// 语音听写（本地 whisper，主进程推理）：麦克风 → AudioContext → 重采样 16k → Float32；
//   - hold 模式（默认）：按住累积，松开时整段送主进程转写，出文字落定；
//   - click 持续模式：能量 VAD 切句（静音 ~600ms 断句，最长 12s 强制断），
//     每句排队转写，文字一句句追加；转写排队串行，不压爆 CPU。
//
// 全 WebAudio 录音，不依赖任何原生模块；回声消除 / 降噪 / 自动增益交给 Chromium。
// Chrome 自带的 SpeechRecognition 在 Electron 里没有识别服务（electron#46143），故走本地模型。

import { resample } from './voiceMedia.js'

const TARGET_RATE = 16000
/** 静音判定窗：连续这么久低于阈值就断句 */
const SILENCE_MS = 600
/** 单句最长（whisper 的舒适区，再长也强制切） */
const MAX_UTTERANCE_MS = 12000
/** 首句前的最长等待（等不到语音就报「没听到」） */
const MAX_LEAD_SILENCE_MS = 20000

export type VoicePhase = 'listening' | 'model-loading' | 'transcribing'

export interface SpeechInputOptions {
  /** 识别语言（菜单值：'auto' | 'zh-CN' | …；空 = 跟随系统，都交给主进程映射 whisper 语言） */
  lang?: string
  /** 指定麦克风（deviceId；空 = 系统默认） */
  deviceId?: string
  /** 状态变化（含模型下载进度 detail） */
  onPhase?: (phase: VoicePhase, detail?: string) => void
  /** 一段转写完成（已落定的文字，一段一段追加；hold 模式只有一段） */
  onText: (text: string) => void
  onError?: (code: string, message: string) => void
  /** 录音完全结束（转写队列排空、麦克风已关）；hold/click 停止后都会来 */
  onEnd?: () => void
}

/** 会话期共享的分句器（纯函数部分抽出便于测试） */
export class UtteranceSlicer {
  private buffer: Float32Array = new Float32Array(0)
  private speechStart = -1
  private silenceSamples = 0
  private totalSamples = 0
  inSpeech = false
  /** 静音阈值（RMS），可随噪声底估计动态调 */
  threshold: number
  constructor(
    private readonly sampleRate: number,
    threshold: number
  ) {
    this.threshold = threshold
  }

  /** 喂一帧；返回切出的话段（可能为空——还没断句） */
  push(frame: Float32Array): Float32Array[] {
    this.buffer = concat(this.buffer, frame)
    this.totalSamples += frame.length
    const rms = frameRms(frame)
    const out: Float32Array[] = []
    if (!this.inSpeech) {
      if (rms >= this.threshold) {
        this.inSpeech = true
        this.speechStart = Math.max(0, this.totalSamples - frame.length - keepPad(this.sampleRate))
        this.silenceSamples = 0
      } else if (this.totalSamples > (MAX_LEAD_SILENCE_MS / 1000) * this.sampleRate) {
        // 一直没人说话：把缓冲清了（避免无限占内存），继续等
        this.buffer = new Float32Array(0)
        this.totalSamples = 0
      }
    } else {
      this.silenceSamples = rms < this.threshold ? this.silenceSamples + frame.length : 0
      const speechLen = this.totalSamples - this.speechStart
      const speechMs = (speechLen / this.sampleRate) * 1000
      if (this.silenceSamples >= (SILENCE_MS / 1000) * this.sampleRate || speechMs >= MAX_UTTERANCE_MS) {
        const utterance = this.buffer.subarray(this.speechStart, this.totalSamples - this.silenceSamples + keepPad(this.sampleRate))
        if (utterance.length > (0.2 * this.sampleRate)) out.push(copy(utterance))
        this.buffer = new Float32Array(0)
        this.totalSamples = 0
        this.inSpeech = false
        this.speechStart = -1
        this.silenceSamples = 0
      }
    }
    return out
  }

  /** 收尾：把说了一半的话段吐出来 */
  flush(): Float32Array[] {
    if (!this.inSpeech) return []
    const end = this.totalSamples - this.silenceSamples
    const utterance = this.buffer.subarray(this.speechStart, end)
    return utterance.length > (0.2 * this.sampleRate) ? [copy(utterance)] : []
  }
}

/** 断句时前后各留这么点静音，给 whisper 一点上下文（首音别切太狠） */
function keepPad(rate: number): number {
  return Math.round(rate * 0.1)
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function copy(src: Float32Array): Float32Array {
  return new Float32Array(src)
}

export function frameRms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i]
  return Math.sqrt(sum / Math.max(1, frame.length))
}

export class SpeechInput {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private processor: ScriptProcessorNode | null = null
  private slicer: UtteranceSlicer | null = null
  /** hold 模式：整段累积 */
  private whole: Float32Array = new Float32Array(0)
  private options: SpeechInputOptions | null = null
  private stopping = false
  /** 串行转写队列 */
  private queue: Float32Array[] = []
  private draining = false
  private transcript = ''
  /** 还在录音（或队列没排空） */
  active = false

  /** 开麦录音。hold=true 整段一次转写；hold=false VAD 分句流式追加 */
  async start(options: SpeechInputOptions, hold: boolean): Promise<void> {
    if (this.active) return
    this.options = options
    this.stopping = false
    this.transcript = ''
    this.whole = new Float32Array(0)
    this.queue = []
    this.hold = hold
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      })
    } catch (error) {
      const name = (error as DOMException)?.name ?? ''
      const hint =
        name === 'NotFoundError' || name === 'OverconstrainedError'
          ? '没找到麦克风'
          : name === 'NotAllowedError'
            ? '麦克风权限被拒'
            : '麦克风打不开'
      options.onError?.('mic', hint)
      options.onEnd?.()
      return
    }
    this.active = true
    this.context = new AudioContext()
    const source = this.context.createMediaStreamSource(this.stream)
    // ScriptProcessor 已废弃但到处能用（voiceMedia 同款），块大小 2048
    this.processor = this.context.createScriptProcessor(2048, 1, 1)
    // 先用固定小阈值（安静环境够用）；未开口期间按实测噪声底自适应上调
    this.slicer = new UtteranceSlicer(TARGET_RATE, 0.006)
    let noiseFloor = 0
    let frames = 0
    this.processor.onaudioprocess = (event) => {
      if (!this.active) return
      const input = event.inputBuffer.getChannelData(0)
      const frame = resample(input, this.context!.sampleRate, TARGET_RATE)
      if (this.hold) {
        this.whole = concat(this.whole, frame)
        // hold 模式最多留 30s（whisper 的舒适区），更早的截掉
        if (this.whole.length > TARGET_RATE * 30) {
          this.whole = this.whole.subarray(this.whole.length - TARGET_RATE * 30)
        }
        return
      }
      if (!this.slicer!.inSpeech) {
        const rms = frameRms(frame)
        noiseFloor = noiseFloor === 0 ? rms : Math.min(noiseFloor, rms)
        frames += 1
        if (frames % 8 === 0) this.slicer!.threshold = Math.max(0.004, noiseFloor * 3)
      }
      for (const utterance of this.slicer!.push(frame)) this.enqueue(utterance)
    }
    source.connect(this.processor)
    // 不接 destination：ScriptProcessor 不连输出也会跑（Chrome 行为），只是别让声音外放
    this.processor.connect(this.context.destination)
    this.context.suspend?.()
    this.context.resume?.()
    options.onPhase?.('listening')
  }

  private hold = true

  private enqueue(utterance: Float32Array): void {
    this.queue.push(utterance)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const utterance = this.queue.shift()!
        this.options?.onPhase?.('transcribing')
        try {
          const out = await window.fridayBridge.transcribeVoice(utterance, this.options?.lang)
          const text = out.text
          if (text) {
            this.transcript += (this.transcript && !this.transcript.endsWith(' ') ? ' ' : '') + text
            this.options?.onText(this.transcript)
          }
        } catch (error) {
          this.options?.onError?.('transcribe', String((error as Error)?.message ?? error))
        }
      }
    } finally {
      this.draining = false
    }
    // 队列排空：还在录就回「在听」，已停就收尾
    if (this.active) this.options?.onPhase?.('listening')
    else this.finishIfIdle()
  }

  /** 停止录音；hold 模式把整段送转写，等队列排空后 onEnd */
  stop(): void {
    if (!this.active || this.stopping) return
    this.stopping = true
    this.active = false
    // 先把最后的半句吐进队列
    if (this.slicer) for (const utterance of this.slicer.flush()) this.enqueue(utterance)
    if (this.hold && this.whole.length > 0) {
      this.queue.push(this.whole)
      this.whole = new Float32Array(0)
      void this.drain()
    }
    this.closeMic()
    this.finishIfIdle()
  }

  private finishIfIdle(): void {
    if (this.stopping && !this.draining && this.queue.length === 0 && !this.active) {
      this.stopping = false
      this.options?.onEnd?.()
    }
  }

  private closeMic(): void {
    this.processor && (this.processor.onaudioprocess = null)
    this.processor?.disconnect()
    this.processor = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    void this.context?.close().catch(() => {})
    this.context = null
  }
}
