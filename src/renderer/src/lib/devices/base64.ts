// 客户端设备：固件 / 照片在 JSON-RPC 里走 base64（WorkFramer 负责大消息分片）。

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  // 分段拼：String.fromCharCode(...大数组) 会爆栈
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}
