#!/bin/sh
# 装 239 的本地语音（voice Power）：cpu 版（这台是 QEMU 虚拟机，没有 GPU）
set -e
mkdir -p /root/.local/share/Friday/powers/voice
cd /root/.local/share/Friday/powers/voice

BASE=https://ghproxy.net/https://github.com/integemjack/Friday.Powers/releases/download
echo "=== 下载 voice 0.4.1 linux-x64-vulkan（CPU 上也带 CPU 后备）==="
if [ ! -f voice.tar.gz ]; then
  curl -L --fail -o voice.tar.gz "$BASE/voice-v0.4.1/voice-0.4.1-linux-x64-vulkan.tar.gz" || \
  curl -L --fail -o voice.tar.gz "$BASE/voice-v0.4.1/voice-0.4.1-linux-x64-cuda.tar.gz"
fi
ls -l voice.tar.gz
echo "=== 解开 ==="
tar xzf voice.tar.gz
ls | head -12
echo "=== done ==="
