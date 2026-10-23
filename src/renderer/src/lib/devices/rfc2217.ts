// RFC 2217（Telnet COM-PORT-OPTION）的服务器一侧编解码（方案-客户端设备 §5.2）。
//
// 客户端是 RFC 2217 服务器：服务端那头的 esptool / pyserial 连 rfc2217://，字节经 DataChannel 原样搬过来，
// 这里拆成「串口数据」和「控制命令」（波特率 / DTR / RTS / 清缓冲……），由 SerialSession 按顺序执行、回确认。
// 只做纯编解码，不碰串口和通道（单测直接喂字节）。
//
// Telnet 选项协商按 RFC 1143 的简化版：每个选项记 no / wantYes / yes，只在状态变化时回话，不会和对端来回打转。

export const IAC = 255
export const DONT = 254
export const DO = 253
export const WONT = 252
export const WILL = 251
export const SB = 250
export const SE = 240

export const OPT_BINARY = 0
export const OPT_ECHO = 1
export const OPT_SGA = 3
export const OPT_COM_PORT = 44

/** COM-PORT-OPTION 的客户端 → 服务器命令码（服务器回的是 +100） */
export const Cpo = {
  Signature: 0,
  SetBaudrate: 1,
  SetDatasize: 2,
  SetParity: 3,
  SetStopsize: 4,
  SetControl: 5,
  NotifyLinestate: 6,
  NotifyModemstate: 7,
  FlowcontrolSuspend: 8,
  FlowcontrolResume: 9,
  SetLinestateMask: 10,
  SetModemstateMask: 11,
  PurgeData: 12
} as const

export const SERVER_OFFSET = 100

/** SET-CONTROL 的取值（RFC 2217） */
export const Control = {
  RequestFlow: 0,
  NoFlow: 1,
  XonXoff: 2,
  HardwareFlow: 3,
  RequestBreak: 4,
  BreakOn: 5,
  BreakOff: 6,
  RequestDtr: 7,
  DtrOn: 8,
  DtrOff: 9,
  RequestRts: 10,
  RtsOn: 11,
  RtsOff: 12
} as const

/** NOTIFY-MODEMSTATE 的位 */
export const Modem = { Cts: 0x10, Dsr: 0x20, Ri: 0x40, Cd: 0x80 } as const

/** 解出来的东西，按流里的顺序 */
export type Rfc2217Event =
  /** 发往串口的数据（已去掉 IAC 转义） */
  | { kind: 'data'; bytes: Uint8Array }
  /** 协商回话，直接发回通道 */
  | { kind: 'reply'; bytes: Uint8Array }
  /** COM-PORT-OPTION 命令（code 是客户端命令码 0..12，value 已去转义） */
  | { kind: 'command'; code: number; value: Uint8Array }

type OptionState = 'no' | 'wantYes' | 'yes'

/** 我们愿意开的选项（两个方向一样） */
const SUPPORTED = new Set([OPT_BINARY, OPT_SGA, OPT_COM_PORT])

export class Rfc2217Codec {
  private state: 'data' | 'iac' | 'option' | 'sb' | 'sbIac' = 'data'
  private optionCommand = 0
  private sub: number[] = []
  private readonly local = new Map<number, OptionState>()
  private readonly remote = new Map<number, OptionState>()

  /** 连上就发的协商：我们 WILL / DO 二进制、SGA、COM-PORT-OPTION */
  start(): Uint8Array {
    const out: number[] = []
    for (const option of SUPPORTED) {
      this.local.set(option, 'wantYes')
      out.push(IAC, WILL, option)
      this.remote.set(option, 'wantYes')
      out.push(IAC, DO, option)
    }
    return Uint8Array.from(out)
  }

  /** 对端（服务端程序）是否同意了 COM-PORT-OPTION */
  get comPortActive(): boolean {
    return this.local.get(OPT_COM_PORT) === 'yes' || this.remote.get(OPT_COM_PORT) === 'yes'
  }

  feed(chunk: Uint8Array): Rfc2217Event[] {
    const events: Rfc2217Event[] = []
    let data: number[] = []
    const flushData = (): void => {
      if (data.length === 0) return
      events.push({ kind: 'data', bytes: Uint8Array.from(data) })
      data = []
    }
    const reply = (bytes: number[]): void => {
      flushData()
      events.push({ kind: 'reply', bytes: Uint8Array.from(bytes) })
    }

    for (const byte of chunk) {
      switch (this.state) {
        case 'data':
          if (byte === IAC) this.state = 'iac'
          else data.push(byte)
          break
        case 'iac':
          if (byte === IAC) {
            data.push(IAC)
            this.state = 'data'
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            this.optionCommand = byte
            this.state = 'option'
          } else if (byte === SB) {
            this.sub = []
            this.state = 'sb'
          } else {
            // NOP / GA / AYT 之类的单字节命令：忽略
            this.state = 'data'
          }
          break
        case 'option': {
          this.state = 'data'
          const answer = this.negotiate(this.optionCommand, byte)
          if (answer) reply(answer)
          break
        }
        case 'sb':
          if (byte === IAC) this.state = 'sbIac'
          else this.sub.push(byte)
          break
        case 'sbIac':
          if (byte === IAC) {
            this.sub.push(IAC)
            this.state = 'sb'
          } else if (byte === SE) {
            this.state = 'data'
            if (this.sub.length >= 2 && this.sub[0] === OPT_COM_PORT) {
              flushData()
              events.push({ kind: 'command', code: this.sub[1], value: Uint8Array.from(this.sub.slice(2)) })
            }
            this.sub = []
          } else {
            // 子协商里的坏序列：丢掉这一段
            this.state = 'data'
            this.sub = []
          }
          break
      }
    }
    flushData()
    return events
  }

  /** 收到 WILL/WONT/DO/DONT：返回要回的三个字节（不用回则 null） */
  private negotiate(command: number, option: number): number[] | null {
    const remoteSide = command === WILL || command === WONT
    const table = remoteSide ? this.remote : this.local
    const current = table.get(option) ?? 'no'
    const yes = command === WILL || command === DO
    if (yes) {
      if (!SUPPORTED.has(option)) return [IAC, remoteSide ? DONT : WONT, option]
      table.set(option, 'yes')
      if (current === 'no') return [IAC, remoteSide ? DO : WILL, option]
      return null // wantYes → yes 是对我们请求的同意；yes 再来一次不回
    }
    if (current === 'no') return null
    table.set(option, 'no')
    if (current === 'yes') return [IAC, remoteSide ? DONT : WONT, option]
    return null // 我们请求的被拒了
  }
}

/** 串口数据发往对端：0xFF 双写 */
export function escapeData(bytes: Uint8Array): Uint8Array {
  let count = 0
  for (const byte of bytes) if (byte === IAC) count++
  if (count === 0) return bytes
  const out = new Uint8Array(bytes.length + count)
  let index = 0
  for (const byte of bytes) {
    out[index++] = byte
    if (byte === IAC) out[index++] = IAC
  }
  return out
}

/** 服务器回话：IAC SB COM-PORT-OPTION <code+100> <value…> IAC SE（value 里的 0xFF 双写） */
export function serverCommand(code: number, value: Uint8Array | number[]): Uint8Array {
  const out = [IAC, SB, OPT_COM_PORT, code + SERVER_OFFSET]
  for (const byte of value) {
    out.push(byte)
    if (byte === IAC) out.push(IAC)
  }
  out.push(IAC, SE)
  return Uint8Array.from(out)
}

/** 4 字节大端（波特率） */
export function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

export function readU32(value: Uint8Array): number {
  if (value.length < 4) return 0
  return ((value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3]) >>> 0
}

/** WebSerial 的校验名 ⇆ RFC 2217 的取值（MARK / SPACE WebSerial 不支持） */
export const PARITY_TO_CODE: Record<ParityName, number> = { none: 1, odd: 2, even: 3 }
export const CODE_TO_PARITY: Record<number, ParityName | undefined> = { 1: 'none', 2: 'odd', 3: 'even' }
export type ParityName = 'none' | 'odd' | 'even'

/** WebSerial 的停止位 ⇆ RFC 2217（3 = 1.5 位，WebSerial 不支持） */
export const STOP_TO_CODE: Record<1 | 2, number> = { 1: 1, 2: 2 }
export const CODE_TO_STOP: Record<number, 1 | 2 | undefined> = { 1: 1, 2: 2 }
