#!/bin/sh
# Pi5 环境探测（ASCII only，sh 兼容）
echo "=== host ==="
hostname; whoami; uname -s -m
echo "=== cpu ==="
grep -m1 'model name\|Model' /proc/cpuinfo
grep -m1 flags /proc/cpuinfo | tr ' ' '\n' | grep -E '^(avx|fma|sse4)' | sort -u | head -5
grep -c processor /proc/cpuinfo
echo "=== mem/disk ==="
free -h | head -2
df -h /root | tail -1
echo "=== tools ==="
for t in cmake ninja g++ make git curl python3; do printf '%-10s' "$t"; command -v $t || echo MISSING; done
echo "=== net ==="
curl -sS -o /dev/null -w "github: %{http_code}\n" --max-time 15 https://github.com || true
curl -sS -o /dev/null -w "ghproxy: %{http_code}\n" --max-time 15 https://ghproxy.net || true
echo "=== friday ==="
ls ~/.friday-server/bin 2>/dev/null && ~/.friday-server/bin/friday-server --status 2>/dev/null | head -5 || echo "no friday-server"
command -v friday >/dev/null && friday --version || true
