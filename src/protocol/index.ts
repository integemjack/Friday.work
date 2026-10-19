// 协议进程入口（utilityProcess）：所有网络与子进程 I/O、协议状态（方案 §3）。
// 主进程经 parentPort 发来 {type:'init', …} + MessagePort（渲染进程数据面）；
// 凭据/句柄请求也走 parentPort。

import { randomUUID } from 'node:crypto'
import type { MessagePortMain } from 'electron'
import { ProtocolHost, type MainBackends } from './host.js'
import type { CredentialBackend } from './session/PairingStore.js'

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const parentPort = process.parentPort

let protocolHost: ProtocolHost | null = null
let port: MessagePortMain | null = null
const pendingCred = new Map<string, PendingCall>()
const pendingHandles = new Map<string, PendingCall>()

function reply<T>(pending: Map<string, PendingCall>, reqID: string, data: { ok: boolean; value?: unknown; path?: string }): void {
  const entry = pending.get(reqID)
  if (!entry) return
  pending.delete(reqID)
  if (data.ok) entry.resolve(data.value ?? data.path ?? null)
  else entry.reject(new Error('主进程拒绝了请求'))
}

function callMain(type: string, payload: Record<string, unknown>, pending: Map<string, PendingCall>): Promise<unknown> {
  const reqID = randomUUID()
  return new Promise((resolve, reject) => {
    pending.set(reqID, { resolve, reject })
    parentPort.postMessage({ type, reqID, ...payload })
    // 30 秒没人回就失败，免得挂死
    setTimeout(() => {
      if (pending.has(reqID)) {
        pending.delete(reqID)
        reject(new Error('主进程没有回应'))
      }
    }, 30_000)
  })
}

const credentials: CredentialBackend = {
  async load(key) {
    const value = await callMain('cred', { op: 'load', key }, pendingCred)
    return typeof value === 'string' ? value : null
  },
  async store(key, value) {
    await callMain('cred', { op: 'store', key, value }, pendingCred)
  },
  async delete(key) {
    await callMain('cred', { op: 'delete', key }, pendingCred)
  }
}

const backends: MainBackends = {
  credentials,
  async resolveHandle(handle) {
    const path = await callMain('handle-resolve', { handle }, pendingHandles)
    return typeof path === 'string' ? path : null
  }
}

parentPort.on('message', (event) => {
  const data = event.data as { type?: string } & Record<string, unknown>
  if (!data || typeof data !== 'object') return

  switch (data.type) {
    case 'init': {
      const userDataPath = String(data.userDataPath ?? '')
      const appVersion = String(data.appVersion ?? '0.0.0')
      initParams = { userDataPath, appVersion }
      void ensureHost()
      break
    }
    case 'attach': {
      const transferred = (event as { ports?: MessagePortMain[] }).ports ?? []
      const newPort = transferred[0]
      if (!newPort) break
      port?.close()
      port = newPort
      if (protocolHost) {
        protocolHost.setPort(newPort)
      } else {
        void ensureHost()
      }
      break
    }
    case 'cred-result':
      reply(pendingCred, String(data.reqID ?? ''), { ok: !!data.ok, value: data.value })
      break
    case 'handle-result':
      reply(pendingHandles, String(data.reqID ?? ''), { ok: !!data.ok, path: data.path as string | undefined })
      break
  }
})

let initParams: { userDataPath: string; appVersion: string } | null = null

async function ensureHost(): Promise<void> {
  if (protocolHost || !initParams) return
  protocolHost = new ProtocolHost(backends, initParams)
  await protocolHost.start()
}
