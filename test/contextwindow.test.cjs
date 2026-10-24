// 模型上下文窗口估算（lib/contextWindow.ts）：按模型名认窗口、token 数格式化、占比取整。

const test = require('node:test')
const assert = require('node:assert/strict')

const { contextWindowTokens, contextWindowNote, formatTokenCount, contextPercent, estimateTokens, contextMixOf } = require('../.tmp/contextwindow.cjs')

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

test('token 估算：中文 1:1、其它 4 字符/token、空文本 0', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(undefined), 0)
  assert.equal(estimateTokens('修复登录页'), 5)
  assert.equal(estimateTokens('abcdefgh'), 2) // 8/4
  assert.equal(estimateTokens('修复 abcdefgh'), 5) // 中文 2 + 空格和英文 9 字符 / 4 = 3
})

// 块的线上形状：{id, kind: {case: payload}}，带关联值的包在 _0 里
function block(id, kind, payload) {
  return { id, kind: { [kind]: payload } }
}

function message(id, blocks) {
  return { id, role: 'assistant', blocks, createdAt: '2026-01-01T00:00:00Z' }
}

test('上下文构成：按工具名聚合 + 文本/思考各自成段，按大小降序', () => {
  const messages = [
    { message: message('m1', [
      block('b1', 'text', 'abcdefgh'), // 2
      block('b2', 'thinking', 'abcd') // 1
    ]), version: 0 },
    { message: message('m2', [
      block('b3', 'tool', { name: 'read_file', arguments: '{"path":"a.md"}', result: 'abcdefgh'.repeat(4) }), // 4 + 8
      block('b4', 'tool', { name: 'read_file', arguments: 'x', result: 'abcdefgh' }) // 1 + 2
    ]), version: 0 }
  ]
  const mix = contextMixOf(messages)
  assert.deepEqual(
    mix.map((s) => [s.key, s.tokens]),
    [
      ['tool:read_file', 15],
      ['text', 2],
      ['thinking', 1]
    ]
  )
})

test('上下文构成：子 Agent 运行记录并入它的工具名下', () => {
  const messages = [
    { message: message('md', [
      block('b1', 'tool', {
        name: 'delegate_task',
        arguments: 'abcdefgh', // 2
        result: 'abcdefgh', // 2
        transcript: [block('t1', 'text', 'abcdefgh'), block('t2', 'tool', { name: 'web_search', arguments: 'x', result: 'abcd' })] // 2 + 1+1
      })
    ]), version: 0 }
  ]
  const mix = contextMixOf(messages)
  assert.deepEqual(
    mix.map((s) => [s.key, s.tokens]),
    [['tool:delegate_task', 2 + 2 + 2 + 1 + 1]]
  )
})

test('上下文构成：同一条消息版本变了重算（缓存不返回旧值）', () => {
  const base = message('mc', [block('bc', 'text', 'abcdefgh')])
  const first = contextMixOf([{ message: base, version: 1 }])
  assert.equal(first[0].tokens, 2)
  base.blocks = [block('bc', 'text', 'abcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh')] // 12
  const second = contextMixOf([{ message: base, version: 2 }])
  assert.equal(second[0].tokens, 12)
})
