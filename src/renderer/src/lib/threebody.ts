// 三体问题物理核心 —— 真实牛顿引力（「按照实际来」落在这里）：
//
// · 单位 G = 1（m、r、v、t 全是自然单位），三体两两万有引力 F = G·m₁m₂/r²，无 softening、
//   无预设轨道、无插值动画——每一步都是这组初值在万有引力下的真实演化；
// · 积分器 velocity Verlet：辛、二阶、时间可逆，能量/角动量是牛顿中心力系的精确守恒量；
// · 近距交会自适应细分步长（最多 512 份）——三体的戏剧性全在近距散射里，粗步长会算出假轨道；
// · 碰撞：两星距离 < 0.01（≈2×恒星半径；太阳半径/AU≈0.0047 的真实量级）按动量守恒非弹性合并；
// · 逃逸：单星相对能量 Eᵢ = ½v²rel − Σ Gmⱼ/rᵢⱼ > 0 且远离质心 → 弹射（三体的典型真实结局：
//   留下一对双星 + 一颗飞走），由 UI 层延时换下一组初值；
// · 能量漂移监控：|E−E₀|/|E₀| 超阈值 = 数值失效，UI 静默换组，绝不把假轨道当真演下去。
//
// 初值三族（都是三体研究里的真实对象）：
//   figure-8    Chenciner–Montgomery (2000) 周期解 + 小扰动 → 长寿命混沌；
//   Pythagorean Burrau (1913)：m=3,4,5 静止释放，经典教科书初值（质点版 t≈60 弹射结局；
//   恒星有半径，深交会会先撞上——t≈9.2 m4+m5 合并，同样是对初值收敛的真实事件）；
//   random      随机束缚系（拒绝采样保证总能量为负、间距充足、角动量大致共面）。
//
// 纯逻辑零 DOM：node --test 直接测（test/threebody.test.cjs 验证周期回归/守恒量/结局事件）。

/** 单个天体。x/y 是轨道面内坐标，z 面外；m 质量，v 速度。 */
export interface Body {
  m: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
}

/** 一次积分的全部状态。merge 会减少 bodies；eject 只是标记（天体继续飞，直到 UI 换组）。 */
export interface Sim {
  bodies: Body[]
  t: number
  /** 总能量基准（初始给定；非弹性合并后重置），漂移监控用 */
  e0: number
  /** 初始角动量模 */
  l0: number
  /** 逃逸者下标；确认后不再变（null = 尚未发生） */
  eject: number | null
  /** 逃逸确认时的 sim 时间 */
  ejectAt: number | null
}

export interface FrameResult {
  /** 这一帧发生了合并：[存留下标, 被并掉下标]（存留者质量/动量已并入） */
  merged: [number, number] | null
  /** 这一帧确认了逃逸：天体下标 */
  ejected: number | null
  /** 相对能量漂移 |E−E₀|/|E₀|（合并后基准重置，天然归零） */
  drift: number
}

export const G = 1
/** 恒星半径量级（太阳半径 7e8 m / AU 1.5e11 m ≈ 0.0047，取 0.005） */
export const STAR_RADIUS = 0.005
/** 两星表面接触（2×STAR_RADIUS）即碰撞合并 */
const COLLIDE = STAR_RADIUS * 2
/** 自适应参考距离：两两距离低于它就开始细分步长 */
const NEAR = 0.3
/** 步长细分下限：dtBase/512 */
const DT_FLOOR = 1 / 512

/** 可复现随机（mulberry32）：初值生成种子化，测试与 UI 共用一套 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// —— 力与守恒量 ——

const ACC_A: number[][] = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0]
]
const ACC_B: number[][] = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0]
]

/** 逐对引力加速度，写进 out（长度随 bodies）。牛顿第三定律 → 总动量严格守恒。 */
function accelerations(bodies: Body[], out: number[][]): void {
  const n = bodies.length
  for (let i = 0; i < n; i++) {
    const o = out[i]!
    o[0] = 0
    o[1] = 0
    o[2] = 0
  }
  for (let i = 0; i < n; i++) {
    const a = bodies[i]!
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = b.z - a.z
      // +1e-12 只防 0/0；碰撞合并的阈值远大于它，奇点前事件已触发
      const d2 = dx * dx + dy * dy + dz * dz + 1e-12
      const inv = G / (d2 * Math.sqrt(d2))
      const fa = inv * b.m
      const fb = inv * a.m
      const oa = out[i]!
      const ob = out[j]!
      oa[0]! += fa * dx
      oa[1]! += fa * dy
      oa[2]! += fa * dz
      ob[0]! -= fb * dx
      ob[1]! -= fb * dy
      ob[2]! -= fb * dz
    }
  }
}

/** 总能量 E = Σ½mv² − Σ Gmᵢmⱼ/rᵢⱼ（束缚系 E<0） */
export function totalEnergy(bodies: Body[]): number {
  let ke = 0
  let pe = 0
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!
    ke += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz)
    for (let j = i + 1; j < bodies.length; j++) {
      const c = bodies[j]!
      const d = Math.hypot(c.x - b.x, c.y - b.y, c.z - b.z)
      pe -= (G * b.m * c.m) / d
    }
  }
  return ke + pe
}

/** 总角动量模 |Σ m r×v| */
export function angularMomentum(bodies: Body[]): number {
  let lx = 0
  let ly = 0
  let lz = 0
  for (const b of bodies) {
    lx += b.m * (b.y * b.vz - b.z * b.vy)
    ly += b.m * (b.z * b.vx - b.x * b.vz)
    lz += b.m * (b.x * b.vy - b.y * b.vx)
  }
  return Math.hypot(lx, ly, lz)
}

function minPair(bodies: Body[]): number {
  let d = Infinity
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i]!
      const b = bodies[j]!
      d = Math.min(d, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z))
    }
  }
  return d
}

function collidingPair(bodies: Body[]): [number, number] | null {
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i]!
      const b = bodies[j]!
      if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < COLLIDE) return [i, j]
    }
  }
  return null
}

/** 动量守恒非弹性合并：j 并入 i（质量相加、位置/速度取质心加权）。 */
function mergeInto(sim: Sim, pair: [number, number]): void {
  const [i, j] = pair
  const a = sim.bodies[i]!
  const b = sim.bodies[j]!
  const m = a.m + b.m
  a.x = (a.m * a.x + b.m * b.x) / m
  a.y = (a.m * a.y + b.m * b.y) / m
  a.z = (a.m * a.z + b.m * b.z) / m
  a.vx = (a.m * a.vx + b.m * b.vx) / m
  a.vy = (a.m * a.vy + b.m * b.vy) / m
  a.vz = (a.m * a.vz + b.m * b.vz) / m
  a.m = m
  sim.bodies.splice(j, 1)
  sim.eject = null
  sim.ejectAt = null
  // 非弹性碰撞耗散动能：守恒基准重置，漂移监控自然归零
  sim.e0 = totalEnergy(sim.bodies)
}

/** 逃逸者：距质心 > 3、相对能量为正、与另两体都已拉开 —— 三体弹射判据。 */
function escaperIndex(bodies: Body[]): number {
  let m = 0
  let cx = 0
  let cy = 0
  let cz = 0
  let px = 0
  let py = 0
  let pz = 0
  for (const b of bodies) {
    m += b.m
    cx += b.m * b.x
    cy += b.m * b.y
    cz += b.m * b.z
    px += b.m * b.vx
    py += b.m * b.vy
    pz += b.m * b.vz
  }
  const vx = px / m
  const vy = py / m
  const vz = pz / m
  cx /= m
  cy /= m
  cz /= m
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!
    const dCM = Math.hypot(b.x - cx, b.y - cy, b.z - cz)
    if (dCM < 3) continue
    let pairMin = Infinity
    let potential = 0
    for (let j = 0; j < bodies.length; j++) {
      if (j === i) continue
      const c = bodies[j]!
      const d = Math.hypot(c.x - b.x, c.y - b.y, c.z - b.z)
      pairMin = Math.min(pairMin, d)
      potential -= (G * c.m) / d
    }
    if (pairMin < 1.2) continue
    const rvx = b.vx - vx
    const rvy = b.vy - vy
    const rvz = b.vz - vz
    const eRel = 0.5 * (rvx * rvx + rvy * rvy + rvz * rvz) + potential
    if (eRel > 0) return i
  }
  return -1
}

/** 平移到质心系：零总动量、质心在原点（三体问题的标准做法，也保证投影中心不漂）。 */
function recentre(bodies: Body[]): void {
  let m = 0
  let cx = 0
  let cy = 0
  let cz = 0
  let px = 0
  let py = 0
  let pz = 0
  for (const b of bodies) {
    m += b.m
    cx += b.m * b.x
    cy += b.m * b.y
    cz += b.m * b.z
    px += b.m * b.vx
    py += b.m * b.vy
    pz += b.m * b.vz
  }
  for (const b of bodies) {
    b.x -= cx / m
    b.y -= cy / m
    b.z -= cz / m
    b.vx -= px / m
    b.vy -= py / m
    b.vz -= pz / m
  }
}

// —— 初值 ——

/** figure-8 周期解（Moore 1993 数值发现，Chinciner–Montgomery 2000 证明存在）。
 *  eps>0 时加扰动 → 长寿命混沌（轨道形状还能认出 8 字，但永不精确重复）。 */
export function makeFigure8(rng: () => number, eps = 0): Body[] {
  // 近似高斯（三次均匀平均）
  const g = (): number => (rng() + rng() + rng() - 1.5) * 1.2
  const bodies: Body[] = [
    { m: 1, x: 0.97000436, y: -0.24308753, z: 0, vx: 0.46620369, vy: 0.43236573, vz: 0 },
    { m: 1, x: -0.97000436, y: 0.24308753, z: 0, vx: 0.46620369, vy: 0.43236573, vz: 0 },
    { m: 1, x: 0, y: 0, z: 0, vx: -0.93240737, vy: -0.86473146, vz: 0 }
  ]
  if (eps > 0) {
    for (const b of bodies) {
      b.x += eps * g()
      b.y += eps * g()
      b.z += eps * g() * 0.3
      b.vx += eps * g() * 0.3
      b.vy += eps * g() * 0.3
      b.vz += eps * g() * 0.1
    }
  }
  recentre(bodies)
  return bodies
}

/** Pythagorean 问题（Burrau 1913）：m=3,4,5 置于 3-4-5 直角三角形顶点，静止释放。
 *  经典教科书初值：质点版在 t≈60 弹射；恒星有半径时 m4+m5 在 t≈9.2 先合并（对步长收敛）。 */
export function makePythagorean(): Body[] {
  const bodies: Body[] = [
    { m: 3, x: 1, y: 3, z: 0, vx: 0, vy: 0, vz: 0 },
    { m: 4, x: -2, y: -2, z: 0, vx: 0, vy: 0, vz: 0 },
    { m: 5, x: 1, y: -1, z: 0, vx: 0, vy: 0, vz: 0 }
  ]
  recentre(bodies)
  return bodies
}

/** 随机束缚初值：随机质量、准平面盘内随机位置（保持间距）、切向速度为主，
 *  拒绝采样直到总能量为负（束缚系，不会开局就散）。 */
export function makeRandomIC(rng: () => number): Body[] {
  for (let tries = 0; tries < 64; tries++) {
    const bodies: Body[] = []
    for (let i = 0; i < 3; i++) {
      bodies.push({ m: 0.7 + rng() * 1.7, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })
    }
    let placed = false
    for (let k = 0; k < 24 && !placed; k++) {
      for (const b of bodies) {
        const a = rng() * Math.PI * 2
        const r = 0.35 + rng() * 0.8
        b.x = Math.cos(a) * r
        b.y = Math.sin(a) * r
        b.z = (rng() * 2 - 1) * 0.22
      }
      placed = minPair(bodies) > 0.6
    }
    if (!placed) continue
    const mTot = bodies.reduce((s, b) => s + b.m, 0)
    const dir = rng() < 0.85 ? 1 : -1 // 大概率同向绕转（真实恒星系共面成因的弱化版）
    for (const b of bodies) {
      const r = Math.hypot(b.x, b.y) || 0.3
      const vc = Math.sqrt((G * mTot) / r)
      const tx = (-dir * b.y) / r
      const ty = (dir * b.x) / r
      const speed = (0.5 + rng() * 0.45) * vc
      b.vx = tx * speed + (rng() * 2 - 1) * 0.12 * vc
      b.vy = ty * speed + (rng() * 2 - 1) * 0.12 * vc
      b.vz = (rng() * 2 - 1) * 0.06 * vc
    }
    recentre(bodies)
    if (totalEnergy(bodies) < -0.05) return bodies
  }
  // 64 次抽不中束缚系几乎不可能；兜底给 figure-8 扰动版
  return makeFigure8(rng, 0.01)
}

export type SolutionKind = 'figure8' | 'pythagorean' | 'random'

/** 挑一组初值建 Sim：random 一半（每组都不同），figure-8 与 Burrau 各约四分之一。
 *  返回的 label 是初值来源（HUD 遥测行显示——这不是随便飞的点，是有出处的三体解）。 */
export function initSolution(rng: () => number): { sim: Sim; label: string; kind: SolutionKind } {
  const roll = rng()
  let bodies: Body[]
  let label: string
  let kind: SolutionKind
  if (roll < 0.5) {
    bodies = makeRandomIC(rng)
    label = 'RANDOM IC'
    kind = 'random'
  } else if (roll < 0.78) {
    bodies = makeFigure8(rng, 0.004 + rng() * 0.012)
    label = 'FIGURE-8'
    kind = 'figure8'
  } else {
    bodies = makePythagorean()
    label = 'BURRAU 3-4-5'
    kind = 'pythagorean'
  }
  return {
    sim: { bodies, t: 0, e0: totalEnergy(bodies), l0: angularMomentum(bodies), eject: null, ejectAt: null },
    label,
    kind
  }
}

/** 推进 dtTotal 的 sim 时间：内部按两两距离自适应细分子步，返回这一帧的事件。
 *  dtBase 是正常（远处）步长；近距时实际步长最低细分到 dtBase/512。 */
export function advance(sim: Sim, dtTotal: number, dtBase = 4e-3): FrameResult {
  const res: FrameResult = { merged: null, ejected: null, drift: 0 }
  // 子步上限：正常需要 dtTotal/dtBase 步，近距细分最多再乘 512；放宽一点防边界抖动。
  // 单次调用最多推 60 单位 sim 时间（防御性截断；UI 每帧只推 ~0.012，碰不到）
  const guard = Math.max(4096, Math.ceil(dtTotal / dtBase) * 700)
  let remaining = Math.max(0, Math.min(dtTotal, 60))
  let steps = 0
  while (remaining > 1e-12 && steps++ < guard) {
    const frac = Math.min(1, (minPair(sim.bodies) / NEAR) ** 2)
    const sub = Math.min(remaining, dtBase * Math.max(frac, DT_FLOOR))
    // velocity Verlet 一步
    const n = sim.bodies.length
    accelerations(sim.bodies, ACC_A)
    for (let i = 0; i < n; i++) {
      const b = sim.bodies[i]!
      const a = ACC_A[i]!
      b.x += b.vx * sub + 0.5 * a[0]! * sub * sub
      b.y += b.vy * sub + 0.5 * a[1]! * sub * sub
      b.z += b.vz * sub + 0.5 * a[2]! * sub * sub
    }
    accelerations(sim.bodies, ACC_B)
    for (let i = 0; i < n; i++) {
      const b = sim.bodies[i]!
      const a = ACC_A[i]!
      const c = ACC_B[i]!
      b.vx += 0.5 * (a[0]! + c[0]!) * sub
      b.vy += 0.5 * (a[1]! + c[1]!) * sub
      b.vz += 0.5 * (a[2]! + c[2]!) * sub
    }
    sim.t += sub
    remaining -= sub
    // 碰撞合并（一帧最多处理一次：物理少推 <1 子步，无碍；UI 标签同步才不乱）
    const pair = collidingPair(sim.bodies)
    if (pair) {
      mergeInto(sim, pair)
      res.merged = pair
      break
    }
  }
  // 逃逸检测（三体都在时才判；确认一次后不再重复报）
  if (sim.eject == null && sim.bodies.length === 3) {
    const i = escaperIndex(sim.bodies)
    if (i >= 0) {
      sim.eject = i
      sim.ejectAt = sim.t
      res.ejected = i
    }
  }
  res.drift = Math.abs(totalEnergy(sim.bodies) - sim.e0) / Math.max(Math.abs(sim.e0), 1e-9)
  return res
}
