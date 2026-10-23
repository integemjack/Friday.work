// 客户端设备：烧录用的串口读写（STK500、STM32 引导这种一问一答的协议）：后台一直读进缓冲，read(n, 超时) 取够 n 个字节。

import type { PortLike } from './serialSession.js'

type OpenOptions = Parameters<PortLike['open']>[0]

export class SerialIO {
  private buffer: number[] = []
  private wake: (() => void) | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private loop: Promise<void> = Promise.resolve()
  private failed: Error | null = null

  constructor(private readonly port: PortLike) {}

  async open(options: OpenOptions): Promise<void> {
    await this.port.open(options)
    this.writer = this.port.writable?.getWriter() ?? null
    const readable = this.port.readable
    if (!readable || !this.writer) throw new Error('串口打不开读写')
    const reader = readable.getReader()
    this.reader = reader
    this.loop = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value) for (const byte of value) this.buffer.push(byte)
          this.wake?.()
        }
      } catch (error) {
        this.failed = error instanceof Error ? error : new Error(String(error))
        this.wake?.()
      } finally {
        try {
          reader.releaseLock()
        } catch {
          /* 已经放了 */
        }
      }
    })()
  }

  async write(bytes: Uint8Array | number[]): Promise<void> {
    if (!this.writer) throw new Error('串口没打开')
    await this.writer.write(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes))
  }

  /** 读满 n 个字节；timeoutMs 内没够抛错 */
  async read(n: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs
    while (this.buffer.length < n) {
      if (this.failed) throw this.failed
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`等设备回话超时（要 ${n} 字节，收到 ${this.buffer.length}）`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wake = null
    }
    return Uint8Array.from(this.buffer.splice(0, n))
  }

  /** 丢掉已经收到的（同步前清掉开机日志、残留） */
  drain(): void {
    this.buffer = []
  }

  async setSignals(signals: Parameters<PortLike['setSignals']>[0]): Promise<void> {
    await this.port.setSignals(signals)
  }

  async close(): Promise<void> {
    try {
      await this.reader?.cancel()
    } catch {
      /* 已经断了 */
    }
    await this.loop
    try {
      this.writer?.releaseLock()
    } catch {
      /* 写到一半 */
    }
    this.writer = null
    this.reader = null
    try {
      await this.port.close()
    } catch {
      /* 已经关了 */
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
