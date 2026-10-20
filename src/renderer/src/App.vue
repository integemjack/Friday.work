<script setup lang="ts">
// 桌面（2026-10 布局改版第二期）：不再有会话/语音/机器人聊天/助手时间线/活动总览/机器与会话窗口——
//   左栏   ：会话列表（常驻）+ 文件面板（会话用到才展开，可折叠）
//   中间   ：桌面主区（气泡 / 操作卡投在这里的随机位置）+ 底部终端面板
//   右栏   ：视频通话面板（常驻顶部，没有挂断）+ 浏览器面板（用到才展开）+ 与助手聊天（常驻底部）
// 会话的思考/文本以气泡投在桌面随机处（5 秒渐隐）；操作以极简终端卡投在桌面（有结果 5 秒后渐隐）。
// 剩下的浮动窗口只有子 Agent / 设置，入口在标题栏。
import { computed, onBeforeUnmount, onMounted } from 'vue'
import type { WindowKind } from './stores/app.js'
import { saveLayout, useAppStore } from './stores/app.js'
import { uiTheme } from './lib/theme.js'
import { host } from './lib/host.js'
import { WorkChannelHub, type WorkSignalIn } from './lib/workChannel.js'
import TitleBar from './components/TitleBar.vue'
import TerminalCard from './components/TerminalCard.vue'
import FilesCard from './components/FilesCard.vue'
import BrowserCard from './components/BrowserCard.vue'
import AgentsCard from './components/AgentsCard.vue'
import SettingsWindow from './components/SettingsWindow.vue'
import LoginView from './components/LoginView.vue'
import CallWidget from './components/CallWidget.vue'
import SessionList from './components/SessionList.vue'
import AssistantChat from './components/AssistantChat.vue'
import DesktopBubbles from './components/DesktopBubbles.vue'
import DesktopOps from './components/DesktopOps.vue'
import WindowFrame from './desktop/WindowFrame.vue'
import JarvisHUD from './desktop/JarvisHUD.vue'

const store = useAppStore()

// work 通道（0.3）：WebRTC 工作连接的渲染进程一头。
// 信令（work.signal）驱动建 PC / 喂 SDP；数据（work.out → 分片发、收到拼回后 work.in 回协议进程）。
// ICE 与语音通话同一套。
const workHub = new WorkChannelHub({
  onOpen: (machineID, requestId) => host.postWork({ type: 'work.open', machineID, requestId }),
  onData: (machineID, text) => host.postWork({ type: 'work.in', machineID, text }),
  onClosed: (machineID, requestId, reason) => host.postWork({ type: 'work.closed', machineID, requestId, reason }),
  onSignalOut: (machineID, signalType, payload) => host.postWork({ type: 'work.signalOut', machineID, signalType, payload }),
  iceServers: async () => (await store.callIce()) as RTCIceServer[]
})
const offWork = host.onWork((message) => {
  if (message.type === 'work.signal') {
    workHub.onSignal(message.machineID, message.signal as WorkSignalIn)
  } else if (message.type === 'work.out') {
    workHub.send(message.machineID, String(message.text ?? ''))
  }
})

// 贾维斯界面开着才挂桌面 HUD（雷达/时钟/连接状态）
const jarvis = computed(() => uiTheme.value === 'jarvis')

// 登录页：还没进过工作台（没连过机器）或手动打开时盖在桌面上。
// 已有凭据/机器时协议进程会静默恢复，machines 一到 workbenchReady 就是 true，这个页不出现
const showLogin = computed(() => !store.workbenchReady || store.loginOverlay)

// 布局持久化：窗口开/关/拖/缩后防抖存一份（saveLayout 里已有内容签名比对，重复状态不落盘）
let saveTimer = 0
let lastSignature = ''
function layoutSignature(): string {
  return JSON.stringify([store.windows, store.nextZ, store.cascade, store.currentMachine])
}
function scheduleLayoutSave(): void {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const signature = layoutSignature()
    if (signature === lastSignature) return
    lastSignature = signature
    saveLayout(store)
  }, 300)
}

onBeforeUnmount(() => {
  window.clearTimeout(saveTimer)
  offWork()
  workHub.disposeAll()
})

onMounted(() => {
  // 界面主题已在 main.ts 挂载前应用（避免首帧闪系统样式）；这里只恢复布局、接协议事件
  store.restoreLayout()
  store.bindHost()
  store.$subscribe(() => scheduleLayoutSave(), { detached: true })
})

const componentFor: Record<WindowKind, unknown> = {
  terminals: TerminalCard,
  files: FilesCard,
  browser: BrowserCard,
  agents: AgentsCard,
  settings: SettingsWindow
}

const sizeLimits: Record<WindowKind, { minWidth: number; minHeight: number }> = {
  terminals: { minWidth: 420, minHeight: 260 },
  files: { minWidth: 360, minHeight: 300 },
  browser: { minWidth: 420, minHeight: 320 },
  agents: { minWidth: 360, minHeight: 240 },
  settings: { minWidth: 420, minHeight: 320 }
}
</script>

<template>
  <div class="app">
    <TitleBar />

    <!-- 桌面：三栏（会话列表 | 留白主区 | 通话+聊天）。
         气泡和操作卡投在主区随机位置；终端/文件/浏览器/子 Agent/设置都是用到时才开的浮动窗口 -->
    <div class="desktop">
      <!-- 贾维斯 HUD：全息雷达 + 真实状态（机器连接 / 窗口数 / 待确认 / 时钟） -->
      <JarvisHUD v-if="jarvis" />

      <!-- 左栏：会话列表（常驻，就这一样） -->
      <aside class="side side-left">
        <SessionList />
      </aside>

      <!-- 中间：桌面主区留白（气泡/操作卡落在几何上的这一块） -->
      <section class="main-area" />

      <!-- 右栏：通话面板（常驻顶部）+ 与助手聊天（常驻底部），不放别的 -->
      <aside class="side side-right">
        <CallWidget />
        <div class="side-chat"><AssistantChat /></div>
      </aside>

      <!-- 桌面投层：思考/文本气泡 + 操作极简终端卡（都在主区随机位置，最上层可点掉） -->
      <DesktopBubbles />
      <DesktopOps />

      <!-- 没连机器时的桌面提示 -->
      <div v-if="!store.connected" class="desktop-empty">
        <div class="desktop-title">Friday</div>
        <div class="desktop-sub">扫码连上那台跑着 Friday 的机器，直接开工</div>
        <div class="desktop-actions">
          <button class="btn primary" @click="store.openLogin()">扫码连接机器</button>
        </div>
      </div>

      <!-- 浮动窗口层（只剩子 Agent / 设置） -->
      <div class="windows-layer">
        <WindowFrame
          v-for="item in store.allWindows"
          :id="item.id"
          :key="item.id"
          :title="item.title"
          :icon="item.icon"
          :rect="{ x: item.x, y: item.y, w: item.w, h: item.h }"
          :z="item.z"
          :minimized="item.minimized"
          :maximized="item.maximized"
          :min-width="sizeLimits[item.kind].minWidth"
          :min-height="sizeLimits[item.kind].minHeight"
          @focus="store.focusWindow(item.id)"
          @close="store.closeWindow(item.id)"
          @minimize="store.minimizeWindow(item.id)"
          @toggle-maximize="store.toggleMaximizeWindow(item.id)"
          @move="(rect) => store.moveWindow(item.id, rect)"
          @resize="(rect) => store.resizeWindow(item.id, rect)"
        >
          <component :is="componentFor[item.kind]" />
        </WindowFrame>
      </div>
    </div>

    <!-- 登录页：盖在桌面上（面板不卸载，终端等实例还在），连上后自己收起 -->
    <LoginView v-if="showLogin" />

    <!-- 全局错误横幅 -->
    <div v-if="store.error" class="error-toast" @click="store.error = ''">
      {{ store.error }}
      <span class="close-hint">（点一下关掉）</span>
    </div>
  </div>
</template>

<style scoped>
.app {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
}

.desktop {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  /* 桌面底：纯色 + 极淡的点阵，不抢面板/窗口的注意力 */
  background-color: var(--bg);
  background-image: radial-gradient(var(--border) 1px, transparent 1px);
  background-size: 22px 22px;
  background-position: -1px -1px;
  /* 三栏单行：左=会话列表，中=留白主区（气泡/操作卡/浮动窗口），右=通话+聊天 */
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr) 352px;
  grid-template-rows: minmax(0, 1fr);
  grid-template-areas: 'left main right';
  gap: 8px;
  padding: 8px;
}

/* ---- 左栏 ---- */
.side {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.side-left {
  grid-area: left;
}

/* ---- 中间：留白主区 ---- */
.main-area {
  grid-area: main;
  position: relative;
  min-width: 0;
  min-height: 0;
}

/* ---- 右栏 ---- */
.side-right {
  grid-area: right;
}

.side-chat {
  flex: none;
  height: 340px;
  /* 贴住右栏底部：上面是通话，中间留空给桌面 */
  margin-top: auto;
}

/* 没连机器时提示铺满（盖在面板上层） */
.desktop-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-2);
  pointer-events: none;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
}

.desktop-empty > * {
  pointer-events: auto;
}

.desktop-title {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--text-3);
}

.desktop-sub {
  font-size: 13px;
  color: var(--text-3);
}

.desktop-actions {
  margin-top: 12px;
}

/* 浮动窗口层：铺满桌面（只剩子 Agent / 设置） */
.windows-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.windows-layer > * {
  pointer-events: auto;
}

/* 贾维斯界面：桌面底纹从点阵换成青色全息网格 + 中央辉光，欢迎语带发光 */
[data-theme='jarvis'] .desktop {
  background-color: var(--bg);
  background-image:
    radial-gradient(ellipse 60% 50% at 50% 42%, var(--accent-a10), transparent 70%),
    linear-gradient(var(--accent-a5) 1px, transparent 1px),
    linear-gradient(90deg, var(--accent-a5) 1px, transparent 1px);
  background-size: auto, 44px 44px, 44px 44px;
  background-position: center;
}

[data-theme='jarvis'] .desktop-title {
  color: var(--accent);
  letter-spacing: 4px;
  text-shadow: 0 0 18px var(--accent-a55);
  text-transform: uppercase;
}

/* 贾维斯：桌面四角的 HUD 括号（压在窗口层下面，纯定位装饰） */
[data-theme='jarvis'] .desktop::before {
  content: '';
  position: absolute;
  inset: 12px;
  pointer-events: none;
  background:
    linear-gradient(var(--accent) 0 0) left top / 22px 1.5px,
    linear-gradient(var(--accent) 0 0) left top / 1.5px 22px,
    linear-gradient(var(--accent) 0 0) right top / 22px 1.5px,
    linear-gradient(var(--accent) 0 0) right top / 1.5px 22px,
    linear-gradient(var(--accent) 0 0) left bottom / 22px 1.5px,
    linear-gradient(var(--accent) 0 0) left bottom / 1.5px 22px,
    linear-gradient(var(--accent) 0 0) right bottom / 22px 1.5px,
    linear-gradient(var(--accent) 0 0) right bottom / 1.5px 22px;
  background-repeat: no-repeat;
  opacity: 0.4;
}

/* 贾维斯：一条扫描线周期性扫过桌面（在窗口层下面，不干扰阅读） */
[data-theme='jarvis'] .desktop::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -140px;
  height: 140px;
  background: linear-gradient(
    180deg,
    transparent,
    var(--accent-a7) 82%,
    var(--accent-a20)
  );
  animation: jarvis-scan 8s linear infinite;
  pointer-events: none;
}

@keyframes jarvis-scan {
  to {
    transform: translateY(calc(100vh + 280px));
  }
}

.error-toast {
  position: fixed;
  left: 50%;
  bottom: 56px;
  transform: translateX(-50%);
  max-width: 70vw;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--fail);
  color: #fff;
  font-size: 12.5px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.24);
  cursor: pointer;
  z-index: 100000;
}

.close-hint {
  opacity: 0.75;
  font-size: 11.5px;
}
</style>
