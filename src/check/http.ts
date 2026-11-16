/**
 * check/http.ts — is an HTTP endpoint reachable?
 *
 * Safety rules, enforced here:
 *  - Only HEAD and GET. HEAD = "send me the headers you'd send for a GET, but
 *    no body", the cheapest way to ask "are you there?". Some servers don't
 *    implement HEAD (405/501), so we fall back to GET and discard the body.
 *    POST/PUT/DELETE can change state; we never send them from a check.
 *  - No credentials: configured headers (Authorization: Bearer ...) are NOT
 *    sent. A 401/403 therefore means "reachable, wants auth" — good news.
 *  - Redirects are not followed (`redirect: "manual"`), so a check can never
 *    wander off to a different host.
 */
import type { Issue, Status } from "../graph.ts";

export interface HttpCheck {
  url: string;
  status: Status;
  method?: "HEAD" | "GET";
  httpStatus?: number;
  durationMs: number;
  summary: string;
  issues: Issue[];
}

export async function checkHttpEndpoint(url: string, opts: { timeoutMs?: number; purpose?: "mcp" | "api" } = {}): Promise<HttpCheck> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const base = { url, durationMs: 0 };

  try {
    let res = await request(url, "HEAD", timeoutMs);
    let method: "HEAD" | "GET" = "HEAD";
    if (res.status === 405 || res.status === 501) {
      res = await request(url, "GET", timeoutMs);
      method = "GET";
    }
    const durationMs = Date.now() - started;
    return { ...base, method, httpStatus: res.status, durationMs, ...classify(res.status, opts.purpose ?? "api", res.headers.get("location")) };
  } catch (err) {
    const durationMs = Date.now() - started;
    const reason = networkErrorReason(err);
    return {
      ...base,
      durationMs,
      status: "error",
      summary: reason.short,
      issues: [{ severity: "error", code: "http_unreachable", message: `${url}: ${reason.short}`, hint: reason.hint }],
    };
  }
}

async function request(url: string, method: "HEAD" | "GET", timeoutMs: number): Promise<Response> {
  const res = await fetch(url, {
    method,
    redirect: "manual",
    // AbortSignal.timeout: a signal that fires after N ms, cancelling the request.
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "agentmap-healthcheck", accept: "*/*" },
  });
  // We only need the status. Cancel the body so we don't download it.
  await res.body?.cancel();
  return res;
}

function classify(code: number, purpose: "mcp" | "api", location: string | null): Pick<HttpCheck, "status" | "summary" | "issues"> {
  if (code >= 200 && code < 300) return { status: "ok", summary: `HTTP ${code}`, issues: [] };
  if (code >= 300 && code < 400) return { status: "ok", summary: `HTTP ${code} → ${location ?? "?"}`, issues: [] };
  if (code === 401 || code === 403) {
    return { status: "ok", summary: `HTTP ${code} (reachable, requires auth)`, issues: [] };
  }
  // An MCP endpoint only speaks POST (JSON-RPC), so 400/404/405/406 on a GET
  // still proves something is listening there.
  if (purpose === "mcp" && code >= 400 && code < 500) {
    return { status: "ok", summary: `HTTP ${code} on GET (reachable; MCP expects POST)`, issues: [] };
  }
  if (code === 404) {
    return { status: "warn", summary: "HTTP 404", issues: [{ severity: "warn", code: "http_not_found", message: "Server is up, but this path returns 404", hint: "Check the URL path." }] };
  }
  if (code >= 500) {
    return { status: "error", summary: `HTTP ${code}`, issues: [{ severity: "error", code: "http_server_error", message: `Server error: HTTP ${code}` }] };
  }
  return { status: "warn", summary: `HTTP ${code}`, issues: [{ severity: "warn", code: "http_unexpected", message: `Unexpected HTTP ${code}` }] };
}

/**
 * fetch() failures are notoriously vague: you get `TypeError: fetch failed`
 * and the real reason hides in `err.cause.code`. Dig it out and translate.
 */
export function networkErrorReason(err: unknown): { short: string; hint?: string } {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e.name === "TimeoutError" || e.name === "AbortError") return { short: "timed out", hint: "Server is slow or a firewall is dropping packets." };
  const code = e.cause?.code;
  switch (code) {
    case "ECONNREFUSED":
      return { short: "connection refused", hint: "Nothing is listening on that port. Is the server running?" };
    case "ENOTFOUND":
      return { short: "DNS lookup failed", hint: "The hostname doesn't resolve. Typo, or VPN required?" };
    case "ECONNRESET":
      return { short: "connection reset", hint: "The server closed the connection abruptly." };
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return { short: `TLS error (${code})`, hint: "The server's HTTPS certificate isn't trusted." };
  }
  return { short: code ? `${code}: ${e.cause?.message ?? ""}`.trim() : e.cause?.message ?? e.message ?? String(err) };
}
