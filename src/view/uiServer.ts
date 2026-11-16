/**
 * view/uiServer.ts — `agentmap ui`: a tiny local web server for the browser view.
 *
 *   GET /               the self-contained page (with the current snapshot embedded)
 *   GET /events         Server-Sent Events: a fresh snapshot whenever anything changes
 *   GET /snapshot.json  the current snapshot (handy for debugging / scripting)
 *
 * Where changes come from:
 *   - `agentmap run --ui`: in-process, by subscribing to the EventLog
 *   - `agentmap ui`:       by TAILING .agentmap/events.jsonl, which a separate
 *                          `agentmap run` process is writing. The file is the
 *                          interface between the two processes.
 *   - .agentmap/check.json: re-read when its modification time changes, so
 *                          running `agentmap check` refreshes the open page.
 *
 * Updates are DEBOUNCED: many events in quick succession produce one push
 * 150ms after the last one, instead of re-sending the whole snapshot 50 times.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { agentmapDir, loadCheckReport, type CheckReport } from "../check/index.ts";
import { readEventsFile, tailEvents, type AgentEvent, type EventLog } from "../live/events.ts";
import { formatSse } from "../live/sse.ts";
import { scanMcpConfigs, type AgentConfig } from "../scan/mcpConfigs.ts";
import { renderHtml } from "./html.ts";
import { buildSnapshot } from "./snapshot.ts";
import { paint } from "./terminal.ts";

export interface UiOptions {
  rootDir: string;
  port: number;
  open: boolean;
  /** In-process event source (agentmap run --ui). Otherwise we tail the file. */
  log?: EventLog;
}

export interface RunningUi {
  url: string;
  close(): Promise<void>;
}

export async function startUi(opts: UiOptions): Promise<RunningUi> {
  const eventsPath = join(agentmapDir(opts.rootDir), "events.jsonl");
  const checkPath = join(agentmapDir(opts.rootDir), "check.json");

  let agents: AgentConfig[] = await scanMcpConfigs(opts.rootDir);
  let report: CheckReport | undefined = await loadCheckReport(opts.rootDir);
  let events: AgentEvent[] = opts.log ? opts.log.events : [];

  const snapshot = (live: boolean) => buildSnapshot({ projectDir: opts.rootDir, agents, report, events, live });

  // --- Push updates to connected browsers ------------------------------------
  const clients = new Set<ServerResponse>();
  let timer: NodeJS.Timeout | undefined;
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const payload = formatSse(JSON.stringify(snapshot(true)), "snapshot");
      for (const res of clients) res.write(payload);
    }, 150);
  };

  const cleanups: (() => void)[] = [];
  if (opts.log) {
    cleanups.push(opts.log.subscribe(changed));
  } else {
    cleanups.push(
      tailEvents(
        eventsPath,
        (e) => {
          events.push(e);
          changed();
        },
        () => {
          events = []; // file truncated → a new session started
          changed();
        },
      ),
    );
  }

  // Watch check.json by polling its mtime (see tailEvents for why polling).
  let checkMtime = mtime(checkPath);
  const checkTimer = setInterval(async () => {
    const m = mtime(checkPath);
    if (m === checkMtime) return;
    checkMtime = m;
    report = await loadCheckReport(opts.rootDir);
    agents = await scanMcpConfigs(opts.rootDir);
    changed();
  }, 1000);
  cleanups.push(() => clearInterval(checkTimer));

  // Heartbeat: an SSE comment every 15s keeps proxies/browsers from timing out idle streams.
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": heartbeat\n\n");
  }, 15_000);
  cleanups.push(() => clearInterval(heartbeat));

  // --- HTTP server --------------------------------------------------------------
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET") {
      res.writeHead(405).end();
    } else if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderHtml(snapshot(true)));
    } else if (path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else if (path === "/snapshot.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snapshot(true)));
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });

  const port = await listenWithFallback(server, opts.port);
  const url = `http://127.0.0.1:${port}`;
  console.error(`${paint("magenta", "agentmap")} browser view → ${paint("bold", url)}${opts.log ? "" : "  (Ctrl+C to stop)"}`);
  if (opts.open) openBrowser(url);

  return {
    url,
    async close() {
      for (const fn of cleanups) fn();
      if (timer) clearTimeout(timer);
      for (const res of clients) res.end();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** `agentmap ui --out report.html`: a static, shareable snapshot. */
export async function exportHtml(rootDir: string, outPath: string): Promise<string> {
  const snap = buildSnapshot({
    projectDir: rootDir,
    agents: await scanMcpConfigs(rootDir),
    report: await loadCheckReport(rootDir),
    events: readEventsFile(join(agentmapDir(rootDir), "events.jsonl")),
    live: false,
  });
  await writeFile(outPath, renderHtml(snap));
  return outPath;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Try the requested port; if taken (EADDRINUSE), try the next few. */
async function listenWithFallback(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = port === 0 ? 0 : port + attempt;
    const ok = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        // Don't `throw` here: this runs inside an event callback, so a throw
        // would be uncaught. Route it into the promise instead.
        if (err.code === "EADDRINUSE") resolve(false);
        else reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      // 127.0.0.1 only: this page shows prompts and tool outputs.
      server.listen(candidate, "127.0.0.1");
    });
    if (ok) {
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : candidate;
    }
  }
  throw new Error(`No free port near ${port}`);
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Each OS has its own "open this URL in the default browser" command. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  // detached + unref: the browser must not be tied to our process's lifetime.
  spawn(cmd as string, args as string[], { stdio: "ignore", detached: true })
    .on("error", () => console.error(`Open ${url} in your browser.`))
    .unref();
}
