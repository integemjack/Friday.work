<script setup lang="ts">
// 贾维斯 HUD：桌面中央的全息雷达。多层旋转环 + 雷达扫描 + 反应堆核心 + 两侧真实遥测。
// 不是纯装饰：遥测栏和状态行显示真实数据——FPS（实测）、JS 堆内存、运行时长、CPU 核数、
// 时区、日期、机器连接状态、窗口数、待确认数、实时时钟；底部 hex 是装饰性数据流。
// 随鼠标做 3D 视差倾斜（--par-x/--par-y 由 App.vue 下发，rAF 已插值）。
// 只在「贾维斯界面」下挂载（App.vue 里 v-if="jarvis"），别的主题不渲染、零开销。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()

const pad = (n: number): string => String(n).padStart(2, '0')

// ---- 心跳：每秒刷新时钟 / 运行时长 / 内存 / 日期 ----
const now = ref('')
const uptime = ref('00:00')
const memText = ref('--')
const dateText = ref('')
let timer = 0
const bootedAt = Date.now()

function readMem(): string {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  if (!memory) return 'N/A'
  return `${Math.round(memory.usedJSHeapSize / 1048576)}M`
}

function tick(): void {
  const d = new Date()
  now.value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const up = Math.floor((Date.now() - bootedAt) / 1000)
  uptime.value = up >= 3600 ? `${Math.floor(up / 3600)}:${pad(Math.floor((up % 3600) / 60))}:${pad(up % 60)}` : `${pad(Math.floor(up / 60))}:${pad(up % 60)}`
  memText.value = readMem()
  if (!dateText.value) {
    const week = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()]
    dateText.value = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${week}`
  }
}

// ---- FPS：rAF 计帧，每 500ms 结算一次（真实测量） ----
const fps = ref(0)
let fpsRaf = 0
let fpsFrames = 0
let fpsLast = 0
function fpsLoop(now: number): void {
  fpsRaf = requestAnimationFrame(fpsLoop)
  fpsFrames += 1
  if (now - fpsLast >= 500) {
    fps.value = Math.round((fpsFrames * 1000) / (now - fpsLast))
    fpsFrames = 0
    fpsLast = now
  }
}

// ---- 装饰性 hex 数据流（HUD 味，低频刷新） ----
const hexLine = ref('')
let hexTimer = 0
function rollHex(): void {
  const bytes: string[] = []
  for (let i = 0; i < 22; i += 1) bytes.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase())
  hexLine.value = bytes.join(' ')
}

// 静态遥测：CPU 核数 / 时区
const coreText = `${navigator.hardwareConcurrency || '?'}x`
const tzText = computed(() => {
  const offset = -new Date().getTimezoneOffset() / 60
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `UTC${sign}${Number.isInteger(abs) ? abs : abs.toFixed(1)}`
})

// 连接状态（和任务栏同一份 state，换成 HUD 味的英文短语；0.3 起只剩这几种）
const stateText: Record<string, string> = {
  disconnected: 'OFFLINE',
  connecting: 'LINKING',
  ready: 'LINK READY',
  failed: 'LINK FAILED',
  versionMismatch: 'VER MISMATCH'
}
const linkText = computed(() => {
  const info = store.currentMachineInfo
  return info ? (stateText[info.state] ?? info.state) : 'STANDBY'
})
const linkReady = computed(() => store.currentMachineInfo?.state === 'ready')
const winText = computed(() => `WIN ${String(store.windows.length).padStart(2, '0')}`)

// 外圈 60 根刻度线（每 5 根一根长的），几何在这里算好，模板只管画
const ticks = Array.from({ length: 60 }, (_, i) => {
  const a = (i * 6 * Math.PI) / 180
  const long = i % 5 === 0
  const r1 = long ? 171 : 177
  return {
    x1: 200 + r1 * Math.cos(a),
    y1: 200 + r1 * Math.sin(a),
    x2: 200 + 186 * Math.cos(a),
    y2: 200 + 186 * Math.sin(a),
    long
  }
})

// 雷达环上的三个「目标点」（相位错开的闪烁）
const blips = [20, 130, 250].map((deg) => {
  const a = (deg * Math.PI) / 180
  return { x: 200 + 150 * Math.cos(a), y: 200 + 150 * Math.sin(a) }
})

onMounted(() => {
  tick()
  timer = window.setInterval(tick, 1000)
  rollHex()
  hexTimer = window.setInterval(rollHex, 420)
  fpsLast = performance.now()
  fpsRaf = requestAnimationFrame(fpsLoop)
})
onBeforeUnmount(() => {
  window.clearInterval(timer)
  window.clearInterval(hexTimer)
  cancelAnimationFrame(fpsRaf)
})
</script>

<template>
  <div class="jarvis-hud" aria-hidden="true">
    <div class="hud-top">J.A.R.V.I.S. // FRIDAY DESKTOP</div>

    <div class="hud-stage">
      <!-- 左遥测：FPS / 内存 / 运行时长（实测） -->
      <div class="telemetry">
        <div class="t-row"><span class="t-key">FPS</span><span class="t-val">{{ fps || '…' }}</span></div>
        <div class="t-row"><span class="t-key">MEM</span><span class="t-val">{{ memText }}</span></div>
        <div class="t-row"><span class="t-key">UPTIME</span><span class="t-val">{{ uptime }}</span></div>
      </div>

      <svg viewBox="0 0 400 400">
        <defs>
          <!-- 雷达扫过的扇形：从扫描边往回渐隐（颜色走令牌，见下方 CSS） -->
          <linearGradient id="hud-sweep" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stop-opacity="0.3" />
            <stop offset="1" stop-opacity="0" />
          </linearGradient>
          <!-- 核心辉光 -->
          <radialGradient id="hud-core" cx="0.5" cy="0.5" r="0.5">
            <stop class="hi" offset="0" stop-opacity="0.9" />
            <stop offset="0.55" stop-opacity="0.35" />
            <stop offset="1" stop-opacity="0" />
          </radialGradient>
        </defs>

        <!-- 最外圈双弧（50s 反向慢转） -->
        <g class="spin-outer">
          <circle cx="200" cy="200" r="193" fill="none" stroke-width="1" stroke-dasharray="420 186.3" opacity="0.26" />
        </g>

        <!-- 外圈刻度：90s 顺时针慢转 -->
        <g class="spin-slow">
          <line
            v-for="(t, i) in ticks"
            :key="i"
            :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2"
            :stroke-width="t.long ? 2 : 1"
            :opacity="t.long ? 0.75 : 0.35"
          />
        </g>

        <!-- 四段弧环：反向转 -->
        <g class="spin-rev">
          <circle cx="200" cy="200" r="160" fill="none" stroke-width="2.5" stroke-dasharray="205 46.33" opacity="0.5" />
        </g>

        <!-- 雷达外圈 + 主扫描扇形（5s 一圈）+ 回波（相位差半圈、更淡）+ 目标点 -->
        <circle cx="200" cy="200" r="150" fill="none" stroke-width="1" opacity="0.35" />
        <g class="sweep">
          <path d="M200 200 L200 50 A150 150 0 0 1 329.9 125 Z" fill="url(#hud-sweep)" />
          <line class="mid" x1="200" y1="200" x2="200" y2="50" stroke-width="1.5" opacity="0.8" />
        </g>
        <g class="sweep echo">
          <path d="M200 200 L200 50 A150 150 0 0 1 329.9 125 Z" fill="url(#hud-sweep)" opacity="0.45" />
        </g>

        <!-- 目标点 + 目标锁定括号（方框四角虚线段），与回波同步闪烁 -->
        <g v-for="(b, i) in blips" :key="i" class="blip-g" :class="`blip-${i + 1}`">
          <rect class="lock" :x="b.x - 9" :y="b.y - 9" width="18" height="18" fill="none" stroke-width="1.4" stroke-dasharray="4 12" stroke-dashoffset="2" />
          <circle class="hi blip" :cx="b.x" :cy="b.y" r="3" />
        </g>

        <!-- 中圈虚线：反向转 -->
        <g class="spin-rev-fast">
          <circle cx="200" cy="200" r="120" fill="none" stroke-width="1" stroke-dasharray="3 9" opacity="0.4" />
        </g>

        <!-- 内圈三段弧：顺时针 -->
        <g class="spin-mid">
          <circle cx="200" cy="200" r="94" fill="none" stroke-width="2" stroke-dasharray="140 56.87" opacity="0.55" />
        </g>

        <!-- 反应堆核心：辉光 + 六边形环（反转）+ 双环 + 三角，呼吸脉冲 -->
        <circle class="core-glow" cx="200" cy="200" r="58" fill="url(#hud-core)" />
        <g class="spin-hex">
          <path d="M200 152 L241.6 176 L241.6 224 L200 248 L158.4 224 L158.4 176 Z" fill="none" stroke-width="1.2" opacity="0.5" />
        </g>
        <g class="core">
          <circle class="mid" cx="200" cy="200" r="36" fill="none" stroke-width="1.5" opacity="0.85" />
          <circle cx="200" cy="200" r="24" fill="none" stroke-width="1" opacity="0.6" />
          <path class="hi" d="M200 182 L216 212 L184 212 Z" opacity="0.9" />
        </g>
      </svg>

      <!-- 右遥测：日期 / 核数 / 时区（真实） -->
      <div class="telemetry align-r">
        <div class="t-row"><span class="t-key">DATE</span><span class="t-val">{{ dateText }}</span></div>
        <div class="t-row"><span class="t-key">CORE</span><span class="t-val">{{ coreText }}</span></div>
        <div class="t-row"><span class="t-key">TZ</span><span class="t-val">{{ tzText }}</span></div>
      </div>
    </div>

    <div class="hud-data">
      <span class="d time">{{ now }}</span>
      <span class="d" :class="{ on: linkReady }">◈ {{ linkText }}</span>
      <span class="d">{{ winText }}</span>
      <span v-if="store.pendingApprovalCount" class="d warn">
        ⚠ {{ String(store.pendingApprovalCount).padStart(2, '0') }} PENDING
      </span>
    </div>

    <div class="hex-stream">RX {{ hexLine }}</div>
  </div>
</template>

<style scoped>
.jarvis-hud {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  pointer-events: none;
  z-index: 0;
  /* 鼠标视差：整个 HUD 随鼠标轻微倾斜 + 平移（变量由 App.vue rAF 插值下发） */
  transform: perspective(1200px) rotateY(calc(var(--par-x, 0) * 2.6deg)) rotateX(calc(var(--par-y, 0) * -2deg));
  translate: calc(var(--par-x, 0) * 9px) calc(var(--par-y, 0) * 7px);
  /* 开机物质化：从模糊过曝里凝聚出来 */
  animation: hud-boot 1.1s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes hud-boot {
  from {
    opacity: 0;
    filter: blur(16px) brightness(2.2);
    transform: perspective(1200px) scale(1.06);
  }
}

/* 子层交错浮现：各自的最终透明度用 --o 分层（keyframes 里的 var 按元素解析） */
.hud-top,
.hud-data,
.hex-stream,
.telemetry {
  opacity: 0;
  animation: hud-fade 0.8s ease-out 0.35s forwards;
  --o: 1;
}

.hud-top {
  --o: 0.6;
}

.hex-stream {
  --o: 0.4;
  animation-delay: 0.6s;
}

@keyframes hud-fade {
  to {
    opacity: var(--o, 1);
  }
}

.hud-top {
  font-size: 11px;
  letter-spacing: 5px;
  color: var(--accent);
  text-transform: uppercase;
  text-shadow: 0 0 12px var(--accent-a45);
}

.hud-stage {
  display: flex;
  align-items: center;
  gap: 4.5vmin;
}

svg {
  width: min(54vmin, 470px);
  height: auto;
  opacity: 0.55;
  filter: drop-shadow(0 0 6px var(--accent-a25));
}

/* 雷达配色全走令牌（CSS 覆盖 SVG 表现属性，改 --accent 全套跟随）：
   默认描边/渐变 = --accent；.mid = 亮一档；.hi = 最亮档填充/渐变。
   注意规则顺序：通用描边 → .mid 加亮 → .blip/.core-glow/锁定框描边恢复。 */
.jarvis-hud svg :is(line, circle) {
  stroke: var(--accent);
}

.jarvis-hud svg :is(line, circle).mid {
  stroke: var(--accent-bright);
}

.jarvis-hud svg :is(.blip, .core-glow) {
  stroke: none;
}

.jarvis-hud svg .lock {
  stroke: var(--accent-a80);
}

.jarvis-hud svg .spin-hex path {
  stroke: var(--accent-a60);
}

.jarvis-hud stop {
  stop-color: var(--accent);
}

.jarvis-hud stop.hi {
  stop-color: var(--accent-brighter);
}

.jarvis-hud svg .hi:not(stop) {
  fill: var(--accent-brighter);
}

/* ---- 两侧遥测：真实数据，HUD 等宽小字 ---- */
.telemetry {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: var(--font-hud);
  font-size: 10.5px;
  letter-spacing: 1.5px;
  min-width: 9ch;
  border-left: 1px solid var(--accent-a22);
  padding-left: 10px;
}

.telemetry.align-r {
  border-left: none;
  border-right: 1px solid var(--accent-a22);
  padding-left: 0;
  padding-right: 10px;
  text-align: right;
}

.t-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.t-key {
  color: var(--accent);
  opacity: 0.55;
  font-size: 9px;
}

.telemetry.align-r .t-key {
  text-align: right;
}

.t-val {
  color: var(--text-2);
  text-shadow: 0 0 8px var(--accent-a25);
}

.hud-data {
  display: flex;
  gap: 18px;
  font-family: var(--font-hud);
  font-size: 12px;
  letter-spacing: 2px;
  color: var(--text-2);
}

.d.on {
  color: var(--accent);
  text-shadow: 0 0 10px var(--accent-a50);
}

.d.warn {
  color: var(--warn);
}

.d.time {
  color: var(--accent);
  opacity: 0.8;
}

/* ---- hex 数据流：装饰性 RX 流，两端渐隐 ---- */
.hex-stream {
  font-family: var(--font-hud);
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--accent);
  opacity: 0;
  max-width: min(64vmin, 560px);
  overflow: hidden;
  white-space: nowrap;
  mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
}

/* ---- 旋转动画：transform-origin 固定在 viewBox 中心 ---- */
.spin-slow, .spin-rev, .spin-rev-fast, .spin-mid, .sweep, .spin-outer, .spin-hex {
  transform-origin: 200px 200px;
}
.spin-slow      { animation: hud-spin 90s linear infinite; }
.spin-rev       { animation: hud-spin-rev 40s linear infinite; }
.spin-rev-fast  { animation: hud-spin-rev 30s linear infinite; }
.spin-mid       { animation: hud-spin 24s linear infinite; }
.sweep          { animation: hud-spin 5s linear infinite; }
.sweep.echo     { animation-delay: -2.5s; }
.spin-outer     { animation: hud-spin-rev 50s linear infinite; }
.spin-hex       { animation: hud-spin-rev 21s linear infinite; }

@keyframes hud-spin {
  to { transform: rotate(360deg); }
}
@keyframes hud-spin-rev {
  to { transform: rotate(-360deg); }
}

/* 核心呼吸 */
.core {
  transform-origin: 200px 200px;
  animation: hud-pulse 3s ease-in-out infinite;
}
@keyframes hud-pulse {
  50% { opacity: 0.65; transform: scale(0.96); }
}

/* 目标点：相位错开，像被雷达扫到的回波；锁定括号同步 */
.blip-g { animation: hud-blip 5s linear infinite; }
.blip-2 { animation-delay: -1.7s; }
.blip-3 { animation-delay: -3.4s; }
@keyframes hud-blip {
  0%, 70% { opacity: 0.15; }
  80% { opacity: 1; }
  95%, 100% { opacity: 0.15; }
}

/* 注：装饰动画不随系统 prefers-reduced-motion 关闭——动效是主题核心体验，
   本机 Windows 关了「动画效果」，跟随 hint 会静默变纯静态（实测 matchMedia 报 reduce）。 */
</style>
