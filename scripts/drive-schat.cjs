// 驱动「扫码一键连」窗口：开窗 → 生成二维码 → 读二维码内容与状态
const WebSocket = require('ws')
const port = Number(process.argv[2] ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
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
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      socket.send(JSON.stringify({ id: i, method, params }))
    })
  const run = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value

  await new Promise((r) => setTimeout(r, 9000))

  // 打开「扫码一键连」窗口
  console.log(
    await run(`(() => {
      const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('扫码一键连'))
      if (!entry) return 'no-entry'
      entry.click()
      return 'opened'
    })()`)
  )
  await sleep(1200)

  // 点「生成登录二维码」
  console.log(
    await run(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('生成登录二维码'))
      if (!btn) return 'no-button'
      btn.click()
      return 'clicked'
    })()`)
  )
  await sleep(5000)

  console.log(
    await run(`(() => {
      const win = [...document.querySelectorAll('.win')].pop()
      return {
        text: win ? win.innerText.slice(0, 300).replace(/\\n+/g, ' | ') : '',
        hasSvg: !!win?.querySelector('.qr svg'),
        payload: win?.querySelector('.qr-payload code')?.textContent?.slice(0, 40) ?? null
      }
    })()`)
  )
  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
