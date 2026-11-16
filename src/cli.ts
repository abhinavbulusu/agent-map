#!/usr/bin/env node
/**
 * agentmap — CLI entry point. Wires commands to modules; contains no logic
 * of its own beyond "parse args → call module → print → set exit code".
 *
 * It runs two ways:
 *   - dev:   `node src/cli.ts`   (Node strips the types and runs it directly)
 *   - built: `node dist/cli.js`  (tsc compiled it; this is what users run)
 * The `#!/usr/bin/env node` line ("shebang") is what lets the OS run this file
 * as a program when it's installed as the `agentmap` command. tsc keeps it.
 *
 * Commands:
 *   agentmap                 scan + show the map
 *   agentmap scan            list detected agents
 *   agentmap check [agent]   health-check every connection
 *   agentmap run -- <cmd>    run an agent through the recording proxy (live mode)
 *   agentmap ui              browser view (live-updating)
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { GraphBuilder, nodeId } from "./graph.ts";
import { addConfigsToGraph, scanMcpConfigs, type AgentConfig } from "./scan/mcpConfigs.ts";
import { addCheckReportToGraph, runChecks, saveCheckReport } from "./check/index.ts";
import { DEFAULT_TOKEN_LIMIT } from "./check/mcp.ts";
import { paint, renderFooter, renderTree, setColor } from "./view/terminal.ts";
import { runAgent } from "./live/run.ts";
import { startUi, exportHtml } from "./view/uiServer.ts";

/**
 * Read agentmap's own version from package.json.
 *
 * Why read the file at runtime instead of `import pkg from "../package.json"`?
 * package.json lives outside `rootDir: "src"`, so tsc would refuse to compile
 * that import (or change the dist/ layout). Reading it from disk avoids that.
 */
export function readVersion(): string {
  // ESM has no `__dirname`; `import.meta.dirname` is the folder containing
  // *this* file. Both src/cli.ts and dist/cli.js sit exactly one level below
  // the package root, so "../package.json" is right in dev AND when built.
  const pkgPath = join(import.meta.dirname, "..", "package.json");
  // JSON.parse returns `any`. Treat it as `unknown`-ish and check the shape,
  // instead of trusting it blindly.
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0-unknown";
}

const VERSION = readVersion();

const program = new Command()
  .name("agentmap")
  .description("Chrome DevTools for AI agents: map, health-check and watch every connection your agent makes.")
  .version(VERSION, "-v, --version")
  // Required for `run`'s passThroughOptions(): options are matched to the
  // command they appear after, so `run -- python agent.py --verbose` passes
  // --verbose to the agent instead of agentmap trying to parse it.
  .enablePositionalOptions();

// ---------------------------------------------------------------------------
// agentmap  /  agentmap scan
// ---------------------------------------------------------------------------

program
  .option("-C, --dir <path>", "project directory", ".")
  .option("--global", "also scan user-level configs (Claude Desktop, ~/.cursor)")
  .action(async (opts: { dir: string; global?: boolean }) => {
    const root = resolve(opts.dir);
    const agents = await scanMcpConfigs(root, { global: opts.global ?? false });
    printScan(root, agents);
    if (agents.length > 0) {
      console.log(paint("dim", "Next:  agentmap check            health-check every connection"));
      console.log(paint("dim", "       agentmap run -- <command>  watch your agent live (e.g. agentmap run -- python agent.py)"));
      console.log(paint("dim", "       agentmap ui               open the browser view"));
    }
  });

program
  .command("scan")
  .description("list detected agents and what they're connected to (reads files only)")
  .option("-C, --dir <path>", "project directory", ".")
  .option("--global", "also scan user-level configs (Claude Desktop, ~/.cursor)")
  .option("--json", "print machine-readable JSON")
  .action(async (opts: { dir: string; global?: boolean; json?: boolean }) => {
    const root = resolve(opts.dir);
    const agents = await scanMcpConfigs(root, { global: opts.global ?? false });
    if (opts.json) return console.log(JSON.stringify(agents, null, 2));
    printScan(root, agents);
  });

function printScan(root: string, agents: AgentConfig[]): void {
  if (agents.length === 0) {
    console.log(`No MCP config files found in ${root}`);
    console.log(paint("dim", "Looked for .mcp.json, .cursor/mcp.json, .vscode/mcp.json, claude_desktop_config.json (try --global)."));
    return;
  }
  const builder = new GraphBuilder();
  addConfigsToGraph(builder, agents);
  console.log(paint("dim", `Scanned ${root}\n`));
  console.log(renderTree(builder.build(), { hints: false }));
}

// ---------------------------------------------------------------------------
// agentmap check [agent]
// ---------------------------------------------------------------------------

program
  .command("check")
  .description("health-check MCP servers, tools, env vars and endpoints")
  .argument("[agent]", "agent to check: claude-code, cursor, vscode, claude-desktop (default: all)")
  .option("-C, --dir <path>", "project directory", ".")
  .option("--global", "also check user-level configs")
  .option("--allow-writes", "also call tools NOT marked readOnlyHint (they may write, send or delete!)")
  .option("--timeout <ms>", "per-request timeout", "10000")
  .option("--token-limit <n>", "flag tool responses larger than this", String(DEFAULT_TOKEN_LIMIT))
  .option("--json", "print the check report as JSON")
  .action(async (agentArg: string | undefined, opts: { dir: string; global?: boolean; allowWrites?: boolean; timeout: string; tokenLimit: string; json?: boolean }) => {
    const root = resolve(opts.dir);
    let agents = await scanMcpConfigs(root, { global: opts.global ?? false });
    if (agentArg) {
      const wanted = agentArg.toLowerCase();
      agents = agents.filter((a) => a.id === wanted || a.name.toLowerCase() === wanted);
      if (agents.length === 0) {
        console.error(`No agent named "${agentArg}". Run \`agentmap scan\` to see what's detected.`);
        process.exitCode = 2;
        return;
      }
    }
    const serverCount = agents.reduce((n, a) => n + a.servers.length, 0);
    if (serverCount === 0) {
      console.log("Nothing to check.");
      return;
    }

    // Transparency: a check RUNS the commands in these config files.
    if (!opts.json) {
      console.error(paint("dim", `Checking ${serverCount} server(s) — this starts the local commands listed in the config files.`));
      if (opts.allowWrites) console.error(paint("yellow", "⚠ --allow-writes: tools that may write, send or delete WILL be called."));
    }

    const report = await runChecks(root, agents, {
      allowWrites: opts.allowWrites ?? false,
      timeoutMs: Number(opts.timeout),
      tokenLimit: Number(opts.tokenLimit),
      clientVersion: VERSION,
    });
    const reportPath = await saveCheckReport(root, report);

    const builder = new GraphBuilder();
    addConfigsToGraph(builder, agents);
    addCheckReportToGraph(builder, report);
    const graph = builder.build();

    if (opts.json) {
      setColor(false);
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("");
      console.log(renderTree(graph, { agentIds: agents.map((a) => nodeId("agent", a.id)) }));
      console.log(renderFooter(graph));
      console.log(paint("dim", `\nReport saved to ${reportPath} — \`agentmap ui\` shows it in the browser.`));
    }
    // Exit code 1 if anything is broken: lets you use `agentmap check` in CI.
    if (graph.nodes.some((n) => n.status === "error")) process.exitCode = 1;
  });

// ---------------------------------------------------------------------------
// agentmap run -- <command...>
// ---------------------------------------------------------------------------

program
  .command("run")
  .description("run an agent through agentmap's recording proxy and stream what it does")
  .argument("<command...>", "the agent command, e.g. -- python agent.py")
  .option("-C, --dir <path>", "where to write .agentmap/events.jsonl", ".")
  .option("--port <n>", "proxy port (default: random free port)", "0")
  .option("--ui", "also open the live browser view")
  .option("--ui-port <n>", "browser view port", "4477")
  .option("--no-open", "with --ui: don't open a browser automatically")
  .option("--no-http-proxy", "don't set HTTP_PROXY/HTTPS_PROXY (only capture LLM calls)")
  .option("-q, --quiet", "don't stream events to the terminal")
  .passThroughOptions()
  .action(async (command: string[], opts: { dir: string; port: string; ui?: boolean; uiPort: string; open: boolean; httpProxy: boolean; quiet?: boolean }) => {
    const code = await runAgent(command, {
      rootDir: resolve(opts.dir),
      port: Number(opts.port),
      httpProxy: opts.httpProxy,
      quiet: opts.quiet ?? false,
      ...(opts.ui ? { ui: { port: Number(opts.uiPort), open: opts.open } } : {}),
    });
    process.exitCode = code;
  });

// ---------------------------------------------------------------------------
// agentmap ui
// ---------------------------------------------------------------------------

program
  .command("ui")
  .description("open the browser view: the map, last check, and live/recorded sessions")
  .option("-C, --dir <path>", "project directory", ".")
  .option("--port <n>", "port to serve on", "4477")
  .option("--no-open", "don't open a browser automatically")
  .option("--out <file>", "write a self-contained HTML report to <file> and exit")
  .action(async (opts: { dir: string; port: string; open: boolean; out?: string }) => {
    const root = resolve(opts.dir);
    if (opts.out) {
      const path = await exportHtml(root, resolve(opts.out));
      console.log(`Wrote ${path}`);
      return;
    }
    await startUi({ rootDir: root, port: Number(opts.port), open: opts.open });
  });

await program.parseAsync(process.argv);
