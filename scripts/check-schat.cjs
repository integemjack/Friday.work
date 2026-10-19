// 读当前「扫码一键连」窗口状态
const WebSocket = require('ws')

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) {
    console.log('应用没在跑')
    return
  }
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
  const state = await run(`(() => {
    const el = document.querySelector('.schat')
    return { open: !!el, text: el ? el.innerText.slice(0, 220) : '(窗口没开)' }
  })()`)
  console.log(JSON.stringify(state, null, 2))
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
