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
import { host, rpc } from '../lib/host.js'
import { uiTheme } from '../lib/theme.js'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()
const container = ref<HTMLDivElement | null>(null)
const loading = ref(false)
const unavailable = computed(() => !store.terminalsAvailable && !!store.terminalsReason)

let term: Terminal | null = null
let fitAddon: FitAddon | null = null

// xterm 的配色是 JS 层主题（CSS 盖不到）：贾维斯下换深空蓝底 + 青色光标/选区 + 调过的 ANSI 色板
const XTERM_THEMES = {
  system: {
    /* 半透明深底：融合（需要 allowTransparency，见 new Terminal） */
    background: 'rgba(20, 21, 26, 0.55)',
    foreground: '#e6e6e8',
    cursor: '#8ab4f8',
    selectionBackground: '#3a4a6b'
  },
  jarvis: {
    // 透明底：终端文字直接浮在全息网格背景上（需要 allowTransparency，见 new Terminal）
    background: 'rgba(6, 11, 20, 0)',
    foreground: '#c9e7f2',
    cursor: '#22d3ee',
    cursorAccent: '#071018',
    selectionBackground: 'rgba(34, 211, 238, 0.28)',
    black: '#0c1a2a',
    red: '#ff6b81',
    green: '#3ddc97',
    yellow: '#ffd166',
    blue: '#6bb8ff',
    magenta: '#c792ea',
    cyan: '#4dd9e8',
    white: '#c9d6e3',
    brightBlack: '#4a6a80',
    brightRed: '#ff8fa0',
    brightGreen: '#6fe7b4',
    brightYellow: '#ffe08a',
    brightBlue: '#93ccff',
    brightMagenta: '#dcb3f5',
    brightCyan: '#7ce6f2',
    brightWhite: '#eef8fc'
  }
} as const

function xtermTheme() {
  return XTERM_THEMES[uiTheme.value === 'jarvis' ? 'jarvis' : 'system']
}
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
  currentID = id
  store.activeTerminalID = id
  loading.value = true
  term.reset()
  try {
    const result = (await rpc(store.currentMachine, 'term.attach', { id })) as TermAttachResult
    term.reset()
    if (result.data) term.write(b64ToBytes(result.data))
    if (result.cols > 0 && result.rows > 0) term.resize(result.cols, result.rows)
    doFit()
    term.focus()
  } catch (error) {
    term.write(`\r\n\x1b[31m接不上这个终端：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
  } finally {
    loading.value = false
  }
}

async function openTerminal(): Promise<void> {
  if (!term || !store.currentMachine || !store.detail) return
  const id = crypto.randomUUID()
  try {
    await rpc(store.currentMachine, 'term.open', {
      id,
      conversationID: store.detail.conversationID,
      cols: term.cols || 80,
      rows: term.rows || 24
    })
    await attach(id)
  } catch (error) {
    term.write(`\r\n\x1b[31m开不了终端：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
  }
}

async function closeTerminal(id: string): Promise<void> {
  if (!store.currentMachine) return
  await rpc(store.currentMachine, 'term.close', { id }).catch(() => {})
  if (currentID === id) currentID = ''
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
  if (store.activeTerminalID) await attach(store.activeTerminalID)
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
  if (resizeTimer) window.clearTimeout(resizeTimer)
  term?.dispose()
  term = null
})

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
          :class="{ active: terminal.id === currentID }"
          :title="terminal.command || terminal.shell"
          @click="selectTerminal(terminal.id)"
        >
          <span class="dot" :class="{ running: terminal.running }" />
          <span class="tab-title">{{ terminal.title || terminal.shell }}</span>
          <span class="tab-close" title="结束这个终端" @click.stop="closeTerminal(terminal.id)">×</span>
        </button>
        <button class="tab add" title="新开一个终端" @click="openTerminal">＋</button>
      </div>
      <div ref="container" class="term-host" />
      <div v-if="!store.terminals.length" class="empty-tip">点上面的 ＋ 在这台机器上开一个终端</div>
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

.term-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  flex: 0 0 auto;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #a8adb8;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.tab:hover {
  background: #24262e;
}

.tab.active {
  background: #2c3040;
  color: #e8eaef;
}

.tab .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #5a5f6b;
}

.tab .dot.running {
  background: #5cd08a;
}

.tab-title {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-close {
  opacity: 0.5;
  padding: 0 2px;
}

.tab-close:hover {
  opacity: 1;
  color: #ff8a8a;
}

.tab.add {
  font-size: 14px;
  padding: 2px 8px;
}

.term-host {
  flex: 1 1 auto;
  min-height: 0;
  padding: 6px 8px;
}

.term-host :deep(.xterm) {
  height: 100%;
}

.empty-tip {
  padding: 8px 12px;
  font-size: 12px;
  color: #7a8090;
}

/* 贾维斯界面：终端变 CRT 全息屏——透明底（文字浮在全息网格上）、青色 tab、扫描线覆层 */
[data-theme='jarvis'] .term-card {
  background: transparent;
  box-shadow: inset 0 0 60px var(--accent-a4-5);
}

[data-theme='jarvis'] .term-tabs {
  background: var(--panel-card-deep-a28);
  border-bottom-color: var(--accent-a25);
}

[data-theme='jarvis'] .tab {
  color: #6f9fb8;
  font-family: var(--font-hud);
}

[data-theme='jarvis'] .tab:hover {
  background: var(--accent-a8);
}

[data-theme='jarvis'] .tab.active {
  background: var(--accent-a14);
  color: #c9f2ff;
  box-shadow: inset 0 -2px 0 0 var(--accent);
}

[data-theme='jarvis'] .tab .dot {
  background: #2c5a72;
}

[data-theme='jarvis'] .tab .dot.running {
  background: var(--ok);
  box-shadow: 0 0 6px var(--ok-a70);
}

[data-theme='jarvis'] .term-host {
  position: relative;
}

/* CRT 扫描线：极淡，纯装饰不挡交互 */
[data-theme='jarvis'] .term-host::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    180deg,
    var(--accent-a2-8) 0 1px,
    transparent 1px 3px
  );
}
</style>
