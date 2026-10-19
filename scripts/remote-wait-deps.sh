#!/bin/sh
i=0
while [ $i -lt 60 ]; do
  if grep -q "libdatachannel ok" /tmp/deps.log 2>/dev/null; then
    echo READY
    break
  fi
  i=$((i + 1))
  sleep 5
done
echo "--- tail ---"
tail -4 /tmp/deps.log
du -sh /root/deps/libdatachannel
