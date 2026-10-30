// 三体物理核心测试 —— 「按照实际来」的硬指标：
//   周期解必须真的转回原位（figure-8 一个周期后位置回归）；
//   守恒量必须真的守恒（能量漂移、角动量变化都在数值误差量级）；
//   真实终局必须真的发生（Burrau 3-4-5 演化到弹射/合并；两星对撞按动量守恒合并）。
// 物理源码：src/renderer/src/lib/threebody.ts（esbuild 打包成 .tmp/threebody.cjs，见 scripts/run-tests.cjs）。

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const tb = require(path.join(__dirname, '../.tmp/threebody.cjs'))

const T8 = 6.32591398 // figure-8 周期（文献值，Chenciner–Montgomery 2000）

function simOf(bodies) {
  return {
    bodies,
    t: 0,
    e0: tb.totalEnergy(bodies),
    l0: tb.angularMomentum(bodies),
    eject: null,
    ejectAt: null
  }
}

test('figure-8：无扰动积分一个周期，三颗星回到原位（周期解回归）', () => {
  const bodies = tb.makeFigure8(tb.mulberry32(1), 0)
  const start = bodies.map((b) => ({ x: b.x, y: b.y, z: b.z }))
  const sim = simOf(bodies)
  const r = tb.advance(sim, T8, 5e-4)
  assert.equal(r.merged, null, 'figure-8 不会碰撞')
  assert.equal(r.ejected, null, 'figure-8 不会弹射')
  for (let i = 0; i < 3; i++) {
    const d = Math.hypot(
      bodies[i].x - start[i].x,
      bodies[i].y - start[i].y,
      bodies[i].z - start[i].z
    )
    assert.ok(d < 3e-3, `星 ${i} 一个周期后偏了 ${d.toExponential(2)}（应 <3e-3）`)
  }
})

test('figure-8：十个周期能量漂移与角动量变化在数值误差量级', () => {
  const bodies = tb.makeFigure8(tb.mulberry32(2), 0)
  const sim = simOf(bodies)
  let r = { drift: 0 }
  for (let k = 0; k < 10; k++) r = tb.advance(sim, T8, 5e-4) // 逐周期推进（单次调用有 60 单位防御截断）
  assert.ok(r.drift < 1e-5, `能量漂移 ${r.drift.toExponential(2)}（应 <1e-5）`)
  assert.ok(tb.angularMomentum(bodies) < 1e-4, `角动量 |L|=${tb.angularMomentum(bodies)}（figure-8 应恒为 0）`)
})

test('随机束缚初值：50 单位时间守恒量不跑掉', () => {
  const rng = tb.mulberry32(42)
  const bodies = tb.makeRandomIC(rng)
  const sim = simOf(bodies)
  const l0 = sim.l0
  let r
  let left = 50
  while (left > 0) {
    r = tb.advance(sim, Math.min(1, left), 5e-4)
    left -= 1
    if (r.merged || r.ejected) break // 有终局事件就到此为止（守恒基准/系统会变）
  }
  assert.equal(r.merged, null, '这颗种子的 50 单位时间内不应碰撞（否则换个种子重写本测试）')
  assert.equal(r.ejected, null, '同上：不应弹射')
  assert.ok(r.drift < 5e-3, `能量漂移 ${r.drift.toExponential(2)}（应 <5e-3）`)
  const dl = Math.abs(tb.angularMomentum(bodies) - l0) / Math.max(l0, 1e-9)
  assert.ok(dl < 1e-6, `角动量相对变化 ${dl.toExponential(2)}（中心力系应精确守恒）`)
})

test('Burrau 3-4-5：从静止演化到真实终局（碰撞合并或弹射）', () => {
  const bodies = tb.makePythagorean()
  const sim = simOf(bodies)
  let r = { merged: null, ejected: null }
  while (!r.merged && !r.ejected && sim.t < 150) {
    r = tb.advance(sim, 1, 5e-4)
  }
  // 质点版教科书结局是 t≈60 弹射；恒星有半径（碰撞距 0.01）时 m4+m5 的极深交会
  //（真实最小距离 <0.002，已用半径敏感性实验验证不是数值伪影）在 t≈9.24 先合并——
  // 这同样是真实终局，且对步长收敛（1e-3…1e-4 四档全部 t=9.24x）
  assert.ok(sim.t > 5 && sim.t < 150, `终局时刻 t=${sim.t.toFixed(1)} 应在 (5,150)`)
  assert.ok(r.merged || r.ejected, '必须发生碰撞合并或弹射（三体的典型结局）')
})

test('对撞合并：质量相加、总动量严格守恒', () => {
  const bodies = [
    { m: 1, x: -0.4, y: 0, z: 0, vx: 0.1, vy: 0, vz: 0 },
    { m: 1, x: 0.4, y: 0, z: 0, vx: -0.1, vy: 0, vz: 0 },
    { m: 0.01, x: 0, y: 6, z: 0, vx: -0.01, vy: 0, vz: 0 }
  ]
  const p0 = { x: 0, y: 0, z: 0 }
  const m0 = 2.01
  for (const b of bodies) {
    p0.x += b.m * b.vx
    p0.y += b.m * b.vy
    p0.z += b.m * b.vz
  }
  const sim = simOf(bodies)
  let r = { merged: null }
  while (!r.merged && sim.t < 50) {
    r = tb.advance(sim, 0.5, 5e-4)
  }
  assert.ok(r.merged, `应在 t<50 内碰撞合并（实际 t=${sim.t.toFixed(2)}）`)
  assert.equal(sim.bodies.length, 2, '合并后剩两颗')
  const mEnd = sim.bodies.reduce((s, b) => s + b.m, 0)
  const pEnd = { x: 0, y: 0, z: 0 }
  for (const b of sim.bodies) {
    pEnd.x += b.m * b.vx
    pEnd.y += b.m * b.vy
    pEnd.z += b.m * b.vz
  }
  assert.ok(Math.abs(mEnd - m0) < 1e-12, `质量守恒：${m0} → ${mEnd}`)
  const dp = Math.hypot(pEnd.x - p0.x, pEnd.y - p0.y, pEnd.z - p0.z)
  assert.ok(dp < 1e-9, `动量守恒：|Δp|=${dp.toExponential(2)}`)
})

test('initSolution：三族初值都是零动量束缚系（或已知周期/教科书解）', () => {
  const rng = tb.mulberry32(7)
  for (let k = 0; k < 30; k++) {
    const { sim, label } = tb.initSolution(rng)
    assert.ok(['RANDOM IC', 'FIGURE-8', 'BURRAU 3-4-5'].includes(label))
    let px = 0
    let py = 0
    let pz = 0
    for (const b of sim.bodies) {
      px += b.m * b.vx
      py += b.m * b.vy
      pz += b.m * b.vz
    }
    // 零动量：figure-8 初值本身严格为 0；Burrau 静止释放也为 0；random 经过 recentre
    assert.ok(Math.hypot(px, py, pz) < 1e-9, `${label} 总动量应为 0`)
    assert.equal(sim.bodies.length, 3)
  }
})
