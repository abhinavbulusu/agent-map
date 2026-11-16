# The agentmap guide

This guide explains **every concept and design decision** in agentmap, in the order data flows through it. Each chapter links to the exact code and ends with a few "check yourself" questions (answers are folded underneath; try first).

**Contents**

0. [The big picture](#0-the-big-picture)
1. [Toolchain: ESM, TypeScript without a build step](#1-toolchain)
2. [The graph: one data model for everything](#2-the-graph)
3. [MCP from the wire up](#3-mcp-from-the-wire-up)
4. [Config files and environment variables](#4-config-files-and-environment-variables)
5. [Health checks](#5-health-checks)
6. [Live mode: proxies, streaming, and the event log](#6-live-mode)
7. [Analysis: X-ray, tracing, silent failures](#7-analysis)
8. [The browser view](#8-the-browser-view)
9. [Testing, and the bugs the tests caught](#9-testing)
10. [The safety model](#10-the-safety-model)
11. [Hands-on walkthrough](#11-hands-on-walkthrough)
12. [Glossary](#12-glossary)

---

## 0. The big picture

An AI agent is a loop: **ask the model → the model asks for a tool → run the tool → send the result back → repeat until the model answers**. When the final answer is wrong, the cause can be anywhere in that loop: a tool server that never started, a missing API key, a tool that returned an empty list, a response so large it got truncated, or a model that filled the gap with invented facts. agentmap makes every link in that loop **visible**.

It works in three modes, from cheapest to most revealing:

| Mode | Command | What it does | Side effects |
|---|---|---|---|
| **Scan** | `agentmap scan` | Reads MCP config files, draws the map | None (reads files only) |
| **Check** | `agentmap check` | Starts each MCP server, lists tools, calls the *read-only* ones | Runs the configured commands |
| **Live** | `agentmap run -- <cmd>` | Runs your agent through a recording proxy | Your agent runs normally |

```
            ┌──────────── static ──────────────────────┐   ┌──────────── live ──────────────────────┐
 project ─▶ scan/mcpConfigs ─▶ check/{env,http,mcp} ─┐    agentmap run -- python agent.py
 dir         (find + parse        (health checks,    │      │ sets OPENAI_BASE_URL, HTTP(S)_PROXY
             config files)         .agentmap/check.json)    ▼
                                                     │    live/proxy ──▶ live/events (.agentmap/events.jsonl)
                                                     ▼                        │
                                               graph.ts  ◀── analyze/{session,xray,silent}
                                                     │
                                       view/terminal (tree)   view/html + uiServer (browser, live via SSE)
```

### File map

| Folder | Responsibility | Files |
|---|---|---|
| `src/` | entry + data model | [cli.ts](../src/cli.ts) (wiring only), [graph.ts](../src/graph.ts) |
| `src/scan/` | *what exists* (passive) | [mcpConfigs.ts](../src/scan/mcpConfigs.ts) |
| `src/check/` | *is it healthy* (active) | [env.ts](../src/check/env.ts), [http.ts](../src/check/http.ts), [mcp.ts](../src/check/mcp.ts), [schemaSample.ts](../src/check/schemaSample.ts), [index.ts](../src/check/index.ts) |
| `src/live/` | *capture* raw traffic | [proxy.ts](../src/live/proxy.ts), [events.ts](../src/live/events.ts), [sse.ts](../src/live/sse.ts), [providers.ts](../src/live/providers.ts), [run.ts](../src/live/run.ts) |
| `src/analyze/` | *interpret* captured traffic | [session.ts](../src/analyze/session.ts), [xray.ts](../src/analyze/xray.ts), [silent.ts](../src/analyze/silent.ts) |
| `src/view/` | *render* | [terminal.ts](../src/view/terminal.ts), [livePrinter.ts](../src/view/livePrinter.ts), [snapshot.ts](../src/view/snapshot.ts), [html.ts](../src/view/html.ts), [uiServer.ts](../src/view/uiServer.ts) |
| `src/util/` | small helpers | [tokens.ts](../src/util/tokens.ts), [redact.ts](../src/util/redact.ts), [jsonc.ts](../src/util/jsonc.ts) |
| `assets/ui/` | browser code (plain JS/CSS) | [app.js](../assets/ui/app.js), [app.css](../assets/ui/app.css) |
| `fixtures/` | the "bug zoo" to test against | [bug-zoo-mcp](../fixtures/bug-zoo-mcp/server.ts), [mock-llm](../fixtures/mock-llm/server.ts), [demo-project](../fixtures/demo-project/) |

Two separations are worth noticing because they recur everywhere:

- **Capture vs. interpret** (`live/` vs `analyze/`). The proxy records only raw facts. Opinions like "this is empty" or "this claim is ungrounded" are computed later. Improve a detector and every old recording gets re-analyzed for free.
- **Data vs. rendering** (`graph.ts` vs `view/`). Every producer emits the same plain-JSON graph, and every view consumes it.

---

## 1. Toolchain

### ESM vs CommonJS

Node has two module systems:

| | CommonJS (CJS) | ES Modules (ESM) |
|---|---|---|
| Syntax | `const x = require("x")`, `module.exports = …` | `import x from "x"`, `export …` |
| Loading | synchronous, at the moment `require` runs | asynchronous; the import graph is analyzed *before* any code runs |
| Top-level `await` | no | yes |
| `__dirname`, `__filename` | injected into every file | don't exist: use `import.meta.dirname` / `import.meta.filename` |
| Relative imports | extension optional (`./graph`) | extension **required** (`./graph.js`, or `./graph.ts` for us) |

`"type": "module"` in [package.json](../package.json) tells Node "every `.js`/`.ts` file here is ESM". We chose ESM because it's the JavaScript standard, the MCP SDK and modern libraries are ESM-first, and top-level `await` makes a CLI simpler (see the last line of [cli.ts](../src/cli.ts): `await program.parseAsync(...)`).

The `__dirname` gotcha appears in `readVersion()` in [cli.ts](../src/cli.ts) and in `ASSETS` in [html.ts](../src/view/html.ts). Both use `import.meta.dirname`. Both paths work in dev *and* when built because `src/x.ts` and `dist/x.js` sit at the same depth below the package root.

### Running TypeScript without a build step

Node 22.18+ can run `.ts` files directly through **type stripping**: it deletes the type annotations (replacing them with whitespace) and runs what's left. It does **not** type-check anything. So the workflow is:

| Purpose | Command | What runs |
|---|---|---|
| develop | `npm run dev -- <args>` (= `node src/cli.ts`) | Node strips types on the fly |
| type-check | `npm run typecheck` (= `tsc`) | the real safety net, no output files |
| ship | `npm run build` (= `tsc -p tsconfig.build.json`) | compiles `src/` → `dist/` |
| test | `npm test` | `node --test` (built-in runner, also type-stripped) |

Type stripping only works if "delete the types" always yields valid JavaScript. Three [tsconfig.json](../tsconfig.json) options enforce that, so mistakes become compile errors instead of confusing runtime crashes:

- `erasableSyntaxOnly`: bans TS syntax that *generates code*: `enum`, `namespace`, and constructor parameter properties (`constructor(private x: number)`). That's why the code uses string-literal unions like `type Status = "ok" | "warn" | …` instead of enums.
- `verbatimModuleSyntax`: forces `import type { X }` for type-only imports. Without the `type` keyword, Node would try to import a runtime value named `X` that doesn't exist.
- `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`: we write `import … from "./graph.ts"` (what Node needs at dev time), and `tsc` rewrites it to `./graph.js` in `dist/`.

**Why two tsconfigs?** [tsconfig.json](../tsconfig.json) type-checks *everything* (`src`, `test`, `fixtures`) and emits nothing. [tsconfig.build.json](../tsconfig.build.json) extends it, includes only `src`, and emits to `dist/`. Tests and fixtures get checked but never shipped.

### Dependencies, and the ones we didn't add

| Package | Why | What it replaces |
|---|---|---|
| `@modelcontextprotocol/sdk` | MCP client: handshake, version negotiation, transports, timeouts | a hand-rolled protocol client (bug farm) |
| `commander` | argument parsing, subcommands, `--help`, the `--` separator | ~200 lines of argv handling |
| `typescript` (dev) | type checker + compiler | n/a |
| `@types/node` (dev) | types for Node built-ins, **pinned to v22** = our minimum Node, so we can't accidentally use newer APIs | n/a |

Deliberately *not* added: **chalk** (Node has `util.styleText`), **a tokenizer** (estimate is enough, see §7), **a graph layout library** (40 lines of layered layout, see §8), **express** (Node's `http` is enough for 3 routes), **dotenv** (20-line parser in [env.ts](../src/check/env.ts)), **tsx/ts-node** (Node strips types natively). `zod` arrives as a peer dependency of the MCP SDK; we never import it.

<details><summary><b>Check yourself</b></summary>

1. *What happens if you write `import { Status } from "./graph.ts"` (no `type`) and run `npm run dev`?* With `verbatimModuleSyntax`, `tsc` refuses it. If you skipped the type-check, Node would keep the import, look for a runtime export `Status`, and crash with a `SyntaxError: does not provide an export named 'Status'`.
2. *Why does `readVersion()` work from both `src/cli.ts` and `dist/cli.js`?* Both files are exactly one directory below the package root, so `join(import.meta.dirname, "..", "package.json")` resolves to the same file.
3. *Why can't we just `import pkg from "../package.json" with { type: "json" }`?* `package.json` is outside `rootDir: "src"`, so the build would either fail or restructure `dist/`.
</details>

---

## 2. The graph

[graph.ts](../src/graph.ts) defines the one data model everything speaks.

- **Node** = a thing: `agent`, `llm`, `tool`, `mcp_server`, `http_endpoint`, `env_var`.
- **Edge** = a dependency, read as "from *kind* to": `connects`, `exposes`, `requires`, `calls`.
- **Status** answers *"is it healthy?"*: `ok` (checked, fine), `warn` (works but suspicious), `error` (broken), `unknown` (not checked or deliberately skipped).
- **Issues** answer *"why not?"*. Each has a stable `code` (for machines), a `message` and an optional `hint` (for humans).
- **Details** answer *"show me the evidence"*: the raw request and response behind a status.

Design decisions:

- **Plain JSON-serializable data** (no classes or Maps in the output). The same object is printed as a tree, dumped with `--json`, embedded in HTML and sent over SSE.
- **Upsert semantics** (`GraphBuilder.node()` / `.edge()`). Scan, check and live mode all mention the same nodes, so adding a node twice *merges*: issues and details append, meta merges, and status escalates.
- **Status only escalates**: `worst()` ranks `unknown < ok < warn < error`. Note `unknown < ok`: once we've *seen* something work, that beats "haven't looked".
- **Stable ids** (`nodeId("mcp_server", "claude-code", "bug-zoo")` → `"mcp_server:claude-code/bug-zoo"`) let sources refer to the same node and let the browser keep your selection across live updates.
- **Rollup**: `rollupStatus()` gives an agent the worst status in its subtree. "Claude Code ✖" means *something under it* is broken, even if the agent node itself is fine.

<details><summary><b>Check yourself</b></summary>

1. *Why do env-var nodes have ids like `env_var:GITHUB_TOKEN` (no agent/server in the id) while tool ids include the server?* An environment variable is global to the machine: two servers needing `GITHUB_TOKEN` need the *same* variable, so they share one node. Tools belong to a specific server.
2. *Why rank `unknown` below `ok`?* When merging, positive evidence ("we checked, it's fine") should replace "we don't know". Anything bad still wins.
</details>

---

## 3. MCP from the wire up

**MCP (Model Context Protocol)** standardizes how an AI app (the *client* or *host*: Claude Code, Cursor, VS Code…) plugs in capabilities (*servers*: GitHub, a database, your filesystem). A server advertises **tools** (functions the model may call), plus resources and prompts. agentmap only deals with tools.

Read [fixtures/bug-zoo-mcp/server.ts](../fixtures/bug-zoo-mcp/server.ts) alongside this chapter. It's a complete MCP server in about 150 lines, written **without** the SDK so nothing is hidden.

### Layer 1: transport (how bytes move)

**stdio**: the client *spawns* the server as a child process and talks over its **stdin/stdout pipes**. Each message is one line of JSON terminated by `\n` (newline-delimited JSON). Consequences:

- **stdout is sacred.** One stray `console.log("starting…")` injects non-JSON into the protocol stream and breaks the client. Servers must log to **stderr**. agentmap detects this case (`stdout_not_jsonrpc` in [mcp.ts](../src/check/mcp.ts)).
- The server's lifetime is tied to the client: when the client closes stdin, the server should exit.
- stdio servers are local only.

**Streamable HTTP** (`"type": "http"`): JSON-RPC over HTTP POST to a URL, for remote servers. **SSE** (`"type": "sse"`) is the older remote transport.

### Layer 2: messages (JSON-RPC 2.0)

Three shapes:

```jsonc
// request: has an id, expects a response
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_status","arguments":{"service":"db"}}}
// response: same id; either "result" or "error"
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"status\":\"healthy\"}"}]}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"ECONNRESET: upstream closed"}}
// notification: no id, never answered
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

The `id` lets a client have several requests in flight and match each response to its request. Standard error codes: `-32700` parse error, `-32601` method not found, `-32602` invalid params, `-32603` internal error.

### Layer 3: lifecycle

1. Client → `initialize` with its `protocolVersion`, capabilities and `clientInfo`.
2. Server → result with the version it will speak, its capabilities (`{"tools":{}}` = "I have tools") and `serverInfo`.
3. Client → `notifications/initialized`.
4. Normal traffic: `tools/list`, `tools/call`, `ping`…

`client.connect()` in the SDK performs steps 1–3. You can replay the whole thing by hand:

```bash
cd fixtures/demo-project
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"me","version":"0"}}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node ../bug-zoo-mcp/server.ts
```

### Two kinds of tool failure

- **Protocol error**: the response has an `error` member. Something went wrong *around* the tool (unknown tool, bad params, an unhandled exception in the server).
- **Tool error**: a normal `result` with `isError: true`. The tool ran and reports failure ("rate limited"). This one is **designed to be shown to the model** so it can react.

agentmap reports both, but distinctly (`tool_threw` vs `tool_is_error`).

### Tool annotations, and why they're only hints

`annotations` such as `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` describe behavior. They are **self-reported by the server**: a promise, not a guarantee. The spec's defaults are pessimistic (`readOnlyHint: false`, `destructiveHint: true`), so a tool with *no* annotations must be assumed destructive. That's exactly how `toolSafety()` in [mcp.ts](../src/check/mcp.ts) classifies tools, and why agentmap only auto-calls tools that **explicitly** say `readOnlyHint: true`.

<details><summary><b>Check yourself</b></summary>

1. *A stdio server prints `Server ready!` with `console.log` at startup. What does the client see?* A line that isn't valid JSON on the protocol stream. The SDK raises a parse error, typically closes the connection, and the server shows up as failed even though it "started fine".
2. *Why doesn't `notifications/initialized` get a response?* It has no `id`; by JSON-RPC rules, notifications are never answered.
3. *A tool has `annotations: {}`. Will `agentmap check` call it?* No. Missing hints fall back to the spec defaults (not read-only, destructive), so it's skipped unless you pass `--allow-writes`.
</details>

---

## 4. Config files and environment variables

### Four dialects

[mcpConfigs.ts](../src/scan/mcpConfigs.ts) normalizes four config formats into one `McpServerConfig`:

| Client | File | Servers key | Interpolation |
|---|---|---|---|
| Claude Code | `.mcp.json` | `mcpServers` | `${VAR}`, `${VAR:-default}` |
| Cursor | `.cursor/mcp.json` (+ `~/.cursor/mcp.json`) | `mcpServers` | `${env:VAR}`, `${workspaceFolder}`, `${userHome}` |
| VS Code | `.vscode/mcp.json` (**JSONC**: comments allowed) | `servers` | `${env:VAR}`, `${input:id}` (prompts you), `${workspaceFolder}` |
| Claude Desktop | `claude_desktop_config.json` (OS app-data folder) | `mcpServers` | **none**: `${VAR}` is passed literally |

Each difference is a real bug class agentmap flags:

- Using `mcpServers` in VS Code (or `servers` elsewhere) → `config_wrong_key`, because the client silently finds zero servers.
- `${VAR}` in Claude Desktop → `interpolation_unsupported`, because the server literally receives the text `${VAR}`.
- `./server.js` in a user-level config → `relative_path_in_user_config`, because GUI apps don't start in your project folder.
- `"API_KEY": "your-api-key-here"` → `env_placeholder`.

**JSONC parsing** ([jsonc.ts](../src/util/jsonc.ts)) is a tiny *lexer*. It walks character by character, tracking whether it's inside a string, because `"https://example.com"` contains `//` and must survive. A regex can't know string context; a lexer can.

**`${workspaceFolder}` vs `${VAR}`**: they look identical to a regex. [env.ts](../src/check/env.ts) checks a list of editor built-ins *first*, otherwise it would report "env var workspaceFolder is missing".

### How a server gets its environment

This is the subtle part. When a client spawns a stdio server, the server does **not** necessarily inherit your shell's environment. The MCP SDK passes only a safe allow-list (`HOME`, `PATH`, `SHELL`, `TERM`, `USER`, `LOGNAME`) **plus** the config's `env` block. So a server that needs `WEATHER_API_KEY` only gets it if the config says `"env": {"WEATHER_API_KEY": "${WEATHER_API_KEY}"}` *and* the variable is set where the client resolves it.

Three classic failures follow:

1. **Variable missing** → the server crashes at startup. agentmap shows the crash (stderr captured) **and** the missing variable, linked as one root cause.
2. **Variable only in `.env`** → agentmap can read `.env`, but **MCP clients don't**. Reported as a warning (`env_only_in_dotenv`).
3. **"Works in my terminal, fails in Claude Desktop"** → GUI apps launched from the Dock don't run your shell profile, so `PATH` lacks nvm/pyenv/Homebrew paths and `npx`/`uvx` aren't found. That's why the `spawn_enoent` hint mentions it.

**Scanning is passive.** `agentmap scan` only reads files. Nothing runs until `check`.

<details><summary><b>Check yourself</b></summary>

1. *Your `.mcp.json` has `"env": {"TOKEN": "${TOKEN}"}` and `TOKEN` is in your project's `.env`. Will Claude Code's server see it?* Not unless your shell exported it. Claude Code doesn't read `.env`. agentmap marks it ⚠ for exactly this reason.
2. *Why does agentmap leave an unresolvable variable OUT of the child's environment instead of setting it to `""`?* To reproduce what the server would really experience: "not set". Some servers treat `""` and unset differently.
</details>

---

## 5. Health checks

[check/index.ts](../src/check/index.ts) orchestrates, per server: **env** (instant, no execution) → **http** (remote servers: reachable?) → **mcp** (connect, list, call). Servers run **in parallel** (`Promise.all`: independent processes, and one slow server shouldn't block the rest); tools within a server run **sequentially** to be gentle.

### Generating inputs from JSON Schema

**JSON Schema** is a JSON vocabulary for describing valid JSON: `type`, `properties`, `required`, `enum`, `minimum`, `format`, `$ref`, `anyOf`… Every MCP tool publishes one as `inputSchema`. The model reads it to know how to call the tool. [schemaSample.ts](../src/check/schemaSample.ts) uses it in reverse to **synthesize the most boring valid input**:

- priority: `const` → `default` → `examples[0]` → `enum[0]` → a minimal value for the type;
- objects get **only `required` properties** (fewer guesses, fewer optional side effects);
- `$ref: "#/$defs/X"` is resolved as a *JSON Pointer* within the same document (never fetched remotely);
- recursion is capped at depth 8 (schemas can be recursive).

It's a best effort, not a solver. A tool may need an id that exists in a database. So `-32602 invalid params` is reported as a **warning** ("our generated input was rejected"), never as proof the tool is broken.

### What each check flags

| Situation | Code | Status |
|---|---|---|
| Command not on PATH | `spawn_enoent` | ✖ |
| Server exited before answering `initialize` | `exited_during_startup` (+ stderr tail) | ✖ |
| No answer to `initialize` in time | `initialize_timeout` | ✖ |
| Non-JSON on stdout | `stdout_not_jsonrpc` | ✖ |
| Remote server unreachable / needs auth | `remote_unreachable` / `requires_auth` | ✖ / ⚠ |
| Tool threw (JSON-RPC error) | `tool_threw` | ✖ |
| Tool returned `isError: true` | `tool_is_error` | ✖ |
| Empty result (`""`, `[]`, `{}`, `null`) | `empty_result` | ⚠ |
| Response > 20k tokens (estimate) | `huge_result` | ⚠ |
| Our sample input rejected | `sample_input_rejected` | ⚠ |
| Not marked read-only | skipped | ○ |

**Root-cause linking**: if a server failed to connect *and* one of its env vars is missing, the hint says "Likely cause: WEATHER_API_KEY is not set". One problem, one fix.

**HTTP checks** ([http.ts](../src/check/http.ts)) use only `HEAD` (headers without a body: the cheapest "are you there?"), falling back to `GET` with the body cancelled. They send no credentials (so 401/403 means "reachable, wants auth": good news) and don't follow redirects. `fetch()` failures are notoriously vague (`TypeError: fetch failed`); the real reason hides in `err.cause.code` (`ECONNREFUSED`, `ENOTFOUND`, TLS errors), which `networkErrorReason()` translates.

**Outputs**: a colored tree (§8 explains the colors), `.agentmap/check.json` (so the browser can show the last check), and **exit code 1** if anything is broken, so `agentmap check` can gate CI. The CLI sets `process.exitCode` instead of calling `process.exit()`, which can cut off output that's still being written to a pipe.

> **Security note:** `check` *runs the commands in the config files*, the same trust decision as opening a project in Claude Code. Don't check repos you don't trust. agentmap prints a reminder each time.

<details><summary><b>Check yourself</b></summary>

1. *Why only required properties when generating input?* Each optional field is another guess that can be wrong, and optional flags often enable extra behavior. Minimal input is the most likely to be accepted and the least likely to do anything surprising.
2. *Why is `sample_input_rejected` a warning but `tool_threw` an error?* The first means *our guess* was wrong (the tool validated input, which is healthy behavior). The second means an exception escaped the tool, which is what agents also hit.
</details>

---

## 6. Live mode

### The trick: change the environment, not the code

`agentmap run -- python agent.py` ([run.ts](../src/live/run.ts)) starts a proxy on `127.0.0.1:<random port>` and launches your agent as a **child process** with extra environment variables:

```
OPENAI_BASE_URL    = http://127.0.0.1:PORT/openai       ← official SDKs read this
ANTHROPIC_BASE_URL = http://127.0.0.1:PORT/anthropic
HTTP_PROXY / HTTPS_PROXY (+ lowercase) = http://127.0.0.1:PORT   ← requests, httpx, curl… read these
NODE_USE_ENV_PROXY = 1                                  ← makes Node's fetch honor HTTP_PROXY
```

The agent's code is untouched; its libraries route traffic through us on their own. If you *already* set `OPENAI_BASE_URL` (Azure, Ollama, LiteLLM…), that becomes the **upstream** we forward to.

### One server, three kinds of proxy

[proxy.ts](../src/live/proxy.ts) tells them apart by the **request line**:

| Request line | Role | Visibility |
|---|---|---|
| `POST /openai/chat/completions` | **Reverse proxy**: the client thinks we *are* the API | full plaintext (we terminate the connection and open our own HTTPS upstream) |
| `GET http://api.example.com/x` (absolute URL) | **Forward proxy** for plain HTTP | full plaintext |
| `CONNECT api.example.com:443` | **Tunnel** for HTTPS | host, timing, byte counts. **No content.** |

Why can't we see inside the tunnel? With `CONNECT`, the client runs TLS *end-to-end with the real server through our pipe*; we only shovel encrypted bytes. Decrypting would require a fake certificate authority trusted by your machine (what mitmproxy does). It's powerful but invasive, so agentmap deliberately doesn't. A tunnel to `api.openai.com` *does* trigger a finding, though: something in your agent hardcodes the base URL and bypassed the proxy.

Some clients even send requests for our *own* base URL through `HTTP_PROXY` (absolute form, addressed to ourselves). The proxy detects "that's me" and unwraps it.

### Proxy details that matter

- **Hop-by-hop headers** (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Upgrade`, `Proxy-*`) describe *one network hop*, not the message, so a proxy must not forward them (RFC 9110). See `HOP_BY_HOP`.
- **Compression**: we drop `Accept-Encoding`, so upstreams send plain text we can read. `fetch()` also auto-decompresses, so a leftover `Content-Encoding: gzip` header would make the client try to decompress plain text. It's removed from responses.
- **Streaming + backpressure**: the response body is relayed chunk by chunk *as it arrives*, so streaming stays live. When `res.write()` returns `false`, the client's buffer is full; we `await once(res, "drain")` instead of piling chunks into memory. We keep a copy of every chunk to record afterwards.
- **Client hang-up**: if the agent disconnects mid-stream, an `AbortController` cancels the upstream request too.
- **Bound to `127.0.0.1`**: on `0.0.0.0` it would be an *open proxy* anyone on your network could use to make requests from your machine.
- **Redaction**: `Authorization`, `x-api-key`, cookies etc. are replaced by `[redacted · N chars]` before anything is written ([redact.ts](../src/util/redact.ts)). The length helps spot "empty key" bugs without exposing the key.

### Server-Sent Events, and reassembling streams

When an LLM streams, the HTTP response has `Content-Type: text/event-stream` and a body like:

```
data: {"choices":[{"delta":{"content":"Hel"}}]}

data: {"choices":[{"delta":{"content":"lo"}}]}

data: [DONE]
```

Messages are separated by a **blank line**, several `data:` lines join with `\n`, lines starting with `:` are comments/keep-alives, and an optional `event:` line names the message. [sse.ts](../src/live/sse.ts) implements these rules.

[providers.ts](../src/live/providers.ts) then rebuilds the full response from its stream, so downstream code treats streamed and non-streamed calls identically:

- **OpenAI Chat** sends *deltas*. Text fragments get concatenated; tool calls arrive as fragments addressed by `index` (the first fragment has the id and name, later ones only more `arguments` text).
- **Anthropic** streams a *state machine*: `message_start` → (`content_block_start` → `content_block_delta`… → `content_block_stop`)* → `message_delta` (stop reason, usage) → `message_stop`. Tool inputs arrive as `input_json_delta` fragments of a JSON **string** that is parsed only at `content_block_stop`.
- **OpenAI Responses** ends with `response.completed` containing the whole response object.

### The event log

[events.ts](../src/live/events.ts) records **raw facts only**: `session_start`, `call_start` (so the UI can show calls in flight), `model_call`, `http_call`, `tunnel`, `session_end`. Each is stamped with `seq` (a total order even when timestamps tie) and `ts`.

- **JSONL** (one JSON object per line): append without rewriting, readable *while* being written, and a crash loses at most the last line.
- **Synchronous writes** (`writeSync`): events are few and small, and sync means each line is on disk (visible to `agentmap ui` in another process) before we continue.
- **The file is the interface between processes**: `agentmap run` writes it, and `agentmap ui` (possibly another terminal) tails it.

### Process management

- The child **inherits stdio**, so it talks to your terminal directly. agentmap's own lines go to **stderr**, so `agentmap run -- ./agent > out.txt` captures only the agent's output.
- **Ctrl+C** sends SIGINT to the whole foreground **process group**: the agent got it too. So agentmap doesn't forward it (Python would get two `KeyboardInterrupt`s); it waits, and a second Ctrl+C force-kills. `SIGTERM` from `kill <pid>` reaches only agentmap, so that one *is* forwarded.
- agentmap exits with the agent's exit code (killed by a signal → `128 + signal number`, the shell convention).

<details><summary><b>Check yourself</b></summary>

1. *Your agent calls `https://api.weather.com`. What does agentmap record?* A `tunnel` event: host, port, bytes and duration, but not the URL path or body. A plain `http://` URL would be recorded in full.
2. *Why strip `Accept-Encoding` instead of decompressing ourselves?* Fewer moving parts: the upstream sends readable text, and we never risk a header/body mismatch.
3. *Why record `call_start` separately instead of only completed calls?* LLM calls can take seconds or minutes; without a start event the UI couldn't show "in flight" (the pulsing edge).
</details>

---

## 7. Analysis

### Normalization: one shape for three APIs

Every LLM request is "a conversation so far plus the tools available". [providers.ts](../src/live/providers.ts) turns each provider's JSON into a list of **segments**, each tagged with a **source**: `system`, `user`, `assistant`, `tool_call`, `tool_result`, `tool_schema`. Tool results only carry an id (`tool_call_id` / `tool_use_id` / `call_id`), so the normalizer remembers id → tool name from earlier assistant messages. Downstream code never sees provider differences.

**Tool schemas are a segment too.** The model receives your tool definitions as part of its prompt, and they cost tokens. In the demo, they're the *largest* part of the context.

### Context X-ray

[xray.ts](../src/analyze/xray.ts) estimates tokens per segment and flags data known to make models fail *quietly*. Flags apply to data from outside the model (tool results and user input):

| Flag | Heuristic | Why it hurts |
|---|---|---|
| `empty` | `""`, `null`, `[]`, `{}`, "no results", or JSON whose every collection is empty with ≤4 top-level scalars (e.g. `{"city":"Paris","observations":[]}`) | nothing to ground on, so the model fills silence with priors |
| `error_text` | `is_error`, or text that looks like an error (`Error:`, `{"error": …}`, `ECONNREFUSED`, `rate limited`…) | models often "summarize" an error as if it were data |
| `truncated` | ends with `...` / `[truncated]` / `N more chars`, or JSON with unbalanced brackets | the model can't know what's missing |
| `html` | doctype, or ≥5 common tags | markup noise buries the content |
| `base64` | data URIs or 200+ chars of base64 alphabet | thousands of meaningless tokens |
| `deep_nesting` | JSON depth > 6 | models lose track of which value belongs where |
| `huge` | > 20k tokens in one segment | crowds out instructions; "lost in the middle" |

**Tokens.** Models read *tokens* produced by a tokenizer (usually BPE: byte-pair encoding, which merges frequent character sequences). English averages about 4 characters per token; JSON, code and base64 tokenize worse. agentmap estimates `ceil(chars / 4)` ([tokens.ts](../src/util/tokens.ts)) because every model family has a different tokenizer and our questions are coarse. The X-ray shows the **provider's reported count** next to the estimate, so you can see how close it is (the demo: ~100 estimated vs 99 reported).

### Linking tool calls across model calls

A tool call spans **two** model calls: call A's *response* asks for `get_weather` (id `call_1`), and call B's *request* carries the result for `call_1`. [session.ts](../src/analyze/session.ts) links them by id. Every later request repeats the whole history, so the same result appears again and again; findings are therefore reported **once per tool result**, at first sighting.

### Attributing HTTP calls to tools, by timing

The proxy can't see *inside* the agent, so how do we know which tool made an HTTP request? **Time.** A tool runs between "the model asked for it" (end of call A) and "its result appears" (start of call B). An HTTP call inside exactly one such window belongs to that tool. With concurrent tools we list candidates instead of guessing. A window also closes at the next model call that *doesn't* carry the result: the agent has moved on (crash, timeout, retry). Without that rule, one abandoned tool call made every later HTTP call ambiguous; the tests caught this (§9).

### Silent failures and source tracing

[silent.ts](../src/analyze/silent.ts) analyzes each model call that produced a **final answer** (text, no tool calls). "This turn" = everything after the last user message.

1. **Answered after a failure/empty result**: a tool result this turn is flagged `error_text` or `empty`, and the answer doesn't acknowledge a problem (no "couldn't", "unable", "no data", "sorry"…) → ✖.
2. **Source tracing**: extract *checkable* claims from the answer (numbers with units, percentages, money, URLs, emails, ISO dates/times, quoted strings) and search for each in the evidence (tool results, user and system messages, but **not** the model's own earlier messages). Numbers match by *value*, not formatting: `18°C` is found in `"temp_c": 18.0`, and `$1,200` in `1200`. Found → we show *where* (which tool result). Not found → **ungrounded**.
3. Ungrounded claims are ✖ if a tool failed or came back empty this turn (they were almost certainly invented to fill the gap), ⚠ otherwise (they may come from training data, which is just as wrong for "current weather").

**Limits, stated plainly:** this checks surface forms, not meaning. It can't verify "it will rain tomorrow", and a number that appears in a tool result for an unrelated reason counts as grounded. Think smoke detector, not fact-checker. Semantic checking would need an LLM judge, which is a possible future step.

<details><summary><b>Check yourself</b></summary>

1. *Why does `extractClaims` skip the "4" in "gpt-4o"?* The number pattern has a lookbehind `(?<![\w.\-/])` and a lookahead `(?![\w])`: a digit glued to letters or a hyphen isn't a standalone number.
2. *Why aren't the model's own previous messages counted as evidence?* Then a hallucination repeated twice would "ground" itself.
3. *Two tools run in parallel and one HTTP call happens. What does attribution do?* Both windows contain it, so it isn't attributed; the edge comes from the agent, labeled "during 2 concurrent tools".
</details>

---

## 8. The browser view

### Server: [uiServer.ts](../src/view/uiServer.ts)

Three routes: `GET /` (the page with the current snapshot embedded), `GET /events` (SSE), `GET /snapshot.json`. Changes come from the in-process `EventLog` (`run --ui`) or from **tailing** `.agentmap/events.jsonl` (`ui` in another terminal), plus `check.json`'s modification time.

- **Polling instead of `fs.watch`**: `fs.watch` wraps OS-specific notification APIs (FSEvents, inotify…) that differ in behavior: duplicate events, missed events on network drives, no event when the file doesn't exist yet. Checking the size every 250ms is boring and works everywhere. `tailEvents()` also handles a half-written last line (kept until its `\n` arrives) and truncation (the file shrank → new session → reset).
- **Debouncing**: many events in quick succession produce **one** push, 150ms after the last.
- **Heartbeat**: an SSE comment every 15s keeps idle connections from timing out.
- **Port fallback**: if 4477 is taken (`EADDRINUSE`), try the next ports. Bound to `127.0.0.1` because the page shows prompts and tool outputs.

### Page: [html.ts](../src/view/html.ts) + [app.js](../assets/ui/app.js)

**Self-contained**: CSS, JS and data are inlined into one file. No CDN, no build, works offline, and can be attached to a bug report (`agentmap ui --out report.html`). Served by `agentmap ui`, the same page also subscribes to live updates.

**Two XSS defenses**, both necessary because the data contains *untrusted text* (tool outputs, prompts):

1. **Embedding**: the snapshot sits in `<script type="application/json">`. A tool returning `</script><script>evil()</script>` would close our tag early and inject its own. `safeJsonForScript()` escapes every `<` as `<`; `JSON.parse` turns it back.
2. **Rendering**: text enters the DOM only through `textContent` / `createTextNode` (the `h()` helper), **never `innerHTML`**. A tool output containing `<img src=x onerror=…>` is displayed as text.

**Graph layout**: a small *layered* (Sugiyama-style) layout. (1) Column = longest path from an agent. (2) Each node's row = average row of its parents, pushed down to avoid overlaps. (3) A backward pass re-centers parents over their children. The live session is placed first. No library needed.

**Deep links**: `report.html#node=tool:live/get_weather` or `#call=m3` opens straight to that item.

**Panels**: map (click anything) → inspector (status, issues, facts, connections, raw evidence) → bottom tabs: **Context X-ray** (segments color-coded by source, token bar, flags, answer with claims underlined green/red, source-tracing table), **Findings** (live + health check), **Timeline**.

<details><summary><b>Check yourself</b></summary>

1. *Why is escaping `<` enough to prevent breaking out of the `<script>` block?* The HTML parser ends a script block only at `</script`; with no literal `<` in the payload, that sequence can't appear.
2. *Why send full snapshots instead of diffs?* Simplicity: the server is the single source of truth, the client just re-renders, and at this scale (tens of nodes) it's fast enough.
</details>

---

## 9. Testing

`npm test` runs 41 tests with Node's built-in runner (`node:test`, no Jest/Vitest dependency):

- [test/unit.test.ts](../test/unit.test.ts): pure functions (parsing, schema sampling, SSE, stream reassembly, detectors, claim tracing, graph, safety helpers).
- [test/e2e.test.ts](../test/e2e.test.ts): real processes and sockets. `check` against the bug zoo (including "destructive tool is called **only** with `--allow-writes`"), and the proxy against the mock LLM: OpenAI/Anthropic/Responses, streamed and not, forward proxy, CONNECT tunnel, unreachable upstream, plus a full agent loop asserting the silent-failure findings.

**The fixtures are the spec.** The bug zoo plants one failure per category; the mock LLM speaks the real wire formats but is scripted to answer confidently from empty data. If a detector regresses, a test fails.

### Bugs the tests and manual runs caught during the build (worth studying)

1. **Regex backtracking.** `"error"\s*:\s*(?!null)` was meant to mean "error is not null", but `\s*` can match *zero* spaces, and then the lookahead sees `" null"` (leading space), which isn't `"null"`, so it passes. Fix: put the whitespace *inside* the lookahead, `:(?!\s*null)`. Lookaheads plus greedy quantifiers are a classic trap.
2. **"Empty" too eager.** `{"user": {"name": "A"}, "tags": []}` was flagged empty because nested scalars were counted as metadata. Fix: only top-level scalars count as metadata.
3. **Abandoned tool windows** made HTTP attribution ambiguous for the rest of a session (§7).
4. **An invisible character.** `/ /` written into source as the *actual* U+2028 character is itself a JavaScript line terminator and broke the regex. Ironically, it's the very character that function escapes. Fix: build it with `String.fromCharCode(0x2028)`.
5. **DOM `append([...])`** stringifies arrays ("[object HTMLDivElement]") and `append(null)` inserts the text "null". Fix: one `fill()` helper that flattens and filters.
6. **A global CSS class** (`.label`) restyled SVG text elsewhere. CSS classes are global, so give components specific names.

Lessons: test the *negative* cases (things that must **not** be flagged), run the real thing end to end, and look at the UI.

---

## 10. The safety model

| Rule | Where it's enforced |
|---|---|
| Never auto-call tools that could write/send/delete | `toolSafety()` + the gate in `checkTool()` ([mcp.ts](../src/check/mcp.ts)); only `readOnlyHint: true` is called without `--allow-writes`; e2e test proves it |
| Never send credentials anywhere | HTTP checks send no configured headers; remote MCP connects without headers ([mcp.ts](../src/check/mcp.ts), [http.ts](../src/check/http.ts)); the proxy forwards the *agent's own* keys only to the upstream the agent was already using |
| Never *write* credentials anywhere | `redactRecord()` on all recorded headers; env checks report presence, never values; graph meta stores env **names** only |
| HTTP checks: GET/HEAD only | [http.ts](../src/check/http.ts); no redirects followed |
| No open proxy / exposed UI | everything listens on `127.0.0.1` |
| Untrusted data stays data | safe JSON embedding + `textContent`-only rendering |
| Transparency | `check` prints that it will run config commands; `--allow-writes` prints a warning |

One nuance: remote MCP servers are contacted with the MCP handshake (an HTTP POST of `initialize`/`tools/list`). That's protocol, read-only by definition, and separate from the "HTTP checks are GET/HEAD" rule, which covers plain endpoint probing.

---

## 11. Hands-on walkthrough

```bash
npm install

# 1. The map (passive)
node src/cli.ts -C fixtures/demo-project

# 2. Health check: every bug-zoo failure, explained
node src/cli.ts check -C fixtures/demo-project
node src/cli.ts check claude-code -C fixtures/demo-project --json | less

# 3. Live mode (offline, no API key needed)
python3 -m venv .venv && .venv/bin/pip install -r fixtures/demo-project/requirements.txt
npm run mock-llm                                    # terminal 1: fake OpenAI/Anthropic + weather API
cd fixtures/demo-project                            # terminal 2:
OPENAI_BASE_URL=http://127.0.0.1:4010/v1 OPENAI_API_KEY=fake \
  node ../../src/cli.ts run --ui -- ../../.venv/bin/python agent.py "What's the weather in Rome?"

# 4. Browser view any time (and a shareable static file)
node src/cli.ts ui -C fixtures/demo-project
node src/cli.ts ui -C fixtures/demo-project --out report.html
```

Experiments that teach a lot:

- `export WEATHER_API_KEY=x` and re-run `check`: the `weather` server now connects (✔), and its tools show the same zoo results as `bug-zoo`.
- Add `console.log("hi")` at the top of the bug-zoo server and re-run `check`: watch stdout pollution break the handshake.
- Change the mock's `/weather` route to return real numbers (`{"temp_c": 18, "humidity": 65}`): `18°C` and `65%` turn green in source tracing; `12 km/h` stays red.
- Make `get_weather` in `agent.py` return `"No observations available."` when the list is empty. The "answered after empty tool" finding disappears (the tool result is now an explicit message, not empty data), but "ungrounded claims" stays, downgraded to ⚠, because the mock still invents numbers. Then make the mock apologize when it sees that message: no claims, no findings. That's the two-sided fix agentmap pushes you toward: honest tools *and* a model that admits gaps.
- Point it at a real model: unset `OPENAI_BASE_URL`, set a real `OPENAI_API_KEY`, keep the mock running for the weather API, and see whether a real model admits the data is missing.

---

## 12. Glossary

- **Agent loop**: model → tool calls → tool results → model … until a final answer.
- **Backpressure**: slowing a producer when the consumer's buffer is full (`write()` → `false`, wait for `'drain'`).
- **BPE / token**: the sub-word units models read; ~4 English characters each.
- **CONNECT**: the HTTP method that asks a proxy to open a raw TCP tunnel (used for HTTPS).
- **Debounce**: collapse a burst of events into one action after things go quiet.
- **ESM / CJS**: JavaScript's standard module system / Node's original one.
- **Forward vs reverse proxy**: the client *knows* it's using a forward proxy; a reverse proxy *pretends to be* the server.
- **Hop-by-hop header**: describes one network hop; proxies must not forward it.
- **JSON Pointer**: `#/$defs/A` style paths into a JSON document (`~1` = `/`, `~0` = `~`).
- **JSON-RPC 2.0**: request/response/notification message format with ids, used by MCP.
- **JSON Schema**: a JSON vocabulary describing valid JSON (types, required fields, enums…).
- **JSONC**: JSON with comments and trailing commas (VS Code configs).
- **JSONL**: one JSON object per line; append-friendly logs.
- **MCP**: Model Context Protocol; clients plug in servers that expose tools.
- **Process group**: processes that receive terminal signals (Ctrl+C) together.
- **SSE (Server-Sent Events)**: one-way server→client stream of `data:` messages over HTTP.
- **stdio transport**: talking to a child process over its stdin/stdout pipes.
- **Type stripping**: Node deleting TypeScript annotations to run `.ts` files directly.
- **Upsert**: insert if new, merge if it exists.
- **XSS**: cross-site scripting: untrusted text executed as code in a page.

---

### What's not built yet (Phase 3)

Source scanner (`src/scan/sourceScan.ts`, `groupAgents.ts`) to detect agents from code instead of configs, an interactive agent picker for the bare `agentmap` command (using `@inquirer/prompts`), layer isolation, "break it" buttons, a lockfile of expected connections, token cost, and OpenTelemetry import. The data model (`graph.ts`) and the event log were designed so these slot in without rewrites.
