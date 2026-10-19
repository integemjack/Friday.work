#!/bin/sh
cd /root/.local/share/Friday/Powers/voice/0.4.1-linux-arm64-vulkan/models || exit 1
while read -r f u s; do
  if [ -f "$f" ]; then
    echo "skip $f"
    continue
  fi
  echo "fetch $f ($s)"
  mkdir -p "$(dirname "$f")"
  curl -sSL -o "$f" "$u" && echo "ok $f"
done < /tmp/ml.txt
echo MODELS-DONE
