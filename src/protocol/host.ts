// 协议进程主体：持有机器连接，向渲染进程暴露 API（方案 §3：协议进程 = 所有网络 I/O）。
// 与主进程的控制消息（凭据、文件句柄）走 process.parentPort；
// 与渲染进程的数据面走 MessagePort（高频事件不过主进程）。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { MessagePortMain } from 'electron'
import { RpcError } from './rpc/RpcClient.js'
import { PROTOCOL_VERSION } from './rpc/protocol.js'
import type { MachineEntry, HostEnvelope, HostRequest, HostResponse, ParsedTarget } from '../shared/api.js'
import { MachineConnection, newMachineID, type MachineConnectionHost } from './session/MachineManager.js'
import { PairingStore, type CredentialBackend } from './session/PairingStore.js'
import { parseTarget, targetToText, targetDisplayName } from './session/TargetParse.js'
import { installPublicKeyWithPassword } from './session/PasswordSsh.js'
import { ensureServer } from './deploy/RemoteDeploy.js'
import { Uploads } from './media/Uploads.js'

/** 剥掉 UTF-8 BOM（Windows 记事本/PowerShell 写的文件常带） */
function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
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
  private readonly pairings: PairingStore
  private readonly uploads: Uploads
  private readonly remotesFile: string

  constructor(
    backends: MainBackends,
    private readonly init: HostInit
  ) {
    this.pairings = new PairingStore(backends.credentials)
    this.uploads = new Uploads(backends)
    this.remotesFile = join(init.userDataPath, 'Remotes', 'remotes.json')
  }

  private port: MessagePortMain | null = null

  async start(): Promise<void> {
    await this.pairings.load()
    await this.loadRemotes()
    this.listen()
    // 端口可能先于 remotes.json 加载到达（那时广播的是空表），加载完再广播一次
    this.broadcastMachines()
  }

  /** 窗口 reload 时换端口，机器连接保持 */
  setPort(newPort: MessagePortMain): void {
    this.port = newPort
    this.listen()
    this.broadcastMachines()
  }

  private listen(): void {
    if (!this.port) return
    this.port.on('message', (event) => {
      void this.handleMessage(event.data as HostEnvelope)
    })
    this.port.start()
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
    // 上次保存的机器重建连接对象（不自动连；渲染进程决定什么时候连）
    for (const entry of this.entries) {
      if (this.machines.has(entry.id)) continue
      const target = parseTarget(entry.target)
      if (!target) continue
      if (entry.identityFile) target.identityFile = entry.identityFile
      const machine = new MachineConnection(
        entry.id,
        entry.name?.trim() || targetDisplayName(target),
        target,
        this.machineHost()
      )
      this.machines.set(entry.id, machine)
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

      case 'machines.add':
        return this.addMachine(request.target, request.name, request.identityFile)

      case 'machines.remove': {
        const machine = this.machines.get(request.id)
        machine?.disconnect()
        this.machines.delete(request.id)
        this.entries = this.entries.filter((entry) => entry.id !== request.id)
        if (this.current === request.id) this.current = ''
        await this.saveRemotes()
        this.broadcastMachines()
        return {}
      }

      case 'machines.addWithPassword': {
        // 一次性装公钥（M4）：密码只用这一次，不落盘
        const target = parseTarget(request.target)
        if (!target || target.kind !== 'ssh') throw new Error('密码添加只用于 SSH 目标（user@host[:端口]）')
        const host = target.host ?? ''
        const installed = await installPublicKeyWithPassword({
          host,
          port: target.port,
          password: request.password
        })
        const added = await this.addMachine(request.target, request.name)
        return { ...(added as Record<string, unknown>), publicKeyPath: installed.publicKeyPath }
      }

      case 'machines.ensureServer': {
        const machine = this.requireMachine(request.id)
        return this.ensureServerFor(machine)
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

      default:
        throw new Error('不认识的请求')
    }
  }

  private requireMachine(id: string): MachineConnection {
    const machine = this.machines.get(id)
    if (!machine) throw new Error('没有这台机器')
    return machine
  }

  /** 自动安装/升级远程 friday-server（只对 SSH / WSL 做；WebSocket 配对的机器不装） */
  private async ensureServerFor(machine: MachineConnection): Promise<{ action: string; message: string }> {
    const target = machine.target
    if (target.kind !== 'ssh' && target.kind !== 'wsl') {
      return { action: 'none', message: '只有 SSH / WSL 连的机器能自动装服务端' }
    }
    const deployTarget =
      target.kind === 'ssh'
        ? { kind: 'ssh' as const, host: target.host ?? '', port: target.port, identityFile: target.identityFile }
        : { kind: 'wsl' as const, distro: target.distro }
    const cacheDir = join(this.init.userDataPath, 'Remotes', 'ServerPackages')
    return ensureServer(deployTarget, cacheDir, {
      protocol: PROTOCOL_VERSION,
      onStatus: (text) => this.port?.postMessage({ type: 'deployStatus', machineID: machine.id, text })
    })
  }

  // MARK: 机器管理

  private machinesInfo() {
    return {
      machines: [...this.machines.values()].map((machine) => machine.info()),
      current: this.current
    }
  }

  private async addMachine(targetText: string, name?: string, identityFile?: string): Promise<unknown> {
    const target = parseTarget(targetText)
    if (!target) {
      throw new Error('写成 user@host、user@host:端口、wsl:发行版，或粘贴配对链接（friday://pair…）')
    }
    const keyFile = identityFile?.trim()
    if (keyFile) {
      if (target.kind !== 'ssh') throw new Error('只有 SSH 连接能指定私钥文件')
      target.identityFile = keyFile
    }

    // 配对链接：记下令牌（经主进程 safeStorage 加密落盘，值只出现这一次）
    if (target.token && target.url) {
      await this.pairings.save(target.url, {
        token: target.token,
        fingerprint: target.fingerprint
      })
    }

    // 同一个目标已在列表里：复用那台
    const text = targetToText(target)
    const existingEntry = this.entries.find((entry) => entry.target === text)
    const id = existingEntry?.id ?? newMachineID()
    if (!existingEntry) {
      const displayName = name?.trim() || target.suggestedName?.trim()
      const entry: MachineEntry = {
        id,
        target: text,
        ...(displayName ? { name: displayName } : {}),
        ...(keyFile ? { identityFile: keyFile } : {}),
        addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      }
      this.entries.push(entry)
    } else if (keyFile && existingEntry.identityFile !== keyFile) {
      // 换了密钥文件：记下新的，连接重建
      existingEntry.identityFile = keyFile
    }
    await this.saveRemotes()

    const existing = this.machines.get(id)
    if (existing && existing.target.identityFile !== target.identityFile) {
      // 已经连着、换了密钥：重新建连接
      existing.disconnect()
      this.machines.delete(id)
    }
    let machine = this.machines.get(id)
    if (!machine) {
      machine = new MachineConnection(id, this.displayNameFor(target, name), target, this.machineHost())
      this.machines.set(id, machine)
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
      pairings: this.pairings,
      onStateChange: () => this.broadcastMachines(),
      onEvent: (machine, method, params) => {
        this.port?.postMessage({ type: 'event', machineID: machine.id, method, params })
      },
      ensureServer: (machine) => this.ensureServerFor(machine)
    }
  }

  private broadcastMachines(): void {
    this.port?.postMessage({ type: 'machines', ...this.machinesInfo() })
  }
}
