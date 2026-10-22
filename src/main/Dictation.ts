// 输入框语音听写 IPC（'voice:transcribe'）：全部走 friday-voice 引擎
// （serve 的 /v1/audio/transcriptions：SenseVoice 出字 + Whisper 定稿、语言引擎内自动）。
// 2026-10 收敛：本地 sherpa-onnx 的 SenseVoice/Qwen3-ASR 和 transformers.js 的 whisper
// 都删了——同一套模型在引擎里（GPU、Vulkan）跑得更快，维护一条链路就够。
// 渲染进程送来 16 kHz 单声道采样：Float32Array 或 16 位小端 PCM ArrayBuffer。

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { transcribeViaServe } from './CosyVoiceService.js'

function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const bytes = new Uint8Array(buffer)
  const out = new Float32Array(bytes.length >> 1)
  for (let i = 0; i < out.length; i++) {
    const value = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8)
    out[i] = (value & 0x8000 ? value - 0x10000 : value) / 32768
  }
  return out
}

/** navigator.language（zh-CN 等）→ 引擎认的语言码（zh/en/ja/ko/yue…） */
function engineLang(value: string | undefined): string | undefined {
  if (!value) return undefined
  const prefix = value.split('-')[0]?.toLowerCase()
  if (prefix === 'zh') return 'zh'
  return prefix
}

export function registerDictationIpc(): void {
  ipcMain.handle(
    'voice:transcribe',
    async (
      event: IpcMainInvokeEvent,
      payload: { audio: Float32Array | ArrayBuffer; lang?: string }
    ): Promise<{ text: string }> => {
      const raw = payload.audio
      const audio = raw instanceof Float32Array ? raw : pcm16ToFloat32(raw)
      if (audio.length < 1600) {
        // 不足 0.1 秒：当没说话
        return { text: '' }
      }
      return { text: await transcribeViaServe(event.sender, audio, engineLang(payload.lang)) }
    }
  )
}
