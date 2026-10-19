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
  private readonly deployListeners = new Set<(info: { machineID: string; text: string }) => void>()
  private readonly schatListeners = new Set<(state: unknown) => void>()
  private readonly callSignalListeners = new Set<(signal: unknown) => void>()

  constructor() {
    window.addEventListener('message', (event) => {
      if (event.data !== 'friday-port' || !Array.isArray(event.ports) || event.ports.length === 0) return
      this.attach(event.ports[0])
    })
    window.fridayRequestPort()
  }

  private attach(port: MessagePort): void {
    this.port = port
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
        } else if (incoming.type === 'deployStatus') {
          for (const listener of this.deployListeners) {
            listener(incoming as { machineID: string; text: string })
          }
        } else if (incoming.type === 'schat') {
          for (const listener of this.schatListeners) listener((incoming as { state: unknown }).state)
        } else if (incoming.type === 'schatCall') {
          for (const listener of this.callSignalListeners) listener((incoming as { signal: unknown }).signal)
        }
      }
    }
    port.start()
  }

  request(request: HostRequest): Promise<unknown> {
    if (!this.port) return Promise.reject(new Error('还没连上协议进程'))
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

  /** 安装/升级服务端的进度 */
  onDeployStatus(listener: (info: { machineID: string; text: string }) => void): () => void {
    this.deployListeners.add(listener)
    return () => this.deployListeners.delete(listener)
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
}

export const host = new HostLink()

/** 类型化的一层：调用协议进程的 JSON-RPC 方法 */
export async function rpc(machineID: string, method: string, params?: unknown): Promise<unknown> {
  return host.request({ type: 'rpc', machineID, method, params })
}
