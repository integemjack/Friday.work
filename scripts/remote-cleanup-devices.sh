#!/bin/sh
BIN=/root/.friday-server/bin/friday-server
echo "=== 吊销多余的测试设备，只留正在用的 cd1b432a 和手机 ec650924 ==="
for id in ac459823 ba76d45e 3981ca6c c8cecfa8 274ac0fc 6dde5370 7e09c9b6 0d1b99b1 cc0fecf1; do
  "$BIN" --revoke "$id" 2>&1 | head -1
done
echo
echo "=== 剩下 ==="
"$BIN" --devices 2>&1 | head -10
