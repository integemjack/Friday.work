// 自动更新管线端到端探针（CDP）：验证「定时检查 → 自动下载（桌面浮层进度）→ 倒计时 → 推迟 → 立即重启」。
// 前置（三个终端）：
//   1) node scripts/serve-fake-update.cjs
//   2) $env:FRIDAY_WORK_AUTO_UPDATE='1'; $env:FRIDAY_WORK_UPDATE_MANIFEST='http://127.0.0.1:8787/latest.json'; npm run dev:debug
//   3) node scripts/check-auto-update.cjs
// 断言：
//   a) 启动后浮层从无到有（idle 不打扰），文案走到「已就绪」倒计时（自动管线发现→下载一气呵成）
//   b) 点「稍后」→ 浮层收起、应用还活着（推迟生效，不再倒计时）
//   c) fridayBridge.updateApply()（浮层「立即重启」同一条 IPC）→ 拉起安装器并退出，dev 进程结束

const WebSocket = require('ws')

const PORT = 9222
const t0 = Date.now()
const log = (msg) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)

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
  // 等页面目标
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const targets = await listTargets()
      page = targets.find((target) => target.type === 'page')
    } catch {
      /* dev 还没起来 */
    }
    if (!page) await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  if (!page) throw new Error('60s 内没等到 CDP 页面目标')
  log(`页面就绪: ${page.url}`)

  const client = await connect(page.webSocketDebuggerUrl)
  await client.send('Runtime.enable')

  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? '执行出错')
    }
    return result.result.value
  }
  const overlayText = () => evaluate(`document.querySelector('.update-overlay')?.innerText ?? ''`)

  // a) 等自动管线把浮层带到「已就绪」（中间路过「下载更新 v…」，都记下来）
  let last = ''
  let readyText = ''
  for (let i = 0; i < 120 && !readyText; i++) {
    const text = await overlayText()
    if (text !== last) {
      log(`浮层: ${text ? text.replace(/\\n/g, ' | ') : '（收起）'}`)
      last = text
    }
    if (/已就绪/.test(text)) readyText = text
    else await new Promise((resolve) => setTimeout(resolve, 300))
  }
  if (!readyText) throw new Error('60s 内浮层没走到「已就绪」（自动检查/下载没发生？）')
  if (!/秒后自动重启更新/.test(readyText)) throw new Error(`倒计时文案不对: ${readyText}`)
  log('断言 a 通过：发现 → 自动下载 → 就绪倒计时')

  // b) 点「稍后」：浮层收起、应用还活着
  await evaluate(`[...document.querySelectorAll('.update-overlay .btn')].find((b) => b.textContent.includes('稍后'))?.click()`)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const afterPostpone = await overlayText()
  if (afterPostpone) throw new Error(`点「稍后」后浮层没收起: ${afterPostpone}`)
  const alive = await evaluate('1 + 1')
  if (alive !== 2) throw new Error('应用没响应了？')
  const note = await evaluate(
    `(async () => { const s = await window.fridayBridge.updateState(); return s.note })()`
  )
  log(`断言 b 通过：推迟后浮层收起、应用存活；主进程 note = ${JSON.stringify(note)}`)
  if (!/退出 Friday Work 时会自动静默安装/.test(String(note))) throw new Error('推迟后的 note 不对')

  // c) 立即重启（浮层「立即重启」按钮同一条 IPC）：拉起安装器并退出，页面目标消失
  await evaluate('window.fridayBridge.updateApply()')
  log('已调 updateApply，等应用退出…')
  let gone = false
  for (let i = 0; i < 20 && !gone; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      const targets = await listTargets()
      gone = !targets.some((target) => target.type === 'page' && target.webSocketDebuggerUrl === page.webSocketDebuggerUrl)
    } catch {
      gone = true // 9222 都关了 = dev 进程整个退了
    }
  }
  if (!gone) throw new Error('10s 内应用没退出（updateApply 没生效？）')
  log('断言 c 通过：updateApply 拉起安装器并退出，页面目标消失')
  console.log('\n自动更新管线端到端：全部通过')
  process.exit(0)
}

main().catch((error) => {
  console.error('失败:', error.message)
  process.exit(1)
})
