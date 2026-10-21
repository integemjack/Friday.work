// 1:1 通话的信令状态机（Secret-Chat docs/cross_end_contract_events.md「机器人通话」一节）。
//
// 只做信令，不碰媒体：媒体（RTCPeerConnection / getUserMedia）在渲染进程，Chromium 自带。
// 主叫（用户 → 机器人）：
//   p2p_request {toUserId, requestId, callType, timestamp, expiresAt, callerName}
//   ← p2p_response {fromUserId, requestId, accepted, reason?, targetUserId}
//   → p2p_signaling {toUserId, targetUserId, fromUserId, requestId, type:"offer", payload:<sdp>, timestamp}
//   ← p2p_signaling type:"answer" / "ice_candidate"
//   → p2p_signaling type:"hangup"（通话中）或 "request_cancel"（还在振铃时取消）
// 同时拨打由服务端裁决（p2p_glare {callId, role, peerId, callType, supersededRequestId}）。

import { randomUUID } from 'node:crypto'
import type { SchatEnvelope } from './SchatClient.js'

export type CallPhase = 'idle' | 'incoming' | 'outgoing' | 'connecting' | 'active' | 'ended'

export interface CallState {
  phase: CallPhase
  /** 对端（机器人）id */
  peerID: number
  peerName: string
  requestId: string
  callType: 'audio' | 'video'
  /** 是别人打进来的（来电） */
  incoming: boolean
  /** 开始拨打 / 接通 / 结束的时刻（ms） */
  startedAt: number
  /** 来电时：振铃开始 */
  ringingAt: number
  /** 来电时：我接听的时刻 */
  acceptedAt: number
  connectedAt: number
  endedAt: number
  endedReason: string
  /** 结束原因码（offline / busy / bot_no_p2p / not_friends / blocked / error / timeout） */
  endedCode: string
  /** 本端静音 */
  muted: boolean
  durationSec: number
}

/** 一帧要交给渲染进程的信令 */
export interface CallSignal {
  requestId: string
  fromUserId: number
  type: string
  payload: string
}

export interface CallHost {
  /** 状态变了（推给渲染进程） */
  onState(state: CallState): void
  /** 收到对端信令（渲染进程拿去喂 RTCPeerConnection） */
  onSignal(signal: CallSignal): void
  /** 这一通所属账号的 server/token/account（拉 ICE 用） */
  sessionInfo(): { server: string; token: string; accountId: number; fingerprint?: string }
  /** 发一帧 schat-ws（不关心 ack） */
  send(event: string, data: Record<string, unknown>): void
}

const REJECT_TEXT: Record<string, string> = {
  offline: '它现在不在线（机器人没连上通话）',
  busy: '它正在通话中',
  bot_no_p2p: '这个机器人没有开通通话',
  not_friends: '还不是好友',
  blocked: '对方拒绝了',
  error: '对方出错了',
  timeout: '没有接听'
}

/** 机器人端多设备「新拨顶旧」的挂断原因（与 WorkSignaling 的口径一致） */
const REPLACED_REASONS = ['新的连接来了', 'replaced']

export class CallService {
  state: CallState = emptyState()

  constructor(private readonly host: CallHost) {}

  /** 拨打（主叫）。返回当前状态；媒体由渲染进程随后建。 */
  dial(peerID: number, peerName: string, callType: 'audio' | 'video' = 'audio'): CallState {
    if (this.state.phase !== 'idle' && this.state.phase !== 'ended') {
      throw new Error('已经有一通电话在进行')
    }
    const requestId = randomUUID()
    const now = Date.now()
    this.setState({
      ...emptyState(),
      phase: 'outgoing',
      incoming: false,
      peerID,
      peerName,
      requestId,
      callType,
      startedAt: now
    })
    const { accountId } = this.host.sessionInfo()
    this.host.send('p2p_request', {
      toUserId: peerID,
      fromUserId: accountId,
      requestId,
      callType,
      timestamp: now,
      expiresAt: now + 30_000
    })
    return this.state
  }

  /** 发一帧信令给对端（渲染进程建好 PC 后用它送 offer / answer / ice） */
  signal(type: string, payload: string): void {
    const state = this.state
    if (!state.peerID || !state.requestId) return
    const { accountId } = this.host.sessionInfo()
    this.host.send('p2p_signaling', {
      toUserId: state.peerID,
      targetUserId: state.peerID,
      fromUserId: accountId,
      requestId: state.requestId,
      type,
      payload,
      timestamp: Date.now()
    })
  }

  /**
   * 接听来电（被叫）。回应 p2p_response{accepted:true}，之后等主叫的 offer。
   * 契约：被叫的 answer 只留 Opus/H.264、沿用对方 offer 的 payload type（Chromium 自己处理）。
   */
  accept(): void {
    if (this.state.phase !== 'incoming') return
    const now = Date.now()
    this.setState({ ...this.state, phase: 'connecting', acceptedAt: now })
    this.respond(true)
  }

  /** 拒接来电 */
  reject(reason = 'decline'): void {
    if (this.state.phase !== 'incoming') return
    this.respond(false, reason)
    this.end('已拒接', reason)
  }

  private respond(accepted: boolean, reason = ''): void {
    const state = this.state
    if (!state.peerID || !state.requestId) return
    const { accountId } = this.host.sessionInfo()
    this.host.send('p2p_response', {
      targetUserId: state.peerID,
      fromUserId: accountId,
      requestId: state.requestId,
      accepted,
      timestamp: Date.now(),
      ...(reason ? { reason } : {})
    })
  }

  /** 本端标记接通（渲染进程收到 setRemoteDescription(answer) 后调） */
  markActive(): void {
    if (this.state.phase !== 'connecting' && this.state.phase !== 'outgoing') return
    const now = Date.now()
    this.setState({ ...this.state, phase: 'active', connectedAt: now })
  }

  setMuted(muted: boolean): void {
    if (this.state.phase === 'idle') return
    this.setState({ ...this.state, muted })
    // iOS/Android 的 media_state 口径：JSON 字符串 {video, muted}（1:1 是空 callId）
    this.signal('media_state', JSON.stringify({ video: this.state.callType === 'video', muted }))
  }

  /** 挂断 / 取消（还在振铃时发 request_cancel） */
  hangup(reason = ''): void {
    const state = this.state
    if (state.phase === 'idle' || state.phase === 'ended') return
    const type = state.phase === 'active' || state.phase === 'connecting' ? 'hangup' : 'request_cancel'
    const durationSec = state.connectedAt ? Math.max(0, Math.round((Date.now() - state.connectedAt) / 1000)) : 0
    const { accountId } = this.host.sessionInfo()
    this.host.send('p2p_signaling', {
      toUserId: state.peerID,
      targetUserId: state.peerID,
      fromUserId: accountId,
      requestId: state.requestId,
      type,
      payload: '',
      timestamp: Date.now(),
      ...(type === 'hangup' ? { durationSec } : {}),
      ...(reason ? { reason } : {})
    })
    this.end(reason || '已挂断')
  }

  /** 服务端/对端事件入口 */
  onEnvelope(envelope: SchatEnvelope): void {
    const d = (envelope.d ?? {}) as Record<string, unknown>
    switch (envelope.e) {
      case 'p2p_response': {
        if (d.requestId !== this.state.requestId) return
        // 同账号多设备：回执扇出到所有设备。还在振铃（没接）说明接的是另一台
        //（自己接会先把 phase 切成 connecting 再发回执）；已接/已挂后到的都是迟到重发，忽略
        if (this.state.phase === 'incoming') {
          this.end(d.accepted === true ? '已在其他设备接听' : '已在其他设备挂断')
          return
        }
        if (this.state.phase !== 'outgoing') return
        if (d.accepted === true) {
          this.setState({ ...this.state, phase: 'connecting' })
        } else {
          const reason = typeof d.reason === 'string' ? d.reason : 'error'
          this.end(REJECT_TEXT[reason] ?? `对方拒绝了（${reason}）`, reason)
        }
        return
      }
      case 'p2p_signaling': {
        if (this.state.phase === 'idle' || this.state.phase === 'ended') return
        if (d.requestId !== this.state.requestId) return
        const from = Number(d.fromUserId ?? 0)
        if (from && from !== this.state.peerID) return
        const type = String(d.type ?? '')
        if (type === 'hangup' || type === 'request_cancel') {
          const reason = typeof d.reason === 'string' ? d.reason : ''
          if (REPLACED_REASONS.includes(reason)) {
            // 机器人端「新拨顶旧」：同一账号另一台设备拨号，这通被顶掉。不自动重拨——
            // 重拨会把对方顶掉、来回互踢（和 work 通道被顶同一个处理）
            this.end('同一账号的另一台设备把这条通话顶掉了', 'replaced')
          } else {
            this.end(type === 'request_cancel' ? '对方取消了' : '对方挂断了')
          }
          return
        }
        // 扇出防串台：还在振铃（没接）就收到 offer/ice = 另一台在处理这通，别抢答
        if (this.state.phase === 'incoming') {
          this.end('已在其他设备接听')
          return
        }
        // 方向校验：主叫只收 answer/ice，被叫只收 offer/ice，串了就是扇出串台
        if (type === 'offer' && !this.state.incoming) return
        if (type === 'answer' && this.state.incoming) return
        // 其余（offer/answer/ice_candidate/media_state）交给渲染进程
        this.host.onSignal({
          requestId: this.state.requestId,
          fromUserId: from,
          type,
          payload: String(d.payload ?? '')
        })
        return
      }
      case 'p2p_glare': {
        // 同时拨打：服务端裁决谁继续
        if (d.supersededRequestId === this.state.requestId && d.role === 'callee') {
          this.end('同时拨打，这通被对方那通接替了')
        }
        return
      }
      case 'p2p_request': {
        // 机器人主动打来（契约：机器人通话连接上发 p2p_request）
        const from = Number(d.fromUserId ?? d.toUserId ?? 0)
        const requestId = String(d.requestId ?? '')
        if (!from || !requestId) return
        // 正在通话/振铃中：回 busy（服务端闸也会拦，这里不抱侥幸）
        if (this.state.phase !== 'idle' && this.state.phase !== 'ended') {
          this.host.send('p2p_response', {
            targetUserId: from,
            fromUserId: this.host.sessionInfo().accountId,
            requestId,
            accepted: false,
            reason: 'busy',
            timestamp: Date.now()
          })
          return
        }
        const callType = d.callType === 'video' ? 'video' : 'audio'
        const now = Date.now()
        this.setState({
          ...emptyState(),
          phase: 'incoming',
          incoming: true,
          peerID: from,
          peerName: typeof d.callerName === 'string' && d.callerName ? d.callerName : `机器人 ${from}`,
          requestId,
          callType,
          startedAt: now,
          ringingAt: now
        })
        return
      }
    }
  }

  /** 连接断了：通话一并结束（disconnected 码让渲染层知道这是断线弄断的，恢复后可自动重拨） */
  onDisconnected(): void {
    if (this.state.phase === 'idle' || this.state.phase === 'ended') return
    this.end('连接断了', 'disconnected')
  }

  private end(reason: string, code = ''): void {
    this.setState({
      ...this.state,
      phase: 'ended',
      endedAt: Date.now(),
      endedReason: reason,
      endedCode: code,
      durationSec: this.state.connectedAt ? Math.round((Date.now() - this.state.connectedAt) / 1000) : 0
    })
  }

  private setState(state: CallState): void {
    this.state = state
    this.host.onState(state)
  }
}

export function emptyState(): CallState {
  return {
    phase: 'idle',
    peerID: 0,
    peerName: '',
    requestId: '',
    callType: 'audio',
    startedAt: 0,
    connectedAt: 0,
    endedAt: 0,
    endedReason: '',
    endedCode: '',
    incoming: false,
    ringingAt: 0,
    acceptedAt: 0,
    muted: false,
    durationSec: 0
  }
}
