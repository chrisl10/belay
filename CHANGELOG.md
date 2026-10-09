# Changelog

## Unreleased

- Economic-strata routing: all subscription lanes form one zero-marginal-cost stratum; among equally-capable candidates the picker prefers the provider pool with the most unused daily capacity. Pay-as-you-go stays the terminal fallback.
- `orchestrator` pseudo-model: a second dial whose picker is restricted to `auto.orchestratorModels` for long-lived main sessions; `auto` remains the everything dial.
- Orchestrator primary tier (`auto.orchestratorPrimary`): astra/sol hold the main-session seat whenever any of them can serve; `glm-5.3` remains the backup orchestrator and engages only when no primary can (quota, cooldown, or window). Orchestrator sessions walk only within the class, never to hop-class or pay-as-you-go lanes.
- Dial-aware session stickiness: pins record their dial (auto / orchestrator / explicit model), cache-warm applies only on dial match, and switching dials mid-session re-picks and re-pins on the next turn. Fixes cross-session pin inheritance when two sessions share a prompt prefix.
- Two-strike quota breaker: the first `usage_limit_reached` walks the ladder to a family sibling; the second inside the window cools the lane for 10 minutes; any successful serve resets the strikes.
- Per-pool daily token budgets (`auto.laneBudgetTokensPerPool`) on top of per-lane budgets; pay-as-you-go pools are exempt.
- Stream metering: day-pool token usage now counts streaming responses, including x.ai usage chunks that ship empty `choices` arrays.
- `GET /v1/models` returns the `auto` and `orchestrator` pseudo-models alongside the concrete lanes (upstream auth forwarded).

## 0.1.0 (2026-09-25)

First public release.

- One endpoint, three inbound dialects: Anthropic Messages, OpenAI Chat Completions, OpenAI Responses (stream + non-stream)
- jev-driven `auto` model choice with heuristic fallback
- Provider exhaustion ladder with config-defined chains and `@openrouter` Hop-2 expansion
- Route tags: the reasoning summary carries `· glyph+tag[:effort] ·` for the serving hop
- Native subscription lanes: Grok CLI OAuth, ChatGPT/Codex OAuth; LiteLLM lane for proxies
- Image generation endpoint (`/v1/images/generate`) with a subscription-first + paid fallback ladder
- Hot-reloading config with last-known-good rejection; loopback-only default bind
- Fleet pattern: config in git, machines self-setup, 15-minute sync (see discussions)
