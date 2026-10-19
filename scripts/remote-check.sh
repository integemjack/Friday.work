#!/bin/sh
sh -n /tmp/build.sh && echo "syntax ok"
echo "--- head ---"
head -3 /tmp/build.sh
echo "--- git rewrite ---"
git config --global --get-regexp insteadof || echo "none"
echo "--- build dir ---"
ls /root/friday-build/build 2>/dev/null | head -5 || echo "no build dir"
echo "--- running procs ---"
ps -ef | grep -c cmake
