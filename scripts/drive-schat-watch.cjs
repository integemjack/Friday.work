// 点发送并观察流式回复
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
    '点发送:',
    await run(`(() => {
      const el = document.querySelector('.schat')
      const btn = [...el.querySelectorAll('.composer button')].find((b) => b.textContent.includes('发送'))
      if (!btn || btn.disabled) return '不可用'
      btn.click()
      return 'clicked'
    })()`)
  )

  let lastCount = -1
  for (let i = 0; i < 12; i++) {
    await sleep(2500)
    const state = await run(`(() => {
      const el = document.querySelector('.schat')
      const bubbles = [...el.querySelectorAll('.msg .bubble')].map((b) => b.innerText.trim())
      return { count: bubbles.length, last: bubbles[bubbles.length - 1]?.slice(0, 160), all: bubbles.map((b) => b.slice(0, 40)) }
    })()`)
    console.log(`+${(i + 1) * 2.5}s`, JSON.stringify(state))
    if (state && state.count >= 2 && state.last && !state.last.endsWith('…')) {
      // 有回复且不再带流式省略号
      if (state.count === lastCount) break
    }
    lastCount = state?.count ?? lastCount
  }
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
