// Intel HEX → 一段连续的镜像（Arduino、STM32 的编译产物常是 .hex）。空洞填 0xFF（flash 擦除后的值）。
// 认数据（00）、结束（01）、扩展段地址（02）、扩展线性地址（04）；起始地址（03 / 05）忽略。每行校验和都核对。

export interface HexImage {
  /** 镜像的起始地址 */
  base: number
  data: Uint8Array
}

const MAX_IMAGE = 16 * 1024 * 1024

export function parseIntelHex(text: string): HexImage {
  const chunks: Array<{ address: number; bytes: Uint8Array }> = []
  let upper = 0
  let ended = false
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length && !ended; index++) {
    const line = lines[index].trim()
    if (line.length === 0) continue
    if (!line.startsWith(':') || line.length < 11 || line.length % 2 === 0) throw new Error(`HEX 第 ${index + 1} 行格式不对`)
    const bytes = new Uint8Array((line.length - 1) / 2)
    for (let i = 0; i < bytes.length; i++) {
      const value = Number.parseInt(line.slice(1 + i * 2, 3 + i * 2), 16)
      if (Number.isNaN(value)) throw new Error(`HEX 第 ${index + 1} 行有非十六进制字符`)
      bytes[i] = value
    }
    const length = bytes[0]
    if (bytes.length !== length + 5) throw new Error(`HEX 第 ${index + 1} 行长度对不上`)
    const sum = bytes.reduce((total, byte) => (total + byte) & 0xff, 0)
    if (sum !== 0) throw new Error(`HEX 第 ${index + 1} 行校验和不对`)
    const offset = (bytes[1] << 8) | bytes[2]
    const type = bytes[3]
    const payload = bytes.subarray(4, 4 + length)
    switch (type) {
      case 0x00:
        chunks.push({ address: upper + offset, bytes: payload })
        break
      case 0x01:
        ended = true
        break
      case 0x02:
        upper = ((payload[0] << 8) | payload[1]) * 16
        break
      case 0x04:
        upper = ((payload[0] << 8) | payload[1]) * 0x10000
        break
      default:
        break
    }
  }
  if (chunks.length === 0) throw new Error('HEX 里没有数据')
  const base = Math.min(...chunks.map((chunk) => chunk.address))
  const end = Math.max(...chunks.map((chunk) => chunk.address + chunk.bytes.length))
  if (end - base > MAX_IMAGE) throw new Error('HEX 的地址跨度太大')
  const data = new Uint8Array(end - base).fill(0xff)
  for (const chunk of chunks) data.set(chunk.bytes, chunk.address - base)
  return { base, data }
}
