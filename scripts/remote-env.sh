#!/bin/sh
echo "=== 工具链 ==="
for t in cmake ninja g++ make git pkg-config curl tar; do
  printf '%-12s' "$t"
  command -v "$t" 2>/dev/null || echo "(missing)"
done
echo
echo "=== Qt ==="
ls -d /root/aqtenv 2>/dev/null && ls /root/aqtenv | head -5
ls /usr/lib/x86_64-linux-gnu/cmake 2>/dev/null | grep -i '^Qt6' | head -8
echo
echo "=== 资源 ==="
free -g | head -2
df -h /root | tail -1
nproc
echo
echo "=== 已装的 Friday ==="
ls /root/.local/opt/Friday/usr/bin 2>/dev/null | head
cat /root/.local/opt/Friday/usr/share/applications/*.desktop 2>/dev/null | head -3
