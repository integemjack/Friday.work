// 协议进程的监护：fork、控制消息转发、崩溃拉起；数据面 MessagePort 按窗口请求分发（方案 §3/§7.2）。
// 端口时序：渲染进程加载完成后发 'friday-request-port'，这里建一对端口——port2 给协议进程、port1 给窗口；
// 协议进程换端口但不重建（机器连接保持），窗口 reload 也走同一条路。

import { join } from 'node:path'
import { MessageChannelMain, app, utilityProcess, type MessagePortMain, type UtilityProcess, type WebContents } from 'electron'
import type { CredentialStore } from './CredentialStore'

export class ProtocolHost {
  private child: UtilityProcess | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private startedAt = 0
  /** stop() 之后不再自动拉起：退出流程里被杀的进程不能在关机路上复活 */
  private stopped = false

  constructor(
    private readonly credentialStore: CredentialStore,
    private readonly resolveHandle: (handle: string) => string | null
  ) {}

  start(): void {
    if (this.child) return
    this.stopped = false
    const child = utilityProcess.fork(join(__dirname, 'protocol.js'), [], {
      serviceName: 'friday-protocol',
      stdio: 'inherit'
    })
    this.child = child
    this.startedAt = Date.now()

    child.on('message', (message) => this.onChildMessage(message))
    child.on('exit', () => {
      // 只清自己：kill 后、exit 回调到来前 providePort 可能已经 start 出了新 child，
      // 不能把新 child 的引用清掉（否则下个请求端口又会 fork 出第二个协议进程）
      if (this.child === child) this.child = null
      if (this.stopped) return
      // 崩溃拉起（刚启动就退的慢一点重试）
      const uptime = Date.now() - this.startedAt
      const delay = uptime < 5_000 ? 3_000 : 500
      if (!this.restartTimer) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          this.start()
        }, delay)
      }
    })

    child.postMessage({
      type: 'init',
      userDataPath: app.getPath('userData'),
      appVersion: app.getVersion()
    })
  }

  /** 渲染进程请求端口（preload 在页面加载完成后调用一次；reload 后会再来） */
  providePort(webContents: WebContents): void {
    if (!this.child) this.start()
    const { port1, port2 } = new MessageChannelMain()
    this.child?.postMessage({ type: 'attach' }, [port2])
    webContents.postMessage('friday-port', null, [port1])
  }

  private onChildMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const data = message as Record<string, unknown>
    const reqID = String(data.reqID ?? '')
    switch (data.type) {
      case 'cred': {
        const op = String(data.op ?? '')
        const key = String(data.key ?? '')
        try {
          let value: string | null = null
          if (op === 'load') value = this.credentialStore.load(key)
          else if (op === 'store') this.credentialStore.store(key, String(data.value ?? ''))
          else if (op === 'delete') this.credentialStore.delete(key)
          this.child?.postMessage({ type: 'cred-result', reqID, ok: true, value })
        } catch (error) {
          this.child?.postMessage({
            type: 'cred-result',
            reqID,
            ok: false,
            value: error instanceof Error ? error.message : String(error)
          })
        }
        break
      }
      case 'handle-resolve': {
        const path = this.resolveHandle(String(data.handle ?? ''))
        this.child?.postMessage({ type: 'handle-result', reqID, ok: !!path, path })
        break
      }
    }
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.child?.kill()
    this.child = null
  }
}

export type { MessagePortMain }
