// 客户端设备：摄像头快照（方案-客户端设备 §5.5）。开摄像头 → 等自动曝光稳一稳 → 画到 canvas → JPEG/PNG。
// 拍完立刻关掉轨道（摄像头指示灯只亮这一下）。

import { bytesToBase64 } from './base64.js'

export interface CameraDeviceInfo {
  id: string
  kind: 'camera'
  label: string
}

export interface SnapshotOptions {
  /** 浏览器的 deviceId（不带 camera: 前缀）；空 = 默认摄像头 */
  deviceId?: string
  width?: number
  height?: number
  format: 'jpeg' | 'png'
  quality: number
  warmupMs: number
}

export interface SnapshotResult {
  mime: string
  data: string
  width: number
  height: number
  deviceId: string
  label: string
  takenAt: string
}

export const CAMERA_PREFIX = 'camera:'

export async function listCameras(): Promise<CameraDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  let unnamed = 0
  return devices
    .filter((device) => device.kind === 'videoinput' && device.deviceId)
    .map((device) => ({
      id: CAMERA_PREFIX + device.deviceId,
      kind: 'camera' as const,
      label: device.label || `摄像头 ${++unnamed}`
    }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function takeSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      ...(options.width ? { width: { ideal: options.width } } : {}),
      ...(options.height ? { height: { ideal: options.height } } : {})
    }
  })
  const video = document.createElement('video')
  try {
    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('摄像头没有画面')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play()
    // 第一帧出来之前 videoWidth 是 0
    const deadline = Date.now() + 5_000
    while (video.videoWidth === 0 && Date.now() < deadline) await sleep(30)
    if (video.videoWidth === 0) throw new Error('摄像头 5 秒内没出画面')
    await sleep(options.warmupMs)

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('画布不可用')
    context.drawImage(video, 0, 0)
    const mime = options.format === 'png' ? 'image/png' : 'image/jpeg'
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, options.quality))
    if (!blob) throw new Error('编码图片失败')
    const settings = track.getSettings()
    return {
      mime,
      data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
      width: canvas.width,
      height: canvas.height,
      deviceId: CAMERA_PREFIX + (settings.deviceId ?? options.deviceId ?? ''),
      label: track.label,
      takenAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    }
  } finally {
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
  }
}
