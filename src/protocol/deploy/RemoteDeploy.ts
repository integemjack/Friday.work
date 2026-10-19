// 自动安装 / 升级远程的 friday-server（方案 §10 M4；REMOTE.md §9）。
//
// 远程布局：~/.friday-server/versions/<版本>/ 是解开的包，~/.friday-server/bin 指向当前版本的 bin/
// （Linux 符号链接、Windows 目录联接）。换版本只是把 bin 指到别处，在跑的常驻进程不受影响。
//
// 流程：探测（uname / bin 在不在 / 装了哪些版本）→ 从 latest.json 取服务端包（assets["<平台>-<架构>"].server）
// → 下到本机缓存并核对 SHA-256 → 经 ssh / wsl 的标准输入把 tar.gz 流过去，远程 tar 解到 versions/<版本>/
// → 跑一次 --version 核对能跑 → 切换 bin → 清掉旧版本。

import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface DeployReport {
  system: string
  machine: string
  installed: string[]
  hasBin: boolean
  installedVersion: string
  switched: boolean
  busy: boolean
  failure: string
}

export interface ServerPackage {
  name: string
  url: string
  sha256: string
  size: number
  version: string
  protocol: number
}

export type DeployTarget =
  | { kind: 'ssh'; host: string; port?: number; identityFile?: string }
  | { kind: 'wsl'; distro?: string }

const MANIFEST_URLS = [
  process.env.FRIDAY_SERVER_MANIFEST || '',
  'https://raw.githubusercontent.com/integemjack/Friday.build/main/latest.json',
  'https://cdn.jsdelivr.net/gh/integemjack/Friday.build@main/latest.json'
].filter(Boolean)

// MARK: 远程脚本（与 Qt RemoteDeploy.cpp 逐字对齐；只用 ASCII，不含单引号）

const POSIX_INSPECT = `echo "FRIDAY-DEPLOY uname $(uname -s) $(uname -m)"
if [ -f "$HOME/.friday-server/bin/friday-server" ]; then echo "FRIDAY-DEPLOY bin yes"; else echo "FRIDAY-DEPLOY bin no"; fi
for x in "$HOME"/.friday-server/versions/*/bin/friday-server; do
  [ -f "$x" ] || continue
  n="\${x%/bin/friday-server}"; echo "FRIDAY-DEPLOY has \${n##*/}"
done
exit 0`

const POSIX_DEPLOY = `d="$HOME/.friday-server"; v="@VERSION@"; k="@KEEP@"; t="$d/versions/$v"
mkdir -p "$d/versions" || { echo "FRIDAY-DEPLOY fail mkdir"; exit 1; }
if [ "@UPLOAD@" = 1 ]; then
  rm -rf "$t.part" && mkdir -p "$t.part" || { echo "FRIDAY-DEPLOY fail mkdir"; exit 1; }
  tar -xzf - -C "$t.part" || { rm -rf "$t.part"; echo "FRIDAY-DEPLOY fail extract"; exit 1; }
  [ -f "$t.part/friday-server/bin/friday-server" ] || { rm -rf "$t.part"; echo "FRIDAY-DEPLOY fail layout"; exit 1; }
  chmod +x "$t.part/friday-server/bin/friday-server"
  if ! o="$("$t.part/friday-server/bin/friday-server" --version 2>&1)"; then
    rm -rf "$t.part"; echo "FRIDAY-DEPLOY fail run $(printf %s "$o" | tr -s "\\n" " " | head -c 600)"; exit 1
  fi
  { rm -rf "$t" && mv "$t.part/friday-server" "$t" && rm -rf "$t.part"; } || { echo "FRIDAY-DEPLOY fail move"; exit 1; }
fi
[ -f "$t/bin/friday-server" ] || { echo "FRIDAY-DEPLOY fail layout"; exit 1; }
o="$("$t/bin/friday-server" --version 2>&1)" || { echo "FRIDAY-DEPLOY fail run $(printf %s "$o" | tr -s "\\n" " " | head -c 600)"; exit 1; }
echo "FRIDAY-DEPLOY installed $o"
if [ -d "$d/bin" ] && [ ! -L "$d/bin" ]; then
  if [ -n "$k" ] && [ ! -e "$d/versions/$k" ]; then
    mkdir -p "$d/versions/$k" && mv "$d/bin" "$d/versions/$k/bin"
  else
    mv "$d/bin" "$d/versions/old-$$"
  fi || { echo "FRIDAY-DEPLOY busy"; exit 0; }
fi
ln -sfn "versions/$v/bin" "$d/bin" || { echo "FRIDAY-DEPLOY busy"; exit 0; }
echo "FRIDAY-DEPLOY switched"
for x in "$d"/versions/*; do
  n="\${x##*/}"
  [ "$n" = "$v" ] || [ "$n" = "$k" ] || [ "$n" = "*" ] || rm -rf "$x"
done
exit 0`

const WINDOWS_INSPECT = `$vs = Join-Path $env:USERPROFILE '.friday-server\\versions'
"FRIDAY-DEPLOY uname Windows $env:PROCESSOR_ARCHITECTURE"
if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.friday-server\\bin\\friday-server.exe')) { 'FRIDAY-DEPLOY bin yes' } else { 'FRIDAY-DEPLOY bin no' }
if (Test-Path -LiteralPath $vs) {
  Get-ChildItem -LiteralPath $vs -Directory | ForEach-Object {
    if (Test-Path -LiteralPath (Join-Path $_.FullName 'bin\\friday-server.exe')) { "FRIDAY-DEPLOY has $($_.Name)" }
  }
}
exit 0`

const WINDOWS_DEPLOY = `$d = Join-Path $env:USERPROFILE '.friday-server'; $v = '@VERSION@'; $k = '@KEEP@'
$vs = Join-Path $d 'versions'; $t = Join-Path $vs $v; $p = "$t.part"
function Fail($m) { "FRIDAY-DEPLOY fail $m"; exit 1 }
function Version($exe) {
  $o = (& $exe --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { if ($o.Length -gt 600) { $o = $o.Substring(0, 600) }; Fail "run $o (exit $LASTEXITCODE)" }
  return $o
}
try { New-Item -ItemType Directory -Force -Path $vs -ErrorAction Stop | Out-Null } catch { Fail 'mkdir' }
if ('@UPLOAD@' -eq '1') {
  try {
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop }
    New-Item -ItemType Directory -Force -Path $p -ErrorAction Stop | Out-Null
  } catch { Fail 'mkdir' }
  & "$env:SystemRoot\\System32\\tar.exe" -xzf - -C $p
  if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; Fail 'extract' }
  $e = Join-Path $p 'friday-server\\bin\\friday-server.exe'
  if (-not (Test-Path -LiteralPath $e)) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; Fail 'layout' }
  $null = Version $e
  try {
    if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction Stop }
    Move-Item -LiteralPath (Join-Path $p 'friday-server') -Destination $t -ErrorAction Stop
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
  } catch { Fail 'move' }
}
$e = Join-Path $t 'bin\\friday-server.exe'
if (-not (Test-Path -LiteralPath $e)) { Fail 'layout' }
"FRIDAY-DEPLOY installed $(Version $e)"
$b = Join-Path $d 'bin'
try {
  $i = Get-Item -LiteralPath $b -Force -ErrorAction SilentlyContinue
  if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    [IO.Directory]::Delete($b)
  } elseif ($i) {
    if ($k -and -not (Test-Path -LiteralPath (Join-Path $vs $k))) {
      New-Item -ItemType Directory -Path (Join-Path $vs $k) -ErrorAction Stop | Out-Null
      Move-Item -LiteralPath $b -Destination (Join-Path $vs "$k\\bin") -ErrorAction Stop
    } else {
      Move-Item -LiteralPath $b -Destination (Join-Path $vs "old-$PID") -ErrorAction Stop
    }
  }
  New-Item -ItemType Junction -Path $b -Target (Join-Path $t 'bin') -ErrorAction Stop | Out-Null
} catch { 'FRIDAY-DEPLOY busy'; exit 0 }
'FRIDAY-DEPLOY switched'
Get-ChildItem -LiteralPath $vs -Directory | Where-Object { $_.Name -ne $v -and $_.Name -ne $k } | ForEach-Object {
  $x = $_.FullName
  try { Rename-Item -LiteralPath $x -NewName "$($_.Name).del" -ErrorAction Stop; Remove-Item -LiteralPath "$x.del" -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}
exit 0`

// MARK: 解析与执行

export function parseDeployReport(output: string): DeployReport {
  const report: DeployReport = {
    system: '',
    machine: '',
    installed: [],
    hasBin: false,
    installedVersion: '',
    switched: false,
    busy: false,
    failure: ''
  }
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf('FRIDAY-DEPLOY ')
    if (at < 0) continue
    const body = line.slice(at + 'FRIDAY-DEPLOY '.length).trim()
    if (body.startsWith('uname ')) {
      const parts = body.slice('uname '.length).split(/\s+/)
      report.system = parts[0] ?? ''
      report.machine = parts[1] ?? ''
    } else if (body === 'bin yes') {
      report.hasBin = true
    } else if (body === 'bin no') {
      report.hasBin = false
    } else if (body.startsWith('has ')) {
      report.installed.push(body.slice(4).trim())
    } else if (body.startsWith('installed ')) {
      report.installedVersion = body.slice('installed '.length).trim()
    } else if (body === 'switched') {
      report.switched = true
    } else if (body === 'busy') {
      report.busy = true
    } else if (body.startsWith('fail ')) {
      report.failure = body.slice('fail '.length).trim()
    }
  }
  return report
}

/** 平台键：uname/架构 → latest.json 里的 assets 键 */
export function platformKey(system: string, machine: string): string {
  const arch = /arm64|aarch64/i.test(machine) ? 'arm64' : 'x64'
  if (/Darwin/i.test(system)) return `macos-${arch}`
  if (/Windows|AMD64|ARM64/i.test(system)) return `windows-${arch}`
  if (/Linux/i.test(system)) return `linux-${arch}`
  return ''
}

/** 把脚本包成一条远程命令（posix：sh -c '…'；windows：powershell -EncodedCommand） */
function remoteCommand(script: string, windows: boolean): string {
  if (!windows) {
    // 脚本里不能有单引号（与 Qt 一致），整段放进 sh -c '…'
    return `sh -c '${script}'`
  }
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `chcp 65001 >NUL 2>NUL & powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`
}

function sshInvocation(target: DeployTarget): { command: string; args: string[]; shellWindows: boolean } {
  if (target.kind === 'wsl') {
    const args = target.distro ? ['-d', target.distro] : []
    return { command: 'wsl.exe', args: [...args, '--', 'sh', '-c', 'true'], shellWindows: false }
  }
  const args = [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'StrictHostKeyChecking=accept-new',
    ...(target.port ? ['-p', String(target.port)] : []),
    ...(target.identityFile ? ['-i', target.identityFile] : []),
    target.host,
    'sh'
  ]
  return { command: 'ssh.exe', args, shellWindows: /^[A-Za-z]:|\.exe$/i.test(target.host) }
}

/** 跑一段远程命令；stdin 可选（部署时把 tar.gz 流过去） */
function runRemote(
  target: DeployTarget,
  script: string,
  options: { windows: boolean; stdinFile?: string; timeout?: number }
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const invocation = sshInvocation(target)
    // WSL / Windows 目标：把脚本作为 sh -c 的参数传（不经过 cmd 的引号规则）
    let command = invocation.command
    let args: string[]
    if (target.kind === 'wsl') {
      const prefix = target.distro ? ['-d', target.distro] : []
      args = [...prefix, '--', 'sh', '-c', script]
    } else {
      args = [...invocation.args.slice(0, -1), remoteCommand(script, options.windows)]
    }

    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      output += chunk
    })
    child.on('error', reject)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('远程命令超时'))
    }, options.timeout ?? 600_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })

    if (options.stdinFile) {
      void pipeline(createReadStream(options.stdinFile), child.stdin).catch(() => {
        // 远程提前退出时 stdin 写入会失败，交给 exit 的结果判断
      })
    } else {
      child.stdin.end()
    }
  })
}

export async function inspectRemote(target: DeployTarget, windows: boolean): Promise<DeployReport> {
  const result = await runRemote(target, windows ? WINDOWS_INSPECT : POSIX_INSPECT, { windows, timeout: 60_000 })
  return parseDeployReport(result.output)
}

type ReleaseEntryShape = { assets?: Record<string, { server?: ServerPackage }> }

type ManifestShape = { stable?: ReleaseEntryShape; beta?: ReleaseEntryShape }

/** 从 latest.json 取这台远程机器要用的服务端包（正式版优先，没有再看 Beta） */
export async function fetchServerPackage(
  key: string,
  cacheDir: string,
  protocol: number
): Promise<ServerPackage | null> {
  let manifest: ManifestShape | null = null
  let lastError = ''
  for (const url of MANIFEST_URLS) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      manifest = (await response.json()) as ManifestShape
      break
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  if (!manifest) throw new Error(`读不到 latest.json：${lastError}`)

  for (const entry of [manifest.stable, manifest.beta]) {
    const server = entry?.assets?.[key]?.server
    if (server && (server.protocol === protocol || protocol === 0)) return server
  }
  return null
}

/** 下载包并核对 SHA-256；已有且校验通过就复用 */
export async function downloadPackage(pkg: ServerPackage, cacheDir: string): Promise<string> {
  await mkdir(cacheDir, { recursive: true })
  const path = join(cacheDir, pkg.name)
  try {
    const info = await stat(path)
    if (info.size === pkg.size) {
      const hash = createHash('sha256').update(await readFile(path)).digest('hex')
      if (hash === pkg.sha256) return path
    }
  } catch {
    // 没下过
  }
  const response = await fetch(pkg.url)
  if (!response.ok || !response.body) throw new Error(`下载服务端包失败：HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path))
  const hash = createHash('sha256').update(await readFile(path)).digest('hex')
  if (hash !== pkg.sha256) {
    throw new Error(`服务端包校验不对（下载的 ${hash.slice(0, 12)}…，应为 ${pkg.sha256.slice(0, 12)}…）`)
  }
  return path
}

/** 装 / 升级：解包、核对、切换 bin（不打断在跑的连接）。dirName 只给测试用（装到临时目录验证）。 */
export async function deployPackage(
  target: DeployTarget,
  windows: boolean,
  version: string,
  packagePath: string,
  keepVersion = '',
  dirName = '.friday-server'
): Promise<DeployReport> {
  const template = windows ? WINDOWS_DEPLOY : POSIX_DEPLOY
  const script = template
    .replaceAll('.friday-server', dirName)
    .replaceAll('@VERSION@', version)
    .replaceAll('@KEEP@', keepVersion)
    .replaceAll('@UPLOAD@', '1')
  const result = await runRemote(target, script, { windows, stdinFile: packagePath, timeout: 900_000 })
  const report = parseDeployReport(result.output)
  if (report.failure) throw new Error(describeFailure(report.failure))
  if (!report.installedVersion && !report.busy) {
    throw new Error(`部署没有回话：${result.output.slice(-400)}`)
  }
  return report
}

/** 跑一段任意远程命令（测试用：目录探测、清理） */
export async function runRemoteForTest(target: DeployTarget, script: string, windows = false): Promise<string> {
  const result = await runRemote(target, script, { windows, timeout: 120_000 })
  return result.output
}

export function describeFailure(failure: string): string {
  const code = failure.split(/\s+/)[0] ?? ''
  const detail = failure.slice(code.length).trim()
  switch (code) {
    case 'mkdir':
      return '在远程建不了 ~/.friday-server 目录'
    case 'extract':
      return '远程解不开 Friday 服务端包（要有 tar；Windows 10 1803 起自带）'
    case 'layout':
      return 'Friday 服务端包里的文件不对'
    case 'move':
      return '在远程放不好 Friday 服务端的文件'
    case 'run': {
      const hint = detail.includes('GLIBC') ? '（远程的系统太旧：要 glibc 2.35 以上）' : ''
      return `新的 Friday 服务端在远程跑不起来${hint}：${detail}`
    }
    default:
      return `装 Friday 服务端没成功：${failure}`
  }
}

/** 一条龙：探测 → 需要时装/升级 → 返回状态说明 */
export async function ensureServer(
  target: DeployTarget,
  cacheDir: string,
  options: { protocol: number; onStatus?: (text: string) => void; keepVersion?: string }
): Promise<{ action: 'none' | 'installed' | 'upgraded' | 'busy'; version: string; message: string }> {
  const status = options.onStatus ?? (() => {})
  status('正在查看远程的 Friday 服务端…')
  const probe = await inspectRemote(target, false)
  if (!probe.system) {
    return { action: 'none', version: '', message: '探测不了远程环境（连不上或 shell 不认）' }
  }
  const windows = /Windows|AMD64|ARM64/i.test(probe.system + probe.machine)
  const key = platformKey(probe.system, probe.machine)
  if (!key) return { action: 'none', version: '', message: `没有给 ${probe.system} ${probe.machine} 的服务端包` }

  status('正在取服务端包信息…')
  const pkg = await fetchServerPackage(key, cacheDir, options.protocol)
  if (!pkg) return { action: 'none', version: '', message: 'latest.json 里没有和客户端协议一致的服务端包' }

  const current = probe.installedVersion.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? probe.installed.at(-1) ?? ''
  const needed = !probe.hasBin || !probe.installed.includes(pkg.version) || current === '' || current === '0.0.0'
  if (!needed) {
    return { action: 'none', version: pkg.version, message: `已经是 ${pkg.version}` }
  }

  status(`正在下载 friday-server ${pkg.version}（${Math.round(pkg.size / 1048576)} MB）…`)
  const path = await downloadPackage(pkg, cacheDir)
  status(`正在把 ${pkg.version} 装到远程…`)
  const report = await deployPackage(target, windows, pkg.version, path, options.keepVersion ?? '')
  if (report.busy) {
    return {
      action: 'busy',
      version: pkg.version,
      message: `${pkg.version} 已装好，接管 bin 时远程正忙（服务退出后会自动换上）`
    }
  }
  const action = probe.hasBin ? 'upgraded' : 'installed'
  return {
    action,
    version: pkg.version,
    message: `${action === 'installed' ? '已安装' : '已升级到'} friday-server ${pkg.version}`
  }
}
