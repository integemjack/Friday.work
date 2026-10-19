#!/bin/sh
echo "=== tail build.log ==="
tail -6 /root/build.log 2>/dev/null
echo
echo "=== cmake procs ==="
ps -ef | grep -c "[c]make"
echo "=== binary ==="
ls -l /root/friday-build/build/friday-headless 2>/dev/null || echo "not yet"
echo "=== deps fetched ==="
ls /root/friday-build/build/_deps 2>/dev/null | head -10
