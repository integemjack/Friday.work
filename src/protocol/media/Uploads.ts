// 附件上传（REMOTE.md §6 file.upload）：读主进程背书的文件句柄，分块传（0.3：块 128 KB，适配 WebRTC DataChannel）。

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { open, stat } from 'node:fs/promises'

const CHUNK = 128 * 1024 // 每块不超过 128 KB（0.3：走 WebRTC DataChannel，超过 ~256 KB 会被切；分片本身在这里变小）

export interface HandleBackend {
  resolveHandle(handle: string): Promise<string | null>
}

type Rpc = (method: string, params: unknown) => Promise<unknown>

export class Uploads {
  constructor(private readonly backend: HandleBackend) {}

  /** 传完返回 {path}：服务端上的路径，用在 runner.submit 的 attachments 里 */
  async sendFile(rpc: Rpc, handle: string): Promise<{ path: string }> {
    const filePath = await this.backend.resolveHandle(handle)
    if (!filePath) throw new Error('找不到这个文件（句柄无效或已过期）')
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('这不是一个普通文件')
    const name = basename(filePath)
    const uploadID = randomUUID()
    const size = info.size

    const fh = await open(filePath, 'r')
    try {
      if (size === 0) {
        const result = (await rpc('file.upload', { uploadID, name, offset: 0, data: '', last: true })) as { path: string }
        return result
      }
      let offset = 0
      let result: { path: string } | undefined
      let lastSent = false
      const buffer = Buffer.alloc(CHUNK)
      while (offset < size) {
        const { bytesRead } = await fh.read(buffer, 0, CHUNK, offset)
        if (bytesRead <= 0) break
        const last = offset + bytesRead >= size
        result = (await rpc('file.upload', {
          uploadID,
          name,
          offset,
          data: buffer.subarray(0, bytesRead).toString('base64'),
          last
        })) as { path: string }
        lastSent = last
        offset += bytesRead
      }
      // 读到的比 stat 时短（读的途中文件被截短）：最后一块没带 last=true，
      // 服务端这份上传收不了尾——不能把中途回执当成功返回
      if (!lastSent) throw new Error('文件在读取途中变短了，上传没有传完整，请重试')
      if (!result) throw new Error('文件是空的')
      return result
    } finally {
      await fh.close()
    }
  }
}
