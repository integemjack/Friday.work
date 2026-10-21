// sherpa-onnx-node 未随包发布类型声明；这里只声明听写用到的最小面。
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
}
