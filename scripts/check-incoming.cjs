// 看来电状态（通话窗口）
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

  const dump = `(() => {
    const el = document.querySelector('.call')
    return el
      ? { open: true, text: el.innerText.replace(/\\n+/g, ' | ').slice(0, 240),
          buttons: [...el.querySelectorAll('.round')].map((b) => b.textContent.trim().replace(/\\s+/g, ' ')) }
      : { open: false, titles: [...document.querySelectorAll('.win-title')].map((n) => n.textContent) }
  })()`

  for (let i = 1; i <= 6; i++) {
    console.log(`+${i * 3}s`, JSON.stringify(await run(dump)))
    await new Promise((r) => setTimeout(r, 3000))
  }
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
