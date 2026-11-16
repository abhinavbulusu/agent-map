/**
 * check/index.ts — run every health check for a set of agents.
 *
 * Per server:
 *   env  → resolve every ${VAR} (no execution, instant)
 *   http → for remote servers: is the URL even reachable? (HEAD/GET only)
 *   mcp  → connect, list tools, call the read-only ones
 * then CONNECT THE DOTS: "server exited during startup" + "WEATHER_API_KEY
 * missing" is one problem with one fix, so we say so.
 *
 * Servers are checked in PARALLEL (Promise.all): each is an independent
 * process or connection, and a slow one shouldn't block the rest. Tools
 * within one server are called SEQUENTIALLY, to be gentle on it.
 *
 * The result is a CheckReport: plain data, saved to .agentmap/check.json so
 * the browser view can show the last check without re-running it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GraphBuilder, nodeId, statusFromIssues, worst, type Detail, type Issue, type Status } from "../graph.ts";
import type { AgentConfig, McpServerConfig } from "../scan/mcpConfigs.ts";
import { checkEnvRefs, interpolate, loadDotEnv, type ClientId, type EnvCheck, type EnvContext } from "./env.ts";
import { checkHttpEndpoint, type HttpCheck } from "./http.ts";
import { checkMcpServer, type McpCheck, type ResolvedServer } from "./mcp.ts";

export interface ServerCheckResult {
  agentId: ClientId;
  serverName: string;
  status: Status;
  summary: string;
  env: EnvCheck[];
  http?: HttpCheck;
  mcp?: McpCheck;
  /** Issues found by checking (config-only issues already live on the scan graph). */
  issues: Issue[];
}

export interface CheckReport {
  version: 1;
  checkedAt: string;
  rootDir: string;
  allowWrites: boolean;
  results: ServerCheckResult[];
}

export interface RunChecksOptions {
  allowWrites: boolean;
  timeoutMs: number;
  tokenLimit: number;
  clientVersion: string;
}

export async function runChecks(rootDir: string, agents: AgentConfig[], opts: RunChecksOptions): Promise<CheckReport> {
  const jobs = agents.flatMap((agent) => agent.servers.map((server) => checkServer(agent, server, opts)));
  return {
    version: 1,
    checkedAt: new Date().toISOString(),
    rootDir,
    allowWrites: opts.allowWrites,
    results: await Promise.all(jobs),
  };
}

async function checkServer(agent: AgentConfig, server: McpServerConfig, opts: RunChecksOptions): Promise<ServerCheckResult> {
  const ctx: EnvContext = { processEnv: process.env, dotenv: loadDotEnv(agent.projectDir), workspaceFolder: agent.projectDir };
  const env = checkEnvRefs(server.envRefs, ctx, agent.id);
  const result: ServerCheckResult = { agentId: agent.id, serverName: server.name, status: "unknown", summary: "", env, issues: [] };

  if (server.disabled) {
    result.summary = "disabled in config — not checked";
    return result;
  }
  // If the config itself is broken (no command, no url), don't try to run it.
  if (server.issues.some((i) => i.severity === "error")) {
    result.status = "error";
    result.summary = server.issues.find((i) => i.severity === "error")!.message;
    return result;
  }

  // --- Substitute ${VAR}s exactly like the client would ---------------------
  const sub = (s: string) => interpolate(s, ctx, agent.id).value;
  const resolvedEnv: Record<string, string> = {};
  for (const [key, raw] of Object.entries(server.env)) {
    const { value, unresolved } = interpolate(raw, ctx, agent.id);
    // A missing variable is left OUT of the child's environment rather than
    // set to "": that's what the server would see when the client can't resolve it.
    if (unresolved.length === 0) resolvedEnv[key] = value;
  }
  const resolved: ResolvedServer = {
    name: server.name,
    transport: server.transport,
    args: server.args.map(sub),
    env: resolvedEnv,
    cwd: server.cwd,
  };
  if (server.command) resolved.command = sub(server.command);
  if (server.url) resolved.url = sub(server.url);

  // --- Remote: reachability first ------------------------------------------
  if (resolved.transport !== "stdio" && resolved.url) {
    result.http = await checkHttpEndpoint(resolved.url, { timeoutMs: opts.timeoutMs, purpose: "mcp" });
    if (result.http.status === "error") {
      // No point attempting an MCP handshake with a server we can't reach.
      // The http_endpoint node owns the issue; the server just reflects it.
      result.summary = `unreachable (${result.http.summary}) — see endpoint`;
      return finalize(result);
    }
  }

  result.mcp = await checkMcpServer(resolved, opts);
  result.issues.push(...result.mcp.issues);
  result.summary = result.mcp.summary;

  // --- Root-cause linking -----------------------------------------------------
  const missing = env.filter((e) => e.source === "missing" || e.source === "literal").map((e) => e.name);
  if (!result.mcp.connected && missing.length > 0) {
    const first = result.issues[0];
    if (first) first.hint = `Likely cause: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set (see env vars). ${first.hint ?? ""}`.trim();
  }
  return finalize(result);
}

/** A server is as unhealthy as the worst of: its own issues, its endpoint, its env vars. */
function finalize(result: ServerCheckResult): ServerCheckResult {
  let status = statusFromIssues(result.issues, "ok");
  if (result.http) status = worst(status, result.http.status);
  for (const e of result.env) status = worst(status, e.status === "unknown" ? "ok" : e.status);
  result.status = status;
  return result;
}

// ---------------------------------------------------------------------------
// Report → graph
// ---------------------------------------------------------------------------

const ENV_SOURCE_TEXT: Record<EnvCheck["source"], string> = {
  process: "set in environment",
  dotenv: "only in .env",
  default: "unset; using ${VAR:-default}",
  missing: "missing",
  prompt: "prompted by VS Code at startup",
  literal: "not expanded by this client",
};

export function addCheckReportToGraph(builder: GraphBuilder, report: CheckReport): void {
  for (const r of report.results) {
    const agentId = nodeId("agent", r.agentId);
    const serverId = nodeId("mcp_server", r.agentId, r.serverName);
    const details: Detail[] = [];
    if (r.mcp?.serverInfo) details.push({ title: "initialize → serverInfo", at: report.checkedAt, response: r.mcp.serverInfo, durationMs: r.mcp.durationMs });
    if (r.mcp?.stderr) details.push({ title: "server stderr (tail)", note: r.mcp.stderr });

    builder.node({ id: serverId, kind: "mcp_server", label: r.serverName, status: r.status, summary: r.summary, issues: r.issues, details });
    builder.edge({ from: agentId, to: serverId, kind: "connects", status: r.mcp?.connected ? "ok" : r.status });

    for (const e of r.env) {
      const envId = e.syntax === "input" ? nodeId("env_var", `input:${e.name}`) : nodeId("env_var", e.name);
      builder.node({ id: envId, kind: "env_var", label: e.syntax === "input" ? `input:${e.name}` : e.name, status: e.status, summary: ENV_SOURCE_TEXT[e.source], issues: e.issues });
      builder.edge({ from: serverId, to: envId, kind: "requires", status: e.status });
    }

    if (r.http) {
      const endpointId = nodeId("http_endpoint", r.http.url.split("?")[0]!);
      builder.node({
        id: endpointId,
        kind: "http_endpoint",
        label: r.http.url.split("?")[0]!,
        status: r.http.status,
        summary: `${r.http.method ?? "HEAD"} → ${r.http.summary} · ${r.http.durationMs}ms`,
        issues: r.http.issues,
        details: [{ title: `${r.http.method ?? "HEAD"} ${r.http.url}`, at: report.checkedAt, response: { status: r.http.httpStatus, summary: r.http.summary }, durationMs: r.http.durationMs }],
      });
      builder.edge({ from: serverId, to: endpointId, kind: "connects", status: r.http.status });
    }

    for (const t of r.mcp?.tools ?? []) {
      const toolId = nodeId("tool", r.agentId, r.serverName, t.name);
      const toolDetails: Detail[] = [];
      if (t.action === "called") {
        toolDetails.push({
          title: `tools/call ${t.name}`,
          at: report.checkedAt,
          request: { name: t.name, arguments: t.input },
          response: t.output ?? { error: t.error },
          ...(t.durationMs !== undefined ? { durationMs: t.durationMs } : {}),
        });
      }
      builder.node({
        id: toolId,
        kind: "tool",
        label: t.name,
        status: t.status,
        summary: t.summary,
        issues: t.issues,
        meta: { safety: t.safety, annotations: t.annotations, description: t.description, inputSchema: t.inputSchema, server: r.serverName },
        details: toolDetails,
      });
      builder.edge({ from: serverId, to: toolId, kind: "exposes", status: t.status });
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence (.agentmap/check.json)
// ---------------------------------------------------------------------------

export function agentmapDir(rootDir: string): string {
  return join(rootDir, ".agentmap");
}

export async function saveCheckReport(rootDir: string, report: CheckReport): Promise<string> {
  const dir = agentmapDir(rootDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "check.json");
  await writeFile(path, JSON.stringify(report, null, 2));
  return path;
}

export async function loadCheckReport(rootDir: string): Promise<CheckReport | undefined> {
  try {
    const report = JSON.parse(await readFile(join(agentmapDir(rootDir), "check.json"), "utf8")) as CheckReport;
    return report.version === 1 ? report : undefined;
  } catch {
    return undefined;
  }
}
