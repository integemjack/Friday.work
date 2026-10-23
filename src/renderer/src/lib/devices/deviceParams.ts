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

/** 服务端给的进度令牌（devices 能力的 job id）：进度通知里带回去 */
export function progressToken(params: unknown): string | undefined {
  const token = record(params).progressToken
  return typeof token === 'string' && token.length <= 64 ? token : undefined
}

export type TcpOpenParams =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'adb'; deviceId: string }
  | { kind: 'usbmux' }

/** device.tcp.open：{host, port} | {service: 'adb', deviceId: 'android:…'} | {service: 'usbmux'} */
export function parseTcpOpen(params: unknown): TcpOpenParams {
  const p = record(params)
  if (p.service === 'adb') return { kind: 'adb', deviceId: requireDeviceId(params, 'android:') }
  if (p.service === 'usbmux') return { kind: 'usbmux' }
  if (p.service !== undefined) throw invalid('service 只能是 adb / usbmux')
  const host = p.host
  if (typeof host !== 'string' || host.length === 0 || host.length > 253 || /[\s/]/.test(host)) throw invalid('host 要是地址或主机名')
  return { kind: 'tcp', host, port: integer(p.port, 0, 1, 65535, 'port') }
}

export interface OtherFlashParams {
  deviceId: string
  method: 'uf2' | 'stk500' | 'stm32'
  /** 要烧的字节（hex 已经展开） */
  data: Uint8Array
  address: number
  baudRate: number
  pageSize: number
  reset: 'none' | 'dtr-rts'
}

/** device.flash：UF2 拷盘 / Arduino STK500 / STM32 串口引导（ESP 走 device.esp.flash） */
export function parseOtherFlash(params: unknown, parseHex: (text: string) => { base: number; data: Uint8Array }): OtherFlashParams {
  const p = record(params)
  const method = pick(p.method, ['uf2', 'stk500', 'stm32'] as const, 'uf2', 'method')
  const deviceId = requireDeviceId(params, method === 'uf2' ? 'uf2:' : 'serial:')
  if (typeof p.data !== 'string' || p.data.length === 0) throw invalid('data 要是 base64')
  let data: Uint8Array
  try {
    data = base64ToBytes(p.data)
  } catch {
    throw invalid('data 不是合法的 base64')
  }
  const format = pick(p.format, ['bin', 'hex'] as const, 'bin', 'format')
  let address = method === 'stm32' ? 0x08000000 : 0
  if (format === 'hex') {
    if (method === 'uf2') throw invalid('uf2 要 .uf2 文件，不是 hex')
    const image = parseHex(new TextDecoder().decode(data))
    data = image.data
    address = image.base
  }
  if (p.address !== undefined && p.address !== null) address = parseAddress(p.address)
  return {
    deviceId,
    method,
    data,
    address,
    baudRate: integer(p.baudRate, method === 'stm32' ? 57600 : 115200, 1200, 1_000_000, 'baudRate'),
    pageSize: integer(p.pageSize, 128, 16, 1024, 'pageSize'),
    reset: pick(p.reset, ['none', 'dtr-rts'] as const, 'none', 'reset')
  }
}

export interface ToolRunParams {
  tool: string
  args: string[]
  files: Array<{ name: string; data: ArrayBuffer }>
  background: boolean
  timeoutMs: number
}

/** device.tool.run：白名单在主进程里核，这里只管形状 */
export function parseToolRun(params: unknown): ToolRunParams {
  const p = record(params)
  if (typeof p.tool !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(p.tool)) throw invalid('tool 要是程序名（如 avrdude、openocd）')
  const args = p.args === undefined ? [] : p.args
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string') || args.length > 200) throw invalid('args 要是字符串数组')
  const files = (p.files === undefined ? [] : p.files) as unknown
  if (!Array.isArray(files) || files.length > 32) throw invalid('files 要是 [{name, data}]')
  return {
    tool: p.tool,
    args: args as string[],
    files: files.map((entry, index) => {
      const file = record(entry)
      if (typeof file.name !== 'string' || file.name.length === 0) throw invalid(`files[${index}].name 不对`)
      if (typeof file.data !== 'string') throw invalid(`files[${index}].data 要是 base64`)
      const bytes = base64ToBytes(file.data)
      return { name: file.name, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }
    }),
    background: p.background === true,
    timeoutMs: integer(p.timeoutMs, 300_000, 1000, 3_600_000, 'timeoutMs')
  }
}
