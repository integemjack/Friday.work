#!/bin/sh
# 下 voice 的五个模型（power.json 里的清单，放到 friday-voice 同级）
set -e
cd /root/.local/share/Friday/powers/voice/friday-voice

fetch() {
  file=$1; url=$2; size=$3
  if [ -f "$file" ]; then
    echo "skip $file（已在）"
    return
  fi
  echo "fetch $file ($size bytes)"
  mkdir -p "$(dirname "$file")"
  curl -sSL --fail -o "$file.part" "$url" && mv "$file.part" "$file" || { echo "FAILED $file"; return 1; }
  ls -l "$file"
}

fetch "sensevoice-small-q8.gguf" "https://modelscope.cn/models/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/master/sensevoice-small-q8.gguf" 254208320
fetch "fsmn-vad.gguf" "https://modelscope.cn/models/FunAudioLLM/fsmn-vad-GGUF/resolve/master/fsmn-vad.gguf" 1720512
fetch "whisper/ggml-large-v3-turbo-q5_0.bin" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin" 574041195
fetch "cosyvoice3/CosyVoice3-2512_Q8_0.gguf" "https://modelscope.cn/models/Lourdle/Fun-CosyVoice3-0.5B-2512-GGUF/resolve/master/CosyVoice3-2512_Q8_0.gguf" 943933536
fetch "campplus.onnx" "https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/campplus.onnx" 28303423

echo "=== MODELS-DONE ==="
ls -laR --block-size=M . 2>/dev/null | tail -20
