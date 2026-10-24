// 子 Agent 树（TeamState.runs → 每个会话一棵）：会话列表行下 / 沉浸模式背景列表的树状显示用。

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  agentTreesByConversation,
  liveAgentRows,
  agentActivityLabel
} = require('../.tmp/agenttree.cjs')

let seq = 0

/** 造一个 TeamRun；started 递增（后造的派出更晚） */
function run(over) {
  seq += 1
  return {
    id: `r${seq}`,
    name: `Agent${seq}`,
    parentKey: '',
    conversationID: 'conv-a',
    background: false,
    depth: 0,
    running: true,
    detached: false,
    stopRequested: false,
    steps: 1,
    started: `2026-01-01T00:${String(seq).padStart(2, '0')}:00Z`,
    speed: 0,
    passTokens: 0,
    queue: [],
    ...over
  }
}

test('按会话分组；没子 Agent 的会话不出现在 Map 里', () => {
  const map = agentTreesByConversation([run({ conversationID: 'conv-a' })])
  assert.deepEqual([...map.keys()], ['conv-a'])
  assert.equal(map.size, 1)
})

test('parentKey 指到另一个 run.id 的挂它下面：深度优先、父在子前、depth 递增', () => {
  const rows = agentTreesByConversation([
    run({ id: 'lead', name: '组长' }),
    run({ id: 'w1', name: '写手', parentKey: 'lead' }),
    run({ id: 'w1sub', name: '写手的助手', parentKey: 'w1' }),
    run({ id: 'w2', name: '审稿', parentKey: 'lead' })
  ]).get('conv-a')
  assert.deepEqual(
    rows.map((row) => [row.run.id, row.depth]),
    [
      ['lead', 0],
      ['w1', 1],
      ['w1sub', 2],
      ['w2', 1]
    ]
  )
})

test('parentKey 指不到 run.id（会话主 Agent 直接派的）：落回会话下当第一层', () => {
  const rows = agentTreesByConversation([
    run({ id: 'a', parentKey: 'conv-root-or-main' }),
    run({ id: 'b', parentKey: '' }),
    run({ id: 'c', parentKey: 'a' })
  ]).get('conv-a')
  // a、b 都是第一层；c 挂 a 下
  assert.deepEqual(
    rows.map((row) => [row.run.id, row.depth]),
    [
      ['a', 0],
      ['c', 1],
      ['b', 0]
    ]
  )
})

test('同层排序：跑着的在前，其余按派出时间先后', () => {
  const rows = agentTreesByConversation([
    run({ id: 'early-done', running: false, started: '2026-01-01T00:01:00Z' }),
    run({ id: 'later-done', running: false, started: '2026-01-01T00:05:00Z' }),
    run({ id: 'live', running: true, started: '2026-01-01T00:03:00Z' })
  ]).get('conv-a')
  assert.deepEqual(rows.map((row) => row.run.id), ['live', 'early-done', 'later-done'])
})

test('liveAgentRows：只留在跑的分支，祖先链保留、层级不变，跑完的整条不显示', () => {
  const rows = agentTreesByConversation([
    run({ id: 'lead' }),
    run({ id: 'done-writer', parentKey: 'lead', running: false }),
    run({ id: 'live-reviewer', parentKey: 'lead', running: true }),
    run({ id: 'reviewer-helper', parentKey: 'live-reviewer', running: true }),
    run({ id: 'done-helper', parentKey: 'reviewer-helper', running: false })
  ]).get('conv-a')
  const live = liveAgentRows(rows)
  assert.deepEqual(
    live.map((row) => [row.run.id, row.depth]),
    [
      ['lead', 0],
      ['live-reviewer', 1],
      ['reviewer-helper', 2]
    ]
  )
})

test('liveAgentRows：全跑完时为空', () => {
  const rows = agentTreesByConversation([
    run({ id: 'a', running: false }),
    run({ id: 'b', parentKey: 'a', running: false })
  ]).get('conv-a')
  assert.deepEqual(liveAgentRows(rows), [])
})

test('agentActivityLabel：跑着的按 activity 出短语，跑完的统一「已结束」', () => {
  assert.equal(agentActivityLabel(run({ running: false, activity: { kind: 'tool', title: '还在的尾巴' } })), '已结束')
  assert.equal(agentActivityLabel(run({ activity: undefined })), '在想')
  assert.equal(agentActivityLabel(run({ activity: { kind: 'generating', title: '' } })), '在生成')
  assert.equal(agentActivityLabel(run({ activity: { kind: 'tool', title: '搜网页' } })), '在执行「搜网页」')
  assert.equal(agentActivityLabel(run({ activity: { kind: 'waitingChildren', title: '' } })), '在等子 Agent')
  assert.equal(agentActivityLabel(run({ activity: { kind: 'waitingApproval', title: 'rm -rf' } })), '在等确认：rm -rf')
  assert.equal(agentActivityLabel(run({ activity: { kind: 'other', title: '排队' } })), '排队')
})
