// 客户端设备：TCP 隧道的这台电脑这头（方案-客户端设备 §5.6）。
// DataChannel（friday-tcp:<id>）在渲染进程，socket 在协议进程（渲染进程开不了 TCP）：字节经数据面端口搬
//   渲染 → 协议：tunnel.data / tunnel.close / tunnel.pause / tunnel.resume
//   协议 → 渲染：tunnel.data / tunnel.closed
// 三种目标：
//   {host, port}       只放行本机、局域网（私有网段 / 链路本地）的地址——主机名先解析，解析出公网地址就拒绝；
//   {service: 'adb'}   本机的 adb server，夹一层 AdbGate 只放行授权过的那台手机；
//   {service: 'usbmux'} 本机的 usbmuxd（iOS）。

import dns from 'node:dns/promises'
import net from 'node:net'
import type { TunnelPortMessage, TunnelTarget } from '../../shared/api.js'
import { AdbGate } from './AdbGate.js'
import { ADB_PORT, usbmuxEndpoint } from './Phones.js'

/** 本机、私有网段、链路本地、CGNAT 的地址才放行（IPv4 / IPv6） */
export function isLocalAddress(address: string): boolean {
  const ip = address.startsWith('::ffff:') ? address.slice(7) : address
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')
  }
  return false
}

interface Tunnel {
  socket: net.Socket
  gate: AdbGate | null
}

export class Tunnels {
  private readonly tunnels = new Map<string, Tunnel>()

  constructor(private readonly post: (message: TunnelPortMessage) => void) {}

  /** 连上目标（失败抛错，文案给人看）；之后两个方向的字节经端口消息搬 */
  async open(id: string, target: TunnelTarget): Promise<void> {
    let options: net.NetConnectOpts
    if (target.kind === 'tcp') {
      const addresses = await dns.lookup(target.host, { all: true }).catch(() => [])
      if (addresses.length === 0) throw new Error(`解析不了 ${target.host}`)
      const bad = addresses.find((entry) => !isLocalAddress(entry.address))
      if (bad) throw new Error(`${target.host}（${bad.address}）不是本机或局域网地址：隧道只通本机和局域网`)
      options = { host: addresses[0].address, port: target.port }
    } else if (target.kind === 'adb') {
      options = { host: '127.0.0.1', port: ADB_PORT }
    } else {
      options = usbmuxEndpoint()
    }
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(options)
      const timer = setTimeout(() => {
        s.destroy()
        reject(new Error('连不上（10 秒超时）'))
      }, 10_000)
      s.once('connect', () => {
        clearTimeout(timer)
        resolve(s)
      })
      s.once('error', (error) => {
        clearTimeout(timer)
        reject(
          new Error(
            target.kind === 'adb'
              ? '连不上本机的 adb server（装了 platform-tools、跑过 adb devices 吗？）'
              : target.kind === 'usbmux'
                ? '连不上 usbmuxd（Windows 上要装 Apple 设备 / iTunes）'
                : `连不上：${error.message}`
          )
        )
      })
    })
    socket.setNoDelay(true)
    const tunnel: Tunnel = { socket, gate: target.kind === 'adb' ? new AdbGate(target.serial) : null }
    this.tunnels.set(id, tunnel)
    socket.on('data', (chunk: Buffer) => {
      const outputs = tunnel.gate ? tunnel.gate.fromServer(chunk).toClient : [chunk]
      for (const output of outputs) this.toRenderer(id, output)
    })
    socket.on('close', () => this.closed(id, '那头关了'))
    socket.on('error', (error) => this.closed(id, error.message))
  }

  /** 渲染进程（通道那头）来的消息 */
  handle(message: TunnelPortMessage): void {
    const tunnel = this.tunnels.get(message.id)
    if (!tunnel) return
    switch (message.type) {
      case 'tunnel.data': {
        const bytes = new Uint8Array(message.data)
        if (!tunnel.gate) {
          tunnel.socket.write(bytes)
          return
        }
        const output = tunnel.gate.fromClient(bytes)
        for (const reply of output.toClient) this.toRenderer(message.id, reply)
        for (const request of output.toServer) tunnel.socket.write(request)
        if (output.close) this.close(message.id, 'adb 请求被拒绝')
        return
      }
      case 'tunnel.close':
        this.close(message.id, '通道关了')
        return
      case 'tunnel.pause':
        tunnel.socket.pause()
        return
      case 'tunnel.resume':
        tunnel.socket.resume()
        return
    }
  }

  close(id: string, reason: string): void {
    const tunnel = this.tunnels.get(id)
    if (!tunnel) return
    this.tunnels.delete(id)
    tunnel.socket.destroy()
    this.post({ type: 'tunnel.closed', id, reason })
  }

  closeAll(): void {
    for (const id of [...this.tunnels.keys()]) this.close(id, '客户端界面重载了')
  }

  private closed(id: string, reason: string): void {
    if (!this.tunnels.has(id)) return
    this.tunnels.delete(id)
    this.post({ type: 'tunnel.closed', id, reason })
  }

  private toRenderer(id: string, bytes: Uint8Array): void {
    // MessagePortMain 只能转移端口，ArrayBuffer 照样拷一份过去
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    this.post({ type: 'tunnel.data', id, data })
  }
}
