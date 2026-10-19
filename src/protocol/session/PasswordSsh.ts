// 密码添加机器（方案 §10 M4「密码添加 SSH」；与 Qt 一致：一次性装公钥、用完即弃，不缓存密码）。
//
// 流程：用 ssh2 以密码登录一次 → 确保 ~/.ssh 存在 → 把本机公钥追加进 authorized_keys → 关掉连接。
// 之后照常走系统 ssh（支持 ~/.ssh/config、ssh-agent、跳板机），不再需要密码。

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'ssh2'

export interface PasswordInstallOptions {
  /** user@host 或 host */
  host: string
  port?: number
  password: string
  /** 默认 ~/.ssh/id_ed25519.pub，没有就用 id_rsa.pub */
  publicKeyPath?: string
}

/** 读本机公钥（没有就返回 null，调用方提示用户先生成） */
export async function readPublicKey(explicitPath?: string): Promise<{ path: string; value: string } | null> {
  const candidates = explicitPath
    ? [explicitPath]
    : [join(homedir(), '.ssh', 'id_ed25519.pub'), join(homedir(), '.ssh', 'id_rsa.pub')]
  for (const path of candidates) {
    try {
      const value = (await readFile(path, 'utf8')).trim()
      if (value) return { path, value }
    } catch {
      // 换下一个
    }
  }
  return null
}

function splitHost(target: string): { user: string; host: string } {
  const trimmed = target.trim()
  const at = trimmed.lastIndexOf('@')
  if (at > 0) return { user: trimmed.slice(0, at), host: trimmed.slice(at + 1) }
  return { user: 'root', host: trimmed }
}

/** 用密码登一次，把公钥装到远端。返回远端 authorized_keys 的行数（便于确认）。 */
export async function installPublicKeyWithPassword(options: PasswordInstallOptions): Promise<{
  remoteLine: string
  publicKeyPath: string
}> {
  const key = await readPublicKey(options.publicKeyPath)
  if (!key) {
    throw new Error('本机没有 SSH 公钥（~/.ssh/id_ed25519.pub）；先 ssh-keygen -t ed25519 生成一个')
  }
  const { user, host } = splitHost(options.host)
  // authorized_keys 里的一行：只保留「类型 + 值 + 注释」
  const parts = key.value.split(/\s+/)
  if (parts.length < 2) throw new Error(`公钥格式不对：${key.path}`)
  const line = parts.slice(0, 3).join(' ')

  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.on('ready', () => resolve())
    client.on('error', (error) => reject(error))
    client.connect({
      host,
      port: options.port ?? 22,
      username: user,
      password: options.password,
      readyTimeout: 20_000
    })
  })

  try {
    // 一次性脚本：建目录、去重追加、修正权限
    const script = [
      'set -e',
      'umask 077',
      'mkdir -p ~/.ssh',
      'chmod 700 ~/.ssh',
      'touch ~/.ssh/authorized_keys',
      'chmod 600 ~/.ssh/authorized_keys',
      `grep -qF '${line.replace(/'/g, `'\\''`)}' ~/.ssh/authorized_keys || printf '%s\\n' '${line.replace(/'/g, `'\\''`)}' >> ~/.ssh/authorized_keys`,
      'wc -l < ~/.ssh/authorized_keys'
    ].join('\n')

    const output = await new Promise<string>((resolve, reject) => {
      client.exec(script, (error, stream) => {
        if (error) {
          reject(error)
          return
        }
        let out = ''
        let err = ''
        stream.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8')
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          err += chunk.toString('utf8')
        })
        stream.on('close', (code: number) => {
          if (code === 0) resolve(out.trim())
          else reject(new Error(err.trim() || `远端脚本退出码 ${code}`))
        })
      })
    })

    return { remoteLine: output, publicKeyPath: key.path }
  } finally {
    client.end()
  }
}
