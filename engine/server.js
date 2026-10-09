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
const laneQuotaCooldown = {}; // lane -> epoch ms; usage_limit_reached 429s cool the lane instead of re-attempting every request
const laneQuotaStrikes = {}; // PRD-004: usage_limit_reached strikes per lane; a second strike within a walk cools the lane, any success resets
function validateConfig(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "config: not an object";
  if (!c.candidates || typeof c.candidates !== "object" || Array.isArray(c.candidates) || !Object.keys(c.candidates).length) return "candidates: missing or empty";
  for (const [name, cd] of Object.entries(c.candidates)) {
    if (!cd || typeof cd !== "object") return "candidate " + name + ": not an object";
    if (!["gpt", "grok", "litellm"].includes(cd.lane)) return "candidate " + name + ": unknown lane";
    if (!Array.isArray(cd.mods)) return "candidate " + name + ": mods must be an array";
    if (cd.contextWindow !== undefined && (typeof cd.contextWindow !== "number" || cd.contextWindow <= 0)) return "candidate " + name + ": contextWindow must be a positive number";
  }
  if (c.contextWindowOverrides) {
    if (typeof c.contextWindowOverrides !== "object" || Array.isArray(c.contextWindowOverrides)) return "contextWindowOverrides: must be an object of model -> positive number";
    for (const [m, w] of Object.entries(c.contextWindowOverrides)) if (typeof w !== "number" || w <= 0) return "contextWindowOverrides " + m + ": must be a positive number";
  }
  if (c.auto && c.auto.windowSafety !== undefined && (typeof c.auto.windowSafety !== "number" || c.auto.windowSafety <= 0 || c.auto.windowSafety > 1)) return "auto.windowSafety: must be a number in (0, 1]";
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
let CATALOG = {}, catalogMtimeMs = 0;
const CATALOG_PATH = process.env.BELAY_CATALOG || path.join(path.dirname(CONFIG_PATH), "model-catalog.json");
function loadCatalog() {
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    CATALOG = raw.catalog || {};
    catalogMtimeMs = fs.statSync(CATALOG_PATH).mtimeMs;
  } catch { CATALOG = {}; }
}
function refreshConfig() {
  try { if (fs.statSync(CONFIG_PATH).mtimeMs !== cfgMtimeMs) loadConfig(); } catch {}
  try { if (fs.statSync(CATALOG_PATH).mtimeMs !== catalogMtimeMs) loadCatalog(); } catch {}
}
loadConfig();
loadCatalog();
if (!cfg) { console.error("[config] no valid config at " + CONFIG_PATH + " - refusing to start"); process.exit(1); }

// ---------- PRD-005: usage metering + dashboard ----------
// Per-lane-attempt counters, persisted under the data dir; /v1/usage and the
// dashboard read this. Streams count requests/outcomes; non-stream counts tokens.
const DATA_DIR = process.env.BELAY_DATA || process.env.FABRIC_DATA || path.join(H, "belay");
const USAGE_PATH = path.join(DATA_DIR, "usage.json");
const USAGE = { startedAt: Date.now(), models: {}, events: [] };
try { const d = JSON.parse(fs.readFileSync(USAGE_PATH, "utf8")); USAGE.models = d.models || {}; USAGE.day = d.day || { date: new Date().toISOString().slice(0, 10), models: {} }; USAGE.events = (d.events || []).slice(0, 50); } catch {}
function meter(model, outcome, tokens, ms) {
  const today = new Date().toISOString().slice(0, 10);
  if (!USAGE.day || USAGE.day.date !== today) USAGE.day = { date: today, models: {} };
  const dm = USAGE.day.models[model] || (USAGE.day.models[model] = { tokens: 0, fails: 0 });
  if (outcome === "ok" && tokens) dm.tokens += (tokens.in || 0) + (tokens.out || 0);
  if (outcome === "fail") dm.fails++;
  const m = USAGE.models[model] || (USAGE.models[model] = { requests: 0, ok: 0, failed: 0, tokensIn: 0, tokensOut: 0, lastServed: 0, msTotal: 0 });
  m.requests++;
  if (outcome === "ok") { m.ok++; m.lastServed = Date.now(); if (ms) m.msTotal += ms; if (tokens) { m.tokensIn += tokens.in || 0; m.tokensOut += tokens.out || 0; } }
  else if (outcome === "fail") m.failed++;
  persistUsage();
}
// Streams meter outcome at hop hand-off, before upstream usage exists; the real
// token counts arrive at stream completion. meterTokens adds them without
// re-counting the request so day pools (and providerPools feeding the picker)
// reflect streamed traffic too.
function meterTokens(model, tokens) {
  if (!tokens) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!USAGE.day || USAGE.day.date !== today) USAGE.day = { date: today, models: {} };
  const dm = USAGE.day.models[model] || (USAGE.day.models[model] = { tokens: 0, fails: 0 });
  dm.tokens += (tokens.in || 0) + (tokens.out || 0);
  const m = USAGE.models[model] || (USAGE.models[model] = { requests: 0, ok: 0, failed: 0, tokensIn: 0, tokensOut: 0, lastServed: 0, msTotal: 0 });
  m.tokensIn += tokens.in || 0; m.tokensOut += tokens.out || 0;
  persistUsage();
}
function persistUsage() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(USAGE_PATH, JSON.stringify({ startedAt: USAGE.startedAt, day: USAGE.day, models: USAGE.models, events: USAGE.events })); } catch {}
}
function meterEvent(text) { USAGE.events.unshift({ t: Date.now(), text: String(text).slice(0, 160) }); if (USAGE.events.length > 50) USAGE.events.pop(); }

// Provider pools: subscription plans are shared across their models. Quota burn,
// utilization, and health are per-PLAN, not per-model (glm-5.3 + glm-5.3-flash
// drain the same z.ai window; astra/sol/luna drain the same OpenAI plan).
function providerPools() {
  // Plans differ widely in real capacity (GLM Max is prompt-capped weekly, OpenAI/xAI
  // publish nothing). Per-pool budgets express that; global value is the fallback.
  const budgetFor = (pool) => ((cfg.auto && cfg.auto.laneBudgetTokensPerPool) || {})[pool] || (cfg.auto && cfg.auto.laneBudgetTokens) || 500000;
  const pools = {};
  const poolOf = (name, lane) => {
    if (lane === "gpt") return "openai-plan";
    if (lane === "grok") return "grok-plan";
    if (name.startsWith("openrouter")) return "openrouter-paygo";
    return "zai-plan";
  };
  const today = new Date().toISOString().slice(0, 10);
  if (!USAGE.day || USAGE.day.date !== today) USAGE.day = { date: today, models: {} };
  for (const [name, cd] of Object.entries(CANDIDATES)) {
    const pool = poolOf(name, cd.lane);
    const p = pools[pool] || (pools[pool] = { tokensToday: 0, failsToday: 0, models: [], budgetTokens: pool === "openrouter-paygo" ? 0 : budgetFor(pool) });
    p.models.push(name);
    const d = USAGE.day.models[name] || { tokens: 0, fails: 0 };
    p.tokensToday += d.tokens;
    p.failsToday += d.fails;
  }
  for (const p of Object.values(pools)) {
    p.utilizationToday = p.budgetTokens ? Math.min(1, p.tokensToday / p.budgetTokens) : 0;
    const laneMs = p.models.reduce((a, n) => a + ((USAGE.models[n] || {}).msTotal || 0), 0);
    const laneOk = p.models.reduce((a, n) => a + ((USAGE.models[n] || {}).ok || 0), 0);
    p.avgLatencyMs = laneOk ? Math.round(laneMs / laneOk) : null;
  }
  return pools;
}

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
  if (model === "auto" || model === "orchestrator" || CANDIDATES[model] || model.startsWith("openrouter")) { // PRD-004: "orchestrator" = picker restricted to auto.orchestratorModels
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

// ---------- context-window routing: know the size before you pick ----------
// A prompt larger than every lane's window cannot be rescued by ANY fallback:
// every hop 400s (grok input_too_large, glm ContextWindowExceeded), poisons the
// lane failure counters, and the client gets a misleading 502 "all models
// exhausted" (fleet incident 2026-10-03: a >1M-token session dead-walked every
// chain all afternoon). So: estimate the request size first, never pick or walk
// a lane whose window cannot fit it, and reject up front with a clear 400 when
// nothing in the pool can serve the request. Skips are not failures - they do
// not touch the meter, so health/degraded-lane data stays honest.
// Window source, first wins: config contextWindowOverrides (machine truth -
// e.g. a subscription whose real limit sits below the catalog number) ->
// candidate.contextWindow -> model-catalog.json contextWindow -> null
// (unknown: no constraint, the pre-window-routing behavior).
const TOKENS_PER_CHAR = 4; // coarse chars->tokens; the windowSafety margin absorbs the drift
const IMAGE_URL_TOKENS = 1500; // url-sourced images: size unknowable at the router, flat charge
function estimateTokens(body) {
  let chars = 0, imageTokens = 0;
  const count = (c) => {
    if (typeof c === "string") { chars += c.length; return; }
    if (!Array.isArray(c)) { if (c != null) { try { chars += JSON.stringify(c).length; } catch {} } return; }
    for (const b of c) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
      else if (b.type === "image") {
        const src = b.source;
        if (src && typeof src.data === "string") imageTokens += Math.max(256, Math.ceil((src.data.length * 3 / 4) / 600)); // decoded bytes -> tile-approximation
        else imageTokens += IMAGE_URL_TOKENS;
      }
      else if (b.type === "tool_use") { try { chars += JSON.stringify(b.input == null ? {} : b.input).length; } catch {} }
      else if (b.type === "tool_result") count(b.content);
      else { try { chars += JSON.stringify(b).length; } catch {} }
    }
  };
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (typeof body.system === "string") chars += body.system.length;
    else if (body.system != null) { try { chars += JSON.stringify(body.system).length; } catch {} }
    if (Array.isArray(body.tools)) for (const t of body.tools) { try { chars += JSON.stringify(t).length; } catch {} }
    if (Array.isArray(body.messages)) for (const m of body.messages) count(m && m.content);
  }
  return Math.ceil(chars / TOKENS_PER_CHAR) + imageTokens;
}
function windowFor(model) {
  const ov = cfg && cfg.contextWindowOverrides && cfg.contextWindowOverrides[model];
  if (typeof ov === "number" && ov > 0) return ov;
  const cd = CANDIDATES[model];
  if (cd && typeof cd.contextWindow === "number" && cd.contextWindow > 0) return cd.contextWindow;
  const cat = CATALOG[model] || {};
  if (typeof cat.contextWindow === "number" && cat.contextWindow > 0) return cat.contextWindow;
  return null;
}
function effMaxTokens(body) {
  if (body && typeof body.max_tokens === "number" && body.max_tokens > 0) return body.max_tokens;
  return 16384; // reasoning-era agent output budget when the client omits it (PRD-001 reopen 2026-10-06: 4096 starved thinking lanes)
}
function windowFits(model, est, maxTokens) {
  const w = windowFor(model);
  if (!w) return true;
  const safety = (cfg && cfg.auto && typeof cfg.auto.windowSafety === "number" && cfg.auto.windowSafety > 0 && cfg.auto.windowSafety <= 1) ? cfg.auto.windowSafety : 0.8;
  return est + maxTokens <= Math.floor(w * safety);
}
function maxServableWindow(models) {
  let max = 0;
  for (const m of models) { const w = windowFor(m); if (w && w > max) max = w; }
  return max;
}
function promptTooLargeMessage(est, maxWindow) {
  return `router: prompt too large for every lane (estimated ~${est} tokens vs largest window ${maxWindow || "?"}). No fallback can serve this request - compact or restart the client session.`;
}
function heuristicModel(body, est, orchestratorOnly) { // window+modality-aware successor of the old flash/glm fallback pick
  const { image, video } = detectModalities(body && body.messages);
  const fits = Object.keys(CANDIDATES).filter((k) => (!image || (CANDIDATES[k].mods || []).includes("image")) && (!video || (CANDIDATES[k].mods || []).includes("video")) && windowFits(k, est, effMaxTokens(body)));
  if (!fits.length) {
    const tl = { est, maxWindow: maxServableWindow(Object.keys(CANDIDATES)) };
    console.log(`[auto] heuristic: prompt too large for every lane (est ${est} tokens) - 400 no walk`);
    meterEvent(`[auto] heuristic: prompt too large (est ${est} tokens) - 400 no walk`);
    return { model: null, tooLarge: tl };
  }
  let taskLen = 0; try { taskLen = JSON.stringify((body && body.messages) || []).length; } catch {}
  const orchPrefer = ((cfg.auto && Array.isArray(cfg.auto.orchestratorPrimary) && cfg.auto.orchestratorPrimary.find((m) => fits.includes(m))) || "glm-5.3");
  const prefer = orchestratorOnly ? orchPrefer : ((image || video || taskLen < 400) ? "glm-5.3-flash" : "glm-5.3"); // PRD-004 owner rule 2026-10-09: primary tier (astra/sol) first; glm-5.3 only when no primary fits
  const pick = fits.includes(prefer) ? prefer : fits.slice().sort((a, b) => (windowFor(b) || 0) - (windowFor(a) || 0))[0];
  return { model: pick };
}

// ---------- PRD-001: session-sticky lanes + honest usage carryover ----------
// Codex-style clients resend the full conversation every turn, so the prefix
// (system + first message) is stable per session while turns append at the
// tail. Pin the first-turn lane pick per fingerprint: turn 2+ reuses the warm
// prompt cache instead of re-running the picker, and a ladder walk re-pins the
// lane that actually served. R2.2: the original lane returns only when a NEW
// session maps to it (entry replaced per fingerprint; no mid-session un-pin).
// Entries idle out after 2h (lazy sweep on lookup keeps the map bounded).
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const sessionAffinity = new Map(); // fingerprint -> { model, lastRealPromptTokens, lastSeenMs }
function sessionFingerprint(body) {
  let sys = "";
  const s = body && body.system;
  if (typeof s === "string") sys = s;
  else if (s != null) { try { sys = JSON.stringify(s); } catch {} }
  let content = "";
  const first = safeMessages(body && body.messages)[0];
  if (first && typeof first === "object" && first.content != null) { try { content = JSON.stringify(first.content); } catch {} }
  return crypto.createHash("sha256").update(sys.slice(0, 1024) + content.slice(0, 1024)).digest("hex");
}
function stickyLookup(fp) {
  const now = Date.now();
  for (const [k, v] of sessionAffinity) if (now - v.lastSeenMs > SESSION_IDLE_MS) sessionAffinity.delete(k);
  return sessionAffinity.get(fp) || null;
}
function stickyPin(fp, h8, model, how, dial) {
  sessionAffinity.set(fp, { model, dial: dial || "auto", lastRealPromptTokens: 0, lastSeenMs: Date.now() });
  console.log(`[sticky] session ${h8} pinned -> ${model} (${how}, dial=${dial || "auto"})`);
}
// R3.1/R3.3: prefer the session's last REAL prompt size (+ one turn of growth)
// over chars/4 when sizing windows and message_start estimates.
function estimateForSession(body, fp) {
  const pinned = fp && stickyLookup(fp);
  if (pinned && typeof pinned.lastRealPromptTokens === "number" && pinned.lastRealPromptTokens > 0) {
    const est = pinned.lastRealPromptTokens + 4096;
    console.log(`[window] session ${String(fp).slice(0, 8)} est ${est} = real ${pinned.lastRealPromptTokens} + 4096 (carryover)`);
    return est;
  }
  return estimateTokens(body);
}

async function decideAuto(body, orchestratorOnly) {
  const messages = safeMessages(body && body.messages);
  const est = estimateTokens(body);
  const task = messages.filter((m) => m && typeof m === "object").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n").slice(-4000);
  const { image, video } = detectModalities(messages);
  const orchList = (cfg.auto && Array.isArray(cfg.auto.orchestratorModels) && cfg.auto.orchestratorModels.length) ? cfg.auto.orchestratorModels : ["glm-5.3"]; // PRD-004: orchestrator-class membership is config-authored
  let eligible = Object.keys(CANDIDATES).filter((k) => (!image || CANDIDATES[k].mods.includes("image")) && (!video || CANDIDATES[k].mods.includes("video")) && windowFits(k, est, effMaxTokens(body)) && (!orchestratorOnly || orchList.includes(k)));
  const orchPrimary = (cfg.auto && Array.isArray(cfg.auto.orchestratorPrimary) && cfg.auto.orchestratorPrimary.length) ? cfg.auto.orchestratorPrimary : [];
  if (orchestratorOnly && orchPrimary.length) {
    const prim = eligible.filter((k) => orchPrimary.includes(k));
    if (prim.length) eligible = prim; // PRD-004 owner rule 2026-10-09: primary tier wins whenever any of it can serve; glm-5.3 joins only when none can (quota, cooldown, window)
  }
  if (!eligible.length) { // window routing: nothing fits, do not even spend the jev call
    console.log(`[auto] prompt too large for every lane (est ${est} tokens) - 400 no walk`);
    meterEvent(`[auto] prompt too large (est ${est} tokens) - 400 no walk`);
    return { model: null, tooLarge: { est, maxWindow: maxServableWindow(Object.keys(CANDIDATES)) } };
  }
  // Real per-lane signals (PRD-005 meter): tokens burned today vs the configured
  // soft budget -> projectedRemainingRatio; recent failures penalize. The router
  // now avoids nearly-exhausted lanes instead of picking them and eating a 429 walk.
  const budget = (cfg.auto && cfg.auto.laneBudgetTokens) || 500000;
  const today = new Date().toISOString().slice(0, 10);
  if (!USAGE.day || USAGE.day.date !== today) USAGE.day = { date: today, models: {} };
  // PRD-006 fix: jev must SEE the tier and the cost, or every pick collapses to
  // one cheap-sounding lane. Tier from config class; relativeCost ranks the
  // classes (1 = cheapest subscription tier, 3 = frontier); description grounds it.
  const TIER_COST = { fast: 1, workhorse: 2, frontier: 3 };
  const TIER_DESC = {
    fast: "economical tier: fast, cheap, right for trivial/routine work",
    workhorse: "workhorse tier: strong general model for routine-to-complex implementation",
    frontier: "frontier tier: strongest models, reserve for complex/ambiguous/security-sensitive/deep-reasoning work",
  };
  const pools = providerPools();
  const poolOf = (k) => (CANDIDATES[k].lane === "gpt" ? "openai-plan" : CANDIDATES[k].lane === "grok" ? "grok-plan" : (k.startsWith("openrouter") ? "openrouter-paygo" : "zai-plan"));
  const criteria = {};
  for (const k of eligible) {
    const d = USAGE.day.models[k] || { tokens: 0, fails: 0 };
    const pool = pools[poolOf(k)] || { utilizationToday: 0, tokensToday: 0, failsToday: 0, avgLatencyMs: null };
    const cat = CATALOG[k] || {};
    const tier = cat.tier || CANDIDATES[k].class || "fast";
    const m = USAGE.models[k] || {};
    criteria[k] = {
      agent: k,
      tier,
      tierDescription: cat.useFor || TIER_DESC[tier] || TIER_DESC.fast,
      relativeCost: cat.relativeCost || TIER_COST[tier] || 2,
      ...(cat.contextWindow ? { contextWindow: cat.contextWindow } : {}),
      providerPool: poolOf(k),
      poolUtilizationToday: pool.utilizationToday,
      projectedRemainingRatio: Math.max(0.05, 1 - pool.utilizationToday),
      poolFailsToday: pool.failsToday,
      tokensToday: d.tokens,
      recentFailures: d.fails,
      avgLatencyMs: pool.avgLatencyMs,
      capabilities: CANDIDATES[k].mods,
      supportedEfforts: ["low", "high", "max"],
    };
  }
  const t0 = Date.now();
  const q = choice((cfg.auto && cfg.auto.question) || "Which model should handle this coding task? Pick the model with the LOWEST relativeCost whose tier is fully capable of completing it correctly. Frontier-tier models are for complex, ambiguous, security-sensitive, or deep-reasoning work; do not use them for routine tasks. Economical (fast) tier is for trivial/routine work. Among equally-capable candidates, prefer the provider pool with the LOWEST poolUtilizationToday: subscription windows expire unused and exhausted windows stall work, so spread load across plans. Never pick a model whose tier risks task failure just because it is cheap.", criteria);
  const dq = choice("Classify the difficulty of this task.", {
    trivial: { agent: "trivial", description: "mechanical: lookup, formatting, rename" },
    routine: { agent: "routine", description: "standard implementation, clear requirements" },
    complex: { agent: "complex", description: "multi-system, ambiguous, or performance-sensitive" },
    frontier: { agent: "frontier", description: "deep reasoning, security-sensitive, architectural" },
  });
  const result = await client.systemOne({ state: {
    task: task.slice(0, (cfg.auto && cfg.auto.maxTaskChars) || 2000),
    estimatedPromptTokens: est, // context-window routing: the picker sees the size class it is routing for
    providerPoolsToday: pools,
    recentLadderEvents: USAGE.events.filter((e) => (e.t || 0) >= Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z")).slice(0, 6).map((e) => e.text), // same UTC day only: yesterday's failures must not narrate as "recent" to the picker
  }, questions: { route: q, difficulty: dq } });
  const picked = (result.answers.route || {}).choice;
  const difficulty = (result.answers.difficulty || {}).choice || "";
  if (!CANDIDATES[picked]) throw new Error("bad pick " + JSON.stringify(picked));
  console.log(`[auto] typesafe -> ${picked} (${difficulty || "?"}, ${Date.now() - t0}ms${orchestratorOnly ? ", orchestrator" : ""})`);
  return { model: picked, difficulty };
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
// Direct-lane keepalive: gpt/grok can think SILENTLY for many minutes on large
// contexts (2026-10-03: "Request timed out" retry loops while the model sat in
// reasoning emitting zero bytes). Pings put bytes on the wire so client idle
// timers reset; they carry no content, so harnesses ignore them (anthropic
// streams ping natively). Litellm lanes stay lazy-primed: empty streams there
// must keep the ladder walkable, and prime-now would spend that card.
const PING_MS = 20000;
const DIRECT_LANE_IDLE_MS = 600000; // upstream socket idle timeout: 240s aborted silent thinking mid-flight
function startKeepalivePings(res, pingMs) {
  const write = () => { try { if (!res.writableEnded && !res.destroyed) res.write(`event: ping\ndata: {"type":"ping"}\n\n`); } catch {} };
  const timer = setInterval(write, pingMs || PING_MS);
  if (typeof timer.unref === "function") timer.unref();
  const stop = () => { try { clearInterval(timer); } catch {} };
  try { res.on("close", stop); res.on("finish", stop); } catch {}
  return stop;
}
// Open a message; optionally lead with a tag-only thinking block (route visibility),
// then the text block. Returns block-index helpers for multi-block streams.
function openAnthropicStream(res, model, tag, tagAlways, keepalive, estInput) {
  if (res.headersSent) { // never throw from event handlers: degrade to a dead stream
    console.log("[stream] open on already-started response - returning dead stream (walk-after-bytes escaped a guard)");
    return { textIdx: -1, tagEmitted: true, primed: () => true, prime() {}, openBlock: () => -1, closeBlock() {}, closeAll() {}, stopPings() {} };
  }
  let tagEmitted = false;
  let next = 0;
  const open = [];
  const openBlock = (cb) => { const i = next++; open.push(i); sseWrite(res, "content_block_start", { type: "content_block_start", index: i, content_block: cb }); return i; };
  const closeBlock = (i) => { sseWrite(res, "content_block_stop", { type: "content_block_stop", index: i }); const k = open.indexOf(i); if (k >= 0) open.splice(k, 1); };
  // LAZY PRIMING: nothing reaches the client until the first real content block.
  // If the upstream streams nothing (empty 200s under quota pressure), zero
  // client bytes have flowed and the ladder can still walk to another hop.
  let primed = false;
  const prime = () => {
    if (primed) return;
    primed = true;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    sseWrite(res, "message_start", { type: "message_start", message: { id: "msg_router_" + Date.now(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estInput || 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }); // cache values unknown at open; real ones ride message_delta
    if (tag && tagAlways) {
      const i = openBlock({ type: "thinking", thinking: "" });
      sseWrite(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: tag + "\n" } });
      sseWrite(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "sig_router" } });
      closeBlock(i);
      tagEmitted = true;
    }
  };
  // text block opens lazily on the first text delta - an empty text block
  // (start+stop, no deltas) reads as a malformed stream to clients.
  let stopPings = () => {};
  if (keepalive) { prime(); stopPings = startKeepalivePings(res); } // direct lanes: headers + message_start immediately, pings until content lands
  return { textIdx: -1, get tagEmitted() { return tagEmitted; }, primed: () => primed, prime, openBlock: (cb) => { prime(); return openBlock(cb); }, closeBlock, closeAll: () => { for (const i of open.slice()) closeBlock(i); }, stopPings };
}
function emitSseError(res, message) {
  if (res.writableEnded) return;
  try {
    if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    if (!res.headersSent) { res.end(); return; }
    res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`);
    res.end();
  } catch {}
}

function anthropicStreamEnd(res, stopReason, usage) {
  sseWrite(res, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason || "end_turn", stop_sequence: null }, usage: { input_tokens: (usage && usage.input_tokens) || 0, output_tokens: (usage && usage.output_tokens) || 0, cache_read_input_tokens: (usage && usage.cache_read_input_tokens) || 0, cache_creation_input_tokens: (usage && usage.cache_creation_input_tokens) || 0 } }); // PRD-001 R1: upstream cache hit data rides the terminal usage; zeros when unreported, never fabricated
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
function pipeGrokSSE(upRes, res, model, tag, onEmpty, keepalive, estInput, onUsage) {
  const s = openAnthropicStream(res, model, tag, true, keepalive, estInput);
  let buf = "", usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
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
      if (payload === "[DONE]") { closeThink(); s.closeAll(); if (usage.input_tokens > 0) meterTokens(model, { in: usage.input_tokens, out: usage.output_tokens }); finishStream(res, usage, finish, s, toolEmitted, false, onEmpty); return; }
      try {
        const j = JSON.parse(payload);
        const d = ((j.choices || [{}])[0] || {}).delta || {}; // x.ai usage chunk ships choices: [] - unguarded [0].delta threw and the catch swallowed the usage
        const fr = ((j.choices || [{}])[0] || {}).finish_reason;
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
            if (s.textIdx >= 0) { s.closeBlock(s.textIdx); s.textIdx = -1; } // reset: re-closing a closed block = malformed stream
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
        if (j.usage && j.usage.prompt_tokens) usage.input_tokens = j.usage.prompt_tokens; // PRD-001 R1/R3: prompt tokens were dropped here; carry them + the cache hit data
        if (j.usage && j.usage.prompt_tokens_details && typeof j.usage.prompt_tokens_details.cached_tokens === "number") usage.cache_read_input_tokens = j.usage.prompt_tokens_details.cached_tokens;
        if (j.usage && j.usage.completion_tokens) usage.output_tokens = j.usage.completion_tokens;
        if (onUsage && usage.input_tokens > 0) onUsage(usage); // PRD-001 R3: real prompt size feeds the session's next-turn estimate
      } catch {}
    }
  });
  let finish = "";
  let toolEmitted = false;
  upRes.on("end", () => { if (!res.writableEnded) { closeThink(); s.closeAll(); if (usage.input_tokens > 0) meterTokens(model, { in: usage.input_tokens, out: usage.output_tokens }); finishStream(res, usage, finish, s, toolEmitted, true, onEmpty); } });
  upRes.on("error", () => { if (!res.writableEnded) { closeThink(); s.closeAll(); if (usage.input_tokens > 0) meterTokens(model, { in: usage.input_tokens, out: usage.output_tokens }); finishStream(res, usage, finish, s, toolEmitted, true, onEmpty); } });
}

// gpt: openai responses SSE -> anthropic SSE. PRD-004: reasoning summary deltas
// surface as thinking blocks (route tag rides first) instead of being dropped.

// PRD-005: shared stream finisher. A tool_use block whose arguments JSON is
// truncated (provider cut the stream mid-call, or token limit) would poison the
// client - Claude Code parses arguments and dies with a malformed-stream error.
// In that case emit an SSE error event so the client retries the turn cleanly.
function finishStream(res, usage, finish, s, toolEmitted, abnormal, onEmpty) {
  if (s && s.stopPings) { try { s.stopPings(); } catch {} } // keepalive card is spent the moment the stream terminates
  const tools = s.toolArgs || new Map();
  for (const [, args] of tools) {
    if (typeof args === "string" && args.trim()) {
      try { JSON.parse(args); }
      catch {
        emitSseError(res, "upstream ended mid tool call (arguments truncated); retry the turn");
        return;
      }
    }
  }
  if (typeof s.primed === "function" && !s.primed()) { // empty upstream: zero client bytes flowed
    if (onEmpty) { onEmpty(); return; }
    return;
  }
  anthropicStreamEnd(res, toolEmitted ? "tool_use" : (finish === "length" ? "max_tokens" : "end_turn"), usage);
}
function pipeGPTSSE(upRes, res, model, tag, onEmpty, keepalive, estInput) {
  const s = openAnthropicStream(res, model, tag, true, keepalive, estInput);
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
      if (payload === "[DONE]") { closeThink(); s.closeAll(); finishStream(res, usage, "", s, toolEmitted, false, onEmpty); return; }
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
          if (s.textIdx >= 0) { s.closeBlock(s.textIdx); s.textIdx = -1; }
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
          meterTokens(model, { in: u.input_tokens || 0, out: u.output_tokens || usage.output_tokens });
          anthropicStreamEnd(res, t === "response.incomplete" ? "max_tokens" : (toolEmitted ? "tool_use" : "end_turn"), { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || usage.output_tokens, cache_read_input_tokens: ((u.input_tokens_details || {}).cached_tokens) || 0, cache_creation_input_tokens: 0 }); // PRD-001 R1: responses-native cached_tokens carried, not dropped
          return;
        }
        if (t === "error" || t === "response.failed") { closeThink(); s.closeAll(); finishStream(res, usage, "", s, toolEmitted, true, onEmpty); return; }
      } catch {}
    }
  });
  upRes.on("end", () => { if (!res.writableEnded) { closeThink(); s.closeAll(); finishStream(res, usage, "", s, toolEmitted, true, onEmpty); } });
  upRes.on("error", () => { if (!res.writableEnded) { closeThink(); s.closeAll(); emitSseError(res, "upstream connection failed mid stream; retry the turn"); } });
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
  let primed = false;
  const prime = () => { if (primed) return; primed = true; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); res.write(chunkStr([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }])); };
  const writeChunk = (choices, usage) => { if (!res.writableEnded) { prime(); res.write(chunkStr(choices, usage)); } };
  // role-only first chunk, deferred until the first real upstream event (empty streams stay walkable)
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
    if (!primed) return; // empty upstream stream: zero client bytes, ladder stays walkable
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
      } else if (t === "ping") { // direct-lane keepalive: bytes on the wire, ignored by data:-line parsers
        prime();
        if (!res.writableEnded) res.write(": keepalive\n\n");
      } else if (t === "error") { // upstream failed mid-stream: surface in-dialect, never silently
        prime();
        if (!res.writableEnded) {
          res.write('data: {"error":{"message":"' + String((j.error || {}).message || "upstream stream error").replace(/"/g, "'").slice(0, 160) + '","type":"api_error"}}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
        }
        ended = true;
        return;
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

const isFail = (s) => s === 400 || s === 429 || s === 401 || s === 403 || s >= 500; // 400 included: error bodies must never parse as empty successes

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
  return { id: o.id || "msg_router", type: "message", role: "assistant", model: reqModel || model, content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: (o.usage || {}).prompt_tokens || 0, output_tokens: (o.usage || {}).completion_tokens || 0, cache_read_input_tokens: (((o.usage || {}).prompt_tokens_details || {}).cached_tokens) || 0, cache_creation_input_tokens: 0 } }; // PRD-001 R1: upstream prompt cache hits surfaced, creation unreported by this lane
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
    max_tokens: (typeof body.max_tokens === "number" && body.max_tokens > 0) ? body.max_tokens : 16384, // client cap verbatim; reasoning-era default (PRD-001 reopen 2026-10-06)
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
    max_tokens: (typeof body.max_output_tokens === "number" && body.max_output_tokens > 0) ? body.max_output_tokens : 16384, // client cap verbatim; reasoning-era default (PRD-001 reopen 2026-10-06)
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
    usage: { input_tokens: inputT, output_tokens: outputT, total_tokens: inputT + outputT, input_tokens_details: { cached_tokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0 } }, // PRD-001 R1: cache transparency in the responses dialect
  };
}

// internal anthropic SSE -> responses SSE (C-5): the event alphabet pipeGPTSSE parses upstream,
// emitted inbound. Every lane event is crash-guarded; upstream end/error still emits a terminal.
function pipeAnthropicToResponsesSSE(upRes, res, model, reqModel, estInput) { // estInput: router estimate, fallback when upstream usage lacks input
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
  let primed = false;
  const prime = () => { if (primed) return; primed = true; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); sseWrite(res, "response.created", { type: "response.created", response: responseObj("in_progress") }); };
  let buf = "";
  let ended = false;
  let outIdx = -1, openKind = "", openItem = null, thinkText = "", toolArgs = "";
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  let stopReason = "";
  const closeItem = () => {
    if (openItem) {
      if (openKind === "thinking") openItem.summary = thinkText ? [{ type: "summary_text", text: thinkText }] : [];
      else openItem.status = "completed";
      if (openKind === "tool") openItem.arguments = toolArgs;
      doneItems.push(openItem);
      prime();
      sseWrite(res, "response.output_item.done", { type: "response.output_item.done", output_index: outIdx, item: openItem });
    }
    outIdx = -1; openKind = ""; openItem = null; thinkText = ""; toolArgs = "";
  };
  const terminal = () => {
    if (ended) return;
    ended = true;
    closeItem();
    if (res.writableEnded) return;
    if (!primed) return; // empty upstream stream: zero client bytes, ladder stays walkable
    const incomplete = stopReason === "max_tokens";
    if (incomplete) { console.log("[incomplete] responses session ended max_tokens (output budget exhausted)"); meterEvent("[incomplete] responses session ended max_tokens (output budget exhausted)"); } // observability only, stream unchanged: codex reconnects on this terminal (RUNBOOK known issue 3)
    const t = incomplete ? "response.incomplete" : "response.completed";
    const inTok = usage.input_tokens || estInput || 0; // usage transparency: codex reads input_tokens to drive auto-compaction; synthetic anthropic message_start reports 0
    const u = { input_tokens: inTok, output_tokens: usage.output_tokens, total_tokens: inTok + usage.output_tokens, input_tokens_details: { cached_tokens: usage.cache_read_input_tokens || 0 } }; // PRD-001 R1/R3.2: real -> carryover est -> estimate, cache hits surfaced
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
        if (typeof u.cache_read_input_tokens === "number") usage.cache_read_input_tokens = u.cache_read_input_tokens;
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
        prime();
        sseWrite(res, "response.output_item.added", { type: "response.output_item.added", output_index: outIdx, item: clone(openItem) });
      } else if (t === "content_block_delta") {
        const d = j.delta || {};
        if (d.type === "text_delta" && typeof d.text === "string" && d.text && openKind === "text" && openItem) {
          usage.output_tokens++;
          openItem.content[0].text += d.text;
          prime();
          sseWrite(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: openItem.id, output_index: outIdx, content_index: 0, delta: d.text });
        } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking && openKind === "thinking") {
          thinkText += d.thinking; // assembled into the reasoning summary at output_item.done (C-3)
        } else if (d.type === "input_json_delta" && typeof d.partial_json === "string" && d.partial_json && openKind === "tool" && openItem) {
          toolArgs += d.partial_json;
          prime();
          sseWrite(res, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: openItem.id, output_index: outIdx, delta: d.partial_json });
        }
      } else if (t === "content_block_stop") {
        closeItem();
      } else if (t === "message_delta") {
        if (j.delta && typeof j.delta.stop_reason === "string" && j.delta.stop_reason) stopReason = j.delta.stop_reason;
        const u = j.usage || {};
        if (typeof u.output_tokens === "number") usage.output_tokens = u.output_tokens;
        if (typeof u.input_tokens === "number") usage.input_tokens = u.input_tokens; // R3.2: upstream real beats the message_start estimate when the lane captured it
        if (typeof u.cache_read_input_tokens === "number") usage.cache_read_input_tokens = u.cache_read_input_tokens; // PRD-001 R1: cache hit data rides the terminal usage
      } else if (t === "ping") { // direct-lane keepalive: bytes on the wire, ignored by data:-line parsers
        prime();
        if (!res.writableEnded) res.write(": keepalive\n\n");
      } else if (t === "error") { // upstream failed mid-stream: surface as response.failed
        prime();
        if (!res.writableEnded) {
          const fail = responseObj("failed");
          fail.error = { code: "upstream_error", message: String((j.error || {}).message || "upstream stream error").slice(0, 160) };
          sseWrite(res, "response.failed", { type: "response.failed", response: fail });
          res.end();
        }
        ended = true;
        return;
      } else if (t === "message_stop") {
        terminal();
        return;
      }
    }
  });
  upRes.on("end", () => terminal());
  upRes.on("error", () => terminal());
}

let grokRefreshAt = 0;
async function serveGrok(model, body, res, tag) {
  let t = tokens();
  if (!t.grok) throw new Error("no grok token");
  const ob = anthropicToOpenAI(body);
  ob.model = "grok-4.7";
  if (ob.stream) ob.stream_options = { include_usage: true }; // without it x.ai omits the usage chunk and streamed tokens never reach the day pools (same fix as the litellm lane, PR #3)
  const wantStream = !!ob.stream;
  let r = await postUpstream("api.x.ai", "/v1/chat/completions", { "Authorization": "Bearer " + t.grok, "content-type": "application/json" }, JSON.stringify(ob), DIRECT_LANE_IDLE_MS, (status) => wantStream && status === 200);
  if ((r.status === 401 || r.status === 403) && !r.stream) { // credential rot: refresh beside-config script (60s exec cooldown), re-read token, retry once
    const now = Date.now();
    if (now - grokRefreshAt > 60000) {
      grokRefreshAt = now;
      const rs = path.join(path.dirname(CONFIG_PATH), "grok-refresh.sh");
      try { require("child_process").execSync("bash " + JSON.stringify(rs), { timeout: 45000, stdio: "ignore" }); console.log("[grok] " + r.status + " -> refresh script executed"); }
      catch (e) { console.log("[grok] refresh script failed: " + errText(e).slice(0, 60)); }
    }
    const nt = tokens();
    if (nt.grok && nt.grok !== t.grok) {
      t = nt;
      r = await postUpstream("api.x.ai", "/v1/chat/completions", { "Authorization": "Bearer " + t.grok, "content-type": "application/json" }, JSON.stringify(ob), DIRECT_LANE_IDLE_MS, (status) => wantStream && status === 200);
    }
  }
  if (wantStream && r.stream) { pipeGrokSSE(r.upRes, res, model, tag, undefined, true, body._estTokens || estimateTokens(body)); return { streamed: true }; }
  if (isFail(r.status)) throw new Error(`grok ${r.status}: ${r.body.slice(0, 120)}`);
  return { kind: "anthropic", body: openAIToAnthropic("grok-4.7", JSON.parse(r.body), model) };
}

async function serveGPT(model, body, res, tag) {
  const t = tokens();
  if (!t.gpt) throw new Error("no codex token");
  const input = []; const sysParts = [];
  for (const m of safeMessages(body.messages)) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system") { // backend 400s {"detail":"System messages are not allowed"}: fold into instructions
      if (typeof m.content === "string") sysParts.push(m.content);
      else if (Array.isArray(m.content)) for (const b of m.content) if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") sysParts.push(b.text);
      continue;
    }
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
    model, instructions: [typeof body.system === "string" ? body.system : "", ...sysParts].filter(Boolean).join("\n\n") || undefined,
    input, tools: gptTools, tool_choice: "auto", parallel_tool_calls: false,
    reasoning: { effort: "low", summary: "auto" }, store: false, stream: wantStream,
    // max_output_tokens REMOVED: the updated backend rejects it ("Unsupported parameter");
    // output length is plan-managed upstream
  };
  ob.stream = true; // the backend REQUIRES streaming ("Stream must be set to true"); non-stream clients get the SSE assembled below
  const r = await postUpstream("chatgpt.com", "/backend-api/codex/responses", {
    "Authorization": "Bearer " + t.gpt, "chatgpt-account-id": t.acct, "content-type": "application/json",
    "originator": "codex_cli_rs", "User-Agent": "codex_cli_rs/0.156.1", "OpenAI-Beta": "responses=experimental",
  }, JSON.stringify(ob), DIRECT_LANE_IDLE_MS, (status) => status === 200);
  if (isFail(r.status)) throw new Error(`gpt ${r.status}: ${r.body.slice(0, 200)}`);
  if (wantStream) { if (r.stream) { pipeGPTSSE(r.upRes, res, model, tag, undefined, true, body._estTokens || estimateTokens(body)); return { streamed: true }; } throw new Error(`gpt ${r.status}: stream not honored` + (r.body ? " - body: " + r.body.slice(0, 200) : "")); }
  if (!r.stream) throw new Error(`gpt ${r.status}: expected event stream`);
  // non-stream client: assemble the JSON response from the upstream SSE events
  const assembled = await new Promise((resolve, reject) => {
    let buf = "", text = "", reasoning = "", stop = "end_turn", usage = { input_tokens: 0, output_tokens: 0 };
    const fns = []; let curFn = null;
    r.upRes.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let j; try { j = JSON.parse(payload); } catch { continue; }
        const tt = j.type || "";
        if (tt === "response.output_text.delta" && typeof j.delta === "string") text += j.delta;
        if (tt === "response.reasoning_summary_text.delta" && typeof j.delta === "string") reasoning += j.delta;
        if (tt === "response.output_item.added" && (j.item || {}).type === "function_call") { curFn = { id: j.item.call_id || ("call_" + fns.length), name: j.item.name || "", args: "" }; fns.push(curFn); }
        if (tt === "response.function_call_arguments.delta" && curFn && typeof j.delta === "string") curFn.args += j.delta;
        if (tt === "response.completed" || tt === "response.incomplete") {
          const u = (j.response || {}).usage || {};
          usage = { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: ((u.input_tokens_details || {}).cached_tokens) || 0, cache_creation_input_tokens: 0 };
          stop = tt === "response.incomplete" ? "max_tokens" : (fns.length ? "tool_use" : "end_turn");
        }
        if (tt === "error" || tt === "response.failed") { reject(new Error("gpt stream error: " + JSON.stringify(j).slice(0, 100))); return; }
      }
    });
    r.upRes.on("end", () => {
      if (!text && !fns.length && !reasoning) {
        try { const d = path.join(DATA_DIR, "diag"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "gpt-empty-" + Date.now() + ".sse"), "model=" + model + " status=" + r.status + " bytes=" + buf.length + "\n" + buf); } catch {}
        reject(new Error("gpt empty output (raw stream captured to belay/diag/gpt-empty-*.sse)")); return; }
      const blocks = [];
      if (reasoning) blocks.push({ type: "thinking", thinking: reasoning.slice(0, 8000), signature: "na" });
      if (text) blocks.push({ type: "text", text });
      for (const f of fns) {
        let input = {}; try { const p = JSON.parse(f.args || "{}"); if (p && typeof p === "object" && !Array.isArray(p)) input = p; } catch {}
        blocks.push({ type: "tool_use", id: f.id, name: f.name, input });
      }
      resolve({ content: blocks, stop_reason: stop, usage });
    });
    r.upRes.on("error", (e) => reject(new Error("gpt stream error: " + errText(e).slice(0, 80))));
  });
  return { kind: "anthropic", body: { id: "msg_router_gpt", type: "message", role: "assistant", model, content: assembled.content, stop_reason: assembled.stop_reason, stop_sequence: null, usage: assembled.usage } };
}
function _gptLegacyReturnUnused() {
  const out = {}; let text = "", reasoning = "";
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
  if (ob.stream) ob.stream_options = { include_usage: true }; // PRD-001 reopen (2026-10-06): litellm emits no usage chunk without this, so cached_tokens never reached streaming clients
  ob.reasoning_effort = (cfg.litellm && cfg.litellm.reasoningEffort) || "low"; // z.ai coding models think unboundedly without it
  const fbMin = (cfg.auto && cfg.auto.fallbackMinTokens) || 2048; // OR fallbacks reason heavily; small generation budgets arrive EMPTY and read as failed hops. Output budget floor only - never touches context window.
  if (String(model).startsWith("openrouter") && ob.max_tokens < fbMin) ob.max_tokens = fbMin;
  ob.allowed_openai_params = ["reasoning_effort"]; // without this LiteLLM rejects the request outright (UnsupportedParamsError -> empty stream)
  return new Promise((resolve, reject) => {
    const b = Buffer.from(JSON.stringify(ob));
    const up = http.request({ host: LITELLM.host, port: LITELLM.port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json", "authorization": typeof req.headers.authorization === "string" ? req.headers.authorization : "", "content-length": Buffer.byteLength(b) } }, (ur) => {
      if (isFail(ur.statusCode)) {
        if (ur.statusCode === 400) { // body says WHICH param offended; log it, route around it
          const chunks = []; ur.on("data", (c) => chunks.push(c));
          ur.on("end", () => { const b = Buffer.concat(chunks).toString("utf8").slice(0, 180); console.log(`[litellm] 400 body: ${b}`); meter(model, "fail"); meterEvent(`[ladder] ${model} failed: litellm 400`); reject(new Error("litellm 400: " + b)); });
          return;
        }
        ur.resume(); meter(model, "fail"); meterEvent(`[ladder] ${model} failed: litellm ${ur.statusCode}`); reject(new Error("litellm " + ur.statusCode)); return;
      }
      if (wantStream) {
        let empty = false;
        const onEmpty = () => { empty = true; };
        if (dialect) { // openai-chat SSE -> anthropic SSE (sink) -> client dialect SSE
          const sink = anthropicSink();
          pipeGrokSSE(ur, sink, model, tag, onEmpty, undefined, body._estTokens || estimateTokens(body), opts && opts.onUsage);
          (dialect === "responses" ? pipeAnthropicToResponsesSSE : pipeAnthropicToOpenAIChatSSE)(sink, res, model, reqModel, body._estTokens || estimateTokens(body));
        } else {
          pipeGrokSSE(ur, res, model, tag, onEmpty, undefined, body._estTokens || estimateTokens(body), opts && opts.onUsage); // anthropic client: openai-chat SSE -> anthropic SSE directly
        }
        ur.on("end", () => {
          if (empty) { meter(model, "fail"); meterEvent(`[ladder] ${model} failed: empty stream`); reject(new Error("litellm empty stream")); return; }
          if (opts) opts.streamed = true; // real content flowed: the ladder must not walk past this point
          meter(model, "ok");
          resolve();
        });
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
        if (opts && opts.onUsage) opts.onUsage(anth.usage); // PRD-001 R3: real prompt tokens feed the session's next-turn estimate
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

async function serveWithLadder(req, res, body, startModel, dialect, reqModel, sessionCtx) {
  // dialect "openai-chat" (PRD-001b) / "responses" (PRD-001c): lanes stay anthropic-native; their output
  // is translated at the edge - non-stream bodies via the dialect's JSON translator, streams via an
  // anthropicSink + the dialect's SSE piper.
  const chat = dialect === "openai-chat";
  const rsp = dialect === "responses";
  const edge = chat || rsp;
  let chain = [startModel, ...((CHAINS[startModel] || []).filter((m) => m !== startModel))];
  if (reqModel === "orchestrator") { // PRD-004 owner rule: the orchestrator seat never falls out of class mid-session
    const _ol = (cfg.auto && Array.isArray(cfg.auto.orchestratorModels) && cfg.auto.orchestratorModels.length) ? cfg.auto.orchestratorModels : ["glm-5.3"];
    chain = [...new Set([startModel, ..._ol.filter((m) => m !== startModel && CANDIDATES[m])])];
  }
  // Context-window routing: a hop whose window cannot fit the request can only
  // fail upstream (input_too_large / ContextWindowExceeded) and poison the lane
  // counters. Skip those hops up front; if NOTHING fits, reject with 400 - a
  // 502 "all models exhausted" here would send the client into a retry loop no
  // model can ever satisfy.
  const est = estimateForSession(body, sessionCtx && sessionCtx.fp); // PRD-001 R3.1: the session's real prior usage sizes the window, not chars/4
  body._estTokens = est; // rides to the serveGrok/serveGPT/litellmLane estimate call sites (same pattern as _routeDifficulty)
  // PRD-001 R2/R3: session bookkeeping. noteUsage records real prompt tokens as
  // lanes report them; stickyServed re-pins the lane that actually served and
  // logs the walk (last hop error text, "breaker", or "window").
  const noteUsage = (u) => {
    if (!sessionCtx || !sessionCtx.fp) return;
    if (!u || typeof u.input_tokens !== "number" || !(u.input_tokens > 0)) return;
    const prev = sessionAffinity.get(sessionCtx.fp) || {};
    sessionAffinity.set(sessionCtx.fp, { model: prev.model || sessionCtx.pinnedModel, dial: prev.dial || "auto", lastRealPromptTokens: u.input_tokens, lastSeenMs: Date.now() });
  };
  const stickyServed = (servedModel, reason) => {
    if (!sessionCtx || !sessionCtx.fp) return;
    const sc = CANDIDATES[servedModel]; if (sc && sc.lane) laneQuotaStrikes[sc.lane] = 0; // PRD-004: a successful serve clears the lane's quota strikes
    const prev = sessionAffinity.get(sessionCtx.fp) || {};
    if (sessionCtx.pinnedModel && servedModel !== sessionCtx.pinnedModel) console.log(`[sticky] session ${sessionCtx.h8} walked ${sessionCtx.pinnedModel} -> ${servedModel}: ${reason || "ladder"}`);
    sessionAffinity.set(sessionCtx.fp, { model: servedModel, dial: prev.dial || "auto", lastRealPromptTokens: prev.lastRealPromptTokens || 0, lastSeenMs: Date.now() });
  };
  const effMax = effMaxTokens(body);
  const servable = [], skipped = [];
  let walkReason = "";
  for (const m of chain) {
    if (windowFits(m, est, effMax)) servable.push(m);
    else skipped.push(m);
  }
  for (const m of skipped) {
    console.log(`[ladder] ${m} skipped: est ${est} + ${effMax} out > window ${windowFor(m)}`);
    meterEvent(`[ladder] ${m} skipped: est ${est} tokens > window ${windowFor(m)} (not a lane failure)`);
    walkReason = "window";
  }
  if (!servable.length) {
    const msg = promptTooLargeMessage(est, maxServableWindow(chain));
    console.log(`[ladder] ${startModel}: prompt too large for every lane (est ${est} tokens) - 400, zero upstream attempts`);
    meterEvent(`[ladder] ${startModel}: prompt too large (est ${est} tokens) - 400 no walk`);
    if (chat || rsp) return sendOpenAIError(res, 400, msg);
    return sendInvalidRequest(res, msg);
  }
  const wantStream = !!body.stream;
  let clientStreaming = false; // once client bytes flowed, a failed hop must NOT walk: it would
                               // writeHead an already-started response and kill the process.
  for (let i = 0; i < servable.length; i++) {
    const model = servable[i];
    const c = CANDIDATES[model];
    const tag = routeTagFor(model, body._routeDifficulty || body._routeEffort); // tag carries difficulty (PRD-006 C) or client effort
    if (laneQuotaCooldown[c && c.lane] > Date.now()) { meterEvent(`[breaker] ${model} skipped: lane ${c.lane} in quota cooldown`); console.log(`[breaker] ${model} skipped: lane ${c.lane} in quota cooldown`); walkReason = "breaker"; continue; }
    try {
      if (c && c.lane === "grok") {
        const sink = edge && wantStream ? anthropicSink() : res;
        const out = await serveGrok(model, body, sink, tag);
        if (out.streamed) clientStreaming = true;
        if (out.streamed) {
          if (sink !== res) (rsp ? pipeAnthropicToResponsesSSE : pipeAnthropicToOpenAIChatSSE)(sink, res, model, reqModel, est);
          meter(model, "ok"); meterEvent(`[ladder] ${chain[0]} -> streaming via ${model}`);
          console.log(`[ladder] ${chain[0]} -> streaming via ${model}`);
          stickyServed(model, walkReason);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(edge ? (rsp ? anthropicToResponses(model, applyRouteTag(out.body, tag), reqModel) : anthropicToOpenAIChat(model, applyRouteTag(out.body, tag), reqModel)) : applyRouteTag(out.body, tag)));
        const _u = (out.body && out.body.usage) || {};
        meter(model, "ok", { in: _u.input_tokens, out: _u.output_tokens }); meterEvent(`[ladder] ${chain[0]} -> served by ${model}`);
        console.log(`[ladder] ${chain[0]} -> served by ${model}`);
        noteUsage(_u); stickyServed(model, walkReason);
        return;
      }
      if (c && c.lane === "gpt") {
        const sink = edge && wantStream ? anthropicSink() : res;
        const out = await serveGPT(model, body, sink, tag);
        if (out.streamed) clientStreaming = true;
        if (out.streamed) {
          if (sink !== res) (rsp ? pipeAnthropicToResponsesSSE : pipeAnthropicToOpenAIChatSSE)(sink, res, model, reqModel, est);
          meter(model, "ok"); meterEvent(`[ladder] ${chain[0]} -> streaming via ${model}`);
          console.log(`[ladder] ${chain[0]} -> streaming via ${model}`);
          stickyServed(model, walkReason);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(edge ? (rsp ? anthropicToResponses(model, applyRouteTag(out.body, tag), reqModel) : anthropicToOpenAIChat(model, applyRouteTag(out.body, tag), reqModel)) : applyRouteTag(out.body, tag)));
        const _u = (out.body && out.body.usage) || {};
        meter(model, "ok", { in: _u.input_tokens, out: _u.output_tokens }); meterEvent(`[ladder] ${chain[0]} -> served by ${model}`);
        console.log(`[ladder] ${chain[0]} -> served by ${model}`);
        noteUsage(_u); stickyServed(model, walkReason);
        return;
      }
      const _opts = edge ? { dialect, reqModel, tag, streamed: false, onUsage: noteUsage } : { tag, streamed: false, onUsage: noteUsage };
      const _r = await litellmLane(req, res, body, model, wantStream, _opts);
      if (_opts.streamed) clientStreaming = true;
      meterEvent(`[ladder] ${chain[0]} -> served by ${model}`);
      console.log(`[ladder] ${chain[0]} -> served by ${model}`);
      stickyServed(model, walkReason);
      return;
    } catch (e) {
      if (c && (c.lane === "grok" || c.lane === "gpt")) meter(model, "fail"); // litellm lane meters itself
      if (c && /usage_limit_reached/.test(errText(e))) { // PRD-004 two-strike: per-model budgets earn one sibling attempt before the lane cools
        const strikes = (laneQuotaStrikes[c.lane] || 0) + 1;
        if (strikes >= 2) { const until = Date.now() + 10 * 60 * 1000; if ((laneQuotaCooldown[c.lane] || 0) < until) { laneQuotaCooldown[c.lane] = until; laneQuotaStrikes[c.lane] = 0; console.log(`[breaker] lane ${c.lane} quota-exhausted (2 strikes): cooling 10m`); } }
        else { laneQuotaStrikes[c.lane] = strikes; console.log(`[breaker] ${model} usage_limit_reached (strike 1 of 2): trying next model in lane ${c.lane}`); }
      }
      meterEvent(`[ladder] ${model} failed: ${errText(e).slice(0, 90)}`);
      walkReason = errText(e).slice(0, 90); // PRD-001 R2: the walk log carries the last hop's failure text
      if (clientStreaming) { // PRD-005: client bytes already flowed; the lane closed the client stream
        console.log(`[ladder] ${chain[0]} -> stream aborted mid-flight (no walk; client stream owned by lane)`);
        return;
      }
      console.log(`[ladder] ${model} failed: ${errText(e).slice(0, 100)}`);
    }
  }
  if (rsp) return sendOpenAIError(res, 502, `router: all models exhausted for ${startModel}`); // C-7: responses-shaped exhaustion error
  if (wantStream) { emitSseError(res, `router: all models exhausted for ${startModel}`); return; } // streaming clients get an SSE error event, never a raw JSON body
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
  // PRD-001 R2: session-sticky entry. A pinned session reuses its lane (warm
  // prompt cache) and skips the picker entirely; a fresh session pins whatever
  // this request resolves to, auto or explicit.
  const _fp = sessionFingerprint(translated);
  const _h8 = _fp.slice(0, 8);
  const _pinned = stickyLookup(_fp);
  let startModel;
  const _dial = reqModel === "orchestrator" ? "orchestrator" : (reqModel === "auto" || (!CANDIDATES[reqModel] && !reqModel.startsWith("openrouter"))) ? "auto" : reqModel;
  if (_pinned && (CANDIDATES[_pinned.model] || _pinned.model.startsWith("openrouter")) && (_pinned.dial || "auto") === _dial) {
    console.log(`[sticky] session ${_h8} -> ${_pinned.model} (cache-warm)`);
    startModel = _pinned.model;
  } else {
    if (_pinned) console.log(`[sticky] session ${_h8} dial ${_pinned.dial || "auto"} -> ${_dial}: repick`);
    startModel = reqModel;
    if (reqModel === "orchestrator") {
      startModel = "orchestrator"; // PRD-004: picker restricted to orchestrator-class lanes
    } else if (reqModel === "auto" || (!CANDIDATES[reqModel] && !reqModel.startsWith("openrouter"))) {
      startModel = "auto"; // absent / "auto" / unknown model -> auto (B-3)
    }
    if (startModel === "auto" || startModel === "orchestrator") {
      try { const _p = await decideAuto(translated, startModel === "orchestrator"); if (_p.tooLarge) return sendOpenAIError(res, 400, promptTooLargeMessage(_p.tooLarge.est, _p.tooLarge.maxWindow)); startModel = _p.model; translated._routeDifficulty = _p.difficulty; }
      catch (e) {
        const _h = heuristicModel(translated, estimateTokens(translated), startModel === "orchestrator");
        if (_h.tooLarge) return sendOpenAIError(res, 400, promptTooLargeMessage(_h.tooLarge.est, _h.tooLarge.maxWindow));
        startModel = _h.model;
        console.log(`[auto] fallback heuristic -> ${startModel} (${errText(e).slice(0, 60)})`);
      }
      stickyPin(_fp, _h8, startModel, "auto", _dial);
    } else {
      stickyPin(_fp, _h8, startModel, "explicit", _dial);
    }
  }
  // C-7 ladder contract applies to the chat dialect too: no direct short-circuit.
  return serveWithLadder(req, res, translated, startModel, "openai-chat", reqModel, { fp: _fp, h8: _h8, pinnedModel: startModel });
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
  // PRD-001 R2: session-sticky entry (see handleChatCompletions); the fingerprint
  // rides the translated prefix so appended turns keep the same session.
  const _fp = sessionFingerprint(translated);
  const _h8 = _fp.slice(0, 8);
  const _pinned = stickyLookup(_fp);
  let startModel;
  const _dial = reqModel === "orchestrator" ? "orchestrator" : (checked.passthrough || reqModel === "auto") ? "auto" : reqModel;
  if (_pinned && (CANDIDATES[_pinned.model] || _pinned.model.startsWith("openrouter")) && (_pinned.dial || "auto") === _dial) {
    console.log(`[sticky] session ${_h8} -> ${_pinned.model} (cache-warm)`);
    startModel = _pinned.model;
  } else {
    if (_pinned) console.log(`[sticky] session ${_h8} dial ${_pinned.dial || "auto"} -> ${_dial}: repick`);
    startModel = checked.passthrough ? "auto" : checked.model;
    if (startModel === "auto" || startModel === "orchestrator") {
      try { const _p = await decideAuto(translated, startModel === "orchestrator"); if (_p.tooLarge) return sendOpenAIError(res, 400, promptTooLargeMessage(_p.tooLarge.est, _p.tooLarge.maxWindow)); startModel = _p.model; translated._routeDifficulty = _p.difficulty; }
      catch (e) {
        const _h = heuristicModel(translated, estimateTokens(translated), startModel === "orchestrator");
        if (_h.tooLarge) return sendOpenAIError(res, 400, promptTooLargeMessage(_h.tooLarge.est, _h.tooLarge.maxWindow));
        startModel = _h.model;
        console.log(`[auto] fallback heuristic -> ${startModel} (${errText(e).slice(0, 60)})`);
      }
      stickyPin(_fp, _h8, startModel, "auto", _dial);
    } else {
      stickyPin(_fp, _h8, startModel, "explicit", _dial);
    }
  }
  // C-7: every pick rides serveWithLadder so a 429 on any lane (incl. litellm) walks the chain
  // instead of failing the request - the direct short-circuit broke the owner ladder contract.
  return serveWithLadder(req, res, translated, startModel, "responses", reqModel, { fp: _fp, h8: _h8, pinnedModel: startModel });
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
  if (req.method === "GET" && req.url.startsWith("/v1/health")) {
    let lastCapture = 0, captureCount = 0;
    try { const cs = fs.readdirSync(CAPTURE_DIR).filter((x) => x.endsWith(".sse")); captureCount = cs.length; for (const c of cs) { const m = c.match(/stream-(\d+)-/); if (m) lastCapture = Math.max(lastCapture, Number(m[1])); } } catch {}
    // Lane health: per-candidate attempt outcomes; a lane is DEGRADED when it has
    // recent failures and no recent success (stale token, dead key, empty streams).
    // Degraded is candidate-gated: a RETIRED model stays in USAGE history forever
    // (all-fail, nothing left to fix) - stats kept, but it is no lane and never degrades.
    const lanes = {};
    const cand = cfg.candidates; // per-request read: hot-reload can retire a candidate mid-flight
    for (const [name, m] of Object.entries(USAGE.models)) {
      const lastOkAgoSec = m.lastServed ? Math.floor((Date.now() - m.lastServed) / 1000) : null;
      const degraded = m.failed > 0 && (m.ok === 0 || lastOkAgoSec === null || lastOkAgoSec > 3600) && !!cand[name];
      lanes[name] = { requests: m.requests, ok: m.ok, failed: m.failed, lastOkAgoSec, degraded };
    }
    const degradedLanes = Object.entries(lanes).filter(([, l]) => l.degraded).map(([n]) => n);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: degradedLanes.length === 0, pid: process.pid, uptimeSec: Math.floor(process.uptime()), emptyWalks: USAGE.events.filter((e) => String(e.text).includes("empty stream")).length, captureCount, lastCapture, lanes, degradedLanes, note: "degradedLanes names provider lanes failing with no recent success - fix the lane (token/key), not the router" }));
  }
  if (req.method === "GET" && req.url.split("?")[0] === "/v1/models") { // PRD-004: surface fabric pseudo-models beside the litellm list
    const up = http.request({ host: LITELLM.host, port: LITELLM.port, method: "GET", path: "/v1/models", headers: { authorization: req.headers.authorization || "" } }, (ur) => {
      let mbuf = "";
      ur.on("data", (c) => mbuf += c);
      ur.on("end", () => {
        try {
          const j = JSON.parse(mbuf);
          const ids = ["auto", "orchestrator", ...(j.data || []).map((m) => m.id)];
          j.data = ids.map((id) => ({ id, object: "model", created: 1677610602, owned_by: "openai" }));
          res.writeHead(ur.statusCode || 200, { "content-type": "application/json" });
          res.end(JSON.stringify(j));
        } catch {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(mbuf);
        }
      });
    });
    up.on("error", () => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "litellm models unreachable" } })); });
    up.end();
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/v1/usage")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ startedAt: USAGE.startedAt, uptimeSec: Math.floor((Date.now() - USAGE.startedAt) / 1000), day: USAGE.day, providerPools: providerPools(), models: USAGE.models, events: USAGE.events.slice(0, 30) }));
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
    // PRD-001 R2: session-sticky entry (see handleChatCompletions); passthrough
    // models returned above never touch the affinity map.
    const _fp = sessionFingerprint(parsed);
    const _h8 = _fp.slice(0, 8);
    const _pinned = stickyLookup(_fp);
    try {
      const _dial = parsed.model === "orchestrator" ? "orchestrator" : parsed.model === "auto" ? "auto" : parsed.model;
      if (_pinned && (CANDIDATES[_pinned.model] || _pinned.model.startsWith("openrouter")) && (_pinned.dial || "auto") === _dial) {
        console.log(`[sticky] session ${_h8} -> ${_pinned.model} (cache-warm)`);
        startModel = _pinned.model;
      } else {
        if (_pinned) console.log(`[sticky] session ${_h8} dial ${_pinned.dial || "auto"} -> ${_dial}: repick`);
        if (startModel === "auto" || startModel === "orchestrator") {
          try { const _p = await decideAuto(parsed, startModel === "orchestrator"); if (_p.tooLarge) return sendInvalidRequest(res, promptTooLargeMessage(_p.tooLarge.est, _p.tooLarge.maxWindow)); startModel = _p.model; parsed._routeDifficulty = _p.difficulty; }
          catch (e) {
            const _h = heuristicModel(parsed, estimateTokens(parsed), startModel === "orchestrator");
            if (_h.tooLarge) return sendInvalidRequest(res, promptTooLargeMessage(_h.tooLarge.est, _h.tooLarge.maxWindow));
            startModel = _h.model;
            console.log(`[auto] fallback heuristic -> ${startModel} (${String(e.message).slice(0, 60)})`);
          }
          stickyPin(_fp, _h8, startModel, "auto", _dial);
        } else {
          stickyPin(_fp, _h8, startModel, "explicit", _dial);
        }
      }
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: String(e.message) } }));
    }
    // litellm-lane picks also ride serveWithLadder (ladder contract); passthrough models
    // (unknown names) still proxy raw above.
    return serveWithLadder(req, res, parsed, startModel, undefined, undefined, { fp: _fp, h8: _h8, pinnedModel: startModel });
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
