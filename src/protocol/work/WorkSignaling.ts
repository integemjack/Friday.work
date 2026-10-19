// WebRTC 工作通道的信令状态机（REMOTE.md §2「WebRTC 工作通道」；0.3 起唯一的连接方式）。
//
// 流程（主叫 = 本机，被叫 = Friday 机器人那头的 RemoteWorkSession）：
//   dial → p2p_request{callType:"work"} → 等 p2p_response{accepted:true}
//   → 渲染进程建 RTCPeerConnection + DataChannel「friday-work」→ offer
//   → p2p_signaling{type:"offer"} → answer / ice_candidate 互送 → DataChannel open → hello
// 挂断 / 通道断开：发 hangup（或 request_cancel 还在响铃时），用新的 requestId 退避重拨。
//
// 媒体与 DataChannel 都在渲染进程（Chromium）；本状态机只经 schat-ws 搬运信令，
// 按 requestId 把每一帧对到对应机器的连接上（一台机器一次重拨一个 requestId）。

import { randomUUID } from 'node:crypto'

/** 一条 work 信令要发给对端时的形状（SchatService 帮忙发） */
export interface WorkSignalingHost {
  /** 发一帧 p2p_* 事件给对端 */
  sendCallFrame(botID: number, event: string, data: Record<string, unknown>): void
  /** 本机账号 id（p2p_* 的 fromUserId） */
  accountID(): number
}

/** 信令事件（协议进程 → 渲染进程，喂 RTCPeerConnection） */
export type WorkSignalEvent =
  | { kind: 'accepted'; requestId: string }
  | { kind: 'signal'; requestId: string; type: string; payload: string }
  | { kind: 'ended'; requestId: string; reason: string }

export class WorkSignaling {
  private requestId = ''
  private peerID = 0
  private ended = true
  private accepted = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly host: WorkSignalingHost,
    private readonly onEvent: (event: WorkSignalEvent) => void
  ) {}

  get activeRequestID(): string {
    return this.requestId
  }

  get peer(): number {
    return this.peerID
  }

  get isActive(): boolean {
    return !this.ended
  }

  /** 发起连接：p2p_request(callType work)。30 秒没被接受就报失败（上层重拨） */
  dial(botID: number): void {
    this.dispose()
    this.peerID = botID
    this.requestId = randomUUID()
    this.ended = false
    this.accepted = false
    this.host.sendCallFrame(botID, 'p2p_request', {
      toUserId: botID,
      fromUserId: this.host.accountID(),
      requestId: this.requestId,
      callType: 'work',
      timestamp: Date.now(),
      expiresAt: Date.now() + 30_000
    })
    this.timer = setTimeout(() => {
      if (!this.ended) this.finish('机器人 30 秒内没接受连接（它在线吗？装的是 2.38+ 吗？）')
    }, 30_000)
  }

  /** p2p_response 进来（accepted / declined） */
  onResponse(requestId: string, accepted: boolean, reason: string): void {
    if (this.ended || requestId !== this.requestId) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (accepted) {
      this.accepted = true
      this.onEvent({ kind: 'accepted', requestId })
    } else {
      const text =
        reason === 'user_rejected'
          ? '机器人拒绝了工作连接（不是主人账号？）'
          : reason === 'error'
            ? '机器人那头没有工作服务（装的是 2.38+ 吗？）'
            : `机器人拒绝了连接（${reason}）`
      this.finish(text)
    }
  }

  /** p2p_signaling 进来（offer / answer / ice_candidate / hangup） */
  onSignal(requestId: string, type: string, payload: string): void {
    if (this.ended || requestId !== this.requestId) return
    if (type === 'hangup' || type === 'request_cancel') {
      this.finish('机器人挂断了工作连接')
      return
    }
    this.onEvent({ kind: 'signal', requestId, type, payload })
  }

  /** 渲染进程要发的信令（offer / ice_candidate） */
  send(type: string, payload: string): void {
    if (this.ended || !this.peerID) return
    this.host.sendCallFrame(this.peerID, 'p2p_signaling', {
      toUserId: this.peerID,
      targetUserId: this.peerID,
      fromUserId: this.host.accountID(),
      requestId: this.requestId,
      type,
      payload,
      timestamp: Date.now()
    })
  }

  /** 挂断（还没被接受就取消，同 CallService 的口径） */
  hangup(): void {
    if (this.ended) return
    if (this.peerID) {
      this.host.sendCallFrame(this.peerID, 'p2p_signaling', {
        toUserId: this.peerID,
        targetUserId: this.peerID,
        fromUserId: this.host.accountID(),
        requestId: this.requestId,
        type: this.accepted ? 'hangup' : 'request_cancel',
        payload: '',
        timestamp: Date.now()
      })
    }
    this.finish('已断开')
  }

  private finish(reason: string): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.ended) return
    this.ended = true
    const requestId = this.requestId
    this.onEvent({ kind: 'ended', requestId, reason })
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.ended = true
    this.accepted = false
    this.requestId = ''
    this.peerID = 0
  }
}
