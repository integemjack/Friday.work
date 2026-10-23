// 客户端设备：一条 TCP 隧道 = 一条专用 DataChannel（friday-tcp:<id>）⇆ 协议进程里的一个 socket（方案-客户端设备 §5.6）。
// 渲染进程开不了 TCP：socket 在协议进程（protocol/device/Tunnels），字节经数据面端口搬（tunnel.* 消息）。
// 通道积压（bufferedAmount 超过 1 MB）时叫协议进程先别读 socket，发完再接着。

import type { TunnelPortMessage } from '../../../../shared/api.js'
import type { ChannelLike } from './serialSession.js'

const HIGH_WATER = 1024 * 1024
const LOW_WATER = 256 * 1024

export interface TcpSessionEvents {
  /** 隧道结束（byPeer：服务端关的通道，不用再发 device.tcp.closed） */
  onClosed(reason: string, byPeer: boolean): void
}

export class TcpSession {
  bytesIn = 0
  bytesOut = 0
  closed = false
  private paused = false

  constructor(
    readonly id: string,
    private readonly channel: ChannelLike,
    private readonly post: (message: TunnelPortMessage) => void,
    private readonly events: TcpSessionEvents
  ) {}

  /** socket 已经连上：开始双向搬 */
  start(): void {
    this.channel.bufferedAmountLowThreshold = LOW_WATER
    this.channel.onbufferedamountlow = () => {
      if (!this.paused) return
      this.paused = false
      this.post({ type: 'tunnel.resume', id: this.id })
    }
    this.channel.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return
      this.bytesOut += event.data.byteLength
      this.post({ type: 'tunnel.data', id: this.id, data: event.data })
    }
    this.channel.onclose = () => this.finish('服务端关了通道', true)
  }

  /** 协议进程来的：socket 读到的字节 / socket 关了 */
  fromSocket(message: TunnelPortMessage): void {
    if (this.closed) return
    if (message.type === 'tunnel.data') {
      if (this.channel.readyState !== 'open') return
      this.bytesIn += message.data.byteLength
      this.channel.send(message.data)
      if (!this.paused && this.channel.bufferedAmount > HIGH_WATER) {
        this.paused = true
        this.post({ type: 'tunnel.pause', id: this.id })
      }
    } else if (message.type === 'tunnel.closed') {
      this.finish(message.reason || '那头关了', false, false)
    }
  }

  /** 这头要关（用户点断开、服务端 device.tcp.close） */
  close(reason: string, byPeer = false): void {
    this.finish(reason, byPeer)
  }

  private finish(reason: string, byPeer: boolean, closeSocket = true): void {
    if (this.closed) return
    this.closed = true
    this.channel.onmessage = null
    this.channel.onclose = null
    this.channel.onbufferedamountlow = null
    try {
      this.channel.close()
    } catch {
      /* 已经关了 */
    }
    if (closeSocket) this.post({ type: 'tunnel.close', id: this.id })
    this.events.onClosed(reason, byPeer)
  }
}
