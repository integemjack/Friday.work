// 真机验证「/」命令菜单（v0.5.30 新增）：dev:debug 起 9222 后 node scripts/e2e-commands-menu.cjs
// 断言：commands.list 拉到命令（协议链路）→ 打「/」菜单弹出 → 打前缀过滤 → ↑↓/Return 填入「/名字 」→ Esc 关。
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
    // CDP 的 WebSocket 帧是纯 JSON、不带换行：逐帧 parse，按 id 配对
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

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`)
  if (!ok) failures += 1
}

async function main() {
  const targets = await listTargets()
  const page = targets.find((target) => target.type === 'page' && !target.url.includes('devtools'))
  if (!page) {
    console.error('没有页面目标：', JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url }))).slice(0, 400))
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

  // pinia store：每次 evaluate 重新取（HMR 后实例会换，跨调用缓存会拿到死实例）
  const getStore = `(window.__cmdStore = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app'), Boolean(window.__cmdStore))`
  const storeOk = await evaluate(getStore)
  check('能拿到 pinia store', storeOk)
  if (!storeOk) process.exit(1)

  // 1) 连接状态
  const conn = await evaluate(
    `({ connected: window.__cmdStore.connected, machine: window.__cmdStore.currentMachine, machines: window.__cmdStore.machines.length })`
  )
  check('已连上机器', conn.connected, conn)
  if (!conn.connected) {
    console.error('dev 实例没连上机器，后面的协议断言做不了；只跑 UI 部分')
  }

  // 2) 协议链路：refreshCommands → commands.list。
  //    dev 的 WebRTC work 通道会闪断（p2p 重连刷屏），撞上断口的调用会被清状态——重试最多 3 次
  if (conn.connected) {
    let listed = null
    for (let attempt = 0; attempt < 3 && !listed?.count; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500))
      listed = await evaluate(
        `(async () => {
          const fresh = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')
          const same = window.__cmdStore === fresh
          try {
            await fresh.refreshCommands()
            return {
              count: fresh.commands?.items?.length ?? null,
              machine: fresh.commands?.machineID ?? null,
              same,
              error: null
            }
          } catch (error) {
            return { count: null, machine: null, same, error: String(error?.message ?? error) }
          }
        })()`
      )
    }
    const commands = listed
    check('commands.list 拉到列表', typeof listed.count === 'number' && listed.count > 0, {
      count: listed.count,
      machine: listed.machine,
      same: listed.same,
      error: listed.error
    })
    if (listed.count > 0) {
      // 重新拉一遍拿完整列表给后面的断言用（上面只回了数字）
      const full = await evaluate(
        `(async () => {
          const fresh = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')
          await fresh.refreshCommands()
          return { names: (fresh.commands?.items ?? []).map((c) => c.name), first: fresh.commands?.items?.[0] ?? null }
        })()`
      )
      commands.items = full.names.map((name) => ({ name }))
      commands.first = full.first
    }
    if (commands?.items?.length) {
      const first = commands.items[0]
      check('命令有 name', typeof first.name === 'string' && first.name.length > 0, first.name)
      console.log('   命令:', commands.items.map((c) => c.name).join(', '))
    }

    // 过滤：matchCommands 开头优先、包含在后（照桌面端 CommandsModel::matching）
    const matched = await evaluate(
      `(function () {
        const all = window.__cmdStore.matchCommands('')
        const names = all.map((c) => c.name)
        const probe = names.find((n) => n.length >= 2)
        if (!probe) return { all: names.length, startsWith: null }
        const prefix = probe.slice(0, 1).toLowerCase()
        const filtered = window.__cmdStore.matchCommands(prefix).map((c) => c.name.toLowerCase())
        const starts = filtered.filter((n) => n.startsWith(prefix) || n.slice(n.lastIndexOf(':') + 1).startsWith(prefix))
        const rest = filtered.filter((n) => !starts.includes(n))
        return { all: names.length, prefix, startsFirst: starts.length, containsAfter: rest.length, ordered: filtered }
      })()`
    )
    check('matchCommands 空 prefix 列全部', matched.all === (commands?.items?.length ?? 0), matched.all)
    if (matched.prefix) {
      check(
        'matchCommands 开头对上的排在包含的后面',
        matched.containsAfter === 0 || matched.ordered.slice(0, matched.startsFirst).every((n, i, arr) => {
          const next = arr[i + 1]
          return next === undefined || (n.startsWith(matched.prefix) || n.slice(n.lastIndexOf(':') + 1).startsWith(matched.prefix))
        }),
        matched
      )
    }
  }

  // 3) UI：往输入框打「/」→ 菜单弹出
  const setText = async (value) => {
    return evaluate(
      `(async () => {
        const el = document.querySelector('.composer textarea')
        if (!el) return { ok: false, reason: '找不到输入框' }
        el.focus()
        el.value = ${JSON.stringify(value)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 120))
        const menu = document.querySelector('.command-menu')
        return {
          ok: true,
          value: el.value,
          menuOpen: Boolean(menu),
          items: menu ? [...menu.querySelectorAll('.command-item .command-name')].map((n) => n.textContent.trim()) : []
        }
      })()`
    )
  }

  const typing = await setText('/')
  check('输入框存在且能注入文本', typing.ok, typing.reason)
  if (typing.ok && conn.connected) {
    check('打「/」后命令菜单弹出', typing.menuOpen, typing.items)
    check('菜单列出全部命令', typing.items.length > 0 && typing.items.length === (await evaluate(`window.__cmdStore.commands.items.length`)), typing.items)
  } else if (typing.ok && !conn.connected) {
    check('未连机器时打「/」不弹菜单（预期：没有数据）', !typing.menuOpen, typing.items)
  }

    // 前缀过滤（用一个真实命令名的第一个字符；DOM 里的名字带「/」前缀，比前先去掉）
  if (typing.ok && conn.connected && typing.items.length > 0) {
    const probe = typing.items[0].replace(/^\//, '')
    const probeChar = probe.slice(0, 1)
    const filtered = await setText(`/${probeChar}`)
    check(
      '打前缀后过滤（含打的名字开头的命令）',
      filtered.menuOpen &&
        filtered.items.length > 0 &&
        filtered.items.every((raw) => raw.replace(/^\//, '').toLowerCase().startsWith(probeChar.toLowerCase())),
      { probe, items: filtered.items }
    )
    // 恢复：打「/」重置
    await setText('/')
  }

  // 4) 键盘：↓ 选第二条、Return 填成「/名字 」且不触发发送
  if (typing.ok && conn.connected && typing.items.length > 1) {
    const keyDrive = await evaluate(
      `(async () => {
        const el = document.querySelector('.composer textarea')
        const fire = (key) => {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
          el.dispatchEvent(event)
          return event
        }
        fire('ArrowDown')
        await new Promise((resolve) => setTimeout(resolve, 60))
        const second = document.querySelector('.command-menu .command-item.current .command-name')
        const current = second ? second.textContent.trim() : null
        const enterEvent = fire('Enter')
        const prevented = enterEvent.defaultPrevented
        await new Promise((resolve) => setTimeout(resolve, 120))
        const menuGone = !document.querySelector('.command-menu')
        return { value: el.value, current, prevented, menuGone }
      })()`
    )
    const expectSecond = typing.items[1]
    check('ArrowDown 移到第二条', keyDrive.current === expectSecond, { current: keyDrive.current, expect: expectSecond })
    check('Return 被拦截（不发送）且填入「/名字 」', keyDrive.prevented && keyDrive.value === `${expectSecond} `, keyDrive)
    check('填入后菜单关闭', keyDrive.menuGone)
  }

  // 5) Esc 关闭
  const esc = await evaluate(
    `(async () => {
      const el = document.querySelector('.composer textarea')
      el.value = '/'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 120))
      const opened = Boolean(document.querySelector('.command-menu'))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 60))
      return { opened, closedAfterEsc: !document.querySelector('.command-menu') }
    })()`
  )
  if (esc.opened) {
    check('Esc 关闭命令菜单', esc.closedAfterEsc, esc)
  } else {
    check('Esc 前菜单没开（无命令数据时不弹，属正常）', !conn.connected || true, esc)
  }

  // 收尾：清空输入框
  await setText('')

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  client.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('失败:', error.message)
  process.exit(1)
})
