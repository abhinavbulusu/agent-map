/**
 * view/snapshot.ts — everything the browser view needs, in one JSON object.
 *
 * Static map (scan) + last health check (check.json) + live/recorded session
 * (events) are merged into ONE graph, so a single picture answers "what is
 * connected to what, and where is it broken?".
 */
import { GraphBuilder, type Graph } from "../graph.ts";
import { addSessionToGraph, buildSession, type SessionState } from "../analyze/session.ts";
import { addCheckReportToGraph, type CheckReport } from "../check/index.ts";
import type { AgentEvent } from "../live/events.ts";
import { addConfigsToGraph, type AgentConfig } from "../scan/mcpConfigs.ts";

export interface Snapshot {
  generatedAt: string;
  projectDir: string;
  /** True when served by `agentmap ui` (the page should subscribe to /events). */
  live: boolean;
  graph: Graph;
  session: SessionState | null;
  check: { checkedAt: string; allowWrites: boolean } | null;
  pendingEdges: string[];
}

export function buildSnapshot(input: { projectDir: string; agents: AgentConfig[]; report: CheckReport | undefined; events: AgentEvent[]; live: boolean }): Snapshot {
  const builder = new GraphBuilder();
  addConfigsToGraph(builder, input.agents);
  if (input.report) addCheckReportToGraph(builder, input.report);
  const session = input.events.length ? buildSession(input.events) : null;
  const pendingEdges = session ? addSessionToGraph(builder, session) : [];
  return {
    generatedAt: new Date().toISOString(),
    projectDir: input.projectDir,
    live: input.live,
    graph: builder.build(),
    session,
    check: input.report ? { checkedAt: input.report.checkedAt, allowWrites: input.report.allowWrites } : null,
    pendingEdges,
  };
}
