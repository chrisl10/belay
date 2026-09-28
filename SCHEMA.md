# belay.config.json schema (v1)

The engine validates this at boot and on every hot reload. Unknown fields are
ignored (drop-not-crash). Validation failure = the new config is rejected and
the last known good keeps serving.

## Top-level fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | number | yes (informational) | config schema version |
| `port` | number | no (default 4000) | port to bind; env `FABRIC_PORT` overrides |
| `tailnetIp` | string | no | Tailscale IP to ALSO bind for tailnet access. **Empty/unset = loopback-only** (the bot posture). Never put another machine's IP here. |
| `litellm` | object | no | `{host, port}` of a local LiteLLM for GLM lanes (optional module) |
| `openrouterFallbacks` | string[] | no | model names substituted for the `@openrouter` chain placeholder (Hop 2) |
| `candidates` | object | **yes** | map of model-name → `{class, mods[], lane}`; lane ∈ `gpt` \| `grok` \| `litellm`; mods ⊆ `text,image,video` |
| `chains` | object | no | model-name → ordered hop list (same names as candidates, plus `@openrouter`); the ladder walks this order on 429/401/5xx |
| `images` | object | no | `{default, paidFallback, bestAlias[], grokPrefix}` for `/v1/images/generate` |
| `auto` | object | no | `{question, maxTaskChars}` - the jev/TypeSafe systemOne routing prompt and task slice |
| `requiredKeys` | string[] | no | logical key names this config needs: `typesafe`, `grok-oauth`, `codex-oauth`, `zai`, `openrouter`. The sync job diffs this against keys present on the machine and logs `KEY-ASK` for missing ones. The engine itself ignores this field. |

## Key-ask reference (what each logical key means on a machine)

| Logical key | Machine-local proof | Unlocks |
|---|---|---|
| `typesafe` | `~/.typesafe.key` | jev `auto` routing (without it auto falls back to the heuristic) |
| `grok-oauth` | `~/.grok/auth.json` | grok lane (owner runs `grok` CLI login on that machine; token self-refreshes on use) |
| `codex-oauth` | `~/.codex/auth.json` | gpt lane (owner runs `codex login` on that machine) |
| `zai` | `~/fabric/litellm/secrets/zai.key` | GLM candidates via local LiteLLM |
| `openrouter` | `~/fabric/litellm/secrets/openrouter.key` | Hop 2 fallbacks + paid image fallback via local LiteLLM |

## Rules the validator enforces

- `candidates` non-empty; every candidate needs a known lane and a `mods` array.
- Every `chains` key must be a candidate; every hop must be a candidate or `@openrouter`.
- `litellm`, when present, needs a string `host` and numeric `port`.

## Routing quality fields (auto.*)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `auto.question` | string | capability-first wording | The jev routing question. Default: capability is the constraint, cost the tiebreaker among capable models. |
| `auto.laneBudgetTokens` | number | 500000 | Soft per-lane daily token budget. The engine feeds each candidate's real `projectedRemainingRatio` (tokens-today vs this budget) plus `recentFailures` to jev, so routing avoids nearly-exhausted lanes instead of walking 429s. |
| `auto.maxTaskChars` | number | 2000 | Task slice sent to the routing decision. |

Difficulty: every `auto` request also asks jev to classify the task
(trivial / routine / complex / frontier) in the same call. The route tag
carries it in-stream, e.g. `\u00b7 \ud83d\udca8flash:trivial \u00b7` vs
`\u00b7 \ud83c\udf10glm:frontier \u00b7`, and the log line shows both:
`[auto] typesafe -> glm-5.3 (frontier, 122ms)`.

## Per-candidate display fields

| Field | Type | Meaning |
|---|---|---|
| `candidates.<name>.glyph` | string | Emoji shown in the route tag (class default otherwise; unknown/external routes show a globe). |
| `candidates.<name>.tag` | string | Short name in the route tag (defaults to the model id). |

`routeTag: { "enabled": true }` toggles tagging entirely.

## Operational endpoints (bearer-gated except the dashboard UI)

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | The dashboard (static UI; data fetched client-side with your key). |
| `/v1/health` | GET | uptime, pid, empty-walk count, capture-ring stats. First stop in the troubleshooting runbook. |
| `/v1/usage` | GET | per-model requests/tokens/failures + the ladder event feed. |
| `/v1/config` | GET | the live config. |
| `/v1/config` | POST | validated, atomic config write-back; hot-reloads the router. |
| `/v1/images/generate` | POST | image ladder (subscription lane first, paid fallback). |

Diagnostics: the engine keeps the last 6 raw client-dialect streams under
`BELAY_DATA/captures/` (disable with `BELAY_CAPTURE=0`). Stream bugs are
diagnosed from these bytes; see the troubleshooting runbook pattern.
