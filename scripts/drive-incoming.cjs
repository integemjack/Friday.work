// 让助手打来并立刻接听：发消息 → 轮询出现「接听」→ 点它 → 观察接通
const WebSocket = require('ws')

const target = process.argv[2] ?? 'Linux 239'
const ask = process.argv[3] ?? '再给我打一次电话，别等太久。'

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

  // 打开扫码窗口选机器人发消息
  await run(`(() => {
    const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('扫码一键连'))
    entry?.click()
    return true
  })()`)
  await sleep(1200)
  console.log(
    '发消息:',
    await run(`(() => {
      const bots = [...document.querySelectorAll('.schat .bot')]
      const hit = bots.find((b) => b.innerText.includes(${JSON.stringify(target)}))
      if (!hit) return '没找到机器人'
      hit.click()
      const area = document.querySelector('.schat .composer textarea')
      const btn = [...document.querySelectorAll('.schat .composer button')].find((b) => b.textContent.includes('发送'))
      if (!area || !btn) return '没有输入框'
      area.value = ${JSON.stringify(ask)}
      area.dispatchEvent(new Event('input', { bubbles: true }))
      setTimeout(() => btn.click(), 100)
      return 'sent'
    })()`)
  )

  // 轮询等来电
  const dump = `(() => {
    const el = document.querySelector('.call')
    if (!el) return { open: false }
    const buttons = [...el.querySelectorAll('.round')].map((b) => b.textContent.trim().replace(/\\s+/g, ' '))
    return { open: true, text: el.innerText.replace(/\\n+/g, ' | ').slice(0, 240), buttons }
  })()`

  let answered = false
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    const state = await run(dump)
    if (state?.buttons?.some((b) => b.includes('接听'))) {
      console.log(`第 ${i + 1}s 来电：`, JSON.stringify(state))
      console.log(
        '接听:',
        await run(`(() => {
          const btn = [...document.querySelectorAll('.call .round')].find((b) => b.textContent.includes('接听'))
          btn?.click()
          return btn ? 'clicked' : '没有按钮'
        })()`)
      )
      answered = true
      break
    }
    if (i % 5 === 0) console.log(`第 ${i + 1}s：`, JSON.stringify(state))
  }

  if (!answered) {
    console.log('没等到来电')
    socket.close()
    return
  }

  for (let i = 1; i <= 9; i++) {
    await sleep(4000)
    console.log(`接通后 +${i * 4}s`, JSON.stringify(await run(dump)))
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

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
