// 渲染进程 ⇆ 协议进程的 API 消息等共有类型。
import type { HostEvent, HostRequest, HostResponse, PickedFile } from '../../../shared/api.js'

export type { PickedFile, HostEvent, HostRequest, HostResponse }

type MachineListener = (info: { machines: import('../../../shared/api.js').MachineStateInfo[]; current: string }) => void
type EventListener = (event: HostEvent) => void

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** 与协议进程的数据面连接（MessagePort） */
class HostLink {
  private port: MessagePort | null = null
  private nextReqID = 1
  private readonly pending = new Map<number, PendingCall>()
  private readonly machineListeners = new Set<MachineListener>()
  private readonly eventListeners = new Set<EventListener>()
  private readonly schatListeners = new Set<(state: unknown) => void>()
  private readonly callSignalListeners = new Set<(signal: unknown) => void>()
  private readonly workListeners = new Set<(message: { type: string; machineID: string } & Record<string, unknown>) => void>()
  /** port 还没到时排队等它的请求（渲染层挂载比 preload 建 port 早，登录页的自动登录首拍就会撞上） */
  private portWaiters: Array<() => void> = []

  constructor() {
    window.addEventListener('message', (event) => {
      if (event.data !== 'friday-port' || !Array.isArray(event.ports) || event.ports.length === 0) return
      this.attach(event.ports[0])
    })
    window.fridayRequestPort()
  }

  private attach(port: MessagePort): void {
    this.port = port
    // port 到了：唤醒在排队的请求
    for (const wake of this.portWaiters.splice(0)) wake()
    port.onmessage = (event) => {
      const data = event.data as HostResponse | HostEvent
      if (!data || typeof data !== 'object') return
      if ('reqID' in data && 'ok' in data) {
        const response = data as HostResponse
        const call = this.pending.get(response.reqID)
        if (!call) return
        this.pending.delete(response.reqID)
        if (response.ok) call.resolve(response.result)
        else {
          const error = new Error(response.error ?? '请求失败') as Error & { code?: number }
          error.code = response.code
          call.reject(error)
        }
        return
      }
      const incoming = data as unknown as { type?: string; machineID?: string; text?: string }
      if (incoming.type) {
        if (incoming.type === 'machines') {
          for (const listener of this.machineListeners) {
            listener(data as unknown as { machines: import('../../../shared/api.js').MachineStateInfo[]; current: string })
          }
        } else if (incoming.type === 'event') {
          for (const listener of this.eventListeners) listener(data as unknown as HostEvent)
        } else if (incoming.type === 'schat') {
          for (const listener of this.schatListeners) listener((incoming as { state: unknown }).state)
        } else if (incoming.type === 'schatCall') {
          for (const listener of this.callSignalListeners) listener((incoming as { signal: unknown }).signal)
        } else if (
          incoming.type === 'work.signal' ||
          incoming.type === 'work.out' ||
          incoming.type === 'work.open' ||
          incoming.type === 'work.closed'
        ) {
          // work 通道（0.3）：协议进程来的信令 / 待发数据（WorkChannelHub 接）
          for (const listener of this.workListeners) {
            listener(incoming as { type: string; machineID: string } & Record<string, unknown>)
          }
        }
      }
    }
    port.start()
  }

  /** 等 port 就绪（最多 timeoutMs，超时拒绝） */
  private waitForPort(timeoutMs: number): Promise<void> {
    if (this.port) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const wake = (): void => {
        window.clearTimeout(timer)
        resolve()
      }
      const timer = window.setTimeout(() => {
        const index = this.portWaiters.indexOf(wake)
        if (index >= 0) this.portWaiters.splice(index, 1)
        reject(new Error('还没连上协议进程'))
      }, timeoutMs)
      this.portWaiters.push(wake)
    })
  }

  request(request: HostRequest): Promise<unknown> {
    if (!this.port) {
      // 渲染层可能比协议进程的 port 早准备好：等一等再发，别第一拍就报「还没连上」
      return this.waitForPort(10_000).then(() => this.request(request))
    }
    const reqID = this.nextReqID++
    return new Promise((resolve, reject) => {
      this.pending.set(reqID, { resolve, reject })
      this.port!.postMessage({ reqID, request })
      setTimeout(() => {
        if (this.pending.has(reqID)) {
          this.pending.delete(reqID)
          reject(new Error('请求超时'))
        }
      }, 190_000)
    })
  }

  onMachines(listener: MachineListener): () => void {
    this.machineListeners.add(listener)
    return () => this.machineListeners.delete(listener)
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** SChat 通道状态（扫码登录 / 机器人对话） */
  onSchat(listener: (state: unknown) => void): () => void {
    this.schatListeners.add(listener)
    return () => this.schatListeners.delete(listener)
  }

  /** 通话信令（渲染进程喂 RTCPeerConnection） */
  onCallSignal(listener: (signal: unknown) => void): () => void {
    this.callSignalListeners.add(listener)
    return () => this.callSignalListeners.delete(listener)
  }

  /** work 通道（0.3）：协议进程来的消息（信令 / 待发数据） */
  onWork(listener: (message: { type: string; machineID: string } & Record<string, unknown>) => void): () => void {
    this.workListeners.add(listener)
    return () => this.workListeners.delete(listener)
  }

  /** work 通道（0.3）：往协议进程发（不带 reqID，不是请求） */
  postWork(message: Record<string, unknown>): void {
    this.port?.postMessage(message)
  }
}

export const host = new HostLink()

/** 类型化的一层：调用协议进程的 JSON-RPC 方法 */
export async function rpc(machineID: string, method: string, params?: unknown): Promise<unknown> {
  return host.request({ type: 'rpc', machineID, method, params })
}
