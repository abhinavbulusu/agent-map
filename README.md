# agentmap

**Chrome DevTools for AI agents.** Map everything an agent is connected to (MCP servers, tools, LLMs, HTTP APIs, env vars), health-check every connection, watch its traffic live, and see exactly what the model received. It catches the confident wrong answers that come from bad or missing data.

```
✖ Claude Code  .mcp.json · 4 servers
├─ ✔ mcp bug-zoo  4 tools (3 called, 1 skipped) · 161ms
│  ├─ ✔ tool get_status  ok · ~14 tokens · 0ms
│  ├─ ✖ tool flaky_lookup  Threw: ECONNRESET: upstream customer-db closed the connection (JSON-RPC -32603)
│  ├─ ⚠ tool dump_logs  Response is ~43,538 tokens (limit 20,000)
│  └─ ○ tool delete_records  skipped: destructive (--allow-writes to call)
├─ ✖ mcp weather  Exited during startup: bug-zoo: fatal: environment variable WEATHER_API_KEY is not set
│  └─ ✖ env WEATHER_API_KEY  missing
```

```
agentmap m3  ← 200 · 2ms · "It's currently 18°C and partly cloudy in Paris, with 65% humidity and…"
agentmap       ✖ Answered confidently, but get_weather returned no data
agentmap       ✖ 3 specific claims appear in no tool output or user input: "18°C", "65%", "12 km/h"
```

## Commands

| Command | What it does |
|---|---|
| `agentmap` | Scan the project and show the map |
| `agentmap scan [--json]` | List detected agents (reads files only) |
| `agentmap check [agent] [--allow-writes]` | Health-check servers, tools, env vars, endpoints. Exits 1 if anything is broken. |
| `agentmap run [--ui] -- <command>` | Run your agent through a recording proxy and stream what it does |
| `agentmap ui [--out report.html]` | Browser view: map, last check, live/recorded session, Context X-ray |

All commands accept `-C <dir>` (project directory). `--global` adds user-level configs (Claude Desktop, `~/.cursor`).

## Quick start

Requires Node 22.18+.

```bash
npm install
npm run dev -- check -C fixtures/demo-project      # the bug zoo
npm test                                          # 41 tests
npm run build && node dist/cli.js --help          # compiled build
```

Live mode against the offline mock LLM:

```bash
python3 -m venv .venv && .venv/bin/pip install -r fixtures/demo-project/requirements.txt
npm run mock-llm                                   # terminal 1
cd fixtures/demo-project                           # terminal 2
OPENAI_BASE_URL=http://127.0.0.1:4010/v1 OPENAI_API_KEY=fake \
  node ../../src/cli.ts run --ui -- ../../.venv/bin/python agent.py
```

## Safety

- Only tools annotated `readOnlyHint: true` are called, unless you pass `--allow-writes`.
- Credentials are never sent by checks and never written to disk (headers are redacted in recordings).
- HTTP checks use only HEAD/GET. Every server listens on `127.0.0.1` only.
- `check` runs the commands in your MCP config files. Only check projects you trust.

## Learn how it works

**[docs/GUIDE.md](docs/GUIDE.md)** walks through every concept (MCP and JSON-RPC, JSON Schema, stdio transports, ESM, proxies and CONNECT tunnels, SSE streaming, the Context X-ray, source tracing) with links into the code and self-check questions.
