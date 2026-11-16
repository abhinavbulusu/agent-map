/**
 * graph.ts — the data model every part of agentmap speaks.
 *
 * Scanning PRODUCES a graph, checks and live mode ANNOTATE it (statuses, issues,
 * raw payloads), and the views RENDER it. Because it is plain JSON-serializable
 * data (no class instances, no functions, no Maps in the output), the exact same
 * object can be printed as a terminal tree, dumped with --json, or embedded into
 * the browser page.
 *
 * Mental model:
 *   - A NODE is a thing:      an agent, an LLM, a tool, an MCP server, an HTTP
 *                             endpoint, an env var.
 *   - An EDGE is a dependency: "this agent connects to that MCP server", "that
 *                             server requires this env var", "the LLM called
 *                             this tool".
 *   - STATUS answers "is it healthy?"  ISSUES answer "why not?"
 *     DETAILS answer "show me the raw evidence" (requests/responses).
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

// We use string-literal unions instead of `enum`: they're erased at runtime
// (compatible with Node's type stripping), and they serialize to readable JSON.
export type NodeKind = "agent" | "llm" | "tool" | "mcp_server" | "http_endpoint" | "env_var";

/**
 * - ok:      we checked it and it's healthy
 * - warn:    it works, but something smells (empty result, huge response, ...)
 * - error:   it's broken (can't connect, threw, missing env var, ...)
 * - unknown: not checked (yet), or deliberately skipped (e.g. a destructive tool)
 */
export type Status = "ok" | "warn" | "error" | "unknown";

/**
 * What an edge means, read as "<from> <kind> <to>":
 * - connects: agent → mcp_server / llm, mcp_server → http_endpoint (remote server URL)
 * - exposes:  mcp_server → tool
 * - requires: mcp_server → env_var
 * - calls:    llm → tool (the model asked for it), tool/agent → http_endpoint
 */
export type EdgeKind = "connects" | "exposes" | "requires" | "calls";

/** One concrete reason a node/edge is not "ok". A node can have several. */
export interface Issue {
  severity: "warn" | "error";
  /** Machine-readable, stable identifier, e.g. "spawn_failed", "empty_result". */
  code: string;
  /** Human sentence: what is wrong. */
  message: string;
  /** Optional: what to do about it. */
  hint?: string;
}

/**
 * Raw evidence. This is what you click on in the browser view: the exact
 * request we sent / the agent sent, and the exact response that came back.
 * `unknown` is deliberate: payloads are arbitrary JSON (or text).
 */
export interface Detail {
  title: string;
  /** ISO timestamp, when we have one. */
  at?: string;
  durationMs?: number;
  request?: unknown;
  response?: unknown;
  note?: string;
  /** Cross-reference into live-session data (e.g. a model call id "m3"). */
  ref?: string;
}

export interface GraphNode {
  /** Stable unique id, e.g. "mcp_server:claude-code/bug-zoo". See nodeId(). */
  id: string;
  kind: NodeKind;
  label: string;
  status: Status;
  /** One-line explanation shown next to the label ("4 tools · 312ms"). */
  summary?: string;
  issues: Issue[];
  /** Kind-specific facts: command, url, annotations, model name, ... */
  meta: Record<string, unknown>;
  details: Detail[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  status: Status;
  label?: string;
  issues: Issue[];
  details: Detail[];
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

// Ranking for "combine two statuses". Note unknown < ok: once we've *seen*
// something work, that beats "haven't looked". Anything bad beats both.
const STATUS_RANK: Record<Status, number> = { unknown: 0, ok: 1, warn: 2, error: 3 };

/** The more severe of two statuses: worst("ok", "warn") === "warn". */
export function worst(a: Status, b: Status): Status {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** Status implied by a list of issues (empty list → the given fallback). */
export function statusFromIssues(issues: Issue[], fallback: Status = "ok"): Status {
  if (issues.some((i) => i.severity === "error")) return "error";
  if (issues.some((i) => i.severity === "warn")) return "warn";
  return fallback;
}

/**
 * Build a stable id from a kind and path-like parts:
 *   nodeId("mcp_server", "claude-code", "bug-zoo") → "mcp_server:claude-code/bug-zoo"
 * Stable ids matter: the static scan and the live session both talk about the
 * same nodes, and the browser keeps your selection across live updates.
 */
export function nodeId(kind: NodeKind, ...parts: string[]): string {
  return `${kind}:${parts.join("/")}`;
}

export function edgeId(from: string, kind: EdgeKind, to: string): string {
  return `${from} -${kind}-> ${to}`;
}

// ---------------------------------------------------------------------------
// GraphBuilder — incremental construction with upsert semantics
// ---------------------------------------------------------------------------

type NodeInput = Pick<GraphNode, "id" | "kind" | "label"> & Partial<Omit<GraphNode, "id" | "kind" | "label">>;
type EdgeInput = Pick<GraphEdge, "from" | "to" | "kind"> & Partial<Omit<GraphEdge, "id" | "from" | "to" | "kind">>;

/**
 * Several producers contribute to one graph (scan, checks, live events), and
 * they often mention the same node. So adding is an UPSERT: the first call
 * creates the node, later calls merge into it (issues/details append, meta
 * merges, status escalates to the worst seen).
 *
 * Internally we use Maps for O(1) lookup; build() returns plain arrays.
 */
export class GraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();

  /** Start from an existing graph (e.g. merge a live session into the scan). */
  static from(graph: Graph): GraphBuilder {
    const b = new GraphBuilder();
    // structuredClone: deep copy, so mutating the builder never mutates the input.
    for (const n of structuredClone(graph.nodes)) b.nodes.set(n.id, n);
    for (const e of structuredClone(graph.edges)) b.edges.set(e.id, e);
    return b;
  }

  node(input: NodeInput): GraphNode {
    const existing = this.nodes.get(input.id);
    if (!existing) {
      const created: GraphNode = {
        status: "unknown",
        issues: [],
        meta: {},
        details: [],
        ...input,
      };
      // Issues always pull the status down, even if the caller passed "ok".
      created.status = worst(created.status, statusFromIssues(created.issues, "unknown"));
      this.nodes.set(created.id, created);
      return created;
    }
    // Merge into the existing node.
    existing.label = input.label;
    if (input.summary !== undefined) existing.summary = input.summary;
    if (input.meta) Object.assign(existing.meta, input.meta);
    if (input.issues) this.addIssues(existing, input.issues);
    if (input.details) existing.details.push(...input.details);
    if (input.status) existing.status = worst(existing.status, input.status);
    return existing;
  }

  edge(input: EdgeInput): GraphEdge {
    const id = edgeId(input.from, input.kind, input.to);
    const existing = this.edges.get(id);
    if (!existing) {
      const created: GraphEdge = { id, status: "unknown", issues: [], details: [], ...input };
      created.status = worst(created.status, statusFromIssues(created.issues, "unknown"));
      this.edges.set(id, created);
      return created;
    }
    if (input.label !== undefined) existing.label = input.label;
    if (input.issues) this.addIssues(existing, input.issues);
    if (input.details) existing.details.push(...input.details);
    if (input.status) existing.status = worst(existing.status, input.status);
    return existing;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Append issues (skipping exact duplicates) and escalate the status. */
  addIssues(target: GraphNode | GraphEdge, issues: Issue[]): void {
    for (const issue of issues) {
      const dup = target.issues.some((i) => i.code === issue.code && i.message === issue.message);
      if (!dup) target.issues.push(issue);
    }
    target.status = worst(target.status, statusFromIssues(target.issues, "unknown"));
  }

  build(): Graph {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
}

// ---------------------------------------------------------------------------
// Read-side helpers (used by the views)
// ---------------------------------------------------------------------------

/** Edges leaving a node, i.e. "what does this depend on?" */
export function outgoing(graph: Graph, id: string): GraphEdge[] {
  return graph.edges.filter((e) => e.from === id);
}

/**
 * Worst status in a node's whole subtree. An agent whose tools are broken is
 * itself unhealthy, even if its own node has no issues — this is the
 * "where does it break?" rollup shown next to each agent.
 */
export function rollupStatus(graph: Graph, id: string, seen = new Set<string>()): Status {
  if (seen.has(id)) return "unknown"; // cycle guard
  seen.add(id);
  const node = graph.nodes.find((n) => n.id === id);
  let status: Status = node?.status ?? "unknown";
  for (const edge of outgoing(graph, id)) {
    status = worst(status, edge.status);
    status = worst(status, rollupStatus(graph, edge.to, seen));
  }
  return status;
}

/** Count statuses across all nodes — for the "2 errors, 1 warning" footer. */
export function countStatuses(graph: Graph): Record<Status, number> {
  const counts: Record<Status, number> = { ok: 0, warn: 0, error: 0, unknown: 0 };
  for (const n of graph.nodes) counts[n.status]++;
  return counts;
}
