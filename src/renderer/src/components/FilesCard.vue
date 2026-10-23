<script setup lang="ts">
// 文件管理器（照 macOS 访达）：左侧边栏（位置 / 磁盘 / 最近 / 本次会话改动）、顶部工具条
// （后退 / 前进 / 上一级、可点的路径面包屑、图标 / 列表视图、搜索、新建文件夹、下载）、
// 中间文件区（列表视图可按名称 / 修改日期 / 大小 / 种类排序；图标视图带图片缩略图）、右侧预览栏，
// 空格键快速查看（Quick Look），右键菜单（打开 / 快速查看 / 下载到本地 / 复制路径 / 让 Friday 看看…）。
// 协议能力（服务端 2.75）：fs.list / fs.read / fs.mkdir + 会话改动 fs.changes / fs.diff / fs.revert；
// 没有重命名、删除、移动、写入——这些做不了，界面里就不摆。
// 下载到本地走 lib/remoteDownload（fs.read 分块读回，主进程落盘，保存位置由用户在系统对话框里选）。
// 上传：把本机文件 / 文件夹拖进来（或工具条「上传」），落到当前目录（拖到某个文件夹行上就落进那个文件夹）——
// lib/remoteUpload：file.upload 传上去，再用一条后台命令挪进目标目录（协议没有直接写目录的方法）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  FsChange,
  FsChangesResult,
  FsDiffResult,
  FsEntry,
  FsListResult,
  FsMkdirResult,
  FsReadResult
} from '../../../protocol/rpc/protocol.js'
import { rpc } from '../lib/host.js'
import { useAppStore } from '../stores/app.js'
import { cancelDownload, dismissDownload, downloadJobs, downloadToLocal, revealDownload, type DownloadJob } from '../lib/remoteDownload.js'
import { cancelUpload, dismissUpload, uploadJobs, uploadToRemote, type DropTree, type ShellFlavor, type UploadJob } from '../lib/remoteUpload.js'
import { runRemoteCommand } from '../lib/remoteCommand.js'

const store = useAppStore()
const rootEl = ref<HTMLElement | null>(null)

// MARK: 偏好（本机 localStorage：视图 / 排序 / 隐藏文件 / 预览栏）

type ViewMode = 'list' | 'icons'
type SortKey = 'name' | 'modified' | 'size' | 'kind'

function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(`files.${key}`)
    if (value && (allowed as readonly string[]).includes(value)) return value as T
  } catch {
    // 用默认
  }
  return fallback
}
function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(`files.${key}`, value)
  } catch {
    // 存不下就算了
  }
}

const viewMode = ref<ViewMode>(loadPref('view', ['list', 'icons'] as const, 'list'))
const sortKey = ref<SortKey>(loadPref('sort', ['name', 'modified', 'size', 'kind'] as const, 'name'))
const sortAsc = ref(loadPref('asc', ['1', '0'] as const, '1') === '1')
const showHidden = ref(loadPref('hidden', ['1', '0'] as const, '0') === '1')
const previewOpen = ref(loadPref('preview', ['1', '0'] as const, '1') === '1')
watch(viewMode, (v) => savePref('view', v))
watch(sortKey, (v) => savePref('sort', v))
watch(sortAsc, (v) => savePref('asc', v ? '1' : '0'))
watch(showHidden, (v) => savePref('hidden', v ? '1' : '0'))
watch(previewOpen, (v) => savePref('preview', v ? '1' : '0'))

// MARK: 浏览状态

const currentPath = ref('')
const parentPath = ref('')
const entries = ref<FsEntry[]>([])
const roots = ref<NonNullable<FsListResult['roots']>>([])
const truncated = ref(false)
const loading = ref(false)
const error = ref('')
const filter = ref('')
const searchEl = ref<HTMLInputElement | null>(null)

/** 后退 / 前进历史（访达式：进新目录清空前进栈） */
const backStack = ref<string[]>([])
const forwardStack = ref<string[]>([])

/** 左侧栏选中的分区：浏览目录，或「本次会话改动」 */
const section = ref<'browse' | 'changes'>('browse')

const serverInfo = computed(() => store.currentMachineInfo?.serverInfo)
const home = computed(() => serverInfo.value?.home ?? '')

/** 路径分隔符跟着路径本身走：服务端回的 Windows 路径也是正斜杠（C:/Users/…），只有纯反斜杠的才用 \\ */
function sepOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function joinPath(base: string, name: string): string {
  if (!base) return name
  return base.endsWith('/') || base.endsWith('\\') ? `${base}${name}` : `${base}${sepOf(base)}${name}`
}

/** 上一级（客户端算：fs.list 带 files:true 时服务端不回 parent）；盘根 / 根目录没有上一级 */
function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return ''
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return ''
  const parent = trimmed.slice(0, cut)
  if (!parent) return '/'
  return /^[A-Za-z]:$/.test(parent) ? `${parent}${sepOf(path)}` : parent
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** 列目录的代数：快速连点两个目录 / 换机器时，慢回执不能覆盖新目录（还会把错误路径压进后退栈） */
let listSeq = 0

async function list(path?: string, options: { history?: boolean } = {}): Promise<void> {
  if (!store.currentMachine) return
  const machine = store.currentMachine
  const seq = ++listSeq
  const fromPath = currentPath.value
  loading.value = true
  error.value = ''
  try {
    const result = (await rpc(machine, 'fs.list', { path, files: true })) as FsListResult
    // 期间又点了别的目录 / 换了机器：这笔整笔作废（loading 也不动，新一轮自己在管）
    if (seq !== listSeq || machine !== store.currentMachine) return
    if (options.history !== false && fromPath && result.path !== fromPath) {
      backStack.value.push(fromPath)
      if (backStack.value.length > 100) backStack.value.shift()
      forwardStack.value = []
    }
    const changedDir = result.path !== currentPath.value
    currentPath.value = result.path
    parentPath.value = result.parent || parentOf(result.path)
    entries.value = result.entries ?? []
    truncated.value = !!result.truncated
    section.value = 'browse'
    if (changedDir) {
      filter.value = ''
      selected.value = new Set()
      anchor.value = ''
      mkdirOpen.value = false
    } else {
      // 刷新：选中的还在的保留
      const alive = new Set(entries.value.map((entry) => entry.path))
      selected.value = new Set([...selected.value].filter((path) => alive.has(path)))
    }
  } catch (e) {
    if (seq === listSeq && machine === store.currentMachine) error.value = e instanceof Error ? e.message : String(e)
  } finally {
    // 过期回执不动 loading：新一轮请求自己在管转圈，旧请求提前熄掉它会闪
    if (seq === listSeq) loading.value = false
  }
}

function goBack(): void {
  const target = backStack.value.pop()
  if (!target) return
  forwardStack.value.push(currentPath.value)
  void list(target, { history: false })
}

function goForward(): void {
  const target = forwardStack.value.pop()
  if (!target) return
  backStack.value.push(currentPath.value)
  void list(target, { history: false })
}

function goUp(): void {
  if (!parentPath.value) return
  const from = currentPath.value
  void list(parentPath.value).then(() => {
    // 回到上一级时选中刚才所在的文件夹（访达行为）
    const hit = entries.value.find((entry) => entry.path === from)
    if (hit) selectOnly(hit)
  })
}

function refresh(): void {
  if (section.value === 'changes') void loadChanges()
  else void list(currentPath.value, { history: false })
}

/** 面包屑：每一级可点（Windows 盘符 / 类 Unix 根目录都当第一级） */
const crumbs = computed(() => {
  const path = currentPath.value
  if (!path) return [] as Array<{ name: string; path: string }>
  const windows = /^[A-Za-z]:/.test(path)
  const s = sepOf(path)
  const parts = path.split(/[\\/]+/).filter(Boolean)
  const out: Array<{ name: string; path: string }> = []
  let acc = ''
  if (!windows) out.push({ name: '/', path: '/' })
  for (const [index, part] of parts.entries()) {
    if (windows && index === 0) acc = `${part}${s}`
    else acc = acc.endsWith(s) ? `${acc}${part}` : `${acc}${s}${part}`
    out.push({ name: part, path: acc })
  }
  return out
})

/** 面包屑显示：太深时只留根 + 「…」+ 最后三级（「…」点了就是往上一级走出显示范围的那一层） */
const shownCrumbs = computed(() => {
  const all = crumbs.value
  if (all.length <= 5) return all
  const tail = all.slice(-3)
  const hidden = all[all.length - 4]!
  return [all[0]!, { name: '…', path: hidden.path }, ...tail]
})

// MARK: 种类 / 图标 / 格式化

type Category = 'folder' | 'image' | 'video' | 'audio' | 'code' | 'text' | 'archive' | 'pdf' | 'doc' | 'app' | 'other'

const EXT_CATEGORY: Record<string, Category> = {}
const EXT_KIND: Record<string, string> = {}
function registerKind(category: Category, label: string, exts: string): void {
  for (const ext of exts.split(' ')) {
    EXT_CATEGORY[ext] = category
    EXT_KIND[ext] = label
  }
}
registerKind('image', '图像', 'png jpg jpeg gif webp bmp svg ico tif tiff heic avif')
registerKind('video', '视频', 'mp4 mov webm mkv avi m4v flv wmv')
registerKind('audio', '音频', 'mp3 wav flac ogg m4a aac opus wma')
registerKind('code', '源代码', 'ts tsx js jsx mjs cjs vue py go rs java kt c cc cpp h hpp cs rb php swift sh bash zsh ps1 bat cmd lua sql dart scala r m mm')
registerKind('text', '文本', 'txt md markdown log csv tsv json jsonl yaml yml toml xml ini cfg conf env gitignore lock html htm css scss less')
registerKind('archive', '压缩包', 'zip rar 7z tar gz tgz bz2 xz zst')
registerKind('pdf', 'PDF 文稿', 'pdf')
registerKind('doc', '文稿', 'doc docx xls xlsx ppt pptx odt ods odp rtf pages numbers key')
registerKind('app', '应用程序', 'exe msi dll app dmg apk deb rpm appimage so')

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : name.startsWith('.') ? name.slice(1).toLowerCase() : ''
}

function categoryOf(entry: { name: string; dir?: boolean }): Category {
  if (entry.dir) return 'folder'
  return EXT_CATEGORY[extOf(entry.name)] ?? 'other'
}

function kindOf(entry: { name: string; dir?: boolean }): string {
  if (entry.dir) return '文件夹'
  const ext = extOf(entry.name)
  const label = EXT_KIND[ext]
  if (label === '源代码' || label === '文本') return `${ext.toUpperCase()} ${label}`
  return label ?? (ext ? `${ext.toUpperCase()} 文件` : '文件')
}

/** 图标上的小字（扩展名，最多 4 个字符） */
function badgeOf(entry: { name: string; dir?: boolean }): string {
  return entry.dir ? '' : extOf(entry.name).slice(0, 4).toUpperCase()
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '--'
  if (bytes < 1000) return `${bytes} 字节`
  if (bytes < 1000 ** 2) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`
  if (bytes < 1000 ** 3) return `${(bytes / 1000 ** 2).toFixed(1)} MB`
  return `${(bytes / 1000 ** 3).toFixed(2)} GB`
}

function formatDate(iso?: string): string {
  if (!iso) return '--'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--'
  const pad = (n: number): string => String(n).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (date.toDateString() === today.toDateString()) return `今天 ${time}`
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${time}`
}

// MARK: 排序 / 过滤后的条目

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

const shownEntries = computed(() => {
  const query = filter.value.trim().toLowerCase()
  const list = entries.value.filter(
    (entry) => (showHidden.value || !entry.name.startsWith('.')) && (!query || entry.name.toLowerCase().includes(query))
  )
  const dir = sortAsc.value ? 1 : -1
  return list.sort((a, b) => {
    // 文件夹始终在前（访达「将文件夹保持在顶部」）
    if (!!a.dir !== !!b.dir) return a.dir ? -1 : 1
    let diff = 0
    if (sortKey.value === 'modified') diff = (Date.parse(a.modified ?? '') || 0) - (Date.parse(b.modified ?? '') || 0)
    else if (sortKey.value === 'size') diff = (a.size ?? 0) - (b.size ?? 0)
    else if (sortKey.value === 'kind') diff = collator.compare(kindOf(a), kindOf(b))
    if (diff === 0) diff = collator.compare(a.name, b.name)
    return diff * dir
  })
})

const hiddenCount = computed(() => (showHidden.value ? 0 : entries.value.filter((entry) => entry.name.startsWith('.')).length))

function setSort(key: SortKey): void {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value
  else {
    sortKey.value = key
    // 日期 / 大小默认从大到小（最新的、最大的在上），名称 / 种类从 A 到 Z
    sortAsc.value = key === 'name' || key === 'kind'
  }
}

// MARK: 选择（单击选中、Ctrl 多选、Shift 连选）

const selected = ref<Set<string>>(new Set())
const anchor = ref('')

const selectedEntries = computed(() => shownEntries.value.filter((entry) => selected.value.has(entry.path)))
const focusEntry = computed(() => (selectedEntries.value.length === 1 ? selectedEntries.value[0]! : null))
const selectedSize = computed(() => selectedEntries.value.reduce((sum, entry) => sum + (entry.dir ? 0 : (entry.size ?? 0)), 0))

function selectOnly(entry: FsEntry): void {
  selected.value = new Set([entry.path])
  anchor.value = entry.path
  void nextTick(() => scrollIntoView(entry.path))
}

function onItemClick(event: MouseEvent, entry: FsEntry): void {
  rootEl.value?.focus({ preventScroll: true })
  if (event.ctrlKey || event.metaKey) {
    const next = new Set(selected.value)
    if (next.has(entry.path)) next.delete(entry.path)
    else next.add(entry.path)
    selected.value = next
    anchor.value = entry.path
    return
  }
  if (event.shiftKey && anchor.value) {
    const list = shownEntries.value
    const a = list.findIndex((item) => item.path === anchor.value)
    const b = list.findIndex((item) => item.path === entry.path)
    if (a >= 0 && b >= 0) {
      const [from, to] = a < b ? [a, b] : [b, a]
      selected.value = new Set(list.slice(from, to + 1).map((item) => item.path))
      return
    }
  }
  selectOnly(entry)
}

function clearSelection(event: MouseEvent): void {
  if (event.target === event.currentTarget) {
    selected.value = new Set()
    anchor.value = ''
  }
}

function scrollIntoView(path: string): void {
  const el = rootEl.value?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
  el?.scrollIntoView({ block: 'nearest' })
}

/** 打开：文件夹进去；文件进快速查看 */
function openEntry(entry: FsEntry): void {
  if (entry.dir) void list(entry.path)
  else openQuickLook(entry)
}

// MARK: 预览（右侧预览栏 / 快速查看共用）

interface PreviewState {
  path: string
  kind: 'image' | 'text' | 'binary' | 'none'
  text: string
  imageURL: string
  partial: boolean
  loading: boolean
  error: string
}

const preview = ref<PreviewState | null>(null)
let previewSeq = 0
const TEXT_PREVIEW_BYTES = 256 * 1024
const IMAGE_PREVIEW_BYTES = 12 * 1024 * 1024

function decodeBase64(base64: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64
  if (native) return native(base64)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function mimeOf(name: string): string {
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif'
  }
  return map[extOf(name)] ?? 'application/octet-stream'
}

function revokePreview(): void {
  if (preview.value?.imageURL) URL.revokeObjectURL(preview.value.imageURL)
}

async function readRange(path: string, limit: number): Promise<{ bytes: Uint8Array; partial: boolean }> {
  const parts: Uint8Array[] = []
  let offset = 0
  let eof = false
  while (!eof && offset < limit) {
    const result = (await rpc(store.currentMachine, 'fs.read', { path, offset, length: Math.min(1024 * 1024, limit - offset) })) as FsReadResult
    const bytes = decodeBase64(result.data ?? '')
    parts.push(bytes)
    offset += bytes.byteLength
    eof = result.eof
    if (bytes.byteLength === 0) break
  }
  const merged = new Uint8Array(offset)
  let at = 0
  for (const part of parts) {
    merged.set(part, at)
    at += part.byteLength
  }
  return { bytes: merged, partial: !eof }
}

async function loadPreview(entry: FsEntry | null): Promise<void> {
  const seq = ++previewSeq
  revokePreview()
  if (!entry || entry.dir || !store.currentMachine) {
    preview.value = null
    return
  }
  store.activeFile = { path: entry.path, name: entry.name }
  const category = categoryOf(entry)
  const isImage = category === 'image' && mimeOf(entry.name) !== 'application/octet-stream'
  const textual = category === 'code' || category === 'text' || category === 'other'
  if (!isImage && !textual) {
    preview.value = { path: entry.path, kind: 'none', text: '', imageURL: '', partial: false, loading: false, error: '' }
    return
  }
  if (isImage && (entry.size ?? 0) > IMAGE_PREVIEW_BYTES) {
    preview.value = { path: entry.path, kind: 'none', text: '', imageURL: '', partial: false, loading: false, error: '图片太大，下载到本地再看' }
    return
  }
  preview.value = { path: entry.path, kind: isImage ? 'image' : 'text', text: '', imageURL: '', partial: false, loading: true, error: '' }
  try {
    const { bytes, partial } = await readRange(entry.path, isImage ? IMAGE_PREVIEW_BYTES : TEXT_PREVIEW_BYTES)
    if (seq !== previewSeq) return
    if (isImage) {
      const imageURL = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(entry.name) }))
      preview.value = { path: entry.path, kind: 'image', text: '', imageURL, partial, loading: false, error: '' }
      return
    }
    // 前 8 KB 里有 NUL 字节当二进制
    if (bytes.subarray(0, 8192).includes(0)) {
      preview.value = { path: entry.path, kind: 'binary', text: '', imageURL: '', partial, loading: false, error: '' }
      return
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    preview.value = { path: entry.path, kind: 'text', text, imageURL: '', partial, loading: false, error: '' }
  } catch (e) {
    if (seq !== previewSeq) return
    preview.value = { path: entry.path, kind: 'none', text: '', imageURL: '', partial: false, loading: false, error: `读不了：${e instanceof Error ? e.message : String(e)}` }
  }
}

// MARK: 快速查看（空格；声明要在下面的预览 watch 之前——watch 创建时就会读它）

const quickLookOpen = ref(false)
function openQuickLook(entry?: FsEntry): void {
  if (entry) selectOnly(entry)
  if (!focusEntry.value || focusEntry.value.dir) return
  quickLookOpen.value = true
}

// 选中单个文件且预览栏 / 快速查看开着时拉预览（稍等一下：方向键快速划过时不对每个文件都发读请求）
let previewTimer = 0
watch(
  () => [focusEntry.value?.path, previewOpen.value, quickLookOpen.value] as const,
  () => {
    window.clearTimeout(previewTimer)
    const entry = focusEntry.value
    if (!entry || (!previewOpen.value && !quickLookOpen.value)) {
      if (!entry) void loadPreview(null)
      return
    }
    if (preview.value?.path === entry.path) return
    previewTimer = window.setTimeout(() => void loadPreview(entry), 120)
  }
)

// MARK: 图标视图的缩略图（图片小于 2 MB 才拉，按需、缓存在本组件）

const thumbs = ref<Record<string, string>>({})
const thumbLoading = new Set<string>()
const THUMB_MAX_BYTES = 2 * 1024 * 1024
/** 缩略图批次的代数：切目录 / 卸载后旧循环终止，不再为旧目录建 blob URL（没人 revoke，白占内存） */
let thumbSeq = 0

async function loadThumbs(): Promise<void> {
  if (viewMode.value !== 'icons' || !store.currentMachine) return
  const seq = ++thumbSeq
  const targets = shownEntries.value
    .filter((entry) => categoryOf(entry) === 'image' && (entry.size ?? Infinity) <= THUMB_MAX_BYTES && mimeOf(entry.name) !== 'application/octet-stream')
    .filter((entry) => !thumbs.value[entry.path] && !thumbLoading.has(entry.path))
    .slice(0, 60)
  for (const entry of targets) {
    thumbLoading.add(entry.path)
    try {
      const { bytes } = await readRange(entry.path, THUMB_MAX_BYTES)
      if (seq !== thumbSeq) return
      thumbs.value = { ...thumbs.value, [entry.path]: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(entry.name) })) }
    } catch {
      // 拉不到就用图标
    } finally {
      thumbLoading.delete(entry.path)
    }
  }
}

function clearThumbs(): void {
  for (const url of Object.values(thumbs.value)) URL.revokeObjectURL(url)
  thumbs.value = {}
}

watch([viewMode, currentPath], () => {
  clearThumbs()
  void loadThumbs()
})

// MARK: 侧边栏：位置（主目录 / 工作目录 / 桌面 / 文稿 / 下载）、磁盘、最近

const extraPlaces = ref<Array<{ name: string; path: string; icon: string }>>([])
const probedFor = ref('')

async function probePlaces(): Promise<void> {
  const machine = store.currentMachine
  if (!machine || !home.value || probedFor.value === `${machine}|${home.value}`) return
  probedFor.value = `${machine}|${home.value}`
  // 磁盘列表：fs.list 不带 files 时才回 roots（带 files 时不回），单独要一次；「主目录」在位置里已经有了
  try {
    const result = (await rpc(machine, 'fs.list', {})) as FsListResult
    roots.value = (result.roots ?? []).filter((root) => !samePath(root.path, home.value))
  } catch {
    // 拿不到就不显示磁盘分组
  }
  const candidates = [
    { name: '桌面', dir: 'Desktop', icon: 'desktop' },
    { name: '文稿', dir: 'Documents', icon: 'doc' },
    { name: '下载', dir: 'Downloads', icon: 'download' }
  ]
  const found: Array<{ name: string; path: string; icon: string }> = []
  for (const item of candidates) {
    const path = joinPath(home.value, item.dir)
    try {
      await rpc(machine, 'fs.list', { path })
      found.push({ name: item.name, path, icon: item.icon })
    } catch {
      // 这台没有这个目录
    }
  }
  extraPlaces.value = found
}

/** 当前会话的工作目录（没有就用这台机器的默认工作目录） */
const workdir = computed(() => {
  const id = store.activeConversationID
  const summary = store.summaries.find((item) => item.id === id)
  return summary?.workingDirectory || store.details[id]?.runtime?.workingDirectory || serverInfo.value?.defaultWorkingDirectory || ''
})

const places = computed(() => {
  const out: Array<{ name: string; path: string; icon: string }> = []
  if (home.value) out.push({ name: serverInfo.value?.user || '主目录', path: home.value, icon: 'home' })
  if (workdir.value) out.push({ name: `工作目录 · ${baseName(workdir.value)}`, path: workdir.value, icon: 'work' })
  out.push(...extraPlaces.value)
  return out
})

const recent = computed(() =>
  (store.recentDirectories ?? []).filter((item) => item.exists && item.path !== workdir.value).slice(0, 6)
)

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return !!a && !!b && norm(a) === norm(b)
}

// MARK: 新建文件夹（fs.mkdir，服务端 features 带 mkdir 才有）

const canMkdir = computed(() => serverInfo.value?.features?.includes('mkdir') ?? false)
const mkdirOpen = ref(false)
const mkdirName = ref('')
const mkdirBusy = ref(false)
const mkdirError = ref('')
const mkdirInput = ref<HTMLInputElement | null>(null)

function startMkdir(): void {
  if (!canMkdir.value || section.value !== 'browse') return
  mkdirOpen.value = true
  mkdirName.value = '未命名文件夹'
  mkdirError.value = ''
  void nextTick(() => {
    mkdirInput.value?.focus()
    mkdirInput.value?.select()
  })
}

async function submitMkdir(): Promise<void> {
  const name = mkdirName.value.trim()
  if (!name || mkdirBusy.value) return
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    mkdirError.value = '名字里不能有 / 或 \\'
    return
  }
  mkdirBusy.value = true
  mkdirError.value = ''
  try {
    const result = (await rpc(store.currentMachine, 'fs.mkdir', { path: currentPath.value, name })) as FsMkdirResult
    mkdirOpen.value = false
    await list(currentPath.value, { history: false })
    const created = entries.value.find((entry) => samePath(entry.path, result?.path ?? joinPath(currentPath.value, name)))
    if (created) selectOnly(created)
  } catch (e) {
    mkdirError.value = e instanceof Error ? e.message : String(e)
  } finally {
    mkdirBusy.value = false
  }
}

function cancelMkdir(): void {
  mkdirOpen.value = false
  mkdirError.value = ''
  rootEl.value?.focus({ preventScroll: true })
}

// MARK: 下载到本地 / 复制路径 / 让 Friday 看看

const notice = ref('')
let noticeTimer = 0
function flash(text: string): void {
  notice.value = text
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.value = ''), 2200)
}

async function download(items: FsEntry[]): Promise<void> {
  if (!items.length || !store.currentMachine) return
  closeMenu()
  await downloadToLocal(store.currentMachine, items)
}

async function copyText(text: string, label: string): Promise<void> {
  closeMenu()
  try {
    await navigator.clipboard.writeText(text)
    flash(`已复制${label}`)
  } catch {
    flash('复制失败')
  }
}

function askFriday(items: FsEntry[]): void {
  closeMenu()
  if (!items.length) return
  const text =
    items.length === 1
      ? `请看看 ${items[0]!.path} 这个${items[0]!.dir ? '文件夹' : '文件'}，`
      : `请看看这几个文件：\n${items.map((item) => `- ${item.path}`).join('\n')}\n`
  window.dispatchEvent(new CustomEvent('friday-prefill', { detail: text }))
}

const activeJobs = computed(() => downloadJobs.filter((job) => job.phase === 'scanning' || job.phase === 'downloading'))

function jobPercent(job: DownloadJob): number {
  if (job.bytesTotal > 0) return Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 100))
  return job.filesTotal ? Math.round((job.filesDone / job.filesTotal) * 100) : 0
}

function jobText(job: DownloadJob): string {
  switch (job.phase) {
    case 'scanning':
      return `正在清点… ${job.filesTotal} 个文件`
    case 'downloading':
      return `${formatSize(job.bytesDone)} / ${formatSize(job.bytesTotal)}${job.filesTotal > 1 ? ` · ${job.filesDone}/${job.filesTotal} 个` : ''}`
    case 'done':
      return `已下载${job.truncatedDirs ? `（${job.truncatedDirs} 个目录太大只下了一部分）` : ''}`
    case 'canceled':
      return '已取消'
    default:
      return `失败：${job.error}`
  }
}

// MARK: 上传（拖进来 / 工具条按钮）

const dragActive = ref(false)
let dragDepth = 0
/** 拖到某个文件夹行 / 图标上：落进那个文件夹（访达行为）；空 = 当前目录 */
const dropFolder = ref<FsEntry | null>(null)

const canUpload = computed(() => section.value === 'browse' && !!currentPath.value && store.connected)
const shellFlavor = computed<ShellFlavor>(() => (serverInfo.value?.platform === 'windows' ? 'powershell' : 'posix'))
const dropTargetName = computed(() => dropFolder.value?.name ?? (baseName(currentPath.value) || currentPath.value))

function isFileDrag(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes('Files')
}

function onDragEnter(event: DragEvent): void {
  if (!isFileDrag(event)) return
  event.preventDefault()
  dragDepth += 1
  dragActive.value = true
}

function onDragOver(event: DragEvent): void {
  if (!isFileDrag(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = canUpload.value ? 'copy' : 'none'
  const el = (event.target as Element | null)?.closest?.('[data-path]') as HTMLElement | null
  const hit = el ? shownEntries.value.find((entry) => entry.path === el.dataset.path) : undefined
  dropFolder.value = hit?.dir ? hit : null
}

function onDragLeave(event: DragEvent): void {
  if (!isFileDrag(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) {
    dragActive.value = false
    dropFolder.value = null
  }
}

async function onDrop(event: DragEvent): Promise<void> {
  if (!isFileDrag(event)) return
  event.preventDefault()
  event.stopPropagation()
  const folder = dropFolder.value
  dragDepth = 0
  dragActive.value = false
  dropFolder.value = null
  if (!canUpload.value) return
  const files = [...(event.dataTransfer?.files ?? [])]
  const trees = (await Promise.all(files.map((file) => window.fridayBridge.registerDropTree(file).catch(() => null)))).filter(
    (tree): tree is DropTree => !!tree
  )
  if (!trees.length) {
    error.value = '拖进来的东西读不到（没权限或已经不在了）'
    return
  }
  await startUpload(trees, folder)
}

/** 工具条「上传」/ 右键「上传文件到这里」：系统对话框选文件（对话框只能选文件；整个文件夹请直接拖进来） */
async function pickUpload(): Promise<void> {
  closeMenu()
  if (!canUpload.value) return
  const picked = await window.fridayBridge.pickAttachments()
  const trees: DropTree[] = picked.map((file) => ({
    name: file.name,
    files: [{ handle: file.handle, rel: file.name, size: file.size }],
    dirs: [],
    truncated: false
  }))
  if (trees.length) await startUpload(trees, null)
}

async function startUpload(trees: DropTree[], folder: FsEntry | null): Promise<void> {
  const machine = store.currentMachine
  // 服务端跑挪文件命令的终端必须挂在一段会话上：当前会话，没有就最近一段
  const conversationID = store.activeConversationID || store.summaries[0]?.id || ''
  if (!machine) return
  if (!conversationID) {
    error.value = '上传要先有一段会话（服务端挪文件的命令挂在会话上）：先新建一段会话再拖进来'
    return
  }
  error.value = ''
  const target = folder?.path ?? currentPath.value
  let existing = entries.value.map((entry) => entry.name)
  if (folder) {
    try {
      existing = ((await rpc(machine, 'fs.list', { path: folder.path, files: true })) as FsListResult).entries.map((entry) => entry.name)
    } catch {
      existing = []
    }
  }
  const job = await uploadToRemote({
    targetDir: target,
    flavor: shellFlavor.value,
    existing,
    trees,
    io: {
      upload: (handle) => store.uploadFile(handle),
      run: (command) => runRemoteCommand(machine, conversationID, command)
    }
  })
  // 还停在上传的那个目录：刷新并选中刚放进来的
  if (job.phase !== 'canceled' && samePath(currentPath.value, folder ? currentPath.value : target)) {
    await list(currentPath.value, { history: false })
    const names = new Set(folder ? [folder.name] : job.placed)
    const hits = entries.value.filter((entry) => names.has(entry.name))
    if (hits.length) {
      selected.value = new Set(hits.map((entry) => entry.path))
      anchor.value = hits[0]!.path
    }
  }
}

function uploadPercent(job: UploadJob): number {
  if (job.phase === 'placing') return 100
  if (job.bytesTotal > 0) return Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 100))
  return job.filesTotal ? Math.round((job.filesDone / job.filesTotal) * 100) : 0
}

function uploadText(job: UploadJob): string {
  switch (job.phase) {
    case 'uploading':
      return `上传中 ${formatSize(job.bytesDone)} / ${formatSize(job.bytesTotal)}${job.filesTotal > 1 ? ` · ${job.filesDone}/${job.filesTotal} 个` : ''}`
    case 'placing':
      return '正在放进目录…'
    case 'done':
      return `已上传到「${baseName(job.target) || job.target}」${job.truncated ? '（文件夹太大，只传了前一部分）' : ''}`
    case 'canceled':
      return '已取消'
    default:
      return `失败：${job.error}`
  }
}

// MARK: 右键菜单

const menu = ref<{ x: number; y: number; target: FsEntry | null } | null>(null)

function openMenu(event: MouseEvent, entry: FsEntry | null): void {
  event.preventDefault()
  if (entry && !selected.value.has(entry.path)) selectOnly(entry)
  if (!entry) {
    selected.value = new Set()
  }
  const box = rootEl.value?.getBoundingClientRect()
  if (!box) return
  // 先按点击位置放，渲染后再夹回卡片里（菜单高度事先不知道）
  menu.value = { x: event.clientX - box.left, y: event.clientY - box.top, target: entry }
  void nextTick(() => {
    const el = rootEl.value?.querySelector<HTMLElement>('.ctx-menu')
    if (!el || !menu.value) return
    const maxX = box.width - el.offsetWidth - 6
    const maxY = box.height - el.offsetHeight - 6
    menu.value = { ...menu.value, x: Math.max(6, Math.min(menu.value.x, maxX)), y: Math.max(6, Math.min(menu.value.y, maxY)) }
  })
}

function closeMenu(): void {
  menu.value = null
}

function onDocPointerDown(event: PointerEvent): void {
  if (menu.value && !(event.target as Element | null)?.closest?.('.ctx-menu')) closeMenu()
}

/** 右键菜单 / 快速查看开着时，Esc 不管焦点在哪都先关它们（捕获阶段 + preventDefault：
 *  不然焦点不在文件窗口里时，这次 Esc 会落到 App 的「取消选中会话」上，菜单却还开着） */
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || (!menu.value && !quickLookOpen.value)) return
  if (menu.value) closeMenu()
  else quickLookOpen.value = false
  event.preventDefault()
  event.stopPropagation()
}

// MARK: 键盘（卡片获得焦点时）

let typeAhead = ''
let typeAheadTimer = 0

function gridColumns(): number {
  if (viewMode.value !== 'icons') return 1
  const grid = rootEl.value?.querySelector<HTMLElement>('.icon-grid')
  const first = grid?.querySelector<HTMLElement>('.tile')
  if (!grid || !first) return 1
  return Math.max(1, Math.floor(grid.clientWidth / (first.offsetWidth + 8)))
}

function moveSelection(delta: number, extend: boolean): void {
  const list = shownEntries.value
  if (!list.length) return
  const current = list.findIndex((entry) => entry.path === (extend ? anchorMoving.value || anchor.value : anchor.value))
  const next = current < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, current + delta))
  const target = list[next]!
  if (extend && anchor.value) {
    const a = list.findIndex((entry) => entry.path === anchor.value)
    const [from, to] = a < next ? [a, next] : [next, a]
    selected.value = new Set(list.slice(from, to + 1).map((entry) => entry.path))
    anchorMoving.value = target.path
    void nextTick(() => scrollIntoView(target.path))
    return
  }
  anchorMoving.value = ''
  selectOnly(target)
}
const anchorMoving = ref('')

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
  const ctrl = event.ctrlKey || event.metaKey
  if (event.key === 'Escape') {
    if (menu.value) closeMenu()
    else if (quickLookOpen.value) quickLookOpen.value = false
    else if (selected.value.size) selected.value = new Set()
    else return
    event.preventDefault()
    event.stopPropagation()
    return
  }
  if (section.value !== 'browse') return
  const cols = gridColumns()
  if (event.key === 'ArrowDown' && (ctrl || event.altKey) && focusEntry.value) {
    openEntry(focusEntry.value)
  } else if (event.key === 'ArrowUp' && (ctrl || event.altKey)) {
    goUp()
  } else if (event.key === 'ArrowLeft' && event.altKey) {
    goBack()
  } else if (event.key === 'ArrowRight' && event.altKey) {
    goForward()
  } else if (event.key === 'ArrowDown') {
    moveSelection(cols, event.shiftKey)
  } else if (event.key === 'ArrowUp') {
    moveSelection(-cols, event.shiftKey)
  } else if (event.key === 'ArrowRight' && viewMode.value === 'icons') {
    moveSelection(1, event.shiftKey)
  } else if (event.key === 'ArrowLeft' && viewMode.value === 'icons') {
    moveSelection(-1, event.shiftKey)
  } else if (event.key === 'Home' && shownEntries.value.length) {
    selectOnly(shownEntries.value[0]!)
  } else if (event.key === 'End' && shownEntries.value.length) {
    selectOnly(shownEntries.value[shownEntries.value.length - 1]!)
  } else if (event.key === 'Enter' && focusEntry.value) {
    openEntry(focusEntry.value)
  } else if (event.key === 'Backspace') {
    goUp()
  } else if (event.key === ' ') {
    if (quickLookOpen.value) quickLookOpen.value = false
    else openQuickLook()
  } else if (ctrl && event.key.toLowerCase() === 'a') {
    selected.value = new Set(shownEntries.value.map((entry) => entry.path))
  } else if (ctrl && event.key.toLowerCase() === 'f') {
    searchEl.value?.focus()
  } else if ((ctrl && event.key.toLowerCase() === 'r') || event.key === 'F5') {
    refresh()
  } else if (ctrl && event.shiftKey && event.key.toLowerCase() === 'n') {
    startMkdir()
  } else if (ctrl && event.key.toLowerCase() === 'c' && selectedEntries.value.length) {
    void copyText(selectedEntries.value.map((entry) => entry.path).join('\n'), '路径')
  } else if (event.key.length === 1 && !ctrl && !event.altKey) {
    // 打字跳转：按名字前缀找
    typeAhead += event.key.toLowerCase()
    window.clearTimeout(typeAheadTimer)
    typeAheadTimer = window.setTimeout(() => (typeAhead = ''), 800)
    const hit = shownEntries.value.find((entry) => entry.name.toLowerCase().startsWith(typeAhead))
    if (hit) selectOnly(hit)
  } else {
    return
  }
  event.preventDefault()
  event.stopPropagation()
}

// MARK: 本次会话改动（fs.changes / fs.diff / fs.revert，2.31 起；旧服务端不显示这一项）

const changes = ref<FsChange[]>([])
const changesAvailable = ref(true)
const diff = ref<{ path: string; lines: DiffLine[]; status: string; binary: boolean; tooLarge: boolean } | null>(null)
const confirmingRevert = ref('')
interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

async function loadChanges(): Promise<void> {
  const conversationID = store.detail?.conversationID
  if (!store.currentMachine || !conversationID) {
    changes.value = []
    return
  }
  try {
    const result = (await rpc(store.currentMachine, 'fs.changes', { conversationID })) as FsChangesResult
    changes.value = result.files ?? []
    changesAvailable.value = true
  } catch {
    changes.value = []
    changesAvailable.value = false
  }
}

/** 逐行对比（客户端做）：LCS，超过 4000 行退化为「只有新内容」 */
function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (a.length + b.length > 4000) return b.map((text) => ({ kind: 'add' as const, text }))
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i += 1) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]! })
      i += 1
    } else {
      out.push({ kind: 'add', text: b[j]! })
      j += 1
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++]! })
  while (j < m) out.push({ kind: 'add', text: b[j++]! })
  return out
}

async function openDiff(change: FsChange): Promise<void> {
  const conversationID = store.detail?.conversationID
  if (!store.currentMachine || !conversationID) return
  error.value = ''
  try {
    const result = (await rpc(store.currentMachine, 'fs.diff', { conversationID, path: change.path })) as FsDiffResult
    diff.value = {
      path: result.path,
      status: result.status,
      binary: result.binary,
      tooLarge: result.tooLarge,
      lines: result.known && !result.binary && !result.tooLarge ? lineDiff(result.old, result.new) : []
    }
    store.activeFile = { path: result.path, name: baseName(result.path) }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** 撤销会话改动（先点一下变「确定？」，再点才撤） */
async function doRevert(path?: string): Promise<void> {
  const conversationID = store.detail?.conversationID
  if (!store.currentMachine || !conversationID) return
  try {
    const result = (await rpc(store.currentMachine, 'fs.revert', { conversationID, ...(path ? { path } : {}) })) as {
      failed: Array<{ path: string; error: string }>
    }
    const failed = result.failed ?? []
    error.value = failed.length
      ? `有 ${failed.length} 个文件撤不了：${failed.map((item) => `${item.path}（${item.error}）`).join('；')}`
      : ''
    confirmingRevert.value = ''
    diff.value = null
    await loadChanges()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function showChanges(): void {
  section.value = 'changes'
  selected.value = new Set()
  void loadChanges()
}

function revealChange(change: FsChange): void {
  // 在文件区里定位改动的文件：进它所在的目录并选中
  const full = /^([A-Za-z]:|\/)/.test(change.path) ? change.path : joinPath(workdir.value, change.path)
  // 根目录下的文件（如 /a.txt、C:\a.txt）剥文件名后是空串：用 parentOf 补成 '/' 或 'C:\'，
  // 别拿空 path 或 'C:'（那是「盘的当前目录」）去 fs.list
  const dir = full.replace(/[\\/][^\\/]+$/, '') || parentOf(full) || undefined
  void list(dir).then(() => {
    const hit = entries.value.find((entry) => samePath(entry.path, full))
    if (hit) selectOnly(hit)
  })
}

// MARK: 生命周期

onMounted(async () => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('keydown', onWindowKeydown, true)
  await list(undefined, { history: false })
  rootEl.value?.focus({ preventScroll: true })
  void probePlaces()
  void loadChanges()
  if (store.recentDirectories === null) void store.refreshDirectories()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.clearTimeout(previewTimer)
  window.clearTimeout(noticeTimer)
  window.clearTimeout(typeAheadTimer)
  listSeq++ // 在途的列目录回执作废
  thumbSeq++ // 在途的缩略图循环终止（里面的 blob URL 也就不会建出来）
  revokePreview()
  clearThumbs()
})

// 换会话：上一段会话的 diff 预览和「确定？」武装状态不能留着——
// 同工作目录的会话改动列表常含同名路径，残留的确认态会用新会话的 id 去撤旧路径
function resetChangesUI(): void {
  diff.value = null
  confirmingRevert.value = ''
}
watch(() => store.detail?.conversationID, () => {
  resetChangesUI()
  void loadChanges()
})
watch(home, () => void probePlaces())
// 换机器：回到新机器的主目录、清掉历史
watch(
  () => store.currentMachine,
  () => {
    backStack.value = []
    forwardStack.value = []
    currentPath.value = ''
    extraPlaces.value = []
    resetChangesUI()
    void list(undefined, { history: false })
  }
)
watch(shownEntries, () => void loadThumbs())
</script>

<template>
  <div
    ref="rootEl"
    class="finder"
    tabindex="0"
    @keydown="onKeydown"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- 工具条：后退 / 前进 / 上一级 · 面包屑 · 视图 · 搜索 · 新建文件夹 · 下载 · 预览栏 -->
    <div class="toolbar">
      <div class="nav-group">
        <button class="tool" :disabled="!backStack.length" title="后退（Alt+←）" @click="goBack">
          <svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" /></svg>
        </button>
        <button class="tool" :disabled="!forwardStack.length" title="前进（Alt+→）" @click="goForward">
          <svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" /></svg>
        </button>
        <button class="tool" :disabled="!parentPath || section !== 'browse'" title="上一级（Backspace / Ctrl+↑）" @click="goUp">
          <svg viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
        </button>
      </div>

      <div class="crumbs" :title="currentPath">
        <template v-if="section === 'browse'">
          <template v-for="(crumb, index) in shownCrumbs" :key="crumb.path + index">
            <span v-if="index > 0" class="crumb-sep">›</span>
            <button
              class="crumb"
              :class="{ last: index === shownCrumbs.length - 1 }"
              :title="crumb.path"
              @click="list(crumb.path)"
            >{{ crumb.name }}</button>
          </template>
        </template>
        <span v-else class="crumb last">本次会话改动</span>
      </div>

      <div class="seg" role="group" aria-label="视图">
        <button class="tool" :class="{ on: viewMode === 'icons' }" title="图标视图" @click="viewMode = 'icons'">
          <svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></svg>
        </button>
        <button class="tool" :class="{ on: viewMode === 'list' }" title="列表视图" @click="viewMode = 'list'">
          <svg viewBox="0 0 16 16"><path d="M5.5 4h8M5.5 8h8M5.5 12h8" /><circle cx="2.8" cy="4" r=".6" /><circle cx="2.8" cy="8" r=".6" /><circle cx="2.8" cy="12" r=".6" /></svg>
        </button>
      </div>

      <button v-if="canMkdir" class="tool" :disabled="section !== 'browse'" title="新建文件夹（Ctrl+Shift+N）" @click="startMkdir">
        <svg viewBox="0 0 16 16"><path d="M1.8 4.2c0-.6.4-1 1-1h3l1.4 1.5h5.9c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z" /><path d="M8 7.2v3.6M6.2 9h3.6" /></svg>
      </button>
      <button class="tool" :disabled="!canUpload" title="上传文件到当前文件夹（也可以把文件 / 文件夹直接拖进来）" @click="pickUpload">
        <svg viewBox="0 0 16 16"><path d="M8 10.5v-8M4.5 6 8 2.5 11.5 6M3 13.5h10" /></svg>
      </button>
      <button class="tool" :disabled="!selectedEntries.length" title="下载到本地" @click="download(selectedEntries)">
        <svg viewBox="0 0 16 16"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" /></svg>
      </button>
      <button class="tool" :class="{ on: previewOpen }" title="显示 / 隐藏预览栏" @click="previewOpen = !previewOpen">
        <svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M10 2.5v11" /></svg>
      </button>

      <label class="search">
        <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></svg>
        <input ref="searchEl" v-model="filter" placeholder="搜索当前文件夹" @keydown.esc.stop="filter = ''; rootEl?.focus()" />
      </label>
    </div>

    <div class="main">
      <!-- 侧边栏 -->
      <nav class="sidebar">
        <div class="side-group">位置</div>
        <button
          v-for="place in places"
          :key="place.path"
          class="side-item"
          :class="{ active: section === 'browse' && samePath(currentPath, place.path) }"
          :title="place.path"
          @click="list(place.path)"
        >
          <span class="side-icon" :class="place.icon" />
          <span class="side-name">{{ place.name }}</span>
        </button>

        <template v-if="roots.length">
          <div class="side-group">磁盘</div>
          <button
            v-for="root in roots"
            :key="root.path"
            class="side-item"
            :class="{ active: section === 'browse' && samePath(currentPath, root.path) }"
            :title="root.path"
            @click="list(root.path)"
          >
            <span class="side-icon disk" />
            <span class="side-name">{{ root.name }}</span>
          </button>
        </template>

        <template v-if="recent.length">
          <div class="side-group">最近</div>
          <button
            v-for="item in recent"
            :key="item.path"
            class="side-item"
            :class="{ active: section === 'browse' && samePath(currentPath, item.path) }"
            :title="item.path"
            @click="list(item.path)"
          >
            <span class="side-icon folder" />
            <span class="side-name">{{ baseName(item.path) }}</span>
          </button>
        </template>

        <template v-if="changesAvailable && store.detail">
          <div class="side-group">会话</div>
          <button class="side-item" :class="{ active: section === 'changes' }" @click="showChanges">
            <span class="side-icon chg" />
            <span class="side-name">本次会话改动</span>
            <span v-if="changes.length" class="side-count">{{ changes.length }}</span>
          </button>
        </template>
      </nav>

      <!-- 文件区 -->
      <section class="content">
        <div v-if="error" class="error">{{ error }}</div>
        <!-- 拖着文件进来时的投放提示（不接鼠标：下面的文件夹行照样能当投放目标） -->
        <div v-if="dragActive" class="drop-overlay" :class="{ blocked: !canUpload, into: !!dropFolder }">
          <div class="drop-card">
            <svg viewBox="0 0 16 16"><path d="M8 10.5v-8M4.5 6 8 2.5 11.5 6M3 13.5h10" /></svg>
            <span v-if="canUpload">松手上传到「{{ dropTargetName }}」</span>
            <span v-else>{{ section === 'browse' ? '还没连上机器' : '切回文件夹再拖进来' }}</span>
          </div>
        </div>

        <template v-if="section === 'browse'">
          <!-- 列表视图 -->
          <div v-if="viewMode === 'list'" class="list" @click="clearSelection" @contextmenu.self="openMenu($event, null)">
            <div class="list-head">
              <button class="col name" @click="setSort('name')">
                名称<span v-if="sortKey === 'name'" class="sort">{{ sortAsc ? '▲' : '▼' }}</span>
              </button>
              <button class="col date" @click="setSort('modified')">
                修改日期<span v-if="sortKey === 'modified'" class="sort">{{ sortAsc ? '▲' : '▼' }}</span>
              </button>
              <button class="col size" @click="setSort('size')">
                大小<span v-if="sortKey === 'size'" class="sort">{{ sortAsc ? '▲' : '▼' }}</span>
              </button>
              <button class="col kind" @click="setSort('kind')">
                种类<span v-if="sortKey === 'kind'" class="sort">{{ sortAsc ? '▲' : '▼' }}</span>
              </button>
            </div>
            <div class="list-body" @click="clearSelection" @contextmenu.self="openMenu($event, null)">
              <div v-if="mkdirOpen" class="row mkdir-row">
                <span class="col name">
                  <span class="file-icon folder small" />
                  <input
                    ref="mkdirInput"
                    v-model="mkdirName"
                    class="mkdir-input"
                    :disabled="mkdirBusy"
                    @keydown.enter.prevent="submitMkdir"
                    @keydown.esc.stop.prevent="cancelMkdir"
                    @blur="mkdirName.trim() ? submitMkdir() : cancelMkdir()"
                  />
                </span>
                <span v-if="mkdirError" class="mkdir-error">{{ mkdirError }}</span>
              </div>
              <div
                v-for="entry in shownEntries"
                :key="entry.path"
                class="row"
                :class="{ selected: selected.has(entry.path), dir: entry.dir, 'drop-into': dropFolder?.path === entry.path }"
                :data-path="entry.path"
                :title="entry.path"
                @click.stop="onItemClick($event, entry)"
                @dblclick="openEntry(entry)"
                @contextmenu.stop="openMenu($event, entry)"
              >
                <span class="col name">
                  <span class="file-icon small" :class="categoryOf(entry)"><i v-if="badgeOf(entry)">{{ badgeOf(entry) }}</i></span>
                  <span class="file-name">{{ entry.name }}</span>
                </span>
                <span class="col date">{{ formatDate(entry.modified) }}</span>
                <span class="col size">{{ entry.dir ? '--' : formatSize(entry.size) }}</span>
                <span class="col kind">{{ kindOf(entry) }}</span>
              </div>
              <div v-if="!loading && !shownEntries.length && !mkdirOpen" class="empty">
                {{ filter ? `没有名字里带「${filter}」的项目` : '这个文件夹是空的' }}
              </div>
            </div>
          </div>

          <!-- 图标视图 -->
          <div v-else class="icon-grid" @click="clearSelection" @contextmenu.self="openMenu($event, null)">
            <div v-if="mkdirOpen" class="tile mkdir-tile">
              <span class="file-icon folder big" />
              <input
                ref="mkdirInput"
                v-model="mkdirName"
                class="mkdir-input"
                :disabled="mkdirBusy"
                @keydown.enter.prevent="submitMkdir"
                @keydown.esc.stop.prevent="cancelMkdir"
                @blur="mkdirName.trim() ? submitMkdir() : cancelMkdir()"
              />
              <span v-if="mkdirError" class="mkdir-error">{{ mkdirError }}</span>
            </div>
            <div
              v-for="entry in shownEntries"
              :key="entry.path"
              class="tile"
              :class="{ selected: selected.has(entry.path), 'drop-into': dropFolder?.path === entry.path }"
              :data-path="entry.path"
              :title="`${entry.name}\n${kindOf(entry)}${entry.dir ? '' : ' · ' + formatSize(entry.size)}\n${formatDate(entry.modified)}`"
              @click.stop="onItemClick($event, entry)"
              @dblclick="openEntry(entry)"
              @contextmenu.stop="openMenu($event, entry)"
            >
              <img v-if="thumbs[entry.path]" class="thumb" :src="thumbs[entry.path]" :alt="entry.name" draggable="false" />
              <span v-else class="file-icon big" :class="categoryOf(entry)"><i v-if="badgeOf(entry)">{{ badgeOf(entry) }}</i></span>
              <span class="tile-name">{{ entry.name }}</span>
            </div>
            <div v-if="!loading && !shownEntries.length && !mkdirOpen" class="empty">
              {{ filter ? `没有名字里带「${filter}」的项目` : '这个文件夹是空的' }}
            </div>
          </div>
        </template>

        <!-- 本次会话改动 -->
        <div v-else class="changes">
          <div class="changes-head">
            <span>{{ changes.length ? `${changes.length} 个文件有改动` : '这段会话还没改过文件' }}</span>
            <span class="spacer" />
            <template v-if="changes.length">
              <button v-if="confirmingRevert !== 'all'" class="link danger" @click="confirmingRevert = 'all'">撤销全部</button>
              <span v-else class="confirm-inline">
                确定撤销全部改动？
                <button class="link danger" @click="doRevert()">确定</button>
                <button class="link" @click="confirmingRevert = ''">取消</button>
              </span>
            </template>
          </div>
          <div
            v-for="item in changes"
            :key="item.path"
            class="change-row"
            :class="{ selected: diff?.path === item.path }"
            @click="openDiff(item)"
          >
            <span class="badge" :class="item.status">{{ item.status }}</span>
            <span class="change-path" :title="item.path">{{ item.path }}</span>
            <span v-if="item.known" class="stat"><span class="add">+{{ item.added }}</span> <span class="del">−{{ item.removed }}</span></span>
            <span v-else class="stat muted">改动未知</span>
            <button class="link" title="在文件区里显示" @click.stop="revealChange(item)">定位</button>
            <button
              class="link rev"
              title="撤销这个文件的改动"
              @click.stop="confirmingRevert === item.path ? doRevert(item.path) : (confirmingRevert = item.path)"
            >
              {{ confirmingRevert === item.path ? '确定？' : '↺' }}
            </button>
          </div>
        </div>
      </section>

      <!-- 预览栏 -->
      <aside v-if="previewOpen" class="inspector">
        <template v-if="section === 'changes'">
          <template v-if="diff">
            <div class="insp-title"><span class="badge" :class="diff.status">{{ diff.status }}</span> {{ baseName(diff.path) }}</div>
            <div class="insp-path">{{ diff.path }}</div>
            <div v-if="diff.binary" class="insp-note">二进制文件，不做逐行对比</div>
            <div v-else-if="diff.tooLarge" class="insp-note">文件太大（超过 1 MB），不做逐行对比</div>
            <div v-else-if="!diff.lines.length" class="insp-note">没有可显示的内容</div>
            <pre v-else class="diff"><code><span
              v-for="(line, index) in diff.lines"
              :key="index"
              class="diff-line"
              :class="line.kind"
            >{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ' }} {{ line.text }}
</span></code></pre>
          </template>
          <div v-else class="insp-empty">点左边的改动看对比</div>
        </template>

        <template v-else-if="focusEntry">
          <div class="insp-hero">
            <img v-if="preview?.kind === 'image' && preview.imageURL" class="insp-image" :src="preview.imageURL" :alt="focusEntry.name" />
            <span v-else class="file-icon huge" :class="categoryOf(focusEntry)"><i v-if="badgeOf(focusEntry)">{{ badgeOf(focusEntry) }}</i></span>
          </div>
          <div class="insp-title">{{ focusEntry.name }}</div>
          <div class="insp-sub">{{ kindOf(focusEntry) }}{{ focusEntry.dir ? '' : ` · ${formatSize(focusEntry.size)}` }}</div>
          <dl class="insp-info">
            <dt>修改日期</dt><dd>{{ formatDate(focusEntry.modified) }}</dd>
            <dt>位置</dt><dd class="mono" :title="focusEntry.path">{{ focusEntry.path }}</dd>
          </dl>
          <div class="insp-actions">
            <button class="act" @click="download([focusEntry])">下载到本地</button>
            <button v-if="focusEntry.dir" class="act" @click="openEntry(focusEntry)">打开</button>
            <button v-else class="act" @click="openQuickLook()">快速查看</button>
            <button class="act" @click="askFriday([focusEntry])">让 Friday 看看</button>
          </div>
          <template v-if="!focusEntry.dir">
            <div v-if="preview?.loading" class="insp-note">读取中…</div>
            <div v-else-if="preview?.error" class="insp-note">{{ preview.error }}</div>
            <div v-else-if="preview?.kind === 'binary'" class="insp-note">二进制文件，没法预览内容</div>
            <pre v-else-if="preview?.kind === 'text'" class="insp-text">{{ preview.text.slice(0, 20000) }}</pre>
          </template>
        </template>

        <template v-else-if="selectedEntries.length > 1">
          <div class="insp-hero"><span class="file-icon huge multi" /></div>
          <div class="insp-title">已选 {{ selectedEntries.length }} 项</div>
          <div class="insp-sub">文件合计 {{ formatSize(selectedSize) }}</div>
          <div class="insp-actions">
            <button class="act" @click="download(selectedEntries)">全部下载到本地</button>
            <button class="act" @click="askFriday(selectedEntries)">让 Friday 看看</button>
          </div>
        </template>

        <template v-else>
          <div class="insp-hero"><span class="file-icon huge folder" /></div>
          <div class="insp-title">{{ baseName(currentPath) || currentPath }}</div>
          <div class="insp-sub">{{ shownEntries.length }} 项</div>
          <div class="insp-actions">
            <button class="act" :disabled="!currentPath" @click="download([{ name: baseName(currentPath) || 'folder', path: currentPath, dir: true }])">
              下载整个文件夹
            </button>
          </div>
        </template>
      </aside>
    </div>

    <!-- 状态栏：项目数 / 选中 / 隐藏文件 · 下载进度 -->
    <footer class="statusbar">
      <span>{{ loading ? '读取中…' : section === 'browse' ? `${shownEntries.length} 项` : `${changes.length} 个改动` }}</span>
      <span v-if="selectedEntries.length" class="dim">· 已选 {{ selectedEntries.length }} 项</span>
      <span v-if="truncated && section === 'browse'" class="warn">· 文件太多，只列了前一部分</span>
      <button v-if="hiddenCount || showHidden" class="link small" @click="showHidden = !showHidden">
        {{ showHidden ? '隐藏以 . 开头的项目' : `显示隐藏项目（${hiddenCount}）` }}
      </button>
      <span v-if="notice" class="notice">{{ notice }}</span>
      <span class="spacer" />
      <span v-if="!activeJobs.length && downloadJobs.length" class="dim">{{ downloadJobs[0]!.title }} · {{ jobText(downloadJobs[0]!) }}</span>
    </footer>

    <!-- 下载列表：进行中的 + 最近完成的（可在文件夹中显示 / 取消 / 移除） -->
    <div v-if="downloadJobs.length || uploadJobs.length" class="downloads">
      <div v-for="job in uploadJobs.slice(0, 3)" :key="'u' + job.id" class="dl up" :class="job.phase">
        <span class="dl-icon">⤒</span>
        <div class="dl-main">
          <div class="dl-title">{{ job.title }}<span v-if="job.current && job.filesTotal > 1" class="dim"> · {{ job.current }}</span></div>
          <div v-if="job.phase === 'uploading' || job.phase === 'placing'" class="dl-bar"><i :style="{ width: uploadPercent(job) + '%' }" /></div>
          <div class="dl-text">{{ uploadText(job) }}</div>
        </div>
        <button v-if="job.phase === 'uploading'" class="link" @click="cancelUpload(job)">取消</button>
        <button v-else-if="job.phase !== 'placing'" class="link muted" title="移除这条记录" @click="dismissUpload(job)">✕</button>
      </div>
      <div v-for="job in downloadJobs.slice(0, 3)" :key="job.id" class="dl" :class="job.phase">
        <span class="dl-icon">⤓</span>
        <div class="dl-main">
          <div class="dl-title">{{ job.title }}<span v-if="job.current && job.filesTotal > 1" class="dim"> · {{ job.current }}</span></div>
          <div v-if="job.phase === 'downloading' || job.phase === 'scanning'" class="dl-bar"><i :style="{ width: jobPercent(job) + '%' }" /></div>
          <div class="dl-text">{{ jobText(job) }}</div>
        </div>
        <button v-if="job.phase === 'downloading' || job.phase === 'scanning'" class="link" @click="cancelDownload(job)">取消</button>
        <template v-else>
          <button v-if="job.phase === 'done'" class="link" @click="revealDownload(job)">在文件夹中显示</button>
          <button class="link muted" title="移除这条记录" @click="dismissDownload(job)">✕</button>
        </template>
      </div>
    </div>

    <!-- 右键菜单 -->
    <div v-if="menu" class="ctx-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @contextmenu.prevent>
      <template v-if="menu.target">
        <button class="ctx-item" @click="openEntry(menu!.target!); closeMenu()">{{ menu.target.dir ? '打开' : '快速查看' }}</button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="download(selectedEntries.length ? selectedEntries : [menu!.target!])">
          下载到本地{{ selectedEntries.length > 1 ? `（${selectedEntries.length} 项）` : '' }}…
        </button>
        <button class="ctx-item" @click="askFriday(selectedEntries.length ? selectedEntries : [menu!.target!])">让 Friday 看看</button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="copyText(selectedEntries.map((entry) => entry.path).join('\n') || menu!.target!.path, '路径')">
          复制路径
        </button>
        <button class="ctx-item" @click="copyText(selectedEntries.map((entry) => entry.name).join('\n') || menu!.target!.name, '名称')">
          复制名称
        </button>
      </template>
      <template v-else>
        <button v-if="canMkdir" class="ctx-item" @click="closeMenu(); startMkdir()">新建文件夹</button>
        <button class="ctx-item" :disabled="!canUpload" @click="pickUpload">上传文件到这里…</button>
        <button class="ctx-item" @click="download([{ name: baseName(currentPath) || 'folder', path: currentPath, dir: true }])">
          下载整个文件夹…
        </button>
        <button class="ctx-item" @click="copyText(currentPath, '路径')">复制当前路径</button>
        <div class="ctx-sep" />
        <div class="ctx-label">排序方式</div>
        <button v-for="key in (['name', 'modified', 'size', 'kind'] as const)" :key="key" class="ctx-item" @click="setSort(key); closeMenu()">
          <span class="check">{{ sortKey === key ? '✓' : '' }}</span>{{ { name: '名称', modified: '修改日期', size: '大小', kind: '种类' }[key] }}
        </button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="viewMode = viewMode === 'list' ? 'icons' : 'list'; closeMenu()">
          {{ viewMode === 'list' ? '以图标显示' : '以列表显示' }}
        </button>
        <button class="ctx-item" @click="showHidden = !showHidden; closeMenu()">{{ showHidden ? '隐藏隐藏项目' : '显示隐藏项目' }}</button>
        <button class="ctx-item" @click="refresh(); closeMenu()">刷新</button>
      </template>
    </div>

    <!-- 快速查看（空格 / 双击文件）：大图或文本，Esc / 空格关，方向键换下一个 -->
    <div v-if="quickLookOpen && focusEntry" class="quicklook" @click.self="quickLookOpen = false">
      <div class="ql-card">
        <div class="ql-head">
          <span class="file-icon small" :class="categoryOf(focusEntry)"><i v-if="badgeOf(focusEntry)">{{ badgeOf(focusEntry) }}</i></span>
          <span class="ql-name">{{ focusEntry.name }}</span>
          <span class="dim">{{ formatSize(focusEntry.size) }}</span>
          <span class="spacer" />
          <button class="link" @click="download([focusEntry])">下载</button>
          <button class="link" title="关闭（空格 / Esc）" @click="quickLookOpen = false">✕</button>
        </div>
        <div class="ql-body">
          <div v-if="!preview || preview.loading" class="insp-note">读取中…</div>
          <img v-else-if="preview.kind === 'image'" class="ql-image" :src="preview.imageURL" :alt="focusEntry.name" />
          <pre v-else-if="preview.kind === 'text'" class="ql-text">{{ preview.text }}</pre>
          <div v-else class="ql-none">
            <span class="file-icon huge" :class="categoryOf(focusEntry)"><i v-if="badgeOf(focusEntry)">{{ badgeOf(focusEntry) }}</i></span>
            <div>{{ preview.error || (preview.kind === 'binary' ? '二进制文件，没法预览内容' : '这种文件没法直接预览，下载到本地再打开') }}</div>
          </div>
          <div v-if="preview?.partial" class="insp-note">只显示了前一部分</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.finder {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 12.5px;
  outline: none;
  container-type: inline-size;
}

/* ---- 工具条 ---- */
.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
}

.nav-group,
.seg {
  display: flex;
  gap: 1px;
}

.seg {
  padding: 1px;
  border-radius: 7px;
  background: var(--chip);
}

.tool {
  width: 28px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--text-2);
  flex: none;
}

.tool svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.tool:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.tool.on {
  background: var(--panel);
  color: var(--accent);
}

.tool:disabled {
  opacity: 0.3;
  cursor: default;
}

.crumbs {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
}

.crumbs > .crumb-sep {
  flex: none;
}

/* 每级可以被压窄（省略号），最后一级最后才压 */
.crumbs > .crumb {
  flex: 0 1 auto;
  min-width: 24px;
}

.crumbs > .crumb.last {
  flex-shrink: 0.2;
}

.crumb {
  padding: 2px 5px;
  border-radius: 5px;
  color: var(--text-2);
  font-size: 12px;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumb:hover {
  background: var(--hover);
  color: var(--text);
}

.crumb.last {
  color: var(--text);
  font-weight: 600;
}

.crumb-sep {
  color: var(--text-3);
  padding: 0 1px;
}

.search {
  flex: 0 1 180px;
  min-width: 90px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  height: 26px;
  border-radius: 7px;
  background: var(--chip);
  color: var(--text-3);
}

.search svg {
  width: 13px;
  height: 13px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}

.search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent !important;
  font-size: 12px;
  outline: none;
  padding: 0;
}

/* ---- 主体：侧边栏 | 文件区 | 预览栏 ---- */
.main {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}

.sidebar {
  flex: none;
  width: 168px;
  overflow-y: auto;
  padding: 6px 6px 10px;
  border-right: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel-2) 60%, transparent);
}

.side-group {
  margin: 10px 8px 4px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-3);
}

.side-group:first-child {
  margin-top: 2px;
}

.side-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--text);
  text-align: left;
}

.side-item:hover {
  background: var(--hover);
}

.side-item.active {
  background: var(--selected);
}

.side-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-count {
  font-size: 10.5px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-foreground);
}

/* 侧边栏图标：线性小图标，颜色走强调色（访达侧边栏那种蓝色线条图标） */
.side-icon {
  width: 15px;
  height: 15px;
  flex: none;
  background-color: var(--accent);
  -webkit-mask: var(--icon) center / contain no-repeat;
  mask: var(--icon) center / contain no-repeat;
}

.side-icon.home { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'%3E%3Cpath d='M2.5 7.5 8 3l5.5 4.5V13H9.8V9.8H6.2V13H2.5z'/%3E%3C/svg%3E"); }
.side-icon.work { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'%3E%3Crect x='2' y='4.5' width='12' height='8.5' rx='1.5'/%3E%3Cpath d='M5.8 4.5V3.2h4.4v1.3M2 8.3h12'/%3E%3C/svg%3E"); }
.side-icon.desktop { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'%3E%3Crect x='2' y='3' width='12' height='8' rx='1.2'/%3E%3Cpath d='M6 13.5h4M8 11v2.5'/%3E%3C/svg%3E"); }
.side-icon.doc { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'%3E%3Cpath d='M4 2h5.5L12.5 5v9H4z'/%3E%3Cpath d='M9.3 2v3.2h3.2M6 8.2h4.5M6 10.7h4.5'/%3E%3C/svg%3E"); }
.side-icon.download { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='8' cy='8' r='6'/%3E%3Cpath d='M8 4.8v6M5.6 8.6 8 11l2.4-2.4'/%3E%3C/svg%3E"); }
.side-icon.disk { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'%3E%3Crect x='2' y='4.5' width='12' height='7' rx='1.5'/%3E%3Ccircle cx='11.2' cy='8' r='.7' fill='black'/%3E%3C/svg%3E"); }
.side-icon.folder { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'%3E%3Cpath d='M1.8 4.2c0-.6.4-1 1-1h3l1.4 1.5h5.9c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z'/%3E%3C/svg%3E"); }
.side-icon.chg { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 2h5.5L12.5 5v9H4z'/%3E%3Cpath d='M8.2 7v4M6.2 9h4'/%3E%3C/svg%3E"); }

.content {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.error {
  flex: none;
  padding: 6px 10px;
  color: var(--fail);
  background: color-mix(in srgb, var(--fail) 8%, transparent);
  font-size: 11.5px;
  line-height: 1.5;
}

/* ---- 文件图标：一张「纸」或一个文件夹，按种类着色，右下角扩展名小签 ---- */
.file-icon {
  position: relative;
  flex: none;
  display: inline-block;
  --c: var(--text-3);
}

.file-icon.small { width: 16px; height: 18px; }
.file-icon.big { width: 46px; height: 54px; }
.file-icon.huge { width: 64px; height: 76px; }

.file-icon::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 2px 22% 2px 2px / 2px 18% 2px 2px;
  background: linear-gradient(160deg, color-mix(in srgb, var(--c) 28%, var(--panel)), color-mix(in srgb, var(--c) 14%, var(--panel)));
  border: 1px solid color-mix(in srgb, var(--c) 55%, transparent);
}

/* 折角 */
.file-icon::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 30%;
  height: 25%;
  background: linear-gradient(225deg, transparent 50%, color-mix(in srgb, var(--c) 45%, var(--panel)) 50%);
  border-bottom-left-radius: 2px;
}

.file-icon i {
  position: absolute;
  left: 50%;
  bottom: 14%;
  transform: translateX(-50%);
  padding: 0 3px;
  border-radius: 2px;
  background: var(--c);
  color: #fff;
  font-style: normal;
  font-weight: 700;
  font-size: 9px;
  line-height: 13px;
  letter-spacing: 0.3px;
  white-space: nowrap;
}

.file-icon.small i { display: none; }
.file-icon.huge i { font-size: 11px; line-height: 15px; }

/* 文件夹：圆角夹子 + 标签页 */
.file-icon.folder { --c: var(--accent); }
.file-icon.folder.small { width: 18px; height: 15px; }
.file-icon.folder.big { width: 56px; height: 46px; }
.file-icon.folder.huge { width: 76px; height: 62px; }

.file-icon.folder::before {
  top: 14%;
  border-radius: 3px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--c) 70%, #fff 10%), color-mix(in srgb, var(--c) 55%, transparent));
  border-color: color-mix(in srgb, var(--c) 80%, transparent);
}

.file-icon.folder::after {
  top: 0;
  left: 0;
  right: auto;
  width: 42%;
  height: 26%;
  border-radius: 3px 3px 0 0;
  background: color-mix(in srgb, var(--c) 60%, transparent);
}

.file-icon.multi { --c: var(--accent); }
.file-icon.multi::after { display: none; }
.file-icon.multi::before { box-shadow: 5px -5px 0 -1px color-mix(in srgb, var(--c) 30%, transparent), 10px -10px 0 -2px color-mix(in srgb, var(--c) 18%, transparent); }

.file-icon.image { --c: var(--ok); }
.file-icon.video { --c: #a855f7; }
.file-icon.audio { --c: #ec4899; }
.file-icon.code { --c: var(--run); }
.file-icon.text { --c: var(--text-2); }
.file-icon.archive { --c: var(--warn); }
.file-icon.pdf { --c: var(--fail); }
.file-icon.doc { --c: #3b82f6; }
.file-icon.app { --c: #64748b; }

/* ---- 列表视图 ---- */
.list {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.list-head,
.row {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) 128px 74px 104px;
  align-items: center;
  column-gap: 10px;
  padding: 0 12px;
}

.list-head {
  flex: none;
  height: 26px;
  border-bottom: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--text-2);
}

.list-head .col {
  text-align: left;
  padding: 0;
  height: 100%;
  color: inherit;
}

.list-head .col:hover {
  color: var(--text);
}

.list-head .size,
.row .size {
  text-align: right;
}

.sort {
  margin-left: 4px;
  font-size: 8px;
  color: var(--accent);
}

.list-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 4px 8px;
}

.row {
  height: 26px;
  border-radius: 6px;
  cursor: default;
  user-select: none;
}

/* 斑马纹（访达列表的交替底色） */
.row:nth-child(even of .row:not(.mkdir-row)) {
  background: color-mix(in srgb, var(--text) 3%, transparent);
}

.row:hover {
  background: var(--hover);
}

.row.selected,
.row.selected:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}

.row.selected .col.date,
.row.selected .col.size,
.row.selected .col.kind {
  color: color-mix(in srgb, var(--accent-foreground) 80%, transparent);
}

.row .col {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row .col.name {
  display: flex;
  align-items: center;
  gap: 7px;
}

.file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row .col.date,
.row .col.size,
.row .col.kind {
  color: var(--text-2);
  font-size: 11.5px;
}

.mkdir-row {
  display: flex;
  gap: 10px;
}

.mkdir-input {
  flex: 1;
  min-width: 0;
  height: 21px;
  padding: 0 6px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--panel);
  font-size: 12px;
  outline: none;
}

.mkdir-error {
  color: var(--fail);
  font-size: 11px;
}

.empty {
  padding: 40px 12px;
  text-align: center;
  color: var(--text-3);
  grid-column: 1 / -1;
}

/* ---- 图标视图 ---- */
.icon-grid {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, 92px);
  grid-auto-rows: max-content;
  gap: 8px;
  align-content: start;
}

.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 8px 4px 6px;
  border-radius: 8px;
  cursor: default;
  user-select: none;
}

.tile:hover {
  background: var(--hover);
}

.tile .file-icon,
.tile .thumb {
  height: 56px;
  display: grid;
  place-items: end center;
}

.tile .thumb {
  width: 64px;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.tile-name {
  max-width: 100%;
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 11.5px;
  line-height: 1.35;
  text-align: center;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tile.selected {
  background: var(--selected);
}

.tile.selected .tile-name {
  background: var(--accent);
  color: var(--accent-foreground);
}

.mkdir-tile .mkdir-input {
  width: 88px;
  flex: none;
  text-align: center;
}

/* ---- 预览栏 ---- */
.inspector {
  flex: none;
  width: 236px;
  overflow-y: auto;
  padding: 14px 12px;
  border-left: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel-2) 50%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.insp-hero {
  display: grid;
  place-items: center;
  min-height: 96px;
}

.insp-image {
  max-width: 100%;
  max-height: 200px;
  border-radius: 6px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
}

.insp-title {
  font-size: 13.5px;
  font-weight: 600;
  text-align: center;
  word-break: break-all;
}

.insp-sub {
  font-size: 11.5px;
  color: var(--text-2);
  text-align: center;
}

.insp-path {
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
}

.insp-info {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
  margin: 4px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  font-size: 11.5px;
}

.insp-info dt {
  color: var(--text-3);
}

.insp-info dd {
  margin: 0;
  color: var(--text-2);
  word-break: break-all;
}

.mono {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 10.5px;
}

.insp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.act {
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--text);
  background: var(--panel);
}

.act:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.act:disabled {
  opacity: 0.4;
  cursor: default;
}

.insp-text,
.diff {
  margin: 0;
  max-height: none;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  border-radius: 6px;
}

.insp-note,
.insp-empty {
  font-size: 11.5px;
  color: var(--text-3);
}

.insp-empty {
  margin: auto;
}

.diff code {
  background: none;
  padding: 0;
}

.diff-line {
  display: block;
}

.diff-line.add {
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  color: var(--ok);
}

.diff-line.del {
  background: color-mix(in srgb, var(--fail) 12%, transparent);
  color: var(--fail);
}

/* ---- 会话改动列表 ---- */
.changes {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 6px 10px;
}

.changes-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 8px;
  color: var(--text-2);
  font-size: 12px;
}

.change-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.change-row:hover {
  background: var(--hover);
}

.change-row.selected {
  background: var(--selected);
}

.change-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.badge {
  flex: none;
  width: 16px;
  height: 16px;
  padding: 0;
  display: inline-grid;
  place-items: center;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
}

.badge.A { color: var(--ok); border-color: var(--ok); }
.badge.M { color: var(--warn); border-color: var(--warn); }
.badge.D { color: var(--fail); border-color: var(--fail); }

.stat {
  font-size: 11px;
  white-space: nowrap;
}

.stat .add { color: var(--ok); }
.stat .del { color: var(--fail); }
.muted { color: var(--text-3); }
.dim { color: var(--text-3); }
.warn { color: var(--warn); }

.spacer {
  flex: 1 1 auto;
}

.link {
  color: var(--accent);
  font-size: 11.5px;
  padding: 1px 4px;
  border-radius: 4px;
  white-space: nowrap;
}

.link:hover {
  background: var(--hover);
}

.link.danger {
  color: var(--fail);
}

.link.muted {
  color: var(--text-3);
}

.link.small {
  font-size: 11px;
}

.confirm-inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--fail);
  font-size: 11.5px;
}

/* ---- 状态栏 / 下载列表 ---- */
.statusbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-top: 1px solid var(--line);
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
}

.notice {
  color: var(--ok);
}

.downloads {
  flex: none;
  border-top: 1px solid var(--line);
  padding: 4px 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--panel-2);
}

.dl {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dl-icon {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--accent-a15);
  color: var(--accent);
  font-size: 12px;
  flex: none;
}

.dl.failed .dl-icon {
  background: color-mix(in srgb, var(--fail) 15%, transparent);
  color: var(--fail);
}

.dl.done .dl-icon {
  background: color-mix(in srgb, var(--ok) 15%, transparent);
  color: var(--ok);
}

.dl-main {
  flex: 1;
  min-width: 0;
}

.dl-title {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-bar {
  height: 3px;
  margin: 3px 0 2px;
  border-radius: 2px;
  background: var(--chip);
  overflow: hidden;
}

.dl-bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.25s ease;
}

.dl-text {
  font-size: 10.5px;
  color: var(--text-3);
}

.dl.failed .dl-text {
  color: var(--fail);
}

/* ---- 拖放上传 ---- */
.content {
  position: relative;
}

.drop-overlay {
  position: absolute;
  inset: 6px;
  z-index: 10;
  display: grid;
  place-items: end center;
  padding-bottom: 18px;
  border: 2px dashed var(--accent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  pointer-events: none;
}

/* 拖到文件夹上时整片提示退淡，让被高亮的那一行当主角 */
.drop-overlay.into {
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  background: transparent;
}

.drop-overlay.blocked {
  border-color: var(--text-3);
  background: color-mix(in srgb, var(--text-3) 6%, transparent);
}

.drop-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-foreground);
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}

.drop-overlay.blocked .drop-card {
  background: var(--panel);
  color: var(--text-2);
}

.drop-card svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.row.drop-into,
.tile.drop-into {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}

.dl.up .dl-icon {
  transform: none;
}

.ctx-item:disabled {
  opacity: 0.4;
  pointer-events: none;
}

/* ---- 右键菜单 ---- */
.ctx-menu {
  position: absolute;
  z-index: 20;
  min-width: 190px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  -webkit-backdrop-filter: blur(18px) saturate(1.3);
  backdrop-filter: blur(18px) saturate(1.3);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}

.ctx-item {
  width: 100%;
  display: flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 5px;
  text-align: left;
  font-size: 12px;
  color: var(--text);
}

.ctx-item:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}

.ctx-item .check {
  width: 16px;
  flex: none;
}

.ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}

.ctx-label {
  padding: 2px 10px;
  font-size: 10.5px;
  color: var(--text-3);
}

/* ---- 快速查看 ---- */
.quicklook {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(0, 0, 0, 0.35);
}

.ql-card {
  width: 100%;
  height: 100%;
  max-width: 900px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  animation: ql-pop 0.16s ease-out;
}

@keyframes ql-pop {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
}

.ql-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}

.ql-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ql-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 12px;
}

.ql-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.ql-text {
  align-self: stretch;
  flex: 1;
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
}

.ql-none {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-2);
}

/* ---- 窄窗口：先收预览栏，再收侧边栏、收列表的种类/日期列 ---- */
@container (max-width: 720px) {
  .inspector {
    display: none;
  }
}

@container (max-width: 560px) {
  .sidebar {
    display: none;
  }

  .list-head,
  .row {
    grid-template-columns: minmax(120px, 1fr) 70px;
  }

  .list-head .date,
  .list-head .kind,
  .row .col.date,
  .row .col.kind {
    display: none;
  }

  .search {
    flex-basis: 110px;
  }
}

/* ---- 贾维斯：HUD 字体的表头 / 分组、青色选中条、发光的文件夹 ---- */
[data-theme='jarvis'] .toolbar {
  background: var(--accent-a4);
}

[data-theme='jarvis'] .side-group,
[data-theme='jarvis'] .list-head {
  font-family: var(--font-hud);
  letter-spacing: 1.5px;
  text-transform: uppercase;
}

[data-theme='jarvis'] .side-group {
  color: var(--accent-a60);
}

[data-theme='jarvis'] .sidebar,
[data-theme='jarvis'] .inspector {
  background: var(--accent-a3);
}

[data-theme='jarvis'] .side-item.active {
  background: var(--accent-a12);
  box-shadow: inset 2px 0 0 var(--accent);
}

[data-theme='jarvis'] .row.selected,
[data-theme='jarvis'] .row.selected:hover {
  background: var(--accent-a22);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--accent);
}

[data-theme='jarvis'] .row.selected .col.date,
[data-theme='jarvis'] .row.selected .col.size,
[data-theme='jarvis'] .row.selected .col.kind {
  color: var(--text-2);
}

[data-theme='jarvis'] .tile.selected {
  background: var(--accent-a12);
  box-shadow: inset 0 0 0 1px var(--accent-a45);
}

[data-theme='jarvis'] .tile.selected .tile-name {
  background: var(--accent-a35);
  color: var(--text);
}

[data-theme='jarvis'] .file-icon.folder::before {
  box-shadow: 0 0 10px var(--accent-a35);
}

[data-theme='jarvis'] .file-icon i {
  color: #04121a;
}

[data-theme='jarvis'] .crumb.last,
[data-theme='jarvis'] .insp-title {
  color: var(--accent);
  text-shadow: 0 0 8px var(--accent-a40);
}

[data-theme='jarvis'] .ctx-menu,
[data-theme='jarvis'] .ql-card {
  background: var(--panel-card-deep-a92);
  border-color: var(--accent-a35);
  box-shadow:
    0 0 24px var(--accent-a12),
    0 14px 36px rgba(0, 0, 0, 0.6);
}

[data-theme='jarvis'] .ctx-item:hover {
  background: var(--accent-a22);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--accent);
}

[data-theme='jarvis'] .drop-overlay {
  box-shadow: inset 0 0 30px var(--accent-a15);
}

[data-theme='jarvis'] .drop-card {
  background: var(--accent-a22);
  color: var(--accent);
  border: 1px solid var(--accent-a60);
  font-family: var(--font-hud);
  letter-spacing: 1px;
  text-shadow: 0 0 8px var(--accent-a50);
  box-shadow: 0 0 18px var(--accent-a30);
}

[data-theme='jarvis'] .dl-bar i {
  box-shadow: 0 0 8px var(--accent-a60);
}
</style>
