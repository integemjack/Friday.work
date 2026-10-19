// 配对凭据（配对令牌 + 证书指纹）：值只经主进程 safeStorage 落盘（方案 §4.3）。
// 协议进程只拿解密后的值连 wss，不落明文盘。

export interface Pairing {
  token: string
  fingerprint?: string
  deviceID?: string
  /** `/connect` 回来的一组候选地址（并行/依次试，第一个握手成功的就用） */
  urls?: string[]
}

/** 主进程提供的凭据后端（parentPort 上的请求/回执） */
export interface CredentialBackend {
  load(key: string): Promise<string | null>
  store(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

const KEY = 'pairings'

export class PairingStore {
  /** wss URL → 配对 */
  private readonly pairings = new Map<string, Pairing>()
  private loaded = false

  constructor(private readonly backend: CredentialBackend) {}

  async load(): Promise<void> {
    if (this.loaded) return
    const raw = await this.backend.load(KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, Pairing>
        for (const [url, pairing] of Object.entries(parsed)) {
          if (pairing && typeof pairing.token === 'string') this.pairings.set(url, pairing)
        }
      } catch {
        // 存档坏了当作没配对过
      }
    }
    this.loaded = true
  }

  get(url: string): Pairing | undefined {
    return this.pairings.get(url)
  }

  async save(url: string, pairing: Pairing): Promise<void> {
    this.pairings.set(url, pairing)
    await this.flush()
  }

  private async flush(): Promise<void> {
    const object: Record<string, Pairing> = {}
    for (const [url, pairing] of this.pairings) object[url] = pairing
    await this.backend.store(KEY, JSON.stringify(object))
  }
}
