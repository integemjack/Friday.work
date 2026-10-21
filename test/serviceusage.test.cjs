// 各家服务的余额 / 套餐用量（REMOTE.md §6「在线服务」）：模型选择器里那一句、悬停明细的文案规则。
// 与 Friday 桌面端 ServiceUsage::menuLine / usedFraction / activeQuota 对齐（关键短语逐字一致）。

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  canQueryUsage,
  isLocalBaseURL,
  quotaCleared,
  usageCount,
  usageDate,
  usageDetailLines,
  usageForEntry,
  usageKey,
  usageMenuLine,
  usageMoney,
  usedFraction
} = require('../.tmp/serviceusage.cjs')

const now = new Date('2026-10-21T12:00:00Z')

test('usageKey：接口地址去尾斜杠、小写 + | + 密钥名（和服务端 observedKey 一套写法）', () => {
  assert.equal(
    usageKey('https://API.DeepSeek.com/v1/', 'DEEPSEEK_API_KEY'),
    'https://api.deepseek.com/v1|DEEPSEEK_API_KEY'
  )
  assert.equal(usageKey('  https://api.moonshot.cn/v1  ', 'KIMI'), 'https://api.moonshot.cn/v1|KIMI')
  // 没有密钥名（不需要密钥的服务）：仍是一份可匹配的键
  assert.equal(usageKey('https://x.example.com', ''), 'https://x.example.com|')
})

test('本机地址不查余额（本地大模型 power://、局域网里的 Ollama）', () => {
  assert.equal(isLocalBaseURL('power://local'), true)
  assert.equal(isLocalBaseURL('http://localhost:11434/v1'), true)
  assert.equal(isLocalBaseURL('http://127.0.0.1:1234/v1'), true)
  assert.equal(isLocalBaseURL('http://192.168.1.5:11434/v1'), true)
  assert.equal(isLocalBaseURL('http://10.0.0.9:8000/v1'), true)
  assert.equal(isLocalBaseURL('https://api.deepseek.com/v1'), false)
  assert.equal(canQueryUsage('https://api.deepseek.com/v1'), true)
  assert.equal(canQueryUsage('power://local'), false)
})

test('money / count：和桌面端一样的写法', () => {
  assert.equal(usageMoney(12.3, 'CNY'), '¥12.30')
  assert.equal(usageMoney(0.5, 'USD'), '$0.50')
  assert.equal(usageMoney(-3, 'CNY'), '-¥3.00')
  assert.equal(usageCount(1234), '1234')
  assert.equal(usageCount(1900000), '190 万')
  assert.equal(usageCount(250000000), '2.5 亿')
})

test('usageDate：ISO（UTC）与 Unix 时间戳（秒 / 毫秒）都认', () => {
  assert.equal(usageDate('2026-10-21T12:00:00Z').toISOString(), '2026-10-21T12:00:00.000Z')
  assert.equal(usageDate(1792584000).toISOString(), '2026-10-21T12:00:00.000Z')
  assert.equal(usageDate(1792584000000).toISOString(), '2026-10-21T12:00:00.000Z')
  assert.equal(usageDate(undefined), undefined)
  assert.equal(usageDate(''), undefined)
})

test('usedFraction：比例、限额、重置时间过了算 0', () => {
  assert.ok(Math.abs(usedFraction({ title: '5 小时', remainingPercent: 91 }, now) - 0.09) < 1e-9)
  assert.equal(usedFraction({ title: '每周', limit: 100, remaining: 20 }, now), 0.8)
  assert.equal(usedFraction({ title: '密钥额度', limit: 100, used: 25 }, now), 0.25)
  assert.equal(usedFraction({ title: '没有数的', unit: '次' }, now), undefined)
  // 重置时间已经过了：这一档从头算
  assert.equal(usedFraction({ title: '5 小时', remainingPercent: 0, resetAt: '2026-10-21T11:00:00Z' }, now), 0)
  assert.equal(usedFraction({ title: '5 小时', remainingPercent: 0, resetAt: '2026-10-21T18:00:00Z' }, now), 1)
})

test('menuLine：只有余额时显示余额（欠费、不够调用了转橙）', () => {
  assert.deepEqual(usageMenuLine({ balances: [{ amount: 12.34, currency: 'CNY' }] }, undefined, now), {
    text: '余额 ¥12.34',
    warning: false
  })
  assert.deepEqual(
    usageMenuLine({ balances: [{ amount: 0, currency: 'CNY', owed: 3 }] }, undefined, now),
    { text: '余额 ¥0.00，欠费 ¥3.00', warning: true }
  )
  assert.deepEqual(
    usageMenuLine({ balances: [{ amount: 1, currency: 'CNY' }], available: false }, undefined, now),
    { text: '余额 ¥1.00，不够调用了', warning: true }
  )
  // 没有余额、只有累计已用（OpenRouter）
  assert.deepEqual(usageMenuLine({ spent: 4.2, spentThisMonth: 1.1 }, undefined, now), {
    text: '累计已用 $4.20',
    warning: false
  })
  // 什么都没有：不显示
  assert.equal(usageMenuLine(undefined, undefined, now), undefined)
})

test('menuLine：套餐窗口说「剩多少 %」（用得最多的两个，按原顺序）', () => {
  const report = {
    windows: [
      { title: '5 小时', remainingPercent: 91, resetAt: '2026-10-21T18:00:00Z' },
      { title: '每周', remainingPercent: 78, resetAt: '2026-10-26T00:00:00Z' },
      { title: '每月', remainingPercent: 60 }
    ]
  }
  // 5 小时只用了 9%，比每周（22%）、每月（40%）都少：不进那一句
  assert.deepEqual(usageMenuLine(report, undefined, now), { text: '每周剩 78% · 每月剩 60%', warning: false })
})

test('menuLine：窗口用完了说「用完了」并带重置时间', () => {
  const report = { windows: [{ title: '5 小时', remainingPercent: 0, resetAt: '2026-10-21T18:00:00Z' }] }
  const line = usageMenuLine(report, undefined, now)
  assert.equal(line.warning, true)
  assert.match(line.text, /^5 小时用完了，.+ 重置$/)
})

test('menuLine：额度用完 / 余额不足（服务端顺手记下的，等恢复）', () => {
  const quotaAt = '2026-10-21T11:00:00Z'
  // 周期额度用完、服务说了恢复时间
  const usage = usageMenuLine(undefined, { quotaAt, quotaKind: 'usage', resumeAt: '2026-10-21T13:00:00Z' }, now)
  assert.equal(usage.warning, true)
  assert.match(usage.text, /^额度用完，\d{2}:\d{2} 恢复$/)
  // 余额不足：充值才好
  assert.deepEqual(usageMenuLine(undefined, { quotaAt, quotaKind: 'balance' }, now), {
    text: '余额不足，充值后恢复',
    warning: true
  })
  // 用完过、之后成功过来了：不再说额度用完，退回余额那句
  assert.deepEqual(
    usageMenuLine({ balances: [{ amount: 5, currency: 'CNY' }] }, { quotaAt, okAt: '2026-10-21T11:30:00Z' }, now),
    { text: '余额 ¥5.00', warning: false }
  )
  // 服务没说恢复时间、也还没成功过：就说用完了
  assert.deepEqual(usageMenuLine(undefined, { quotaAt, quotaKind: 'usage' }, now), {
    text: '额度用完了',
    warning: true
  })
  // 七天前的、又没说恢复时间：不再提示（老黄历）
  assert.equal(usageMenuLine(undefined, { quotaAt: '2026-10-01T11:00:00Z', quotaKind: 'usage' }, now), undefined)
})

test('quotaCleared：之后查到的报告说已经恢复了', () => {
  const observed = { quotaAt: '2026-10-21T10:00:00Z', quotaKind: 'usage' }
  const fresh = { windows: [{ title: '5 小时', remainingPercent: 50 }], fetchedAt: '2026-10-21T11:00:00Z' }
  assert.equal(quotaCleared(observed, fresh, now), true)
  // 查到的报告比额度用完还早（同一时刻的旧报告）：不算恢复
  const stale = { windows: [{ title: '5 小时', remainingPercent: 50 }], fetchedAt: '2026-10-21T10:00:30Z' }
  assert.equal(quotaCleared(observed, stale, now), false)
  // 查到的窗口还是满的：没恢复
  const full = { windows: [{ title: '5 小时', remainingPercent: 0 }], fetchedAt: '2026-10-21T11:00:00Z' }
  assert.equal(quotaCleared(observed, full, now), false)
})

test('detailLines：悬停看的明细（余额、套餐窗口、限流余量）', () => {
  const report = {
    balances: [{ amount: 12.3, currency: 'CNY', granted: 2 }],
    windows: [{ title: '每周', remainingPercent: 78, resetAt: '2026-10-26T00:00:00Z' }],
    fetchedAt: '2026-10-21T11:59:00Z'
  }
  const observed = { limits: [{ title: '请求', limit: 1000, remaining: 200 }], limitsAt: '2026-10-21T11:00:00Z' }
  const lines = usageDetailLines(report, observed, now).map((item) => item.text)
  assert.equal(lines[0], '余额 ¥12.30（其中赠送 ¥2.00）')
  // 套餐 / 额度窗口全列出来（这里没有进度条）
  assert.match(lines[1], /^每周剩 78%（.+ 重置）$/)
  assert.match(lines[2], /^限流余量（.+ 的请求）：请求剩 200 \/ 1000$/)
})

test('usageForEntry：查的过程中写「正在查余额…」，查不到的写原因', () => {
  const loading = usageForEntry(
    {
      key: 'k',
      baseURL: 'https://api.deepseek.com/v1',
      secretName: 'DEEPSEEK_API_KEY',
      custom: false,
      loading: true,
      checked: false,
      supported: false,
      error: '',
      checkedAt: 0
    },
    now
  )
  assert.equal(loading.line.text, '正在查余额…')
  const failed = usageForEntry(
    {
      key: 'k',
      baseURL: 'https://relay.example.com/v1',
      secretName: 'RELAY',
      custom: true,
      loading: false,
      checked: true,
      supported: false,
      error: '连不上',
      checkedAt: Date.now()
    },
    now
  )
  assert.equal(failed.line.text, '查不到余额和用量：连不上')
})