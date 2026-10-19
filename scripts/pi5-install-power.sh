#!/bin/sh
# Pi5 装 voice Power（arm64-vulkan；Pi5 的 VideoCore VII 有 Vulkan 驱动）+ 模型
# 用法：sh /tmp/pv.sh   （state.json 由 Friday 自己维护的话就不用写；先只装文件）
set -e
IDX=/root/.local/share/Friday/Powers/index.json
URL=$(python3 -c "import json;d=json.load(open('$IDX'));print([t['url'] for t in next(p for p in d['powers'] if p['id']=='voice')['targets'].values() if 'arm64' in t['url']][0])" 2>/dev/null || echo "https://github.com/integemjack/Friday.Powers/releases/download/voice-v0.4.1/voice-0.4.1-linux-arm64-vulkan.tar.gz")
DEST=/root/.local/share/Friday/Powers/voice
mkdir -p "$DEST"
cd "$DEST"
echo "=== download $URL ==="
curl -sSL -o voice.tar.gz "$URL"
echo "=== unpack ==="
tar xzf voice.tar.gz
rm -f voice.tar.gz
ls friday-voice | head -5
echo "=== models ==="
# 模型清单从 power.json 里拿（fetch 逐个下）
python3 - <<'PY' > /tmp/model-list.txt
import json
p = json.load(open('/root/.local/share/Friday/Powers/voice/friday-voice/power.json'))
for m in p.get('models', []):
    print(m['file'], m['url'], m.get('sha256', ''))
PY
while read -r file url sha; do
  [ -f "$file" ] && { echo "skip $file"; continue; }
  echo "fetch $file"
  mkdir -p "$(dirname "$file")"
  curl -sSL -o "$file" "$url"
done < /tmp/model-list.txt
echo "=== done ==="
du -sh /root/.local/share/Friday/Powers/voice
