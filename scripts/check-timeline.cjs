// 打开助手时间线窗口，读内容
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

  console.log(
    '打开时间线:',
    await run(`(() => {
      const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('助手时间线'))
      if (!entry) return '没有入口'
      entry.click()
      return 'clicked'
    })()`)
  )
  await sleep(3000)
  console.log(
    JSON.stringify(
      await run(`(() => {
    const el = document.querySelector('.timeline')
    if (!el) return { open: false }
    return {
      open: true,
      rows: el.querySelectorAll('.row').length,
      first: [...el.querySelectorAll('.row')].slice(0, 6).map((r) => r.innerText.replace(/\\n+/g, ' · ')),
      tip: el.querySelector('.tip')?.innerText ?? ''
    }
  })()`),
      null,
      1
    )
  )
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
