// 对拍两份快照：node scripts/theme-diff.cjs <目录A> <目录B> [--views v1,v2]
// 目录结构：<目录>/<主题>/<视图>.styles.txt + root-vars.txt（styles 按行首 key 配对）
// 退出码：0 = 零差异；1 = 有差异（每视图最多列 5 处，总数照实计）
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

const parseStyles = (txt) => {
  const map = new Map()
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue
    const idx = line.indexOf('|')
    if (idx > 0) map.set(line.slice(0, idx), line.slice(idx + 1))
  }
  return map
}

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
    if (!varMapB.has(k)) report(`${label}root-var 仅A有: ${k} = ${v}`)
    else if (varMapB.get(k) !== v) report(`${label}root-var 不一致: ${k}\n    A: ${v}\n    B: ${varMapB.get(k)}`)
  }
  // 仅B新增的令牌定义不算差异：不影响视觉，元素样式对拍才是硬门榁

  const views = new Set()
  for (const dir of [ta, tb]) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.styles.txt')) views.add(file.replace('.styles.txt', ''))
    }
  }

  for (const view of views) {
    if (viewFilter && !viewFilter.includes(view)) continue
    const pa = path.join(ta, view + '.styles.txt')
    const pb = path.join(tb, view + '.styles.txt')
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) {
      report(`${label}${view}: ${!fs.existsSync(pa) ? 'A' : 'B'} 缺少该视图样式`)
      continue
    }
    const mapA = parseStyles(fs.readFileSync(pa, 'utf8'))
    const mapB = parseStyles(fs.readFileSync(pb, 'utf8'))
    let shown = 0
    const show = (msg) => { if (shown < 5) { console.log(msg); shown++ } }
    for (const [k, v] of mapA) {
      if (!mapB.has(k)) { show(`${label}${view}: 仅A有元素 ${k} → ${v}`); diffs++ }
      else if (mapB.get(k) !== v) { show(`${label}${view}: 元素样式不一致 ${k}\n    A: ${v}\n    B: ${mapB.get(k)}`); diffs++ }
    }
    for (const [k, v] of mapB) {
      if (!mapA.has(k)) { show(`${label}${view}: 仅B有元素 ${k} → ${v}`); diffs++ }
    }
    if (shown >= 5) console.log(`${label}${view}: ……（其余差异省略）`)
  }
}

console.log(diffs === 0 ? '对拍结果：零差异 ✔' : `对拍结果：${diffs} 处差异 ✘`)
process.exit(diffs === 0 ? 0 : 1)
