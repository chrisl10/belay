# QUICKSTART: zero to first routed request

## 0. Prerequisites

- Node.js >= 18
- One model credential to start with. Any one of:
  - an OpenAI-compatible API key (via LiteLLM or any proxy), or
  - a ChatGPT subscription (Codex CLI logged in on this machine), or
  - a Grok subscription (Grok CLI logged in on this machine)

## 1. Get the engine

```bash
git clone https://github.com/chrisl10/belay && cd belay/engine
npm install
```

## 2. Minimal config

Save as `~/belay/belay.config.json` (or anywhere; pass `BELAY_CONFIG=/path`):

```json
{
  "version": 1,
  "candidates": {
    "my-frontier": { "class": "frontier", "mods": ["text"], "lane": "litellm", "glyph": "🚀", "tag": "frontier" },
    "my-fast":     { "class": "fast",     "mods": ["text"], "lane": "litellm", "glyph": "⚡", "tag": "fast" }
  },
  "chains": {
    "my-frontier": ["my-fast", "@openrouter"],
    "my-fast":     ["my-frontier", "@openrouter"]
  },
  "routeTag": { "enabled": true }
}
```

`lane: "litellm"` means the model is served by a local LiteLLM (or any
OpenAI-compatible proxy) on `127.0.0.1:4001` whose model list defines
`my-frontier` / `my-fast`. belay also ships native lanes: `lane: "grok"` (Grok
CLI OAuth on this machine) and `lane: "gpt"` (ChatGPT/Codex OAuth on this
machine).

## 3. Run it

```bash
BELAY_MASTER_KEY=pick-a-secret BELAY_CONFIG=$HOME/belay/belay.config.json node server.js
```

## 4. First routed request

```bash
curl -s -X POST http://127.0.0.1:4000/v1/messages \
  -H "authorization: Bearer pick-a-secret" \
  -H 'content-type: application/json' \
  -d '{"model":"auto","max_tokens":512,"messages":[{"role":"user","content":"What is 6*7? Brief reasoning."}]}'
```

`model: "auto"` means the jev decision layer picks the candidate. Look at the
`thinking` block: it opens with the route tag (e.g. `· ⚡fast ·`) telling you
who served. Without a jev key, a heuristic picker takes over and belay still works.

## 5. Point your harness at it

- **Claude Code** (`~/.claude/settings.json` env): `ANTHROPIC_BASE_URL=http://127.0.0.1:4000`, `ANTHROPIC_AUTH_TOKEN=<your key>`, `ANTHROPIC_MODEL=auto`
- **Codex** (`~/.codex/config.toml`): provider with `base_url = "http://127.0.0.1:4000/v1"`, `wire_api = "responses"`, `env_key = "BELAY_MASTER_KEY"` (or your env name), then `model_provider = "<provider>"`, `model = "auto"`
- **ZCode**: custom provider, type `anthropic-messages`, base URL `http://127.0.0.1:4000`

## 6. Watch the ladder

Exhaust a lane (or set a bogus `api_base`) and re-request: the log walks the
chain and the client never sees the failure.

```
[ladder] my-frontier failed: 502
[ladder] my-frontier -> served by my-fast
```

Next: grow the config (SCHEMA.md), add your subscriptions as native lanes, and
check the route tag in your harness's reasoning display.
