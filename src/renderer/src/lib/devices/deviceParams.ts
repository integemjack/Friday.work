// 客户端设备：device.* 请求的参数校验与默认值（方案-客户端设备 §5）。纯函数，单测直接调。

import { RpcErrors } from '../../../../protocol/rpc/protocol.js'
import { base64ToBytes } from './base64.js'
import type { SerialConfig, SerialMode } from './serialSession.js'
import type { EspFlashOptions } from './espFlash.js'
import type { SnapshotOptions } from './camera.js'
import type { After, Before, FlashFreqValues, FlashModeValues, FlashSizeValues } from 'esptool-js'

const FLASH_MODES: readonly FlashModeValues[] = ['keep', 'dio', 'qio', 'dout', 'qout']
const FLASH_FREQS: readonly FlashFreqValues[] = ['keep', '80m', '60m', '48m', '40m', '30m', '26m', '24m', '20m', '16m', '15m', '12m']
const FLASH_SIZES: readonly FlashSizeValues[] = ['detect', 'keep', '256KB', '512KB', '1MB', '2MB', '2MB-c1', '4MB', '4MB-c1', '8MB', '16MB', '32MB', '64MB', '128MB']
const BEFORE_MODES: readonly Before[] = ['default_reset', 'usb_reset', 'no_reset', 'no_reset_no_sync']
const AFTER_MODES: readonly After[] = ['hard_reset', 'soft_reset', 'no_reset', 'no_reset_stub']

/** 带 JSON-RPC 错误码的错误（回给服务端） */
export class DeviceError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

function invalid(message: string): DeviceError {
  return new DeviceError(RpcErrors.InvalidParams, message)
}

function record(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw invalid(`${name} 只能是 ${allowed.join(' / ')}`)
}

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${name} 要是 ${min}..${max} 的整数`)
  }
  return value
}

export function requireDeviceId(params: unknown, prefix: string): string {
  const deviceId = record(params).deviceId
  if (typeof deviceId !== 'string' || !deviceId.startsWith(prefix)) throw invalid(`deviceId 要是 device.list 给的 ${prefix}… 标识`)
  return deviceId
}

/** 烧录地址：数字或 "0x…" / 十进制字符串 */
export function parseAddress(value: unknown): number {
  let address = Number.NaN
  if (typeof value === 'number') address = value
  else if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    address = text.startsWith('0x') ? Number.parseInt(text.slice(2), 16) : /^\d+$/.test(text) ? Number(text) : Number.NaN
  }
  if (!Number.isInteger(address) || address < 0 || address > 0x7fffffff) throw invalid(`烧录地址不对：${String(value)}`)
  return address
}

export interface SerialOpenParams {
  deviceId: string
  mode: SerialMode
  config: SerialConfig
}

export function parseSerialOpen(params: unknown): SerialOpenParams {
  const p = record(params)
  const dataBits = integer(p.dataBits, 8, 7, 8, 'dataBits') as 7 | 8
  const stopBits = integer(p.stopBits, 1, 1, 2, 'stopBits') as 1 | 2
  return {
    deviceId: requireDeviceId(params, 'serial:'),
    mode: pick(p.mode, ['rfc2217', 'raw'] as const, 'rfc2217', 'mode'),
    config: {
      baudRate: integer(p.baudRate, 115200, 50, 16_000_000, 'baudRate'),
      dataBits,
      parity: pick(p.parity, ['none', 'odd', 'even'] as const, 'none', 'parity'),
      stopBits,
      flowControl: pick(p.flowControl, ['none', 'hardware'] as const, 'none', 'flowControl')
    }
  }
}

export function parseFlash(params: unknown): { deviceId: string; options: EspFlashOptions } {
  const p = record(params)
  if (!Array.isArray(p.files) || p.files.length === 0) throw invalid('files 至少要有一个 { address, data }')
  const files = p.files.map((entry, index) => {
    const file = record(entry)
    if (typeof file.data !== 'string' || file.data.length === 0) throw invalid(`files[${index}].data 要是 base64`)
    let data: Uint8Array
    try {
      data = base64ToBytes(file.data)
    } catch {
      throw invalid(`files[${index}].data 不是合法的 base64`)
    }
    return { address: parseAddress(file.address), data }
  })
  return {
    deviceId: requireDeviceId(params, 'serial:'),
    options: {
      files,
      baudRate: integer(p.baudRate, 460800, 9600, 3_000_000, 'baudRate'),
      flashMode: pick(p.flashMode, FLASH_MODES, 'keep', 'flashMode'),
      flashFreq: pick(p.flashFreq, FLASH_FREQS, 'keep', 'flashFreq'),
      flashSize: pick(p.flashSize, FLASH_SIZES, 'keep', 'flashSize'),
      eraseAll: p.eraseAll === true,
      compress: p.compress !== false,
      before: pick(p.before, BEFORE_MODES, 'default_reset', 'before'),
      after: pick(p.after, AFTER_MODES, 'hard_reset', 'after')
    }
  }
}

export function parseEspInfo(params: unknown): { deviceId: string; before: Before } {
  return {
    deviceId: requireDeviceId(params, 'serial:'),
    before: pick(record(params).before, BEFORE_MODES, 'default_reset', 'before')
  }
}

export function parseSnapshot(params: unknown): { deviceId?: string; options: SnapshotOptions } {
  const p = record(params)
  let deviceId: string | undefined
  if (p.deviceId !== undefined && p.deviceId !== null) deviceId = requireDeviceId(params, 'camera:')
  const quality = p.quality === undefined ? 0.85 : Number(p.quality)
  if (!Number.isFinite(quality) || quality <= 0 || quality > 1) throw invalid('quality 要在 (0, 1] 之间')
  return {
    deviceId,
    options: {
      width: p.width === undefined ? undefined : integer(p.width, 0, 16, 7680, 'width'),
      height: p.height === undefined ? undefined : integer(p.height, 0, 16, 4320, 'height'),
      format: pick(p.format, ['jpeg', 'png'] as const, 'jpeg', 'format'),
      quality,
      warmupMs: integer(p.warmupMs, 600, 0, 5000, 'warmupMs')
    }
  }
}
