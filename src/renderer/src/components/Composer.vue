<script setup lang="ts">
// 输入框（方案 §5.3，样式照 Friday 桌面端）：圆角卡片内嵌文本区，文本区左边「开新会话」「和助手说」分段式按钮组，底行左侧附件、右侧圆形发送键；
// 生成中发送键变成停止。附件（对话框 + 拖放，经主进程背书上传）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { useAppStore } from '../stores/app.js'
import type { EngineView } from '../stores/app.js'
import type { CommandInfo, PermissionMode, ThinkingLevel } from '../../../protocol/rpc/protocol.js'
import {
  builtinChoices,
  effectiveThinking,
  mergeBuiltinCommands,
  normalizeTeamMode,
  parseBuiltin,
  PERMISSION_MODES,
  resolveBuiltin,
  TEAM_MODES,
  thinkingTitle,
  type BuiltinAction,
  type BuiltinChoice,
  type BuiltinContext
} from '../lib/builtinCommands.js'
import type { FsMkdirResult } from '../../../protocol/rpc/protocol.js'
import type { PickedFile } from '../lib/host.js'
import { SpeechInput, type VoicePhase } from '../lib/speechInput.js'
import { usageForEntry, usageKey, canQueryUsage, usageTip, type UsageLine, type UsageMeter } from '../lib/serviceUsage.js'

const store = useAppStore()
// 提交走 prop 回调（@submit 绑定到 onSubmit）而不是 emit：emit 拿不到结果，发送失败时
// 文本和附件已经清掉了——消息直接丢、错误还成了未处理的 rejection。现在等它返回，成功才清空
const props = defineProps<{
  conversationId?: string
  onSubmit?: (text: string, attachments: Array<{ path: string; name: string }>) => Promise<void> | void
}>()
const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const focused = ref(false)

// 「让 Friday 改」：文件卡片预填一条消息（方案 §5.5）
function onPrefill(event: Event): void {
  const detail = (event as CustomEvent<string>).detail
  if (typeof detail !== 'string') return
  text.value = detail
  void nextTick(() => {
    textarea.value?.focus()
    textarea.value?.setSelectionRange(detail.length, detail.length)
    resize() // 程序赋值不触发 @input，预填长文本时文本域要自己长高
  })
}
onMounted(() => window.addEventListener('friday-prefill', onPrefill as EventListener))
onBeforeUnmount(() => window.removeEventListener('friday-prefill', onPrefill as EventListener))
const busy = ref(false)
const attachments = ref<Array<{ handle: string; name: string; size: number }>>([])
const uploadError = ref('')

// MARK: 模型选择（方案 §5.3：runner.setEngine；照 Friday 输入框底行的模型选择器）
const modelOpen = ref(false)
const modelWrap = ref<HTMLDivElement | null>(null)
const switchError = ref('')

const availableEngines = computed<EngineView[]>(() => store.engines.filter((engine) => !engine.disabled))
const currentEngineID = computed(
  () => store.summaries.find((summary) => summary.id === props.conversationId)?.engineID ?? ''
)
const currentEngine = computed(() => availableEngines.value.find((engine) => engine.id === currentEngineID.value))
/** 没选过时跟随新对话默认引擎（REMOTE.md：engineID 空 = 跟随默认） */
const effectiveEngine = computed(
  () => currentEngine.value ?? availableEngines.value.find((engine) => engine.id === store.defaultEngineID)
)
/** 选择器上显示实际使用的模型名（engine.model；title 是服务商名，挪到悬停提示里） */
const currentEngineLabel = computed(
  () => effectiveEngine.value?.model || effectiveEngine.value?.title || '默认模型'
)
const currentEngineTip = computed(() => {
  const engine = effectiveEngine.value
  const text =
    !engine || engine.model === engine.title
      ? engine?.title || '默认模型'
      : `${engine.title} · ${engine.model}`
  // 悬停给全：当前模型 + 这一家的余额 / 套餐用量明细（没有就不加）
  const detail = engine ? usageOf(engine.id).detail : []
  return [`当前模型：${text}`, ...detail.map((item) => item.text)].join('\n')
})

function toggleModelMenu() {
  modelOpen.value = !modelOpen.value
  if (modelOpen.value) {
    dirOpen.value = false
    permOpen.value = false
    voiceMenuOpen.value = false
    switchError.value = ''
  }
}

// 用量数据（serviceUsage 推送 + services.usage 查询）：模型选择器显示着就一直订（边框要一直跟着推，
// 不只菜单开着）；菜单开着也不另订。所有路径（切到助手模式、组件卸载）都改它，用 watch 看着。
watch(
  () => !store.assistantChat,
  (shown) => void store.watchServiceUsage(shown),
  { immediate: true }
)
onBeforeUnmount(() => {
  if (!store.assistantChat) void store.watchServiceUsage(false)
})
// 换到哪家查哪家（== Friday：菜单里选了别的模型、默认引擎到了，那家的边框才有数）
watch(
  () => effectiveEngine.value?.id,
  (id) => {
    if (store.assistantChat || !id) return
    const engine = effectiveEngine.value
    if (!engine) return
    const target = {
      key: usageKey(engine.baseURL ?? '', engine.apiKeySecret ?? ''),
      baseURL: engine.baseURL ?? '',
      secretName: engine.apiKeySecret ?? '',
      custom: true
    }
    if (!canQueryUsage(target.baseURL)) return
    void store.queryServiceUsage(target)
  }
)

/** 这家服务现在要说的一句话（余额 / 套餐用量 / 额度用完；按接口地址 + 密钥名取，同一家的模型共用一份）。
 *  边框（meter）也在里面：当前模型那家已用的部分描在 chip 边框上 */
const engineUsage = computed<Map<string, { line?: UsageLine; detail: UsageLine[]; meter?: UsageMeter }>>(() => {
  const now = usageNow.value
  const map = new Map<string, { line?: UsageLine; detail: UsageLine[]; meter?: UsageMeter }>()
  for (const engine of availableEngines.value) {
    const key = usageKey(engine.baseURL ?? '', engine.apiKeySecret ?? '')
    const entry = store.serviceUsage[key]
    if (!entry) continue
    map.set(engine.id, usageForEntry(entry, now))
  }
  return map
})

function usageOf(engineID: string): { line?: UsageLine; detail: UsageLine[]; meter?: UsageMeter } {
  return engineUsage.value.get(engineID) ?? { detail: [] }
}

/** 当前模型那家的用量边框（Friday v2.27 模型胶囊的边框：已用的部分从左往右描成实色，80% 以上、用完了橙色） */
const engineMeter = computed(() => usageOf(effectiveEngine.value?.id ?? '').meter)

/** 用量里的时间（「15:20 恢复」到点消失）：每分钟走一次重算（菜单里那一句、chip 边框、note 共用） */
const usageNow = ref(new Date())
let usageTimer = 0
onMounted(() => {
  usageTimer = window.setInterval(() => {
    usageNow.value = new Date()
  }, 60_000)
})
onBeforeUnmount(() => window.clearInterval(usageTimer))

// ---- 悬停浮条（== Friday v2.37 UsageTip）：鼠标停在胶囊上 0.35 秒浮出来，移开马上收；菜单开着不浮 ----

/** 当前模型是在线服务（本机地址不查余额）才有浮条；有浮条时胶囊原来的 title 提示波它取代（== Friday help 的让位） */
const engineTipAvailable = computed(() => {
  const engine = effectiveEngine.value
  return !store.assistantChat && !!engine && canQueryUsage(engine.baseURL ?? '')
})
const engineTipData = computed(() => {
  if (!engineTipAvailable.value) return undefined
  const engine = effectiveEngine.value!
  return usageTip(store.serviceUsage[usageKey(engine.baseURL ?? '', engine.apiKeySecret ?? '')], usageNow.value)
})
/** 浮条头上的：服务名 + 模型名（两者一样时只写一个，== Friday tipService / engineModel） */
const tipEngineModel = computed(() => {
  const engine = effectiveEngine.value
  return engine && engine.model && engine.model !== engine.title ? engine.model : ''
})
/** 条和行都没有又不在查：补一句「这家查不到余额和用量」（== Friday 浮条的兑底） */
const engineTipLines = computed<UsageLine[]>(() => {
  const lines = engineTipData.value?.lines ?? []
  return lines.length > 0 ? lines : [{ text: '这家查不到余额和用量', warning: false }]
})
const tipOpen = ref(false)
const tipAlignRight = ref(false)
let tipDelayTimer = 0
let tipTicker = 0
function onChipEnter() {
  if (!engineTipAvailable.value || modelOpen.value) return
  // 停上去就重查那家（10 秒内查过的不再查，来回晃不会一直查；== Friday refreshUsage(false, service, 10)）
  const engine = effectiveEngine.value!
  void store.queryServiceUsage(
    {
      key: usageKey(engine.baseURL ?? '', engine.apiKeySecret ?? ''),
      baseURL: engine.baseURL ?? '',
      secretName: engine.apiKeySecret ?? '',
      custom: true
    },
    false,
    10_000
  )
  window.clearTimeout(tipDelayTimer)
  tipDelayTimer = window.setTimeout(() => {
    // 浮在胶囊上方、和它左对齐；右边出了窗口就和它右对齐（== Friday 浮条的 onAboutToShow）
    const rect = modelWrap.value?.getBoundingClientRect()
    tipAlignRight.value = !!rect && rect.left + 264 > window.innerWidth - 8
    tipOpen.value = true
  }, 350)
}
function onChipLeave() {
  window.clearTimeout(tipDelayTimer)
  tipOpen.value = false
}
// 浮着时每秒走一次：条下面「2 小时 15 分后重置」这类倒计时跟着走（== Friday v2.47）
watch(tipOpen, (open) => {
  window.clearInterval(tipTicker)
  if (open) tipTicker = window.setInterval(() => {
    usageNow.value = new Date()
  }, 1000)
})
// 菜单弹开时收掉浮条（两者都浮在胶囊上方）
watch(modelOpen, (open) => {
  if (open) onChipLeave()
})
onBeforeUnmount(() => {
  window.clearTimeout(tipDelayTimer)
  window.clearInterval(tipTicker)
})

/** 菜单项的悬停提示：服务商 · 模型 + 余额 / 用量的明细（有的话一项一行） */
function engineTip(engine: EngineView): string {
  const base =
    engine.model && engine.model !== engine.title ? `${engine.title} · ${engine.model}` : engine.model || engine.title
  const detail = usageOf(engine.id).detail
  return detail.length > 0 ? [base, ...detail.map((item) => item.text)].join('\n') : base
}

async function chooseEngine(engine: EngineView) {
  modelOpen.value = false
  switchError.value = ''
  if (engine.id === currentEngineID.value) return
  try {
    // 没打开会话（空着重升新对话）：直接建一段新的，建的时候就带上引擎（REMOTE.md conversation.create engineID）
    if (!props.conversationId) {
      await store.createConversation({ engineID: engine.id })
    } else {
      await store.setEngine(props.conversationId, engine.id)
    }
    // 换模型同时记成新对话的默认（Qt v2.9 起同款；REMOTE.md settings.update defaultEngineID）
    await store.setDefaultEngine(engine.id)
  } catch (error) {
    switchError.value = error instanceof Error ? error.message : String(error)
  }
}

/** 模型菜单里的任务模式 / 思考档位两节（Qt v2.9 起都在模型菜单里）：换这段对话的（runner.setTeamMode / setThinking，
 *  工作中换的下一轮生效），没开会话时直接建一段带着它的新对话。不动输入框里打了一半的文字 */
async function chooseTeamMode(mode: string) {
  modelOpen.value = false
  switchError.value = ''
  try {
    if (props.conversationId) await store.setTeamMode(props.conversationId, mode)
    else await store.createConversation({ teamMode: mode })
  } catch (error) {
    switchError.value = error instanceof Error ? error.message : String(error)
  }
}

async function chooseThinking(level: ThinkingLevel) {
  modelOpen.value = false
  switchError.value = ''
  try {
    if (props.conversationId) await store.setThinking(props.conversationId, level)
    else await store.createConversation({ thinking: level })
  } catch (error) {
    switchError.value = error instanceof Error ? error.message : String(error)
  }
}

// 当前任务模式（打勾用）：见 currentTeamMode（currentSummary 之后定义，要引用它）
/** 思考档位两节能列的行（title + 原始值）；runtime 明确给了空数组 = 这个模型不能调 */
const thinkingRows = computed(() => {
  const context = builtinContext()
  const levels = context.thinkingLevels
  return levels.map((level) => ({
    raw: level,
    title: thinkingTitle(level, levels),
    current: level === effectiveThinking(context.thinkingLevel, levels)
  }))
})
const thinkingAdjustable = computed(() => builtinContext().thinkingLevels.length > 0)

// MARK: 权限选择（Qt PermissionChip：这段会话的工具权限，自动 / 计划 / 完全；按会话保存在服务端）
const permOpen = ref(false)
const permWrap = ref<HTMLDivElement | null>(null)

/** 现在的权限（summaries 永远有；没开会话时拿本机「上次选的」，新会话接着用它） */
const currentPermission = computed<PermissionMode>(
  () => currentSummary.value?.permissionMode ?? store.newChatDefaults.permissionMode ?? 'auto'
)
const currentPermissionInfo = computed(() => PERMISSION_MODES.find((mode) => mode.raw === currentPermission.value))

function togglePermMenu() {
  permOpen.value = !permOpen.value
  if (permOpen.value) {
    modelOpen.value = false
    dirOpen.value = false
    voiceMenuOpen.value = false
  }
}

/** 换这段会话的权限（runner.setPermissionMode）；没开会话时直接建一段带着它的新对话。两种都记本机「上次选的」 */
async function choosePermission(mode: PermissionMode) {
  permOpen.value = false
  switchError.value = ''
  if (mode === currentPermission.value) return
  try {
    if (props.conversationId) await store.setPermissionMode(props.conversationId, mode)
    else await store.createConversation({ permissionMode: mode })
  } catch (error) {
    switchError.value = error instanceof Error ? error.message : String(error)
  }
}

// MARK: 工作目录选择（方案 §5.3：runner.setWorkingDirectory；最近目录 directories.*，浏览 fs.list）
const dirOpen = ref(false)
const dirWrap = ref<HTMLDivElement | null>(null)
const dirError = ref('')
const browsing = ref(false)
const browseLoading = ref(false)
const browseError = ref('')
const browsePath = ref('')
const browseParent = ref<string | undefined>(undefined)
const browseEntries = ref<Array<{ name: string; path: string }>>([])
const browseRoots = ref<Array<{ name: string; path: string }>>([])

/** 这台机器的新对话默认工作目录（server.defaultWorkingDirectory） */
const defaultWorkdir = computed(() => store.currentMachineInfo?.serverInfo?.defaultWorkingDirectory ?? '')

function dirBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

const currentSummary = computed(() => store.summaries.find((summary) => summary.id === props.conversationId))

/** 现在实际在用的任务模式（== Qt runner->teamMode(id) 的解析，菜单和 /mode 打勾都用它）：
 *  会话选过的（summary.teamMode）优先；没选过跟那台机器的新对话默认（settings.get teamMode）；
 *  没选会话时本机「上次选的」优先（createConversation 会带上它），再跟机器默认；都不给 = solo */
const currentTeamMode = computed(() => {
  const raw = props.conversationId
    ? currentSummary.value?.teamMode ?? store.machineDefaultTeamMode
    : store.newChatDefaults.teamMode ?? store.machineDefaultTeamMode
  return normalizeTeamMode(raw) ?? 'solo'
})
/** 有内容后不能再改工作目录（服务端对非空会话静默忽略，选了也会被打回；
 *  Qt 端 v2.1 起同样整个不显示，WorkingDirectoryChip 的 locked） */
const workdirLocked = computed(() => (props.conversationId ? currentSummary.value?.isEmpty === false : false))
watch(workdirLocked, (locked) => {
  if (locked) dirOpen.value = false
})
const currentWorkdir = computed(
  () => currentSummary.value?.workingDirectory ?? store.details[props.conversationId ?? '']?.runtime?.workingDirectory ?? ''
)
const currentWorkdirLabel = computed(() => {
  if (currentWorkdir.value) return currentSummary.value?.workingDirectoryName || dirBasename(currentWorkdir.value)
  return defaultWorkdir.value ? dirBasename(defaultWorkdir.value) : '默认目录'
})

function toggleDirMenu() {
  dirOpen.value = !dirOpen.value
  if (dirOpen.value) {
    modelOpen.value = false
    permOpen.value = false
    voiceMenuOpen.value = false
    dirError.value = ''
    browsing.value = false
    void store.refreshDirectories() // 打开时重拉：顺带重验最近目录还在不在（REMOTE.md）
  }
}

/** 选定工作目录（path 不给 = 回这台机器的默认）；没打开会话就建一段新的并直接带上目录 */
async function chooseWorkdir(path?: string) {
  dirOpen.value = false
  dirError.value = ''
  if (path && path === currentWorkdir.value) return
  try {
    if (!props.conversationId) {
      await store.createConversation(path ? { workingDirectory: path } : {})
      return
    }
    await store.setWorkingDirectory(props.conversationId, path)
  } catch (error) {
    dirError.value = error instanceof Error ? error.message : String(error)
  }
}

/** 打开目录浏览（REMOTE.md fs.list：不给 path 是主目录；roots 是主目录和各盘） */
async function openBrowse(path?: string) {
  browsing.value = true
  browseLoading.value = true
  browseError.value = ''
  mkdirOpen.value = false // 换目录了，收起新建行
  mkdirError.value = ''
  try {
    const result = await store.browseDirectory(path)
    if (!result) return
    browsePath.value = result.path
    browseParent.value = result.parent
    browseEntries.value = result.entries ?? []
    browseRoots.value = result.roots ?? []
  } catch (error) {
    browseError.value = error instanceof Error ? error.message : String(error)
  } finally {
    browseLoading.value = false
  }
}

// 浏览时新建文件夹（v2.72 fs.mkdir：{path, name} → {path}，特性 mkdir；Friday v2.72 起的服务端才有，旧的不显示按钮）
const canMkdir = computed(() => store.currentMachineInfo?.serverInfo?.features?.includes('mkdir') ?? false)
const mkdirOpen = ref(false)
const mkdirName = ref('')
const mkdirBusy = ref(false)
const mkdirError = ref('')
const mkdirInput = ref<HTMLInputElement | null>(null)

function toggleMkdir() {
  mkdirOpen.value = !mkdirOpen.value
  mkdirName.value = ''
  mkdirError.value = ''
  if (mkdirOpen.value) void nextTick(() => mkdirInput.value?.focus())
}

async function submitMkdir() {
  const name = mkdirName.value.trim()
  if (!name || mkdirBusy.value || !browsePath.value) return
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    mkdirError.value = '文件夹名字里不能有 / 或 \\，也不能是 . 或 ..'
    return
  }
  mkdirBusy.value = true
  mkdirError.value = ''
  try {
    const result = (await store.rpc(store.currentMachine, 'fs.mkdir', {
      path: browsePath.value,
      name
    })) as FsMkdirResult
    mkdirOpen.value = false
    mkdirName.value = ''
    await openBrowse(result?.path || browsePath.value) // 建好直接进新目录
  } catch (error) {
    mkdirError.value = error instanceof Error ? error.message : String(error)
  } finally {
    mkdirBusy.value = false
  }
}

function onDocClick(event: MouseEvent) {
  const target = event.target as Node
  if (modelOpen.value && modelWrap.value && !modelWrap.value.contains(target)) modelOpen.value = false
  if (dirOpen.value && dirWrap.value && !dirWrap.value.contains(target)) dirOpen.value = false
  if (permOpen.value && permWrap.value && !permWrap.value.contains(target)) permOpen.value = false
  if (voiceMenuOpen.value && voiceWrap.value && !voiceWrap.value.contains(target)) voiceMenuOpen.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

const sending = computed(() => {
  const id = props.conversationId
  const runtime = id ? store.details[id]?.runtime : store.runtime
  return runtime?.generating ?? false
})

/** 占位文案：Enter/Shift+Enter 键盘提示并进 placeholder（不占底行位置）；默认不带场景前缀，助手模式保留场景文案 */
const placeholder = computed(() => {
  if (store.assistantChat) {
    const enterHint = store.assistantState?.reacting
      ? 'Enter 发下一句会打断重来'
      : 'Enter 发给助手'
    return `和助手说点什么… · ${enterHint} · Shift+Enter 换行`
  }
  return sending.value ? 'Enter 补充给智能体 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行'
})

const canSend = computed(() => Boolean(text.value.trim()) || attachments.value.length > 0)

function resize() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  // 按钮组的对齐随行数切换：单行时与文字垂直居中，多行时改顶部对齐（按钮组高 36px 与单行文本域同高，
  // 顶对齐正好让组的中线落在第一行文字中线上）。lineHeight 拿到的是倍数（"1.55"）就用字号折算。
  const cs = getComputedStyle(el)
  const lhRaw = parseFloat(cs.lineHeight)
  const lineHeight = Number.isFinite(lhRaw) && lhRaw >= 10 ? lhRaw : parseFloat(cs.fontSize) * 1.55
  const oneLine = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + lineHeight
  el.closest('.input-zone')?.classList.toggle('multi-line', el.scrollHeight > oneLine + 1)
}

// 行数不只随内容变：拖窗口 / 加减附件 chips 改变文本域宽度也会变行数，但那不经过 @input。
// 用 ResizeObserver 盯着宽度变化也调 resize()，不然 multi-line 类卡死在旧行数，
// 按钮组的「单行居中/多行顶对齐」就错了
let textareaResizeObserver: ResizeObserver | null = null
onMounted(() => {
  const el = textarea.value
  if (!el) return
  textareaResizeObserver = new ResizeObserver(() => resize())
  textareaResizeObserver.observe(el)
})
onBeforeUnmount(() => {
  textareaResizeObserver?.disconnect()
  textareaResizeObserver = null
})

async function handleAttachments(picked: PickedFile[]) {
  for (const file of picked) {
    attachments.value.push(file)
  }
}

async function pick() {
  const picked = await window.fridayBridge.pickAttachments()
  await handleAttachments(picked)
}

function onDrop(event: DragEvent) {
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length === 0) return
  event.preventDefault()
  for (const file of files) {
    // 登记是异步的：落地前用户把消息发了（send 清空附件并 bump 代数）的话，
    // 这份附件不能塞进下一条消息的输入框凭空多出来
    const seq = sendSeq
    void window.fridayBridge.registerDrop(file).then((picked) => {
      if (picked && seq === sendSeq) attachments.value.push(picked)
    })
  }
}

/** 发送代数：send 清空附件时 bump，作废还在途的拖放登记 */
let sendSeq = 0

async function send() {
  const value = text.value.trim()
  if ((!value && attachments.value.length === 0) || busy.value) return
  if (sendBuiltinCommand()) return
  // 生成中也能发（插入内容）：runner.submit 不带 whenBusy，服务端 == 输入框——
  // 这段在工作就排进它的队列，做完当前这一步就交给它（REMOTE.md；qt ComposerView「补充给智能体」）
  busy.value = true
  uploadError.value = ''
  sendSeq++ // 在途的拖放登记作废：稍后落地的不属于已发出的这条消息
  try {
    const uploaded: Array<{ path: string; name: string }> = []
    for (const attachment of attachments.value) {
      const path = await store.uploadFile(attachment.handle)
      uploaded.push({ path, name: attachment.name })
    }
    await props.onSubmit?.(value, uploaded)
    text.value = ''
    attachments.value = []
    await nextTick(resize)
  } catch (error) {
    uploadError.value = `发送失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    busy.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  // 命令菜单开着：↑↓ 选、Return / Tab 填进来、Esc 关（照桌面端 GrowingTextView.keyFilter；
  // 带修饰键的 Return / Tab 不拦，Shift+Enter 照常换行）
  if (commandMenuOpen.value) {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveCommand(-1)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveCommand(1)
      return
    }
    if (
      event.key === 'Tab' ||
      (event.key === 'Enter' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.isComposing)
    ) {
      event.preventDefault()
      acceptCommand()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      commandMenuOpen.value = false
      commandDismissed.value = true
      return
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}

function removeAttachment(index: number) {
  attachments.value.splice(index, 1)
}

// MARK: 「/」命令菜单（照 Friday 桌面端 v2.16 CommandMenu + ComposerView.updateCommandMenu）：
// 正文是「/」加一段没有空白的名字时弹在输入台上方，列出对得上的命令（名字、参数提示、用途、来源）；
// ↑↓ 选、Return / Tab 填成「/名字 」（接着写参数）、Esc 关。不抢输入框焦点（照常打字过滤）。
// 和助手说不弹（桌面端助手时间线没有菜单）。展开在服务端做：发出去的「/名字 参数」会换成命令正文
// 再交给模型，对话里照旧显示打的原文（docs/COMMANDS.md §1）。
// v2.71 内置 /model、/mode、/thinking（COMMANDS.md §8，lib/builtinCommands）：菜单里总有这三项，这台没有命令文件也照样弹；
// 打「/model 」等后菜单换成能选的（现在用的打勾、先选中它），选中或发出「/model 名字」就换上，不发给模型。
const commandMenuOpen = ref(false)
const commandIndex = ref(0)
const commandMenuEl = ref<HTMLElement | null>(null)
/** 用户按 Esc 关过菜单：在途的 commands.list 回执到了也不自动重开；再打字（prefix 变）才复位 */
const commandDismissed = ref(false)
/** 命令行，或 v2.71 内置命令后面能选的一项（带 action；照 Qt CommandMenu 的 isModel 行：✓、标题、trailing、detail） */
type CommandMenuItem = CommandInfo & { choice?: BuiltinChoice }
/** 「/」后面的名字前缀；null = 正文不是「/名字」形态（不是 / 开头、中间有空白 / 已带参数），菜单收起 */
const commandPrefix = computed<string | null>(() => {
  if (store.assistantChat || !store.connected) return null
  const match = /^\/(\S*)$/.exec(text.value)
  return match ? match[1] : null
})
/** 「/model 」「/mode 」「/thinking 」后面打的（名字后面有空白才算，只打「/model」还是列命令） */
const builtinQuery = computed(() => {
  if (store.assistantChat || !store.connected || !/^\/[a-z]+[ \t]/.test(text.value)) return null
  return parseBuiltin(text.value)
})
watch([commandPrefix, () => builtinQuery.value?.argument], () => {
  commandDismissed.value = false
})
/** 这段对话现在的模型、任务模式、思考档位（没开会话时看新对话的默认；思考档位没拿到
 *  runtime 前先列全量——选了哪档建会话时就带上哪档，runtime 到了再收窄到这个模型能调的） */
const ALL_THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'ultra']
function builtinContext(): BuiltinContext {
  const runtime = props.conversationId ? store.details[props.conversationId]?.runtime : store.runtime
  return {
    engines: availableEngines.value,
    engineID: effectiveEngine.value?.id,
    // 打勾跟「实际在用」的模式（会话选过的 → 机器默认 → solo），三项里永远有一项勾着
    teamMode: currentTeamMode.value,
    thinkingLevel:
      currentSummary.value?.thinking ?? runtime?.thinkingLevel ?? (props.conversationId ? undefined : store.newChatDefaults.thinking),
    thinkingLevels: runtime?.thinkingLevels ?? ALL_THINKING_LEVELS
  }
}
const commandItems = computed<CommandMenuItem[]>(() => {
  const builtin = builtinQuery.value
  if (builtin) {
    return builtinChoices(builtin.command, builtin.argument, builtinContext()).map((choice) => ({
      name: `${choice.action.kind}:${choice.action.value}`,
      choice
    }))
  }
  const prefix = commandPrefix.value
  if (prefix === null) return []
  return mergeBuiltinCommands(prefix, store.matchCommands(prefix))
})
watchEffect(() => {
  const prefix = commandPrefix.value
  const items = commandItems.value
  if (builtinQuery.value) {
    if (commandDismissed.value) return
    commandMenuOpen.value = items.length > 0
    commandIndex.value = Math.max(0, items.findIndex((item) => item.choice?.checked))
    return
  }
  if (prefix === null) {
    commandMenuOpen.value = false
    return
  }
  // 刚打出「/」（菜单还关着、没被 Esc 关过）时重列一遍这台的命令（当前会话的工作目录，空 = 默认的；
  // 结果到了 items 重算，这里自动重开——照桌面端 Commands.load 的时机）
  if (prefix === '' && !commandMenuOpen.value && !commandDismissed.value)
    void store.refreshCommands(currentWorkdir.value || undefined)
  if (commandDismissed.value) return
  if (items.length === 0) {
    commandMenuOpen.value = false
    return
  }
  commandMenuOpen.value = true
  commandIndex.value = 0
})

function moveCommand(delta: number) {
  const count = commandItems.value.length
  if (count === 0) return
  commandIndex.value = (commandIndex.value + delta + count) % count
  scrollCommandIntoView()
}

/** 选中项滚进菜单视口（照桌面端 list.positionViewAtIndex(Contain)；nearest = 已可见就不动） */
function scrollCommandIntoView() {
  void nextTick(() => {
    commandMenuEl.value?.querySelector('.command-item.current')?.scrollIntoView({ block: 'nearest' })
  })
}
// 打字过滤后列表变短：选中（第 0 条）若被滚出视口也拉回来
watch(commandItems, () => {
  if (commandMenuOpen.value) scrollCommandIntoView()
})

/** 选中一条：填成「/名字 」（接着写参数），光标到末尾；正文带空格后不再匹配命令形态，watchEffect 会收起菜单
 *  （内置的 /model 等填进去后菜单换成能选的）；选的是能选的一项就直接换上 */
function chooseCommand(item: CommandMenuItem) {
  if (item.choice) {
    void useBuiltinChoice(item.choice.action)
    return
  }
  setText(`/${item.name} `)
}

function setText(value: string) {
  text.value = value
  void nextTick(() => {
    textarea.value?.focus()
    const end = text.value.length
    textarea.value?.setSelectionRange(end, end)
    resize() // 程序赋值不触发 @input，文本域高度要跟着内容走
  })
}

function acceptCommand() {
  const chosen = commandItems.value[commandIndex.value]
  if (chosen) chooseCommand(chosen)
}

/** v2.71 换上选的模型 / 任务模式 / 思考档位：这段对话用它，同时记成新对话的默认（同 Qt ModelMenu.trigger；工作中换的下一轮生效）。
 *  没开会话时同模型选择器：直接建一段带着它的新对话 */
async function useBuiltinChoice(action: BuiltinAction) {
  commandMenuOpen.value = false
  setText('')
  switchError.value = ''
  const id = props.conversationId
  try {
    if (action.kind === 'setEngine') {
      if (id) await store.setEngine(id, action.value)
      else await store.createConversation({ engineID: action.value })
      await store.setDefaultEngine(action.value)
    } else if (action.kind === 'setTeamMode') {
      if (id) await store.setTeamMode(id, action.value)
      else await store.createConversation({ teamMode: action.value })
    } else {
      const level = action.value as ThinkingLevel
      if (id) await store.setThinking(id, level)
      else await store.createConversation({ thinking: level })
    }
  } catch (error) {
    switchError.value = error instanceof Error ? error.message : String(error)
  }
}

/** v2.71 发出去的是「/model …」「/mode …」「/thinking …」：不发给模型。只打「/命令」= 列出能选的；认得出是哪个就换上，
 *  认不出留着文字、菜单列对得上的（同 Qt ComposerView.sendBuiltinCommand；带附件的照常发） */
function sendBuiltinCommand(): boolean {
  if (store.assistantChat || attachments.value.length > 0) return false
  const parsed = parseBuiltin(text.value)
  if (!parsed) return false
  if (!parsed.argument) {
    setText(`/${parsed.command} `)
    return true
  }
  const action = resolveBuiltin(parsed.command, parsed.argument, builtinContext())
  if (action) void useBuiltinChoice(action)
  else commandDismissed.value = false
  return true
}

function stop() {
  // 助手模式下停止 = 打断正在说的助手（assistant.stop）；平时停会话的 runner
  if (store.assistantChat) void store.assistantStop()
  else void store.stopRunner()
}

// MARK: 和助手说（输入台目标切到所连机器的助手：submit 走 assistant.say，模型/目录选择不适用）
const assistantReacting = computed(() => store.assistantChat && (store.assistantState?.reacting ?? false))

/** 开/关「和助手说」。开着时点「开新会话」或选中会话自动切回（store.openConversation 会退出助手模式） */
async function toggleAssistantChat(): Promise<void> {
  if (!store.connected) return
  if (store.assistantChat) await store.closeAssistantChat()
  else await store.openAssistantChat()
}

// MARK: 和助手开新会话（默认和助手对话：没选中会话时，输入本来就直接开一段新的和助手聊；
// 这个键把「开新会话」放到输入框旁边，不用去左上角会话列表找「＋ 新建」）
const newChatBusy = ref(false)
async function newConversation(): Promise<void> {
  if (!store.connected || newChatBusy.value) return
  // 当前已经是一段空着、没在跑的新会话：不再多开一段（连点几下也不攒空会话），直接聚焦输入
  const current = props.conversationId
  const detail = current ? store.details[current] : undefined
  const runtime = detail?.runtime
  const alreadyFresh =
    detail !== undefined &&
    detail.messages.length === 0 &&
    !runtime?.generating &&
    !runtime?.stopping &&
    (runtime?.queue?.length ?? 0) === 0
  if (!alreadyFresh) {
    newChatBusy.value = true
    try {
      await store.createConversation()
    } finally {
      newChatBusy.value = false
    }
  }
  textarea.value?.focus()
}

// MARK: 语音听写（Chrome 自带识别；发送键上方那颗麦克风，右键换模式/麦克风/语言）
// 两种模式：hold=按住识别松开结束（默认）；click=按一下开始持续识别、再按一下结束
const VOICE_LANGS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: '自动（跟随系统）' },
  { value: 'mix', label: '中英混合（whisper）' },
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'zh-TW', label: '中文（繁體）' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'ru-RU', label: 'Русский' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'es-ES', label: 'Español' }
]

function loadVoicePref(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
function saveVoicePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage 不可用：本次会话内生效即可
  }
}

// 识别引擎收敛为 friday-voice 一条路（语言引擎内自动）：菜单只剩模式/麦克风/语言。
// 旧缓存的 voice.model 值已无意义，不读。

const voiceMode = ref<'hold' | 'click'>(loadVoicePref('voice.mode') === 'click' ? 'click' : 'hold')
const voiceLang = ref(loadVoicePref('voice.lang') || 'auto')
const voiceMicId = ref(loadVoicePref('voice.mic'))
const voiceMenuOpen = ref(false)
const voiceWrap = ref<HTMLDivElement | null>(null)
const mics = ref<Array<{ deviceId: string; label: string }>>([])
const micEnumError = ref('')
const listening = ref(false)
const starting = ref(false)
const transcribing = ref(false)
const modelPrep = ref('')
const voiceError = ref('')
let voiceSession: SpeechInput | null = null

// 底行提示的右缘渐隐只在真被挤时挂：hint 宽度随内容收缩（flex 0 1 auto），mask 锚在元素
// 自身宽度上，无条件挂会把没到发送键的提示尾巴无辜渐隐（会话名行没事是因为它 flex:1 撑满，
// 渐隐带落在空白里）。ResizeObserver 盯着提示元素，内容宽超过盒宽（被底行挤了）才算被挤。
const hintEl = ref<HTMLSpanElement | null>(null)
const hintSqueezed = ref(false)
let hintResizeObserver: ResizeObserver | null = null
function syncHintSqueeze(): void {
  const el = hintEl.value
  // +1 容差：subpixel 文本宽取整会把差不到 1px 的假溢出当真
  hintSqueezed.value = !!el && el.scrollWidth > el.clientWidth + 1
}
watch(hintEl, (el) => {
  hintResizeObserver?.disconnect()
  hintResizeObserver = null
  if (!el) return
  hintResizeObserver = new ResizeObserver(syncHintSqueeze) // observe 自带首帧回调
  hintResizeObserver.observe(el)
  syncHintSqueeze()
})
onBeforeUnmount(() => hintResizeObserver?.disconnect())

const voiceTitle = computed(() =>
  starting.value
    ? '正在开麦克风…'
    : listening.value
      ? voiceMode.value === 'click'
        ? '正在听…再点一下结束'
        : '正在听…松开结束'
      : voiceMode.value === 'click'
        ? '点一下开始持续识别 · 右键设置麦克风/语言'
        : '按住说话，松开结束 · 右键设置麦克风/语言'
)

/** 列一遍输入设备（右键菜单里选）；Chrome 给 default/communications 两个别名，滤掉只留实体 */
async function refreshMics(): Promise<void> {
  micEnumError.value = ''
  try {
    let inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === 'audioinput' && device.deviceId !== 'default' && device.deviceId !== 'communications'
    )
    // 没授权时 label 全空：开一次默认麦（顺便预热识别的权限）再列一遍拿名字
    if (inputs.length > 0 && inputs.every((device) => !device.label)) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((track) => track.stop())
        inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
          (device) => device.kind === 'audioinput' && device.deviceId !== 'default' && device.deviceId !== 'communications'
        )
      } catch {
        micEnumError.value = '拿不到麦克风名字（未授权）'
      }
    }
    mics.value = inputs.map((device) => ({ deviceId: device.deviceId, label: device.label }))
  } catch {
    micEnumError.value = '列不出麦克风'
  }
}

function openVoiceMenu(): void {
  voiceMenuOpen.value = !voiceMenuOpen.value
  if (voiceMenuOpen.value) {
    modelOpen.value = false
    dirOpen.value = false
    void refreshMics()
  }
}

function setVoiceMode(mode: 'hold' | 'click'): void {
  voiceMode.value = mode
  saveVoicePref('voice.mode', mode)
}

function setVoiceLang(value: string): void {
  voiceLang.value = value
  saveVoicePref('voice.lang', value)
}

function chooseMic(deviceId: string): void {
  voiceMicId.value = deviceId
  saveVoicePref('voice.mic', deviceId)
}

async function startListen(): Promise<void> {
  if (listening.value || starting.value || busy.value) return
  voiceError.value = ''
  sessionBase = text.value
  starting.value = true // 开麦中：麦真正收到音（onPhase('listening')）才亮「正在听」。
  // 提前亮红会让人抢在麦克风启动前开口，首 1-2 个字正好落在没录到的那段里
  const session = new SpeechInput()
  voiceSession = session
  await session.start(
    {
      lang:
        voiceLang.value === 'auto'
          ? navigator.language || undefined // 「自动」= 跟随系统（引擎自己也会识别语言）
          : voiceLang.value,
      deviceId: voiceMicId.value || undefined,
      onPhase: (phase: VoicePhase, detail?: string) => {
        if (phase === 'listening') {
          starting.value = false
          listening.value = true
          transcribing.value = false
        } else if (phase === 'transcribing') transcribing.value = true
        // 模型准备进度由 onVoiceModelProgress 专门推送，这里不管 detail
      },
      onText: (recognized) => {
        // 转写逐段落定追加：整段拼回输入框（开头保留用户已打的字）
        const base = sessionBase
        text.value = base ? base + recognized : recognized
        void nextTick(resize)
      },
      onPartial: (preview) => {
        // 实时引擎：正在说的这句的临时字也先拼进去，边说边出字（final 落定后替换）
        const base = sessionBase
        text.value = base ? base + preview : preview
        void nextTick(resize)
      },
      onError: (code, message) => {
        voiceError.value = message || `语音听写出错（${code}）`
      },
      onEnd: () => {
        listening.value = false
        starting.value = false
        transcribing.value = false
        voiceSession = null
      }
    },
    voiceMode.value === 'hold'
  )
  // 启动即失败（麦克风打不开）：onEnd 不会来，这里收掉
  if (!session.active && voiceSession === session) {
    listening.value = false
    starting.value = false
    voiceSession = null
  }
}

/** 本次听写的基座：开始时输入框里已有的文字，识别结果接在后面 */
let sessionBase = ''

function stopListen(): void {
  voiceSession?.stop()
}

/* 左键按住（hold）／左键点一下切换（click）；右键（button=2）只开设置菜单 */
function onVoicePointerDown(event: PointerEvent): void {
  if (voiceMode.value !== 'hold' || event.button !== 0) return
  // 抓住指针：按住期间挪出按钮再松开也能收到 pointerup
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  void startListen()
}

function onVoicePointerUp(event: PointerEvent): void {
  if (voiceMode.value !== 'hold' || event.button !== 0) return
  stopListen()
}

function onVoiceClick(): void {
  if (voiceMode.value !== 'click') return // hold 模式的 click 是按住后的松手，不算切换
  if (listening.value || starting.value) stopListen() // 开麦中再点一下也停（取消）
  else void startListen()
}

/* 识别中 Esc 停止（焦点不在输入框时也要能停） */
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && listening.value) {
    event.preventDefault() // 这次 Esc 已用来停录音，别再取消选中会话（App.vue）
    stopListen()
  }
}
/* 主进程推模型准备进度（首次使用要下载模型）：下载中显示在输入框上方的下载条
   （进度 + 速度 + 已下/总量），下载完的加载阶段回落到底行提示「准备中」。速度按
   字节增量算指数滑动平均；主进程每个文件完成补推一次 100%，多文件（多引擎回退链）
   按字节累计，字节倒退 = 换了下一个文件，把上一个记进累计、速度窗重开 */
const modelDl = ref<{ label: string; percent: number; received: number; total: number; speed: number } | null>(null)
let dlAcc = { received: 0, total: 0, lastReceived: 0, lastTotal: 0, at: 0, speed: 0 }
/** 上一事件的阶段：从别的阶段重新进入 downloading = 新一轮下载，要把累计清零 */
let lastDlPhase: VoiceModelProgress['phase'] | 'none' = 'none'
type VoiceModelProgress = {
  phase: 'downloading' | 'loading' | 'ready'
  percent?: number
  detail?: string
  received?: number
  total?: number
}
function onModelProgress(state: VoiceModelProgress): void {
  if (state.phase === 'downloading') {
    modelPrep.value = ''
    // 新一轮下载（上一轮已随 loading/ready 收尾）：累计清零。不清的话首个事件的 received
    // 必然小于残留的 lastReceived，被判成「换了文件」把上一轮的字节累计进来，进度虚高
    if (lastDlPhase !== 'downloading') {
      dlAcc = { received: 0, total: 0, lastReceived: 0, lastTotal: 0, at: 0, speed: 0 }
      modelDl.value = null
    }
    if (typeof state.received === 'number') {
      const now = Date.now()
      if (state.received < dlAcc.lastReceived) {
        // 换文件：上一个文件的最后进度记进累计（靠完成时的 100% 对账）
        dlAcc.received += dlAcc.lastReceived
        dlAcc.total += dlAcc.lastTotal
        dlAcc.speed = 0
      }
      if (dlAcc.at > 0) {
        const dt = (now - dlAcc.at) / 1000
        const delta = state.received - dlAcc.lastReceived
        if (dt > 0 && delta >= 0) dlAcc.speed = dlAcc.speed ? dlAcc.speed * 0.7 + (delta / dt) * 0.3 : delta / dt
      }
      dlAcc.at = now
      dlAcc.lastReceived = state.received
      dlAcc.lastTotal = typeof state.total === 'number' ? state.total : 0
      const received = dlAcc.received + state.received
      const total = dlAcc.total + dlAcc.lastTotal
      modelDl.value = {
        label: state.detail || '语音模型',
        percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : (state.percent ?? 0),
        received,
        total,
        speed: dlAcc.speed
      }
    } else if (modelDl.value) {
      // 没字节的下载事件（解压中等）：留着已累计的字节和进度，只换标签、速度归零
      modelDl.value = { ...modelDl.value, label: state.detail || modelDl.value.label, speed: 0 }
    } else {
      modelDl.value = { label: state.detail || '语音模型', percent: state.percent ?? 0, received: 0, total: 0, speed: 0 }
    }
  } else if (state.phase === 'loading') {
    modelDl.value = null
    modelPrep.value = '语音模型准备中…'
  } else {
    modelDl.value = null
    modelPrep.value = ''
  }
  lastDlPhase = state.phase
}
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(0, Math.round(n / 1024))} KB`
}
function fmtSpeed(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB/s`
}
/** 下载条右侧文案：45% · 123.4 / 234.5 MB · 2.8 MB/s（总量未知时只报百分比） */
const dlText = computed(() => {
  const dl = modelDl.value
  if (!dl) return ''
  const parts = [`${dl.percent}%`]
  if (dl.total > 0) parts.push(`${fmtBytes(dl.received)} / ${fmtBytes(dl.total)}`)
  if (dl.speed > 0) parts.push(fmtSpeed(dl.speed))
  return parts.join(' · ')
})
let offModelProgress: (() => void) | null = null
onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  offModelProgress = window.fridayBridge.onVoiceModelProgress(onModelProgress)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  stopListen() // 组件没了把识别会话一并收掉
  offModelProgress?.()
})
</script>

<template>
  <div class="composer" @drop.prevent="onDrop" @dragover.prevent>
    <div class="composer-card" :class="{ focused }">
      <!-- 「/」命令菜单：正文是「/」+ 没空白的名字时弹在输入台上方（照 Friday 桌面端 v2.16 CommandMenu；
           出入场 90/70ms 淡入淡出也照它） -->
      <Transition name="command-menu">
        <div v-if="commandMenuOpen && commandItems.length > 0" ref="commandMenuEl" class="command-menu">
          <button
            v-for="(command, index) in commandItems"
            :key="command.name"
            class="command-item"
            :class="{ current: index === commandIndex }"
            :title="command.choice ? command.choice.detail || command.choice.title : command.description || `/${command.name}`"
            @mouseenter="commandIndex = index"
            @click="chooseCommand(command)"
          >
            <span v-if="command.choice" class="command-line">
              <span v-if="command.choice.checked" class="command-check">✓</span>
              <span class="command-name">{{ command.choice.title }}</span>
              <span class="command-spacer" />
              <span v-if="command.choice.trailing" class="command-source">{{ command.choice.trailing }}</span>
            </span>
            <span v-else class="command-line">
              <span class="command-name">/{{ command.name }}</span>
              <span v-if="command.argumentHint" class="command-hint">{{ command.argumentHint }}</span>
              <span class="command-spacer" />
              <span v-if="command.sourceTitle" class="command-source">{{ command.sourceTitle }}</span>
            </span>
            <span v-if="command.choice ? command.choice.detail : command.description" class="command-desc">
              {{ command.choice ? command.choice.detail : command.description }}
            </span>
          </button>
        </div>
      </Transition>

      <!-- 附件 chips：卡片内、文本区上方 -->
      <div v-if="attachments.length > 0" class="attachments">
        <div v-for="(attachment, index) in attachments" :key="attachment.handle" class="attachment">
          <span class="att-name">{{ attachment.name }}</span>
          <span class="att-size">{{ (attachment.size / 1024).toFixed(0) }} KB</span>
          <button class="att-remove" title="移除" @click="removeAttachment(index)">×</button>
        </div>
      </div>

      <!-- 语音识别模型下载条（首次使用拉模型时）：进度 + 速度 + 已下/总量，贴在输入框上方 -->
      <div v-if="modelDl" class="model-download" role="status">
        <span class="dl-label" :title="modelDl.label">{{ modelDl.label }}</span>
        <span class="dl-track"><i class="dl-bar" :style="{ width: modelDl.percent + '%' }" /></span>
        <span class="dl-bytes">{{ dlText }}</span>
      </div>

      <!-- 输入区：文本区左边挂「开新会话」「和助手说」按钮组（分段式一体，显眼位置，不藏在底行一排按钮里）；
           默认没选会话时输入就会自动开新的一段会话，「和助手说」把输入切到机器上的助手（不经会话） -->
      <div class="input-zone">
        <div class="chat-mode-group" role="group" aria-label="输入去向">
          <button
            class="icon-btn new-chat-btn"
            title="开新会话"
            aria-label="开新会话"
            :disabled="!store.connected || newChatBusy"
            @click="newConversation"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <path d="M12 7v6" />
              <path d="M9 10h6" />
            </svg>
          </button>
          <button
            class="icon-btn assistant-say-btn"
            :class="{ active: store.assistantChat }"
            title="和助手说：直接跟这台机器上的助手聊，不开会话"
            aria-label="和助手说"
            :disabled="!store.connected"
            @click="toggleAssistantChat"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 3.5l1.8 4.2 4.2 1.8-4.2 1.8L11 15.5l-1.8-4.2L5 9.5l4.2-1.8z" />
              <path d="M18.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
            </svg>
          </button>
        </div>
        <textarea
          ref="textarea"
          v-model="text"
          rows="1"
          :placeholder="placeholder"
          @input="resize(); uploadError = ''"
          @keydown="onKeydown"
          @focus="focused = true"
          @blur="focused = false"
        />
      </div>

      <div class="row">
        <button class="icon-btn" title="添加附件" @click="pick">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        <!-- 模型选择（Friday 输入框底行的模型选择器；和助手说时不适用，收起） -->
        <div v-if="!store.assistantChat" ref="modelWrap" class="model-wrap">
          <button
            class="model-chip"
            :class="{ open: modelOpen }"
            :title="engineTipAvailable ? '' : switchError || currentEngineTip"
            @click="toggleModelMenu"
            @mouseenter="onChipEnter"
            @mouseleave="onChipLeave"
          >
            <span class="model-name">{{ currentEngineLabel }}</span>
            <span v-if="engineMeter?.exhausted && engineMeter.note" class="model-note">{{ engineMeter.note }}</span>
            <span class="model-caret">▾</span>
            <!-- Friday v2.27 模型胶囊的边框：一圈淡的底圈，当前模型那家已用的部分从左往右描成实色
                 （80% 以上、用完了橙色；clip-path 按比例裁剪，同 Qt 的裁剪 Item） -->
            <span v-if="engineMeter && engineMeter.used > 0" class="meter" aria-hidden="true">
              <span class="meter-base"></span>
              <span
                class="meter-fill"
                :class="{ warning: engineMeter.warning }"
                :style="{ clipPath: `inset(0 ${((1 - engineMeter.used) * 100).toFixed(2)}% 0 0)` }"
              ></span>
            </span>
          </button>
          <!-- Friday v2.37 悬停浮条：服务名 · 模型、额度条（用得最多的两个窗口）、余额条（按 100 元算满、
               剩多少填多少）、明细、上次查的时间；重置 / 恢复是倒计时，浮着时每秒走；不拦鼠标 -->
          <div v-if="tipOpen" class="usage-tip" :class="{ right: tipAlignRight }">
            <div class="usage-tip-head">
              <span class="usage-tip-service">{{ effectiveEngine?.title || effectiveEngine?.model }}</span>
              <span v-if="tipEngineModel" class="usage-tip-engine">{{ tipEngineModel }}</span>
              <span v-if="engineTipData?.loading" class="usage-tip-spinner"></span>
            </div>
            <div v-for="(bar, index) in engineTipData?.bars ?? []" :key="index" class="usage-tip-bar">
              <div class="usage-tip-bar-label" :class="{ warning: bar.warning }">{{ bar.label }}</div>
              <div class="usage-tip-track">
                <div
                  class="usage-tip-fill"
                  :class="{ warning: bar.warning }"
                  :style="{ width: bar.used > 0 ? `max(6px, ${(bar.used * 100).toFixed(2)}%)` : '0' }"
                ></div>
              </div>
              <div v-if="bar.reset" class="usage-tip-bar-reset">{{ bar.reset }}</div>
            </div>
            <div
              v-if="(engineTipData?.lines.length ?? 0) > 0 || ((engineTipData?.bars.length ?? 0) === 0 && !engineTipData?.loading)"
              class="usage-tip-lines"
            >
              <div
                v-for="(line, index) in engineTipLines"
                :key="index"
                class="usage-tip-line"
                :class="{ warning: line.warning }"
              >{{ line.text }}</div>
            </div>
            <div v-if="engineTipData?.checkedAt && !engineTipData.loading" class="usage-tip-checked">{{ engineTipData.checkedAt }} 查的</div>
          </div>
          <div v-if="modelOpen" class="model-menu">
            <div v-if="availableEngines.length === 0" class="model-empty">这台机器没有可用引擎</div>
            <button
              v-for="engine in availableEngines"
              :key="engine.id"
              class="model-item"
              :class="{ current: engine.id === currentEngineID }"
              :title="engineTip(engine)"
              @click="chooseEngine(engine)"
            >
              <span class="model-item-main">
                <span class="model-item-title">{{ engine.model || engine.title }}</span>
                <span v-if="engine.model && engine.title && engine.model !== engine.title" class="model-item-model">{{ engine.title }}</span>
                <span
                  v-if="usageOf(engine.id).line"
                  class="model-item-usage"
                  :class="{ warning: usageOf(engine.id).line!.warning }"
                >{{ usageOf(engine.id).line!.text }}</span>
              </span>
              <span v-if="engine.id === currentEngineID" class="model-check">✓</span>
            </button>
            <!-- 任务模式 / 思考模式（Qt v2.9 起都在模型菜单里；换这段对话的并记成新对话的默认） -->
            <div class="menu-sep"></div>
            <div class="menu-section">任务模式</div>
            <button
              v-for="mode in TEAM_MODES"
              :key="`team-${mode.raw}`"
              class="model-item"
              :class="{ current: mode.raw === currentTeamMode }"
              @click="chooseTeamMode(mode.raw)"
            >
              <span class="model-item-main">
                <span class="model-item-title">{{ mode.title }}</span>
                <span class="model-item-detail">{{ mode.detail }}</span>
              </span>
              <span v-if="mode.raw === currentTeamMode" class="model-check">✓</span>
            </button>
            <div class="menu-sep"></div>
            <div class="menu-section">思考模式</div>
            <template v-if="thinkingAdjustable">
              <button
                v-for="row in thinkingRows"
                :key="`thinking-${row.raw}`"
                class="model-item"
                @click="chooseThinking(row.raw)"
              >
                <span class="model-item-main">
                  <span class="model-item-title">{{ row.title }}</span>
                </span>
                <span v-if="row.current" class="model-check">✓</span>
              </button>
            </template>
            <div v-else class="model-empty">这个模型不能调</div>
          </div>
        </div>

        <!-- 工作目录选择（方案 §5.3）：作用在当前会话；没打开会话就新建一段把目录带上；助手模式下收起；
             会话有内容后不能改（服务端对非空会话静默忽略），整个不显示（同 Qt 端 v2.1） -->
        <div v-if="!store.assistantChat && !workdirLocked" ref="dirWrap" class="model-wrap dir-wrap">
          <button
            class="model-chip"
            :class="{ open: dirOpen }"
            :title="dirError || `工作目录：${currentWorkdir || defaultWorkdir || '这台机器的默认目录'}`"
            @click="toggleDirMenu"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span class="model-name">{{ currentWorkdirLabel }}</span>
            <span class="model-caret">▾</span>
          </button>
          <!-- 菜单内的点击不冒泡到 document：点「浏览」等会立刻重渲染菜单（v-if 切换），
               事件还没冒到 document 时 target 已被移出 DOM，onDocClick 的 contains 会误判成「点在外面」把菜单关掉（真实鼠标点击才触发） -->
          <div v-if="dirOpen" class="model-menu dir-menu" @click.stop>
            <!-- 列表模式：默认目录 + 最近目录 + 浏览入口 -->
            <template v-if="!browsing">
              <button class="model-item" :class="{ current: !currentWorkdir }" @click="chooseWorkdir()">
                <span class="model-item-main">
                  <span class="model-item-title">默认目录</span>
                  <span v-if="defaultWorkdir" class="model-item-model">{{ defaultWorkdir }}</span>
                </span>
                <span v-if="!currentWorkdir" class="model-check">✓</span>
              </button>
              <div v-if="store.recentDirectories && store.recentDirectories.length > 0" class="dir-sep">最近选择</div>
              <div
                v-for="entry in store.recentDirectories ?? []"
                :key="entry.path"
                class="model-item dir-recent"
                :class="{ current: entry.path === currentWorkdir, missing: !entry.exists }"
                :title="entry.path"
                @click="entry.exists && chooseWorkdir(entry.path)"
              >
                <span class="model-item-main">
                  <span class="model-item-title">{{ dirBasename(entry.path) }}</span>
                  <span class="model-item-model">{{ entry.path }}</span>
                </span>
                <button class="dir-remove" title="从最近里去掉" @click.stop="store.removeRecentDirectory(entry.path)">×</button>
              </div>
              <button class="dir-browse-btn" @click="openBrowse()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <path d="M9 14l2-2 2 2" transform="translate(1,-1)" />
                </svg>
                浏览这台机器的目录…
              </button>
            </template>
            <!-- 浏览模式（fs.list）：逐层下钻，「选定此目录」收尾 -->
            <template v-else>
              <div class="dir-browse-bar">
                <button v-if="browseParent" class="dir-up" title="上一级" @click="openBrowse(browseParent)">↑</button>
                <span class="dir-browse-path" :title="browsePath">{{ browsePath || '主目录' }}</span>
                <button v-if="canMkdir" class="dir-mkdir" title="在这里新建一个文件夹" @click="toggleMkdir">＋ 新建文件夹</button>
                <button class="dir-back" @click="browsing = false">返回</button>
              </div>
              <!-- 新建文件夹（fs.mkdir）：名字只允许一级，Enter 提交，Esc 收起；建好直接进新目录 -->
              <div v-if="mkdirOpen" class="dir-mkdir-row">
                <input
                  ref="mkdirInput"
                  v-model="mkdirName"
                  class="dir-mkdir-input"
                  placeholder="文件夹名"
                  maxlength="80"
                  :disabled="mkdirBusy"
                  @keydown.enter.prevent="submitMkdir"
                  @keydown.esc="toggleMkdir"
                />
                <button class="dir-mkdir-go" :disabled="mkdirBusy || !mkdirName.trim()" @click="submitMkdir">{{ mkdirBusy ? '建…' : '建' }}</button>
              </div>
              <div v-if="mkdirError" class="dir-mkdir-error">{{ mkdirError }}</div>
              <div v-if="browseLoading" class="model-empty">正在读目录…</div>
              <div v-else-if="browseError" class="model-empty">{{ browseError }}</div>
              <div v-else class="dir-browse-list">
                <template v-if="browseRoots.length > 0 && !browseParent">
                  <div class="dir-browse-sep">这台机器的盘 / 主目录</div>
                  <button
                    v-for="root in browseRoots"
                    :key="root.path"
                    class="model-item"
                    :title="root.path"
                    @click="openBrowse(root.path)"
                  >
                    <span class="model-item-main">
                      <span class="model-item-title">{{ root.name }}</span>
                    </span>
                  </button>
                </template>
                <button
                  v-for="entry in browseEntries"
                  :key="entry.path"
                  class="model-item"
                  :title="entry.path"
                  @click="openBrowse(entry.path)"
                >
                  <span class="model-item-main">
                    <span class="model-item-title">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity: .7; vertical-align: -1px; margin-right: 3px">
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                      </svg>{{ entry.name }}
                    </span>
                  </span>
                </button>
                <div v-if="browseEntries.length === 0 && !(browseRoots.length > 0 && !browseParent)" class="model-empty">这里面没有子目录</div>
              </div>
              <button class="dir-pick" :disabled="!browsePath" @click="chooseWorkdir(browsePath)">选定此目录</button>
            </template>
          </div>
        </div>

        <!-- 权限选择（Qt PermissionChip 同款：这段会话的工具权限，自动 / 计划 / 完全；改了 runner.setPermissionMode 同步到服务端。
             没开会话时显示本机「上次选的」，选了就带着它开一段新会话；助手模式下和模型选择器一起收起） -->
        <div v-if="!store.assistantChat" ref="permWrap" class="model-wrap perm-wrap">
          <button
            class="model-chip perm-chip"
            :class="{ open: permOpen, full: currentPermission === 'full' }"
            :title="`这段会话的工具权限：${currentPermissionInfo?.detail ?? ''}`"
            @click="togglePermMenu"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <template v-if="currentPermission === 'full'">
                <path d="M12 2.5l7.5 3v5.2c0 4.6-3 8.9-7.5 10.3-4.5-1.4-7.5-5.7-7.5-10.3V5.5z" />
                <path d="M8.6 12l2.3 2.3 4.5-4.6" />
              </template>
              <template v-else-if="currentPermission === 'plan'">
                <rect x="5" y="4" width="14" height="17" rx="2" />
                <path d="M9 4.5V3.2A1.2 1.2 0 0 1 10.2 2h3.6A1.2 1.2 0 0 1 15 3.2v1.3" />
                <path d="M8.5 10.5h7M8.5 14h5" />
              </template>
              <template v-else>
                <path d="M13 2.5L5.5 13.5H11l-1 8 8-11h-5.5z" />
              </template>
            </svg>
            <span class="model-name">{{ currentPermissionInfo?.title ?? '自动' }}</span>
            <span class="model-caret">▾</span>
          </button>
          <div v-if="permOpen" class="model-menu perm-menu">
            <button
              v-for="mode in PERMISSION_MODES"
              :key="mode.raw"
              class="model-item"
              :class="{ current: mode.raw === currentPermission }"
              @click="choosePermission(mode.raw)"
            >
              <span class="model-item-main">
                <span class="model-item-title">{{ mode.title }}</span>
              </span>
              <span v-if="mode.raw === currentPermission" class="model-check">✓</span>
            </button>
            <div class="perm-detail">{{ currentPermissionInfo?.detail }}</div>
          </div>
        </div>

        <span v-if="voiceError" class="error">{{ voiceError }}</span>
        <span v-else-if="switchError" class="error">{{ switchError }}</span>
        <span v-else-if="uploadError" class="error">{{ uploadError }}</span>
        <span v-else-if="dirError" class="error">{{ dirError }}</span>
        <!-- 键盘提示（Enter/Shift+Enter）已并进 textarea 的 placeholder，这行只在语音/模型下载等临时状态时出现 -->
        <span
          v-else-if="modelPrep || starting || transcribing || listening"
          ref="hintEl"
          class="hint"
          :class="{ squeezed: hintSqueezed }"
        >{{
          modelPrep
            ? modelPrep
            : starting
              ? '正在开麦…等变红再说话'
              : transcribing
                ? '转写中…'
                : voiceMode === 'click'
                  ? '正在听 · 再点一下结束 · Esc 停止'
                  : '正在听 · 松开结束'
        }}</span>
        <span class="spacer" />
        <!-- 发送键那组：语音键浮在发送键正上方（跟着发送键走，不占行高） -->
        <div class="send-stack">
          <!-- 语音听写（Chrome 自带识别）：默认按住说话松开结束；右键换「按一下持续识别」/麦克风/语言 -->
          <div ref="voiceWrap" class="voice-wrap">
            <button
              class="round-btn voice"
              :class="{ listening, starting: starting && !listening, transcribing: transcribing && !listening && !starting }"
              :title="voiceTitle"
              :aria-label="listening ? '结束语音输入' : '语音输入'"
              @contextmenu.prevent="openVoiceMenu"
              @pointerdown="onVoicePointerDown"
              @pointerup="onVoicePointerUp"
              @pointercancel="onVoicePointerUp"
              @click="onVoiceClick"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <path d="M12 18v3" />
              </svg>
            </button>
            <div v-if="voiceMenuOpen" class="model-menu voice-menu">
              <button
                class="model-item voice-mode-row"
                title="开：点一下开始持续识别，再点一下结束；关：按住识别，松开结束"
                @click="setVoiceMode(voiceMode === 'click' ? 'hold' : 'click')"
              >
                <span class="model-item-main">
                  <span class="model-item-title">按一下持续识别</span>
                  <span class="model-item-model">{{ voiceMode === 'click' ? '开：点一下开始，再点一下结束' : '关：按住识别，松开结束' }}</span>
                </span>
                <span class="voice-switch" :class="{ on: voiceMode === 'click' }"><i class="voice-knob" /></span>
              </button>
              <div class="dir-sep">麦克风</div>
              <div v-if="micEnumError" class="model-empty">{{ micEnumError }}</div>
              <button class="model-item" :class="{ current: !voiceMicId }" @click="chooseMic('')">
                <span class="model-item-main"><span class="model-item-title">系统默认</span></span>
                <span v-if="!voiceMicId" class="model-check">✓</span>
              </button>
              <button
                v-for="(mic, index) in mics"
                :key="mic.deviceId"
                class="model-item"
                :class="{ current: voiceMicId === mic.deviceId }"
                :title="mic.label"
                @click="chooseMic(mic.deviceId)"
              >
                <span class="model-item-main"><span class="model-item-title">{{ mic.label || `麦克风 ${index + 1}` }}</span></span>
                <span v-if="voiceMicId === mic.deviceId" class="model-check">✓</span>
              </button>
              <div class="dir-sep">识别语言</div>
              <button
                v-for="lang in VOICE_LANGS"
                :key="lang.value"
                class="model-item"
                :class="{ current: voiceLang === lang.value }"
                @click="setVoiceLang(lang.value)"
              >
                <span class="model-item-main">
                  <span class="model-item-title">{{ lang.label }}</span>
                  <span v-if="lang.value !== 'auto'" class="model-item-model">{{ lang.value }}</span>
                </span>
                <span v-if="voiceLang === lang.value" class="model-check">✓</span>
              </button>
              <!-- 识别引擎收敛为 friday-voice 一条路：语言菜单后面不再有「识别模型」区 -->
            </div>
          </div>
          <!-- 生成中/助手在说：停止键；会话生成中还多一颗补充键（插入内容：做完当前这一步就交给它，qt 同款双键）。
               助手在说时没有补充键：Enter 本来就是打断重来（REMOTE.md assistant.say） -->
          <button
            v-if="sending || assistantReacting"
            class="round-btn stop"
            :title="store.assistantChat ? '打断助手' : '停止生成'"
            @click="stop"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2.5" />
            </svg>
          </button>
          <button
            v-if="sending && !store.assistantChat && canSend"
            class="round-btn send insert"
            title="补充给智能体：做完当前这一步就交给它 (Enter)"
            :disabled="busy"
            @click="send"
          >
            <svg v-if="!busy" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
            <span v-else class="busy-dot" />
          </button>
          <button
            v-else
            class="round-btn send"
            title="发送"
            :disabled="busy || !canSend"
            @click="send"
          >
            <svg v-if="!busy" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
            <span v-else class="busy-dot" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer {
  flex: none;
  padding: 4px 6px 6px;
  /* 悬浮在中间桌面底部（App.vue 的 composer-dock）：不再做面板底色，透出 3D 场景 */
  background: transparent;
}

.composer-card {
  position: relative;
  max-width: 760px;
  margin: 0 auto;
  border: 1px solid var(--border);
  border-radius: 18px;
  /* 悬浮输入台：磨砂玻璃卡（透出底下场景）+ 顶部内高光 + 柔和落影。
     磨砂画在 ::before 而不是卡片自己：backdrop-filter 会把卡片变成 backdrop root，
     后代弹出菜单（model/voice/dir-menu）的 backdrop-filter 就只能看到卡片内部，
     悬出卡片外的部分磨砂直接失效（实测开/关 blur 像素差仅 33/255）。
     挪到伪元素后，菜单的 backdrop 回到文档根，能真正糊到桌面场景 */
  background: var(--panel-2);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.22),
    0 10px 30px rgba(0, 0, 0, 0.16);
  padding: 4px 8px 7px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  transition: border-color 0.18s, box-shadow 0.18s, transform 0.18s;
}

/* 磨砂层：垫在卡片半透明底色之下（z -1，卡片在 dock 的 stacking context 内不会沉过场景） */
.composer-card::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  backdrop-filter: blur(18px) saturate(1.4);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
}

/* 贾维斯主题的输入台样式在文件末尾的「全息指令台」段（四角括号/能量线/聚焦辉光，特异性更高会盖掉上面） */

/* 聚焦：不再改边框/光环（用户要求去掉输入框聚焦边框），只保留轻轻上浮 */
.composer-card.focused {
  transform: translateY(-2px);
}

.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 8px 0;
}

.attachment {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 3px 8px;
  font-size: 12.5px;
  background: var(--panel);
}

.att-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.att-size {
  color: var(--text-3);
  font-size: 11.5px;
}

.att-remove {
  color: var(--text-3);
  font-size: 14px;
  line-height: 1;
}

.att-remove:hover {
  color: var(--fail);
}

/* 语音识别模型下载条：贴在附件区下、输入区上；窄面板里标签自己收缩，右侧字节文案不折行 */
.model-download {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 0;
  font-size: 11px;
  color: var(--text-2);
}

.dl-label {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-track {
  flex: 1 1 48px;
  min-width: 48px;
  height: 3px;
  border-radius: 2px;
  background: var(--chip);
  overflow: hidden;
}

.dl-bar {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.25s ease;
}

.dl-bytes {
  flex: none;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

textarea {
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  /* 右侧给浮在发送键上方的语音键让位，文字不打到按钮底下；上下对称 padding 让单行文字垂直居中 */
  padding: 8px 44px 8px 10px;
  background: transparent;
  color: var(--text);
  line-height: 1.55;
  min-height: 36px;
  max-height: 200px;
  overflow-x: hidden; /* 不折行的占位提示会撑出横向滚动条 */
  /* 占位提示（Enter/Shift+Enter）比输入区宽时超出部分向右渐隐，不硬切（照会话名行的做法）；
     渐隐带锚定在文字区右缘（border-box 右移 44px padding，否则渐变全落在空白 padding 里盖不住切点），
     最右 36px 恢复不透明，多行滚动时滚动条不隐身；正文长到滚动时右缘同样淡出 */
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 72px), transparent calc(100% - 44px), #000 calc(100% - 36px), #000 100%);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 72px), transparent calc(100% - 44px), #000 calc(100% - 36px), #000 100%);
}

/* 占位提示不折行（窄窗口下折成两行会被单行高度裁掉半截），超出部分由上面的 mask 渐隐 */
textarea::placeholder {
  color: var(--text-3);
  white-space: nowrap;
}

/* 输入区：文本域 + 左边「开新会话 / 和助手说」按钮组；按钮组、文本行、浮在右上的语音键垂直居中对齐 */
.input-zone {
  display: flex;
  align-items: center;
}

/* 正文多行时按钮组改顶部对齐：不再钉在整块垂直中间漂着，而是贴住文本域顶、
   中线正好对上第一行文字（组高 36px = 单行文本域高） */
.input-zone.multi-line {
  align-items: flex-start;
}

.input-zone textarea {
  flex: 1;
  min-width: 0;
}

/* 「开新会话」「和助手说」拼成分段式按钮组：整组一圈描边 + 统一圆角，与单行文本域同高（36px） */
.chat-mode-group {
  flex: none;
  display: flex;
  align-items: center;
  gap: 3px;
  margin-left: 4px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--panel);
}

.chat-mode-group .icon-btn {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 8px;
}

/* 中缝细分隔线（画在后一键左缘外的空隙里，不吃按钮 hover 底色） */
.chat-mode-group .icon-btn + .icon-btn::before {
  content: '';
  position: absolute;
  left: -2px;
  top: 7px;
  bottom: 7px;
  width: 1px;
  background: var(--border);
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 3px 0;
}

.icon-btn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  flex: none;
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.icon-btn:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

/* 模型选择器（Friday 样式：ghost chip + 上拉菜单） */
.model-wrap {
  position: relative;
  /* 空间不够时跟着收缩（chip 限宽、名称 ellipsis），发送键不被顶出输入台；
     不加 overflow——模型/目录/语音菜单都是从这个容器弹出的，加了会把菜单裁掉 */
  flex: 0 1 auto;
  min-width: 0;
}

.model-chip {
  position: relative; /* 用量边框层（.meter）贴着 chip 定位 */
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* 跟着 .model-wrap 的收缩变窄（名称有 ellipsis），不收缩时最宽仍是 220px */
  max-width: min(220px, 100%);
  height: 30px;
  padding: 0 9px;
  border-radius: 8px;
  color: var(--text-2);
  font-size: 12.5px;
}

.model-chip:hover,
.model-chip.open {
  background: var(--hover);
  color: var(--text);
}

/* Friday v2.27 模型胶囊的边框：底圈一圈淡的，当前模型那家已用的部分从左往右描成实色
   （80% 以上、用完了橙色）；clip-path inset 按自身宽度百分比裁剪，不需要知道像素宽 */
.meter {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.meter-base,
.meter-fill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  border: 1.5px solid transparent;
}

.meter-base {
  border-color: color-mix(in srgb, var(--text) 14%, transparent);
}

.meter-fill {
  border-color: color-mix(in srgb, var(--text) 50%, transparent);
  transition: clip-path 0.3s cubic-bezier(0.215, 0.61, 0.355, 1);
}

.meter-fill.warning {
  border-color: var(--warn);
}

/* 用完了时模型名后面写的（「15:20 恢复」「额度用完」，== Friday Capsule 的 detail：淡色小字） */
.model-note {
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
}

.model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-caret {
  font-size: 9px;
  color: var(--text-3);
}

/* Friday v2.37 悬停浮条（== UsageTip）：浮在胶囊上方 6px、宽 264，外观同弹出菜单（磨砂玻璃）；
   不拦鼠标（同 Qt 的 popupType Item）——鼠标只能停在胶囊上，浮条本身不接事件。
   无边框（用户要求 tooltip 一律去边框），层次感靠投影 */
.usage-tip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  width: 264px;
  padding: 12px 14px;
  background: var(--panel);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  border-radius: 14px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.18);
  z-index: 31;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: usage-tip-in 0.09s ease-out;
}

.usage-tip.right {
  left: auto;
  right: 0;
}

@keyframes usage-tip-in {
  from {
    opacity: 0;
  }
}

/* 头：服务名（粗）· 模型名（淡，太长留尾巴 ≈ 中间截断）；在查时右上角转圈 */
.usage-tip-head {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}

.usage-tip-service {
  flex: none;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}

.usage-tip-engine {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-size: 12.5px;
  color: var(--text-2);
}

.usage-tip-spinner {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--text-3);
  border-top-color: transparent;
  animation: usage-tip-spin 0.8s linear infinite;
}

@keyframes usage-tip-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 条：标签（warning 橙）、6px 圆角轨道 + 填充（剩 0 时不填，有一点就至少 6px）、下面一行小字 */
.usage-tip-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.usage-tip-bar-label {
  font-size: 12px;
  color: var(--text);
}

.usage-tip-bar-label.warning {
  color: var(--warn);
}

.usage-tip-track {
  height: 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text) 10%, transparent);
  overflow: hidden;
}

.usage-tip-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--text-2);
  transition: width 0.25s cubic-bezier(0.215, 0.61, 0.355, 1);
}

.usage-tip-fill.warning {
  background: var(--warn);
}

.usage-tip-bar-reset {
  font-size: 11px;
  color: var(--text-3);
}

/* 明细行（warning 橙）+ 上次查的时间 */
.usage-tip-lines {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.usage-tip-line {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.usage-tip-line.warning {
  color: var(--warn);
}

.usage-tip-checked {
  font-size: 10.5px;
  color: var(--text-3);
}

.model-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  min-width: 240px;
  max-height: 300px;
  overflow-y: auto;
  /* 弹出菜单：磨砂玻璃（半透底 + 模糊背景），和悬浮输入台同一质感 */
  background: var(--panel);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.18);
  padding: 5px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* ---- 工作目录选择 ---- */
.dir-menu {
  min-width: 300px;
  max-height: 360px;
}

/* ---- 模型菜单里的任务模式 / 思考模式两节（Qt v2.9 同款；分组线 + 节标题） ---- */
.menu-sep {
  flex: none;
  margin: 4px 9px 2px;
  border-top: 1px solid var(--border);
}

.menu-section {
  flex: none;
  padding: 4px 9px 2px;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--text-3);
}

.model-item-detail {
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text-3);
  /* 两行说明不折成一长条：菜单限宽下中间截断太齐，自然换行更好读 */
  white-space: normal;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

/* ---- 权限选择（Qt PermissionChip：full 时橙字提醒） ---- */
.perm-chip.full {
  color: var(--warn);
}

.perm-chip.full:hover,
.perm-chip.full.open {
  color: var(--warn);
}

.perm-menu {
  min-width: 260px;
}

/* 菜单底部当前模式的说明（Qt：分隔线 + 不可点的说明文字） */
.perm-detail {
  flex: none;
  margin-top: 2px;
  padding: 7px 9px 5px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-3);
}

.dir-sep,
.dir-browse-sep {
  flex: none;
  padding: 7px 9px 3px;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--text-3);
}

.dir-recent.missing {
  opacity: 0.45;
  cursor: default;
}

.dir-recent .model-item-model {
  direction: rtl; /* 路径太长时留下尾巴（盘符/深层目录名）而不是开头 */
  text-align: left;
}

.dir-remove {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1;
}

.dir-remove:hover {
  background: var(--hover);
  color: var(--fail);
}

.dir-browse-btn {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 3px;
  padding: 7px 9px;
  border-top: 1px solid var(--border);
  border-radius: 0 0 8px 8px;
  color: var(--text-2);
  font-size: 12.5px;
}

.dir-browse-btn:hover {
  color: var(--text);
  background: var(--hover);
}

.dir-browse-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 5px 7px;
  border-bottom: 1px solid var(--border);
}

.dir-up,
.dir-back,
.dir-mkdir {
  flex: none;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
}

.dir-up:hover,
.dir-back:hover,
.dir-mkdir:hover {
  background: var(--hover);
  color: var(--text);
}

.dir-browse-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 11.5px;
  color: var(--text-2);
}

/* ---- 新建目录（fs.mkdir）：输入行 + 错误 ---- */
.dir-mkdir-row {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 6px 5px 0;
}

.dir-mkdir-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
}

.dir-mkdir-input:focus {
  outline: none;
  border-color: var(--accent, var(--text-2));
}

.dir-mkdir-go {
  flex: none;
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--hover);
  color: var(--text);
  font-size: 12px;
}

.dir-mkdir-go:disabled {
  opacity: .5;
}

.dir-mkdir-error {
  flex: none;
  padding: 4px 5px 0;
  font-size: 11.5px;
  color: var(--danger, #e5484d);
}

.dir-browse-list {
  min-height: 120px;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0 -5px;
  padding: 0 5px;
}

.dir-pick {
  flex: none;
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
}

.dir-pick:hover:not(:disabled) {
  filter: brightness(1.08);
}

.dir-pick:disabled {
  background: var(--chip);
  color: var(--text-3);
  cursor: default;
}

.model-empty {
  padding: 10px 12px;
  font-size: 12.5px;
  color: var(--text-3);
}

.model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 8px;
  text-align: left;
}

.model-item:hover {
  background: var(--hover);
}

.model-item.current {
  background: var(--selected);
}

.model-item-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.model-item-title {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-item-model {
  font-size: 11.5px;
  color: var(--text-3);
  font-family: 'Cascadia Code', Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 服务端来的余额 / 套餐用量 / 额度用完（services.usage + serviceUsage 事件）：菜单里每个模型下面一行小字，
   额度用完 / 余额不足时转橙色 */
.model-item-usage {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-item-usage.warning {
  color: var(--warn);
}

.model-check {
  flex: none;
  color: var(--accent);
  font-size: 13px;
}

/* ---- 「/」命令菜单（照 Friday 桌面端 CommandMenu.qml；弹在输入台上方，质感同 model-menu） ---- */
.command-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  /* 宽度照桌面端 min(520, 输入框宽)，从左边贴齐 */
  width: min(520px, 100%);
  max-height: 320px;
  overflow-y: auto;
  background: var(--panel);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.18);
  padding: 5px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* 出入场：90ms 进 / 70ms 出（照桌面端 enter/exit Transition） */
.command-menu-enter-active {
  transition: opacity 0.09s ease-out;
}

.command-menu-leave-active {
  transition: opacity 0.07s ease-in;
}

.command-menu-enter-from,
.command-menu-leave-to {
  opacity: 0;
}

.command-item {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 9px;
  border-radius: 8px;
  text-align: left;
}

/* 悬停 / 键盘选中 = 强调色实底、文字反色（照桌面端 Theme.menuHighlight：== NSMenu；
   悬停即选中——mouseenter 已把 index 指过来，两处同款防闪变） */
.command-item:hover,
.command-item.current {
  background: var(--accent);
}

.command-item:hover .command-name,
.command-item.current .command-name {
  color: var(--accent-foreground);
}

.command-item:hover .command-hint,
.command-item:hover .command-source,
.command-item:hover .command-desc,
.command-item.current .command-hint,
.command-item.current .command-source,
.command-item.current .command-desc {
  color: color-mix(in srgb, var(--accent-foreground) 80%, transparent);
}

.command-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.command-name {
  flex: none;
  max-width: 62%; /* 名字特别长时省略（防把来源/提示顶出菜单） */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.command-check {
  flex: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.command-item:hover .command-check,
.command-item.current .command-check {
  color: var(--accent-foreground);
}

.command-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-3);
}

.command-spacer {
  flex: 1;
}

.command-source {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
}

.command-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--text-3);
}

.error {
  color: var(--fail);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
  /* 底行空间不够时自己收缩，不把发送/语音键顶出输入台 */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
}

/* 真被挤（内容宽 > 盒宽）才右缘渐隐：mask 锚在元素自身宽度上，
   不挤时挂上去会把没到发送键的提示尾巴无辜渐隐 */
.hint.squeezed {
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 28px), transparent);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 28px), transparent);
}

/* 面板窄时提示行没地方放：按容器宽（.assistant-chat 设了 container-type）而不是视口宽判断，
   视口媒体查询在 1920px 桌面上永远不命中，提示行在 352px 面板里会被挤断 */
@container (max-width: 420px) {
  .hint {
    display: none;
  }
}

.spacer {
  flex: 1;
}

/* 发送键那组（停止/补充/发送 + 浮在上方的语音键） */
.send-stack {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

/* 语音键：浮在发送键正上方、右对齐（跟着发送键走），不占行高；
   bottom 4.8px 是实测值：让语音键中心线和输入行中心线完全重合（输入行高 37.7px、组高 36px）；
   录音中红色脉冲；右键弹设置菜单（菜单再往上浮） */
.voice-wrap {
  position: absolute;
  bottom: calc(100% + 4.8px);
  right: 0;
  display: flex;
  z-index: 5;
}

.round-btn.voice {
  border: 1px solid var(--border);
  color: var(--text-2);
  background: transparent;
  transition: color 0.15s, border-color 0.15s, background 0.15s, box-shadow 0.15s;
}

.round-btn.voice:hover {
  background: var(--hover);
  color: var(--text);
}

.round-btn.voice.listening {
  border-color: var(--fail);
  color: var(--fail);
  animation: voice-pulse 1.5s ease-in-out infinite;
}

/* 松开后转写中：强调色呼吸（录音红、转写黄） */
.round-btn.voice.transcribing {
  border-color: var(--warn, #d59f0a);
  color: var(--warn, #d59f0a);
  animation: voice-pulse 1.5s ease-in-out infinite;
}

/* 开麦中：还没真在收音，给个中性弱化态（提示「等变红再说话」） */
.round-btn.voice.starting {
  border-color: var(--text-3);
  color: var(--text-3);
  animation: voice-pulse 1s ease-in-out infinite;
}

@keyframes voice-pulse {
  0%, 100% { box-shadow: 0 0 0 0 transparent; }
  50% { box-shadow: 0 0 12px color-mix(in srgb, var(--fail) 45%, transparent); }
}

.voice-menu {
  left: auto;
  right: 0;
  min-width: 264px;
}

.voice-mode-row {
  align-items: center;
}

/* 小开关胶囊（「按一下持续识别」那一行右侧） */
.voice-switch {
  flex: none;
  position: relative;
  width: 30px;
  height: 17px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--chip);
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.voice-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--text-2);
  transition: left 0.15s, background 0.15s;
}

.voice-switch.on {
  background: var(--accent);
  border-color: var(--accent);
}

.voice-switch.on .voice-knob {
  left: 15px;
  background: #fff;
}

/* 圆形发送 / 停止键（Friday 样式） */
.round-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.round-btn.send {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 35%, transparent);
  transition: filter 0.12s, opacity 0.12s, transform 0.12s, box-shadow 0.12s;
}

.round-btn.send:hover:not(:disabled) {
  filter: brightness(1.1);
  transform: translateY(-1px);
  box-shadow: 0 5px 14px color-mix(in srgb, var(--accent) 45%, transparent);
}

.round-btn.send:active:not(:disabled) {
  transform: translateY(0);
}

.round-btn.send:disabled {
  background: var(--chip);
  color: var(--text-3);
  cursor: default;
}

.round-btn.stop {
  border: 1px solid var(--fail);
  color: var(--fail);
  background: transparent;
}

.round-btn.stop:hover {
  background: var(--fail);
  color: #fff;
}

.busy-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* 贾维斯界面：输入台 = 全息指令台。真四角括号（伪元素画，不被圆角裁掉）、顶部能量线、聚焦辉光 */

[data-theme='jarvis'] .composer-card {
  position: relative;
  border-radius: 6px;
  background:
    linear-gradient(90deg, transparent, var(--accent-a40), transparent) top / 100% 1px no-repeat,
    var(--panel-glass-deep);
  border-color: var(--accent-a26);
  box-shadow:
    0 0 20px var(--accent-a7),
    0 10px 26px rgba(0, 0, 0, 0.45);
}

/* 磨砂同卡挪到伪元素（原因见 .composer-card::before），糊得比默认主题轻一点 */
[data-theme='jarvis'] .composer-card::before {
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

/* 四角括号：::before 画上面两角，::after 画下面两角 */
[data-theme='jarvis'] .composer-card::before,
[data-theme='jarvis'] .composer-card::after {
  content: '';
  position: absolute;
  left: -1px;
  right: -1px;
  height: 14px;
  pointer-events: none;
  background:
    linear-gradient(var(--accent) 0 0) left top / 14px 2px,
    linear-gradient(var(--accent) 0 0) left top / 2px 14px,
    linear-gradient(var(--accent) 0 0) right top / 14px 2px,
    linear-gradient(var(--accent) 0 0) right top / 2px 14px;
  background-repeat: no-repeat;
  opacity: 0.75;
  transition: opacity 0.15s;
}

[data-theme='jarvis'] .composer-card::before {
  top: -1px;
}

[data-theme='jarvis'] .composer-card::after {
  bottom: -1px;
  background:
    linear-gradient(var(--accent) 0 0) left bottom / 14px 2px,
    linear-gradient(var(--accent) 0 0) left bottom / 2px 14px,
    linear-gradient(var(--accent) 0 0) right bottom / 14px 2px,
    linear-gradient(var(--accent) 0 0) right bottom / 2px 14px;
  background-repeat: no-repeat;
}

/* 聚焦：同样只上浮，不改边框/辉光；四角括号也不再点亮（去掉聚焦边框效果） */
[data-theme='jarvis'] .composer-card.focused {
  transform: translateY(-2px);
}

[data-theme='jarvis'] .composer-card textarea {
  background: transparent;
  caret-color: var(--accent);
}

[data-theme='jarvis'] .composer-card textarea::placeholder {
  font-family: var(--font-hud);
  letter-spacing: 2px;
}

[data-theme='jarvis'] .icon-btn {
  color: var(--accent-a65);
}

[data-theme='jarvis'] .icon-btn:hover {
  color: var(--accent);
  text-shadow: 0 0 8px var(--accent-a60);
}

/* 按钮组整体：贾维斯主题常态一圈淡青描边 + 淡青底（不靠悬停才被看见）；小圆角的方HUD 感（照模型 chip） */
[data-theme='jarvis'] .chat-mode-group {
  border-color: var(--accent-a30);
  background: var(--accent-a10);
  border-radius: 5px;
}

[data-theme='jarvis'] .chat-mode-group .icon-btn {
  color: var(--accent);
  border-radius: 3px;
}

/* 和助手说开着时（输入目标就是助手）：底色加重 + 一圈微光 */
[data-theme='jarvis'] .assistant-say-btn.active {
  color: var(--accent);
  background: var(--accent-a20);
  box-shadow: 0 0 10px var(--accent-a25);
}

/* 中缝分隔线也用淡青：深底上 var(--border) 灰线看不清 */
[data-theme='jarvis'] .chat-mode-group .icon-btn + .icon-btn::before {
  background: var(--accent-a30);
}

/* 系统主题：开着时给个明确的选中态 */
.assistant-say-btn.active {
  color: var(--text);
  background: var(--hover);
}

[data-theme='jarvis'] .hint {
  color: var(--text-3-a70);
}

[data-theme='jarvis'] .model-chip {
  font-family: var(--font-hud);
  letter-spacing: 1px;
  border-color: var(--accent-a30);
  border-radius: 4px;
  color: var(--code-inline-fg-a90);
}

[data-theme='jarvis'] .model-chip .model-caret {
  color: var(--accent);
}

[data-theme='jarvis'] .model-chip:hover,
[data-theme='jarvis'] .model-chip.open {
  border-color: var(--accent-a55);
  color: #c9f2ff;
}

[data-theme='jarvis'] .model-menu {
  /* 全息面板：深色玻璃 + 青色描边（模糊背景照加，透出底下网格） */
  background: var(--panel-glass-deep);
  border-color: var(--accent-a30);
  box-shadow:
    0 0 18px var(--accent-a10),
    0 12px 32px rgba(0, 0, 0, 0.5);
}

[data-theme='jarvis'] .command-menu {
  /* 同 model-menu 的全息面板；选中行的青色实底 + 黑字在上面照样成立（对比度 11.6:1） */
  background: var(--panel-glass-deep);
  border-color: var(--accent-a30);
  box-shadow:
    0 0 18px var(--accent-a10),
    0 12px 32px rgba(0, 0, 0, 0.5);
}

[data-theme='jarvis'] .dir-sep,
[data-theme='jarvis'] .dir-browse-sep,
[data-theme='jarvis'] .menu-section {
  font-family: var(--font-hud);
  color: var(--accent-a65);
}

[data-theme='jarvis'] .dir-up,
[data-theme='jarvis'] .dir-back {
  border-color: var(--accent-a30);
  color: var(--text-2);
}

[data-theme='jarvis'] .dir-pick {
  background: var(--accent-a20);
  border: 1px solid var(--accent-a55);
  color: #bdf3ff;
  box-shadow: 0 0 12px var(--accent-a25);
}

[data-theme='jarvis'] .dir-pick:disabled {
  background: transparent;
  border-color: var(--accent-a20);
  color: var(--text-3);
  box-shadow: none;
}

[data-theme='jarvis'] .dir-browse-btn {
  border-top-color: var(--accent-a20);
  color: var(--accent-a65);
}

[data-theme='jarvis'] .dir-browse-btn:hover {
  color: var(--accent);
  background: var(--hover);
}

/* 发送 / 停止钮：圆环辉光；生成中停止键红色脉冲 */
[data-theme='jarvis'] .round-btn {
  border: 1px solid var(--accent-a55);
  background: var(--accent-a10);
  color: #bdf3ff;
  box-shadow:
    0 0 12px var(--accent-a25),
    inset 0 0 8px var(--accent-a12);
  transition: box-shadow 0.15s, transform 0.15s, filter 0.15s;
}

[data-theme='jarvis'] .round-btn.send:hover:not(:disabled) {
  box-shadow:
    0 0 20px var(--accent-a50),
    inset 0 0 10px var(--accent-a20);
  transform: translateY(-1px);
}

[data-theme='jarvis'] .round-btn.send:disabled {
  opacity: 0.35;
  box-shadow: none;
}

[data-theme='jarvis'] .round-btn.stop {
  border-color: var(--fail-a65);
  background: var(--fail-a12);
  color: #ffc2cd;
  animation: jarvis-stop-pulse 1.2s ease-in-out infinite;
}

@keyframes jarvis-stop-pulse {
  50% {
    box-shadow: 0 0 22px var(--fail-a50);
  }
}

[data-theme='jarvis'] .busy-dot {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent-a80);
}

/* 语音键：常态随上面 .round-btn 的青色圆环；录音中转红色脉冲（照停止键那套） */
[data-theme='jarvis'] .round-btn.voice.listening {
  border-color: var(--fail-a65);
  background: var(--fail-a12);
  color: #ffc2cd;
  animation: jarvis-voice-pulse 1.2s ease-in-out infinite;
}

[data-theme='jarvis'] .round-btn.voice.transcribing {
  border-color: var(--accent-a55);
  color: var(--accent);
  animation: jarvis-voice-pulse 1.2s ease-in-out infinite;
}

[data-theme='jarvis'] .round-btn.voice.starting {
  border-color: var(--accent-a30);
  color: var(--accent-a65);
  animation: jarvis-voice-pulse 1s ease-in-out infinite;
}

@keyframes jarvis-voice-pulse {
  50% { box-shadow: 0 0 22px var(--fail-a50); }
}

[data-theme='jarvis'] .voice-switch {
  border-color: var(--accent-a30);
  background: transparent;
}

[data-theme='jarvis'] .voice-knob {
  background: var(--accent-a65);
}

[data-theme='jarvis'] .voice-switch.on {
  background: var(--accent-a20);
  border-color: var(--accent-a55);
  box-shadow: 0 0 8px var(--accent-a25);
}

[data-theme='jarvis'] .voice-switch.on .voice-knob {
  background: var(--accent);
}
</style>
