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
    assert.deepEqual(calls.slice(-1), ['没等到的尾巴。'], 'flush 把尾巴整段送播（无句末标点补句号收音）')
    release()
    await flushMicro()

    inc.push('一'.repeat(200)) // 无任何句末标点：超过 120 字兕底直送（splitForSpeech 硬切）
    await flushMicro()
    assert.ok(calls.length >= 3, '无标点长文不憋着不出声')
  } finally {
    restore()
  }
})

test('修复：流式 append 不再用首句 16 字上限硬切（一句话不再分两次说）', async () => {
  const { calls, release, flushMicro, restore } = mockBridge()
  try {
    speech.speakText('第一句。', { force: true })
    await flushMicro()
    assert.deepEqual(calls, ['第一句。'], '首句立即送合成')

    // 泵在跑（第一句还挂在 pending）：append 的完整句不应被 16 字上限切开
    const long = '这句已经超过十六个字还有逗号，后面是同一个句子的后半截。'
    speech.speakText(long, { force: true, append: true })
    await flushMicro()
    assert.deepEqual(calls, ['第一句。'], 'append 只入队')
    release()
    await flushMicro()
    assert.deepEqual(calls, ['第一句。', long], '流式追加的句子整句送合成，不从中间切开')

    // 泵停了？不——泵还在等上一句的合成结果：先放行，再验证新一轮 append 也不切
    release()
    await flushMicro()
    speech.speakText('还没等到的尾巴后面接了一句完整的长句子，长度超过了十六个字', { force: true, append: true })
    await flushMicro()
    assert.deepEqual(calls.slice(-1), ['还没等到的尾巴后面接了一句完整的长句子，长度超过了十六个字。'], '新一轮 append 同样整句送（无尾标点补句号）')
  } finally {
    restore()
  }
})

test('分句：硬切不产生孤儿标点段（引擎对纯标点实测返回空音频）', () => {
  // 17 字子句硬切出的 1 字尾片「，」要拼回前段，不独立成段
  const parts = splitForSpeech('这句话已经超过了十六个字还有逗号，后面这些是同一个句子的后半截。')
  assert.deepEqual(parts, ['这句话已经超过了十六个字还有逗号，', '后面这些是同一个句子的后半截。'])
  // 纯标点/空白片段不独立成段
  assert.deepEqual(splitForSpeech('。。，'), [])
  assert.deepEqual(splitForSpeech('好的。'), ['好的。'])
  // 流式追加（firstLimit=Infinity）不切：句子多长都整句
  const long = '这是一句没有标点会一直往下说的很长的话'.repeat(2)
  assert.deepEqual(splitForSpeech(long, Infinity), [long])
})

test('句缓冲：冒号引导句（如「如下：」）立刻成句送播，不等收尾 flush', async () => {
  const { calls, release, flushMicro, restore } = mockBridge()
  try {
    const inc = speech.createSpeechIncrement()
    inc.push('好的，具体步骤如下：')
    await flushMicro()
    assert.deepEqual(calls, ['好的，具体步骤如下：'], '全角冒号也是成句点，保持未完语气原样送播')
    release()
    await flushMicro()
    inc.flush() // 没攒下的尾巴：不送
    await flushMicro()
    assert.equal(calls.length, 1, '冒号后没有尾巴就不补播')
  } finally {
    restore()
  }
})

// ---- 流式播报遇到跨行结构（``` 代码块 / $$ 公式块）：按句切开后各片凑不齐围栏，曾逐行念代码 ----
// 按固定字数切片模拟流式，逐片 push 后 flush；每次放行一句合成，收齐送进合成的全部句子
async function streamSpeak(text, size) {
  const { calls, release, flushMicro, restore } = mockBridge()
  try {
    const inc = speech.createSpeechIncrement()
    for (let i = 0; i < text.length; i += size) {
      inc.push(text.slice(i, i + size))
      await flushMicro()
    }
    inc.flush()
    for (let i = 0; i < 32; i++) {
      await flushMicro()
      release()
    }
    await flushMicro()
    return calls.slice()
  } finally {
    restore()
  }
}

test('流式代码块：围栏里的代码不念，围栏前后照常成句（与整段清理一致）', async () => {
  const text = '示例如下：\n```ts\nconst a = foo(1);\nconsole.log(a);\n```\n运行即可。'
  assert.deepEqual(cleanForSpeech(text), '示例如下： 运行即可。', '整段清理的基准')
  for (const size of [1, 2, 3, 6, 11, text.length]) {
    assert.deepEqual(await streamSpeak(text, size), ['示例如下：', '运行即可。'], `每 ${size} 字一片：代码不进合成`)
  }
})

test('流式公式块：$$…$$ 跨行公式不念', async () => {
  const text = '能量公式是：\n$$\nE = mc^2;\n$$\n其中 c 是光速。'
  for (const size of [1, 4, 7]) {
    assert.deepEqual(await streamSpeak(text, size), ['能量公式是：', '其中 c 是光速。'], `每 ${size} 字一片：公式不进合成`)
  }
})

test('流式围栏：句中出现的代码块当空白，句子在两侧接着攒；记号被切成两半也认得', async () => {
  const text = '先跑一下 ```sh\nnpm test;\n``` 再看结果。'
  for (const size of [1, 2, 5]) {
    assert.deepEqual(await streamSpeak(text, size), ['先跑一下 再看结果。'], `每 ${size} 字一片`)
  }
})

test('流式围栏：收尾时代码块还没闭合，未闭合部分整段丢掉', async () => {
  const calls = await streamSpeak('看这段：\n```py\nprint(1)\nprint(2)\n', 3)
  assert.deepEqual(calls, ['看这段：'])
})

test('流式围栏：行内代码 / 单个 $ 被片尾扣住后照常放出，不误判成围栏', async () => {
  assert.deepEqual(await streamSpeak('调用 `foo` 即可。', 4), ['调用 foo 即可。'], '行内代码的反引号跨片也照常清理')
  const tail = await streamSpeak('单价 5$', 2)
  assert.equal(tail.length, 1, '片尾扣住的 $ 收尾时放出')
  assert.ok(tail[0].includes('5$'), `$ 当普通字符念（实际 ${tail[0]}）`)
})

test('中途起播：历史经 skip 过游标，停在代码块中间时后面的代码下半截不念', async () => {
  const { calls, release, flushMicro, restore } = mockBridge()
  try {
    const inc = speech.createSpeechIncrement()
    inc.skip('已经念过的开头。示例如下：\n``') // 历史停在半个围栏记号上
    inc.push('`ts\nconst a = foo(1);\n')
    inc.push('console.log(a);\n```\n运行即可。')
    inc.flush()
    for (let i = 0; i < 8; i++) {
      await flushMicro()
      release()
    }
    assert.deepEqual(calls, ['运行即可。'], '历史不念、代码下半截不念，围栏闭合后照常')

    const fresh = speech.createSpeechIncrement()
    fresh.skip('历史里没说完的半句')
    fresh.push('，后面接上的半句。')
    for (let i = 0; i < 8; i++) {
      await flushMicro()
      release()
    }
    assert.deepEqual(calls.slice(1), ['，后面接上的半句。'], 'skip 的正文丢掉，不拼进下一句')
  } finally {
    restore()
  }
})

// ---- 多来源并行播报：每个会话一路，前台优先合成、后台一次只让一路占麦 ----
// 这个 mock 记下送合成的整个 payload（语速 / 音色），并能按调用顺序放行
function payloadBridge() {
  const calls = []
  const pending = []
  globalThis.window = {
    fridayBridge: {
      speakReply: (payload) => {
        calls.push(payload)
        return new Promise((resolve) => pending.push(resolve))
      },
      cancelCosyVoice: () => Promise.resolve()
    }
  }
  const flushMicro = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  const release = () => (pending.shift() ?? (() => {}))({ samples: new Float32Array(0), sampleRate: 24000 })
  const restore = () => {
    speech.stopSpeaking()
    for (const resolve of pending.splice(0)) resolve({ samples: new Float32Array(0), sampleRate: 24000 })
    speech.setSpeechForeground('')
    delete globalThis.window
  }
  return { calls, release, flushMicro, restore, texts: () => calls.map((c) => c.text) }
}

test('并行：后台一次只让一路占麦，占麦的空下来要等一会儿才让给下一路', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { release, flushMicro, restore, texts } = payloadBridge()
  try {
    speech.setSpeechForeground('A')
    speech.speakText('B 说一句。', { force: true, append: true, source: 'B' })
    speech.speakText('C 说一句。', { force: true, append: true, source: 'C' })
    await flushMicro()
    assert.deepEqual(texts(), ['B 说一句。'], 'B 先来，占后台麦')
    release()
    await flushMicro()
    assert.deepEqual(texts(), ['B 说一句。'], 'B 刚说完（可能在等模型下一片），C 还不能插进来')

    speech.speakText('B 接着说。', { force: true, append: true, source: 'B' })
    await flushMicro()
    assert.deepEqual(texts().slice(1), ['B 接着说。'], '让出前等到了新句子：B 接着占麦')
    release()
    await flushMicro()

    t.mock.timers.tick(3000)
    await flushMicro()
    assert.deepEqual(texts().slice(2), ['C 说一句。'], 'B 空了 3 秒才让麦给 C')
    release()
    await flushMicro()
  } finally {
    restore()
  }
})

test('并行：后台提速、换一个和前台不同的快音色；前台照常', async () => {
  const { calls, release, flushMicro, restore } = payloadBridge()
  try {
    speech.setTtsDynamicSpeed(false)
    speech.setTtsSpeed(1)
    speech.setTtsBackgroundVoiceSwap(true)
    speech.setSpeechForeground('A')
    speech.speakText('前台的句子。', { force: true, append: true, source: 'A' })
    await flushMicro()
    release()
    await flushMicro()
    speech.speakText('后台的句子。', { force: true, append: true, source: 'B' })
    await flushMicro()
    const [front, back] = calls
    assert.equal(front.speed, 1, '前台原速')
    assert.equal(front.voice, speech.activeVoice().voice, '前台用选中的音色')
    assert.ok(Math.abs(back.speed - 1.2) < 1e-9, `后台提速 1.2×（实际 ${back.speed}）`)
    assert.notEqual(back.voice, front.voice, '后台换了个音色')
    release()
    await flushMicro()
  } finally {
    restore()
  }
})

test('并行：切前台后下一句按新身份合成；后台音量 0 时后台不播', async () => {
  const { calls, release, flushMicro, restore, texts } = payloadBridge()
  try {
    speech.setTtsDynamicSpeed(false)
    speech.setTtsSpeed(1)
    speech.setSpeechForeground('A')
    speech.speakText('B 第一句。', { force: true, append: true, source: 'B' })
    speech.speakText('B 第二句。', { force: true, append: true, source: 'B' })
    await flushMicro()
    speech.setSpeechForeground('B') // 用户切到 B：正在合成的那句不动，下一句起按前台
    release()
    await flushMicro()
    assert.deepEqual(texts(), ['B 第一句。', 'B 第二句。'])
    assert.equal(calls[1].speed, 1, '切成前台后的句子不再提速')
    release()
    await flushMicro()

    speech.setTtsBackgroundVolume(0)
    speech.speakText('A 现在是后台。', { force: false, append: true, source: 'A' })
    await flushMicro()
    assert.ok(!texts().includes('A 现在是后台。'), '后台音量 0：后台会话的句子直接丢，不攒着过后再念')
  } finally {
    speech.setTtsBackgroundVolume(0.25)
    restore()
  }
})

// ---- 第二步：后台积压压成一句提示、气泡方位 / HRTF 坐标 ----
test('方位：气泡横坐标同侧、离正中至少 0.35；HRTF 坐标在单位球上', () => {
  assert.equal(speech.bubblePan(-1, 'x'), -0.9, '最左 → -0.9（不打满）')
  assert.equal(speech.bubblePan(0.1, 'x'), 0.35, '靠中间也至少偏 0.35，别和居中的前台叠')
  assert.ok(Math.abs(Math.abs(speech.bubblePan(0, 'x')) - 0.35) < 1e-9, '正中按 id 定一侧')
  const front = speech.hrtfPosition(0, 0)
  assert.ok(Math.abs(front.x) < 1e-9 && Math.abs(front.y) < 1e-9 && Math.abs(front.z + 1) < 1e-9, '正前方 (0,0,-1)')
  const right = speech.hrtfPosition(1, 0)
  assert.ok(Math.abs(right.x - 1) < 1e-9 && Math.abs(right.z) < 1e-9, 'pan 1 → 正右方')
  const up = speech.hrtfPosition(0.5, 0.4)
  assert.ok(Math.abs(Math.hypot(up.x, up.y, up.z) - 1) < 1e-9 && up.y > 0, '带仰角仍在单位球上、偏上')
})

test('积压：排着轮不到的后台等满 30 秒压成「XX 有新回复」，这条回复后面的文本丢掉', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { release, flushMicro, restore, texts } = payloadBridge()
  try {
    speech.setSpeechTitleResolver((source) => `会话${source}`)
    speech.setSpeechForeground('A')
    speech.speakText('B 一直在说。', { force: true, append: true, source: 'B' })
    await flushMicro()
    speech.speakText('C 的第一句。', { force: true, append: true, source: 'C' })
    speech.speakText('C 的第二句。', { force: true, append: true, source: 'C' })
    await flushMicro()
    assert.deepEqual(texts(), ['B 一直在说。'], 'B 占着麦，C 排队')

    t.mock.timers.tick(30_000) // B 那句合成一直没回来：C 等满 30 秒
    await flushMicro()
    speech.speakText('C 后来又说的。', { force: true, append: true, source: 'C' }) // 同一条回复还在流式：丢
    release() // B 说完
    await flushMicro()
    t.mock.timers.tick(3000) // B 空了 3 秒让麦
    await flushMicro()
    assert.deepEqual(texts().slice(1), ['会话C 有新回复。'], 'C 只念一句提示，旧句和后来的文本都不念')
    release()
    await flushMicro()

    t.mock.timers.tick(20_000) // C 安静 20 秒：那条回复说完了
    speech.speakText('C 的新回复。', { force: true, append: true, source: 'C' })
    await flushMicro()
    assert.deepEqual(texts().slice(2), ['C 的新回复。'], '安静过后来的新回复照常念')
    release()
    await flushMicro()
  } finally {
    speech.setSpeechTitleResolver(() => '')
    restore()
  }
})

test('积压：后台一下攒了 300 字以上当场压成提示；切到眼前时提示作废、之后的文本实时念', async () => {
  const { release, flushMicro, restore, texts } = payloadBridge()
  try {
    speech.setSpeechTitleResolver((source) => `会话${source}`)
    speech.setSpeechForeground('A')
    speech.speakText('B 占着麦。', { force: true, append: true, source: 'B' })
    await flushMicro()
    const long = Array.from({ length: 20 }, (_, i) => `这是 C 积压的第${i + 1}句比较长的内容。`).join('')
    speech.speakText(long, { force: true, append: true, source: 'C' })
    await flushMicro()
    speech.setSpeechForeground('C') // 用户切过去看 C：提示不用念了
    speech.speakText('切过来之后的新句子。', { force: true, append: true, source: 'C' })
    await flushMicro()
    release()
    await flushMicro()
    assert.deepEqual(texts(), ['B 占着麦。', '切过来之后的新句子。'], '积压不念、提示不念，眼前的新文本照念')
    release()
    await flushMicro()
  } finally {
    speech.setSpeechTitleResolver(() => '')
    restore()
  }
})
