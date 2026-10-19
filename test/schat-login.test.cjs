// 扫码登录客户端流程（mock chatserver）：建会话 → 轮询 → 扫描 → 批准 → 领到凭据 → 404 失效。
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { createQrSession, pollQrSession } = require('../.tmp/login.cjs')

/** 起一个假 chatserver：按 mode 决定 poll 行为 */
function startServer(mode) {
  let polls = 0
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/login-sessions') {
        if (!body.deviceId) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'bad_request' }))
          return
        }
        res.end(JSON.stringify({ success: true, token: 'TOK123', expiresAt: Date.now() + 300000, intervalMs: 10 }))
        return
      }
      if (req.url === '/login-sessions/poll') {
        if (body.token !== 'TOK123' || !body.deviceId) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'invalid_or_expired' }))
          return
        }
        polls += 1
        if (mode === 'expired') {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'invalid_or_expired' }))
          return
        }
        if (mode === 'scanned-first' && polls === 1) {
          res.end(JSON.stringify({ success: true, status: 'scanned' }))
          return
        }
        if (polls < 2) {
          res.end(JSON.stringify({ success: true, status: 'pending' }))
          return
        }
        res.end(
          JSON.stringify({
            success: true,
            status: 'approved',
            userId: 42,
            token: 'legacy-token',
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresIn: 3600
          })
        )
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

test('建会话：拿到 token 与 SCSH:1:login 载荷', async () => {
  const server = await startServer('pending')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const session = await createQrSession(base, { deviceId: 'dev-1', deviceName: '测试机' })
    assert.equal(session.token, 'TOK123')
    assert.equal(session.payload, 'SCSH:1:login:TOK123')
    assert.equal(session.deviceId, 'dev-1')
  } finally {
    server.close()
  }
})

test('轮询：pending → 批准，一次拿到凭据', async () => {
  const server = await startServer('pending')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const session = await createQrSession(base, { deviceId: 'dev-2', deviceName: '测试机' })
    const statuses = []
    let received = null
    const hooks = {
      onStatus: (s) => statuses.push(s),
      onSession: (s) => {
        received = s
      },
      onError: (m) => {
        throw new Error(m)
      }
    }
    assert.equal(await pollQrSession(base, session, hooks), 'pending')
    assert.equal(await pollQrSession(base, session, hooks), 'approved')
    assert.equal(received.userId, 42)
    assert.equal(received.token, 'legacy-token')
    assert.equal(received.refreshToken, 'refresh-token')
    assert.deepEqual(statuses, ['pending', 'approved'])
  } finally {
    server.close()
  }
})

test('轮询：已扫描状态能识别', async () => {
  const server = await startServer('scanned-first')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const session = await createQrSession(base, { deviceId: 'dev-3', deviceName: '测试机' })
    const hooks = { onStatus() {}, onSession() {}, onError() {} }
    assert.equal(await pollQrSession(base, session, hooks), 'scanned')
  } finally {
    server.close()
  }
})

test('轮询：404 = 码失效（过期/已被使用）', async () => {
  const server = await startServer('expired')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const session = await createQrSession(base, { deviceId: 'dev-4', deviceName: '测试机' })
    const hooks = { onStatus() {}, onSession() {}, onError() {} }
    assert.equal(await pollQrSession(base, session, hooks), 'expired')
  } finally {
    server.close()
  }
})
