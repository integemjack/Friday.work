// 消息树当前路径与分支切换（方案 §5.3）——与 Qt ConversationStore 同一套规则。

const test = require('node:test')
const assert = require('node:assert/strict')

const { conversationPath } = require('../.tmp/path.cjs')

function message(id, parentID, createdAt, text = id) {
  return {
    id,
    parentID,
    createdAt,
    role: 'user',
    blocks: [{ id: `${id}-b`, kind: { text: { _0: text } } }]
  }
}

test('单链：从头走到尾', () => {
  const nodes = [message('a', undefined, '2026-01-01T00:00:00Z'), message('b', 'a', '2026-01-01T00:00:01Z')]
  const { path, branches } = conversationPath(nodes, {})
  assert.deepEqual(path.map((node) => node.id), ['a', 'b'])
  assert.deepEqual(branches, {})
})

test('分叉：按 selectedChildren 选中的那条走，并给出兄弟信息', () => {
  const nodes = [
    message('a', undefined, '2026-01-01T00:00:00Z'),
    message('b1', 'a', '2026-01-01T00:00:01Z'),
    message('b2', 'a', '2026-01-01T00:00:02Z'),
    message('b3', 'a', '2026-01-01T00:00:03Z'),
    message('c', 'b2', '2026-01-01T00:00:04Z')
  ]
  // 没选：走最早的那条（b1），且 b1 没有孩子 → 路径到 b1 结束
  const first = conversationPath(nodes, {})
  assert.deepEqual(first.path.map((node) => node.id), ['a', 'b1'])
  assert.equal(first.branches.b1.count, 3)
  assert.equal(first.branches.b1.index, 0)

  // 选中 b2：走 a → b2 → c
  const second = conversationPath(nodes, { a: 'b2' })
  assert.deepEqual(second.path.map((node) => node.id), ['a', 'b2', 'c'])
  assert.equal(second.branches.b2.index, 1)
  assert.deepEqual(second.branches.b2.siblings, ['b1', 'b2', 'b3'])
  assert.equal(second.branches.b2.parentKey, 'a')
})

test('分叉切换：index 与 count 能算出前后跳的目标', () => {
  const nodes = [message('a', undefined, 't0'), message('b1', 'a', 't1'), message('b2', 'a', 't2')]
  const { branches } = conversationPath(nodes, { a: 'b1' })
  const info = branches.b1
  const next = (info.index + 1 + info.count) % info.count
  assert.equal(info.siblings[next], 'b2')
})

test('父节点不在（partial 只给了一截）：当成根节点', () => {
  const nodes = [message('x', 'missing-parent', 't1'), message('y', 'x', 't2')]
  const { path } = conversationPath(nodes, {})
  assert.deepEqual(path.map((node) => node.id), ['x', 'y'])
})

test('同一层按创建时间排（服务端顺序乱也给对）', () => {
  const nodes = [message('b', 'a', '2026-01-01T00:00:02Z'), message('a', undefined, 't0'), message('c', 'a', '2026-01-01T00:00:01Z')]
  const { path } = conversationPath(nodes, {})
  assert.deepEqual(path.map((node) => node.id), ['a', 'c'])
})
