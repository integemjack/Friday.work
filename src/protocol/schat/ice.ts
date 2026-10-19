// 1:1 通话的 ICE 服务器（Secret-Chat docs/cross_end_contract_events.md「1:1 通话的 TURN 中继」）。
//
// 口径（四端一致）：
//  - 用**这通电话所属账号**的 server+token 拉 `GET /calls/ice-servers`；
//  - 按 (server, account) 缓存，过半即重拉；
//  - 拉到的列表**追加在内置 STUN 清单之后**（STUN 清单本身不动：三端 parity 铁律）；
//  - 失败（401 / 404 老服务端 / 网络错）→ 照旧只用内置 STUN，绝不因此让通话失败；
//  - 日志里不打 credential。

import { getJson } from './http.js'

/** 与桌面端 DcMediaEngine 的 defaultServers 同一份（三端 parity） */
export const BUILTIN_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
  'stun:stun.miwifi.com:3478',
  'stun:stun.qq.com:3478',
  'stun:stun.syncthing.net:3478',
  'stun:stun.stunprotocol.org:3478'
]

export const BUILTIN_ICE_SERVERS: RTCIceServerLike[] = BUILTIN_STUN.map((urls) => ({ urls }))

/** 渲染进程的 RTCIceServer 结构（协议进程只做数据搬运，不依赖 DOM 类型） */
export interface RTCIceServerLike {
  urls: string | string[]
  username?: string
  credential?: string
}

interface CacheEntry {
  servers: RTCIceServerLike[]
  fetchedAt: number
  expiresIn: number
}

const cache = new Map<string, CacheEntry>()

/** 内置 STUN + 拉到的 TURN（失败就只给内置的） */
export async function iceServersFor(
  server: string,
  token: string,
  accountId: number,
  options: { fingerprint?: string } = {}
): Promise<RTCIceServerLike[]> {
  const key = `${server}|${accountId}`
  const cached = cache.get(key)
  const now = Date.now()
  // 过半即重拉（契约③）
  if (cached && now - cached.fetchedAt < (cached.expiresIn * 1000) / 2) {
    return [...BUILTIN_ICE_SERVERS, ...cached.servers]
  }
  try {
    const result = await getJson(`${server.replace(/\/+$/, '')}/calls/ice-servers`, {
      token,
      fingerprint: options.fingerprint
    })
    if (result.status < 200 || result.status >= 300) {
      return [...BUILTIN_ICE_SERVERS]
    }
    const parsed = JSON.parse(result.body) as {
      iceServers?: RTCIceServerLike[]
      expiresIn?: number
    }
    const servers = Array.isArray(parsed.iceServers) ? parsed.iceServers : []
    cache.set(key, { servers, fetchedAt: now, expiresIn: parsed.expiresIn ?? 300 })
    return [...BUILTIN_ICE_SERVERS, ...servers]
  } catch {
    // 网络错/超时：只用内置 STUN（契约③）
    return [...BUILTIN_ICE_SERVERS]
  }
}

export function clearIceCache(): void {
  cache.clear()
}
