/**
 * mock-llm — an offline stand-in for OpenAI + Anthropic, plus a fake weather API.
 *
 * It speaks the real wire formats (that's the point: agentmap's proxy must
 * parse real traffic), but its "model" is a 10-line script:
 *   turn 1: the user asks something → reply with a tool call: get_weather(city)
 *   turn 2: a tool result is present → reply with a CONFIDENT answer that
 *           ignores the tool result entirely.
 * And the weather API returns no observations. Together that reproduces the
 * failure agentmap exists to catch: a fluent, specific, WRONG answer built on
 * empty data ("18°C and partly cloudy" — none of which came from any tool).
 *
 * Endpoints:
 *   POST /v1/chat/completions   OpenAI Chat Completions (stream + non-stream)
 *   POST /v1/responses          OpenAI Responses API     (stream + non-stream)
 *   POST /v1/messages           Anthropic Messages       (stream + non-stream)
 *   GET  /weather?city=Paris    fake weather API → {"city":"Paris","observations":[]}
 *
 * Run: node fixtures/mock-llm/server.ts [--port 4010]
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const portArg = process.argv.indexOf("--port");
const PORT = portArg === -1 ? Number(process.env.MOCK_LLM_PORT ?? 4010) : Number(process.argv[portArg + 1]);

type Json = Record<string, any>; // fixture code: loose typing is fine here

// ---------------------------------------------------------------------------
// The "model"
// ---------------------------------------------------------------------------

type Decision = { kind: "tool"; city: string } | { kind: "answer"; city: string };

function decide(lastUserText: string, sawToolResult: boolean, toolsOffered: boolean): Decision {
  const city = /\bin ([A-Z][a-zA-Z]+)/.exec(lastUserText)?.[1] ?? "Paris";
  if (!sawToolResult && toolsOffered) return { kind: "tool", city };
  return { kind: "answer", city };
}

function answerText(city: string): string {
  // Every number here is invented. agentmap should flag all of them.
  return `It's currently 18°C and partly cloudy in ${city}, with 65% humidity and light winds from the west at 12 km/h.`;
}

const now = () => Math.floor(Date.now() / 1000);
let counter = 0;
const newId = (prefix: string) => `${prefix}_mock${++counter}`;

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

function chatCompletions(body: Json, res: ServerResponse): void {
  const messages: Json[] = body.messages ?? [];
  const last = messages[messages.length - 1];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const d = decide(textOf(lastUser?.content), last?.role === "tool", (body.tools ?? []).length > 0);
  const model = body.model ?? "mock-gpt";
  const usage = { prompt_tokens: approxTokens(JSON.stringify(messages)), completion_tokens: 24, total_tokens: 0 };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  const toolCall = { id: newId("call"), type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: d.city }) } };

  if (!body.stream) {
    const message = d.kind === "tool" ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: answerText(d.city) };
    return json(res, 200, {
      id: newId("chatcmpl"),
      object: "chat.completion",
      created: now(),
      model,
      choices: [{ index: 0, message, finish_reason: d.kind === "tool" ? "tool_calls" : "stop" }],
      usage,
    });
  }

  // Streaming: Server-Sent Events, one JSON "chunk" per `data:` line.
  const id = newId("chatcmpl");
  const chunk = (delta: Json, finish: string | null = null) =>
    sse(res, { id, object: "chat.completion.chunk", created: now(), model, choices: [{ index: 0, delta, finish_reason: finish }] });
  startSse(res);
  chunk({ role: "assistant", content: "" });
  if (d.kind === "tool") {
    chunk({ tool_calls: [{ index: 0, id: toolCall.id, type: "function", function: { name: "get_weather", arguments: "" } }] });
    // Arguments arrive as string FRAGMENTS — the client must concatenate them.
    for (const part of splitInto(toolCall.function.arguments, 3)) chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] });
    chunk({}, "tool_calls");
  } else {
    for (const word of answerText(d.city).split(/(?<= )/)) chunk({ content: word });
    chunk({}, "stop");
  }
  if (body.stream_options?.include_usage) sse(res, { id, object: "chat.completion.chunk", created: now(), model, choices: [], usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

function responses(body: Json, res: ServerResponse): void {
  const input: Json[] = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input ?? [];
  const lastUser = [...input].reverse().find((i) => i.role === "user");
  const sawToolResult = input.some((i) => i.type === "function_call_output");
  const d = decide(textOf(lastUser?.content), sawToolResult, (body.tools ?? []).length > 0);
  const output =
    d.kind === "tool"
      ? [{ type: "function_call", id: newId("fc"), call_id: newId("call"), name: "get_weather", arguments: JSON.stringify({ city: d.city }), status: "completed" }]
      : [{ type: "message", id: newId("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: answerText(d.city), annotations: [] }] }];
  const response = {
    id: newId("resp"),
    object: "response",
    created_at: now(),
    status: "completed",
    model: body.model ?? "mock-gpt",
    output,
    usage: { input_tokens: approxTokens(JSON.stringify(input)), output_tokens: 24, total_tokens: 0 },
  };
  if (!body.stream) return json(res, 200, response);
  startSse(res);
  sse(res, { type: "response.created", response: { ...response, status: "in_progress", output: [] } }, "response.created");
  sse(res, { type: "response.completed", response }, "response.completed");
  res.end();
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

function anthropicMessages(body: Json, res: ServerResponse): void {
  const messages: Json[] = body.messages ?? [];
  const last = messages[messages.length - 1];
  const lastBlocks: Json[] = Array.isArray(last?.content) ? last.content : [];
  const sawToolResult = lastBlocks.some((b) => b.type === "tool_result");
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && textOf(m.content));
  const d = decide(textOf(lastUser?.content), sawToolResult, (body.tools ?? []).length > 0);
  const model = body.model ?? "mock-claude";
  const toolUse = { type: "tool_use", id: newId("toolu"), name: "get_weather", input: { city: d.city } };
  const content = d.kind === "tool" ? [toolUse] : [{ type: "text", text: answerText(d.city) }];
  const stopReason = d.kind === "tool" ? "tool_use" : "end_turn";
  const usage = { input_tokens: approxTokens(JSON.stringify(messages)), output_tokens: 24 };

  if (!body.stream) {
    return json(res, 200, { id: newId("msg"), type: "message", role: "assistant", model, content, stop_reason: stopReason, stop_sequence: null, usage });
  }

  // Anthropic streams NAMED events (the `event:` line) describing a little
  // state machine: message_start → (content_block_start → deltas → stop)* → message_delta → message_stop.
  startSse(res);
  const ev = (type: string, data: Json) => sse(res, { type, ...data }, type);
  ev("message_start", { message: { id: newId("msg"), type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } });
  if (d.kind === "tool") {
    ev("content_block_start", { index: 0, content_block: { ...toolUse, input: {} } });
    for (const part of splitInto(JSON.stringify(toolUse.input), 3)) ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: part } });
  } else {
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const word of answerText(d.city).split(/(?<= )/)) ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: word } });
  }
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  ev("message_stop", {});
  res.end();
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: Json) => (typeof p.text === "string" ? p.text : "")).join(" ");
  return "";
}

function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function splitInto(s: string, parts: number): string[] {
  const size = Math.ceil(s.length / parts);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
}

function sse(res: ServerResponse, data: unknown, event?: string): void {
  res.write((event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Json) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/weather") {
      // The data source is "up" but has nothing: a 200 with an empty list.
      // That's the nastiest kind of failure — no error for anyone to notice.
      return json(res, 200, { city: url.searchParams.get("city") ?? "", observations: [] });
    }
    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) return chatCompletions(await readBody(req), res);
    if (req.method === "POST" && url.pathname.endsWith("/responses")) return responses(await readBody(req), res);
    if (req.method === "POST" && url.pathname.endsWith("/messages")) return anthropicMessages(await readBody(req), res);
    json(res, 404, { error: { message: `mock-llm: no route for ${req.method} ${url.pathname}` } });
  } catch (err) {
    json(res, 500, { error: { message: String(err) } });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // Report the ACTUAL port (with --port 0 the OS picks a free one; tests rely on this line).
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  console.error(`mock-llm listening on http://127.0.0.1:${port}  (OpenAI: /v1, Anthropic: /, weather: /weather)`);
});
