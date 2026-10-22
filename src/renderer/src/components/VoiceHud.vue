<script setup lang="ts">
// 语音 HUD（主区顶部居中）：左边一块独立的大波形屏（示波器风），右边一粒小控制条
// （静音 + 音量）。波形数据取自 speechOutput 播放链上的 AnalyserNode
// （source → masterGain → analyser → destination），反映的是「实际听到的」——
// 静音即归零、音量小波形也矮；静音不打断播报队列，取消静音能接回正在念的那句。
// 偏好全部 localStorage 持久化（重启仍在）。两个主题（跟随系统 / 贾维斯）都挂载。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getTtsAnalyser, setTtsMuted, setTtsVolume, ttsMuted, ttsPhase, ttsVolume } from '../lib/speechOutput.js'

const canvas = ref<HTMLCanvasElement | null>(null)
let raf = 0

const speaking = computed(() => ttsPhase.value === 'speaking')
const live = computed(() => speaking.value && !ttsMuted.value)

function onVolume(event: Event): void {
  setTtsVolume(Number((event.target as HTMLInputElement).value))
}

// ---- 波形：镜像对称双曲线（上下包络 + 渐变填充 + 辉光），空闲退化为流动的待机呼吸波 ----
const COLS = 96
/** 纯视觉增益：TTS 语音 RMS 实测只有 ~0.06-0.18，不放大波形会很矮；
 *  只改显示不改声音（音量由 GainNode 管，静音时数据本身就是 0，放大后仍是 0） */
const VIEW_GAIN = 2.8
let waveData: Uint8Array<ArrayBuffer> | null = null
/** 颜色缓存：主题变量不常变，每 500ms 刷新一次就够（每帧 getComputedStyle 没必要） */
let colorCache: { accent: string; dim: string; at: number } | null = null

function hudColors(el: HTMLElement): { accent: string; dim: string } {
  const now = performance.now()
  if (!colorCache || now - colorCache.at > 500) {
    const style = getComputedStyle(el)
    colorCache = {
      accent: style.getPropertyValue('--accent').trim() || '#4f46e5',
      dim: style.getPropertyValue('--text-3').trim() || '#a1a1aa',
      at: now
    }
  }
  return colorCache
}

/** 时域数据 → 每列 RMS 幅度，再做邻域平滑（列与列之间不抖毛刺） */
function columnLevels(analyser: AnalyserNode | null): number[] {
  const levels = new Array<number>(COLS).fill(0)
  if (!analyser) return levels
  if (!waveData || waveData.length !== analyser.fftSize) waveData = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(waveData)
  const size = Math.floor(waveData.length / COLS)
  for (let col = 0; col < COLS; col += 1) {
    let sum = 0
    let n = 0
    for (let i = col * size; i < (col + 1) * size && i < waveData.length; i += 1) {
      const dev = (waveData[i]! - 128) / 128
      sum += dev * dev
      n += 1
    }
    levels[col] = n ? Math.sqrt(sum / n) : 0
  }
  // 邻域平滑（窗口 5）：曲线顺滑才有示波器的味道
  const out = levels.slice()
  for (let col = 0; col < COLS; col += 1) {
    let sum = 0
    let n = 0
    for (let k = -2; k <= 2; k += 1) {
      const at = col + k
      if (at >= 0 && at < COLS) {
        sum += levels[at]!
        n += 1
      }
    }
    out[col] = sum / n
  }
  return out
}

function drawFrame(): void {
  raf = requestAnimationFrame(drawFrame)
  const el = canvas.value
  if (!el) return
  const ctx = el.getContext('2d')
  if (!ctx) return

  // 画布尺寸跟随 CSS 盒（dpr 缩放，绘制坐标一律用 CSS 像素）
  const dpr = window.devicePixelRatio || 1
  const w = el.clientWidth
  const h = el.clientHeight
  if (!w || !h) return
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const t = performance.now() / 1000
  const colors = hudColors(el)
  const mid = h / 2
  const half = h / 2 - 3
  const levels = columnLevels(getTtsAnalyser())

  // 每列最终幅度：有声音用实时数据；静默（含没播过）叠加一条缓慢流动的待机呼吸波
  const amps = new Array<number>(COLS)
  for (let col = 0; col < COLS; col += 1) {
    const breathe = 0.05 + 0.045 * Math.sin(t * 1.5 - col * 0.13)
    amps[col] = Math.min(1, Math.max(levels[col]! * VIEW_GAIN, breathe))
  }

  const xAt = (col: number): number => (col / (COLS - 1)) * w

  // 中轴基线
  ctx.strokeStyle = colors.dim
  ctx.globalAlpha = 0.18
  ctx.beginPath()
  ctx.moveTo(0, mid)
  ctx.lineTo(w, mid)
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.globalAlpha = 1

  // 镜像包络填充：上下曲线围成的区域，垂直渐变（上下缘亮、中间淡，示波器余辉感）
  const fill = ctx.createLinearGradient(0, 0, 0, h)
  fill.addColorStop(0, colors.accent)
  fill.addColorStop(0.5, colors.dim)
  fill.addColorStop(1, colors.accent)
  ctx.globalAlpha = live.value ? 0.3 : 0.14
  ctx.fillStyle = fill
  ctx.beginPath()
  for (let col = 0; col < COLS; col += 1) {
    const y = mid - amps[col]! * half
    if (col === 0) ctx.moveTo(xAt(col), y)
    else ctx.lineTo(xAt(col), y)
  }
  for (let col = COLS - 1; col >= 0; col -= 1) ctx.lineTo(xAt(col), mid + amps[col]! * half)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 1

  // 上下包络线 + 辉光（播报中主题色高亮，空闲低饱和）
  ctx.strokeStyle = live.value ? colors.accent : colors.dim
  ctx.lineWidth = 1.4
  ctx.shadowColor = colors.accent
  ctx.shadowBlur = live.value ? 9 : 3
  for (const sign of [-1, 1] as const) {
    ctx.beginPath()
    for (let col = 0; col < COLS; col += 1) {
      const y = mid + sign * amps[col]! * half
      if (col === 0) ctx.moveTo(xAt(col), y)
      else ctx.lineTo(xAt(col), y)
    }
    ctx.stroke()
  }
  ctx.shadowBlur = 0

  // 扫描线：一道竖直亮线缓慢扫过（HUD 仪器感；播报中更快更亮）
  const sweepX = ((t * (live.value ? 90 : 36)) % (w + 60)) - 30
  const sweep = ctx.createLinearGradient(sweepX - 14, 0, sweepX + 14, 0)
  sweep.addColorStop(0, 'transparent')
  sweep.addColorStop(0.5, colors.accent)
  sweep.addColorStop(1, 'transparent')
  ctx.globalAlpha = live.value ? 0.16 : 0.08
  ctx.fillStyle = sweep
  ctx.fillRect(sweepX - 14, 1, 28, h - 2)
  ctx.globalAlpha = 1
}

onMounted(() => {
  raf = requestAnimationFrame(drawFrame)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
})
</script>

<template>
  <!-- 组容器只负责定位；波形屏和控制条是两块各自独立的面板 -->
  <div class="voice-hud">
    <!-- 大波形屏（独立显示）：示波器底板 + 四角 HUD 括号 + 铭牌 -->
    <div class="wave-panel" :class="{ live }">
      <span class="plate">TTS·AUDIO</span>
      <canvas ref="canvas" class="wave" />
    </div>

    <!-- 控制条：静音 + 音量（独立小胶囊，垂直居中靠在波形屏右侧） -->
    <div class="voice-controls" :class="{ live }">
      <button
        class="mute-btn"
        :class="{ muted: ttsMuted }"
        :title="ttsMuted ? '取消静音（播报还在继续）' : '静音（播报继续，只是没声）'"
        :aria-pressed="ttsMuted"
        :aria-label="ttsMuted ? '取消静音' : '静音'"
        @click="setTtsMuted(!ttsMuted)"
      >
        <svg v-if="!ttsMuted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none" />
          <line x1="16" y1="9" x2="22" y2="15" />
          <line x1="22" y1="9" x2="16" y2="15" />
        </svg>
      </button>
      <input
        class="vol"
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="ttsVolume"
        :disabled="ttsMuted"
        :title="`播报音量 ${Math.round(ttsVolume * 100)}%`"
        :aria-label="`播报音量 ${Math.round(ttsVolume * 100)}%`"
        @input="onVolume"
      />
    </div>
  </div>
</template>

<style scoped>
/* 顶部居中悬浮（同输入台 z-45 的逻辑：常驻控件盖过投层气泡 z-40，窗口层能压它） */
.voice-hud {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 45;
  display: flex;
  align-items: center;
  gap: 10px;
  pointer-events: none; /* 组间空白让点击穿到桌面；面板自己开回 */
}

.voice-hud > * {
  pointer-events: auto;
}

/* ---- 大波形屏：独立的一块示波器面板 ---- */
.wave-panel {
  position: relative;
  width: 300px;
  height: 64px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  backdrop-filter: blur(10px);
  overflow: hidden;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

/* 播报中：描边点亮 + 外辉光（颜色跟波形一致） */
.wave-panel.live {
  border-color: var(--accent);
  box-shadow: 0 0 18px color-mix(in srgb, var(--accent) 22%, transparent);
}

/* 四角 HUD 括号（多重背景拼四个角，超出圆角由 overflow 裁掉） */
.wave-panel::after {
  content: '';
  position: absolute;
  inset: 4px;
  pointer-events: none;
  background:
    linear-gradient(var(--accent) 0 0) left top / 14px 1.5px,
    linear-gradient(var(--accent) 0 0) left top / 1.5px 14px,
    linear-gradient(var(--accent) 0 0) right top / 14px 1.5px,
    linear-gradient(var(--accent) 0 0) right top / 1.5px 14px,
    linear-gradient(var(--accent) 0 0) left bottom / 14px 1.5px,
    linear-gradient(var(--accent) 0 0) left bottom / 1.5px 14px,
    linear-gradient(var(--accent) 0 0) right bottom / 14px 1.5px,
    linear-gradient(var(--accent) 0 0) right bottom / 1.5px 14px;
  background-repeat: no-repeat;
  opacity: 0.45;
  transition: opacity 0.25s ease;
}

.wave-panel.live::after {
  opacity: 0.9;
}

/* 仪器铭牌：左上角极小的字距拉开的标签，科幻仪表味（装饰，不是说明文字） */
.plate {
  position: absolute;
  top: 5px;
  left: 10px;
  z-index: 1;
  font-size: 8px;
  letter-spacing: 2px;
  color: var(--text-3);
  user-select: none;
  pointer-events: none;
}

.wave-panel.live .plate {
  color: var(--accent);
}

.wave {
  display: block;
  width: 100%;
  height: 100%;
}

/* ---- 控制条：独立小胶囊（静音 + 音量） ---- */
.voice-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  backdrop-filter: blur(10px);
  transition: border-color 0.25s ease;
}

.voice-controls.live {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
}

.mute-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

.mute-btn:hover {
  color: var(--text);
  background: var(--chip);
}

.mute-btn svg {
  width: 15px;
  height: 15px;
}

.mute-btn.muted {
  color: var(--fail);
}

.vol {
  width: 76px;
  height: 26px;
  margin: 0;
  accent-color: var(--text-2);
  cursor: pointer;
}

.vol:disabled {
  opacity: 0.35;
  cursor: default;
}

/* 贾维斯：音量条和静音 hover 走 accent，与整体发光风一致 */
[data-theme='jarvis'] .vol {
  accent-color: var(--accent);
}

[data-theme='jarvis'] .mute-btn:hover {
  color: var(--accent);
}
</style>
