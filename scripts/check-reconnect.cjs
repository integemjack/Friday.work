// M1 验收：断线自动重连（杀远端的 --attach 桥，客户端应自己接回来）
// 注意：不能用 pkill -f '<关键字>' —— 那样会把执行命令的 shell 自身也匹配进去。
// 这里先取 PID，再按 PID 结束。
const { execFileSync } = require('node:child_process')
const WebSocket = require('ws')

const HOST = process.env.FRIDAY_SSH ?? 'root@192.168.20.239'

function ssh(command) {
  return execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', HOST, command], { encoding: 'utf8' }).trim()
}

/** 远端桥进程的 PID（friday-server 的 --attach 那条） */
function attachPids() {
  const out = ssh("ps -eo pid,args | grep -F -- 'serv''er --attach' | grep -v grep | awk '{print $1}'")
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

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

  const state = `(() => {
    const lines = document.body.innerText.split('\\n')
    const idx = lines.findIndex((l) => l.includes('测试机'))
    return { head: lines.slice(0, 4).join(' / '), state: idx >= 0 ? lines[idx + 1] ?? '' : '' }
  })()`

  console.log('断线前:', JSON.stringify(await run(state)))
  const before = attachPids()
  console.log('远端 attach 的 PID:', before.join(','))

  if (before.length === 0) throw new Error('远端没有 attach 进程（应用可能没连）')
  console.log('杀掉:', ssh(`kill ${before.join(' ')}`).trim() || '(sent)')

  for (let i = 1; i <= 14; i++) {
    await sleep(3000)
    const snapshot = await run(state)
    const pids = attachPids()
    console.log(`+${i * 3}s`, JSON.stringify(snapshot), '远端 attach:', pids.join(',') || '(无)')
    if (i > 1 && String(snapshot.state).includes('已连接') && pids.length > 0) {
      console.log('\n✓ 客户端自己重连并重新拉起了桥')
      socket.close()
      return
    }
  }
  console.log('\n✗ 12 次采样内没恢复')
  socket.close()
  process.exit(1)
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
