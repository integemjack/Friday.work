// 看 UI 里每台机器连的是哪个版本（判断守护进程是谁）
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
      pending.set(i, (r) => resolve(r?.result?.value))
      socket.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
    })

  const info = await run(`(async () => {
    const app = document.querySelector('#app').__vue_app__
    let pinia = null
    for (const key of Reflect.ownKeys(app._context.provides)) {
      const v = app._context.provides[key]
      if (v && typeof v === 'object' && v._s instanceof Map) { pinia = v; break }
    }
    const store = pinia._s.get('app')
    return {
      machines: store.machines.map((m) => ({ name: m.name, state: m.state, version: m.serverInfo && m.serverInfo.version })),
      current: store.currentMachine
    }
  })()`)
  console.log(JSON.stringify(info, null, 1))
  socket.close()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
