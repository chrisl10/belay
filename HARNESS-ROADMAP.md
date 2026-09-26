# Harness roadmap

Fabric's engine never changes to add a harness. Any coding agent that accepts a
custom base URL for an OpenAI-compatible, Anthropic-compatible, or Responses-API
endpoint can ride an already-shipped dialect (`/v1/chat/completions`,
`/v1/messages`, `/v1/responses`). Each new harness is therefore **one module**:
detect the binary, write its provider config (backup-first), add a verification
snippet to the runbook. Router work: zero.

## Shipped out of the box (`bootstrap.sh harness`)

| Harness | Config surface | Dialect used |
|---|---|---|
| Claude Code | `~/.claude/settings.json` env | anthropic `/v1/messages` |
| Codex | `~/.codex/config.toml` provider + key env | responses `/v1/responses` |
| ZCode | `~/.zcode/v2/provider_config.json` | anthropic `/v1/messages` |

## Expansion queue (add as issues; or install a harness and build its module)

Priority-ordered candidates. "Check" = the one thing to verify before writing the module.

1. **Grok CLI** - xAI's official CLI; grok-oauth is already a fabric lane.
   Check: does it honor a base-URL override (env/config)? If yes -> openai-chat
   dialect, one of the cheapest modules. If no -> needs a wrapper or upstream
   request; note it and move on.
2. **OpenCode** - popular OSS terminal agent with documented custom-provider
   config (OpenAI- and Anthropic-shaped endpoints). Likely a very easy module.
3. **Pi** - agent harness with provider-config support; verify its provider
   schema, then map to the nearest dialect.
4. **Cursor** - the IDE-class case (custom OpenAI-compatible base URL). Higher
   effort: GUI-managed config, per-project scoping; do after the terminal agents.
5. **Hermes / OpenClaw** - owner's agent runtimes; same pattern, config-format
   check first.
6. **DeepSeek CLI** - if used as a harness (not just a provider via LiteLLM);
   OpenAI-compatible, same as grok-cli pattern.

## Intake paths

- **Issue-driven (preferred):** each harness gets one issue in this repo -
  "harness-X module: config format, detection, verification" - and lands in
  `bootstrap.sh harness` when built.
- **Ad-hoc:** install the harness on a fleet machine, work out its config by
  hand, then codify what worked into a module. The hand-worked notes become the issue body.

Both paths end in the same place: a module, a runbook snippet, and a line in this table.
