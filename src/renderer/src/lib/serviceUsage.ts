// 各家在线服务的余额 / 套餐用量（REMOTE.md §6「在线服务」）——模型选择器里每家模型下面那一句、悬停的明细。
//
// 两个来源（和 Friday 桌面端 ServiceUsage 一样）：
// 1. 查：services.usage {baseURL, secretName, custom, observedOnly} → {supported, report?, error?, observed}；
// 2. 推：serviceUsage 事件 {changes:[{observedKey, observed}]}——这台机器上的请求成功（observed=false）、
//    额度用完 / 用完后头一次成功（observed=true）时推，只有订了 config.subscribe 的客户端才收（见 stores/app.ts）。
//    observedKey =「接口地址去掉末尾的 / 、小写 + | + 密钥名」，和这里的 usageKey 是同一套写法，可以直接对上。
//
// 文案与 ServiceUsage::menuLine / summaryLines / usedFraction / activeQuota 对齐（关键短语逐字照抄）。

/** 套餐 / 额度的一个周期窗口（ServiceUsage::Window） */
export interface UsageWindow {
  /** 「5 小时」「每周」「这个密钥的额度」「tokens」…… */
  title: string
  used?: number
  limit?: number
  remaining?: number
  /** 只给了比例的（智谱）：剩下的百分比 0–100 */
  remainingPercent?: number
  /** ISO 时间（UTC） */
  resetAt?: string
  /** 用量的单位：「次」「tokens」「$」
   *  */
  unit?: string
}

/** 余额（ServiceUsage::Balance） */
export interface UsageBalance {
  amount: number
  /** CNY / USD；空 = 不知道 */
  currency?: string
  /** 其中赠送的 */
  granted?: number
  /** 欠费（Kimi 现金余额为负） */
  owed?: number
}

/** 查到的（ServiceUsage::Report::toJson） */
export interface UsageReport {
  balances?: UsageBalance[]
  windows?: UsageWindow[]
  /** 套餐 / 会员等级 */
  plan?: string
  /** 服务说能不能调用（nullopt = 没说） */
  available?: boolean
  /** 累计已用（OpenRouter，美元） */
  spent?: number
  spentThisMonth?: number
  freeTier?: boolean
  /** 查出来是套餐 */
  subscription?: boolean
  /** 要提醒的（橙色） */
  warnings?: string[]
  fetchedAt?: string
}

/** 顺手记下的（ServiceUsage::Observed::toJson） */
export interface UsageObserved {
  /** 最近一次请求响应头里的限流余量 */
  limits?: UsageWindow[]
  limitsAt?: string
  /** 最近一次额度用完 / 余额不足 */
  quotaAt?: string
  /** usage / balance */
  quotaKind?: string
  /** 服务说的恢复时间 */
  resumeAt?: string
  /** 最近一次请求成功 */
  okAt?: string
}

/** services.usage 的回执 */
export interface UsageResult {
  /** 这个地址有没有能用密钥查的余额 / 用量接口 */
  supported?: boolean
  report?: UsageReport
  /** 查不到时的原因（不是协议错误） */
  error?: string
  observed?: UsageObserved
}

/** 一行文字（warning = 橙色：额度用完、余额不足、欠费） */
export interface UsageLine {
  text: string
  warning: boolean
}

/** 手里记着的一份用量（按接口地址 + 密钥名） */
export interface UsageEntry {
  key: string
  baseURL: string
  secretName: string
  custom: boolean
  /** 正在查 */
  loading: boolean
  /** 查过一次（含「这个地址不支持查询」） */
  checked: boolean
  supported: boolean
  report?: UsageReport
  observed?: UsageObserved
  /** 查不到的原因（给提示用，不弹错） */
  error: string
  /** 上次查的时间（毫秒；推送来了按它节流） */
  checkedAt: number
}

/** 一个要查的目标（同一家的多个模型只要查一次） */
export interface UsageTarget {
  key: string
  baseURL: string
  secretName: string
  custom: boolean
}

/** 服务端认的键：接口地址去掉末尾的 /、小写 + `|` + 密钥名（== ServiceUsage::observedKey） */
export function usageKey(baseURL: string, secretName: string): string {
  let base = (baseURL ?? '').trim().toLowerCase()
  while (base.endsWith('/')) base = base.slice(0, -1)
  return `${base}|${secretName ?? ''}`
}

/** 本机的地址（本地大模型 power://、局域网里的 Ollama）：不查余额（== ServiceUsage 里「本机的不试」） */
export function isLocalBaseURL(baseURL: string): boolean {
  const text = (baseURL ?? '').trim().toLowerCase()
  if (!/^https?:\/\//.test(text)) return true
  try {
    const host = new URL(text).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true
    if (host.endsWith('.local')) return true
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
    return false
  } catch {
    return true
  }
}

/** 这个地址值不值得查一次（本机的不查） */
export function canQueryUsage(baseURL: string): boolean {
  return !isLocalBaseURL(baseURL)
}

/** ISO 时间（UTC）/ Unix 时间戳（秒 / 毫秒）→ Date */
export function usageDate(value: string | number | undefined | null): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : 0
    return ms > 0 ? new Date(ms) : undefined
  }
  const text = String(value).trim()
  if (!text) return undefined
  if (/^\d+(\.\d+)?$/.test(text)) return usageDate(Number(text))
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** 「¥12.34」「$0.00」「-¥3.00」（== ServiceUsage::money） */
export function usageMoney(amount: number, currency?: string): string {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''
  return `${amount < 0 ? '-' : ''}${symbol}${Math.abs(amount).toFixed(2)}`
}

/** 大数：亿 / 万，一位小数（== ServiceUsage::count） */
export function usageCount(value: number): string {
  const trimmed = (number: number): string => {
    const rounded = Math.round(number * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  }
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${trimmed(value / 1e8)} 亿`
  if (abs >= 1e4) return `${trimmed(value / 1e4)} 万`
  return String(Math.round(value))
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** 「15:20」「明天 08:00」「11月1日 08:00」（== ServiceUsage::when） */
export function usageWhen(date: Date, now: Date): string {
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((day.getTime() - today.getTime()) / 86_400_000)
  if (days === 0) return time
  if (days === 1) return `明天 ${time}`
  if (days === -1) return `昨天 ${time}`
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

/** 这个窗口已用的比例 0–1（== ServiceUsage::usedFraction）；算不出返回 undefined */
export function usedFraction(window: UsageWindow, now: Date): number | undefined {
  let fraction: number | undefined
  if (typeof window.remainingPercent === 'number') {
    fraction = 1 - window.remainingPercent / 100
  } else if (typeof window.limit === 'number' && window.limit > 0) {
    if (typeof window.remaining === 'number') fraction = 1 - window.remaining / window.limit
    else if (typeof window.used === 'number') fraction = window.used / window.limit
  }
  if (fraction === undefined) return undefined
  const resetAt = usageDate(window.resetAt)
  if (resetAt && resetAt.getTime() <= now.getTime()) return 0
  return Math.min(Math.max(fraction, 0), 1)
}

/** 算得出用了多少的窗口里用得最多的两个，按原来的顺序（== ServiceUsage 的 barWindows） */
export function usageBarWindows(report: UsageReport, now: Date): Array<{ window: UsageWindow; used: number }> {
  const windows = (report.windows ?? [])
    .map((window, index) => ({ window, index, used: usedFraction(window, now) }))
    .filter((item): item is { window: UsageWindow; index: number; used: number } => item.used !== undefined)
  windows.sort((a, b) => (a.used !== b.used ? b.used - a.used : a.index - b.index))
  return windows
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map((item) => ({ window: item.window, used: item.used }))
}

/** 额度用完 / 余额不足还没过去（== ServiceUsage::activeQuota） */
function activeQuota(
  observed: UsageObserved | undefined,
  report: UsageReport | undefined,
  now: Date
): { balance: boolean; resumeAt?: Date } | undefined {
  const quotaAt = usageDate(observed?.quotaAt)
  if (!quotaAt) return undefined
  const okAt = usageDate(observed?.okAt)
  if (okAt && okAt.getTime() > quotaAt.getTime()) return undefined
  if (quotaCleared(observed, report, now)) return undefined
  if (observed?.quotaKind === 'balance') return { balance: true }
  const resumeAt = usageDate(observed?.resumeAt)
  if (resumeAt) return resumeAt.getTime() > now.getTime() ? { balance: false, resumeAt } : undefined
  return now.getTime() - quotaAt.getTime() < 7 * 86_400_000 ? { balance: false } : undefined
}

/** 额度用完之后查到的已经恢复了（== ServiceUsage::quotaCleared；quotaReportLag = 60 秒） */
export function quotaCleared(observed: UsageObserved | undefined, report: UsageReport | undefined, now: Date): boolean {
  const quotaAt = usageDate(observed?.quotaAt)
  const fetchedAt = usageDate(report?.fetchedAt)
  if (!quotaAt || !report || !fetchedAt) return false
  if (fetchedAt.getTime() - quotaAt.getTime() < 60_000) return false
  if (report.available === false) return false
  if (observed?.quotaKind === 'balance') {
    return report.available === true || (report.balances ?? []).some((balance) => balance.amount > 0)
  }
  let any = false
  for (const window of report.windows ?? []) {
    const used = usedFraction(window, now)
    if (used === undefined) continue
    if (used >= 1) return false
    any = true
  }
  return any
}

function windowText(window: UsageWindow, now: Date, withReset: boolean): string {
  let amount = ''
  if (typeof window.remainingPercent === 'number') {
    amount = `${Math.round(window.remainingPercent)}%`
  } else if (typeof window.remaining === 'number') {
    const dollars = window.unit === '$'
    const format = (value: number): string => (dollars ? usageMoney(value, 'USD') : usageCount(value))
    amount = format(window.remaining)
    if (typeof window.limit === 'number') amount += ` / ${format(window.limit)}`
    if (!dollars && window.unit) amount += ` ${window.unit}`
  } else {
    return ''
  }
  const last = window.title ? window.title[window.title.length - 1]! : ''
  const space = last && last.charCodeAt(0) < 0x80 && /[A-Za-z]/.test(last) ? ' ' : ''
  let text = `${window.title}${space}剩 ${amount}`
  const resetAt = usageDate(window.resetAt)
  if (withReset && resetAt && resetAt.getTime() > now.getTime()) text += `（${usageWhen(resetAt, now)} 重置）`
  return text
}

function exhausted(window: UsageWindow): boolean {
  if (typeof window.remainingPercent === 'number') return window.remainingPercent <= 0
  return typeof window.remaining === 'number' && window.remaining <= 0
}

/**
 * 模型选择菜单里每家模型下面那一句（== ServiceUsage::menuLine）：
 * 「5 小时剩 91% · 每周剩 78%」「余额 ¥12.34」「余额不足，充值后恢复」「额度用完，15:20 恢复」「额度用完了」。
 * 没有可说的（不支持查询、又没什么记下的）返回 undefined
 */
export function usageMenuLine(report: UsageReport | undefined, observed: UsageObserved | undefined, now: Date): UsageLine | undefined {
  const quota = activeQuota(observed, report, now)
  if (quota) {
    if (quota.balance) return { text: '余额不足，充值后恢复', warning: true }
    return {
      text: quota.resumeAt ? `额度用完，${usageWhen(quota.resumeAt, now)} 恢复` : '额度用完了',
      warning: true
    }
  }
  if (!report) return undefined
  const picked = usageBarWindows(report, now)
  if (picked.length > 0) {
    for (const item of picked) {
      if (item.used >= 1) {
        const resetAt = usageDate(item.window.resetAt)
        const reset = resetAt && resetAt.getTime() > now.getTime() ? `，${usageWhen(resetAt, now)} 重置` : ''
        return { text: `${item.window.title}用完了${reset}`, warning: true }
      }
    }
    return {
      text: picked
        .map((item) => {
          const last = item.window.title ? item.window.title[item.window.title.length - 1]! : ''
          const space = last && last.charCodeAt(0) < 0x80 && /[A-Za-z]/.test(last) ? ' ' : ''
          return `${item.window.title}${space}剩 ${Math.round((1 - item.used) * 100)}%`
        })
        .join(' · '),
      warning: false
    }
  }
  if ((report.warnings ?? []).length > 0) return { text: report.warnings![0]!, warning: true }
  const parts: string[] = []
  let warning = report.available === false
  const balance = (report.balances ?? [])[0]
  if (balance) {
    parts.push(`余额 ${usageMoney(balance.amount, balance.currency)}`)
    if (balance.owed && balance.owed > 0) {
      parts.push(`欠费 ${usageMoney(balance.owed, balance.currency)}`)
      warning = true
    }
  } else if (typeof report.spent === 'number') {
    parts.push(`累计已用 ${usageMoney(report.spent, 'USD')}`)
  }
  if (report.available === false) parts.push('不够调用了')
  if (parts.length === 0) return undefined
  return { text: parts.join('，'), warning }
}

/**
 * 悬停时的明细（== ServiceUsage::summaryLines 的几条）：余额、套餐窗口、额度用完、限流余量。
 * 每一项一行文字
 */
export function usageDetailLines(report: UsageReport | undefined, observed: UsageObserved | undefined, now: Date): UsageLine[] {
  const lines: UsageLine[] = []
  if (report) {
    const parts: string[] = []
    const insufficient = report.available === false
    let owed = false
    for (const balance of report.balances ?? []) {
      let part = `余额 ${usageMoney(balance.amount, balance.currency)}`
      if (balance.granted && balance.granted > 0 && balance.granted < balance.amount) {
        part += `（其中赠送 ${usageMoney(balance.granted, balance.currency)}）`
      }
      parts.push(part)
      if (balance.owed && balance.owed > 0) {
        parts.push(`欠费 ${usageMoney(balance.owed, balance.currency)}`)
        owed = true
      }
    }
    if (typeof report.spent === 'number') {
      let part = `累计已用 ${usageMoney(report.spent, 'USD')}`
      if (report.spentThisMonth && report.spentThisMonth > 0 && report.spentThisMonth < report.spent) {
        part += `（本月 ${usageMoney(report.spentThisMonth, 'USD')}）`
      }
      parts.push(part)
    }
    if (report.freeTier) parts.push('免费档（没充过值）')
    if (insufficient) parts.push('不够调用了，充值后恢复')
    if (parts.length > 0) lines.push({ text: parts.join('，'), warning: insufficient || owed })
    // 套餐 / 额度窗口：全都写出来（这里没有进度条，不像桌面端的设置页会把条上的两个留给条）
    const windows: string[] = []
    let empty = false
    for (const window of report.windows ?? []) {
      const text = windowText(window, now, true)
      if (!text) continue
      windows.push(text)
      empty = empty || exhausted(window)
    }
    if (windows.length > 0) {
      const prefix = report.plan ? `${report.plan} · ` : ''
      lines.push({ text: prefix + windows.join('，'), warning: empty })
    } else if (report.plan) {
      lines.push({ text: `套餐 ${report.plan}`, warning: false })
    }
    for (const warning of report.warnings ?? []) lines.push({ text: warning, warning: true })
  }
  const quotaAt = usageDate(observed?.quotaAt)
  const okAt = usageDate(observed?.okAt)
  if (quotaAt && !(okAt && okAt.getTime() > quotaAt.getTime()) && !quotaCleared(observed, report, now)) {
    if (observed?.quotaKind === 'balance') {
      lines.push({ text: `余额不足（${usageWhen(quotaAt, now)} 的请求），充值后恢复`, warning: true })
    } else {
      const resumeAt = usageDate(observed?.resumeAt)
      if (resumeAt && resumeAt.getTime() > now.getTime()) {
        lines.push({ text: `额度用完了，${usageWhen(resumeAt, now)} 恢复`, warning: true })
      } else if (now.getTime() - quotaAt.getTime() < 7 * 86_400_000) {
        lines.push({ text: `额度用完了（${usageWhen(quotaAt, now)} 的请求），服务没说什么时候恢复`, warning: true })
      }
    }
  }
  const limitsAt = usageDate(observed?.limitsAt)
  if ((observed?.limits ?? []).length > 0 && limitsAt) {
    const parts: string[] = []
    for (const window of observed!.limits!) {
      const text = windowText(window, now, false)
      if (text) parts.push(text)
    }
    if (parts.length > 0) {
      lines.push({ text: `限流余量（${usageWhen(limitsAt, now)} 的请求）：${parts.join('，')}`, warning: false })
    }
  }
  return lines
}

/** 一条模型条目要显示什么：那一句 + 悬停明细（没有可显示的就都是空） */
export function usageForEntry(
  entry: UsageEntry | undefined,
  now: Date
): { line?: UsageLine; detail: UsageLine[] } {
  if (!entry) return { detail: [] }
  if (entry.loading && !entry.checked) return { line: { text: '正在查余额…', warning: false }, detail: [] }
  const line = usageMenuLine(entry.report, entry.observed, now)
  const detail = usageDetailLines(entry.report, entry.observed, now)
  if (!line && entry.error && !entry.supported) {
    return { line: { text: `查不到余额和用量：${entry.error}`, warning: false }, detail }
  }
  return { line, detail }
}