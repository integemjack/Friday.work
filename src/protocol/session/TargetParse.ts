// 目标解析：与 Qt MachineSwitcher::parseInput / RemoteTarget::parse 对齐。
// 支持：friday://pair?u=<wss地址>&t=<令牌>&f=<指纹>&n=<名字>、wsl:发行版、
// user@host[:端口]（自动补 ssh:）、ssh:user@host[:端口]、wss://… / ws://…

import type { ParsedTarget } from '../../shared/api.js'

export function parseTarget(text: string): ParsedTarget | null {
  const input = text.trim()

  // 配对链接（REMOTE.md §8）：记下令牌，连 WebSocket 入口
  const pairing = pairingFromLink(input)
  if (pairing) return pairing

  if (/^wsl:/i.test(input)) {
    const distro = input.slice(4).trim()
    return { kind: 'wsl', distro }
  }

  if (/^wss:\/\//i.test(input) || /^ws:\/\//i.test(input)) {
    return { kind: 'ws', url: input }
  }

  let rest = input
  if (/^ssh:/i.test(rest)) rest = rest.slice(4)
  if (rest.startsWith('//')) rest = rest.slice(2)
  rest = rest.trim()
  if (!rest || rest.includes(' ')) return null

  // user@host:port（IPv6 地址写成 [::1]:22）
  let port: number | undefined
  const colon = rest.lastIndexOf(':')
  const bracket = rest.lastIndexOf(']')
  if (colon > 0 && colon > bracket) {
    const parsed = Number.parseInt(rest.slice(colon + 1), 10)
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed
      rest = rest.slice(0, colon)
    }
  }
  if (!rest) return null
  return { kind: 'ssh', host: rest, port }
}

/** friday://pair?u=<地址>&t=<令牌>&f=<指纹>&n=<名字>（Qt RemotePairing::fromLink 的移植） */
export function pairingFromLink(link: string): ParsedTarget | null {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'friday:' || url.hostname !== 'pair') return null
  const u = url.searchParams.get('u') ?? ''
  const token = url.searchParams.get('t') ?? ''
  const inner = parseTarget(u)
  if (!inner || inner.kind !== 'ws' || !inner.url || !token) return null
  return {
    kind: 'ws',
    url: inner.url,
    token,
    fingerprint: url.searchParams.get('f') ?? undefined,
    suggestedName: url.searchParams.get('n') ?? undefined
  }
}

/** remotes.json 里的 target 字符串（与 Qt RemoteTarget::toString 一致） */
export function targetToText(target: ParsedTarget): string {
  if (target.kind === 'ws') return target.url ?? ''
  if (target.kind === 'wsl') return `wsl:${target.distro ?? ''}`
  return `ssh:${target.host ?? ''}${target.port ? `:${target.port}` : ''}`
}

/** 界面上显示的名字（Qt RemoteTarget::displayName 的做法） */
export function targetDisplayName(target: ParsedTarget): string {
  if (target.kind === 'ws') {
    try {
      const url = new URL(target.url ?? '')
      return `${url.hostname}${url.port ? `:${url.port}` : ''}`
    } catch {
      return target.url ?? 'WebSocket'
    }
  }
  if (target.kind === 'wsl') return target.distro ? `WSL · ${target.distro}` : 'WSL'
  return target.host ?? ''
}
