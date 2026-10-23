// 客户端设备（方案-客户端设备）：RFC 2217 编解码、串口会话（假串口 + 假通道）、串口命名、参数校验、MD5。
// 锁住：IAC 转义两个方向都对、子协商可以跨包、协商不来回打转；命令和数据严格按流里的顺序落到串口
// （esptool 复位靠这个）；改波特率 = 关口重开且把 DTR/RTS 补回去；烧录挂起期间数据攒着、恢复后照发。
const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash, randomBytes } = require('node:crypto')

const rfc = require('../.tmp/rfc2217.cjs')
const { SerialSession } = require('../.tmp/serialsession.cjs')
const { describePorts, SerialIdRegistry, bridgeFor } = require('../.tmp/serialports.cjs')
const params = require('../.tmp/deviceparams.cjs')
const { md5Hex } = require('../.tmp/md5.cjs')

const { IAC, SB, SE, WILL, WONT, DO, DONT, OPT_BINARY, OPT_SGA, OPT_COM_PORT, OPT_ECHO } = rfc

const sb = (code, ...value) => [IAC, SB, OPT_COM_PORT, code, ...value, IAC, SE]
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms))

// MARK: RFC 2217 编解码

test('RFC 2217：开场协商 WILL/DO 二进制、SGA、COM-PORT；对端同意不再回话', () => {
  const codec = new rfc.Rfc2217Codec()
  const start = [...codec.start()]
  for (const option of [OPT_BINARY, OPT_SGA, OPT_COM_PORT]) {
    assert.ok(start.join(',').includes([IAC, WILL, option].join(',')))
    assert.ok(start.join(',').includes([IAC, DO, option].join(',')))
  }
  const events = codec.feed(Uint8Array.from([IAC, DO, OPT_COM_PORT, IAC, WILL, OPT_COM_PORT, IAC, DO, OPT_BINARY]))
  assert.deepEqual(events, [], '对我们请求的同意不回')
  assert.ok(codec.comPortActive)
})

test('RFC 2217：不支持的选项拒绝、已开的再请求不回、关掉要确认', () => {
  const codec = new rfc.Rfc2217Codec()
  const replies = (bytes) => codec.feed(Uint8Array.from(bytes)).filter((e) => e.kind === 'reply').map((e) => [...e.bytes])
  assert.deepEqual(replies([IAC, DO, OPT_ECHO]), [[IAC, WONT, OPT_ECHO]], 'pyserial 会 DO ECHO：我们不回显')
  assert.deepEqual(replies([IAC, DO, OPT_BINARY]), [[IAC, WILL, OPT_BINARY]], '没请求过的：同意并回 WILL')
  assert.deepEqual(replies([IAC, DO, OPT_BINARY]), [], '已经开了：不回（不打转）')
  assert.deepEqual(replies([IAC, DONT, OPT_BINARY]), [[IAC, WONT, OPT_BINARY]])
  assert.deepEqual(replies([IAC, WILL, 24]), [[IAC, DONT, 24]], '终端类型之类的不接')
})

test('RFC 2217：数据里的 IAC IAC 还原成一个 0xFF；子协商跨包也能拼出来，顺序不乱', () => {
  const codec = new rfc.Rfc2217Codec()
  const stream = [0x41, IAC, IAC, 0x42, ...sb(rfc.Cpo.SetBaudrate, 0x00, 0x01, 0xc2, 0x00), 0x43]
  const events = []
  for (let i = 0; i < stream.length; i += 3) events.push(...codec.feed(Uint8Array.from(stream.slice(i, i + 3))))
  const merged = []
  for (const event of events) {
    const last = merged[merged.length - 1]
    if (event.kind === 'data' && last && last.kind === 'data') last.bytes = [...last.bytes, ...event.bytes]
    else merged.push({ ...event, bytes: event.bytes && [...event.bytes], value: event.value && [...event.value] })
  }
  assert.deepEqual(merged.map((e) => e.kind), ['data', 'command', 'data'])
  assert.deepEqual(merged[0].bytes, [0x41, 0xff, 0x42])
  assert.equal(merged[1].code, rfc.Cpo.SetBaudrate)
  assert.equal(rfc.readU32(Uint8Array.from(merged[1].value)), 115200)
  assert.deepEqual(merged[2].bytes, [0x43])
})

test('RFC 2217：子协商值里的 0xFF 双写进出都对', () => {
  const codec = new rfc.Rfc2217Codec()
  const [event] = codec.feed(Uint8Array.from(sb(rfc.Cpo.SetBaudrate, 0, 0, IAC, IAC, IAC, IAC)))
  assert.deepEqual([...event.value], [0, 0, 0xff, 0xff])
  assert.deepEqual([...rfc.serverCommand(rfc.Cpo.SetBaudrate, [0, 0, 0xff, 0xff])], [IAC, SB, 44, 101, 0, 0, IAC, IAC, IAC, IAC, IAC, SE])
  assert.deepEqual([...rfc.escapeData(Uint8Array.from([1, 0xff, 2]))], [1, 0xff, 0xff, 2])
})

// MARK: 串口会话（假串口 + 假通道）

class FakePort {
  constructor() {
    this.opens = []
    this.closes = 0
    this.log = [] // 串口上实际发生的事，按顺序：['write', bytes] / ['signals', {...}]
    this.readable = null
    this.writable = null
  }
  async open(options) {
    if (this.readable) throw new Error('已经开着')
    this.opens.push(options)
    const self = this
    this.readable = new ReadableStream({ start: (controller) => (self.controller = controller) })
    this.writable = new WritableStream({ write: (chunk) => self.log.push(['write', [...chunk]]) })
  }
  async close() {
    this.closes++
    this.readable = null
    this.writable = null
  }
  async setSignals(signals) {
    this.log.push(['signals', signals])
  }
  async getSignals() {
    return { clearToSend: true, dataSetReady: false, ringIndicator: false, dataCarrierDetect: true }
  }
  emit(bytes) {
    this.controller.enqueue(Uint8Array.from(bytes))
  }
}

class FakeChannel {
  constructor() {
    this.readyState = 'open'
    this.bufferedAmount = 0
    this.bufferedAmountLowThreshold = 0
    this.onmessage = null
    this.onclose = null
    this.onbufferedamountlow = null
    this.sent = []
  }
  send(buffer) {
    this.sent.push(...new Uint8Array(buffer))
  }
  close() {
    this.readyState = 'closed'
  }
  push(bytes) {
    this.onmessage({ data: Uint8Array.from(bytes).buffer })
  }
}

const CONFIG = { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' }

async function session(mode = 'rfc2217') {
  const port = new FakePort()
  const channel = new FakeChannel()
  const closed = []
  const s = new SerialSession(port, channel, mode, CONFIG, { onClosed: (reason, byPeer) => closed.push({ reason, byPeer }), onChange: () => {} })
  await s.start()
  return { port, channel, s, closed }
}

function contains(haystack, needle) {
  return haystack.join(',').includes(needle.join(','))
}

test('会话：DTR/RTS 和数据严格按流里的顺序落到串口，命令回显确认', async () => {
  const { port, channel } = await session()
  assert.equal(port.opens[0].baudRate, 115200)
  assert.ok(contains(channel.sent, [IAC, WILL, OPT_COM_PORT]), '开场协商发出去了')
  channel.sent.length = 0

  // esptool 经典复位：DTR 关 / RTS 开 → DTR 开 / RTS 关 → DTR 关，中间夹数据
  channel.push([
    ...sb(rfc.Cpo.SetControl, rfc.Control.DtrOff),
    ...sb(rfc.Cpo.SetControl, rfc.Control.RtsOn),
    0x10, IAC, IAC,
    ...sb(rfc.Cpo.SetControl, rfc.Control.DtrOn),
    ...sb(rfc.Cpo.SetControl, rfc.Control.RtsOff),
    0x20
  ])
  await tick()
  assert.deepEqual(port.log, [
    ['signals', { dataTerminalReady: false }],
    ['signals', { requestToSend: true }],
    ['write', [0x10, 0xff]],
    ['signals', { dataTerminalReady: true }],
    ['signals', { requestToSend: false }],
    ['write', [0x20]]
  ])
  for (const value of [rfc.Control.DtrOff, rfc.Control.RtsOn, rfc.Control.DtrOn, rfc.Control.RtsOff]) {
    assert.ok(contains(channel.sent, [IAC, SB, 44, 105, value, IAC, SE]), `SET-CONTROL ${value} 回显了`)
  }
})

test('会话：改波特率 = 关口按新参数重开，DTR/RTS 补回去，回实际值', async () => {
  const { port, channel, s } = await session()
  channel.push([...sb(rfc.Cpo.SetControl, rfc.Control.DtrOff), ...sb(rfc.Cpo.SetControl, rfc.Control.RtsOn)])
  await tick()
  channel.push(sb(rfc.Cpo.SetBaudrate, ...rfc.u32(921600)))
  await tick()
  assert.equal(port.closes, 1)
  assert.equal(port.opens.length, 2)
  assert.equal(port.opens[1].baudRate, 921600)
  assert.equal(s.config.baudRate, 921600)
  assert.deepEqual(port.log[port.log.length - 1], ['signals', { dataTerminalReady: false, requestToSend: true }], '重开后补信号')
  assert.ok(contains(channel.sent, [IAC, SB, 44, 101, ...rfc.u32(921600), IAC, SE]))

  // 查询（0）不重开，回当前值
  channel.push(sb(rfc.Cpo.SetBaudrate, 0, 0, 0, 0))
  await tick()
  assert.equal(port.opens.length, 2)
})

test('会话：串口读到的数据转义后进通道；调制解调器状态、清缓冲、签名都有回话', async () => {
  const { port, channel } = await session()
  channel.sent.length = 0
  port.emit([0x41, 0xff, 0x42])
  await tick()
  assert.deepEqual(channel.sent, [0x41, 0xff, 0xff, 0x42])

  channel.sent.length = 0
  channel.push([...sb(rfc.Cpo.NotifyModemstate), ...sb(rfc.Cpo.PurgeData, 1), ...sb(rfc.Cpo.Signature)])
  await tick()
  assert.ok(contains(channel.sent, [IAC, SB, 44, 107, 0x90, IAC, SE]), 'CTS + CD')
  assert.ok(contains(channel.sent, [IAC, SB, 44, 112, 1, IAC, SE]))
  assert.ok(contains(channel.sent, [IAC, SB, 44, 100, ...Buffer.from('Friday Work'), IAC, SE]))
})

test('会话：不支持的参数（MARK 校验）不重开、回当前值', async () => {
  const { port, channel } = await session()
  channel.push(sb(rfc.Cpo.SetParity, 4))
  await tick()
  assert.equal(port.opens.length, 1)
  assert.ok(contains(channel.sent, [IAC, SB, 44, 103, 1, IAC, SE]), '回 NONE')
})

test('会话：烧录挂起时口让出来、进来的数据攒着；恢复后按原参数重开再写', async () => {
  const { port, channel, s } = await session()
  await s.suspend()
  assert.equal(port.closes, 1)
  assert.ok(s.suspended)
  channel.push([0x55, 0x66])
  await tick()
  assert.deepEqual(port.log, [], '挂起期间一个字节都不碰串口')
  await s.resume()
  await tick()
  assert.equal(port.opens.length, 2)
  assert.equal(port.opens[1].baudRate, 115200)
  assert.deepEqual(port.log, [['write', [0x55, 0x66]]])
})

test('会话：raw 模式只搬字节；对端关通道 = 会话结束、口关掉', async () => {
  const { port, channel, s, closed } = await session('raw')
  assert.deepEqual(channel.sent, [], 'raw 不发协商')
  channel.push([IAC, 0x01])
  port.emit([IAC])
  await tick()
  assert.deepEqual(port.log, [['write', [IAC, 0x01]]])
  assert.deepEqual(channel.sent, [IAC], 'raw 不转义')
  channel.onclose()
  await tick()
  assert.ok(s.closed)
  assert.equal(port.closes, 1)
  assert.deepEqual(closed, [{ reason: '服务端关了通道', byPeer: true }])
})

// MARK: 串口命名

test('串口命名：同型号按枚举顺序配 COM 名；拿不到名字时用芯片名 + 序号', () => {
  const ports = [
    { id: 'serial:4292:60000:0', usbVendorId: 0x10c4, usbProductId: 0xea60 },
    { id: 'serial:6790:29987:0', usbVendorId: 0x1a86, usbProductId: 0x7523 },
    { id: 'serial:4292:60000:1', usbVendorId: 0x10c4, usbProductId: 0xea60 }
  ]
  const names = [
    { portName: 'COM5', vendorId: 0x10c4, productId: 0xea60 },
    { portName: 'COM3', vendorId: 0x1a86, productId: 0x7523 },
    { portName: 'COM9', vendorId: 0x10c4, productId: 0xea60 }
  ]
  const described = describePorts(ports, names)
  assert.deepEqual(described.map((d) => d.label), ['COM5 · CP210x', 'COM3 · CH340', 'COM9 · CP210x'])
  assert.ok(described.every((d) => d.espHint))
  const unnamed = describePorts(ports, [])
  assert.deepEqual(unnamed.map((d) => d.label), ['CP210x #1', 'CH340', 'CP210x #2'])
  assert.equal(bridgeFor(0x303a, 0x1001).name, 'ESP USB')
  assert.equal(bridgeFor(0x2341, 0x43).esp, false)
})

test('串口 id：同一个口对象不变；拔掉后序号放出来给下一个同型号的口', () => {
  const registry = new SerialIdRegistry()
  const a = {}
  const b = {}
  assert.equal(registry.idFor(a, 1, 2), 'serial:1:2:0')
  assert.equal(registry.idFor(b, 1, 2), 'serial:1:2:1')
  assert.equal(registry.idFor(a, 1, 2), 'serial:1:2:0')
  registry.forget(a)
  const c = {}
  assert.equal(registry.idFor(c, 1, 2), 'serial:1:2:0')
  assert.equal(registry.portFor('serial:1:2:1'), b)
})

// MARK: 参数校验

test('参数：烧录地址认数字 / 0x / 十进制，默认值齐全；坏参数回 -32602', () => {
  assert.equal(params.parseAddress('0x10000'), 0x10000)
  assert.equal(params.parseAddress('4096'), 4096)
  assert.equal(params.parseAddress(0x8000), 0x8000)
  assert.throws(() => params.parseAddress('0xZZ'), (error) => error.code === -32602)
  assert.throws(() => params.parseAddress(-1), (error) => error.code === -32602)

  const { deviceId, options } = params.parseFlash({
    deviceId: 'serial:4292:60000:0',
    files: [{ address: '0x0', data: Buffer.from([1, 2, 3]).toString('base64') }]
  })
  assert.equal(deviceId, 'serial:4292:60000:0')
  assert.deepEqual([...options.files[0].data], [1, 2, 3])
  assert.equal(options.baudRate, 460800)
  assert.equal(options.flashMode, 'keep')
  assert.equal(options.compress, true)
  assert.equal(options.after, 'hard_reset')
  assert.throws(() => params.parseFlash({ deviceId: 'serial:x', files: [] }), (error) => error.code === -32602)
  assert.throws(() => params.parseFlash({ deviceId: 'camera:x', files: [{ address: 0, data: 'AA==' }] }), (error) => error.code === -32602)
  assert.throws(
    () => params.parseFlash({ deviceId: 'serial:x', files: [{ address: 0, data: 'AA==' }], flashMode: 'turbo' }),
    (error) => error.code === -32602
  )
})

test('参数：串口默认 rfc2217 / 115200 8N1；摄像头默认 JPEG 0.85、预热 600ms', () => {
  const open = params.parseSerialOpen({ deviceId: 'serial:1:2:0' })
  assert.equal(open.mode, 'rfc2217')
  assert.deepEqual(open.config, { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' })
  assert.throws(() => params.parseSerialOpen({ deviceId: 'serial:1:2:0', parity: 'mark' }), (error) => error.code === -32602)
  assert.throws(() => params.parseSerialOpen({ deviceId: 'serial:1:2:0', baudRate: 1.5 }), (error) => error.code === -32602)

  const snap = params.parseSnapshot({})
  assert.equal(snap.deviceId, undefined)
  assert.deepEqual(snap.options, { width: undefined, height: undefined, format: 'jpeg', quality: 0.85, warmupMs: 600 })
  assert.throws(() => params.parseSnapshot({ quality: 2 }), (error) => error.code === -32602)
  assert.throws(() => params.parseSnapshot({ deviceId: 'serial:1' }), (error) => error.code === -32602)
})

// MARK: MD5

test('MD5：和 node:crypto 一致（各种长度，含补位边界和 1 MB）', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 1024 * 1024]) {
    const data = randomBytes(length)
    assert.equal(md5Hex(new Uint8Array(data)), createHash('md5').update(data).digest('hex'), `长度 ${length}`)
  }
})
