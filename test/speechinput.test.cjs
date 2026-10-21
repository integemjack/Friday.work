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

test('说话 → 静音 600ms → 切出一句（开头带预滚前导）', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  const out = []
  // 先 500ms 静音（预滚窗口内），再 1 秒语音
  for (let i = 0; i < 4; i += 1) out.push(...slicer.push(frame(0)))
  for (let i = 0; i < 8; i += 1) out.push(...slicer.push(frame(0.3)))
  // 800ms 静音（> 600ms 断句阈值）
  for (let i = 0; i < 7; i += 1) out.push(...slicer.push(frame(0)))
  assert.equal(out.length, 1, '切出一句')
  const sec = out[0].length / RATE
  // ≈ 300ms 预滚 + 1s 语音 + 100ms 尾垫，静音尾被切掉
  assert.ok(sec > 1.2 && sec < 1.6, `句长 ${sec.toFixed(2)}s（预滚+语音+尾垫）`)
  // 开头 300ms 预滚：句首应包含开口前 300ms 的静音段（全零开头）
  assert.ok(out[0][0] === 0 && out[0][Math.floor(0.1 * RATE)] === 0, '句首带前导静音')
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
  assert.ok(out[0].length / RATE > 11.5 && out[0].length / RATE < 12.6, '第一句约 12 秒（从开口起算，预滚不计）')
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

test('弱起音：低于阈值的开头弱音频也被带上（不漏首字）', () => {
  const slicer = new UtteranceSlicer(RATE, 0.05) // 阈值调高，模拟噪声底高
  const out = []
  // 250ms 弱起音（低于阈值，VAD 不认为开口）——真实场景里首字辅音/浊音起始常这样
  out.push(...slicer.push(frame(0.02, 0.13)))
  out.push(...slicer.push(frame(0.02, 0.12)))
  // 然后强语音
  for (let i = 0; i < 8; i += 1) out.push(...slicer.push(frame(0.3)))
  for (let i = 0; i < 7; i += 1) out.push(...slicer.push(frame(0)))
  assert.equal(out.length, 1)
  const sec = out[0].length / RATE
  // 弱起音落在预滚窗口内，必须被切进句子里
  assert.ok(sec > 1.1, `句长 ${sec.toFixed(2)}s（含弱起音前导）`)
  // 弱起音本身在句首（前 250ms 里有非零样本）
  let nonZero = 0
  for (let i = 0; i < Math.floor(0.25 * RATE); i += 1) if (out[0][i] !== 0) nonZero += 1
  assert.ok(nonZero > 0.1 * RATE, '句首包含弱起音样本')
})

test('padSilence：前面垫指定时长静音', () => {
  const { padSilence } = require('../.tmp/speechinput.cjs')
  const audio = new Float32Array(1600).fill(0.5)
  const padded = padSilence(audio, RATE, 150)
  assert.equal(padded.length, audio.length + 0.15 * RATE)
  assert.equal(padded[0], 0, '开头是静音')
  assert.ok(Math.abs(padded[2400] - 0.5) < 1e-6, '原音频接在后面')
})

test('flush：说了一半直接收尾，把半句吐出来（含预滚）', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  for (let i = 0; i < 8; i += 1) slicer.push(frame(0.3))
  const out = slicer.flush()
  assert.equal(out.length, 1)
  assert.ok(out[0].length / RATE > 1.0, `半句长 ${(out[0].length / RATE).toFixed(2)}s（含预滚前导）`)
})

test('flush：没说话时收尾，空', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  for (let i = 0; i < 8; i += 1) slicer.push(frame(0))
  assert.equal(slicer.flush().length, 0)
})

test('纯静音永不成句（没人说话就不产生转写）', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  const out = []
  for (let i = 0; i < 50; i += 1) out.push(...slicer.push(frame(0))) // 6 秒多纯静音
  assert.equal(out.length, 0, '纯静音无输出')
  assert.equal(slicer.flush().length, 0)
})

test('太短的话段（<0.2s 的杂音）被丢弃：断句裁掉静音尾后不足 200ms', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  const out = []
  out.push(...slicer.push(frame(0.3, 0.05))) // 50ms 杂音（触发开口）
  for (let i = 0; i < 7; i += 1) out.push(...slicer.push(frame(0)))
  // 杂音前没有预滚内容，断句后只剩杂音+尾垫 <200ms，丢弃
  assert.equal(out.length, 0, '短杂音不成句')
})

test('预滚太久的杂音不再保留：preroll 只留最近 300ms', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  const out = []
  out.push(...slicer.push(frame(0.3, 0.05))) // 杂音
  for (let i = 0; i < 3; i += 1) out.push(...slicer.push(frame(0))) // ~384ms 静音：杂音已被挤出预滚窗口
  for (let i = 0; i < 8; i += 1) out.push(...slicer.push(frame(0.3))) // 然后真说话
  for (let i = 0; i < 7; i += 1) out.push(...slicer.push(frame(0)))
  assert.equal(out.length, 1)
  // 句首是静音（挤出杂音后的预滚），不是 384ms 前的杂音
  assert.ok(out[0][0] === 0, '句首不含被挤出的旧杂音')
})

test('阈值可动态调（噪声底估计后上调）', () => {
  const slicer = new UtteranceSlicer(RATE, 0.01)
  slicer.threshold = 0.05
  const out = []
  for (let i = 0; i < 8; i += 1) out.push(...slicer.push(frame(0.04))) // 高于原阈值、低于新阈值
  assert.equal(out.length, 0, '小幅噪声不再触发开口')
})
