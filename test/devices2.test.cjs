// 客户端设备第二批（方案-客户端设备 §5.6–5.8）：adb 过滤、手机清单解析、隧道（真起本机 TCP）、Intel HEX、
// Arduino STK500 / STM32 串口引导烧录（假的 optiboot / 引导程序跑完整流程）、UF2 镜像校验、工具白名单与参数展开、参数校验。
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')

const { AdbGate, filterListing } = require('../.tmp/adbgate.cjs')
const { parseAdbDevices, parseUsbmuxDevices, usbmuxMessage, adbRequest, AdbTrackParser, androidKey, takeUsbmuxMessage, isUsbmuxDeviceChange } = require('../.tmp/phones.cjs')
const { Tunnels, isLocalAddress } = require('../.tmp/tunnels.cjs')
const { parseIntelHex } = require('../.tmp/intelhex.cjs')
const { flashStk500 } = require('../.tmp/stk500.cjs')
const { flashStm32 } = require('../.tmp/stm32.cjs')
const { TcpSession } = require('../.tmp/tcpsession.cjs')
const { isUf2Image, isAllowedTool, expandArgs } = require('../.tmp/devicetools.cjs')
const params = require('../.tmp/deviceparams.cjs')

const enc = (text) => new TextEncoder().encode(text)
const dec = (bytes) => new TextDecoder().decode(bytes)
const join = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p))).toString('latin1')
const adb = (text) => enc(text.length.toString(16).padStart(4, '0') + text)

// MARK: adb 过滤

test('adb：照转 version / features，tport:any 改写成授权的那台，别的序列号拒绝', () => {
  const gate = new AdbGate('R5CT')
  let out = gate.fromClient(adb('host:version'))
  assert.equal(join(out.toServer), '000chost:version')
  assert.equal(out.close, false)

  const g2 = new AdbGate('R5CT')
  out = g2.fromClient(adb('host:tport:any'))
  assert.equal(join(out.toServer), join([adb('host:tport:serial:R5CT')]))

  const g3 = new AdbGate('R5CT')
  out = g3.fromClient(adb('host:transport:OTHER'))
  assert.equal(out.toServer.length, 0)
  assert.ok(out.close)
  assert.ok(join(out.toClient).startsWith('FAIL'))
})

test('adb：kill / connect / pair 一律拒绝（不让服务端关掉客户端的 adb server）', () => {
  for (const request of ['host:kill', 'host:connect:1.2.3.4:5555', 'host:pair:1.2.3.4:1 123456', 'host-serial:R5CT:kill', 'host:reconnect']) {
    const out = new AdbGate('R5CT').fromClient(adb(request))
    assert.ok(out.close, request)
    assert.equal(out.toServer.length, 0, request)
  }
  // host-usb: 落到这一台
  const out = new AdbGate('R5CT').fromClient(adb('host-usb:get-state'))
  assert.equal(join(out.toServer), join([adb('host-serial:R5CT:get-state')]))
})

test('adb：devices 的回复只留这一台；跨包也能拆', () => {
  const gate = new AdbGate('R5CT')
  gate.fromClient(adb('host:devices-l'))
  const listing = 'R5CT\tdevice usb:1-1 model:Pixel_8\nEMU1\tdevice product:sdk\n'
  const reply = Buffer.concat([Buffer.from('OKAY'), Buffer.from(adb(listing))])
  const pieces = [reply.subarray(0, 3), reply.subarray(3, 10), reply.subarray(10)]
  const got = pieces.flatMap((piece) => gate.fromServer(new Uint8Array(piece)).toClient)
  const text = join(got)
  assert.ok(text.startsWith('OKAY'))
  const body = text.slice(8)
  assert.equal(body, 'R5CT\tdevice usb:1-1 model:Pixel_8\n')
  assert.equal(parseInt(text.slice(4, 8), 16), body.length)
  assert.equal(filterListing('A\tdevice\nB\tdevice\n', 'B'), 'B\tdevice\n')
})

test('adb：transport 回 OKAY 之后（tport 带 8 字节 id）全部照转，不再拆', () => {
  const gate = new AdbGate('R5CT')
  gate.fromClient(adb('host:tport:serial:R5CT'))
  const okay = Buffer.concat([Buffer.from('OKAY'), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])])
  assert.equal(join(gate.fromServer(new Uint8Array(okay.subarray(0, 6))).toClient), '')
  assert.equal(join(gate.fromServer(new Uint8Array(okay.subarray(6))).toClient).length, 12)
  // 之后的 shell: 请求是给手机的：照转
  const shell = gate.fromClient(adb('shell:ls'))
  assert.equal(join(shell.toServer), '0008shell:ls')
  assert.equal(join(gate.fromServer(enc('anything')).toClient), 'anything')
})

// MARK: 手机清单、地址

test('手机：adb devices-l 解析出型号、状态；usbmux 的 ListDevices 解析出 UDID；请求编码', () => {
  const phones = parseAdbDevices('R5CT                   device usb:1-1 product:shiba model:Pixel_8 device:shiba transport_id:3\nXYZ unauthorized usb:2-1 transport_id:4\n')
  assert.equal(phones.length, 2)
  assert.equal(phones[0].id, 'android:R5CT')
  assert.match(phones[0].label, /^Pixel 8（R5CT）$/)
  assert.equal(phones[1].state, 'unauthorized')
  assert.match(phones[1].label, /没点允许调试/)

  const plist = '<plist><dict><key>DeviceList</key><array><dict><key>DeviceID</key><integer>3</integer><key>Properties</key><dict>' +
    '<key>ConnectionType</key><string>USB</string><key>SerialNumber</key><string>00008110-001A2B3C4D5E6F7A</string></dict></dict></array></dict></plist>'
  const ios = parseUsbmuxDevices(plist)
  assert.deepEqual(ios.map((d) => d.id), ['ios:00008110-001A2B3C4D5E6F7A'])
  const message = Buffer.from(usbmuxMessage('ListDevices'))
  assert.equal(message.readUInt32LE(0), message.length)
  assert.equal(message.readUInt32LE(8), 8)
  assert.match(message.subarray(16).toString(), /<string>ListDevices<\/string>/)
  assert.equal(Buffer.from(adbRequest('host:devices-l')).toString(), '000ehost:devices-l')
})

// MARK: 手机变更监听（device.changed 的手机来源：adb track / usbmuxd Listen）

test('手机监听：adb track 流每帧都交出（含基线），跨包、半帧、坏流都对', () => {
  const frame = (text) => Buffer.from(text.length.toString(16).padStart(4, '0') + text, 'latin1')
  const a = 'R5CT device usb:1-1 model:Pixel_8 transport_id:3\n'
  const b = 'R5CT device usb:1-1 model:Pixel_8 transport_id:3\nXYZ unauthorized usb:2-1 transport_id:4\n'
  // OKAY 和第一帧分三段喂（含半帧）：拼齐后基线帧完整交出
  const parser = new AdbTrackParser()
  assert.deepEqual(parser.feed(Buffer.from('OK', 'latin1')), [])
  assert.deepEqual(parser.feed(Buffer.concat([Buffer.from('AY', 'latin1'), frame(a).subarray(0, 5)])), [])
  assert.deepEqual(parser.feed(frame(a).subarray(5)), [a])
  // 一包里连着几帧也都交出
  const batch = new AdbTrackParser()
  batch.feed(Buffer.from('OKAY', 'latin1'))
  assert.deepEqual(batch.feed(Buffer.concat([frame(a), frame(a), frame(b)])), [a, a, b])
  // 不是 OKAY 开头 = 协议不对，置 failed
  const bad = new AdbTrackParser()
  bad.feed(Buffer.from('FAIL001fserver is broken     ', 'latin1'))
  assert.equal(bad.failed, true)
})

test('手机监听：清单比对键——空基线对着 adb 后启动带来的手机算变化，同清单重推、仅状态变化都分辨得出', () => {
  const a = 'R5CT device usb:1-1 model:Pixel_8 transport_id:3\n'
  const b = 'R5CT device usb:1-1 model:Pixel_8 transport_id:3\nXYZ unauthorized usb:2-1 transport_id:4\n'
  const keyA = androidKey(parseAdbDevices(a))
  assert.equal(androidKey(parseAdbDevices('')), '', '空清单的键是空串（watcher 启动时 adb 没跑）')
  assert.notEqual(keyA, '', 'adb 后启动、基线带着手机：键变了，算变化')
  assert.equal(keyA, androidKey(parseAdbDevices(a)), '同一清单重推（重连基线）键不变，不触发')
  assert.notEqual(keyA, androidKey(parseAdbDevices(b)), '多了一台手机算变化')
  assert.notEqual(keyA, androidKey(parseAdbDevices('R5CT unauthorized usb:1-1 transport_id:3\n')), '授权状态变化也算变化')
})

test('手机监听：usbmux 消息要完整一条才切出来，Attached / Detached 算变化、Listen 回执不算', () => {
  const message = (inner) => {
    const body = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${inner}</dict></plist>\n`)
    const head = Buffer.alloc(16)
    head.writeUInt32LE(16 + body.length, 0)
    head.writeUInt32LE(8, 8)
    head.writeUInt32LE(1, 12)
    return Buffer.concat([head, body])
  }
  const result = message('<key>MessageType</key><string>Result</string><key>Result</key><string>Success</string>')
  const attached = message('<key>MessageType</key><string>Attached</string><key>DeviceID</key><integer>7</integer>')
  assert.equal(takeUsbmuxMessage(result.subarray(0, 20)), null, '半条不算')
  const cut = takeUsbmuxMessage(Buffer.concat([result, attached]))
  assert.ok(cut)
  assert.equal(isUsbmuxDeviceChange(cut.body), false, 'Listen 的 Result 回执不算')
  assert.equal(cut.rest.length, attached.length, '剩下的正好是下一条')
  assert.equal(isUsbmuxDeviceChange(cut.rest.subarray(16).toString()), true, 'Attached 算变化')
  assert.equal(isUsbmuxDeviceChange('<plist><dict><key>MessageType</key><string>Detached</string></dict></plist>'), true)
})

test('隧道：只放行本机 / 局域网地址', () => {
  for (const ok of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.50', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::5', '::ffff:192.168.0.2']) {
    assert.ok(isLocalAddress(ok), ok)
  }
  for (const bad of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2001:4860::8888', '100.128.0.1']) assert.ok(!isLocalAddress(bad), bad)
})

test('隧道：真连本机的 TCP 回显，两个方向都通；公网地址拒绝；关了通知', async () => {
  const server = net.createServer((socket) => socket.on('data', (chunk) => socket.write(Buffer.from(chunk.toString().toUpperCase()))))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const posted = []
  const tunnels = new Tunnels((message) => posted.push(message))
  await assert.rejects(tunnels.open('x', { kind: 'tcp', host: '8.8.8.8', port: 53 }), /不是本机或局域网地址/)
  await tunnels.open('t1', { kind: 'tcp', host: '127.0.0.1', port })
  tunnels.handle({ type: 'tunnel.data', id: 't1', data: enc('ping').buffer })
  const deadline = Date.now() + 5000
  while (!posted.some((m) => m.type === 'tunnel.data') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  const data = posted.find((m) => m.type === 'tunnel.data')
  assert.equal(dec(new Uint8Array(data.data)), 'PING')
  tunnels.handle({ type: 'tunnel.close', id: 't1' })
  assert.ok(posted.some((m) => m.type === 'tunnel.closed' && m.id === 't1'))
  server.close()
})

test('隧道会话：通道 ⇆ 端口消息；通道积压时叫 socket 暂停，发完恢复；服务端关通道 = 关 socket', () => {
  const posted = []
  const channel = {
    readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0, onmessage: null, onclose: null, onbufferedamountlow: null,
    sent: [], send(data) { this.sent.push(data) }, close() { this.readyState = 'closed' }
  }
  const closed = []
  const session = new TcpSession('t1', channel, (m) => posted.push(m), { onClosed: (reason, byPeer) => closed.push({ reason, byPeer }) })
  session.start()
  channel.onmessage({ data: enc('hi').buffer })
  assert.deepEqual(posted.map((m) => m.type), ['tunnel.data'])
  channel.bufferedAmount = 2 * 1024 * 1024
  session.fromSocket({ type: 'tunnel.data', id: 't1', data: enc('big').buffer })
  assert.equal(channel.sent.length, 1)
  assert.equal(posted.at(-1).type, 'tunnel.pause')
  channel.bufferedAmount = 0
  channel.onbufferedamountlow()
  assert.equal(posted.at(-1).type, 'tunnel.resume')
  channel.onclose()
  assert.equal(posted.at(-1).type, 'tunnel.close')
  assert.deepEqual(closed, [{ reason: '服务端关了通道', byPeer: true }])
})

// MARK: Intel HEX

test('Intel HEX：数据 + 扩展线性地址，空洞填 0xFF，校验和不对报错', () => {
  const hex = [':020000040800F2', ':0400000001020304F2', ':04000800AABBCCDDE6', ':00000001FF'].join('\n')
  const image = parseIntelHex(hex)
  assert.equal(image.base, 0x08000000)
  assert.deepEqual([...image.data], [1, 2, 3, 4, 0xff, 0xff, 0xff, 0xff, 0xaa, 0xbb, 0xcc, 0xdd])
  assert.throws(() => parseIntelHex(':0400000001020304F3'), /校验和/)
  assert.throws(() => parseIntelHex('hello'), /格式不对/)
})

// MARK: 假设备上的烧录

/** 一块假的串口：写进来的字节交给 device(bytes) → 返回要回的字节 */
function emulatedPort(device) {
  const port = {
    signals: [],
    opened: null,
    readable: null,
    writable: null,
    async open(options) {
      this.opened = options
      const self = this
      this.readable = new ReadableStream({ start: (controller) => (self.controller = controller) })
      this.writable = new WritableStream({
        write: (chunk) => {
          const reply = device.feed([...chunk])
          if (reply.length) self.controller.enqueue(Uint8Array.from(reply))
        }
      })
    },
    async close() { this.readable = null; this.writable = null },
    async setSignals(signals) { this.signals.push(signals) },
    async getSignals() { return {} }
  }
  return port
}

/** 假的 optiboot（ATmega328P）：第一次 GET_SYNC 不理（测重试） */
function optiboot() {
  const flash = new Uint8Array(32 * 1024).fill(0xff)
  let inbox = []
  let address = 0
  let ignoredFirstSync = false
  const ok = [0x14, 0x10]
  return {
    flash,
    feed(bytes) {
      inbox.push(...bytes)
      const out = []
      for (;;) {
        if (inbox.length === 0) break
        const cmd = inbox[0]
        const need = { 0x30: 2, 0x75: 2, 0x50: 2, 0x51: 2, 0x55: 4, 0x74: 5 }[cmd] ?? (cmd === 0x64 && inbox.length >= 3 ? 5 + ((inbox[1] << 8) | inbox[2]) : Infinity)
        if (inbox.length < need) break
        const message = inbox.splice(0, need)
        if (cmd === 0x30) {
          if (!ignoredFirstSync) { ignoredFirstSync = true; continue }
          out.push(...ok)
        } else if (cmd === 0x75) out.push(0x14, 0x1e, 0x95, 0x0f, 0x10)
        else if (cmd === 0x55) { address = (message[1] | (message[2] << 8)) * 2; out.push(...ok) }
        else if (cmd === 0x64) { flash.set(message.slice(4, -1), address); out.push(...ok) }
        else if (cmd === 0x74) { const size = (message[1] << 8) | message[2]; out.push(0x14, ...flash.slice(address, address + size), 0x10) }
        else out.push(...ok)
      }
      return out
    }
  }
}

test('Arduino STK500：复位（DTR/RTS 低→高）、握手重试、按页写、读回核对、认出 ATmega328P', async () => {
  const device = optiboot()
  const port = emulatedPort(device)
  const image = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff)
  const progress = []
  const result = await flashStk500(port, image, { baudRate: 115200, pageSize: 128, address: 0 }, (w, t) => progress.push([w, t]))
  assert.equal(result.chip, 'ATmega328P')
  assert.equal(result.pages, 3)
  assert.deepEqual([...device.flash.subarray(0, 300)], [...image])
  assert.deepEqual(port.signals[0], { dataTerminalReady: false, requestToSend: false })
  assert.deepEqual(port.signals[1], { dataTerminalReady: true, requestToSend: true })
  assert.deepEqual(progress.at(-1), [600, 600])
  assert.equal(port.opened.baudRate, 115200)
})

/** 假的 STM32 引导程序（F103，支持扩展擦除） */
function stm32Bootloader() {
  const flash = new Map()
  let inbox = []
  let state = 'idle'
  let address = 0
  let went = null
  const ACK = 0x79
  const xor = (list) => list.reduce((a, b) => a ^ b, 0)
  return {
    flash, get went() { return went },
    feed(bytes) {
      inbox.push(...bytes)
      const out = []
      for (;;) {
        if (state === 'idle') {
          if (inbox[0] === 0x7f) { inbox.shift(); out.push(ACK); continue }
          if (inbox.length < 2) break
          const [cmd, check] = inbox.splice(0, 2)
          assert.equal(cmd ^ check, 0xff)
          if (cmd === 0x00) out.push(ACK, 7, 0x31, 0x00, 0x01, 0x02, 0x11, 0x21, 0x31, 0x44, ACK)
          else if (cmd === 0x02) out.push(ACK, 1, 0x04, 0x10, ACK)
          else if (cmd === 0x44) { out.push(ACK); state = 'erase' }
          else if (cmd === 0x31) { out.push(ACK); state = 'writeAddr' }
          else if (cmd === 0x11) { out.push(ACK); state = 'readAddr' }
          else if (cmd === 0x21) { out.push(ACK); state = 'goAddr' }
          continue
        }
        if (state === 'erase') {
          if (inbox.length < 3) break
          inbox.splice(0, 3); flash.clear(); out.push(ACK); state = 'idle'; continue
        }
        if (state === 'writeAddr' || state === 'readAddr' || state === 'goAddr') {
          if (inbox.length < 5) break
          const a = inbox.splice(0, 5)
          assert.equal(xor(a.slice(0, 4)), a[4])
          address = ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0
          out.push(ACK)
          if (state === 'goAddr') { went = address; state = 'idle' } else state = state === 'writeAddr' ? 'writeData' : 'readLen'
          continue
        }
        if (state === 'writeData') {
          if (inbox.length < 1 || inbox.length < inbox[0] + 3) break
          const n = inbox[0] + 1
          const block = inbox.splice(0, n + 2)
          assert.equal(xor(block.slice(0, n + 1)), block[n + 1])
          block.slice(1, n + 1).forEach((byte, i) => flash.set(address + i, byte))
          out.push(ACK); state = 'idle'; continue
        }
        if (state === 'readLen') {
          if (inbox.length < 2) break
          const [n, check] = inbox.splice(0, 2)
          assert.equal(n ^ check, 0xff)
          out.push(ACK)
          for (let i = 0; i <= n; i++) out.push(flash.get(address + i) ?? 0xff)
          state = 'idle'; continue
        }
        break
      }
      return out
    }
  }
}

test('STM32 串口引导：8E1、握手、GET / GET ID、扩展擦除、写 + 读回核对、GO 到 0x08000000', async () => {
  const device = stm32Bootloader()
  const port = emulatedPort(device)
  const image = Uint8Array.from({ length: 600 }, (_, i) => (i * 13) & 0xff)
  const result = await flashStm32(port, image, { baudRate: 57600, address: 0x08000000, reset: 'none' }, () => {})
  assert.equal(port.opened.parity, 'even')
  assert.equal(result.productId, '0x410')
  assert.match(result.chip, /F10xxx 中密度/)
  assert.equal(result.bootloader, '3.1')
  for (let i = 0; i < image.length; i++) assert.equal(device.flash.get(0x08000000 + i), image[i])
  assert.equal(device.went, 0x08000000)
})

// MARK: UF2、工具、参数

test('UF2：只认每 512 字节一块、魔数都对的镜像', () => {
  const block = new Uint8Array(512)
  const view = new DataView(block.buffer)
  view.setUint32(0, 0x0a324655, true)
  view.setUint32(4, 0x9e5d5157, true)
  view.setUint32(508, 0x0ab16f30, true)
  assert.ok(isUf2Image(block))
  const two = new Uint8Array(1024)
  two.set(block, 0)
  two.set(block, 512)
  assert.ok(isUf2Image(two))
  assert.ok(!isUf2Image(new Uint8Array(512)))
  assert.ok(!isUf2Image(block.subarray(0, 500)))
})

test('工具：白名单（大小写、.exe 都认）、{file:名字} / {dir} 展开、不认识的文件名报错', () => {
  assert.ok(isAllowedTool('avrdude'))
  assert.ok(isAllowedTool('OpenOCD.exe'))
  assert.ok(isAllowedTool('JLinkExe'))
  assert.ok(!isAllowedTool('cmd'))
  assert.ok(!isAllowedTool('powershell'))
  assert.ok(!isAllowedTool('arduino-cli'))
  const sep = require('node:path').sep
  const expanded = expandArgs(['-U', 'flash:w:{file:fw.hex}:i', '-C', '{dir}'], 'D', ['fw.hex'])
  assert.deepEqual(expanded, ['-U', `flash:w:D${sep}fw.hex:i`, '-C', 'D'])
  assert.throws(() => expandArgs(['{file:other.bin}'], 'D', ['fw.hex']), /没有对应的文件/)
})

test('参数：隧道目标、别的烧录（hex 展开、缺省地址）、工具运行', () => {
  assert.deepEqual(params.parseTcpOpen({ host: '192.168.1.50', port: 22 }), { kind: 'tcp', host: '192.168.1.50', port: 22 })
  assert.deepEqual(params.parseTcpOpen({ service: 'adb', deviceId: 'android:R5CT' }), { kind: 'adb', deviceId: 'android:R5CT' })
  assert.deepEqual(params.parseTcpOpen({ service: 'usbmux' }), { kind: 'usbmux' })
  assert.throws(() => params.parseTcpOpen({ host: 'a b', port: 22 }), (e) => e.code === -32602)
  assert.throws(() => params.parseTcpOpen({ host: 'x', port: 70000 }), (e) => e.code === -32602)
  assert.throws(() => params.parseTcpOpen({ service: 'ssh' }), (e) => e.code === -32602)

  const hex = Buffer.from([':020000040800F2', ':0400000001020304F2', ':00000001FF'].join('\n')).toString('base64')
  const stm = params.parseOtherFlash({ deviceId: 'serial:1:2:0', method: 'stm32', data: hex, format: 'hex' }, parseIntelHex)
  assert.equal(stm.address, 0x08000000)
  assert.deepEqual([...stm.data], [1, 2, 3, 4])
  assert.equal(stm.baudRate, 57600)
  const avr = params.parseOtherFlash({ deviceId: 'serial:1:2:0', method: 'stk500', data: 'AQID' }, parseIntelHex)
  assert.equal(avr.address, 0)
  assert.equal(avr.baudRate, 115200)
  assert.throws(() => params.parseOtherFlash({ deviceId: 'serial:1', method: 'uf2', data: 'AQID' }, parseIntelHex), (e) => e.code === -32602)

  const run = params.parseToolRun({ tool: 'avrdude', args: ['-p', 'm328p'], files: [{ name: 'fw.hex', data: 'AQID' }] })
  assert.equal(run.background, false)
  assert.equal(run.timeoutMs, 300000)
  assert.deepEqual([...new Uint8Array(run.files[0].data)], [1, 2, 3])
  assert.throws(() => params.parseToolRun({ tool: 'rm -rf' }), (e) => e.code === -32602)
  assert.throws(() => params.parseToolRun({ tool: 'x', args: [1] }), (e) => e.code === -32602)
  assert.equal(params.progressToken({ progressToken: 'job-3' }), 'job-3')
})
