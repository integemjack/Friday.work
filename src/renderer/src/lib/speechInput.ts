// 语音听写（本地模型，主进程推理）：麦克风 → AudioContext → 重采样 16k → Float32；
//   - hold 模式（默认）：按住累积，松开时整段送主进程转写，出文字落定；
//   - click 持续模式：能量 VAD 切句（静音 ~600ms 断句，最长 12s 强制断），
//     每句排队转写，文字一句句追加；转写排队串行，不压爆 CPU。
//   - 实时引擎（model='friday-voice'，GPU）：不走上面的整段转写，音频帧直接流式喂给
//     friday-voice 引擎（边说边出 partial、每句 final 定稿）；断句/首词处理引擎内做，
//     渲染层只管喂帧和拼文字。引擎冷启动期间帧先攒着（最多 10s），连上后补发。
//
// 全 WebAudio 录音，不依赖任何原生模块；回声消除 / 降噪 / 自动增益交给 Chromium。
// Chrome 自带的 SpeechRecognition 在 Electron 里没有识别服务（electron#46143），故走本地模型。

import { resample } from './voiceMedia.js'

/** 「识别模型」菜单里实时引擎的值：选它走流式链路（rtBeginVoice/…），不调 transcribeVoice */
export const RT_VOICE_MODEL = 'friday-voice'

const TARGET_RATE = 16000
/** 静音判定窗：连续这么久低于阈值就断句 */
const SILENCE_MS = 600
/** 单句最长（whisper 的舒适区，再长也强制切） */
const MAX_UTTERANCE_MS = 12000
/** 开口前的预滚缓冲：未说话期间一直保留最近这么久的音频，
 *  一开口就把它们整段带上（首字的弱起音常低于阈值，不能从触发帧算起） */
export const PRE_ROLL_MS = 300
/** 送 whisper 的每段音频前面再垫这么久纯静音：whisper 对紧贴开头的音频
 *  会丢首词（实测中文句被吃掉「今天」），有前导静音才稳 */
const LEADING_PAD_MS = 150
/** 断句时句尾留这么点静音，给 whisper 一点上下文 */
const TAIL_PAD_MS = 100

export type VoicePhase = 'listening' | 'model-loading' | 'transcribing'

export interface SpeechInputOptions {
  /** 识别语言（菜单值：'auto' | 'zh-CN' | …；空 = 跟随系统，都交给主进程映射 whisper 语言） */
  lang?: string
  /** 识别模型（菜单值：'auto' | 'sensevoice' | 'qwen3' | 'qwen3-1.7b'；主进程路由） */
  model?: string
  /** 指定麦克风（deviceId；空 = 系统默认） */
  deviceId?: string
  /** 状态变化（含模型下载进度 detail） */
  onPhase?: (phase: VoicePhase, detail?: string) => void
  /** 一段转写完成（已落定的文字，一段一段追加；hold 模式只有一段） */
  onText: (text: string) => void
  /** 实时引擎：正在说的这句的临时文字（含之前已定稿的，会不断变化；final 后落定） */
  onPartial?: (preview: string) => void
  onError?: (code: string, message: string) => void
  /** 录音完全结束（转写队列排空、麦克风已关）；hold/click 停止后都会来 */
  onEnd?: () => void
}

/** 会话期共享的分句器（纯函数部分抽出便于测试） */
export class UtteranceSlicer {
  /** 开口后的句缓冲（开头已含 pre-roll） */
  private buffer: Float32Array = new Float32Array(0)
  /** 未开口期间的预滚缓冲（最近 PRE_ROLL_MS，环形丢弃） */
  private preroll: Float32Array = new Float32Array(0)
  private silenceSamples = 0
  /** 开口后累积的样本数（从触发帧起算，不含 pre-roll） */
  private speechSamples = 0
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
    const rms = frameRms(frame)
    const out: Float32Array[] = []
    if (!this.inSpeech) {
      // 预滚：一直保留最近 PRE_ROLL_MS 的音频（含低于阈值的弱起音和环境声）
      this.preroll = concat(this.preroll, frame)
      const max = Math.round((PRE_ROLL_MS / 1000) * this.sampleRate)
      if (this.preroll.length > max) this.preroll = this.preroll.subarray(this.preroll.length - max)
      if (rms >= this.threshold) {
        // 开口：从预滚的开头算起（首字的弱起音在里面），不是从触发帧
        this.inSpeech = true
        this.buffer = this.preroll
        this.preroll = new Float32Array(0)
        this.silenceSamples = 0
        this.speechSamples = frame.length
      }
    } else {
      this.buffer = concat(this.buffer, frame)
      this.speechSamples += frame.length
      this.silenceSamples = rms < this.threshold ? this.silenceSamples + frame.length : 0
      const speechMs = (this.speechSamples / this.sampleRate) * 1000
      if (this.silenceSamples >= (SILENCE_MS / 1000) * this.sampleRate || speechMs >= MAX_UTTERANCE_MS) {
        const tailPad = Math.round((TAIL_PAD_MS / 1000) * this.sampleRate)
        const end = Math.min(this.buffer.length, this.buffer.length - this.silenceSamples + tailPad)
        const utterance = this.buffer.subarray(0, end)
        if (utterance.length > 0.2 * this.sampleRate) out.push(copy(utterance))
        // 断句后的静音期间同样要预滚（用户可能马上接下一句）
        this.preroll = new Float32Array(0)
        this.buffer = new Float32Array(0)
        this.inSpeech = false
        this.silenceSamples = 0
        this.speechSamples = 0
      }
    }
    return out
  }

  /** 收尾：把说了一半的话段吐出来（含开头 pre-roll） */
  flush(): Float32Array[] {
    if (!this.inSpeech) return []
    const end = this.buffer.length - this.silenceSamples
    return end > 0.2 * this.sampleRate ? [copy(this.buffer.subarray(0, end))] : []
  }
}

/** 断句时句尾留静音的量已并入 TAIL_PAD_MS */
function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** 音频前面垫一段静音（whisper 需要前导静音，否则首词容易被吃掉） */
export function padSilence(audio: Float32Array, rate: number, ms: number): Float32Array {
  const pad = new Float32Array(Math.round((ms / 1000) * rate))
  const out = new Float32Array(pad.length + audio.length)
  out.set(pad, 0)
  out.set(audio, pad.length)
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
  /** 还没开起来就被要求停（短按/误触）：开起来后立即收尾 */
  private pendingStop = false
  /** 串行转写队列 */
  private queue: Float32Array[] = []
  private draining = false
  private transcript = ''
  /** 实时引擎状态 */
  private realtime = false
  private rtReady = false
  private rtUnsub: (() => void) | null = null
  private rtChunks: Int16Array[] = []
  private rtSampleCount = 0
  private rtPending = ''
  private rtFinalTimer: ReturnType<typeof setTimeout> | null = null
  private rtFinishing: (() => void) | null = null
  /** final 去重（同句重复定稿时只落一次字；一次性灌入大块音频时引擎可能同 segment 双发）。
   *  键含 segment：两句话内容一样（用户重复说）不算重复 */
  private rtLastFinalKey = ''
  private ended = false
  /** 还在录音（或队列没排空） */
  active = false

  /** 开麦录音。hold=true 整段一次转写；hold=false VAD 分句流式追加。
   *  「在听」状态（onPhase('listening')）等麦克风真正收到第一帧才发：
   *  红灯早亮会让人抢在麦克风启动前开口，正好漏首字（getUserMedia 起设备要几百毫秒） */
  async start(options: SpeechInputOptions, hold: boolean): Promise<void> {
    if (this.active) return
    this.options = options
    this.stopping = false
    this.pendingStop = false
    this.ended = false
    this.transcript = ''
    this.rtPending = ''
    this.rtLastFinalKey = ''
    this.whole = new Float32Array(0)
    this.queue = []
    this.hold = hold
    this.realtime = options.model === RT_VOICE_MODEL
    // AudioContext 不依赖设备，先建；和 getUserMedia 并行省点启动时间
    const context = new AudioContext()
    this.context = context
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      })
      this.stream = stream
    } catch (error) {
      const name = (error as DOMException)?.name ?? ''
      const hint =
        name === 'NotFoundError' || name === 'OverconstrainedError'
          ? '没找到麦克风'
          : name === 'NotAllowedError'
            ? '麦克风权限被拒'
            : '麦克风打不开'
      void context.close().catch(() => {})
      this.context = null
      options.onError?.('mic', hint)
      options.onEnd?.()
      return
    }
    this.active = true
    const source = context.createMediaStreamSource(this.stream)
    // ScriptProcessor 已废弃但到处能用（voiceMedia 同款），块大小 2048
    this.processor = context.createScriptProcessor(2048, 1, 1)
    // 先用固定小阈值（安静环境够用）；未开口期间按实测噪声底自适应上调
    this.slicer = new UtteranceSlicer(TARGET_RATE, 0.006)
    let noiseFloor = 0
    let frames = 0
    let announced = false
    // 实时引擎：先订事件再 begin（冷启动期间帧先攒着，连上后补发）
    if (this.realtime) {
      this.rtUnsub = window.fridayBridge.onRtVoiceEvent((event) => this.onRtEvent(event))
      window.fridayBridge
        .rtBeginVoice(options.lang)
        .then(() => {
          this.rtReady = true
          this.sendRealtime() // 引擎冷启动期间攒的帧现在补发
        })
        .catch((error: unknown) => {
          this.onErrorRealtime(String((error as Error)?.message ?? error))
        })
    }
    this.processor.onaudioprocess = (event) => {
      if (!this.active) return
      if (!announced) {
        announced = true
        options.onPhase?.('listening') // 第一帧到了才是真的在收音
      }
      const input = event.inputBuffer.getChannelData(0)
      const frame = resample(input, context.sampleRate, TARGET_RATE)
      if (this.realtime) {
        this.pushRealtime(frame)
        return
      }
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
    this.processor.connect(context.destination)
    context.suspend?.()
    context.resume?.()
    // 麦没起来就被要求停了（短按）：现在起来了，立即收尾
    if (this.pendingStop) this.stop()
  }

  private hold = true

  // MARK: 实时引擎（friday-voice）：攒帧补发 + 事件拼字 + flush 收尾

  private static toPcm16(frame: Float32Array): Int16Array {
    const out = new Int16Array(frame.length)
    for (let i = 0; i < frame.length; i++) {
      const s = Math.max(-1, Math.min(1, frame[i]))
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return out
  }

  private pushRealtime(frame: Float32Array): void {
    const pcm = SpeechInput.toPcm16(frame)
    this.rtChunks.push(pcm)
    this.rtSampleCount += pcm.length
    // 引擎还没连上（冷启动/首次下载）：最多攒 10 秒（同服务端 RealtimeConnection 的限额）
    while (this.rtSampleCount > TARGET_RATE * 10 && this.rtChunks.length > 1) {
      this.rtSampleCount -= this.rtChunks[0]!.length
      this.rtChunks.shift()
    }
    if (this.rtReady && this.rtSampleCount >= 1024) this.sendRealtime() // ~64ms 一发
  }

  private sendRealtime(): void {
    if (this.rtChunks.length === 0) return
    const total = new Int16Array(this.rtSampleCount)
    let at = 0
    for (const chunk of this.rtChunks) {
      total.set(chunk, at)
      at += chunk.length
    }
    this.rtChunks = []
    this.rtSampleCount = 0
    window.fridayBridge.rtFeedVoice(total.buffer as ArrayBuffer)
  }

  private appendTranscript(text: string): void {
    this.transcript += (this.transcript && !this.transcript.endsWith(' ') ? ' ' : '') + text
  }

  private onRtEvent(event: {
    type: 'speech_start' | 'partial' | 'final' | 'speech_end' | 'error'
    segment?: number
    text?: string
    message?: string
  }): void {
    if (this.ended) return
    if (event.type === 'partial') {
      this.rtPending = event.text ?? ''
      this.options?.onPartial?.(this.joinPreview())
    } else if (event.type === 'final') {
      this.rtPending = ''
      const key = `${event.segment ?? ''}:${event.text ?? ''}`
      if (event.text && key !== this.rtLastFinalKey) {
        this.rtLastFinalKey = key
        this.appendTranscript(event.text)
        this.options?.onText(this.transcript)
      } else if (event.text) {
        this.rtLastFinalKey = key
      }
      // 结束中：这句定稿到了，可以收尾（等一小会儿防同句后续事件）
      if (this.rtFinishing) {
        const finish = this.rtFinishing
        this.rtFinishing = null
        setTimeout(finish, 250)
      }
    } else if (event.type === 'speech_end') {
      // 这句没听出字（噪音/咳嗽）：清掉残影
      this.rtPending = ''
      this.options?.onPartial?.(this.joinPreview())
      if (this.rtFinishing) {
        const finish = this.rtFinishing
        this.rtFinishing = null
        setTimeout(finish, 250)
      }
    } else if (event.type === 'error') {
      this.onErrorRealtime(event.message ?? '语音引擎听写出错')
    }
  }

  private joinPreview(): string {
    return this.rtPending ? this.transcript + (this.transcript && !this.transcript.endsWith(' ') ? ' ' : '') + this.rtPending : this.transcript
  }

  private onErrorRealtime(message: string): void {
    if (this.ended) return
    this.options?.onError?.('transcribe', message)
    this.finishRealtime()
  }

  private finishRealtime(): void {
    if (this.ended) return
    this.ended = true
    if (this.rtFinalTimer) {
      clearTimeout(this.rtFinalTimer)
      this.rtFinalTimer = null
    }
    window.fridayBridge.rtStopVoice()
    this.rtUnsub?.()
    this.rtUnsub = null
    this.closeMic()
    this.options?.onEnd?.()
  }

  /** 结束实时听写：尾巴帧发出去 → flush 定稿当前半句 → 等 final（起 1.5s 超时）→ 收尾 */
  private stopRealtime(): void {
    this.sendRealtime()
    window.fridayBridge.rtFlushVoice()
    this.rtFinishing = () => this.finishRealtime()
    this.rtFinalTimer = setTimeout(() => {
      this.rtFinishing = null
      this.finishRealtime()
    }, 1500)
  }

  private enqueue(utterance: Float32Array): void {
    // 前垫静音：whisper 对紧贴开头的音频丢首词（见 LEADING_PAD_MS 注释）
    this.queue.push(padSilence(utterance, TARGET_RATE, LEADING_PAD_MS))
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
          const out = await window.fridayBridge.transcribeVoice(utterance, this.options?.lang, this.options?.model)
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

  /** 停止录音；hold 模式把整段送转写，等队列排空后 onEnd；实时引擎走 flush 收尾 */
  stop(): void {
    if (!this.active) {
      // 还在开麦中就被要求停（短按/误触）：记下，开起来立即收尾
      if (this.context !== null || this.queue.length > 0) this.pendingStop = true
      return
    }
    if (this.stopping) return
    this.stopping = true
    this.active = false
    if (this.realtime) {
      this.stopRealtime()
      return
    }
    // 先把最后的半句吐进队列
    if (this.slicer) for (const utterance of this.slicer.flush()) this.enqueue(utterance)
    if (this.hold && this.whole.length > 0) {
      // hold 整段同样前垫静音（用户一按住就说话时，麦刚起的第一帧就贴着开头）
      this.queue.push(padSilence(this.whole, TARGET_RATE, LEADING_PAD_MS))
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
