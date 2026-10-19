// 验证工具卡片渲染：点开含工具调用的会话，看卡片、状态徽标、展开后的参数/结果。

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

  // 点「这一步要删文件」那段会话
  const clicked = await run(`(() => {
    const items = [...document.querySelectorAll('.item')]
    const target = items.find((el) => el.textContent.includes('删文件'))
    if (target) target.click()
    return !!target
  })()`)
  console.log('点到目标会话:', clicked)
  await sleep(2500)

  console.log('\n=== 消息区文字 ===')
  console.log((await run('document.querySelector(".conversation-view")?.innerText ?? "(没有)"')).slice(0, 600))

  console.log('\n=== 工具卡片 ===')
  console.log(
    await run(`(() => {
      const cards = [...document.querySelectorAll('.tool-card')]
      return {
        count: cards.length,
        first: cards[0] ? {
          text: cards[0].innerText.slice(0, 200),
          status: cards[0].querySelector('.status')?.textContent?.trim(),
          statusClass: cards[0].querySelector('.status')?.className
        } : null
      }
    })()`)
  )

  console.log('\n=== 展开工具卡片 ===')
  await run(`(() => { document.querySelector('.tool-card .head')?.click(); return true })()`)
  await sleep(500)
  console.log(await run(`document.querySelector('.tool-card')?.innerText?.slice(0, 500) ?? ''`))

  socket.close()
}

main().catch((error) => {
  console.error('失败:', error.message)
  process.exit(1)
})
