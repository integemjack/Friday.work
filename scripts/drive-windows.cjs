// 打开语音 / 设置 / 活动 / 子 Agent 窗口，检查渲染与报错
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

  await send('Runtime.enable')
  // 收集控制台错误
  await run(`(() => { window.__errs = []; const orig = console.error; console.error = (...a) => { window.__errs.push(a.map(String).join(' ')); orig(...a) }; window.addEventListener('error', (e) => window.__errs.push('error: ' + e.message)); return true })()`)

  for (const label of ['语音', '设置', '活动总览', '子 Agent', '文件', '浏览器']) {
    const opened = await run(`(() => {
      const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('${label}'))
      if (!entry) return 'no-entry'
      entry.click()
      return 'clicked'
    })()`)
    await sleep(1600)
    const state = await run(`(() => {
      const titles = [...document.querySelectorAll('.win')].map((w) => w.querySelector('.win-text')?.textContent?.trim())
      const wins = [...document.querySelectorAll('.win')]
      const last = wins[wins.length - 1]
      return { opened: '${label}', titles, lastText: last ? last.innerText.slice(0, 160).replace(/\\n+/g, ' | ') : '' }
    })()`)
    console.log(state)
  }

  console.log('\n控制台错误:', await run(`window.__errs.slice(0, 5)`))
  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
