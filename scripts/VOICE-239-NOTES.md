把 239 的 voice（本地语音）跑起来 —— 卡在哪、为什么

结论：这台 239 是 QEMU 虚拟机，guest CPU 是「QEMU Virtual CPU version 2.5+」，
**没有 AVX / AVX2 指令集**（只有到 SSE4.2）。而 Friday.Powers 的 voice 0.4.1
只有这几个包：

  linux-x64-vulkan   17 MB   要 Vulkan 设备；这台没有 GPU（QEMU 标准显卡）
  linux-x64-cuda     384 MB  要 NVIDIA CUDA；这台也没有

两个包都在 x86-64-v3（AVX2）基线上编译，在这个 guest CPU 上第一条
AVX2 指令就是 Illegal instruction，换 --device cpu / auto、装 lavapipe
（llvmpipe 软件渲染，vulkaninfo 里能看到设备）都一样崩。

已验证的链路（这些都不依赖那两个包）：
  - friday-server 2.34.0（我们自己编的，带 /connect + voice.*）正常跑
  - server.features 里有 "voice"
  - voice.start → 起本地能力进程 →（包装了，进程起不来）→ 正确回错误 4 与原因
  - voice.stop / voice.state 正常
  - 音频帧格式 640 字节 / 20 毫秒有单测钉着

要让 239 的实时语音真正出声，需要下面任一条：
  1. 把 239 的 QEMU CPU 模型改成 host（或 qemu64 + avx），重启虚拟机
     —— 宿主机上 virsh edit <vm>，<cpu mode='host-passthrough'/>，
     之后 voice 0.4.1 原样就能跑（Vulkan 走 lavapipe 也能用，慢但能出声）
  2. Powers 出一个 linux-x64-cpu（x86-64 基线，不带 AVX2）的 voice 包
  3. 或在别的有 GPU / AVX2 的 Linux 机器上测

我们这边（客户端 + Friday 协议）不缺任何东西：装上能跑的 voice 包（或
换台机器）后，语音窗口的「开始」就直接能用。
