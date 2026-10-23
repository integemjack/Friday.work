// 客户端设备：adb 隧道的过滤（方案-客户端设备 §5.6）。
//
// 服务端的 adb 连过来的是客户端这台的 adb server（127.0.0.1:5037）——它能碰这台电脑连着的所有手机、还能关掉 server。
// 这里夹在中间看 adb 的主机协议（每条请求 = 4 位十六进制长度 + 文字），只放行授权过的那一台：
//   - host:version / features / host-features / list-forward 照转；
//   - host:devices[-l] / track-devices[-l] 的回复只留这一台那行；
//   - host:transport:<它> / host:tport:serial:<它> 照转，-any / -usb / -local 改写成它；别的序列号拒绝；
//   - host-serial:<它>:… 照转，host-usb: / host-local: / host:get-* 改写成 host-serial:<它>:…；
//   - host:kill、connect、disconnect、pair、reconnect……一律拒绝（不让服务端关掉客户端的 adb server、连别的手机）。
// 切到手机之后（transport 回了 OKAY）的字节是手机上的服务（shell、sync、install……），不再管。

export interface GateOutput {
  toServer: Uint8Array[]
  toClient: Uint8Array[]
  /** 拒绝了：把 toClient 发完就关 */
  close: boolean
}

type ServerState =
  /** 还没发请求 / 回复原样转（version、features、host-serial:…） */
  | 'pass'
  /** 等 transport 的 OKAY（tport 还要 8 字节的 transport id） */
  | 'transport'
  /** devices / track-devices：OKAY 之后每条列表过滤一遍 */
  | 'list'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0')
}

function frame(text: string): Uint8Array {
  const body = encoder.encode(text)
  return concat([encoder.encode(hex4(body.length)), body])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function failFrame(message: string): Uint8Array {
  return concat([encoder.encode('FAIL'), frame(message)])
}

/** 照转的主机请求 */
const PASS = new Set(['host:version', 'host:features', 'host:host-features', 'host:list-forward'])
const LISTS = new Set(['host:devices', 'host:devices-l', 'host:track-devices', 'host:track-devices-l'])

export class AdbGate {
  /** 客户端（服务端的 adb）还在发主机请求；切到手机后为 false，之后全部照转 */
  private requesting = true
  private clientBuffer: Uint8Array = new Uint8Array(0)
  private serverBuffer: Uint8Array = new Uint8Array(0)
  private serverState: ServerState = 'pass'
  private tport = false
  private gotStatus = false

  constructor(private readonly serial: string) {}

  /** 服务端的 adb 发来的字节 */
  fromClient(chunk: Uint8Array): GateOutput {
    const out: GateOutput = { toServer: [], toClient: [], close: false }
    if (!this.requesting) {
      out.toServer.push(chunk)
      return out
    }
    this.clientBuffer = concat([this.clientBuffer, chunk])
    while (this.requesting && this.clientBuffer.length >= 4) {
      const length = Number.parseInt(decoder.decode(this.clientBuffer.subarray(0, 4)), 16)
      if (!Number.isFinite(length) || length < 0) {
        out.toClient.push(failFrame('坏请求'))
        out.close = true
        return out
      }
      if (this.clientBuffer.length < 4 + length) break
      const request = decoder.decode(this.clientBuffer.subarray(4, 4 + length))
      this.clientBuffer = this.clientBuffer.subarray(4 + length)
      const decision = this.decide(request)
      if (!decision) {
        out.toClient.push(failFrame(`客户端只开放了 ${this.serial}，不能 ${request.split(':').slice(0, 2).join(':')}`))
        out.close = true
        return out
      }
      out.toServer.push(frame(decision.request))
      this.serverState = decision.state
      this.tport = decision.tport
      this.gotStatus = false
      // transport 之后的请求是给手机的：不再拆
      if (decision.state === 'transport') this.requesting = false
    }
    if (!this.requesting && this.clientBuffer.length > 0) {
      out.toServer.push(this.clientBuffer)
      this.clientBuffer = new Uint8Array(0)
    }
    return out
  }

  /** 客户端这台的 adb server 回来的字节 */
  fromServer(chunk: Uint8Array): GateOutput {
    const out: GateOutput = { toServer: [], toClient: [], close: false }
    if (this.serverState === 'pass') {
      out.toClient.push(chunk)
      return out
    }
    this.serverBuffer = concat([this.serverBuffer, chunk])
    if (!this.gotStatus) {
      const statusLength = this.serverState === 'transport' && this.tport ? 12 : 4
      if (this.serverBuffer.length < 4) return out
      const status = decoder.decode(this.serverBuffer.subarray(0, 4))
      if (status !== 'OKAY') {
        // FAIL：原样转，之后照转
        this.serverState = 'pass'
        out.toClient.push(this.serverBuffer)
        this.serverBuffer = new Uint8Array(0)
        return out
      }
      if (this.serverBuffer.length < statusLength) return out
      out.toClient.push(this.serverBuffer.subarray(0, statusLength))
      this.serverBuffer = this.serverBuffer.subarray(statusLength)
      this.gotStatus = true
      if (this.serverState === 'transport') {
        this.serverState = 'pass'
        if (this.serverBuffer.length > 0) out.toClient.push(this.serverBuffer)
        this.serverBuffer = new Uint8Array(0)
        return out
      }
    }
    // list：一条一条（4 位长度 + 列表文字），只留这一台
    while (this.serverBuffer.length >= 4) {
      const length = Number.parseInt(decoder.decode(this.serverBuffer.subarray(0, 4)), 16)
      if (!Number.isFinite(length) || this.serverBuffer.length < 4 + length) break
      const listing = decoder.decode(this.serverBuffer.subarray(4, 4 + length))
      this.serverBuffer = this.serverBuffer.subarray(4 + length)
      out.toClient.push(frame(filterListing(listing, this.serial)))
    }
    return out
  }

  private decide(request: string): { request: string; state: ServerState; tport: boolean } | null {
    const serial = this.serial
    if (PASS.has(request)) return { request, state: 'pass', tport: false }
    if (LISTS.has(request)) return { request, state: 'list', tport: false }
    if (request === `host:transport:${serial}`) return { request, state: 'transport', tport: false }
    if (request === 'host:transport-any' || request === 'host:transport-usb' || request === 'host:transport-local') {
      return { request: `host:transport:${serial}`, state: 'transport', tport: false }
    }
    if (request === `host:tport:serial:${serial}`) return { request, state: 'transport', tport: true }
    if (request === 'host:tport:any' || request === 'host:tport:usb' || request === 'host:tport:local') {
      return { request: `host:tport:serial:${serial}`, state: 'transport', tport: true }
    }
    if (request.startsWith(`host-serial:${serial}:`)) {
      return this.hostSerial(request.slice(`host-serial:${serial}:`.length))
    }
    for (const prefix of ['host-usb:', 'host-local:']) {
      if (request.startsWith(prefix)) return this.hostSerial(request.slice(prefix.length))
    }
    // host:get-state / get-serialno / get-devpath（隐含「任意一台」）：落到这一台
    if (request === 'host:get-state' || request === 'host:get-serialno' || request === 'host:get-devpath') {
      return this.hostSerial(request.slice('host:'.length))
    }
    return null
  }

  /** host-serial:<它>:<命令>：命令也得是对这一台无害的（不能 kill / connect…） */
  private hostSerial(command: string): { request: string; state: ServerState; tport: boolean } | null {
    if (/^(kill|connect|disconnect|pair|reconnect)/.test(command)) return null
    return { request: `host-serial:${this.serial}:${command}`, state: 'pass', tport: false }
  }
}

/** 设备列表只留这一台（「序列号\t状态 …」一行一台） */
export function filterListing(listing: string, serial: string): string {
  return listing
    .split('\n')
    .filter((line) => line.length > 0 && line.split(/[\t ]/)[0] === serial)
    .map((line) => `${line}\n`)
    .join('')
}
