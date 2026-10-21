<script setup lang="ts">
// 桌面（2026-10 布局改版第二期）：不再有会话/语音/机器人聊天/助手时间线/活动总览/机器与会话窗口——
//   左栏   ：会话列表（常驻）+ 文件面板（会话用到才展开，可折叠）
//   中间   ：桌面主区（气泡 / 操作卡投在这里的随机位置）+ 底部终端面板
//   右栏   ：视频通话面板（常驻顶部，没有挂断）+ 浏览器面板（用到才展开）+ 与助手聊天（常驻底部）
// 会话的思考/文本以气泡投在桌面随机处（5 秒渐隐）；操作以极简终端卡投在桌面（有结果 5 秒后渐隐）。
// 剩下的浮动窗口只有子 Agent / 设置，入口在标题栏。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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
import AskOverlay from './components/AskOverlay.vue'
import CallWidget from './components/CallWidget.vue'
import SessionList from './components/SessionList.vue'
import AssistantChat from './components/AssistantChat.vue'
import Composer from './components/Composer.vue'
import DesktopBubbles from './components/DesktopBubbles.vue'
import DesktopOps from './components/DesktopOps.vue'
import DesktopMediaStacks from './components/DesktopMediaStacks.vue'
import MediaLightbox from './components/MediaLightbox.vue'
import UpdateOverlay from './components/UpdateOverlay.vue'
import CenterScene from './components/CenterScene.vue'
import WindowFrame from './desktop/WindowFrame.vue'
import JarvisHUD from './desktop/JarvisHUD.vue'
import SpaceVeil from './components/SpaceVeil.vue'

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

// 贾维斯界面开着才挂桌面 HUD（雷达/时钟/连接状态）和深空层（星野/流星）
const jarvis = computed(() => uiTheme.value === 'jarvis')

// 贾维斯：鼠标视差——鼠标在桌面上的位置归一化成 --par-x/--par-y（-1..1），
// rAF 里插值逼近后写回 CSS 变量；深空层 / 3D 场景 / HUD 各自按变量反向/正向小幅偏移。
// 不随系统 prefers-reduced-motion 关闭（本机系统动画效果是关的，跟随会静默失效）。
const desktopEl = ref<HTMLElement | null>(null)
let parRaf = 0
let parTarget = { x: 0, y: 0 }
let parNow = { x: 0, y: 0 }
function parTick(): void {
  parRaf = 0
  const el = desktopEl.value
  if (!el) return
  parNow.x += (parTarget.x - parNow.x) * 0.07
  parNow.y += (parTarget.y - parNow.y) * 0.07
  el.style.setProperty('--par-x', parNow.x.toFixed(4))
  el.style.setProperty('--par-y', parNow.y.toFixed(4))
  if (Math.abs(parTarget.x - parNow.x) > 0.002 || Math.abs(parTarget.y - parNow.y) > 0.002) {
    parRaf = requestAnimationFrame(parTick)
  }
}
function onDesktopMove(event: MouseEvent): void {
  if (!jarvis.value) return
  parTarget.x = (event.clientX / window.innerWidth) * 2 - 1
  parTarget.y = (event.clientY / window.innerHeight) * 2 - 1
  if (!parRaf) parRaf = requestAnimationFrame(parTick)
}

// 登录页：还没进过工作台（没连过机器）或手动打开时盖在桌面上。
// 已有凭据/机器时协议进程会静默恢复，machines 一到 workbenchReady 就是 true，这个页不出现
const showLogin = computed(() => !store.workbenchReady || store.loginOverlay)

// 布局持久化：窗口开/关/拖/缩后防抖存一份（saveLayout 里已有内容签名比对，重复状态不落盘）
let saveTimer = 0
let lastSignature = ''
function layoutSignature(): string {
  // 媒体叠也在存档里：只看图不动窗口时叠的变化也要落盘（不然重启后丢叠）
  return JSON.stringify([store.windows, store.nextZ, store.cascade, store.currentMachine, store.stackMedia])
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
  cancelAnimationFrame(parRaf)
  store.stopCastTicker()
  offWork()
  workHub.disposeAll()
})

onMounted(() => {
  // 界面主题已在 main.ts 挂载前应用（避免首帧闪系统样式）；这里只恢复布局、接协议事件
  store.restoreLayout()
  store.bindHost()
  store.startCastTicker() // 投层置顶 tick：窗口到期时抬「当前最活跃」的气泡/卡
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

// 中间桌面底部的输入台：提交作用在当前选中会话上（没选中时默认和助手开一段新的，
// 「开新会话」键显式开）；「和助手说」开着时不走会话，直接发给所连机器的助手（assistant.say）
const conversationID = computed(() => store.activeConversationID)
async function onComposerSubmit(text: string, attachments: Array<{ path: string; name: string }>) {
  if (store.assistantChat) {
    await store.assistantSay(text, attachments.map((attachment) => attachment.path))
    return
  }
  await store.submitText(text, attachments)
}
</script>

<template>
  <div class="app">
    <TitleBar />

    <!-- 桌面：三栏（会话列表 | 留白主区 | 通话+聊天）。
         气泡和操作卡投在主区随机位置；终端/文件/浏览器/子 Agent/设置都是用到时才开的浮动窗口 -->
    <div class="desktop" ref="desktopEl" @mousemove="onDesktopMove">
      <!-- 贾维斯深空层：漂移星野 + 流星 + 星云（最底层，面板全是玻璃能透出来） -->
      <SpaceVeil v-if="jarvis" />

      <!-- 左栏：会话列表（常驻，就这一样） -->
      <aside class="side side-left">
        <SessionList />
      </aside>

      <!-- 中间：3D 场景铺在背景上（网格地面 + 自转陀螺环，纯 CSS 不挡交互），气泡/操作卡投在它上面；
           只属于默认（跟随系统）主题——贾维斯有自己的装饰层（深空星野 + HUD + 扫描线），
           3D 场景混进去会跟它们叠影打架；
           媒体叠（看图/看视频成功归档，图片一叠视频一叠）压在最底层，被气泡/卡/窗口盖住就点不到；
           底部居中悬浮输入台（盖过投层气泡，别被随机投下的气泡挡住打字） -->
      <section class="main-area">
        <!-- 贾维斯 HUD 挂在主区里（不挂桌面）：左右栏宽不对称（248/352），
             挂桌面上居中会相对整窗偏左半个栏差——挂主区，雷达才正对两栏之间的空白中心 -->
        <JarvisHUD v-if="jarvis" />
        <CenterScene v-if="!jarvis" />
        <DesktopMediaStacks />
        <div class="composer-dock">
          <Composer :conversation-id="conversationID" @submit="onComposerSubmit" />
        </div>
      </section>

      <!-- 右栏：视频通话铺满整栏 + 聊天叠在下半段（顶端顶到视频中点、向上渐隐），不放别的 -->
      <aside class="side side-right">
        <CallWidget />
        <div class="side-chat"><AssistantChat /></div>
      </aside>

      <!-- 桌面投层：思考/文本气泡 + 操作极简终端卡（同一层里按最近活动置顶，可点掉） -->
      <div class="cast-layer">
        <DesktopBubbles />
        <DesktopOps />
      </div>

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
          :plain-chrome="item.kind === 'terminals'"
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

    <!-- ask_user 置顶提问浮层：有待答的问题时弹在屏幕正中间、窗口系统级置顶，没了收起 -->
    <AskOverlay />

    <!-- 媒体灯箱：叠里点单张图片放大 / 视频大窗播放（盖过登录页，Esc/点背景关） -->
    <MediaLightbox />

    <!-- 桌面更新浮层：自动更新管线把进度直接摆到桌面右下角（下载进度/倒计时/安装中） -->
    <UpdateOverlay />

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

/* 输入台：悬浮在主区底部居中，浮在 3D 场景和媒体叠之上。
   z-index 45：盖过投层气泡（cast-layer z-40，别被随机投下的气泡挡住打字）；
   浮动窗口 z 从 10 起随交互递增，压过它就盖住它，符合「窗口在最上层」的直觉 */
.composer-dock {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  width: min(720px, calc(100% - 32px));
  z-index: 45;
  pointer-events: none; /* 停在透明空白上时让点击穿过到桌面；卡片自己再开回 */
}

.composer-dock > :deep(.composer) {
  pointer-events: auto;
}

/* ---- 右栏 ---- */
.side-right {
  grid-area: right;
  /* 聊天是覆盖层：叠在视频下半段上面，右栏自身只留视频在流内 */
  position: relative;
}

.side-chat {
  /* 聊天叠在右栏下半段：顶端从视频中点起、向上渐隐，视频从聊天底下透出来；
     栏太矮时保住 280px 最低高度（顶端略微上探越过中点） */
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  top: min(50%, calc(100% - 280px));
  z-index: 2;
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

/* 桌面投层：气泡与操作卡同层（z 在层内跨气泡/卡比较，最近活动的置顶） */
.cast-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 40;
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
