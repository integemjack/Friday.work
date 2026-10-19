// 点接听，观察是否接通并收到声音
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
    '点接听:',
    await run(`(() => {
      const btn = [...document.querySelectorAll('.call .round')].find((b) => b.textContent.includes('接听'))
      if (!btn) return '没有接听按钮'
      btn.click()
      return 'clicked'
    })()`)
  )

  const dump = `(() => {
    const el = document.querySelector('.call')
    return el ? { text: el.innerText.replace(/\\n+/g, ' | ').slice(0, 260) } : { gone: true }
  })()`

  for (let i = 1; i <= 9; i++) {
    await sleep(4000)
    console.log(`+${i * 4}s`, JSON.stringify(await run(dump)))
  }

  console.log(
    '挂断:',
    await run(`(() => {
      const btn = [...document.querySelectorAll('.call .round')].find((b) => b.textContent.includes('挂断'))
      if (!btn || btn.disabled) return '按钮不可用'
      btn.click()
      return 'clicked'
    })()`)
  )
  await sleep(1500)
  console.log('挂断后:', JSON.stringify(await run(dump)))
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
