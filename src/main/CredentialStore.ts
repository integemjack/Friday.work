// 凭据落盘：safeStorage 加密（Windows DPAPI），渲染进程接触不到（方案 §4.3）。
// 文件：<userData>/Remotes/pairings.enc，格式 { <key>: { enc: <base64> } }

import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Entry {
  enc: string
}

export class CredentialStore {
  private readonly file = join(app.getPath('userData'), 'Remotes', 'pairings.enc')

  private readAll(): Record<string, Entry> {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, Entry>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  private writeAll(all: Record<string, Entry>): void {
    mkdirSync(join(app.getPath('userData'), 'Remotes'), { recursive: true })
    writeFileSync(this.file, JSON.stringify(all, null, 2), 'utf8')
  }

  private encrypt(text: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统的凭据加密不可用，存不了配对信息')
    }
    return safeStorage.encryptString(text).toString('base64')
  }

  private decrypt(base64: string): string {
    return safeStorage.decryptString(Buffer.from(base64, 'base64'))
  }

  load(key: string): string | null {
    const entry = this.readAll()[key]
    if (!entry) return null
    try {
      return this.decrypt(entry.enc)
    } catch {
      return null
    }
  }

  store(key: string, value: string): void {
    const all = this.readAll()
    all[key] = { enc: this.encrypt(value) }
    this.writeAll(all)
  }

  delete(key: string): void {
    const all = this.readAll()
    delete all[key]
    this.writeAll(all)
  }
}
