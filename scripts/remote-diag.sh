#!/bin/sh
echo "=== attach 试一次（3 秒） ==="
timeout 4 /root/.friday-server/bin/friday-server --attach < /dev/null 2>&1 | head -5
echo "exit=$?"
echo
echo "=== 数据目录里的 socket ==="
ls -la "/root/.local/share/Friday/" 2>/dev/null | grep -i sock
echo
echo "=== 助手开没开 ==="
ls -la /root/.local/share/Friday/Assistant/ 2>/dev/null | head -6
cat /root/.local/share/Friday/Assistant/settings.json 2>/dev/null | head -20
echo
echo "=== 渠道 ==="
cat /root/.local/share/Friday/Assistant/channels.json 2>/dev/null | head -30
