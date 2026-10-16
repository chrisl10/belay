# Changelog

## Unreleased

- Receipt aging with cache-stable batching (PRD-010 Stage 1; patterns adapted from SuperHelix77/HELIX-1.0, MIT): old `tool_result` blocks that the model has already acted on are rewritten into compact receipts (bytes, head/tail preview, recovery handle) with the exact original retained in a new content-addressed AES-256-GCM store under the data dir (verify-on-retain, TTL + quota guarded). Byte-identical duplicate results with identical call signatures collapse to two-line duplicate receipts. Rewrites commit in batches (>= 8 results or >= 16 KB saved, defaults) so the request prefix stays byte-stable and provider prompt-cache reuse is preserved; committed rewrites replay byte-identically per session. The newest result frontier (<= 32 KB) and security evidence (CVE ids, private keys, vulnerability findings) are never aged, `messages[0]` is never touched (fingerprint stability), and the client's own compaction requests are skipped. Default OFF: enable via `receiptAging.enabled` in config, per-request `x-receipt-aging: 1|0` (header wins), or `BELAY_RECEIPT_AGING=on|off`. New `GET /v1/receipt/<handle>` (bearer auth) recovers an exact original; `/v1/usage` gains an `aging` block. Aging never fails a request: any pass error disables it for that request.
- selftest: new shape 7 (`node server.js --selfcheck-aging`, 11 internal checks: store roundtrip + verify-on-retain, acted-after invariant, messages[0] untouched, frontier protection, security-evidence preservation, tiny-result floor, duplicate dedup, cache-stable defer/commit/byte-stable replay) and shape 8 (live header-gated aging through a real lane: protocol-clean response + `/v1/usage` aging.applied advance).
- Native grok OAuth refresh (pattern ported from askalf/dario, MIT): the engine refreshes the grok subscription token itself via `auth.x.ai/oauth2/token` ~30 minutes before expiry (10-minute checks), single-flight with atomic `auth.json` rotation (the provider rotates the refresh token on every grant), with a 30-minute dead-out and a `KEY-ASK grok-oauth` log/meter event on terminal rejection. The reactive 401/403 path now forces a native refresh instead of shelling out to the legacy `grok-refresh.sh` burn-a-query script, which is retired along with its daily launchd job.
- Session affinity bounds (dario port): the sticky-lane map now carries at most 2000 fingerprints, evicting the oldest-seen decile on lookup, and idle entries live 6 hours from last use instead of 2.
- selftest: new shape 5 (grok auth freshness inside the 30-minute margin) and shape 6 (same conversation prefix must land on the same lane: route-tag equality across two turns).

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
