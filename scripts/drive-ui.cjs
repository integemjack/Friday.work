// 通过 CDP 驱动 UI 做 M2 冒烟：点会话 → 开终端 → 看文件卡片 → 看子 Agent 卡片。
// 用法：node scripts/drive-ui.cjs

const WebSocket = require('ws')

const PORT = 9222

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return response.json()
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let id = 0
    const pending = new Map()
    const consoleErrors = []
    socket.on('open', () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const messageID = ++id
            pending.set(messageID, { res, rej })
            socket.send(JSON.stringify({ id: messageID, method, params }))
            setTimeout(() => {
              if (pending.has(messageID)) {
                pending.delete(messageID)
                rej(new Error(`${method} 超时`))
              }
            }, 25_000)
          })
        },
        consoleErrors,
        close() {
          socket.close()
        }
      })
    )
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '))
      }
      if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? 'exception')
      }
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) rej(new Error(message.error.message))
        else res(message.result)
      }
    })
    socket.on('error', reject)
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const targets = await listTargets()
  const page = targets.find((target) => target.type === 'page')
  const client = await connect(page.webSocketDebuggerUrl)
  await client.send('Runtime.enable')

  const run = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? '执行出错')
    return result.result.value
  }

  const text = () => run('document.body.innerText')

  // 1) 点第一段会话
  console.log('=== 点开第一段会话 ===')
  await run(`(() => {
    const item = document.querySelector('.item') || [...document.querySelectorAll('button')].find((b) => b.textContent.includes('第 1 段'))
    if (item) item.click()
    return !!item
  })()`)
  await sleep(2500)
  const afterOpen = await text()
  console.log(afterOpen.slice(0, 700))

  console.log('\n=== 元素检查 ===')
  console.log(
    await run(`(() => ({
      dock: !!document.querySelector('.dock'),
      dockTabs: [...document.querySelectorAll('.dock-tab')].map((el) => el.textContent.trim()),
      messages: document.querySelectorAll('.message').length,
      toolCards: document.querySelectorAll('.tool-card').length,
      approval: !!document.querySelector('.approval-bar')
    }))()`)
  )

  // 2) 打开终端卡片
  console.log('\n=== 打开终端卡片 ===')
  await run(`(() => {
    const tab = [...document.querySelectorAll('.dock-tab')].find((el) => el.textContent.includes('终端'))
    tab?.click()
    return !!tab
  })()`)
  await sleep(1500)
  console.log(
    await run(`(() => ({
      termCard: !!document.querySelector('.term-card'),
      termHost: !!document.querySelector('.term-host'),
      termTabs: [...document.querySelectorAll('.term-tabs .tab')].map((el) => el.textContent.trim()),
      notice: document.querySelector('.notice')?.textContent?.trim() ?? null,
      emptyTip: document.querySelector('.empty-tip')?.textContent?.trim() ?? null
    }))()`)
  )

  // 3) 开一个新终端
  console.log('\n=== 点 ＋ 开终端 ===')
  await run(`(() => { document.querySelector('.tab.add')?.click(); return true })()`)
  await sleep(4000)
  console.log(
    await run(`(() => ({
      termTabs: [...document.querySelectorAll('.term-tabs .tab')].map((el) => el.textContent.trim()),
      xtermRows: document.querySelectorAll('.xterm-rows > div').length,
      lastRows: [...document.querySelectorAll('.xterm-rows > div')].slice(-6).map((d) => d.textContent)
    }))()`)
  )

  // 4) 文件卡片
  console.log('\n=== 打开文件卡片 ===')
  await run(`(() => {
    const tab = [...document.querySelectorAll('.dock-tab')].find((el) => el.textContent.includes('文件'))
    tab?.click()
    return !!tab
  })()`)
  await sleep(3000)
  console.log(
    await run(`(() => ({
      filesCard: !!document.querySelector('.files-card'),
      path: document.querySelector('.files-card .path')?.textContent?.trim(),
      entries: [...document.querySelectorAll('.files-card .entry')].slice(0, 10).map((el) => el.textContent.trim()),
      changes: document.querySelector('.changes-head')?.textContent?.trim() ?? null,
      error: document.querySelector('.files-card .error')?.textContent?.trim() ?? null
    }))()`)
  )

  // 5) 子 Agent 卡片
  console.log('\n=== 打开子 Agent 卡片 ===')
  await run(`(() => {
    const tab = [...document.querySelectorAll('.dock-tab')].find((el) => el.textContent.includes('子 Agent'))
    tab?.click()
    return !!tab
  })()`)
  await sleep(800)
  console.log(await run(`document.querySelector('.agents-card')?.innerText?.trim() ?? '(没有卡片)'`))

  // 6) 控制台报错
  console.log('\n=== 控制台报错 ===')
  console.log(client.consoleErrors.length ? client.consoleErrors.slice(0, 10).join('\n') : '（无）')

  client.close()
}

main().catch((error) => {
  console.error('失败:', error.message)
  process.exit(1)
})
