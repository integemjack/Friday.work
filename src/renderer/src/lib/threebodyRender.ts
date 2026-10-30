// 三体全息渲染 —— 只管把 Sim 画到 2D canvas 上；rAF 循环/生命周期在 JarvisHUD.vue。
// 「鼠标视差」不在这里做：canvas 铺在 .stage 的 preserve-3d 空间里，整台 HUD 随
// --par-x/--par-y 转动时它作为一层跟着转（和原地球同一机制）。
//
// 透视：固定仰角的针孔相机（从轨道面上方 24° 看向质心原点），近大远小按 depth 缩放。
// 尾迹：离屏累积层（组件每帧先 destination-out 衰减一次，再往上面画新段），加色混合出辉光。
// 配色：星核/辉光按「质量 → 主序星色温」上色（大质量蓝白、小质量橙红——真实的质光关系方向），
// 标签/遥测/质心标记全走 --accent 令牌，保持贾维斯全息语言。

import { angularMomentum, totalEnergy, type Body, type Sim } from './threebody.js'

const ELEV = (24 * Math.PI) / 180 // 相机仰角：从轨道面上方 24° 看向质心
const CE = Math.cos(ELEV)
const SE = Math.sin(ELEV)

export interface View {
  w: number
  h: number
  cx: number
  cy: number
  /** 焦距（px·单位长度） */
  f: number
  /** 相机到质心距离（单位长度） */
  dist: number
  accent: string
  warn: string
  font: string
}

export function makeView(w: number, h: number, accent: string, warn: string, font: string): View {
  return { w, h, cx: w / 2, cy: h / 2, f: Math.min(w, h) * 1.5, dist: 5.4, accent, warn, font }
}

export interface Projected {
  sx: number
  sy: number
  depth: number
  scale: number
}

/** 世界坐标（x/y 轨道面内、z 面外）→ 画布坐标。depth 越大越远，scale = dist/depth 近大远小。 */
export function project(view: View, x: number, y: number, z: number): Projected {
  // 世界绕 x 轴转 ELEV，把相机转到 (0,−dist,0)、光轴过原点
  const y2 = y * CE - z * SE
  const z2 = y * SE + z * CE
  const depth = view.dist + y2
  const k = view.f / depth
  return { sx: view.cx + x * k, sy: view.cy - z2 * k, depth, scale: view.dist / depth }
}

type RGB = [number, number, number]

/** 质量 → 主序星色温方向（大质量蓝白、小质量橙红）。m∈[0.6,2.6] 映射暖白→冰蓝。 */
export function starColor(m: number): RGB {
  const t = Math.min(1, Math.max(0, (m - 0.6) / 2))
  const warm: RGB = [255, 178, 120]
  const mid: RGB = [255, 243, 229]
  const cool: RGB = [170, 216, 255]
  const mix = (a: RGB, b: RGB, k: number): RGB => [
    a[0]! + (b[0]! - a[0]!) * k,
    a[1]! + (b[1]! - a[1]!) * k,
    a[2]! + (b[2]! - a[2]!) * k
  ]
  return t < 0.5 ? mix(warm, mid, t * 2) : mix(mid, cool, (t - 0.5) * 2)
}

const rgba = (c: RGB, a: number): string => `rgba(${c[0]! | 0},${c[1]! | 0},${c[2]! | 0},${a})`

/** 尾迹层整体衰减（destination-out：每帧乘掉一点 alpha，尾迹渐隐）。
 *  alpha ≈ 0.013 → 秒衰 ~54%；换组淡出时组件传大值快速抹掉。 */
export function fadeTrail(ctx: CanvasRenderingContext2D, view: View, alpha: number): void {
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = `rgba(0,0,0,${alpha})`
  ctx.fillRect(0, 0, view.w, view.h)
  ctx.globalCompositeOperation = 'source-over'
}

/** 在尾迹层上画一小段（上一帧位置 → 当前位置），lighter 叠加出辉光。 */
export function drawTrailSeg(
  ctx: CanvasRenderingContext2D,
  view: View,
  b: Body,
  prev: { x: number; y: number; z: number }
): void {
  const p0 = project(view, prev.x, prev.y, prev.z)
  const p1 = project(view, b.x, b.y, b.z)
  ctx.globalCompositeOperation = 'lighter'
  ctx.strokeStyle = rgba(starColor(b.m), 0.5)
  ctx.lineWidth = 1 + 0.7 * Math.cbrt(b.m)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(p0.sx, p0.sy)
  ctx.lineTo(p1.sx, p1.sy)
  ctx.stroke()
  ctx.globalCompositeOperation = 'source-over'
}

export interface Flash {
  /** 合并闪光的世界坐标（每帧重新投影，视角变了也对） */
  x: number
  y: number
  z: number
  t0: number
}

export interface Banner {
  text: string
  tone: 'warn' | 'info'
}

export interface FrameMeta {
  names: string[]
  label: string
  sol: number
  drift: number
  flashes: Flash[]
  banner: Banner | null
  now: number
}

/** 画一整帧：尾迹层铺底 + 质心标记 + 按深度排序的恒星 + 事件闪光/横幅 + 左下遥测。 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  trail: HTMLCanvasElement,
  view: View,
  sim: Sim,
  meta: FrameMeta
): void {
  const { w, h } = view
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(trail, 0, 0, w, h)
  const sizeK = Math.min(w, h) / 320

  // 质心标记：系统不动点，全息参考十字
  const cm = project(view, 0, 0, 0)
  ctx.strokeStyle = view.accent
  ctx.globalAlpha = 0.35
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(cm.sx - 6, cm.sy)
  ctx.lineTo(cm.sx + 6, cm.sy)
  ctx.moveTo(cm.sx, cm.sy - 6)
  ctx.lineTo(cm.sx, cm.sy + 6)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(cm.sx, cm.sy, 10, 0, 6.2832)
  ctx.globalAlpha = 0.18
  ctx.stroke()
  ctx.globalAlpha = 1

  // 恒星：远的先画（近的盖在上面）；大小 ∝ ∛m（体积按质量）
  const order = sim.bodies
    .map((b, i) => ({ b, i, p: project(view, b.x, b.y, b.z) }))
    .sort((a, z) => z.p.depth - a.p.depth)
  for (const { b, i, p } of order) {
    const col = starColor(b.m)
    const rad = 2.2 * Math.cbrt(b.m) * p.scale * sizeK
    const glow = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, rad * 5)
    glow.addColorStop(0, 'rgba(255,255,255,0.95)')
    glow.addColorStop(0.18, rgba(col, 0.85))
    glow.addColorStop(0.45, rgba(col, 0.2))
    glow.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(p.sx, p.sy, rad * 5, 0, 6.2832)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(p.sx, p.sy, Math.max(1.2, rad * 0.7), 0, 6.2832)
    ctx.fill()
    // 名称标签：α/β/γ + 质量；远处的（scale 小）淡一些
    const fade = Math.max(0.25, Math.min(0.9, (p.scale - 0.6) * 1.6))
    ctx.font = `9px ${view.font}`
    ctx.textAlign = 'left'
    ctx.fillStyle = view.accent
    ctx.globalAlpha = fade
    ctx.fillText(`${meta.names[i] ?? '?'} m=${b.m.toFixed(2)}`, p.sx + rad * 2 + 4, p.sy - rad * 2 - 2)
    ctx.globalAlpha = 1
  }

  // 合并闪光：扩散环（0.9s）
  for (const f of meta.flashes) {
    const age = (meta.now - f.t0) / 900
    if (age < 0 || age >= 1) continue
    const p = project(view, f.x, f.y, f.z)
    ctx.strokeStyle = view.accent
    ctx.globalAlpha = (1 - age) * 0.9
    ctx.lineWidth = Math.max(0.5, 2.2 * (1 - age))
    ctx.beginPath()
    ctx.arc(p.sx, p.sy, (4 + age * 44) * sizeK, 0, 6.2832)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // 事件横幅（右上）：EJECT / MERGE
  if (meta.banner) {
    ctx.font = `9px ${view.font}`
    ctx.textAlign = 'right'
    ctx.fillStyle = meta.banner.tone === 'warn' ? view.warn : view.accent
    ctx.globalAlpha = 0.9
    ctx.fillText(meta.banner.text, w - 8, 14)
    ctx.globalAlpha = 1
  }

  // 左下遥测两行：这组解的出处、sim 时间、守恒量实况
  ctx.font = `8.5px ${view.font}`
  ctx.textAlign = 'left'
  ctx.fillStyle = view.accent
  ctx.globalAlpha = 0.75
  ctx.fillText(`SOL ${String(meta.sol).padStart(2, '0')} · ${meta.label} · T +${sim.t.toFixed(1)}`, 7, h - 22)
  ctx.fillText(
    `E ${totalEnergy(sim.bodies).toFixed(4)} · L ${angularMomentum(sim.bodies).toFixed(3)} · ΔE ${(meta.drift * 100).toFixed(2)}%`,
    7,
    h - 10
  )
  ctx.globalAlpha = 1
}
