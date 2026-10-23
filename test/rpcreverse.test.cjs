// 反向请求（方案-客户端设备 §3）：服务端发带 id 的请求，RpcClient 交给 onRequest 处理、按原 id 回 result / error；
// 没挂处理器回 -32601；notify 不带 id；原来的事件分发和请求配对不受影响。
const test = require('node:test')
const assert = require('node:assert/strict')

const { RpcClient, RpcError } = require('../.tmp/rpcclient.cjs')

function client() {
  const sent = []
  const rpc = new RpcClient((text) => sent.push(JSON.parse(text)), () => {})
  return { rpc, sent }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('服务端请求：交给处理器，按原 id 回 result（字符串和数字 id 都认）', async () => {
  const { rpc, sent } = client()
  const seen = []
  rpc.onRequest(async (method, params, id) => {
    seen.push({ method, params, id })
    return { devices: [] }
  })
  rpc.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 's:7', method: 'device.list', params: { a: 1 } }))
  rpc.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'device.list' }))
  await settle()
  assert.deepEqual(seen[0], { method: 'device.list', params: { a: 1 }, id: 's:7' })
  assert.deepEqual(sent, [
    { jsonrpc: '2.0', id: 's:7', result: { devices: [] } },
    { jsonrpc: '2.0', id: 42, result: { devices: [] } }
  ])
})

test('处理器抛 RpcError：错误码原样回；普通异常回 -32603；没处理器回 -32601', async () => {
  const { rpc, sent } = client()
  rpc.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'device.list' }))
  await settle()
  assert.equal(sent[0].error.code, -32601)

  rpc.onRequest(async (method) => {
    if (method === 'device.serial.open') throw new RpcError(20, '用户拒绝')
    throw new Error('炸了')
  })
  rpc.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'device.serial.open' }))
  rpc.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'device.camera.snapshot' }))
  await settle()
  assert.deepEqual(sent[1], { jsonrpc: '2.0', id: 2, error: { code: 20, message: '用户拒绝' } })
  assert.deepEqual(sent[2], { jsonrpc: '2.0', id: 3, error: { code: -32603, message: '炸了' } })
})

test('通知不带 id；事件和自己发出的请求照旧', async () => {
  const { rpc, sent } = client()
  rpc.notify('device.changed', {})
  assert.deepEqual(sent[0], { jsonrpc: '2.0', method: 'device.changed', params: {} })

  const events = []
  rpc.on('summaries', (params) => events.push(params))
  rpc.handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'summaries', params: { n: 1 } }))
  assert.deepEqual(events, [{ n: 1 }])

  const pending = rpc.request('ping', {}, 1000)
  const id = sent[1].id
  rpc.handleMessage(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }))
  assert.deepEqual(await pending, { ok: true })
})
