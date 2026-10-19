// SSH/WSL 传输的行分帧：协议上每条消息一行紧凑 UTF-8 JSON + \n（REMOTE.md §2）。
// JSON 文本里不会出现裸换行，按 \n 切即可；容忍远端 \r\n。

export class LineFramer {
  private buffer = ''

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > 0) this.onLine(line)
    }
  }

  /** 流结束；剩下的不算消息（协议不会半行结束） */
  flush(): string {
    return this.buffer
  }
}
