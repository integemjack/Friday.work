#!/bin/sh
# 等 voice Power 下载解开完
i=0
while [ $i -lt 100 ]; do
  if grep -q "=== done ===" /tmp/pw.log 2>/dev/null; then
    echo POWER-READY
    break
  fi
  i=$((i + 1))
  sleep 5
done
tail -14 /tmp/pw.log
