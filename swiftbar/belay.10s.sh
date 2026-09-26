#!/bin/bash
# SwiftBar plugin: belay usage in your macOS menu bar.
# Install: install SwiftBar, put this file in your SwiftBar plugin folder,
#   chmod +x, and export BELAY_URL / BELAY_MASTER_KEY (or edit the defaults).
set -euo pipefail
URL="${BELAY_URL:-http://127.0.0.1:4000}"
KEY="${BELAY_MASTER_KEY:?set BELAY_MASTER_KEY to your belay bearer key}"
J=$(curl -s -m 3 "$URL/v1/usage" -H "authorization: Bearer $KEY" || echo '{}')
python3 - "$J" <<'PYEOF'
import json, sys, time
try:
    j = json.loads(sys.argv[1])
except Exception:
    print("belay (no response)"); sys.exit()
models = j.get("models", {})
total = sum(m.get("requests", 0) for m in models.values())
failed = sum(m.get("failed", 0) for m in models.values())
events = j.get("events", [])
last = events[0]["text"] if events else "quiet"
print(f"belay {total} req" + (f" | {failed} fail" if failed else ""))
print("---")
for name, m in sorted(models.items(), key=lambda kv: -kv[1].get("requests", 0)):
    ago = ""
    if m.get("lastServed"):
        ago = f" ({max(0, int(time.time() * 1000 - m['lastServed']) // 1000)}s ago)"
    print(f"{name}: {m.get('ok', 0)} ok / {m.get('failed', 0)} fail, {m.get('tokensOut', 0)} out{ago}")
print("---")
print(f"{last}")
print(f"uptime: {j.get('uptimeSec', 0) // 3600}h {(j.get('uptimeSec', 0) % 3600) // 60}m")
print("Open dashboard | href=" + URL + "/")
PYEOF
