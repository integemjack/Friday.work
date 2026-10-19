#!/bin/sh
# 长等 tts.wav（最多 25 分钟，Pi5 上 CosyVoice 首次合成很慢）
i=0
while [ $i -lt 150 ]; do
  if [ -s /tmp/voice-e2e/tts.wav ]; then
    echo TTS-READY
    ls -la /tmp/voice-e2e/tts.wav
    exit 0
  fi
  # 合成进程死了也没出文件 → 停
  if ! ps -eo args | grep -q "[f]riday-voice speak"; then
    echo SPEAKER-DIED
    tail -4 /tmp/voice-e2e/err.log
    exit 1
  fi
  i=$((i + 1))
  sleep 10
done
echo TTS-TIMEOUT
