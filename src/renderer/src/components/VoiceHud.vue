<script setup lang="ts">
// 语音 HUD（主区顶部居中）：左边一块独立的大波形屏（示波器风），右边一粒小控制条
// （静音 + 音量）。波形数据取自 speechOutput 播放链上的 AnalyserNode
// （source → masterGain → analyser → destination），反映的是「实际听到的」——
// 静音即归零、音量小波形也矮；静音不打断播报队列，取消静音能接回正在念的那句。
// 偏好全部 localStorage 持久化（重启仍在）。两个主题（跟随系统 / 贾维斯）都挂载。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getTtsAnalyser, setTtsMuted, setTtsSinkId, setTtsVolume, ttsMuted, ttsPhase, ttsSinkId, ttsVolume } from '../lib/speechOutput.js'

const canvas = ref<HTMLCanvasElement | null>(null)
let raf = 0

const speaking = computed(() => ttsPhase.value === 'speaking')
const live = computed(() => speaking.value && !ttsMuted.value)

function onVolume(event: Event): void {
  setTtsVolume(Number((event.target as HTMLInputElement).value))
}

// ---- 点击波形屏才弹出的音量控制（平时收起，波形屏独立常驻、位置不随弹出挪动） ----
const controlsOpen = ref(false)
const hudRoot = ref<HTMLElement | null>(null)

const waveTitle = computed(() => (controlsOpen.value ? '收起音量控制' : '点击显示音量控制（静音 / 音量）'))

function toggleControls(): void {
  controlsOpen.value = !controlsOpen.value
  if (!controlsOpen.value) sinkMenuOpen.value = false
}

// ---- 静音按钮右键：选 TTS 输出设备（enumerateDevices 的 audiooutput → AudioContext.setSinkId） ----
interface SinkOption {
  deviceId: string
  label: string
}
const sinkMenuOpen = ref(false)
const sinks = ref<SinkOption[]>([])
const sinkEnumError = ref('')

/** 列一遍输出设备：滤掉 Windows 的 default/communications 别名只留实体（顶部「系统默认」= ''）；
 *  label 拿不到时用序号占位（Chromium 对输出设备名一般直接给） */
async function refreshSinks(): Promise<void> {
  sinkEnumError.value = ''
  try {
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === 'audiooutput' && device.deviceId !== 'default' && device.deviceId !== 'communications'
    )
    sinks.value = outputs.map((device, index) => ({ deviceId: device.deviceId, label: device.label || `扬声器 ${index + 1}` }))
  } catch {
    sinkEnumError.value = '列不出输出设备'
  }
}

function openSinkMenu(): void {
  sinkMenuOpen.value = !sinkMenuOpen.value
  if (sinkMenuOpen.value) void refreshSinks()
}

function chooseSink(deviceId: string): void {
  setTtsSinkId(deviceId)
  sinkMenuOpen.value = false
}

/** 点 HUD 外面：收起音量控制与设备菜单 */
function onDocPointerDown(event: PointerEvent): void {
  const root = hudRoot.value
  if (root && !root.contains(event.target as Node)) {
    controlsOpen.value = false
    sinkMenuOpen.value = false
  }
}

/** 设备热插拔：菜单开着时刷新列表 */
function onDeviceChange(): void {
  if (sinkMenuOpen.value) void refreshSinks()
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
  document.addEventListener('pointerdown', onDocPointerDown)
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  document.removeEventListener('pointerdown', onDocPointerDown)
  navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
})
</script>

<template>
  <!-- 组容器只负责定位；波形屏常驻，控制条点击波形屏才弹出（都各自独立的面板） -->
  <div ref="hudRoot" class="voice-hud">
    <!-- 大波形屏（独立显示）：示波器底板 + 四角 HUD 括号 + 铭牌；点击弹出/收起音量控制 -->
    <div class="wave-panel" :class="{ live }" :title="waveTitle" @click="toggleControls">
      <span class="plate">TTS·AUDIO</span>
      <canvas ref="canvas" class="wave" />
    </div>

    <!-- 控制条（点击波形屏弹出）：静音（右键选输出设备）+ 音量；浮在波形屏右侧，不动波形屏 -->
    <Transition name="controls">
      <div v-if="controlsOpen" class="voice-controls" :class="{ live }">
        <button
          class="mute-btn"
          :class="{ muted: ttsMuted }"
          :title="ttsMuted ? '取消静音（播报还在继续）· 右键选输出设备' : '静音（播报继续，只是没声）· 右键选输出设备'"
          :aria-pressed="ttsMuted"
          :aria-label="ttsMuted ? '取消静音' : '静音'"
          @click="setTtsMuted(!ttsMuted)"
          @contextmenu.prevent="openSinkMenu"
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
        <!-- 输出设备（静音按钮右键弹出）：当前项打勾，点选即切（AudioContext.setSinkId） -->
        <div v-if="sinkMenuOpen" class="sink-menu">
          <div class="sink-sep">输出设备</div>
          <div v-if="sinkEnumError" class="sink-empty">{{ sinkEnumError }}</div>
          <button class="sink-item" :class="{ current: !ttsSinkId }" @click="chooseSink('')">
            <span class="sink-name">系统默认</span>
            <span v-if="!ttsSinkId" class="sink-check">✓</span>
          </button>
          <button
            v-for="sink in sinks"
            :key="sink.deviceId"
            class="sink-item"
            :class="{ current: ttsSinkId === sink.deviceId }"
            :title="sink.label"
            @click="chooseSink(sink.deviceId)"
          >
            <span class="sink-name">{{ sink.label }}</span>
            <span v-if="ttsSinkId === sink.deviceId" class="sink-check">✓</span>
          </button>
        </div>
      </div>
    </Transition>
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

/* ---- 大波形屏：独立的一块示波器面板（点击弹出/收起音量控制） ---- */
.wave-panel {
  position: relative;
  width: 300px;
  height: 64px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  backdrop-filter: blur(10px);
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

/* 可点的提示（播报中的 accent 描边优先，不让 hover 盖掉） */
.wave-panel:not(.live):hover {
  border-color: color-mix(in srgb, var(--text-3) 45%, var(--border));
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

/* ---- 控制条（点击波形屏弹出）：绝对定位浮在波形屏右侧，波形屏永远居中不动 ---- */
.voice-controls {
  position: absolute;
  left: calc(100% + 10px);
  top: 50%;
  transform: translateY(-50%);
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

/* 弹出/收起：淡入 + 从波形屏侧滑出（transform 里要带上定位的 translateY） */
.controls-enter-active,
.controls-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.controls-enter-from,
.controls-leave-to {
  opacity: 0;
  transform: translateY(-50%) translateX(10px);
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

/* ---- 输出设备菜单（静音按钮右键）：挂在控制条下方的小浮层 ---- */
.sink-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 60;
  min-width: 248px;
  max-height: 280px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  backdrop-filter: blur(12px);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.28);
}

.sink-sep {
  padding: 6px 10px 4px;
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--text-3);
  user-select: none;
}

.sink-empty {
  padding: 4px 10px 6px;
  font-size: 12px;
  color: var(--fail);
}

.sink-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.sink-item:hover {
  background: var(--chip);
  color: var(--text);
}

.sink-item.current {
  color: var(--accent);
}

.sink-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sink-check {
  flex: none;
  font-size: 12px;
  color: var(--accent);
}

[data-theme='jarvis'] .sink-item:hover {
  color: var(--accent);
}
</style>
