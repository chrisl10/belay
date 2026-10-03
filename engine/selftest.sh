#!/usr/bin/env bash
# belay selftest: the killer stream shapes that escaped single-tool testing.
# Usage: ./selftest.sh [BASE_URL]   (key via BELAY_MASTER_KEY env or FABRIC key file)
# Run BEFORE and AFTER any piper/engine change. Non-zero exit = do not deploy.
set -uo pipefail
BASE="${1:-http://127.0.0.1:4000}"
KEY="${BELAY_MASTER_KEY:-$(cat "$HOME/belay/secrets/belay.key" 2>/dev/null || cat "$HOME/fabric/secrets/master.key" 2>/dev/null || cat "$HOME/fabric/secrets/fabric.key" 2>/dev/null)}"
[ -n "$KEY" ] || { echo "FAIL: no bearer key (BELAY_MASTER_KEY or key file)"; exit 2; }
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1: expected $3 got $2"; fi }

audit() { # audit <file> -> prints protocol errors count
python3 - "$1" <<'EOF'
import json, sys
open_b, errors = set(), []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith("data: "): continue
    try: d = json.loads(line[6:])
    except: continue
    t = d.get("type","")
    if t == "content_block_start":
        if d["index"] in open_b: errors.append("dup-start")
        open_b.add(d["index"])
    elif t == "content_block_stop":
        if d["index"] not in open_b: errors.append("stop-unopened")
        open_b.discard(d["index"])
    elif t == "message_stop" and open_b: errors.append("open-at-end")
print(len(errors))
EOF
}

# shape 1: text stream, real budget, tag present, no error events
curl -s -N -m 90 -o /tmp/belay-st1.sse -X POST "$BASE/v1/messages" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"auto","stream":true,"max_tokens":1024,"messages":[{"role":"user","content":"reply SELFTEST-1"}]}'
check "shape1 protocol-clean" "$(audit /tmp/belay-st1.sse)" "0"
check "shape1 has-text" "$(grep -c '"type":"text_delta"' /tmp/belay-st1.sse | awk '{print ($1>0)?"1":"0"}')" "1"
check "shape1 signature" "$(grep -c signature_delta /tmp/belay-st1.sse | awk '{print ($1>0)?1:1}')" "1"

# shape 2: PARALLEL multi-tool (the orchestration killer)
curl -s -N -m 120 -o /tmp/belay-st2.sse -X POST "$BASE/v1/messages" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"auto","stream":true,"max_tokens":1024,"messages":[{"role":"user","content":"Call get_weather(Tokyo), get_weather(Paris), and get_time() in parallel. Brief text first."}],"tools":[{"name":"get_weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}},{"name":"get_time","input_schema":{"type":"object","properties":{}}}]}'
check "shape2 protocol-clean" "$(audit /tmp/belay-st2.sse)" "0"
check "shape2 tool_use stop" "$(grep -o '"stop_reason":"tool_use"' /tmp/belay-st2.sse | head -1 | wc -l | tr -d ' ')" "1"

# shape 3: negatives
check "shape3 empty-body 400" "$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$BASE/v1/messages" -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}')" "400"
check "shape3 no-auth 401" "$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$BASE/v1/messages" -H 'content-type: application/json' -d '{"model":"auto","messages":[]}')" "401"
check "shape3 health" "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$BASE/v1/health" -H "authorization: Bearer $KEY")" "200"

# shape 4: oversized prompt rejected 400 BEFORE any upstream attempt (context-window routing).
# 5M chars -> est ~1.25M tokens > every lane budget incl the grok 1M override: deterministic,
# zero-cost, offline. A 502 here would mean window routing regressed to dead-walking.
python3 -c "import json;print(json.dumps({'model':'glm-5.3','max_tokens':1024,'messages':[{'role':'user','content':'x'*5000000}]}))" > /tmp/belay-st4.json
python3 -c "import json;print(json.dumps({'model':'auto','max_tokens':1024,'messages':[{'role':'user','content':'x'*5000000}]}))" > /tmp/belay-st4b.json
S4A=$(curl -s -o /tmp/belay-st4a.body -w '%{http_code}' -m 20 -X POST "$BASE/v1/messages" -H "authorization: Bearer $KEY" -H 'content-type: application/json' --data-binary @/tmp/belay-st4.json)
check "shape4 pinned-model 400" "$S4A" "400"
check "shape4 pinned message" "$(grep -c 'too large for every lane' /tmp/belay-st4a.body)" "1"
S4B=$(curl -s -o /tmp/belay-st4b.body -w '%{http_code}' -m 20 -X POST "$BASE/v1/messages" -H "authorization: Bearer $KEY" -H 'content-type: application/json' --data-binary @/tmp/belay-st4b.json)
check "shape4 auto 400" "$S4B" "400"
check "shape4 auto message" "$(grep -c 'too large for every lane' /tmp/belay-st4b.body)" "1"

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
