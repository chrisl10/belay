// Harness test: simulate a sink that streams content then an error event,
// verify each dialect piper surfaces the error in its native shape.
const { PassThrough } = require("stream");
const fs = require("fs");
const src = fs.readFileSync("/tmp/belay/server.js", "utf8");

// extract the two pipers
const chatFn = src.slice(src.indexOf("function pipeAnthropicToOpenAIChatSSE"), src.indexOf("function anthropicSink"));
const respFn = src.slice(src.indexOf("function pipeAnthropicToResponsesSSE"), src.indexOf("async function serveGrok"));
const STOP = "const STOP_TO_FINISH = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop' };";
const sse = 'const sseWrite = (res, event, data) => { res.__events.push(`event: ${event}`); res.__data.push(JSON.stringify(data)); };';

function fakeRes() {
  const r = new PassThrough();
  r.__events = []; r.__data = []; r.chunks = [];
  r.writeHead = () => r;
  r.write = (c) => { r.chunks.push(c); return true; };
  r.end = (c) => { if (c) r.chunks.push(c); r.ended = true; return r; };
  Object.defineProperty(r, "writableEnded", { get() { return !!r.ended; } });
  return r;
}
function sinkWithError() {
  const pt = new PassThrough();
  pt.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n');
  pt.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
  pt.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial..."}}\n\n');
  pt.write('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream ended mid tool call (arguments truncated); retry the turn"}}\n\n');
  pt.end();
  return pt;
}

// --- chat dialect ---
{
  const res = fakeRes();
  eval(STOP + sse + chatFn);
  pipeAnthropicToOpenAIChatSSE(sinkWithError(), res, "m", "m");
  setTimeout(() => {
    const out = res.chunks.join("");
    const passChat = out.includes('"error"') && out.includes("[DONE]") && out.includes("api_error");
    console.log("chat dialect error passthrough:", passChat ? "PASS" : "FAIL", "|", out.replace(/\n/g, " ").slice(-160));
    // --- responses dialect ---
    const res2 = fakeRes();
    eval(sse + respFn);
    pipeAnthropicToResponsesSSE(sinkWithError(), res2, "m", "m");
    setTimeout(() => {
      const out2 = res2.__events.join(",");
      const passResp = out2.includes("response.failed");
      console.log("responses dialect error passthrough:", passResp ? "PASS" : "FAIL", "|", out2.slice(-120));
      process.exit(passChat && passResp ? 0 : 1);
    }, 50);
  }, 50);
}
