// 诊断：机器窗口里的结构（会话行为什么点不到）
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

  console.log(
    JSON.stringify(
      await run(`(() => {
    const w = document.querySelector('.machines')
    return {
      hasWindow: !!w,
      text: w ? w.innerText.slice(0, 400) : '(没有 .machines)',
      convRows: document.querySelectorAll('.conv-row').length,
      machineRows: document.querySelectorAll('.machine-row').length,
      state: document.body.innerText.slice(0, 200)
    }
  })()`),
      null,
      1
    )
  )
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
