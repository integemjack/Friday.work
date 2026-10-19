// /trust 升级：拿完整设备 id → 发 /trust <id> on → 看同一台机器的终端是否解锁
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

  const readState = `(() => {
    const app = document.querySelector('#app').__vue_app__
    let pinia = null
    for (const key of Reflect.ownKeys(app._context.provides)) {
      const value = app._context.provides[key]
      if (value && typeof value === 'object' && value._s instanceof Map) { pinia = value; break }
    }
    const store = pinia._s.get('app')
    return { machine: store.currentMachineInfo?.name, terminalsAvailable: store.terminalsAvailable, reason: store.terminalsReason }
  })()`

  const sendTo = async (text) => {
    await run(`(() => {
      const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('扫码一键连'))
      entry?.click()
      return true
    })()`)
    await sleep(900)
    await run(`(() => {
      const bots = [...document.querySelectorAll('.schat .bot')]
      const hit = bots.find((b) => b.innerText.includes(${JSON.stringify(target)}))
      hit?.click()
      return true
    })()`)
    await sleep(300)
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

  // 1) 读 /devices 全文
  console.log('/devices:', await sendTo('/devices'))
  await sleep(6000)
  const devicesText = await run(
    `(() => {
      const msgs = [...document.querySelectorAll('.schat .msg')]
      const last = msgs[msgs.length - 1]
      return last ? last.innerText : ''
    })()`
  )
  console.log('设备列表:\n' + devicesText)

  // 2) 找最新那台「扫码连入的」设备的 id
  const lines = String(devicesText).split('\n').map((s) => s.trim()).filter(Boolean)
  const mineLines = lines.filter((line) => line.includes('扫码连入的'))
  const lastLine = mineLines[mineLines.length - 1] ?? ''
  const deviceID = lastLine.split(/\s+/)[0] ?? ''
  console.log('要升级的设备:', deviceID, '|', lastLine)

  // 3) /trust <id> on
  console.log('/trust:', await sendTo(`/trust ${deviceID} on`))
  await sleep(6000)
  console.log(
    '回复:',
    await run(`(() => {
      const msgs = [...document.querySelectorAll('.schat .msg')]
      const last = msgs[msgs.length - 1]
      return last ? last.innerText : ''
    })()`)
  )

  // 4) 回到那台机器看终端
  await sleep(2000)
  await run(`(() => {
    const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('机器与会话'))
    entry?.click()
    return true
  })()`)
  await sleep(1200)
  await run(`(() => {
    const row = [...document.querySelectorAll('.machine-row')].find((m) => m.innerText.includes('扫码连入的'))
    row?.click()
    return true
  })()`)
  await sleep(3000)
  console.log('受信后:', JSON.stringify(await run(readState)))
  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
