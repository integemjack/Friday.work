// 调试：看输入框与发送按钮的真实状态
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

  console.log(await run(`(() => {
    const wins = document.querySelectorAll('.schat')
    const el = wins[wins.length - 1]
    const area = el?.querySelector('.composer textarea')
    const btn = [...(el?.querySelectorAll('.composer button') ?? [])].find((b) => b.textContent.includes('发送'))
    const bots = [...(el?.querySelectorAll('.bot') ?? [])].map((b) => ({ text: b.innerText.replace(/\\n/g, '|'), active: b.className }))
    if (area) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, '你好')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return { wins: wins.length, areaValue: area?.value, disabled: btn?.disabled, bots }
  })()`))

  await new Promise((r) => setTimeout(r, 500))
  console.log(
    await run(`(() => {
      const wins = document.querySelectorAll('.schat')
      const el = wins[wins.length - 1]
      const btn = [...(el?.querySelectorAll('.composer button') ?? [])].find((b) => b.textContent.includes('发送'))
      return { disabledAfterInput: btn?.disabled }
    })()`)
  )
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
