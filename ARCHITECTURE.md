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

## Dials: `auto` and `orchestrator`

Two pseudo-models ride the same endpoint. `auto` lets the picker consider
every candidate (cheapest clearly-sufficient, spread across provider pools).
`orchestrator` restricts the picker to `auto.orchestratorModels`, the
frontier-capable class, for long-lived main sessions; spawned subagents stay
on `auto` and may land on cheaper hop-class lanes. `GET /v1/models` lists both
beside the concrete lanes, so harness model pickers discover them.

## Session stickiness (dial-aware)

A session's first request fingerprints it (sha256 of the leading system +
content bytes) and pins the lane the picker chose, so turn 2+ reuses the warm
prompt cache instead of re-routing. A pin records its dial (`auto`,
`orchestrator`, or an explicit model name) and only applies while the request
carries the same dial: switching dials mid-session re-runs the picker and
re-pins on the next turn. Ladder walks and usage updates re-pin the serving
lane but preserve the dial. Pins are in-memory only and expire after two idle
hours. Fingerprinting is prefix-based: two sessions in one project can share a
prefix, which is harmless because the dial check still routes each request
into the class it asked for.

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
