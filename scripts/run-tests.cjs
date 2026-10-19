// 跑协议核心逻辑的单元测试：先 esbuild 把 TS 源码打成 cjs（供 node --test require），跑完清理 .tmp。
// 用法：npm test

const { spawnSync } = require('node:child_process')
const { mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const tmp = join(root, '.tmp')
mkdirSync(tmp, { recursive: true })

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('npx', ['esbuild', 'src/protocol/rpc/MessagePatcher.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/patcher.cjs'])
run('npx', ['esbuild', 'src/protocol/schat/http.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/schathttp.cjs'])
run('npx', ['esbuild', 'src/protocol/rpc/protocol.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/protocol.cjs'])
run('npx', ['esbuild', 'src/protocol/rpc/ConversationPath.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/path.cjs'])
run('npx', ['esbuild', 'src/protocol/schat/Login.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/login.cjs'])
run('npx', ['esbuild', 'src/protocol/work/WorkSignaling.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/worksignaling.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/workFramer.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/workframer.cjs'])
run('npx', ['esbuild', 'src/protocol/session/TargetParse.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/targetparse.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/voiceMedia.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/voicemedia.cjs'])
run('npx', ['esbuild', 'src/shared/update.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/update.cjs'])
run('node', ['--test', 'test/'])

rmSync(tmp, { recursive: true, force: true })
console.log('已清理 .tmp')