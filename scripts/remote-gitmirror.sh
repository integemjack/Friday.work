#!/bin/sh
echo "=== cmake ==="
cmake --version | head -1
echo
echo "=== git clone through mirror ==="
rm -rf /tmp/clonetest
if git -c url."https://ghproxy.net/https://github.com/".insteadOf="https://github.com/" \
      clone --depth 1 --branch v1.5.2 https://github.com/xiph/opus.git /tmp/clonetest 2>&1 | tail -3; then
  echo "clone ok:"
  ls /tmp/clonetest | head -3
else
  echo "clone failed"
fi
