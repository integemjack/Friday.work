// 回复语音播报（speechOutput.ts）的纯函数部分：
// 预置音色表（friday-voice 引擎五个）、朗读清理（markdown/代码块/链接不进语音）、分句、文本块提取。
// 播放与 localStorage 偏好在渲染环境里，这里只锁「进模型的文本」和音色表。
const test = require('node:test')
const assert = require('node:assert')

const { PRESET_VOICES, cleanForSpeech, dynamicSpeedFor, speechSpeedFor, textBlocksToSpeech, splitForSpeech } = require('../.tmp/speechoutput.cjs')

test('语速倍率：音色自带 × 全局倍率，夹进安全区间', () => {
  assert.equal(speechSpeedFor(1.0, 1.0), 1.0, '默认原速')
  assert.equal(speechSpeedFor(1.0, 1.5), 1.5, '全局 1.5× 生效')
  assert.equal(speechSpeedFor(1.2, 0.5), 0.6, '乘在音色自带倍率上')
  assert.equal(speechSpeedFor(0, 1.5), 1.5, '音色倍率缺失按 1 兜底')
  assert.equal(speechSpeedFor(1.0, 0), 1, '全局倍率缺失按 1 兜底')
  assert.equal(speechSpeedFor(1.0, 99), 3, '上限 3')
  assert.equal(speechSpeedFor(1.0, 0.01), 0.25, '下限 0.25')
})

test('动态语速：按字数在最慢~最快间插值（短=慢、长=快）', () => {
  assert.equal(dynamicSpeedFor(10, 0.9, 1.6), 0.9, '短句（≤40 字）用最慢')
  assert.equal(dynamicSpeedFor(40, 0.9, 1.6), 0.9, '40 字边界还是最慢')
  assert.equal(dynamicSpeedFor(520, 0.9, 1.6), 1.6, '520 字边界到最快')
  assert.equal(dynamicSpeedFor(5000, 0.9, 1.6), 1.6, '更长也封顶最快')
  const mid = dynamicSpeedFor(280, 0.9, 1.6)
  assert.ok(Math.abs(mid - 1.25) < 1e-9, '中间点线性（280 字 → 1.25）')
  assert.equal(dynamicSpeedFor(10, 1.5, 1.0), 1.0, 'min>max 传反了也自洽（短句取较小值当最慢）')
  assert.equal(dynamicSpeedFor(5000, 1.5, 1.0), 1.5, '传反时长句取较大值当最快')
})

test('预置音色：引擎五个，id/音色名一一对应', () => {
  assert.equal(PRESET_VOICES.length, 5, '预置 5 个（引擎 voices/*.gguf）')
  const names = PRESET_VOICES.map((voice) => voice.voice)
  assert.equal(new Set(names).size, names.length, '音色名不重复')
  for (const voice of PRESET_VOICES) {
    assert.ok(typeof voice.voice === 'string' && voice.voice.length > 0, `${voice.name} 有音色名`)
    assert.equal(voice.id, `cv3:${voice.voice}`, `${voice.name} 的 id 带 cv3: 前缀`)
    assert.ok(voice.speed > 0.2 && voice.speed < 4, '语速在安全区间')
  }
  assert.deepEqual(
    names,
    ['default', 'lively-female', 'gentle-female', 'young-male', 'calm-male'],
    '音色名和引擎包里的文件一致'
  )
})

test('分句：首句默认 16 字（引擎收敛后首句切短，首音快）', () => {
  const long = '这是一句没有标点会一直往下说的很长的话'.repeat(4)
  const parts = splitForSpeech(long)
  assert.ok(parts[0].length <= 16, `默认首句不超过 16 字（实际 ${parts[0].length}）`)
  assert.equal(parts.join(''), long, '只是切法不同，字不丢')
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

// ---- 流式实时播报（队列 + 句缓冲）：受控 mock，不依赖真实计时 ----
// mock 桥把每次合成挂成手动放行的 pending promise，空 samples 让泵跳过播放
// （不碰 AudioContext），这样断言的就是「哪些句子被送进合成队列、什么顺序、什么时机」。
const speech = require('../.tmp/speechoutput.cjs')

function mockBridge() {
  const calls = []
  const pending = []
  globalThis.window = {
    fridayBridge: {
      speakReply: ({ text }) => {
        calls.push(text)
        return new Promise((resolve) => pending.push(resolve))
      }
    }
  }
  const flushMicro = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  const release = (value) => {
    ;(pending.shift() ?? (() => {}))(value ?? { samples: new Float32Array(0), sampleRate: 24000 })
  }
  const restore = () => {
    speech.stopSpeaking()
    for (const resolve of pending.splice(0)) resolve({ samples: new Float32Array(0), sampleRate: 24000 })
    delete globalThis.window
  }
  return { calls, release, flushMicro, restore }
}

test('队列：流式增量 append 接在队尾不打断；整条播报打断并清队', async () => {
  const { calls, release, flushMicro, restore } = mockBridge()
  try {
    speech.speakText('第一句。', { force: true })
    await flushMicro()
    assert.deepEqual(calls, ['第一句。'], '首句立即送合成')

    speech.speakText('接在后面的句子。', { force: true, append: true })
    await flushMicro()
    assert.deepEqual(calls, ['第一句。'], 'append 只入队，不打断正在合成的句子')

    release() // 放行第一句 → 泵取走队尾那句
    await flushMicro()
    assert.deepEqual(calls, ['第一句。', '接在后面的句子。'], '前一句完成后增量按序接播')

    speech.speakText('还没轮到就被作废。', { force: true, append: true })
    await flushMicro()
    speech.speakText('新整条回复。', { force: true }) // 整条：打断清队
    await flushMicro()
    assert.ok(!calls.includes('还没轮到就被作废。'), '被打断时未取走的增量作废')
    assert.deepEqual(calls.slice(-1), ['新整条回复。'])
  } finally {
    restore()
  }
})

test('句缓冲：增量攒到句末才送播、flush 播尾巴、无标点长文兕底直送', async () => {
  const { calls, release, flushMicro, restore } = mockBridge()
  try {
    const inc = speech.createSpeechIncrement()
    inc.push('你好，我是')
    await flushMicro()
    assert.deepEqual(calls, [], '句中不送')

    inc.push('助手。')
    await flushMicro()
    assert.deepEqual(calls, ['你好，我是助手。'], '到句末成句送播')
    release()
    await flushMicro()

    inc.push('没等到的尾巴')
    await flushMicro()
    assert.equal(calls.length, 1, '尾巴继续攒')
    inc.flush()
    await flushMicro()
    assert.deepEqual(calls.slice(-1), ['没等到的尾巴'], 'flush 把尾巴整段送播')
    release()
    await flushMicro()

    inc.push('一'.repeat(200)) // 无任何句末标点：超过 120 字兕底直送（splitForSpeech 硬切）
    await flushMicro()
    assert.ok(calls.length >= 3, '无标点长文不憋着不出声')
  } finally {
    restore()
  }
})
