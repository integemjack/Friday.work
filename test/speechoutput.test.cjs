// 回复语音播报（speechOutput.ts）的纯函数部分：
// 音色映射（kokoro v1.1 的 103 个 sid）、朗读清理（markdown/代码块/链接不进语音）、文本块提取。
// 播放与 localStorage 偏好在渲染环境里，这里只锁「进模型的文本」和「sid 表」。
const test = require('node:test')
const assert = require('node:assert')

const {
  sidToVoiceCode,
  PRESET_VOICES,
  CUSTOM_VOICE_GROUPS,
  cleanForSpeech,
  textBlocksToSpeech,
  splitForSpeech
} = require('../.tmp/speechoutput.cjs')

test('sid → 音色代号：0-2 英文女、3-57 中文女、58-102 中文男（k2-fsa PR #1942）', () => {
  assert.equal(sidToVoiceCode(0), 'af_maple')
  assert.equal(sidToVoiceCode(1), 'af_sol')
  assert.equal(sidToVoiceCode(2), 'bf_vale')
  assert.equal(sidToVoiceCode(3), 'zf_001')
  assert.equal(sidToVoiceCode(57), 'zf_055')
  assert.equal(sidToVoiceCode(58), 'zm_001')
  assert.equal(sidToVoiceCode(102), 'zm_045')
  // 越界不炸：给个可读代号
  assert.equal(sidToVoiceCode(103), 'sid_103')
})

test('预置 10 种音色：sid 全部落在合法区间且互不重复', () => {
  assert.equal(PRESET_VOICES.length, 10)
  const sids = PRESET_VOICES.map((voice) => voice.sid)
  assert.equal(new Set(sids).size, 10, 'sid 不重复')
  for (const sid of sids) assert.ok(sid >= 0 && sid <= 102, `sid ${sid} 合法`)
  for (const voice of PRESET_VOICES) {
    assert.ok(voice.id === sidToVoiceCode(voice.sid), `${voice.name} 的 id 与 sid 对应`)
    assert.ok(voice.speed > 0.2 && voice.speed < 4, '语速在安全区间')
  }
})

test('自定义音色分组：55 女 + 45 男 + 3 英文女 = 103', () => {
  const total = CUSTOM_VOICE_GROUPS.reduce((sum, group) => sum + group.sids.length, 0)
  assert.equal(total, 103)
})

test('朗读清理：代码块 / 行内代码 / 链接 URL / 图片 / LaTeX / markdown 记号都拿掉', () => {
  const raw = [
    '# 改好了',
    '',
    '我把 `TtsService.ts` **新增**了，见 [文档](https://example.com/docs)。',
    '```ts',
    'const x = 1 // 这段不该被念出来',
    '```',
    '- 第一点：$E=mc^2$ 不念',
    '![截图](https://example.com/1.png)',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '裸链接 https://example.com/a 也不念',
    '> 引用行念出来',
    '~~删除线~~ 和 **加粗** 去记号留文字'
  ].join('\n')
  const clean = cleanForSpeech(raw)
  assert.ok(!clean.includes('const x'), '代码块去掉')
  assert.ok(!clean.includes('```'), '围栏记号去掉')
  assert.ok(!clean.includes('E=mc'), 'LaTeX 去掉')
  assert.ok(!clean.includes('example.com'), 'URL 去掉')
  assert.ok(!clean.includes('|'), '表格竖线去掉')
  assert.ok(!clean.includes('---'), '表格分隔行去掉')
  assert.ok(!clean.includes('[') && !clean.includes(']'), '链接语法去掉')
  assert.ok(!clean.includes('*') && !clean.includes('~'), '强调记号去掉')
  assert.ok(!clean.includes('#'), '标题井号去掉')
  assert.ok(!clean.includes('>'), '引用符号去掉（内容保留）')
  assert.ok(clean.includes('改好了'), '标题文字保留')
  assert.ok(clean.includes('TtsService.ts'), '行内代码内容保留')
  assert.ok(clean.includes('文档'), '链接文字保留')
  assert.ok(clean.includes('引用行念出来'), '引用内容保留')
  assert.ok(clean.includes('第一点：'), '列表标记去掉、内容保留')
  assert.ok(clean.includes('加粗'), '强调内容保留')
  assert.ok(!/\s{2,}/.test(clean), '空白压成单个空格')
})

test('朗读清理：emoji 与控制字符去掉，中英文标点保留', () => {
  const clean = cleanForSpeech('完成了 ✅，下一步\tdo it\u0007。🚀')
  assert.ok(!clean.includes('✅'), 'emoji 去掉')
  assert.ok(!clean.includes('🚀'), 'emoji 去掉')
  assert.ok(!clean.includes('\u0007'), '控制字符去掉')
  assert.ok(!clean.includes('\t'), '制表符压成空格')
  assert.equal(clean, '完成了，下一步 do it。')
})

test('文本块提取：只取 text 块，thinking / tool / media 不念', () => {
  const blocks = [
    { id: 'a', kind: { text: { _0: '第一段' } } },
    { id: 'b', kind: { thinking: { _0: '心里的独白不该念' } } },
    { id: 'c', kind: { tool: { id: 't', name: 'run_shell', arguments: '{}', status: 'succeeded', result: '' } } },
    { id: 'd', kind: { text: '第二段' } },
    { id: 'e', kind: { media: { id: 'm', kind: 'image', relativePath: 'a.png', fileName: 'a.png', mimeType: 'image/png', byteCount: 1 } } }
  ]
  assert.equal(textBlocksToSpeech(blocks), '第一段\n第二段')
  assert.equal(textBlocksToSpeech(undefined), '')
  assert.equal(textBlocksToSpeech(null), '')
})

test('分句：句末标点切句、超长句按逗号再切、空段丢弃（流水线首句要短）', () => {
  const parts = splitForSpeech('第一句话。第二句话更长一些，包含逗号，还有顿号、也切！第三段\n\n换行后的句子？')
  assert.deepEqual(parts, ['第一句话。', '第二句话更长一些，包含逗号，还有顿号、也切！', '第三段', '换行后的句子？'])

  const long = '这是一个特别长的句子'.padEnd(0) + '，' + '后面还跟着很多很多很多的内容'.repeat(6)
  const cut = splitForSpeech(long)
  assert.ok(cut.length > 1, '超长句被逗号再切')
  for (const part of cut) assert.ok(part.length <= 60, `片段不超 60 字（实际 ${part.length}）`)

  assert.deepEqual(splitForSpeech(''), [])
  assert.deepEqual(splitForSpeech('   \n  '), [])
})

test('文本块提取：text 是裸字符串（无 _0 包装）也能取', () => {
  // 线上形状：带关联值的包 _0；Swift 端 text 直接是字符串的情况也兼容
  const blocks = [
    { id: 'a', kind: { text: '直接字符串' } },
    { id: 'b', kind: { text: { _0: '包装字符串' } } }
  ]
  assert.equal(textBlocksToSpeech(blocks), '直接字符串\n包装字符串')
})
