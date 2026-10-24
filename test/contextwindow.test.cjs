// 模型上下文窗口估算（lib/contextWindow.ts）：按模型名认窗口、token 数格式化、占比取整。

const test = require('node:test')
const assert = require('node:assert/strict')

const { contextWindowTokens, contextWindowNote, formatTokenCount, contextPercent } = require('../.tmp/contextwindow.cjs')

test('按模型名认窗口：具体的规则先命中', () => {
  assert.equal(contextWindowTokens('glm-4.7'), 200000)
  assert.equal(contextWindowTokens('GLM-5'), 200000) // 大小写不敏感
  assert.equal(contextWindowTokens('glm-4.5'), 128000)
  assert.equal(contextWindowTokens('zhipu/glm-4.6'), 200000) // 带 / 前缀也认
  assert.equal(contextWindowTokens('deepseek-chat'), 128000)
  assert.equal(contextWindowTokens('kimi-k2-instruct'), 256000)
  assert.equal(contextWindowTokens('qwen3-max'), 256000) // qwen3-max 先于 qwen3
  assert.equal(contextWindowTokens('qwen3-coder-plus'), 262144)
  assert.equal(contextWindowTokens('qwen-plus-latest'), 131072)
  assert.equal(contextWindowTokens('qwen-max'), 32768)
  assert.equal(contextWindowTokens('claude-sonnet-4-5'), 200000)
  assert.equal(contextWindowTokens('gpt-5.2'), 400000)
  assert.equal(contextWindowTokens('gpt-4.1-mini'), 1000000)
  assert.equal(contextWindowTokens('gpt-4o'), 128000)
  assert.equal(contextWindowTokens('o3-mini'), 200000)
  assert.equal(contextWindowTokens('gemini-2.5-pro'), 1000000)
  assert.equal(contextWindowTokens('minimax-m2'), 204800)
  assert.equal(contextWindowTokens('grok-4'), 256000)
})

test('认不出的 / 空名字：undefined（界面只显示长度不给占比）', () => {
  assert.equal(contextWindowTokens('totally-unknown-model'), undefined)
  assert.equal(contextWindowTokens(''), undefined)
  assert.equal(contextWindowTokens(undefined), undefined)
})

test('窗口注释（悬停提示用）：命中同一条规则', () => {
  assert.deepEqual(contextWindowNote('glm-4.7'), { note: 'GLM 4.6+', tokens: 200000 })
  assert.equal(contextWindowNote('unknown-model'), undefined)
})

test('token 数格式化：k/M 一位小数、尾零去掉', () => {
  assert.equal(formatTokenCount(842), '842')
  assert.equal(formatTokenCount(84200), '84.2k')
  assert.equal(formatTokenCount(128000), '128k')
  assert.equal(formatTokenCount(1048576), '1M')
})

test('占比取整；超窗口照实显示', () => {
  assert.equal(contextPercent(50000, 200000), 25)
  assert.equal(contextPercent(84000, 200000), 42)
  assert.equal(contextPercent(199999, 200000), 100)
  assert.equal(contextPercent(240000, 200000), 120)
})
