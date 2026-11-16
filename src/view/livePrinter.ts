/**
 * view/livePrinter.ts — stream a human-readable play-by-play of a live run.
 *
 *   agentmap m1 → openai gpt-4o-mini · 2 msgs
 *   agentmap m1 ← 200 · 14ms · tool call: get_weather({"city":"Paris"})
 *   agentmap h2 ⇄ GET http://127.0.0.1:4010/weather?city=Paris → 200 · 35 B · 3ms
 *   agentmap    ✖ get_weather: Tool returned no data: "observations" is empty
 *
 * It subscribes to the EventLog (observer pattern) and, after each completed
 * call, re-derives the session to print any NEW findings. Findings are
 * deduplicated by content, since their ids are positional and can shift.
 */
import { buildSession, type Finding } from "../analyze/session.ts";
import type { EventLog } from "../live/events.ts";
import { paint, statusIcon } from "./terminal.ts";

export function prefix(id = ""): string {
  return paint("magenta", "agentmap") + (id ? " " + paint("dim", id.padEnd(3)) : "    ");
}

export function attachLivePrinter(log: EventLog, write: (line: string) => void = (l) => process.stderr.write(l + "\n")): () => void {
  const printed = new Set<string>();
  const key = (f: Finding) => [f.code, f.modelCallId, f.toolCallId, f.httpCallId, f.message].join("|");

  const printNewFindings = () => {
    const state = buildSession(log.events);
    for (const f of state.findings) {
      if (printed.has(key(f))) continue;
      printed.add(key(f));
      write(`${prefix()}   ${statusIcon(f.severity)} ${paint(f.severity === "error" ? "red" : "yellow", f.message)}`);
      if (f.hint) write(`${prefix()}     ${paint("cyan", "→ " + f.hint)}`);
    }
    return state;
  };

  return log.subscribe((e) => {
    switch (e.type) {
      case "call_start":
        if (e.kind === "model") {
          write(`${prefix(e.id)} → ${e.provider} ${paint("bold", e.model ?? "?")}${e.messageCount !== undefined ? paint("dim", ` · ${e.messageCount} msgs`) : ""}`);
        }
        break;

      case "model_call": {
        const state = buildSession(log.events);
        const call = state.modelCalls.find((c) => c.id === e.id);
        if (call) {
          const r = call.response;
          const what = r.error
            ? paint("red", `error: ${r.error}`)
            : r.toolCalls.length
              ? `tool call: ${r.toolCalls.map((t) => `${t.name}(${clip(t.arguments, 60)})`).join(", ")}`
              : `"${clip(r.text, 70)}"`;
          const status = call.httpStatus ?? "✗";
          write(`${prefix(e.id)} ← ${status} · ${e.durationMs}ms${call.streamed ? " · streamed" : ""} · ${what}`);
        }
        printNewFindings();
        break;
      }

      case "http_call":
      case "tunnel": {
        const line =
          e.type === "tunnel"
            ? `⇄ CONNECT ${e.host}:${e.port} ${e.error ? paint("red", e.error) : paint("dim", `(encrypted) ${e.bytesUp + e.bytesDown} B`)} · ${e.durationMs}ms`
            : `⇄ ${e.method} ${e.url} → ${e.error ? paint("red", e.error) : e.response?.status} · ${e.response?.bodyBytes ?? 0} B · ${e.durationMs}ms`;
        write(`${prefix(e.id)} ${line}`);
        printNewFindings();
        break;
      }

      case "session_end": {
        const state = printNewFindings();
        const errors = state.findings.filter((f) => f.severity === "error").length;
        const warns = state.findings.length - errors;
        const verdict = errors ? `${statusIcon("error")} ${errors} problem(s)` : warns ? `${statusIcon("warn")} ${warns} warning(s)` : `${statusIcon("ok")} no problems found`;
        write(
          `${prefix()} ■ ${e.error ? paint("red", e.error) : `exited ${e.exitCode ?? e.signal}`} · ${state.modelCalls.length} model call(s) · ${state.tools.length} tool call(s) · ${state.http.length} HTTP · ${verdict}`,
        );
        write(`${prefix()}   ${paint("dim", "inspect: agentmap ui")}`);
        break;
      }
    }
  });
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
