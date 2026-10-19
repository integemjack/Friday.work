// 断开再连那台 WS 机器，看终端是否解锁（受信后）
const WebSocket = require('ws')

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const page = list.find((t) => t.type === 'page')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  await new Promise((r) => socket.on('open', r))
  socket.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result)
      pending.delete(m.id)
    }
  })
  const run = (expr) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, (r) => resolve(r?.result?.value ?? r?.result))
      socket.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
    })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const readState = `(() => {
    const app = document.querySelector('#app').__vue_app__
    let pinia = null
    for (const key of Reflect.ownKeys(app._context.provides)) {
      const value = app._context.provides[key]
      if (value && typeof value === 'object' && value._s instanceof Map) { pinia = value; break }
    }
    const store = pinia._s.get('app')
    return { machine: store.currentMachineInfo?.name, state: store.currentMachineInfo?.state, terminalsAvailable: store.terminalsAvailable, reason: store.terminalsReason }
  })()`

  await run(`(() => {
    const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('机器与会话'))
    entry?.click()
    return true
  })()`)
  await sleep(900)

  console.log(
    '点断开:',
    await run(`(() => {
      const row = [...document.querySelectorAll('.machine-row')].find((m) => m.innerText.includes('扫码连入的'))
      row?.click()
      return true
    })()`)
  )
  await sleep(800)
  console.log(
    '断开按钮:',
    await run(`(() => {
      const btn = [...document.querySelectorAll('.machine-actions button')].find((b) => b.innerText.trim() === '断开')
      if (!btn) return '没有断开按钮：' + [...document.querySelectorAll('.machine-actions button')].map((b) => b.innerText).join(',')
      btn.click()
      return 'clicked'
    })()`)
  )
  await sleep(2500)
  console.log(
    '再连:',
    await run(`(() => {
      const btn = [...document.querySelectorAll('.machine-actions button')].find((b) => b.innerText.includes('连接'))
      if (!btn) return '没有连接按钮'
      btn.click()
      return 'clicked'
    })()`)
  )
  await sleep(6000)
  console.log('重连后:', JSON.stringify(await run(readState)))
  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
