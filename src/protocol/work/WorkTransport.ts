// work 机器的传输端点（REMOTE.md §2「WebRTC 工作通道」）：
// 协议进程不直接碰 WebRTC（utilityProcess 没有 RTCPeerConnection）——
// DataChannel 在渲染进程，本类把「send(text)」转成 port 消息交给渲染进程的 WorkChannel，
// 渲染进程收到的每条 JSON 也从 port 回来（handleMessage → RpcClient）。

import type { TransportLike } from '../rpc/RpcClient.js'
import type { WorkSignalEvent } from './WorkSignaling.js'

/** 协议进程 ⇆ 渲染进程的 work 消息（shared：两端都用） */
export type WorkPortMessage =
  | { type: 'work.signal'; machineID: string; signal: WorkSignalEvent }
  | { type: 'work.out'; machineID: string; text: string } // 协议 → 渲染：要发到 DataChannel 的一条 JSON
  | { type: 'work.in'; machineID: string; text: string } // 渲染 → 协议：DataChannel 收到的一条 JSON
  | { type: 'work.signalOut'; machineID: string; signalType: string; payload: string } // 渲染 → 协议：发信令
  | { type: 'work.open'; machineID: string; requestId: string } // 渲染 → 协议：DataChannel 打开了
  | { type: 'work.closed'; machineID: string; requestId: string; reason: string } // 渲染 → 协议：通道断了

export class WorkTransport implements TransportLike {
  private open_ = false
  private readonly listeners = new Set<(text: string) => void>()
  private readonly closeListeners = new Set<(reason: string) => void>()

  constructor(
    private readonly machineID: string,
    private readonly send_: (message: WorkPortMessage) => void
  ) {}

  get connected(): boolean {
    return this.open_
  }

  send(text: string): void {
    if (!this.open_) return
    this.send_({ type: 'work.out', machineID: this.machineID, text })
  }

  close(): void {
    if (!this.open_) return
    this.open_ = false
    for (const listener of this.closeListeners) listener('本地断开')
    this.closeListeners.clear()
  }

  // MARK: 协议进程侧驱动（MachineManager / host 调）

  /** 渲染进程：DataChannel 打开了（机器可以 hello 了） */
  handleOpen(): void {
    this.open_ = true
  }

  /** 渲染进程：DataChannel 收到一条完整 JSON */
  handleMessage(text: string): void {
    for (const listener of this.listeners) listener(text)
  }

  /** 渲染进程：通道断了 */
  handleClosed(reason: string): void {
    const wasOpen = this.open_
    this.open_ = false
    for (const listener of this.closeListeners) listener(reason)
    this.closeListeners.clear()
    void wasOpen
  }

  /** 交给 RpcClient 的回调 */
  onMessage(listener: (text: string) => void): void {
    this.listeners.add(listener)
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListeners.add(listener)
  }
}
