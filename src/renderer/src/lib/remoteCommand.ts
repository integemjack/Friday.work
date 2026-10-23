// 在服务端跑一条一次性命令并等它结束（term.open 带 command：服务端用它的 shell 跑——Windows 是 PowerShell）。
// 用后台终端：store 里登记过的不进终端列表、不弹终端窗口；跑完立刻 term.close。
// term.open 必须挂在一段会话上（协议要求 conversationID），调用方给当前会话或最近一段。
import { host, rpc } from './host.js'
import { backgroundTerminalInfo, registerBackgroundTerminal, releaseBackgroundTerminal } from '../stores/app.js'

export async function runRemoteCommand(
  machineID: string,
  conversationID: string,
  command: string,
  timeoutMs = 10 * 60_000
): Promise<{ exitCode: number | undefined; output: string }> {
  const id = crypto.randomUUID()
  const decoder = new TextDecoder()
  let output = ''
  const off = host.onEvent((event) => {
    if (event.type !== 'event' || event.method !== 'term.output') return
    const params = event.params as { id?: string; data?: string }
    if (params.id !== id || !params.data) return
    const binary = atob(params.data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    output = (output + decoder.decode(bytes, { stream: true })).slice(-8000)
  })
  registerBackgroundTerminal(id)
  try {
    await rpc(machineID, 'term.open', { id, conversationID, command, cols: 200, rows: 50 })
    // attach 才收得到输出（出错时要拿错误信息）；拿不到也不影响等结束
    await rpc(machineID, 'term.attach', { id }).catch(() => {})
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const info = backgroundTerminalInfo(id)
      if (info && !info.running) {
        // 流式解码收尾（不 flush 的话末尾多字节 UTF-8 序列被截成 U+FFFD）
        output = (output + decoder.decode()).slice(-8000)
        return { exitCode: info.exitCode, output }
      }
      if (Date.now() > deadline) throw new Error('服务端命令超时没结束')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  } finally {
    off()
    await rpc(machineID, 'term.close', { id }).catch(() => {})
    // 关掉后服务端还会再推一次 terminals：等一下再注销，免得这个终端在列表里闪一下
    setTimeout(() => releaseBackgroundTerminal(id), 5000)
  }
}
