// 输入框语音听写 IPC（'voice:transcribe'）：按「识别模型 + 语言」路由到引擎——
//   - SenseVoice（sherpa-onnx）：zh/en/ja/ko（含「自动」跟随系统）→ 中文最快最准、
//     强噪/电话带宽下仍稳（见 SenseVoiceService.ts）
//   - Qwen3-ASR（sherpa-onnx）：「中英混合」与俄/法/德/西等 SenseVoice 不支持的
//     语言（2026-10 替换 whisper 槽位，本机同题实测质量更好，见
//     Qwen3AsrService.ts）；「识别模型」菜单也可显式锁定 0.6B / 1.7B
//   - whisper（transformers.js）：降为回退引擎——SenseVoice/Qwen3 下载或加载失败
//     时兜底（菜单里已移除，旧缓存的 whisper-* 选择也迁到 Qwen3-0.6B）
// 渲染进程送来 16 kHz 单声道采样：Float32Array 或 16 位小端 PCM ArrayBuffer。

import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { pcm16ToFloat32, transcribeWithWhisper, whisperLang } from './WhisperService.js'
import { transcribeWithSenseVoice } from './SenseVoiceService.js'
import { transcribeWithQwen3, type Qwen3Size } from './Qwen3AsrService.js'

/** 菜单语言值 → SenseVoice 语言码；认不出（mix/ru/fr/de/es…）= undefined */
const SENSEVOICE_LANGS: Record<string, string> = {
  'zh-CN': 'zh',
  'zh-TW': 'zh',
  'en-US': 'en',
  'en-GB': 'en',
  'ja-JP': 'ja',
  'ko-KR': 'ko'
}

/** navigator.language 可能是 zh、zh-Hans-CN 这类变体：先精确再按主标签回退 */
function senseVoiceLang(value: string): string | undefined {
  if (SENSEVOICE_LANGS[value]) return SENSEVOICE_LANGS[value]
  const prefix = value.split('-')[0]?.toLowerCase()
  const hit = Object.entries(SENSEVOICE_LANGS).find(([key]) => key.split('-')[0] === prefix)
  return hit?.[1]
}

type Engine =
  | { kind: 'sensevoice'; lang: string }
  | { kind: 'qwen3'; size: Qwen3Size }
  | { kind: 'whisper'; size: 'small' }

/** 「识别模型」菜单值 × 语言 → 用哪个引擎；模型留空/'auto' = 按语言自动选 */
function route(model: string | undefined, lang: string | undefined): Engine {
  // 渲染层「自动」档传 navigator.language；万一没传（旧渲染层缓存等），退系统 locale
  const resolved = lang || app.getLocale()
  const svLang = senseVoiceLang(resolved)
  // 显式锁定 Qwen3（含尺寸）；旧缓存里的 whisper-base/whisper-small 也迁到 Qwen3-0.6B
  if (model === 'qwen3-1.7b') return { kind: 'qwen3', size: '1.7b' }
  if (model === 'qwen3' || model === 'whisper-base' || model === 'whisper-small') {
    return { kind: 'qwen3', size: '0.6b' }
  }
  // 'sensevoice' 与 'auto'：SenseVoice 支持的语言走 SenseVoice，
  // 其余（mix/ru/fr/de/es/未知）走 Qwen3-0.6B（原 whisper 槽位）
  return svLang ? { kind: 'sensevoice', lang: svLang } : { kind: 'qwen3', size: '0.6b' }
}

export function registerDictationIpc(): void {
  ipcMain.handle(
    'voice:transcribe',
    async (
      event: IpcMainInvokeEvent,
      payload: { audio: Float32Array | ArrayBuffer; lang?: string; model?: string }
    ): Promise<{ text: string }> => {
      const raw = payload.audio
      const audio = raw instanceof Float32Array ? raw : pcm16ToFloat32(raw)
      if (audio.length < 1600) {
        // 不足 0.1 秒：当没说话
        return { text: '' }
      }
      const engine = route(payload.model, payload.lang)
      if (engine.kind === 'sensevoice') {
        try {
          return await transcribeWithSenseVoice(event.sender, audio, engine.lang)
        } catch (error) {
          // SenseVoice 起不来（原生模块/模型下载问题）时回 whisper，别让听写整个不可用
          console.warn('[voice] SenseVoice 转写失败，回退 whisper：', error)
          return await transcribeWithWhisper(event.sender, audio, whisperLang(payload.lang), 'small')
        }
      }
      if (engine.kind === 'qwen3') {
        try {
          return await transcribeWithQwen3(event.sender, audio, engine.size)
        } catch (error) {
          // Qwen3 起不来（模型下载失败/解压失败等）时同样回 whisper
          console.warn('[voice] Qwen3-ASR 转写失败，回退 whisper：', error)
          return await transcribeWithWhisper(event.sender, audio, whisperLang(payload.lang), 'small')
        }
      }
      return await transcribeWithWhisper(event.sender, audio, whisperLang(payload.lang), engine.size)
    }
  )
}
