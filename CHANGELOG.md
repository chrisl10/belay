# Changelog

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
