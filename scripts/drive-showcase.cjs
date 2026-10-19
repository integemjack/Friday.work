// 摆一个完整桌面（会话 + 终端 + 文件 + 子 Agent），用于截图看效果
const WebSocket = require('ws')
const PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  await new Promise((r) => socket.on('open', r))
  socket.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.id && pending.has(m.id)) {
      const { res } = pending.get(m.id)
      pending.delete(m.id)
      res(m.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, { res })
      socket.send(JSON.stringify({ id: i, method, params }))
    })
  const run = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r.result?.value
  }

  // 开终端、文件、活动三个窗口
  for (const label of ['终端', '文件', '活动总览']) {
    await run(`(() => {
      const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('${label}'))
      entry?.click()
      return !!entry
    })()`)
    await sleep(1800)
  }

  // 终端里敲一条命令看输出
  await sleep(500)
  await run(`(() => {
    const host = document.querySelector('.term-host')
    const textarea = host?.querySelector('textarea')
    textarea?.focus()
    return !!textarea
  })()`)
  for (const ch of 'echo Friday 桌面\r') {
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch })
    await sleep(40)
  }
  await sleep(1200)

  console.log(
    await run(`(() => ({
      windows: [...document.querySelectorAll('.win')].map((w) => ({
        title: w.querySelector('.win-text')?.textContent?.trim(),
        rect: (() => { const r = w.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()
      })),
      termRows: document.querySelector('.xterm-rows')?.innerText?.trim().split('\\n').slice(-4)
    }))()`)
  )
  socket.close()
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
