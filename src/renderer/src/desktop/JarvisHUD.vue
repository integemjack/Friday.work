<script setup lang="ts">
// 贾维斯 HUD：桌面中央的全息雷达。多层旋转环 + 雷达扫描 + 反应堆核心。
// 不是纯装饰：下面的状态行显示真实数据——机器连接状态、窗口数、待确认数、实时时钟，
// 只在「贾维斯界面」下挂载（App.vue 里 v-if="jarvis"），别的主题不渲染、零开销。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()

// 实时时钟（HUD 的心跳）
const now = ref('')
let timer = 0
function tick(): void {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  now.value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
onMounted(() => {
  tick()
  timer = window.setInterval(tick, 1000)
})
onBeforeUnmount(() => window.clearInterval(timer))

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
</script>

<template>
  <div class="jarvis-hud" aria-hidden="true">
    <div class="hud-top">J.A.R.V.I.S. // FRIDAY DESKTOP</div>

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

      <!-- 雷达外圈 + 扫描扇形（5s 一圈）+ 目标点 -->
      <circle cx="200" cy="200" r="150" fill="none" stroke-width="1" opacity="0.35" />
      <g class="sweep">
        <path d="M200 200 L200 50 A150 150 0 0 1 329.9 125 Z" fill="url(#hud-sweep)" />
        <line class="mid" x1="200" y1="200" x2="200" y2="50" stroke-width="1.5" opacity="0.8" />
      </g>
      <circle
        v-for="(b, i) in blips"
        :key="i"
        class="blip hi"
        :class="`blip-${i + 1}`"
        :cx="b.x" :cy="b.y" r="3"
      />

      <!-- 中圈虚线：反向转 -->
      <g class="spin-rev-fast">
        <circle cx="200" cy="200" r="120" fill="none" stroke-width="1" stroke-dasharray="3 9" opacity="0.4" />
      </g>

      <!-- 内圈三段弧：顺时针 -->
      <g class="spin-mid">
        <circle cx="200" cy="200" r="94" fill="none" stroke-width="2" stroke-dasharray="140 56.87" opacity="0.55" />
      </g>

      <!-- 反应堆核心：辉光 + 双环 + 三角，呼吸脉冲 -->
      <circle class="core-glow" cx="200" cy="200" r="58" fill="url(#hud-core)" />
      <g class="core">
        <circle class="mid" cx="200" cy="200" r="36" fill="none" stroke-width="1.5" opacity="0.85" />
        <circle cx="200" cy="200" r="24" fill="none" stroke-width="1" opacity="0.6" />
        <path class="hi" d="M200 182 L216 212 L184 212 Z" opacity="0.9" />
      </g>
    </svg>

    <div class="hud-data">
      <span class="d time">{{ now }}</span>
      <span class="d" :class="{ on: linkReady }">◈ {{ linkText }}</span>
      <span class="d">{{ winText }}</span>
      <span v-if="store.pendingApprovalCount" class="d warn">
        ⚠ {{ String(store.pendingApprovalCount).padStart(2, '0') }} PENDING
      </span>
    </div>
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
}

.hud-top {
  font-size: 11px;
  letter-spacing: 5px;
  color: var(--accent);
  opacity: 0.5;
  text-transform: uppercase;
}

svg {
  width: min(54vmin, 470px);
  height: auto;
  opacity: 0.55;
  filter: drop-shadow(0 0 6px var(--accent-a25));
}

/* 雷达配色全走令牌（CSS 覆盖 SVG 表现属性，改 --accent 全套跟随）：
   默认描边/渐变 = --accent；.mid = 亮一档；.hi = 最亮档填充/渐变。
   注意规则顺序：通用描边 → .mid 加亮 → .blip/.core-glow 恢复无描边。 */
.jarvis-hud svg :is(line, circle) {
  stroke: var(--accent);
}

.jarvis-hud svg :is(line, circle).mid {
  stroke: var(--accent-bright);
}

.jarvis-hud svg :is(.blip, .core-glow) {
  stroke: none;
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

.hud-data {
  display: flex;
  gap: 18px;
  font-family: 'Cascadia Code', Consolas, monospace;
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

/* ---- 旋转动画：transform-origin 固定在 viewBox 中心 ---- */
.spin-slow, .spin-rev, .spin-rev-fast, .spin-mid, .sweep {
  transform-origin: 200px 200px;
}
.spin-slow      { animation: hud-spin 90s linear infinite; }
.spin-rev       { animation: hud-spin-rev 40s linear infinite; }
.spin-rev-fast  { animation: hud-spin-rev 30s linear infinite; }
.spin-mid       { animation: hud-spin 24s linear infinite; }
.sweep          { animation: hud-spin 5s linear infinite; }

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

/* 目标点：相位错开，像被雷达扫到的回波 */
.blip { animation: hud-blip 5s linear infinite; }
.blip-2 { animation-delay: -1.7s; }
.blip-3 { animation-delay: -3.4s; }
@keyframes hud-blip {
  0%, 70% { opacity: 0.15; }
  80% { opacity: 1; }
  95%, 100% { opacity: 0.15; }
}
</style>
