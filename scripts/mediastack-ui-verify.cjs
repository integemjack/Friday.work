// 媒体叠本地缓存的端到端验证（对着 dev 实例跑，需先起 npm run dev:debug）：
//   A. 预置：生成一张 PNG，按渲染层同一套哈希算出缓存名，放进 .dev-user-data/MediaStack
//   B. 注入叠条目（src=假远端路径，盘上并没有这个文件——只能走本地缓存）
//   C. 验证缩略图 <img> 从 friday-media:// 加载成功（naturalWidth>0）
//   D. 验证 saveLayout 把叠写进 localStorage；reload 页面（模拟重启）叠自动回来、图还能加载
//   E. 展开叠、点「清空」：盘上的缓存文件一并删除、localStorage 同步清空
//   F. 全程收集渲染进程 console 报错
// 用法：node scripts/mediastack-ui-verify.cjs
const { spawnSync } = require('node:child_process')
const { mkdirSync, rmSync, writeFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const zlib = require('node:zlib')

const root = join(__dirname, '..')
const shots = join(root, '.tmp', 'ui-shots')
mkdirSync(shots, { recursive: true })

// ---- A. 生成一张 64x64 红→蓝渐变 PNG（手拼 PNG，不依赖图像库） ----
const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8bit RGB
  const raw = []
  for (let y = 0; y < h; y += 1) {
    const row = Buffer.alloc(1 + w * 3)
    for (let x = 0; x < w; x += 1) {
      row[1 + x * 3] = Math.round((x / w) * 255)
      row[2 + x * 3] = 0
      row[3 + x * 3] = Math.round((y / h) * 255)
    }
    raw.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(raw))),
    chunk('IEND', Buffer.alloc(0))
  ])
}
const png = makePng(64, 64)

// ---- 用渲染层同一套哈希算缓存名（esbuild 打 stackMediaCache.ts，vue/host 打桩） ----
const bundle = spawnSync('npx.cmd', [
  'esbuild', 'src/renderer/src/lib/stackMediaCache.ts',
  '--bundle', '--platform=node', '--format=cjs', '--external:vue',
  '--outfile=.tmp/ui-stackMediaCache.cjs'
], { cwd: root, shell: true })
if (bundle.status !== 0) { console.error(bundle.stderr?.toString()); process.exit(1) }
globalThis.window = { addEventListener() {}, removeEventListener() {}, postMessage() {}, fridayRequestPort() {}, parent: null }
globalThis.location = { origin: 'http://localhost:5173', hash: '' }
const Module = require('node:module')
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'vue') return { ref: (v) => ({ value: v }) }
  return origLoad.apply(this, [request, ...rest])
}
const cacheLib = require(join(root, '.tmp', 'ui-stackMediaCache.cjs'))

const CONV = 'conv-verify-1'
const SRC = 'C:/Users/ultra/Desktop/works/远端已清理/pic.png' // 盘上不存在——只有本地缓存能加载它
const cacheName = cacheLib.stackCacheName(CONV, 'image', SRC)
const cachePath = join(root, '.dev-user-data', 'MediaStack', cacheName)
mkdirSync(join(root, '.dev-user-data', 'MediaStack'), { recursive: true })
writeFileSync(cachePath, png)
console.log('cache name =', cacheName)

// ---- CDP 客户端 ----
let msgId = 0
const pending = new Map()
const consoleErrors = []
let ws
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 找 dev 页面目标
  let page = null
  for (let i = 0; i < 40 && !page; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
      page = list.find((t) => t.type === 'page' && /localhost:5173|index\.html/.test(t.url))
    } catch { /* dev 还没起来 */ }
    if (!page) await sleep(1000)
  }
  if (!page) throw new Error('9222 上找不到 dev 页面目标')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      consoleErrors.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push('log: ' + String(msg.params.entry.text).slice(0, 300))
    }
  }
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')

  // 等应用挂载（pinia 可达）
  let ready = false
  for (let i = 0; i < 30 && !ready; i += 1) {
    ready = await evaluate(`!!(document.querySelector('#app') && document.querySelector('#app').__vue_app__ && window.fridayBridge)`)
    if (!ready) await sleep(1000)
  }
  if (!ready) throw new Error('应用没挂起来')

  // 先 reload 一次：缓存文件是在 dev 启动后才写进去的，boot 时 initStackCache 列到的是空目录；
  // 重载后注册表回填（真实场景里归档下载完成时会即时更新注册表，这里用 reload 达到同一状态）
  await evaluate('location.reload()')
  for (let i = 0; i < 30; i += 1) {
    const up = await evaluate(`!!(document.querySelector('#app') && document.querySelector('#app').__vue_app__ && window.fridayBridge)`).catch(() => false)
    if (up) break
    await sleep(1000)
  }
  await sleep(1500)

  const fail = []
  const check = (name, ok, detail) => {
    console.log(ok ? 'PASS' : 'FAIL', name, detail ?? '')
    if (!ok) fail.push(name)
  }

  // ---- B. 注入叠条目（盘上没有这个源文件——只有缓存能加载） ----
  const injected = await evaluate(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const store = app.config.globalProperties.$pinia._s.get('app')
    store.stackMedia = [{ id: ${JSON.stringify(CONV + ':image:' + SRC)}, conversationID: ${JSON.stringify(CONV)}, kind: 'image', src: ${JSON.stringify(SRC)}, at: Date.now(), cache: ${JSON.stringify(cacheName)} }]
    return store.stackMedia.length
  })()`)
  check('inject-stack', injected === 1, 'n=' + injected)

  // ---- C. 缩略图从 friday-media:// 加载成功（懒加载给点时间） ----
  await sleep(2500)
  const thumb = await evaluate(`(() => {
    const imgs = [...document.querySelectorAll('img')]
    const hit = imgs.find((i) => i.src.startsWith('friday-media://stack/'))
    return { found: !!hit, url: hit ? hit.src : '', loaded: hit ? (hit.complete && hit.naturalWidth > 0) : false, w: hit ? hit.naturalWidth : 0, imgCount: imgs.length }
  })()`)
  check('thumb-uses-cache-url', thumb.found, JSON.stringify(thumb))
  check('thumb-loaded', thumb.loaded, `naturalWidth=${thumb.w}`)
  check('thumb-url-name', thumb.url.endsWith(cacheName), thumb.url)

  // 截图（登录页盖着桌面就先藏掉，只为了看叠）
  await evaluate(`(() => { const el = document.querySelector('.login-overlay, .login, [class*=login]'); if (el) el.style.display = 'none'; return true })()`)
  await sleep(300)
  await capture('1-stack.png')

  // 展开叠 → 截图
  const expanded = await evaluate(`(() => {
    const card = document.querySelector('.stack, .stack-card, [class*=stack]')
    if (!card) return false
    card.click()
    return true
  })()`)
  await sleep(600)
  if (expanded) await capture('2-expanded.png')

  // ---- D. localStorage 持久化 + reload 恢复（模拟重启） ----
  await sleep(900) // 布局保存防抖 300ms + 余量
  const saved = await evaluate(`(() => { try { return JSON.parse(localStorage.getItem('friday.work.layout.v1') ?? '{}') } catch { return {} } })()`)
  check('persisted', Array.isArray(saved.stackMedia) && saved.stackMedia.length === 1 && saved.stackMedia[0].cache === cacheName, JSON.stringify(saved.stackMedia ?? null))

  await evaluate('location.reload()')
  await sleep(4000) // 等 dev 重挂载 + initStackCache 回填
  let restored = null
  for (let i = 0; i < 10 && !restored; i += 1) {
    restored = await evaluate(`(() => {
      const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__
      if (!app) return null
      const store = app.config.globalProperties.$pinia._s.get('app')
      return { n: store.stackMedia.length, src: store.stackMedia[0]?.src ?? '', cache: store.stackMedia[0]?.cache ?? '' }
    })()`).catch(() => null)
    if (!restored || restored.n === 0) { await sleep(1000); restored = restored && restored.n === 0 ? null : restored }
  }
  check('restored-after-reload', !!restored && restored.n === 1 && restored.src === SRC, JSON.stringify(restored))
  if (restored) check('restored-cache-name', restored.cache === cacheName, restored.cache)

  await sleep(2000) // 缩略图懒加载
  const thumb2 = await evaluate(`(() => {
    const hit = [...document.querySelectorAll('img')].find((i) => i.src.startsWith('friday-media://stack/'))
    return { found: !!hit, loaded: hit ? (hit.complete && hit.naturalWidth > 0) : false }
  })()`)
  check('reload-thumb-loaded', thumb2.found && thumb2.loaded, JSON.stringify(thumb2))

  // ---- E. 清空：展开叠点「清空」按钮，连本地缓存文件一起删 ----
  const expandResult = await evaluate(`(() => {
    const pile = document.querySelector('.media-stacks .stack .pile')
    if (!pile) return 'no-pile'
    pile.click()
    return 'clicked'
  })()`)
  await sleep(500) // Vue 异步渲染：panel 下一 tick 才出现
  const clearedByClick = await evaluate(`(() => {
    const panel = document.querySelector('.media-stacks .stack-panel')
    if (!panel) return 'no-panel'
    const clear = panel.querySelector('button.clear')
    if (!clear) return 'no-clear-btn'
    clear.click()
    return 'clicked'
  })()`)
  await sleep(1000)
  const clearTrace = expandResult + ' > ' + clearedByClick
  const afterClear = await evaluate(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const store = app.config.globalProperties.$pinia._s.get('app')
    let saved = null
    try { saved = JSON.parse(localStorage.getItem('friday.work.layout.v1') ?? '{}') } catch {}
    return { n: store.stackMedia.length, savedN: Array.isArray(saved?.stackMedia) ? saved.stackMedia.length : -1 }
  })()`)
  check('clear-by-ui-click', expandResult === 'clicked' && clearedByClick === 'clicked', clearTrace)
  check('stack-emptied', afterClear.n === 0, JSON.stringify(afterClear))
  await sleep(900) // 布局保存防抖
  const savedAfterClear = await evaluate(`(() => { try { const s = JSON.parse(localStorage.getItem('friday.work.layout.v1') ?? '{}'); return Array.isArray(s.stackMedia) ? s.stackMedia.length : -1 } catch { return -2 } })()`)
  check('persisted-after-clear', savedAfterClear === 0, 'saved stackMedia n=' + savedAfterClear)
  check('cache-file-deleted', !existsSync(cachePath), cachePath)

  // ---- G. data: 源条目：存档时换成缓存地址，重启恢复后照样加载（friday-media 直连分支） ----
  const dataSrc = 'data:image/png;base64,' + png.toString('base64')
  const dataName = cacheLib.stackCacheName(CONV + '-data', 'image', dataSrc)
  writeFileSync(join(root, '.dev-user-data', 'MediaStack', dataName), png)
  await evaluate('location.reload()')
  for (let i = 0; i < 30; i += 1) {
    const up = await evaluate(`!!(document.querySelector('#app') && document.querySelector('#app').__vue_app__ && window.fridayBridge)`).catch(() => false)
    if (up) break
    await sleep(1000)
  }
  await sleep(1500)
  const injectedData = await evaluate(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const store = app.config.globalProperties.$pinia._s.get('app')
    store.stackMedia.push({ id: ${JSON.stringify(CONV + '-data:image:' + dataSrc)}, conversationID: ${JSON.stringify(CONV + '-data')}, kind: 'image', src: ${JSON.stringify(dataSrc)}, at: Date.now(), cache: ${JSON.stringify(dataName)} })
    return store.stackMedia.length
  })()`)
  await sleep(2500)
  const dataThumb = await evaluate(`(() => {
    const hits = [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('friday-media://stack/'))
    return { n: hits.length, loaded: hits.every((i) => i.complete && i.naturalWidth > 0), urls: hits.map((i) => i.src) }
  })()`)
  check('data-src-thumb-loaded', injectedData === 1 && dataThumb.n >= 1 && dataThumb.loaded, JSON.stringify(dataThumb))
  await sleep(900)
  const dataSaved = await evaluate(`(() => { try { const s = JSON.parse(localStorage.getItem('friday.work.layout.v1') ?? '{}'); return (s.stackMedia ?? []).map((x) => ({ src: String(x.src).slice(0, 50), cache: x.cache })) } catch { return null } })()`)
  const dataEntry = Array.isArray(dataSaved) ? dataSaved.find((x) => x.cache === dataName) : null
  check('data-src-saved-as-cache-url', !!dataEntry && dataEntry.src.startsWith('friday-media://stack/'), JSON.stringify(dataEntry))
  // 重启恢复：src 已是 friday-media://（用哈希重算会对不上，必须走直连分支）
  await evaluate('location.reload()')
  for (let i = 0; i < 30; i += 1) {
    const up = await evaluate(`!!(document.querySelector('#app') && document.querySelector('#app').__vue_app__ && window.fridayBridge)`).catch(() => false)
    if (up) break
    await sleep(1000)
  }
  await sleep(3000)
  const dataRestored = await evaluate(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const store = app.config.globalProperties.$pinia._s.get('app')
    const item = store.stackMedia.find((x) => x.cache === ${JSON.stringify(dataName)})
    const hit = [...document.querySelectorAll('img')].find((i) => i.src.endsWith(${JSON.stringify(dataName)}))
    return { inStack: !!item, src: String(item?.src ?? '').slice(0, 50), imgLoaded: hit ? hit.complete && hit.naturalWidth > 0 : false }
  })()`)
  check('data-src-restored-loads', dataRestored.inStack && dataRestored.imgLoaded, JSON.stringify(dataRestored))

  // ---- F. 结果 ----
  const relevantErrors = consoleErrors.filter((e) => !/GPU|gpu|dbus|Passthrough|fallback|Vulkan|ANGLE|sandbox/i.test(e))
  if (relevantErrors.length) console.log('console errors/warnings:\n' + relevantErrors.join('\n'))
  else console.log('console: no unexpected errors')

  console.log(fail.length === 0 ? 'UI VERIFY: ALL PASS' : `UI VERIFY: ${fail.length} FAILED -> ${fail.join(', ')}`)
  process.exit(fail.length ? 1 : 0)
}

async function capture(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name), Buffer.from(r.data, 'base64'))
  console.log('shot saved:', name)
}

main().catch((e) => { console.error('VERIFY ERROR:', e.message); process.exit(1) })
