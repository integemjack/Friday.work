// 客户端设备：本机烧录 ESP（方案-客户端设备 §5.3/§5.4）。
// 用 Espressif 官方的 esptool-js（网页烧录器同款，底层就是 WebSerial），在客户端直接对串口烧，
// 速度和插在本机上一样，不用隔着网络一块一块地来回。每个文件烧完比对 flash MD5。

import { ESPLoader, Transport, type After, type Before, type FlashFreqValues, type FlashModeValues, type FlashSizeValues } from 'esptool-js'
import { md5Hex } from './md5.js'

export interface EspFlashFile {
  address: number
  data: Uint8Array
}

export interface EspFlashOptions {
  files: EspFlashFile[]
  baudRate: number
  flashMode: FlashModeValues
  flashFreq: FlashFreqValues
  flashSize: FlashSizeValues
  eraseAll: boolean
  compress: boolean
  before: Before
  after: After
}

export interface EspFlashResult {
  chip: string
  files: Array<{ address: number; size: number; md5: string }>
  elapsedMs: number
  log: string
}

export interface EspInfo {
  chip: string
  features: string
  mac: string
  flashSize: string
}

const LOG_LIMIT = 8 * 1024

/** esptool-js 的输出：只留最后 8 KB（回给服务端看） */
class LogTail {
  private text = ''
  readonly terminal = {
    clean: (): void => {},
    writeLine: (data: string): void => this.add(`${data}\n`),
    write: (data: string): void => this.add(data)
  }

  private add(data: string): void {
    this.text += data
    if (this.text.length > LOG_LIMIT * 2) this.text = this.text.slice(-LOG_LIMIT)
  }

  get value(): string {
    return this.text.length > LOG_LIMIT ? this.text.slice(-LOG_LIMIT) : this.text
  }
}

/** Espressif 原生 USB（USB-JTAG-Serial / USB-OTG）：复位要走它那套 */
function usingUsbOtg(port: SerialPort): boolean {
  return port.getInfo().usbVendorId === 0x303a
}

async function withLoader<T>(
  port: SerialPort,
  baudRate: number,
  before: Before,
  run: (loader: ESPLoader, chip: string, log: LogTail) => Promise<T>
): Promise<T> {
  const log = new LogTail()
  const transport = new Transport(port, false)
  const loader = new ESPLoader({ transport, baudrate: baudRate, terminal: log.terminal, debugLogging: false })
  try {
    const chip = await loader.main(before)
    try {
      return await run(loader, chip, log)
    } catch (error) {
      // 烧录 / 读信息中途出错也要把芯片从下载模式拽出来复位（esptool CLI 同款行为）：
      // 不复位的话用户看到失败后必须手动按 EN 才能重试
      await loader.after('hard_reset', usingUsbOtg(port)).catch(() => {})
      throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const tail = log.value.trim().split('\n').slice(-6).join('\n')
    throw new Error(tail ? `${message}\n${tail}` : message)
  } finally {
    try {
      await transport.disconnect()
    } catch {
      /* 已经断了 */
    }
  }
}

export async function flashEsp(
  port: SerialPort,
  options: EspFlashOptions,
  onProgress: (fileIndex: number, written: number, total: number) => void
): Promise<EspFlashResult> {
  const startedAt = Date.now()
  return withLoader(port, options.baudRate, options.before, async (loader, chip, log) => {
    // esptool-js 会先补齐 4 字节、改写镜像头里的 flash 参数再算 MD5：记下它实际校验的那份
    const md5s: string[] = []
    await loader.writeFlash({
      fileArray: options.files.map((file) => ({ address: file.address, data: file.data })),
      flashMode: options.flashMode,
      flashFreq: options.flashFreq,
      flashSize: options.flashSize,
      eraseAll: options.eraseAll,
      compress: options.compress,
      reportProgress: onProgress,
      calculateMD5Hash: (image) => {
        const hash = md5Hex(image)
        md5s.push(hash)
        return hash
      }
    })
    await loader.after(options.after, usingUsbOtg(port))
    return {
      chip,
      files: options.files.map((file, index) => ({ address: file.address, size: file.data.length, md5: md5s[index] ?? '' })),
      elapsedMs: Date.now() - startedAt,
      log: log.value
    }
  })
}

export async function espInfo(port: SerialPort, before: Before): Promise<EspInfo> {
  return withLoader(port, 115200, before, async (loader, chip) => {
    const features = await loader.chip.getChipFeatures(loader)
    const mac = await loader.chip.readMac(loader)
    const flashSize = await loader.detectFlashSize()
    await loader.after('hard_reset', usingUsbOtg(port))
    return { chip, features: features.join(', '), mac, flashSize }
  })
}
