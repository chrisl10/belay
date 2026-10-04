// Harness test: direct-lane keepalive (2026-10-03 "Request timed out" fix).
// Slices the SSE stream opener out of server.js and verifies: keepalive mode
// primes headers + message_start immediately, emits ping events on an
// interval, stops cleanly; lazy mode still writes nothing until content.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const start = src.indexOf("function sseWrite");
const end = src.indexOf("function emitSseError");
if (start < 0 || end < 0 || end <= start) { console.log("FAIL: stream helper block not found"); process.exit(1); }
const block = src.slice(start, end);

function fakeRes() {
  const r = {
    chunks: [], headersSent: false, writableEnded: false, destroyed: false,
    _on: {},
    writeHead() { r.headersSent = true; return r; },
    write(c) { r.chunks.push(String(c)); return true; },
    end(c) { if (c) r.chunks.push(String(c)); r.writableEnded = true; return r; },
    on(ev, fn) { (r._on[ev] = r._on[ev] || []).push(fn); },
    emit(ev) { (r._on[ev] || []).forEach((f) => f()); },
  };
  return r;
}

const h = new Function("setInterval", "clearInterval", "console", block + "\nreturn { sseWrite, startKeepalivePings, openAnthropicStream };")(setInterval, clearInterval, console);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FAIL " + name + ": expected " + JSON.stringify(want) + " got " + JSON.stringify(got)); }
};

// keepalive stream: immediate prime + interval pings, then stop
{
  const res = fakeRes();
  const s = h.openAnthropicStream(res, "gpt-6.1-sol", "· tag ·", true, true);
  check("keepalive primes immediately", res.chunks.some((c) => c.includes("message_start")), true);
  check("keepalive writes tag block", res.chunks.some((c) => c.includes("thinking_delta")), true);
  check("no pings before interval", res.chunks.some((c) => c.includes("event: ping")), false);
  const stop = h.startKeepalivePings(res, 15); // second timer with short interval for observation
  setTimeout(() => {
    check("pings flow on interval", res.chunks.filter((c) => c.includes("event: ping")).length >= 2, true);
    stop();
    const n = res.chunks.filter((c) => c.includes("event: ping")).length;
    setTimeout(() => {
      check("stop() halts pings", res.chunks.filter((c) => c.includes("event: ping")).length, n);
      res.emit("close"); // stream-owned timer also stops on close
      check("close listener wired", Array.isArray(res._on.close), true);
      s.closeAll();
      if (s.stopPings) s.stopPings();

      // lazy stream (litellm lanes): zero bytes until content
      const res2 = fakeRes();
      const s2 = h.openAnthropicStream(res2, "glm-5.3", "· tag ·", true);
      check("lazy writes nothing at open", res2.chunks.length, 0);
      const idx = s2.openBlock({ type: "text", text: "" });
      check("lazy primes on first block", [res2.chunks.some((c) => c.includes("message_start")), idx, res2.chunks.some((c) => c.includes("thinking_delta"))], [true, 1, true]); // tag block takes index 0, text opens as 1
      s2.closeBlock(idx); s2.closeAll();

      console.log("-----");
      console.log("PASS=" + pass + " FAIL=" + fail);
      process.exit(fail ? 1 : 0);
    }, 45);
  }, 45);
}
