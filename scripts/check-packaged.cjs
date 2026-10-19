// 检查打包后的程序是否真的连上远程（读 DOM 实际内容）
const WebSocket = require('ws')
const port = Number(process.argv[2] ?? 9333)

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((target) => target.type === 'page')
  if (!page) throw new Error('没有页面')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  await new Promise((resolve) => socket.on('open', resolve))
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result)
      pending.delete(message.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const messageID = ++id
      pending.set(messageID, resolve)
      socket.send(JSON.stringify({ id: messageID, method, params }))
    })
  const run = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value

  await new Promise((resolve) => setTimeout(resolve, Number(process.argv[3] ?? 8000)))
  console.log(
    await run(`(() => ({
      windows: [...document.querySelectorAll('.win')].map((w) => w.querySelector('.win-text')?.textContent),
      machine: document.querySelector('.machine-name')?.textContent ?? null,
      state: document.querySelector('.machine-state')?.textContent ?? null,
      body: document.body.innerText.slice(0, 300)
    }))()`)
  )
  socket.close()
}

main().catch((error) => {
  console.error('ERR', error.message)
  process.exit(1)
})
