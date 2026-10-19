// `/connect` 的客户端侧（docs/REMOTE.md §8、方案 §4.0 ③）：
//   本机生成一次性 X25519 密钥对 → 在聊天里给 bot 发 `/connect <公钥>` →
//   Friday 用它自己的临时密钥做 ECDH、HKDF-SHA256、ChaCha20-Poly1305，把配对凭据封装回来 →
//   本机用私钥解开、立刻丢弃私钥。聊天记录里只有密文，事后再拿也解不开。
//
// 与服务端 qt/src/core/remote/SealedBox.cpp 是同一套参数：
//   shared = X25519(我的私钥, 服务端临时公钥)
//   salt   = 服务端公钥 || 我的公钥（把两边身份绑进密钥）
//   info   = "friday-connect-v1"
//   key    = HKDF-SHA256(shared, salt, info, 32)
//   密文   = ChaCha20-Poly1305(key, nonce 12 字节, AAD = salt)
//   回包   = 服务端公钥(32) || nonce(12) || ciphertext||tag(16)

import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject
} from 'node:crypto'

const INFO = Buffer.from('friday-connect-v1', 'utf8')

export interface Ephemeral {
  privateKey: KeyObject
  /** 32 字节裸公钥（base64url 发给服务端） */
  publicKeyRaw: Buffer
}

/** 生成一次性 X25519 密钥对 */
export function generateEphemeral(): Ephemeral {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  // 导出的 SPKI：最后 32 字节就是裸公钥
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const publicKeyRaw = Buffer.from(der.subarray(der.length - 32))
  return { privateKey, publicKeyRaw }
}

/** DER 里包一层 SPKI 头，把裸公钥变成 KeyObject */
function publicKeyFromRaw(raw: Buffer): KeyObject {
  const prefix = Buffer.from('302a300506032b656e032100', 'hex')
  if (raw.length !== 32) throw new Error('服务端公钥长度不对')
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' })
}

export interface ConnectPayload {
  v?: number
  deviceID: string
  name?: string
  token: string
  urls: string[]
  secure?: boolean
  fingerprint?: string
}

/**
 * 解开服务端封装的凭据。
 * sealed = base64url 解码后的 buffer（服务端公钥 32 || nonce 12 || 密文+tag）
 */
export function openSealed(ephemeral: Ephemeral, sealedBase64Url: string): ConnectPayload {
  const sealed = Buffer.from(sealedBase64Url, 'base64url')
  if (sealed.length < 32 + 12 + 16) throw new Error('封装的数据太短')
  const serverPublicRaw = sealed.subarray(0, 32)
  const nonce = sealed.subarray(32, 44)
  const cipherAndTag = sealed.subarray(44)

  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyFromRaw(serverPublicRaw) })
  const salt = Buffer.concat([serverPublicRaw, ephemeral.publicKeyRaw])
  const key = Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32))

  const ciphertext = cipherAndTag.subarray(0, cipherAndTag.length - 16)
  const tag = cipherAndTag.subarray(cipherAndTag.length - 16)
  // AES-256-GCM：AAD = salt（与服务端一致；Electron 的 BoringSSL 没有 ChaCha20-Poly1305）
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  decipher.setAAD(salt, { plaintextLength: ciphertext.length })
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  const payload = JSON.parse(plain.toString('utf8')) as ConnectPayload
  if (!payload.token || !Array.isArray(payload.urls) || payload.urls.length === 0) {
    throw new Error('解开的凭据不完整')
  }
  return payload
}

/** 聊天里回执的标记 */
export const CONNECT_OK = 'FRIDAY-CONNECT-OK'

/** 从消息文本里取封装载荷（消息可能带额外说明文字） */
export function extractSealed(text: string): string | null {
  const at = text.indexOf(CONNECT_OK)
  if (at < 0) return null
  const rest = text.slice(at + CONNECT_OK.length).trim()
  const token = rest.split(/\s+/)[0]
  return token ? token : null
}
