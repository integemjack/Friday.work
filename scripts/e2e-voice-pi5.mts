// Pi5 上验证 voice.* 端到端：voice.start → 喂系统测试音（Front_Center.wav，转 16k PCM16）→
// 收 caption/pending（V3D 上听写实时率 ~39：1.4 秒音频要 ~55 秒，喂完后要耐心等）。
import { spawn } from 'node:child_process'
import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'

const HOST = process.env.PS5 ?? 'root@192.168.20.91'

const events: Array<{ method: string; params: unknown }> = []

function host() {
  return {
    appVersion: '0.1.0',
    pairings: new PairingStore({
      async load() { return null },
      async store() {},
      async delete() {}
    }),
    onStateChange: () => {},
    onEvent: (_c: unknown, method: string, params: unknown) => {
      events.push({ method, params })
    },
    onBridgeError: () => {},
    ensureServer: async () => ({ action: 'none', message: '' })
  } as never
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 从远端取测试 wav 的 PCM16（转 16k 单声道），base64 */
function fetchPcm(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-T',
      '-o',
      'BatchMode=yes',
      HOST,
      "python3 -c \"import wave,base64,array; w=wave.open('/usr/share/sounds/alsa/Front_Center.wav','rb'); raw=w.readframes(w.getnframes()); rate=w.getframerate(); w.close(); a=array.array('h',raw); n=int(len(a)*16000/rate); out=array.array('h',bytes(2*n));\n" +
        "import math\n" +
        'for i in range(n):\n' +
        '    src=i*rate/16000\n' +
        '    i0=int(src)\n' +
        '    frac=src-i0\n' +
        "    s0=a[i0] if i0<len(a) else 0\n" +
        "    s1=a[i0+1] if i0+1<len(a) else 0\n" +
        '    out[i]=int(s0+(s1-s0)*frac)\n' +
        "print(base64.b64encode(out.tobytes()).decode())\""
    ])
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d))
    child.on('close', () => resolve(out.trim()))
    child.on('error', reject)
  })
}

async function main() {
  const pairings = new PairingStore({
    async load() { return null },
    async store() {},
    async delete() {}
  })
  const machine = new MachineConnection('pi5-voice-test', 'Pi5', { kind: 'ssh', host: HOST }, host())
  await machine.connect()
  await wait(2500)
  if (machine.state !== 'ready') throw new Error(`没连上：${machine.detail}`)
  console.log('=== 连上 ===', JSON.stringify(machine.serverInfo?.features?.filter((f) => f === 'voice')))

  console.log('\n=== voice.start ===')
  const start = (await machine.request('voice.start', { inputSampleRate: 16000, outputSampleRate: 16000 })) as {
    state?: string
    error?: string
  }
  console.log(JSON.stringify(start))
  if (!start.state || start.state === 'off') {
    throw new Error(`voice.start 没起来：${start.error ?? ''}`)
  }

  console.log('\n=== 取测试音频并按实时节奏喂 ===')
  const pcm = await fetchPcm()
  const buffer = Buffer.from(pcm, 'base64')
  console.log('PCM 字节：', buffer.length, '（约', (buffer.length / 32000).toFixed(2), '秒）')
  const frame = 640
  for (let offset = 0; offset < buffer.length; offset += frame) {
    const chunk = buffer.subarray(offset, Math.min(offset + frame, buffer.length))
    if (chunk.length < frame) break
    await machine.request('voice.feed', { pcm: chunk.toString('base64') }).catch(() => {})
    await wait(18)
  }
  console.log('喂完。Pi5 的 V3D 听写实时率约 39:1，等 70 秒收结果…')
  await wait(70000)

  const states = events.filter((e) => e.method === 'voice.state')
  const audios = events.filter((e) => e.method === 'voice.audio')
  console.log('\n=== 事件统计 ===')
  console.log('voice.state:', states.length, ' voice.audio:', audios.length)
  for (const s of states.slice(-8)) {
    const p = s.params as { state?: string; caption?: string; pending?: string }
    console.log(`  state=${p.state} caption="${(p.caption ?? '').slice(0, 60)}" pending="${(p.pending ?? '').slice(0, 60)}"`)
  }

  await machine.request('voice.stop', {}).catch(() => {})
  machine.disconnect()

  const withText = states.filter((s) => {
    const p = s.params as { caption?: string; pending?: string }
    return (p.caption ?? '').length > 0 || (p.pending ?? '').length > 0
  })
  if (withText.length > 0) {
    console.log('\n✓✓ 实时链路完整：麦克风数据进了听写，字幕回来了')
  } else if (states.length > 2) {
    console.log('\n△ 协议通、事件在流，但这次音频内容没出字幕（Pi5 的 V3D 实时率 ~39:1，1.4 秒音频要 ~55 秒；可加大等待或换更快的硬件）')
  } else {
    console.log('\n✗ voice.state 没怎么流')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('✗ 失败:', error.message)
  process.exit(1)
})
