// 输入框语音听写 IPC（'voice:transcribe'）：按「识别模型 + 语言」路由到引擎——
//   - SenseVoice（sherpa-onnx）：zh/en/ja/ko（含「自动」跟随系统）→ 中文最快最准、
//     强噪/电话带宽下仍稳（见 SenseVoiceService.ts）
//   - whisper（transformers.js）：「中英混合」（mix）与俄/法/德/西等 SenseVoice
//     不支持的语言；「识别模型」菜单也可显式选 base/small 尺寸
// 渲染进程送来 16 kHz 单声道采样：Float32Array 或 16 位小端 PCM ArrayBuffer。

import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { pcm16ToFloat32, transcribeWithWhisper, whisperLang, type WhisperSize } from './WhisperService.js'
import { transcribeWithSenseVoice } from './SenseVoiceService.js'

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

type Engine = { kind: 'sensevoice'; lang: string } | { kind: 'whisper'; size: WhisperSize }

/** 「识别模型」菜单值 × 语言 → 用哪个引擎；模型留空/'auto' = 按语言自动选 */
function route(model: string | undefined, lang: string | undefined): Engine {
  // 渲染层「自动」档传 navigator.language；万一没传（旧渲染层缓存等），退系统 locale
  const resolved = lang || app.getLocale()
  const svLang = senseVoiceLang(resolved)
  if (model === 'whisper-base') return { kind: 'whisper', size: 'base' }
  if (model === 'whisper-small') return { kind: 'whisper', size: 'small' }
  if (model === 'sensevoice') {
    // 显式选了 SenseVoice 但当前语言它不支持（mix/ru/fr/de/es…）：回 whisper-small
    return svLang ? { kind: 'sensevoice', lang: svLang } : { kind: 'whisper', size: 'small' }
  }
  // 自动：SenseVoice 支持的语言走 SenseVoice，其余（mix/ru/fr/de/es/未知）走 whisper-small
  return svLang ? { kind: 'sensevoice', lang: svLang } : { kind: 'whisper', size: 'small' }
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
      return await transcribeWithWhisper(event.sender, audio, whisperLang(payload.lang), engine.size)
    }
  )
}
