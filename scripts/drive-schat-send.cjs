// 在「扫码一键连」窗口里给 Friday 机器人发一句话，检查流式回复
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

  // 1) 选第一个机器人
  console.log('选机器人:', await run(`(() => {
    const bot = document.querySelector('.schat .bot')
    if (!bot) return '没有机器人'
    bot.click()
    return bot.innerText.replace(/\\n/g, ' ')
  })()`))

  // 2) 填内容并发送（走 Vue 的 v-model：派发 input 事件）
  console.log('发送:', await run(`(() => {
    const area = document.querySelector('.schat .composer textarea')
    if (!area) return '没有输入框'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, '你好，我是 Friday 桌面客户端，这是扫码登录后发的第一条消息。')
    area.dispatchEvent(new Event('input', { bubbles: true }))
    const btn = [...document.querySelectorAll('.schat .composer button')].find((b) => b.textContent.includes('发送'))
    if (!btn || btn.disabled) return '发送按钮不可用'
    btn.click()
    return 'clicked'
  })()`))

  // 3) 等回复（流式）
  for (const wait of [3000, 6000, 10000, 15000]) {
    await sleep(wait)
    const state = await run(`(() => {
      const bubbles = [...document.querySelectorAll('.schat .msg .bubble')].map((b) => b.innerText.trim())
      return { count: bubbles.length, last: bubbles.slice(-2), status: document.querySelector('.schat .phase')?.textContent }
    })()`)
    console.log(`+${wait}ms`, JSON.stringify(state))
    if (state && state.count >= 2) break
  }

  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
