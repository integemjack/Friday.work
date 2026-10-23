<script setup lang="ts">
// 终端卡片（M2，方案 §5.4 / REMOTE.md §6「终端」）：
// 远程的伪终端在服务端（libvterm），客户端只是字节流镜像 —— htop/vim 等全屏程序天然可用。
// 输出：term.output 事件（base64）→ xterm.write(Uint8Array)
// 输入：xterm onData（已按终端键位编码）→ base64 → term.write
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TermAttachResult } from '../../../protocol/rpc/protocol.js'
import { XTERM_THEMES } from '../../../shared/theme-tokens.js'
import { host, rpc } from '../lib/host.js'
import { uiTheme } from '../lib/theme.js'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()
const container = ref<HTMLDivElement | null>(null)
const loading = ref(false)
const unavailable = computed(() => !store.terminalsAvailable && !!store.terminalsReason)

let term: Terminal | null = null
let fitAddon: FitAddon | null = null

function systemDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

/** 终端配色：贾维斯一套；跟随系统按当前深浅档取（底都是透明的，见 XTERM_THEMES） */
function xtermTheme() {
  if (uiTheme.value === 'jarvis') return XTERM_THEMES.jarvis
  return XTERM_THEMES.system[systemDark() ? 'dark' : 'light']
}

/** 系统深浅色变了（跟随系统主题下）：终端配色跟着换一档 */
function onSchemeChange(): void {
  if (term) term.options.theme = xtermTheme()
}

let schemeQuery: MediaQueryList | null = null
let currentID = ''
let unsubscribe: (() => void) | null = null
let observer: ResizeObserver | null = null
let resizeTimer: number | null = null

function b64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToB64(bytes: Uint8Array): string {
  // 分块，避免大段数据把栈撑爆
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function doFit(): void {
  if (!term || !fitAddon || !container.value) return
  try {
    fitAddon.fit()
  } catch {
    // 卡片还没显示时量不出尺寸
    return
  }
  if (currentID && term.cols > 0 && term.rows > 0) {
    void rpc(store.currentMachine, 'term.resize', { id: currentID, cols: term.cols, rows: term.rows }).catch(() => {})
  }
}

/** 接上一个终端：清屏 → 按回执尺寸重放最近输出 → 再按本地尺寸重排（REMOTE.md §6） */
async function attach(id: string): Promise<void> {
  if (!term || !store.currentMachine) return
  const machine = store.currentMachine
  currentID = id
  store.activeTerminalID = id
  loading.value = true
  term.reset()
  try {
    const result = (await rpc(machine, 'term.attach', { id })) as TermAttachResult
    // 等回执的时候窗口可能已经关了，或者已经切到别的标签/机器（快速连点）：
    // 旧标签的回执不能重放，不然画面串台、按键发错终端
    if (!term || currentID !== id || machine !== store.currentMachine) return
    term.reset()
    if (result.data) term.write(b64ToBytes(result.data))
    if (result.cols > 0 && result.rows > 0) term.resize(result.cols, result.rows)
    doFit()
    // 不跟用户正在打字的输入框抢焦点：Agent 自动弹的终端不该打断输入（焦点进了 xterm 还会把
    // 后续按键发给远端 shell）。当前焦点在可编辑元素上就不动它；用户点开终端窗口 / 点标签 /
    // 点 ＋ 时焦点在按钮或 body 上，照常聚焦，点开就能打字
    const active = document.activeElement
    const editing =
      active instanceof HTMLElement &&
      (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)
    if (!editing) term.focus()
  } catch (error) {
    if (!term || currentID !== id || machine !== store.currentMachine) return
    term.write(`\r\n\x1b[31m接不上这个终端：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
  } finally {
    // 已切到别的标签时不转 loading：那笔账由新标签自己的 attach 管
    if (!term || currentID === id) loading.value = false
  }
}

let opening = false
async function openTerminal(): Promise<void> {
  if (!term || !store.currentMachine || opening) return
  opening = true
  const id = crypto.randomUUID()
  try {
    // 挂在当前会话上；没选会话时用最近一段（原来要求必须有选中的会话，否则点 ＋ 毫无反应）
    const conversationID = await store.toolConversationID()
    if (!conversationID) throw new Error('还没有可以挂终端的会话')
    await rpc(store.currentMachine, 'term.open', {
      id,
      conversationID,
      cols: term.cols || 80,
      rows: term.rows || 24
    })
    // 先把新标签放进本地列表并选中（服务端的 terminals 事件回来只是确认），标签栏立刻出现
    if (!store.terminals.some((terminal) => terminal.id === id)) {
      store.terminals = [
        ...store.terminals,
        { id, conversationID, title: 'shell', shell: '', running: true, cols: term.cols || 80, rows: term.rows || 24 }
      ]
    }
    await attach(id)
  } catch (error) {
    term?.write(`\r\n\x1b[31m开不了终端：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
  } finally {
    opening = false
  }
}

/** 标题栏要求开一个新标签（窗口刚打开、里面还没有终端）：xterm 准备好之后开 */
function consumeNewTabRequest(): void {
  if (!store.newTabRequest.terminals || !term) return
  store.newTabRequest.terminals = false
  if (store.terminals.length === 0 && !unavailable.value) void openTerminal()
}
watch(() => store.newTabRequest.terminals, consumeNewTabRequest)

async function closeTerminal(id: string): Promise<void> {
  if (!store.currentMachine) return
  const hadTerminals = store.terminals.length > 0
  // 本地先把这个标签摘掉（同 closeAllTerminalsOnWindowClose）：服务端的 terminals 事件回来只是确认，
  // 桥断了也不能让标签挂着不走——下面 watch(terminals) 会负责清画面 / 切到剩下的那个
  store.terminals = store.terminals.filter((terminal) => terminal.id !== id)
  if (store.activeTerminalID === id) store.activeTerminalID = ''
  // 关掉的就是最后一个：窗口里再没标签，跟着一起收掉
  store.closeTerminalWindowIfEmpty(hadTerminals)
  await rpc(store.currentMachine, 'term.close', { id }).catch(() => {})
}

/** 终端窗口关掉时：把里面挂着的终端全部真关掉（term.close）。
 *  不关的话 shell 会一直留在机器上跑，Agent 那边（read_terminal）也一直看得见——「在客户端里关了却没关」积下来就是一堆僵尸终端。
 *  要收起窗口不关终端，用最小化。应用退出 / 整页刷新不走这里，终端照旧留给机器上的会话。 */
function closeAllTerminalsOnWindowClose(): void {
  const machine = store.currentMachine
  const ids = store.terminals.map((terminal) => terminal.id)
  if (!machine || ids.length === 0) return
  // 先把本地列表清掉（标签随窗口一起消失）；服务端的 terminals 事件回来只是确认，断了也不残留
  store.terminals = []
  store.activeTerminalID = ''
  currentID = ''
  term?.reset() // 标签清掉的同时画面也得清掉（下面的 watch 因为 currentID 已经空了不会再跑）
  for (const id of ids) {
    void rpc(machine, 'term.close', { id }).catch(() => {})
  }
}

onMounted(async () => {
  await nextTick()
  if (!container.value) return
  term = new Terminal({
    cursorBlink: true,
    fontSize: 12.5,
    fontFamily: 'Consolas, "Cascadia Mono", "Sarasa Mono SC", monospace',
    theme: xtermTheme(),
    scrollback: 4000,
    allowProposedApi: true,
    // 融合：终端背景透明，桌面背景透出来
    allowTransparency: true
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(container.value)

  schemeQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null
  schemeQuery?.addEventListener('change', onSchemeChange)

  // 用户按键 → 远端伪终端
  term.onData((data) => {
    if (!currentID || !store.currentMachine) return
    void rpc(store.currentMachine, 'term.write', {
      id: currentID,
      data: bytesToB64(new TextEncoder().encode(data))
    }).catch(() => {})
  })

  // 远端输出 → xterm（高频，不经 store）
  unsubscribe = host.onEvent((event) => {
    if (event.type !== 'event' || event.method !== 'term.output') return
    const params = event.params as { id: string; data: string }
    if (params.id !== currentID) return
    term?.write(b64ToBytes(params.data))
  })

  observer = new ResizeObserver(() => {
    if (resizeTimer) window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => doFit(), 120)
  })
  observer.observe(container.value)

  doFit()
  // 只挂列表里真的存在的那个：刷新前留下的 activeTerminalID 可能已经指向一个关掉的终端，
  // 直接 attach 会在空标签栏下面写一行「接不上这个终端」——那也是一种残留
  const want = wantedTerminal()
  if (want) await attach(want)
  consumeNewTabRequest()
})

// 切主题时热切换终端配色（xterm 支持运行时改 options.theme）
watch(uiTheme, () => {
  if (term) {
    term.options.theme = xtermTheme()
    term.options.allowTransparency = true
  }
})

onBeforeUnmount(() => {
  unsubscribe?.()
  observer?.disconnect()
  schemeQuery?.removeEventListener('change', onSchemeChange)
  if (resizeTimer) window.clearTimeout(resizeTimer)
  term?.dispose()
  term = null
})

/** 该挂哪个终端：活动的那个还在列表里就用它，已经不在了（跑完被回收 / Agent close_terminal / 点了 ×）
 *  就退到剩下的第一个，一个都不剩就是空。 */
function wantedTerminal(): string {
  const id = store.activeTerminalID
  if (id && store.terminals.some((terminal) => terminal.id === id)) return id
  return store.terminals[0]?.id ?? ''
}

// 列表 / 活动终端一变就跟过去：这是「标签关了、画面还挂着上一个终端的输出」的根治处——
// 光清掉标签不够，xterm 是本地实例，服务端不会再推它的内容，必须自己 reset。
// 挂在 watch 上而不是 closeTerminal 里：终端消失的路径不止点 ×（Agent 关掉、shell 退出被回收、
// 快照整份换掉），它们最后都落到这里。
watch(
  () => [store.activeTerminalID, store.terminals.map((terminal) => terminal.id).join(',')] as const,
  () => {
    if (!term) return
    const want = wantedTerminal()
    if (want === currentID) return
    if (!want) {
      currentID = ''
      term.reset() // 没有终端可挂了：画面跟着标签一起清干净，只留下面的空态提示
      return
    }
    void attach(want)
  }
)

// 终端窗口从窗口列表里消失 = 用户把它关了：把里面挂着的终端全部真关掉（closeAllTerminalsOnWindowClose）。
// 用 watch 窗口列表而不是 onBeforeUnmount：热更新也会卸载重挂组件，那样不能把终端带走；
// sync：窗口从 store 里删掉的那一刻同步执行——pre/post 会随组件卸载一起被停掉，来不及跑
watch(
  () => store.windows.some((item) => item.kind === 'terminals'),
  (open, wasOpen) => {
    if (wasOpen && !open) closeAllTerminalsOnWindowClose()
  },
  { flush: 'sync' }
)

async function selectTerminal(id: string): Promise<void> {
  if (id === currentID) return
  await attach(id)
}
</script>

<template>
  <div class="term-card">
    <div v-if="unavailable" class="notice">
      这台机器上的终端只有 SSH / WSL 连接可以用（{{ store.terminalsReason }}）
    </div>
    <template v-else>
      <div class="term-tabs">
        <button
          v-for="terminal in store.terminals"
          :key="terminal.id"
          class="tab"
          :class="{ active: terminal.id === store.activeTerminalID, running: terminal.running }"
          :title="terminal.command || terminal.shell"
          @click="selectTerminal(terminal.id)"
        >
          <span v-if="terminal.running" class="dot" />
          <span class="tab-title">{{ terminal.title || terminal.shell }}</span>
          <span class="tab-close" title="结束这个终端" @click.stop="closeTerminal(terminal.id)">×</span>
        </button>
        <button class="tab add" title="新开一个终端" @click="openTerminal">＋</button>
      </div>
      <div ref="container" class="term-host" />
      <div v-if="!store.terminals.length" class="empty-tip">点 ＋ 在这台机器上开一个终端</div>
    </template>
  </div>
</template>

<style scoped>
.term-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  /* 融合：透明底，文字浮在桌面背景上（xterm 画布也是透明的） */
  background: transparent;
}

.notice {
  padding: 16px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.7;
}

/* 标签栏：不铺底条、不画分隔线——一行标签直接浮在终端上方（简化元素） */
.term-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 6px 1px;
  overflow-x: auto;
  background: transparent;
  flex: 0 0 auto;
}

/* 横向滚动条不占视觉（标签多了照样能滚） */
.term-tabs::-webkit-scrollbar {
  height: 0;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.35;
  cursor: pointer;
  white-space: nowrap;
}

.tab:hover {
  background: var(--hover);
  color: var(--text);
}

.tab.active {
  background: var(--selected);
  color: var(--text);
}

/* 只有运行中的终端才有点：空闲标签不再挂一个灰点（简化元素） */
.tab .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ok);
}

.tab-title {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 关闭：平时不露，鼠标进标签 / 标签是当前的才浮出来 */
.tab-close {
  opacity: 0;
  padding: 0 2px;
  color: var(--text-3);
  transition: opacity 0.12s ease;
}

.tab:hover .tab-close,
.tab.active .tab-close {
  opacity: 0.6;
}

.tab-close:hover {
  opacity: 1;
  color: var(--fail);
}

.tab.add {
  font-size: 14px;
  padding: 2px 8px;
  color: var(--text-3);
}

.tab.add:hover {
  color: var(--accent);
}

.term-host {
  flex: 1 1 auto;
  min-height: 0;
  padding: 2px 8px 6px;
}

/* 去黑底：xterm 自带 CSS 把 .xterm-viewport 写死成 #000（node_modules/@xterm/xterm/css/xterm.css），
   画布那层底本来就透明，只有它黑着——整个终端内部因此是个黑块。
   !important 是为了压过 .xterm .xterm-viewport 那条规则（同特异度，不赌加载顺序） */
.term-host :deep(.xterm),
.term-host :deep(.xterm-screen),
.term-host :deep(.xterm-viewport) {
  background-color: transparent !important;
}

.term-host :deep(.xterm) {
  height: 100%;
}

.empty-tip {
  padding: 4px 12px 10px;
  font-size: 12px;
  color: var(--text-3);
}

/* 贾维斯界面：终端界面走 HUD 极简——标签等宽字、当前标签只留一道青色底线，
   底条 / 扫描线 / 内发光都不留（旧版那三样是「重新美化」要去掉的元素） */
[data-theme='jarvis'] .tab {
  font-family: var(--font-hud);
  color: var(--text-3);
}

[data-theme='jarvis'] .tab:hover {
  background: var(--accent-a8);
  color: var(--text);
}

[data-theme='jarvis'] .tab.active {
  background: transparent;
  color: var(--accent-bright);
  box-shadow: inset 0 -1.5px 0 0 var(--accent);
}

[data-theme='jarvis'] .tab .dot {
  box-shadow: 0 0 6px var(--ok-a70);
}

[data-theme='jarvis'] .tab.add:hover {
  color: var(--accent-bright);
}
</style>
