<script setup lang="ts">
// 登录页（深空科幻版）：整页只有一个二维码，登录后单机器人直连进工作台 / 多机器人列表选择。
// 视觉：3D 星空 + 透视网格地平线 + 陀螺仪轨道环，二维码卡浮在环上方，随鼠标视差倾斜；
// 连接中是一个旋转的 3D 立方体。文字极简：每个阶段一行状态 + 少量图标按钮。
import QRCode from 'qrcode'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app.js'
import Starfield from './Starfield.vue'

const store = useAppStore()
const state = computed(() => store.schat)
const bots = computed(() => state.value.bots ?? [])

const svg = ref('')
/** 正在连接的机器人（手动选的或单机器人自动连的）与它的 machineID */
const connectingBot = ref<{ id: number; name: string } | null>(null)
const connectingMachineID = ref('')
const connectError = ref('')
/** host 层直接抛的错（协议进程没起来等） */
const loginError = ref('')
/** 自动重生成二维码的次数（过期/失效自动换码，但别无限打服务器） */
let autoRetryCount = 0
let retryTimer = 0
/** 单机器人自动连接只发起一次（bots 是 online 后异步拉的，watch 会触发多次） */
let autoConnectStarted = false
/** 这次登录页是手动打开的（换账号/重新扫码）：连着的机器不得自动把它收走 */
const manualOpen = ref(store.loginOverlay)

/** 登录页界面阶段：比 schat.phase 多出「选机器人 / 正在连接」两步 */
const stage = computed<'qr' | 'restoring' | 'error' | 'pick' | 'connecting'>(() => {
  if (connectingBot.value) return 'connecting'
  if (state.value.phase === 'online') return 'pick'
  if (state.value.phase === 'error') return 'error'
  if (state.value.phase === 'logging-in') return 'qr'
  return state.value.restoring ? 'restoring' : 'qr'
})

/** 正在连的那台机器的连接状态（协议进程广播 machines 时更新） */
const machineState = computed(
  () => store.machines.find((machine) => machine.id === connectingMachineID.value)?.state ?? ''
)

/** 状态行（唯一的常驻文字） */
const statusLine = computed(() => {
  if (stage.value === 'restoring') return '正在恢复上次的登录'
  if (stage.value === 'error') return state.value.error || state.value.status || '登录出错'
  if (stage.value === 'connecting') {
    if (machineState.value === 'ready') return '已连接，正在打开工作台'
    if (connectError.value) return `「${connectingBot.value?.name ?? ''}」连接失败`
    return `正在连接「${connectingBot.value?.name ?? ''}」`
  }
  if (stage.value === 'pick') {
    return bots.value.length > 1 ? '选择要连接的机器人' : bots.value.length === 1 ? '' : '好友里还没有机器人'
  }
  return state.value.status || '正在获取登录二维码'
})

async function renderQr(): Promise<void> {
  if (stage.value !== 'qr' || !state.value.qrPayload) {
    svg.value = ''
    return
  }
  svg.value = await QRCode.toString(state.value.qrPayload, { type: 'svg', margin: 1, width: 228 })
}

watch(() => [state.value.qrPayload, stage.value], () => void renderQr(), { immediate: true })

/** 生成二维码（= 开始一轮扫码登录） */
async function startLogin(): Promise<void> {
  loginError.value = ''
  connectError.value = ''
  connectingBot.value = null
  connectingMachineID.value = ''
  autoConnectStarted = false
  try {
    await store.schatLogin()
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : String(error)
  }
}

// MARK: 鼠标视差（rAF 插值，场景绕 X/Y 轴微倾）

const rootEl = ref<HTMLElement | null>(null)
const assemblyEl = ref<HTMLElement | null>(null)
let pointerX = 0
let pointerY = 0
let tiltX = 0
let tiltY = 0
let parallaxRaf = 0

function onPointerMove(event: MouseEvent): void {
  const rect = rootEl.value?.getBoundingClientRect()
  if (!rect) return
  pointerX = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2))
  pointerY = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2))
}

function parallaxTick(): void {
  tiltX += (pointerX - tiltX) * 0.06
  tiltY += (pointerY - tiltY) * 0.06
  assemblyEl.value?.style.setProperty('--px', tiltX.toFixed(4))
  assemblyEl.value?.style.setProperty('--py', tiltY.toFixed(4))
  parallaxRaf = requestAnimationFrame(parallaxTick)
}

/** Esc：从工作台打开的登录页直接退回（首次进入时没有可退的工作台，不响应） */
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && store.workbenchReady) {
    event.preventDefault() // 这次 Esc 已用来退回工作台，别再取消选中会话（App.vue）
    store.closeLogin()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  store.loginActive = true
  // 静默场景：登录页冒出来时其实已有连着的机器（窗口 reload、布局恢复）——没事可做，直接进工作台
  if (!manualOpen.value && store.machines.some((machine) => machine.state === 'ready')) {
    store.enterWorkbench()
    return
  }
  rootEl.value?.addEventListener('mousemove', onPointerMove)
  parallaxRaf = requestAnimationFrame(parallaxTick)
  // bindHost 已拉过一次；这里再拉是防协议进程稍晚恢复（窗口 reload 等）
  void store
    .schatRefresh()
    .then(() => {
      if (state.value.phase === 'idle' && !state.value.restoring) void startLogin()
    })
    .catch(() => {
      if (state.value.phase === 'idle') void startLogin()
    })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  store.loginActive = false
  rootEl.value?.removeEventListener('mousemove', onPointerMove)
  cancelAnimationFrame(parallaxRaf)
  window.clearTimeout(retryTimer)
})

// 二维码过期 / 凭据失效：自动换一个码（其余错误给出按钮手动重试，免得死循环）
watch(
  () => state.value.error,
  (message) => {
    if (state.value.phase !== 'error' || !message) return
    if ((message.includes('过期') || message.includes('失效')) && autoRetryCount < 5) {
      autoRetryCount += 1
      window.clearTimeout(retryTimer)
      retryTimer = window.setTimeout(() => {
        if (state.value.phase === 'error') void startLogin()
      }, 2000)
    }
  }
)

// 登录成功：只有一个机器人 → 直接连接；多个 → 列表（模板里 pick 阶段）
watch(
  () => [state.value.phase, bots.value.length] as const,
  () => {
    if (state.value.phase !== 'online' || autoConnectStarted) return
    if (bots.value.length === 1) {
      autoConnectStarted = true
      void connectBot(bots.value[0]!)
    } else {
      autoConnectStarted = true // 先看一眼列表就算「见过」了，之后加机器人不再抢连
    }
  },
  { immediate: true }
)

// 连上的机器 ready → 进工作台；failed → 报错。另外：不在连接流程中时任何机器
// 变 ready（比如存的机器自动重连成功）都算“能干活了”，直接收登录页（手动打开的除外）
watch(machineState, (value) => {
  if (!connectingMachineID.value || !value) return
  if (value === 'ready') {
    store.enterWorkbench()
  } else if (value === 'failed' || value === 'versionMismatch' || value === 'disconnected') {
    const detail = store.machines.find((machine) => machine.id === connectingMachineID.value)?.detail ?? ''
    connectError.value = detail || (value === 'versionMismatch' ? '两端版本不匹配' : '连接失败')
  }
})

watch(
  () => store.machines.map((machine) => machine.state).join(','),
  () => {
    if (manualOpen.value || connectingBot.value) return
    if (store.machines.some((machine) => machine.state === 'ready')) store.enterWorkbench()
  },
  { immediate: true }
)

async function connectBot(bot: { id: number; name: string }): Promise<void> {
  connectError.value = ''
  connectingBot.value = bot
  try {
    connectingMachineID.value = await store.connectWork(bot.id, bot.name)
  } catch (error) {
    connectError.value = error instanceof Error ? error.message : String(error)
    connectingBot.value = null
  }
}

function retryConnect(): void {
  const bot = connectingBot.value
  if (bot) {
    connectingBot.value = null
    void connectBot(bot)
  }
}

function backToPick(): void {
  connectingBot.value = null
  connectingMachineID.value = ''
  connectError.value = ''
}

async function switchAccount(): Promise<void> {
  autoRetryCount = 0
  connectError.value = ''
  connectingBot.value = null
  connectingMachineID.value = ''
  await store.schatDisconnect()
  await startLogin()
}
</script>

<template>
  <div ref="rootEl" class="login-view" data-testid="login-card">
    <!-- 背景层：深空 + 3D 星空 + 透视网格地平线 + 暗角 -->
    <div class="space" />
    <Starfield class="stars" />
    <div class="grid-floor" />
    <div class="vignette" />

    <!-- 从工作台里手动打开（换账号 / 扫码连新机器）时可以随时退回去：store.closeLogin 原来没有任何入口调用，
         打开了就只能连上一台机器才能出来。首次进入（还没有工作台）不显示 -->
    <button v-if="store.workbenchReady" class="back-btn" title="返回工作台（Esc）" @click="store.closeLogin()">
      返回工作台 <span class="back-x">✕</span>
    </button>
    <i class="hud-frame tl" /><i class="hud-frame tr" /><i class="hud-frame bl" /><i class="hud-frame br" />

    <div class="brand-hud">FRIDAY · WORK</div>

    <!-- 中央 3D 场景：陀螺仪轨道环 + 浮起的内容卡 -->
    <div class="scene">
      <div ref="assemblyEl" class="assembly">
        <div class="gyro">
          <div class="orbit o1"><i class="ring" /><i class="dot" /></div>
          <div class="orbit o2"><i class="ring" /><i class="dot" /></div>
          <div class="orbit o3"><i class="ring" /><i class="dot" /></div>
        </div>

        <!-- 二维码：唯一的主体 -->
        <div v-if="stage === 'qr'" class="float" data-testid="login-qr">
          <div class="holo-card" :class="{ dim: !state.qrPayload }">
            <div v-if="svg" class="qr" v-html="svg" />
            <div v-else class="core-pulse" />
            <i class="scanline" />
          </div>
        </div>

        <!-- 恢复上次登录 -->
        <div v-else-if="stage === 'restoring'" class="float" data-testid="login-restoring">
          <div class="stage-block"><div class="cube"><i /><i /><i /><i /><i /><i /></div></div>
        </div>

        <!-- 登录出错 -->
        <div v-else-if="stage === 'error'" class="float" data-testid="login-error">
          <div class="stage-block"><div class="alert-glyph">!</div></div>
        </div>

        <!-- 多机器人：全息列表 -->
        <div v-else-if="stage === 'pick' && bots.length > 1" class="float" data-testid="login-pick">
          <div class="holo-panel">
            <button
              v-for="(bot, index) in bots"
              :key="bot.id"
              class="bot-row"
              :data-bot-id="bot.id"
              :style="{ animationDelay: `${index * 70}ms` }"
              @click="connectBot(bot)"
            >
              <span class="bot-dot" />
              <span class="bot-name">{{ bot.name }}</span>
              <span v-if="bot.botCalls" class="bot-call" title="支持语音通话">📞</span>
              <span class="go">→</span>
            </button>
          </div>
        </div>

        <!-- 登录成功但没有机器人好友 -->
        <div v-else-if="stage === 'pick'" class="float" data-testid="login-nobots">
          <div class="stage-block"><div class="alert-glyph dim-glyph">∅</div></div>
        </div>

        <!-- 正在连接选中的机器人 -->
        <div v-else class="float" data-testid="login-connecting">
          <div class="stage-block" :class="{ ok: machineState === 'ready' }">
            <div v-if="machineState === 'ready'" class="core-pulse big" />
            <div v-else class="cube"><i /><i /><i /><i /><i /><i /></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 状态行：唯一的常驻文字 -->
    <div class="status-bar">
      <div class="hud-line">
        <span class="prefix">▸</span>
        {{ statusLine || ' ' }}
        <span class="cursor">▌</span>
      </div>
      <div v-if="loginError || connectError" class="err-line">{{ loginError || connectError }}</div>

      <div class="controls">
        <template v-if="stage === 'qr'">
          <button class="icon-btn" title="换一个码" @click="startLogin">⟳</button>
        </template>
        <template v-else-if="stage === 'error'">
          <button class="text-btn" @click="startLogin">重新生成二维码</button>
          <button v-if="state.userId" class="icon-btn" title="换个账号" @click="switchAccount">⇄</button>
        </template>
        <template v-else-if="stage === 'pick'">
          <button class="icon-btn" title="刷新机器人列表" @click="store.schatRefreshBots()">⟳</button>
          <button class="icon-btn" title="换个账号" @click="switchAccount">⇄</button>
        </template>
        <template v-else-if="stage === 'connecting'">
          <template v-if="connectError">
            <button class="text-btn" @click="retryConnect">重试</button>
            <button v-if="bots.length > 1" class="text-btn" @click="backToPick">重新选择</button>
          </template>
          <button v-else-if="machineState !== 'ready'" class="text-btn" @click="backToPick">返回</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-view {
  position: absolute;
  /* 留出标题栏：窗口拖动/最小化/关闭还要用 */
  top: 44px;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 深空底：登录页无论应用什么主题都走这一套 */
  background:
    radial-gradient(ellipse 55% 40% at 50% 34%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 70%),
    radial-gradient(ellipse 120% 80% at 50% 115%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 60%),
    #04070e;
  color: var(--text);
  cursor: default;
}

/* 背景层 */
.space {
  position: absolute;
  inset: 0;
}

.stars {
  position: absolute;
  inset: 0;
  opacity: 0.9;
}

/* 透视网格地平线（3D 地面） */
.grid-floor {
  position: absolute;
  left: -55%;
  right: -55%;
  bottom: -14%;
  height: 52%;
  background-image:
    linear-gradient(color-mix(in srgb, var(--accent) 26%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 26%, transparent) 1px, transparent 1px);
  background-size: 54px 54px;
  transform: perspective(620px) rotateX(63deg);
  transform-origin: 50% 100%;
  animation: grid-scroll 6.5s linear infinite;
  opacity: 0.34;
  -webkit-mask-image: radial-gradient(ellipse 62% 92% at 50% 100%, #000 34%, transparent 76%);
  mask-image: radial-gradient(ellipse 62% 92% at 50% 100%, #000 34%, transparent 76%);
  pointer-events: none;
}

.grid-floor::before {
  content: '';
  position: absolute;
  top: 0;
  left: 14%;
  right: 14%;
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 55%, transparent), transparent);
}

@keyframes grid-scroll {
  from {
    background-position: 0 54px, 0 0;
  }
  to {
    background-position: 0 0, 0 0;
  }
}

.vignette {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse 90% 80% at 50% 45%, transparent 55%, rgba(0, 0, 0, 0.55));
  pointer-events: none;
}

/* HUD 四角框 */
.hud-frame {
  position: absolute;
  width: 26px;
  height: 26px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  opacity: 0.5;
  pointer-events: none;
}

.hud-frame.tl {
  top: 14px;
  left: 16px;
  border-right: none;
  border-bottom: none;
}

.hud-frame.tr {
  top: 14px;
  right: 16px;
  border-left: none;
  border-bottom: none;
}

.hud-frame.bl {
  bottom: 14px;
  left: 16px;
  border-right: none;
  border-top: none;
}

.hud-frame.br {
  bottom: 14px;
  right: 16px;
  border-left: none;
  border-top: none;
}

.brand-hud {
  position: absolute;
  top: 20px;
  left: 58px;
  font-family: var(--font-hud, 'Cascadia Code', Consolas, monospace);
  font-size: 11px;
  letter-spacing: 4px;
  color: color-mix(in srgb, var(--accent) 80%, #fff 10%);
  text-shadow: 0 0 12px color-mix(in srgb, var(--accent) 45%, transparent);
  pointer-events: none;
}

/* 返回工作台（右上角，和左上角的 HUD 铭牌对称） */
.back-btn {
  position: absolute;
  top: 14px;
  right: 22px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: color-mix(in srgb, var(--accent) 85%, #fff 10%);
  font-family: var(--font-hud, 'Cascadia Code', Consolas, monospace);
  font-size: 11px;
  letter-spacing: 2px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}

.back-btn:hover {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-color: color-mix(in srgb, var(--accent) 65%, transparent);
  box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 30%, transparent);
}

.back-x {
  font-size: 10px;
  opacity: 0.8;
}

/* 中央 3D 场景 */
.scene {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  perspective: 1100px;
  animation: materialize 0.8s cubic-bezier(0.2, 0.7, 0.3, 1) both;
}

@keyframes materialize {
  from {
    opacity: 0;
    transform: scale(0.92);
    filter: blur(6px);
  }
  to {
    opacity: 1;
    transform: scale(1);
    filter: blur(0);
  }
}

.assembly {
  position: relative;
  width: 430px;
  height: 430px;
  transform-style: preserve-3d;
  transform: rotateY(calc(var(--px, 0) * 7deg)) rotateX(calc(var(--py, 0) * -7deg));
}

/* 陀螺仪轨道环（三条不同平面的 3D 圆轨 + 轨道点） */
.gyro {
  position: absolute;
  inset: 0;
  transform-style: preserve-3d;
  pointer-events: none;
}

.orbit {
  position: absolute;
  width: var(--d);
  height: var(--d);
  left: calc(50% - var(--d) / 2);
  top: calc(50% - var(--d) / 2);
  transform-style: preserve-3d;
}

.orbit.o1 {
  --d: 416px;
  animation: orbit-a 19s linear infinite;
}

.orbit.o2 {
  --d: 360px;
  animation: orbit-b 25s linear infinite reverse;
}

.orbit.o3 {
  --d: 306px;
  animation: orbit-c 15s linear infinite;
}

.ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--accent) 38%, transparent);
  box-shadow: 0 0 18px color-mix(in srgb, var(--accent) 12%, transparent), inset 0 0 18px color-mix(in srgb, var(--accent) 8%, transparent);
}

.dot {
  position: absolute;
  top: -3.5px;
  left: 50%;
  width: 7px;
  height: 7px;
  margin-left: -3.5px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 80%, transparent), 0 0 22px color-mix(in srgb, var(--accent) 45%, transparent);
}

@keyframes orbit-a {
  from {
    transform: rotateX(68deg) rotateZ(0deg);
  }
  to {
    transform: rotateX(68deg) rotateZ(360deg);
  }
}

@keyframes orbit-b {
  from {
    transform: rotateY(66deg) rotateZ(0deg);
  }
  to {
    transform: rotateY(66deg) rotateZ(360deg);
  }
}

@keyframes orbit-c {
  from {
    transform: rotateX(68deg) rotateY(58deg) rotateZ(0deg);
  }
  to {
    transform: rotateX(68deg) rotateY(58deg) rotateZ(360deg);
  }
}

/* 浮起的内容（二维码卡 / 列表 / 立方体）：translateZ 拉出环面 + 上下浮动 */
.float {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transform-style: preserve-3d;
  animation: float-y 5.5s ease-in-out infinite;
}

@keyframes float-y {
  0%,
  100% {
    transform: translate3d(0, -6px, 56px);
  }
  50% {
    transform: translate3d(0, 6px, 56px);
  }
}

/* 全息卡：二维码 */
.holo-card {
  position: relative;
  width: 264px;
  height: 264px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent);
  border-radius: 18px;
  background:
    linear-gradient(color-mix(in srgb, var(--accent) 5%, transparent), color-mix(in srgb, var(--accent) 2%, transparent)),
    rgba(6, 12, 22, 0.72);
  backdrop-filter: blur(6px);
  box-shadow:
    0 0 34px color-mix(in srgb, var(--accent) 16%, transparent),
    inset 0 0 26px color-mix(in srgb, var(--accent) 6%, transparent);
  transition: opacity 0.3s;
}

.holo-card.dim {
  opacity: 0.55;
}

.qr :deep(svg) {
  width: 228px;
  height: 228px;
  border-radius: 8px;
}

/* 没有码时的核心脉冲 */
.core-pulse {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
  box-shadow: 0 0 30px color-mix(in srgb, var(--accent) 35%, transparent);
  animation: pulse 1.6s ease-in-out infinite;
}

.core-pulse.big {
  width: 84px;
  height: 84px;
  background: color-mix(in srgb, var(--ok, #34d399) 20%, transparent);
  border-color: color-mix(in srgb, var(--ok, #34d399) 65%, transparent);
  box-shadow: 0 0 44px color-mix(in srgb, var(--ok, #34d399) 40%, transparent);
}

@keyframes pulse {
  50% {
    transform: scale(1.16);
    opacity: 0.7;
  }
}

/* 扫描线 */
.scanline {
  position: absolute;
  left: 7%;
  width: 86%;
  height: 2px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 85%, transparent), transparent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 60%, transparent);
  animation: scan 2.9s ease-in-out infinite;
}

@keyframes scan {
  0% {
    top: 5%;
    opacity: 0;
  }
  12% {
    opacity: 1;
  }
  88% {
    opacity: 1;
  }
  100% {
    top: 94%;
    opacity: 0;
  }
}

/* 全息列表：选机器人 */
.holo-panel {
  width: 330px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: 18px;
  background: rgba(6, 12, 22, 0.74);
  backdrop-filter: blur(8px);
  box-shadow: 0 0 34px color-mix(in srgb, var(--accent) 13%, transparent);
}

.bot-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
  border-radius: 11px;
  background: linear-gradient(color-mix(in srgb, var(--accent) 4%, transparent), transparent);
  color: var(--text);
  font-size: 13.5px;
  cursor: pointer;
  text-align: left;
  animation: row-in 0.45s cubic-bezier(0.2, 0.7, 0.3, 1) both;
  transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.bot-row:hover {
  border-color: color-mix(in srgb, var(--accent) 70%, transparent);
  box-shadow: 0 0 20px color-mix(in srgb, var(--accent) 22%, transparent);
  transform: translateY(-1px);
}

@keyframes row-in {
  from {
    opacity: 0;
    transform: translateZ(-60px) translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateZ(0) translateY(0);
  }
}

.bot-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 70%, transparent);
}

.bot-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-call {
  font-size: 12.5px;
  opacity: 0.85;
}

.go {
  color: var(--accent);
  font-size: 15px;
  text-shadow: 0 0 10px color-mix(in srgb, var(--accent) 60%, transparent);
}

/* 阶段块（立方体 / 提示图形） */
.stage-block {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 264px;
  height: 264px;
}

.stage-block.ok .cube {
  display: none;
}

/* 3D 旋转立方体（连接中） */
.cube {
  position: relative;
  width: 58px;
  height: 58px;
  transform-style: preserve-3d;
  animation: cube-spin 7s linear infinite;
}

.cube i {
  position: absolute;
  inset: 0;
  border: 1px solid color-mix(in srgb, var(--accent) 65%, transparent);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 18%, transparent) inset;
}

.cube i:nth-child(1) { transform: rotateY(0deg) translateZ(29px); }
.cube i:nth-child(2) { transform: rotateY(90deg) translateZ(29px); }
.cube i:nth-child(3) { transform: rotateY(180deg) translateZ(29px); }
.cube i:nth-child(4) { transform: rotateY(270deg) translateZ(29px); }
.cube i:nth-child(5) { transform: rotateX(90deg) translateZ(29px); }
.cube i:nth-child(6) { transform: rotateX(-90deg) translateZ(29px); }

@keyframes cube-spin {
  from {
    transform: rotateX(-22deg) rotateY(0deg);
  }
  to {
    transform: rotateX(-22deg) rotateY(360deg);
  }
}

/* 出错 / 空态图形 */
.alert-glyph {
  width: 84px;
  height: 84px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--fail, #fb5f7d) 60%, transparent);
  border-radius: 50%;
  color: var(--fail, #fb5f7d);
  font-size: 40px;
  font-weight: 700;
  font-family: var(--font-hud, Consolas, monospace);
  text-shadow: 0 0 18px color-mix(in srgb, var(--fail, #fb5f7d) 60%, transparent);
  box-shadow: 0 0 30px color-mix(in srgb, var(--fail, #fb5f7d) 20%, transparent);
  animation: pulse 1.8s ease-in-out infinite;
}

.alert-glyph.dim-glyph {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  color: color-mix(in srgb, var(--accent) 80%, #fff);
  text-shadow: 0 0 18px color-mix(in srgb, var(--accent) 50%, transparent);
  box-shadow: 0 0 30px color-mix(in srgb, var(--accent) 14%, transparent);
}

/* 底部状态条 */
.status-bar {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 0 20px 7vh;
}

.hud-line {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 620px;
  font-family: var(--font-hud, 'Cascadia Code', Consolas, monospace);
  font-size: 12.5px;
  letter-spacing: 1.5px;
  color: color-mix(in srgb, var(--text) 88%, var(--accent));
  text-shadow: 0 0 14px color-mix(in srgb, var(--accent) 22%, transparent);
  white-space: nowrap;
  overflow: hidden;
}

.hud-line .prefix {
  color: var(--accent);
  text-shadow: 0 0 10px color-mix(in srgb, var(--accent) 70%, transparent);
}

.hud-line .cursor {
  color: var(--accent);
  animation: blink 1.1s steps(1) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

.err-line {
  max-width: 620px;
  font-size: 11.5px;
  color: var(--fail, #fb5f7d);
  opacity: 0.85;
  text-align: center;
}

.controls {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
}

.icon-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--accent) 38%, transparent);
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: color-mix(in srgb, var(--accent) 90%, #fff);
  font-size: 15px;
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s, transform 0.15s;
}

.icon-btn:hover {
  border-color: var(--accent);
  box-shadow: 0 0 18px color-mix(in srgb, var(--accent) 35%, transparent);
  transform: translateY(-1px);
}

.text-btn {
  padding: 7px 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: color-mix(in srgb, var(--accent) 88%, #fff);
  font-size: 12.5px;
  letter-spacing: 1px;
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;
}

.text-btn:hover {
  border-color: var(--accent);
  box-shadow: 0 0 18px color-mix(in srgb, var(--accent) 35%, transparent);
}

/* 减少动态：系统开了「减少动态效果」就停掉所有装饰动画 */
@media (prefers-reduced-motion: reduce) {
  .scene,
  .float,
  .orbit,
  .scanline,
  .cube,
  .core-pulse,
  .alert-glyph,
  .grid-floor,
  .hud-line .cursor,
  .bot-row {
    animation: none;
  }
}
</style>
