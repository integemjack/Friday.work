#!/bin/sh
# 等 friday-voice serve 预热完成（CPU 降下来 = 模型加载完），最多 8 分钟
i=0
while [ $i -lt 48 ]; do
  pid=$(ps -eo pid,args | grep "friday-voice serve" | grep -v grep | awk '{print $1}' | head -1)
  if [ -z "$pid" ]; then
    echo "DIED at round $i"
    grep -iE '退出|两分钟|没就绪' /root/.local/share/Friday/Logs/friday-server.log | tail -2
    exit 1
  fi
  cpu=$(ps -o %cpu= -p "$pid" | tr -d ' ' | awk '{print int($1)}')
  etime=$(ps -o etime= -p "$pid" | tr -d ' ')
  echo "round $i: alive pid=$pid cpu=$cpu etime=$etime"
  if [ "$cpu" -lt 20 ] 2>/dev/null && [ "$i" -gt 2 ]; then
    echo WARM
    exit 0
  fi
  i=$((i + 1))
  sleep 10
done
echo TIMEOUT
