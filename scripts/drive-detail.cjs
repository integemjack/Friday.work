// 细查：会话窗口里消息文本、终端内容、最小化行为

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
      const { res, rej } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) rej(new Error(m.error.message))
      else res(m.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id
      pending.set(i, { res, rej })
      socket.send(JSON.stringify({ id: i, method, params }))
      setTimeout(() => pending.delete(i) && rej(new Error('超时')), 15000)
    })
  const run = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description)
    return r.result.value
  }

  console.log('=== 会话窗口的消息 ===')
  console.log(
    await run(`(() => {
      const scroll = document.querySelector('.message-scroll')
      if (!scroll) return 'no scroll'
      const text = scroll.innerText.trim()
      return {
        chars: text.length,
        head: text.slice(0, 260),
        messageEls: scroll.querySelectorAll('.message').length,
        blocks: scroll.querySelectorAll('.block').length
      }
    })()`)
  )

  console.log('\n=== 终端窗口 ===')
  console.log(
    await run(`(() => {
      const host = document.querySelector('.term-host')
      if (!host) return 'no term host'
      return {
        html: host.innerHTML.slice(0, 200),
        rows: host.querySelector('.xterm-rows')?.innerText?.slice(0, 300) ?? '(无 textarea/rows)',
        textarea: !!host.querySelector('textarea')
      }
    })()`)
  )

  console.log('\n=== 最小化（点第一个 win-btn）===')
  console.log(
    await run(`(async () => {
      const win = [...document.querySelectorAll('.win')].find((w) => w.querySelector('.message-scroll'))
      if (!win) return 'no conv window'
      const btn = win.querySelector('.win-btn')
      const label = btn?.getAttribute('title')
      btn?.click()
      await new Promise((r) => setTimeout(r, 400))
      return { btnTitle: label, display: win.style.display, className: win.className }
    })()`)
  )

  console.log('\n=== 任务栏还原 ===')
  console.log(
    await run(`(async () => {
      const chips = [...document.querySelectorAll('.task-chip')]
      const target = chips.find((c) => c.className.includes('minimized')) ?? chips[chips.length - 1]
      const before = { count: chips.length, minimizedChips: chips.filter((c) => c.className.includes('minimized')).length }
      target?.click()
      await new Promise((r) => setTimeout(r, 400))
      const win = [...document.querySelectorAll('.win')].find((w) => w.querySelector('.message-scroll'))
      return { before, afterDisplay: win?.style.display ?? 'gone' }
    })()`)
  )

  console.log('\n=== 缩放（右下角拖 +100,+80）===')
  console.log(
    await run(`(async () => {
      const win = [...document.querySelectorAll('.win')].find((w) => w.querySelector('.message-scroll'))
      if (!win) return 'no conv window'
      const before = win.getBoundingClientRect()
      const handle = win.querySelector('.handle.se')
      const r = handle.getBoundingClientRect()
      const opts = (x, y) => ({ bubbles: true, clientX: x, clientY: y, button: 0 })
      handle.dispatchEvent(new MouseEvent('mousedown', opts(r.x + 5, r.y + 5)))
      window.dispatchEvent(new MouseEvent('mousemove', opts(r.x + 105, r.y + 85)))
      window.dispatchEvent(new MouseEvent('mouseup', opts(r.x + 105, r.y + 85)))
      await new Promise((r2) => setTimeout(r2, 300))
      const after = win.getBoundingClientRect()
      return {
        before: { w: Math.round(before.width), h: Math.round(before.height) },
        after: { w: Math.round(after.width), h: Math.round(after.height) }
      }
    })()`)
  )

  socket.close()
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
