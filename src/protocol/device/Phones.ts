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
