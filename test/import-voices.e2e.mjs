// 一次性 e2e：直接调主进程 voice:import-voice 的 handler（CosyVoiceService.ts 打包 + electron stub），
// 真实起停 friday-voice serve，验证「拖拽导入音色 gguf」的完整链路：校验 → staging → user-voices
// 持久化 → serve 列表确认 → 坏文件不毒化（回滚 + 对照恢复）。跑完自清理。
//
// 用法：node test/import-voices.e2e.mjs   （在仓库根目录；用 .dev-user-data 当 userData）
import { build } from 'esbuild'
import { mkdir, rm, copyFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const repo = join(root, '..')
const require = createRequire(import.meta.url)

// ── electron stub：把 app.getPath 指到 .dev-user-data，handler 注册进表里供直接调 ──
const stubDir = join(root, '.tmp-e2e-stub')
await mkdir(stubDir, { recursive: true })
const handlers = new Map()
await writeFile(
  join(stubDir, 'electron.js'),
  `// 被打包进 bundle 的 stub：handler 表挂 globalThis，外部 harness 才能拿到同一实例
const handlers = globalThis.__e2eIpcHandlers ??= new Map()
module.exports.ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) }
module.exports.app = {
  getPath: () => ${JSON.stringify(join(repo, '.dev-user-data'))},
  on: () => {}
}
module.exports.dialog = {}
module.exports.__handlers = handlers
`
)

// ── 打包 CosyVoiceService.ts（不 bundle ws；electron 重定向到 stub）──
const outfile = join(stubDir, 'CosyVoiceService.bundle.cjs')
const redirectElectron = {
  name: 'stub-electron',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: join(stubDir, 'electron.js') }))
  }
}
await build({
  entryPoints: [join(repo, 'src/main/CosyVoiceService.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['ws'],
  plugins: [redirectElectron],
  logLevel: 'silent'
})
process.env.NODE_PATH = join(repo, 'node_modules')
require('module').Module._initPaths()

process.on('unhandledRejection', (reason) => {
  console.error('! unhandledRejection:', reason)
})

const svc = require(outfile)
svc.registerCosyVoiceIpc()
const __handlers = globalThis.__e2eIpcHandlers
const importHandler = __handlers.get('voice:import-voice')
if (!importHandler) {
  console.error('✗ voice:import-voice 没注册（registerCosyVoiceIpc 没被调？）')
  process.exit(1)
}

// ── 夹具 ──
const userVoices = join(repo, '.dev-user-data', 'voice-power', 'user-voices')
await mkdir(userVoices, { recursive: true })
const fixtureDir = join(root, '.tmp-e2e-fixture')
await rm(fixtureDir, { recursive: true, force: true })
await mkdir(fixtureDir, { recursive: true })
// 好文件 = 真克隆产物（dev userData 里 vk-cloned 的副本，模拟「克隆导出的 gguf」）
await copyFile(join(repo, '.dev-user-data/voice-power/models/user-voices/vk-cloned.gguf'), join(fixtureDir, 'my-cloned-voice.gguf'))
await copyFile(join(repo, '.dev-user-data/voice-power/models/user-voices/test-cloned.gguf'), join(fixtureDir, '中文名音色.gguf'))
// 毒文件 = 过得了客户端轻校验（GGUF + version 3）但内容垃圾，实测会让 serve 启动即退
const poison = Buffer.concat([
  Buffer.from('GGUF', 'latin1'),
  Buffer.from([3, 0, 0, 0]),
  Buffer.alloc(100 * 1024, 0x5a)
])
await writeFile(join(fixtureDir, 'poison.gguf'), poison)
// 假文件 = 根本不是 gguf
await writeFile(join(fixtureDir, 'not-gguf.bin'), Buffer.from('hello world this is not a gguf at all'.repeat(100)))

const before = new Set((await readdir(userVoices).catch(() => [])).map((n) => n))
const dummySender = { send: () => {} }
let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}
const inUserVoices = async () => (await readdir(userVoices).catch(() => [])).filter((n) => n.endsWith('.gguf'))

// ── 用例 1：好文件（英文名 + 中文名）──
{
  const r = await importHandler({ sender: dummySender }, [
    join(fixtureDir, 'my-cloned-voice.gguf'),
    join(fixtureDir, '中文名音色.gguf')
  ])
  check('好文件导入成功（英文名）', r.imported.includes('my-cloned-voice'))
  check('好文件导入成功（中文名）', r.imported.includes('中文名音色'))
  check('好文件无失败项', r.failed.length === 0, JSON.stringify(r.failed))
  const files = await inUserVoices()
  check('user-voices 里持久化了两个文件', files.includes('my-cloned-voice.gguf') && files.includes('中文名音色.gguf'))
}

// ── 用例 2：毒文件单独导入（serve 起不来 → 定位到它 → 删除 + failed，引擎恢复）──
{
  const r = await importHandler({ sender: dummySender }, [join(fixtureDir, 'poison.gguf')])
  check('毒文件被拒（failed）', r.failed.length === 1 && /引擎加载不了|损坏/.test(r.failed[0].error), JSON.stringify(r.failed))
  check('毒文件没进 imported', r.imported.length === 0)
  const files = await inUserVoices()
  check('毒文件没有残留在 user-voices', !files.includes('poison.gguf'))
}

// ── 用例 3：一批混着好 + 毒（快路径失败 → 逐个 → 好的留下、毒的剔除）──
{
  await copyFile(join(fixtureDir, 'my-cloned-voice.gguf'), join(fixtureDir, 'another-clone.gguf'))
  const r = await importHandler(
    { sender: dummySender },
    [join(fixtureDir, 'another-clone.gguf'), join(fixtureDir, 'poison.gguf')]
  )
  check('混批里好文件成功', r.imported.includes('another-clone'))
  check('混批里毒文件被拒', r.failed.some((f) => /损坏/.test(f.error)), JSON.stringify(r.failed))
  const files = await inUserVoices()
  check('混批后 user-voices 无毒残留', !files.includes('poison.gguf'))
  check('混批后好文件留存', files.includes('another-clone.gguf'))
}

// ── 用例 4：不是 gguf / 校验失败 ──
{
  const r = await importHandler({ sender: dummySender }, [join(fixtureDir, 'not-gguf.bin'), ''])
  check('非 gguf 文件被拒并给出原因', r.failed.length >= 1 && r.failed.every((f) => f.error.length > 0), JSON.stringify(r.failed))
  check('没误导入', r.imported.length === 0)
}

// ── 用例 5：同名重复导入（更新），再验证文件还在（更新成功）──
{
  const r = await importHandler({ sender: dummySender }, [join(fixtureDir, 'my-cloned-voice.gguf')])
  check('同名重导成功（= 更新）', r.imported.includes('my-cloned-voice'), JSON.stringify(r.failed))
}

// ── 收尾：staging 目录应被清掉、本次导入前的旧文件没动、毒没留在引擎侧 ──
{
  check('staging 已清理', !existsSync(join(repo, '.dev-user-data', 'voice-power', 'import-staging')))
  const after = new Set(await inUserVoices())
  const untouched = [...before].every((n) => after.has(n))
  check('导入前已有的文件未被破坏', untouched)
  // 清理本次 e2e 导入的
  for (const n of ['my-cloned-voice.gguf', '中文名音色.gguf', 'another-clone.gguf']) await rm(join(userVoices, n), { force: true })
}

await rm(fixtureDir, { recursive: true, force: true })
await rm(stubDir, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
