// JSON-RPC 客户端：请求/回执配对、超时、事件分发（REMOTE.md §3/§4）。
// 传输层负责分帧（SSH 按行、WS 按帧），本层只处理文本消息。

import {
  RpcErrors,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RemoteEventName
} from './protocol.js'

export interface TransportLike {
  send(text: string): void
  close(): void
  /** 传输是否还连着（未必已 hello） */
  readonly connected: boolean
}

/** 请求超时（REMOTE.md §3）：hello 30 秒、file.* 3 分钟、其余 60 秒 */
export function timeoutFor(method: string): number {
  if (method === 'hello') return 30_000
  if (method.startsWith('file.')) return 180_000
  return 60_000
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

type EventHandler = (params: unknown) => void
/** 处理服务端发来的请求：返回值即 result，抛 RpcError 即 error（带 code） */
export type RequestHandler = (method: string, params: unknown, id: number | string) => Promise<unknown>

export class RpcClient implements TransportLike {
  private nextID = 1
  private readonly pending = new Map<number, Pending>()
  private readonly handlers = new Map<string, Set<EventHandler>>()
  private readonly anyHandlers = new Set<(method: string, params: unknown) => void>()
  private requestHandler: RequestHandler | null = null

  constructor(
    private readonly sendFn: (text: string) => void,
    private readonly closeFn: () => void
  ) {}

  get connected(): boolean {
    return true // 由持有者判断；本层只管消息
  }

  send(text: string): void {
    this.sendFn(text)
  }

  close(): void {
    this.closeFn()
  }

  /** 收到一条传输层消息（一行 / 一帧） */
  handleMessage(text: string): void {
    let msg: JsonRpcResponse | { jsonrpc: '2.0'; method: string; params?: unknown }
    try {
      msg = JSON.parse(text)
    } catch {
      return // 解析不了的消息丢弃（REMOTE.md §3）
    }
    if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: string }).jsonrpc !== '2.0') return

    if ('method' in msg && typeof msg.method === 'string') {
      if (!('id' in msg)) {
        // 事件
        const handlers = this.handlers.get(msg.method)
        if (handlers) for (const h of handlers) h(msg.params)
        for (const h of this.anyHandlers) h(msg.method, msg.params)
      } else {
        // 反向请求（服务端 → 客户端，方案-客户端设备 §3）：id 是服务端的，原样回
        const id = (msg as { id: unknown }).id
        if (typeof id === 'number' || typeof id === 'string') void this.answer(id, msg.method, msg.params)
      }
      return
    }

    const response = msg as JsonRpcResponse
    if (typeof response.id !== 'number') return
    const entry = this.pending.get(response.id)
    if (!entry) return
    this.pending.delete(response.id)
    clearTimeout(entry.timer)
    if (response.error) {
      entry.reject(new RpcError(response.error.code, response.error.message))
    } else {
      entry.resolve(response.result)
    }
  }

  /** 发请求；失败时 reject RpcError（带协议错误码）或超时错误 */
  request(method: string, params?: unknown, timeout?: number): Promise<unknown> {
    const id = this.nextID++
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError(-32000, `请求 ${method} 超时`))
      }, timeout ?? timeoutFor(method))
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send(JSON.stringify(request))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  on(method: RemoteEventName | string, handler: (params: unknown) => void): () => void {
    let set = this.handlers.get(method)
    if (!set) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(handler)
    return () => set!.delete(handler)
  }

  /** 服务端发来的请求交给谁处理（只有一个；没设 = 一律「不认识的方法」） */
  onRequest(handler: RequestHandler | null): void {
    this.requestHandler = handler
  }

  /** 发一条通知（没有 id，不等回执） */
  notify(method: string, params?: unknown): void {
    this.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    let reply: Record<string, unknown>
    try {
      if (!this.requestHandler) throw new RpcError(RpcErrors.MethodNotFound, `不认识的方法 ${method}`)
      const result = await this.requestHandler(method, params, id)
      reply = { jsonrpc: '2.0', id, result: result ?? {} }
    } catch (error) {
      const code = error instanceof RpcError ? error.code : RpcErrors.Internal
      reply = { jsonrpc: '2.0', id, error: { code, message: error instanceof Error ? error.message : String(error) } }
    }
    this.send(JSON.stringify(reply))
  }

  onAny(handler: (method: string, params: unknown) => void): () => void {
    this.anyHandlers.add(handler)
    return () => this.anyHandlers.delete(handler)
  }

  /** 传输断开：所有在途请求立即失败 */
  failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}
