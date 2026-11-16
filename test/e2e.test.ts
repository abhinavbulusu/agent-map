/**
 * End-to-end tests: real processes, real sockets, real fixtures.
 *   - `check` against the bug-zoo MCP server and the demo project
 *   - the recording proxy against the mock LLM (OpenAI + Anthropic, streamed
 *     and not), forward-proxy HTTP, a CONNECT tunnel, and an unreachable upstream
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { scanMcpConfigs } from "../src/scan/mcpConfigs.ts";
import { runChecks } from "../src/check/index.ts";
import { EventLog, readEventsFile, type AgentEvent, type ModelCallEvent } from "../src/live/events.ts";
import { startProxy, type RunningProxy } from "../src/live/proxy.ts";
import { buildSession } from "../src/analyze/session.ts";

const ROOT = join(import.meta.dirname, "..");
const DEMO = join(ROOT, "fixtures", "demo-project");

describe("agentmap check (bug zoo)", () => {
  it("catches every planted failure and never calls the destructive tool", async () => {
    delete process.env.WEATHER_API_KEY;
    const agents = (await scanMcpConfigs(DEMO)).filter((a) => a.id === "claude-code");
    const report = await runChecks(DEMO, agents, { allowWrites: false, timeoutMs: 10_000, tokenLimit: 20_000, clientVersion: "test" });
    const byName = Object.fromEntries(report.results.map((r) => [r.serverName, r]));

    const tools = Object.fromEntries((byName["bug-zoo"]?.mcp?.tools ?? []).map((t) => [t.name, t]));
    assert.equal(tools.get_status?.status, "ok");
    assert.equal(tools.flaky_lookup?.issues[0]?.code, "tool_threw");
    assert.equal(tools.dump_logs?.issues[0]?.code, "huge_result");
    assert.equal(tools.delete_records?.action, "skipped");
    assert.ok(!byName["bug-zoo"]?.mcp?.stderr.includes("delete_records CALLED"));

    assert.equal(byName["broken-server"]?.issues[0]?.code, "spawn_enoent");
    assert.equal(byName.weather?.issues[0]?.code, "exited_during_startup");
    assert.match(byName.weather?.issues[0]?.hint ?? "", /WEATHER_API_KEY/);
    assert.equal(byName["docs-api"]?.http?.status, "error");
  });

  it("calls destructive tools only with allowWrites", async () => {
    const agents = (await scanMcpConfigs(DEMO)).filter((a) => a.id === "cursor");
    const report = await runChecks(DEMO, agents, { allowWrites: true, timeoutMs: 10_000, tokenLimit: 20_000, clientVersion: "test" });
    const del = report.results[0]?.mcp?.tools.find((t) => t.name === "delete_records");
    assert.equal(del?.action, "called");
    assert.match(report.results[0]?.mcp?.stderr ?? "", /delete_records CALLED/);
  });
});

describe("recording proxy (against the mock LLM)", () => {
  let mock: ChildProcess;
  let mockUrl = "";
  let proxy: RunningProxy;
  let log: EventLog;
  let eventsPath = "";

  before(async () => {
    mock = spawn(process.execPath, [join(ROOT, "fixtures", "mock-llm", "server.ts"), "--port", "0"], { stdio: ["ignore", "ignore", "pipe"] });
    mockUrl = await new Promise<string>((resolve, reject) => {
      mock.stderr!.on("data", (d: Buffer) => {
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(d.toString());
        if (m) resolve(m[1]!);
      });
      mock.on("exit", () => reject(new Error("mock-llm exited")));
    });
    eventsPath = join(mkdtempSync(join(tmpdir(), "agentmap-test-")), "events.jsonl");
    log = new EventLog(eventsPath);
    proxy = await startProxy({ port: 0, upstreams: { openai: `${mockUrl}/v1`, anthropic: mockUrl }, log });
  });

  after(async () => {
    await proxy.close();
    log.close();
    mock.kill();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${proxy.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const lastModelCall = () => [...log.events].reverse().find((e): e is ModelCallEvent & AgentEvent => e.type === "model_call")!;
  const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }];

  it("forwards OpenAI calls, records them, and redacts the API key", async () => {
    const res = await post("/openai/chat/completions", { model: "gpt-x", messages: [{ role: "user", content: "weather in Oslo?" }], tools }, { authorization: "Bearer sk-secret-123" });
    const body = (await res.json()) as { choices: { message: { tool_calls: { function: { arguments: string } }[] } }[] };
    assert.equal(res.status, 200);
    assert.equal(body.choices[0]?.message.tool_calls[0]?.function.arguments, '{"city":"Oslo"}');
    const ev = lastModelCall();
    assert.equal(ev.api, "chat.completions");
    assert.equal(ev.request.headers.authorization, "[redacted · 20 chars]");
    assert.ok(!JSON.stringify(readEventsFile(eventsPath)).includes("sk-secret-123"));
  });

  it("relays OpenAI streams live and reassembles them", async () => {
    const res = await post("/openai/chat/completions", { model: "gpt-x", stream: true, messages: [{ role: "user", content: "weather in Lima?" }], tools });
    const raw = await res.text();
    assert.match(raw, /data: \[DONE\]/); // the client received the real stream
    const ev = lastModelCall();
    assert.equal(ev.response?.streamed, true);
    const reassembled = ev.response?.body as { choices: { message: { tool_calls: { function: { arguments: string } }[] } }[] };
    assert.equal(reassembled.choices[0]?.message.tool_calls[0]?.function.arguments, '{"city":"Lima"}');
  });

  it("handles Anthropic streaming and the Responses API", async () => {
    await (await post("/anthropic/v1/messages", { model: "claude-x", stream: true, max_tokens: 50, tools: [{ name: "get_weather" }], messages: [{ role: "user", content: "weather in Rome?" }] })).text();
    const a = lastModelCall().response?.body as { content: { input?: unknown }[]; stop_reason: string };
    assert.deepEqual(a.content[0]?.input, { city: "Rome" });
    assert.equal(a.stop_reason, "tool_use");

    await (await post("/openai/responses", { model: "gpt-x", stream: true, input: "weather in Cairo?", tools: [{ type: "function", name: "get_weather" }] })).text();
    const r = lastModelCall().response?.body as { output: { name?: string }[] };
    assert.equal(r.output[0]?.name, "get_weather");
  });

  it("acts as a forward proxy for plain HTTP (absolute-form requests)", async () => {
    const target = `${mockUrl}/weather?city=Bern`;
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: proxy.port, method: "GET", path: target }, (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => resolve(s));
      });
      req.on("error", reject);
      req.end();
    });
    assert.deepEqual(JSON.parse(body), { city: "Bern", observations: [] });
    const ev = [...log.events].reverse().find((e) => e.type === "http_call");
    assert.equal(ev?.type === "http_call" && ev.url, target);
  });

  it("tunnels CONNECT requests and records only metadata", async () => {
    const port = Number(new URL(mockUrl).port);
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(proxy.port, "127.0.0.1", () => sock.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
      let buf = "";
      let tunneled = false;
      sock.on("data", (d) => {
        buf += d.toString();
        if (!tunneled && buf.includes("\r\n\r\n")) {
          tunneled = true;
          assert.match(buf, /200 Connection Established/);
          buf = "";
          sock.write("GET /weather?city=Pisa HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        }
      });
      sock.on("end", () => resolve(buf));
      sock.on("error", reject);
    });
    assert.match(reply, /"city":"Pisa"/);
    await new Promise((r) => setTimeout(r, 50));
    const ev = [...log.events].reverse().find((e) => e.type === "tunnel");
    assert.ok(ev && ev.type === "tunnel" && ev.bytesDown > 0 && ev.host === "127.0.0.1");
  });

  it("returns a clear 502 when the upstream is unreachable", async () => {
    const dead = await startProxy({ port: 0, upstreams: { openai: "http://127.0.0.1:59998/v1", anthropic: "http://127.0.0.1:59998" }, log });
    const res = await fetch(`${dead.url}/openai/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(res.status, 502);
    assert.match(lastModelCall().error ?? "", /ECONNREFUSED/);
    await dead.close();
  });

  it("derives a session: tool linking, HTTP attribution, silent-failure findings", async () => {
    // Simulate the agent loop: ask → tool call → HTTP via proxy → send result → answer.
    const first = (await (await post("/openai/chat/completions", { model: "gpt-x", messages: [{ role: "user", content: "weather in Graz?" }], tools })).json()) as {
      choices: { message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] } }[];
    };
    const call = first.choices[0]!.message.tool_calls[0]!;
    const weather = await new Promise<string>((resolve) => {
      request({ host: "127.0.0.1", port: proxy.port, path: `${mockUrl}/weather?city=Graz` }, (res) => {
        let s = "";
        res.on("data", (c) => (s += c)).on("end", () => resolve(s));
      }).end();
    });
    await post("/openai/chat/completions", {
      model: "gpt-x",
      tools,
      messages: [
        { role: "user", content: "weather in Graz?" },
        { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: call.function }] },
        { role: "tool", tool_call_id: call.id, content: weather },
      ],
    });

    const session = buildSession(log.events);
    const inv = session.tools.find((t) => t.callId === call.id);
    assert.ok(inv?.result, "tool result linked to its call");
    assert.equal(inv.httpCallIds.length, 1, "HTTP call attributed to the tool by timing");
    const codes = session.findings.filter((f) => f.modelCallId === session.modelCalls.at(-1)?.id).map((f) => f.code);
    assert.ok(codes.includes("answered_after_empty_tool"));
    assert.ok(codes.includes("ungrounded_claims"));
  });
});
