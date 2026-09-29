# FAQ

**Is using my ChatGPT/Grok subscription through a router against the terms?**
Maybe, depending on provider and plan. These OAuth lanes are unofficial: your
own credentials, your own machine, no sharing. Read your terms and decide. All
non-OAuth lanes (API keys, LiteLLM, OpenRouter) are ordinary documented API use.

**What does a routing decision cost?**
The jev System One call is a tiny classified pick: on the order of $0.00001 per
decision. Routine tasks routed to an economical model save orders of magnitude
more in token quota than the decision spends. No jev key? A heuristic picker
runs instead and belay keeps working.

**Why does the reasoning summary start with `· 🧠sol ·`?**
That is the route tag: the glyph + short name of the model that served you,
config-driven. It exists because a ladder can serve from a different hop than
the one you asked for, and you should be able to see that at a glance.

**Does the 2048 fallback floor limit my context window?**
No. `auto.fallbackMinTokens` floors the per-response output budget on openrouter fallback requests only (their models spend hidden reasoning tokens before content, so tiny budgets return empty). Your context window - whatever your harness sets, e.g. 1M - is input capacity, is never touched by the engine, and larger output requests pass through uncapped.

**How is this different from LiteLLM?**
They complement each other. LiteLLM is a great OpenAI-compatible proxy; belay
sits above it (or replaces it), adds subscription OAuth lanes, AI-driven model
choice, the exhaustion ladder across providers, three inbound dialects, and the
fleet config pattern.

**Why is the engine a single file?**
So you can read all of it in one sitting before pointing your credentials at it.
No framework, no plugins, no hidden calls.

**Does it phone home?**
To your model providers (obviously) and to the jev decision service for `auto`
routing (your key). That is the whole list.

**Does an invalid config break the router?**
No. Boot refuses without a valid config; hot reloads reject invalid changes and
the last known good keeps serving.

**Which harnesses work?**
Claude Code, Codex, and ZCode have ready-made config snippets. Anything that
speaks Anthropic Messages, OpenAI Chat, or Responses against a custom base URL
works. See HARNESS-ROADMAP.md for the expansion queue.
