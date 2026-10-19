// WebRTC 工作通道的分帧（与服务端 qt/src/core/remote/WorkFramer 同一协议，REMOTE.md §2）。
//
// DataChannel 一条消息有上限（Chromium / libdatachannel 都 ~256 KB），而 JSON-RPC 的一条
// 消息（会话快照、文件分块）可以到几 MB：≤ 200 KB 的整条发（文本帧），更大的切成
// ≤ 128 KB 的二进制片：
//   'F' 'W' '1' + 8 字节大端 sid + 4 字节大端 seq + 4 字节大端 total + 分片
// 接收端按 sid 拼回。协议违规（重复片 / total 漂移 / 超过单条上限）= 通道坏了，断开重拨。

export const WHOLE_LIMIT = 200 * 1024
export const CHUNK = 128 * 1024
export const MESSAGE_LIMIT = 64 * 1024 * 1024
const HEADER = 19
const MAGIC = 0x46_57_31 // 'F''W''1'

export interface WorkFrame {
  binary: boolean
  data: string | ArrayBuffer
}

export type FeedResult =
  | { state: 'ready'; message: string }
  | { state: 'more' }
  | { state: 'invalid' }

interface Incoming {
  total: number
  seen: Set<number>
  parts: Map<number, Uint8Array>
  received: number
  at: number
}

/** 大的拆、小的直过（文本帧必须是 string：dc.send(string) 才是文本消息，ArrayBuffer 一律是二进制） */
export function encode(message: string): WorkFrame[] {
  if (message.length <= WHOLE_LIMIT) {
    return [{ binary: false, data: message }]
  }
  const bytes = new TextEncoder().encode(message)
  const total = Math.ceil(bytes.length / CHUNK)
  const sid = nextSID++
  const frames: WorkFrame[] = []
  for (let seq = 0; seq < total; seq++) {
    const from = seq * CHUNK
    const length = Math.min(CHUNK, bytes.length - from)
    const frame = new Uint8Array(HEADER + length)
    frame[0] = 0x46
    frame[1] = 0x57
    frame[2] = 0x31
    const view = new DataView(frame.buffer)
    view.setBigUint64(3, BigInt(sid), false)
    view.setUint32(11, seq, false)
    view.setUint32(15, total, false)
    frame.set(bytes.subarray(from, from + length), HEADER)
    frames.push({ binary: true, data: frame.buffer as ArrayBuffer })
  }
  return frames
}

let nextSID = 1

/** 拼片。出 invalid 时调用方应把通道断开（协议错，不是丢包——SCTP 保证有序可靠） */
export class WorkFramer {
  private readonly incoming = new Map<bigint, Incoming>()

  feed(binary: boolean, data: ArrayBuffer): FeedResult {
    if (!binary) {
      return { state: 'ready', message: new TextDecoder().decode(data) }
    }
    const bytes = new Uint8Array(data)
    if (bytes.length < HEADER) return { state: 'invalid' }
    const view = new DataView(data)
    if (view.getUint32(0, false) >>> 8 !== MAGIC) return { state: 'invalid' }
    const sid = view.getBigUint64(3, false)
    const seq = view.getUint32(11, false)
    const total = view.getUint32(15, false)
    if (total < 2 || total * CHUNK > MESSAGE_LIMIT) return { state: 'invalid' }

    let entry = this.incoming.get(sid)
    if (!entry) {
      entry = { total, seen: new Set(), parts: new Map(), received: 0, at: Date.now() }
      this.incoming.set(sid, entry)
    } else if (entry.total !== total || entry.seen.has(seq)) {
      return { state: 'invalid' }
    }
    entry.seen.add(seq)
    entry.parts.set(seq, bytes.subarray(HEADER))
    entry.received += data.byteLength - HEADER
    if (entry.seen.size < total) {
      this.gc()
      return { state: 'more' }
    }
    this.incoming.delete(sid)
    const assembled = new Uint8Array(entry.received)
    let at = 0
    for (let index = 0; index < total; index++) {
      const part = entry.parts.get(index)
      if (!part) return { state: 'invalid' } // 不该发生（size==total 但有空洞）
      assembled.set(part, at)
      at += part.length
    }
    return { state: 'ready', message: new TextDecoder().decode(assembled) }
  }

  /** 丢弃迟迟拼不齐的（协议错外的兜底；DataChannel 断了自然会清） */
  private gc(): void {
    const now = Date.now()
    for (const [sid, entry] of this.incoming) {
      if (now - entry.at > 60_000) this.incoming.delete(sid)
    }
  }
}
