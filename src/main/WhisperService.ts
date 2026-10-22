// 输入框语音听写的 whisper 引擎（transformers.js + onnxruntime-node，CPU 推理）：
//   - 负责「中英混合」（mix）与俄/法/德/西等 SenseVoice 不支持的语言；
//   - 「识别模型」菜单可选尺寸：base 约 80MB（小、快）/ small 约 240MB（准）。
//     注意 base 对中文麦克风音频近音错误率高（实测「今天星期几」在电话带宽+轻噪
//     下错成「今天星期天」这类同音替换，且常出繁体），中文主力是 SenseVoice
//     （见 SenseVoiceService.ts）；路由见 Dictation.ts。
//   - 模型首次使用时下载到用户数据目录（whisper-models/），之后完全离线；下载进度
//     经 'voice:model-progress' 事件推给渲染进程。模型加载和推理都在主进程。
//
// 为什么不用 Chrome 自带的 SpeechRecognition：Electron 的开源 Chromium 没有
// Chrome/Edge 正式构建内置的 Google 专有识别服务，官方确认不会支持
// （electron/electron#46143），实测 start() 即 not-allowed。

import { app, type WebContents } from 'electron'
import { join } from 'node:path'

/** 菜单里的语言值 → whisper 的语言全名。注意 transformers.js 不传 language
 *  不会自动检测，而是默认按英语转写（实测中文会被硬套成英文）；
 *  渲染层「自动」档已传 navigator.language（中文系统 = zh-CN）规避 */
const WHISPER_LANGS: Record<string, string> = {
  'zh-CN': 'chinese',
  'zh-TW': 'chinese',
  'en-US': 'english',
  'en-GB': 'english',
  'ja-JP': 'japanese',
  'ko-KR': 'korean',
  'ru-RU': 'russian',
  'fr-FR': 'french',
  'de-DE': 'german',
  'es-ES': 'spanish'
}

/** 「识别模型」菜单值 → 模型仓库（都走 q8 量化） */
const WHISPER_MODELS = {
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small'
} as const

export type WhisperSize = keyof typeof WHISPER_MODELS

type PipelineFactory = (
  task: 'automatic-speech-recognition',
  model: string,
  options: Record<string, unknown>
) => Promise<Transcriber>
type Transcriber = (
  audio: Float32Array,
  options: { language?: string; task?: 'transcribe' }
) => Promise<{ text: string }>

/** 每个尺寸一份懒加载 Promise（同一时刻同一尺寸只加载一份） */
const transcribers = new Map<WhisperSize, Promise<Transcriber>>()

function pushProgress(
  to: WebContents,
  phase: 'downloading' | 'loading' | 'ready',
  percent?: number,
  detail?: string,
  bytes?: { received: number; total: number }
): void {
  try {
    to.send('voice:model-progress', { phase, percent, detail, ...bytes })
  } catch {
    // 窗口已关：忽略
  }
}

function loadTranscriber(to: WebContents, size: WhisperSize): Promise<Transcriber> {
  const cached = transcribers.get(size)
  if (cached) return cached
  const loading = (async () => {
    const mod = (await import('@huggingface/transformers')) as {
      pipeline: PipelineFactory
      env: { cacheDir: string; remoteHost?: string; allowRemoteModels: boolean }
    }
    mod.env.cacheDir = join(app.getPath('userData'), 'whisper-models')
    const modelId = WHISPER_MODELS[size]
    const onProgress = (info: {
      status: string
      progress?: number
      loaded?: number
      total?: number
      file?: string
    }): void => {
      if (info.status === 'progress' && info.file) {
        // progress 按文件各算各的：只在下载大文件（模型本体）时报百分比
        if (
          (info.file.endsWith('.onnx') || info.file.endsWith('.onnx_data')) &&
          typeof info.progress === 'number'
        ) {
          const bytes =
            typeof info.loaded === 'number' && typeof info.total === 'number' && info.total > 0
              ? { received: info.loaded, total: info.total }
              : undefined
          pushProgress(to, 'downloading', Math.round(info.progress), undefined, bytes)
        }
      } else if (info.status === 'ready') {
        pushProgress(to, 'ready')
      }
    }
    const make = () =>
      mod.pipeline('automatic-speech-recognition', modelId, {
        dtype: 'q8',
        device: 'cpu',
        progress_callback: onProgress
      })
    try {
      pushProgress(to, 'loading', undefined, modelId)
      return await make()
    } catch (first) {
      // 官方源（huggingface.co）连不上很常见：换国内镜像 hf-mirror 再试一次
      mod.env.remoteHost = 'https://hf-mirror.com'
      try {
        return await make()
      } catch (second) {
        throw new Error(
          `语音模型加载失败：${String((second as Error)?.message ?? second)}（首次失败原因：${String(
            (first as Error)?.message ?? first
          )}）`
        )
      }
    }
  })().catch((error: unknown) => {
    // 失败了清掉缓存，让下次按键能重试
    transcribers.delete(size)
    throw error
  })
  transcribers.set(size, loading)
  return loading
}

/** 转写一段 16 kHz 单声道采样（语言不传时 transformers.js 会默认按英语，见上方注释） */
export async function transcribeWithWhisper(
  to: WebContents,
  audio: Float32Array,
  lang: string | undefined,
  size: WhisperSize
): Promise<{ text: string }> {
  const transcriber = await loadTranscriber(to, size)
  const out = await transcriber(audio, { language: lang, task: 'transcribe' })
  return { text: (out.text ?? '').trim() }
}

/** 菜单语言值 → whisper 语言名；不传（或认不出）= undefined。渲染层「自动」
 *  会传 navigator.language，所以正常到不了 undefined；万一到了（旧会话缓存等），
 *  宁可退回系统语言也不要让 transformers.js 默认按英语转写。
 *  系统语言可能是 zh、zh-Hans-CN 这类变体：先精确再按主标签回退 */
export function whisperLang(value?: string): string | undefined {
  if (value && WHISPER_LANGS[value]) return WHISPER_LANGS[value]
  if (value) {
    const prefix = value.split('-')[0]?.toLowerCase()
    for (const [key, name] of Object.entries(WHISPER_LANGS)) {
      if (key.split('-')[0] === prefix) return name
    }
  }
  const locale = (app.getLocale() || 'en').toLowerCase()
  for (const [key, name] of Object.entries(WHISPER_LANGS)) {
    if (key.split('-')[0] === locale.split('-')[0]) return name
  }
  return undefined
}

/** 16 位小端 PCM → Float32 [-1,1]（和渲染侧 voiceMedia 的约定一致） */
export function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer)
  const out = new Float32Array(buffer.byteLength / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 0x8000
  return out
}
