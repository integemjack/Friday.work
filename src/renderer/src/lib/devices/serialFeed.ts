// 客户端设备：串口内容投桌面（HUD 串口屏）——把串口字节流解码成一行行文本。
// UTF-8 流式解码（多字节字符跨段不断裂），按 \n 分行、剔 \r 和别的控制字符
// （二进制流量路过也不会把屏刷成乱码），超长行截断。纯函数：喂字节、出文本行，单测直接跑。

/** 单行最多显示的字符（超长截断，串口日志偶尔一长串 hex / base64 时不把屏撑爆） */
export const MAX_LINE = 200
/** 半行攒到这么长还没等到换行（设备打的是不换行的连续输出）：先交一行，让屏滚起来 */
const HALF_LINE_FLUSH = MAX_LINE * 2

/** 除 \t 外的全部控制字符（\n 由分行处理，\r 与其余的一并剔除；U+FFFD 是丢字时的替换字符，一并剔） */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\uFFFD]/g

export interface SerialLineFeeder {
  /** 串口读到的一段字节（按到达顺序喂） */
  push(bytes: Uint8Array): void
  /** 会话结束：解码器里剩的字节、没等到换行的最后半行也交出去 */
  flush(): void
}

export function makeSerialLineFeeder(onLine: (line: string) => void): SerialLineFeeder {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let pending = ''

  const emit = (raw: string): void => {
    const line = raw.replace(CONTROL, '').trim()
    if (!line) return
    onLine(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line)
  }

  const split = (text: string): void => {
    pending += text
    for (;;) {
      const nl = pending.indexOf('\n')
      if (nl < 0) break
      emit(pending.slice(0, nl))
      pending = pending.slice(nl + 1)
    }
    if (pending.length > HALF_LINE_FLUSH) {
      emit(pending.slice(0, MAX_LINE))
      pending = pending.slice(MAX_LINE)
    }
  }

  return {
    push: (bytes) => split(decoder.decode(bytes, { stream: true })),
    flush: () => {
      split(decoder.decode())
      if (pending) {
        emit(pending)
        pending = ''
      }
    }
  }
}
