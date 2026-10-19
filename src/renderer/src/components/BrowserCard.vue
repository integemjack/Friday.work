<script setup lang="ts">
// 浏览器卡片（M2，方案 §5.6 / BROWSER.md §9）：
// 画面是远端的浏览器截图（browser.watch → browser.frame，变了才推、积压丢帧只要最新）；
// 卡片里捕获的鼠标键盘按 browser.input 编码转发 —— 用户在动，智能体让开（人机共驾）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { BrowserTab } from '../../../protocol/rpc/protocol.js'
import { rpc } from '../lib/host.js'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()
const canvas = ref<HTMLDivElement | null>(null)
const watchedTab = ref('')
const addressText = ref('')
const editingAddress = ref(false)

// Qt::KeyboardModifier 数值（REMOTE.md §6 browser.input 的 modifiers）
const QT_SHIFT = 0x02000000
const QT_CONTROL = 0x04000000
const QT_ALT = 0x08000000
const QT_META = 0x10000000

const tab = computed<BrowserTab | undefined>(() => {
  const inConversation = store.browserTabs.find((item) => item.conversationID === store.detail?.conversationID)
  return inConversation ?? store.browserTabs[0]
})

const frame = computed(() => (store.browserFrame && store.browserFrame.tab === watchedTab.value ? store.browserFrame : null))

function qtModifiers(event: MouseEvent | KeyboardEvent | WheelEvent): number {
  let value = 0
  if (event.shiftKey) value |= QT_SHIFT
  if (event.ctrlKey) value |= QT_CONTROL
  if (event.altKey) value |= QT_ALT
  if (event.metaKey) value |= QT_META
  return value
}

function send(kind: string, payload: Record<string, unknown>): void {
  if (!store.currentMachine || !watchedTab.value) return
  void rpc(store.currentMachine, 'browser.input', { tab: watchedTab.value, kind, ...payload }).catch(() => {})
}

/** 屏幕坐标 → 视口坐标（画面被缩放显示时要换算） */
function toViewport(event: MouseEvent): { x: number; y: number } {
  const element = canvas.value
  const viewport = frame.value?.viewport ?? tab.value?.viewport ?? [1280, 800]
  if (!element) return { x: 0, y: 0 }
  const rect = element.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * viewport[0]
  const y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * viewport[1]
  return { x: Math.round(x), y: Math.round(y) }
}

function isKeyboardTarget(target: EventTarget | null): boolean {
  // 地址栏输入时不把键转给网页
  return !(target instanceof HTMLElement && target.closest('.address-input'))
}

function onMouseDown(event: MouseEvent): void {
  if (!canvas.value) return
  canvas.value.focus()
  const { x, y } = toViewport(event)
  const button = event.button === 0 ? 'left' : event.button === 1 ? 'middle' : 'right'
  send('mouse', { type: 'press', x, y, button, clicks: event.detail || 1, modifiers: qtModifiers(event) })
}

function onMouseUp(event: MouseEvent): void {
  const { x, y } = toViewport(event)
  const button = event.button === 0 ? 'left' : event.button === 1 ? 'middle' : 'right'
  send('mouse', { type: 'release', x, y, button, clicks: event.detail || 1, modifiers: qtModifiers(event) })
}

function onMouseMove(event: MouseEvent): void {
  const { x, y } = toViewport(event)
  send('mouse', { type: 'move', x, y, button: 'none', modifiers: qtModifiers(event) })
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const { x, y } = toViewport(event)
  send('wheel', { x, y, dx: event.deltaX, dy: event.deltaY, modifiers: qtModifiers(event) })
}

function onKeyDown(event: KeyboardEvent): void {
  if (!isKeyboardTarget(event.target)) return
  // 大部分由 input/componsition 处理的文字键不重复发（可打印字符走 text）
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
  if (printable) return
  event.preventDefault()
  send('key', { press: true, key: event.key, code: event.code, modifiers: qtModifiers(event) })
}

function onKeyUp(event: KeyboardEvent): void {
  if (!isKeyboardTarget(event.target)) return
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
  if (printable) return
  send('key', { press: false, key: event.key, code: event.code, modifiers: qtModifiers(event) })
}

/** 输入法提交 / 粘贴的文字 */
function onCompositionEnd(event: CompositionEvent): void {
  if (!event.data) return
  send('text', { text: event.data })
}
function onPaste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text')
  if (!text) return
  event.preventDefault()
  send('text', { text })
}

async function watchTab(tabID: string): Promise<void> {
  if (!store.currentMachine || !tabID) return
  const width = Math.round(canvas.value?.clientWidth || 1280)
  const height = Math.round(canvas.value?.clientHeight || 800)
  try {
    await rpc(store.currentMachine, 'browser.watch', { tab: tabID, width, height })
    watchedTab.value = tabID
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  }
}

async function openTab(): Promise<void> {
  if (!store.currentMachine || !store.detail) return
  try {
    const result = (await rpc(store.currentMachine, 'browser.open', { conversationID: store.detail.conversationID })) as { tab: string }
    await watchTab(result.tab)
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  }
}

async function navigate(action: 'back' | 'forward' | 'reload'): Promise<void> {
  if (!store.currentMachine || !tab.value) return
  await rpc(store.currentMachine, 'browser.navigate', { tab: tab.value.id, action }).catch(() => {})
}

async function goAddress(): Promise<void> {
  if (!store.currentMachine || !tab.value) return
  editingAddress.value = false
  const text = addressText.value.trim()
  if (!text) return
  // 客户端按自己的搜索引擎拼好（REMOTE.md §6）
  const url = /^[a-z]+:\/\//i.test(text) ? text : text.includes('.') && !text.includes(' ') ? `https://${text}` : `https://www.bing.com/search?q=${encodeURIComponent(text)}`
  await rpc(store.currentMachine, 'browser.navigate', { tab: tab.value.id, url }).catch(() => {})
}

async function selectTab(tabID: string): Promise<void> {
  if (!store.currentMachine) return
  await rpc(store.currentMachine, 'browser.select', { tab: tabID }).catch(() => {})
  await watchTab(tabID)
}

async function closeTab(tabID: string): Promise<void> {
  if (!store.currentMachine) return
  await rpc(store.currentMachine, 'browser.close', { tab: tabID }).catch(() => {})
  if (watchedTab.value === tabID) watchedTab.value = ''
}

async function answerDialog(accept: boolean): Promise<void> {
  if (!store.currentMachine || !tab.value) return
  await rpc(store.currentMachine, 'browser.dialog', {
    tab: tab.value.id,
    accept,
    ...(tab.value.dialog?.defaultText ? { text: tab.value.dialog.defaultText } : {})
  }).catch(() => {})
}

async function handOverDone(): Promise<void> {
  if (!store.currentMachine || !tab.value) return
  await rpc(store.currentMachine, 'browser.handOverDone', { tab: tab.value.id }).catch(() => {})
}

let observer: ResizeObserver | null = null

onMounted(() => {
  if (tab.value) void watchTab(tab.value.id)
  if (canvas.value) {
    observer = new ResizeObserver(() => {
      if (!store.currentMachine || !watchedTab.value) return
      void rpc(store.currentMachine, 'browser.container', {
        tab: watchedTab.value,
        width: Math.round(canvas.value?.clientWidth || 1280),
        height: Math.round(canvas.value?.clientHeight || 800)
      }).catch(() => {})
    })
    observer.observe(canvas.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (store.currentMachine && watchedTab.value) {
    void rpc(store.currentMachine, 'browser.unwatch', { tab: watchedTab.value }).catch(() => {})
  }
})

watch(
  () => tab.value?.id,
  (id) => {
    // 浏览器窗口一开就盯着当前标签（窗口可见，直接 watch）
    if (id && id !== watchedTab.value) void watchTab(id)
  },
  { immediate: true }
)

watch(
  () => tab.value?.url,
  (url) => {
    if (url && !editingAddress.value) addressText.value = url
  },
  { immediate: true }
)
</script>

<template>
  <div class="browser-card">
    <div v-if="!store.browserAvailable && store.browserReason" class="notice">
      这台机器上的浏览器只有 SSH / WSL 连接可以用（{{ store.browserReason }}）
    </div>
    <template v-else>
      <div class="tabs">
        <button
          v-for="item in store.browserTabs"
          :key="item.id"
          class="tab"
          :class="{ active: item.id === tab?.id }"
          :title="item.url"
          @click="selectTab(item.id)"
        >
          <span v-if="item.loading" class="spinner" />
          <span class="tab-title">{{ item.title || item.url || '新标签' }}</span>
          <span class="tab-close" @click.stop="closeTab(item.id)">×</span>
        </button>
        <button class="tab add" title="新开一个标签" @click="openTab">＋</button>
      </div>

      <div class="navbar">
        <button class="nav" title="后退" @click="navigate('back')">‹</button>
        <button class="nav" title="前进" @click="navigate('forward')">›</button>
        <button class="nav" title="刷新" @click="navigate('reload')">⟳</button>
        <input
          v-model="addressText"
          class="address-input"
          spellcheck="false"
          placeholder="输入网址或搜索词"
          @focus="editingAddress = true"
          @blur="editingAddress = false"
          @keydown.enter="goAddress"
        />
        <span v-if="tab?.fixed" class="fixed-badge" title="智能体定了固定视口">固定视口</span>
      </div>

      <div
        ref="canvas"
        class="screen"
        :class="{ 'hand-over': !!tab?.handOver }"
        tabindex="0"
        @mousedown="onMouseDown"
        @mouseup="onMouseUp"
        @mousemove="onMouseMove"
        @wheel.prevent="onWheel"
        @keydown="onKeyDown"
        @keyup="onKeyUp"
        @compositionend="onCompositionEnd"
        @paste="onPaste"
      >
        <img v-if="frame" class="frame" :src="`data:image/jpeg;base64,${frame.data}`" alt="远程浏览器画面" draggable="false" />
        <div v-else class="waiting">
          {{ tab ? '正在取画面…' : '这段会话还没有浏览器标签' }}
        </div>
      </div>

      <div v-if="tab?.handOver" class="hand-over-bar">
        <span>Friday 请你在这个页面里操作：{{ tab.handOver.reason }}</span>
        <button class="primary" @click="handOverDone">好了</button>
      </div>

      <div v-if="tab?.dialog" class="dialog-bar">
        <span class="dialog-message">{{ tab.dialog.message }}</span>
        <input v-if="tab.dialog.defaultText" v-model="tab.dialog.defaultText" class="dialog-input" />
        <button class="link" @click="answerDialog(true)">确定</button>
        <button class="link" @click="answerDialog(false)">取消</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.browser-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.notice {
  padding: 16px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.7;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
  flex: 0 0 auto;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
  max-width: 180px;
}

.tab:hover {
  background: var(--hover);
}

.tab.active {
  background: var(--selected);
  color: var(--fg);
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-close {
  opacity: 0.5;
}

.tab-close:hover {
  opacity: 1;
  color: #c0473c;
}

.tab.add {
  font-size: 14px;
}

.spinner {
  width: 7px;
  height: 7px;
  border: 1.5px solid var(--muted);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.navbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
}

.nav {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  cursor: pointer;
  padding: 1px 5px;
  border-radius: 4px;
}

.nav:hover {
  background: var(--hover);
  color: var(--fg);
}

.address-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--fg);
  font-size: 11.5px;
  padding: 3px 8px;
  outline: none;
}

.address-input:focus {
  border-color: var(--accent);
}

.fixed-badge {
  font-size: 10px;
  color: var(--muted);
  background: var(--chip);
  border-radius: 4px;
  padding: 1px 5px;
  flex: 0 0 auto;
}

.screen {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1a1b20;
  overflow: hidden;
  outline: none;
  cursor: default;
}

.screen.hand-over {
  box-shadow: inset 0 0 0 2px #d08a2a;
}

.frame {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  user-select: none;
  pointer-events: none;
}

.waiting {
  color: #7a8090;
  font-size: 12px;
}

.hand-over-bar,
.dialog-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 11.5px;
  flex: 0 0 auto;
}

.hand-over-bar {
  background: rgba(208, 138, 42, 0.12);
  color: #9a6a1c;
}

.dialog-bar {
  background: rgba(60, 120, 200, 0.1);
  color: var(--fg);
}

.dialog-message {
  flex: 1 1 auto;
}

.dialog-input {
  width: 120px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11.5px;
  background: var(--panel);
  color: var(--fg);
}

.primary {
  border: none;
  border-radius: 5px;
  background: var(--accent);
  color: #fff;
  font-size: 11.5px;
  padding: 3px 10px;
  cursor: pointer;
}

.link {
  border: none;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font-size: 11.5px;
}
</style>
