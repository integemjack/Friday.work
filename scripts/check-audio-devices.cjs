// 查本机有没有麦克风 / 扬声器（CDP 里读 navigator.mediaDevices）
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

  console.log(
    JSON.stringify(
      await run(`(async () => {
    const out = { audioInputs: [], audioOutputs: [], videoInputs: [], error: null }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      out.audioInputs = devices.filter((d) => d.kind === 'audioinput').map((d) => ({ label: d.label, id: d.deviceId.slice(0, 8) }))
      out.audioOutputs = devices.filter((d) => d.kind === 'audiooutput').map((d) => ({ label: d.label }))
      out.videoInputs = devices.filter((d) => d.kind === 'videoinput').map((d) => ({ label: d.label }))
    } catch (e) { out.error = String(e) }
    return out
  })()`),
      null,
      1
    )
  )
  socket.close()
}

main().catch((e) => console.error('ERR', e.message))
