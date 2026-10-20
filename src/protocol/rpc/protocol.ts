// Friday 远程协议（REMOTE.md v2.1+）——类型与常量。
// 本文件是协议的唯一前端真相：所有字段名与 Qt 客户端（qt/src/core/remote、models/ChatModels）逐一对齐。

// MARK: JSON-RPC 2.0

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

/** 事件（没有 id） */
export interface JsonRpcEvent {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcErrorObj {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: JsonRpcErrorObj
}

/** 协议层错误码（REMOTE.md §4） */
export const RpcErrors = {
  Parse: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  /** hello 的 protocol 不一样 */
  ProtocolVersion: 1,
  /** 还没 hello 就调方法 */
  NotHello: 2,
  NotFound: 3,
  /** 现在不能（浏览器不可用、WebSocket 连接不能做终端/文件/服务类操作…） */
  NotAllowed: 4,
  /** WebSocket 令牌不对 / 已吊销：回完就断开，客户端不再自动重连 */
  Unpaired: 5
} as const

/** 客户端与服务端约定的协议版本 */
export const PROTOCOL_VERSION = 1

// MARK: hello（REMOTE.md §3）

export interface HelloClient {
  name: string
  version: string
  /** 客户端所在平台：windows / macos / linux */
  platform: 'windows' | 'macos' | 'linux'
  kind: 'desktop' | 'mobile' | 'watch'
}

export interface HelloParams {
  protocol: number
  client: HelloClient
  /** 必须声明 messagePatch（v2.3 起） */
  features?: string[]
  /** 仅 WebSocket 连接需要（配对令牌） */
  token?: string
}

export interface ServerInfo {
  version: string
  platform: string
  arch: string
  hostname: string
  user: string
  home: string
  dataDir: string
  pid: number
  startedAt: string
  defaultWorkingDirectory?: string
  /** 谁在提供服务（§12） */
  host?: 'server' | 'desktop' | 'swift'
  features?: string[]
}

/** hello 回来的整份状态快照（state） */
export interface StateSnapshot {
  summaries: ConversationSummary[]
  runner: RunnerState
  team: TeamState
  engines: EnginesState
  secrets: { names: string[] }
  directories?: DirectoriesState
  terminals?: TerminalsState
  browser?: BrowserState
}

export interface HelloResult {
  protocol: number
  server: ServerInfo
  state: StateSnapshot
}

// MARK: 数据模型（ARCHITECTURE.md §5.3 / REMOTE.md §5；字段名与 Qt ChatModels 对齐）

export type Uuid = string
/** ISO 8601 UTC 无毫秒 */
export type Iso = string

export type PermissionMode = 'auto' | 'plan' | 'full'
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'ultra'

export interface ConversationSummary {
  id: Uuid
  title: string
  updatedAt: Iso
  pinned: boolean
  isEmpty: boolean
  hasDraft: boolean
  workingDirectory?: string
  workingDirectoryName?: string
  permissionMode: PermissionMode
  thinking?: ThinkingLevel
  teamMode?: string
  engineID?: Uuid
}

export interface QueuedInput {
  id: string
  text: string
  /** 服务端上的路径（file.upload 的结果） */
  attachments: string[]
  createdAt: Iso
  from?: { kind: string; label?: string }
}

/** 一段会话的运行状态（runtime 事件 / conversation.subscribe 回执） */
export interface Runtime {
  generating: boolean
  stopping: boolean
  queue: QueuedInput[]
  queuePaused: boolean
  pendingApproval: boolean
  failedMessageID?: Uuid
  canRetry: boolean
  /** 上一次发消息时的模型/思考档位和现在不一样，重试时问要不要换过去 */
  pendingTurnChanges: { model: boolean; thinking: boolean }
  canSend: boolean
  engine?: Record<string, unknown>
  thinkingLevel: ThinkingLevel
  thinkingLevels: ThinkingLevel[]
  permissionMode: PermissionMode
  workingDirectory?: string
  mainLiveSpeed: number
}

/** 这台机器全部会话的运行状态（runner 事件 / state.runner） */
export interface RunnerState {
  generating: Uuid[]
  stopping: Uuid[]
  pendingApproval: Uuid[]
  pendingQuestion: Uuid[]
  backgroundAgents: Uuid[]
  liveAgents: number
  liveSpeed: number
  queueRevision: number
}

export interface TeamRun {
  id: Uuid
  name: string
  parentKey: string
  conversationID: Uuid
  background: boolean
  depth: number
  running: boolean
  detached: boolean
  stopRequested: boolean
  activity?: { kind: string; title: string }
  steps: number
  started: Iso
  lastOutput?: string
  deadline?: Iso
  speed: number
  passTokens: number
  queue: QueuedInput[]
}

export interface TeamState {
  runs: TeamRun[]
}

export interface EngineConfig {
  id: Uuid
  title: string
  baseURL?: string
  apiKeySecret?: string
  model?: string
  supportsVision?: boolean
  supportsTools?: boolean
  disabled?: boolean
  [key: string]: unknown
}

export interface EnginesState {
  engines: EngineConfig[]
  defaultEngineID?: Uuid
}

export interface DirectoriesState {
  recent: { path: string; exists: boolean }[]
}

export interface TerminalInfo {
  id: string
  conversationID: Uuid
  title: string
  shell: string
  command?: string
  running: boolean
  exitCode?: number
  cols: number
  rows: number
}

export interface TerminalsState {
  terminals: TerminalInfo[]
  available: boolean
  reason?: string
}

export interface BrowserTab {
  id: string
  conversationID: Uuid
  title: string
  url: string
  loading: boolean
  current: boolean
  viewport: [number, number]
  fixed: boolean
  handOver?: { reason: string }
  dialog?: { type: string; message: string; defaultText?: string }
}

export interface BrowserState {
  available: boolean
  reason?: string
  tabs: BrowserTab[]
}

// MARK: 消息与块（与 Qt ChatModels.cpp 的 JSON 编码逐字段对齐）

export type MediaKind = 'image' | 'video' | 'audio' | 'file' | string

export interface MediaAttachment {
  id: Uuid
  kind: MediaKind
  /** 相对媒体目录、/ 分隔 */
  relativePath: string
  fileName: string
  mimeType: string
  byteCount: number
  caption?: string
  width?: number
  height?: number
}

/** 子 Agent / 模型一次调用的用量（工具的 usage） */
export interface AgentUsage {
  model: string
  service?: string
  thinking: string
  temperature: number
  generatedTokens: number
  promptTokens: number
  generateTime: number
  cachedTokens?: number
}

export type ToolStatus = 'awaitingApproval' | 'running' | 'succeeded' | 'failed' | 'denied'

export interface ToolEvent {
  id: Uuid
  name: string
  /** 参数的 JSON 文本 */
  arguments: string
  status: ToolStatus
  result: string
  title?: string
  symbol?: string
  preview?: string
  media?: MediaAttachment[]
  /** 子 Agent 的运行记录：下一层的块 */
  transcript?: MessageBlock[]
  agentName?: string
  queued?: boolean
  stopped?: boolean
  usage?: AgentUsage
  hint?: string
  recalled?: boolean
  surprise?: number
  hallucination?: string
  /** 后台子 Agent 结束时模型当时拿到的结果（界面上显示结论 result） */
  modelResult?: string
  linesAdded?: number
  linesRemoved?: number
}

export interface GenerationStats {
  tokensPerSecond: number
  tokenCount: number
  promptTokenCount?: number
  promptTokensPerSecond?: number
  contextTokenCount?: number
  live?: boolean
  prefilling?: boolean
  startedAt?: Iso
  engineName?: string
  firstTokenSeconds?: number
  cachedTokenCount?: number
}

export type ChatRole = 'user' | 'assistant' | string

/** MessageBlock 线上形状：{id, kind: {case: payload}}（Swift 带关联值枚举的 Codable） */
export type BlockKind =
  | { text: string }
  | { thinking: string }
  | { tool: ToolEvent }
  | { media: MediaAttachment }
  | { [key: string]: unknown }

export interface MessageBlock {
  id: Uuid
  kind: BlockKind
}

export function blockCase(block: MessageBlock): string {
  for (const key of Object.keys(block.kind)) return key
  return ''
}

/**
 * 取块里那种 case 的值。线上形状是 Swift 带关联值枚举的 Codable：`{"text":{"_0":"…"}}`，
 * 带关联值的一律包在 `_0` 里（Qt 的 Json::readEnumCase 同样处理）；
 * thinking 之类的裸字符串（没有关联值包装）直接返回。
 */
export function blockPayload<T>(block: MessageBlock, caseName: string): T | undefined {
  const value = (block.kind as Record<string, unknown>)[caseName]
  if (value === undefined) return undefined
  if (value !== null && typeof value === 'object' && '_0' in (value as Record<string, unknown>)) {
    return (value as Record<string, T>)['_0']
  }
  return value as T
}

export interface ChatMessage {
  id: Uuid
  role: ChatRole
  blocks: MessageBlock[]
  createdAt: Iso
  stats?: GenerationStats
  error?: string
  notice?: string
  /** 消息树：根消息没有 parentID */
  parentID?: Uuid
  taskNote?: string
  folded?: boolean
  stoppedByUser?: boolean
  interjected?: boolean
  hookBlocked?: boolean
  commandPrompt?: string
  fromAgent?: string
  sentBy?: string
  checks?: string[]
  finishedAt?: Iso
  quotaWait?: { provider?: string; reason?: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface Conversation {
  id: Uuid
  title: string
  createdAt: Iso
  updatedAt: Iso
  nodes: ChatMessage[]
  /** 消息树的当前路径：父消息 id → 选中的孩子 id */
  selectedChildren: Record<Uuid, Uuid>
  engineID?: Uuid
  workingDirectory?: string
  permissionMode: PermissionMode
  thinking?: ThinkingLevel
  pinned: boolean
}

/** conversation 事件（REMOTE.md §5）：增量时只带客户端没有或变了的消息 */
export interface ConversationEventParams {
  conversation: Conversation
  partial?: boolean
  /** partial 时：全部消息的顺序（对应服务端 nodes 的完整集合） */
  nodeIDs?: Uuid[]
  versions?: Record<Uuid, number>
}

/** message 事件：整条消息替换，带版本 */
export interface MessageEventParams {
  conversationID: Uuid
  message: ChatMessage
  version: number
}

/** message.patch 事件（v2.3）：块补丁一层层递归 */
export interface MessagePatchParams {
  conversationID: Uuid
  messageID: Uuid
  /** 本地版本要对上的基线 */
  base: number
  /** 打上补丁后的版本 */
  version: number
  /** 消息除 blocks 以外的全部字段 */
  fields?: ChatMessage
  blocks?: BlocksPatch
}

/** 一层块的补丁：ids = 这一层块的完整顺序；set = 整块换掉；tools = 工具块分开比 */
export interface BlocksPatch {
  ids?: Uuid[]
  set?: MessageBlock[]
  tools?: ToolPatch[]
}

export interface ToolPatch {
  id: Uuid
  /** 工具字段（JSON 里没有 transcript） */
  tool?: ToolEvent
  /** 运行记录：下一层的块补丁 */
  transcript?: BlocksPatch
}

// MARK: 方法回执（REMOTE.md §6，M1 用到的）

export interface SubscribeResult {
  conversation: Conversation
  runtime: Runtime
  versions?: Record<Uuid, number>
}

export interface MessageGetResult {
  message: ChatMessage
  version: number
}

export interface FileUploadResult {
  path: string
}

// MARK: 活动与审批（REMOTE.md §6「会话的实时动静」）

export interface PendingApproval {
  eventID: string
  tool: string
  title: string
  summary: string
}

export interface SessionActivity {
  id: Uuid
  title: string
  workingDirectory?: string
  status: 'idle' | 'running' | 'approval' | 'question' | 'quota' | 'error'
  task?: { goal: string; steps: Array<{ text: string; status: 'todo' | 'doing' | 'done' }> }
  lastBrief?: Record<string, unknown>
  approvals: PendingApproval[]
  currentTool?: { tool: string; title: string; summary: string }
  startedBy?: { kind: string; label?: string }
  updatedAt: Iso
}

export interface ActivitySubscribeResult {
  sessions: SessionActivity[]
}

export interface ActivityEventParams {
  conversationID: Uuid
  kind: 'started' | 'step' | 'tool' | 'approval' | 'quota' | 'stalled' | 'finished'
  seq: number
  at: Iso
  title?: string
  workingDirectory?: string
  approvals?: PendingApproval[]
  brief?: Record<string, unknown>
  [key: string]: unknown
}

// MARK: 助手日志（M3-A 语音 / 助手时间线，REMOTE.md §6「助手」）

export interface AssistantAttachment {
  path: string
  size?: number
  missing?: boolean
}

export interface AssistantEntry {
  id: string
  at: Iso
  kind: 'user' | 'assistant' | 'receipt' | 'tool' | 'notice'
  source?: string
  text: string
  projects?: string[]
  refs?: string[]
  interrupted?: boolean
  streaming?: boolean
  data?: {
    silent?: boolean
    error?: boolean
    details?: string
    name?: string
    arguments?: string
    result?: string
    reply?: string
    attachments?: AssistantAttachment[]
    direct?: { machineID: string; conversationID: Uuid }
    [key: string]: unknown
  }
}

export interface AssistantState {
  enabled: boolean
  reacting: boolean
  reactingEntryID?: string
  config?: Record<string, unknown>
  brainEngineTitle?: string
  engines?: Array<{ id: string; title: string; model: string; supportsTools?: boolean }>
}

export interface AssistantSubscribeResult {
  state: AssistantState
  entries: AssistantEntry[]
  board?: Record<string, unknown>
  channels?: Array<Record<string, unknown>>
}

// MARK: 终端 / 浏览器 / 文件（M2）
/** term.attach 回执：最近输出（≤512 KB）+ 伪终端现在的大小 */
export interface TermAttachResult {
  data: string
  cols: number
  rows: number
}

export interface BrowserFrameParams {
  tab: string
  data: string
  viewport: [number, number]
}

export interface BrowserDownloadParams {
  tab: string
  name: string
  path: string
  state: 'progress' | 'done' | 'failed'
  fraction?: number
}

// MARK: 文件（M2，FILES.md）

export interface FsEntry {
  name: string
  path: string
  /** fs.list 带 files: true 时才有 */
  dir?: boolean
  size?: number
  modified?: Iso
}

export interface FsListResult {
  path: string
  parent?: string
  entries: FsEntry[]
  roots?: Array<{ name: string; path: string }>
  truncated?: boolean
}

export interface FsReadResult {
  data: string
  size: number
  eof: boolean
}

export interface FsChange {
  path: string
  status: 'A' | 'M' | 'D'
  known: boolean
  text?: string
  added: number
  removed: number
}

export interface FsChangesResult {
  files: FsChange[]
}

export interface FsDiffResult {
  path: string
  status: 'A' | 'M' | 'D'
  known: boolean
  binary: boolean
  tooLarge: boolean
  old: string
  new: string
}

export interface FsRevertResult {
  failed: Array<{ path: string; error: string }>
}

/** 一台机器的实时状态（hello 快照 + 对应事件维护；切机器时渲染进程取一份） */
export interface MachineLiveState {
  terminals: TerminalsState
  browser: BrowserState
  team: TeamState
  /** 运行状态（liveAgents / liveSpeed；标题栏实时指示用；旧服务端没有） */
  runner?: RunnerState
  /** 引擎（设置窗口用；字段与 EnginesState.engines 一致） */
  engines: EngineConfigView[]
  defaultEngineID: string
  /** 最近选择的工作目录（输入框的目录选择器用；旧服务端没有） */
  directories?: DirectoriesState
}

/** EnginesState 里的引擎条目（REMOTE.md §5；只有密钥名，没有值） */
export interface EngineConfigView {
  id: string
  title: string
  model: string
  kind?: string
  supportsTools?: boolean
  disabled?: boolean
  apiKeySecret?: string
  [key: string]: unknown
}

export interface ServerPairResult {
  deviceID: string
  name: string
  token: string
  urls: string[]
  secure: boolean
  fingerprint?: string
  link: string
}

export interface ServerWebsocketResult {
  enabled: boolean
  listening: boolean
  bind: string
  port: number
  secure: boolean
  fingerprint?: string
  urls: string[]
  error?: string
}

// MARK: 事件名（REMOTE.md §5 全表，客户端按需订阅/转发）

export const RemoteEvents = [
  'summaries',
  'conversation',
  'message',
  'message.patch',
  'runner',
  'runtime',
  'team',
  'engines',
  'secrets',
  'directories',
  'terminals',
  'term.output',
  'browser',
  'browser.frame',
  'browser.handOver',
  'browser.download',
  'attention',
  'activity',
  'assistant.entry',
  'assistant.board',
  'assistant.call',
  'powers',
  'models',
  'bridgeError'
] as const

export type RemoteEventName = (typeof RemoteEvents)[number]
