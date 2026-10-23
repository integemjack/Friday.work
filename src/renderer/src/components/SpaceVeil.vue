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
import { subscribeFrames, wakeFrames } from '../lib/frameTicker.js'

const STAR_COUNT = 120

const rootEl = ref<HTMLElement | null>(null)
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
let unsubscribeFrames: (() => void) | null = null
let ctx: CanvasRenderingContext2D | null = null
let running = true
let width = 0
let height = 0
let last = 0
let nextMeteorAt = 0
let accentRgb = ACCENT_FALLBACK_RGB
const starRgb = '198, 224, 255'

function resetStar(star: Star, first: boolean): void {
  // 星野整体往下（vy > 0）、往左（vx < 0）漂：从底边出去的星要回到顶边重生。
  // 原来重生在 height + 8（底边外、还在往下走）→ 下一帧又判出界、永远卡在屏外，
  // 开着几分钟星星就一颗颗漏光；窗口拉高时卡住的那排星会在旧底边处排成一条线
  star.x = Math.random() * width
  star.y = first ? Math.random() * height : -8
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
  const prevW = width
  const prevH = height
  width = parent.clientWidth
  height = parent.clientHeight
  // 窗口缩放：已有的星按比例搬到新画布上（不然拉大窗口后新露出来的区域要等很久才有星）
  if (prevW > 0 && prevH > 0 && (prevW !== width || prevH !== height)) {
    for (const star of stars) {
      star.x *= width / prevW
      star.y *= height / prevH
    }
  }
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  ctx = canvas.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function drawStar(ctx: CanvasRenderingContext2D, star: Star, alpha: number, dx: number, dy: number): void {
  const rgb = star.accent ? accentRgb : starRgb
  const x = star.x + dx
  const y = star.y + dy
  ctx.fillStyle = `rgba(${rgb}, ${alpha})`
  ctx.beginPath()
  ctx.arc(x, y, star.r, 0, Math.PI * 2)
  ctx.fill()
  if (star.flare) {
    // 十字星芒：只给最亮的几颗，长度与亮度挂钩
    const len = star.r * 5.5
    ctx.strokeStyle = `rgba(${rgb}, ${alpha * 0.4})`
    ctx.lineWidth = 0.7
    ctx.beginPath()
    ctx.moveTo(x - len, y)
    ctx.lineTo(x + len, y)
    ctx.moveTo(x, y - len)
    ctx.lineTo(x, y + len)
    ctx.stroke()
  }
}

/** 帧率交给共用的 lib/frameTicker：平时随空闲帧率（≈30fps）和语音波形同帧画；
 *  有流星（或下一颗 50ms 内就来）时要逐帧——流星 500+ px/s，30fps 会一跳一跳 */
function wantsEveryFrame(): boolean {
  return meteors.length > 0 || nextMeteorAt - performance.now() < 50
}

function step(now: number): void {
  if (!ctx || !running) return
  // 别人要逐帧（正在播报）时帧驱动每个 vsync 都会来：星野自己没流星就仍按 ~30fps 画
  if (!wantsEveryFrame() && now - last < 1000 / 30 - 4) return
  const dt = Math.min((now - last) / 1000, 0.05)
  last = now
  const t = now / 1000
  ctx.clearRect(0, 0, width, height)

  // 景深视差：鼠标位置（App.vue 写在根上的 --par-x/--par-y）按星的大小错开——大星算近、挪得多，
  // 小星算远、几乎不动，星野不再是一整张平面跟着平移
  const style = rootEl.value?.style
  const parX = Number(style?.getPropertyValue('--par-x')) || 0
  const parY = Number(style?.getPropertyValue('--par-y')) || 0
  for (const star of stars) {
    star.x += star.vx * dt
    star.y += star.vy * dt
    if (star.y > height + 10) resetStar(star, false)
    else if (star.x < -10) star.x = width + 8
    const alpha = star.base * (0.72 + 0.28 * Math.sin(t * star.twinkle + star.phase))
    const depth = star.r * star.r * 6
    drawStar(ctx, star, alpha, -parX * depth, -parY * depth * 0.75)
  }

  // 流星
  if (now >= nextMeteorAt) {
    spawnMeteor(now)
    wakeFrames()
  }
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
  unsubscribeFrames = subscribeFrames(step, wantsEveryFrame)
})

function onResize(): void {
  resize()
}

onBeforeUnmount(() => {
  unsubscribeFrames?.()
  unsubscribeFrames = null
  ctx = null
  window.removeEventListener('resize', onResize)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div ref="rootEl" class="space-veil" data-parallax aria-hidden="true">
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
  /* 鼠标视差（App.vue 把 --par-x/--par-y 直接写到这个根上）：最远的一层（星云），反向小幅移动；
     星点在 canvas 里按大小再各自错开（见 step） */
  translate: calc(var(--par-x, 0) * -5px) calc(var(--par-y, 0) * -4px);
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
