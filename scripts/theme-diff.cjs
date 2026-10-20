// 对拍两份快照：node scripts/theme-diff.cjs <目录A> <目录B> [--views v1,v2]
// 目录结构：<目录>/<主题>/<视图>.styles.txt + root-vars.txt
// 退出码：0 = 零差异；1 = 有差异（并列出）
const fs = require('fs')
const path = require('path')

const [dirA, dirB] = process.argv.slice(2, 4)
const viewsArgIdx = process.argv.indexOf('--views')
const viewFilter = viewsArgIdx > 0 ? process.argv[viewsArgIdx + 1].split(',') : null

if (!dirA || !dirB || !fs.existsSync(dirA) || !fs.existsSync(dirB)) {
  console.error('用法: node scripts/theme-diff.cjs <目录A> <目录B> [--views v1,v2]')
  process.exit(2)
}

let diffs = 0
const report = (line) => { console.log(line); diffs++ }

// 支持两种传参：传根目录（内含 <主题>/ 子目录）或直接传主题目录（内含 root-vars.txt）
const themesA = fs.existsSync(path.join(dirA, 'root-vars.txt')) ? ['.'] : fs.readdirSync(dirA)

for (const theme of themesA) {
  const ta = path.join(dirA, theme)
  const tb = path.join(dirB, theme)
  const label = theme === '.' ? '' : `[${theme}] `
  if (!fs.existsSync(tb)) { report(`${label}目录B缺少该主题`); continue }

  // root-vars
  const va = fs.readFileSync(path.join(ta, 'root-vars.txt'), 'utf8').split('\n')
  const vb = fs.existsSync(path.join(tb, 'root-vars.txt')) ? fs.readFileSync(path.join(tb, 'root-vars.txt'), 'utf8').split('\n') : []
  const varMapA = new Map(va.map((l) => [l.split(' = ')[0], l.split(' = ')[1] ?? '']))
  const varMapB = new Map(vb.map((l) => [l.split(' = ')[0], l.split(' = ')[1] ?? '']))
  for (const [k, v] of varMapA) {
    if (!varMapB.has(k)) report(`[${theme}] root-var 仅A有: ${k} = ${v}`)
    else if (varMapB.get(k) !== v) report(`[${theme}] root-var 不一致: ${k}\n    A: ${v}\n    B: ${varMapB.get(k)}`)
  }
  for (const k of varMapB.keys()) if (!varMapA.has(k)) report(`[${theme}] root-var 仅B有: ${k} = ${varMapB.get(k)}`)

  for (const file of fs.readdirSync(ta)) {
    if (!file.endsWith('.styles.txt')) continue
    const view = file.replace('.styles.txt', '')
    if (viewFilter && !viewFilter.includes(view)) continue
    const pb = path.join(tb, file)
    if (!fs.existsSync(pb)) { report(`[${theme}/${view}] 目录B缺少该视图样式`); continue }
    const la = fs.readFileSync(path.join(ta, file), 'utf8').split('\n')
    const lb = fs.readFileSync(pb, 'utf8').split('\n')
    const n = Math.max(la.length, lb.length)
    for (let i = 0; i < n; i++) {
      if (la[i] !== lb[i]) {
        const keyA = la[i]?.split('|')[1] ?? '(无)'
        const keyB = lb[i]?.split('|')[1] ?? '(无)'
        report(`[${theme}/${view}] 第${i + 1}行元素样式不一致 (${keyA} / ${keyB})\n    A: ${la[i] ?? '(缺失)'}\n    B: ${lb[i] ?? '(缺失)'}`)
      }
    }
  }
  for (const file of fs.readdirSync(tb)) {
    if (!file.endsWith('.styles.txt')) continue
    const view = file.replace('.styles.txt', '')
    if (viewFilter && !viewFilter.includes(view)) continue
    if (!fs.existsSync(path.join(ta, file))) report(`[${theme}/${view}] 目录A缺少该视图样式`)
  }
}

console.log(diffs === 0 ? '对拍结果：零差异 ✔' : `对拍结果：${diffs} 处差异 ✘`)
process.exit(diffs === 0 ? 0 : 1)
