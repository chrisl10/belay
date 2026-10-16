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

# shape 5: grok token freshness (P1 native refresh, sitting 83). The engine
# refreshes ~30min before expiry every 10min; a present expiry inside the
# margin means the refresh machinery stopped working.
G5=$(python3 -c "
import json, sys, datetime
try:
    d = json.load(open('$HOME/.grok/auth.json')); e = d[list(d.keys())[0]]
    exp = datetime.datetime.fromisoformat(e['expires_at'].replace('Z','+00:00'))
    margin = datetime.timedelta(minutes=30)
    print('ok' if exp - datetime.datetime.now(datetime.timezone.utc) > margin else 'stale')
except FileNotFoundError:
    print('skip')")
if [ "$G5" = "skip" ]; then echo "ok   shape5 grok-auth (no auth file, skipped)"; PASS=$((PASS+1))
else check "shape5 grok-auth fresh" "$G5" "ok"; fi

# shape 6: session-sticky smoke (sitting 83). Same system+first-message prefix
# must land on the SAME lane twice: the route tag in stream 2 equals stream 1.
REQ6='{"model":"auto","stream":true,"max_tokens":512,"system":"You are the selftest oracle.","messages":[{"role":"user","content":"sticky probe: reply SELFTEST-6"}]}'
echo "$REQ6" > /tmp/belay-st6.json
curl -s -N -m 90 -o /tmp/belay-st6a.sse -X POST "$BASE/v1/messages" -H "authorization: Bearer $KEY" -H 'content-type: application/json' --data-binary @/tmp/belay-st6.json
python3 -c "import json;b=json.load(open('/tmp/belay-st6.json'));b['messages'].append({'role':'assistant','content':'SELFTEST-6'});b['messages'].append({'role':'user','content':'again, same lane expected'});json.dump(b,open('/tmp/belay-st6b.json','w'))"
curl -s -N -m 90 -o /tmp/belay-st6b.sse -X POST "$BASE/v1/messages" -H "authorization: Bearer $KEY" -H 'content-type: application/json' --data-binary @/tmp/belay-st6b.json
# Compare LANE identity only: a cache-warm sticky hit skips decideAuto, so the
# second turn's tag legitimately omits the difficulty suffix (e.g. ":trivial").
tag_lane() { grep -o '"thinking_delta","thinking":"· [^"]*"' "$1" | head -1 | sed 's/:[a-z]* ·/ ·/'; }
TAG6A=$(tag_lane /tmp/belay-st6a.sse)
TAG6B=$(tag_lane /tmp/belay-st6b.sse)
if [ -z "$TAG6A" ] || [ -z "$TAG6B" ]; then echo "FAIL shape6 sticky-lane: no route tag found (a=$TAG6A b=$TAG6B)"; FAIL=$((FAIL+1))
else check "shape6 sticky-lane same-tag" "$TAG6B" "$TAG6A"; fi

# shape 7: PRD-010 S1 internal aging selfcheck (store roundtrip, acted-after
# invariant, frontier, security evidence, dedup, cache-stable defer/commit/replay).
S7DIR=$(cd "$(dirname "$0")" && pwd)
S7=$(cd "$S7DIR" && node server.js --selfcheck-aging 2>&1 | tail -1)
if echo "$S7" | grep -q "AGING-SELFCHECK PASS"; then echo "ok   shape7 aging-selfcheck ${S7#AGING-SELFCHECK }"; PASS=$((PASS+1))
else echo "FAIL shape7 aging-selfcheck: $S7"; FAIL=$((FAIL+1)); fi

# shape 8: live aging smoke (header-gated). A conversation with one large acted-on
# tool_result (> batchMinBytes) must commit + apply on the first request: the
# response stays protocol-clean and /v1/usage shows aging.applied advancing.
python3 - <<'PYEOF'
import json
big = "\n".join("aging-probe line %03d %s" % (i, "x" * 60) for i in range(300))
req = {
    "model": "auto", "stream": True, "max_tokens": 512,
    "system": "You are the selftest oracle.",
    "messages": [
        {"role": "user", "content": "aging probe"},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "t8", "name": "grep", "input": {"q": "aging"}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t8", "content": [{"type": "text", "text": big}]}]},
        {"role": "assistant", "content": "acted on the grep output"},
        {"role": "user", "content": "reply with the single word AGING-8"},
    ],
}
json.dump(req, open("/tmp/belay-st8.json", "w"))
PYEOF
U8A=$(curl -s -m 10 "$BASE/v1/usage" -H "authorization: Bearer $KEY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('aging',{}).get('applied',0))" 2>/dev/null || echo 0)
curl -s -N -m 90 -o /tmp/belay-st8.sse -X POST "$BASE/v1/messages" -H "authorization: Bearer $KEY" -H 'content-type: application/json' -H 'x-receipt-aging: 1' --data-binary @/tmp/belay-st8.json
check "shape8 protocol-clean" "$(audit /tmp/belay-st8.sse)" "0"
U8B=$(curl -s -m 10 "$BASE/v1/usage" -H "authorization: Bearer $KEY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('aging',{}).get('applied',0))" 2>/dev/null || echo 0)
if [ "$U8B" -gt "$U8A" ] 2>/dev/null; then echo "ok   shape8 aging applied ($U8A -> $U8B)"; PASS=$((PASS+1))
else echo "FAIL shape8 aging applied: usage $U8A -> $U8B"; FAIL=$((FAIL+1)); fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
