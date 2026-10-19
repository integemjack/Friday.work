// 验受信级别：先看这台 WS 设备（不受信）终端/浏览器/文件不可用 → 聊天里 /devices + /trust → 再看
const WebSocket = require('ws')

const target = process.argv[2] ?? 'Linux 239'
const stateExpr = `(() => {
  const s = document.querySelector('.machines')
  return {
    rows: [...document.querySelectorAll('.machine-row')].map((m) => m.innerText.replace(/\\n+/g, ' ')),
    selected: null
  }
})()`

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

  console.log('机器列表:', JSON.stringify(await run(stateExpr)))

  // 选中「扫码连入」那台
  console.log(
    '选中扫码连入的机器:',
    await run(`(() => {
      const row = [...document.querySelectorAll('.machine-row')].find((m) => m.innerText.includes('扫码连入的'))
      if (!row) return '没有'
      row.click()
      return 'clicked'
    })()`)
  )
  await sleep(3000)

  // 读 store 里的终端可用性
  const readState = `(() => {
    const app = document.querySelector('#app').__vue_app__
    let pinia = null
    for (const key of Reflect.ownKeys(app._context.provides)) {
      const value = app._context.provides[key]
      if (value && typeof value === 'object' && value._s instanceof Map) { pinia = value; break }
    }
    const store = pinia._s.get('app')
    return {
      machine: store.currentMachineInfo?.name,
      state: store.currentMachineInfo?.state,
      terminalsAvailable: store.terminalsAvailable,
      reason: store.terminalsReason,
      trusted: store.machines.find((m) => m.id === store.currentMachine)?.id ? 'n/a' : 'n/a'
    }
  })()`

  console.log('（不受信时）:', JSON.stringify(await run(readState)))

  // 聊天里发 /devices
  await run(`(() => {
    const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('扫码一键连'))
    entry?.click()
    return true
  })()`)
  await sleep(1200)
  const sendTo = async (text) => {
    await run(`(() => {
      const bots = [...document.querySelectorAll('.schat .bot')]
      const hit = bots.find((b) => b.innerText.includes(${JSON.stringify(target)}))
      hit?.click()
      return true
    })()`)
    await sleep(400)
    return run(`(() => {
      const area = document.querySelector('.schat .composer textarea')
      const btn = [...document.querySelectorAll('.schat .composer button')].find((b) => b.textContent.includes('发送'))
      if (!area || !btn) return 'no box'
      area.value = ${JSON.stringify(text)}
      area.dispatchEvent(new Event('input', { bubbles: true }))
      setTimeout(() => btn.click(), 100)
      return 'sent'
    })()`)
  }

  console.log('/devices:', await sendTo('/devices'))
  await sleep(6000)
  console.log(
    '聊天尾部:',
    JSON.stringify(
      await run(`(() => [...document.querySelectorAll('.schat .msg')].slice(-2).map((m) => m.innerText.replace(/\\n+/g, ' ').slice(0, 160)))()`)
    )
  )
  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
