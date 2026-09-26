# Architecture

One file (`engine/server.js`, ~1,100 lines), zero frameworks. This doc is the map.

```
 harness (any dialect)                     providers
 ─────────────────────                    ──────────────────────────────
 Claude Code   /v1/messages ─┐            ┌─ grok lane: api.x.ai chat (your OAuth)
 Codex         /v1/responses ┼─▶ belay ───┼─ gpt lane: chatgpt backend (your OAuth)
 openai-tools  /v1/chat/...  ─┤    │       ├─ litellm lane: local LiteLLM (GLM etc.)
                              │    │       └─ @openrouter: Hop 2 paid fallbacks
            dialect by URL path    │
            (deterministic)        ▼
                        1. validate (400, never crash)
                        2. model resolution: auto | candidate | openrouter-*
                        3. auto: jev System One picks cheapest sufficient
                        4. ladder: walk the chain on 429/401/403/5xx
                        5. translate response back to the client dialect
                        6. route tag rides the reasoning summary
```

## Dialects (inbound)

| Path | Schema | Client examples |
|---|---|---|
| `POST /v1/messages` | Anthropic Messages | Claude Code |
| `POST /v1/chat/completions` | OpenAI Chat | most tools |
| `POST /v1/responses` | OpenAI Responses | Codex |

Dialect selection is by URL path only: deterministic, no body sniffing. Every
lane natively produces an internal Anthropic shape; the edge translators
(`anthropicToOpenAIChat`, `anthropicToResponses`) convert JSON and SSE to the
client dialect. Streaming is translated per event.

## The ladder

Each candidate has a chain (its own fallback order, `@openrouter` expands to the
Hop-2 list). On failure (429/401/403/5xx, empty output, upstream error) the
ladder walks. Streams that die mid-flight are the reason Hop-1-first matters:
the walk happens before the first token whenever possible. The serving hop is
visible via the route tag and the `[ladder] a -> served by b` log line.

## jev (the AI in the middle)

`model: "auto"` asks the jev System One decision layer to pick one candidate:
the task's tail (last ~2k chars) plus each candidate's class/capabilities go in;
a choice comes back (~100-200ms, ~$0.00001). No jev key? A heuristic fallback
(short task -> fast candidate) keeps the router alive.

## Route tag

Whoever serves stamps the reasoning: `· glyph+tag[:effort] ·`, config-driven per
candidate (glyph + short tag), class defaults otherwise, 🌍 for unknown/external.
In streams it rides a leading thinking delta; in JSON it prefixes the thinking
block (a tag-only thinking block is prepended when the model produced none).
Downstream harnesses render it wherever they show reasoning.

## Fleet pattern (config in git)

The engine hot-reloads its config on file change and rejects invalid configs
(last known good keeps serving). That is the entire primitive the fleet uses: a
git repo holds the config, machines pull it on a timer, self-setup via a
bootstrap script, and a `KEY-ASK` line reports missing credentials. See the
belay fleet template link in the README discussions.
