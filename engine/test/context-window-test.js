// Harness test: context-window routing helpers (2026-10-03 fleet incident fix).
// Slices the helper block out of server.js and exercises it against fixture
// config/catalog/candidates: token estimation, window resolution precedence
// (override > candidate > catalog), fit decisions under the safety margin, and
// the too-large short-circuit of the fallback heuristic.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const start = src.indexOf("// ---------- context-window routing");
const end = src.indexOf("async function decideAuto");
if (start < 0 || end < 0 || end <= start) { console.log("FAIL: helper block not found in server.js"); process.exit(1); }
const block = src.slice(start, end);

const fixtureCfg = {
  contextWindowOverrides: { "grok-4.7": 1000000, "openrouter-glm-flash": 200000, "openrouter-deepseek-flash": 128000 },
  auto: { windowSafety: 0.8 },
};
const fixtureCandidates = {
  "glm-5.3": { lane: "litellm", mods: ["text"] },
  "glm-5.3-flash": { lane: "litellm", mods: ["text", "image"] },
  "grok-4.7": { lane: "grok", mods: ["text"] },
};
const fixtureCatalog = {
  "glm-5.3": { contextWindow: 200000 },
  "glm-5.3-flash": { contextWindow: 200000 },
  "grok-4.7": { contextWindow: 2000000 }, // catalog says 2M; the override must win
  "gpt-6.1-sol": { contextWindow: 1000000 },
};

const h = new Function("cfg", "CANDIDATES", "CATALOG", "detectModalities",
  block + "\nreturn { estimateTokens, windowFor, effMaxTokens, windowFits, maxServableWindow, promptTooLargeMessage, heuristicModel };"
)(fixtureCfg, fixtureCandidates, fixtureCatalog, () => ({ image: false, video: false }));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FAIL " + name + ": expected " + JSON.stringify(want) + " got " + JSON.stringify(got)); }
};

// estimation: text
check("est text 1000 chars -> 250", h.estimateTokens({ messages: [{ role: "user", content: "x".repeat(1000) }] }), 250);
// estimation: system + tools + tool_use inputs are counted
check("est system+tool counted", h.estimateTokens({ system: "s".repeat(400), tools: [{ name: "t", input_schema: { a: 1 } }], messages: [{ role: "assistant", content: [{ type: "tool_use", id: "1", name: "t", input: { a: "y".repeat(400) } }] }] }) >= 200, true);
// estimation: images by decoded bytes, 256 floor
check("est image floor", h.estimateTokens({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(800) } }] }] }), 256);
check("est image 4M b64 -> 5000", h.estimateTokens({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4000000) } }] }] }), 5000);
check("est image url flat", h.estimateTokens({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] }] }), 1500);
// window resolution precedence
check("windowFor override wins over catalog", h.windowFor("grok-4.7"), 1000000);
check("windowFor catalog default", h.windowFor("glm-5.3"), 200000);
check("windowFor unknown -> null", h.windowFor("mystery-model"), null);
// fit decisions (glm-5.3: 200K * 0.8 = 160000 budget)
check("fits with margin", h.windowFits("glm-5.3", 150000, 4096), true);
check("skips past margin", h.windowFits("glm-5.3", 157000, 4096), false);
check("unknown window -> no constraint", h.windowFits("mystery-model", 99999999, 4096), true);
check("max_tokens respected", h.windowFits("glm-5.3", 100000, 70000), false);
check("effMaxTokens default 4096", h.effMaxTokens({}), 4096);
check("effMaxTokens passthrough", h.effMaxTokens({ max_tokens: 1234 }), 1234);
// message
const msg = h.promptTooLargeMessage(1234567, 1000000);
check("message names size + window + action", [msg.includes("1234567"), msg.includes("1000000"), msg.includes("compact")], [true, true, true]);
// heuristic: small body -> flash; oversized -> tooLarge; preferred-unfit -> largest window
check("heuristic small -> flash", h.heuristicModel({ messages: [{ role: "user", content: "hi" }] }, h.estimateTokens({ messages: [{ role: "user", content: "hi" }] })).model, "glm-5.3-flash");
const bigBody = { max_tokens: 1024, messages: [{ role: "user", content: "x".repeat(6000000) }] }; // est 1.5M > every window incl grok override
const big = h.heuristicModel(bigBody, h.estimateTokens(bigBody));
check("heuristic oversized -> tooLarge", [big.model, big.tooLarge && big.tooLarge.est > 1400000, big.tooLarge && big.tooLarge.maxWindow], [null, true, 1000000]);
const midBody = { max_tokens: 1024, messages: [{ role: "user", content: "y".repeat(3000000) }] }; // est 750K: glm 200K unfit, grok 1M (800K budget) fits
const mid = h.heuristicModel(midBody, h.estimateTokens(midBody));
check("heuristic climbs to largest fit", mid.model, "grok-4.7");
// maxServableWindow across a mixed set
check("maxServableWindow", h.maxServableWindow(["glm-5.3", "grok-4.7", "gpt-6.1-sol"]), 1000000);

console.log("-----");
console.log("PASS=" + pass + " FAIL=" + fail);
process.exit(fail ? 1 : 0);
