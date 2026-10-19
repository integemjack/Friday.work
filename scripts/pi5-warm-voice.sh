#!/bin/sh
# 等 friday-voice serve 预热完（Pi5 上约 3-4 分钟），期间不被杀（若 Friday 2 分钟判死会自动再拉）
i=0
while [ $i -lt 50 ]; do
  pid=$(ps -eo pid,args | grep "friday-voice serve" | grep -v grep | awk '{print $1}' | head -1)
  if [ -z "$pid" ]; then
    echo "VOICE-DIED（等 Friday 重新拉起）"
    sleep 15
    i=$((i + 1))
    continue
  fi
  etime=$(ps -o etime= -p "$pid" | tr -d ' ')
  cpu=$(ps -o %cpu= -p "$pid" | tr -d ' ')
  echo "alive pid=$pid etime=$etime cpu=$cpu"
  # 预热完成的标志：CPU 掉下来（加载模型是满核的）
  high=$(echo "$cpu" | awk '{print int($1)}')
  if [ "$etime" | awk -F: '{print $1}' ] >/dev/null 2>&1; then :; fi
  if [ "$high" -lt 30 ] 2>/dev/null && [ "${etime%%-*}" != "$etime" -o "${etime#*:}" != "$etime" ]; then
    echo WARMED-UP
    exit 0
  fi
  i=$((i + 1))
  sleep 10
done
echo TIMEOUT
