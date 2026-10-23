// 文件管理器拖放上传（lib/remoteUpload.ts）：file.upload 先落到服务端 Uploads/<uuid>/，再用一条命令挪进目标目录。
// 锁住：重名加「 (2)」不覆盖（Windows 不分大小写）、命令拼装与引号转义、只清理 Uploads/<uuid> 这种空壳、
// 命令按长度分批；挪文件出错 / 用户取消时清掉已经传上去的；最后在本机真跑一遍拼出来的命令
// （Windows 用 PowerShell，其他用 sh），确认中文 / 空格 / 单引号名字都能原样落到位、空目录建出来、空壳删干净。
const test = require('node:test')
const assert = require('node:assert')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const os = require('node:os')

const { uniqueName, buildPlaceCommands, buildCleanupCommand, uploadShellDir, uploadToRemote, cancelUpload, uploadJobs } = require('../.tmp/remoteupload.cjs')

test('重名：加「 (n)」，扩展名保留；Windows 不分大小写', () => {
  const taken = new Set(['report.pdf', 'docs'])
  assert.equal(uniqueName('Report.pdf', taken, true), 'Report (2).pdf')
  assert.equal(uniqueName('Report.pdf', taken, true), 'Report (3).pdf', '第二个再往后排')
  assert.equal(uniqueName('docs', taken, true), 'docs (2)')
  assert.equal(uniqueName('new.txt', taken, true), 'new.txt')
  const strict = new Set(['A.txt'])
  assert.equal(uniqueName('a.txt', strict, false), 'a.txt', '类 Unix 区分大小写')
})

test('Uploads 空壳：只认最后一级是 uuid 的目录', () => {
  assert.equal(uploadShellDir('C:/x/Friday/Uploads/4cb778cb-c0fc-40d0-a630-36ea762abe70/a.txt'), 'C:/x/Friday/Uploads/4cb778cb-c0fc-40d0-a630-36ea762abe70')
  assert.equal(uploadShellDir('C:/Users/me/Desktop/a.txt'), null, '不像 uuid 的目录绝不删')
  assert.equal(uploadShellDir('/home/u/.friday/uploads/0f5cddd2-05d4-4b1a-9c1a-1234567890ab/x'), '/home/u/.friday/uploads/0f5cddd2-05d4-4b1a-9c1a-1234567890ab')
})

test('命令拼装：PowerShell 单引号转义、先建目录再挪、带清理；sh 用 \'\\\'\' 转义', () => {
  const from = 'C:/U/Uploads/4cb778cb-c0fc-40d0-a630-36ea762abe70/it\'s.txt'
  const ps = buildPlaceCommands('powershell', [{ from, to: 'C:/T/a b/it\'s.txt' }], ['C:/T/empty'])
  assert.equal(ps.length, 1)
  assert.match(ps[0], /^\$ErrorActionPreference='Stop'/)
  assert.ok(ps[0].includes(`Move-Item -LiteralPath 'C:/U/Uploads/4cb778cb-c0fc-40d0-a630-36ea762abe70/it''s.txt' -Destination 'C:/T/a b/it''s.txt'`))
  assert.ok(ps[0].indexOf("New-Item -ItemType Directory -Force -Path 'C:/T/a b'") < ps[0].indexOf('Move-Item'), '目录在挪之前建')
  assert.ok(ps[0].includes("-Path 'C:/T/empty'"), '空目录也建')
  assert.ok(ps[0].includes("Remove-Item -LiteralPath 'C:/U/Uploads/4cb778cb-c0fc-40d0-a630-36ea762abe70'"), '删空壳')
  const sh = buildPlaceCommands('posix', [{ from: '/u/Uploads/4cb778cb-c0fc-40d0-a630-36ea762abe70/it\'s', to: '/t/it\'s' }], [])
  assert.ok(sh[0].startsWith('set -e'))
  assert.ok(sh[0].includes(`mv -f -- '/u/Uploads/4cb778cb-c0fc-40d0-a630-36ea762abe70/it'\\''s' '/t/it'\\''s'`))
})

test('命令按长度分批：每条都不超过上限、各自带开头的出错即停', () => {
  const moves = Array.from({ length: 400 }, (_, i) => ({
    from: `C:/Users/me/AppData/Roaming/Friday/Uploads/${randomUUID()}/file-${i}.txt`,
    to: `C:/Users/me/Desktop/target/sub/file-${i}.txt`
  }))
  const cmds = buildPlaceCommands('powershell', moves, [])
  assert.ok(cmds.length > 1, '分了好几条')
  for (const cmd of cmds) {
    assert.ok(cmd.length <= 7000, `长度 ${cmd.length}`)
    assert.match(cmd, /^\$ErrorActionPreference='Stop'; /)
  }
  const all = cmds.join('\n')
  for (let i = 0; i < 400; i += 1) assert.ok(all.includes(`file-${i}.txt' -Destination`), `第 ${i} 个在`)
})

function fakeIO({ failExit = null } = {}) {
  const uploads = []
  const commands = []
  return {
    uploads,
    commands,
    async upload(handle) {
      uploads.push(handle)
      return `/srv/Uploads/${randomUUID()}/${handle}`
    },
    async run(command) {
      commands.push(command)
      return failExit != null && command.includes('mv -f') ? { exitCode: failExit, output: 'mv: cannot move: Permission denied' } : { exitCode: 0, output: '' }
    }
  }
}

test('编排：重名的顶层改名、目录结构跟着改、空目录保留、完成后记下落地的名字', async () => {
  const io = fakeIO()
  const job = await uploadToRemote({
    targetDir: '/home/u/work',
    flavor: 'posix',
    existing: ['proj', 'notes.md'],
    trees: [
      {
        name: 'proj',
        files: [
          { handle: 'h1', rel: 'proj/a.ts', size: 10 },
          { handle: 'h2', rel: 'proj/src/b.ts', size: 20 }
        ],
        dirs: ['proj/empty'],
        truncated: false
      },
      { name: 'notes.md', files: [{ handle: 'h3', rel: 'notes.md', size: 5 }], dirs: [], truncated: false }
    ],
    io
  })
  assert.equal(job.phase, 'done')
  assert.deepEqual(job.placed, ['proj (2)', 'notes (2).md'])
  assert.deepEqual(io.uploads, ['h1', 'h2', 'h3'])
  assert.equal(job.bytesDone, 35)
  const all = io.commands.join('\n')
  assert.ok(all.includes("'/home/u/work/proj (2)/src/b.ts'"))
  assert.ok(all.includes("mkdir -p -- '/home/u/work/proj (2)/empty'"))
  assert.ok(all.includes("'/home/u/work/notes (2).md'"))
  assert.ok(!all.includes("'/home/u/work/proj/"), '没有写进原来那个同名目录')
})

test('挪文件出错：任务失败带上输出，已经传上去的空壳清掉', async () => {
  const io = fakeIO({ failExit: 1 })
  const job = await uploadToRemote({
    targetDir: '/t',
    flavor: 'posix',
    existing: [],
    trees: [{ name: 'a.txt', files: [{ handle: 'a.txt', rel: 'a.txt', size: 1 }], dirs: [], truncated: false }],
    io
  })
  assert.equal(job.phase, 'failed')
  assert.match(job.error, /退出码 1.*Permission denied/)
  assert.ok(io.commands.at(-1).startsWith('rm -rf -- '), '最后跑了清理')
})

test('取消：停止后续上传，清掉已传的，任务标已取消', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const io = fakeIO()
  const originalUpload = io.upload
  io.upload = async (handle) => {
    if (handle === 'h2') await gate
    return originalUpload(handle)
  }
  const pending = uploadToRemote({
    targetDir: '/t',
    flavor: 'posix',
    existing: [],
    trees: [
      {
        name: 'dir',
        files: [1, 2, 3].map((n) => ({ handle: `h${n}`, rel: `dir/f${n}`, size: 1 })),
        dirs: [],
        truncated: false
      }
    ],
    io
  })
  while (!uploadJobs[0] || uploadJobs[0].filesDone < 1) await new Promise((resolve) => setTimeout(resolve, 1))
  cancelUpload(uploadJobs[0])
  release()
  const job = await pending
  assert.equal(job.phase, 'canceled')
  assert.deepEqual(io.uploads, ['h1', 'h2'], 'h3 没再传')
  assert.equal(io.commands.length, 1)
  assert.ok(io.commands[0].startsWith('rm -rf -- '), '只跑了清理，没往目标目录挪')
})

test('本机真跑一遍拼出来的命令：中文 / 空格 / 单引号名字落到位、空目录建出来、空壳删干净', async (t) => {
  const isWin = process.platform === 'win32'
  const shell = isWin ? 'powershell' : 'sh'
  const probe = spawnSync(shell, isWin ? ['-NoProfile', '-Command', 'exit 0'] : ['-c', 'exit 0'])
  if (probe.status !== 0) {
    t.skip(`本机没有 ${shell}`)
    return
  }
  const root = mkdtempSync(join(os.tmpdir(), 'friday-up-test-'))
  const uploads = join(root, 'Uploads')
  const target = join(root, '目标 dir')
  mkdirSync(target)
  writeFileSync(join(target, '报告.txt'), 'old')
  const names = ["它's 文件.txt", '报告.txt', 'plain.bin']
  const shells = []
  const io = {
    async upload(handle) {
      const dir = join(uploads, randomUUID())
      mkdirSync(dir, { recursive: true })
      const name = handle.split('|')[1]
      writeFileSync(join(dir, name), `content of ${handle}`)
      shells.push(dir)
      return join(dir, name).replace(/\\/g, '/')
    },
    async run(command) {
      const result = isWin
        ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
        : spawnSync('sh', ['-c', command], { encoding: 'utf8' })
      return { exitCode: result.status ?? undefined, output: `${result.stdout}${result.stderr}` }
    }
  }
  const job = await uploadToRemote({
    targetDir: target.replace(/\\/g, '/'),
    flavor: isWin ? 'powershell' : 'posix',
    existing: readdirSync(target),
    trees: [
      { name: '文件 夹', files: [{ handle: `a|${names[0]}`, rel: `文件 夹/子 目录/${names[0]}`, size: 1 }], dirs: ['文件 夹/空目录'], truncated: false },
      { name: names[1], files: [{ handle: `b|${names[1]}`, rel: names[1], size: 1 }], dirs: [], truncated: false },
      { name: names[2], files: [{ handle: `c|${names[2]}`, rel: names[2], size: 1 }], dirs: [], truncated: false }
    ],
    io
  })
  assert.equal(job.phase, 'done', job.error)
  assert.equal(readFileSync(join(target, '文件 夹', '子 目录', names[0]), 'utf8'), `content of a|${names[0]}`)
  assert.ok(existsSync(join(target, '文件 夹', '空目录')), '空目录建出来了')
  assert.equal(readFileSync(join(target, '报告.txt'), 'utf8'), 'old', '原有同名文件没被覆盖')
  assert.equal(readFileSync(join(target, '报告 (2).txt'), 'utf8'), `content of b|${names[1]}`)
  assert.equal(readFileSync(join(target, 'plain.bin'), 'utf8'), `content of c|${names[2]}`)
  for (const dir of shells) assert.equal(existsSync(dir), false, 'Uploads 空壳删干净')
  assert.equal(buildCleanupCommand('posix', []), null)
})
