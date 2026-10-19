#!/bin/sh
echo "=== github endpoints ==="
for u in https://github.com https://codeload.github.com https://raw.githubusercontent.com https://objects.githubusercontent.com https://ghproxy.net https://ghfast.top https://mirrors.tuna.tsinghua.edu.cn; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 12 "$u" 2>/dev/null || echo "ERR")
  echo "$u -> $code"
done
echo
echo "=== proxy env ==="
env | grep -i proxy || echo "(none)"
echo
echo "=== other hosts on LAN with common proxy ports? (just local check) ==="
ss -tlnp 2>/dev/null | grep -E ':(7890|7891|8080|1080|10809|20171)' || echo "(nothing listening locally)"
