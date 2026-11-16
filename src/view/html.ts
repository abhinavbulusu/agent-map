/**
 * view/html.ts — produce ONE self-contained HTML file.
 *
 * "Self-contained" = the CSS, the JavaScript and the data are all inlined.
 * No CDN, no build step, no server required: you can email the file, attach
 * it to a bug report, or open it offline years later. When it IS served by
 * `agentmap ui`, the same page also subscribes to live updates.
 *
 * The browser code lives in assets/ui/ as plain .js/.css (easier to read and
 * edit than a giant template string) and is read from disk at render time.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "./snapshot.ts";

// src/view/html.ts and dist/view/html.js are both two levels below the
// package root, so this path works in dev and when built.
const ASSETS = join(import.meta.dirname, "..", "..", "assets", "ui");

/**
 * Embed JSON inside <script> SAFELY. The data contains untrusted text (tool
 * outputs, prompts). A tool returning "</script><script>evil()</script>"
 * would otherwise END our script tag and inject its own. Escaping every "<"
 * as \u003c makes that impossible, and JSON.parse turns it back into "<".
 * (U+2028/U+2029 are escaped too: legal in JSON, historically not in JS.)
 */
export function safeJsonForScript(value: unknown): string {
  // Written as code points (not literal characters) on purpose: a raw U+2028
  // in source code is itself a line terminator and would break this regex.
  const LINE_SEP = new RegExp(String.fromCharCode(0x2028), "g");
  const PARA_SEP = new RegExp(String.fromCharCode(0x2029), "g");
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(LINE_SEP, "\\u2028").replace(PARA_SEP, "\\u2029");
}

export function renderHtml(snapshot: Snapshot): string {
  const css = readFileSync(join(ASSETS, "app.css"), "utf8");
  const js = readFileSync(join(ASSETS, "app.js"), "utf8");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentmap</title>
<style>${css}</style>
</head>
<body>
<header id="top"></header>
<main id="layout">
  <section id="graph-pane" aria-label="Connection map"><div id="graph-scroll"></div></section>
  <aside id="inspector" aria-label="Inspector"></aside>
  <section id="bottom" aria-label="Details">
    <nav id="tabs" role="tablist"></nav>
    <div id="tab-body"></div>
  </section>
</main>
<script id="agentmap-data" type="application/json">${safeJsonForScript(snapshot)}</script>
<script>${js}</script>
</body>
</html>
`;
}
