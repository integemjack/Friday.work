<script setup lang="ts">
// 桌面（2026-10 布局改版第二期）：不再有会话/语音/机器人聊天/助手时间线/活动总览/机器与会话窗口——
//   左栏   ：会话列表（常驻）+ 文件面板（会话用到才展开，可折叠）
//   中间   ：桌面主区（气泡 / 操作卡投在这里的随机位置）+ 底部终端面板
//   右栏   ：与助手聊天（默认占满整栏）；拨打视频/语音时顶部让出 1/3 给通话面板、聊天缩到 2/3
// 会话的思考/文本以气泡投在桌面随机处（5 秒渐隐）；操作以极简终端卡投在桌面（有结果 5 秒后渐隐）。
// 剩下的浮动窗口只有子 Agent / 设置，入口在标题栏。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { WindowKind } from './stores/app.js'
import { saveLayout, useAppStore } from './stores/app.js'
import { uiTheme } from './lib/theme.js'
import { host } from './lib/host.js'
import { WorkChannelHub, type WorkSignalIn } from './lib/workChannel.js'
import { deviceBroker } from './lib/devices/broker.js'
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
import DeviceOverlay from './components/DeviceOverlay.vue'
import CenterScene from './components/CenterScene.vue'
import VoiceHud from './components/VoiceHud.vue'
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

// 客户端设备（方案-客户端设备）：服务端的 device.* 请求（串口 / 本机烧录 / 摄像头）在这里处理，
// 串口会话的专用 DataChannel 开在上面这条工作连接上
deviceBroker.attach(workHub, (machineID) => store.machines.find((machine) => machine.id === machineID)?.name ?? '远端机器')
const offDevice = host.onDevice((message) => deviceBroker.handle(message))

// 贾维斯界面开着才挂桌面 HUD（雷达/时钟/连接状态）和深空层（星野/流星）
const jarvis = computed(() => uiTheme.value === 'jarvis')

// 贾维斯：鼠标视差——鼠标在桌面上的位置归一化成 --par-x/--par-y（-1..1），
// rAF 里插值逼近后写回 CSS 变量；深空层 / HUD 各自按变量反向/正向小幅偏移。
// 变量只写到用它的元素上（带 data-parallax 的根，base.css 里 @property 声明为不继承）：
// 写在 .desktop 上时每帧都会让整棵桌面子树（会话列表、聊天、几千个节点）重算样式。
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
  const x = parNow.x.toFixed(4)
  const y = parNow.y.toFixed(4)
  for (const target of el.querySelectorAll<HTMLElement>('[data-parallax]')) {
    target.style.setProperty('--par-x', x)
    target.style.setProperty('--par-y', y)
  }
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
  offDevice()
  workHub.disposeAll()
})

onMounted(() => {
  // 界面主题已在 main.ts 挂载前应用（避免首帧闪系统样式）；这里只恢复布局、接协议事件
  store.restoreLayout()
  store.bindHost()
  store.startCastTicker() // 投层置顶 tick：窗口到期时抬「当前最活跃」的气泡/卡
})

// 只盯布局相关的几个字段（签名串变了才排一次保存）。不能用 store.$subscribe：它是对整个
// store state 的 deep watch，流式增量 / machines 事件每改一次就把含会话详情的整棵树遍历一遍
// （实测单次 12-15ms，HMR 后 detached 订阅还会叠加，dev 下每次变动 ~77ms，界面一顿一顿）
watch(layoutSignature, () => scheduleLayoutSave())

const componentFor: Record<WindowKind, unknown> = {
  terminals: TerminalCard,
  files: FilesCard,
  browser: BrowserCard,
  agents: AgentsCard,
  settings: SettingsWindow
}

const sizeLimits: Record<WindowKind, { minWidth: number; minHeight: number }> = {
  terminals: { minWidth: 420, minHeight: 260 },
  files: { minWidth: 480, minHeight: 320 },
  browser: { minWidth: 420, minHeight: 320 },
  agents: { minWidth: 360, minHeight: 240 },
  settings: { minWidth: 420, minHeight: 320 }
}

// 中间桌面底部的输入台：提交作用在当前选中会话上（没选中时默认和助手开一段新的，
// 「开新会话」键显式开）；「和助手说」开着时不走会话，直接发给所连机器的助手（assistant.say）
const conversationID = computed(() => store.activeConversationID)
async function onComposerSubmit(text: string, attachments: Array<{ path: string; name: string }>) {
  // 没连机器时 store 的提交是静默 return：在这里抛出来，输入台保留原文并提示
  if (!store.currentMachine) throw new Error('还没连上机器')
  if (store.assistantChat) {
    await store.assistantSay(text, attachments.map((attachment) => attachment.path))
    return
  }
  await store.submitText(text, attachments)
}

// 全局错误横幅：8 秒后自己收起（换了新错误重新计时；鼠标停在上面时不收，读完再走）。
// 原来只能点掉——偶发的瞬时错误会一直挂在桌面底部
let errorTimer = 0
const errorHover = ref(false)
function scheduleErrorDismiss(): void {
  window.clearTimeout(errorTimer)
  if (!store.error) return
  errorTimer = window.setTimeout(() => {
    if (errorHover.value) scheduleErrorDismiss()
    else store.error = ''
  }, 8000)
}
watch(() => store.error, scheduleErrorDismiss)
onBeforeUnmount(() => window.clearTimeout(errorTimer))

// Esc 取消选中会话：回到默认态（聊天栏显示「新对话」，输入台发出去就开一段新的）；只取消选中，不退订——
// 后台的流式气泡 / 播报照常。别的东西先吃掉这次 Esc 的（灯箱、登录页、机器菜单、命令菜单、停录音…
// 它们都会 preventDefault）就不再取消选中；判断放到下一个任务里做，晚注册的监听也来得及标记。
// 在输入框里按 Esc 不算，除非是输入台且里面没字（有字时取消选中会让正在写的这条发到新会话去）。
function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.repeat) return
  const target = event.target as HTMLElement | null
  const editable = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  if (editable) {
    const inComposer = target!.tagName === 'TEXTAREA' && !!target!.closest('.composer-card')
    if (!inComposer || (target as HTMLTextAreaElement).value.trim()) return
  }
  window.setTimeout(() => {
    if (event.defaultPrevented) return
    if (showLogin.value || store.zoomMedia || store.assistantChat || !store.activeConversationID) return
    store.activeConversationID = ''
  })
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))

// 文件拖到没有接拖放的地方（桌面、聊天栏…）时什么也不做：Electron 默认会把整个窗口导航到那个文件，
// 应用当场被替换成一张文件预览（状态全丢）。输入台 / 文件管理器 / 设置的音色区有自己的投放处理，元素上先处理掉
function blockStrayDrop(event: DragEvent): void {
  if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return
  // 元素自己接了（preventDefault 过）的不动它的光标；没人接的显示「不能放」
  const handled = event.defaultPrevented
  event.preventDefault()
  if (event.type === 'dragover' && event.dataTransfer && !handled) event.dataTransfer.dropEffect = 'none'
}
onMounted(() => {
  window.addEventListener('dragover', blockStrayDrop)
  window.addEventListener('drop', blockStrayDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener('dragover', blockStrayDrop)
  window.removeEventListener('drop', blockStrayDrop)
})

// 通话中（来电/呼出/接通中/通话中）：右栏顶部给通话面板让出 1/3、聊天缩到 2/3；空闲时聊天占满整栏
const calling = computed(() => store.calling)
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
        <!-- 语音 HUD：TTS 实时波形 + 静音 + 音量，顶部居中（功能件，两主题都挂，不是装饰） -->
        <VoiceHud />
        <DesktopMediaStacks />
        <div class="composer-dock">
          <Composer :conversation-id="conversationID" @submit="onComposerSubmit" />
        </div>
      </section>

      <!-- 右栏：与助手聊天默认占满整栏；拨打视频/语音时（calling）顶部 1/3 通话面板 + 底部 2/3 聊天 -->
      <aside class="side side-right" :class="{ calling }">
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
    <DeviceOverlay />

    <!-- 全局错误横幅 -->
    <div
      v-if="store.error"
      class="error-toast"
      @click="store.error = ''"
      @mouseenter="errorHover = true"
      @mouseleave="errorHover = false"
    >
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
  /* 定位：给贾维斯导轨伪元素作参照；顺带让两栏绘制在深空层（z-index 0）之上，星点不再压在正文上 */
  position: relative;
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
  /* size 容器：贾维斯 HUD 按主区的实际宽高（cqw/cqh + @container main）缩放、收起遥测栏 */
  container: main / size;
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

/* ---- 右栏：聊天默认占满整栏；通话时（calling）顶部 1/3 通话面板 + 底部 2/3 聊天 ---- */
.side-right {
  grid-area: right;
}

/* 聊天占份数可过渡：空闲 1 份 = 整栏，通话时 2 份（对面通话面板 1 份）= 下 2/3 */
.side-chat {
  flex: 1 1 0;
  min-height: 0;
  transition: flex-grow 0.25s ease;
}

/* 通话面板（CallWidget 根元素，v-show 控制）：只在通话中占位，收起时 display:none 不留空 */
.side-right.calling :deep(.call-widget) {
  flex: 1 1 0;
  min-height: 0;
}

.side-right.calling .side-chat {
  flex-grow: 2;
}

/* 小屏（窗口宽 < 1100px）：收起左右两栏，中间桌面占满。只用 display 藏、组件不卸载
   （会话订阅、聊天草稿、播报都还在）。通话中例外：右栏的通话面板是唯一的挂断/静音入口，照常让出右栏 */
@media (max-width: 1099px) {
  .desktop {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'main';
  }

  .side {
    display: none;
  }

  .desktop:has(.side-right.calling) {
    grid-template-columns: minmax(0, 1fr) 352px;
    grid-template-areas: 'main right';
  }

  .side-right.calling {
    display: flex;
  }
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

/* 浮动窗口层：铺满桌面。z-index 50 压过语音波形屏 / 输入台（45）和投层（40）：
   窗口自己的 z 从 10 起随交互递增，原来新开的窗口标题栏会被顶部的波形屏盖住；
   层内各窗口仍按自己的 z 互相叠放 */
.windows-layer {
  position: absolute;
  inset: 0;
  z-index: 50;
  pointer-events: none;
}

.windows-layer > * {
  pointer-events: auto;
}

/* 贾维斯界面：桌面底纹去掉点阵/平面网格（网格只留在 HUD 的 3D 地面上，平铺满屏的网格是噪音），
   只剩中央一团辉光把视线收到全息舞台；欢迎语带发光 */
[data-theme='jarvis'] .desktop {
  background-color: var(--bg);
  background-image: radial-gradient(ellipse 55% 50% at 50% 46%, var(--accent-a10), transparent 70%);
  background-size: auto;
}

[data-theme='jarvis'] .desktop-title {
  color: var(--accent);
  letter-spacing: 4px;
  text-shadow: 0 0 18px var(--accent-a55);
  text-transform: uppercase;
}

/* 贾维斯：两侧栏内缘的 HUD 导轨（栏间 8px 缝正中一道竖向发丝线，上下渐隐），
   把中间舞台框出来；两栏本身仍然无卡片壳、融在桌面上 */
[data-theme='jarvis'] .side-left::after,
[data-theme='jarvis'] .side-right::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 7px;
  pointer-events: none;
  background: linear-gradient(var(--accent-a30), var(--accent-a30)) center / 1px 100% no-repeat;
  -webkit-mask-image: linear-gradient(180deg, transparent 2%, #000 24%, #000 76%, transparent 98%);
  mask-image: linear-gradient(180deg, transparent 2%, #000 24%, #000 76%, transparent 98%);
  opacity: 0.6;
}

[data-theme='jarvis'] .side-left::after {
  right: -7.5px;
}

[data-theme='jarvis'] .side-right::before {
  left: -7.5px;
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

/* 贾维斯：一条扫描线周期性扫过中间主区（只扫 HUD 舞台：扫过两侧会话列表/聊天栏时会把正文刷亮一道，
   读着晃眼，而且每帧都逼两栏里的磨砂层重算模糊） */
[data-theme='jarvis'] .main-area::after {
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
  /* 两端渐隐：光带从舞台中间亮起、到两侧栏边缘前收掉，不切出硬边 */
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
  animation: jarvis-scan 8s linear infinite;
  will-change: transform;
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

/* 贾维斯：错误横幅改成深色全息条 + 红色描边辉光（实底大红块和整套 HUD 不搭） */
[data-theme='jarvis'] .error-toast {
  background: var(--panel-card-deep-a92);
  color: #ffd2db;
  border: 1px solid var(--fail-a60);
  box-shadow:
    0 0 18px var(--fail-a35),
    0 10px 28px rgba(0, 0, 0, 0.5);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  font-family: var(--font-hud);
  letter-spacing: 0.5px;
}
</style>
