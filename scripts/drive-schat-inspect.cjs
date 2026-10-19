// 细看气泡（自己的/对方的）并长时间等 bot 回复
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

  const dump = `(() => {
    const el = document.querySelector('.schat')
    return [...el.querySelectorAll('.msg')].map((m) => ({
      mine: m.className.includes('mine'),
      text: m.innerText.trim().slice(0, 60)
    }))
  })()`

  console.log('当前气泡:', JSON.stringify(await run(dump)))
  for (let i = 0; i < 12; i++) {
    await sleep(5000)
    const bubbles = await run(dump)
    console.log(`+${(i + 1) * 5}s`, JSON.stringify(bubbles))
    if (bubbles?.some((b) => !b.mine)) {
      console.log('✓ 收到对方消息')
      break
    }
  }
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
