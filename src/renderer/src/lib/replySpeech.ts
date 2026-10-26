// 回复语音播报的「送播」逻辑：哪些文本该送合成、什么时候收尾。
// 从 AssistantChat.vue 抽出来，让产品代码和测试跑同一份实现——此前两个测试文件
// （conversation-tts-watch / tts-alternation）各自复刻了一份 watch，三份会漂移，
// 而且已经漂了：其中一个验的还是修复前的旧行为。抽出来之后改一处，测试立刻验真代码。
//
// 贯穿全模块的一条不变式：
//
//   **skip 是不可逆的**——它一边推进游标一边把那段文本永久丢掉，字段之后再翻回来也拿不回来。
//   所以「播不播」只能由**单调不可逆**的信号决定。
//
// 会在一轮中途翻转的字段一律不能当判据。服务端（qt AgentRunner）的真实行为：
//   - error：重试时被 reset（AgentRunner.cpp:2652），随后继续往同一条消息写正文；
//   - notice：看图描述完被 reset（:2082）、被交付检查/验证检查/额度等待**累加**（:1748、:4135、
//     QuotaWaiting.cpp:83），挂上之后服务端 renderPass(true) + startNewPass() 照样往同一条
//     消息里写真正做完的正文。
// 拿它们静音，就等于把一轮的最终结论整段丢掉。而且这两个字段只是气泡 meta 行上的一个小标签
// （MessageItem.vue:46-47），正文照常渲染——看得见却听不到，本身就不一致。
//
// 单调的判据只有这些：
//   historical（不是新内容：首帧 / 新订阅的会话 / store.historyMessages）
//   stoppedByUser（用户明确不要了；服务端只设 true，从不清）
//   interrupted / silent（助手日志：被中止 / 根本不渲染的条目）

import { blockCase, blockPayload, type AssistantEntry, type ChatMessage } from '../../../protocol/rpc/protocol.js'
import { ASSISTANT_SPEECH_SOURCE, createSpeechIncrement, type SpeechIncrement } from './speechOutput.js'

/** 一个文本块的播报游标：增量游标 + 已播到的文本长度 */
interface BlockStream {
  inc: SpeechIncrement
  len: number
}

// MARK: 助手模式（「和助手说」面板的日志条）

export interface AssistantSpeechState {
  /** entryID → 游标（按条记，流式一断再续从游标续播） */
  streams: Map<string, BlockStream>
}

export function createAssistantSpeechState(): AssistantSpeechState {
  return { streams: new Map() }
}

/**
 * 把这一帧的助手日志条目送播。
 * initial：首帧（true = 已有文本一律当历史不补播，只登记游标位置）。
 */
export function speakAssistantEntries(
  entries: readonly AssistantEntry[],
  state: AssistantSpeechState,
  initial: boolean
): void {
  for (const entry of entries) {
    if (entry.kind !== 'assistant') continue
    const done = !entry.streaming
    // 与会话模式同一口径：skip 不可逆，只认单调信号。silent 的条目根本不渲染
    // （AssistantChat.vue 的 assistantMessages 里就滤掉了）；interrupted 是「被中止」、只设不清。
    // data.error 故意不看：它只是 meta 行上一个「出错了」标签，正文照常渲染——看得见就该听得到。
    const speakable = !entry.data?.silent && !entry.interrupted
    let stream = state.streams.get(entry.id)
    if (!stream) {
      stream = { inc: createSpeechIncrement(ASSISTANT_SPEECH_SOURCE), len: 0 }
      state.streams.set(entry.id, stream)
    }
    // 首帧已有的文本当历史不补播；之后流式长出来的部分实时送播（新条目直接落地也从 0 全播
    // ——它刚出现，不算历史）。不播的那段也要过一遍游标（skip）：历史停在代码块中间时，
    // 游标得知道后面长出来的是代码下半截
    if (entry.text.length > stream.len) {
      const grown = entry.text.slice(stream.len)
      if (!initial && speakable) stream.inc.push(grown)
      else stream.inc.skip(grown)
    }
    if (entry.text.length !== stream.len) stream.len = entry.text.length
    // 完结期间每帧都收尾（flush 幂等，buffer 空了不做事）：不去捕捉 streaming 翻转那一次的
    // 边沿——边沿漏掉（收尾帧没触发回调、收尾后同一条目又被合并更新长出文本）尾巴就永久静音
    if (!initial && done && speakable) stream.inc.flush()
  }
}

// MARK: 会话模式（所有已订阅会话的 assistant 消息）

/** 播报只需要 store 的这两样 */
export interface SpeechStore {
  details: Record<string, { messages: ReadonlyArray<{ message: ChatMessage }> } | undefined>
  historyMessages: Record<string, unknown>
}

/** 一帧快照里的一条：完成态字段 + text 块长度串。会话清单项用 key '__convs__' */
export interface ConversationSpeechItem {
  key: string
  conv?: string
  msgID?: string
  /** 打开会话时就在的历史消息（store.historyMessages） */
  history?: boolean
  /** 当前会话里自己发的那条（只用来登记已见） */
  user?: boolean
  finishedAt?: string
  stoppedByUser?: boolean
  /** text 块的「块id:长度」串，用 | 连接 */
  lens?: string
  /** 会话清单项专用：本帧监听范围内有哪些会话（含空会话） */
  convs?: string[]
}

export interface ConversationSpeechState {
  /** 已登记过的会话：新进入监听那帧，其中已有内容全部当历史 */
  seenConversations: Set<string>
  /** 消息 key → 上一帧见到的 finishedAt（用来区分「新回复的收尾帧」和「重推的完结消息」） */
  seenMessageFinish: Map<string, string | undefined>
  /** conv:msgID:blockID → 游标 */
  blockStreams: Map<string, BlockStream>
}

export function createConversationSpeechState(): ConversationSpeechState {
  return { seenConversations: new Set(), seenMessageFinish: new Map(), blockStreams: new Map() }
}

/** 会话清单快照项的 key */
const CONVS_KEY = '__convs__'

/** 收走一个会话的全部播报游标（会话从监听范围里消失时调）。
 *  key 形状：blockStreams 是 `conv:msgID:blockID`，seenMessageFinish 是 `a:conv:msgID` / `u:conv:msgID`；
 *  会话 id 是 uuid，前缀匹配不会撞到别的会话。 */
function dropConversation(state: ConversationSpeechState, conv: string): void {
  for (const key of [...state.blockStreams.keys()]) {
    if (key.startsWith(`${conv}:`)) state.blockStreams.delete(key)
  }
  for (const key of [...state.seenMessageFinish.keys()]) {
    if (key.startsWith(`a:${conv}:`) || key.startsWith(`u:${conv}:`)) state.seenMessageFinish.delete(key)
  }
}

/**
 * 读一帧快照（当 watch 的 getter 用）。
 * 长度串必须真读块内容——applyPatch 是原地改块、保留对象引用，不读内容的话流式片
 * 根本不触发 watch 回调（正是「只播最后一次集合」的根因）；读了之后块一长快照就变。
 *
 * ⚠️ 故意不读 error / notice，别加回来。两个理由：
 *  1. 它们会在一轮中途翻转（服务端重试清 error、看图描述清 notice、交付检查/验证检查/
 *     额度等待累加 notice），而 skip 不可逆——拿它们当静音判据就会把一轮的最终结论整段丢掉；
 *  2. 多读一个字段就多一个无谓的 watch 触发源。
 * 不读，播报逻辑就根本看不见它们，这条错误无法再被写出来（详见文件头）。
 */
export function conversationSpeechSnapshot(
  store: SpeechStore,
  currentConversation: string | null | undefined
): ConversationSpeechItem[] {
  const snapshot: ConversationSpeechItem[] = []
  // 会话清单项：豁免判定的单位（空会话也要登记，否则它第一条回复的第一片那帧才被当新会话
  // 豁免——开头一句直接丢）
  snapshot.push({ key: CONVS_KEY, convs: Object.keys(store.details) })
  for (const conv of Object.keys(store.details)) {
    const current = conv === currentConversation
    for (const { message } of store.details[conv]?.messages ?? []) {
      if (message.role === 'user') {
        if (current) snapshot.push({ key: `u:${conv}:${message.id}`, user: true })
        continue
      }
      if (message.role !== 'assistant') continue
      const lens = (message.blocks ?? [])
        .map((block) =>
          blockCase(block) === 'text' ? `${block.id}:${String(blockPayload<string>(block, 'text') ?? '').length}` : ''
        )
        .join('|')
      snapshot.push({
        key: `a:${conv}:${message.id}`,
        conv,
        msgID: message.id,
        history: !!store.historyMessages[message.id],
        finishedAt: message.finishedAt,
        stoppedByUser: message.stoppedByUser,
        lens
      })
    }
  }
  return snapshot
}

/**
 * 把一帧快照送播。
 * initial：首帧（prev === undefined，已有内容一律当历史）。
 */
export function speakConversationSnapshot(
  list: readonly ConversationSpeechItem[],
  store: SpeechStore,
  state: ConversationSpeechState,
  initial: boolean
): void {
  // 先统一登记本帧新出现的会话（以会话清单项为准，空会话也算）：其中已有的内容全部当历史
  // 不播。（不能在遍历中边遇边登记——那样只有新会话的第一条享受到豁免，后面的照播）
  const convs = list.find((item) => item.key === CONVS_KEY)?.convs ?? []
  const freshConvs = new Set<string>()
  for (const conv of convs) {
    if (!state.seenConversations.has(conv)) freshConvs.add(conv)
  }
  // 会话从监听范围里消失（订阅上限淘汰 / 关掉）就把它连同游标一起忘掉：
  //  - 重订阅时它才真的算「新会话」、当帧已有内容重新豁免一次。不忘掉的话快照里已完成的
  //    历史会从 0 全量重播（念旧账）——光靠 store.historyMessages 兜不住，那是别处按
  //    别的时机重建的，而这里的消息 id / 块 id 还可能整个换过一轮。
  //  - 游标和完结记录不再只增不减：长跑的桌面端每见一条消息就留一份，不清就一直涨。
  const alive = new Set(convs)
  for (const conv of [...state.seenConversations]) {
    if (alive.has(conv)) continue
    state.seenConversations.delete(conv)
    dropConversation(state, conv)
  }
  for (const conv of freshConvs) state.seenConversations.add(conv)
  // 消息按 conv:id 先建一遍索引（O(n)）：逐条 messages.find 是 O(n²)，每个流式增量都要扫一遍
  const entryIndex = new Map<string, { message: ChatMessage }>()
  for (const conv of Object.keys(store.details)) {
    for (const candidate of store.details[conv]?.messages ?? []) {
      const key = `${conv}:${candidate.message.id}`
      if (!entryIndex.has(key)) entryIndex.set(key, candidate) // 同 id 重复时取第一条（与 find 一致）
    }
  }
  for (const item of list) {
    if (item.key === CONVS_KEY) continue
    if (item.user) {
      // 只登记已见（快照每帧重跑，靠它跳过重复处理）；自己发言不断播报——
      // 正在念的继续，新回复的句子 append 到队尾接着播
      state.seenMessageFinish.set(item.key, undefined)
      continue
    }
    if (item.conv === undefined || item.msgID === undefined) continue
    const entry = entryIndex.get(`${item.conv}:${item.msgID}`)
    if (!entry) continue
    const before = state.seenMessageFinish.get(item.key)
    const done = !!item.finishedAt
    // 新进会话里已完成的消息是历史：不播增量也不收尾（否则切会话/重连会念旧账）。
    // 打开会话时就在的消息（store.historyMessages）同样是历史：旧会话的消息未必带 finishedAt，
    // 服务端换块 id 重推时光看 done 拦不住，会从头把旧回复念一遍
    const historical = initial || freshConvs.has(item.conv) || !!item.history
    const speakable = !item.stoppedByUser
    for (const block of entry.message.blocks ?? []) {
      if (blockCase(block) !== 'text') continue
      const full = String(blockPayload<string>(block, 'text') ?? '')
      const key = `${item.conv}:${item.msgID}:${block.id}`
      let stream = state.blockStreams.get(key)
      if (!stream) {
        // 完结消息里「新出现的块」= 服务端重推历史换了块 id（noteAssistantStream 同款场景：
        // 新一轮活动把已见过的消息按新块 id 重弹）：内容念过了，游标直接对齐、不重播；
        // 未完成消息的新块才是流式新段，从头播。
        // 「首见即已完结」不能一律当重推跳过：思考模型答案太短/渲染节流时，text 块第一次
        // 可见就是带 finishedAt 的收尾帧（流式期间只有 thinking 块），跳过会让整轮不播——
        // 隔条交替不播的根因。之前记录过这条消息的 finishedAt（before 为真）才是重推过完结消息
        // tag = 桌面气泡的 id（store.pushBubble 用 `${会话}:${kind}:${块ID}`，text 块的 kind 恒为
        // 'text'）：这条气泡的句子全部念完时 speechOutput 会通知它，气泡才渐隐——长回复
        // 念到一半气泡就没了的话，用户听着声音却找不到对应的字。
        // turn = 一轮回复（一条助手消息）：同会话来了新回复，老的还在念就压低成背景音。
        stream = {
          inc: createSpeechIncrement(item.conv, {
            tag: `${item.conv}:text:${block.id}`,
            turn: `${item.conv}:${item.msgID}`
          }),
          len: 0
        }
        state.blockStreams.set(key, stream)
        if (historical || (done && before)) {
          stream.inc.skip(full)
          stream.len = full.length
        }
      }
      // 新进监听 / 首帧的已有文本当历史；之后流式长出来的增量（=气泡正在显示的新文本）
      // 实时送播；块长度回退（重发/修正，罕见）只对齐游标不重播。
      // 不播的那段也要过一遍游标（skip）：中途起播时历史可能停在代码块 / 公式块中间，
      // 游标不知道的话后面长出来的代码下半截会被当正文念
      if (full.length > stream.len) {
        const grown = full.slice(stream.len)
        if (!historical && speakable) stream.inc.push(grown)
        else stream.inc.skip(grown)
      }
      if (full.length !== stream.len) stream.len = full.length
      // 完结期间每帧都收尾（flush 幂等）：不去捕捉「finishedAt 刚出现」那个只有一次的边沿——
      // 边沿漏掉（收尾帧没触发回调 / 收尾后又补来文本 / 断线补拉）整条尾巴就永久静音
      if (done && !historical && speakable) stream.inc.flush()
    }
    state.seenMessageFinish.set(item.key, item.finishedAt)
  }
}
