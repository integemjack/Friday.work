// 客户端设备：STM32 的串口引导程序烧录（ST AN3155，方案-客户端设备 §5.7）。8 位偶校验：
//   0x7F 自适应波特率 → GET（看用 ERASE 0x43 还是 EXTENDED ERASE 0x44）→ GET ID → 整片擦除 →
//   WRITE MEMORY 每块 256 字节（地址、长度、数据各带异或校验）→ READ MEMORY 读回核对 → GO 跳到应用。
// 要先让芯片从系统存储器启动（BOOT0 拉高再复位）；reset = 'dtr-rts' 时用 RTS 拉 BOOT0、DTR 拉 NRST（同 stm32flash -i 的常见接法）。

import { SerialIO, sleep } from './serialIO.js'
import type { PortLike } from './serialSession.js'

const ACK = 0x79
const NACK = 0x1f
const CMD_GET = 0x00
const CMD_GET_ID = 0x02
const CMD_READ = 0x11
const CMD_GO = 0x21
const CMD_WRITE = 0x31
const CMD_ERASE = 0x43
const CMD_EXTENDED_ERASE = 0x44
const BLOCK = 256

export interface Stm32Options {
  baudRate: number
  /** 烧到哪（缺省 0x08000000，主 flash 开头） */
  address: number
  reset: 'none' | 'dtr-rts'
}

export interface Stm32Result {
  chip: string
  productId: string
  bootloader: string
  bytes: number
  elapsedMs: number
}

const PRODUCTS: Record<number, string> = {
  0x410: 'STM32F10xxx 中密度（F103C8 等）',
  0x412: 'STM32F10xxx 低密度',
  0x414: 'STM32F10xxx 高密度',
  0x413: 'STM32F40xxx / F41xxx',
  0x431: 'STM32F411',
  0x423: 'STM32F401xB/C',
  0x433: 'STM32F401xD/E',
  0x440: 'STM32F030x8 / F05x',
  0x444: 'STM32F030x4/6',
  0x466: 'STM32G03x / G04x',
  0x468: 'STM32G43x / G44x',
  0x415: 'STM32L47x / L48x',
  0x450: 'STM32H74x / H75x'
}

function xor(bytes: number[]): number {
  return bytes.reduce((value, byte) => value ^ byte, 0)
}

async function expectAck(io: SerialIO, what: string, timeoutMs = 1000): Promise<void> {
  const [reply] = await io.read(1, timeoutMs)
  if (reply === ACK) return
  throw new Error(`${what}：引导程序${reply === NACK ? '拒绝了（NACK；读保护打开了？）' : `回了 0x${reply.toString(16)}`}`)
}

async function send(io: SerialIO, command: number, what: string): Promise<void> {
  await io.write([command, command ^ 0xff])
  await expectAck(io, what)
}

async function sendAddress(io: SerialIO, address: number, what: string): Promise<void> {
  const bytes = [(address >>> 24) & 0xff, (address >>> 16) & 0xff, (address >>> 8) & 0xff, address & 0xff]
  await io.write([...bytes, xor(bytes)])
  await expectAck(io, what)
}

export async function flashStm32(
  port: PortLike,
  image: Uint8Array,
  options: Stm32Options,
  onProgress: (written: number, total: number) => void
): Promise<Stm32Result> {
  const startedAt = Date.now()
  const io = new SerialIO(port)
  await io.open({ baudRate: options.baudRate, dataBits: 8, parity: 'even', stopBits: 1, flowControl: 'none' })
  try {
    if (options.reset === 'dtr-rts') {
      // BOOT0 高（RTS 置位）、拉一下 NRST（DTR 置位 = 低）
      await io.setSignals({ requestToSend: true, dataTerminalReady: true })
      await sleep(100)
      await io.setSignals({ dataTerminalReady: false })
      await sleep(200)
    }
    // 自适应波特率：0x7F；已经握过手的会回 NACK，也算好
    io.drain()
    await io.write([0x7f])
    const [hello] = await io.read(1, 1000).catch(() => {
      throw new Error('引导程序没回话（BOOT0 拉高再复位了吗？TX/RX 接对了吗？）')
    })
    if (hello !== ACK && hello !== NACK) throw new Error(`引导程序回了 0x${hello.toString(16)}`)

    await send(io, CMD_GET, 'GET')
    const [count] = await io.read(1, 1000)
    const info = await io.read(count + 1, 1000)
    await expectAck(io, 'GET 结尾')
    const version = info[0]
    const commands = Array.from(info.subarray(1))
    const extended = commands.includes(CMD_EXTENDED_ERASE)

    await send(io, CMD_GET_ID, 'GET ID')
    const [idCount] = await io.read(1, 1000)
    const id = await io.read(idCount + 1, 1000)
    await expectAck(io, 'GET ID 结尾')
    const productId = (id[0] << 8) | id[1]

    // 整片擦除（大芯片要十几秒）
    if (extended) {
      await send(io, CMD_EXTENDED_ERASE, '擦除')
      await io.write([0xff, 0xff, 0x00])
    } else {
      await send(io, CMD_ERASE, '擦除')
      await io.write([0xff, 0x00])
    }
    await expectAck(io, '擦除', 60_000)

    const padded = new Uint8Array(Math.ceil(image.length / 4) * 4).fill(0xff)
    padded.set(image)
    for (let offset = 0; offset < padded.length; offset += BLOCK) {
      const chunk = Array.from(padded.subarray(offset, offset + BLOCK))
      await send(io, CMD_WRITE, '写')
      await sendAddress(io, options.address + offset, '写地址')
      await io.write([chunk.length - 1, ...chunk, xor([chunk.length - 1, ...chunk])])
      await expectAck(io, `写 0x${(options.address + offset).toString(16)}`, 2000)
      onProgress(offset + chunk.length, padded.length * 2)
    }
    for (let offset = 0; offset < padded.length; offset += BLOCK) {
      const length = Math.min(BLOCK, padded.length - offset)
      await send(io, CMD_READ, '读')
      await sendAddress(io, options.address + offset, '读地址')
      await io.write([length - 1, (length - 1) ^ 0xff])
      await expectAck(io, '读长度')
      const read = await io.read(length, 2000)
      for (let i = 0; i < length; i++) {
        if (read[i] !== padded[offset + i]) throw new Error(`核对不对：地址 0x${(options.address + offset + i).toString(16)}`)
      }
      onProgress(padded.length + offset + length, padded.length * 2)
    }

    await send(io, CMD_GO, 'GO')
    await sendAddress(io, options.address, 'GO 地址')
    if (options.reset === 'dtr-rts') {
      // BOOT0 放低，再复位一次从 flash 起
      await io.setSignals({ requestToSend: false, dataTerminalReady: true })
      await sleep(100)
      await io.setSignals({ dataTerminalReady: false })
    }
    return {
      chip: PRODUCTS[productId] ?? `STM32（产品 ID 0x${productId.toString(16)}）`,
      productId: `0x${productId.toString(16)}`,
      bootloader: `${version >> 4}.${version & 0xf}`,
      bytes: image.length,
      elapsedMs: Date.now() - startedAt
    }
  } finally {
    await io.close()
  }
}
