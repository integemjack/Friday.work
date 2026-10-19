// SSH / WSL 传输：spawn 一个长期进程，stdout 上一行一条消息（REMOTE.md §2/§3）。

import { spawn, type ChildProcess } from 'node:child_process'
import { LineFramer } from './LineFramer.js'
import { attachCommand, probeShell, sshArgs, wslArgs, type SshOptions } from './probe.js'

export type TransportCallbacks = {
  onMessage: (text: string) => void
  onExit: (info: { exitCode: number | null; sshFailed: boolean; stderrTail: string }) => void
  onError: (error: Error) => void
}

export class SshTransport {
  private child: ChildProcess | null = null
  private stderrTail = ''
  private closed = false

  constructor(
    private readonly callbacks: TransportCallbacks,
    private readonly onStdoutText: (text: string) => void
  ) {}

  get connected(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.closed
  }

  /** 起 ssh / wsl：先探测 shell，再按对应的 --attach 命令连 */
  async startSSH(ssh: SshOptions): Promise<void> {
    if (this.child) throw new Error('传输已在运行')
    const shell = await probeShell(ssh)
    await this.startRaw('ssh', sshArgs(ssh, attachCommand(shell)))
  }

  async startWSL(distro: string): Promise<void> {
    if (this.child) throw new Error('传输已在运行')
    const command = attachCommand('posix')
    await this.startRaw('wsl.exe', wslArgs(distro, command))
  }

  private startRaw(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const framer = new LineFramer((line) => this.callbacks.onMessage(line))
      let child: ChildProcess
      try {
        child = spawn(command, args, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.child = child

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        this.onStdoutText(chunk)
        framer.push(chunk)
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4096)
      })
      child.on('error', (error) => {
        if (this.child === child) this.child = null
        this.callbacks.onError(error)
      })
      child.on('exit', (code) => {
        if (this.child === child) this.child = null
        if (!this.closed) {
          this.callbacks.onExit({ exitCode: code, sshFailed: code === 255, stderrTail: this.stderrTail })
        }
      })
      // spawn 成功即认为已启动；握手是否成功由 hello 决定
      resolve()
    })
  }

  send(text: string): void {
    if (!this.child?.stdin?.writable) return
    // 一条消息一行 + \n（REMOTE.md §2）
    this.child.stdin.write(text.replace(/\n/g, ' ') + '\n')
  }

  close(): void {
    this.closed = true
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin?.end()
    } catch { /* 忽略 */ }
    child.kill()
    // 给 2 秒优雅退出，否则强杀
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 忽略 */ }
    }, 2000)
    child.once('exit', () => clearTimeout(timer))
  }
}
