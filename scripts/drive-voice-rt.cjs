// 验 voice.* 链路：打开语音窗口 → 点「开始」→ 看服务端回的 state / 错误
const WebSocket = require('ws')

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

  // 打开语音窗口
  await run(`(() => {
    const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('语音'))
    entry?.click()
    return !!entry
  })()`)
  await sleep(1500)

  console.log(
    '窗口内容:',
    JSON.stringify(
      await run(`(() => {
    const el = document.querySelector('.voice')
    if (!el) return '没开'
    return { head: el.innerText.replace(/\\n+/g, ' ').slice(0, 220), hasRealtime: !!el.querySelector('.rt') }
  })()`)
    )
  )

  // 直接调协议（比点按钮更能看清返回）
  console.log(
    'voice.start 回执:',
    JSON.stringify(
      await run(`(async () => {
    const app = document.querySelector('#app').__vue_app__
    let pinia = null
    for (const key of Reflect.ownKeys(app._context.provides)) {
      const v = app._context.provides[key]
      if (v && typeof v === 'object' && v._s instanceof Map) { pinia = v; break }
    }
    const store = pinia._s.get('app')
    const { rpc } = await import('/src/lib/host.js').catch(() => ({}))
    try {
      const result = await store.rpc(store.currentMachine, 'voice.start', { inputSampleRate: 16000, outputSampleRate: 16000 })
      return { ok: true, result }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), code: e && e.code }
    }
  })()`)
    )
  )

  // 点界面上的「开始」，看它把错误显示出来
  await run(`(() => {
    const btn = [...document.querySelectorAll('.rt .rt-btn')].find((b) => b.textContent.trim() === '开始')
    btn?.click()
    return !!btn
  })()`)
  await sleep(3000)
  console.log(
    '点开始后:',
    JSON.stringify(
      await run(`(() => {
    const rt = document.querySelector('.rt')
    return rt ? rt.innerText.replace(/\\n+/g, ' ') : '没有实时对话区'
  })()`)
    )
  )
  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
