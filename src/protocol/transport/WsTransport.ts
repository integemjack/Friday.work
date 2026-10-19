// WebSocket 传输（REMOTE.md §8 / 方案 §4.3）：
// - wss 用自签证书：关掉链校验（rejectUnauthorized:false），TLS 握手完成后比对证书指纹（SHA-256），
//   比对通过之前不发 hello（令牌）。
// - 一条消息一帧，不加换行。
// - 两边都发 ping：客户端每 15 秒一帧，45 秒没有任何回音（消息/pong）就断开重连。

import { TLSSocket } from 'node:tls'
import WebSocket from 'ws'

export const PING_INTERVAL = 15_000
export const PING_TIMEOUT = 45_000

/** 指纹归一化：去冒号、转小写；合法的是 64 位十六进制 */
export function normalizeFingerprint(fingerprint: string | undefined): string | null {
  if (!fingerprint) return null
  const hex = fingerprint.replace(/:/g, '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null
}

export type WsCallbacks = {
  onMessage: (text: string) => void
  onOpen: () => void
  onClose: () => void
  onError: (error: Error) => void
}

export class WsTransport {
  private ws: WebSocket | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private deadTimer: NodeJS.Timeout | null = null
  private verified = false
  private closed = false

  constructor(private readonly callbacks: WsCallbacks) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /** 连 wss/ws；expectFingerprint 是配对时拿到的指纹（wss 必须有） */
  start(url: string, expectFingerprint?: string): void {
    if (this.ws) throw new Error('传输已在运行')
    this.verified = false
    this.closed = false
    const secure = url.startsWith('wss://')
    const ws = new WebSocket(url, {
      rejectUnauthorized: false, // Node 只在链校验通过后才调 checkServerIdentity；自签证书必须关掉，改为在握手后比对指纹
      handshakeTimeout: 15_000
    })
    this.ws = ws

    if (secure) {
      // 指纹校验：upgrade 完成时 TLS 已经握手，此时取对端证书比对
      ws.on('upgrade', (response) => {
        const tls = response.socket as TLSSocket
        const cert = tls.getPeerCertificate()
        const actual = normalizeFingerprint(cert?.fingerprint256)
        if (!this.closed && expectFingerprint) {
          const expected = normalizeFingerprint(expectFingerprint)
          if (!actual || !expected || actual !== expected) {
            // 证书变了 / 不是配对的那台：不发 hello，直接断
            this.verified = false
            this.cleanup()
            this.callbacks.onError(new Error('服务器证书和配对时不一致：为了安全拒绝连接。如果那台机器重装过服务，删除这台机器重新配对'))
            return
          }
        }
        this.verified = true
      })
    } else {
      // ws:// 明文：令牌照样要（REMOTE.md §8），只在可信网络用
      this.verified = true
    }

    ws.on('message', (data) => {
      this.touch()
      this.callbacks.onMessage(data.toString('utf8'))
    })
    ws.on('pong', () => this.touch())
    ws.on('open', () => {
      if (!this.verified) return // 指纹校验没过，upgrade 回调里已经断了
      this.callbacks.onOpen()
      this.startPinging()
    })
    ws.on('error', (error) => {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)))
    })
    ws.on('close', () => {
      this.stopPinging()
      if (!this.closed) this.callbacks.onClose()
    })
  }

  send(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text)
  }

  close(): void {
    this.closed = true
    this.cleanup()
  }

  private startPinging(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping()
    }, PING_INTERVAL)
    this.touch()
  }

  /** 45 秒没有任何消息 / pong：主动断开（REMOTE.md §3） */
  private touch(): void {
    if (this.deadTimer) clearTimeout(this.deadTimer)
    this.deadTimer = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.terminate()
    }, PING_TIMEOUT)
  }

  private stopPinging(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.deadTimer) { clearTimeout(this.deadTimer); this.deadTimer = null }
  }

  private cleanup(): void {
    this.stopPinging()
    const ws = this.ws
    this.ws = null
    if (!ws) return
    try { ws.terminate() } catch { /* 忽略 */ }
  }
}
