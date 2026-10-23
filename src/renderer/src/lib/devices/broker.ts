// 客户端设备：服务端 device.* 请求的处理中心（方案-客户端设备）。
//
// 协议进程把请求经数据面端口转来（device.request），这里校验参数 → 认设备 → 问人授权 → 干活 → device.reply。
// 串口会话占着的口、正在烧录的口都记在 busy 里：同一个口同时只给一个用，烧录时把串口会话挂起、烧完接着转发。
// 界面要的东西（待授权的弹窗、正在用的设备）放在 deviceUi 里，DeviceOverlay 直接读。

import { reactive } from 'vue'
import { RpcErrors } from '../../../../protocol/rpc/protocol.js'
import type { DevicePortMessage, TunnelPortMessage } from '../../../../shared/api.js'
import { host } from '../host.js'
import type { WorkChannelHub } from '../workChannel.js'
import { CAMERA_PREFIX, listCameras, takeSnapshot, type CameraDeviceInfo } from './camera.js'
import {
  DeviceError,
  parseEspInfo,
  parseFlash,
  parseOtherFlash,
  parseSerialOpen,
  parseSnapshot,
  parseTcpOpen,
  parseToolRun,
  progressToken
} from './deviceParams.js'
import { espInfo, flashEsp } from './espFlash.js'
import { addGrant, hasGrant, type DeviceCapability } from './grants.js'
import { parseIntelHex } from './intelHex.js'
import { SerialIdRegistry, describePorts, type SerialDeviceInfo } from './serialPorts.js'
import { SerialSession, type ChannelLike, type PortLike } from './serialSession.js'
import { flashStk500 } from './stk500.js'
import { flashStm32 } from './stm32.js'
import { TcpSession } from './tcpSession.js'

type RequestMessage = Extract<DevicePortMessage, { type: 'device.request' }>

export type PromptChoice = 'once' | 'always' | 'deny'

export interface DevicePrompt {
  id: number
  machineName: string
  capability: DeviceCapability
  deviceLabel: string
  /** 要干什么（一句话） */
  action: string
  expiresAt: number
  /** 能不能「始终允许」（跑工具每次都要问） */
  allowAlways: boolean
}

export interface DeviceActivity {
  key: string
  machineName: string
  kind: 'serial' | 'flash' | 'info' | 'camera' | 'tunnel' | 'tool'
  deviceLabel: string
  detail: string
  /** 烧录进度 0..1 */
  progress?: number
}

/** 界面状态（DeviceOverlay 读；改只经下面的 answerPrompt / stopActivity） */
export const deviceUi = reactive({ prompts: [] as DevicePrompt[], activity: [] as DeviceActivity[] })

const PROMPT_TIMEOUT_MS = 60_000
/** 隧道在「使用中」条里的说明 */
const CAPABILITY_DETAIL: Record<string, string> = { android: 'adb', ios: 'usbmuxd' }
const CHANNEL_OPEN_TIMEOUT_MS = 15_000
const PROGRESS_INTERVAL_MS = 250

interface SerialEntry {
  session: SerialSession
  machineID: string
  port: SerialPort
  label: string
}

function failure(error: unknown, prefix: string): DeviceError {
  if (error instanceof DeviceError) return error
  return new DeviceError(RpcErrors.DeviceFailed, `${prefix}：${error instanceof Error ? error.message : String(error)}`)
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => (byte % 36).toString(36)).join('')
}

function waitOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('专用通道 15 秒没打开')), CHANNEL_OPEN_TIMEOUT_MS)
    channel.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    channel.addEventListener('close', () => {
      clearTimeout(timer)
      reject(new Error('专用通道被关了'))
    })
  })
}

class DeviceBroker {
  private hub: WorkChannelHub | null = null
  private machineName: (machineID: string) => string = (machineID) => machineID
  private readonly serialIds = new SerialIdRegistry<SerialPort>()
  private readonly sessions = new Map<string, SerialEntry>()
  /** 口 → 占着它的串口会话 id，或 'esp'（正在烧录 / 读芯片） */
  private readonly busy = new Map<SerialPort, string>()
  private readonly promptAnswers = new Map<number, (choice: PromptChoice) => void>()
  /** 请求 rid → 它在等的授权弹窗（请求被取消时一起撤） */
  private readonly promptOfRequest = new Map<number, number>()
  private readonly stoppers = new Map<string, () => void>()
  /** 发过 device.* 请求的机器（设备增减时通知它们） */
  private readonly machinesSeen = new Set<string>()
  /** TCP 隧道：会话 id → 会话（socket 在协议进程） */
  private readonly tunnels = new Map<string, { session: TcpSession; machineID: string }>()
  /** 后台跑着的工具：runId → 哪台机器要的 */
  private readonly toolRuns = new Map<string, { machineID: string; key: string }>()
  private nextPromptId = 1

  attach(hub: WorkChannelHub, machineName: (machineID: string) => string): void {
    this.hub = hub
    this.machineName = machineName
    navigator.serial?.addEventListener('connect', () => this.devicesChanged())
    navigator.serial?.addEventListener('disconnect', (event) => {
      this.serialIds.forget(event.target as SerialPort)
      this.devicesChanged()
    })
    navigator.mediaDevices?.addEventListener('devicechange', () => this.devicesChanged())
    window.fridayBridge.onToolExited(({ runId, exitCode, output }) => {
      const run = this.toolRuns.get(runId)
      if (!run) return
      this.toolRuns.delete(runId)
      this.untrack(run.key)
      this.notify(run.machineID, 'device.tool.exited', { runId, exitCode, output })
    })
  }

  /** 协议进程来的隧道字节 / socket 关了 */
  tunnelMessage(message: TunnelPortMessage): void {
    this.tunnels.get(message.id)?.session.fromSocket(message)
  }

  handle(message: DevicePortMessage): void {
    if (message.type === 'device.request') void this.run(message)
    else if (message.type === 'device.cancel') {
      const promptId = this.promptOfRequest.get(message.rid)
      if (promptId !== undefined) this.promptAnswers.get(promptId)?.('deny')
    }
  }

  // MARK: 界面操作

  answerPrompt(id: number, choice: PromptChoice): void {
    this.promptAnswers.get(id)?.(choice)
  }

  stopActivity(key: string): void {
    this.stoppers.get(key)?.()
  }

  // MARK: 请求

  private async run(message: RequestMessage): Promise<void> {
    this.machinesSeen.add(message.machineID)
    try {
      const result = await this.dispatch(message)
      host.postDevice({ type: 'device.reply', rid: message.rid, ok: true, result: result ?? {} })
    } catch (error) {
      const deviceError = failure(error, '设备操作失败')
      host.postDevice({ type: 'device.reply', rid: message.rid, ok: false, code: deviceError.code, message: deviceError.message })
    } finally {
      this.promptOfRequest.delete(message.rid)
    }
  }

  private dispatch(message: RequestMessage): Promise<unknown> {
    switch (message.method) {
      case 'device.list':
        return this.list()
      case 'device.serial.open':
        return this.openSerial(message)
      case 'device.serial.close':
        return this.closeSerial(message)
      case 'device.esp.flash':
        return this.flash(message)
      case 'device.esp.info':
        return this.info(message)
      case 'device.camera.snapshot':
        return this.snapshot(message)
      case 'device.tcp.open':
        return this.openTcp(message)
      case 'device.tcp.close':
        return this.closeTcp(message)
      case 'device.flash':
        return this.flashOther(message)
      case 'device.tool.run':
        return this.runTool(message)
      case 'device.tool.stop':
        return this.stopTool(message)
      default:
        return Promise.reject(new DeviceError(RpcErrors.MethodNotFound, `不认识的方法 ${message.method}`))
    }
  }

  private notify(machineID: string, method: string, params: unknown): void {
    host.postDevice({ type: 'device.notify', machineID, method, params })
  }

  private devicesChanged(): void {
    for (const machineID of this.machinesSeen) this.notify(machineID, 'device.changed', {})
  }

  // MARK: 设备清单

  private async serialPorts(): Promise<Array<{ port: SerialPort; info: SerialDeviceInfo }>> {
    if (!navigator.serial) return []
    const ports = await navigator.serial.getPorts()
    const names = await window.fridayBridge.serialPortNames().catch(() => [])
    const entries = ports.map((port) => {
      const { usbVendorId, usbProductId } = port.getInfo()
      return { port, id: this.serialIds.idFor(port, usbVendorId, usbProductId), usbVendorId, usbProductId }
    })
    const described = describePorts(entries, names)
    return entries.map((entry, index) => ({ port: entry.port, info: described[index] }))
  }

  private async phones(): Promise<Array<{ id: string; kind: 'android' | 'ios'; label: string; state: string; serial: string }>> {
    try {
      const reply = (await host.request({ type: 'device.phones' })) as { phones?: Array<{ id: string; kind: 'android' | 'ios'; label: string; state: string; serial: string }> }
      return reply.phones ?? []
    } catch {
      return []
    }
  }

  private async list(): Promise<unknown> {
    const [serial, cameras, phones, drives] = await Promise.all([
      this.serialPorts(),
      listCameras().catch(() => [] as CameraDeviceInfo[]),
      this.phones(),
      window.fridayBridge.uf2Drives().catch(() => [])
    ])
    return {
      devices: [
        ...serial.map((entry) => entry.info),
        ...cameras,
        ...phones.map(({ id, kind, label, state }) => ({ id, kind, label, state })),
        ...drives.map(({ id, label, model, boardId }) => ({ id, kind: 'uf2', label, model, boardId }))
      ]
    }
  }

  /** 设备面板用：这台电脑上现在有什么（不发给谁） */
  async localDevices(): Promise<Array<{ id: string; kind: string; label: string; state?: string }>> {
    const listed = (await this.list()) as { devices: Array<{ id: string; kind: string; label: string; state?: string }> }
    return listed.devices
  }

  private async resolveSerial(deviceId: string): Promise<{ port: SerialPort; info: SerialDeviceInfo }> {
    const found = (await this.serialPorts()).find((entry) => entry.info.id === deviceId)
    if (!found) throw new DeviceError(RpcErrors.DeviceNotFound, `没有这个串口（${deviceId}），可能已经拔掉了`)
    return found
  }

  // MARK: 授权

  private async authorize(
    message: RequestMessage,
    capability: DeviceCapability,
    deviceId: string,
    deviceLabel: string,
    action: string
  ): Promise<void> {
    const allowAlways = capability !== 'tool'
    if (allowAlways && hasGrant(message.machineID, capability, deviceId)) return
    const machineName = this.machineName(message.machineID)
    const id = this.nextPromptId++
    const choice = await new Promise<PromptChoice>((resolve) => {
      const timer = setTimeout(() => finish('deny'), PROMPT_TIMEOUT_MS)
      const finish = (answer: PromptChoice): void => {
        clearTimeout(timer)
        this.promptAnswers.delete(id)
        const index = deviceUi.prompts.findIndex((prompt) => prompt.id === id)
        if (index >= 0) deviceUi.prompts.splice(index, 1)
        resolve(answer)
      }
      this.promptAnswers.set(id, finish)
      this.promptOfRequest.set(message.rid, id)
      deviceUi.prompts.push({ id, machineName, capability, deviceLabel, action, expiresAt: Date.now() + PROMPT_TIMEOUT_MS, allowAlways })
    })
    if (choice === 'deny') throw new DeviceError(RpcErrors.DeviceDenied, '客户端用户没有允许（或 60 秒内没人理）')
    if (choice === 'always' && allowAlways) addGrant({ machineID: message.machineID, machineName, capability, deviceId, deviceLabel })
  }

  // MARK: 界面上的「正在用」

  private track(activity: DeviceActivity, stop?: () => void): void {
    deviceUi.activity.push(activity)
    if (stop) this.stoppers.set(activity.key, stop)
  }

  private untrack(key: string): void {
    const index = deviceUi.activity.findIndex((activity) => activity.key === key)
    if (index >= 0) deviceUi.activity.splice(index, 1)
    this.stoppers.delete(key)
  }

  private updateActivity(key: string, change: Partial<DeviceActivity>): void {
    const activity = deviceUi.activity.find((item) => item.key === key)
    if (activity) Object.assign(activity, change)
  }

  // MARK: 串口会话

  private async openSerial(message: RequestMessage): Promise<unknown> {
    const { deviceId, mode, config } = parseSerialOpen(message.params)
    const { port, info } = await this.resolveSerial(deviceId)
    const busyMessage = '这个串口已经被占用（开着别的会话或正在烧录）'
    if (this.busy.has(port)) throw new DeviceError(RpcErrors.DeviceBusy, busyMessage)
    const modeText = mode === 'rfc2217' ? 'RFC 2217' : '原始字节'
    await this.authorize(message, 'serial', deviceId, info.label, `打开串口（${modeText}，${config.baudRate} 波特）`)
    if (this.busy.has(port)) throw new DeviceError(RpcErrors.DeviceBusy, busyMessage)

    const sessionId = randomId()
    const label = `friday-serial:${sessionId}`
    const channel = this.hub?.openDataChannel(message.machineID, label)
    if (!channel) throw new DeviceError(RpcErrors.DeviceFailed, '和这台机器的工作通道还没通')
    this.busy.set(port, sessionId)
    const machineName = this.machineName(message.machineID)
    const detail = (): string => {
      const entry = this.sessions.get(sessionId)
      const config = entry?.session.config
      if (!config) return modeText
      return `${entry.session.suspended ? '烧录中，已暂停 · ' : ''}${config.baudRate} · ${modeText}`
    }
    const session = new SerialSession(port as unknown as PortLike, channel as unknown as ChannelLike, mode, config, {
      onClosed: (reason, byPeer) => {
        this.sessions.delete(sessionId)
        if (this.busy.get(port) === sessionId) this.busy.delete(port)
        this.untrack(sessionId)
        if (!byPeer) this.notify(message.machineID, 'device.serial.closed', { sessionId, reason })
      },
      onChange: () => this.updateActivity(sessionId, { detail: detail() })
    })
    try {
      await waitOpen(channel)
      await session.start()
    } catch (error) {
      this.busy.delete(port)
      try {
        channel.close()
      } catch {
        /* 已经关了 */
      }
      throw failure(error, '打开串口失败')
    }
    this.sessions.set(sessionId, { session, machineID: message.machineID, port, label: info.label })
    this.track(
      { key: sessionId, machineName, kind: 'serial', deviceLabel: info.label, detail: detail() },
      () => void session.close('客户端用户断开了')
    )
    return { sessionId, channel: label }
  }

  private async closeSerial(message: RequestMessage): Promise<unknown> {
    const sessionId = (message.params as { sessionId?: unknown } | null)?.sessionId
    const entry = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
    if (!entry || entry.machineID !== message.machineID) {
      throw new DeviceError(RpcErrors.NotFound, '没有这个串口会话（可能已经关了）')
    }
    await entry.session.close('服务端关闭', true)
    return {}
  }

  // MARK: ESP 烧录 / 读芯片

  /** 独占一个口做 esptool-js 的事：开着串口会话就先挂起，做完恢复 */
  private async withExclusivePort<T>(machineID: string, port: SerialPort, work: () => Promise<T>): Promise<T> {
    const owner = this.busy.get(port)
    if (owner === 'esp') throw new DeviceError(RpcErrors.DeviceBusy, '这个口正在烧录')
    const entry = owner ? this.sessions.get(owner) : undefined
    if (entry && entry.machineID !== machineID) {
      throw new DeviceError(RpcErrors.DeviceBusy, '这个口被另一台机器的串口会话占着')
    }
    this.busy.set(port, 'esp')
    try {
      await entry?.session.suspend()
      return await work()
    } finally {
      if (entry && !entry.session.closed && owner) {
        this.busy.set(port, owner)
        await entry.session.resume()
      } else {
        this.busy.delete(port)
      }
    }
  }

  private async flash(message: RequestMessage): Promise<unknown> {
    const { deviceId, options } = parseFlash(message.params)
    const { port, info } = await this.resolveSerial(deviceId)
    const totalBytes = options.files.reduce((sum, file) => sum + file.data.length, 0)
    await this.authorize(
      message,
      'esp',
      deviceId,
      info.label,
      `烧录 ${options.files.length} 个文件（共 ${Math.ceil(totalBytes / 1024)} KB）${options.eraseAll ? '，先整片擦除' : ''}`
    )
    const key = `flash:${message.rid}`
    this.track({ key, machineName: this.machineName(message.machineID), kind: 'flash', deviceLabel: info.label, detail: '连接芯片…', progress: 0 })
    let lastProgress = 0
    try {
      return await this.withExclusivePort(message.machineID, port, () =>
        flashEsp(port, options, (fileIndex, written, total) => {
          const fraction = (fileIndex + (total > 0 ? written / total : 1)) / options.files.length
          this.updateActivity(key, { detail: `第 ${fileIndex + 1}/${options.files.length} 个文件`, progress: fraction })
          const now = Date.now()
          if (now - lastProgress < PROGRESS_INTERVAL_MS && written < total) return
          lastProgress = now
          this.notify(message.machineID, 'device.esp.progress', {
            requestId: message.serverID,
            token: progressToken(message.params),
            fileIndex,
            written,
            total
          })
        })
      )
    } catch (error) {
      throw failure(error, '烧录失败')
    } finally {
      this.untrack(key)
    }
  }

  private async info(message: RequestMessage): Promise<unknown> {
    const { deviceId, before } = parseEspInfo(message.params)
    const { port, info } = await this.resolveSerial(deviceId)
    await this.authorize(message, 'esp', deviceId, info.label, '复位进下载模式读芯片信息（读完复位回应用）')
    const key = `info:${message.rid}`
    this.track({ key, machineName: this.machineName(message.machineID), kind: 'info', deviceLabel: info.label, detail: '读芯片信息…' })
    try {
      return await this.withExclusivePort(message.machineID, port, () => espInfo(port, before))
    } catch (error) {
      throw failure(error, '读芯片信息失败')
    } finally {
      this.untrack(key)
    }
  }

  // MARK: TCP 隧道（局域网 / 本机端口、adb、usbmuxd）

  private async openTcp(message: RequestMessage): Promise<unknown> {
    const target = parseTcpOpen(message.params)
    let capability: DeviceCapability
    let deviceId: string
    let label: string
    let action: string
    let tunnelTarget: import('../../../../shared/api.js').TunnelTarget
    if (target.kind === 'tcp') {
      capability = 'network'
      deviceId = `tcp:${target.host}:${target.port}`
      label = `${target.host}:${target.port}`
      action = '经这台电脑连过去（只通本机和局域网地址）'
      tunnelTarget = { kind: 'tcp', host: target.host, port: target.port }
    } else if (target.kind === 'adb') {
      const phone = (await this.phones()).find((item) => item.id === target.deviceId)
      if (!phone) throw new DeviceError(RpcErrors.DeviceNotFound, `没有这台安卓手机（${target.deviceId}）：插好、打开 USB 调试了吗？`)
      if (phone.state !== 'device') throw new DeviceError(RpcErrors.DeviceFailed, `${phone.label}：手机还没准备好（在手机上点允许调试）`)
      capability = 'android'
      deviceId = phone.id
      label = phone.label
      action = '把这台手机交给服务端的 adb（装应用、shell、看日志、截屏都能做）'
      tunnelTarget = { kind: 'adb', serial: phone.serial }
    } else {
      capability = 'ios'
      deviceId = 'ios:usbmux'
      label = '这台电脑连着的所有 iOS 设备'
      action = '把 iOS 设备服务（usbmuxd）交给服务端（看信息、日志、装应用）'
      tunnelTarget = { kind: 'usbmux' }
    }
    await this.authorize(message, capability, deviceId, label, action)
    const sessionId = randomId()
    const channelLabel = `friday-tcp:${sessionId}`
    const channel = this.hub?.openDataChannel(message.machineID, channelLabel)
    if (!channel) throw new DeviceError(RpcErrors.DeviceFailed, '和这台机器的工作通道还没通')
    const machineName = this.machineName(message.machineID)
    const session = new TcpSession(sessionId, channel as unknown as ChannelLike, (msg) => host.postTunnel(msg), {
      onClosed: (reason, byPeer) => {
        this.tunnels.delete(sessionId)
        this.untrack(sessionId)
        if (!byPeer) this.notify(message.machineID, 'device.tcp.closed', { sessionId, reason })
      }
    })
    try {
      await waitOpen(channel)
      await host.request({ type: 'device.tunnel.open', id: sessionId, target: tunnelTarget })
    } catch (error) {
      try {
        channel.close()
      } catch {
        /* 已经关了 */
      }
      throw failure(error, '连不上')
    }
    this.tunnels.set(sessionId, { session, machineID: message.machineID })
    session.start()
    this.track({ key: sessionId, machineName, kind: 'tunnel', deviceLabel: label, detail: capability === 'network' ? '隧道' : CAPABILITY_DETAIL[capability] }, () =>
      session.close('客户端用户断开了')
    )
    return { sessionId, channel: channelLabel }
  }

  private async closeTcp(message: RequestMessage): Promise<unknown> {
    const sessionId = (message.params as { sessionId?: unknown } | null)?.sessionId
    const entry = typeof sessionId === 'string' ? this.tunnels.get(sessionId) : undefined
    if (!entry || entry.machineID !== message.machineID) throw new DeviceError(RpcErrors.NotFound, '没有这个隧道（可能已经关了）')
    entry.session.close('服务端关闭', true)
    return {}
  }

  // MARK: 别的烧录（UF2、Arduino STK500、STM32 串口引导）

  private async flashOther(message: RequestMessage): Promise<unknown> {
    const options = parseOtherFlash(message.params, parseIntelHex)
    const token = progressToken(message.params)
    const kb = Math.ceil(options.data.length / 1024)
    const key = `flash:${message.rid}`
    let lastProgress = 0
    const progress = (written: number, total: number): void => {
      this.updateActivity(key, { progress: total > 0 ? written / total : 0 })
      const now = Date.now()
      if (now - lastProgress < PROGRESS_INTERVAL_MS && written < total) return
      lastProgress = now
      this.notify(message.machineID, 'device.flash.progress', { requestId: message.serverID, token, fileIndex: 0, written, total })
    }
    if (options.method === 'uf2') {
      const drive = (await window.fridayBridge.uf2Drives()).find((item) => item.id === options.deviceId)
      if (!drive) throw new DeviceError(RpcErrors.DeviceNotFound, '没有这个 UF2 盘（按住 BOOTSEL 再插上）')
      await this.authorize(message, 'esp', drive.id, drive.label, `把 ${kb} KB 的 .uf2 拷进去（板子会自己重启）`)
      this.track({ key, machineName: this.machineName(message.machineID), kind: 'flash', deviceLabel: drive.label, detail: 'UF2', progress: 0 })
      try {
        const startedAt = Date.now()
        const written = await window.fridayBridge.uf2Write(drive.root, options.data)
        progress(1, 1)
        return { method: 'uf2', board: drive.model, boardId: drive.boardId, ...written, elapsedMs: Date.now() - startedAt }
      } catch (error) {
        throw failure(error, 'UF2 烧录失败')
      } finally {
        this.untrack(key)
      }
    }
    const { port, info } = await this.resolveSerial(options.deviceId)
    const what = options.method === 'stk500' ? 'Arduino（STK500）' : 'STM32（串口引导）'
    await this.authorize(message, 'esp', options.deviceId, info.label, `用 ${what} 烧 ${kb} KB（地址 0x${options.address.toString(16)}）`)
    this.track({ key, machineName: this.machineName(message.machineID), kind: 'flash', deviceLabel: info.label, detail: what, progress: 0 })
    try {
      const result = await this.withExclusivePort<object>(message.machineID, port, () =>
        options.method === 'stk500'
          ? flashStk500(port as unknown as PortLike, options.data, { baudRate: options.baudRate, pageSize: options.pageSize, address: options.address }, progress)
          : flashStm32(port as unknown as PortLike, options.data, { baudRate: options.baudRate, address: options.address, reset: options.reset }, progress)
      )
      return { method: options.method, ...result }
    } catch (error) {
      throw failure(error, '烧录失败')
    } finally {
      this.untrack(key)
    }
  }

  // MARK: 本机工具（白名单）

  private async runTool(message: RequestMessage): Promise<unknown> {
    const request = parseToolRun(message.params)
    const commandLine = [request.tool, ...request.args].join(' ')
    const fileNote = request.files.length > 0 ? `（带 ${request.files.length} 个文件）` : ''
    await this.authorize(message, 'tool', `tool:${request.tool}`, commandLine, `在这台电脑上运行${request.background ? '（后台）' : ''}${fileNote}`)
    const key = `tool:${message.rid}`
    this.track({ key, machineName: this.machineName(message.machineID), kind: 'tool', deviceLabel: request.tool, detail: request.background ? '后台运行' : '运行中' })
    try {
      const result = await window.fridayBridge.toolRun(request)
      if (result.runId) {
        // 后台的：一直亮着，退出时（onToolExited）收掉并通知服务端
        this.toolRuns.set(result.runId, { machineID: message.machineID, key })
        this.stoppers.set(key, () => void window.fridayBridge.toolStop(result.runId!))
        return result
      }
      this.untrack(key)
      return result
    } catch (error) {
      this.untrack(key)
      throw failure(error, '运行失败')
    }
  }

  private async stopTool(message: RequestMessage): Promise<unknown> {
    const runId = (message.params as { runId?: unknown } | null)?.runId
    const run = typeof runId === 'string' ? this.toolRuns.get(runId) : undefined
    if (!run || run.machineID !== message.machineID) throw new DeviceError(RpcErrors.NotFound, '没有这个后台工具（可能已经结束了）')
    await window.fridayBridge.toolStop(runId as string)
    return {}
  }

  // MARK: 摄像头

  private async snapshot(message: RequestMessage): Promise<unknown> {
    const { deviceId, options } = parseSnapshot(message.params)
    const cameras = await listCameras().catch(() => [] as CameraDeviceInfo[])
    let camera = deviceId ? cameras.find((item) => item.id === deviceId) : cameras[0]
    // 拿不到设备清单（权限还没给过）但只要默认摄像头：照样试
    if (!camera && !deviceId) camera = { id: `${CAMERA_PREFIX}default`, kind: 'camera', label: '默认摄像头' }
    if (!camera) throw new DeviceError(RpcErrors.DeviceNotFound, `没有这个摄像头（${deviceId}）`)
    await this.authorize(message, 'camera', camera.id, camera.label, '拍一张照片')
    const key = `camera:${message.rid}`
    this.track({ key, machineName: this.machineName(message.machineID), kind: 'camera', deviceLabel: camera.label, detail: '拍照中' })
    try {
      const browserId = camera.id === `${CAMERA_PREFIX}default` ? undefined : camera.id.slice(CAMERA_PREFIX.length)
      return await takeSnapshot({ ...options, deviceId: browserId })
    } catch (error) {
      throw failure(error, '拍照失败')
    } finally {
      this.untrack(key)
    }
  }
}

export const deviceBroker = new DeviceBroker()

export type { TunnelPortMessage }
