#!/bin/sh
cd /root/.local/share/Friday/powers/voice/friday-voice || exit 1
check() {
  want=$1; file=$2
  got=$(sha256sum "$file" 2>/dev/null | awk '{print $1}')
  if [ "$got" = "$want" ]; then echo "ok  $file"; else echo "BAD $file (got $got)"; fi
}
check 4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5 sensevoice-small-q8.gguf
check 1270f2559c495f4e7b6e739541151027d360761a3fda43fc147034f5719f5479 fsmn-vad.gguf
check 394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2 whisper/ggml-large-v3-turbo-q5_0.bin
check be133cb6154ca73cd1d213b1c9496def99ba9c1f7c14cd99f6b350af2eb7963d cosyvoice3/CosyVoice3-2512_Q8_0.gguf
check a6ac6a63997761ae2997373e2ee1c47040854b4b759ea41ec48e4e42df0f4d73 campplus.onnx
