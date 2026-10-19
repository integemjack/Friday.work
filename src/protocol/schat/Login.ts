// 扫码登录（Secret-Chat docs/qr_login_plan.md；chatserver internal/server/login_http.go）。
//
//   POST /login-sessions          匿名：建会话，拿要渲染的 token（码 = SCSH:1:login:<token>）
//   POST /login-sessions/poll     匿名 + deviceId：桌面每 2 秒轮询；approved 时一次性领到凭据
//   404 一律是 invalid_or_expired（过期 / 已领 / deviceId 不符，服务端刻意不区分）
//
// deviceId 是领取凭据（poll 必须带回），绝不进二维码。

import { randomUUID } from 'node:crypto'
import { getJson, postJson, type PostOptions } from './http.js'

export type QrLoginStatus = 'pending' | 'scanned' | 'approved' | 'expired' | 'error'

export interface QrSession {
  token: string
  /** 要渲染成二维码的字符串 */
  payload: string
  expiresAt: number
  intervalMs: number
  deviceId: string
}

export interface QrSessionResult {
  userId: number
  /** 7 天 legacy token（REST + WS 都用它） */
  token: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  keyBlob?: string
}

export interface QrLoginHooks {
  onStatus(status: QrLoginStatus, detail?: string): void
  onSession(session: QrSessionResult): void
  onError(message: string): void
}

const DEVICE_PLATFORM = 'desktop'

/** 建会话。老服务端没有这条路由时回 404，调用方据此提示「该服务器不支持扫码登录」。 */
export async function createQrSession(
  server: string,
  options: { deviceId: string; deviceName: string; fingerprint?: string; serverPassword?: string }
): Promise<QrSession> {
  const result = await postJson(
    `${server.replace(/\/+$/, '')}/login-sessions`,
    { deviceId: options.deviceId, devicePlatform: DEVICE_PLATFORM, deviceName: options.deviceName },
    { fingerprint: options.fingerprint, serverPassword: options.serverPassword }
  )
  if (result.status === 404) throw new Error('该服务器不支持扫码登录（没有 /login-sessions）')
  let json: { success?: boolean; token?: string; expiresAt?: number; intervalMs?: number; error?: string } = {}
  try {
    json = JSON.parse(result.body)
  } catch {
    // 非 JSON
  }
  if (result.status === 429) {
    const retryAfter = (json as { retryAfter?: number }).retryAfter ?? 60
    throw new Error(`请求太频繁，请 ${retryAfter} 秒后再试`)
  }
  if (result.status < 200 || result.status >= 300 || !json.token) {
    throw new Error(json.error ? `拿不到登录码（${json.error}）` : `拿不到登录码（HTTP ${result.status}）`)
  }
  return {
    token: json.token,
    payload: `SCSH:1:login:${json.token}`,
    expiresAt: json.expiresAt ?? Date.now() + 300_000,
    intervalMs: json.intervalMs ?? 2000,
    deviceId: options.deviceId
  }
}

/** 一次轮询：approved 时把凭据交给 onSession（只拿到一次） */
export async function pollQrSession(
  server: string,
  session: QrSession,
  hooks: QrLoginHooks,
  options: { fingerprint?: string; serverPassword?: string } = {}
): Promise<QrLoginStatus> {
  let result
  try {
    result = await postJson(
      `${server.replace(/\/+$/, '')}/login-sessions/poll`,
      { token: session.token, deviceId: session.deviceId },
      { fingerprint: options.fingerprint, serverPassword: options.serverPassword }
    )
  } catch (error) {
    // 网络抖动不算终态，继续轮
    const message = error instanceof Error ? error.message : String(error)
    hooks.onStatus('error', message)
    return 'error'
  }
  if (result.status === 404) {
    hooks.onStatus('expired', '二维码已失效（过期或已被使用）')
    return 'expired'
  }
  if (result.status < 200 || result.status >= 300) {
    hooks.onStatus('error', `HTTP ${result.status}`)
    return 'error'
  }
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(result.body) as Record<string, unknown>
  } catch {
    hooks.onStatus('error', '回执不是 JSON')
    return 'error'
  }
  const status = String(json.status ?? 'pending')
  if (status !== 'approved') {
    const known: QrLoginStatus = status === 'scanned' ? 'scanned' : 'pending'
    hooks.onStatus(known)
    return known
  }
  // approved：与 /auth/login 同型的会话载荷
  const sessionResult: QrSessionResult = {
    userId: Number(json.userId ?? 0),
    token: String(json.token ?? ''),
    accessToken: String(json.accessToken ?? json.token ?? ''),
    refreshToken: String(json.refreshToken ?? ''),
    expiresIn: Number(json.expiresIn ?? 0),
    ...(json.keyBlob ? { keyBlob: String(json.keyBlob) } : {})
  }
  if (!sessionResult.token) {
    hooks.onError('登录已批准，但回执里没有凭据')
    return 'error'
  }
  hooks.onStatus('approved')
  hooks.onSession(sessionResult)
  return 'approved'
}

/** 跑完整的扫码登录：建会话 → 轮询直到终态。返回取消函数。 */
export function runQrLogin(
  server: string,
  options: { deviceId: string; deviceName: string; fingerprint?: string; serverPassword?: string },
  hooks: QrLoginHooks
): { cancel(): void; session: QrSession | null; ready: Promise<QrSession> } {
  let cancelled = false
  let timer: NodeJS.Timeout | null = null
  let current: QrSession | null = null

  const ready = createQrSession(server, options)
  ready.catch((error: unknown) => {
    hooks.onError(error instanceof Error ? error.message : String(error))
  })

  void ready
    .then((session) => {
      current = session
      if (cancelled) return
      const tick = async (): Promise<void> => {
        if (cancelled || !current) return
        if (Date.now() > current.expiresAt) {
          hooks.onStatus('expired', '二维码已过期')
          return
        }
        const status = await pollQrSession(server, current, hooks, {
          fingerprint: options.fingerprint,
          serverPassword: options.serverPassword
        })
        if (cancelled) return
        if (status === 'approved' || status === 'expired') return
        timer = setTimeout(() => void tick(), current.intervalMs)
      }
      timer = setTimeout(() => void tick(), current.intervalMs)
    })
    .catch(() => {
      // 已经在 catch 里报过
    })

  return {
    cancel(): void {
      cancelled = true
      if (timer) clearTimeout(timer)
    },
    get session() {
      return current
    },
    ready
  }
}

/** 刷新凭据（rotation：旧的作废） */
export async function refreshSession(
  server: string,
  refreshToken: string,
  options: { fingerprint?: string } = {}
): Promise<QrSessionResult> {
  const result = await postJson(
    `${server.replace(/\/+$/, '')}/auth/refresh`,
    { refreshToken },
    { fingerprint: options.fingerprint } as PostOptions
  )
  if (result.status < 200 || result.status >= 300) throw new Error(`刷新凭据失败（HTTP ${result.status}）`)
  const json = JSON.parse(result.body) as Record<string, unknown>
  return {
    userId: Number(json.userId ?? 0),
    token: String(json.token ?? ''),
    accessToken: String(json.accessToken ?? json.token ?? ''),
    refreshToken: String(json.refreshToken ?? ''),
    expiresIn: Number(json.expiresIn ?? 0)
  }
}

/** 好友列表（含机器人：isBot 为真的那些） */
export async function fetchFriends(
  server: string,
  token: string,
  options: { fingerprint?: string } = {}
): Promise<Array<{ id: number; name: string; nickname?: string; isBot?: boolean; botCalls?: boolean }>> {
  const result = await getJson(`${server.replace(/\/+$/, '')}/friends`, { token, fingerprint: options.fingerprint })
  if (result.status < 200 || result.status >= 300) throw new Error(`读好友列表失败（HTTP ${result.status}）`)
  const parsed = JSON.parse(result.body) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed as Array<{ id: number; name: string; nickname?: string; isBot?: boolean; botCalls?: boolean }>
}

/** 稳定设备 id：每个 chatserver + 本机一份（渲染进程不用管它怎么来的） */
export function newDeviceId(): string {
  return randomUUID()
}
