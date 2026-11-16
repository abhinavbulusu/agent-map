/**
 * scan/mcpConfigs.ts — find MCP config files and turn them into graph nodes.
 *
 * WHAT IS MCP?
 * The Model Context Protocol is a standard way for an AI app (the "client" or
 * "host": Claude Code, Cursor, VS Code, ...) to plug in external capabilities
 * ("servers": GitHub, a database, your filesystem). A server advertises TOOLS
 * (functions the model may call), plus resources and prompts. The client
 * decides which servers to start by reading a CONFIG FILE — which is what we
 * parse here. One config file = one agent setup = one "agent" node.
 *
 * Scanning is deliberately PASSIVE: we read files and nothing else. No process
 * is spawned and no network request is made until you run `agentmap check`.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { GraphBuilder, nodeId, type Graph, type Issue } from "../graph.ts";
import { parseJsonc } from "../util/jsonc.ts";
import { checkLiteralEnv, clientName, findEnvRefs, type ClientId, type EnvRef } from "../check/env.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Transport = "stdio" | "http" | "sse";

/** One server entry, normalized across the four config dialects. */
export interface McpServerConfig {
  name: string;
  /**
   * HOW the client talks to the server:
   *  - stdio: the client SPAWNS the server as a child process and exchanges
   *           JSON-RPC messages over its stdin/stdout pipes. Local only.
   *  - http:  "Streamable HTTP": JSON-RPC over HTTP POST to a URL (remote).
   *  - sse:   the older remote transport (HTTP + Server-Sent Events).
   */
  transport: Transport;
  command?: string;
  args: string[];
  /** env block AS WRITTEN (references like ${VAR} not yet resolved). */
  env: Record<string, string>;
  /** Directory the server would be spawned in. */
  cwd: string;
  url?: string;
  headers: Record<string, string>;
  /** Every ${...} reference anywhere in this entry. */
  envRefs: EnvRef[];
  disabled: boolean;
  /** Problems visible from the config alone (no execution needed). */
  issues: Issue[];
}

/** One config file = one agent setup. */
export interface AgentConfig {
  /** Which client this config belongs to: also the name you pass to `check`. */
  id: ClientId;
  name: string;
  configPath: string;
  scope: "project" | "user";
  projectDir: string;
  servers: McpServerConfig[];
  /** File-level problems (unreadable, invalid JSON, wrong shape). */
  issues: Issue[];
}

interface ConfigLocation {
  client: ClientId;
  path: string;
  scope: "project" | "user";
}

// ---------------------------------------------------------------------------
// Where configs live
// ---------------------------------------------------------------------------

export function configLocations(rootDir: string, includeGlobal: boolean): ConfigLocation[] {
  const locations: ConfigLocation[] = [
    { client: "claude-code", path: join(rootDir, ".mcp.json"), scope: "project" },
    { client: "cursor", path: join(rootDir, ".cursor", "mcp.json"), scope: "project" },
    { client: "vscode", path: join(rootDir, ".vscode", "mcp.json"), scope: "project" },
    // Not usually in a project, but people keep copies there; cheap to check.
    { client: "claude-desktop", path: join(rootDir, "claude_desktop_config.json"), scope: "project" },
  ];
  if (includeGlobal) {
    locations.push({ client: "claude-desktop", path: claudeDesktopConfigPath(), scope: "user" });
    locations.push({ client: "cursor-global", path: join(homedir(), ".cursor", "mcp.json"), scope: "user" });
  }
  return locations;
}

/** Claude Desktop's config lives in the OS's per-user app-data folder. */
function claudeDesktopConfigPath(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

// ---------------------------------------------------------------------------
// Scanning + parsing
// ---------------------------------------------------------------------------

export async function scanMcpConfigs(rootDir: string, opts: { global?: boolean } = {}): Promise<AgentConfig[]> {
  const root = resolve(rootDir);
  const agents: AgentConfig[] = [];
  for (const loc of configLocations(root, opts.global ?? false)) {
    let text: string;
    try {
      text = await readFile(loc.path, "utf8");
    } catch (err) {
      // ENOENT = "file doesn't exist", the normal case. Anything else
      // (e.g. EACCES permission denied) is worth reporting.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      agents.push(emptyAgent(loc, root, [
        { severity: "error", code: "config_unreadable", message: `Can't read ${loc.path}: ${(err as Error).message}` },
      ]));
      continue;
    }
    // Project configs run with the project as their working directory; user
    // configs (Claude Desktop) have no project, so relative paths are fragile.
    const projectDir = loc.scope === "project" ? root : homedir();
    agents.push(parseMcpConfigText(text, loc, projectDir));
  }
  return agents;
}

function emptyAgent(loc: ConfigLocation, projectDir: string, issues: Issue[]): AgentConfig {
  return {
    id: loc.client,
    name: clientName(loc.client),
    configPath: loc.path,
    scope: loc.scope,
    projectDir,
    servers: [],
    issues,
  };
}

/** Parse one config file's text. Exported separately so tests can feed strings. */
export function parseMcpConfigText(text: string, loc: ConfigLocation, projectDir: string): AgentConfig {
  const agent = emptyAgent(loc, projectDir, []);

  let json: unknown;
  try {
    // Only VS Code officially allows comments, but being lenient costs nothing.
    json = parseJsonc(text);
  } catch (err) {
    agent.issues.push({
      severity: "error",
      code: "config_invalid_json",
      message: `${basename(loc.path)} is not valid JSON: ${(err as Error).message}`,
      hint: "The client will ignore this whole file. Look for a missing comma or quote.",
    });
    return agent;
  }

  if (!isRecord(json)) {
    agent.issues.push({ severity: "error", code: "config_shape", message: "Config root must be a JSON object" });
    return agent;
  }

  // VS Code uses "servers"; everyone else uses "mcpServers". Accept both, but
  // flag the wrong one, because the real client would silently find nothing.
  const expectedKey = loc.client === "vscode" ? "servers" : "mcpServers";
  const otherKey = expectedKey === "servers" ? "mcpServers" : "servers";
  let serversObj = json[expectedKey];
  if (serversObj === undefined && isRecord(json[otherKey])) {
    serversObj = json[otherKey];
    agent.issues.push({
      severity: "error",
      code: "config_wrong_key",
      message: `${clientName(loc.client)} reads "${expectedKey}", but this file uses "${otherKey}"`,
      hint: `Rename the key to "${expectedKey}" or the client will see zero servers.`,
    });
  }
  if (serversObj === undefined) return agent; // valid file, no servers
  if (!isRecord(serversObj)) {
    agent.issues.push({ severity: "error", code: "config_shape", message: `"${expectedKey}" must be an object` });
    return agent;
  }

  for (const [name, entry] of Object.entries(serversObj)) {
    agent.servers.push(parseServerEntry(name, entry, loc, projectDir));
  }
  return agent;
}

function parseServerEntry(name: string, entry: unknown, loc: ConfigLocation, projectDir: string): McpServerConfig {
  const server: McpServerConfig = {
    name,
    transport: "stdio",
    args: [],
    env: {},
    cwd: projectDir,
    headers: {},
    envRefs: [],
    disabled: false,
    issues: [],
  };
  if (!isRecord(entry)) {
    server.issues.push({ severity: "error", code: "server_shape", message: `Server "${name}" must be an object` });
    return server;
  }

  // --- Pull out fields, tolerating wrong types instead of crashing ----------
  const command = typeof entry.command === "string" ? entry.command : undefined;
  const url = typeof entry.url === "string" ? entry.url : undefined;
  if (command) server.command = command;
  if (url) server.url = url;
  if (Array.isArray(entry.args)) server.args = entry.args.map(String);
  if (isRecord(entry.env)) server.env = stringRecord(entry.env);
  if (isRecord(entry.headers)) server.headers = stringRecord(entry.headers);
  if (typeof entry.cwd === "string") server.cwd = resolve(projectDir, entry.cwd);
  server.disabled = entry.disabled === true;

  // --- Which transport? ------------------------------------------------------
  const type = typeof entry.type === "string" ? entry.type : undefined;
  if (type === "sse") server.transport = "sse";
  else if (type === "http" || type === "streamable-http" || type === "streamableHttp") server.transport = "http";
  else if (type === "stdio") server.transport = "stdio";
  else if (type !== undefined) {
    server.issues.push({ severity: "error", code: "unknown_transport", message: `Unknown transport type "${type}"` });
  } else if (url && !command) server.transport = "http";

  if (server.transport === "stdio" && !command) {
    server.issues.push({
      severity: "error",
      code: "missing_command",
      message: url ? `Has a "url" but type is stdio` : `No "command" and no "url": the client can't start it`,
    });
  }
  if (server.transport !== "stdio" && !url) {
    server.issues.push({ severity: "error", code: "missing_url", message: `Transport ${server.transport} needs a "url"` });
  }

  // --- Every ${...} reference, wherever it hides -----------------------------
  const where: [string, string][] = [];
  if (command) where.push(["command", command]);
  server.args.forEach((a, i) => where.push([`args[${i}]`, a]));
  for (const [k, v] of Object.entries(server.env)) where.push([`env.${k}`, v]);
  if (url) where.push(["url", url]);
  for (const [k, v] of Object.entries(server.headers)) where.push([`headers.${k}`, v]);
  for (const [location, value] of where) server.envRefs.push(...findEnvRefs(value, location, loc.client));

  server.issues.push(...checkLiteralEnv(server.env));

  // Relative paths in a user-level config resolve against wherever the app
  // happens to start (often "/"), not your project. Classic Claude Desktop bug.
  if (loc.scope === "user") {
    const relative = [command, ...server.args].filter(
      (p): p is string => !!p && /^\.\.?[/\\]/.test(p) && !isAbsolute(p),
    );
    if (relative.length > 0) {
      server.issues.push({
        severity: "warn",
        code: "relative_path_in_user_config",
        message: `Relative path ${relative[0]} in a user-level config`,
        hint: "Use an absolute path: GUI apps don't start in your project folder.",
      });
    }
  }
  return server;
}

// ---------------------------------------------------------------------------
// Configs → graph
// ---------------------------------------------------------------------------

/** The static map: structure only, statuses stay "unknown" until checked. */
export function addConfigsToGraph(builder: GraphBuilder, agents: AgentConfig[]): void {
  for (const agent of agents) {
    const agentNodeId = nodeId("agent", agent.id);
    builder.node({
      id: agentNodeId,
      kind: "agent",
      label: agent.name,
      summary: `${displayPath(agent.configPath, agent.projectDir)} · ${agent.servers.length} server${agent.servers.length === 1 ? "" : "s"}`,
      issues: agent.issues,
      meta: { client: agent.id, configPath: agent.configPath, scope: agent.scope, projectDir: agent.projectDir },
    });

    for (const server of agent.servers) {
      const serverNodeId = nodeId("mcp_server", agent.id, server.name);
      builder.node({
        id: serverNodeId,
        kind: "mcp_server",
        label: server.name,
        summary: server.disabled ? "disabled" : describeServer(server),
        issues: server.issues,
        meta: {
          transport: server.transport,
          command: server.command,
          args: server.args,
          cwd: server.cwd,
          url: server.url,
          envKeys: Object.keys(server.env), // names only — never values
          headerKeys: Object.keys(server.headers),
          disabled: server.disabled,
        },
      });
      builder.edge({ from: agentNodeId, to: serverNodeId, kind: "connects" });

      // Env vars are global to the machine, so they get a shared id: two
      // servers needing GITHUB_TOKEN point at the same node.
      for (const ref of server.envRefs) {
        const envNodeId = ref.syntax === "input" ? nodeId("env_var", `input:${ref.name}`) : nodeId("env_var", ref.name);
        builder.node({
          id: envNodeId,
          kind: "env_var",
          label: ref.syntax === "input" ? `input:${ref.name}` : ref.name,
          meta: { syntax: ref.syntax },
        });
        builder.edge({ from: serverNodeId, to: envNodeId, kind: "requires", label: ref.location });
      }

      if (server.url) {
        const endpointId = nodeId("http_endpoint", stripQuery(server.url));
        builder.node({ id: endpointId, kind: "http_endpoint", label: stripQuery(server.url), meta: { url: server.url } });
        builder.edge({ from: serverNodeId, to: endpointId, kind: "connects" });
      }
    }
  }
}

export function scanToGraph(agents: AgentConfig[]): Graph {
  const builder = new GraphBuilder();
  addConfigsToGraph(builder, agents);
  return builder.build();
}

export function describeServer(server: McpServerConfig): string {
  if (server.transport === "stdio") return `stdio: ${[server.command, ...server.args].join(" ")}`;
  return `${server.transport}: ${server.url ?? "?"}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Type guard: narrows `unknown` to a plain object we can index into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(obj: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v)]));
}

function stripQuery(url: string): string {
  return url.split("?")[0]!;
}

function displayPath(path: string, projectDir: string): string {
  return path.startsWith(projectDir + "/") ? path.slice(projectDir.length + 1) : path.replace(homedir(), "~");
}
