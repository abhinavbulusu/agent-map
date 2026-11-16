/**
 * live/run.ts — `agentmap run -- <command>`: run an agent under observation.
 *
 *   1. start the recording proxy on 127.0.0.1:<random port>
 *   2. start the agent as a CHILD PROCESS with a modified environment:
 *        OPENAI_BASE_URL    = http://127.0.0.1:PORT/openai     (LLM calls → us)
 *        ANTHROPIC_BASE_URL = http://127.0.0.1:PORT/anthropic
 *        HTTP(S)_PROXY      = http://127.0.0.1:PORT            (other HTTP → us)
 *      The agent's code doesn't change at all: SDKs and HTTP libraries read
 *      these variables themselves. That's the whole trick.
 *   3. record every event to .agentmap/events.jsonl, print a live summary
 *   4. when the agent exits: shut down, exit with the agent's exit code
 *
 * The agent's stdin/stdout/stderr are INHERITED (it talks to your terminal
 * directly); agentmap's own lines go to stderr, so piping the agent's stdout
 * (`agentmap run -- ./agent > out.txt`) still captures only the agent.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { join, relative } from "node:path";
import { agentmapDir } from "../check/index.ts";
import { attachLivePrinter, prefix } from "../view/livePrinter.ts";
import { paint } from "../view/terminal.ts";
import { startUi } from "../view/uiServer.ts";
import { EventLog } from "./events.ts";
import { startProxy } from "./proxy.ts";

export interface RunOptions {
  rootDir: string;
  port: number;
  httpProxy: boolean;
  quiet: boolean;
  ui?: { port: number; open: boolean };
}

export async function runAgent(command: string[], opts: RunOptions): Promise<number> {
  if (command.length === 0) {
    console.error("Usage: agentmap run -- <command> [args...]");
    return 2;
  }
  const eventsPath = join(agentmapDir(opts.rootDir), "events.jsonl");
  const log = new EventLog(eventsPath);

  // Where to forward to: whatever the agent WOULD have used. If you already
  // point OPENAI_BASE_URL at Azure, Ollama or LiteLLM, we forward there.
  const upstreams = {
    openai: upstream(process.env.OPENAI_BASE_URL, "https://api.openai.com/v1"),
    anthropic: upstream(process.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com"),
  };
  const proxy = await startProxy({ port: opts.port, upstreams, log });
  const detach = opts.quiet ? () => {} : attachLivePrinter(log);

  log.append({
    type: "session_start",
    sessionId: randomUUID(),
    command,
    cwd: process.cwd(),
    proxyUrl: proxy.url,
    upstreams,
    httpProxy: opts.httpProxy,
  });
  console.error(`${prefix()} proxy ${proxy.url} · recording to ${relative(process.cwd(), eventsPath) || eventsPath}`);
  console.error(`${prefix()} LLM calls → ${upstreams.openai} / ${upstreams.anthropic}${opts.httpProxy ? " · HTTP(S)_PROXY set" : ""}`);

  const ui = opts.ui ? await startUi({ rootDir: opts.rootDir, port: opts.ui.port, open: opts.ui.open, log }) : undefined;

  // --- The child's environment ---------------------------------------------
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENAI_BASE_URL: `${proxy.url}/openai`,
    OPENAI_API_BASE: `${proxy.url}/openai`, // older LangChain / openai<1.0 name
    ANTHROPIC_BASE_URL: `${proxy.url}/anthropic`,
    AGENTMAP_PROXY_URL: proxy.url,
  };
  if (opts.httpProxy) {
    // Both spellings: tools disagree on upper vs lower case.
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) env[name] = proxy.url;
    // Node's built-in fetch ignores HTTP_PROXY unless this is set (Node 24+).
    env.NODE_USE_ENV_PROXY = "1";
  }

  console.error(`${prefix()} ▶ ${command.join(" ")}`);
  const started = Date.now();
  const child = spawn(command[0]!, command.slice(1), {
    stdio: "inherit",
    env,
    // Windows needs a shell to run .cmd/.bat shims like `npx`.
    shell: process.platform === "win32",
  });

  // --- Signals ---------------------------------------------------------------
  // Ctrl+C sends SIGINT to the whole foreground process GROUP — the agent got
  // it too. So we don't forward it; we wait. A second Ctrl+C force-kills.
  let interrupts = 0;
  const onSigint = () => {
    if (++interrupts >= 2) child.kill("SIGKILL");
    else console.error(`\n${prefix()} waiting for the agent to exit (Ctrl+C again to force)`);
  };
  // SIGTERM (e.g. `kill <pid>`) only reaches us, so forward it.
  const onSigterm = () => child.kill("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((resolve) => {
    child.once("error", (err: NodeJS.ErrnoException) => {
      resolve({ code: 127, signal: null, error: err.code === "ENOENT" ? `command not found: ${command[0]}` : err.message });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);

  // Let in-flight tunnels notice their client is gone, then shut down.
  await new Promise((r) => setTimeout(r, 100));
  await proxy.close();
  log.append({ type: "session_end", exitCode: exit.code, signal: exit.signal, durationMs: Date.now() - started, ...(exit.error ? { error: exit.error } : {}) });
  detach();
  log.close();

  if (ui) {
    console.error(`${prefix()} browser view still running at ${ui.url} — ${paint("bold", "Ctrl+C")} to quit`);
    await new Promise((r) => process.once("SIGINT", r));
    await ui.close();
  }

  // Exit like the agent did. Killed by a signal → 128 + signal number (shell convention).
  if (exit.code !== null) return exit.code;
  return exit.signal ? 128 + (constants.signals[exit.signal] ?? 0) : 1;
}

/** Use an existing base URL as the upstream, unless it's already an agentmap proxy. */
function upstream(value: string | undefined, fallback: string): string {
  if (!value || /^http:\/\/127\.0\.0\.1:\d+\/(openai|anthropic)\/?$/.test(value)) return fallback;
  return value.replace(/\/+$/, "");
}
