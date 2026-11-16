/**
 * live/proxy.ts — the recording proxy behind `agentmap run`.
 *
 * ONE local HTTP server, three jobs, chosen by the shape of the request:
 *
 * 1. REVERSE PROXY for LLM APIs   (request line: "POST /openai/chat/completions")
 *    The agent's SDK was told OPENAI_BASE_URL=http://127.0.0.1:PORT/openai, so
 *    it sends plain HTTP to us thinking we ARE OpenAI. We forward to the real
 *    upstream over HTTPS, stream the answer back, and record both sides in
 *    full. This works because WE terminate the agent's connection: there is
 *    no encryption between the agent and us.
 *
 * 2. FORWARD PROXY for plain HTTP (request line: "GET http://api.example.com/x")
 *    With HTTP_PROXY set, HTTP clients send the FULL URL to the proxy and let
 *    it fetch. We fetch, record, and relay.
 *
 * 3. CONNECT TUNNEL for HTTPS     (request line: "CONNECT api.example.com:443")
 *    With HTTPS_PROXY set, clients ask us to open a raw TCP pipe, then run TLS
 *    *through* it, end-to-end with the real server. We see host, timing and
 *    byte counts, never content. Decrypting would require a fake certificate
 *    authority installed on your machine (what mitmproxy does) — powerful but
 *    invasive, so agentmap deliberately doesn't.
 *
 * Listens on 127.0.0.1 ONLY. Bound to 0.0.0.0 it would be an open proxy that
 * anyone on your network could use to make requests from your machine.
 */
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { redactRecord } from "../util/redact.ts";
import type { CallStartEvent, EventLog, Provider } from "./events.ts";
import { detectApi, messageCount, reassembleStream } from "./providers.ts";
import { parseSse } from "./sse.ts";

export interface ProxyOptions {
  port: number;
  /** Real API base URLs to forward to (e.g. https://api.openai.com/v1). */
  upstreams: { openai: string; anthropic: string };
  log: EventLog;
}

export interface RunningProxy {
  url: string;
  port: number;
  close(): Promise<void>;
}

// Headers that describe ONE network hop, not the message. A proxy must not
// forward them (RFC 9110 §7.6.1). Plus a few we manage ourselves.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host", // fetch() sets the right Host for the upstream
  "content-length", // recomputed (we may re-encode the body)
  "accept-encoding", // ask upstream for plain text, so we can read it
]);

const MAX_RAW_STREAM = 256 * 1024; // cap stored raw SSE text per call
const MAX_HTTP_BODY = 256 * 1024; // cap stored HTTP bodies per call

export async function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}${++counter}`;
  const openTunnels = new Set<() => void>();
  let port = 0;

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`agentmap proxy error: ${(err as Error).message}`);
    });
  });

  // CONNECT doesn't go through the normal request handler: Node hands us the
  // raw client socket instead.
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => tunnel(req, client as Socket, head));

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? "/";
    let path = raw;

    // Absolute-form ("GET http://host/path") = we're being used as a forward proxy.
    if (/^https?:\/\//i.test(raw)) {
      const target = new URL(raw);
      const isSelf = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) && Number(target.port) === port;
      // Some clients send even our OWN base URL through HTTP_PROXY. Unwrap it.
      if (!isSelf) return forwardHttp(req, res, target);
      path = target.pathname + target.search;
    }

    if (path.startsWith("/openai/")) return forwardModel(req, res, "openai", opts.upstreams.openai + path.slice("/openai".length));
    if (path.startsWith("/anthropic/")) return forwardModel(req, res, "anthropic", opts.upstreams.anthropic + path.slice("/anthropic".length));

    res.writeHead(path === "/" ? 200 : 404, { "content-type": "text/plain" });
    res.end(`agentmap recording proxy.\nLLM routes: /openai/* → ${opts.upstreams.openai}, /anthropic/* → ${opts.upstreams.anthropic}\n`);
  }

  // -------------------------------------------------------------------------
  // 1. LLM calls (reverse proxy)
  // -------------------------------------------------------------------------

  async function forwardModel(req: IncomingMessage, res: ServerResponse, provider: Provider, upstreamUrl: string): Promise<void> {
    const id = nextId("m");
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const reqBody = await readBody(req);
    const reqJson = tryJson(reqBody.toString("utf8"));
    const path = new URL(upstreamUrl).pathname;
    const api = detectApi(provider, path);
    const method = req.method ?? "POST";

    const startEvent: CallStartEvent = { type: "call_start", id, kind: "model", method, url: upstreamUrl, provider };
    const model = (reqJson as { model?: unknown } | undefined)?.model;
    if (typeof model === "string") startEvent.model = model;
    const count = messageCount(api, reqJson);
    if (count !== undefined) startEvent.messageCount = count;
    opts.log.append(startEvent);

    const base = {
      type: "model_call" as const,
      id,
      provider,
      api,
      method,
      path,
      upstreamUrl,
      startedAt,
      request: { headers: redactRecord(req.headers), body: reqJson ?? reqBody.toString("utf8") },
    };

    // If the agent hangs up mid-stream, stop the upstream request too.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method,
        headers: forwardHeaders(req.headers),
        ...(method === "GET" || method === "HEAD" ? {} : { body: reqBody }),
        signal: abort.signal,
        redirect: "manual",
      });
    } catch (err) {
      const message = describeFetchError(err);
      // Answer like an API would, so the agent's SDK shows a sensible error.
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `agentmap proxy: could not reach ${upstreamUrl}: ${message}`, type: "agentmap_upstream_error" } }));
      opts.log.append({ ...base, durationMs: Date.now() - started, error: message });
      return;
    }

    // Relay status + headers, then the body chunk by chunk (keeps streaming live).
    const headers = responseHeaders(upstream.headers);
    res.writeHead(upstream.status, headers);
    const chunks = await relayBody(upstream, res);
    const text = Buffer.concat(chunks).toString("utf8");

    const streamed = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    const sse = streamed ? parseSse(text) : [];
    opts.log.append({
      ...base,
      durationMs: Date.now() - started,
      response: {
        status: upstream.status,
        headers: redactRecord(headers),
        body: streamed ? reassembleStream(api, sse) : tryJson(text) ?? text,
        streamed,
        ...(streamed ? { sseEvents: sse.length, rawStream: text.slice(0, MAX_RAW_STREAM) } : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // 2. Plain HTTP (forward proxy)
  // -------------------------------------------------------------------------

  async function forwardHttp(req: IncomingMessage, res: ServerResponse, target: URL): Promise<void> {
    const id = nextId("h");
    const started = Date.now();
    const method = req.method ?? "GET";
    opts.log.append({ type: "call_start", id, kind: "http", method, url: target.href });
    const reqBody = await readBody(req);
    const request = { headers: redactRecord(req.headers), bodyBytes: reqBody.length, ...(reqBody.length ? { body: textPreview(reqBody, req.headers["content-type"]) } : {}) };

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method,
        headers: forwardHeaders(req.headers),
        ...(method === "GET" || method === "HEAD" ? {} : { body: reqBody }),
        redirect: "manual", // the CLIENT decides whether to follow redirects
      });
    } catch (err) {
      const message = describeFetchError(err);
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`agentmap proxy: ${message}`);
      opts.log.append({ type: "http_call", id, method, url: target.href, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, request, error: message });
      return;
    }
    const headers = responseHeaders(upstream.headers);
    res.writeHead(upstream.status, headers);
    const body = Buffer.concat(await relayBody(upstream, res));
    const contentType = upstream.headers.get("content-type") ?? undefined;
    opts.log.append({
      type: "http_call",
      id,
      method,
      url: target.href,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      request,
      response: { status: upstream.status, headers: redactRecord(headers), bodyBytes: body.length, body: textPreview(body, contentType), ...(contentType ? { contentType } : {}) },
    });
  }

  // -------------------------------------------------------------------------
  // 3. HTTPS (CONNECT tunnel)
  // -------------------------------------------------------------------------

  function tunnel(req: IncomingMessage, client: Socket, head: Buffer): void {
    const id = nextId("t");
    const started = Date.now();
    const authority = req.url ?? "";
    const sep = authority.lastIndexOf(":"); // lastIndexOf: IPv6 hosts contain colons too
    const host = authority.slice(0, sep).replace(/^\[|\]$/g, "");
    const targetPort = Number(authority.slice(sep + 1)) || 443;
    opts.log.append({ type: "call_start", id, kind: "http", method: "CONNECT", url: `https://${host}:${targetPort}` });

    let bytesUp = head.length;
    let bytesDown = 0;
    let error: string | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      openTunnels.delete(finish);
      client.destroy();
      upstreamSocket.destroy();
      opts.log.append({
        type: "tunnel",
        id,
        host,
        port: targetPort,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        bytesUp,
        bytesDown,
        ...(error ? { error } : {}),
      });
    };
    openTunnels.add(finish);

    const upstreamSocket = connect(targetPort, host, () => {
      // Tell the client the pipe is open; from here on it's opaque TLS bytes.
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(client);
      client.pipe(upstreamSocket);
    });
    upstreamSocket.on("data", (c: Buffer) => (bytesDown += c.length));
    client.on("data", (c: Buffer) => (bytesUp += c.length));
    upstreamSocket.on("error", (err) => {
      error = (err as NodeJS.ErrnoException).code ?? err.message;
      if (client.writable && bytesDown === 0) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      finish();
    });
    client.on("error", finish);
    upstreamSocket.on("close", finish);
    client.on("close", finish);
  }

  // -------------------------------------------------------------------------
  // Start listening
  // -------------------------------------------------------------------------

  server.listen(opts.port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  port = typeof address === "object" && address ? address.port : opts.port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    async close() {
      for (const finish of [...openTunnels]) finish(); // log still-open tunnels
      server.closeAllConnections(); // don't wait for idle keep-alive sockets
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function forwardHeaders(incoming: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function responseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, name) => {
    // fetch() already DECOMPRESSED the body, so a leftover content-encoding
    // header would make the client try to decompress plain text.
    if (HOP_BY_HOP.has(name) || name === "content-encoding") return;
    out[name] = value;
  });
  return out;
}

/**
 * Copy the upstream body to the client as it arrives, keeping a copy.
 * BACKPRESSURE: res.write() returns false when the client's buffer is full;
 * we then wait for 'drain' instead of piling chunks up in memory.
 */
async function relayBody(upstream: Response, res: ServerResponse): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  try {
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        chunks.push(chunk);
        if (!res.write(chunk)) await once(res, "drain");
      }
    }
  } catch {
    // Client or upstream went away mid-stream; keep what we got.
  }
  res.end();
  return chunks;
}

function tryJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Store text-like bodies (capped); summarize binary ones. */
function textPreview(body: Buffer, contentType: string | undefined): string {
  const ct = contentType ?? "";
  const textual = ct === "" || /json|text|xml|javascript|html|x-www-form-urlencoded|event-stream/i.test(ct);
  if (!textual) return `[${ct} · ${body.length} bytes]`;
  const s = body.subarray(0, MAX_HTTP_BODY).toString("utf8");
  return body.length > MAX_HTTP_BODY ? s + `\n… [${body.length - MAX_HTTP_BODY} more bytes]` : s;
}

function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  return e.cause?.code ? `${e.cause.code}${e.cause.message ? ` (${e.cause.message})` : ""}` : e.message ?? String(err);
}
