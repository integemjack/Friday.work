// 只发一条唯一文本，数气泡并读调试日志
const WebSocket = require('ws')
const fs = require('node:fs')

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

  const text = 'probe-' + Date.now().toString(36)
  await run(`(() => {
    const area = document.querySelector('.schat .composer textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, '${text}')
    area.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(300)
  await run(`(() => {
    const btn = [...document.querySelectorAll('.schat .composer button')].find((b) => b.textContent.includes('发送'))
    btn?.click()
    return true
  })()`)
  await sleep(2500)

  const bubbles = await run(`(() => [...document.querySelectorAll('.schat .msg')].map((m) => m.innerText.trim()))()`)
  console.log('气泡:', JSON.stringify(bubbles))
  console.log('这条出现了', bubbles.filter((b) => b.includes(text)).length, '次')

  const log = fs.readFileSync(process.env.APPDATA + '/friday-desktop-work/schat-debug.log', 'utf8').trim().split('\n')
  console.log('调试日志行数:', log.length)
  console.log('含 message 的帧:', log.filter((l) => l.includes('"e":"message"')).slice(-3))
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
