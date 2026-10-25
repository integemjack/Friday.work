// ask_user 的客户端纯逻辑（lib/askUser.ts）：
// 参数原文 → 问题列表（对齐服务端 AskUser::parse 的宽松规则）、界面选择 → runner.resolveApproval 的 answer。
// 锁住 recommended 的 1 起/0 起换算、多选「、」连、自己写的原样、全空 = 跳过这些容易悄悄错的事。
const test = require('node:test')
const assert = require('node:assert')

const { parseAskQuestions, buildAskAnswer } = require('../.tmp/askuser.cjs')

test('解析：完整形状（recommended 1 起 → 0 起）', () => {
  const questions = parseAskQuestions(
    JSON.stringify({
      questions: [
        {
          question: '登录页改成哪种样式？',
          options: [
            { label: '卡片式', detail: '居中一张卡' },
            { label: '分栏式', detail: '左图右表单' }
          ],
          recommended: 1
        },
        { question: '要深色吗？', options: [{ label: '深色' }, { label: '浅色' }], multiple: true, recommended: 2 }
      ]
    })
  )
  assert.equal(questions.length, 2)
  assert.equal(questions[0].question, '登录页改成哪种样式？')
  assert.equal(questions[0].recommended, 0, '1 起的 recommended 换成 0 起')
  assert.equal(questions[0].options[0].detail, '居中一张卡')
  assert.equal(questions[1].multiple, true)
  assert.equal(questions[1].recommended, 1)
  assert.equal(questions[1].options[1].label, '浅色')
})

test('解析：只有一题的简写、字符串选项、选项上的 recommended:true', () => {
  const questions = parseAskQuestions(JSON.stringify({ question: '先做哪个？', options: ['首页', '详情页', '设置'], recommended: 2 }))
  assert.equal(questions.length, 1)
  assert.equal(questions[0].options.length, 3, '纯字符串选项也认')
  assert.equal(questions[0].recommended, 1)

  const flagged = parseAskQuestions(
    JSON.stringify({ question: '用哪个？', options: [{ label: 'A', recommended: true }, { label: 'B' }] })
  )
  assert.equal(flagged[0].recommended, 0, '选项上的 recommended:true → 第 0 个')

  // 选项认 text/description 别名；recommended 认字符串数字
  const aliased = parseAskQuestions(
    JSON.stringify({ question: '去哪？', options: [{ text: '北京', description: '首都' }], recommended: '1' })
  )
  assert.equal(aliased[0].options[0].label, '北京')
  assert.equal(aliased[0].options[0].detail, '首都')
  assert.equal(aliased[0].recommended, 0)
})

test('解析：没写题面的丢掉；最多 3 题、每题 4 个选项；解析不出返回空', () => {
  const capped = parseAskQuestions(
    JSON.stringify({
      questions: [
        { question: '', options: ['a', 'b'] }, // 没题面：丢
        { question: '一', options: ['a', 'b', 'c', 'd', 'e'] }, // 5 个选项截到 4
        { question: '二', options: ['a', 'b'] },
        { question: '三', options: ['a', 'b'] },
        { question: '四', options: ['a', 'b'] } // 超过 3 题：不要
      ]
    })
  )
  assert.equal(capped.length, 3)
  assert.equal(capped[0].options.length, 4)
  assert.equal(capped[0].question, '一')

  assert.deepEqual(parseAskQuestions('不是 JSON'), [])
  assert.deepEqual(parseAskQuestions('[]'), [])
  assert.deepEqual(parseAskQuestions('{}'), [], '没有 questions 也没有简写 → 空（当普通审批处理）')
  // recommended 越界 → 没有
  const none = parseAskQuestions(JSON.stringify({ question: 'q', options: ['a', 'b'], recommended: 9 }))
  assert.equal(none[0].recommended, undefined)
})

test('组回答：多选「、」连、自己写的也是答案（不被点过的选项压住）、全空 = 跳过', () => {
  const answer = buildAskAnswer(
    [
      ['卡片式'], // 单选
      ['深色', '大字'] // 多选 → 「、」连
      // 第三题没动
    ],
    ['', '', '先不做']
  )
  assert.deepEqual(answer.answers, ['卡片式', '深色、大字', '先不做'])

  const skipped = buildAskAnswer([[], []], ['', ''])
  assert.deepEqual(skipped.answers, ['', ''], '全空 = 跳过（服务端按推荐的做）')

  // 单选里界面保证互斥（有字就不再有选中项，见 AskPanel 的 onOwnInput），但纯逻辑上
  // 两样都在时不能让默认选中把字压掉（曾有 bug：预填的推荐 + 自己写，交的是推荐）
  const ownWithPicked = buildAskAnswer([['推荐项'], []], ['我自己写了', ''])
  assert.deepEqual(ownWithPicked.answers, ['推荐项、我自己写了', ''], '选项和自己的字都在 → 并到一起，第二题没动为空')
})
