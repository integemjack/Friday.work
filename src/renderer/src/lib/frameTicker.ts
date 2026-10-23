// 装饰性 canvas 动画（深空星野、语音波形）的共用帧驱动。
// 为什么要共用：每个 requestAnimationFrame 请求都会让主线程跑一整个主帧（样式重算 + 图层提交），
// 哪怕回调里什么都不画。各组件自己限帧时，星野 30fps、波形 24fps 两条定时器互相错开，
// 实测一秒反而跑出 ~54 个主帧；各自每个 vsync 请求再在回调里跳过，又等于没限帧。
// 这里只有一条链：所有订阅者在同一帧里画——有人要逐帧（流星划过、正在播报）就每个 vsync 一帧，
// 都空闲时用定时器隔一个空闲帧间隔、到点再对齐 vsync（≈30fps）。

type Tick = (now: number) => void

interface Subscriber {
  tick: Tick
  /** 这一刻要不要逐帧（返回 false 时按空闲帧率走） */
  wantsEveryFrame: () => boolean
}

const IDLE_FRAME_MS = 1000 / 30

const subscribers = new Set<Subscriber>()
let raf = 0
let timer = 0

function frame(now: number): void {
  raf = 0
  for (const subscriber of subscribers) subscriber.tick(now)
  schedule()
}

function schedule(): void {
  if (raf || timer || subscribers.size === 0) return
  let everyFrame = false
  for (const subscriber of subscribers) {
    if (subscriber.wantsEveryFrame()) {
      everyFrame = true
      break
    }
  }
  if (everyFrame) {
    raf = requestAnimationFrame(frame)
    return
  }
  // 提前一点醒，留给对齐下一个 vsync
  timer = window.setTimeout(() => {
    timer = 0
    raf = requestAnimationFrame(frame)
  }, IDLE_FRAME_MS - 6)
}

/** 订阅帧回调；返回退订函数 */
export function subscribeFrames(tick: Tick, wantsEveryFrame: () => boolean = () => false): () => void {
  const subscriber: Subscriber = { tick, wantsEveryFrame }
  subscribers.add(subscriber)
  schedule()
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0) {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      raf = 0
      timer = 0
    }
  }
}

/** 有订阅者刚开始要逐帧（开始播报 / 流星出现）：别等空闲定时器，下一个 vsync 就画 */
export function wakeFrames(): void {
  if (!timer) return
  window.clearTimeout(timer)
  timer = 0
  raf = requestAnimationFrame(frame)
}
