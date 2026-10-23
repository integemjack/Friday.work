// 文件管理器「下载到本地」（lib/remoteDownload.ts）：远端用假的 fs.list / fs.read，本地用内存里的「主进程会话」。
// 锁住：分块并发读 + 按偏移写拼回的字节和原文件逐字节一致；服务端单次回得比要的少（不足 1 MB）也不留洞；
// 列表里的大小过时（文件比列表大）也读到 eof；空文件、空目录照样落地；文件夹递归保留结构；
// 对话框取消不建任务；中途取消 / 读失败时会话以 ok=false 收尾（主进程据此删半成品）。
const test = require('node:test')
const assert = require('node:assert')

// host.ts 在 import 时就会挂 message 监听、要端口：给个最小的 window 让它安静地起来（这里用不到真 rpc）
globalThis.window = { addEventListener() {}, fridayRequestPort() {} }

const { downloadToLocal, cancelDownload, downloadJobs } = require('../.tmp/remotedownload.cjs')

/** 确定性的「文件内容」：第 i 个字节 = (i * 31 + seed) & 0xff */
function bytesOf(size, seed) {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + seed) & 0xff
  return out
}

/** 假远端：tree 是 { path: Uint8Array | { dir: true, children: [name...] } }；
 *  maxRead 模拟服务端单次最多回多少字节；listSize 可以让列表里报的大小和实际不一致 */
function fakeRemote(tree, { maxRead = Infinity, listSize = {}, failRead = null } = {}) {
  const reads = []
  return {
    reads,
    async list(_machine, path) {
      const node = tree[path]
      if (!node || !node.dir) throw new Error(`没有这个目录：${path}`)
      return {
        path,
        entries: node.children.map((name) => {
          const child = `${path}/${name}`
          const value = tree[child]
          return value.dir
            ? { name, path: child, dir: true }
            : { name, path: child, size: listSize[child] ?? value.byteLength }
        })
      }
    },
    async read(_machine, path, offset, length) {
      if (failRead && failRead(path, offset)) throw new Error('读不了这个文件')
      const data = tree[path]
      if (!(data instanceof Uint8Array)) throw new Error(`读不了这个文件：${path}`)
      reads.push({ path, offset, length })
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 3)) // 让并发的块乱序回来
      const end = Math.min(data.byteLength, offset + Math.min(length, maxRead))
      const slice = data.subarray(Math.min(offset, data.byteLength), end)
      return { data: Buffer.from(slice).toString('base64'), size: data.byteLength, eof: end >= data.byteLength }
    }
  }
}

/** 内存里的主进程下载会话：记下按偏移写入的结果、建过的目录、收尾时的 ok */
function fakeSink({ cancelDialog = false } = {}) {
  const state = { files: new Map(), dirs: [], ended: null, begun: null, closed: [] }
  return {
    state,
    async downloadBegin(mode, suggestedName, count) {
      state.begun = { mode, suggestedName, count }
      return cancelDialog ? null : { id: 'session-1', target: '/tmp/target' }
    },
    async downloadWrite(_id, rel, offset, data) {
      const key = rel || '<file>'
      const prev = state.files.get(key) ?? new Uint8Array(0)
      const next = new Uint8Array(Math.max(prev.byteLength, offset + data.byteLength))
      next.set(prev)
      next.set(data, offset)
      state.files.set(key, next)
      return true
    },
    async downloadCloseFile(_id, rel) {
      const key = rel || '<file>'
      if (!state.files.has(key)) state.files.set(key, new Uint8Array(0))
      state.closed.push(key)
      return true
    },
    async downloadMkdir(_id, rel) {
      state.dirs.push(rel)
      return true
    },
    async downloadEnd(_id, ok) {
      state.ended = ok
      return ok ? '/tmp/target' : null
    }
  }
}

test('单个大文件：分块并发读、乱序按偏移写，拼回来逐字节一致；对话框走「另存为」', async () => {
  const big = bytesOf(3 * 1024 * 1024 + 12345, 7)
  const remote = fakeRemote({ '/r/big.bin': big })
  const sink = fakeSink()
  const job = await downloadToLocal('m', [{ name: 'big.bin', path: '/r/big.bin', size: big.byteLength }], { ...remote, sink })
  assert.equal(job.phase, 'done')
  assert.deepEqual(sink.state.begun, { mode: 'file', suggestedName: 'big.bin', count: 1 })
  assert.equal(sink.state.ended, true)
  assert.ok(Buffer.from(sink.state.files.get('<file>')).equals(Buffer.from(big)), '内容一致')
  assert.equal(job.bytesDone, big.byteLength)
  assert.equal(job.bytesTotal, big.byteLength)
})

test('服务端单次只回 300 KB：每块自己读满，不留洞', async () => {
  const data = bytesOf(2 * 1024 * 1024 + 99, 3)
  const remote = fakeRemote({ '/r/a.bin': data }, { maxRead: 300 * 1024 })
  const sink = fakeSink()
  const job = await downloadToLocal('m', [{ name: 'a.bin', path: '/r/a.bin', size: data.byteLength }], { ...remote, sink })
  assert.equal(job.phase, 'done')
  assert.ok(Buffer.from(sink.state.files.get('<file>')).equals(Buffer.from(data)))
})

test('列表里的大小过时（文件比列表大 / 大小未知）：也读到 eof', async () => {
  const data = bytesOf(1024 * 1024 * 2 + 5, 11)
  for (const reported of [1024 * 1024, 0]) {
    const remote = fakeRemote({ '/r/grow.log': data })
    const sink = fakeSink()
    const job = await downloadToLocal('m', [{ name: 'grow.log', path: '/r/grow.log', size: reported }], { ...remote, sink })
    assert.equal(job.phase, 'done', `报 ${reported}`)
    assert.ok(Buffer.from(sink.state.files.get('<file>')).equals(Buffer.from(data)), `报 ${reported} 时内容一致`)
  }
})

test('文件夹：递归保留结构，空文件落成 0 字节，空目录也建出来；选文件夹对话框', async () => {
  const tree = {
    '/r/proj': { dir: true, children: ['README.md', 'src', 'empty', 'zero.txt'] },
    '/r/proj/README.md': bytesOf(1500, 1),
    '/r/proj/src': { dir: true, children: ['main.ts', 'deep'] },
    '/r/proj/src/main.ts': bytesOf(1024 * 1024 + 1, 2),
    '/r/proj/src/deep': { dir: true, children: ['x.json'] },
    '/r/proj/src/deep/x.json': bytesOf(10, 9),
    '/r/proj/empty': { dir: true, children: [] },
    '/r/proj/zero.txt': new Uint8Array(0)
  }
  const remote = fakeRemote(tree)
  const sink = fakeSink()
  const job = await downloadToLocal('m', [{ name: 'proj', path: '/r/proj', dir: true }], { ...remote, sink })
  assert.equal(job.phase, 'done')
  assert.equal(sink.state.begun.mode, 'dir')
  assert.equal(job.filesTotal, 4)
  assert.equal(job.filesDone, 4)
  assert.deepEqual(sink.state.dirs, ['proj/empty'])
  for (const [rel, path] of [
    ['proj/README.md', '/r/proj/README.md'],
    ['proj/src/main.ts', '/r/proj/src/main.ts'],
    ['proj/src/deep/x.json', '/r/proj/src/deep/x.json'],
    ['proj/zero.txt', '/r/proj/zero.txt']
  ]) {
    assert.ok(sink.state.files.has(rel), `有 ${rel}`)
    assert.ok(Buffer.from(sink.state.files.get(rel)).equals(Buffer.from(tree[path])), `${rel} 内容一致`)
  }
})

test('多选几个文件：走选文件夹对话框，各自按名字落地', async () => {
  const tree = { '/r/a.txt': bytesOf(100, 1), '/r/b.txt': bytesOf(200, 2) }
  const remote = fakeRemote(tree)
  const sink = fakeSink()
  const job = await downloadToLocal(
    'm',
    [
      { name: 'a.txt', path: '/r/a.txt', size: 100 },
      { name: 'b.txt', path: '/r/b.txt', size: 200 }
    ],
    { ...remote, sink }
  )
  assert.equal(job.phase, 'done')
  assert.equal(sink.state.begun.mode, 'dir')
  assert.equal(sink.state.begun.count, 2)
  assert.ok(Buffer.from(sink.state.files.get('a.txt')).equals(Buffer.from(tree['/r/a.txt'])))
  assert.ok(Buffer.from(sink.state.files.get('b.txt')).equals(Buffer.from(tree['/r/b.txt'])))
})

test('对话框里点了取消：不建任务、不读远端', async () => {
  const remote = fakeRemote({ '/r/a.txt': bytesOf(100, 1) })
  const sink = fakeSink({ cancelDialog: true })
  const before = downloadJobs.length
  const job = await downloadToLocal('m', [{ name: 'a.txt', path: '/r/a.txt', size: 100 }], { ...remote, sink })
  assert.equal(job, null)
  assert.equal(downloadJobs.length, before)
  assert.equal(remote.reads.length, 0)
})

test('读到一半失败：任务标失败、会话以 ok=false 收尾（主进程删半成品）', async () => {
  const data = bytesOf(3 * 1024 * 1024, 5)
  const remote = fakeRemote({ '/r/a.bin': data }, { failRead: (_path, offset) => offset >= 2 * 1024 * 1024 })
  const sink = fakeSink()
  const job = await downloadToLocal('m', [{ name: 'a.bin', path: '/r/a.bin', size: data.byteLength }], { ...remote, sink })
  assert.equal(job.phase, 'failed')
  assert.match(job.error, /读不了/)
  assert.equal(sink.state.ended, false)
})

test('用户取消：停在半路，任务标已取消，会话以 ok=false 收尾', async () => {
  const data = bytesOf(8 * 1024 * 1024, 4)
  const remote = fakeRemote({ '/r/huge.bin': data })
  const sink = fakeSink()
  const pending = downloadToLocal('m', [{ name: 'huge.bin', path: '/r/huge.bin', size: data.byteLength }], { ...remote, sink })
  // 等任务出现在列表里、开始读之后再取消
  while (!downloadJobs[0] || downloadJobs[0].bytesDone === 0) await new Promise((resolve) => setTimeout(resolve, 1))
  cancelDownload(downloadJobs[0])
  const job = await pending
  assert.equal(job.phase, 'canceled')
  assert.equal(sink.state.ended, false)
  assert.ok(job.bytesDone < data.byteLength, '没读完就停了')
})
