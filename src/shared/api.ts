// 渲染进程 ⇆ 协议进程的 API 消息（方案 §7.3「暴露一组带类型的方法」）。
// 数据面走 MessagePort（高频事件不经过主进程），请求用 reqID 配对。

import type { ServerInfo } from '../protocol/rpc/protocol.js'

export type MachineRuntimeState =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'failed'
  | 'versionMismatch'

export interface MachineStateInfo {
  id: string
  name: string
  targetKind: 'ssh' | 'wsl' | 'ws' | 'work'
  /** 与 Qt remotes.json 的 target 一致：ssh:user@host[:port] / wsl:发行版 / wss://… / work:<botUserID> */
  targetText: string
  state: MachineRuntimeState
  detail?: string
  serverInfo?: ServerInfo
  /** 这台机器上有会话等着确认（侧边栏橙色点） */
  hasPendingApproval: boolean
}

/** remotes.json 里的一条（REMOTE.md §11）。0.3 起只有 work（SChat 扫码连入的机器人） */
export interface MachineEntry {
  id: string
  target: string
  name?: string
  identityFile?: string
  addedAt: string
}

export interface ParsedTarget {
  kind: 'ssh' | 'wsl' | 'ws' | 'work'
  host?: string
  port?: number
  distro?: string
  url?: string
  /** SChat 机器人（work 通道）：对端用户 id */
  botUserID?: number
  /** 配对链接带来的 */
  token?: string
  fingerprint?: string
  suggestedName?: string
  /** SSH 指定私钥文件 */
  identityFile?: string
}

export interface UploadedFileInfo {
  handle: string
  name: string
  size: number
}

/** 主进程背书过的本地文件（只认对话框/拖放得到的句柄，方案 §7.3） */
export interface PickedFile {
  handle: string
  name: string
  size: number
}

/** 本机系统资源快照（贾维斯 HUD 的远程遥测用；null = 这台测不了，显示 N/A） */
export interface SysStats {
  /** 采样那台的主机名（只作标识；「服务器是否就是本机」改用探针文件判，重名机器很常见） */
  hostname: string
  cpuPct: number | null
  ramPct: number | null
  gpuPct: number | null
  vramUsedMiB: number | null
  vramTotalMiB: number | null
  /** 系统进程数 */
  procs: number | null
}

/** sysstats.json 的格式（SysStats + 写入时刻）：别的电脑 fs.read 读它看这台的资源。
 *  at 是写入方的时钟，读的一方只看它变没变（两台的钟不比），超过 10 秒没变说明那台没在写（没跑/刚断），不采信 */
export interface SysStatsSnapshot extends SysStats {
  at: number
}

// MARK: 渲染 → 协议

export type HostRequest =
  | { type: 'machines.list' }
  | { type: 'machines.remove'; id: string }
  | { type: 'machines.connect'; id: string }
  | { type: 'machines.disconnect'; id: string }
  /** 取一台机器最近的会话列表（hello 快照 + summaries 事件维护，REMOTE.md §5） */
  | { type: 'summaries.get'; machineID: string }
  /** 取一台机器的实时卡片状态（终端/浏览器/子 Agent，M2） */
  | { type: 'state.get'; machineID: string }
  /** 任意协议方法透传（conversation.create / runner.submit / assistant.* …） */
  | { type: 'rpc'; machineID: string; method: string; params?: unknown }
  /** 在协议进程登记会话订阅（断线重连后自动恢复，并把事件转给渲染进程） */
  | { type: 'conversations.subscribe'; machineID: string; conversationID: string }
  | { type: 'conversations.unsubscribe'; machineID: string; conversationID: string }
  /** 补丁打不上时拉整条消息 */
  | { type: 'conversations.getMessage'; machineID: string; conversationID: string; messageID: string }
  /** 上传主进程背书的一个文件（file.upload 分块） */
  | { type: 'upload.sendFile'; machineID: string; handle: string }
  /** SChat 通道（M1.5）：读当前状态 */
  | { type: 'schat.state' }
  /** 开始扫码登录（不给 server 用默认生产地址） */
  | { type: 'schat.login'; server?: string; deviceName?: string }
  | { type: 'schat.disconnect' }
  | { type: 'schat.send'; botID: number; text: string }
  /** 重拉好友里的机器人列表（登录后列表为空/新加了机器人时用） */
  | { type: 'schat.refreshBots' }
  /** 从机器人列表直接建机器（0.3：WebRTC 工作通道） */
  | { type: 'machines.addWork'; botID: number; name?: string }
  /** 1:1 通话（M3-D）：拨打 / 信令 / 接通 / 静音 / 挂断 / ICE */
  | { type: 'schat.call.dial'; botID: number; callType?: 'audio' | 'video' }
  | { type: 'schat.call.signal'; signalType: string; payload: string }
  | { type: 'schat.call.active' }
  | { type: 'schat.call.mute'; muted: boolean }
  | { type: 'schat.call.accept' }
  | { type: 'schat.call.reject' }
  | { type: 'schat.call.hangup' }
  | { type: 'schat.call.ice' }
  /** 客户端设备：这台电脑连着的手机（adb server / usbmuxd 里的） */
  | { type: 'device.phones' }
  /** 客户端设备：TCP 隧道这台电脑这头连上目标（失败抛错）；字节之后走 tunnel.* 端口消息 */
  | { type: 'device.tunnel.open'; id: string; target: TunnelTarget }

// MARK: 协议 → 渲染

export type HostEvent =
  | { type: 'machines'; machines: MachineStateInfo[] }
  | { type: 'event'; machineID: string; method: string; params: unknown }

/** 请求的回执 */
export interface HostResponse {
  reqID: number
  ok: boolean
  result?: unknown
  error?: string
  /** 协议错误码（REMOTE.md §4） */
  code?: number
}

export interface HostEnvelope {
  reqID: number
  request: HostRequest
}

// MARK: 客户端设备（方案-客户端设备）：服务端的 device.* 请求在渲染进程处理

/** TCP 隧道的目标：局域网 / 本机的 host:port，或本机的 adb server（只放行一台手机）、usbmuxd */
export type TunnelTarget = { kind: 'tcp'; host: string; port: number } | { kind: 'adb'; serial: string } | { kind: 'usbmux' }

/** TCP 隧道的字节（渲染进程的 DataChannel ⇆ 协议进程的 socket，走数据面端口） */
export type TunnelPortMessage =
  | { type: 'tunnel.data'; id: string; data: ArrayBuffer }
  | { type: 'tunnel.close'; id: string }
  | { type: 'tunnel.pause'; id: string }
  | { type: 'tunnel.resume'; id: string }
  | { type: 'tunnel.closed'; id: string; reason: string }

/** 协议进程 ⇆ 渲染进程的 device 消息（不带 reqID，和 work.* 一样走数据面端口） */
export type DevicePortMessage =
  /** 协议 → 渲染：服务端发来一条 device.* 请求（serverID = 服务端的 JSON-RPC id，进度通知要带） */
  | { type: 'device.request'; machineID: string; rid: number; serverID: number | string; method: string; params: unknown }
  /** 协议 → 渲染：这条请求不用再回了（超时 / 机器断了） */
  | { type: 'device.cancel'; rid: number }
  /** 渲染 → 协议：请求的结果 */
  | { type: 'device.reply'; rid: number; ok: true; result: unknown }
  | { type: 'device.reply'; rid: number; ok: false; code: number; message: string }
  /** 渲染 → 协议：给这台机器的服务端发一条通知（进度 / 会话关了 / 设备变了） */
  | { type: 'device.notify'; machineID: string; method: string; params: unknown }
