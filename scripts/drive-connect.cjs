// 点机器人的 ⚡ 一键连上这台机器（/connect），读结果
const WebSocket = require('ws')

const target = process.argv[2] ?? 'Linux 239'

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

  // 开扫码窗口
  await run(`(() => {
    const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('扫码一键连'))
    entry?.click()
    return true
  })()`)
  await sleep(1500)

  console.log(
    '点 ⚡:',
    await run(`(() => {
      const bots = [...document.querySelectorAll('.schat .bot')]
      const hit = bots.find((b) => b.innerText.includes(${JSON.stringify(target)}))
      if (!hit) return '没找到机器人: ' + bots.map((b) => b.innerText).join(' / ')
      hit.querySelector('.bot-work')?.click()
      return 'clicked'
    })()`)
  )

  const dump = `(() => {
    const el = document.querySelector('.schat')
    if (!el) return { gone: true }
    return {
      ok: el.querySelector('.work-ok')?.innerText ?? '',
      err: el.querySelector('.error')?.innerText ?? '',
      machines: [...document.querySelectorAll('.machine-row')].map((m) => m.innerText.replace(/\\n+/g, ' '))
    }
  })()`

  for (let i = 1; i <= 12; i++) {
    await sleep(5000)
    console.log(`+${i * 5}s`, JSON.stringify(await run(dump)))
  }
  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
