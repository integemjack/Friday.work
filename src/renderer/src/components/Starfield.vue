<script setup lang="ts">
// 3D 星空（登录页背景）：每颗星是空间里的点 (x, y, z)，z 递减 → 透视投影到屏幕，
// 越近越大越亮，带一点拖尾，像缓慢的曲速飞行。纯 canvas，无依赖。
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ count?: number; speed?: number }>(), {
  count: 150,
  speed: 0.26
})

const canvasEl = ref<HTMLCanvasElement | null>(null)

interface Star {
  x: number
  y: number
  z: number
  /** 少数星用主题强调色，其余是冷白 */
  accent: boolean
}

const stars: Star[] = []
let raf = 0
let running = true
let width = 0
let height = 0
let last = 0
let accentRgb = '34, 211, 238'
const starRgb = '198, 224, 255'

function reset(star: Star): void {
  star.x = (Math.random() * 2 - 1) * 1.25
  star.y = (Math.random() * 2 - 1) * 1.05
  star.z = 0.12 + Math.random() * 0.88
  star.accent = Math.random() < 0.16
}

function resize(): void {
  const canvas = canvasEl.value
  const parent = canvas?.parentElement
  if (!canvas || !parent) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = parent.clientWidth
  height = parent.clientHeight
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function step(now: number): void {
  raf = requestAnimationFrame(step)
  const ctx = canvasEl.value?.getContext('2d')
  if (!ctx || !running) return
  const dt = Math.min((now - last) / 1000, 0.05)
  last = now
  ctx.clearRect(0, 0, width, height)
  const cx = width / 2
  const cy = height * 0.44
  const scale = Math.min(width, height) * 0.6
  for (const star of stars) {
    star.z -= dt * props.speed
    if (star.z <= 0.04) reset(star)
    const project = (z: number): [number, number] => [cx + (star.x / z) * scale, cy + (star.y / z) * scale]
    const [sx, sy] = project(star.z)
    if (sx < -30 || sx > width + 30 || sy < -30 || sy > height + 30) {
      reset(star)
      continue
    }
    const near = 1 - star.z
    const alpha = Math.min(1, Math.max(0.06, near * 1.2))
    const size = 0.6 + near * 2
    const rgb = star.accent ? accentRgb : starRgb
    // 拖尾：往远处多投一个点，连线（近处的星拖尾更长）
    const [tx, ty] = project(Math.min(star.z + dt * props.speed * 9, 1))
    ctx.strokeStyle = `rgba(${rgb}, ${alpha * 0.55})`
    ctx.lineWidth = size * 0.8
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    ctx.lineTo(sx, sy)
    ctx.stroke()
    ctx.fillStyle = `rgba(${rgb}, ${alpha})`
    ctx.fillRect(sx - size / 2, sy - size / 2, size, size)
  }
}

function onVisibility(): void {
  running = !document.hidden
  last = performance.now()
}

onMounted(() => {
  const css = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(css)) {
    accentRgb = `${Number.parseInt(css.slice(1, 3), 16)}, ${Number.parseInt(css.slice(3, 5), 16)}, ${Number.parseInt(css.slice(5, 7), 16)}`
  }
  stars.length = 0
  for (let index = 0; index < props.count; index += 1) {
    const star: Star = { x: 0, y: 0, z: 1, accent: false }
    reset(star)
    stars.push(star)
  }
  resize()
  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', onVisibility)
  last = performance.now()
  raf = requestAnimationFrame(step)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <canvas ref="canvasEl" class="starfield" />
</template>

<style scoped>
.starfield {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
