// 实时语音的媒体侧（方案 §6.2 M3-B 的客户端一半）：
//   麦克风 → AudioContext 48k → 重采样到 16k → PCM16 小端 → base64 帧（20 毫秒一帧）
//   服务端回来的 PCM16（16k）→ AudioContext 播放，播了多少采样报回去（念到哪）。
//
// 全部用 WebAudio，不依赖任何原生模块；回声消除 / 降噪 / 自动增益交给 Chromium。

const TARGET_RATE = 16000
/** 一帧 20 毫秒（16 kHz 16 位单声道 = 640 字节），和服务端 kFrameBytes 一致 */
const FRAME_MS = 20

/** Float32 [-1,1] → 16 位小端 PCM */
export function toPcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return buffer
}

/** base64 → ArrayBuffer */
export function pcmFromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** 16 位小端 PCM → Float32 */
export function pcmToFloat32(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer)
  const out = new Float32Array(buffer.byteLength / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 0x8000
  return out
}

/** 线性重采样（质量够语音用；服务端听写自己也会做降噪） */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const at = i * ratio
    const left = Math.floor(at)
    const right = Math.min(left + 1, input.length - 1)
    const weight = at - left
    out[i] = (input[left] ?? 0) * (1 - weight) + (input[right] ?? 0) * weight
  }
  return out
}

export class VoiceMedia {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private leftover: Float32Array = new Float32Array(0)
  private playHead = 0
  private playing = 0

  /** 起麦克风；onFrame 收到一帧 20 毫秒的 16k PCM16 */
  async start(onFrame: (base64: string) => void): Promise<void> {
    this.context = new AudioContext()
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    })
    this.source = this.context.createMediaStreamSource(this.stream)
    // ScriptProcessor 已废弃但到处能用；一帧 4096 采样，攒够 20 毫秒就发
    this.processor = this.context.createScriptProcessor(4096, 1, 1)
    const frameSamples = (TARGET_RATE * FRAME_MS) / 1000

    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      const resampled = resample(input, this.context?.sampleRate ?? 48000, TARGET_RATE)
      // 和上一块剩下的拼起来，凑够整帧再发
      const merged = new Float32Array(this.leftover.length + resampled.length)
      merged.set(this.leftover)
      merged.set(resampled, this.leftover.length)
      let at = 0
      while (merged.length - at >= frameSamples) {
        const frame = merged.subarray(at, at + frameSamples)
        at += frameSamples
        onFrame(bytesToBase64(toPcm16(frame)))
      }
      this.leftover = merged.slice(at)
    }
    // 接上但不接到扬声器（否则自己听自己）；连到 destination 才能被驱动
    const mute = this.context.createGain()
    mute.gain.value = 0
    this.source.connect(this.processor)
    this.processor.connect(mute)
    mute.connect(this.context.destination)
  }

  /** 播一段 16k PCM16；onPlayed 报已经放了多少采样 */
  play(base64: string, onPlayed: (samples: number) => void): void {
    const context = this.context
    if (!context) return
    const floats = pcmToFloat32(pcmFromBase64(base64))
    const buffer = context.createBuffer(1, floats.length, TARGET_RATE)
    // TS 把 Float32Array 的 buffer 类型分得很细（可能带 SharedArrayBuffer），复制一份干净的
    const clean = new Float32Array(floats.length)
    clean.set(floats)
    buffer.copyToChannel(clean, 0)
    const node = context.createBufferSource()
    node.buffer = buffer
    node.connect(context.destination)
    const at = Math.max(context.currentTime, this.playHead)
    node.start(at)
    this.playHead = at + buffer.duration
    this.playing += 1
    node.onended = () => {
      this.playing -= 1
      onPlayed(floats.length)
    }
  }

  /** 还没放完的都丢掉（打断） */
  stopPlayback(): void {
    this.playHead = this.context?.currentTime ?? 0
    this.playing = 0
  }

  isPlaying(): boolean {
    return this.playing > 0
  }

  stop(): void {
    this.processor?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()
    this.processor = null
    this.source = null
    this.stream = null
    this.context = null
    this.leftover = new Float32Array(0)
    this.playing = 0
  }
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
