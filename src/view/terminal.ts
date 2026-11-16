/**
 * view/terminal.ts — render the graph as a colored tree.
 *
 *   ✖ Claude Code  .mcp.json · 4 servers
 *   ├─ ✔ mcp bug-zoo  4 tools (3 called, 1 skipped) · 210ms
 *   │  ├─ ✔ tool get_status  ok · ~14 tokens · 3ms
 *   │  ├─ ✖ tool flaky_lookup  Threw: ECONNRESET ...
 *   ...
 *
 * Colors: terminals understand "ANSI escape codes" — invisible byte sequences
 * like "\x1b[31m" (switch to red) and "\x1b[39m" (reset). Node's built-in
 * util.styleText() produces them. We switch colors OFF when output isn't a
 * terminal (piped to a file/grep: escape codes would be garbage there) or
 * when the user sets NO_COLOR (a cross-tool convention: no-color.org).
 */
import { styleText } from "node:util";
import { outgoing, rollupStatus, type Graph, type GraphNode, type Issue, type NodeKind, type Status } from "../graph.ts";

type Style = Parameters<typeof styleText>[0];

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return stream.isTTY === true;
}

let COLOR = colorEnabled();
/** For tests / --json: force colors on or off. */
export function setColor(on: boolean): void {
  COLOR = on;
}

export function paint(style: Style, text: string): string {
  return COLOR ? styleText(style, text) : text;
}

export const STATUS_ICON: Record<Status, string> = { ok: "✔", warn: "⚠", error: "✖", unknown: "○" };
const STATUS_STYLE: Record<Status, Style> = { ok: "green", warn: "yellow", error: "red", unknown: "gray" };
const KIND_TAG: Record<NodeKind, string> = { agent: "agent", llm: "llm", tool: "tool", mcp_server: "mcp", http_endpoint: "http", env_var: "env" };
// Children are listed in this order: what it talks to, then what it needs.
const KIND_ORDER: NodeKind[] = ["agent", "llm", "mcp_server", "tool", "http_endpoint", "env_var"];

export function statusIcon(status: Status): string {
  return paint(STATUS_STYLE[status], STATUS_ICON[status]);
}

export interface TreeOptions {
  /** Only render these agent node ids (default: all agents). */
  agentIds?: string[];
  /** Print hints under issues. */
  hints?: boolean;
}

export function renderTree(graph: Graph, opts: TreeOptions = {}): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const roots = graph.nodes.filter((n) => n.kind === "agent" && (!opts.agentIds || opts.agentIds.includes(n.id)));
  const lines: string[] = [];

  for (const root of roots) {
    // An agent's icon is the ROLLUP of its subtree: "something below is broken".
    const rolled = rollupStatus(graph, root.id);
    lines.push(`${statusIcon(rolled)} ${paint("bold", root.label)}  ${paint("dim", root.summary ?? "")}`);
    pushIssues(lines, root.issues, "  ", opts.hints ?? true);
    renderChildren(graph, byId, root.id, "", new Set([root.id]), lines, opts.hints ?? true);
    lines.push("");
  }
  if (roots.length === 0) lines.push(paint("dim", "No agents found."));
  return lines.join("\n");
}

function renderChildren(graph: Graph, byId: Map<string, GraphNode>, id: string, prefix: string, path: Set<string>, lines: string[], hints: boolean): void {
  const children = outgoing(graph, id)
    .map((edge) => ({ edge, node: byId.get(edge.to) }))
    .filter((c): c is { edge: (typeof c)["edge"]; node: GraphNode } => !!c.node && !path.has(c.node.id))
    // Stable sort by kind keeps config order within each kind.
    .sort((a, b) => KIND_ORDER.indexOf(a.node.kind) - KIND_ORDER.indexOf(b.node.kind));

  children.forEach(({ node }, i) => {
    const last = i === children.length - 1;
    const branch = last ? "└─ " : "├─ ";
    const childPrefix = prefix + (last ? "   " : "│  ");
    const tag = paint("dim", KIND_TAG[node.kind]);
    const summary = node.summary ? `  ${paint("dim", node.summary)}` : "";
    lines.push(`${prefix}${branch}${statusIcon(node.status)} ${tag} ${node.label}${summary}`);
    // Don't repeat an issue that IS the summary line.
    pushIssues(lines, node.issues.filter((iss) => iss.message !== node.summary), childPrefix + "  ", hints);
    if (hints) {
      const hinted = node.issues.find((iss) => iss.message === node.summary && iss.hint);
      if (hinted) lines.push(`${childPrefix}  ${paint("cyan", "→ " + hinted.hint)}`);
    }
    renderChildren(graph, byId, node.id, childPrefix, new Set([...path, node.id]), lines, hints);
  });
}

function pushIssues(lines: string[], issues: Issue[], indent: string, hints: boolean): void {
  for (const issue of issues) {
    lines.push(`${indent}${statusIcon(issue.severity)} ${paint(issue.severity === "error" ? "red" : "yellow", issue.message)}`);
    if (hints && issue.hint) lines.push(`${indent}  ${paint("cyan", "→ " + issue.hint)}`);
  }
}

/** "✖ 3 errors  ⚠ 2 warnings  ✔ 9 ok  ○ 1 skipped" — counted over non-agent nodes. */
export function renderFooter(graph: Graph): string {
  const counts = { ok: 0, warn: 0, error: 0, unknown: 0 };
  for (const n of graph.nodes) if (n.kind !== "agent") counts[n.status]++;
  const part = (s: Status, word: string) => (counts[s] ? `${statusIcon(s)} ${counts[s]} ${word}${counts[s] === 1 || s === "ok" ? "" : "s"}` : "");
  return [part("error", "error"), part("warn", "warning"), part("ok", "ok"), counts.unknown ? `${statusIcon("unknown")} ${counts.unknown} unchecked/skipped` : ""]
    .filter(Boolean)
    .join("   ");
}
