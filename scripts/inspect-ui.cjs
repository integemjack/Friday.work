// 通过 Chrome DevTools Protocol 看渲染进程的实际 DOM（验证 UI，不用截图猜）。
// 用法：先带 --remote-debugging-port=9222 启动应用，再 node scripts/inspect-ui.cjs [actions]

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
            }, 20_000)
          })
        },
        close() {
          socket.close()
        }
      })
    )
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
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

async function main() {
  const targets = await listTargets()
  const page = targets.find((target) => target.type === 'page')
  if (!page) {
    console.error('没有页面目标：', JSON.stringify(targets).slice(0, 300))
    process.exit(1)
  }
  console.log('页面:', page.title, page.url)
  const client = await connect(page.webSocketDebuggerUrl)
  await client.send('Runtime.enable')

  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? '执行出错')
    }
    return result.result.value
  }

  // 1) 页面上有哪些文字
  const text = await evaluate('document.body.innerText')
  console.log('\n===== 页面文字 =====')
  console.log(text)

  // 2) 关键元素在不在、尺寸多少
  const layout = await evaluate(`(() => {
    const pick = (selector) => {
      const el = document.querySelector(selector)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }
    }
    return {
      sidebar: pick('.sidebar'),
      conversation: pick('.conversation-view') || pick('.conversation'),
      dock: pick('.dock'),
      dockBody: pick('.dock-body'),
      termHost: pick('.term-host'),
      messages: document.querySelectorAll('.message').length,
      dockTabs: [...document.querySelectorAll('.dock-tab')].map((el) => el.textContent.trim())
    }
  })()`)
  console.log('\n===== 布局 =====')
  console.log(JSON.stringify(layout, null, 2))

  // 3) 控制台报错
  const errors = await evaluate('window.__fridayErrors ? window.__fridayErrors : "(没有收集器)"')
  console.log('\n控制台错误收集:', errors)

  if (process.argv[2] === 'screenshot') {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    require('fs').writeFileSync('shot-ui.png', Buffer.from(shot.data, 'base64'))
    console.log('截图写到 shot-ui.png')
  }

  client.close()
}

main().catch((error) => {
  console.error('失败:', error.message)
  process.exit(1)
})
