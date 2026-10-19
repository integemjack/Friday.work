#!/bin/sh
# 等模型全下完（MODELS-DONE）
i=0
while [ $i -lt 110 ]; do
  if grep -q "MODELS-DONE" /tmp/fm.log 2>/dev/null; then
    echo MODELS-READY
    break
  fi
  i=$((i + 1))
  sleep 5
done
grep -E "fetch|skip|FAILED|MODELS-DONE" /tmp/fm.log
du -sh /root/.local/share/Friday/powers/voice/friday-voice
