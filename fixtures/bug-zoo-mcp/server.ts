/**
 * bug-zoo — a fake MCP server with one tool per failure mode.
 *
 * Written WITHOUT the MCP SDK on purpose, so you can see the whole protocol:
 *
 *  - TRANSPORT (stdio): the client spawns this process. Each message is one
 *    line of JSON on stdin (client → server) or stdout (server → client),
 *    terminated by "\n". That's it. Consequence: stdout is SACRED — a stray
 *    console.log() would inject non-JSON into the protocol stream and break
 *    the client. All logging goes to stderr.
 *
 *  - MESSAGES (JSON-RPC 2.0): three shapes.
 *      request:      {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
 *      response:     {"jsonrpc":"2.0","id":1,"result":{...}}   (or "error":{code,message})
 *      notification: {"jsonrpc":"2.0","method":"notifications/initialized"}  (no id → no reply)
 *    The id is how the client matches a response to its request.
 *
 *  - LIFECYCLE: initialize (negotiate protocol version + capabilities)
 *    → notifications/initialized → normal traffic (tools/list, tools/call ...).
 *
 * The four tools:
 *   get_status      readOnly, works                    → should be ✔
 *   flaky_lookup    readOnly, throws                   → should be ✖ (JSON-RPC error)
 *   dump_logs       readOnly, ~30k-token response      → should be ⚠ (too big for context)
 *   delete_records  destructive                        → must be SKIPPED without --allow-writes
 *
 * Flags:
 *   --require-env NAME   exit at startup if NAME isn't set (like real servers that need an API key)
 *   --name NAME          server name to report in serverInfo
 */
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Startup checks (this is where "missing env var" crashes happen in real life)
// ---------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const requiredEnv = flag("--require-env");
if (requiredEnv && !process.env[requiredEnv]) {
  // Real servers do exactly this: log to stderr, exit non-zero.
  console.error(`bug-zoo: fatal: environment variable ${requiredEnv} is not set`);
  process.exit(1);
}
const serverName = flag("--name") ?? "bug-zoo";

// ---------------------------------------------------------------------------
// Tool definitions — what tools/list returns
// ---------------------------------------------------------------------------

/**
 * inputSchema is JSON SCHEMA: a JSON document describing what valid input
 * looks like (types, required fields, enums, ranges). The model reads it to
 * know how to call the tool; agentmap reads it to generate a test input.
 *
 * annotations are HINTS about behavior. readOnlyHint: true = "calling me
 * changes nothing". They are self-reported by the server, i.e. a promise, not
 * a guarantee — which is why agentmap treats a MISSING hint as "unsafe".
 */
const TOOLS = [
  {
    name: "get_status",
    title: "Service status",
    description: "Return the health status of one internal service.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", enum: ["api", "db", "queue"], description: "Which service" },
        verbose: { type: "boolean", default: false },
      },
      required: ["service"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "flaky_lookup",
    title: "Customer lookup",
    description: "Look up a customer record by id.",
    inputSchema: {
      type: "object",
      properties: { customer_id: { type: "string", minLength: 3, description: "Customer id, e.g. cus_123" } },
      required: ["customer_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "dump_logs",
    title: "Dump logs",
    description: "Return recent application log lines.",
    inputSchema: {
      type: "object",
      properties: { lines: { type: "integer", minimum: 1, maximum: 10000, default: 2000 } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "delete_records",
    title: "Delete records",
    description: "Permanently delete rows from a table.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string" }, where: { type: "string" } },
      required: ["table", "where"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function callTool(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case "get_status":
      return text(JSON.stringify({ service: args.service ?? "api", status: "healthy", uptime_s: 86400 }));

    case "flaky_lookup":
      // Simulates a bug in the server: an unhandled exception. The dispatcher
      // below turns it into a JSON-RPC error response.
      throw new Error("ECONNRESET: upstream customer-db closed the connection");

    case "dump_logs": {
      const n = typeof args.lines === "number" ? args.lines : 2000;
      const lines: string[] = [];
      for (let i = 0; i < n; i++) {
        lines.push(`2026-11-15T10:${String(i % 60).padStart(2, "0")}:00Z INFO request id=${i} path=/api/v1/items status=200 duration_ms=${(i * 7) % 300}`);
      }
      return text(lines.join("\n"));
    }

    case "delete_records":
      // A fake destructive action. If agentmap ever calls this without
      // --allow-writes, that's a bug in agentmap — the log line makes it visible.
      console.error(`bug-zoo: !!! delete_records CALLED: table=${args.table} where=${args.where}`);
      return text(`Deleted 42 rows from ${args.table}`);

    default:
      // Unknown tool: per the MCP spec this is a protocol-level error.
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type RpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> };

function handle(req: RpcRequest): unknown {
  switch (req.method) {
    case "initialize": {
      // Version negotiation: echo the client's version if we can speak it.
      const requested = req.params?.protocolVersion;
      return {
        protocolVersion: typeof requested === "string" ? requested : "2025-06-18",
        capabilities: { tools: {} }, // "I have tools" (and nothing else)
        serverInfo: { name: serverName, version: "1.0.0" },
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = String(req.params?.name);
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      return callTool(name, args);
    }
    default:
      throw new RpcError(-32601, `Method not found: ${req.method}`);
  }
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

// readline splits the incoming byte stream into lines for us.
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: RpcRequest;
  try {
    req = JSON.parse(line) as RpcRequest;
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  // Notifications have no id and get no response.
  if (req.id === undefined) return;
  try {
    send({ jsonrpc: "2.0", id: req.id, result: handle(req) });
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603; // -32603 = "Internal error"
    send({ jsonrpc: "2.0", id: req.id, error: { code, message: (err as Error).message } });
  }
});
// When the client closes our stdin, it's time to go.
rl.on("close", () => process.exit(0));
