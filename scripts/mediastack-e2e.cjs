// MediaStack 主进程模块的 Electron 运行时测试（不经渲染层，直接调导出函数 + net.fetch 打协议）。
// 运行：node scripts/mediastack-e2e.cjs（脚本自己起 electron，跑完退出，退出码 0 = 全过）
const { spawnSync } = require('node:child_process')
const { mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const tmp = join(root, '.tmp', 'mediastack-app')
mkdirSync(tmp, { recursive: true })

// 把 TS 模块打成 cjs（electron 外置），放进测试 app 里
const bundle = spawnSync('npx.cmd', [
  'esbuild', 'src/main/MediaStack.ts',
  '--bundle', '--platform=node', '--format=cjs', '--external:electron',
  '--outfile=' + join(tmp, 'mediastack.cjs')
], { cwd: root, shell: true })
if (bundle.status !== 0) {
  console.error(bundle.stdout?.toString(), bundle.stderr?.toString())
  process.exit(1)
}

writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'mediastack-e2e', main: 'test.cjs' }))
writeFileSync(join(tmp, 'test.cjs'), `'use strict'
const { app, protocol, net } = require('electron')
const m = require('./mediastack.cjs')
const results = []
const check = (name, ok, detail) => { results.push([name, ok, detail]); if (!ok) console.log('FAIL', name, detail ?? '') }

app.setPath('userData', require('node:path').join(__dirname, 'user-data'))
protocol.registerSchemesAsPrivileged([{ scheme: 'friday-media', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

async function fetchBytes(url, headers) {
  const res = await net.fetch(url, { headers })
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, buf }
}

app.whenReady().then(async () => {
  try {
    protocol.handle('friday-media', (request) => m.handleMediaStackRequest(request))

    // 1. 存：渲染层传字节
    const payload = Buffer.alloc(1000)
    for (let i = 0; i < 1000; i += 1) payload[i] = i % 251
    const saved = await m.saveStackMediaFile('0123456789abcdef.png', { bytes: payload })
    check('save-bytes', saved === '0123456789abcdef.png', saved)

    // 2. 非法名字被拒（目录穿越 / 乱名字）
    check('reject-bad-name-1', (await m.saveStackMediaFile('../evil.png', { bytes: payload })) === null)
    check('reject-bad-name-2', (await m.saveStackMediaFile('nohash.png', { bytes: payload })) === null)
    check('reject-bad-name-3', (await m.saveStackMediaFile('0123456789abcdef.exe', { bytes: payload })) === null)
    check('reject-empty', (await m.saveStackMediaFile('0123456789abcdef.png', {})) === null)

    // 3. 列表
    const list = await m.listStackMediaFiles()
    check('list', Array.isArray(list) && list.includes('0123456789abcdef.png'), JSON.stringify(list))

    // 4. 全量取：200 + Content-Length + Accept-Ranges + 字节一致
    const full = await fetchBytes('friday-media://stack/0123456789abcdef.png')
    check('full-200', full.status === 200, full.status)
    check('full-length', full.headers.get('content-length') === '1000', full.headers.get('content-length'))
    check('full-type', full.headers.get('content-type') === 'image/png', full.headers.get('content-type'))
    check('full-accept-ranges', full.headers.get('accept-ranges') === 'bytes')
    check('full-bytes', Buffer.compare(full.buf, payload) === 0, 'len=' + full.buf.length)

    // 5. Range：开区间 / 后缀区间 / 416
    const r1 = await fetchBytes('friday-media://stack/0123456789abcdef.png', { Range: 'bytes=100-199' })
    check('range-206', r1.status === 206, r1.status)
    check('range-len', r1.buf.length === 100 && r1.headers.get('content-length') === '100')
    check('range-cr', r1.headers.get('content-range') === 'bytes 100-199/1000', r1.headers.get('content-range'))
    check('range-bytes', Buffer.compare(r1.buf, payload.subarray(100, 200)) === 0)
    const r2 = await fetchBytes('friday-media://stack/0123456789abcdef.png', { Range: 'bytes=950-' })
    check('range-open-end', r2.status === 206 && r2.buf.length === 50, r2.status + ' len=' + r2.buf.length)
    const r3 = await fetchBytes('friday-media://stack/0123456789abcdef.png', { Range: 'bytes=-30' })
    check('range-suffix', r3.status === 206 && r3.buf.length === 30 && Buffer.compare(r3.buf, payload.subarray(970)) === 0)
    const r4 = await fetchBytes('friday-media://stack/0123456789abcdef.png', { Range: 'bytes=2000-' })
    check('range-416', r4.status === 416, r4.status)

    // 6. 不存在的 / 越界的路径 → 404
    check('404-missing', (await fetchBytes('friday-media://stack/ffffffffffffffff.png')).status === 404)
    check('404-evil', (await fetchBytes('friday-media://stack/..%2F..%2Fsecret.png')).status === 404)
    check('404-empty', (await fetchBytes('friday-media://stack/')).status === 404)

    // 7. URL 代下载（http）：起个本地 http 服务喂一段，走 save({url})
    const http = require('node:http')
    const mp4 = Buffer.alloc(3000, 9)
    const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'video/mp4'); res.end(mp4) })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const saved2 = await m.saveStackMediaFile('fedcba9876543210.mp4', { url: 'http://127.0.0.1:' + port + '/x.mp4' })
    check('save-url', saved2 === 'fedcba9876543210.mp4', saved2)
    const v = await fetchBytes('friday-media://stack/fedcba9876543210.mp4')
    check('url-bytes', v.status === 200 && Buffer.compare(v.buf, mp4) === 0, 'status=' + v.status + ' len=' + v.buf.length)
    server.close()

    // 8. 删：按名字删，之后 404；列表不再含
    const del = await m.deleteStackMediaFiles(['0123456789abcdef.png', 'fedcba9876543210.mp4'])
    check('delete-count', del === 2, del)
    check('deleted-404', (await fetchBytes('friday-media://stack/0123456789abcdef.png')).status === 404)
    const list2 = await m.listStackMediaFiles()
    check('list-after-delete', !list2.includes('0123456789abcdef.png') && !list2.includes('fedcba9876543210.mp4'))

    // 9. 越权删除（路径样式的名字）不会真删盘上文件——名字白名单挡住，不会碰任意路径
    check('delete-bad-name', (await m.deleteStackMediaFiles(['..\\\\..\\\\secret.png'])) === 0)
  } catch (e) {
    console.log('EXCEPTION', e && e.stack)
    process.exitCode = 1
  } finally {
    const failed = results.filter(([, ok]) => !ok)
    console.log('RESULT', results.length - failed.length + '/' + results.length)
    app.exit(failed.length ? 1 : 0)
  }
})
`)

// 起 electron 跑测试 app
const run = spawnSync('npx.cmd', ['electron', '.'], { cwd: tmp, shell: true, env: { ...process.env, ELECTRON_NO_ATTACH_CONSOLE: '1' } })
const out = (run.stdout?.toString() ?? '') + (run.stderr?.toString() ?? '')
for (const line of out.split(/\r?\n/)) if (/RESULT|FAIL|EXCEPTION/.test(line)) console.log(line)
if (run.status !== 0) { console.log('electron exit:', run.status); process.exit(1) }
rmSync(tmp, { recursive: true, force: true })
console.log('mediastack e2e: OK')
