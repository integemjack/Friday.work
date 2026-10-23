// 客户端设备：一个串口会话 = 一个 WebSerial 口 ⇆ 一条专用 DataChannel（方案-客户端设备 §5.2）。
//
// rfc2217 模式下客户端是 RFC 2217 服务器：通道进来的字节拆成数据和控制命令，**严格按流里的顺序**执行
// （esptool 的复位时序靠 DTR/RTS 和数据的先后），每条命令执行完回确认；串口读到的数据 IAC 转义后发回通道。
// raw 模式只搬字节。
//
// WebSerial 不能热改波特率 / 数据位 / 校验 / 停止位 / 流控：改的时候关口按新参数重开，再把 DTR/RTS 补回去。
// 本机烧录要独占这个口时 suspend()：口让出去、通道不关、进来的数据先攒着；resume() 按原参数重开接着转发。

import {
  Control,
  Cpo,
  CODE_TO_PARITY,
  CODE_TO_STOP,
  Modem,
  PARITY_TO_CODE,
  Rfc2217Codec,
  STOP_TO_CODE,
  escapeData,
  readU32,
  serverCommand,
  u32,
  type ParityName
} from './rfc2217.js'

/** WebSerial SerialPort 里用到的那部分（单测用假的） */
export interface PortLike {
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  open(options: {
    baudRate: number
    dataBits?: number
    stopBits?: number
    parity?: ParityName
    flowControl?: 'none' | 'hardware'
    bufferSize?: number
  }): Promise<void>
  close(): Promise<void>
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void>
  getSignals(): Promise<{ clearToSend: boolean; dataSetReady: boolean; ringIndicator: boolean; dataCarrierDetect: boolean }>
}

/** RTCDataChannel 里用到的那部分 */
export interface ChannelLike {
  readonly readyState: string
  readonly bufferedAmount: number
  bufferedAmountLowThreshold: number
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onbufferedamountlow: (() => void) | null
  send(data: ArrayBuffer): void
  close(): void
}

export interface SerialConfig {
  baudRate: number
  dataBits: 7 | 8
  parity: ParityName
  stopBits: 1 | 2
  flowControl: 'none' | 'hardware'
}

export type SerialMode = 'rfc2217' | 'raw'

export interface SerialSessionEvents {
  /** 会话结束（byPeer：服务端那头关的通道，不用再发 device.serial.closed） */
  onClosed(reason: string, byPeer: boolean): void
  /** 参数变了 / 挂起恢复了（界面刷新） */
  onChange(): void
}

const SIGNATURE = 'Friday Work'
/** 通道里积压超过这么多就先不读串口（让 WebSerial 的缓冲兜着） */
const HIGH_WATER = 1024 * 1024
const LOW_WATER = 256 * 1024

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.byteLength === bytes.byteLength && bytes.byteOffset === 0
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer)
}

/** WebSerial 报出来的非致命读错误（之后 port.readable 会换成新的流，接着读就行） */
const RECOVERABLE = new Set(['BufferOverrunError', 'BreakError', 'FramingError', 'ParityError'])

export class SerialSession {
  readonly config: SerialConfig
  bytesIn = 0
  bytesOut = 0
  suspended = false
  closed = false

  private readonly codec: Rfc2217Codec | null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private pump: Promise<void> = Promise.resolve()
  private releasing = false
  /** 还没开口（start 的 openPort 在跑）：通道进来的字节先攒在这 */
  private starting = true
  private readonly pendingIn: Uint8Array[] = []
  /** 通道进来的字节按顺序处理（命令要等串口操作做完才处理下一段） */
  private queue: Promise<void> = Promise.resolve()
  /** 挂起期间挡住 queue；resume 时放行 */
  private gate: { promise: Promise<void>; open: () => void } | null = null
  /** RFC 2217 FLOWCONTROL-SUSPEND：对端叫停时先不往通道送 */
  private flowGate: { promise: Promise<void>; open: () => void } | null = null
  private drained: (() => void) | null = null
  /** 对端设过的 DTR / RTS / BREAK（重开口后补回去；没设过就保持 WebSerial 打开时的默认） */
  private readonly signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean } = {}

  constructor(
    private readonly port: PortLike,
    private readonly channel: ChannelLike,
    readonly mode: SerialMode,
    config: SerialConfig,
    private readonly events: SerialSessionEvents
  ) {
    this.config = { ...config }
    this.codec = mode === 'rfc2217' ? new Rfc2217Codec() : null
  }

  /** 打开串口、开始双向转发 */
  async start(): Promise<void> {
    // 先挂好通道处理器再开口：openPort 要几十毫秒，这窗口里对端关通道的事件
    // 不能丢（丢了会话永远挂着、口一直占在 busy 里），首包字节也不能丢
    this.channel.bufferedAmountLowThreshold = LOW_WATER
    this.channel.onbufferedamountlow = () => {
      const drained = this.drained
      this.drained = null
      drained?.()
    }
    this.channel.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return
      const bytes = new Uint8Array(event.data)
      // 还没开口（openPort 在跑）：先攒着，开口后按序补处理——
      // esptool 连上就发 IAC 协商，丢了整条流就坏了
      if (this.starting) {
        this.pendingIn.push(bytes)
        return
      }
      this.enqueueFromChannel(bytes)
    }
    this.channel.onclose = () => void this.close('服务端关了通道', true)
    try {
      await this.openPort()
    } finally {
      this.starting = false
    }
    if (this.closed) return
    if (this.codec) this.sendChannel(this.codec.start())
    // 开口前攒的字节按原顺序补处理（在协商帧之后，保证 RFC 2217 的先后序）
    for (const bytes of this.pendingIn.splice(0)) this.enqueueFromChannel(bytes)
  }

  private enqueueFromChannel(bytes: Uint8Array): void {
    this.queue = this.queue.then(() => this.fromChannel(bytes)).catch((error) => {
      void this.close(`串口操作失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** 本机烧录要独占串口：让出来（通道不关，进来的数据攒着） */
  async suspend(): Promise<void> {
    if (this.closed || this.suspended) return
    let open = (): void => {}
    const promise = new Promise<void>((resolve) => (open = resolve))
    this.gate = { promise, open }
    // 等正在处理的那段做完，再让口
    await this.queue.catch(() => {})
    this.suspended = true
    await this.releasePort()
    this.events.onChange()
  }

  /** 烧录完：按原参数重开，接着转发 */
  async resume(): Promise<void> {
    if (this.closed || !this.suspended) return
    try {
      await this.openPort()
    } catch (error) {
      void this.close(`烧录后重新打开串口失败：${error instanceof Error ? error.message : String(error)}`)
      return
    } finally {
      this.suspended = false
      const gate = this.gate
      this.gate = null
      gate?.open()
    }
    this.events.onChange()
  }

  async close(reason: string, byPeer = false): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.gate?.open()
    this.flowGate?.open()
    this.drained?.()
    this.channel.onmessage = null
    this.channel.onclose = null
    this.channel.onbufferedamountlow = null
    try {
      this.channel.close()
    } catch {
      /* 已经关了 */
    }
    if (!this.suspended) await this.releasePort()
    this.events.onClosed(reason, byPeer)
  }

  // MARK: 串口

  private async openPort(): Promise<void> {
    await this.port.open({
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits,
      parity: this.config.parity,
      stopBits: this.config.stopBits,
      flowControl: this.config.flowControl,
      bufferSize: 64 * 1024
    })
    if (Object.keys(this.signals).length > 0) await this.port.setSignals({ ...this.signals })
    this.writer = this.port.writable?.getWriter() ?? null
    this.pump = this.readLoop()
  }

  /** 停读、放锁、关口（重开 / 挂起 / 结束都走这里） */
  private async releasePort(): Promise<void> {
    this.releasing = true
    // readLoop 可能停在 toChannel 的两个 await 上（对端 FLOWCONTROL-SUSPEND /
    // 通道积压等 drained）：不放行的话 pump 永远不结束，suspend / 改参数 / 关闭
    // 全跟着永久卡死（烧录会把串口占死在 'esp' 上）
    this.flowGate?.open()
    this.drained?.()
    try {
      await this.reader?.cancel()
    } catch {
      /* 已经断了 */
    }
    await this.pump
    try {
      this.writer?.releaseLock()
    } catch {
      /* 写到一半：锁放不掉也要关口 */
    }
    this.writer = null
    try {
      await this.port.close()
    } catch {
      /* 设备拔了 / 已经关了 */
    }
    this.releasing = false
  }

  private async readLoop(): Promise<void> {
    while (!this.releasing && !this.closed && this.port.readable) {
      const reader = this.port.readable.getReader()
      this.reader = reader
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value && value.length > 0) await this.toChannel(value)
        }
      } catch (error) {
        const name = error instanceof Error ? error.name : ''
        if (!this.releasing && !this.closed && !RECOVERABLE.has(name)) {
          reader.releaseLock()
          this.reader = null
          void this.close('串口断开了（设备拔掉或出错）')
          return
        }
      } finally {
        try {
          reader.releaseLock()
        } catch {
          /* 已经放了 */
        }
        if (this.reader === reader) this.reader = null
      }
    }
    // 不是自己停的却读不下去了（readable 没了）：设备没了
    if (!this.releasing && !this.closed) void this.close('串口断开了（设备拔掉或出错）')
  }

  private async toChannel(bytes: Uint8Array): Promise<void> {
    if (this.flowGate) await this.flowGate.promise
    if (this.closed || this.channel.readyState !== 'open') return
    this.bytesIn += bytes.length
    this.sendChannel(this.codec ? escapeData(bytes) : bytes)
    if (this.channel.bufferedAmount > HIGH_WATER) {
      await new Promise<void>((resolve) => (this.drained = resolve))
    }
  }

  private sendChannel(bytes: Uint8Array): void {
    if (this.channel.readyState !== 'open') return
    this.channel.send(toArrayBuffer(bytes))
  }

  private async writePort(bytes: Uint8Array): Promise<void> {
    if (!this.writer || bytes.length === 0) return
    this.bytesOut += bytes.length
    await this.writer.write(bytes)
  }

  /** 改参数：WebSerial 只能关了重开 */
  private async reconfigure(change: Partial<SerialConfig>): Promise<void> {
    const next = { ...this.config, ...change }
    if (
      next.baudRate === this.config.baudRate &&
      next.dataBits === this.config.dataBits &&
      next.parity === this.config.parity &&
      next.stopBits === this.config.stopBits &&
      next.flowControl === this.config.flowControl
    ) {
      return
    }
    await this.releasePort()
    // releasePort 期间通道被对端关了（close 会把口也放掉）：到此为止，
    // 不能再把物理口重新打开——那样 broker 以为空闲，口实际被锁死到重载页面
    if (this.closed) return
    Object.assign(this.config, next)
    await this.openPort()
    this.events.onChange()
  }

  // MARK: 通道进来的字节

  private async fromChannel(bytes: Uint8Array): Promise<void> {
    if (this.gate) await this.gate.promise
    if (this.closed) return
    if (!this.codec) {
      await this.writePort(bytes)
      return
    }
    for (const event of this.codec.feed(bytes)) {
      if (this.closed) return
      if (event.kind === 'data') await this.writePort(event.bytes)
      else if (event.kind === 'reply') this.sendChannel(event.bytes)
      else await this.command(event.code, event.value)
    }
  }

  private async command(code: number, value: Uint8Array): Promise<void> {
    const reply = (bytes: number[] | Uint8Array): void => this.sendChannel(serverCommand(code, bytes))
    switch (code) {
      case Cpo.Signature:
        // 空值 = 问我们的签名；带值 = 对端报它自己的，不用回
        if (value.length === 0) reply(new TextEncoder().encode(SIGNATURE))
        return
      case Cpo.SetBaudrate: {
        const baudRate = readU32(value)
        if (baudRate > 0) await this.reconfigure({ baudRate })
        reply(u32(this.config.baudRate))
        return
      }
      case Cpo.SetDatasize: {
        const bits = value[0] ?? 0
        if (bits === 7 || bits === 8) await this.reconfigure({ dataBits: bits })
        reply([this.config.dataBits])
        return
      }
      case Cpo.SetParity: {
        const parity = CODE_TO_PARITY[value[0] ?? 0]
        if (parity) await this.reconfigure({ parity })
        reply([PARITY_TO_CODE[this.config.parity]])
        return
      }
      case Cpo.SetStopsize: {
        const stopBits = CODE_TO_STOP[value[0] ?? 0]
        if (stopBits) await this.reconfigure({ stopBits })
        reply([STOP_TO_CODE[this.config.stopBits]])
        return
      }
      case Cpo.SetControl:
        reply([await this.control(value[0] ?? 0)])
        return
      case Cpo.NotifyLinestate:
        reply([0])
        return
      case Cpo.NotifyModemstate:
        reply([await this.modemState()])
        return
      case Cpo.FlowcontrolSuspend:
        if (!this.flowGate) {
          let open = (): void => {}
          const promise = new Promise<void>((resolve) => (open = resolve))
          this.flowGate = { promise, open }
        }
        return
      case Cpo.FlowcontrolResume: {
        const flowGate = this.flowGate
        this.flowGate = null
        flowGate?.open()
        return
      }
      case Cpo.SetLinestateMask:
      case Cpo.SetModemstateMask:
      case Cpo.PurgeData:
        // 客户端侧没有自己的缓冲可清；掩码我们也不主动推，回显确认即可
        reply(value)
        return
      default:
        return
    }
  }

  /** SET-CONTROL：执行后返回要回显的值 */
  private async control(value: number): Promise<number> {
    switch (value) {
      case Control.RequestFlow:
        return this.config.flowControl === 'hardware' ? Control.HardwareFlow : Control.NoFlow
      case Control.NoFlow:
        await this.reconfigure({ flowControl: 'none' })
        return Control.NoFlow
      case Control.HardwareFlow:
        await this.reconfigure({ flowControl: 'hardware' })
        return Control.HardwareFlow
      case Control.XonXoff:
        // WebSerial 没有软件流控：回当前的，对端会知道没设上
        return this.config.flowControl === 'hardware' ? Control.HardwareFlow : Control.NoFlow
      case Control.RequestBreak:
        return this.signals.break ? Control.BreakOn : Control.BreakOff
      case Control.BreakOn:
      case Control.BreakOff:
        await this.setSignal('break', value === Control.BreakOn)
        return value
      case Control.RequestDtr:
        return this.signals.dataTerminalReady === false ? Control.DtrOff : Control.DtrOn
      case Control.DtrOn:
      case Control.DtrOff:
        await this.setSignal('dataTerminalReady', value === Control.DtrOn)
        return value
      case Control.RequestRts:
        return this.signals.requestToSend === false ? Control.RtsOff : Control.RtsOn
      case Control.RtsOn:
      case Control.RtsOff:
        await this.setSignal('requestToSend', value === Control.RtsOn)
        return value
      default:
        // 入向流控（13..19）等：WebSerial 管不了，回显
        return value
    }
  }

  private async setSignal(name: 'dataTerminalReady' | 'requestToSend' | 'break', on: boolean): Promise<void> {
    this.signals[name] = on
    await this.port.setSignals({ [name]: on })
  }

  private async modemState(): Promise<number> {
    try {
      const signals = await this.port.getSignals()
      return (
        (signals.clearToSend ? Modem.Cts : 0) |
        (signals.dataSetReady ? Modem.Dsr : 0) |
        (signals.ringIndicator ? Modem.Ri : 0) |
        (signals.dataCarrierDetect ? Modem.Cd : 0)
      )
    } catch {
      return 0
    }
  }
}
