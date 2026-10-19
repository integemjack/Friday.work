// `/connect` 的封装格式（与服务端 qt/src/core/remote/SealedBox.cpp 同一套参数）。
// 这里用 Node 自己扮演服务端，按同样的布局封一段凭据，再看客户端能不能解开——
// 锁住的是：X25519 → HKDF-SHA256(salt=两边公钥, info="friday-connect-v1") → AES-256-GCM(AAD=salt)、
// 回包布局 srvPub(32) || nonce(12) || ciphertext||tag(16)。
const test = require('node:test')
const assert = require('node:assert')

const { generateEphemeral, openSealed, extractSealed, CONNECT_OK } = require('../.tmp/connect.cjs')

const { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } = require('node:crypto')

/** 扮演服务端：用对方的临时公钥封装一段 JSON */
function sealLikeServer(peerPublicRaw, payload) {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const serverPublicRaw = Buffer.from(der.subarray(der.length - 32))

  const clientKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), peerPublicRaw]),
    format: 'der',
    type: 'spki'
  })
  const shared = diffieHellman({ privateKey, publicKey: clientKey })
  const salt = Buffer.concat([serverPublicRaw, peerPublicRaw])
  const key = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('friday-connect-v1'), 32))
  const nonce = Buffer.alloc(12, 7)

  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(salt, { plaintextLength: Buffer.byteLength(JSON.stringify(payload)) })
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([serverPublicRaw, nonce, ciphertext, tag]).toString('base64url')
}

test('/connect：客户端能解开服务端封装的凭据', () => {
  const ephemeral = generateEphemeral()
  assert.equal(ephemeral.publicKeyRaw.length, 32, '公钥要 32 字节')

  const payload = {
    v: 1,
    deviceID: 'AA11BB22',
    name: '扫码连入的设备',
    token: 'tok_abcdef',
    urls: ['wss://192.168.20.239:7443', 'wss://100.64.0.5:7443'],
    secure: true,
    fingerprint: 'EE:14:8A'
  }
  const sealed = sealLikeServer(ephemeral.publicKeyRaw, payload)
  const opened = openSealed(ephemeral, sealed)

  assert.equal(opened.token, 'tok_abcdef')
  assert.equal(opened.deviceID, 'AA11BB22')
  assert.deepEqual(opened.urls, payload.urls)
  assert.equal(opened.fingerprint, 'EE:14:8A')
})

test('/connect：换了私钥就解不开（AAD 与密钥都绑了双方公钥）', () => {
  const ephemeral = generateEphemeral()
  const sealed = sealLikeServer(ephemeral.publicKeyRaw, { deviceID: 'X', token: 't', urls: ['wss://a:1'] })
  const other = generateEphemeral()
  assert.throws(() => openSealed(other, sealed))
})

test('/connect：被篡改的密文会被 AEAD 挡住', () => {
  const ephemeral = generateEphemeral()
  const sealed = Buffer.from(
    sealLikeServer(ephemeral.publicKeyRaw, { deviceID: 'X', token: 't', urls: ['wss://a:1'] }),
    'base64url'
  )
  sealed[sealed.length - 20] ^= 0xff // 动一个字节
  assert.throws(() => openSealed(ephemeral, sealed.toString('base64url')))
})

test('/connect：从聊天文本里取封装载荷', () => {
  const text = `FRIDAY-CONNECT-OK abc_DEF-123\n\n配对好了：设备「手机」（AA11）。`
  assert.equal(extractSealed(text), 'abc_DEF-123')
  assert.equal(extractSealed(`随便一句话`), null)
  assert.equal(CONNECT_OK, 'FRIDAY-CONNECT-OK')
})
