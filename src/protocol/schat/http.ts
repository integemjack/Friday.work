// chatserver 的 HTTPS 请求（自签证书 + 指纹钉住）。
// 与 friday 的 wss 同一套做法：不认链路校验，握手后比对证书 SHA-256；第一次见到的指纹要落盘（TOFU），之后必须一致。

import { createHash } from 'node:crypto'
import { request, type RequestOptions } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { URL } from 'node:url'

export interface HttpResult {
  status: number
  body: string
  /** 服务端证书指纹（去冒号、小写） */
  fingerprint: string
  error?: string
}

/** 证书指纹：sha256，去冒号、小写 */
export function normalizeFingerprint(value: string | undefined | null): string | null {
  if (!value) return null
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  return hex.length === 64 ? hex : null
}

export function socketFingerprint(socket: TLSSocket): string | null {
  const cert = socket.getPeerCertificate()
  if (!cert || !cert.fingerprint256) return null
  return normalizeFingerprint(cert.fingerprint256)
}

export interface PostOptions {
  /** 只接受这个指纹（不给 = 第一次见，用回执里的指纹为准，调用方自行存下） */
  fingerprint?: string
  /** Bearer 令牌 */
  token?: string
  /** 服务器密码（X-Server-Password） */
  serverPassword?: string
  timeoutMs?: number
}

/** POST JSON 到 chatserver。证书指纹不符时抛错（不发请求体）。 */
export function postJson(url: string, payload: unknown, options: PostOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const body = JSON.stringify(payload)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body))
    }
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    if (options.serverPassword) headers['X-Server-Password'] = options.serverPassword
    const secure = target.protocol === 'https:'
    const module = secure ? request : undefined
    if (!module) {
      // 明文 HTTP（内网测试）：直接用 http 模块
      void import('node:http').then(({ request: httpRequest }) => {
        const req = httpRequest(
          {
            hostname: target.hostname,
            port: target.port || 80,
            path: target.pathname + target.search,
            method: 'POST',
            headers,
            timeout: options.timeoutMs ?? 8000
          },
          (res) => {
            let text = ''
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => {
              text += chunk
            })
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, body: text, fingerprint: '' })
            )
          }
        )
        req.on('timeout', () => req.destroy(new Error('请求超时')))
        req.on('error', (error) => reject(error))
        req.end(body)
      })
      return
    }

    const expected = normalizeFingerprint(options.fingerprint)
    const requestOptions: RequestOptions = {
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: 'POST',
      headers,
      timeout: options.timeoutMs ?? 8000,
      rejectUnauthorized: false,
      // 不复用连接：指纹检查挂在 secureConnect 上，复用的 TLS socket 不会再触发它
      agent: false
    }
    const req = request(requestOptions, (res) => {
      const socket = res.socket as TLSSocket
      const fingerprint = socketFingerprint(socket) ?? ''
      if (expected && fingerprint && fingerprint !== expected) {
        res.destroy()
        reject(new Error(`服务器证书指纹变了（收到 ${fingerprint.slice(0, 12)}…，记着的是 ${expected.slice(0, 12)}…）`))
        return
      }
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, fingerprint }))
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', (error) => reject(error))
    // 指纹不符时请求体不能发出去：挂在响应回调里比对此前为时已晚——TLS 握手已完成、
    // 请求体（refreshToken / X-Server-Passssword / Bearer）已经交到对端手上。
    // 改在 secureConnect 里先比对证书，通过后才允许发送
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        const fingerprint = socketFingerprint(socket as TLSSocket)
        if (expected && (!fingerprint || fingerprint !== expected)) {
          req.destroy(
            new Error(
              `服务器证书指纹变了（收到 ${fingerprint ? `${fingerprint.slice(0, 12)}…` : '空'}，记着的是 ${expected.slice(0, 12)}…）`
            )
          )
          return
        }
        req.end(body)
      })
    })
  })
}

/** GET JSON（带 Bearer） */
export function getJson(url: string, options: PostOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const secure = target.protocol === 'https:'
    const headers: Record<string, string> = {}
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    if (options.serverPassword) headers['X-Server-Password'] = options.serverPassword
    const send = (fn: typeof request | typeof import('node:http').request): void => {
      const expected = normalizeFingerprint(options.fingerprint)
      const req = fn(
        {
          hostname: target.hostname,
          port: target.port || (secure ? 443 : 80),
          path: target.pathname + target.search,
          method: 'GET',
          headers,
          timeout: options.timeoutMs ?? 8000,
          // 同 postJson：不复用连接 + secureConnect 先过指纹再发（GET 也带 Authorization 头）
          ...(secure ? { rejectUnauthorized: false, agent: false } : {})
        } as RequestOptions,
        (res) => {
          const fingerprint = secure ? socketFingerprint(res.socket as TLSSocket) : ''
          const expected = normalizeFingerprint(options.fingerprint)
          if (secure && expected && fingerprint && fingerprint !== expected) {
            res.destroy()
            reject(new Error('服务器证书指纹变了'))
            return
          }
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            text += chunk
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, fingerprint: fingerprint ?? '' }))
        }
      )
      req.on('timeout', () => req.destroy(new Error('请求超时')))
      req.on('error', (error) => reject(error))
      if (!secure) {
        req.end()
        return
      }
      req.on('socket', (socket) => {
        socket.once('secureConnect', () => {
          const fingerprint = socketFingerprint(socket as TLSSocket)
          if (expected && (!fingerprint || fingerprint !== expected)) {
            req.destroy(new Error('服务器证书指纹变了'))
            return
          }
          req.end()
        })
      })
    }
    if (secure) send(request)
    else void import('node:http').then(({ request: httpRequest }) => send(httpRequest as typeof request))
  })
}

/** 短指纹：设备指纹之类的地方给人看的 12 字符（对齐 Qt keyfer::fingerprint 的展示习惯） */
export function shortFingerprint(value: string): string {
  const hex = value.replace(/[^0-9a-f]/gi, '').toLowerCase()
  return createHash('sha256').update(hex).digest('hex').slice(0, 12)
}
