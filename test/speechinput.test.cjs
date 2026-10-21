// 语音听写的分句器（纯函数部分）：能量 VAD 切句。
// 锁住三件事：静音 600ms 断句、话段前后留 pad、首句前的长静音不无限攒内存。
const test = require('node:test')
const assert = require('node:assert')

const { UtteranceSlicer, frameRms } = require('../.tmp/speechinput.cjs')

const RATE = 16000

/** 模拟一帧（128ms = 2048 采样，和渲染侧 ScriptProcessor 一致） */
function frame(loud, seconds = 0.128) {
  const n = Math.floor(RATE * seconds)
  const out = new Float32Array(n)
  if (loud > 0) {
    // 有声：220Hz 正弦到指定幅度（RMS ≈ 幅度/√2）
    for (let i = 0; i < n; i += 1) out[i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * loud
  }
  return out
}

test('RMS：静音帧为 0，正弦帧约为幅度/√2', () => {
  assert.equal(frameRms(frame(0)), 0)
  const rms = frameRms(frame(0.2))
  assert.ok(Math.abs(rms - 0.2 / Math.SQRT2) < 0.01, `rms=${rms}`)
})

test('说话 → 静音 600ms → 切出一句', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  const out = []
  // 1 秒语音
  for (let i = 0; i < 8; i += 1) out.push(...slicer.push(frame(0.3)))
  // 800ms 静音（> 600ms 断句阈值）
  for (let i = 0; i < 7; i += 1) out.push(...slicer.push(frame(0)))
  assert.equal(out.length, 1, '切出一句')
  const sec = out[0].length / RATE
  assert.ok(sec > 0.9 && sec < 1.3, `句长 ${sec.toFixed(2)}s（≈1s 语音 + pad，静音尾被切掉）`)
})

test('说话不停：一直不出句（还在句中）', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  const out = []
  for (let i = 0; i < 40; i += 1) out.push(...slicer.push(frame(0.3))) // 5 秒连续说话
  assert.equal(out.length, 0, '5 秒连续语音不切句')
})

test('连续说话超过 12 秒强制切句', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  const out = []
  for (let i = 0; i < 110; i += 1) out.push(...slicer.push(frame(0.3))) // ~14 秒
  assert.equal(out.length, 1, '超长强制切出第一句')
  assert.ok(out[0].length / RATE > 11, '第一句约 12 秒')
})

test('静音 400ms 不切（还在等下文），再说话并到同一句', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  const out = []
  for (let i = 0; i < 8; i += 1) out.push(...slicer.push(frame(0.3))) // 1s 语音
  for (let i = 0; i < 3; i += 1) out.push(...slicer.push(frame(0)))   // ~0.38s 静音
  for (let i = 0; i < 8; i += 1) out.push(...slicer.push(frame(0.3))) // 又 1s 语音
  for (let i = 0; i < 7; i += 1) out.push(...slicer.push(frame(0)))   // 0.9s 静音收尾
  assert.equal(out.length, 1, '短停顿不断句，两句并成一句')
  assert.ok(out[0].length / RATE > 2, '句长含两段语音')
})

test('flush：说了一半直接收尾，把半句吐出来', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  for (let i = 0; i < 8; i += 1) slicer.push(frame(0.3))
  const out = slicer.flush()
  assert.equal(out.length, 1)
  assert.ok(out[0].length / RATE > 0.9, `半句长 ${(out[0].length / RATE).toFixed(2)}s`)
})

test('flush：没说话时收尾，空', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  for (let i = 0; i < 8; i += 1) slicer.push(frame(0))
  assert.equal(slicer.flush().length, 0)
})

test('太短的话段（<0.2s 的杂音）被丢弃', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  const out = []
  out.push(...slicer.push(frame(0.3, 0.05))) // 50ms 杂音
  for (let i = 0; i < 7; i += 1) out.push(...slicer.push(frame(0)))
  assert.equal(out.length, 0, '短杂音不成句')
})

test('阈值可动态调（噪声底估计后上调）', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  slicer.threshold = 0.05
  const out = []
  for (let i = 0; i < 8; i += 1) out.push(...slicer.push(frame(0.04))) // 高于原阈值、低于新阈值
  assert.equal(out.length, 0, '小幅噪声不再触发开口')
})
