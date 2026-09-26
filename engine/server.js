// belay v0.1.0 - one endpoint for every AI subscription.
// Config-driven provider ladder + an AI in the middle (jev) + SSE translation.
// Public engine; your config stays yours.
const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { PassThrough } = require("stream");
const { TypeSafeClient, choice } = require("@typesafe-ai/sdk");

// ---------- PRD-002 F1: config-driven routing ----------
// Everything that varies per machine (candidates, chains, lanes, images) lives in
// fabric.config.json; the engine code stays generic. Hot-reloaded on mtime change;
// an invalid config is rejected and the last known good keeps serving.
// Portable paths: everything is $HOME-relative. belay env names are primary;
// FABRIC_* aliases keep existing fleet deployments running untouched.
const H = os.homedir();
const CONFIG_PATH = process.env.BELAY_CONFIG || process.env.FABRIC_CONFIG || path.join(H, "belay", "belay.config.json");
let cfg = null, cfgMtimeMs = 0, CANDIDATES = {}, OR = [], CHAINS = {};
function validateConfig(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "config: not an object";
  if (!c.candidates || typeof c.candidates !== "object" || Array.isArray(c.candidates) || !Object.keys(c.candidates).length) return "candidates: missing or empty";
  for (const [name, cd] of Object.entries(c.candidates)) {
    if (!cd || typeof cd !== "object") return "candidate " + name + ": not an object";
    if (!["gpt", "grok", "litellm"].includes(cd.lane)) return "candidate " + name + ": unknown lane";
    if (!Array.isArray(cd.mods)) return "candidate " + name + ": mods must be an array";
  }
  for (const [name, chain] of Object.entries(c.chains || {})) {
    if (!Array.isArray(chain)) return "chain " + name + ": must be an array";
    if (!c.candidates[name]) return "chain " + name + ": no matching candidate";
    for (const hop of chain) if (hop !== "@openrouter" && !c.candidates[hop]) return "chain " + name + ": unknown hop " + hop;
  }
  if (c.litellm && (typeof c.litellm.host !== "string" || typeof c.litellm.port !== "number")) return "litellm: bad shape";
  return null;
}
function applyConfig(c) {
  cfg = c;
  CANDIDATES = c.candidates;
  OR = Array.isArray(c.openrouterFallbacks) ? c.openrouterFallbacks : [];
  CHAINS = {};
  for (const [k, v] of Object.entries(c.chains || {})) CHAINS[k] = v.flatMap((h) => (h === "@openrouter" ? OR : [h]));
}
function loadConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch (e) { console.log("[config] unreadable (" + String((e && e.message) || e).slice(0, 80) + "): keeping last known good"); return; }
  const err = validateConfig(raw);
  if (err) { console.log("[config] rejected: " + err + " - keeping last known good"); return; }
  try { cfgMtimeMs = fs.statSync(CONFIG_PATH).mtimeMs; } catch {}
  applyConfig(raw);
  console.log("[config] loaded v" + (raw.version || "?") + ": " + Object.keys(CANDIDATES).length + " candidates, " + Object.keys(CHAINS).length + " chains");
}
function refreshConfig() { try { if (fs.statSync(CONFIG_PATH).mtimeMs !== cfgMtimeMs) loadConfig(); } catch {} }
loadConfig();
if (!cfg) { console.error("[config] no valid config at " + CONFIG_PATH + " - refusing to start"); process.exit(1); }

// ---------- PRD-005: usage metering + dashboard ----------
// Per-lane-attempt counters, persisted under the data dir; /v1/usage and the
// dashboard read this. Streams count requests/outcomes; non-stream counts tokens.
const DATA_DIR = process.env.BELAY_DATA || process.env.FABRIC_DATA || path.join(H, "belay");
const USAGE_PATH = path.join(DATA_DIR, "usage.json");
const USAGE = { startedAt: Date.now(), models: {}, events: [] };
try { const d = JSON.parse(fs.readFileSync(USAGE_PATH, "utf8")); USAGE.models = d.models || {}; USAGE.events = (d.events || []).slice(0, 50); } catch {}
function meter(model, outcome, tokens) {
  const m = USAGE.models[model] || (USAGE.models[model] = { requests: 0, ok: 0, failed: 0, tokensIn: 0, tokensOut: 0, lastServed: 0 });
  m.requests++;
  if (outcome === "ok") { m.ok++; m.lastServed = Date.now(); if (tokens) { m.tokensIn += tokens.in || 0; m.tokensOut += tokens.out || 0; } }
  else if (outcome === "fail") m.failed++;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(USAGE_PATH, JSON.stringify({ startedAt: USAGE.startedAt, models: USAGE.models, events: USAGE.events })); } catch {}
}
function meterEvent(text) { USAGE.events.unshift({ t: Date.now(), text: String(text).slice(0, 160) }); if (USAGE.events.length > 50) USAGE.events.pop(); }

const PORT = process.env.BELAY_PORT || process.env.FABRIC_PORT || cfg.port || 4000;
const TS_IP = process.env.BELAY_TS_IP || process.env.FABRIC_TS_IP || cfg.tailnetIp || ""; // empty = loopback-only bind (bot machines)
const LITELLM = { host: (cfg.litellm && cfg.litellm.host) || "127.0.0.1", port: (cfg.litellm && cfg.litellm.port) || 4001 };
const KEY = fs.readFileSync(path.join(H, ".typesafe.key"), "utf8").trim();
const client = new TypeSafeClient({ apiKey: KEY });
// PRD-001 security HIGH-1: fabric validates the bearer token on every endpoint itself
// (the client doc already promises this; Tailscale alone is not authN).
// Bearer key: BELAY_MASTER_KEY / FABRIC_MASTER_KEY env, or a key file under $HOME.
const MASTER_KEY_PATH = process.env.BELAY_MASTER_KEY || process.env.FABRIC_MASTER_KEY
  || [path.join(H, "belay", "secrets", "belay.key"), path.join(H, "fabric", "secrets", "fabric.key"), path.join(H, "fabric", "secrets", "master.key")].find((p) => fs.existsSync(p))
  || path.join(H, "belay", "secrets", "belay.key");
const MASTER_KEY = fs.readFileSync(MASTER_KEY_PATH, "utf8").trim();
if (!MASTER_KEY) throw new Error("empty master key"); // belt-and-braces: an empty key would authorize "Bearer "
const MAX_BODY = 32 * 1024 * 1024; // MEDIUM-2: 32 MB cap, oversized bodies get 413 not OOM
function authorized(req) {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return false;
  const got = Buffer.from(h.slice(7));
  const want = Buffer.from(MASTER_KEY);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function tokens() {
  let grok = "";
  try { const d = JSON.parse(fs.readFileSync(path.join(H, ".grok", "auth.json"), "utf8")); grok = Object.values(d)[0].key; } catch {}
  let gpt = "", acct = "";
  try { const d = JSON.parse(fs.readFileSync(path.join(H, ".codex", "auth.json"), "utf8")); gpt = (d.tokens || {}).access_token || ""; acct = d.chatgpt_account_id || ""; } catch {}
  return { grok, gpt, acct };
}

// ---------- PRD-001a: shared request validation (A-1/A-5) ----------
// Single validation entry point for message endpoints. Returns:
//   { ok: true, model }                    -> fabric-managed model (auto / candidate / openrouter-*)
//   { ok: true, passthrough: true, model } -> present string model LiteLLM handles (passthrough preserved)
//   { ok: false, message }                 -> malformed body, caller must HTTP 400
function validateMessageBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "request body must be a JSON object" };
  }
  const model = body.model;
  if (model === undefined || model === null || typeof model !== "string") {
    return { ok: false, message: "model: required field missing or not a string" };
  }
  if (model === "auto" || CANDIDATES[model] || model.startsWith("openrouter")) {
    return { ok: true, model };
  }
  return { ok: true, passthrough: true, model };
}

function sendInvalidRequest(res, message) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "invalid_request_error", message } }));
}

// PRD-001b: openai-shaped error responses for the /v1/chat/completions dialect.
function sendOpenAIError(res, status, message) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "invalid_request_error", code: String(status) } }));
}

// messages is client-controlled JSON; only iterate it when it is actually an array.
const safeMessages = (messages) => (Array.isArray(messages) ? messages : []);

// ---------- route tag: the reasoning summary carries the routed identity ----------
// e.g. "· 🚀astra:low ·" - one glyph per route, config-driven; external fallbacks
// show their own route. Injected into the thinking/reasoning content, stream and JSON.
const CLASS_GLYPHS = { frontier: "🚀", workhorse: "🧠", fast: "⚡", external: "🌍" };
function routeTagFor(model, effort) {
  if (!cfg.routeTag || cfg.routeTag.enabled === false) return "";
  const cd = CANDIDATES[model];
  const glyph = (cd && cd.glyph) || CLASS_GLYPHS[(cd && cd.class)] || CLASS_GLYPHS.external;
  const name = (cd && cd.tag) || model;
  return "· " + glyph + name + (effort ? ":" + effort : "") + " ·";
}
function applyRouteTag(anth, tag) { // non-stream: prefix the first thinking block, else prepend a tag-only one
  if (!tag) return anth;
  const blocks = Array.isArray(anth && anth.content) ? anth.content : [];
  const th = blocks.find((b) => b && b.type === "thinking");
  if (th) th.thinking = tag + "\n" + th.thinking;
  else blocks.unshift({ type: "thinking", thinking: tag, signature: "na" });
  return anth;
}

// error -> short string without assuming Error shape (crash-class guard)
const errText = (e) => String((e && e.message) || e);

function detectModalities(messages) {
  let image = false, video = false;
  for (const m of safeMessages(messages)) {
    const c = m && m.content;
    if (Array.isArray(c)) for (const b of c) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "image") image = true;
      if (b.type === "video") video = true;
    }
  }
  return { image, video };
}

async function decideAuto(messages) {
  const task = safeMessages(messages).filter((m) => m && typeof m === "object").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n").slice(-4000);
  const { image, video } = detectModalities(messages);
  const eligible = Object.keys(CANDIDATES).filter((k) => (!image || CANDIDATES[k].mods.includes("image")) && (!video || CANDIDATES[k].mods.includes("video")));
  const criteria = {};
  for (const k of eligible) criteria[k] = { agent: k, projectedRemainingRatio: 0.5, capabilities: CANDIDATES[k].mods, supportedEfforts: ["low", "high", "max"] };
  const t0 = Date.now();
  const q = choice((cfg.auto && cfg.auto.question) || "Which model should handle this coding task? Pick the cheapest subscription model that is clearly sufficient; frontier models only for hard work.", criteria);
  const result = await client.systemOne({ state: { task: task.slice(0, (cfg.auto && cfg.auto.maxTaskChars) || 2000) }, questions: { route: q } });
  const picked = (result.answers.route || {}).choice;
  if (!CANDIDATES[picked]) throw new Error("bad pick " + JSON.stringify(picked));
  console.log(`[auto] typesafe -> ${picked} (${Date.now() - t0}ms)`);
  return picked;
}

function anthropicToOpenAI(body) {
  const msgs = [];
  if (body.system) msgs.push({ role: "system", content: typeof body.system === "string" ? body.system : JSON.stringify(body.system) });
  for (const m of safeMessages(body.messages)) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") { msgs.push({ role, content: m.content }); continue; }
    if (!Array.isArray(m.content)) { msgs.push({ role, content: m.content == null ? "" : String(m.content) }); continue; }
    // C-6: tool_use/tool_result blocks ride the grok lane as openai tool_calls / tool messages
    const parts = [], toolCalls = [], toolResults = [];
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") parts.push({ type: "text", text: b.text });
      else if (b.type === "image" && b.source) parts.push({ type: "image_url", image_url: { url: (b.source.type === "url" && typeof b.source.url === "string") ? b.source.url : `data:${b.source.media_type};base64,${b.source.data}` } });
      else if (b.type === "tool_use" && typeof b.name === "string" && b.name) toolCalls.push({ id: (typeof b.id === "string" && b.id) || ("call_" + toolCalls.length), type: "function", function: { name: b.name, arguments: JSON.stringify((b.input && typeof b.input === "object" && !Array.isArray(b.input)) ? b.input : {}) } });
      else if (b.type === "tool_result") toolResults.push({ role: "tool", tool_call_id: typeof b.tool_use_id === "string" ? b.tool_use_id : "", content: typeof b.content === "string" ? b.content : JSON.stringify(b.content == null ? "" : b.content) });
    }
    if (toolResults.length) { msgs.push(...toolResults); continue; }
    const msg = { role, content: parts };
    if (toolCalls.length) { msg.tool_calls = toolCalls; if (!parts.length) msg.content = null; }
    msgs.push(msg);
  }
  const out = { messages: msgs, max_tokens: body.max_tokens || 1024, temperature: body.temperature, stream: !!body.stream };
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name) continue;
      tools.push({ type: "function", function: { name: t.name, description: typeof t.description === "string" ? t.description : "", parameters: (t.input_schema && typeof t.input_schema === "object" && !Array.isArray(t.input_schema)) ? t.input_schema : { type: "object", properties: {} } } });
    }
    if (tools.length) out.tools = tools;
  }
  return out;
}

// ---------- SSE helpers: emit Anthropic event stream ----------
function sseWrite(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
// Open a message; optionally lead with a tag-only thinking block (route visibility),
// then the text block. Returns block-index helpers for multi-block streams.
function openAnthropicStream(res, model, tag, tagAlways) {
  if (res.headersSent) throw new Error("client stream already started; refusing to restart");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  sseWrite(res, "message_start", { type: "message_start", message: { id: "msg_router_" + Date.now(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let next = 0;
  const open = [];
  const openBlock = (cb) => { const i = next++; open.push(i); sseWrite(res, "content_block_start", { type: "content_block_start", index: i, content_block: cb }); return i; };
  const closeBlock = (i) => { sseWrite(res, "content_block_stop", { type: "content_block_stop", index: i }); const k = open.indexOf(i); if (k >= 0) open.splice(k, 1); };
  let tagEmitted = false;
  if (tag && tagAlways) {
    const i = openBlock({ type: "thinking", thinking: "" });
    sseWrite(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: tag + "\n" } });
    sseWrite(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "sig_router" } });
    closeBlock(i);
    tagEmitted = true;
  }
  // PRD-005 fix: the text block opens LAZILY on the first text delta - an empty
  // text block (start+stop, no deltas) reads as a malformed stream to clients.
  return { textIdx: -1, tagEmitted, openBlock, closeBlock, closeAll: () => { for (const i of open.slice()) closeBlock(i); } };
}
function anthropicStreamEnd(res, stopReason, usage) {
  sseWrite(res, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason || "end_turn", stop_sequence: null }, usage: { output_tokens: (usage && usage.output_tokens) || 0 } });
  sseWrite(res, "message_stop", { type: "message_stop" });
  res.end();
}

// PRD-005 diagnostic: ring of recent raw client-dialect streams. When a client
// reports a malformed stream, the exact bytes are here instead of a guessing game.
const CAPTURE_DIR = path.join(DATA_DIR, "captures");
const captureOn = process.env.BELAY_CAPTURE !== "0";
// grok/openai-chat: openai chat SSE -> anthropic SSE. Maps streaming tool_calls
// deltas to tool_use blocks and reasoning_content to thinking blocks (PRD-003/004);
// leads with the route tag so the user sees who served, in-stream.
function pipeGrokSSE(upRes, res, model, tag) {
  const s = openAnthropicStream(res, model, tag, true);
  let buf = "", usage = { output_tokens: 0 };
  let thinkIdx = -1;
  // anthropic blocks are sequential: opening one kind closes the other; blocks REOPEN
  // as the upstream alternates (glm streams reasoning first, then content).
  const closeThink = () => { if (thinkIdx >= 0) { sseWrite(res, "content_block_delta", { type: "content_block_delta", index: thinkIdx, delta: { type: "signature_delta", signature: "sig_router" } }); s.closeBlock(thinkIdx); thinkIdx = -1; } };
  const openThink = () => { if (thinkIdx < 0) { if (s.textIdx >= 0) s.closeBlock(s.textIdx); thinkIdx = s.openBlock({ type: "thinking", thinking: "" }); if (tag && !s.tagEmitted) { sseWrite(res, "content_block_delta", { type: "content_block_delta", index: thinkIdx, delta: { type: "thinking_delta", thinking: tag + "\n" } }); s.tagEmitted = true; } } };
  const openText = () => { if (s.textIdx < 0) { closeThink(); s.textIdx = s.openBlock({ type: "text", text: "" }); } };
  upRes.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { closeThink(); s.closeAll(); finishStream(res, usage, finish, s, toolEmitted, false); return; }
      try {
        const j = JSON.parse(payload);
        const d = (j.choices || [{}])[0].delta || {};
        const fr = (j.choices || [{}])[0].finish_reason;
        if (typeof fr === "string" && fr) finish = fr;
        const rc = (typeof d.reasoning_content === "string" && d.reasoning_content) || (d.reasoning && typeof d.reasoning.content === "string" && d.reasoning.content);
        if (rc) { // PRD-004: reasoning deltas -> thinking block, tag rides first
          openThink();
          usage.output_tokens++;
          sseWrite(res, "content_block_delta", { type: "content_block_delta", index: thinkIdx, delta: { type: "thinking_delta", thinking: rc } });
        }
        if (d.content) { usage.output_tokens++; openText(); sseWrite(res, "content_block_delta", { type: "content_block_delta", index: s.textIdx, delta: { type: "text_delta", text: d.content } }); }
        if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) { // openai streaming tool_calls -> anthropic tool_use blocks
          if (!tc || typeof tc !== "object") continue;
          const key = typeof tc.index === "number" ? tc.index : -1;
          let bIdx = s.toolIdx && s.toolIdx.get(key);
          if (bIdx === undefined) {
            if (s.textIdx >= 0) s.closeBlock(s.textIdx);
            closeThink();
            const fn = (tc.function && typeof tc.function === "object") ? tc.function : {};
            bIdx = s.openBlock({ type: "tool_use", id: (typeof tc.id === "string" && tc.id) || ("toolu_sse_" + key), name: (typeof fn.name === "string" && fn.name) || "", input: {} });
            (s.toolIdx || (s.toolIdx = new Map())).set(key, bIdx);
            (s.toolArgs || (s.toolArgs = new Map())).set(key, "");
            toolEmitted = true;
          }
          const args = (tc.function && typeof tc.function.arguments === "string") ? tc.function.arguments : "";
          if (args) { usage.output_tokens++; (s.toolArgs || (s.toolArgs = new Map())).set(key, (s.toolArgs.get(key) || "") + args); sseWrite(res, "content_block_delta", { type: "content_block_delta", index: bIdx, delta: { type: "input_json_delta", partial_json: args } }); }
        }
        if (j.usage && j.usage.completion_tokens) usage.output_tokens = j.usage.completion_tokens;
      } catch {}
    }
  });
  let finish = "";
  let toolEmitted = false;
  upRes.on("end", () => { if (!res.writableEnded) { closeThink(); s.closeAll(); finishStream(res, usage, finish, s, toolEmitted, true); } });
  upRes.on("error", () => { if (!res.writableEnded) { closeThink(); s.closeAll(); finishStream(res, usage, finish, s, toolEmitted, true); } });
}

// gpt: openai responses SSE -> anthropic SSE. PRD-004: reasoning summary deltas
// surface as thinking blocks (route tag rides first) instead of being dropped.

// PRD-005: shared stream finisher. A tool_use block whose arguments JSON is
// truncated (provider cut the stream mid-call, or token limit) would poison the
// client - Claude Code parses arguments and dies with a malformed-stream error.
// In that case emit an SSE error event so the client retries the turn cleanly.
function finishStream(res, usage, finish, s, toolEmitted, abnormal) {
  const tools = s.toolArgs || new Map();
  for (const [, args] of tools) {
    if (typeof args === "string" && args.trim()) {
      try { JSON.parse(args); }
      catch {
        sseWrite(res, "error", { type: "error", error: { type: "api_error", message: "upstream ended mid tool call (arguments truncated); retry the turn" } });
        res.end();
        return;
      }
    }
  }
  anthropicStreamEnd(res, toolEmitted ? "tool_use" : (finish === "length" ? "max_tokens" : "end_turn"), usage);
}
function pipeGPTSSE(upRes, res, model, tag) {
  const s = openAnthropicStream(res, model, tag, true);
  let buf = "", usage = { output_tokens: 0 };
  let thinkIdx = -1;
  let toolEmitted = false;
  const closeThink = () => { if (thinkIdx >= 0) { sseWrite(res, "content_block_delta", { type: "content_block_delta", index: thinkIdx, delta: { type: "signature_delta", signature: "sig_router" } }); s.closeBlock(thinkIdx); thinkIdx = -1; } };
  upRes.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { closeThink(); s.closeAll(); finishStream(res, usage, "", s, toolEmitted, false); return; }
      try {
        const j = JSON.parse(payload);
        const t = j.type || "";
        if (t === "response.reasoning_summary_text.delta" && typeof j.delta === "string" && j.delta) {
          if (thinkIdx < 0) { if (s.textIdx >= 0) s.closeBlock(s.textIdx); thinkIdx = s.openBlock({ type: "thinking", thinking: "" }); }
          usage.output_tokens++;
          sseWrite(res, "content_block_delta", { type: "content_block_delta", index: thinkIdx, delta: { type: "thinking_delta", thinking: j.delta } });
        }
        if (t === "response.output_text.delta" && j.delta) { closeThink(); if (s.textIdx < 0) s.textIdx = s.openBlock({ type: "text", text: "" }); usage.output_tokens++; sseWrite(res, "content_block_delta", { type: "content_block_delta", index: s.textIdx, delta: { type: "text_delta", text: j.delta } }); }
        if (t === "response.output_item.added" && (j.item || {}).type === "function_call") { // PRD-005: gpt-lane streaming tool calls
          closeThink();
          const it = j.item;
          const fi = s.openBlock({ type: "tool_use", id: (typeof it.call_id === "string" && it.call_id) || ("toolu_sse_" + (s.fnCount = (s.fnCount || 0) + 1)), name: (typeof it.name === "string" && it.name) || "", input: {} });
          (s.fnIdx || (s.fnIdx = new Map())).set(it.id || it.call_id, fi);
          (s.fnArgs || (s.fnArgs = new Map())).set(fi, "");
          toolEmitted = true;
        }
        if (t === "response.function_call_arguments.delta" && typeof j.delta === "string" && j.delta) {
          const fi = s.fnIdx && s.fnIdx.get(j.item_id);
          if (fi !== undefined) { usage.output_tokens++; sseWrite(res, "content_block_delta", { type: "content_block_delta", index: fi, delta: { type: "input_json_delta", partial_json: j.delta } }); }
        }
        if (t === "response.output_item.done" && (j.item || {}).type === "function_call") {
          const fi = s.fnIdx && s.fnIdx.get(j.item.id || j.item.call_id);
          if (fi !== undefined) s.closeBlock(fi);
        }
        if (t === "response.completed" || t === "response.incomplete") {
          const u = (j.response || {}).usage || {};
          closeThink(); s.closeAll();
          anthropicStreamEnd(res, t === "response.incomplete" ? "max_tokens" : (toolEmitted ? "tool_use" : "end_turn"), { output_tokens: u.output_tokens || usage.output_tokens });
          return;
        }
        if (t === "error" || t === "response.failed") { closeThink(); s.closeAll(); finishStream(res, usage, "", s, toolEmitted, true); return; }
      } catch {}
    }
  });
  upRes.on("end", () => { if (!res.writableEnded) { closeThink(); s.closeAll(); finishStream(res, usage, "", s, toolEmitted, true); } });
  upRes.on("error", () => { if (!res.writableEnded) { closeThink(); s.closeAll(); sseWrite(res, "error", { type: "error", error: { type: "api_error", message: "upstream connection failed mid stream; retry the turn" } }); res.end(); } });
}

// ---------- PRD-001b B-6: anthropic SSE -> openai chat SSE (inverse of pipeGrokSSE) ----------
const STOP_TO_FINISH = { end_turn: "stop", max_tokens: "length", tool_use: "tool_calls", stop_sequence: "stop" };

function pipeAnthropicToOpenAIChatSSE(upRes, res, model, reqModel) {
  const id = "chatcmpl-router-" + Date.now();
  const created = Math.floor(Date.now() / 1000);
  const outModel = reqModel || model;
  const chunkStr = (choices, usage) => {
    const j = { id, object: "chat.completion.chunk", created, model: outModel, choices };
    if (usage) j.usage = usage;
    return "data: " + JSON.stringify(j) + "\n\n";
  };
  const writeChunk = (choices, usage) => { if (!res.writableEnded) res.write(chunkStr(choices, usage)); };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  // role-only first chunk, as openai clients expect
  writeChunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
  let buf = "";
  let finishReason = null;
  let ended = false;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const blockToTool = new Map(); // anthropic content_block index -> openai tool_calls index
  let nextToolIdx = 0;
  const done = () => {
    if (ended) return;
    ended = true;
    if (res.writableEnded) return;
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    res.write(chunkStr([{ index: 0, delta: {}, finish_reason: finishReason || "stop" }], usage));
    res.write("data: [DONE]\n\n");
    res.end();
  };
  upRes.on("data", (c) => {
    if (ended) return;
    buf += c.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; } // skip malformed upstream line, never crash the stream
      const t = j.type || "";
      if (t === "message_start") {
        const u = (j.message || {}).usage || {};
        if (typeof u.input_tokens === "number") usage.prompt_tokens = u.input_tokens;
      } else if (t === "content_block_start") {
        const cb = j.content_block || {};
        if (cb.type === "tool_use" && typeof cb.name === "string" && cb.name) {
          const tIdx = nextToolIdx++;
          blockToTool.set(typeof j.index === "number" ? j.index : tIdx, tIdx);
          writeChunk([{ index: 0, delta: { tool_calls: [{ index: tIdx, id: (typeof cb.id === "string" && cb.id) || ("call_" + id + "_" + tIdx), type: "function", function: { name: cb.name, arguments: "" } }] }, finish_reason: null }]);
        }
      } else if (t === "content_block_delta") {
        const d = j.delta || {};
        if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
          usage.completion_tokens++;
          writeChunk([{ index: 0, delta: { content: d.text }, finish_reason: null }]);
        } else if (d.type === "input_json_delta" && typeof d.partial_json === "string" && d.partial_json) {
          const tIdx = blockToTool.get(typeof j.index === "number" ? j.index : 0);
          if (tIdx !== undefined) writeChunk([{ index: 0, delta: { tool_calls: [{ index: tIdx, function: { arguments: d.partial_json } }] }, finish_reason: null }]);
        }
        // thinking_delta: internal reasoning, not part of the openai chat dialect - dropped by design
      } else if (t === "message_delta") {
        if (j.delta && typeof j.delta.stop_reason === "string" && j.delta.stop_reason) finishReason = STOP_TO_FINISH[j.delta.stop_reason] || "stop";
        const u = j.usage || {};
        if (typeof u.output_tokens === "number") usage.completion_tokens = u.output_tokens;
      } else if (t === "message_stop") {
        done();
        return;
      }
    }
  });
  upRes.on("end", () => done());
  upRes.on("error", () => done());
}

// anthropic-dialect sink for lanes that stream anthropic SSE toward a client speaking openai chat:
// the lane writes into this PassThrough, pipeAnthropicToOpenAIChatSSE then translates it onto the real res.
function anthropicSink() {
  const pt = new PassThrough();
  pt.writeHead = () => pt; // the piper owns the real status/headers
  return pt;
}

function postUpstream(host, path, headers, bodyStr, timeoutMs, onStatus) {
  // onStatus(status, headers) -> true to stream the response object back (caller gets upRes)
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(bodyStr) }, timeout: timeoutMs }, (r) => {
      if (onStatus(r.statusCode, r.headers)) { resolve({ stream: true, upRes: r, status: r.statusCode }); return; }
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => resolve({ stream: false, status: r.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(bodyStr);
  });
}

const isFail = (s) => s === 429 || s === 401 || s === 403 || s >= 500;

function openAIToAnthropic(model, o, reqModel) {
  const ch = (o.choices || [{}])[0] || {};
  const msg = ch.message || {};
  const content = msg.content || "";
  const reasoning = msg.reasoning_content;
  const blocks = [];
  if (reasoning) blocks.push({ type: "thinking", thinking: String(reasoning).slice(0, 8000), signature: "na" });
  blocks.push({ type: "text", text: content });
  if (Array.isArray(msg.tool_calls)) for (const tc of msg.tool_calls) { // PRD-003: tool_calls -> tool_use (grok + litellm lanes)
    if (!tc || typeof tc !== "object") continue;
    const fn = (tc.function && typeof tc.function === "object") ? tc.function : {};
    if (typeof fn.name !== "string" || !fn.name) continue;
    let input = {};
    if (typeof fn.arguments === "string" && fn.arguments.trim()) {
      try { const p = JSON.parse(fn.arguments); if (p && typeof p === "object" && !Array.isArray(p)) input = p; }
      catch {}
    } else if (fn.arguments && typeof fn.arguments === "object" && !Array.isArray(fn.arguments)) input = fn.arguments;
    blocks.push({ type: "tool_use", id: (typeof tc.id === "string" && tc.id) || ("toolu_router_" + blocks.length), name: fn.name, input });
  }
  const stop = ch.finish_reason === "tool_calls" ? "tool_use" : (ch.finish_reason === "length" ? "max_tokens" : "end_turn");
  return { id: o.id || "msg_router", type: "message", role: "assistant", model: reqModel || model, content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: (o.usage || {}).prompt_tokens || 0, output_tokens: (o.usage || {}).completion_tokens || 0 } };
}

// ---------- PRD-001b B-2/B-4/B-5: openai chat <-> anthropic translators ----------

// openai content (string | parts array) -> anthropic content (string | block array); crash-guarded per part.
function openAIContentToAnthropic(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return String(content);
  const blocks = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string" && p.text) blocks.push({ type: "text", text: p.text });
    else if (p.type === "image_url" && p.image_url && typeof p.image_url.url === "string") {
      const m = /^data:([^;]+);base64,(.+)$/.exec(p.image_url.url);
      if (m) blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      else if (/^https?:\/\//i.test(p.image_url.url)) blocks.push({ type: "image", source: { type: "url", url: p.image_url.url } });
    }
  }
  return blocks;
}

// plain text of an openai message (string or text parts); used where anthropic wants a plain string
function openAIText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
}

// openai chat request -> internal anthropic request (inverse of anthropicToOpenAI; pure, crash-guarded, unknown fields dropped)
function openaiChatToAnthropic(body) {
  const systemParts = [];
  const msgs = [];
  for (const m of safeMessages(body.messages)) {
    if (!m || typeof m !== "object") continue;
    const role = typeof m.role === "string" ? m.role : "user";
    if (role === "system" || role === "developer") { // system-equivalent -> anthropic top-level system (B-2)
      if (typeof m.content === "string") systemParts.push(m.content);
      else if (m.content != null) systemParts.push(JSON.stringify(m.content));
      continue;
    }
    if (role === "tool") { // role:"tool" -> anthropic tool_result block inside a user message (B-4)
      const block = { type: "tool_result", tool_use_id: typeof m.tool_call_id === "string" ? m.tool_call_id : "", content: openAIText(m.content) };
      const last = msgs[msgs.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.length && last.content.every((b) => b && b.type === "tool_result")) last.content.push(block);
      else msgs.push({ role: "user", content: [block] });
      continue;
    }
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      // assistant tool_calls -> anthropic tool_use blocks (B-4)
      const blocks = [];
      const text = openAIText(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of m.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const fn = tc.function && typeof tc.function === "object" ? tc.function : {};
        if (typeof fn.name !== "string" || !fn.name) continue;
        let input = {};
        if (typeof fn.arguments === "string" && fn.arguments.trim()) {
          try { const p = JSON.parse(fn.arguments); if (p && typeof p === "object" && !Array.isArray(p)) input = p; }
          catch {} // unparseable arguments -> empty input; the model re-asks (guarded, not fatal)
        } else if (fn.arguments && typeof fn.arguments === "object" && !Array.isArray(fn.arguments)) input = fn.arguments;
        blocks.push({ type: "tool_use", id: (typeof tc.id === "string" && tc.id) || ("toolu_router_" + msgs.length + "_" + blocks.length), name: fn.name, input });
      }
      msgs.push({ role: "assistant", content: blocks.length ? blocks : "" });
      continue;
    }
    msgs.push({ role: role === "assistant" ? "assistant" : "user", content: openAIContentToAnthropic(m.content) });
  }
  const out = {
    messages: msgs.length ? msgs : [{ role: "user", content: "" }],
    max_tokens: (typeof body.max_tokens === "number" && body.max_tokens > 0) ? body.max_tokens : 1024,
    stream: !!body.stream,
  };
  if (systemParts.length) out.system = systemParts.join("\n\n");
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (Array.isArray(body.tools) && body.tools.length && body.tool_choice !== "none") { // tool_choice "none" -> drop tools entirely
    const tools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== "object") continue;
      const fn = (t.function && typeof t.function === "object") ? t.function : (typeof t.name === "string" ? t : null);
      if (!fn || typeof fn.name !== "string" || !fn.name) continue;
      tools.push({ name: fn.name, description: typeof fn.description === "string" ? fn.description : "", input_schema: (fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)) ? fn.parameters : { type: "object", properties: {} } });
    }
    if (tools.length) {
      out.tools = tools;
      const tc = body.tool_choice;
      // "auto"/absent omitted: anthropic's default is auto, and LiteLLM's glm lane was observed
      // returning an empty 200 when tool_choice is passed explicitly (2026-09-25 probe).
      if (tc === "required") out.tool_choice = { type: "any" };
      else if (tc && typeof tc === "object" && !Array.isArray(tc) && (tc.type === "function" || tc.type === "tool") && tc.function && typeof tc.function.name === "string") out.tool_choice = { type: "tool", name: tc.function.name };
    }
  }
  return out;
}

// anthropic message -> openai chat completion JSON (B-5)
function anthropicToOpenAIChat(model, body, reqModel) {
  const textParts = [], thinkParts = [], toolCalls = [];
  for (const b of Array.isArray(body && body.content) ? body.content : []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string") thinkParts.push(b.thinking);
    else if (b.type === "tool_use" && typeof b.name === "string" && b.name) {
      toolCalls.push({ id: (typeof b.id === "string" && b.id) || ("call_router_" + toolCalls.length), type: "function", function: { name: b.name, arguments: JSON.stringify((b.input && typeof b.input === "object" && !Array.isArray(b.input)) ? b.input : {}) } });
    }
  }
  const u = (body && body.usage) || {};
  const prompt = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const completion = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const text = textParts.join("");
  const message = { role: "assistant", content: toolCalls.length && !text ? null : text };
  if (thinkParts.length) message.reasoning_content = thinkParts.join("\n");
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: (body && typeof body.id === "string" && body.id) || ("chatcmpl-router-" + Date.now()),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: reqModel || model,
    choices: [{ index: 0, message, finish_reason: STOP_TO_FINISH[(body && body.stop_reason) || "end_turn"] || "stop" }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

// ---------- PRD-001c C-2/C-4/C-5: openai responses <-> anthropic translators ----------
// serveGPT's outbound construction is the canonical responses field map; these are its inverse
// (request) and its inbound mirror (JSON object + SSE events), crash-guarded per item/part.

// responses request -> internal anthropic request (C-2); pure, unknown fields/items dropped.
function responsesToAnthropic(body) {
  const systemParts = [];
  if (typeof body.instructions === "string" && body.instructions) systemParts.push(body.instructions);
  const msgs = [];

  // responses message content (string | parts[]) -> anthropic content (string | block[])
  const partsToContent = (content) => {
    if (typeof content === "string") return content;
    if (content == null) return "";
    if (!Array.isArray(content)) return String(content);
    const blocks = [];
    for (const p of content) {
      if (!p || typeof p !== "object") continue;
      if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string" && p.text) blocks.push({ type: "text", text: p.text });
      else if (p.type === "input_image" && p.image_url) {
        const url = typeof p.image_url === "string" ? p.image_url : (p.image_url && typeof p.image_url === "object" && typeof p.image_url.url === "string" ? p.image_url.url : "");
        const m = /^data:([^;]+);base64,(.+)$/.exec(url);
        if (m) blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
        else if (/^https?:\/\//i.test(url)) blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
    return blocks.length ? blocks : "";
  };
  const pushToolResult = (block) => { // consecutive function_call_output items -> one user tool_result run
    const last = msgs[msgs.length - 1];
    if (last && last.role === "user" && Array.isArray(last.content) && last.content.length && last.content.every((b) => b && b.type === "tool_result")) last.content.push(block);
    else msgs.push({ role: "user", content: [block] });
  };
  const pushToolUse = (block) => { // function_call items merge into the adjacent assistant turn
    const last = msgs[msgs.length - 1];
    if (last && last.role === "assistant" && Array.isArray(last.content) && last.content.length && last.content.every((b) => b && (b.type === "tool_use" || b.type === "text"))) last.content.push(block);
    else msgs.push({ role: "assistant", content: [block] });
  };

  const items = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input }]
    : (Array.isArray(body.input) ? body.input : []);
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    if (it.type === "message") {
      const role = typeof it.role === "string" ? it.role : "user";
      if (role === "system" || role === "developer") { // system-equivalent -> anthropic top-level system
        if (typeof it.content === "string") systemParts.push(it.content);
        else if (it.content != null) systemParts.push(JSON.stringify(it.content));
        continue;
      }
      const content = partsToContent(it.content);
      if (content === "" || (Array.isArray(content) && !content.length)) continue; // empty turns would 400 on lanes
      msgs.push({ role: role === "assistant" ? "assistant" : "user", content });
    } else if (it.type === "function_call") { // assistant tool call -> anthropic tool_use (C-6)
      if (typeof it.name !== "string" || !it.name) continue;
      let input = {};
      if (typeof it.arguments === "string" && it.arguments.trim()) {
        try { const p = JSON.parse(it.arguments); if (p && typeof p === "object" && !Array.isArray(p)) input = p; }
        catch {} // unparseable arguments -> empty input; the model re-asks (guarded, not fatal)
      } else if (it.arguments && typeof it.arguments === "object" && !Array.isArray(it.arguments)) input = it.arguments;
      pushToolUse({ type: "tool_use", id: (typeof it.call_id === "string" && it.call_id) || ("toolu_router_" + msgs.length + "_" + msgs.length), name: it.name, input });
    } else if (it.type === "function_call_output") { // tool result -> anthropic tool_result (C-6)
      const out = typeof it.output === "string" ? it.output : (it.output != null ? JSON.stringify(it.output) : "");
      pushToolResult({ type: "tool_result", tool_use_id: typeof it.call_id === "string" ? it.call_id : "", content: out });
    }
    // reasoning items carry no conversational content for the anthropic core (serveGPT sends none
    // outbound either); unknown item types dropped - A drop-not-crash discipline.
  }
  const out = {
    messages: msgs.length ? msgs : [{ role: "user", content: "" }],
    max_tokens: (typeof body.max_output_tokens === "number" && body.max_output_tokens > 0) ? body.max_output_tokens : 1024,
    stream: !!body.stream,
  };
  if (systemParts.length) out.system = systemParts.join("\n\n");
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (Array.isArray(body.tools) && body.tools.length && body.tool_choice !== "none") { // tool_choice "none" -> drop tools entirely
    const tools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== "object") continue;
      const fn = (t.function && typeof t.function === "object") ? t.function : (typeof t.name === "string" ? t : null); // responses defs are flat; chat-shaped nested defs tolerated
      if (!fn || typeof fn.name !== "string" || !fn.name) continue;
      tools.push({ name: fn.name, description: typeof fn.description === "string" ? fn.description : "", input_schema: (fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)) ? fn.parameters : { type: "object", properties: {} } });
    }
    if (tools.length) {
      out.tools = tools;
      const tc = body.tool_choice;
      // "auto"/absent omitted (see openaiChatToAnthropic note: LiteLLM glm lane + explicit tool_choice).
      if (tc === "required") out.tool_choice = { type: "any" };
      else if (tc && typeof tc === "object" && !Array.isArray(tc) && typeof tc.name === "string" && tc.name) out.tool_choice = { type: "tool", name: tc.name };
      if (body.parallel_tool_calls === false) { // codex pins this
        if (!out.tool_choice) out.tool_choice = { type: "auto" };
        out.tool_choice.disable_parallel_tool_use = true;
      }
    }
  }
  return out;
}

// anthropic message -> responses object (C-4). Thinking blocks become a reasoning item with
// summary text (C-3); tool_use blocks become function_call items (C-6).
function anthropicToResponses(model, body, reqModel) {
  const textParts = [], thinkParts = [], fnCalls = [];
  let n = 0;
  for (const b of Array.isArray(body && body.content) ? body.content : []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string") thinkParts.push(b.thinking);
    else if (b.type === "tool_use" && typeof b.name === "string" && b.name) {
      fnCalls.push({ type: "function_call", id: "fc_" + Date.now() + "_" + (n++), call_id: (typeof b.id === "string" && b.id) || ("call_" + n), name: b.name, arguments: JSON.stringify((b.input && typeof b.input === "object" && !Array.isArray(b.input)) ? b.input : {}), status: "completed" });
    }
  }
  const u = (body && body.usage) || {};
  const inputT = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const outputT = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const stamp = Date.now();
  const output = [];
  if (thinkParts.length) output.push({ type: "reasoning", id: "rs_" + stamp, summary: [{ type: "summary_text", text: thinkParts.join("\n") }] });
  output.push({ type: "message", id: "msg_" + stamp, role: "assistant", status: "completed", content: [{ type: "output_text", text: textParts.join(""), annotations: [] }] });
  output.push(...fnCalls);
  return {
    id: "resp_router_" + stamp,
    object: "response",
    created_at: Math.floor(stamp / 1000),
    status: (body && body.stop_reason === "max_tokens") ? "incomplete" : "completed",
    model: reqModel || model,
    output,
    usage: { input_tokens: inputT, output_tokens: outputT, total_tokens: inputT + outputT },
  };
}

// internal anthropic SSE -> responses SSE (C-5): the event alphabet pipeGPTSSE parses upstream,
// emitted inbound. Every lane event is crash-guarded; upstream end/error still emits a terminal.
function pipeAnthropicToResponsesSSE(upRes, res, model, reqModel) {
  const rid = "resp_router_" + Date.now();
  const outModel = reqModel || model;
  const createdAt = Math.floor(Date.now() / 1000);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const doneItems = [];
  const responseObj = (status, usage) => {
    const r = { id: rid, object: "response", created_at: createdAt, status, model: outModel, output: doneItems.slice() };
    if (usage) r.usage = usage;
    if (status === "incomplete") r.incomplete_details = { reason: "max_output_tokens" };
    return r;
  };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  sseWrite(res, "response.created", { type: "response.created", response: responseObj("in_progress") });
  let buf = "";
  let ended = false;
  let outIdx = -1, openKind = "", openItem = null, thinkText = "", toolArgs = "";
  const usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = "";
  const closeItem = () => {
    if (openItem) {
      if (openKind === "thinking") openItem.summary = thinkText ? [{ type: "summary_text", text: thinkText }] : [];
      else openItem.status = "completed";
      if (openKind === "tool") openItem.arguments = toolArgs;
      doneItems.push(openItem);
      sseWrite(res, "response.output_item.done", { type: "response.output_item.done", output_index: outIdx, item: openItem });
    }
    outIdx = -1; openKind = ""; openItem = null; thinkText = ""; toolArgs = "";
  };
  const terminal = () => {
    if (ended) return;
    ended = true;
    closeItem();
    if (res.writableEnded) return;
    const incomplete = stopReason === "max_tokens";
    const t = incomplete ? "response.incomplete" : "response.completed";
    const u = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens };
    sseWrite(res, t, { type: t, response: responseObj(incomplete ? "incomplete" : "completed", u) });
    res.end();
  };
  upRes.on("data", (c) => {
    if (ended) return;
    buf += c.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; } // skip malformed upstream line, never crash the stream
      const t = j.type || "";
      if (t === "message_start") {
        const u = (j.message || {}).usage || {};
        if (typeof u.input_tokens === "number") usage.input_tokens = u.input_tokens;
      } else if (t === "content_block_start") {
        closeItem(); // anthropic content blocks are strictly sequential, never nested
        const cb = j.content_block || {};
        outIdx++;
        if (cb.type === "tool_use" && typeof cb.name === "string" && cb.name) {
          openKind = "tool";
          openItem = { type: "function_call", id: "fc_" + rid + "_" + outIdx, call_id: (typeof cb.id === "string" && cb.id) || ("call_" + outIdx), name: cb.name, arguments: "", status: "in_progress" };
        } else if (cb.type === "thinking") {
          openKind = "thinking";
          openItem = { type: "reasoning", id: "rs_" + rid + "_" + outIdx, summary: [] };
        } else {
          openKind = "text";
          openItem = { type: "message", id: "msg_" + rid + "_" + outIdx, role: "assistant", status: "in_progress", content: [{ type: "output_text", text: "", annotations: [] }] };
        }
        sseWrite(res, "response.output_item.added", { type: "response.output_item.added", output_index: outIdx, item: clone(openItem) });
      } else if (t === "content_block_delta") {
        const d = j.delta || {};
        if (d.type === "text_delta" && typeof d.text === "string" && d.text && openKind === "text" && openItem) {
          usage.output_tokens++;
          openItem.content[0].text += d.text;
          sseWrite(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: openItem.id, output_index: outIdx, content_index: 0, delta: d.text });
        } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking && openKind === "thinking") {
          thinkText += d.thinking; // assembled into the reasoning summary at output_item.done (C-3)
        } else if (d.type === "input_json_delta" && typeof d.partial_json === "string" && d.partial_json && openKind === "tool" && openItem) {
          toolArgs += d.partial_json;
          sseWrite(res, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: openItem.id, output_index: outIdx, delta: d.partial_json });
        }
      } else if (t === "content_block_stop") {
        closeItem();
      } else if (t === "message_delta") {
        if (j.delta && typeof j.delta.stop_reason === "string" && j.delta.stop_reason) stopReason = j.delta.stop_reason;
        const u = j.usage || {};
        if (typeof u.output_tokens === "number") usage.output_tokens = u.output_tokens;
      } else if (t === "message_stop") {
        terminal();
        return;
      }
    }
  });
  upRes.on("end", () => terminal());
  upRes.on("error", () => terminal());
}

async function serveGrok(model, body, res, tag) {
  const t = tokens();
  if (!t.grok) throw new Error("no grok token");
  const ob = anthropicToOpenAI(body);
  ob.model = "grok-4.7";
  const wantStream = !!ob.stream;
  const r = await postUpstream("api.x.ai", "/v1/chat/completions", { "Authorization": "Bearer " + t.grok, "content-type": "application/json" }, JSON.stringify(ob), 240000, (status) => wantStream && status === 200);
  if (wantStream && r.stream) { pipeGrokSSE(r.upRes, res, model, tag); return { streamed: true }; }
  if (isFail(r.status)) throw new Error(`grok ${r.status}: ${r.body.slice(0, 120)}`);
  return { kind: "anthropic", body: openAIToAnthropic("grok-4.7", JSON.parse(r.body), model) };
}

async function serveGPT(model, body, res, tag) {
  const t = tokens();
  if (!t.gpt) throw new Error("no codex token");
  const input = [];
  for (const m of safeMessages(body.messages)) {
    if (!m || typeof m !== "object") continue;
    const parts = [];
    if (typeof m.content === "string") parts.push({ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content });
    else if (Array.isArray(m.content)) for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") parts.push({ type: m.role === "assistant" ? "output_text" : "input_text", text: b.text });
      else if (b.type === "image" && b.source) parts.push({ type: "input_image", image_url: (b.source.type === "url" && typeof b.source.url === "string") ? b.source.url : `data:${b.source.media_type};base64,${b.source.data}` });
      else if (b.type === "tool_use" && typeof b.name === "string" && b.name) input.push({ type: "function_call", call_id: (typeof b.id === "string" && b.id) || ("call_" + input.length), name: b.name, arguments: JSON.stringify((b.input && typeof b.input === "object" && !Array.isArray(b.input)) ? b.input : {}) }); // C-6 tool history
      else if (b.type === "tool_result") input.push({ type: "function_call_output", call_id: typeof b.tool_use_id === "string" ? b.tool_use_id : "", output: typeof b.content === "string" ? b.content : JSON.stringify(b.content == null ? "" : b.content) });
    }
    if (parts.length) input.push({ type: "message", role: m.role, content: parts });
  }
  const wantStream = !!body.stream;
  const gptTools = [];
  if (Array.isArray(body.tools)) for (const t of body.tools) {
    if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name) continue;
    gptTools.push({ type: "function", name: t.name, description: typeof t.description === "string" ? t.description : "", parameters: (t.input_schema && typeof t.input_schema === "object" && !Array.isArray(t.input_schema)) ? t.input_schema : { type: "object", properties: {} } }); // C-6: client tool defs ride the GPT lane
  }
  const ob = {
    model, instructions: typeof body.system === "string" ? body.system : undefined,
    input, tools: gptTools, tool_choice: "auto", parallel_tool_calls: false,
    reasoning: { effort: "low", summary: "auto" }, store: false, stream: wantStream,
    max_output_tokens: body.max_tokens || 1024,
  };
  const r = await postUpstream("chatgpt.com", "/backend-api/codex/responses", {
    "Authorization": "Bearer " + t.gpt, "chatgpt-account-id": t.acct, "content-type": "application/json",
    "originator": "codex_cli_rs", "User-Agent": "codex_cli_rs/0.156.1", "OpenAI-Beta": "responses=experimental",
  }, JSON.stringify(ob), 240000, (status) => wantStream && status === 200);
  if (wantStream && r.stream) { pipeGPTSSE(r.upRes, res, model, tag); return { streamed: true }; }
  if (isFail(r.status)) throw new Error(`gpt ${r.status}: ${r.body.slice(0, 120)}`);
  const out = JSON.parse(r.body);
  if (out.error) throw new Error("gpt wrapped error: " + JSON.stringify(out.error).slice(0, 100));
  let text = "", reasoning = "";
  for (const item of out.output || []) {
    if (item.type === "message") for (const c of item.content || []) if (c.type === "output_text" || c.text) text += c.text || "";
    if (item.type === "reasoning") reasoning += (item.summary || []).map((s) => s.text || "").join(" ");
  }
  if (!text && !(out.output || []).some((i) => (i.content || []).length)) throw new Error("gpt empty output");
  const blocks = [];
  if (reasoning) blocks.push({ type: "thinking", thinking: reasoning.slice(0, 8000), signature: "na" });
  blocks.push({ type: "text", text });
  return { kind: "anthropic", body: { id: out.id || "msg_router", type: "message", role: "assistant", model, content: blocks, stop_reason: out.status === "incomplete" ? "max_tokens" : "end_turn", stop_sequence: null, usage: { input_tokens: (out.usage || {}).input_tokens || 0, output_tokens: (out.usage || {}).output_tokens || 0 } } };
}

function litellmLane(req, res, body, model, wantStream, opts) {
  // PRD-003 E2: ALWAYS speak openai chat/completions to LiteLLM and translate back.
  // z.ai Coding-Plan backends return content:[] through LiteLLM's /v1/messages on
  // openai-style model configs (fleet bug brief 2026-09-25); chat/completions is
  // the reliable surface for every LiteLLM model style. Same architecture as the
  // grok lane: anthropicToOpenAI request, openAIToAnthropic / pipeGrokSSE back,
  // then the client-dialect translators when the client is not anthropic.
  const dialect = opts && opts.dialect; // "openai-chat" | "responses" | undefined = anthropic client
  const reqModel = (opts && opts.reqModel) || model;
  const tag = (opts && opts.tag) || "";
  const ob = anthropicToOpenAI(body); // maps tools + tool history (PRD-001c)
  ob.model = model;
  ob.stream = !!wantStream;
  return new Promise((resolve, reject) => {
    const b = Buffer.from(JSON.stringify(ob));
    const up = http.request({ host: LITELLM.host, port: LITELLM.port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json", "authorization": typeof req.headers.authorization === "string" ? req.headers.authorization : "", "content-length": Buffer.byteLength(b) } }, (ur) => {
      if (isFail(ur.statusCode)) { ur.resume(); meter(model, "fail"); meterEvent(`[ladder] ${model} failed: litellm ${ur.statusCode}`); reject(new Error("litellm " + ur.statusCode)); return; }
      if (wantStream) {
        if (opts) opts.streamed = true; // client bytes flowing: the ladder must not walk past this point
        if (dialect) { // openai-chat SSE -> anthropic SSE (sink) -> client dialect SSE
          const sink = anthropicSink();
          pipeGrokSSE(ur, sink, model, tag);
          (dialect === "responses" ? pipeAnthropicToResponsesSSE : pipeAnthropicToOpenAIChatSSE)(sink, res, model, reqModel);
        } else {
          pipeGrokSSE(ur, res, model, tag); // anthropic client: openai-chat SSE -> anthropic SSE directly
        }
        meter(model, "ok");
        ur.on("end", resolve);
        return;
      }
      const chunks = [];
      ur.on("data", (c) => chunks.push(c));
      ur.on("error", (e) => reject(new Error("litellm stream error: " + errText(e).slice(0, 80))));
      ur.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch (e) { reject(new Error("litellm bad json: " + errText(e).slice(0, 80))); return; }
        const anth = applyRouteTag(openAIToAnthropic(model, parsed, reqModel), tag);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(dialect === "responses" ? anthropicToResponses(model, anth, reqModel) : (dialect === "openai-chat" ? anthropicToOpenAIChat(model, anth, reqModel) : anth)));
        meter(model, "ok", { in: (anth.usage || {}).input_tokens, out: (anth.usage || {}).output_tokens });
        resolve({ tokens: { in: (anth.usage || {}).input_tokens, out: (anth.usage || {}).output_tokens } });
      });
    });
    up.on("error", reject);
    up.end(b);
  });
}

function proxyToLiteLLM(req, res, bodyBuf, modelOverride) {
  let buf = bodyBuf;
  if (modelOverride) {
    const p = JSON.parse(bodyBuf.toString("utf8"));
    p.model = modelOverride;
    buf = Buffer.from(JSON.stringify(p));
  }
  const up = http.request({ host: LITELLM.host, port: LITELLM.port, method: req.method, path: req.url, headers: { ...req.headers, "content-length": Buffer.byteLength(buf) } }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
    ur.on("error", () => { try { if (!res.writableEnded) res.end(); } catch {} }); // MEDIUM-1
    res.on("error", () => {});
  });
  up.on("error", (e) => { console.log("[proxy] litellm unreachable:", errText(e).slice(0, 120)); res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "router: litellm unreachable" } })); });
  up.end(buf);
}

async function serveWithLadder(req, res, body, startModel, dialect, reqModel) {
  // dialect "openai-chat" (PRD-001b) / "responses" (PRD-001c): lanes stay anthropic-native; their output
  // is translated at the edge - non-stream bodies via the dialect's JSON translator, streams via an
  // anthropicSink + the dialect's SSE piper.
  const chat = dialect === "openai-chat";
  const rsp = dialect === "responses";
  const edge = chat || rsp;
  const chain = [startModel, ...((CHAINS[startModel] || []).filter((m) => m !== startModel))];
  const wantStream = !!body.stream;
  let clientStreaming = false; // once client bytes flowed, a failed hop must NOT walk: it would
                               // writeHead an already-started response and kill the process.
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const c = CANDIDATES[model];
    const tag = routeTagFor(model, body._routeEffort); // PRD-004: tag rides the stream/reasoning of whichever hop serves
    try {
      if (c && c.lane === "grok") {
        const sink = edge && wantStream ? anthropicSink() : res;
        const out = await serveGrok(model, body, sink, tag);
        if (out.streamed) clientStreaming = true;
        if (out.streamed) {
          if (sink !== res) (rsp ? pipeAnthropicToResponsesSSE : pipeAnthropicToOpenAIChatSSE)(sink, res, model, reqModel);
          meter(model, "ok"); meterEvent(`[ladder] ${chain[0]} -> streaming via ${model}`);
          console.log(`[ladder] ${chain[0]} -> streaming via ${model}`);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(edge ? (rsp ? anthropicToResponses(model, applyRouteTag(out.body, tag), reqModel) : anthropicToOpenAIChat(model, applyRouteTag(out.body, tag), reqModel)) : applyRouteTag(out.body, tag)));
        const _u = (out.body && out.body.usage) || {};
        meter(model, "ok", { in: _u.input_tokens, out: _u.output_tokens }); meterEvent(`[ladder] ${chain[0]} -> served by ${model}`);
        console.log(`[ladder] ${chain[0]} -> served by ${model}`);
        return;
      }
      if (c && c.lane === "gpt") {
        const sink = edge && wantStream ? anthropicSink() : res;
        const out = await serveGPT(model, body, sink, tag);
        if (out.streamed) clientStreaming = true;
        if (out.streamed) {
          if (sink !== res) (rsp ? pipeAnthropicToResponsesSSE : pipeAnthropicToOpenAIChatSSE)(sink, res, model, reqModel);
          meter(model, "ok"); meterEvent(`[ladder] ${chain[0]} -> streaming via ${model}`);
          console.log(`[ladder] ${chain[0]} -> streaming via ${model}`);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(edge ? (rsp ? anthropicToResponses(model, applyRouteTag(out.body, tag), reqModel) : anthropicToOpenAIChat(model, applyRouteTag(out.body, tag), reqModel)) : applyRouteTag(out.body, tag)));
        const _u = (out.body && out.body.usage) || {};
        meter(model, "ok", { in: _u.input_tokens, out: _u.output_tokens }); meterEvent(`[ladder] ${chain[0]} -> served by ${model}`);
        console.log(`[ladder] ${chain[0]} -> served by ${model}`);
        return;
      }
      const _opts = edge ? { dialect, reqModel, tag, streamed: false } : { tag, streamed: false };
      const _r = await litellmLane(req, res, body, model, wantStream, _opts);
      if (_opts.streamed) clientStreaming = true;
      meterEvent(`[ladder] ${chain[0]} -> served by ${model}`);
      console.log(`[ladder] ${chain[0]} -> served by ${model}`);
      return;
    } catch (e) {
      if (c && (c.lane === "grok" || c.lane === "gpt")) meter(model, "fail"); // litellm lane meters itself
      meterEvent(`[ladder] ${model} failed: ${errText(e).slice(0, 90)}`);
      if (clientStreaming) { // PRD-005: client bytes already flowed; the lane closed the client stream
        console.log(`[ladder] ${chain[0]} -> stream aborted mid-flight (no walk; client stream owned by lane)`);
        return;
      }
      console.log(`[ladder] ${model} failed: ${errText(e).slice(0, 100)}`);
    }
  }
  if (rsp) return sendOpenAIError(res, 502, `router: all models exhausted for ${startModel}`); // C-7: responses-shaped exhaustion error
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `router: all models exhausted for ${startModel}` } }));
}


const { execSync } = require("child_process");
async function handleImageGenerate(req, res, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return sendInvalidRequest(res, "prompt required");
  let model;
  const imgDefault = (cfg.images && cfg.images.default) || "grok-imagine-image-2.0";
  if (body.model === undefined || body.model === null || body.model === "") model = imgDefault;
  else if (typeof body.model !== "string") return sendInvalidRequest(res, "model: must be a string when present");
  else model = body.model;
  if (model === "best" || model === "") {
    // owner ladder: subscription grok first, best OpenAI on OpenRouter as paid fallback (config-driven, PRD-002)
    try { return await handleImageGenerate(req, res, { ...body, model: imgDefault }); }
    catch (e) { console.log("[image] grok sub lane failed:", String(e.message).slice(0, 100)); return await handleImageGenerate(req, res, { ...body, model: (cfg.images && cfg.images.paidFallback) || "openai/gpt-5.4-image-2" }); }
  }
  if (model.startsWith((cfg.images && cfg.images.grokPrefix) || "grok-")) {
    const t = tokens();
    if (!t.grok) throw new Error("no grok token");
    const r = await postUpstreamPlain("api.x.ai", "/v1/images/generations", { "Authorization": "Bearer " + t.grok, "content-type": "application/json" }, JSON.stringify({ model, prompt }), 180000);
    if (r.status !== 200) throw new Error("grok images " + r.status + ": " + r.body.slice(0, 150));
    const j = JSON.parse(r.body);
    const dir2 = path.join(H, "fabric-images");
    fs.mkdirSync(dir2, { recursive: true });
    const stamp2 = Date.now();
    const saved2 = [];
    (j.data || []).forEach((img, i) => {
      if (!img.url) return;
      const ext = (img.mime_type || "image/jpeg").includes("png") ? "png" : "jpg";
      const path2 = `${dir2}/img-${stamp2}-${i}.${ext}`;
      try {
        const dl = https.get(img.url, (ir) => {
          const f = fs.createWriteStream(path2);
          ir.pipe(f);
          f.on("finish", () => f.close());
        });
        dl.on("error", () => {});
        saved2.push(path2);
      } catch {}
    });
    console.log(`[image] ${model} (subscription) -> ${saved2.length} file(s)`);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ model, saved: saved2, text: "" }));
  }
  const orKey = fs.readFileSync(path.join(H, "fabric", "secrets", "openrouter.key"), "utf8").trim();
  const out = await postUpstreamPlain("openrouter.ai", "/api/v1/chat/completions", {
    "Authorization": "Bearer " + orKey, "content-type": "application/json",
  }, JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }), 180000);
  if (out.status !== 200) { console.log("[image] openrouter " + out.status + ": " + out.body.slice(0, 200)); res.writeHead(502, {"content-type":"application/json"}); return res.end(JSON.stringify({error:{message:"router: image generation failed"}})); } // MEDIUM-3 residual: static client message, detail to log
  const j = JSON.parse(out.body);
  const msg = (j.choices || [{}])[0].message || {};
  const images = msg.images || [];
  console.log("[image-debug] msg keys:", Object.keys(msg).join(","), "| images:", images.length, "| first:", images[0] ? JSON.stringify(images[0]).slice(0, 80) : "none");
  const dir = path.join(H, "fabric-images");
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  const stamp = Date.now();
  images.forEach((img, i) => {
    const url = (img.image_url && (typeof img.image_url === "string" ? img.image_url : img.image_url.url)) || img.url || "";
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(url);
    if (!m) return;
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const path = `${dir}/img-${stamp}-${i}.${ext}`;
    fs.writeFileSync(path, Buffer.from(m[2], "base64"));
    saved.push(path);
  });
  console.log(`[image] ${model} -> ${saved.length} file(s)`);
  res.writeHead(200, {"content-type":"application/json"});
  res.end(JSON.stringify({ model, saved, text: (typeof msg.content === "string" ? msg.content : "").slice(0, 300) }));
}
function postUpstreamPlain(host, path, headers, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(bodyStr) }, timeout: timeoutMs }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(bodyStr);
  });
}

// ---------- PRD-001b B-1..B-8: POST /v1/chat/completions (openai chat dialect inbound) ----------
async function handleChatCompletions(req, res, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return sendOpenAIError(res, 400, "request body must be a JSON object");
  if (!Array.isArray(body.messages) || body.messages.length === 0) return sendOpenAIError(res, 400, "messages: required field missing or not a non-empty array");
  const translated = openaiChatToAnthropic(body); // pure, crash-guarded translation (B-2/B-4)
  if (typeof body.reasoning_effort === "string") translated._routeEffort = body.reasoning_effort; // PRD-004
  const reqModel = (typeof body.model === "string" && body.model.trim()) ? body.model.trim() : "auto";
  let startModel = reqModel;
  if (reqModel === "auto" || (!CANDIDATES[reqModel] && !reqModel.startsWith("openrouter"))) {
    startModel = "auto"; // absent / "auto" / unknown model -> auto (B-3)
  }
  if (startModel === "auto") {
    try { startModel = await decideAuto(translated.messages); }
    catch (e) {
      const t = JSON.stringify(translated.messages || []).toLowerCase();
      const { image, video } = detectModalities(translated.messages);
      startModel = (image || video) ? "glm-5.3-flash" : (t.length < 400 ? "glm-5.3-flash" : "glm-5.3");
      console.log(`[auto] fallback heuristic -> ${startModel} (${errText(e).slice(0, 60)})`);
    }
  }
  // C-7 ladder contract applies to the chat dialect too: no direct short-circuit.
  return serveWithLadder(req, res, translated, startModel, "openai-chat", reqModel);
}

// ---------- PRD-001c C-1..C-7: POST /v1/responses (openai responses dialect inbound) ----------
async function handleResponses(req, res, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return sendOpenAIError(res, 400, "request body must be a JSON object");
  const inputOk = (typeof body.input === "string" && body.input.trim().length > 0) || (Array.isArray(body.input) && body.input.length > 0);
  if (!inputOk) return sendOpenAIError(res, 400, "input: required field missing or not a non-empty string/array");
  // C-1: model semantics ride the A-5 helper - absent/blank model defaults to "auto" (codex may omit
  // it), helper passthrough (unknown names) resolves to auto, candidates + openrouter-* honored as-is.
  const reqModel = (typeof body.model === "string" && body.model.trim()) ? body.model.trim() : "auto";
  const checked = validateMessageBody({ model: reqModel });
  if (!checked.ok) return sendOpenAIError(res, 400, checked.message);
  const translated = responsesToAnthropic(body); // C-2: pure, crash-guarded translation
  const effort = (body.reasoning && typeof body.reasoning === "object" && typeof body.reasoning.effort === "string") ? body.reasoning.effort : "";
  if (effort) console.log(`[responses] reasoning effort=${effort} (informational)`); // C-3: recorded for ladder logs
  translated._routeEffort = effort; // PRD-004: rides the route tag
  let startModel = checked.passthrough ? "auto" : checked.model;
  if (startModel === "auto") {
    try { startModel = await decideAuto(translated.messages); }
    catch (e) {
      const t = JSON.stringify(translated.messages || []).toLowerCase();
      const { image, video } = detectModalities(translated.messages);
      startModel = (image || video) ? "glm-5.3-flash" : (t.length < 400 ? "glm-5.3-flash" : "glm-5.3");
      console.log(`[auto] fallback heuristic -> ${startModel} (${errText(e).slice(0, 60)})`);
    }
  }
  // C-7: every pick rides serveWithLadder so a 429 on any lane (incl. litellm) walks the chain
  // instead of failing the request - the direct short-circuit broke the owner ladder contract.
  return serveWithLadder(req, res, translated, startModel, "responses", reqModel);
}

function handleRequest(req, res) {
  refreshConfig(); // PRD-002: hot-reload the config on mtime change; invalid configs keep serving the last known good
  // PRD-005 diagnostic: keep the raw bytes of recent SSE streams. When a client
  // reports a malformed stream the exact bytes are on disk, not a guessing game.
  const _cap = [];
  const _w = res.write.bind(res), _e = res.end.bind(res);
  res.write = (c, ...a) => { if (typeof c === "string" && _cap.length < 8192) _cap.push(c); return _w(c, ...a); };
  res.end = (c, ...a) => {
    try {
      if (_cap.length && _cap.some((x) => x.includes("event:"))) {
        fs.mkdirSync(CAPTURE_DIR, { recursive: true });
        fs.writeFileSync(path.join(CAPTURE_DIR, "stream-" + Date.now() + "-" + Math.floor(Math.random() * 1e4) + ".sse"), _cap.join(""));
        const all = fs.readdirSync(CAPTURE_DIR).filter((x) => x.endsWith(".sse")).sort();
        while (all.length > 6) fs.unlinkSync(path.join(CAPTURE_DIR, all.shift()));
      }
    } catch {}
    return _e(c, ...a);
  };
  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/dashboard"))) { // PRD-005: static UI, public; data endpoints stay auth-gated
    try {
      const html = fs.readFileSync(path.join(__dirname, "dashboard.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("dashboard.html not found beside server.js");
    }
    return;
  }
  if (!authorized(req)) { // HIGH-1: auth gate before any data; only the static dashboard UI is public
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "unauthorized: missing or invalid bearer token" } }));
    req.resume();
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/v1/usage")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ startedAt: USAGE.startedAt, uptimeSec: Math.floor((Date.now() - USAGE.startedAt) / 1000), models: USAGE.models, events: USAGE.events.slice(0, 30) }));
  }
  if (req.method === "GET" && req.url.startsWith("/v1/config")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(cfg, null, 2));
  }
  const chunks = [];
  let bodyBytes = 0;
  req.on("data", (c) => {
    bodyBytes += c.length;
    if (bodyBytes > MAX_BODY) { // MEDIUM-2: reject oversized bodies instead of buffering into OOM
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "request body too large" } }));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    let bodyBuf = Buffer.concat(chunks);
    if (req.method === "POST" && req.url.startsWith("/v1/config")) { // PRD-005: config editor write-back; validated, atomic, hot-reloaded
      let nc;
      try { nc = JSON.parse(bodyBuf.toString("utf8")); }
      catch { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "config body is not valid JSON" } })); }
      const cerr = validateConfig(nc);
      if (cerr) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "config rejected: " + cerr } })); }
      try { fs.writeFileSync(CONFIG_PATH + ".tmp", JSON.stringify(nc, null, 2)); fs.renameSync(CONFIG_PATH + ".tmp", CONFIG_PATH); }
      catch (e) { res.writeHead(500, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "config write failed: " + errText(e).slice(0, 80) } })); }
      refreshConfig();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, note: "config written; hot reload applied" }));
    }
    if (req.url.includes("/v1/images/generate")) {
      let imgBody;
      try { imgBody = JSON.parse(bodyBuf.toString("utf8") || "{}"); }
      catch { return sendInvalidRequest(res, "request body is not valid JSON"); }
      handleImageGenerate(req, res, imgBody).catch((e) => {
        console.log("[image] error:", String(e.message).slice(0, 200)); // MEDIUM-3: detail to log, static message to client
        if (!res.headersSent) { res.writeHead(502, {"content-type":"application/json"}); res.end(JSON.stringify({error:{message:"router: image generation failed"}})); }
      });
      return;
    }
    const isMsg = req.url.includes("/v1/messages") || req.url.includes("/chat/completions") || req.url.includes("/v1/responses");
    if (!isMsg) return proxyToLiteLLM(req, res, bodyBuf);
    let parsed;
    try { parsed = JSON.parse(bodyBuf.toString("utf8")); }
    catch { return sendInvalidRequest(res, "request body is not valid JSON"); }
    // B-1: dialect is selected by URL path only - /v1/chat/completions speaks openai chat schema end to end.
    if (req.url.includes("/chat/completions")) {
      return handleChatCompletions(req, res, parsed).catch((e) => {
        console.log("[chat] error:", errText(e).slice(0, 200)); // MEDIUM-3: detail to log, static to client
        if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "router: upstream request failed" } })); }
      });
    }
    // C-1: /v1/responses speaks the openai responses dialect end to end (URL-path rule, same as B-1).
    if (req.url.includes("/v1/responses")) {
      return handleResponses(req, res, parsed).catch((e) => {
        console.log("[responses] error:", errText(e).slice(0, 200)); // MEDIUM-3
        if (!res.headersSent) sendOpenAIError(res, 502, "router: upstream request failed");
      });
    }
    const checked = validateMessageBody(parsed);
    if (!checked.ok) return sendInvalidRequest(res, checked.message);
    if (checked.passthrough) return proxyToLiteLLM(req, res, bodyBuf);
    let startModel = parsed.model;
    try {
      if (startModel === "auto") {
        try { startModel = await decideAuto(parsed.messages); }
        catch (e) {
          const t = JSON.stringify(parsed.messages || []).toLowerCase();
          const { image, video } = detectModalities(parsed.messages);
          startModel = (image || video) ? "glm-5.3-flash" : (t.length < 400 ? "glm-5.3-flash" : "glm-5.3");
          console.log(`[auto] fallback heuristic -> ${startModel} (${String(e.message).slice(0, 60)})`);
        }
      }
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: String(e.message) } }));
    }
    // litellm-lane picks also ride serveWithLadder (ladder contract); passthrough models
    // (unknown names) still proxy raw above.
    return serveWithLadder(req, res, parsed, startModel);
  });
}

// MEDIUM-4: two listeners on the shared handler - loopback for macdev-local clients,
// the Tailscale IP for the tailnet. LAN interfaces no longer bound. If Tailscale is
// not up yet at boot, the tailnet bind retries every 30s instead of crash-looping.
const loopbackServer = http.createServer(handleRequest);
loopbackServer.listen(PORT, "127.0.0.1", () => console.log("fabric-router v3 (sse) on 127.0.0.1:" + PORT));
const tsServer = http.createServer(handleRequest);
function bindTailnet() {
  tsServer.listen(PORT, TS_IP, () => console.log("fabric-router v3 (sse) on " + TS_IP + ":" + PORT))
    .on("error", (e) => { console.log("[bind] tailscale ip not ready, retry in 30s:", errText(e).slice(0, 80)); setTimeout(bindTailnet, 30000); });
}
if (TS_IP) bindTailnet(); // PRD-003 E3: empty tailnetIp = loopback-only (bot posture); never bind all interfaces
else console.log("[bind] loopback-only: tailnetIp empty, tailnet bind skipped");
