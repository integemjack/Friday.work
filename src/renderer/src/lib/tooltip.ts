/* 全局自绘 tooltip —— 接管所有 [title] 元素的原生提示，换成无边框圆角浮签
   .frid-tip（基础样式在 styles/base.css，贾维斯主题覆写在 styles/jarvis.css）。

   为什么要自绘：原生 title 提示是操作系统画的（浅底、细边框、直角），CSS 改不动。
   做法：捕获阶段监听 pointerover，指针一进带 title 的元素就把 title 暂存到
   data-frid-title 并摘下属性（原生提示来不及触发），停住 SHOW_DELAY_MS 后在
   元素上方浮出浮签（上方放不下翻到下方，左右夹进视口）；指针离开锚点 /
   按下 / 任何滚动 / Esc / 窗口失焦 / 缩放时收起，并把 title 还回去。

   几个边界：
   - 禁用的按钮（如 FilesCard 的前进/后退）不发 mousedown，但 pointerover/
     pointermove 照发（Chromium 行为，见 FloatingUI #3075），所以这里全程用
     pointer 事件，禁用按钮的 tooltip 也接得住；
   - 空 title（:title 条件给 ''）直接跳过，不出浮签也不出原生提示；
   - 悬停期间 Vue 把 :title 改成新值会直接写回属性：收起时以 Vue 的新值为准，
     不拿暂存的旧值覆盖；
   - 悬停中锚点被 v-if 卸载：指针不动没有 pointerout，靠 pointermove 兜底收起。 */

const SHOW_DELAY_MS = 350
const VIEW_MARGIN = 8 // 浮签离视口边缘至少留的空隙
const GAP = 8 // 浮签与锚点元素之间的间距
const STASH = 'data-frid-title' // 悬停期间 title 文本的暂存处

let tip: HTMLDivElement | null = null
let anchor: Element | null = null // 正在悬停（或已出浮签）的元素
let stashed = '' // 从 anchor 暂存下来的 title 文本
let restTimer = 0 // 「指针停住」计时器：到点出浮签
let showRaf = 0

/** 从节点向上找带 title（或已暂存 title）的祖先；文本为空返回 null */
function titledAncestor(target: EventTarget | null): { el: Element; text: string } | null {
  if (!(target instanceof Element)) return null
  const el = target.closest(`[title], [${STASH}]`)
  if (!el) return null
  const text = el.getAttribute('title') ?? el.getAttribute(STASH) ?? ''
  return text.trim() ? { el, text } : null
}

/** 收起浮签、还原锚点的 title（Vue 悬停中写了新值则以新值为准） */
function hide(): void {
  window.clearTimeout(restTimer)
  window.cancelAnimationFrame(showRaf)
  if (anchor) {
    const value = anchor.getAttribute(STASH)
    anchor.removeAttribute(STASH)
    if (value !== null && anchor.getAttribute('title') === null) anchor.setAttribute('title', value)
    anchor = null
  }
  tip?.classList.remove('show')
}

function show(): void {
  if (!tip || !anchor || !anchor.isConnected) {
    hide()
    return
  }
  tip.textContent = stashed
  // 收起态是 visibility:hidden（保留布局）：先量尺寸定位，再加 .show 淡入
  const rect = anchor.getBoundingClientRect()
  const width = tip.offsetWidth
  const height = tip.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  let x = rect.left + rect.width / 2 - width / 2
  x = Math.max(VIEW_MARGIN, Math.min(x, vw - width - VIEW_MARGIN))
  let y = rect.top - height - GAP
  if (y < VIEW_MARGIN) y = rect.bottom + GAP // 贴着窗口顶放不下 → 翻到下方
  if (y + height > vh - VIEW_MARGIN) y = Math.max(VIEW_MARGIN, vh - height - VIEW_MARGIN)
  tip.style.left = `${Math.round(x)}px`
  tip.style.top = `${Math.round(y)}px`
  showRaf = requestAnimationFrame(() => tip?.classList.add('show'))
}

function onPointerOver(event: PointerEvent): void {
  if (event.pointerType === 'touch') return // 触屏本来就不出 title 提示
  const found = titledAncestor(event.target)
  if (!found) return
  if (found.el === anchor) return // 只是在锚点内部挪动：不打断
  hide()
  anchor = found.el
  stashed = found.text
  // 立刻摘下 title（原生提示出不来），文本暂存进 data-frid-title
  anchor.setAttribute(STASH, anchor.getAttribute('title') ?? stashed)
  anchor.removeAttribute('title')
  restTimer = window.setTimeout(show, SHOW_DELAY_MS)
}

function onPointerOut(event: PointerEvent): void {
  if (!anchor) return
  const to = event.relatedTarget
  if (to instanceof Node && anchor.contains(to)) return // 还没离开锚点
  hide()
}

function onPointerMove(): void {
  // 兜底：锚点在悬停中被 v-if 卸载时没有 pointerout，指针动一下就在这里收掉
  if (anchor && !anchor.isConnected) hide()
}

/** 每个窗口挂一次（主窗口和快捷输入浮层共用本入口） */
export function installTooltip(): void {
  if (tip) return
  tip = document.createElement('div')
  tip.className = 'frid-tip'
  tip.setAttribute('role', 'tooltip')
  document.body.appendChild(tip)

  document.addEventListener('pointerover', onPointerOver, { capture: true, passive: true })
  document.addEventListener('pointerout', onPointerOut, { capture: true, passive: true })
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('pointerdown', hide, { capture: true, passive: true })
  document.addEventListener('scroll', hide, { capture: true, passive: true })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide()
  })
  window.addEventListener('blur', hide)
  window.addEventListener('resize', hide)
}
