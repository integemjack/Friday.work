#!/bin/sh
i=0
while [ $i -lt 55 ]; do
  if [ -s /tmp/voice-e2e/tts.wav ]; then
    echo READY
    ls -la /tmp/voice-e2e/tts.wav
    exit 0
  fi
  if ! ps -p 256990 >/dev/null 2>&1; then
    echo DIED
    tail -4 /tmp/voice-e2e/err.log
    exit 1
  fi
  i=$((i + 1))
  sleep 10
done
echo STILL-RUNNING
top -b -n 1 -p 256990 2>/dev/null | tail -2
