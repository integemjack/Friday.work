// sherpa-onnx-node 未随包发布类型声明；这里只声明听写/合成用到的最小面。
// 真实结构见 node_modules/sherpa-onnx-node/types.js（JSDoc typedef）。
declare module 'sherpa-onnx-node' {
  export interface OfflineStream {
    acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void
  }
  export interface OfflineRecognizerResult {
    text: string
    [key: string]: unknown
  }
  export class OfflineRecognizer {
    constructor(config: unknown)
    createStream(): OfflineStream
    decode(stream: OfflineStream): void
    getResult(stream: OfflineStream): OfflineRecognizerResult
  }
  /** TTS 合成结果（non-streaming-tts.js GeneratedAudio） */
  export interface GeneratedAudio {
    samples: Float32Array
    sampleRate: number
  }
  /** 离线 TTS（kokoro / vits / matcha 都走这个类；config 形状随模型架构不同） */
  export class OfflineTts {
    constructor(config: unknown)
    numSpeakers: number
    sampleRate: number
    generate(req: { text: string; sid?: number; speed?: number }): GeneratedAudio
    generateAsync(req: { text: string; sid?: number; speed?: number }): Promise<GeneratedAudio>
  }
}
