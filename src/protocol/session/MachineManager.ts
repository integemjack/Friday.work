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
  type DirectoriesState,
  type EngineConfigView,
  type HelloResult,
  type MachineLiveState,
  type RunnerState,
  type TeamState,
  type TerminalsState
} from '../rpc/protocol.js'
import type { MachineRuntimeState, ParsedTarget } from '../../shared/api.js'
import { targetToText } from '../session/TargetParse.js'
import { WorkSignaling, type WorkSignalingHost, type WorkSignalEvent } from '../work/WorkSignaling.js'
import { WorkTransport, type WorkPortMessage } from '../work/WorkTransport.js'

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000]

export interface MachineConnectionHost {
  appVersion: string
  /** 状态变了（重绘机器列表） */
  onStateChange(connection: MachineConnection): void
  /** 服务端事件转发（渲染进程） */
  onEvent(connection: MachineConnection, method: string, params: unknown): void
  /** work 通道：信令主机（SChat 没在线给 null，机器报「先扫码登录」） */
  workSignalingHost(): WorkSignalingHost | null
  /** work 通道：给渲染进程发消息（MessagePort 数据面） */
  workPortSend(message: WorkPortMessage): void
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
  /** 最近选择的工作目录（hello 快照 + directories 事件维护；输入框的目录选择器用；旧服务端 null） */
  directories: DirectoriesState | null = null
  /** 运行状态（hello 快照 + runner 事件维护；标题栏的实时智能体数 / token 速度用） */
  runner?: RunnerState

  liveState(): MachineLiveState {
    return {
      terminals: this.terminals,
      browser: this.browser,
      team: this.team,
      runner: this.runner,
      engines: this.engines,
      defaultEngineID: this.defaultEngineID,
      directories: this.directories ?? undefined
    }
  }

  private transport: WorkTransport | null = null
  private workSignaling: WorkSignaling | null = null
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
    this.state = 'connecting'
    this.detail = undefined
    this.host.onStateChange(this)

    try {
      // 0.3：唯一的连接方式——WebRTC 工作通道（SChat 扫码后的机器人，REMOTE.md §2）
      const signalingHost = this.host.workSignalingHost()
      if (!signalingHost) {
        this.connecting = false
        this.state = 'failed'
        this.detail = 'SChat 没在线：先在登录页扫码登录'
        this.host.onStateChange(this)
        if (this.wanted) this.scheduleReconnect()
        return
      }
      const transport = new WorkTransport(this.id, (message) => this.host.workPortSend(message))
      transport.onMessage((text) => this.rpc?.handleMessage(text))
      transport.onClose((reason) => this.onTransportDown(reason))
      this.attach(transport)
      this.workSignaling = new WorkSignaling(signalingHost, (event) => this.onWorkEvent(event))
      this.detail = '正在呼叫机器人（WebRTC）…'
      this.host.onStateChange(this)
      this.workSignaling.dial(this.target.botUserID ?? 0)
    } catch (error) {
      this.connecting = false
      this.state = 'failed'
      this.detail = error instanceof Error ? error.message : String(error)
      this.host.onStateChange(this)
      if (this.wanted) this.scheduleReconnect()
    }
  }

  private attach(transport: WorkTransport): void {
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
      if (method === 'directories') {
        this.directories = params as DirectoriesState
      }
      if (method === 'runner') {
        const runner = params as RunnerState | undefined
        this.runner = runner
        this.hasPendingApproval = !!runner && runner.pendingApproval.length > 0
      }
      this.host.onEvent(this, method, params)
    })
  }

  // MARK: work 通道（渲染进程 ⇆ 协议进程）

  private onWorkEvent(event: WorkSignalEvent): void {
    if (event.kind === 'ended') {
      // 被同一账号的另一台设备顶掉（旧版服务端的「新拨顶旧」）：不重拨——
      // 重拨会把对方顶掉、来回互踢；等服务端升到 2.44+（多端并存）或用户手动重连
      if (event.replaced) {
        this.wanted = false
        this.clearReconnect()
        this.teardown()
        this.state = 'failed'
        this.detail = '同一账号的另一台设备正在使用这台机器（服务端 ≤ 2.43 会顶掉已有连接）'
        this.connecting = false
        this.host.onStateChange(this)
        return
      }
      // 信令断了（被拒 / 超时 / 对端挂断）：走传输断开的路（退避重拨用新 requestId）
      this.onTransportDown(event.reason)
      return
    }
    this.host.workPortSend({ type: 'work.signal', machineID: this.id, signal: event })
  }

  /** 渲染进程：DataChannel 打开了（接着 hello） */
  handleWorkOpen(): void {
    const transport = this.transport instanceof WorkTransport ? this.transport : null
    if (!transport) return
    transport.handleOpen()
    void this.sendHello()
  }

  /** 渲染进程：DataChannel 收到一条完整 JSON */
  handleWorkIn(text: string): void {
    if (this.transport instanceof WorkTransport) this.transport.handleMessage(text)
  }

  /** 渲染进程：通道断了 */
  handleWorkClosed(reason: string): void {
    if (this.transport instanceof WorkTransport) this.transport.handleClosed(reason)
  }

  /** 渲染进程要发信令（offer / ice_candidate） */
  handleWorkSignalOut(signalType: string, payload: string): void {
    this.workSignaling?.send(signalType, payload)
  }

  /** SChat 的 p2p 帧进来（botID 对得上这台）：认领是这台 work 会话的才处理。
   *  返回认领了没有——同一个 bot 可以同时有 audio 通话，requestId 不是 work 会话的
   *  要交回普通通话（SchatService 据此决定截不截） */
  handleWorkEnvelope(event: string, data: Record<string, unknown>): boolean {
    if (event === 'offline') {
      this.invalidateWork('SChat 连接断了')
      return true
    }
    const requestId = typeof data.requestId === 'string' ? data.requestId : String(data.requestId ?? '')
    const signaling = this.workSignaling
    if (!signaling) return false
    if (event === 'p2p_request') {
      // callType work 的请求才这台管（SchatService 已按 callType 过滤；到这里的都是重拨）
      return String(data.callType ?? '') === 'work'
    }
    if (!requestId || requestId !== signaling.currentRequestID()) return false
    if (event === 'p2p_response') {
      signaling.onResponse(requestId, !!data.accepted, typeof data.reason === 'string' ? data.reason : '')
      return true
    }
    if (event === 'p2p_signaling') {
      signaling.onSignal(
        requestId,
        typeof data.type === 'string' ? data.type : '',
        typeof data.payload === 'string' ? data.payload : '',
        typeof data.reason === 'string' ? data.reason : ''
      )
      return true
    }
    return false
  }

  /** SChat 掉线：work 机器立刻断开重拨（信令层没了，通道活不成） */
  invalidateWork(reason: string): void {
    if (this.target.kind !== 'work') return
    if (this.transport instanceof WorkTransport) this.transport.handleClosed(reason)
  }

  private async sendHello(): Promise<void> {
    if (!this.rpc) return
    this.state = 'connecting'
    this.host.onStateChange(this)
    try {
      // work 通道：身份是 SChat 主人（信令层验过），不带配对令牌（REMOTE.md §2）
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
          features: ['messagePatch']
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
    if (state.runner) this.runner = state.runner
    if (state.directories) this.directories = state.directories
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

  /** 外部依赖恢复（SChat 重连上线）：不等退避计时，立刻重拨想要的连接。
   *  SChat 断线时这台机器一定断开并进入退避（最长 60 秒才试下一次），
   *  信令层先恢复时由宿主踢这一脚，工作台和视频通话才能马上回来 */
  retryNow(): void {
    if (!this.wanted || this.connecting || this.state === 'ready') return
    this.clearReconnect()
    this.backoffIndex = 0
    void this.start()
  }

  private teardown(): void {
    this.rpc?.failAll(new Error('连接已断开'))
    // 先取快照、先置空再挂断：hangup() 可能同步触发信令回调重入 teardown()，
    // 重入时看到 null 跳过；外层拿着局部变量走完，不会对 null 调 dispose（连接被顶掉时崩过）
    const signaling = this.workSignaling
    this.workSignaling = null
    if (signaling) {
      signaling.hangup()
      signaling.dispose()
    }
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
      targetText: targetToText(this.target),
      state: this.state,
      detail: this.detail,
      serverInfo: this.serverInfo,
      hasPendingApproval: this.hasPendingApproval
    }
  }
}

export function newMachineID(): string {
  return randomUUID()
}
