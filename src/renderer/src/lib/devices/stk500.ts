// 客户端设备：Arduino（Uno / Nano / Pro Mini，optiboot）的 STK500v1 烧录（方案-客户端设备 §5.7）。同 avrdude -c arduino：
//   DTR/RTS 拉低 250 ms 再拉高（经板子上的电容复位芯片，进 bootloader）→ GET_SYNC 握手 → 读签名 → 进编程模式 →
//   按页 LOAD_ADDRESS（字地址）+ PROG_PAGE → 逐页读回核对 → 退出编程模式（bootloader 跳到新程序）。
// Mega 2560 用的是 STK500v2，不在这里（用 run_tool 跑 avrdude）。

import { SerialIO, sleep } from './serialIO.js'
import type { PortLike } from './serialSession.js'

const STK_OK = 0x10
const STK_INSYNC = 0x14
const CRC_EOP = 0x20
const GET_SYNC = 0x30
const ENTER_PROGMODE = 0x50
const LEAVE_PROGMODE = 0x51
const LOAD_ADDRESS = 0x55
const PROG_PAGE = 0x64
const READ_PAGE = 0x74
const READ_SIGN = 0x75

const SIGNATURES: Record<string, string> = {
  '1e950f': 'ATmega328P',
  '1e9514': 'ATmega328',
  '1e9406': 'ATmega168',
  '1e940b': 'ATmega168P',
  '1e9587': 'ATmega32U4'
}

export interface Stk500Options {
  /** optiboot（Uno、新 Nano）115200；老 bootloader 的 Nano / Pro Mini 57600 */
  baudRate: number
  /** 页大小（字节）：ATmega328P / 168 是 128 */
  pageSize: number
  /** 镜像起始地址（.hex 的最低地址，通常 0） */
  address: number
}

export interface Stk500Result {
  chip: string
  signature: string
  bytes: number
  pages: number
  elapsedMs: number
}

async function command(io: SerialIO, bytes: number[], replyBytes = 0, timeoutMs = 1000): Promise<Uint8Array> {
  await io.write([...bytes, CRC_EOP])
  const reply = await io.read(replyBytes + 2, timeoutMs)
  if (reply[0] !== STK_INSYNC || reply[reply.length - 1] !== STK_OK) {
    throw new Error(`bootloader 回话不对（命令 0x${bytes[0].toString(16)}：${Array.from(reply, (b) => b.toString(16).padStart(2, '0')).join(' ')}）`)
  }
  return reply.subarray(1, 1 + replyBytes)
}

async function sync(io: SerialIO): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    io.drain()
    await io.write([GET_SYNC, CRC_EOP])
    try {
      const reply = await io.read(2, 300)
      if (reply[0] === STK_INSYNC && reply[1] === STK_OK) return
    } catch {
      /* 再来 */
    }
  }
  throw new Error('和 bootloader 握不上手（波特率不对？Nano 老 bootloader 用 57600；或者这块板子没有 bootloader）')
}

export async function flashStk500(
  port: PortLike,
  image: Uint8Array,
  options: Stk500Options,
  onProgress: (written: number, total: number) => void
): Promise<Stk500Result> {
  const startedAt = Date.now()
  const io = new SerialIO(port)
  await io.open({ baudRate: options.baudRate, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' })
  try {
    // 复位进 bootloader（同 avrdude 的 arduino 编程器）
    await io.setSignals({ dataTerminalReady: false, requestToSend: false })
    await sleep(250)
    await io.setSignals({ dataTerminalReady: true, requestToSend: true })
    await sleep(50)
    await sync(io)
    const signatureBytes = await command(io, [READ_SIGN], 3)
    const signature = Array.from(signatureBytes, (b) => b.toString(16).padStart(2, '0')).join('')
    await command(io, [ENTER_PROGMODE])
    const pageSize = options.pageSize
    const pages = Math.ceil(image.length / pageSize)
    for (let page = 0; page < pages; page++) {
      const offset = page * pageSize
      const chunk = new Uint8Array(pageSize).fill(0xff)
      chunk.set(image.subarray(offset, offset + pageSize))
      const word = (options.address + offset) >> 1
      await command(io, [LOAD_ADDRESS, word & 0xff, (word >> 8) & 0xff])
      await command(io, [PROG_PAGE, (pageSize >> 8) & 0xff, pageSize & 0xff, 0x46, ...chunk], 0, 2000)
      onProgress(Math.min(offset + pageSize, image.length), image.length * 2)
    }
    // 读回核对
    for (let page = 0; page < pages; page++) {
      const offset = page * pageSize
      const length = Math.min(pageSize, image.length - offset)
      const word = (options.address + offset) >> 1
      await command(io, [LOAD_ADDRESS, word & 0xff, (word >> 8) & 0xff])
      const read = await command(io, [READ_PAGE, (pageSize >> 8) & 0xff, pageSize & 0xff, 0x46], pageSize, 2000)
      for (let i = 0; i < length; i++) {
        if (read[i] !== image[offset + i]) throw new Error(`核对不对：地址 0x${(options.address + offset + i).toString(16)}`)
      }
      onProgress(image.length + offset + length, image.length * 2)
    }
    await command(io, [LEAVE_PROGMODE])
    return {
      chip: SIGNATURES[signature] ?? `未知芯片（签名 ${signature}）`,
      signature,
      bytes: image.length,
      pages,
      elapsedMs: Date.now() - startedAt
    }
  } finally {
    await io.close()
  }
}
