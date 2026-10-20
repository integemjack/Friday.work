<script setup lang="ts">
// 桌面（2026-10 布局改版）：底部任务栏去掉，
// 终端 / 文件 / 浏览器连上机器后直接铺在桌面上（左=文件、右=浏览器、底=终端，可折叠）；
// 其余（会话 / 子 Agent / 活动总览 / 机器 / 设置 / 聊天 …）仍是可拖动窗口，入口在标题栏；
// 通话是右下角悬浮挂件（视频画面 + 静麦 + 静扬声器）。
import { computed, onBeforeUnmount, onMounted } from 'vue'
import type { WindowKind } from './stores/app.js'
import { saveLayout, useAppStore } from './stores/app.js'
import { uiTheme } from './lib/theme.js'
import { host } from './lib/host.js'
import { WorkChannelHub, type WorkSignalIn } from './lib/workChannel.js'
import TitleBar from './components/TitleBar.vue'
import ConversationView from './components/ConversationView.vue'
import TerminalCard from './components/TerminalCard.vue'
import FilesCard from './components/FilesCard.vue'
import BrowserCard from './components/BrowserCard.vue'
import AgentsCard from './components/AgentsCard.vue'
import ActivityOverview from './components/ActivityOverview.vue'
import VoiceWindow from './components/VoiceWindow.vue'
import SettingsWindow from './components/SettingsWindow.vue'
import SchatWindow from './components/SchatWindow.vue'
import LoginView from './components/LoginView.vue'
import CallWidget from './components/CallWidget.vue'
import TimelineWindow from './components/TimelineWindow.vue'
import MachinesWindow from './desktop/MachinesWindow.vue'
import WindowFrame from './desktop/WindowFrame.vue'
import JarvisHUD from './desktop/JarvisHUD.vue'
import JarvisTelemetry from './desktop/JarvisTelemetry.vue'

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

// 桌面面板的展开/折叠尺寸（折叠成窄轨，留标签可点回来）
const dockStyle = computed(() => ({
  '--dock-files': store.docks.files ? '230px' : '22px',
  '--dock-browser': store.docks.browser ? '350px' : '22px',
  '--dock-term': store.docks.terminals ? '192px' : '22px'
}))

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
  if (!store.windows.length) store.openWindow('machines')
})

const componentFor: Record<WindowKind, unknown> = {
  conversation: ConversationView,
  terminals: TerminalCard,
  files: FilesCard,
  browser: BrowserCard,
  agents: AgentsCard,
  activity: ActivityOverview,
  machines: MachinesWindow,
  voice: VoiceWindow,
  settings: SettingsWindow,
  schat: SchatWindow,
  call: CallWidget,
  timeline: TimelineWindow
}

const sizeLimits: Record<WindowKind, { minWidth: number; minHeight: number }> = {
  conversation: { minWidth: 420, minHeight: 340 },
  terminals: { minWidth: 420, minHeight: 260 },
  files: { minWidth: 360, minHeight: 300 },
  browser: { minWidth: 420, minHeight: 320 },
  agents: { minWidth: 360, minHeight: 240 },
  activity: { minWidth: 320, minHeight: 240 },
  machines: { minWidth: 320, minHeight: 280 },
  voice: { minWidth: 360, minHeight: 320 },
  settings: { minWidth: 420, minHeight: 320 },
  schat: { minWidth: 420, minHeight: 360 },
  call: { minWidth: 300, minHeight: 380 },
  timeline: { minWidth: 380, minHeight: 300 }
}
</script>

<template>
  <div class="app">
    <TitleBar />

    <!-- 桌面：连上机器后是「文件 | 浮动窗口区 | 浏览器 / 终端」网格；面板上面浮着窗口和通话挂件 -->
    <div class="desktop" :class="{ docked: store.connected }" :style="store.connected ? dockStyle : undefined">
      <!-- 贾维斯 HUD：全息雷达 + 真实状态（机器连接 / 窗口数 / 待确认 / 时钟），窗口盖在上面 -->
      <JarvisHUD v-if="jarvis" />

      <!-- 贾维斯桌面遥测：正在跑的会话 / 子 Agent / 系统日志直接投在桌面上，点开才进窗口 -->
      <JarvisTelemetry v-if="jarvis" />

      <!-- 桌面直显面板（扁平、无窗口样式）：文件（左）/ 浏览器（右）/ 终端（底）。
           v-show 保内容：终端实例不能重建 -->
      <template v-if="store.connected">
        <aside class="dock dock-files" :class="{ collapsed: !store.docks.files }">
          <div class="dock-body"><FilesCard /></div>
          <div class="dock-rail">
            <button class="dock-toggle" :title="store.docks.files ? '折叠文件' : '展开文件'" @click="store.toggleDock('files')">
              {{ store.docks.files ? '‹' : '›' }}
            </button>
            <span class="dock-label" @click="store.toggleDock('files')">文件</span>
          </div>
        </aside>

        <aside class="dock dock-browser" :class="{ collapsed: !store.docks.browser }">
          <div class="dock-body"><BrowserCard /></div>
          <div class="dock-rail">
            <button class="dock-toggle" :title="store.docks.browser ? '折叠浏览器' : '展开浏览器'" @click="store.toggleDock('browser')">
              {{ store.docks.browser ? '›' : '‹' }}
            </button>
            <span class="dock-label" @click="store.toggleDock('browser')">浏览器</span>
          </div>
        </aside>

        <section class="dock dock-terminals" :class="{ collapsed: !store.docks.terminals }">
          <div class="dock-body"><TerminalCard /></div>
          <div class="dock-rail">
            <button class="dock-toggle" :title="store.docks.terminals ? '折叠终端' : '展开终端'" @click="store.toggleDock('terminals')">
              {{ store.docks.terminals ? '⌄' : '⌃' }}
            </button>
            <span class="dock-label" @click="store.toggleDock('terminals')">终端</span>
          </div>
        </section>
      </template>

      <!-- 没连机器时的桌面提示 -->
      <div v-if="!store.connected" class="desktop-empty">
        <div class="desktop-title">Friday</div>
        <div class="desktop-sub">连上那台跑着 Friday 的机器，终端 / 文件 / 浏览器直接铺在桌面上</div>
        <div class="desktop-actions">
          <button class="btn primary" @click="store.openWindow('machines')">打开机器与会话</button>
        </div>
      </div>

      <!-- 浮动窗口层（会话 / 子 Agent / 活动 / 设置 …）：绝对定位铺在面板上面 -->
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
          <component
            :is="componentFor[item.kind]"
            :conversation-id="item.conversationID"
          />
        </WindowFrame>
      </div>

      <!-- 右下角通话挂件：视频画面 + 静麦 + 静扬声器（随通话状态自动出现） -->
      <CallWidget />
    </div>

    <!-- 登录页：盖在桌面上（窗口不卸载，终端等实例还在），连上后自己收起 -->
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
}

/* 连上机器：桌面变三栏网格（文件 | 主区 | 浏览器），终端横贯底部 */
.desktop.docked {
  display: grid;
  grid-template-columns: var(--dock-files) minmax(0, 1fr) var(--dock-browser);
  grid-template-rows: minmax(0, 1fr) var(--dock-term);
  grid-template-areas:
    'files main browser'
    'term term term';
}

/* 桌面直显面板：扁平、不做窗口样式——没有标题栏/边框盒子/阴影，
   内容直接铺在桌面上，靠内侧一条发丝线分区；标签浮在边缘、悬停才见控制钮 */
.dock {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.dock-files {
  grid-area: files;
  border-right: 1px solid var(--border);
}

.dock-browser {
  grid-area: browser;
  border-left: 1px solid var(--border);
}

.dock-terminals {
  grid-area: term;
  flex-direction: column;
  border-top: 1px solid var(--border);
}

.dock-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  background: transparent;
}

/* 边缘轨道：展开时是内缘一条悬停可见的细条（只有箭头）；折叠时就是面板本体（22px，标签+箭头） */
.dock-rail {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  z-index: 5;
}

.dock:hover .dock-rail,
.dock.collapsed .dock-rail {
  display: flex;
}

/* 展开态：轨道只占内缘 16px，不遮内容 */
.dock-files:not(.collapsed) .dock-rail {
  left: auto;
  width: 16px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--bg) 78%, transparent));
}

.dock-browser:not(.collapsed) .dock-rail {
  right: auto;
  width: 16px;
  background: linear-gradient(270deg, transparent, color-mix(in srgb, var(--bg) 78%, transparent));
}

.dock-terminals:not(.collapsed) .dock-rail {
  bottom: auto;
  height: 16px;
  flex-direction: row;
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--bg) 78%, transparent));
}

.dock:not(.collapsed) .dock-label {
  display: none;
}

.dock-files .dock-rail,
.dock-browser .dock-rail {
  flex-direction: column;
}

.dock-label {
  font-size: 10px;
  letter-spacing: 3px;
  color: var(--text-3);
  writing-mode: vertical-rl;
  user-select: none;
}

.dock-terminals .dock-label {
  writing-mode: horizontal-tb;
  letter-spacing: 4px;
}

.dock-toggle {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
}

.dock-toggle:hover {
  background: var(--hover);
  color: var(--text);
}

/* 折叠态：整条就是窄轨（标签 + 展开箭头），内容 v-show 隐藏 */
.dock.collapsed .dock-body {
  display: none;
}

/* 没连机器时提示铺满（网格未启用，走绝对定位居中） */
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

/* 浮动窗口层：铺满桌面（坐标与旧版一致），面板、提示、挂件都在它下面/上面各归各 */
.windows-layer {
  position: absolute;
  inset: 0;
}

/* 贾维斯界面：桌面底纹从点阵换成青色全息网格 + 中央辉光，欢迎语带发光 */
[data-theme='jarvis'] .desktop {
  background-color: var(--bg);
  background-image:
    radial-gradient(ellipse 60% 50% at 50% 42%, rgba(34, 211, 238, 0.1), transparent 70%),
    linear-gradient(rgba(34, 211, 238, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(34, 211, 238, 0.05) 1px, transparent 1px);
  background-size: auto, 44px 44px, 44px 44px;
  background-position: center;
}

[data-theme='jarvis'] .desktop-title {
  color: var(--accent);
  letter-spacing: 4px;
  text-shadow: 0 0 18px rgba(34, 211, 238, 0.55);
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
    rgba(34, 211, 238, 0.07) 82%,
    rgba(34, 211, 238, 0.2)
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
