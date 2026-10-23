// 「下载到本地」主进程一侧（src/main/ipc/Downloads.ts）：electron 用替身，真写临时目录。
// 锁住安全边界与落盘行为：相对路径越界（..）一律拒绝、Windows 非法字符清洗、同名不覆盖（加「 (2)」）、
// 同一新文件的块并发到达只开一次（不互相截断）、取消时只删本次新建的东西、用户原有文件不碰。
const test = require('node:test')
const assert = require('node:assert')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

// 打包时 electron 是 external：在这里把 require('electron') 指到替身上（同一个实例，测试能拿到登记的 handler）
const Module = require('node:module')
const electron = require('./electron-stub.cjs')
const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return electron
  return originalLoad.call(this, request, ...rest)
}
const { registerDownloadIpc } = require('../.tmp/downloads-main.cjs')

registerDownloadIpc(() => null)
const call = (channel, payload) => electron.__handlers.get(channel)({}, payload)

function tempDir() {
  return mkdtempSync(join(os.tmpdir(), 'friday-dl-test-'))
}

test('单个文件：写到「另存为」选的路径，乱序块拼回原样；成功后可定位', async () => {
  const dir = tempDir()
  const target = join(dir, 'out.bin')
  electron.__setDialog({ canceled: false, filePath: target })
  const session = await call('download:begin', { mode: 'file', suggestedName: 'x.bin', count: 1 })
  assert.ok(session?.id)
  const a = Buffer.from('hello ')
  const b = Buffer.from('world')
  // 后半块先到、两块并发
  await Promise.all([
    call('download:write', { id: session.id, rel: '', offset: a.length, data: new Uint8Array(b) }),
    call('download:write', { id: session.id, rel: '', offset: 0, data: new Uint8Array(a) })
  ])
  await call('download:close-file', { id: session.id, rel: '' })
  const reveal = await call('download:end', { id: session.id, ok: true })
  assert.equal(readFileSync(target, 'utf8'), 'hello world')
  assert.equal(reveal, target)
  assert.equal(await call('download:reveal', { id: session.id }), true)
  assert.equal(electron.__revealed.at(-1), target)
})

test('对话框取消：不开会话', async () => {
  electron.__setDialog({ canceled: true })
  assert.equal(await call('download:begin', { mode: 'dir', suggestedName: 'a', count: 2 }), null)
})

test('文件夹：按相对路径建结构；同名已存在时加「 (2)」不覆盖；越界路径拒绝', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'proj'))
  writeFileSync(join(dir, 'proj', 'keep.txt'), 'user file')
  electron.__setDialog({ canceled: false, filePaths: [dir] })
  const session = await call('download:begin', { mode: 'dir', suggestedName: 'proj', count: 1 })
  const write = (rel, text, offset = 0) => call('download:write', { id: session.id, rel, offset, data: new Uint8Array(Buffer.from(text)) })
  // 同一个新文件的几块并发到达（首块打开文件的竞争）
  await Promise.all([write('proj/src/a.txt', 'BBBB', 4), write('proj/src/a.txt', 'AAAA', 0), write('proj/src/a.txt', 'CC', 8)])
  await call('download:close-file', { id: session.id, rel: 'proj/src/a.txt' })
  await call('download:mkdir', { id: session.id, rel: 'proj/empty' })
  // 越界：.. 被清洗成普通名字段，绝不会写到所选文件夹外面
  assert.equal(await write('../escape.txt', 'x'), true)
  await call('download:close-file', { id: session.id, rel: '../escape.txt' })
  assert.equal(existsSync(join(dir, '..', 'escape.txt')), false, '没有写到所选文件夹外面')
  // Windows 非法字符清洗
  await write('proj/we:ird*name?.txt', 'ok')
  await call('download:close-file', { id: session.id, rel: 'proj/we:ird*name?.txt' })
  await call('download:end', { id: session.id, ok: true })

  assert.equal(readFileSync(join(dir, 'proj', 'keep.txt'), 'utf8'), 'user file', '原有文件夹没被动')
  const got = join(dir, 'proj (2)')
  assert.equal(readFileSync(join(got, 'src', 'a.txt'), 'utf8'), 'AAAABBBBCC', '并发块拼回原样')
  assert.ok(existsSync(join(got, 'empty')), '空目录建出来了')
  assert.ok(existsSync(join(got, 'we_ird_name_.txt')), '非法字符换成 _')
})

test('取消：删掉本次新建的东西，所选文件夹里原有的不碰', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'mine.txt'), 'keep me')
  electron.__setDialog({ canceled: false, filePaths: [dir] })
  const session = await call('download:begin', { mode: 'dir', suggestedName: 'big', count: 1 })
  await call('download:write', { id: session.id, rel: 'big/part.bin', offset: 0, data: new Uint8Array(1024) })
  await call('download:end', { id: session.id, ok: false })
  assert.deepEqual(readdirSync(dir).sort(), ['mine.txt'], '半成品删掉了，原有文件还在')
  assert.equal(await call('download:write', { id: session.id, rel: 'big/x', offset: 0, data: new Uint8Array(1) }), false, '会话结束后不能再写')
})

test('单个文件取消：删掉目标文件', async () => {
  const dir = tempDir()
  const target = join(dir, 'half.bin')
  electron.__setDialog({ canceled: false, filePath: target })
  const session = await call('download:begin', { mode: 'file', suggestedName: 'half.bin', count: 1 })
  await call('download:write', { id: session.id, rel: '', offset: 0, data: new Uint8Array(10) })
  await call('download:end', { id: session.id, ok: false })
  assert.equal(existsSync(target), false)
})
