// 客户端设备：这台电脑连着的手机（方案-客户端设备 §5.1）。不起任何外部程序：
//   安卓：直接问本机的 adb server（127.0.0.1:5037，host:devices-l）——没装 platform-tools / 没起 server 就是空；
//   iOS：问 usbmuxd（Windows 上是 Apple 设备服务的 127.0.0.1:27015，Mac / Linux 是 /var/run/usbmuxd）的 ListDevices。

import net from 'node:net'

export interface PhoneInfo {
  id: string
  kind: 'android' | 'ios'
  label: string
  /** android：device / unauthorized / offline……；ios：USB / Network */
  state: string
  serial: string
}

export const ADB_PORT = 5037

/** usbmuxd 在哪：Windows 是 TCP，其余是 unix socket */
export function usbmuxEndpoint(): net.NetConnectOpts {
  return process.platform === 'win32' ? { host: '127.0.0.1', port: 27015 } : { path: '/var/run/usbmuxd' }
}

/** 连上、发一段、读到对方关或够了为止（最多 timeoutMs） */
function exchange(
  options: net.NetConnectOpts,
  request: Uint8Array,
  done: (received: Buffer) => boolean,
  timeoutMs = 3000
): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const socket = net.connect(options)
    const finish = (): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(Buffer.concat(chunks))
    }
    const timer = setTimeout(finish, timeoutMs)
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      if (done(Buffer.concat(chunks))) finish()
    })
    socket.on('error', finish)
    socket.on('close', finish)
  })
}

/** adb 主机协议的一条请求：4 位十六进制长度 + 文字 */
export function adbRequest(text: string): Uint8Array {
  const body = Buffer.from(text, 'utf8')
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0')), body])
}

/** host:devices-l 的回复：「序列号  状态 usb:… product:… model:Pixel_8 device:… transport_id:1」一行一台 */
export function parseAdbDevices(listing: string): PhoneInfo[] {
  const phones: PhoneInfo[] = []
  for (const line of listing.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2 || !parts[0]) continue
    const [serial, state, ...rest] = parts
    const props = Object.fromEntries(
      rest.filter((part) => part.includes(':')).map((part) => [part.slice(0, part.indexOf(':')), part.slice(part.indexOf(':') + 1)])
    )
    const model = (props.model ?? props.product ?? '安卓手机').replace(/_/g, ' ')
    const note = state === 'device' ? '' : state === 'unauthorized' ? '，手机上还没点允许调试' : `，${state}`
    phones.push({ id: `android:${serial}`, kind: 'android', label: `${model}（${serial}${note}）`, state, serial })
  }
  return phones
}

export async function androidPhones(): Promise<PhoneInfo[]> {
  const reply = await exchange({ host: '127.0.0.1', port: ADB_PORT }, adbRequest('host:devices-l'), (received) => {
    if (received.length < 8) return false
    const length = Number.parseInt(received.subarray(4, 8).toString('latin1'), 16)
    return Number.isFinite(length) && received.length >= 8 + length
  })
  if (reply.length < 8 || reply.subarray(0, 4).toString('latin1') !== 'OKAY') return []
  const length = Number.parseInt(reply.subarray(4, 8).toString('latin1'), 16)
  return parseAdbDevices(reply.subarray(8, 8 + length).toString('utf8'))
}

/** usbmux 的一条消息：16 字节小端头（总长、版本 1、类型 8 = plist、tag）+ XML plist */
export function usbmuxMessage(type: string, tag = 1): Uint8Array {
  const body = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      `<plist version="1.0"><dict><key>MessageType</key><string>${type}</string>` +
      '<key>ClientVersionString</key><string>friday-work</string><key>ProgName</key><string>friday-work</string></dict></plist>\n',
    'utf8'
  )
  const header = Buffer.alloc(16)
  header.writeUInt32LE(16 + body.length, 0)
  header.writeUInt32LE(1, 4)
  header.writeUInt32LE(8, 8)
  header.writeUInt32LE(tag, 12)
  return Buffer.concat([header, body])
}

/** ListDevices 的回复里每台的 SerialNumber（UDID）和 ConnectionType */
export function parseUsbmuxDevices(plist: string): PhoneInfo[] {
  const phones: PhoneInfo[] = []
  const seen = new Set<string>()
  for (const block of plist.split('<key>Properties</key>').slice(1)) {
    const udid = /<key>SerialNumber<\/key>\s*<string>([^<]+)<\/string>/.exec(block)?.[1]
    if (!udid || seen.has(udid)) continue
    seen.add(udid)
    const connection = /<key>ConnectionType<\/key>\s*<string>([^<]+)<\/string>/.exec(block)?.[1] ?? 'USB'
    phones.push({
      id: `ios:${udid}`,
      kind: 'ios',
      label: `iOS 设备（${udid.slice(0, 8)}…，${connection === 'Network' ? 'Wi-Fi' : 'USB'}）`,
      state: connection,
      serial: udid
    })
  }
  return phones
}

export async function iosDevices(): Promise<PhoneInfo[]> {
  const reply = await exchange(usbmuxEndpoint(), usbmuxMessage('ListDevices'), (received) => {
    return received.length >= 16 && received.length >= received.readUInt32LE(0)
  })
  if (reply.length < 16) return []
  return parseUsbmuxDevices(reply.subarray(16, reply.readUInt32LE(0)).toString('utf8'))
}

export async function listPhones(): Promise<PhoneInfo[]> {
  const [android, ios] = await Promise.all([androidPhones().catch(() => []), iosDevices().catch(() => [])])
  return [...android, ...ios]
}

// MARK: 变更监听（方案-客户端设备 §5.1：手机增减 / 授权状态变化也要发 device.changed）

/** adb 的 host:track-devices-l 回复流：OKAY 之后每帧「4 位十六进制长度 + 整份设备列表」。
 *  第一帧是当前快照（基线，不算变化），之后 adb 只在列表变了才推——每帧都是一次变化。 */
export class AdbTrackParser {
  private buffer: Buffer = Buffer.alloc(0)
  private saidHello = false
  private frames = 0
  /** 协议不对（不是 OKAY 开头 / 长度不是十六进制）：调用方该断开重连 */
  failed = false

  /** 喂一段字节，返回这段里完成的「基线之后」的变化帧数 */
  feed(chunk: Buffer): number {
    this.buffer = Buffer.concat([this.buffer, chunk])
    let changes = 0
    if (!this.saidHello) {
      if (this.buffer.length < 4) return 0
      if (this.buffer.subarray(0, 4).toString('latin1') !== 'OKAY') {
        this.failed = true
        return 0
      }
      this.saidHello = true
      this.buffer = this.buffer.subarray(4)
    }
    while (this.buffer.length >= 4) {
      const length = Number.parseInt(this.buffer.subarray(0, 4).toString('latin1'), 16)
      if (!Number.isFinite(length)) {
        this.failed = true
        return changes
      }
      if (this.buffer.length < 4 + length) break
      this.buffer = this.buffer.subarray(4 + length)
      this.frames++
      if (this.frames > 1) changes++
    }
    return changes
  }
}

/** 从缓冲里取出一条完整的 usbmux 消息（16 字节小端头 + plist）；不够一条返回 null */
export function takeUsbmuxMessage(buffer: Buffer): { body: string; rest: Buffer } | null {
  if (buffer.length < 16) return null
  const size = buffer.readUInt32LE(0)
  if (size < 16 || buffer.length < size) return null
  return { body: buffer.subarray(16, size).toString('utf8'), rest: buffer.subarray(size) }
}

/** usbmuxd 推来的消息是不是设备增减（Attached / Detached）；Listen 的回执（Result）不算 */
export function isUsbmuxDeviceChange(plist: string): boolean {
  return /<key>MessageType<\/key>\s*<string>(?:Attached|Detached)<\/string>/.test(plist)
}

const WATCH_RETRY_MS = 30_000
const WATCH_DEBOUNCE_MS = 250

/** 盯住这台电脑上的手机增减：安卓 = adb server 的 host:track-devices-l（连接保持，列表一变推一整份），
 *  iOS = usbmuxd 的 Listen（Attached / Detached）。连不上（没装 platform-tools / iTunes、adb server 还没起）
 *  每 30 秒重试，装好 / 起来后自动接上；短防抖把插上 + 授权到位的连推合成一次。 */
export function watchPhones(onChange: () => void): { stop(): void } {
  let stopped = false
  const sockets = new Set<net.Socket>()
  const timers = new Set<NodeJS.Timeout>()
  let notifyTimer: NodeJS.Timeout | null = null
  const changed = (): void => {
    if (notifyTimer || stopped) return
    notifyTimer = setTimeout(() => {
      notifyTimer = null
      if (!stopped) onChange()
    }, WATCH_DEBOUNCE_MS)
  }
  const retry = (again: () => void): void => {
    if (stopped) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      again()
    }, WATCH_RETRY_MS)
    timers.add(timer)
  }

  // 安卓：track-devices-l 长连接，AdbTrackParser 只数「基线之后」的帧
  const trackAdb = (): void => {
    if (stopped) return
    const socket = net.connect({ host: '127.0.0.1', port: ADB_PORT })
    sockets.add(socket)
    const parser = new AdbTrackParser()
    socket.on('connect', () => socket.write(adbRequest('host:track-devices-l')))
    socket.on('data', (chunk) => {
      if (parser.feed(chunk) > 0) changed()
      if (parser.failed) socket.destroy()
    })
    socket.on('close', () => {
      sockets.delete(socket)
      retry(trackAdb)
    })
    socket.on('error', () => {})
  }

  // iOS：usbmuxd 的 Listen，Attached / Detached 推送
  const listenUsbmux = (): void => {
    if (stopped) return
    const socket = net.connect(usbmuxEndpoint())
    sockets.add(socket)
    let buffer: Buffer = Buffer.alloc(0)
    socket.on('connect', () => socket.write(usbmuxMessage('Listen')))
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const message = takeUsbmuxMessage(buffer)
        if (!message) break
        buffer = message.rest
        if (isUsbmuxDeviceChange(message.body)) changed()
      }
    })
    socket.on('close', () => {
      sockets.delete(socket)
      retry(listenUsbmux)
    })
    socket.on('error', () => {})
  }

  trackAdb()
  listenUsbmux()
  return {
    stop(): void {
      stopped = true
      if (notifyTimer) clearTimeout(notifyTimer)
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
    }
  }
}
