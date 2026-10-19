#!/bin/sh
# 等 Pi5 构建结束（BUILD-FINISHED / BUILD-STOPPED），最多 ~50 分钟
i=0
while [ $i -lt 100 ]; do
  if grep -q "=== done" /root/friday-build.log 2>/dev/null; then
    echo BUILD-FINISHED
    break
  fi
  if grep -qE "ninja: build stopped|CMake Error" /root/friday-build.log 2>/dev/null; then
    echo BUILD-STOPPED
    break
  fi
  i=$((i + 1))
  sleep 30
done
echo "--- tail ---"
tail -5 /root/friday-build.log
echo "--- errors ---"
grep -E "error:|Error" /root/friday-build.log | tail -6
echo "--- binary ---"
ls -l /root/friday-build/build/src/cli/friday-headless 2>/dev/null || echo no binary
