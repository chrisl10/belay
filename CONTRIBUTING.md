# Contributing

- The engine is intentionally a single file. Keep changes inside it unless the
  size genuinely demands a split; propose the split in an issue first.
- Every PR needs: `node --check engine/server.js`, a repro of the bug (or a
  screenshot of the new behavior), and no new runtime dependencies without an issue.
- Translators (request/response/SSE) are inverse pairs: if you touch one side,
  prove the round trip.
- Harness support requests: open an issue with the harness name, its config
  surface (where custom base URLs live), and a wire capture if possible.
- Keep the personal out: no real endpoints, keys, or model pools in examples or
  tests. CI enforces this.
