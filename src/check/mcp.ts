/**
 * check/mcp.ts — connect to one MCP server, list its tools, call the safe ones.
 *
 * Sequence (each step can fail in its own characteristic way):
 *
 *   1. START       stdio: spawn the process       → ENOENT (command not found), EACCES
 *                  http:  open a connection        → refused / DNS / 401
 *   2. INITIALIZE  JSON-RPC handshake              → crash during startup (connection closed),
 *                                                    hang (timeout), garbage on stdout
 *   3. tools/list  what can this server do?        → 0 tools, error
 *   4. tools/call  ONLY tools annotated readOnlyHint: true (unless --allow-writes)
 *                                                  → threw, isError, empty, huge
 *
 * TWO KINDS OF TOOL FAILURE (MCP distinguishes them, and so do we):
 *  - Protocol error: the JSON-RPC response has an `error` member. Something
 *    went wrong *around* the tool: unknown tool, invalid params, server bug.
 *  - Tool error: a normal `result` with `isError: true`. The tool ran and
 *    reports failure ("API rate limited"). The MODEL sees this one — it's
 *    designed to be fed back so the model can react.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Issue, Status } from "../graph.ts";
import { estimateTokens, formatTokens } from "../util/tokens.ts";
import { networkErrorReason } from "./http.ts";
import { sampleFromSchema, type JsonSchema } from "./schemaSample.ts";

/** Responses above this many (estimated) tokens get flagged. */
export const DEFAULT_TOKEN_LIMIT = 20_000;
/** Keep at most this much tool output in reports (the token count is still exact-ish). */
const OUTPUT_PREVIEW_CHARS = 4_000;

/** A server config with every ${VAR} already substituted. */
export interface ResolvedServer {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url?: string;
}

export interface McpCheckOptions {
  allowWrites: boolean;
  timeoutMs: number;
  tokenLimit: number;
  clientVersion: string;
}

export type ToolSafety = "read_only" | "destructive" | "write" | "unannotated";

export interface ToolCheck {
  name: string;
  title?: string;
  description?: string;
  safety: ToolSafety;
  annotations: Record<string, unknown>;
  inputSchema: unknown;
  action: "called" | "skipped";
  status: Status;
  summary: string;
  input?: unknown;
  output?: { preview: string; chars: number; tokens: number; isError: boolean; contentTypes: string[] };
  error?: { code?: number; message: string };
  durationMs?: number;
  issues: Issue[];
}

export interface McpCheck {
  status: Status;
  connected: boolean;
  summary: string;
  serverInfo?: { name: string; version: string };
  durationMs: number;
  tools: ToolCheck[];
  /** Last few KB of the server's stderr — usually where the real reason is. */
  stderr: string;
  issues: Issue[];
}

export async function checkMcpServer(server: ResolvedServer, opts: McpCheckOptions): Promise<McpCheck> {
  const started = Date.now();
  const stderr = new TailBuffer(4096);
  const protocolErrors: string[] = [];

  const transport = createTransport(server, stderr);
  const client = new Client({ name: "agentmap", version: opts.clientVersion }, { capabilities: {} });
  // Errors that don't belong to a specific request (e.g. a non-JSON line on
  // stdout) arrive here instead of rejecting a promise.
  client.onerror = (err) => protocolErrors.push(err.message);

  // --- 1 + 2: start and initialize -----------------------------------------
  try {
    await client.connect(transport, { timeout: opts.timeoutMs });
  } catch (err) {
    await client.close().catch(() => {});
    // Give the dying process a moment to flush its last stderr lines.
    await new Promise((r) => setTimeout(r, 50));
    const issue = diagnoseConnectError(err, server, stderr.text(), protocolErrors, opts.timeoutMs);
    return {
      status: issue.severity === "warn" ? "warn" : "error",
      connected: false,
      summary: issue.message,
      durationMs: Date.now() - started,
      tools: [],
      stderr: stderr.text(),
      issues: [issue],
    };
  }

  const result: McpCheck = {
    status: "ok",
    connected: true,
    summary: "",
    durationMs: 0,
    tools: [],
    stderr: "",
    issues: [],
  };
  const info = client.getServerVersion();
  if (info) result.serverInfo = { name: info.name, version: info.version };

  try {
    // --- 3: list tools (following pagination cursors) ----------------------
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: opts.timeoutMs });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    // --- 4: call the safe ones, one at a time -------------------------------
    for (const tool of tools) result.tools.push(await checkTool(client, tool, opts));
  } catch (err) {
    result.issues.push({ severity: "error", code: "list_tools_failed", message: `tools/list failed: ${(err as Error).message}` });
  } finally {
    await client.close().catch(() => {});
  }

  if (result.tools.length === 0 && result.issues.length === 0) {
    result.issues.push({ severity: "warn", code: "no_tools", message: "Server connected but exposes no tools" });
  }
  for (const msg of protocolErrors) {
    result.issues.push({ severity: "warn", code: "protocol_error", message: `Protocol error: ${msg}` });
  }

  result.durationMs = Date.now() - started;
  result.stderr = stderr.text();
  const called = result.tools.filter((t) => t.action === "called").length;
  const skipped = result.tools.length - called;
  result.summary = `${result.tools.length} tools (${called} called${skipped ? `, ${skipped} skipped` : ""}) · ${result.durationMs}ms`;
  // The server's own status reflects connection-level health; per-tool
  // problems live on the tool nodes (and roll up in the views).
  result.status = result.issues.some((i) => i.severity === "error") ? "error" : result.issues.length ? "warn" : "ok";
  return result;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

function createTransport(server: ResolvedServer, stderr: TailBuffer): Transport {
  if (server.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: server.command ?? "",
      args: server.args,
      // The SDK merges this over a small safe default (HOME, PATH, SHELL, ...).
      // It does NOT pass your whole environment — just like real MCP clients.
      env: server.env,
      cwd: server.cwd,
      // "pipe" = capture stderr instead of letting it spill into our terminal.
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    return transport;
  }
  // Remote servers. Note: configured `headers` are NOT passed. agentmap never
  // sends credentials, so auth-protected servers will report "requires auth".
  const url = new URL(server.url ?? "");
  return server.transport === "sse" ? new SSEClientTransport(url) : new StreamableHTTPClientTransport(url);
}

// ---------------------------------------------------------------------------
// Diagnosing connection failures
// ---------------------------------------------------------------------------

function diagnoseConnectError(err: unknown, server: ResolvedServer, stderr: string, protocolErrors: string[], timeoutMs: number): Issue {
  const e = err as NodeJS.ErrnoException & { code?: unknown };
  const lastStderr = lastLines(stderr, 3);

  // Spawn errors come straight from Node's child_process.
  if (e.code === "ENOENT") {
    return {
      severity: "error",
      code: "spawn_enoent",
      message: `Command not found: ${server.command}`,
      hint:
        "Install it or use an absolute path. Note: GUI apps (Claude Desktop, Cursor) often don't get your " +
        "shell's PATH, so tools installed via nvm/pyenv/Homebrew can be missing there even if they work in your terminal.",
    };
  }
  if (e.code === "EACCES") {
    return { severity: "error", code: "spawn_eacces", message: `Permission denied running ${server.command}`, hint: "chmod +x it, or run it via its interpreter." };
  }

  if (err instanceof McpError) {
    if (err.code === ErrorCode.ConnectionClosed) {
      // The process started, then exited before answering `initialize`.
      const garbage = protocolErrors.find((m) => /JSON|Unexpected token/i.test(m));
      if (garbage) {
        return {
          severity: "error",
          code: "stdout_not_jsonrpc",
          message: "Server wrote non-JSON to stdout",
          hint: "On stdio, stdout must carry ONLY JSON-RPC messages. Move logging to stderr.",
        };
      }
      return {
        severity: "error",
        code: "exited_during_startup",
        message: lastStderr ? `Exited during startup: ${lastStderr}` : "Exited during startup (no stderr output)",
        hint: "Run the command yourself to see the full error.",
      };
    }
    if (err.code === ErrorCode.RequestTimeout) {
      return {
        severity: "error",
        code: "initialize_timeout",
        message: `No response to initialize within ${timeoutMs / 1000}s`,
        hint: "Is it really an MCP server? It may be waiting for input, downloading (npx), or speaking a different transport.",
      };
    }
  }

  // Remote transports: HTTP status codes and network errors.
  const message = (err as Error).message ?? String(err);
  const httpCode = /HTTP (\d{3})/.exec(message)?.[1] ?? (typeof e.code === "number" ? String(e.code) : undefined);
  if (httpCode === "401" || httpCode === "403") {
    return {
      severity: "warn",
      code: "requires_auth",
      message: `Reachable, but requires auth (HTTP ${httpCode})`,
      hint: "agentmap never sends credentials, so it can't list this server's tools.",
    };
  }
  if (server.transport !== "stdio") {
    // fetch() errors carry the real reason in err.cause (see check/http.ts).
    const reason = networkErrorReason(err);
    return { severity: "error", code: "remote_unreachable", message: `Can't reach ${server.url}: ${reason.short}`, ...(reason.hint ? { hint: reason.hint } : {}) };
  }
  return { severity: "error", code: "connect_failed", message: lastStderr ? `${message} — stderr: ${lastStderr}` : message };
}

// ---------------------------------------------------------------------------
// Checking one tool
// ---------------------------------------------------------------------------

/**
 * Classify a tool by its annotations. Per the MCP spec the DEFAULTS are
 * pessimistic: readOnlyHint defaults to false and destructiveHint to true.
 * So a tool with no annotations at all must be assumed destructive.
 */
export function toolSafety(annotations: Record<string, unknown> | undefined): ToolSafety {
  if (!annotations || Object.keys(annotations).length === 0) return "unannotated";
  if (annotations.readOnlyHint === true) return "read_only";
  return annotations.destructiveHint === false ? "write" : "destructive";
}

async function checkTool(client: Client, tool: Tool, opts: McpCheckOptions): Promise<ToolCheck> {
  const annotations = (tool.annotations ?? {}) as Record<string, unknown>;
  const safety = toolSafety(annotations);
  const check: ToolCheck = {
    name: tool.name,
    safety,
    annotations,
    inputSchema: tool.inputSchema,
    action: "skipped",
    status: "unknown",
    summary: "",
    issues: [],
  };
  if (tool.title ?? annotations.title) check.title = String(tool.title ?? annotations.title);
  if (tool.description) check.description = tool.description;

  // --- The safety gate -------------------------------------------------------
  if (safety !== "read_only" && !opts.allowWrites) {
    check.summary =
      safety === "unannotated"
        ? "skipped: no readOnlyHint, so assumed unsafe (--allow-writes to call)"
        : `skipped: ${safety === "destructive" ? "destructive" : "may write"} (--allow-writes to call)`;
    return check;
  }

  check.action = "called";
  check.input = sampleFromSchema(tool.inputSchema as JsonSchema);
  const started = Date.now();
  try {
    const res = await client.callTool({ name: tool.name, arguments: check.input as Record<string, unknown> }, undefined, {
      timeout: opts.timeoutMs,
    });
    check.durationMs = Date.now() - started;
    analyzeToolResult(check, res, opts.tokenLimit);
  } catch (err) {
    check.durationMs = Date.now() - started;
    const code = err instanceof McpError ? err.code : undefined;
    const message = err instanceof McpError ? err.message.replace(/^MCP error -?\d+: /, "") : (err as Error).message;
    check.error = code === undefined ? { message } : { code, message };
    if (code === ErrorCode.InvalidParams) {
      check.issues.push({
        severity: "warn",
        code: "sample_input_rejected",
        message: `Rejected our generated input: ${message}`,
        hint: "agentmap guesses inputs from the schema; the tool may be fine. Check the schema is accurate.",
      });
    } else if (code === ErrorCode.RequestTimeout) {
      check.issues.push({ severity: "error", code: "tool_timeout", message: `No response within ${opts.timeoutMs / 1000}s` });
    } else {
      check.issues.push({
        severity: "error",
        code: "tool_threw",
        message: `Threw: ${message}${code !== undefined ? ` (JSON-RPC ${code})` : ""}`,
        hint: "An exception escaped the tool handler. Agents typically see this as a hard failure.",
      });
    }
  }
  check.status = check.issues.some((i) => i.severity === "error") ? "error" : check.issues.length ? "warn" : "ok";
  if (!check.summary) {
    check.summary = check.issues[0]?.message ?? `ok · ~${formatTokens(check.output?.tokens ?? 0)} tokens · ${check.durationMs}ms`;
  }
  return check;
}

type ContentBlock = { type: string; text?: string; mimeType?: string; data?: string; uri?: string };

function analyzeToolResult(check: ToolCheck, res: Record<string, unknown>, tokenLimit: number): void {
  // Older servers may answer in a legacy { toolResult } shape; normalize it.
  const content: ContentBlock[] = Array.isArray(res.content) ? (res.content as ContentBlock[]) : [{ type: "text", text: JSON.stringify(res.toolResult ?? "") }];
  const isError = res.isError === true;

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text ?? "");
    else if (block.type === "image" || block.type === "audio") parts.push(`[${block.type} ${block.mimeType ?? ""} · ${Math.round(((block.data?.length ?? 0) * 3) / 4 / 1024)}KB]`);
    else parts.push(`[${block.type}${block.uri ? ` ${block.uri}` : ""}]`);
  }
  if (res.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent));
  const text = parts.join("\n");
  const tokens = estimateTokens(text);

  check.output = {
    preview: text.length > OUTPUT_PREVIEW_CHARS ? text.slice(0, OUTPUT_PREVIEW_CHARS) + `\n… [${formatTokens(text.length - OUTPUT_PREVIEW_CHARS)} more chars]` : text,
    chars: text.length,
    tokens,
    isError,
    contentTypes: [...new Set(content.map((c) => c.type))],
  };

  if (isError) {
    check.issues.push({ severity: "error", code: "tool_is_error", message: `Returned an error: ${oneLine(text, 160)}` });
  } else if (isEmptyText(text)) {
    check.issues.push({
      severity: "warn",
      code: "empty_result",
      message: "Returned an empty result",
      hint: "Models often answer anyway when a tool returns nothing — a top cause of confident wrong answers.",
    });
  }
  if (tokens > tokenLimit) {
    check.issues.push({
      severity: "warn",
      code: "huge_result",
      message: `Response is ~${formatTokens(tokens)} tokens (limit ${formatTokens(tokenLimit)})`,
      hint: "That eats a big slice of the context window, and many agent frameworks truncate it silently. Paginate, filter, or summarize server-side.",
    });
  }
}

export function isEmptyText(text: string): boolean {
  const t = text.trim();
  return t === "" || t === "[]" || t === "{}" || t === "null" || t === '""';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Keeps only the last N characters written to it (bounded memory). */
class TailBuffer {
  private buf = "";
  private max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(s: string): void {
    this.buf = (this.buf + s).slice(-this.max);
  }
  text(): string {
    return this.buf.trim();
  }
}

function lastLines(text: string, n: number): string {
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join(" | ");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
