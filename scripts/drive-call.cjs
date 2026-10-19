// 真机拨打：点机器人上的 📞，读通话窗口状态（信令链路：p2p_request → p2p_response）
const WebSocket = require('ws')

const target = process.argv[2] ?? 'Linux 239'
const seconds = Number(process.argv[3] ?? 40)

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

  // 开「扫码一键连」窗口
  await run(`(() => {
    const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('扫码一键连'))
    entry?.click()
    return true
  })()`)
  await sleep(1500)

  console.log(
    '点通话:',
    await run(`(() => {
      const bots = [...document.querySelectorAll('.schat .bot')]
      const hit = bots.find((b) => b.innerText.includes(${JSON.stringify(target)}))
      if (!hit) return '没找到 ' + ${JSON.stringify(target)}
      const callBtn = hit.querySelector('.bot-call')
      if (!callBtn) return '这个机器人没有通话入口'
      callBtn.click()
      return 'clicked'
    })()`)
  )

  const dump = `(() => {
    const el = document.querySelector('.call')
    if (!el) return { noWindow: true, titles: [...document.querySelectorAll('.win-title')].map((n) => n.textContent) }
    return {
      text: el.innerText.replace(/\\n+/g, ' | ').slice(0, 300),
      controls: [...el.querySelectorAll('.round')].map((b) => b.textContent.trim().replace(/\\s+/g, ' ')),
      avatarLive: !!el.querySelector('.avatar.live'),
      pulseTransform: el.querySelector('.pulse')?.style.transform ?? ''
    }
  })()`

  for (let i = 1; i <= seconds / 4; i++) {
    await sleep(4000)
    console.log(`+${i * 4}s`, JSON.stringify(await run(dump)))
  }

  // 挂断
  console.log(
    '挂断:',
    await run(`(() => {
      const btn = [...document.querySelectorAll('.call .round')].find((b) => b.textContent.includes('挂断'))
      if (!btn || btn.disabled) return '按钮不可用'
      btn.click()
      return 'clicked'
    })()`)
  )
  await sleep(2000)
  console.log('挂断后:', JSON.stringify(await run(dump)))
  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
