<script setup lang="ts">
// 桌面深空层（贾维斯主题专用，App.vue 里只在 jarvis 下挂载）：
// canvas 漂移星野（缓慢漂移 + 闪烁，少数亮星带十字星芒）+ 偶发流星；
// 星云辉光和暗角走 CSS 伪元素。纯 canvas + CSS，零依赖，主题色跟随 --accent。
// pointer-events 全关；document.hidden 时暂停。
// 帧率：星野漂移只有几 px/s，30fps 肉眼无差；有流星划过时才跑满 60fps（流星 500+ px/s 要顺）。
// 注：不随系统 prefers-reduced-motion 降级——动效是本主题核心体验，
// 本机 Windows 关了「动画效果」，跟随 hint 会静默变纯静态（实测 matchMedia 报 reduce）。
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ACCENT_FALLBACK_RGB } from '../../../shared/theme-tokens.js'

const STAR_COUNT = 120

const canvasEl = ref<HTMLCanvasElement | null>(null)

interface Star {
  x: number
  y: number
  r: number
  /** 基础亮度 */
  base: number
  /** 闪烁相位与速度 */
  phase: number
  twinkle: number
  vx: number
  vy: number
  accent: boolean
  /** 少数亮星带十字星芒 */
  flare: boolean
}

interface Meteor {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
}

const stars: Star[] = []
const meteors: Meteor[] = []
let raf = 0
let ctx: CanvasRenderingContext2D | null = null
let running = true
let width = 0
let height = 0
let last = 0
let nextMeteorAt = 0
let accentRgb = ACCENT_FALLBACK_RGB
const starRgb = '198, 224, 255'

function resetStar(star: Star, first: boolean): void {
  star.x = Math.random() * width
  star.y = first ? Math.random() * height : height + 8
  star.r = 0.5 + Math.random() * 1.3
  star.base = 0.25 + Math.random() * 0.6
  star.phase = Math.random() * Math.PI * 2
  star.twinkle = 0.4 + Math.random() * 1.4
  // 整片星野朝同一侧极缓漂移，像飞船在滑行
  star.vx = -(2 + Math.random() * 5)
  star.vy = 1 + Math.random() * 3.5
  star.accent = Math.random() < 0.2
  star.flare = star.base > 0.72 && Math.random() < 0.4
}

function spawnMeteor(now: number): void {
  const fromLeft = Math.random() < 0.5
  const speed = 520 + Math.random() * 420
  const angle = (Math.random() * 18 + 24) * (Math.PI / 180)
  meteors.push({
    x: fromLeft ? -40 : width * (0.3 + Math.random() * 0.7),
    y: Math.random() * height * 0.42,
    vx: (fromLeft ? 1 : -1) * speed * Math.cos(angle),
    vy: speed * Math.sin(angle),
    age: 0,
    life: 0.9 + Math.random() * 0.6
  })
  // 下一颗 7–16 秒后（原来多乘了个 1000，算成了 2–4 小时：整个会话只看得到开场那一颗）
  nextMeteorAt = now + 7000 + Math.random() * 9000
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
  ctx = canvas.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function drawStar(ctx: CanvasRenderingContext2D, star: Star, alpha: number): void {
  const rgb = star.accent ? accentRgb : starRgb
  ctx.fillStyle = `rgba(${rgb}, ${alpha})`
  ctx.beginPath()
  ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2)
  ctx.fill()
  if (star.flare) {
    // 十字星芒：只给最亮的几颗，长度与亮度挂钩
    const len = star.r * 5.5
    ctx.strokeStyle = `rgba(${rgb}, ${alpha * 0.4})`
    ctx.lineWidth = 0.7
    ctx.beginPath()
    ctx.moveTo(star.x - len, star.y)
    ctx.lineTo(star.x + len, star.y)
    ctx.moveTo(star.x, star.y - len)
    ctx.lineTo(star.x, star.y + len)
    ctx.stroke()
  }
}

/** 没有流星时的最小帧间隔（≈30fps；留 4ms 余量免得 60Hz 下抖成 20fps） */
const IDLE_FRAME_MS = 1000 / 30 - 4

function step(now: number): void {
  raf = requestAnimationFrame(step)
  if (!ctx || !running) return
  if (!meteors.length && now < nextMeteorAt && now - last < IDLE_FRAME_MS) return
  const dt = Math.min((now - last) / 1000, 0.05)
  last = now
  const t = now / 1000
  ctx.clearRect(0, 0, width, height)

  for (const star of stars) {
    star.x += star.vx * dt
    star.y += star.vy * dt
    if (star.y > height + 10 || star.x < -10) {
      if (star.y > height + 10) resetStar(star, false)
      else star.x = width + 8
    }
    const alpha = star.base * (0.72 + 0.28 * Math.sin(t * star.twinkle + star.phase))
    drawStar(ctx, star, alpha)
  }

  // 流星
  if (now >= nextMeteorAt) spawnMeteor(now)
  for (let i = meteors.length - 1; i >= 0; i -= 1) {
    const m = meteors[i]
    m.age += dt
    if (m.age >= m.life) {
      meteors.splice(i, 1)
      continue
    }
    m.x += m.vx * dt
    m.y += m.vy * dt
    const fade = Math.sin((m.age / m.life) * Math.PI)
    const tailX = m.x - m.vx * 0.16
    const tailY = m.y - m.vy * 0.16
    const grad = ctx.createLinearGradient(m.x, m.y, tailX, tailY)
    grad.addColorStop(0, `rgba(233, 250, 255, ${0.85 * fade})`)
    grad.addColorStop(1, 'rgba(233, 250, 255, 0)')
    ctx.strokeStyle = grad
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(tailX, tailY)
    ctx.lineTo(m.x, m.y)
    ctx.stroke()
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
  resize()
  stars.length = 0
  for (let i = 0; i < STAR_COUNT; i += 1) {
    const star: Star = { x: 0, y: 0, r: 1, base: 0.5, phase: 0, twinkle: 1, vx: 0, vy: 0, accent: false, flare: false }
    resetStar(star, true)
    stars.push(star)
  }
  nextMeteorAt = performance.now() + 3500
  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisibility)
  last = performance.now()
  raf = requestAnimationFrame(step)
})

function onResize(): void {
  resize()
}

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ctx = null
  window.removeEventListener('resize', onResize)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div class="space-veil" data-parallax aria-hidden="true">
    <canvas ref="canvasEl" class="veil-canvas" />
  </div>
</template>

<style scoped>
.space-veil {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
  /* 鼠标视差（App.vue 把 --par-x/--par-y 直接写到这个根上）：最远的一层，反向小幅移动 */
  translate: calc(var(--par-x, 0) * -7px) calc(var(--par-y, 0) * -5px);
}

.veil-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/* 星云：两团极淡的辉光（青 + 一点紫作对比色），营造深空纵深 */
.space-veil::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 42% 34% at 24% 18%, var(--accent-a9), transparent 70%),
    radial-gradient(ellipse 38% 30% at 80% 72%, rgba(124, 108, 255, 0.06), transparent 70%),
    radial-gradient(ellipse 30% 24% at 62% 30%, rgba(56, 189, 248, 0.05), transparent 70%);
}

/* 暗角：四边压暗，把视线收到中央 */
.space-veil::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse 90% 82% at 50% 46%, transparent 58%, rgba(2, 6, 14, 0.55));
}
</style>
