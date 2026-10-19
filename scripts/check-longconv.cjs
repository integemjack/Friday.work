// 验证长会话的渐进渲染：往一段会话里注入 200 条消息，看 DOM 里只挂 60 条，
// 滚到顶再加载 60（方案 §11「只渲染当前路径可视区」）。
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

  // 打开机器窗口并点第一段会话
  await run(`(() => {
    const entry = [...document.querySelectorAll('.task-entry')].find((b) => b.textContent.includes('机器与会话'))
    if (!entry) return 'no entry'
    entry.click()
    return 'ok'
  })()`)
  await sleep(1200)
  console.log(
    '开会话:',
    await run(`(() => {
      const row = document.querySelector('.conv-row')
      if (!row) return '没有会话行，titles=' + [...document.querySelectorAll('.win-title')].map((n) => n.textContent).join(',')
      row.click()
      return 'clicked'
    })()`)
  )
  await sleep(2500)

  // 取 pinia store 并注入 200 条
  console.log(
    '注入:',
    await run(`(() => {
      const app = document.querySelector('#app').__vue_app__
      if (!app) return '拿不到 app'
      const provides = app._context.provides
      let pinia = null
      for (const key of Reflect.ownKeys(provides)) {
        const value = provides[key]
        if (value && typeof value === 'object' && value._s && value._s instanceof Map) { pinia = value; break }
      }
      if (!pinia) return '拿不到 pinia'
      const store = pinia._s.get('app')
      if (!store) return '拿不到 store'
      const id = store.activeConversationID
      const detail = store.details[id]
      if (!detail) return '没有 detail，active=' + id
      const base = detail.nodes[0]
      const extra = []
      let parent = base.id
      for (let i = 0; i < 200; i++) {
        const nodeID = 'fake-' + i
        extra.push({
          id: nodeID,
          role: i % 2 === 0 ? 'assistant' : 'user',
          parentID: parent,
          createdAt: '2026-10-19T10:00:00Z',
          blocks: [{ id: 'fb-' + i, kind: { text: { _0: '第 ' + i + ' 条测试消息（用于验证渐进渲染）' } } }]
        })
        detail.selectedChildren[parent] = nodeID
        parent = nodeID
      }
      detail.nodes = [...detail.nodes, ...extra]
      store.rebuildPath(detail)
      return { id, nodes: detail.nodes.length, messages: detail.messages.length, base: !!base }
    })()`)
  )
  await sleep(2000)

  const counts = `(() => {
    const els = [...document.querySelectorAll('.message-scroll')]
    const el = els[els.length - 1]
    return {
      rendered: el ? el.querySelectorAll('.message-wrap').length : -1,
      earlier: el?.querySelector('.earlier')?.innerText ?? '',
      scrollTop: el?.scrollTop ?? -1
    }
  })()`

  console.log('注入后:', JSON.stringify(await run(counts)))

  // 滚到顶
  await run(`(() => {
    const els = [...document.querySelectorAll('.message-scroll')]
    const el = els[els.length - 1]
    if (!el) return 'no scroll'
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
    return 'scrolled'
  })()`)
  await sleep(1200)
  console.log('滚到顶后:', JSON.stringify(await run(counts)))
  await run(`(() => {
    const els = [...document.querySelectorAll('.message-scroll')]
    const el = els[els.length - 1]
    if (!el) return
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
  })()`)
  await sleep(1200)
  console.log('再滚一次:', JSON.stringify(await run(counts)))

  socket.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
