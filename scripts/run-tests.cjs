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
run('npx', ['esbuild', 'src/protocol/schat/SchatService.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/schatservice.cjs'])
run('npx', ['esbuild', 'src/protocol/work/WorkSignaling.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/worksignaling.cjs'])
run('npx', ['esbuild', 'src/protocol/session/MachineManager.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/machinemanager.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/workFramer.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/workframer.cjs'])
run('npx', ['esbuild', 'src/protocol/session/TargetParse.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/targetparse.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/voiceMedia.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/voicemedia.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/speechInput.ts', '--bundle', '--platform=node', '--format=cjs', '--external:electron', '--outfile=.tmp/speechinput.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/speechOutput.ts', '--bundle', '--platform=node', '--format=cjs', '--external:electron', '--outfile=.tmp/speechoutput.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/askUser.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/askuser.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/serviceUsage.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/serviceusage.cjs'])
run('npx', ['esbuild', 'src/shared/update.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/update.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/remoteDownload.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/remotedownload.cjs'])
run('npx', ['esbuild', 'src/main/ipc/Downloads.ts', '--bundle', '--platform=node', '--format=cjs', '--external:electron', '--outfile=.tmp/downloads-main.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/remoteUpload.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/remoteupload.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/builtinCommands.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/builtincommands.cjs'])
run('npx', ['esbuild', 'src/protocol/rpc/RpcClient.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/rpcclient.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/devices/rfc2217.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/rfc2217.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/devices/serialSession.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/serialsession.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/devices/serialPorts.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/serialports.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/devices/deviceParams.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/deviceparams.cjs'])
run('npx', ['esbuild', 'src/renderer/src/lib/devices/md5.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=.tmp/md5.cjs'])
run('node', ['--test', 'test/'])

rmSync(tmp, { recursive: true, force: true })
console.log('已清理 .tmp')