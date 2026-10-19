#!/bin/sh
# 等 Friday 拉起 friday-voice serve 并且**不杀它**：23:30:54 拉起的那次（第 4 次），到目前没有"退出"警告。
# 盯住它：预热完成（CPU 降）→ 立即跑 e2e
i=0
while [ $i -lt 45 ]; do
  pid=$(ps -eo pid,args | grep "friday-voice serve" | grep -v grep | awk '{print $1}' | head -1)
  if [ -z "$pid" ]; then
    echo "round $i: 不在（等重拉）"
    sleep 15
    i=$((i + 1))
    continue
  fi
  cpu=$(ps -o %cpu= -p "$pid" | tr -d ' ' | awk '{print int($1)}')
  etime=$(ps -o etime= -p "$pid" | tr -d ' ')
  echo "round $i: pid=$pid cpu=$cpu etime=$etime"
  low=$(ps -o %cpu= -p "$pid" | awk '{print ($1 < 25) ? 1 : 0}')
  if [ "$low" = "1" ] && [ "$i" -gt 3 ]; then
    echo WARM
    exit 0
  fi
  i=$((i + 1))
  sleep 10
done
echo TIMEOUT
