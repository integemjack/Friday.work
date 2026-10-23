// 协议进程主体：持有机器连接，向渲染进程暴露 API（方案 §3：协议进程 = 所有网络 I/O）。
// 与主进程的控制消息（凭据、文件句柄）走 process.parentPort；
// 与渲染进程的数据面走 MessagePort（高频事件不过主进程）。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { MessagePortMain } from 'electron'
import { RpcError } from './rpc/RpcClient.js'
import { RpcErrors } from './rpc/protocol.js'
import type { DevicePortMessage, MachineEntry, HostEnvelope, HostRequest, HostResponse, ParsedTarget } from '../shared/api.js'
import { MachineConnection, newMachineID, type MachineConnectionHost } from './session/MachineManager.js'
import type { CredentialBackend } from './session/PairingStore.js'
import { parseTarget, targetToText, targetDisplayName } from './session/TargetParse.js'
import type { WorkPortMessage } from './work/WorkTransport.js'
import { SchatService } from './schat/SchatService.js'
import { Uploads } from './media/Uploads.js'
import { listPhones } from './device/Phones.js'
import { Tunnels } from './device/Tunnels.js'
import type { TunnelPortMessage } from '../shared/api.js'

/** 剥掉 UTF-8 BOM（Windows 记事本/PowerShell 写的文件常带） */
function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** device.* 请求等渲染进程回多久（含等人点授权、烧录全程）：服务端那头也有自己的超时 */
function deviceTimeoutMs(method: string): number {
  if (method === 'device.esp.flash') return 15 * 60_000
  if (method === 'device.esp.info') return 3 * 60_000
  if (method === 'device.serial.open' || method === 'device.camera.snapshot') return 2 * 60_000
  return 60_000
}

interface PendingDevice {
  machineID: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface HostInit {
  userDataPath: string
  appVersion: string
}

/** 主进程实现的两个后端（凭据落盘、文件句柄解析） */
export interface MainBackends {
  credentials: CredentialBackend
  resolveHandle(handle: string): Promise<string | null>
}

export class ProtocolHost {
  private readonly machines = new Map<string, MachineConnection>()
  private entries: MachineEntry[] = []
  private current = ''
  private readonly uploads: Uploads
  private readonly remotesFile: string

  private readonly schat: SchatService
  /** 客户端设备的 TCP 隧道（socket 在这里，DataChannel 在渲染进程） */
  private readonly tunnels = new Tunnels((message) => this.port?.postMessage(message))
  /** 转给渲染进程、还没回的 device.* 请求 */
  private readonly pendingDevice = new Map<number, PendingDevice>()
  private nextDeviceRid = 1

  constructor(
    backends: MainBackends,
    private readonly init: HostInit
  ) {
    this.uploads = new Uploads(backends)
    this.remotesFile = join(init.userDataPath, 'Remotes', 'remotes.json')
    this.schat = new SchatService(backends.credentials, {
      onChange: (state) => this.port?.postMessage({ type: 'schat', state }),
      onCallSignal: (signal) => this.port?.postMessage({ type: 'schatCall', signal }),
      // SChat 恢复在线：依赖它的信令重连 work 机器都立刻重试，不等各自最长 60 秒的退避
      onOnline: () => {
        for (const machine of this.machines.values()) machine.retryNow()
      }
    })
  }

  private port: MessagePortMain | null = null
  /** 已经挂过监听的那个端口对象（listen 幂等：同一个端口只挂一次，否则每个请求会被处理两遍） */
  private listeningPort: MessagePortMain | null = null

  async start(): Promise<void> {
    await this.loadRemotes()
    this.listen()
    // 端口可能先于 remotes.json 加载到达（那时广播的是空表），加载完再广播一次
    this.broadcastMachines()
    // 已登录的 SChat 会话直连（不用再扫码）
    void this.schat.load()
  }

  /** 窗口 reload 时换端口，机器连接保持 */
  setPort(newPort: MessagePortMain): void {
    if (this.port !== newPort) {
      this.listeningPort = null
      // 换了端口 = 窗口重载：旧页面里在处理的设备请求没人回了
      this.failPendingDevice(() => true, '客户端界面重载了')
      this.tunnels.closeAll()
    }
    this.port = newPort
    this.listen()
    this.broadcastMachines()
    // SChat 状态也补推一次：它在端口挂上前就可能已静默恢复在线（load → connectWs），
    // 那时的推送发给了 null 端口，不补推渲染层会一直显示「未登录」
    this.port?.postMessage({ type: 'schat', state: this.schat.getState() })
  }

  private listen(): void {
    if (!this.port || this.listeningPort === this.port) return
    this.listeningPort = this.port
    this.port.on('message', (event) => {
      const data = event.data as { type?: string } & Record<string, unknown>
      // work 通道（0.3）：渲染进程 WorkChannel 的数据/信令/状态（不带 reqID，不是请求）
      if (data && typeof data === 'object' && typeof data.type === 'string' && data.type.startsWith('work.')) {
        this.handleWorkPortMessage(data as WorkPortMessage)
        return
      }
      if (data && typeof data === 'object' && typeof data.type === 'string' && data.type.startsWith('device.')) {
        this.handleDevicePortMessage(data as DevicePortMessage)
        return
      }
      if (data && typeof data === 'object' && typeof data.type === 'string' && data.type.startsWith('tunnel.')) {
        this.tunnels.handle(data as TunnelPortMessage)
        return
      }
      void this.handleMessage(event.data as HostEnvelope)
    })
    this.port.start()
  }

  /** 渲染进程 WorkChannel 来的消息：DataChannel 状态 / 数据 / 信令 */
  private handleWorkPortMessage(message: WorkPortMessage): void {
    const machine = this.machines.get(message.machineID)
    if (!machine) return
    switch (message.type) {
      case 'work.open':
        machine.handleWorkOpen()
        break
      case 'work.in':
        machine.handleWorkIn(message.text)
        break
      case 'work.closed':
        machine.handleWorkClosed(message.reason)
        break
      case 'work.signalOut':
        machine.handleWorkSignalOut(message.signalType, message.payload)
        break
    }
  }

  // MARK: 客户端设备（方案-客户端设备）：服务端的 device.* 请求转给渲染进程

  private forwardDeviceRequest(machine: MachineConnection, method: string, params: unknown, serverID: number | string): Promise<unknown> {
    const port = this.port
    if (!port) return Promise.reject(new RpcError(RpcErrors.DeviceFailed, '客户端界面还没就绪'))
    const rid = this.nextDeviceRid++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingDevice.delete(rid)) return
        this.port?.postMessage({ type: 'device.cancel', rid } satisfies DevicePortMessage)
        reject(new RpcError(RpcErrors.DeviceFailed, '客户端处理超时'))
      }, deviceTimeoutMs(method))
      this.pendingDevice.set(rid, { machineID: machine.id, resolve, reject, timer })
      port.postMessage({ type: 'device.request', machineID: machine.id, rid, serverID, method, params } satisfies DevicePortMessage)
    })
  }

  private handleDevicePortMessage(message: DevicePortMessage): void {
    if (message.type === 'device.reply') {
      const pending = this.pendingDevice.get(message.rid)
      if (!pending) return
      this.pendingDevice.delete(message.rid)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new RpcError(message.code, message.message))
      return
    }
    if (message.type === 'device.notify') {
      this.machines.get(message.machineID)?.notify(message.method, message.params)
    }
  }

  private failPendingDevice(match: (pending: PendingDevice) => boolean, reason: string): void {
    for (const [rid, pending] of this.pendingDevice) {
      if (!match(pending)) continue
      this.pendingDevice.delete(rid)
      clearTimeout(pending.timer)
      this.port?.postMessage({ type: 'device.cancel', rid } satisfies DevicePortMessage)
      pending.reject(new RpcError(RpcErrors.DeviceFailed, reason))
    }
  }

  // MARK: remotes.json（REMOTE.md §11 的格式）

  private async loadRemotes(): Promise<void> {
    try {
      const raw = stripBOM(await readFile(this.remotesFile, 'utf8'))
      const parsed = JSON.parse(raw) as { remotes?: MachineEntry[]; current?: string }
      this.entries = Array.isArray(parsed.remotes) ? parsed.remotes : []
      this.current = typeof parsed.current === 'string' ? parsed.current : ''
    } catch {
      this.entries = []
      this.current = ''
    }
    // 上次保存的机器重建连接对象（不自动连；渲染进程决定什么时候连）。
    // 0.3：只认 work（SChat 扫码连入的机器人）；旧版存的 ssh / wsl / wss 条目直接跳过（界面里也建不了了）
    let pruned = false
    for (const entry of this.entries) {
      if (this.machines.has(entry.id)) continue
      const target = parseTarget(entry.target)
      if (!target || target.kind !== 'work') {
        pruned = true
        continue
      }
      if (entry.identityFile) target.identityFile = entry.identityFile
      const machine = new MachineConnection(
        entry.id,
        entry.name?.trim() || targetDisplayName(target),
        target,
        this.machineHost()
      )
      this.machines.set(entry.id, machine)
      this.attachWorkRoute(machine, target)
    }
    // 跳过了旧条目的：把它们从存档里清掉（不然永远躺在 remotes.json 里）
    if (pruned) {
      this.entries = this.entries.filter((entry) => parseTarget(entry.target)?.kind === 'work')
      void this.saveRemotes()
    }
  }

  private async saveRemotes(): Promise<void> {
    await mkdir(join(this.init.userDataPath, 'Remotes'), { recursive: true })
    await writeFile(
      this.remotesFile,
      JSON.stringify({ remotes: this.entries, current: this.current || undefined }, null, 2),
      'utf8'
    )
  }

  // MARK: 渲染进程请求

  private reply(reqID: number, response: Omit<HostResponse, 'reqID'>): void {
    this.port?.postMessage({ reqID, ...response } satisfies HostResponse)
  }

  private async handleMessage(envelope: HostEnvelope | unknown): Promise<void> {
    if (!envelope || typeof envelope !== 'object' || !('reqID' in envelope) || !('request' in envelope)) return
    const { reqID, request } = envelope as HostEnvelope
    try {
      const result = await this.dispatch(request)
      this.reply(reqID, { ok: true, result })
    } catch (error) {
      const code = error instanceof RpcError ? error.code : undefined
      this.reply(reqID, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(code !== undefined ? { code } : {})
      })
    }
  }

  private async dispatch(request: HostRequest): Promise<unknown> {
    switch (request.type) {
      case 'machines.list':
        return this.machinesInfo()

      case 'machines.remove': {
        const machine = this.machines.get(request.id)
        this.detachWorkRoute(machine)
        machine?.disconnect()
        this.machines.delete(request.id)
        this.entries = this.entries.filter((entry) => entry.id !== request.id)
        if (this.current === request.id) this.current = ''
        await this.saveRemotes()
        this.broadcastMachines()
        return {}
      }

      case 'machines.connect': {
        const machine = this.machines.get(request.id)
        if (!machine) throw new Error('没有这台机器')
        machine.connect()
        this.broadcastMachines()
        return {}
      }

      case 'machines.disconnect': {
        const machine = this.machines.get(request.id)
        machine?.disconnect()
        this.broadcastMachines()
        return {}
      }

      case 'summaries.get': {
        const machine = this.requireMachine(request.machineID)
        return { summaries: machine.summaries }
      }

      case 'state.get': {
        const machine = this.requireMachine(request.machineID)
        return machine.liveState()
      }

      case 'rpc': {
        const machine = this.requireMachine(request.machineID)
        return machine.request(request.method, request.params)
      }

      case 'conversations.subscribe': {
        // 回执（整段会话 + runtime + versions）原样给渲染进程
        return this.requireMachine(request.machineID).subscribeConversation(request.conversationID)
      }

      case 'conversations.unsubscribe': {
        this.requireMachine(request.machineID).unsubscribeConversation(request.conversationID)
        return {}
      }

      case 'conversations.getMessage': {
        const machine = this.requireMachine(request.machineID)
        return machine.request('message.get', {
          conversationID: request.conversationID,
          messageID: request.messageID
        })
      }

      case 'upload.sendFile': {
        const machine = this.requireMachine(request.machineID)
        return this.uploads.sendFile((method, params) => machine.request(method, params), request.handle)
      }

      case 'schat.state':
        return this.schat.getState()

      case 'schat.login':
        return this.schat.startLogin(request.server, request.deviceName)

      case 'schat.disconnect':
        this.schat.disconnect()
        return {}

      case 'schat.send':
        await this.schat.send(request.botID, request.text)
        return {}

      case 'schat.refreshBots':
        await this.schat.loadBots()
        return this.schat.getState()

      case 'machines.addWork': {
        // 0.3：扫码后从机器人列表直接建机器（WebRTC 工作通道，不再走 /connect + wss）
        const botID = Number(request.botID)
        if (!Number.isInteger(botID) || botID <= 0) throw new Error('机器人 id 不对')
        return this.addMachine(`work:${botID}`, request.name)
      }

      case 'schat.call.dial':
        return this.schat.dial(request.botID, request.callType ?? 'audio')

      case 'schat.call.signal':
        this.schat.callSignal(request.signalType, request.payload)
        return {}

      case 'schat.call.active':
        this.schat.callActive()
        return {}

      case 'schat.call.mute':
        this.schat.callMute(request.muted)
        return {}

      case 'schat.call.accept':
        this.schat.callAccept()
        return {}

      case 'schat.call.reject':
        this.schat.callReject()
        return {}

      case 'schat.call.hangup':
        this.schat.callHangup()
        return {}

      case 'schat.call.ice':
        return { iceServers: await this.schat.iceServers() }

      case 'device.phones':
        return { phones: await listPhones() }

      case 'device.tunnel.open':
        await this.tunnels.open(request.id, request.target)
        return {}

      default:
        throw new Error('不认识的请求')
    }
  }

  private requireMachine(id: string): MachineConnection {
    const machine = this.machines.get(id)
    if (!machine) throw new Error('没有这台机器')
    return machine
  }

  // MARK: 机器管理

  private machinesInfo() {
    return {
      machines: [...this.machines.values()].map((machine) => machine.info()),
      current: this.current
    }
  }

  private async addMachine(targetText: string, name?: string): Promise<unknown> {
    const target = parseTarget(targetText)
    if (!target) throw new Error('不认识的机器标识（work:<机器人ID>）')
    if (target.kind !== 'work') throw new Error('0.3 起只支持 SChat 扫码连入的机器人（work 通道）')

    // 同一个机器人已在列表里：复用那台
    const text = targetToText(target)
    const existingEntry = this.entries.find((entry) => entry.target === text)
    const id = existingEntry?.id ?? newMachineID()
    if (!existingEntry) {
      const displayName = name?.trim()
      const entry: MachineEntry = {
        id,
        target: text,
        ...(displayName ? { name: displayName } : {}),
        addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      }
      this.entries.push(entry)
    }
    await this.saveRemotes()

    let machine = this.machines.get(id)
    if (!machine) {
      machine = new MachineConnection(id, this.displayNameFor(target, name), target, this.machineHost())
      this.machines.set(id, machine)
      this.attachWorkRoute(machine, target)
    } else {
      machine.name = this.displayNameFor(target, name)
    }
    machine.connect()
    this.current = id
    await this.saveRemotes()
    this.broadcastMachines()
    return this.machinesInfo()
  }

  private displayNameFor(target: ParsedTarget, name?: string): string {
    const explicit = name?.trim() || target.suggestedName?.trim()
    return explicit || targetDisplayName(target)
  }

  private machineHost(): MachineConnectionHost {
    return {
      appVersion: this.init.appVersion,
      onStateChange: () => this.broadcastMachines(),
      onEvent: (machine: MachineConnection, method, params) => {
        this.port?.postMessage({ type: 'event', machineID: machine.id, method, params })
      },
      workSignalingHost: () => this.schat.workHost(),
      workPortSend: (message) => this.port?.postMessage(message),
      deviceRequest: (machine, method, params, id) => this.forwardDeviceRequest(machine, method, params, id)
    }
  }

  /** work 机器：把信令路由接到 SChat（同一台机器重复注册无害） */
  private attachWorkRoute(machine: MachineConnection, target: ParsedTarget): void {
    if (target.kind !== 'work' || !target.botUserID) return
    this.schat.registerWorkRoute(target.botUserID, {
      onWorkEnvelope: (event, data) => machine.handleWorkEnvelope(event, data)
    })
  }

  private detachWorkRoute(machine: MachineConnection | undefined): void {
    if (!machine || machine.target.kind !== 'work' || !machine.target.botUserID) return
    this.schat.unregisterWorkRoute(machine.target.botUserID)
  }

  private broadcastMachines(): void {
    this.port?.postMessage({ type: 'machines', ...this.machinesInfo() })
  }
}
