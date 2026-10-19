#!/bin/sh
# 等构建结束（出现 "=== done" 或进程没了），最多等 ~9 分钟
i=0
while [ $i -lt 105 ]; do
  if grep -q "=== done" /root/friday-build.log 2>/dev/null; then
    echo "BUILD-FINISHED"
    break
  fi
  if ! ps -ef | grep -q "[c]make --build"; then
    if ! ps -ef | grep -q "[n]inja"; then
      echo "BUILD-STOPPED"
      break
    fi
  fi
  i=$((i + 1))
  sleep 5
done
echo "--- errors ---"
grep -n -i -m 25 "error:" /root/friday-build.log 2>/dev/null || echo "(no error:)"
echo "--- tail ---"
tail -6 /root/friday-build.log
echo "--- binary ---"
ls -l /root/friday-build/build/friday-headless 2>/dev/null || echo "no binary"
