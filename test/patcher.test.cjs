// messagePatch 补丁应用 + 指纹归一化的单元测试（方案 M1 验收：补丁嵌套 transcript、错误指纹必断）。
// 跑法：先 esbuild 打包 src 为 cjs，再 node --test test/。

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { applyBlocks, applyMessagePatch } = require('../.tmp/patcher.cjs')
const { normalizeFingerprint } = require('../.tmp/wsfp.cjs')

function block(id, kind) {
  return { id, kind }
}

test('applyBlocks：set 替换整块', () => {
  const blocks = [block('a', { text: 'hello' }), block('b', { text: 'world' })]
  const ok = applyBlocks(blocks, { set: [{ id: 'b', kind: { text: '替换' } }] })
  assert.equal(ok, true)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].kind.text, '替换')
})

test('applyBlocks：ids 重排 + 新增', () => {
  const blocks = [block('a', { text: 'a' }), block('b', { text: 'b' })]
  const ok = applyBlocks(blocks, { ids: ['b', 'a', 'c'], set: [{ id: 'c', kind: { text: '新增' } }] })
  assert.equal(ok, true)
  assert.deepEqual(blocks.map((b) => b.id), ['b', 'a', 'c'])
})

test('applyBlocks：引用了不存在的块返回 false（要拉整条）', () => {
  const blocks = [block('a', { text: 'a' })]
  const ok = applyBlocks(blocks, { set: [], ids: ['a', 'nonexistent'] })
  assert.equal(ok, false)
})

test('applyBlocks：tools 只改工具字段，保留 transcript', () => {
  const blocks = [
    {
      id: 't',
      kind: {
        tool: {
          id: 't',
          name: 'edit_file',
          arguments: '{"path":"a"}',
          status: 'running',
          result: '',
          transcript: [{ id: 's1', kind: { text: 'step1' } }]
        }
      }
    }
  ]
  const ok = applyBlocks(blocks, {
    tools: [{ id: 't', tool: { id: 't', name: 'edit_file', arguments: '{"path":"b"}', status: 'succeeded', result: 'done' } }]
  })
  assert.equal(ok, true)
  const tool = blocks[0].kind.tool
  assert.equal(tool.status, 'succeeded')
  assert.equal(tool.result, 'done')
  // transcript 保留下来了
  assert.equal(tool.transcript.length, 1)
  assert.equal(tool.transcript[0].kind.text, 'step1')
})

test('applyBlocks：线上 _0 包装的工具块（Swift 枚举）', () => {
  // 真实服务端形状：{kind:{tool:{_0:{…}}}}，补丁的 tool 也可能包 _0
  const blocks = [
    { id: 't', kind: { tool: { _0: { id: 't', name: 'run_shell', arguments: '{}', status: 'running', result: '' } } } }
  ]
  const ok = applyBlocks(blocks, {
    tools: [{ id: 't', tool: { _0: { id: 't', name: 'run_shell', arguments: '{}', status: 'succeeded', result: 'ok' } } }]
  })
  assert.equal(ok, true)
  // 写回时保持 _0 包装，字段合并正确
  const wrapped = blocks[0].kind.tool._0
  assert.equal(wrapped.status, 'succeeded')
  assert.equal(wrapped.result, 'ok')
})

test('blockPayload：解包 Swift 枚举的 _0', () => {
  const { blockPayload } = require('../.tmp/protocol.cjs')
  assert.equal(blockPayload({ id: 'x', kind: { text: { _0: '你好' } } }, 'text'), '你好')
  assert.equal(blockPayload({ id: 'x', kind: { thinking: '思考中' } }, 'thinking'), '思考中')
  assert.equal(blockPayload({ id: 'x', kind: { media: { _0: { fileName: 'a.png' } } } }, 'media').fileName, 'a.png')
})

test('applyBlocks：tools 里 transcrtipt 递归打补丁', () => {
  const blocks = [
    {
      id: 't',
      kind: {
        tool: {
          id: 't',
          name: 'delegate_task',
          arguments: '{}',
          status: 'running',
          result: '',
          transcript: [{ id: 's1', kind: { tool: { id: 's1', name: 'read_file', arguments: '{}', status: 'running', result: '' } } }]
        }
      }
    }
  ]
  // s1 之前没有运行记录；补丁给它加一段（ids 只列新块，和不存在旧块引用不同）
  const ok = applyBlocks(blocks, {
    tools: [
      {
        id: 't',
        transcript: {
          ids: ['s1'],
          set: [],
          tools: [
            {
              id: 's1',
              transcript: {
                ids: ['s1b'],
                set: [{ id: 's1b', kind: { text: '子 Agent 的步骤' } }]
              }
            }
          ]
        }
      }
    ]
  })
  assert.equal(ok, true)
  const inner = blocks[0].kind.tool.transcript[0].kind.tool.transcript
  assert.equal(inner.length, 1)
  assert.equal(inner[0].kind.text, '子 Agent 的步骤')
})

test('applyMessagePatch：fields + blocks 组合', () => {
  const message = {
    id: 'm1',
    role: 'assistant',
    blocks: [{ id: 'a', kind: { text: 'hi' } }],
    createdAt: '2026-01-01T00:00:00Z'
  }
  const ok = applyMessagePatch(message, {
    conversationID: 'c1',
    messageID: 'm1',
    base: 1,
    version: 2,
    fields: { id: 'm1', role: 'assistant', createdAt: '2026-01-01T00:00:00Z', stats: { tokenCount: 5 } },
    blocks: { ids: ['a', 'b'], set: [{ id: 'b', kind: { text: '追加' } }] }
  })
  assert.equal(ok, true)
  assert.equal(message.stats.tokenCount, 5)
  assert.equal(message.blocks.length, 2)
  assert.equal(message.blocks[1].kind.text, '追加')
})

test('applyMessagePatch：id 变了返回 false', () => {
  const message = { id: 'm1', role: 'user', blocks: [], createdAt: 'x' }
  const ok = applyMessagePatch(message, {
    conversationID: 'c1',
    messageID: 'm2',
    base: 0,
    version: 1,
    fields: { id: '其他id', blocks: [] }
  })
  assert.equal(ok, false)
})

test('指纹归一化：去冒号、小写、长度 64', () => {
  // 只有长度 = 64（SHA-256）才认；短的值、非法的返回 null
  assert.equal(normalizeFingerprint(undefined), null)
  assert.equal(normalizeFingerprint(''), null)
  assert.equal(normalizeFingerprint('AA:BB:CC:DD'), null) // 只有 4 字节
  assert.equal(normalizeFingerprint('zz'.repeat(32)), null) // 非十六进制
  // 64 位十六进制：带冒号/大写 → 去冒号小写
  const withColons = 'AB:CD:EF:01:23:45:67:89:'.repeat(4).replace(/:$/, '')
  assert.equal(normalizeFingerprint(withColons), 'abcdef0123456789'.repeat(4))
})