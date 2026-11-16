/**
 * analyze/session.ts — turn the raw event log into an understanding of the run.
 *
 *   events (raw facts)  ──buildSession()──▶  SessionState  ──addSessionToGraph()──▶  graph
 *
 * SessionState holds:
 *   modelCalls  each call normalized, X-rayed, its answer claim-traced
 *   tools       every tool invocation: requested in call A (the model's
 *               tool_call), result seen in call B (the next request carries it)
 *   http        every HTTP call / HTTPS tunnel, ATTRIBUTED to the tool that
 *               was running at the time (when unambiguous)
 *   findings    deduplicated problems, worst first
 *
 * This is a PURE FUNCTION of the events: same events in, same state out. The
 * live view simply re-runs it on every new event (cheap: runs have tens to
 * hundreds of events, not millions).
 */
import { basename } from "node:path";
import { GraphBuilder, nodeId, type Detail, type Issue, type Status } from "../graph.ts";
import type { AgentEvent, CallStartEvent, HttpCallEvent, ModelApi, ModelCallEvent, Provider, TunnelEvent } from "../live/events.ts";
import { normalizeRequest, normalizeResponse, type NormalizedRequest, type NormalizedResponse } from "../live/providers.ts";
import { detectSilentFailures, traceClaims, type ClaimTrace } from "./silent.ts";
import { xrayRequest, type XRay, type XrayFlag } from "./xray.ts";

export interface ModelCallView {
  id: string;
  seq: number;
  provider: Provider;
  api: ModelApi;
  model: string;
  startedAt: string;
  durationMs: number;
  httpStatus: number | null;
  streamed: boolean;
  request: NormalizedRequest;
  response: NormalizedResponse;
  xray: XRay;
  claims: ClaimTrace[];
  /** Raw bodies, for the "show me exactly" view. */
  raw: { request: unknown; response: unknown; rawStream?: string };
}

export interface ToolInvocation {
  callId: string;
  name: string;
  arguments: string;
  requestedIn?: string;
  requestedAt?: number; // epoch ms: end of the model call that asked for it
  result?: { text: string; tokens: number; flags: XrayFlag[]; seenIn: string; seenAt: number };
  httpCallIds: string[];
}

export interface HttpCallView {
  id: string;
  kind: "http" | "tunnel";
  method: string;
  url: string;
  origin: string;
  startedAt: string;
  durationMs: number;
  status?: number;
  error?: string;
  bytes: number;
  attributedTo?: string; // tool callId
  candidates: string[];
  event: HttpCallEvent | TunnelEvent;
}

export interface Finding {
  id: string;
  severity: "warn" | "error";
  code: string;
  message: string;
  hint?: string;
  modelCallId?: string;
  toolCallId?: string;
  httpCallId?: string;
}

export interface SessionState {
  sessionId?: string;
  command?: string[];
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  running: boolean;
  modelCalls: ModelCallView[];
  tools: ToolInvocation[];
  http: HttpCallView[];
  /** Calls in flight: started, not finished. targetNodeId is where the edge points. */
  pending: { id: string; kind: "model" | "http"; label: string; startedAt: string; targetNodeId: string; targetLabel: string }[];
  findings: Finding[];
  timeline: { seq: number; ts: string; type: string; label: string; ref?: string }[];
}

const LLM_HOSTS = /(^|\.)(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.groq\.com)$/;

export function buildSession(events: AgentEvent[]): SessionState {
  const state: SessionState = { running: false, modelCalls: [], tools: [], http: [], pending: [], findings: [], timeline: [] };
  const started = new Map<string, CallStartEvent & { ts: string }>();
  const done = new Set<string>();

  for (const e of events) {
    switch (e.type) {
      case "session_start":
        state.sessionId = e.sessionId;
        state.command = e.command;
        state.startedAt = e.ts;
        state.running = true;
        state.timeline.push({ seq: e.seq, ts: e.ts, type: e.type, label: `started: ${e.command.join(" ")}` });
        break;
      case "call_start":
        started.set(e.id, e);
        break;
      case "model_call":
        done.add(e.id);
        state.modelCalls.push(viewModelCall(e));
        break;
      case "http_call":
      case "tunnel":
        done.add(e.id);
        state.http.push(viewHttp(e));
        break;
      case "session_end":
        state.running = false;
        state.endedAt = e.ts;
        state.exitCode = e.exitCode;
        state.timeline.push({ seq: e.seq, ts: e.ts, type: e.type, label: `exited ${e.exitCode ?? e.signal ?? "?"}${e.error ? ` (${e.error})` : ""}` });
        break;
    }
  }

  // In-flight calls: started but not finished (only meaningful while running).
  if (state.running) {
    for (const [id, s] of started) {
      if (done.has(id)) continue;
      const isModel = s.kind === "model";
      const model = s.model ?? "unknown-model";
      state.pending.push({
        id,
        kind: s.kind,
        label: `${s.method} ${s.url}`,
        startedAt: s.ts,
        targetNodeId: isModel ? nodeId("llm", s.provider ?? "openai", model) : nodeId("http_endpoint", originOf(s.url)),
        targetLabel: isModel ? model : originOf(s.url),
      });
    }
  }

  linkTools(state);
  attributeHttp(state);
  collectFindings(state);
  buildTimeline(state);
  return state;
}

// ---------------------------------------------------------------------------
// Views of individual events
// ---------------------------------------------------------------------------

function viewModelCall(e: ModelCallEvent & { seq: number }): ModelCallView {
  const request = normalizeRequest(e.api, e.request.body);
  const httpStatus = e.response?.status ?? null;
  const response: NormalizedResponse = e.response ? normalizeResponse(e.api, e.response.body, e.response.status) : { text: "", toolCalls: [], truncated: false, error: e.error ?? "no response" };
  const xray = xrayRequest(request, response);
  const claims = response.text ? traceClaims(response.text, request.segments) : [];
  const raw: ModelCallView["raw"] = { request: e.request.body, response: e.response?.body ?? { error: e.error } };
  if (e.response?.rawStream) raw.rawStream = e.response.rawStream;
  return {
    id: e.id,
    seq: e.seq,
    provider: e.provider,
    api: e.api,
    model: request.model ?? "unknown-model",
    startedAt: e.startedAt,
    durationMs: e.durationMs,
    httpStatus,
    streamed: e.response?.streamed ?? false,
    request,
    response,
    xray,
    claims,
    raw,
  };
}

function viewHttp(e: (HttpCallEvent | TunnelEvent) & { seq: number }): HttpCallView {
  if (e.type === "tunnel") {
    const url = `https://${e.host}${e.port === 443 ? "" : `:${e.port}`}`;
    const v: HttpCallView = { id: e.id, kind: "tunnel", method: "CONNECT", url, origin: url, startedAt: e.startedAt, durationMs: e.durationMs, bytes: e.bytesUp + e.bytesDown, candidates: [], event: e };
    if (e.error) v.error = e.error;
    return v;
  }
  const v: HttpCallView = {
    id: e.id,
    kind: "http",
    method: e.method,
    url: e.url,
    origin: originOf(e.url),
    startedAt: e.startedAt,
    durationMs: e.durationMs,
    bytes: (e.response?.bodyBytes ?? 0) + e.request.bodyBytes,
    candidates: [],
    event: e,
  };
  if (e.response) v.status = e.response.status;
  if (e.error) v.error = e.error;
  return v;
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.protocol === "http:" ? u.pathname : ""}`;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Linking tool calls (requested in one model call, answered in a later one)
// ---------------------------------------------------------------------------

function linkTools(state: SessionState): void {
  const byId = new Map<string, ToolInvocation>();
  const calls = [...state.modelCalls].sort((a, b) => a.seq - b.seq);

  for (const call of calls) {
    const startMs = Date.parse(call.startedAt);
    // 1) Results present in this request → attach to their invocation (first sighting wins).
    call.xray.segments.forEach((seg) => {
      if (seg.source !== "tool_result" || !seg.toolCallId) return;
      let inv = byId.get(seg.toolCallId);
      if (!inv) {
        // A result for a call we never saw requested (e.g. history replayed from elsewhere).
        inv = { callId: seg.toolCallId, name: seg.toolName ?? "?", arguments: "", httpCallIds: [] };
        byId.set(seg.toolCallId, inv);
        state.tools.push(inv);
      }
      inv.result ??= { text: seg.text, tokens: seg.tokens, flags: seg.flags, seenIn: call.id, seenAt: startMs };
    });
    // 2) Tool calls the model asked for in its response.
    for (const tc of call.response.toolCalls) {
      if (byId.has(tc.id)) continue;
      const inv: ToolInvocation = { callId: tc.id, name: tc.name, arguments: tc.arguments, requestedIn: call.id, requestedAt: startMs + call.durationMs, httpCallIds: [] };
      byId.set(tc.id, inv);
      state.tools.push(inv);
    }
  }
}

/**
 * Which tool made this HTTP call? The proxy can't see inside the agent, but
 * TIME can: a tool runs between "model asked for it" and "its result appears
 * in the next request". An HTTP call inside exactly one such window belongs
 * to that tool. If several tools ran concurrently, we list the candidates.
 */
function attributeHttp(state: SessionState): void {
  const callStarts = state.modelCalls.map((c) => Date.parse(c.startedAt)).sort((a, b) => a - b);
  // A tool's window ends when its result reaches the model — or, if that
  // never happens (crash, timeout, retry), at the NEXT model call: by then the
  // agent has moved on. Without this, one abandoned tool call would make every
  // later HTTP call look ambiguous.
  const windowEnd = (inv: ToolInvocation) =>
    inv.result?.seenAt ?? callStarts.find((t) => t > (inv.requestedAt ?? 0)) ?? Number.POSITIVE_INFINITY;

  for (const h of state.http) {
    const t = Date.parse(h.startedAt);
    const windows = state.tools.filter((inv) => inv.requestedAt !== undefined && t >= inv.requestedAt - 5 && t <= windowEnd(inv));
    h.candidates = windows.map((w) => w.callId);
    if (windows.length === 1) {
      h.attributedTo = windows[0]!.callId;
      windows[0]!.httpCallIds.push(h.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function collectFindings(state: SessionState): void {
  const findings: Finding[] = [];
  let n = 0;
  const add = (f: Omit<Finding, "id">) => findings.push({ id: `f${++n}`, ...f });

  for (const call of state.modelCalls) {
    if (call.response.error) {
      add({ severity: "error", code: "model_call_failed", message: `${call.model}: ${call.httpStatus ? `HTTP ${call.httpStatus} — ` : ""}${call.response.error}`, modelCallId: call.id });
    }
    if (call.response.truncated) {
      add({ severity: "warn", code: "output_truncated", message: `${call.model} hit its max-tokens limit: the answer is cut off`, hint: "Raise max_tokens, or ask for shorter output.", modelCallId: call.id });
    }
    for (const note of call.xray.notes) add({ severity: "warn", code: "context_hidden", message: note, modelCallId: call.id });

    // Silent failures + ungrounded claims (only for final answers).
    for (const s of detectSilentFailures(call.xray.segments, call.response, call.claims)) {
      const f: Omit<Finding, "id"> = { severity: s.severity, code: s.code, message: s.message, hint: s.hint, modelCallId: call.id };
      if (s.toolCallIds[0]) f.toolCallId = s.toolCallIds[0];
      add(f);
    }
  }

  // Data-quality flags, ONCE per tool result. (Each later request repeats the
  // whole history, so the same result appears again and again.)
  for (const inv of state.tools) {
    for (const flag of inv.result?.flags ?? []) {
      add({ severity: flag.severity, code: `tool_${flag.code}`, message: `${inv.name}: ${flag.message}`, toolCallId: inv.callId, ...(inv.result ? { modelCallId: inv.result.seenIn } : {}) });
    }
  }

  for (const h of state.http) {
    if (h.error) add({ severity: "error", code: "http_failed", message: `${h.method} ${h.url} failed: ${h.error}`, httpCallId: h.id });
    else if (h.status !== undefined && h.status >= 400) {
      add({ severity: h.status >= 500 ? "error" : "warn", code: "http_status", message: `${h.method} ${h.url} → HTTP ${h.status}`, httpCallId: h.id, ...(h.attributedTo ? { toolCallId: h.attributedTo } : {}) });
    }
    if (h.kind === "tunnel" && LLM_HOSTS.test(new URL(h.url).hostname)) {
      add({
        severity: "warn",
        code: "llm_bypassed_proxy",
        message: `Encrypted connection straight to ${new URL(h.url).hostname}: an LLM call that bypassed OPENAI_BASE_URL/ANTHROPIC_BASE_URL`,
        hint: "Something in the agent hardcodes the API base URL, so agentmap can't see that call's content.",
        httpCallId: h.id,
      });
    }
  }

  state.findings = findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}

function buildTimeline(state: SessionState): void {
  for (const call of state.modelCalls) {
    const what = call.response.error
      ? `error: ${call.response.error}`
      : call.response.toolCalls.length
        ? `tool call: ${call.response.toolCalls.map((t) => t.name).join(", ")}`
        : `answer: ${oneLine(call.response.text, 60)}`;
    state.timeline.push({ seq: call.seq, ts: call.startedAt, type: "model_call", label: `${call.model} → ${what}`, ref: call.id });
  }
  for (const h of state.http) {
    state.timeline.push({ seq: Number.MAX_SAFE_INTEGER, ts: h.startedAt, type: h.kind, label: `${h.method} ${h.url} → ${h.error ?? h.status ?? `${h.bytes} bytes`}`, ref: h.id });
  }
  state.timeline.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.seq - b.seq);
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// ---------------------------------------------------------------------------
// Session → graph
// ---------------------------------------------------------------------------

export const LIVE_AGENT_ID = nodeId("agent", "live");

/** Adds the live session to the graph; returns the ids of edges with calls in flight. */
export function addSessionToGraph(builder: GraphBuilder, state: SessionState): string[] {
  if (!state.command) return [];
  const findingsFor = (pred: (f: Finding) => boolean): Issue[] =>
    state.findings.filter(pred).map((f) => ({ severity: f.severity, code: f.code, message: f.message, ...(f.hint ? { hint: f.hint } : {}) }));

  const status = state.running ? "running" : `exited ${state.exitCode ?? "?"}`;
  builder.node({
    id: LIVE_AGENT_ID,
    kind: "agent",
    // "/long/venv/bin/python agent.py" → "python agent.py": the path is noise here.
    label: [basename(state.command[0] ?? "agent"), ...state.command.slice(1)].join(" "),
    status: state.exitCode && state.exitCode !== 0 ? "error" : "ok",
    summary: `live session · ${status} · ${state.modelCalls.length} model call(s)`,
    meta: { source: "live", sessionId: state.sessionId, startedAt: state.startedAt, endedAt: state.endedAt },
  });

  // LLMs: one node per provider/model.
  const toolCallToLlm = new Map<string, string>();
  for (const call of state.modelCalls) {
    const llmId = nodeId("llm", call.provider, call.model);
    const callIssues = findingsFor((f) => f.modelCallId === call.id && !f.code.startsWith("tool_"));
    const callStatus: Status = call.response.error ? "error" : "ok";
    builder.node({
      id: llmId,
      kind: "llm",
      label: call.model,
      status: callStatus,
      issues: callIssues,
      meta: { source: "live", provider: call.provider, api: call.api },
      details: [modelCallDetail(call)],
    });
    builder.edge({ from: LIVE_AGENT_ID, to: llmId, kind: "connects", status: callStatus, label: `${call.provider} ${call.api}` });
    for (const tc of call.response.toolCalls) toolCallToLlm.set(tc.id, llmId);
  }
  // Summaries need totals, so set them after the loop.
  for (const llm of new Set(state.modelCalls.map((c) => nodeId("llm", c.provider, c.model)))) {
    const calls = state.modelCalls.filter((c) => nodeId("llm", c.provider, c.model) === llm);
    const tokensIn = calls.reduce((n, c) => n + (c.response.usage?.inputTokens ?? c.xray.estimatedTokens), 0);
    const avg = Math.round(calls.reduce((n, c) => n + c.durationMs, 0) / calls.length);
    builder.node({ id: llm, kind: "llm", label: calls[0]!.model, summary: `${calls[0]!.provider} · ${calls.length} call(s) · ${tokensIn.toLocaleString("en-US")} tokens in · avg ${avg}ms` });
  }

  // Tools: one node per tool name; each invocation is a detail.
  for (const inv of state.tools) {
    const toolId = nodeId("tool", "live", inv.name);
    const flags = inv.result?.flags ?? [];
    const st: Status = flags.some((f) => f.severity === "error") ? "error" : flags.length ? "warn" : inv.result ? "ok" : "unknown";
    builder.node({
      id: toolId,
      kind: "tool",
      label: inv.name,
      status: st,
      meta: { source: "live" },
      issues: flags.map((f) => ({ severity: f.severity, code: `tool_${f.code}`, message: f.message })),
      details: [
        {
          title: `${inv.name}(${inv.arguments})`,
          request: tryParse(inv.arguments),
          response: inv.result ? inv.result.text : "(result not seen yet)",
          note: inv.result ? `~${inv.result.tokens} tokens · sent to the model in ${inv.result.seenIn}` : "the model hasn't received this result yet",
          ref: inv.callId,
        },
      ],
    });
    // Edge from the LLM that requested this call (fallback: first LLM, else the agent).
    const firstCall = state.modelCalls[0];
    const llmId = toolCallToLlm.get(inv.callId) ?? (firstCall ? nodeId("llm", firstCall.provider, firstCall.model) : LIVE_AGENT_ID);
    builder.edge({ from: llmId, to: toolId, kind: "calls", status: st, issues: findingsFor((f) => f.toolCallId === inv.callId && !f.code.startsWith("tool_")) });
  }
  for (const name of new Set(state.tools.map((t) => t.name))) {
    const invs = state.tools.filter((t) => t.name === name);
    const last = invs[invs.length - 1]!;
    builder.node({ id: nodeId("tool", "live", name), kind: "tool", label: name, summary: `${invs.length} call(s) · last result ~${last.result?.tokens ?? 0} tokens` });
  }

  // HTTP endpoints: grouped by origin (+ path for plain HTTP).
  for (const h of state.http) {
    const endpointId = nodeId("http_endpoint", h.origin);
    const st: Status = h.error ? "error" : h.status !== undefined && h.status >= 500 ? "error" : h.status !== undefined && h.status >= 400 ? "warn" : "ok";
    const detail: Detail = {
      title: `${h.method} ${h.url}`,
      at: h.startedAt,
      durationMs: h.durationMs,
      request: h.event.type === "http_call" ? h.event.request : { host: h.event.host, port: h.event.port, bytesUp: h.event.bytesUp },
      response: h.event.type === "http_call" ? h.event.response ?? { error: h.error } : { bytesDown: h.event.bytesDown, error: h.error, note: "TLS tunnel: content is encrypted end-to-end" },
      ref: h.id,
    };
    builder.node({
      id: endpointId,
      kind: "http_endpoint",
      label: h.origin,
      status: st,
      meta: { source: "live" },
      summary: h.kind === "tunnel" ? "HTTPS (encrypted: metadata only)" : `HTTP ${h.status ?? "error"}`,
      issues: findingsFor((f) => f.httpCallId === h.id),
      details: [detail],
    });
    const inv = h.attributedTo ? state.tools.find((t) => t.callId === h.attributedTo) : undefined;
    const from = inv ? nodeId("tool", "live", inv.name) : LIVE_AGENT_ID;
    builder.edge({ from, to: endpointId, kind: "calls", status: st, ...(inv ? {} : { label: h.candidates.length > 1 ? `during ${h.candidates.length} concurrent tools` : "not during a tool call" }) });
  }

  // Calls in flight: make sure their target exists, and mark the edge.
  const pendingEdges: string[] = [];
  for (const p of state.pending) {
    if (!builder.getNode(p.targetNodeId)) {
      builder.node({ id: p.targetNodeId, kind: p.kind === "model" ? "llm" : "http_endpoint", label: p.targetLabel, summary: "in flight…" });
    }
    pendingEdges.push(builder.edge({ from: LIVE_AGENT_ID, to: p.targetNodeId, kind: p.kind === "model" ? "connects" : "calls" }).id);
  }
  return pendingEdges;
}

function modelCallDetail(call: ModelCallView): Detail {
  const out = call.response.error ? `error: ${call.response.error}` : call.response.toolCalls.length ? `tool calls: ${call.response.toolCalls.map((t) => t.name).join(", ")}` : oneLine(call.response.text, 80);
  return {
    title: `${call.id} · ${call.api}${call.streamed ? " (streamed)" : ""} → ${out}`,
    at: call.startedAt,
    durationMs: call.durationMs,
    request: call.raw.request,
    response: call.raw.response,
    note: `~${call.xray.estimatedTokens.toLocaleString("en-US")} tokens estimated${call.xray.reportedInputTokens !== undefined ? `, ${call.xray.reportedInputTokens.toLocaleString("en-US")} reported by provider` : ""}`,
    ref: call.id,
  };
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
