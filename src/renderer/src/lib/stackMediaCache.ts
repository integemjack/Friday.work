// 媒体叠本地缓存（渲染层一头）：看图/看视频成功归档时把媒体文件下载一份到本机
// （userData/MediaStack，主进程管），会话结束、远端文件被清理、重启软件后，
// 图片叠/视频叠和消息里的内嵌媒体都改从 friday-media:// 本地协议加载。
// 文件名按「会话:类型:媒体源」确定性哈希——同一个媒体不管从哪个组件看（消息内嵌
// ToolCard / 叠缩略图 StackThumb / 灯箱 MediaLightbox）算出的名字都一样，存过就直接
// 走本地，不再 fs.read 拉远端。点「清空」时主进程把这些文件一起删掉。
// toolMedia.ts 从这里取共享的小工具（扩展名/上限/base64），方向单向避免循环依赖。

import { ref } from 'vue'
import type { FsReadResult } from '../../../protocol/rpc/protocol.js'
import { rpc } from './host.js'

export type MediaKind = 'image' | 'video'

export const MEDIA_EXT: Record<MediaKind, ReadonlySet<string>> = {
  image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']),
  video: new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv', 'ogg', 'mkv'])
}

/** 内嵌与缓存共用的拉取上限：图片 24 MB、视频 64 MB（超过的不内嵌也不缓存） */
export const CAP_BYTES: Record<MediaKind, number> = { image: 24 * 1024 * 1024, video: 64 * 1024 * 1024 }

export function extOf(path: string): string {
  const clean = (path.split(/[?#]/, 1)[0] ?? '').split(/[\\/]/).pop() ?? ''
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : ''
}

export function b64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 绝对路径（盘符 / UNC / POSIX 绝对 / ~）— 相对的要拼上会话工作目录才能在服务端读到 */
export function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path) || path.startsWith('/') || path.startsWith('~')
}

/** 相对路径 → 会话工作目录下的绝对路径（toolMedia 与归档下载共用同一套拼法） */
export function joinUnder(path: string, base: string | undefined): string {
  if (isAbsolute(path)) return path
  if (!base) return path
  return `${base.replace(/[\\/]+$/, '')}/${path.replace(/^[\\/]+/, '')}`
}

/** 缓存文件名：<两轮 FNV-1a 哈希共 16 位十六进制>.<扩展名>。
 *  同一「会话:类型:媒体源」永远算出同一个名字——主进程按白名单校验（不含路径分隔符） */
export function stackCacheName(conversationID: string, kind: MediaKind, src: string): string {
  const key = `${conversationID}:${kind}:${src}`
  const hash = (seed: number): string => {
    let x = seed
    for (let i = 0; i < key.length; i += 1) {
      x ^= key.charCodeAt(i)
      x = Math.imul(x, 16777619) >>> 0
    }
    return x.toString(16).padStart(8, '0')
  }
  const ext = extOf(src) || (kind === 'image' ? 'png' : 'mp4')
  return `${hash(0x811c9dc5)}${hash(0x01000193)}.${ext}`
}

/** 本地缓存文件的加载地址（friday-media:// 协议由主进程供文件，支持 Range） */
export function stackCacheUrl(name: string): string {
  return `friday-media://stack/${name}`
}

// ---- 已缓存文件名注册表：启动时列目录回填（initStackCache），保存/删除时更新；
//      版本号是响应式的，useToolMedia 感知到变化会重新解析（在线加载 → 切到本地缓存）。
//      放模块级（不放 Pinia state）：Set 进 state 会被 Pinia 代理，方法全丢。----
const cacheFiles = new Set<string>()
export const cacheVersion = ref(0)

function bumpVersion(): void {
  cacheVersion.value += 1
}

export function hasStackCache(name: string): boolean {
  return cacheFiles.has(name)
}

/** 启动时回填注册表（App 挂载后调；拿到列表前 useToolMedia 先按在线路径走，回填后自动切） */
export async function initStackCache(): Promise<void> {
  const bridge = window.fridayBridge
  if (!bridge) return
  try {
    const names = await bridge.listStackMedia()
    if (!Array.isArray(names)) return
    let changed = false
    for (const name of names) {
      if (typeof name === 'string' && !cacheFiles.has(name)) {
        cacheFiles.add(name)
        changed = true
      }
    }
    if (changed) bumpVersion()
  } catch {
    // 列不到就算了（主进程还没就绪）：按在线路径加载，下次启动再回填
  }
}

async function saveToCache(payload: { name: string; bytes?: ArrayBuffer; url?: string }): Promise<string | null> {
  const bridge = window.fridayBridge
  if (!bridge) return null
  try {
    const saved = await bridge.saveStackMedia(payload)
    if (saved?.name && !cacheFiles.has(saved.name)) {
      cacheFiles.add(saved.name)
      bumpVersion()
    }
    return saved?.name ?? null
  } catch {
    return null
  }
}

/** data: URL 在渲染层解开成字节（把整条 base64 字符串发过 IPC 太浪费） */
function dataUrlBytes(url: string): Uint8Array | null {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(url)
  if (!match) return null
  try {
    return b64ToBytes(match[1]!)
  } catch {
    return null
  }
}

/** 从远端机器分块拉一个媒体文件（归档时下载到本地用；超上限/拉不动返回 null） */
async function readRemoteFile(machineID: string, path: string, kind: MediaKind): Promise<Uint8Array | null> {
  const chunk = 1024 * 1024
  const cap = CAP_BYTES[kind]!
  const parts: Uint8Array[] = []
  let offset = 0
  let total = 0
  while (true) {
    const result = (await rpc(machineID, 'fs.read', { path, offset, length: chunk })) as FsReadResult
    if (!result || typeof result.data !== 'string') return null
    const bytes = b64ToBytes(result.data)
    parts.push(bytes)
    total += bytes.length
    // size 缺失/失真时靠累计字节数兜底（同 toolMedia.loadLocal）
    if (result.size > cap || total > cap) return null
    offset += bytes.length
    if (result.eof || bytes.length === 0) break
  }
  const merged = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    merged.set(part, at)
    at += part.length
  }
  return merged
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** 把叠里的一条媒体落到本地缓存（已缓存就跳过，幂等）。成功返回文件名。
 *  - http(s) URL：交给主进程代下（渲染层有 CORS，主进程没有）
 *  - data: URL：渲染层解开成字节传过去
 *  - 本地路径：按会话工作目录解析后 fs.read 分块拉回来
 *  失败返回 null——不影响在线查看（会话还在时照旧走在线路径）。 */
export async function ensureStackMediaCached(
  item: { conversationID: string; kind: MediaKind; src: string },
  ctx: { machineID: string; workingDirectory?: string }
): Promise<string | null> {
  const name = stackCacheName(item.conversationID, item.kind, item.src)
  if (hasStackCache(name)) return name
  // 已经是本地缓存地址（重启恢复的 data: 源条目）：它本身就在本机，没什么可下
  if (/^friday-media:/i.test(item.src)) return null
  if (/^data:/i.test(item.src)) {
    const bytes = dataUrlBytes(item.src)
    if (!bytes) return null
    return saveToCache({ name, bytes: bytesBuffer(bytes) })
  }
  if (/^https?:/i.test(item.src)) {
    return saveToCache({ name, url: item.src })
  }
  if (!ctx.machineID) return null
  const bytes = await readRemoteFile(ctx.machineID, joinUnder(item.src, ctx.workingDirectory), item.kind)
  if (!bytes) return null
  return saveToCache({ name, bytes: bytesBuffer(bytes) })
}

/** 删掉一批缓存文件（清空一叠时用）：注册表先摘，再让主进程删盘上的文件 */
export async function deleteStackCaches(names: string[]): Promise<void> {
  let changed = false
  for (const name of names) {
    if (cacheFiles.delete(name)) changed = true
  }
  if (changed) bumpVersion()
  try {
    await window.fridayBridge?.deleteStackMedia(names)
  } catch {
    // 删不掉（主进程没就绪）就先只摘注册表；盘上的文件下次清空/重装时再清
  }
}
