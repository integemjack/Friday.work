// SChat 通道（M1.5）：扫码登录 → schat-ws 连接 → 好友里的机器人 → 和 Friday bot 对话（含流式拼装）。
//
// 凭据（refreshToken / legacy token）与证书指纹只经主进程 safeStorage 落盘；
// 这里的状态机向渲染进程暴露：未登录 / 登录中（带二维码）/ 已登录（带 bot 列表）/ 出错。

import { randomUUID } from 'node:crypto'
import { createQrSession, fetchFriends, pollQrSession, refreshSession, type QrSessionResult } from './Login.js'
import type { WorkSignalingHost } from '../work/WorkSignaling.js'
import { SchatClient, type SchatEnvelope } from './SchatClient.js'
import { CallService, emptyState, type CallSignal, type CallState } from './CallService.js'
import { iceServersFor, type RTCIceServerLike } from './ice.js'
import type { CredentialBackend } from '../session/PairingStore.js'

const KEY = 'schat'

/** 落盘的 SChat 会话（加密存） */
interface StoredSession {
  server: string
  userId: number
  token: string
  refreshToken: string
  fingerprint: string
  deviceId: string
  deviceName: string
}

export interface SchatBot {
  id: number
  name: string
  botCalls: boolean
}

export interface SchatMessage {
  /** 服务端消息 id（流式期间同一条不变；自己刚发的还没有 = 负数占位） */
  id: number
  senderId: number
  to: number
  content: string
  streaming: boolean
  at: number
  /** 自己发的（乐观更新） */
  mine?: boolean
  /** 发送失败（服务端拒绝，比如不是好友）：气泡标红并显示原因 */
  failed?: string
  /** 自己发出去的幂等键：服务端回显带着它，用来把占位那条换成真消息 */
  clientMsgId?: string
}

export type SchatPhase = 'idle' | 'logging-in' | 'online' | 'error'

export interface SchatState {
  phase: SchatPhase
  server: string
  userId: number
  deviceName: string
  /** 启动时正用存档凭据静默恢复（登录页据此不急着生成新二维码） */
  restoring: boolean
  /** 登录中：要渲染的 SCSH:1:login:<token> */
  qrPayload: string
  qrExpiresAt: number
  status: string
  bots: SchatBot[]
  /** 和一个 bot 的对话（按 bot id） */
  messages: Record<number, SchatMessage[]>
  /** 1:1 通话状态（通话窗口用） */
  call: CallState
  error: string
}

export interface SchatHooks {
  onChange(state: SchatState): void
  /** 收到一帧通话信令（渲染进程拿去喂 RTCPeerConnection） */
  onCallSignal(signal: CallSignal): void
}

/** work 通道（0.3）：callType "work" 的 p2p_* 转给对应机器的连接 */
export interface WorkRoute {
  /** 这帧是不是这台机器 work 会话的（requestId 对得上）？不是就交回普通通话处理 */
  onWorkEnvelope(event: string, data: Record<string, unknown>): boolean
}

/** 生产 chatserver（方案 §7.4：https://47.100.98.3:2012） */
export const DEFAULT_SCHAT_SERVER = 'https://47.100.98.3:2012'

export class SchatService {
  private state: SchatState = {
    phase: 'idle',
    server: DEFAULT_SCHAT_SERVER,
    userId: 0,
    deviceName: '',
    restoring: false,
    qrPayload: '',
    qrExpiresAt: 0,
    status: '',
    bots: [],
    messages: {},
    call: emptyState(),
    error: ''
  }
  private client: SchatClient | null = null
  private session: StoredSession | null = null
  private readonly calls: CallService
  private qr: { cancel(): void } | null = null
  private loading = false
  /** work 通道（0.3）：机器人 → 信令状态机（按 botUserID 一台机器一个） */
  private readonly workRoutes = new Map<number, WorkRoute>()

  constructor(
    private readonly backend: CredentialBackend,
    private readonly hooks: SchatHooks
  ) {
    this.calls = new CallService({
      onState: (call) => this.patch({ call }),
      onSignal: (signal) => this.hooks.onCallSignal(signal),
      sessionInfo: () => ({
        server: this.session?.server ?? DEFAULT_SCHAT_SERVER,
        token: this.session?.token ?? '',
        accountId: this.state.userId,
        fingerprint: this.session?.fingerprint || undefined
      }),
      send: (event, data) => this.client?.emit(event, data)
    })
  }

  /** work 通道：把一台机器的信令状态机接到这个 bot 的 p2p_* 上 */
  registerWorkRoute(botID: number, route: WorkRoute): void {
    this.workRoutes.set(botID, route)
  }

  unregisterWorkRoute(botID: number): void {
    this.workRoutes.delete(botID)
  }

  /** 这帧是不是 work 会话的（该 bot 的在连 work 机器认领这个 requestId）？
   *  同一个 bot 可以同时有 audio 通话和 work 通道：requestId 对得上的才算 work 的 */
  private isWorkFrame(botID: number, event: string, data: Record<string, unknown>): boolean {
    const route = this.workRoutes.get(botID)
    if (!route) return false
    return route.onWorkEnvelope(event, data)
  }

  /** work 通道的发帧能力（MachineConnection → WorkSignaling 用） */
  workHost(): WorkSignalingHost | null {
    if (this.state.phase !== 'online' || !this.client) return null
    return {
      sendCallFrame: (botID, event, data) => this.client?.emit(event, data),
      accountID: () => this.state.userId
    }
  }

  getState(): SchatState {
    return this.state
  }

  private patch(partial: Partial<SchatState>): void {
    this.state = { ...this.state, ...partial }
    this.hooks.onChange(this.state)
  }

  /** 启动时读回已登录的会话（有就直连，不再扫码）。restoring 期间渲染层的登录页显示「正在恢复」而不是立刻生成新二维码 */
  async load(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.patch({ restoring: true })
    try {
      const raw = await this.backend.load(KEY)
      if (!raw) return
      const stored = JSON.parse(raw) as StoredSession
      if (!stored?.server || !stored.token) return
      this.session = stored
      this.patch({ server: stored.server, userId: stored.userId, deviceName: stored.deviceName, status: '正在连接聊天服务器…' })
      await this.connectWs()
    } catch {
      // 存档坏了当没登录
    } finally {
      this.loading = false
      this.patch({ restoring: false })
    }
  }

  /** 开始扫码登录：建会话、把二维码内容交给界面、轮询到批准 */
  async startLogin(server?: string, deviceName?: string): Promise<SchatState> {
    this.qr?.cancel()
    const chosen = (server?.trim() || this.state.server || DEFAULT_SCHAT_SERVER).replace(/\/+$/, '')
    const name = deviceName?.trim() || `Friday Work（${process.platform === 'win32' ? 'Windows' : 'Linux'}）`
    this.patch({ phase: 'logging-in', server: chosen, deviceName: name, qrPayload: '', status: '正在获取登录二维码…', error: '' })

    // 设备 id 一次登录一份，落盘以后复用（服务端靠它绑定 poll）
    const existing = await this.loadStored()
    const deviceId = existing?.deviceId ?? randomUUID()

    try {
      const session = await createQrSession(chosen, {
        deviceId,
        deviceName: name,
        fingerprint: existing?.server === chosen ? existing.fingerprint : undefined
      })
      this.patch({
        qrPayload: session.payload,
        qrExpiresAt: session.expiresAt,
        status: '用手机 Secret-Chat 扫一扫上面的二维码'
      })
      const tick = async (): Promise<void> => {
        if (this.state.qrPayload !== session.payload) return
        if (Date.now() > session.expiresAt) {
          this.patch({ status: '二维码已过期', phase: 'error', error: '二维码已过期，重新生成一个' })
          return
        }
        const status = await pollQrSession(chosen, session, {
          onStatus: (value, detail) => {
            if (value === 'scanned') this.patch({ status: '已扫描，请在手机上确认' })
            if (value === 'pending') this.patch({ status: '等着你扫码…' })
            if (value === 'expired') this.patch({ status: detail ?? '二维码已失效', phase: 'error', error: detail ?? '' })
            if (value === 'error' && detail) this.patch({ status: `轮询出错：${detail}` })
          },
          onSession: (result) => void this.onApproved(chosen, name, deviceId, result),
          onError: (message) => this.patch({ phase: 'error', error: message })
        })
        if (status === 'approved' || status === 'expired') return
        setTimeout(() => void tick(), session.intervalMs)
      }
      setTimeout(() => void tick(), session.intervalMs)
      return this.state
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.patch({ phase: 'error', error: message, status: message })
      return this.state
    }
  }

  private async loadStored(): Promise<StoredSession | null> {
    try {
      const raw = await this.backend.load(KEY)
      return raw ? (JSON.parse(raw) as StoredSession) : null
    } catch {
      return null
    }
  }

  private async onApproved(server: string, deviceName: string, deviceId: string, result: QrSessionResult): Promise<void> {
    // 登录成功：把码收起来（否则窗口里还挂着一个已用掉的二维码）
    this.patch({ status: '登录成功，正在连接…', qrPayload: '', qrExpiresAt: 0 })
    const fingerprint = this.session?.server === server ? this.session.fingerprint : ''
    const stored: StoredSession = {
      server,
      userId: result.userId,
      token: result.token,
      refreshToken: result.refreshToken,
      fingerprint,
      deviceId,
      deviceName
    }
    this.session = stored
    await this.backend.store(KEY, JSON.stringify(stored))
    await this.connectWs()
  }

  /** 有凭据就直连（每次连接前先刷一次 refreshToken，rotation 后写回） */
  private async connectWs(): Promise<void> {
    if (!this.session) return
    this.client?.close()
    const session = this.session
    try {
      if (session.refreshToken) {
        try {
          const refreshed = await refreshSession(session.server, session.refreshToken, {
            fingerprint: session.fingerprint || undefined
          })
          session.token = refreshed.token
          session.refreshToken = refreshed.refreshToken
          session.userId = refreshed.userId || session.userId
          await this.backend.store(KEY, JSON.stringify(session))
        } catch {
          // 刷新失败就用旧 token 试（可能还没过期）
        }
      }
      const url = this.wsUrl(session.server)
      const client = new SchatClient({
        url,
        token: session.token,
        deviceId: session.deviceId,
        deviceName: session.deviceName,
        fingerprint: session.fingerprint || undefined,
        onFingerprint: (fingerprint) => {
          session.fingerprint = fingerprint
          void this.backend.store(KEY, JSON.stringify(session))
        },
        onEvent: (envelope) => this.onEnvelope(envelope),
        onState: (state, detail) => {
          if (state === 'online') {
            this.patch({ phase: 'online', userId: session.userId, status: '' })
            void this.loadBots()
          } else if (state === 'kicked') {
            this.patch({ phase: 'error', status: detail ?? '凭据已失效', error: '凭据已失效，请重新扫码登录' })
          } else if (state === 'offline') {
            this.patch({ phase: 'idle', status: detail ?? '' })
            // 掉线：还在通话的话一并结束；work 机器也断（信令层没了）
            this.calls.onDisconnected()
            this.workRoutes.forEach((route) => route.onWorkEnvelope('offline', {}))
          }
        }
      })
      this.client = client
      await client.connect()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.patch({ phase: 'error', error: message, status: message })
    }
  }

  /** https://host:port → wss://host:port/ws（chatserver 的 WS 入口） */
  private wsUrl(server: string): string {
    const url = new URL(server)
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${url.host}/ws`
  }

  /** 好友里 isBot 的那些（周五机器人就在这）；登录页/聊天窗都能主动刷新 */
  async loadBots(): Promise<void> {
    if (!this.session) return
    try {
      const friends = await fetchFriends(this.session.server, this.session.token, {
        fingerprint: this.session.fingerprint || undefined
      })
      const bots = friends
        .filter((friend) => friend.isBot && !friend.botDisabled)
        .map((friend) => ({
          id: friend.id,
          // 备注（relation.ext.remark）是给我的私有别名，优先于昵称
          name: friend.relation?.ext?.remark?.trim() || friend.nickname || friend.name,
          botCalls: !!friend.botCalls
        }))
        .filter((bot, index, list) => list.findIndex((other) => other.id === bot.id) === index)
      this.patch({ bots })
    } catch (error) {
      this.patch({ status: `读机器人列表失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  /** 给它打电话（主叫） */
  dial(peerID: number, callType: 'audio' | 'video' = 'audio'): CallState {
    if (this.state.phase !== 'online') throw new Error('还没连上聊天服务器')
    const bot = this.state.bots.find((item) => item.id === peerID)
    const call = this.calls.dial(peerID, bot?.name ?? `机器人 ${peerID}`, callType)
    return call
  }

  /** 信令（渲染进程建好 PC 后发给对端） */
  callSignal(type: string, payload: string): void {
    this.calls.signal(type, payload)
  }

  /** 本端已接通（收到 answer 后） */
  callActive(): void {
    this.calls.markActive()
  }

  callMute(muted: boolean): void {
    this.calls.setMuted(muted)
  }

  /** 接听来电 */
  callAccept(): void {
    this.calls.accept()
  }

  /** 拒接来电 */
  callReject(): void {
    this.calls.reject()
  }

  callHangup(): void {
    this.calls.hangup()
  }

  /** 拉这通电话用的 ICE 服务器（内置 STUN + 服务端 TURN） */
  async iceServers(): Promise<RTCIceServerLike[]> {
    if (!this.session) return []
    return iceServersFor(this.session.server, this.session.token, this.state.userId, {
      fingerprint: this.session.fingerprint || undefined
    })
  }

  private onEnvelope(envelope: SchatEnvelope): void {
    // work 通道（0.3）：callType "work" 的请求、以及命中在连机器 work 会话（requestId 对得上）的回执/信令，
    // 转给对应机器的连接；同一个 bot 的 audio 通话信令不截（requestId 不是 work 会话的就不算）
    const d = envelope.d as Record<string, unknown> | undefined
    if (d && typeof d === 'object') {
      if (envelope.e === 'p2p_response' || envelope.e === 'p2p_signaling' || envelope.e === 'p2p_request') {
        // eslint-disable-next-line no-console
        console.log(`[schat] ← ${envelope.e} req=${String(d.requestId ?? '')} type=${String(d.type ?? '')} accepted=${String(d.accepted ?? '')} reason=${String(d.reason ?? '')} from=${String(d.fromUserId ?? '')}`)
      }
      const botID = Number(d.fromUserId ?? 0)
      if (botID && envelope.e === 'p2p_response' && this.isWorkFrame(botID, envelope.e, d)) return
      if (botID && envelope.e === 'p2p_signaling' && this.isWorkFrame(botID, envelope.e, d)) return
      if (botID && envelope.e === 'p2p_request' && d.callType === 'work' && this.workRoutes.has(botID)) {
        this.workRoutes.get(botID)?.onWorkEnvelope(envelope.e, d)
        return
      }
    }
    // 通话信令优先交给通话状态机（p2p_request / response / signaling / glare）
    if (
      envelope.e === 'p2p_response' ||
      envelope.e === 'p2p_signaling' ||
      envelope.e === 'p2p_request' ||
      envelope.e === 'p2p_glare'
    ) {
      this.calls.onEnvelope(envelope)
      return
    }
    if (envelope.e === 'message') {
      const message = envelope.d as {
        id?: number
        senderId?: number
        receiverId?: number
        content?: string
        createdAt?: number
        streaming?: boolean
        clientMsgId?: string
      } | undefined
      if (!message || typeof message.id !== 'number') return
      const peer = message.senderId === this.state.userId ? message.receiverId : message.senderId
      if (typeof peer !== 'number') return
      this.upsertMessage(peer, {
        id: message.id,
        senderId: message.senderId ?? 0,
        to: peer,
        content: message.content ?? '',
        streaming: !!message.streaming,
        at: message.createdAt ?? Date.now(),
        mine: message.senderId === this.state.userId,
        ...(message.clientMsgId ? { clientMsgId: message.clientMsgId } : {})
      })
      return
    }
    // bot 流式：delta 追加、done 用终版覆盖
    if (envelope.e === 'bot_stream_delta') {
      const data = envelope.d as { messageId?: number; index?: number; delta?: string } | undefined
      if (typeof data?.messageId !== 'number' || !data.delta) return
      for (const list of Object.values(this.state.messages)) {
        const target = list.find((item) => item.id === data.messageId)
        if (target) {
          target.content += data.delta
          target.streaming = true
          this.patch({ messages: { ...this.state.messages } })
          return
        }
      }
      return
    }
    if (envelope.e === 'bot_stream_done') {
      const data = envelope.d as { messageId?: number; content?: string } | undefined
      if (typeof data?.messageId !== 'number') return
      for (const [peer, list] of Object.entries(this.state.messages)) {
        const target = list.find((item) => item.id === data.messageId)
        if (target) {
          target.content = data.content ?? target.content
          target.streaming = false
          this.patch({ messages: { ...this.state.messages } })
          void peer
          return
        }
      }
    }
  }

  private upsertMessage(peer: number, message: SchatMessage): void {
    const list = [...(this.state.messages[peer] ?? [])]
    // 先按 id 找；找不到再按 clientMsgId 找（自己发的那条在服务端回显前是负数占位）
    let index = list.findIndex((item) => item.id === message.id)
    if (index < 0 && message.clientMsgId) {
      index = list.findIndex((item) => item.clientMsgId === message.clientMsgId && item.id < 0)
    }
    if (index < 0 && message.mine && message.id > 0) {
      // 老路径：没有 clientMsgId 的回显，按内容 + 时间就近归并
      index = list.findIndex(
        (item) => item.mine && item.id < 0 && item.content === message.content && item.to === message.to
      )
    }
    if (index >= 0) list[index] = { ...list[index]!, ...message }
    else list.push(message)
    list.sort((a, b) => a.at - b.at)
    this.patch({ messages: { ...this.state.messages, [peer]: list } })
  }

  /** 给某个 bot 发一句话（流式回复随后从事件里来） */
  async send(botID: number, text: string): Promise<void> {
    if (!this.client || this.client.state !== 'online') throw new Error('还没连上聊天服务器')
    const clientMsgId = randomUUID()
    const placeholder = -Date.now()
    // 乐观更新：先画出自己的这句
    this.upsertMessage(botID, {
      id: placeholder,
      senderId: this.state.userId,
      to: botID,
      content: text,
      streaming: false,
      at: Date.now(),
      mine: true,
      clientMsgId
    })
    try {
      // 线上接收者必须带类型前缀："user:N" | "room:N"（chatserver ws.go convAddr）；
      // 纯数字会被当成 bad recipient 拒掉。
      await this.client.request('message', { to: `user:${botID}`, clientMsgId, type: 'text', content: text })
    } catch (error) {
      // 服务端拒了（比如 not_friends）：把这条标成失败，并把原因告诉调用方
      const reason = error instanceof Error ? error.message : String(error)
      const list = this.state.messages[botID] ?? []
      const index = list.findIndex((item) => item.clientMsgId === clientMsgId)
      if (index >= 0) {
        const next = [...list]
        next[index] = { ...next[index]!, failed: reason }
        this.patch({ messages: { ...this.state.messages, [botID]: next } })
      }
      throw new Error(reason)
    }
  }

  disconnect(): void {
    this.qr?.cancel()
    this.qr = null
    this.client?.close()
    this.client = null
    this.session = null
    void this.backend.delete(KEY)
    this.patch({ phase: 'idle', qrPayload: '', bots: [], messages: {}, status: '', error: '', userId: 0 })
  }
}
