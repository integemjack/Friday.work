// 主题基线快照（重构阶段 0 的工具，收尾时删除）
// 用法：node scripts/theme-snapshot.cjs <输出目录> <jarvis|system>
// 前提：npm run dev:debug 已起（CDP 端口 9222）
// 产物：<输出目录>/<主题>/<视图名>.png + <视图名>.styles.txt + root-vars.txt
const http = require('http')
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

const OUT_ROOT = process.argv[2] || 'docs/_baseline/current'
const THEME = process.argv[3] === 'system' ? 'system' : 'jarvis'
const CDP_PORT = 9222
// 固定视口：跨阶段对拍必须一致
const VW = 1600
const VH = 900

// 视图集：每个视图一段设置 store 的 JS（在页面里执行）
// 约定：setupStoreJS 先跑一次公共态，然后每个视图的 setup 做差异化
const COMMON_SETUP = `(() => {
  const app = document.querySelector('#app').__vue_app__
  const store = app.config.globalProperties.$pinia._s.get('app')
  store.workbenchReady = true
  store.loginOverlay = false
  store.loginActive = false
  store.error = ''
  store.windows = []
  store.nextZ = 10
  return store ? 'ok' : 'no-store'
})()`

const MOCK_JS = `const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')
  s.machines = [{ id: 'mock-1', name: 'MOCK-MACHINE', targetKind: 'work', targetText: 'work:mock', state: 'ready', detail: '', hasPendingApproval: false }]
  s.currentMachine = 'mock-1'`

const NOMEMO_JS = `const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')
  s.machines = []
  s.currentMachine = ''`

const VIEWS = [
  { name: 'desktop-empty', setup: `(() => { ${NOMEMO_JS}; s.windows = []; return 'ok' })()` },
  { name: 'desktop-docks', setup: `(() => { ${MOCK_JS}; s.windows = []; return 'ok' })()` },
  { name: 'win-settings', setup: `(() => { ${MOCK_JS}; s.windows = []; s.openWindow('settings'); return 'ok' })()` },
  { name: 'win-voice', setup: `(() => { ${MOCK_JS}; s.windows = []; s.openWindow('voice'); return 'ok' })()` },
  { name: 'win-schat', setup: `(() => { ${NOMEMO_JS}; s.windows = []; s.openWindow('schat'); return 'ok' })()` },
  { name: 'win-timeline', setup: `(() => { ${MOCK_JS}; s.windows = []; s.openWindow('timeline'); return 'ok' })()` },
  { name: 'win-activity', setup: `(() => { ${MOCK_JS}; s.windows = []; s.openWindow('activity'); return 'ok' })()` },
  { name: 'win-agents', setup: `(() => { ${MOCK_JS}; s.windows = []; s.openWindow('agents'); return 'ok' })()` },
  { name: 'win-machines', setup: `(() => { ${NOMEMO_JS}; s.windows = []; s.openWindow('machines'); return 'ok' })()` },
  { name: 'win-conversation', setup: `(() => { ${MOCK_JS}; s.windows = []; s.openWindow('conversation', { conversationID: 'conv-mock' }); return 'ok' })()` }
]

// 页面内执行：computed style 全量 dump（DOM 路径为 key，动画属性只记 animation-name）
const DUMP_JS = `(() => {
  const PROPS = ['color','backgroundColor','backgroundImage','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','boxShadow','fontFamily','fontSize','fontWeight','letterSpacing','textTransform','opacity','textShadow','caretColor','outlineColor']
  const ANIMATED = new Set(['color','backgroundColor','backgroundImage','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','boxShadow','opacity','textShadow','transform','filter','backgroundPosition'])
  // 非视觉元素不进 dump（Vite 注入的 STYLE/LINK 数量随构建方式变，与样式无关）
  const SKIP = new Set(['STYLE','SCRIPT','LINK','META','TEMPLATE','TITLE','HEAD','BASE','NOSCRIPT'])
  const pathOf = (el) => {
    const chain = []
    let node = el
    while (node && node.parentElement) {
      const parent = node.parentElement
      const k = [...parent.children].filter((c) => c.tagName === node.tagName).indexOf(node) + 1
      chain.unshift(node.tagName + (node.id ? '#' + node.id : '') + ':nth-of-type(' + k + ')')
      node = parent
    }
    return chain.join('>')
  }
  const out = []
  // 颜色语义归一：color(srgb r g b / a) → rgba(r*255, g*255, b*255, a)。
  // Chromium 对 color-mix 的 computed 序列化是 color(srgb) 格式，与字面 rgba 视觉等价但字符串不同；
  // 对拍比的是视觉零差异，所以先归一再比。
  const norm = (v) => String(v).replace(
    /color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)(?: \\/ ([\\d.]+))?\\)/g,
    (_m, r, g, b, a) => 'rgba(' + Math.round(parseFloat(r) * 255) + ', ' + Math.round(parseFloat(g) * 255) + ', ' + Math.round(parseFloat(b) * 255) + ', ' + (a === undefined ? '1' : a) + ')'
  )
  for (const el of document.querySelectorAll('*')) {
    if (SKIP.has(el.tagName)) continue
    const cs = getComputedStyle(el)
    const anim = cs.animationName !== 'none' ? cs.animationName : ''
    const parts = []
    for (const p of PROPS) {
      if (anim && ANIMATED.has(p)) continue
      const v = norm(cs[p])
      if (v && v !== 'none' && v !== '' && v !== 'auto' && v !== 'normal') parts.push(p + ':' + v)
    }
    if (anim) parts.push('anim:' + anim)
    if (parts.length) out.push(pathOf(el) + '|' + parts.join(';'))
  }
  return out.sort().join('\\n')
})()`

// 页面内执行：收集 :root 上生效的全部 CSS 变量值
const VARS_JS = `(() => {
  const names = new Set()
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    if (!rules) continue
    for (const rule of rules) {
      const text = rule.cssText || ''
      for (const m of text.matchAll(/(--[a-zA-Z0-9-]+)\\s*:/g)) names.add(m[1])
    }
  }
  const cs = getComputedStyle(document.documentElement)
  const norm = (v) => String(v).replace(
    /color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)(?: \\/ ([\\d.]+))?\\)/g,
    (_m, r, g, b, a) => 'rgba(' + Math.round(parseFloat(r) * 255) + ', ' + Math.round(parseFloat(g) * 255) + ', ' + Math.round(parseFloat(b) * 255) + ', ' + (a === undefined ? '1' : a) + ')'
  )
  return [...names].sort().map(n => n + ' = ' + norm(cs.getPropertyValue(n).trim())).join('\\n')
})()`

function httpJSON(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: pathname }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('bad json: ' + data.slice(0, 200))) }
      })
    }).on('error', reject)
  })
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function main() {
  const targets = await httpJSON('/json/list')
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  if (!page) throw new Error('没有找到页面 target：' + JSON.stringify(targets.map((t) => t.type + t.url)))
  console.log('target:', page.title, page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 100 * 1024 * 1024 })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })

  let seq = 0
  const pending = new Map()
  const events = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    else events.push(msg)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const waitEvent = (method, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等事件超时: ' + method)), timeoutMs)
    const check = () => {
      const idx = events.findIndex((e) => e.method === method)
      if (idx >= 0) { clearTimeout(t); const [e] = events.splice(idx, 1); resolve(e) }
      else setTimeout(check, 100)
    }
    check()
  })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false })

  // 注入早期脚本：拦截协议进程的 MessagePort，让机器列表/会话事件永远不进来（快照环境确定性）。
  // 请求会挂在 waitForPort 里不返回——不报错、不弹错误横幅，视图停在确定空态。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      "window.addEventListener('message', (e) => { if (e.data === 'friday-port') { e.stopImmediatePropagation() } }, true)"
  })

  const evalJS = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) throw new Error('页面 JS 出错: ' + JSON.stringify(r.exceptionDetails).slice(0, 500))
    return r.result?.value
  }

  // 清布局存档 + 设主题，然后整页重载，保证从同一个初始状态出发
  await evalJS(`localStorage.removeItem('friday.work.layout.v1'); localStorage.setItem('ui.theme', '${THEME}')`)
  const loadP = waitEvent('Page.loadEventFired')
  await send('Page.navigate', { url: page.url })
  await loadP
  await sleep(1200) // 等挂载、等 restoreLayout/bindHost 安顿下来

  const common = await evalJS(COMMON_SETUP)
  if (common !== 'ok') throw new Error('公共态设置失败: ' + common)

  const outDir = path.join(OUT_ROOT, THEME)
  fs.mkdirSync(outDir, { recursive: true })

  for (const view of VIEWS) {
    const r = await evalJS(view.setup)
    if (r !== 'ok') throw new Error(view.name + ' 设置失败: ' + r)
    await sleep(500)
    // 截图前重申状态：清错误横幅、防止任何异步写入改变视图
    await evalJS(`(() => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app'); s.error = ''; return 'ok' })()`)
    await sleep(80)
    // 窗口弹层动画（transition）结束再取数
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(outDir, view.name + '.png'), Buffer.from(shot.data, 'base64'))
    const dump = await evalJS(DUMP_JS)
    fs.writeFileSync(path.join(outDir, view.name + '.styles.txt'), dump)
    console.log('✔', THEME, view.name, '(' + dump.split('\n').length + ' 个元素)')
  }

  const vars = await evalJS(VARS_JS)
  fs.writeFileSync(path.join(outDir, 'root-vars.txt'), vars)
  console.log('✔', THEME, 'root-vars (' + vars.split('\n').length + ' 个变量)')

  ws.close()
}

main().catch((e) => { console.error('快照失败:', e.message); process.exit(1) })
