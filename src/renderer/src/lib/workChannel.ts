// WebRTC 工作通道（0.3，REMOTE.md §2）：渲染进程这一头的 RTCPeerConnection + DataChannel。
//
// WebRTC 只能在渲染进程（utilityProcess 没有）；协议进程负责信令（WorkSignaling）和 JSON-RPC，
// 两头经 MessagePort 搬运（协议进程 host.ts 的 work.* 消息）：
//   work.signal（信令：accepted → 这里建 PC 出 offer；signal → 喂 PC）
//   work.out / work.in（DataChannel 上的整条 JSON）
//   work.open / work.closed（通道状态 → 协议进程好去 hello / 断开重拨）
//
// ICE 服务器与语音通话同一套（schat.call.ice：内置 STUN + 账号的 TURN）。
// 每台 work 机器一个 WorkChannel；断开由协议进程驱动重拨（新的 requestId → 新的 PC）。

import { encode, WorkFramer } from './workFramer.js'

/** 协议进程发来的信令事件（WorkSignalEvent 的渲染进程侧形状） */
export type WorkSignalIn =
  | { kind: 'accepted'; requestId: string }
  | { kind: 'signal'; requestId: string; type: string; payload: string }
  | { kind: 'ended'; requestId: string; reason: string }

interface WorkChannelCallbacks {
  onOpen(machineID: string, requestId: string): void
  onData(machineID: string, text: string): void
  onClosed(machineID: string, requestId: string, reason: string): void
  onSignalOut(machineID: string, signalType: string, payload: string): void
  iceServers(): Promise<RTCIceServer[]>
}

/** 一台机器的连接：信令 accepted 后建 PC，DataChannel 开了就算通道就绪 */
class WorkChannel {
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private readonly framer = new WorkFramer()
  /** accept 的代数：await iceServers 期间又来一次 accept（重拨）时，旧的那次作废——
   *  不然两条并行各建一个 PC，先建的泄漏还照常打洞 */
  private acceptGen = 0
  requestId = ''

  constructor(
    private readonly machineID: string,
    private readonly callbacks: WorkChannelCallbacks
  ) {
    this.log('constructed')
  }

  /** 验收日志：console + window 留底（CDP 探针可读） */
  private log(line: string): void {
    // eslint-disable-next-line no-console
    console.log(`[workChannel ${this.machineID}] ${line}`)
    const w = window as unknown as { __workDebug?: string[] }
    ;(w.__workDebug ??= []).push(`${new Date().toISOString().slice(11, 23)} ${line}`)
  }

  /** 机器人接受了（p2p_response accepted）：建 PC + DataChannel、出 offer */
  async accept(requestId: string): Promise<void> {
    this.log(`accept req=${requestId}`)
    this.teardownPeer()
    this.requestId = requestId
    const gen = ++this.acceptGen
    const iceServers = await this.callbacks.iceServers()
    if (gen !== this.acceptGen) {
      // 期间又有一次更新的 accept：这次建的 PC 丢弃不登记，直接关掉
      this.log('accept 过期（有更新的拨号），丢弃')
      return
    }
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' })
    this.pc = pc
    // 数据通道：有序、可靠（JSON-RPC 语义），先建再出 offer（SDP 里才有 m=application）
    const dc = pc.createDataChannel('friday-work', { ordered: true })
    this.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.onopen = () => {
      this.log('DataChannel OPEN')
      this.callbacks.onOpen(this.machineID, this.requestId)
    }
    dc.onclose = () => this.callbacks.onClosed(this.machineID, this.requestId, '通道关了')
    dc.onerror = () => this.callbacks.onClosed(this.machineID, this.requestId, '通道出错')
    dc.onmessage = (event) => this.onFrame(event.data)
    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      this.callbacks.onSignalOut(
        this.machineID,
        'ice_candidate',
        JSON.stringify({
          sdpMid: event.candidate.sdpMid ?? '0',
          sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0,
          candidate: event.candidate.candidate
        })
      )
    }
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      this.log('pc state=' + state)
      if (state === 'failed') {
        this.callbacks.onClosed(this.machineID, this.requestId, 'WebRTC 连不上（NAT 穿透失败）')
      }
    }
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.log('offer ready，iceServers=' + iceServers.length + '，发送 offer')
    this.callbacks.onSignalOut(this.machineID, 'offer', offer.sdp ?? '')
  }

  /** 对端信令（answer / ice_candidate） */
  async signal(type: string, payload: string): Promise<void> {
    this.log(`signal ${type} len=${payload.length}`)
    const pc = this.pc
    if (!pc) return
    if (type === 'answer') {
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: payload })
      } catch {
        // 坏 SDP / 乱序：连接状态机会兜底
      }
      return
    }
    if (type === 'ice_candidate') {
      try {
        const parsed = JSON.parse(payload) as { sdpMid?: string; sdpMLineIndex?: number; candidate: string }
        await pc.addIceCandidate({
          candidate: parsed.candidate,
          sdpMid: parsed.sdpMid ?? '0',
          sdpMLineIndex: parsed.sdpMLineIndex ?? 0
        })
      } catch {
        // 候选来早了或已过期：忽略
      }
    }
  }

  /** 协议进程要发一条 JSON 到 DataChannel（分片在这里做；文本帧 send(string)，二进制片 send(ArrayBuffer)） */
  send(text: string): void {
    const dc = this.dc
    if (!dc || dc.readyState !== 'open') return
    for (const frame of encode(text)) {
      if (frame.binary) dc.send(frame.data as ArrayBuffer)
      else dc.send(frame.data as string)
    }
  }

  /** 在同一个 PC 上再开一条 DataChannel（客户端设备的串口会话；带内 DCEP，不用重新协商）。
   *  工作通道还没通就返回 null */
  openDataChannel(label: string): RTCDataChannel | null {
    if (!this.pc || this.dc?.readyState !== 'open') return null
    const channel = this.pc.createDataChannel(label, { ordered: true })
    channel.binaryType = 'arraybuffer'
    return channel
  }

  private onFrame(data: unknown): void {
    // 服务端发文本帧时 data 是 string，二进制片时是 ArrayBuffer（binaryType='arraybuffer'）
    if (typeof data === 'string') {
      this.callbacks.onData(this.machineID, data)
      return
    }
    if (!(data instanceof ArrayBuffer)) return
    const feed = this.framer.feed(true, data)
    if (feed.state === 'ready') {
      this.callbacks.onData(this.machineID, feed.message)
      return
    }
    if (feed.state === 'invalid') {
      this.callbacks.onClosed(this.machineID, this.requestId, '通道协议错（分片对不上）')
      this.teardownPeer()
    }
    // 'more'：接着攒
  }

  /** 本地主动断开（机器被删 / 应用退出）：不发 closed（协议进程自己知道） */
  dispose(): void {
    this.teardownPeer()
  }

  private teardownPeer(): void {
    const dc = this.dc
    const pc = this.pc
    this.dc = null
    this.pc = null
    if (dc) {
      dc.onopen = null
      dc.onclose = null
      dc.onerror = null
      dc.onmessage = null
      try {
        dc.close()
      } catch {
        /* 已经关了 */
      }
    }
    if (pc) {
      pc.onicecandidate = null
      pc.onconnectionstatechange = null
      try {
        pc.close()
      } catch {
        /* 已经关了 */
      }
    }
  }
}

export class WorkChannelHub {
  private readonly channels = new Map<string, WorkChannel>()
  private readonly callbacks: WorkChannelCallbacks

  constructor(callbacks: Omit<WorkChannelCallbacks, 'iceServers'> & { iceServers(): Promise<RTCIceServer[]> }) {
    this.callbacks = callbacks
  }

  /** 协议进程的信令进来（work.signal） */
  onSignal(machineID: string, signal: WorkSignalIn): void {
    if (signal.kind === 'ended') {
      // 协议进程已经收尾（被拒 / 超时 / 挂断）：把 PC 一起清掉
      this.channels.get(machineID)?.dispose()
      this.channels.delete(machineID)
      return
    }
    if (signal.kind === 'accepted') {
      let channel = this.channels.get(machineID)
      if (!channel) {
        channel = new WorkChannel(machineID, this.callbacks)
        this.channels.set(machineID, channel)
      }
      void channel.accept(signal.requestId)
      return
    }
    this.channels.get(machineID)?.signal(signal.type, signal.payload)
  }

  /** 协议进程要发一条 JSON（work.out） */
  send(machineID: string, text: string): void {
    this.channels.get(machineID)?.send(text)
  }

  /** 客户端设备：在这台机器的工作连接上开一条额外的 DataChannel */
  openDataChannel(machineID: string, label: string): RTCDataChannel | null {
    return this.channels.get(machineID)?.openDataChannel(label) ?? null
  }

  disposeAll(): void {
    for (const channel of this.channels.values()) channel.dispose()
    this.channels.clear()
  }
}
