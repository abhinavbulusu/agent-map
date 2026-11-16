/**
 * live/events.ts — the event log: what happened during an agent run.
 *
 * DESIGN: record RAW FACTS, derive everything else.
 * The proxy writes only what it observed on the wire: "this request went
 * out, this response came back, it took 412ms". Interpretations — "the tool
 * returned empty", "this claim isn't grounded" — are computed LATER from the
 * raw events (see src/analyze/). Two payoffs:
 *   - better detectors re-analyze old recordings for free;
 *   - a bug in analysis can never corrupt the recording.
 *
 * FORMAT: JSONL ("JSON Lines") — one JSON object per line, appended as events
 * happen. Unlike one big JSON array, you can append without rewriting the
 * file, read it while it's being written (`agentmap ui` tails it), and a
 * crash mid-write loses at most the last line.
 *
 * Every event gets `seq` (1, 2, 3...; total order even when timestamps tie)
 * and `ts` (ISO time when it was logged).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync, readSync } from "node:fs";
import { dirname } from "node:path";

export type Provider = "openai" | "anthropic";
export type ModelApi = "chat.completions" | "responses" | "messages" | "other";

export interface SessionStartEvent {
  type: "session_start";
  sessionId: string;
  command: string[];
  cwd: string;
  proxyUrl: string;
  upstreams: { openai: string; anthropic: string };
  httpProxy: boolean;
  agentmapVersion?: string;
}

/** Logged when a request ARRIVES, so the UI can show calls in flight. */
export interface CallStartEvent {
  type: "call_start";
  id: string;
  kind: "model" | "http";
  method: string;
  url: string;
  provider?: Provider;
  model?: string;
  messageCount?: number;
}

export interface ModelCallEvent {
  type: "model_call";
  id: string;
  provider: Provider;
  api: ModelApi;
  method: string;
  path: string;
  upstreamUrl: string;
  startedAt: string;
  durationMs: number;
  request: { headers: Record<string, string>; body: unknown };
  response?: {
    status: number;
    headers: Record<string, string>;
    /** For streamed responses: REASSEMBLED into the non-streaming shape. */
    body: unknown;
    streamed: boolean;
    sseEvents?: number;
    /** Raw SSE text (capped), so you can see exactly what streamed. */
    rawStream?: string;
  };
  /** Set if the upstream couldn't be reached at all. */
  error?: string;
}

export interface HttpCallEvent {
  type: "http_call";
  id: string;
  method: string;
  url: string;
  startedAt: string;
  durationMs: number;
  request: { headers: Record<string, string>; body?: string; bodyBytes: number };
  response?: { status: number; headers: Record<string, string>; body?: string; bodyBytes: number; contentType?: string };
  error?: string;
}

/** An HTTPS connection we tunneled: encrypted, so only metadata is known. */
export interface TunnelEvent {
  type: "tunnel";
  id: string;
  host: string;
  port: number;
  startedAt: string;
  durationMs: number;
  bytesUp: number;
  bytesDown: number;
  error?: string;
}

export interface SessionEndEvent {
  type: "session_end";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  error?: string;
}

/** An event before the log stamps it. */
export type NewEvent = SessionStartEvent | CallStartEvent | ModelCallEvent | HttpCallEvent | TunnelEvent | SessionEndEvent;
/** An event as stored: stamped with seq + ts. */
export type AgentEvent = NewEvent & { seq: number; ts: string };

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type Listener = (event: AgentEvent) => void;

export class EventLog {
  readonly path: string;
  readonly events: AgentEvent[] = [];
  private fd: number;
  private seq = 0;
  private listeners = new Set<Listener>();

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    // "w" truncates: one file = one session. (The previous session is gone;
    // copy the file if you want to keep it.)
    this.fd = openSync(path, "w");
  }

  append(event: NewEvent): AgentEvent {
    const stamped = { ...event, seq: ++this.seq, ts: new Date().toISOString() } as AgentEvent;
    this.events.push(stamped);
    // Synchronous write: events are few and small, and sync means the line is
    // on disk (visible to `agentmap ui`) before we move on — and nothing is
    // lost in a buffer if the process dies.
    writeSync(this.fd, JSON.stringify(stamped) + "\n");
    for (const listener of this.listeners) listener(stamped);
    return stamped;
  }

  /** Observer pattern: get called for every new event. Returns an unsubscribe fn. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    closeSync(this.fd);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function parseEventLines(text: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AgentEvent);
    } catch {
      // A partially-written last line, most likely. Skip it.
    }
  }
  return events;
}

export function readEventsFile(path: string): AgentEvent[] {
  try {
    return parseEventLines(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Follow a JSONL file as it grows (like `tail -f`).
 *
 * Why POLLING (check the size every 250ms) instead of fs.watch()? fs.watch is
 * built on OS-specific notification APIs (FSEvents, inotify, ...) whose
 * behavior differs: duplicate events, missed events on network drives, no
 * event when the file doesn't exist yet. A size check is boring and works
 * everywhere; 250ms of latency is invisible to a human.
 *
 * Subtleties handled:
 *  - The file may not exist yet (ui started before run): keep polling.
 *  - Shrinking = a new session truncated the file: call onReset, start over.
 *  - We may read half a line: keep the remainder until its "\n" arrives.
 */
export function tailEvents(path: string, onEvent: (e: AgentEvent) => void, onReset: () => void, intervalMs = 250): () => void {
  let offset = 0;
  let partial = "";

  const poll = () => {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < offset) {
      offset = 0;
      partial = "";
      onReset();
    }
    if (size === offset) return;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const text = partial + buf.toString("utf8");
      const lines = text.split("\n");
      partial = lines.pop() ?? ""; // last element is incomplete (or "")
      for (const event of parseEventLines(lines.join("\n"))) onEvent(event);
    } finally {
      closeSync(fd);
    }
  };

  poll();
  const timer = setInterval(poll, intervalMs);
  return () => clearInterval(timer);
}
