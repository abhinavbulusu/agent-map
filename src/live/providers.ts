/**
 * live/providers.ts — understand LLM API traffic.
 *
 * Three wire formats, one meaning. Every LLM request is "a conversation so
 * far + the tools the model may use"; every response is "some text and/or
 * some tool calls, and why it stopped". This module converts each provider's
 * shape into ONE normalized form:
 *
 *   request  → Segment[]   (system / user / assistant / tool_call / tool_result / tool_schema)
 *   response → { text, toolCalls, finishReason, truncated, usage }
 *
 * Downstream code (X-ray, silent-failure detection, the UI) only knows
 * segments, so adding a fourth provider means touching only this file.
 *
 * Supported:
 *   OpenAI Chat Completions   POST …/chat/completions
 *   OpenAI Responses          POST …/responses
 *   Anthropic Messages        POST …/v1/messages
 */
import type { ModelApi, Provider } from "./events.ts";
import type { SseMessage } from "./sse.ts";

// Loose JSON typing for parsing wire formats we don't control. We access
// fields defensively (?.) and check types before trusting them.
type J = Record<string, any>;

export type SegmentSource = "system" | "user" | "assistant" | "tool_call" | "tool_result" | "tool_schema";

export interface Segment {
  source: SegmentSource;
  /** The provider's role string ("developer", "tool", ...), for display. */
  role: string;
  text: string;
  /** Position of the message in the request's conversation array. */
  messageIndex: number;
  toolName?: string;
  toolCallId?: string;
  /** Provider-level error flag on a tool result (Anthropic `is_error`). */
  isError?: boolean;
}

export interface NormalizedRequest {
  model?: string;
  stream: boolean;
  segments: Segment[];
  toolNames: string[];
  /** Things the X-ray should warn about that aren't tied to one segment. */
  notes: string[];
}

export interface ToolCallOut {
  id: string;
  name: string;
  /** Raw JSON string of arguments, exactly as the model produced it. */
  arguments: string;
}

export interface NormalizedResponse {
  text: string;
  toolCalls: ToolCallOut[];
  finishReason?: string;
  /** Output was cut off by the max-tokens limit. */
  truncated: boolean;
  refusal?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
}

// ---------------------------------------------------------------------------
// Which API is this?
// ---------------------------------------------------------------------------

export function detectApi(provider: Provider, path: string): ModelApi {
  const p = path.split("?")[0]!;
  if (provider === "openai" && p.endsWith("/chat/completions")) return "chat.completions";
  if (provider === "openai" && p.endsWith("/responses")) return "responses";
  if (provider === "anthropic" && p.endsWith("/messages")) return "messages";
  return "other"; // embeddings, model lists, count_tokens, ...
}

// ---------------------------------------------------------------------------
// Requests → segments
// ---------------------------------------------------------------------------

export function normalizeRequest(api: ModelApi, body: unknown): NormalizedRequest {
  const b = (isObj(body) ? body : {}) as J;
  const out: NormalizedRequest = { stream: b.stream === true, segments: [], toolNames: [], notes: [] };
  if (typeof b.model === "string") out.model = b.model;

  if (api === "chat.completions") normalizeChat(b, out);
  else if (api === "messages") normalizeAnthropic(b, out);
  else if (api === "responses") normalizeResponses(b, out);

  return out;
}

function normalizeChat(b: J, out: NormalizedRequest): void {
  // Tool results only carry tool_call_id; remember id → name from the
  // assistant messages that made the calls.
  const callNames = new Map<string, string>();
  const messages: J[] = Array.isArray(b.messages) ? b.messages : [];

  messages.forEach((m, i) => {
    const role = String(m.role ?? "user");
    if (role === "system" || role === "developer") {
      push(out, { source: "system", role, text: contentText(m.content), messageIndex: i });
    } else if (role === "user") {
      push(out, { source: "user", role, text: contentText(m.content), messageIndex: i });
    } else if (role === "assistant") {
      const text = contentText(m.content);
      if (text) push(out, { source: "assistant", role, text, messageIndex: i });
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const name = String(tc.function?.name ?? "?");
        const id = String(tc.id ?? "");
        callNames.set(id, name);
        push(out, { source: "tool_call", role, text: `${name}(${tc.function?.arguments ?? ""})`, messageIndex: i, toolName: name, toolCallId: id });
      }
    } else if (role === "tool" || role === "function") {
      const id = String(m.tool_call_id ?? "");
      const name = callNames.get(id) ?? (typeof m.name === "string" ? m.name : "?");
      push(out, { source: "tool_result", role, text: contentText(m.content), messageIndex: i, toolName: name, toolCallId: id });
    }
  });

  const tools: J[] = Array.isArray(b.tools) ? b.tools : [];
  out.toolNames = tools.map((t) => String(t.function?.name ?? t.name ?? t.type ?? "?"));
  if (tools.length) push(out, { source: "tool_schema", role: "tools", text: JSON.stringify(tools), messageIndex: -1 });
}

function normalizeAnthropic(b: J, out: NormalizedRequest): void {
  const callNames = new Map<string, string>();
  if (b.system !== undefined) push(out, { source: "system", role: "system", text: contentText(b.system), messageIndex: -1 });

  const messages: J[] = Array.isArray(b.messages) ? b.messages : [];
  messages.forEach((m, i) => {
    const role = String(m.role ?? "user");
    const base: SegmentSource = role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") return push(out, { source: base, role, text: m.content, messageIndex: i });

    // Content is a list of typed BLOCKS; one message can mix text, tool calls
    // and tool results, so one message can become several segments.
    for (const block of Array.isArray(m.content) ? (m.content as J[]) : []) {
      switch (block.type) {
        case "text":
          push(out, { source: base, role, text: String(block.text ?? ""), messageIndex: i });
          break;
        case "thinking":
          push(out, { source: "assistant", role: "thinking", text: String(block.thinking ?? ""), messageIndex: i });
          break;
        case "tool_use": {
          const name = String(block.name ?? "?");
          callNames.set(String(block.id), name);
          push(out, { source: "tool_call", role, text: `${name}(${JSON.stringify(block.input ?? {})})`, messageIndex: i, toolName: name, toolCallId: String(block.id) });
          break;
        }
        case "tool_result": {
          const id = String(block.tool_use_id ?? "");
          const seg: Segment = { source: "tool_result", role, text: contentText(block.content), messageIndex: i, toolName: callNames.get(id) ?? "?", toolCallId: id };
          if (block.is_error === true) seg.isError = true;
          push(out, seg);
          break;
        }
        default:
          push(out, { source: base, role, text: `[${block.type}]`, messageIndex: i });
      }
    }
  });

  const tools: J[] = Array.isArray(b.tools) ? b.tools : [];
  out.toolNames = tools.map((t) => String(t.name ?? t.type ?? "?"));
  if (tools.length) push(out, { source: "tool_schema", role: "tools", text: JSON.stringify(tools), messageIndex: -1 });
}

function normalizeResponses(b: J, out: NormalizedRequest): void {
  const callNames = new Map<string, string>();
  if (typeof b.instructions === "string") push(out, { source: "system", role: "instructions", text: b.instructions, messageIndex: -1 });
  if (typeof b.previous_response_id === "string") {
    // Conversation state lives on OpenAI's servers: we can't see it.
    out.notes.push("Uses previous_response_id: earlier turns are stored server-side and are NOT visible in this request.");
  }

  const items: J[] = typeof b.input === "string" ? [{ role: "user", content: b.input }] : Array.isArray(b.input) ? b.input : [];
  items.forEach((item, i) => {
    if (item.type === "function_call") {
      const name = String(item.name ?? "?");
      callNames.set(String(item.call_id), name);
      push(out, { source: "tool_call", role: "assistant", text: `${name}(${item.arguments ?? ""})`, messageIndex: i, toolName: name, toolCallId: String(item.call_id) });
    } else if (item.type === "function_call_output") {
      const id = String(item.call_id ?? "");
      push(out, { source: "tool_result", role: "tool", text: contentText(item.output), messageIndex: i, toolName: callNames.get(id) ?? "?", toolCallId: id });
    } else if (item.role) {
      const role = String(item.role);
      const source: SegmentSource = role === "system" || role === "developer" ? "system" : role === "assistant" ? "assistant" : "user";
      push(out, { source, role, text: contentText(item.content), messageIndex: i });
    }
    // "reasoning" and other item types are skipped.
  });

  const tools: J[] = Array.isArray(b.tools) ? b.tools : [];
  out.toolNames = tools.map((t) => String(t.name ?? t.type ?? "?"));
  if (tools.length) push(out, { source: "tool_schema", role: "tools", text: JSON.stringify(tools), messageIndex: -1 });
}

// ---------------------------------------------------------------------------
// Responses → normalized
// ---------------------------------------------------------------------------

export function normalizeResponse(api: ModelApi, body: unknown, status: number): NormalizedResponse {
  const b = (isObj(body) ? body : {}) as J;
  const out: NormalizedResponse = { text: "", toolCalls: [], truncated: false };

  if (status >= 400 || b.error) {
    // OpenAI: {error:{message}}  ·  Anthropic: {type:"error", error:{message}}
    out.error = String(b.error?.message ?? (typeof body === "string" ? body : `HTTP ${status}`));
    return out;
  }

  if (api === "chat.completions") {
    const choice = b.choices?.[0] ?? {};
    out.text = contentText(choice.message?.content);
    if (typeof choice.message?.refusal === "string") out.refusal = choice.message.refusal;
    for (const tc of choice.message?.tool_calls ?? []) {
      out.toolCalls.push({ id: String(tc.id ?? ""), name: String(tc.function?.name ?? "?"), arguments: String(tc.function?.arguments ?? "") });
    }
    if (choice.finish_reason) out.finishReason = String(choice.finish_reason);
    out.truncated = choice.finish_reason === "length";
    if (b.usage) out.usage = { inputTokens: b.usage.prompt_tokens, outputTokens: b.usage.completion_tokens };
  } else if (api === "messages") {
    for (const block of Array.isArray(b.content) ? (b.content as J[]) : []) {
      if (block.type === "text") out.text += String(block.text ?? "");
      if (block.type === "tool_use") out.toolCalls.push({ id: String(block.id), name: String(block.name), arguments: JSON.stringify(block.input ?? {}) });
    }
    if (b.stop_reason) out.finishReason = String(b.stop_reason);
    out.truncated = b.stop_reason === "max_tokens";
    if (b.usage) {
      // Prompt caching splits input into fresh + cache read + cache write; the model saw all of it.
      const u = b.usage;
      out.usage = { inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens };
    }
  } else if (api === "responses") {
    for (const item of Array.isArray(b.output) ? (b.output as J[]) : []) {
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (part.type === "output_text") out.text += String(part.text ?? "");
          if (part.type === "refusal") out.refusal = String(part.refusal ?? "");
        }
      } else if (item.type === "function_call") {
        out.toolCalls.push({ id: String(item.call_id ?? item.id), name: String(item.name), arguments: String(item.arguments ?? "") });
      }
    }
    out.finishReason = String(b.status ?? "");
    out.truncated = b.status === "incomplete" && b.incomplete_details?.reason === "max_output_tokens";
    if (b.usage) out.usage = { inputTokens: b.usage.input_tokens, outputTokens: b.usage.output_tokens };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Streaming: SSE messages → the equivalent non-streamed response body
// ---------------------------------------------------------------------------

/**
 * Rebuild the full response from its stream, so everything downstream can
 * treat streamed and non-streamed calls identically.
 */
export function reassembleStream(api: ModelApi, messages: SseMessage[]): unknown {
  const datas: J[] = [];
  for (const m of messages) {
    if (m.data === "[DONE]") continue;
    try {
      datas.push(JSON.parse(m.data) as J);
    } catch {
      /* non-JSON keep-alive or garbage: ignore */
    }
  }
  if (api === "chat.completions") return reassembleChat(datas);
  if (api === "messages") return reassembleAnthropic(datas);
  if (api === "responses") return reassembleResponses(datas);
  return { streamedEvents: datas };
}

/**
 * OpenAI chunks carry DELTAS: small pieces to append. Text arrives as
 * content fragments; tool calls arrive as fragments addressed by `index`
 * (first fragment has id + name, later ones only more `arguments` text).
 */
function reassembleChat(chunks: J[]): J {
  const result: J = { object: "chat.completion", choices: [] as J[] };
  for (const chunk of chunks) {
    if (chunk.error) result.error = chunk.error;
    result.id ??= chunk.id;
    result.model ??= chunk.model;
    if (chunk.usage) result.usage = chunk.usage;
    for (const c of chunk.choices ?? []) {
      const idx = c.index ?? 0;
      const choice = (result.choices[idx] ??= { index: idx, message: { role: "assistant", content: null }, finish_reason: null });
      const d = c.delta ?? {};
      if (typeof d.content === "string") choice.message.content = (choice.message.content ?? "") + d.content;
      if (typeof d.refusal === "string") choice.message.refusal = (choice.message.refusal ?? "") + d.refusal;
      for (const tc of d.tool_calls ?? []) {
        choice.message.tool_calls ??= [];
        const slot = (choice.message.tool_calls[tc.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
      if (c.finish_reason) choice.finish_reason = c.finish_reason;
    }
  }
  return result;
}

/**
 * Anthropic streams a STATE MACHINE:
 *   message_start            → the message skeleton (id, model, input usage)
 *   content_block_start[i]   → a new block: text "" or tool_use {input:{}}
 *   content_block_delta[i]   → text_delta (append text) or input_json_delta
 *                              (append to a JSON *string* we parse at the end)
 *   content_block_stop[i]
 *   message_delta            → stop_reason + final output usage
 *   message_stop
 */
function reassembleAnthropic(events: J[]): J {
  let message: J = { type: "message", role: "assistant", content: [] as J[] };
  const partialJson = new Map<number, string>();
  for (const ev of events) {
    switch (ev.type) {
      case "message_start":
        message = { ...ev.message, content: [] };
        break;
      case "content_block_start":
        message.content[ev.index] = { ...ev.content_block };
        if (ev.content_block?.type === "tool_use") partialJson.set(ev.index, "");
        break;
      case "content_block_delta": {
        const block = message.content[ev.index] ?? (message.content[ev.index] = { type: "text", text: "" });
        const d = ev.delta ?? {};
        if (d.type === "text_delta") block.text = (block.text ?? "") + d.text;
        else if (d.type === "input_json_delta") partialJson.set(ev.index, (partialJson.get(ev.index) ?? "") + d.partial_json);
        else if (d.type === "thinking_delta") block.thinking = (block.thinking ?? "") + d.thinking;
        break;
      }
      case "content_block_stop": {
        const json = partialJson.get(ev.index);
        if (json !== undefined) {
          try {
            message.content[ev.index].input = json ? JSON.parse(json) : {};
          } catch {
            message.content[ev.index].input = { _unparsed: json };
          }
        }
        break;
      }
      case "message_delta":
        Object.assign(message, ev.delta ?? {});
        message.usage = { ...message.usage, ...ev.usage };
        break;
      case "error":
        message.error = ev.error;
        break;
    }
  }
  return message;
}

/** The Responses API ends its stream with the COMPLETE response object. */
function reassembleResponses(events: J[]): J {
  const final = events.find((e) => e.type === "response.completed" || e.type === "response.incomplete" || e.type === "response.failed");
  if (final?.response) return final.response;
  // Fallback: stitch the text deltas together.
  const text = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  return { object: "response", status: "in_progress", output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Content can be a string, or an array of PARTS ([{type:"text",text}, {type:"image_url"}...]).
 * Flatten to text, with placeholders for non-text parts so they stay visible.
 */
export function contentText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: J) => {
        if (typeof p === "string") return p;
        if (typeof p?.text === "string") return p.text;
        if (p?.type === "tool_result") return contentText(p.content);
        return `[${p?.type ?? "part"}]`;
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

function push(out: NormalizedRequest, seg: Segment): void {
  out.segments.push(seg);
}

function isObj(v: unknown): v is J {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Number of conversation messages (for the "→ 4 msgs" terminal line). */
export function messageCount(api: ModelApi, body: unknown): number | undefined {
  const b = (isObj(body) ? body : {}) as J;
  if (api === "chat.completions" || api === "messages") return Array.isArray(b.messages) ? b.messages.length : undefined;
  if (api === "responses") return typeof b.input === "string" ? 1 : Array.isArray(b.input) ? b.input.length : undefined;
  return undefined;
}
