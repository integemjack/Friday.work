// 打开扫码一键连窗口并读状态（验证重启后免扫码直连）
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
      pending.set(i, (r) => resolve(r?.result?.value))
      socket.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
    })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  console.log(
    '打开窗口:',
    await run(`(() => {
      const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('扫码一键连'))
      if (!entry) return 'no-entry'
      entry.click()
      return 'ok'
    })()`)
  )
  await sleep(2500)
  console.log(JSON.stringify(await run(`(() => {
    const el = document.querySelector('.schat')
    return el ? { text: el.innerText.slice(0, 260).replace(/\\n+/g, ' | ') } : null
  })()`), null, 2))
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
