// 内置命令 /model、/mode、/thinking（lib/builtinCommands.ts；照 Friday v2.71 COMMANDS.md §8、Qt BuiltinCommands）。
// 锁住：这台一个命令文件都没有时菜单照样有三项（之前打「/」什么都不弹）；内置的排序、同名命令文件不列；
// 「/model 」后列能选的、打勾；发出去的「/命令 名字」认得出是哪个。
const test = require('node:test')
const assert = require('node:assert')

const {
  builtinCommandItems,
  parseBuiltin,
  mergeBuiltinCommands,
  builtinChoices,
  resolveBuiltin,
  resolveModel,
  resolveTeamMode,
  resolveThinking,
  thinkingTitle,
  isChatModel,
  PERMISSION_MODES,
  permissionTitle
} = require('../.tmp/builtincommands.cjs')

const engines = [
  { id: 'e1', title: 'DeepSeek', model: 'deepseek-chat' },
  { id: 'e2', title: 'DeepSeek', model: 'deepseek-reasoner' },
  { id: 'e3', title: 'Kimi', model: 'kimi-k2' }
]
const context = {
  engines: [...engines, { id: 'e4', title: '智谱 GLM', model: 'cogview-3-flash' }],
  engineID: 'e3',
  teamMode: 'solo',
  thinkingLevel: 'medium',
  thinkingLevels: ['off', 'low', 'medium', 'high']
}

test('isChatModel：画图、语音、向量模型不算（同 Qt ModelTraits）', () => {
  for (const name of ['cogview-3-flash', 'qwen-audio-3.0-tts-plus', 'qwen-audio-3.0-realtime-plus', 'wan2.5-t2v', 'text-embedding-3', 'openai/dall-e-3'])
    assert.equal(isChatModel(name), false, name)
  for (const name of ['glm-5.3-flash', 'deepseek-v4-pro', 'qwen3.7-max', 'sparse-chat', 'apodex/apodex-1.1-mini:free', ''])
    assert.equal(isChatModel(name), true, name)
})

test('没有命令文件：打「/」也列出三项内置的', () => {
  const items = mergeBuiltinCommands('', [])
  assert.deepEqual(items.map((item) => item.name), ['model', 'mode', 'thinking'])
  assert.ok(items.every((item) => item.sourceTitle === '内置' && item.argumentHint && item.description))
  assert.equal(builtinCommandItems().length, 3)
})

test('内置的开头对上的在命令前面、名字里有的在最后；同名命令文件不列', () => {
  const commands = [{ name: 'mode' }, { name: 'commit' }, { name: 'review-model' }]
  assert.deepEqual(mergeBuiltinCommands('mo', commands).map((item) => item.name), ['model', 'mode', 'commit', 'review-model'])
  assert.deepEqual(mergeBuiltinCommands('in', []).map((item) => item.name), ['thinking'])
  assert.deepEqual(mergeBuiltinCommands('x', [{ name: 'xray' }]).map((item) => item.name), ['xray'])
})

test('parseBuiltin：名字后面要空白或结束，换行的不算', () => {
  assert.deepEqual(parseBuiltin('/model'), { command: 'model', argument: '' })
  assert.deepEqual(parseBuiltin('/model  kimi '), { command: 'model', argument: 'kimi' })
  assert.deepEqual(parseBuiltin('/mode 极限'), { command: 'mode', argument: '极限' })
  assert.equal(parseBuiltin('/models'), null)
  assert.equal(parseBuiltin('/model a\nb'), null)
  assert.equal(parseBuiltin('model'), null)
})

test('「/model 」列能选的：现在用的打勾，开头对上的在前', () => {
  const all = builtinChoices('model', '', context)
  assert.deepEqual(all.map((choice) => choice.title), ['deepseek-chat', 'deepseek-reasoner', 'kimi-k2'])
  assert.deepEqual(all.map((choice) => choice.checked), [false, false, true])
  assert.deepEqual(all[0].action, { kind: 'setEngine', value: 'e1' })
  assert.deepEqual(builtinChoices('model', 'reason', context).map((choice) => choice.title), ['deepseek-reasoner'])
  assert.deepEqual(builtinChoices('model', 'k', context).map((choice) => choice.title), ['kimi-k2', 'deepseek-chat', 'deepseek-reasoner'])
})

test('「/mode 」「/thinking 」列能选的；工作流模式下思考也能调（2026-10-23 起服务端不再强制最高）', () => {
  const modes = builtinChoices('mode', '', context)
  assert.equal(modes.length, 3)
  assert.equal(modes.find((choice) => choice.checked).action.value, 'solo')
  assert.equal(builtinChoices('mode', '', { ...context, teamMode: 'delegatesOnly' }).find((c) => c.checked).action.value, 'delegatesHeavy')
  const levels = builtinChoices('thinking', '', context)
  assert.deepEqual(levels.map((choice) => choice.title), ['关闭', '低', '中', '高'])
  assert.equal(levels.find((choice) => choice.checked).action.value, 'medium')
  const ultra = builtinChoices('thinking', '', { ...context, teamMode: 'ultra' })
  assert.equal(ultra.length, 4, '工作流模式下思考档位照列')
  assert.equal(thinkingTitle('high', ['off', 'high']), '开启')
})

test('权限三档（== Qt PermissionMode：标题、说明逐字一致；认不出的原始值原样显示）', () => {
  assert.deepEqual(PERMISSION_MODES.map((mode) => [mode.raw, mode.title]), [
    ['auto', '自动'],
    ['plan', '计划'],
    ['full', '完全']
  ])
  assert.ok(PERMISSION_MODES.every((mode) => mode.detail))
  assert.equal(permissionTitle('full'), '完全')
  assert.equal(permissionTitle(undefined), '')
})

test('发出去的「/命令 名字」认哪个', () => {
  assert.equal(resolveModel('2', engines).id, 'e2')
  assert.equal(resolveModel('KIMI-K2', engines).id, 'e3')
  assert.equal(resolveModel('DeepSeek · deepseek-chat', engines).id, 'e1')
  assert.equal(resolveModel('deepseek', engines).id, 'e1', '名字一样的先认（同 Qt）')
  assert.equal(resolveModel('deepseek-', engines), null, '只是包含、对上两个的不认')
  assert.equal(resolveModel('reasoner', engines).id, 'e2')
  assert.equal(resolveTeamMode('极限'), 'ultra')
  assert.equal(resolveTeamMode('工作流'), 'ultra', '新名字也认（2026-10-23 起 ultra 叫工作流）')
  assert.equal(resolveTeamMode('workflow'), 'ultra')
  assert.equal(resolveTeamMode('需要时派'), 'delegatesHeavy')
  assert.equal(resolveTeamMode('1'), 'solo')
  assert.equal(resolveTeamMode('随便'), null)
  assert.equal(resolveThinking('高', context.thinkingLevels), 'high')
  assert.equal(resolveThinking('off', context.thinkingLevels), 'off')
  assert.equal(resolveThinking('开', context.thinkingLevels), 'low')
  assert.equal(resolveThinking('超', context.thinkingLevels), null, '这个模型没有的档位不认')
  assert.deepEqual(resolveBuiltin('mode', '极限', context), { kind: 'setTeamMode', value: 'ultra' })
  assert.deepEqual(resolveBuiltin('thinking', '高', { ...context, teamMode: 'ultra' }), { kind: 'setThinking', value: 'high' }, '工作流模式下也能换思考档位')
  assert.equal(resolveBuiltin('model', '', context), null)
})
