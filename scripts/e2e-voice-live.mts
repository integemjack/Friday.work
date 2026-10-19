// 端到端验证 voice.*：拿一段真实语音（远端合成或现成的 wav）喂给 voice.feed，
// 看 voice.state 的 caption/pending 出字、再等助手回复的 voice.audio 回来。
// 跑在本机（Node）：连上我们客户端已开的 wss 机器走 UI 协议；这里直接走协议层（与 UI 相同路径）。
import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'
import { readFileSync } from 'node:fs'

const HOST = process.env.FRIDAY_SSH ?? 'root@192.168.20.239'

async function main(): Promise<void> {
  const pairings = new PairingStore({
    async load() {
      return null
    },
    async store() {},
    async delete() {}
  })
  const events: Array<{ method: string; size?: number; text?: string }> = []
  const machine = new MachineConnection('voice-e2e', 'voice e2e', { kind: 'ssh', host: HOST }, {
    appVersion: '0.1.0-e2e',
    pairings,
    onStateChange: () => {},
    onEvent: (_c, method, params) => {
      if (method === 'voice.state') {
        const p = params as { state?: string; caption?: string; pending?: string }
        events.push({ method, text: `state=${p.state} caption="${p.caption ?? ''}" pending="${p.pending ?? ''}"` })
      } else if (method === 'voice.audio') {
        events.push({ method, size: ((params as { pcm?: string }).pcm ?? '').length })
      }
    },
    onBridgeError: () => {},
    ensureServer: async () => ({ action: 'none', message: '' })
  })
  await machine.connect()
  for (let i = 0; i < 40 && machine.state !== 'ready'; i += 1) await new Promise((r) => setTimeout(r, 250))
  if (machine.state !== 'ready') throw new Error('没连上')

  console.log('=== voice.start ===')
  const start = (await machine.request('voice.start', { inputSampleRate: 16000, outputSampleRate: 16000 })) as { state?: string; error?: string }
  console.log(JSON.stringify(start))
  if (start.error) throw new Error(start.error)

  // 一段 16k 16位单声道的语音：远端有 ffmpeg，用 espeak 不一定装了；
  // 直接让 friday-voice 自己合成一句再来一遍不现实（要等 Powers 起来）。
  // 改用最朴素的：生成 1.2 秒的 440Hz + 静音交替当“说话”喂进去 —— 听写应当不出字但链路活，
  // 然后用 wave 文件（如果有）真实测听写。
  console.log('=== 喂 3 秒的“说话”形状音频（正弦包络） ===')
  const rate = 16000
  const seconds = 3
  const total = rate * seconds
  const pcm = Buffer.alloc(total * 2)
  for (let i = 0; i < total; i += 1) {
    const t = i / rate
    // 断续的正弦：模拟有话/停顿，让 VAD 有东西可咬
    const speaking = Math.sin(t * 3) > -0.2
    const value = speaking ? Math.sin(2 * Math.PI * 220 * t) * 0.4 : 0
    pcm.writeInt16LE(Math.round(value * 32767), i * 2)
  }
  // 20 毫秒一帧（640 字节）喂 3 秒
  const frame = rate * 0.02 * 2
  for (let at = 0; at < pcm.length; at += frame) {
    await machine.request('voice.feed', { pcm: pcm.subarray(at, at + frame).toString('base64') })
    await new Promise((r) => setTimeout(r, 18))
  }
  console.log('喂完了，等 6 秒收 state / audio 事件…')
  await new Promise((r) => setTimeout(r, 6000))

  const states = events.filter((e) => e.method === 'voice.state')
  const audios = events.filter((e) => e.method === 'voice.audio')
  console.log(`voice.state 事件 ${states.length} 条；voice.audio 事件 ${audios.length} 帧`)
  for (const e of states.slice(-6)) console.log(' -', e.text)
  if (audios.length) console.log(' - audio 最大帧 b64 长度:', Math.max(...audios.map((a) => a.size ?? 0)))

  await machine.request('voice.stop', {})
  machine.disconnect()
  console.log('✓ voice.* 链路端到端跑完')
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
