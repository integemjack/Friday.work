#!/bin/sh
# state.json 按 PowerManager::loadState 的完整字段重写（version/target/dir/executable/serve/capabilities/title/detail/enabled）
python3 - <<'PY'
import json, os
path = '/root/.local/share/Friday/Powers/state.json'
power_path = '/root/.local/share/Friday/Powers/voice/friday-voice/power.json'
with open(power_path) as f:
    power = json.load(f)
with open(path) as f:
    state = json.load(f)
state.setdefault('powers', {})['voice'] = {
    'version': power['version'],
    'target': power.get('target', 'linux-x64-vulkan'),
    'dir': '/root/.local/share/Friday/Powers/voice/friday-voice',
    'executable': power.get('executable', 'friday-voice'),
    'serve': ['serve', '--device', 'cpu', '--models', '{models}', '--host', '127.0.0.1', '--port', '0', '--token', '{token}', '--parent-stdin'],
    'capabilities': power.get('capabilities', []),
    'title': power.get('title', '本地语音'),
    'detail': power.get('detail', ''),
    'enabled': True,
}
with open(path, 'w') as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
print(json.dumps(state, ensure_ascii=False)[:400])
PY
