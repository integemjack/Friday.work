// 选机器人 → 发一句话 → 观察是否来了回复（含流式）
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

  await run(`(() => { document.querySelector('.schat .bot')?.click(); return true })()`)
  await sleep(400)
  console.log(
    '发送:',
    await run(`(() => {
      const area = document.querySelector('.schat .composer textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, '你好，我这边是 Friday 桌面客户端。')
      area.dispatchEvent(new Event('input', { bubbles: true }))
      return 'typed'
    })()`)
  )
  await sleep(400)
  console.log(
    '点发送:',
    await run(`(() => {
      const btn = [...document.querySelectorAll('.schat .composer button')].find((b) => b.textContent.includes('发送'))
      if (!btn || btn.disabled) return 'disabled=' + (btn?.disabled ?? 'none')
      btn.click()
      return 'clicked'
    })()`)
  )

  for (let i = 0; i < 16; i++) {
    await sleep(3000)
    const state = await run(`(() => {
      const el = document.querySelector('.schat')
      const bubbles = [...el.querySelectorAll('.msg .bubble')].map((b) => b.innerText.trim())
      return { n: bubbles.length, last: (bubbles[bubbles.length - 1] ?? '').slice(0, 120) }
    })()`)
    console.log(`+${(i + 1) * 3}s`, JSON.stringify(state))
    if (state && state.n >= 2 && !state.last.endsWith('…')) break
  }
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
