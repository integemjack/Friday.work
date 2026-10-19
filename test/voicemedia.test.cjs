// 实时语音的客户端媒体逻辑（纯函数部分）：
// 麦克风 48k Float32 → 重采样 16k → PCM16 小端 → base64 帧；回来的 base64 → PCM16 → Float32 → 播放。
// 锁住的是采样率、字节序、幅度这三件容易悄悄错的事。
const test = require('node:test')
const assert = require('node:assert')

const { toPcm16, pcmToFloat32, pcmFromBase64, resample } = require('../.tmp/voicemedia.cjs')

/** 64 Hz 正弦，给够长的样本 */
function sine(rate, seconds, freq = 440) {
  const out = new Float32Array(Math.floor(rate * seconds))
  for (let i = 0; i < out.length; i += 1) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.5
  return out
}

test('PCM16：小端、幅度不越界、往返一致', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -1.5])
  const buffer = toPcm16(input)
  const view = new DataView(buffer)
  assert.equal(buffer.byteLength, input.length * 2, '16 位 = 每采样两字节')
  assert.equal(view.getInt16(0, true), 0)
  // 正数按 32767 放、负数按 32768 放（setInt16 截断，所以 0.5 是 16383 而不是 16384）
  assert.equal(view.getInt16(2, true), 16383, '0.5 → 16383')
  assert.equal(view.getInt16(4, true), -16384, '-0.5 → -16384')
  assert.equal(view.getInt16(6, true), 32767, '1 顶到 32767')
  assert.equal(view.getInt16(8, true), -32768)
  assert.equal(view.getInt16(10, true), 32767, '>1 被夹住')
  assert.equal(view.getInt16(12, true), -32768, '<-1 被夹住')

  const back = pcmToFloat32(buffer)
  for (let i = 0; i < 5; i += 1) assert.ok(Math.abs(back[i] - Math.max(-1, Math.min(1, input[i]))) < 1e-4)
})

test('base64 往返（语音帧的传输格式）', () => {
  const pcm = toPcm16(sine(16000, 0.02))
  const base64 = Buffer.from(pcm).toString('base64')
  const back = pcmFromBase64(base64)
  assert.equal(back.byteLength, pcm.byteLength)
  assert.deepEqual(new Uint8Array(back), new Uint8Array(pcm))
})

test('重采样 48k → 16k：长度是三分之一，波形还认得出', () => {
  const input = sine(48000, 0.1)
  const out = resample(input, 48000, 16000)
  assert.ok(Math.abs(out.length - input.length / 3) <= 2, `长度 ${out.length} 应当约为 ${input.length / 3}`)
  // 峰峰值仍在 0.5 附近（线性插值不会把幅度打没）
  let peak = 0
  for (const value of out) peak = Math.max(peak, Math.abs(value))
  assert.ok(peak > 0.4 && peak <= 0.52, `峰值 ${peak.toFixed(3)}`)
})

test('重采样：同采样率原样返回', () => {
  const input = sine(16000, 0.01)
  assert.equal(resample(input, 16000, 16000), input)
})

test('一帧 20 毫秒正好 640 字节（和服务端 kFrameBytes 一致）', () => {
  const frame = toPcm16(sine(16000, 0.02))
  assert.equal(frame.byteLength, 640)
})
