// stackMediaCache.ts 的哈希/路径工具验证（node 直接跑 esbuild 打出的 cjs，vue 打桩）：
//   1. 同一「会话:类型:源」永远算出同一名字（重启后/不同组件间一致——本地缓存的根基）
//   2. 名字格式过主进程白名单 NAME_RE（16 位十六进制 + 图片/视频扩展名）
//   3. 类型/源/会话任一不同 → 名字不同；query 串不参与、扩展名保留
//   4. joinUnder：绝对路径不动，相对路径拼会话工作目录
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const root = join(__dirname, '..')

const b = spawnSync('npx.cmd', [
  'esbuild', 'src/renderer/src/lib/stackMediaCache.ts',
  '--bundle', '--platform=node', '--format=cjs', '--external:vue',
  '--outfile=.tmp/stackMediaCache.cjs'
], { cwd: root, shell: true })
if (b.status !== 0) { console.error(b.stderr?.toString()); process.exit(1) }

// vue 打桩：ref() 只要个带 .value 的对象；host.ts 在模块层碰 window，也打个桩（这里只测纯函数）
globalThis.window = { addEventListener() {}, removeEventListener() {}, postMessage() {}, fridayRequestPort() {}, parent: null }
globalThis.location = { origin: 'http://localhost:5173', hash: '' }
const Module = require('node:module')
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'vue') return { ref: (v) => ({ value: v }) }
  return origLoad.apply(this, [request, ...rest])
}

const m = require(join(root, '.tmp', 'stackMediaCache.cjs'))
let fail = 0
const check = (name, ok, detail) => { if (!ok) { fail += 1; console.log('FAIL', name, detail ?? '') } }

// 1. 确定性
const a1 = m.stackCacheName('conv-1', 'image', 'C:/Users/x/Desktop/pic.png')
const a2 = m.stackCacheName('conv-1', 'image', 'C:/Users/x/Desktop/pic.png')
check('deterministic', a1 === a2 && typeof a1 === 'string', `${a1} vs ${a2}`)

// 2. 格式过主进程白名单（和 MediaStack.ts 的 NAME_RE 一致）
const NAME_RE = /^[0-9a-f]{16}\.(png|jpg|jpeg|gif|webp|bmp|svg|avif|ico|mp4|m4v|webm|mov|ogv|ogg|mkv)$/
check('format', NAME_RE.test(a1), a1)

// 3. 区分度：类型/源/会话；query 不参与；默认扩展名
check('kind-differs', m.stackCacheName('conv-1', 'video', 'C:/Users/x/Desktop/pic.png') !== a1)
check('src-differs', m.stackCacheName('conv-1', 'image', 'C:/Users/x/Desktop/pic2.png') !== a1)
check('conv-differs', m.stackCacheName('conv-2', 'image', 'C:/Users/x/Desktop/pic.png') !== a1)
check('src-with-query-is-own-entry', m.stackCacheName('conv-1', 'image', 'C:/Users/x/Desktop/pic.png?x=1') !== a1)
check('ext-kept', m.stackCacheName('conv-1', 'video', 'https://a.com/v.mp4?t=1').endsWith('.mp4'))
check('ext-default-image', m.stackCacheName('c', 'image', 'https://a.com/noext').endsWith('.png'))
check('ext-default-video', m.stackCacheName('c', 'video', 'https://a.com/noext').endsWith('.mp4'))

// 4. 路径解析
check('abs-win', m.joinUnder('C:/a/b.png', 'W:/work') === 'C:/a/b.png')
check('abs-posix', m.joinUnder('/tmp/a.png', 'W:/work') === '/tmp/a.png')
check('rel', m.joinUnder('sub/a.png', 'W:/work') === 'W:/work/sub/a.png')
check('rel-nobase', m.joinUnder('sub/a.png', undefined) === 'sub/a.png')

// 5. 缓存地址格式
check('url', m.stackCacheUrl(a1) === `friday-media://stack/${a1}`)

console.log(fail === 0 ? 'stackMediaCache unit: OK' : `stackMediaCache unit: ${fail} FAILED`)
process.exit(fail ? 1 : 0)
