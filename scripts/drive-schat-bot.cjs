// 给指定的机器人发一句话，并等它的回复（含流式增量）
const WebSocket = require('ws')

const target = process.argv[2] ?? 'Linux 239'
const text = process.argv[3] ?? '你好，我这边是 Friday 桌面客户端（Electron）。请回一句简短的话。'

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
    '选机器人:',
    await run(`(() => {
      const bots = [...document.querySelectorAll('.schat .bot')]
      const hit = bots.find((b) => b.innerText.includes(${JSON.stringify(target)}))
      if (!hit) return '没找到 ' + ${JSON.stringify(target)} + '，有：' + bots.map((b) => b.innerText.replace(/\\n/g, ' ')).join(' / ')
      hit.click()
      return hit.innerText.replace(/\\n/g, ' ')
    })()`)
  )
  await sleep(600)

  console.log(
    '填内容:',
    await run(`(() => {
      const area = document.querySelector('.schat .composer textarea')
      if (!area) return '没有输入框'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, ${JSON.stringify(text)})
      area.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)
  )
  await sleep(400)
  console.log(
    '发送:',
    await run(`(() => {
      const btn = [...document.querySelectorAll('.schat .composer button')].find((b) => b.textContent.includes('发送'))
      if (!btn || btn.disabled) return '按钮不可用'
      btn.click()
      return 'clicked'
    })()`)
  )

  const dump = `(() => {
    const el = document.querySelector('.schat')
    return [...el.querySelectorAll('.msg')].map((m) => ({
      mine: m.className.includes('mine'),
      text: m.innerText.trim().slice(0, 200)
    }))
  })()`

  let sawReply = false
  for (let i = 1; i <= 30; i++) {
    await sleep(4000)
    const bubbles = await run(dump)
    const reply = (bubbles ?? []).find((b) => !b.mine)
    console.log(`+${i * 4}s`, JSON.stringify(bubbles))
    if (reply && reply.text) {
      sawReply = true
      if (!reply.text.endsWith('…')) {
        console.log('✓ 收到回复（终版）')
        break
      }
    }
  }
  if (!sawReply) console.log('✗ 120 秒内没收到回复')
  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
