// SChat 断线自动重连（bug：断线重连后视频通话不回来）：
//   意外断线 → 退避重连（hello 重拨）；用户退出 / 被踢（auth_expired）→ 不重连；连不上 → 自动重试。
// mock 一个 chatserver：HTTP 全 404（refresh/friends 失败可吞），WS 升级后回 hello 的 ack。

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { WebSocketServer } = require('ws')

const { SchatService } = require('../.tmp/schatservice.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假 chatserver：httpRequests 数所有 HTTP 请求（每次 connectWs 前的 refresh 一次）；
 *  mode 'ws' 处理 WS 升级并应答 hello；mode 'no-ws' 不挂 WS（连接必失败） */
function startServer(mode = 'ws') {
  let httpRequests = 0
  let hellos = 0
  const server = http.createServer((req, res) => {
    httpRequests += 1
    res.statusCode = 404
    res.end('{}')
  })
  let wss = null
  if (mode === 'ws') {
    wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on('message', (raw) => {
          const frame = JSON.parse(raw.toString())
          if (frame.e === 'hello' && frame.t === 'req') {
            hellos += 1
            ws.send(JSON.stringify({ e: 'hello', a: frame.a, t: 'ack', d: { success: true, id: 42 } }))
          }
        })
      })
    })
  }
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        hellos: () => hellos,
        httpRequests: () => httpRequests,
        dropAll() {
          for (const client of wss.clients) client.terminate()
        },
        sendAll(text) {
          for (const client of wss.clients) client.send(text)
        },
        close() {
          wss?.close()
          server.close()
        }
      })
    )
  })
}

/** 内存凭据后端：预置一份已登录会话（load 一读就有，静默恢复） */
function memoryBackend(server) {
  const stored = JSON.stringify({
    server,
    userId: 42,
    token: 'token-1',
    refreshToken: 'refresh-1',
    fingerprint: '',
    deviceId: 'dev-1',
    deviceName: '测试机'
  })
  return {
    load: async () => stored,
    store: async () => {},
    delete: async () => {}
  }
}

async function waitFor(predicate, timeoutMs = 6000, what = '条件') {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(100)
  }
  throw new Error(`等超时：${what}`)
}

test('意外断线：退避后自动重连（hello 重拨），恢复在线时 onOnline 通知宿主', async () => {
  const server = await startServer('ws')
  let onOnlineCount = 0
  const states = []
  try {
    const schat = new SchatService(memoryBackend(server.base), {
      onChange: (state) => states.push(state),
      onCallSignal: () => {},
      onOnline: () => {
        onOnlineCount += 1
      }
    })
    await schat.load()
    await waitFor(() => states.some((s) => s.phase === 'online'), 6000, '首次上线')
    assert.equal(server.hellos(), 1)

    // 服务端把连接掐了：客户端进 offline，安排 1 秒后的重连
    server.dropAll()
    await waitFor(() => states.some((s) => s.phase === 'idle'), 3000, '断线转 idle')
    await waitFor(() => server.hellos() >= 2, 6000, '重连重新 hello')
    await waitFor(() => states.filter((s) => s.phase === 'online').length >= 2, 6000, '第二次上线')
    assert.ok(onOnlineCount >= 1, 'onOnline 至少通知一次')
    schat.disconnect()
  } finally {
    server.close()
  }
})

test('用户退出登录（disconnect）：不再自动重连', async () => {
  const server = await startServer('ws')
  const states = []
  try {
    const schat = new SchatService(memoryBackend(server.base), {
      onChange: (state) => states.push(state),
      onCallSignal: () => {}
    })
    await schat.load()
    await waitFor(() => states.some((s) => s.phase === 'online'), 6000, '首次上线')
    schat.disconnect()
    // 退出后再掐线（复刻真实：close 由 disconnect 自己发），退避窗口内确认没有重拨
    await sleep(1600)
    assert.equal(server.hellos(), 1)
  } finally {
    server.close()
  }
})

test('被踢（auth_expired）：不自动重连（防失效 token 降级成 guest）', async () => {
  const server = await startServer('ws')
  const states = []
  try {
    const schat = new SchatService(memoryBackend(server.base), {
      onChange: (state) => states.push(state),
      onCallSignal: () => {}
    })
    await schat.load()
    await waitFor(() => states.some((s) => s.phase === 'online'), 6000, '首次上线')
    // 服务端下发凭据作废 + 掐线
    server.sendAll(JSON.stringify({ e: 'auth_expired', d: { reason: 'revoked' } }))
    server.dropAll()
    await waitFor(() => states.some((s) => s.phase === 'error'), 3000, '转 error（凭据失效）')
    await sleep(1600)
    assert.equal(server.hellos(), 1)
    schat.disconnect()
  } finally {
    server.close()
  }
})

test('连不上（WS 升级被拒）：自动重试，不死在 error 态', async () => {
  const server = await startServer('no-ws')
  const states = []
  try {
    const schat = new SchatService(memoryBackend(server.base), {
      onChange: (state) => states.push(state),
      onCallSignal: () => {}
    })
    await schat.load()
    await waitFor(() => states.some((s) => s.phase === 'error'), 6000, '首次连接失败')
    // 首次失败后 1 秒退避重试：HTTP 请求（每次 connectWs 前的 refresh）应明显增多
    await sleep(1400)
    assert.ok(server.httpRequests() >= 2, `应有重试（HTTP 请求 ${server.httpRequests()} 次 ≥ 2）`)
    schat.disconnect()
  } finally {
    server.close()
  }
})
