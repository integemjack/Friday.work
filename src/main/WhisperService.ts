// 输入框语音听写的本地转写引擎（whisper，onnxruntime-node，CPU 推理）：
//   渲染进程送来 16 kHz 的音频采样（Float32），这里转成文字送回。
//   模型用 onnx-community/whisper-base 的 q8 量化（约 80MB），首次使用时
//   下载到用户数据目录（whisper-models/），之后完全离线；下载进度经
//   'voice:model-progress' 事件推给渲染进程显示。模型加载和推理都在主进程，
//   渲染进程照旧接触不到模型与凭据。
//
// 为什么不用 Chrome 自带的 SpeechRecognition：Electron 的开源 Chromium 没有
// Chrome/Edge 正式构建内置的 Google 专有识别服务，官方确认不会支持
// （electron/electron#46143），实测 start() 即 not-allowed。

import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'

/** 菜单里的语言值 → whisper 的语言全名（不传 = 让 whisper 自己检测） */
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

const MODEL_ID = 'onnx-community/whisper-base'

type PipelineFactory = (
  task: 'automatic-speech-recognition',
  model: string,
  options: Record<string, unknown>
) => Promise<Transcriber>
type Transcriber = (
  audio: Float32Array,
  options: { language?: string; task?: 'transcribe' }
) => Promise<{ text: string }>

let loading: Promise<Transcriber> | null = null

function pushProgress(to: WebContents, phase: 'downloading' | 'loading' | 'ready', percent?: number, detail?: string): void {
  try {
    to.send('voice:model-progress', { phase, percent, detail })
  } catch {
    // 窗口已关：忽略
  }
}

/** 懒加载模型（含首次下载）；同一时刻只加载一份，重复调用共用同一个 Promise */
function loadTranscriber(to: WebContents): Promise<Transcriber> {
  if (loading) return loading
  loading = (async () => {
    const mod = (await import('@huggingface/transformers')) as {
      pipeline: PipelineFactory
      env: { cacheDir: string; remoteHost?: string; allowRemoteModels: boolean }
    }
    mod.env.cacheDir = join(app.getPath('userData'), 'whisper-models')
    const onProgress = (info: { status: string; progress?: number; file?: string }): void => {
      if (info.status === 'progress' && info.file) {
        // progress 按文件各算各的：只在下载大文件（模型本体）时报百分比
        if ((info.file.endsWith('.onnx') || info.file.endsWith('.onnx_data')) && typeof info.progress === 'number') {
          pushProgress(to, 'downloading', Math.round(info.progress))
        }
      } else if (info.status === 'ready') {
        pushProgress(to, 'ready')
      }
    }
    try {
      pushProgress(to, 'loading', undefined, MODEL_ID)
      return await mod.pipeline('automatic-speech-recognition', MODEL_ID, {
        dtype: 'q8',
        device: 'cpu',
        progress_callback: onProgress
      })
    } catch (first) {
      // 官方源（huggingface.co）连不上很常见：换国内镜像 hf-mirror 再试一次
      mod.env.remoteHost = 'https://hf-mirror.com'
      try {
        return await mod.pipeline('automatic-speech-recognition', MODEL_ID, {
          dtype: 'q8',
          device: 'cpu',
          progress_callback: onProgress
        })
      } catch (second) {
        loading = null // 让下次按键能重试
        throw new Error(`语音模型加载失败：${String((second as Error)?.message ?? second)}（首次失败原因：${String((first as Error)?.message ?? first)}）`)
      }
    }
  })()
  return loading
}

/**
 * 注册听写 IPC。audio 为 16 kHz 单声道采样：
 *   - Float32Array（[-1,1]，ipc 结构化克隆直接传）
 *   - 或 ArrayBuffer（16 位小端 PCM，渲染侧 voiceMedia.toPcm16 的产物）
 */
export function registerWhisperIpc(): void {
  ipcMain.handle(
    'voice:transcribe',
    async (
      event: IpcMainInvokeEvent,
      payload: { audio: Float32Array | ArrayBuffer; lang?: string }
    ): Promise<{ text: string }> => {
      const raw = payload.audio
      const audio =
        raw instanceof Float32Array ? raw : pcm16ToFloat32(raw)
      if (audio.length < 1600) {
        // 不足 0.1 秒：当没说话
        return { text: '' }
      }
      const transcriber = await loadTranscriber(event.sender)
      const out = await transcriber(audio, {
        language: whisperLang(payload.lang),
        task: 'transcribe'
      })
      return { text: (out.text ?? '').trim() }
    }
  )
}

/** 菜单语言值 → whisper 语言名；不传（或认不出）= 让 whisper 自己检测。
 *  系统语言可能是 zh、zh-Hans-CN 这类变体：先精确再按主标签回退 */
function whisperLang(value?: string): string | undefined {
  if (!value) return undefined
  if (WHISPER_LANGS[value]) return WHISPER_LANGS[value]
  const prefix = value.split('-')[0]?.toLowerCase()
  for (const [key, name] of Object.entries(WHISPER_LANGS)) {
    if (key.split('-')[0] === prefix) return name
  }
  return undefined
}

/** 16 位小端 PCM → Float32 [-1,1]（和渲染侧 voiceMedia 的约定一致） */
function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer)
  const out = new Float32Array(buffer.byteLength / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 0x8000
  return out
}
