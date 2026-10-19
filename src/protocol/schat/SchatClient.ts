// schat-ws/v1 客户端（Secret-Chat docs/raw_ws_protocol.md）。
// 信封：{ e: 事件名, d: 载荷, a: ackId, t: req|ev|ack|err }
// 连上后第一帧必须 hello；被踢（auth_expired）后不许自动重连。

import { WebSocket } from 'ws'
import { normalizeFingerprint } from './http.js'

export type SchatEnvelopeType = 'req' | 'ev' | 'ack' | 'err'

export interface SchatEnvelope {
  e: string
  d?: unknown
  a?: string
  t?: SchatEnvelopeType
}

export interface SchatClientOptions {
  url: string
  token: string
  deviceId: string
  deviceName: string
  /** 证书指纹（去冒号小写）；不给就第一次见到记下 */
  fingerprint?: string
  serverPassword?: string
  onFingerprint?(fingerprint: string): void
  onEvent(envelope: SchatEnvelope): void
  onState(state: 'connecting' | 'online' | 'offline' | 'kicked', detail?: string): void
}

const ACK_TIMEOUT_MS = 15_000

/** 服务端用 t:"ack" + {success:false, error} 表示业务拒绝（三端约定：不重试，但要让用户看见） */
export class SchatRejected extends Error {
  constructor(
    readonly code: string,
    readonly ack: unknown
  ) {
    super(rejectText(code))
  }
}

/** 拒绝码 → 人话（对齐 Secret-Chat 三端的既有文案口径） */
function rejectText(code: string): string {
  switch (code) {
    case 'not_friends':
      return '还没和这个机器人成为好友（或陌生人额度用完了）：先在手机上把它加为好友'
    case 'blocked':
      return '对方把你拉黑了'
    case 'contentLimitExceeded':
      return '内容太长了'
    default:
      return code ? `发送失败（${code}）` : '发送失败'
  }
}

export class SchatClient {
  private socket: WebSocket | null = null
  private nextAck = 1
  private readonly pending = new Map<string, { resolve: (d: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private closedByUs = false
  private kicked = false
  /** 被服务端踢掉后不再自动重连（防止失效 token 降级成 guest） */
  state: 'connecting' | 'online' | 'offline' | 'kicked' = 'offline'

  constructor(private readonly options: SchatClientOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.closedByUs = false
      this.setState('connecting')
      const socket = new WebSocket(this.options.url, ['schat-ws.v1'], {
        rejectUnauthorized: false,
        handshakeTimeout: 12_000
      })
      this.socket = socket

      socket.on('upgrade', (response) => {
        const cert = (response.socket as { getPeerCertificate?: () => { fingerprint256?: string } }).getPeerCertificate?.()
        const fingerprint = normalizeFingerprint(cert?.fingerprint256)
        if (!fingerprint) return
        const expected = normalizeFingerprint(this.options.fingerprint)
        if (expected && expected !== fingerprint) {
          this.closedByUs = true
          socket.terminate()
          reject(new Error(`证书指纹对不上（收到 ${fingerprint.slice(0, 12)}…，记着的是 ${expected.slice(0, 12)}…）`))
          return
        }
        if (!expected) this.options.onFingerprint?.(fingerprint)
      })

      socket.on('open', () => {
        void this.sendHello()
          .then(() => {
            this.setState('online')
            resolve()
          })
          .catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))))
      })

      socket.on('message', (raw) => this.onFrame(raw.toString()))

      socket.on('close', () => {
        const wasKicked = this.kicked
        this.socket = null
        this.rejectAll(new Error('连接断了'))
        if (wasKicked) {
          this.setState('kicked', '这个设备在别处退出了，或凭据被撤销')
        } else {
          this.setState('offline', this.closedByUs ? undefined : '连接断了')
        }
      })

      socket.on('error', (error) => {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) reject(error)
      })
    })
  }

  private async sendHello(): Promise<void> {
    const response = await this.request('hello', {
      v: 1,
      token: this.options.token,
      deviceId: this.options.deviceId,
      devicePlatform: 'desktop',
      deviceName: this.options.deviceName,
      ...(this.options.serverPassword ? { password: this.options.serverPassword } : {})
    })
    const self = response as { id?: number; guest?: boolean } | undefined
    if (self && typeof self.id === 'number' && self.id === 999) {
      throw new Error('凭据已失效（服务端把它降级成访客了），请重新扫码登录')
    }
  }

  private onFrame(text: string): void {
    let envelope: SchatEnvelope
    try {
      envelope = JSON.parse(text) as SchatEnvelope
    } catch {
      return
    }
    const type = envelope.t ?? (envelope.a ? 'ack' : 'ev')
    if (type === 'ack' || type === 'err') {
      const ackID = envelope.a
      if (ackID) {
        const call = this.pending.get(ackID)
        if (call) {
          clearTimeout(call.timer)
          this.pending.delete(ackID)
          if (type === 'err') {
            const detail = envelope.d as { code?: string; message?: string } | undefined
            call.reject(new Error(detail?.message ?? detail?.code ?? '服务端拒绝了请求'))
          } else {
            // 业务失败也走 t:"ack"：{success:false, error:"not_friends"|"blocked"|…}
            // （见 chatserver handlers.go 陌生人窗口/拉黑分支）。不能当成功吞掉。
            const ack = envelope.d as { success?: boolean; error?: string } | undefined
            if (ack && ack.success === false) {
              call.reject(new SchatRejected(ack.error ?? '', ack))
            } else {
              call.resolve(envelope.d)
            }
          }
          return
        }
      }
    }
    // auth_expired：被踢，停掉自动重连
    if (envelope.e === 'auth_expired') {
      this.kicked = true
      const reason = (envelope.d as { reason?: string } | undefined)?.reason
      this.options.onState('kicked', reason ? `凭据已失效：${reason}` : '凭据已失效')
      this.setState('kicked', reason)
      return
    }
    this.options.onEvent(envelope)
  }

  /** 发一帧并等 ack */
  request(event: string, data: unknown): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('还没连上聊天服务器'))
    }
    const ackID = `a${this.nextAck++}-${Date.now().toString(36)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ackID)
        reject(new Error('服务端没回应（超时）'))
      }, ACK_TIMEOUT_MS)
      this.pending.set(ackID, { resolve, reject, timer })
      socket.send(JSON.stringify({ e: event, d: data, a: ackID, t: 'req' }), (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(ackID)
        reject(error)
      })
    })
  }

  /** 单向事件（不需要 ack） */
  emit(event: string, data: unknown): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ e: event, d: data, t: 'ev' }))
  }

  close(): void {
    this.closedByUs = true
    this.kicked = false
    this.socket?.close()
    this.socket = null
    this.rejectAll(new Error('已断开'))
    this.setState('offline')
  }

  private setState(state: 'connecting' | 'online' | 'offline' | 'kicked', detail?: string): void {
    this.state = state
    this.options.onState(state, detail)
  }

  private rejectAll(error: Error): void {
    for (const [ackID, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(error)
      this.pending.delete(ackID)
    }
  }
}
