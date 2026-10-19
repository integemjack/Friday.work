// 验证桌面范式：任务栏开窗口 → 会话窗口 → 拖动 → 最小化/还原 → 层叠 → 缩放

const WebSocket = require('ws')

const PORT = 9222
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()

  await new Promise((resolve) => socket.on('open', resolve))
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id && pending.has(message.id)) {
      const { res, rej } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) rej(new Error(message.error.message))
      else res(message.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const messageID = ++id
      pending.set(messageID, { res, rej })
      socket.send(JSON.stringify({ id: messageID, method, params }))
      setTimeout(() => pending.delete(messageID) && rej(new Error('超时')), 20_000)
    })
  const run = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description)
    return result.result.value
  }

  await send('Runtime.enable')
  await sleep(1500)

  console.log('=== 启动后：窗口 ===')
  console.log(
    await run(`(() => {
      const wins = [...document.querySelectorAll('.win')]
      return {
        windowCount: wins.length,
        titles: wins.map((w) => w.querySelector('.win-text')?.textContent),
        taskbar: [...document.querySelectorAll('.task-entry')].map((b) => b.textContent.trim()),
        machine: document.querySelector('.machine-name')?.textContent ?? null,
        machineState: document.querySelector('.machine-state')?.textContent ?? null
      }
    })()`)
  )

  console.log('\n=== 点机器窗口里第一段会话 ===')
  console.log(
    await run(`(() => {
      const rows = [...document.querySelectorAll('.conv-row')]
      if (!rows.length) return { rows: 0 }
      rows[0].click()
      return { rows: rows.length, clicked: rows[0].textContent.trim().slice(0, 40) }
    })()`)
  )
  await sleep(2500)

  console.log('\n=== 会话窗口 ===')
  console.log(
    await run(`(() => {
      const wins = [...document.querySelectorAll('.win')]
      return {
        count: wins.length,
        titles: wins.map((w) => w.querySelector('.win-text')?.textContent?.trim()),
        hasMessages: !!document.querySelector('.message-scroll'),
        messageCount: document.querySelectorAll('.message-item').length,
        hasComposer: !!document.querySelector('.composer'),
        geometry: wins.map((w) => {
          const r = w.getBoundingClientRect()
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        })
      }
    })()`)
  )

  console.log('\n=== 拖动会话窗口（标题栏拖 80,60）===')
  const dragResult = await run(`(async () => {
    const win = [...document.querySelectorAll('.win')].find((w) => w.querySelector('.message-scroll'))
    if (!win) return 'no-conversation-window'
    const before = win.getBoundingClientRect()
    const title = win.querySelector('.win-title')
    const r = title.getBoundingClientRect()
    const opts = (x, y) => ({ bubbles: true, clientX: x, clientY: y, button: 0 })
    title.dispatchEvent(new MouseEvent('mousedown', opts(r.x + 40, r.y + 10)))
    window.dispatchEvent(new MouseEvent('mousemove', opts(r.x + 120, r.y + 70)))
    window.dispatchEvent(new MouseEvent('mouseup', opts(r.x + 120, r.y + 70)))
    await new Promise((done) => setTimeout(done, 300))
    const after = win.getBoundingClientRect()
    return { before: { x: Math.round(before.x), y: Math.round(before.y) }, after: { x: Math.round(after.x), y: Math.round(after.y) } }
  })()`)
  console.log(dragResult)

  console.log('\n=== 最小化 + 从任务栏还原 ===')
  console.log(
    await run(`(async () => {
      const win = [...document.querySelectorAll('.win')].find((w) => w.querySelector('.message-scroll'))
      const before = win.style.display
      win.querySelector('.win-btn')?.click()  // 第一个按钮 = 最小化
      await new Promise((done) => setTimeout(done, 200))
      const hidden = win.style.display
      const chip = [...document.querySelectorAll('.task-chip')].find((c) => c.className.includes('minimized'))
      chip?.click()
      await new Promise((done) => setTimeout(done, 200))
      return { before, hidden, restored: win.style.display }
    })()`)
  )

  console.log('\n=== 任务栏开终端窗口 ===')
  console.log(
    await run(`(async () => {
      const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('终端'))
      entry?.click()
      await new Promise((done) => setTimeout(done, 1500))
      const win = [...document.querySelectorAll('.win')].find((w) => w.querySelector('.term-host, .term-tabs'))
      return {
        windows: document.querySelectorAll('.win').length,
        termWindow: !!win,
        termTabs: [...document.querySelectorAll('.term-tabs .tab')].map((t) => t.textContent.trim().slice(0, 30)),
        canvas: !!document.querySelector('.term-host canvas')
      }
    })()`)
  )

  console.log('\n=== 控制台报错 ===')
  console.log(await run(`window.__fridayErrors?.slice(-5) ?? '(未收集)'`))

  socket.close()
}

main().catch((error) => {
  console.error('失败:', error.message)
  process.exit(1)
})
