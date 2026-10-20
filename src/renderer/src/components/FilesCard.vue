<script setup lang="ts">
// 文件卡片（M2，方案 §5.5 / FILES.md）：
// 目录树（fs.list 带 files:true）、预览（fs.read 分块，只读）、
// 本次会话改动（fs.changes / fs.diff / fs.revert，v2.31）。
// 协议没有客户端写文件的方法 —— 卡片只读；要改文件走「让 Friday 改」（预填一条消息）。
import { onMounted, ref, watch } from 'vue'
import type {
  FsChange,
  FsChangesResult,
  FsDiffResult,
  FsListResult,
  FsReadResult
} from '../../../protocol/rpc/protocol.js'
import { rpc } from '../lib/host.js'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()

const currentPath = ref('')
const parentPath = ref('')
const entries = ref<FsListResult['entries']>([])
const roots = ref<FsListResult['roots']>([])
const truncated = ref(false)
const loading = ref(false)
const error = ref('')

const preview = ref<{ path: string; name: string; text: string; size: number; eof: boolean; imageURL?: string } | null>(null)

/** 本次会话改动（fs.changes；2.31 之前的服务端不认识 → 不显示分组） */
const changes = ref<FsChange[]>([])
const changesAvailable = ref(true)
const changesOpen = ref(true)
const diff = ref<{ path: string; lines: DiffLine[]; status: string; binary: boolean; tooLarge: boolean } | null>(null)
const confirmingRevert = ref('')
interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

function formatSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function mimeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }
  return map[ext] ?? 'application/octet-stream'
}

async function list(path?: string): Promise<void> {
  if (!store.currentMachine) return
  loading.value = true
  error.value = ''
  try {
    const result = (await rpc(store.currentMachine, 'fs.list', { path, files: true })) as FsListResult
    currentPath.value = result.path
    parentPath.value = result.parent ?? ''
    entries.value = result.entries ?? []
    roots.value = result.roots ?? []
    truncated.value = !!result.truncated
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function b64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 预览：按 1 MB 分块拉（只读） */
async function openFile(entry: { path: string; name: string; size?: number; dir?: boolean }): Promise<void> {
  if (entry.dir) {
    await list(entry.path)
    return
  }
  if (!store.currentMachine) return
  store.activeFile = { path: entry.path, name: entry.name }
  error.value = ''
  diff.value = null
  const chunk = 1024 * 1024
  const parts: Uint8Array[] = []
  let offset = 0
  let size = 0
  let eof = false
  try {
    while (!eof && offset < 8 * chunk) {
      const result = (await rpc(store.currentMachine, 'fs.read', { path: entry.path, offset, length: chunk })) as FsReadResult
      const bytes = b64ToBytes(result.data)
      parts.push(bytes)
      offset += bytes.length
      size = result.size
      eof = result.eof
      if (bytes.length === 0) break
    }
  } catch (e) {
    error.value = `读不了这个文件：${e instanceof Error ? e.message : String(e)}`
    return
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const merged = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    merged.set(part, at)
    at += part.length
  }
  if (isImageMime(entry.path)) {
    const url = URL.createObjectURL(new Blob([merged], { type: mimeOf(entry.path) }))
    preview.value = { path: entry.path, name: entry.name, text: '', size, eof, imageURL: url }
  } else {
    // 有 NUL 字节当二进制
    const binary = merged.subarray(0, Math.min(merged.length, 8192)).includes(0)
    preview.value = {
      path: entry.path,
      name: entry.name,
      text: binary ? '' : new TextDecoder('utf-8', { fatal: false }).decode(merged),
      size,
      eof
    }
    if (binary) error.value = '这是二进制文件，只显示大小'
  }
}

function isImageMime(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path)
}

/** 本次会话改动（只读；经 WebSocket 连的机器不能用，回错误 4） */
async function loadChanges(): Promise<void> {
  const conversationID = store.detail?.conversationID
  if (!store.currentMachine || !conversationID) return
  try {
    const result = (await rpc(store.currentMachine, 'fs.changes', { conversationID })) as FsChangesResult
    changes.value = result.files ?? []
    changesAvailable.value = true
  } catch {
    // 2.31 之前的服务端 / WebSocket 连接：不显示改动分组
    changes.value = []
    changesAvailable.value = false
  }
}

/** 逐行对比（客户端做）：LCS，超过 4000 行退化为「只有新内容」 */
function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (a.length + b.length > 4000) {
    return b.map((text) => ({ kind: 'add' as const, text }))
  }
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
  while (i < n) {
    out.push({ kind: 'del', text: a[i]! })
    i += 1
  }
  while (j < m) {
    out.push({ kind: 'add', text: b[j]! })
    j += 1
  }
  return out
}

async function openDiff(change_: FsChange): Promise<void> {
  const conversationID = store.detail?.conversationID
  if (!store.currentMachine || !conversationID) return
  error.value = ''
  try {
    const result = (await rpc(store.currentMachine, 'fs.diff', { conversationID, path: change_.path })) as FsDiffResult
    diff.value = {
      path: result.path,
      status: result.status,
      binary: result.binary,
      tooLarge: result.tooLarge,
      lines: result.known && !result.binary && !result.tooLarge ? lineDiff(result.old, result.new) : []
    }
    preview.value = null
    store.activeFile = { path: result.path, name: result.path.split(/[\\/]/).pop() ?? result.path }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** 撤销会话改动（照 Friday 的做法：先弹红色确认） */
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
    preview.value = null
    await loadChanges()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** 「让 Friday 改」：预填一条消息到当前会话（方案 §5.5） */
function askFridayPath(): string {
  const target = diff.value?.path ?? preview.value?.path ?? ''
  if (!target) return ''
  return `请看看 ${target} 这个文件，`
}

function emitAskFridayRequest(): void {
  const text = askFridayPath()
  if (!text) return
  window.dispatchEvent(new CustomEvent('friday-prefill', { detail: text }))
}

onMounted(async () => {
  await list()
  await loadChanges()
})

watch(() => store.detail?.conversationID, () => void loadChanges())
</script>

<template>
  <div class="files-card">
    <div class="toolbar">
      <button class="crumb" title="主目录" @click="list()">⌂</button>
      <button class="crumb" :disabled="!parentPath" title="上一级" @click="list(parentPath)">↑</button>
      <span class="path" :title="currentPath">{{ currentPath }}</span>
      <button class="crumb" title="刷新" @click="list(currentPath)">⟳</button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <!-- 本次会话改动（方案 §5.5 / FILES.md §5） -->
    <div v-if="changesAvailable && changes.length" class="changes">
      <div class="changes-head" @click="changesOpen = !changesOpen">
        <span class="caret">{{ changesOpen ? '▾' : '▸' }}</span>
        本次会话改动 <span class="count">{{ changes.length }}</span>
        <span class="spacer" />
        <button
          v-if="confirmingRevert !== 'all'"
          class="link danger"
          @click.stop="confirmingRevert = 'all'"
        >
          撤销全部
        </button>
        <span v-else class="confirm-inline">
          确定撤销全部改动？
          <button class="link danger" @click.stop="doRevert()">确定</button>
          <button class="link" @click.stop="confirmingRevert = ''">取消</button>
        </span>
      </div>
      <template v-if="changesOpen">
        <div v-for="item in changes" :key="item.path" class="change-row">
          <span class="badge" :class="item.status">{{ item.status }}</span>
          <span class="change-path" :title="item.path" @click="openDiff(item)">{{ item.path }}</span>
          <span v-if="item.known" class="stat"><span class="add">+{{ item.added }}</span> <span class="del">−{{ item.removed }}</span></span>
          <span v-else class="stat muted">改动未知</span>
          <button class="link rev" title="撤销这个文件的改动" @click.stop="confirmingRevert === item.path ? doRevert(item.path) : (confirmingRevert = item.path)">
            {{ confirmingRevert === item.path ? '确定？' : '↺' }}
          </button>
        </div>
      </template>
    </div>

    <div class="body">
      <div class="tree">
        <div v-for="root in roots" :key="root.path" class="entry root" @click="list(root.path)">
          <span class="icon">⌂</span>{{ root.name }}
        </div>
        <div v-if="parentPath" class="entry dir" @click="list(parentPath)">
          <span class="icon">↰</span>..
        </div>
        <div
          v-for="entry in entries"
          :key="entry.path"
          class="entry"
          :class="{ dir: entry.dir, file: !entry.dir, active: store.activeFile?.path === entry.path }"
          :title="entry.path"
          @click="openFile(entry)"
        >
          <span class="icon">{{ entry.dir ? '▸' : '·' }}</span>
          <span class="name">{{ entry.name }}</span>
          <span class="size">{{ entry.dir ? '' : formatSize(entry.size) }}</span>
        </div>
        <div v-if="truncated" class="truncated">（这个目录文件太多，只列了前一部分）</div>
        <div v-if="loading" class="truncated">读取中…</div>
      </div>

      <div v-if="diff" class="preview">
        <div class="preview-head">
          <span class="badge" :class="diff.status">{{ diff.status }}</span>
          <span class="preview-name" :title="diff.path">{{ diff.path }}</span>
          <button class="link" title="在当前会话里让 Friday 改这个文件" @click="emitAskFridayRequest">让 Friday 改</button>
        </div>
        <div v-if="diff.binary" class="preview-note">二进制文件，不做逐行对比</div>
        <div v-else-if="diff.tooLarge" class="preview-note">文件太大（超过 1 MB），不做逐行对比</div>
        <div v-else-if="!diff.lines.length" class="preview-note">没有可显示的内容</div>
        <pre v-else class="diff"><code><span
          v-for="(line, index) in diff.lines"
          :key="index"
          class="diff-line"
          :class="line.kind"
        >{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ' }} {{ line.text }}
</span></code></pre>
      </div>

      <div v-else-if="preview" class="preview">
        <div class="preview-head">
          <span class="preview-name" :title="preview.path">{{ preview.name }}</span>
          <span class="stat muted">{{ formatSize(preview.size) }}</span>
          <button class="link" title="在当前会话里让 Friday 改这个文件" @click="emitAskFridayRequest">让 Friday 改</button>
        </div>
        <img v-if="preview.imageURL" class="preview-image" :src="preview.imageURL" :alt="preview.name" />
        <pre v-else class="text"><code>{{ preview.text }}</code></pre>
        <div v-if="!preview.eof" class="preview-note">只显示了前一部分（大文件分块拉取）</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.files-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 12.5px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
  flex: 0 0 auto;
}

.crumb {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
  border-radius: 4px;
}

.crumb:hover:not(:disabled) {
  background: var(--hover);
  color: var(--fg);
}

.crumb:disabled {
  opacity: 0.3;
}

.path {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  color: var(--muted);
  font-size: 11.5px;
}

.error {
  padding: 6px 10px;
  color: #d0574a;
  background: rgba(208, 87, 74, 0.08);
  font-size: 11.5px;
  line-height: 1.5;
}

.changes {
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
  max-height: 40%;
  overflow-y: auto;
}

.changes-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  color: var(--muted);
  font-size: 11.5px;
  position: sticky;
  top: 0;
  background: var(--panel);
}

.count {
  background: var(--chip);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 10.5px;
}

.spacer {
  flex: 1 1 auto;
}

.change-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  line-height: 1.5;
}

.change-row:hover {
  background: var(--hover);
}

.change-path {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  cursor: pointer;
}

.badge {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--chip);
  color: var(--muted);
  flex: 0 0 auto;
}

.badge.A {
  background: rgba(60, 160, 100, 0.15);
  color: #2f8f5b;
}

.badge.M {
  background: rgba(190, 140, 40, 0.15);
  color: #a87716;
}

.badge.D {
  background: rgba(200, 80, 70, 0.15);
  color: #b8443a;
}

.stat {
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.stat .add {
  color: #2f8f5b;
}

.stat .del {
  color: #b8443a;
}

.muted {
  color: var(--muted);
}

.link {
  border: none;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 4px;
  white-space: nowrap;
}

.link:hover {
  background: var(--hover);
}

.link.danger {
  color: #c0473c;
}

.confirm-inline {
  font-size: 11px;
  color: #c0473c;
}

.body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.tree {
  flex: 0 1 auto;
  overflow-y: auto;
  min-height: 90px;
  max-height: 45%;
  padding: 4px 0;
}

.entry {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  cursor: pointer;
  line-height: 1.6;
}

.entry:hover {
  background: var(--hover);
}

.entry.active {
  background: var(--selected);
}

.entry.dir .name {
  font-weight: 500;
}

.entry .icon {
  color: var(--muted);
  width: 10px;
  flex: 0 0 auto;
}

.entry.root {
  color: var(--muted);
}

.name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.size {
  color: var(--muted);
  font-size: 10.5px;
  flex: 0 0 auto;
}

.truncated {
  padding: 4px 10px;
  color: var(--muted);
  font-size: 11px;
}

.preview {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--line);
}

.preview-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
}

.preview-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.preview-note {
  padding: 8px 10px;
  color: var(--muted);
  font-size: 11.5px;
}

.preview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  padding: 8px;
}

.text,
.diff {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre;
}

.text code,
.diff code {
  font-family: inherit;
}

.diff-line {
  display: block;
}

.diff-line.add {
  background: rgba(60, 160, 100, 0.12);
  color: #2c7f52;
}

.diff-line.del {
  background: rgba(200, 80, 70, 0.12);
  color: #a83d34;
}
/* 贾维斯界面：文件窗变档案终端——工具条、路径、目录行、diff 都青色化（半透明，背景透出来） */
[data-theme='jarvis'] .toolbar {
  background: rgba(10, 25, 45, 0.28);
  border-bottom-color: rgba(34, 211, 238, 0.2);
  font-family: var(--font-hud);
}

[data-theme='jarvis'] .path {
  color: #7dd3fc;
}

[data-theme='jarvis'] .crumb:hover:not(:disabled) {
  background: rgba(34, 211, 238, 0.1);
}

[data-theme='jarvis'] .entry.active {
  background: rgba(34, 211, 238, 0.1);
  box-shadow: inset 2px 0 0 0 var(--accent);
}

[data-theme='jarvis'] .entry:hover {
  background: rgba(34, 211, 238, 0.06);
}

[data-theme='jarvis'] .size,
[data-theme='jarvis'] .changes-head,
[data-theme='jarvis'] .change-path {
  font-family: var(--font-hud);
}

[data-theme='jarvis'] .changes-head {
  letter-spacing: 1px;
}

[data-theme='jarvis'] .diff {
  /* diff 是文本对照区，保留较高不透明度保可读性，但不再是实底 */
  background: rgba(7, 20, 36, 0.6);
}
</style>
