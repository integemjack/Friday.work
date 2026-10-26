// 工具卡片的媒体内嵌（看图 / 看视频 / 听录音）：从 analyze_image / analyze_video / transcribe_audio
// 的参数里取出媒体，http(s)/data URL 直接当 src；本地文件走 fs.read 分块拉回来拼 Blob。
// 看过的媒体归档进桌面媒体叠时会下载一份到本机（stackMediaCache）：只要本地缓存在，
// 这里优先用 friday-media:// 本地地址——会话结束、远端文件被清理、重启软件后照样能看，
// 也不再走 fs.read 挤 WebRTC 通道。
// 本地文件只在卡片滚进视口时才拉（一条长消息里几十张看图卡片不能同时全量拉，会压垮 WebRTC 通道），
// 失败自动重试一次（通道偶发抖动）。图片直接显示，视频自动播放（静音循环 + 控件，可点开声音），
// 音频给原生 <audio> 控件。
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { FsReadResult, ToolEvent } from '../../../protocol/rpc/protocol.js'
import { rpc } from './host.js'
import { useAppStore } from '../stores/app.js'
import { mediaArgSource } from './mediaTools.js'
import {
  b64ToBytes,
  cacheVersion,
  CAP_BYTES,
  extOf,
  hasStackCache,
  joinUnder,
  stackCacheName,
  stackCacheUrl,
  type MediaKind
} from './stackMediaCache.js'

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon'
}
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mkv: 'video/x-matroska'
}
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma'
}

function mimeOf(kind: MediaKind, src: string): string {
  const ext = extOf(src)
  if (kind === 'image') return IMAGE_MIME[ext] ?? 'image/png'
  if (kind === 'audio') return AUDIO_MIME[ext] ?? 'audio/mpeg'
  return VIDEO_MIME[ext] ?? 'video/mp4'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 用在 ToolCard 里：返回卡片内嵌媒体需要的一切。
 * - source：{kind, src} 或 null（不是看图/看视频、参数还没流完整时）
 * - url：能直接放进 <img>/<video> 的 src（本地缓存地址 / 直连 URL / 本地文件拉完的 Blob 地址）
 * - state：idle / loading / ready / error / skipped；note：error/skipped 时给用户看的提示
 * - mediaEl：绑到媒体容器上，滚进视口才开始拉本地文件（:ref="setMediaEl"）
 */
export function useToolMedia(
  tool: Ref<ToolEvent> | (() => ToolEvent),
  /** conversationID：相对路径按哪段会话的工作目录解析。桌面操作卡可能不属于活动会话，
   *  不给（空）就退回活动会话——聊天面板里两段是同一段 */
  options?: { conversationID?: () => string }
) {
  const store = useAppStore()

  /** 相对路径 → 会话工作目录下的绝对路径（工具参数里的按对话工作目录解析；服务端 fs.read 不认相对路径） */
  function resolvePath(path: string): string {
    const id = options?.conversationID?.() || store.activeConversationID
    const base = store.summaries.find((s) => s.id === id)?.workingDirectory
    return joinUnder(path, base)
  }

  const source = computed<{ kind: MediaKind; src: string } | null>(() => {
    const event = typeof tool === 'function' ? tool() : tool.value
    return mediaArgSource(event.name ?? '', event.arguments)
  })

  const url = ref('')
  const state = ref<'idle' | 'loading' | 'ready' | 'error' | 'skipped'>('idle')
  const note = ref('')
  /** 媒体容器元素（ToolCard 模板里 ref="mediaEl"） */
  const mediaEl = ref<HTMLElement | null>(null)

  let objectURL = ''
  /** 当前 url 对应的加载键（源键 / 缓存键）——重跑 attempt 时判断要不要动现状，
   *  缓存版本号跳动不至于把在播的视频重置 */
  let readyKey = ''
  /** 一次加载的令牌：加载中途换了目标/卸载，旧结果不认（防止旧 Blob 地址写回新卡片） */
  let loadToken = 0
  let retriesLeft = 0
  let observer: IntersectionObserver | null = null
  const visible = ref(false)

  function revoke(): void {
    if (objectURL) {
      URL.revokeObjectURL(objectURL)
      objectURL = ''
    }
  }

  async function loadLocal(kind: MediaKind, path: string, token: number): Promise<void> {
    const machine = store.currentMachine
    if (!machine) throw new Error('没连上机器，读不了这个文件')
    const chunk = 1024 * 1024
    const cap = CAP_BYTES[kind]!
    const parts: Uint8Array[] = []
    let offset = 0
    let total = 0
    while (true) {
      const result = (await rpc(machine, 'fs.read', { path, offset, length: chunk })) as FsReadResult
      if (token !== loadToken) return
      if (!result || typeof result.data !== 'string') throw new Error('fs.read 回执不对')
      const bytes = b64ToBytes(result.data)
      parts.push(bytes)
      total += bytes.length
      // size 缺失/失真（正在写入的文件等）时靠累计字节数兜底：退出的路只剩 eof，
      // 不然几 GB 会整个攒进 parts[] 撑爆渲染进程
      if (result.size > cap || total > cap) {
        state.value = 'skipped'
        note.value = `文件太大（${(Math.max(result.size, total) / 1024 / 1024).toFixed(0)} MB），不在卡片里内嵌`
        return
      }
      offset += bytes.length
      if (result.eof || bytes.length === 0) break
    }
    const merged = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
      merged.set(part, at)
      at += part.length
    }
    objectURL = URL.createObjectURL(new Blob([merged], { type: mimeOf(kind, path) }))
    url.value = objectURL
    state.value = 'ready'
  }

  async function run(kind: MediaKind, path: string, token: number): Promise<void> {
    try {
      await loadLocal(kind, path, token)
    } catch (e) {
      if (token !== loadToken) return
      if (retriesLeft > 0) {
        retriesLeft -= 1
        await sleep(1500)
        if (token !== loadToken) return
        state.value = 'loading'
        note.value = ''
        return run(kind, path, token)
      }
      state.value = 'error'
      note.value = `媒体加载失败：${e instanceof Error ? e.message : String(e)}`
    }
  }

  /** 当前媒体源对应的缓存文件名（会话:类型:源 确定性算出——和归档下载用的同一个） */
  function cacheNameOf(current: { kind: MediaKind; src: string }): string {
    const id = options?.conversationID?.() || store.activeConversationID
    return stackCacheName(id, current.kind, current.src)
  }

  function attempt(): void {
    // 换目标了：旧一载的结果全部作废（loadLocal 里比对 token 丢弃旧 Blob）
    loadToken += 1
    const token = loadToken
    const current = source.value
    if (!current) {
      revoke()
      url.value = ''
      readyKey = ''
      state.value = 'idle'
      note.value = ''
      return
    }
    const sourceKey = `${current.kind}:${current.src}`
    // 已经是本地缓存地址（重启恢复的 data: 源条目）：直接用——再按它重算哈希会对不上
    if (/^friday-media:/i.test(current.src)) {
      if (readyKey !== sourceKey) {
        revoke()
        url.value = current.src
        readyKey = sourceKey
      }
      note.value = ''
      state.value = 'ready'
      return
    }
    // 本地缓存（归档时下载的那份）优先：会话结束、远端文件被清理、重启软件后仍可加载
    const cacheName = cacheNameOf(current)
    if (hasStackCache(cacheName)) {
      const cacheKey = `cache:${cacheName}`
      if (readyKey !== cacheKey) {
        revoke()
        url.value = stackCacheUrl(cacheName)
        readyKey = cacheKey
      }
      note.value = ''
      state.value = 'ready'
      return
    }
    // http(s)/data URL：直连
    if (/^(https?|data):/i.test(current.src)) {
      if (readyKey !== sourceKey) {
        revoke()
        url.value = current.src
        readyKey = sourceKey
      }
      note.value = ''
      state.value = 'ready'
      return
    }
    // 本地文件：同一个源已就绪/在拉就保持现状（缓存版本号跳动重跑时不能重置在播的媒体；
    // 等归档下载完成、缓存可用，会走上面的分支切到本地地址）
    if (readyKey === sourceKey && (state.value === 'ready' || state.value === 'loading')) return
    // 本地文件等滚进视口再拉；拉不到机器/超大也在这里变成提示
    if (!visible.value) {
      revoke()
      url.value = ''
      readyKey = ''
      state.value = 'idle'
      return
    }
    revoke()
    url.value = ''
    readyKey = sourceKey
    note.value = ''
    state.value = 'loading'
    void run(current.kind, resolvePath(current.src), token)
  }

  // 用稳定 key（kind:src + 缓存版本）触发：消息补丁每次都换工具对象，但参数没变就不重拉、
  // 视频不重头播；缓存注册表变化（回填/新下载/清空删文件）时重新解析一次
  watch(
    () => [source.value ? `${source.value.kind}:${source.value.src}` : '', visible.value, cacheVersion.value] as const,
    () => {
      retriesLeft = 1
      attempt()
    },
    { immediate: true }
  )

  watch(
    mediaEl,
    (el) => {
      observer?.disconnect()
      observer = null
      if (!el) return
      if (typeof IntersectionObserver === 'undefined') {
        visible.value = true
        return
      }
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) if (entry.isIntersecting) visible.value = true
        },
        { rootMargin: '300px' }
      )
      observer.observe(el)
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
    revoke()
  })

  /** 模板里 :ref="setMediaEl" 绑到媒体容器上 */
  function setMediaEl(el: unknown): void {
    mediaEl.value = el instanceof HTMLElement ? el : null
  }

  return { source, url, state, note, visible, setMediaEl }
}
