/**
 * Unit tests: pure functions, no processes, no network.
 * Run: npm test   (Node's built-in runner: `node --test`)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GraphBuilder, rollupStatus } from "../src/graph.ts";
import { parseJsonc } from "../src/util/jsonc.ts";
import { checkEnvRefs, checkLiteralEnv, findEnvRefs, interpolate, parseDotEnv } from "../src/check/env.ts";
import { parseMcpConfigText } from "../src/scan/mcpConfigs.ts";
import { sampleFromSchema } from "../src/check/schemaSample.ts";
import { toolSafety } from "../src/check/mcp.ts";
import { parseSse } from "../src/live/sse.ts";
import { normalizeRequest, normalizeResponse, reassembleStream } from "../src/live/providers.ts";
import { base64Blob, emptiness, jsonDepth, looksLikeError, looksLikeHtml, truncation } from "../src/analyze/xray.ts";
import { detectSilentFailures, extractClaims, traceClaims } from "../src/analyze/silent.ts";
import { xrayRequest } from "../src/analyze/xray.ts";
import { safeJsonForScript } from "../src/view/html.ts";
import { redactRecord } from "../src/util/redact.ts";

describe("jsonc", () => {
  it("strips comments but not // inside strings", () => {
    const v = parseJsonc(`// header\n{ "url": "https://x.com/a", /* note */ "n": 1 }`);
    assert.deepEqual(v, { url: "https://x.com/a", n: 1 });
  });
  it("removes trailing commas, but not inside strings", () => {
    assert.deepEqual(parseJsonc(`{ "a": [1, 2,], "s": "a,}", }`), { a: [1, 2], s: "a,}" });
  });
  it("keeps escaped quotes inside strings", () => {
    assert.deepEqual(parseJsonc(`{ "q": "say \\"hi\\" // not a comment" }`), { q: 'say "hi" // not a comment' });
  });
});

describe("env references", () => {
  it("understands each client's syntax", () => {
    assert.deepEqual(findEnvRefs("${A} ${B:-dflt}", "x", "claude-code").map((r) => [r.name, r.syntax, r.defaultValue, r.supported]), [
      ["A", "dollar", undefined, true],
      ["B", "dollar", "dflt", true],
    ]);
    assert.equal(findEnvRefs("${env:TOKEN}", "x", "cursor")[0]?.supported, true);
    assert.equal(findEnvRefs("${input:key}", "x", "vscode")[0]?.syntax, "input");
  });
  it("ignores editor variables like ${workspaceFolder}", () => {
    assert.equal(findEnvRefs("${workspaceFolder}/server.js", "args[0]", "cursor").length, 0);
  });
  it("flags syntax the client does not expand (Claude Desktop passes it literally)", () => {
    const refs = findEnvRefs("${GITHUB_TOKEN}", "env.GITHUB_TOKEN", "claude-desktop");
    const [check] = checkEnvRefs(refs, { processEnv: { GITHUB_TOKEN: "x" }, dotenv: {}, workspaceFolder: "/p" }, "claude-desktop");
    assert.equal(check?.source, "literal");
    assert.equal(check?.status, "warn");
  });
  it("resolves from process env, then .env (with a warning), then defaults", () => {
    const refs = [...findEnvRefs("${A} ${B} ${C:-x} ${D}", "x", "claude-code")];
    const checks = checkEnvRefs(refs, { processEnv: { A: "1" }, dotenv: { B: "2" }, workspaceFolder: "/p" }, "claude-code");
    assert.deepEqual(checks.map((c) => [c.name, c.source, c.status]), [
      ["A", "process", "ok"],
      ["B", "dotenv", "warn"],
      ["C", "default", "ok"],
      ["D", "missing", "error"],
    ]);
  });
  it("interpolates and reports unresolved names", () => {
    const ctx = { processEnv: { A: "1" }, dotenv: {}, workspaceFolder: "/proj" };
    assert.deepEqual(interpolate("${workspaceFolder}/s ${A} ${Z}", ctx, "claude-code"), { value: "/proj/s 1 ", unresolved: ["Z"] });
  });
  it("parses .env files", () => {
    assert.deepEqual(parseDotEnv(`# c\nexport A=1\nB="two words"\nC=x # trailing\n`), { A: "1", B: "two words", C: "x" });
  });
  it("catches copy-pasted placeholders", () => {
    assert.equal(checkLiteralEnv({ API_KEY: "your-api-key-here" })[0]?.code, "env_placeholder");
    assert.equal(checkLiteralEnv({ API_KEY: "" })[0]?.code, "env_empty");
  });
});

describe("MCP config parsing", () => {
  const loc = (client: "claude-code" | "vscode" | "claude-desktop", scope: "project" | "user" = "project") => ({ client, path: `/p/${client}.json`, scope });

  it("normalizes stdio and http servers", () => {
    const a = parseMcpConfigText(`{"mcpServers":{"s":{"command":"node","args":["x.js"]},"r":{"url":"https://h/mcp"}}}`, loc("claude-code"), "/p");
    assert.deepEqual(a.servers.map((s) => [s.name, s.transport]), [["s", "stdio"], ["r", "http"]]);
  });
  it("flags the wrong top-level key for VS Code", () => {
    const a = parseMcpConfigText(`{"mcpServers":{"s":{"command":"x"}}}`, loc("vscode"), "/p");
    assert.equal(a.issues[0]?.code, "config_wrong_key");
    assert.equal(a.servers.length, 1);
  });
  it("reports invalid JSON instead of crashing", () => {
    assert.equal(parseMcpConfigText(`{"mcpServers": {`, loc("claude-code"), "/p").issues[0]?.code, "config_invalid_json");
  });
  it("flags missing command and relative paths in user configs", () => {
    const a = parseMcpConfigText(`{"mcpServers":{"bad":{},"rel":{"command":"node","args":["./s.js"]}}}`, loc("claude-desktop", "user"), "/home");
    assert.equal(a.servers[0]?.issues[0]?.code, "missing_command");
    assert.equal(a.servers[1]?.issues[0]?.code, "relative_path_in_user_config");
  });
});

describe("JSON Schema sampling", () => {
  it("fills only required fields with the most boring valid values", () => {
    const schema = {
      type: "object",
      properties: { kind: { enum: ["a", "b"] }, n: { type: "integer", minimum: 3 }, opt: { type: "string" }, when: { type: "string", format: "date" } },
      required: ["kind", "n", "when"],
    };
    const v = sampleFromSchema(schema) as Record<string, unknown>;
    assert.equal(v.kind, "a");
    assert.equal(v.n, 3);
    assert.match(String(v.when), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal("opt" in v, false);
  });
  it("follows $ref and anyOf, prefers defaults", () => {
    const schema = { type: "object", required: ["a", "b"], properties: { a: { $ref: "#/$defs/A" }, b: { anyOf: [{ type: "boolean" }, { type: "string" }] } }, $defs: { A: { type: "string", default: "dflt" } } };
    assert.deepEqual(sampleFromSchema(schema), { a: "dflt", b: false });
  });
  it("respects minLength and minItems", () => {
    assert.equal((sampleFromSchema({ type: "string", minLength: 6 }) as string).length, 6);
    assert.deepEqual(sampleFromSchema({ type: "array", minItems: 2, items: { type: "number" } }), [0, 0]);
  });
});

describe("tool safety classification", () => {
  it("treats missing annotations as unsafe (spec defaults are pessimistic)", () => {
    assert.equal(toolSafety(undefined), "unannotated");
    assert.equal(toolSafety({ readOnlyHint: true }), "read_only");
    assert.equal(toolSafety({ readOnlyHint: false }), "destructive");
    assert.equal(toolSafety({ readOnlyHint: false, destructiveHint: false }), "write");
  });
});

describe("SSE parsing", () => {
  it("handles events, multi-line data, comments and CRLF", () => {
    const msgs = parseSse(`: keep-alive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: {"x":1}\n\ndata: [DONE]`);
    assert.deepEqual(msgs, [{ event: "a", data: "one\ntwo" }, { data: '{"x":1}' }, { data: "[DONE]" }]);
  });
});

describe("provider normalization", () => {
  it("maps OpenAI tool results back to the tool name", () => {
    const req = normalizeRequest("chat.completions", {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "{}" },
      ],
      tools: [{ type: "function", function: { name: "get_weather" } }],
    });
    assert.deepEqual(req.segments.map((s) => [s.source, s.toolName]), [["user", undefined], ["tool_call", "get_weather"], ["tool_result", "get_weather"], ["tool_schema", undefined]]);
  });
  it("reassembles an OpenAI stream with fragmented tool-call arguments", () => {
    const chunks = [
      { id: "x", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_weather", arguments: "" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Rome"}' } }] }, finish_reason: "tool_calls" }] },
    ];
    const body = reassembleStream("chat.completions", chunks.map((c) => ({ data: JSON.stringify(c) })).concat({ data: "[DONE]" }));
    const res = normalizeResponse("chat.completions", body, 200);
    assert.deepEqual(res.toolCalls, [{ id: "c1", name: "get_weather", arguments: '{"city":"Rome"}' }]);
    assert.equal(res.finishReason, "tool_calls");
  });
  it("reassembles an Anthropic stream (text + partial JSON)", () => {
    const evs = [
      { type: "message_start", message: { id: "m", model: "c", content: [], usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "f", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 5 } },
    ];
    const res = normalizeResponse("messages", reassembleStream("messages", evs.map((e) => ({ data: JSON.stringify(e) }))), 200);
    assert.equal(res.text, "Hello");
    assert.deepEqual(res.toolCalls, [{ id: "t1", name: "f", arguments: '{"a":1}' }]);
    assert.equal(res.truncated, true);
  });
  it("reads Anthropic tool_result is_error and Responses-API hidden context", () => {
    const a = normalizeRequest("messages", { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }] }] });
    assert.equal(a.segments[0]?.isError, true);
    const r = normalizeRequest("responses", { input: "hi", previous_response_id: "resp_1" });
    assert.equal(r.notes.length, 1);
  });
  it("extracts API error messages", () => {
    assert.equal(normalizeResponse("messages", { type: "error", error: { message: "overloaded" } }, 529).error, "overloaded");
  });
});

describe("X-ray detectors", () => {
  it("recognizes 'effectively empty' results", () => {
    for (const t of ["", "[]", "{}", "null", '{"results": []}', '{"city":"Paris","observations":[]}', '{"data": {"items": []}}']) {
      assert.ok(emptiness(t), `expected empty: ${t}`);
    }
    for (const t of ['{"temp": 18}', '{"items": [1]}', "It is sunny", '{"user": {"name": "A"}, "tags": []}']) {
      assert.equal(emptiness(t), undefined, `expected NOT empty: ${t}`);
    }
  });
  it("spots error text, truncation, HTML, base64 and deep nesting", () => {
    assert.ok(looksLikeError("Error: rate limited"));
    assert.ok(looksLikeError('{"error": {"message": "nope"}}'));
    assert.ok(!looksLikeError('{"error": null, "data": 1}'));
    assert.ok(truncation("lots of data ... [truncated]"));
    assert.ok(truncation('{"items": [1, 2, {"a": 3'));
    assert.ok(!truncation('{"complete": true}'));
    assert.ok(looksLikeHtml("<html><body><div>hi</div></body></html>"));
    assert.ok(base64Blob("img: " + "QUJD".repeat(80)));
    assert.equal(jsonDepth('{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}}'), 7);
  });
});

describe("claims + silent failures", () => {
  it("extracts specific facts and skips noise like model names and list numbers", () => {
    const claims = extractClaims("1. Use gpt-4o: it's 18°C, 65% humid, costs $1,200, see https://ex.com/a. Released 2024-05-13.");
    assert.deepEqual(claims.map((c) => [c.text, c.kind]), [
      ["18°C", "temperature"],
      ["65%", "percent"],
      ["$1,200", "money"],
      ["https://ex.com/a", "url"],
      ["2024-05-13", "date"],
    ]);
  });
  it("traces numbers regardless of formatting", () => {
    const segs = [{ source: "tool_result" as const, role: "tool", text: '{"temp_c": 18.0, "price": 1200}', messageIndex: 0, toolName: "w" }];
    const traces = traceClaims("It's 18°C and costs $1,200 but 7,000 people", segs);
    assert.deepEqual(traces.map((t) => [t.text, t.grounded]), [["18°C", true], ["$1,200", true], ["7,000", false]]);
    assert.equal(traces[0]?.sources[0]?.toolName, "w");
  });
  it("flags confident answers after empty tool results, but not honest ones", () => {
    const req = normalizeRequest("chat.completions", {
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", tool_calls: [{ id: "c", function: { name: "w", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c", content: '{"observations": []}' },
      ],
    });
    const x = xrayRequest(req);
    const confident = { text: "It's 21°C and sunny.", toolCalls: [], truncated: false };
    const honest = { text: "Sorry, I couldn't get weather data right now.", toolCalls: [], truncated: false };
    const f1 = detectSilentFailures(x.segments, confident, traceClaims(confident.text, req.segments)).map((f) => f.code);
    const f2 = detectSilentFailures(x.segments, honest, traceClaims(honest.text, req.segments)).map((f) => f.code);
    assert.deepEqual(f1, ["answered_after_empty_tool", "ungrounded_claims"]);
    assert.deepEqual(f2, []);
  });
});

describe("graph", () => {
  it("upserts nodes, escalates status, and rolls up subtree health", () => {
    const b = new GraphBuilder();
    b.node({ id: "agent:a", kind: "agent", label: "A" });
    b.node({ id: "tool:t", kind: "tool", label: "T", status: "ok" });
    b.node({ id: "tool:t", kind: "tool", label: "T", issues: [{ severity: "warn", code: "x", message: "m" }] });
    b.edge({ from: "agent:a", to: "tool:t", kind: "calls", status: "ok" });
    const g = b.build();
    assert.equal(g.nodes.find((n) => n.id === "tool:t")?.status, "warn");
    assert.equal(rollupStatus(g, "agent:a"), "warn");
  });
});

describe("safety helpers", () => {
  it("embeds JSON in <script> without allowing a breakout", () => {
    const out = safeJsonForScript({ t: "</script><script>alert(1)</script>" });
    assert.ok(!out.includes("</script>"));
    assert.deepEqual(JSON.parse(out), { t: "</script><script>alert(1)</script>" });
  });
  it("redacts secret headers by name", () => {
    assert.deepEqual(redactRecord({ authorization: "Bearer sk-123", "content-type": "json", "x-api-key": "k" }), {
      authorization: "[redacted · 13 chars]",
      "content-type": "json",
      "x-api-key": "[redacted · 1 chars]",
    });
  });
});
