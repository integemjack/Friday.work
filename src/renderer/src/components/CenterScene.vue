<script setup lang="ts">
// 桌面中央 3D 场景（2026-10：中栏改 3D 形式）：纯 CSS 3D，零依赖——
// 透视网格地面（向观察者流动）+ 缓慢自转的线框陀螺环 + 中心辉光核。
// 只是氛围层：pointer-events 全关，铺在桌面背景上、气泡/操作卡/浮动窗口之下，主题色跟随 --accent。
// 只属于默认（跟随系统）主题；贾维斯主题不挂（App.vue 里 v-if="!jarvis"，那边走自己的深空层 + HUD）。
</script>

<template>
  <div class="center-scene" aria-hidden="true">
    <!-- 地平线辉光：网格地面远端边缘的一条能量线 + 升腾的大气光 -->
    <div class="horizon">
      <div class="horizon-line" />
      <div class="horizon-glow" />
    </div>

    <!-- 透视网格地面 -->
    <div class="floor">
      <div class="floor-grid" />
    </div>

    <!-- 线框陀螺环 + 辉光核 -->
    <div class="core">
      <div class="ring r1" />
      <div class="ring r2" />
      <div class="ring r3" />
      <div class="halo" />
      <div class="nucleus" />
    </div>

    <!-- 悬浮微粒（景深感）：三层不同深度的光点缓慢漂移 -->
    <div class="dust d1" />
    <div class="dust d2" />
    <div class="dust d3" />
  </div>
</template>

<style scoped>
.center-scene {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  perspective: 760px;
  perspective-origin: 50% 40%;
  z-index: 0;
  /* 鼠标视差：3D 场景顺向小幅移动（深空层反向，拉开景深）；
     独立 translate 属性，不跟 perspective 冲突 */
  translate: calc(var(--par-x, 0) * 11px) calc(var(--par-y, 0) * 8px);
}

/* ---- 地平线：一条呼吸的能量线 + 往上升的大气辉光，
        位置对齐网格地面投影后的远端边缘（约场景 72% 高处，截图校准） ---- */
.horizon {
  position: absolute;
  left: 0;
  right: 0;
  top: 68%;
  height: 130px;
}

.horizon-line {
  position: absolute;
  left: 4%;
  right: 4%;
  top: 0;
  height: 1.5px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--accent-a45) 16%,
    var(--accent-a70) 50%,
    var(--accent-a45) 84%,
    transparent
  );
  box-shadow:
    0 0 14px var(--accent-a30),
    0 0 44px var(--accent-a14);
  animation: horizon-breathe 6s ease-in-out infinite;
}

.horizon-glow {
  position: absolute;
  left: 8%;
  right: 8%;
  top: 0;
  height: 116px;
  background: radial-gradient(ellipse 62% 100% at 50% 0%, var(--accent-a12), transparent 72%);
  filter: blur(6px);
}

@keyframes horizon-breathe {
  50% {
    opacity: 0.5;
  }
}

/* ---- 地面：rotateX 压平成地面，网格线沿 Z 轴向观察者流动，远处淡出 ---- */
.floor {
  position: absolute;
  left: -45%;
  right: -45%;
  bottom: -14%;
  height: 64%;
  transform: rotateX(64deg);
  transform-origin: 50% 100%;
  -webkit-mask-image: linear-gradient(180deg, transparent 2%, #000 42%);
  mask-image: linear-gradient(180deg, transparent 2%, #000 42%);
}

.floor-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(to right, var(--accent-a18, rgba(90, 220, 255, 0.16)) 1px, transparent 1px),
    linear-gradient(to top, var(--accent-a18, rgba(90, 220, 255, 0.16)) 1px, transparent 1px);
  background-size: 72px 72px;
  animation: floor-flow 5.5s linear infinite;
}

@keyframes floor-flow {
  from {
    background-position: 0 0, 0 0;
  }
  to {
    background-position: 0 72px, 0 72px;
  }
}

/* ---- 核心：三维自转的陀螺环组 ---- */
.core {
  position: absolute;
  left: 50%;
  top: 42%;
  width: 230px;
  height: 230px;
  margin: -115px 0 0 -115px;
  transform-style: preserve-3d;
  animation: core-spin 26s linear infinite;
}

.ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid var(--accent-a40, rgba(90, 220, 255, 0.36));
  box-shadow: 0 0 12px var(--accent-a10, rgba(90, 220, 255, 0.1)) inset;
}

.r1 {
  transform: rotateX(70deg);
}

.r2 {
  transform: rotateX(70deg) rotateY(60deg);
  border-color: var(--accent-a28, rgba(90, 220, 255, 0.25));
}

.r3 {
  transform: rotateX(70deg) rotateY(-60deg);
  border-color: var(--accent-a28, rgba(90, 220, 255, 0.25));
}

@keyframes core-spin {
  from {
    transform: rotateZ(0deg);
  }
  to {
    transform: rotateZ(360deg);
  }
}

/* 辉光与核：压在环组平面上，跟着一起转也无妨（圆形旋转不可见） */
.halo {
  position: absolute;
  inset: 22%;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-a22, rgba(90, 220, 255, 0.2)), transparent 68%);
  filter: blur(8px);
  transform: rotateX(70deg);
}

.nucleus {
  position: absolute;
  inset: 46.5%;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 22px var(--accent-a55, rgba(90, 220, 255, 0.5));
  opacity: 0.85;
}

/* ---- 悬浮微粒：三个不同 translateZ 深度的光点，缓慢漂移 ---- */
.dust {
  position: absolute;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent-a40, rgba(90, 220, 255, 0.36));
  box-shadow: 0 0 8px var(--accent-a30, rgba(90, 220, 255, 0.28));
}

.d1 {
  left: 30%;
  top: 30%;
  transform: translateZ(-140px);
  animation: drift-a 19s ease-in-out infinite alternate;
}

.d2 {
  left: 66%;
  top: 24%;
  transform: translateZ(-60px);
  animation: drift-b 23s ease-in-out infinite alternate;
}

.d3 {
  left: 56%;
  top: 62%;
  transform: translateZ(-220px);
  animation: drift-a 27s ease-in-out infinite alternate-reverse;
}

@keyframes drift-a {
  to {
    translate: 90px -46px;
  }
}

@keyframes drift-b {
  to {
    translate: -70px 60px;
  }
}

/* 注：动画不随系统 prefers-reduced-motion 关闭——
   本机 Windows 关了「动画效果」（性能模式），跟随系统 hint 会让场景静默变成纯静态
   （实测 matchMedia 报 reduce），失去这套氛围层的意义。 */
</style>
