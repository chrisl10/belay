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
