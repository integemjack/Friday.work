// 远端 shell 探测与 ssh 参数（与 Qt RemoteClient.cpp / RemoteTarget 逐项对齐）

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type ShellKind = 'cmd' | 'powershell' | 'posix'

export interface SshOptions {
  /** 整串 user@host（Qt 的 RemoteTarget.host 就是这么存） */
  host: string
  port?: number
  identityFile?: string
}

/** Windows 上优先用系统自带的 OpenSSH（与 Qt RemoteTarget::program 一致） */
export function sshProgram(): string {
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  return existsSync(system) ? system : 'ssh'
}

/** ssh 公共参数：不交互（只支持密钥 / ssh-agent）、第一次见的主机记指纹、保活（REMOTE.md §3：15s × 3） */
export function sshArgs(ssh: SshOptions, command?: string): string[] {
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'Compression=yes'
  ]
  if (ssh.port) args.push('-p', String(ssh.port))
  if (ssh.identityFile) {
    // 自定义密钥：只用它，不再试 ssh-agent 里别的（免得试多了被服务端按次数拒绝）
    args.push('-i', ssh.identityFile, '-o', 'IdentitiesOnly=yes')
  }
  args.push(ssh.host)
  if (command !== undefined) args.push(command)
  return args
}

const PROBE_TIMEOUT = 15_000

/** `echo FRIDAY-PROBE %OS% $env:OS`：cmd 展开 %OS%、PowerShell 展开 $env:OS、POSIX sh 都不展开 */
export async function probeShell(ssh: SshOptions): Promise<ShellKind> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(sshProgram(), sshArgs(ssh, 'echo FRIDAY-PROBE %OS% $env:OS'), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('探测远端 shell 超时'))
    }, PROBE_TIMEOUT)
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(sshFailureReason(code ?? -1, stderr)))
    })
  })

  const at = output.indexOf('FRIDAY-PROBE')
  if (at < 0) throw new Error('探测远端 shell 失败：输出不对')
  const words = output.slice(at).split(/\s+/).filter((w) => w.length > 0)
  if (words[1] === 'Windows_NT') return 'cmd'
  if (words[2] === 'Windows_NT') return 'powershell'
  return 'posix'
}

/** WSL 里固定按 POSIX 处理，不用探测 */
export function wslProbeShell(): ShellKind {
  return 'posix'
}

/** --attach 的远端命令（REMOTE.md §2） */
export function attachCommand(shell: ShellKind): string {
  switch (shell) {
    case 'posix':
      return 'exec "$HOME/.friday-server/bin/friday-server" --attach'
    case 'cmd':
      return '"%USERPROFILE%\\.friday-server\\bin\\friday-server.exe" --attach'
    case 'powershell':
      return '& "$env:USERPROFILE\\.friday-server\\bin\\friday-server.exe" --attach'
  }
}

/** WSL：wsl.exe [-d 发行版] --exec sh -c <命令>（与 Qt RemoteTarget::commandArguments 一致） */
export function wslArgs(distro: string, command: string): string[] {
  const args: string[] = []
  if (distro) args.push('-d', distro)
  return [...args, '--exec', 'sh', '-c', command]
}

/** 常见连不上的原因换成给人看的说明（REMOTE.md §11 RemoteTarget::sshFailureReason 的做法） */
export function sshFailureReason(code: number, stderr: string): string {
  const text = stderr.toLowerCase()
  if (text.includes('permission denied') && text.includes('publickey')) {
    return '连上了但这台机器不认这把密钥（permission denied）：确认密钥已加进 ssh-agent，或指定私钥文件'
  }
  if (text.includes('permission denied')) return '登录被拒绝（permission denied）'
  if (text.includes('connection refused')) return '对方拒绝连接：那台机器的 ssh 服务没开，或端口不对'
  if (text.includes('timed out') || text.includes('connection timed out')) return '连接超时：检查网络，或那台机器不在线'
  if (text.includes('could not resolve hostname') || text.includes('nodename nor servname')) return '找不到主机：检查主机名 / IP'
  if (text.includes('host key verification failed') || text.includes('remote host identification has changed')) {
    return '主机密钥变了：与本机记录的不一致（known_hosts），确认后删掉旧记录再连'
  }
  if (text.includes('no route to host')) return '网络不通（no route to host）'
  if (code === 255) return `ssh 连接失败：${stderr.trim().split(/\r?\n/).pop() ?? ''}`
  return `ssh 退出码 ${code}：${stderr.trim().split(/\r?\n/).pop() ?? ''}`
}
