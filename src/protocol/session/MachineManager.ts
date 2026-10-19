// 一台远程机器的连接生命周期（REMOTE.md §3/§4 + 方案 §4.2/§4.4）：
// transport（SSH/WSL/WS）→ hello（声明 messagePatch）→ ready → 事件全部转发给渲染进程。
// 断线后按 1s/2s/5s/…/60s 退避自动重连（重新 hello + 恢复订阅，不补事件）；
// 配对失效（错误 5）和协议版本不对（错误 1）不重连。

import { randomUUID } from 'node:crypto'
import { RpcClient, RpcError } from '../rpc/RpcClient.js'
import {
  PROTOCOL_VERSION,
  RpcErrors,
  type BrowserState,
  type ConversationSummary,
  type EngineConfigView,
  type HelloResult,
  type MachineLiveState,
  type RunnerState,
  type TeamState,
  type TerminalsState
} from '../rpc/protocol.js'
import { SshTransport } from '../transport/SshTransport.js'
import { WsTransport } from '../transport/WsTransport.js'
import type { MachineRuntimeState, ParsedTarget } from '../../shared/api.js'
import type { PairingStore } from './PairingStore.js'
import { sshFailureReason } from '../transport/probe.js'

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000]

export interface MachineConnectionHost {
  appVersion: string
  pairings: PairingStore
  /** 状态变了（重绘机器列表） */
  onStateChange(connection: MachineConnection): void
  /** 服务端事件转发（渲染进程） */
  onEvent(connection: MachineConnection, method: string, params: unknown): void
}

export class MachineConnection {
  readonly id: string
  name: string
  readonly target: ParsedTarget

  state: MachineRuntimeState = 'disconnected'
  detail?: string
  serverInfo?: HelloResult['server']
  hasPendingApproval = false
  /** 这台机器的会话列表（hello 快照 + summaries 事件维护，渲染进程切换时取） */
  summaries: ConversationSummary[] = []
  /** M2 实时卡片的状态（hello 快照 + terminals/browser/team 事件维护） */
  terminals: TerminalsState = { terminals: [], available: false }
  browser: BrowserState = { available: false, tabs: [] }
  team: TeamState = { runs: [] }
  /** 引擎（hello 快照的 state.engines + engines 事件维护；设置窗口用） */
  engines: EngineConfigView[] = []
  /** 新对话默认引擎 */
  defaultEngineID = ''

  liveState(): MachineLiveState {
    return {
      terminals: this.terminals,
      browser: this.browser,
      team: this.team,
      engines: this.engines,
      defaultEngineID: this.defaultEngineID
    }
  }

  private transport: SshTransport | WsTransport | null = null
  private rpc: RpcClient | null = null
  private wanted = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private backoffIndex = 0
  private connecting = false
  private readonly subscriptions = new Set<string>()

  constructor(id: string, name: string, target: ParsedTarget, private readonly host: MachineConnectionHost) {
    this.id = id
    this.name = name
    this.target = target
  }

  get connected(): boolean {
    return this.state === 'ready'
  }

  // MARK: 连接

  connect(): void {
    this.wanted = true
    if (this.connecting || this.state === 'ready') return
    void this.start()
  }

  disconnect(): void {
    this.wanted = false
    this.clearReconnect()
    this.teardown()
    this.state = 'disconnected'
    this.detail = undefined
    this.host.onStateChange(this)
  }

  private async start(): Promise<void> {
    this.connecting = true
    this.clearReconnect()
    this.teardown()
    this.state = this.target.kind === 'ws' ? 'connecting' : 'probing'
    this.detail = undefined
    this.host.onStateChange(this)

    try {
      if (this.target.kind === 'ssh') {
        const transport = new SshTransport(
          {
            onMessage: (line) => this.rpc?.handleMessage(line),
            onExit: ({ sshFailed, stderrTail }) => this.onTransportDown(sshFailed ? sshFailureReason(255, stderrTail) : undefined),
            onError: () => { /* exit 会跟着来 */ }
          },
          () => { /* 原始输出（诊断用） */ }
        )
        this.attach(transport)
        await transport.startSSH({ host: this.target.host ?? '', port: this.target.port, identityFile: this.target.identityFile })
        // --attach 起来后客户端先发 hello（REMOTE.md §3）
        await this.sendHello()
      } else if (this.target.kind === 'wsl') {
        const transport = new SshTransport(
          {
            onMessage: (line) => this.rpc?.handleMessage(line),
            onExit: ({ sshFailed, stderrTail }) => this.onTransportDown(sshFailed ? sshFailureReason(255, stderrTail) : undefined),
            onError: () => { /* exit 会跟着来 */ }
          },
          () => { /* 原始输出 */ }
        )
        this.attach(transport)
        await transport.startWSL(this.target.distro ?? '')
        await this.sendHello()
      } else {
        const url = this.target.url ?? ''
        const pairing = this.target.token
          ? { token: this.target.token, fingerprint: this.target.fingerprint }
          : this.host.pairings.get(url)
        if (!pairing) {
          this.state = 'unpaired'
          this.detail = '没有这台机器的配对信息：粘贴一次配对链接（friday://pair?…）'
          this.connecting = false
          this.host.onStateChange(this)
          return
        }
        // 记下配对（扫码 / 手贴链接带来的令牌只出现这一次）
        if (this.target.token) {
          await this.host.pairings.save(url, {
            token: pairing.token,
            fingerprint: pairing.fingerprint,
            deviceID: this.target.suggestedName
          })
        }
        const transport = new WsTransport({
          onMessage: (text) => this.rpc?.handleMessage(text),
          onOpen: () => void this.sendHello(),
          onClose: () => this.onTransportDown(),
          onError: (error) => {
            if (this.state !== 'ready') {
              this.state = 'failed'
              this.detail = error.message
              this.connecting = false
              this.host.onStateChange(this)
              this.scheduleReconnect()
            }
          }
        })
        this.attach(transport)
        transport.start(url, pairing.fingerprint)
      }
    } catch (error) {
      this.connecting = false
      this.state = 'failed'
      this.detail = error instanceof Error ? error.message : String(error)
      this.host.onStateChange(this)
      if (this.wanted) this.scheduleReconnect()
    }
  }

  private attach(transport: SshTransport | WsTransport): void {
    this.transport = transport
    this.rpc = new RpcClient(
      (text) => transport.send(text),
      () => transport.close()
    )
    this.rpc.onAny((method, params) => {
      if (method === 'bridgeError') {
        // 桥连不上服务（服务没在跑 / 正在被拉起）：REMOTE.md §2
        const message = (params as { message?: string } | undefined)?.message
        this.detail = message ? `桥：${message}` : '桥：friday-server 连不上'
        this.host.onStateChange(this)
      }
      if (method === 'summaries') {
        this.summaries = (params as { summaries: ConversationSummary[] }).summaries ?? []
      }
      // M2 实时卡片：状态事件（每次都是完整快照，REMOTE.md §5）
      if (method === 'terminals') {
        this.terminals = params as TerminalsState
      }
      if (method === 'browser') {
        this.browser = params as BrowserState
      }
      if (method === 'team') {
        this.team = params as TeamState
      }
      if (method === 'engines') {
        const state = params as { engines?: EngineConfigView[]; defaultEngineID?: string }
        this.engines = state.engines ?? []
        this.defaultEngineID = state.defaultEngineID ?? ''
      }
      if (method === 'runner') {
        const runner = params as RunnerState | undefined
        this.hasPendingApproval = !!runner && runner.pendingApproval.length > 0
      }
      this.host.onEvent(this, method, params)
    })
  }

  private async sendHello(): Promise<void> {
    if (!this.rpc) return
    this.state = 'connecting'
    this.host.onStateChange(this)
    const token = this.target.kind === 'ws' ? this.host.pairings.get(this.target.url ?? '')?.token : undefined
    try {
      const result = (await this.rpc.request(
        'hello',
        {
          protocol: PROTOCOL_VERSION,
          client: {
            name: 'Friday Work',
            version: this.host.appVersion,
            platform: 'windows',
            kind: 'desktop'
          },
          features: ['messagePatch'],
          ...(token ? { token } : {})
        },
        30_000
      )) as HelloResult
      this.serverInfo = result.server
      this.summaries = result.state?.summaries ?? []
      this.applyLiveSnapshot(result.state)
      this.state = 'ready'
      this.detail = undefined
      this.backoffIndex = 0
      const runner = result.state?.runner
      this.hasPendingApproval = !!runner && runner.pendingApproval.length > 0
      this.connecting = false
      this.host.onStateChange(this)
      // 恢复订阅（断线重连不补事件：重新 hello + 重新订阅）
      for (const conversationID of [...this.subscriptions]) {
        this.rpc.request('conversation.subscribe', { id: conversationID }).catch(() => {})
      }
    } catch (error) {
      this.connecting = false
      if (error instanceof RpcError && error.code === RpcErrors.ProtocolVersion) {
        this.state = 'versionMismatch'
        this.detail = error.message
        this.wanted = false
      } else if (error instanceof RpcError && error.code === RpcErrors.Unpaired) {
        this.state = 'unpaired'
        this.detail = '配对已失效（令牌被吊销或不认识）：删除这台机器重新配对'
        this.wanted = false
      } else {
        this.state = 'failed'
        this.detail = error instanceof Error ? error.message : String(error)
      }
      this.host.onStateChange(this)
      if (this.wanted) this.scheduleReconnect()
    }
  }

  // MARK: 断线与重连

  /** hello 快照里的实时卡片状态（没这几项的旧服务端保留空值） */
  private applyLiveSnapshot(state: HelloResult['state'] | undefined): void {
    if (!state) return
    if (state.terminals) this.terminals = state.terminals
    if (state.browser) this.browser = state.browser
    if (state.team) this.team = state.team
    if (state.engines) {
      const engines = state.engines as { engines?: EngineConfigView[]; defaultEngineID?: string }
      this.engines = engines.engines ?? []
      this.defaultEngineID = engines.defaultEngineID ?? ''
    }
  }

  private onTransportDown(reason?: string): void {
    const wasReady = this.state === 'ready'
    this.teardown()
    if (!this.wanted) {
      this.state = 'disconnected'
      this.host.onStateChange(this)
      return
    }
    this.state = 'failed'
    this.detail = reason ?? (wasReady ? '连接断了，马上重连' : '连不上')
    this.host.onStateChange(this)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.reconnectTimer) return
    const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)]
    this.backoffIndex += 1
    this.detail = `${this.detail ?? '连不上'}（${Math.round(delay / 1000)} 秒后重试）`
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.wanted) void this.start()
    }, delay)
    this.host.onStateChange(this)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private teardown(): void {
    this.rpc?.failAll(new Error('连接已断开'))
    this.transport?.close()
    this.transport = null
    this.rpc = null
    this.connecting = false
  }

  // MARK: 操作

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.rpc || this.state !== 'ready') {
      return Promise.reject(new RpcError(-32000, this.detail ?? '还没连上这台机器'))
    }
    return this.rpc.request(method, params)
  }

  /** 登记会话订阅：ready 时马上发（返回订阅回执：整段会话 + runtime + versions），重连后自动恢复 */
  subscribeConversation(conversationID: string): Promise<unknown> {
    this.subscriptions.add(conversationID)
    if (this.rpc && this.state === 'ready') {
      return this.rpc.request('conversation.subscribe', { id: conversationID })
    }
    return Promise.reject(new RpcError(-32000, this.detail ?? '还没连上这台机器'))
  }

  unsubscribeConversation(conversationID: string): void {
    this.subscriptions.delete(conversationID)
    if (this.rpc && this.state === 'ready') {
      this.rpc.request('conversation.unsubscribe', { id: conversationID }).catch(() => {})
    }
  }

  /** 机器信息（给渲染进程） */
  info() {
    return {
      id: this.id,
      name: this.name,
      targetKind: this.target.kind,
      targetText: targetText(this.target),
      state: this.state,
      detail: this.detail,
      serverInfo: this.serverInfo,
      hasPendingApproval: this.hasPendingApproval
    }
  }
}

function targetText(target: ParsedTarget): string {
  if (target.kind === 'ws') return target.url ?? ''
  if (target.kind === 'wsl') return `wsl:${target.distro ?? ''}`
  return `ssh:${target.host ?? ''}${target.port ? `:${target.port}` : ''}`
}

export function newMachineID(): string {
  return randomUUID()
}
