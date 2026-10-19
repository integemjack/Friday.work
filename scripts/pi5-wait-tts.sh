#!/bin/sh
# 等 tts.wav 出现（Pi5 上 CosyVoice 合成一句要几分钟），最多 10 分钟
i=0
while [ $i -lt 60 ]; do
  if [ -s /tmp/voice-e2e/tts.wav ]; then
    echo TTS-READY
    ls -la /tmp/voice-e2e/tts.wav
    break
  fi
  i=$((i + 1))
  sleep 10
done
[ -s /tmp/voice-e2e/tts.wav ] || echo TTS-TIMEOUT
tail -3 /tmp/voice-e2e/err.log 2>/dev/null
