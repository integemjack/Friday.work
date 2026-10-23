// 媒体叠本地缓存（userData/MediaStack）：看图/看视频成功归档的媒体文件落一份在本机，
// 会话结束、远端文件被清理、甚至重启软件后，图片叠/视频叠仍能从本地加载。
// 文件名由渲染层按「会话:类型:媒体源」确定性哈希算出，这里只按白名单校验
// （16 位十六进制 + 图片/视频扩展名），不认任何路径——渲染进程塞不进目录穿越。
// 供文件走自定义协议 friday-media://stack/<name>（index.ts 注册 handler），支持
// Range 请求（视频拖进度），<img>/<video> 直接 src 引用，不走 IPC 传大块字节。

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, net } from 'electron'

/** 渲染层算出的缓存文件名格式：<16 位十六进制哈希>.<图片/视频扩展名> */
const NAME_RE = /^[0-9a-f]{16}\.(png|jpg|jpeg|gif|webp|bmp|svg|avif|ico|mp4|m4v|webm|mov|ogv|ogg|mkv)$/

/** 单文件上限（渲染层内嵌上限是图 24 MB / 视频 64 MB，这里兜 128 MB） */
const MAX_BYTES = 128 * 1024 * 1024

/** 下载远端 URL 的超时 */
const FETCH_TIMEOUT_MS = 90_000

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mkv: 'video/x-matroska'
}

export function mediaStackDir(): string {
  return join(app.getPath('userData'), 'MediaStack')
}

/** 是不是合法的缓存文件名（类型收窄用） */
export function isValidStackMediaName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name)
}

function stackMediaPath(name: string): string {
  return join(mediaStackDir(), name)
}

/** 列出已缓存的文件名（启动时渲染层回填注册表用） */
export async function listStackMediaFiles(): Promise<string[]> {
  try {
    return (await readdir(mediaStackDir())).filter(isValidStackMediaName)
  } catch {
    return []
  }
}

/** 落一个缓存文件：字节由渲染层传（远端 fs.read / data: URL 解出来的），或给个
 *  http(s)/data: URL 让主进程代下（渲染层有 CORS，主进程没有）。先写临时文件再
 *  改名，写一半挂了不留半截文件。成功返回文件名，失败返回 null。 */
export async function saveStackMediaFile(
  name: string,
  source: { bytes?: Uint8Array | ArrayBuffer; url?: string }
): Promise<string | null> {
  if (!isValidStackMediaName(name)) return null
  await mkdir(mediaStackDir(), { recursive: true })
  const final = stackMediaPath(name)
  const tmp = join(mediaStackDir(), `.${randomUUID()}.tmp`)
  try {
    if (source.bytes) {
      const buf = Buffer.from(source.bytes as ArrayBuffer)
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null
      await writeFile(tmp, buf)
    } else if (typeof source.url === 'string' && /^(https?|data):/i.test(source.url)) {
      const ok = await downloadTo(source.url, tmp)
      if (!ok) return null
    } else {
      return null
    }
    await rename(tmp, final)
    return name
  } catch {
    await unlink(tmp).catch(() => {})
    return null
  }
}

/** 主进程代渲染层下载一个 URL 到临时文件（限 MAX_BYTES，超了掐断不落盘） */
async function downloadTo(url: string, tmp: string): Promise<boolean> {
  let response: Response
  try {
    response = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch {
    return false
  }
  if (!response.ok || !response.body) return false
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) return false
  const reader = response.body.getReader()
  const out = createWriteStream(tmp)
  let total = 0
  // 写流出错（磁盘满/文件被删）时 'drain' 永远不来，await once(out,'drain') 会把
  // 调用方永久挂起：挂一个 error 监听记下来，等的时候跟 drain 一起竞速
  let writeError: Error | null = null
  out.once('error', (error: Error) => {
    writeError = error
  })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) {
        out.destroy()
        await unlink(tmp).catch(() => {})
        return false
      }
      if (!out.write(value)) {
        await Promise.race([once(out, 'drain'), once(out, 'error')])
        if (writeError) throw writeError
      }
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())))
    return total > 0
  } catch {
    // 掉不取消远端读取，连接挂着不放
    await reader.cancel().catch(() => {})
    out.destroy()
    await unlink(tmp).catch(() => {})
    return false
  }
}

/** 删一批缓存文件（清空一叠时渲染层把那一叠的文件名全发来）；返回删掉的个数 */
export async function deleteStackMediaFiles(names: unknown): Promise<number> {
  if (!Array.isArray(names)) return 0
  let deleted = 0
  for (const name of names) {
    if (!isValidStackMediaName(name)) continue
    try {
      await unlink(stackMediaPath(name))
      deleted += 1
    } catch {
      // 没了这个文件就算了（可能已经删过）
    }
  }
  return deleted
}

/** friday-media:// 协议的请求处理：只放行 MediaStack 目录里、名字过白名单的文件。
 *  实现 Range（视频拖进度条要 206 分段），body 用 Node 流转 web 流零拷贝喂给 <img>/<video>。 */
export async function handleMediaStackRequest(request: Request): Promise<Response> {
  let name = ''
  try {
    const url = new URL(request.url)
    if (url.host === 'stack') name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  } catch {
    // 解不出来的 URL 当 404
  }
  if (!isValidStackMediaName(name)) return new Response('not found', { status: 404 })
  const path = stackMediaPath(name)
  const info = await stat(path).catch(() => null)
  if (!info || !info.isFile()) return new Response('not found', { status: 404 })
  const type = MIME[name.split('.').pop() ?? ''] ?? 'application/octet-stream'
  const size = Number(info.size)

  const range = request.headers.get('range')
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (match) {
    // 后缀区间（bytes=-N：最后 N 字节）先换算；开区间上限按文件尾收
    let start = match[1] ? Number(match[1]) : 0
    let end = match[2] ? Number(match[2]) : size - 1
    if (!match[1] && match[2]) {
      // bytes=-N：要的是最后 N 个字节，开头和结尾都要换算（end 不是 N，是文件尾）
      start = Math.max(0, size - Number(match[2]))
      end = size - 1
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      return new Response('range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` }
      })
    }
    end = Math.min(end, size - 1)
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes'
      }
    })
  }

  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
  })
}
