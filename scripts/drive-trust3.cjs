// 重新选一遍那台机器，读终端可用性（受信后应当解锁）
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
    return {
      machine: store.currentMachineInfo?.name,
      terminalsAvailable: store.terminalsAvailable,
      reason: store.terminalsReason,
      terminalCount: store.terminals.length
    }
  })()`

  // 切到 SSH 那台，再切回来（触发重新取状态）
  await run(`(() => {
    const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('机器与会话'))
    entry?.click()
    return true
  })()`)
  await sleep(900)
  await run(`(() => {
    const row = [...document.querySelectorAll('.machine-row')].find((m) => m.innerText.includes('ubuntu'))
    row?.click()
    return true
  })()`)
  await sleep(1500)
  await run(`(() => {
    const row = [...document.querySelectorAll('.machine-row')].find((m) => m.innerText.includes('扫码连入的'))
    row?.click()
    return true
  })()`)
  await sleep(3500)
  console.log('受信后重新选中:', JSON.stringify(await run(readState)))

  // 开终端窗口，看它能不能用
  await run(`(() => {
    const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('终端'))
    entry?.click()
    return true
  })()`)
  await sleep(3000)
  console.log(
    '终端窗口:',
    JSON.stringify(
      await run(`(() => {
    const el = document.querySelector('.term-card')
    if (!el) return { open: false }
    return { notice: el.querySelector('.notice')?.innerText ?? '', tabs: [...el.querySelectorAll('.tab')].map((t) => t.innerText) }
  })()`)
    )
  )
  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
