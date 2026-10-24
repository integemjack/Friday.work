// 串口内容屏（桌面 HUD 的串口投屏）：makeSerialLineFeeder 的行拆分——
// 流式 UTF-8 解码（多字节字符跨段不断裂）、\r\n / \n 分行、控制字符剔除、
// 超长截断、不换行的连续输出滚屏、flush 交出最后半行。
const test = require('node:test')
const assert = require('node:assert/strict')

const { makeSerialLineFeeder, MAX_LINE } = require('../.tmp/serialfeed.cjs')

function feeder() {
  const lines = []
  const f = makeSerialLineFeeder((line) => lines.push(line))
  return { f, lines }
}

const enc = new TextEncoder()

test('serialFeed：按 \\n 分行、\\r 清掉、空行不交', () => {
  const { f, lines } = feeder()
  f.push(enc.encode('boot ok\r\n\r\nhello world\n'))
  assert.deepEqual(lines, ['boot ok', 'hello world'])
})

test('serialFeed：多字节 UTF-8 跨段不断裂', () => {
  const { f, lines } = feeder()
  const bytes = enc.encode('串口内容屏测试')
  f.push(bytes.slice(0, 5))
  f.push(bytes.slice(5))
  f.push(enc.encode('：第二行\n'))
  assert.deepEqual(lines, ['串口内容屏测试：第二行'])
})

test('serialFeed：控制字符剔除（二进制路过不出乱码行），只剩控制字符的行不交', () => {
  const { f, lines } = feeder()
  f.push(enc.encode('a\x00\x01b\x1f\n\x07\x08\n'))
  assert.deepEqual(lines, ['ab'])
})

test('serialFeed：超长行截断到 MAX_LINE 带省略号', () => {
  const { f, lines } = feeder()
  f.push(enc.encode('x'.repeat(MAX_LINE + 50) + '\n'))
  assert.equal(lines.length, 1)
  assert.ok(lines[0].length <= MAX_LINE + 1)
  assert.ok(lines[0].endsWith('…'))
})

test('serialFeed：不换行的连续输出——攒过两倍限长先交一行，屏能滚起来', () => {
  const { f, lines } = feeder()
  f.push(enc.encode('y'.repeat(MAX_LINE * 3)))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].length, MAX_LINE)
  assert.ok(!lines[0].endsWith('…')) // 半行截断不是丢弃，不加省略号
})

test('serialFeed：flush 交出没换行的最后半行（断了流的多字节尾部不丢已解码部分）', () => {
  const { f, lines } = feeder()
  f.push(enc.encode('line1\n尾部还没'))
  f.push(enc.encode('换').slice(0, 2)) // 「换」只到了 2/3 字节就断流：缺的补不回来，已解码的照常交
  f.flush()
  assert.deepEqual(lines, ['line1', '尾部还没'])
})
