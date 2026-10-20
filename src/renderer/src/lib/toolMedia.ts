// 工具卡片的媒体内嵌（看图 / 看视频）：从 analyze_image / analyze_video 的参数里取出媒体，
// http(s)/data URL 直接当 src；本地文件走 fs.read 分块拉回来拼 Blob。
// 图片直接显示，视频自动播放（静音循环 + 控件，可点开声音）。
// 本地文件只在卡片滚进视口时才拉（一条长消息里几十张看图卡片不能同时全量拉，会压垮 WebRTC 通道），
// 失败自动重试一次（通道偶发抖动）。
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { FsReadResult, ToolEvent } from '../../../protocol/rpc/protocol.js'
import { rpc } from './host.js'
import { useAppStore } from '../stores/app.js'
import { TOOL_MEDIA_ARG } from './mediaTools.js'

type MediaKind = 'image' | 'video'

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

/** 内嵌上限：图片 24 MB、视频 64 MB；超过只在卡片里提示（WebRTC 通道拉太大太慢） */
const CAP_BYTES: Record<MediaKind, number> = { image: 24 * 1024 * 1024, video: 64 * 1024 * 1024 }

function extOf(path: string): string {
  const clean = (path.split(/[?#]/, 1)[0] ?? '').split(/[\\/]/).pop() ?? ''
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : ''
}

function mimeOf(kind: MediaKind, src: string): string {
  const ext = extOf(src)
  if (kind === 'image') return IMAGE_MIME[ext] ?? 'image/png'
  return VIDEO_MIME[ext] ?? 'video/mp4'
}

function b64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 绝对路径（盘符 / UNC / POSIX 绝对 / ~）— 相对的要拼上会话工作目录才能在服务端读到 */
function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path) || path.startsWith('/') || path.startsWith('~')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 用在 ToolCard 里：返回卡片内嵌媒体需要的一切。
 * - source：{kind, src} 或 null（不是看图/看视频、参数还没流完整时）
 * - url：能直接放进 <img>/<video> 的 src（本地文件拉完换成 Blob 地址）
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
    if (isAbsolute(path)) return path
    const id = options?.conversationID?.() || store.activeConversationID
    const base = store.summaries.find((s) => s.id === id)?.workingDirectory
    if (!base) return path
    return `${base.replace(/[\\/]+$/, '')}/${path.replace(/^[\\/]+/, '')}`
  }

  const source = computed<{ kind: MediaKind; src: string } | null>(() => {
    const event = typeof tool === 'function' ? tool() : tool.value
    const rule = TOOL_MEDIA_ARG[(event.name ?? '').toLowerCase()]
    if (!rule) return null
    const raw = event.arguments?.trim()
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const src = typeof parsed[rule.field] === 'string' ? (parsed[rule.field] as string).trim() : ''
      if (!src) return null
      return { kind: rule.kind, src }
    } catch {
      return null // 参数 JSON 还没流完整，等下一块补丁
    }
  })

  const url = ref('')
  const state = ref<'idle' | 'loading' | 'ready' | 'error' | 'skipped'>('idle')
  const note = ref('')
  /** 媒体容器元素（ToolCard 模板里 ref="mediaEl"） */
  const mediaEl = ref<HTMLElement | null>(null)

  let objectURL = ''
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
    while (true) {
      const result = (await rpc(machine, 'fs.read', { path, offset, length: chunk })) as FsReadResult
      if (token !== loadToken) return
      if (!result || typeof result.data !== 'string') throw new Error('fs.read 回执不对')
      const bytes = b64ToBytes(result.data)
      parts.push(bytes)
      if (result.size > cap) {
        state.value = 'skipped'
        note.value = `文件太大（${(result.size / 1024 / 1024).toFixed(0)} MB），不在卡片里内嵌`
        return
      }
      offset += bytes.length
      if (result.eof || bytes.length === 0) break
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0)
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

  function attempt(): void {
    const token = ++loadToken
    revoke()
    url.value = ''
    note.value = ''
    const current = source.value
    if (!current) {
      state.value = 'idle'
      return
    }
    if (/^(https?|data):/i.test(current.src)) {
      url.value = current.src
      state.value = 'ready'
      return
    }
    // 本地文件等滚进视口再拉；拉不到机器/超大也在这里变成提示
    if (!visible.value) {
      state.value = 'idle'
      return
    }
    state.value = 'loading'
    void run(current.kind, resolvePath(current.src), token)
  }

  // 用稳定 key（kind:src）触发：消息补丁每次都换工具对象，但参数没变就不重拉、视频不重头播
  watch(
    () => [source.value ? `${source.value.kind}:${source.value.src}` : '', visible.value] as const,
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
