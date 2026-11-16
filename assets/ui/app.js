// agentmap browser view — plain JavaScript, no framework, no build step.
//
// Data flow: the page starts with a SNAPSHOT embedded as JSON (so it works
// as a static file). When served by `agentmap ui`, it also opens an
// EventSource on /events and replaces the snapshot whenever a new one
// arrives, then re-renders. Re-rendering everything is simple and fast
// enough at this scale (tens of nodes, hundreds of events).
//
// SECURITY: tool outputs and prompts shown here are UNTRUSTED. Text only ever
// enters the page via textContent / createTextNode — never innerHTML — so a
// tool returning "<img src=x onerror=alert(1)>" is displayed, not executed.
"use strict";
(function () {
  const $ = (sel) => document.querySelector(sel);
  let snap = JSON.parse(document.getElementById("agentmap-data").textContent);

  // View state: what's selected / open. Survives live re-renders.
  const ui = { sel: null, tab: "xray", callId: null, connected: null, open: new Set() };
  try {
    ui.tab = localStorage.getItem("agentmap.tab") || ui.tab;
  } catch (_) {
    /* storage can be unavailable (file://, private mode) — that's fine */
  }

  // ---------------------------------------------------------------------------
  // Tiny DOM helpers
  // ---------------------------------------------------------------------------
  const SVG_NS = "http://www.w3.org/2000/svg";
  function h(tag, attrs, ...kids) {
    return build(document.createElement(tag), attrs, kids);
  }
  function s(tag, attrs, ...kids) {
    return build(document.createElementNS(SVG_NS, tag), attrs, kids);
  }
  function build(el, attrs, kids) {
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === undefined || kid === null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  /** Replace an element's content. Unlike el.append(), handles arrays and skips null. */
  function fill(el, ...kids) {
    el.replaceChildren();
    return build(el, null, kids);
  }
  const clip = (str, n) => {
    str = String(str ?? "");
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  };
  const fmt = (n) => Number(n || 0).toLocaleString("en-US");
  // Show short names; the full path stays available as a hover tooltip.
  const baseName = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
  const shortCommand = (cmd) => [baseName(cmd[0]), ...cmd.slice(1)].join(" ");
  const ICON = { ok: "✔", warn: "⚠", error: "✖", unknown: "○" };
  const KIND = { agent: "agent", llm: "llm", tool: "tool", mcp_server: "mcp server", http_endpoint: "http", env_var: "env var" };
  const SOURCE = { system: "system", user: "user", assistant: "assistant", tool_call: "tool call", tool_result: "tool result", tool_schema: "tool schemas" };
  const RANK = { unknown: 0, ok: 1, warn: 2, error: 3 };
  const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);

  const nodeById = (id) => snap.graph.nodes.find((n) => n.id === id);
  const edgeById = (id) => snap.graph.edges.find((e) => e.id === id);
  const callById = (id) => snap.session?.modelCalls.find((c) => c.id === id);
  const callFindings = (id) => (snap.session?.findings || []).filter((f) => f.modelCallId === id);

  /** Worst status in a node's subtree — what an agent node displays. */
  function rollup(id, seen = new Set()) {
    if (seen.has(id)) return "unknown";
    seen.add(id);
    let st = nodeById(id)?.status || "unknown";
    for (const e of snap.graph.edges) {
      if (e.from !== id) continue;
      st = worst(st, e.status);
      st = worst(st, rollup(e.to, seen));
    }
    return st;
  }
  const displayStatus = (n) => (n.kind === "agent" ? rollup(n.id) : n.status);

  // ---------------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------------
  function renderHeader() {
    const sess = snap.session;
    let status;
    if (!sess) status = h("span", { class: "muted" }, "no live session — run ", h("code", {}, "agentmap run -- <cmd>"));
    else if (sess.running) status = h("span", { class: "pill live", title: sess.command.join(" ") }, "● live · ", clip(shortCommand(sess.command), 48));
    else status = h("span", { class: "pill", title: sess.command.join(" ") }, "recorded · ", clip(shortCommand(sess.command), 48), ` · exited ${sess.exitCode ?? "?"}`);

    const counts = { error: 0, warn: 0 };
    for (const n of snap.graph.nodes) if (n.kind !== "agent" && counts[n.status] !== undefined) counts[n.status]++;
    for (const f of sess?.findings || []) counts[f.severity]++;

    fill($("#top"),
      h("strong", { class: "brand" }, "agentmap"),
      h("span", { class: "muted path", title: snap.projectDir }, baseName(snap.projectDir)),
      status,
      snap.check
        ? h("span", { class: "muted" }, "checked ", new Date(snap.check.checkedAt).toLocaleTimeString())
        : h("span", { class: "muted" }, "not health-checked — ", h("code", {}, "agentmap check")),
      h("span", { class: "spacer" }),
      counts.error ? h("span", { class: "count error" }, `✖ ${counts.error}`) : null,
      counts.warn ? h("span", { class: "count warn" }, `⚠ ${counts.warn}`) : null,
      snap.live
        ? h("span", { class: "conn " + (ui.connected === false ? "off" : "on") }, ui.connected === false ? "● disconnected" : "● connected")
        : h("span", { class: "muted" }, "static report"),
    );
  }

  // ---------------------------------------------------------------------------
  // Graph: layered layout + SVG
  // ---------------------------------------------------------------------------
  const NW = 214, NH = 50, GX = 284, GY = 62, PAD = 20;
  const KIND_ORDER = ["agent", "llm", "mcp_server", "tool", "http_endpoint", "env_var"];

  /**
   * A small layered ("Sugiyama-style") layout:
   *  1. column = longest path from a root (agents are roots)
   *  2. each node's row = average row of its parents, pushed down to avoid overlap
   *  3. a backward pass re-centers parents over their children
   */
  function layout(graph) {
    const parents = new Map(), children = new Map();
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      (children.get(e.from) || children.set(e.from, []).get(e.from)).push(e.to);
      (parents.get(e.to) || parents.set(e.to, []).get(e.to)).push(e.from);
    }
    const depth = new Map();
    for (const n of graph.nodes) if (n.kind === "agent" || !parents.has(n.id)) depth.set(n.id, 0);
    for (let i = 0; i < graph.nodes.length; i++) {
      let changed = false;
      for (const e of graph.edges) {
        const d = depth.get(e.from);
        if (d === undefined || !ids.has(e.to)) continue;
        if ((depth.get(e.to) ?? -1) < d + 1 && d + 1 < 8) {
          depth.set(e.to, d + 1);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const cols = [];
    // The live session (if any) goes first: during a run it's what you're watching.
    const ordered = [...graph.nodes].sort((a, b) => (b.meta?.source === "live") - (a.meta?.source === "live"));
    for (const n of ordered) {
      const d = depth.get(n.id) ?? 0;
      (cols[d] = cols[d] || []).push(n);
    }
    const pos = new Map();
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const place = (col, ci, desiredOf) => {
      const items = col.map((n) => ({ n, y: desiredOf(n) })).sort((a, b) => a.y - b.y || KIND_ORDER.indexOf(a.n.kind) - KIND_ORDER.indexOf(b.n.kind));
      let cursor = PAD;
      for (const it of items) {
        const y = Math.max(it.y, cursor);
        pos.set(it.n.id, { x: PAD + ci * GX, y });
        cursor = y + GY;
      }
    };
    cols.forEach((col, ci) => {
      if (!col) return;
      place(col, ci, (n) => {
        const ps = (parents.get(n.id) || []).filter((p) => pos.has(p));
        return ps.length ? avg(ps.map((p) => pos.get(p).y)) : ci === 0 ? col.indexOf(n) * GY : 0;
      });
    });
    for (let ci = cols.length - 2; ci >= 0; ci--) {
      if (!cols[ci]) continue;
      place(cols[ci], ci, (n) => {
        const cs = (children.get(n.id) || []).filter((c) => depth.get(c) === ci + 1 && pos.has(c));
        return cs.length ? avg(cs.map((c) => pos.get(c).y)) : pos.get(n.id).y;
      });
    }
    let width = 0, height = 0;
    for (const p of pos.values()) {
      width = Math.max(width, p.x + NW + PAD);
      height = Math.max(height, p.y + NH + PAD);
    }
    return { pos, width, height };
  }

  function renderGraph() {
    const wrap = $("#graph-scroll");
    const g = snap.graph;
    if (!g.nodes.length) {
      fill(wrap, h("div", { class: "empty" }, "No agents found. Add an MCP config (.mcp.json) or run ", h("code", {}, "agentmap run -- <cmd>")));
      return;
    }
    const L = layout(g);
    const pending = new Set(snap.pendingEdges || []);
    const svg = s("svg", { class: "graph", width: L.width, height: L.height, viewBox: `0 0 ${L.width} ${L.height}`, role: "img", "aria-label": "Agent connection map" });

    for (const e of g.edges) {
      const a = L.pos.get(e.from), b = L.pos.get(e.to);
      if (!a || !b) continue;
      let d;
      if (b.x > a.x) {
        const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, dx = Math.max(40, (x2 - x1) / 2);
        d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      } else {
        d = `M${a.x + NW / 2},${a.y + NH} C${a.x + NW / 2},${a.y + NH + 50} ${b.x + NW / 2},${b.y - 50} ${b.x + NW / 2},${b.y}`;
      }
      const isSel = ui.sel?.type === "edge" && ui.sel.id === e.id;
      const tip = `${nodeById(e.from)?.label} ${e.kind} ${nodeById(e.to)?.label}${e.label ? " — " + e.label : ""}`;
      svg.append(
        s("g", { class: `edge st-${e.status}${pending.has(e.id) ? " pending" : ""}${isSel ? " selected" : ""}`, onclick: () => select("edge", e.id) },
          s("title", {}, tip),
          s("path", { class: "line", d }),
          s("path", { class: "hit", d })),
      );
    }
    for (const n of g.nodes) {
      const p = L.pos.get(n.id);
      if (!p) continue;
      const st = displayStatus(n);
      const isSel = ui.sel?.type === "node" && ui.sel.id === n.id;
      svg.append(
        s("g", {
            class: `node kind-${n.kind}${isSel ? " selected" : ""}`,
            transform: `translate(${p.x},${p.y})`,
            tabindex: 0,
            onclick: () => select("node", n.id),
            onkeydown: (ev) => ev.key === "Enter" && select("node", n.id),
          },
          s("title", {}, `${n.label}\n${n.summary || ""}`),
          s("rect", { class: "box", width: NW, height: NH, rx: 8 }),
          s("rect", { class: `stripe st-${st}`, width: 5, height: NH, rx: 2 }),
          s("text", { class: `kind st-${st}`, x: 14, y: 15 }, `${ICON[st]} ${KIND[n.kind]}`),
          s("text", { class: "label", x: 14, y: 31 }, clip(n.label, 28)),
          s("text", { class: "sum", x: 14, y: 44 }, clip(n.summary || "", 38))),
      );
    }
    const sx = wrap.scrollLeft, sy = wrap.scrollTop;
    wrap.replaceChildren(svg);
    wrap.scrollLeft = sx;
    wrap.scrollTop = sy;
  }

  // ---------------------------------------------------------------------------
  // Inspector (right panel)
  // ---------------------------------------------------------------------------
  function renderInspector() {
    const el = $("#inspector");
    const scroll = el.scrollTop;
    fill(el);
    const item = ui.sel && (ui.sel.type === "node" ? nodeById(ui.sel.id) : edgeById(ui.sel.id));
    if (!item) {
      ui.sel = null;
      fill(el,
        h("h3", {}, "Inspector"),
        h("p", { class: "muted" }, "Click any node or edge to see its health, the issues found, and the raw requests and responses behind it."),
        h("h4", {}, "Status"),
        ["ok", "warn", "error", "unknown"].map((st) =>
          h("div", { class: "legend-row" }, h("span", { class: `badge st-${st}` }, ICON[st]), { ok: "healthy", warn: "works, but suspicious", error: "broken", unknown: "not checked / skipped" }[st])),
        h("h4", {}, "Context sources (X-ray)"),
        Object.entries(SOURCE).map(([k, v]) => h("div", { class: "legend-row" }, h("span", { class: `sw src-${k}` }), v)),
      );
      return;
    }
    if (ui.sel.type === "node") {
      const st = displayStatus(item);
      fill(el,
        h("div", { class: "insp-kind" }, KIND[item.kind]),
        h("h3", {}, item.label),
        h("div", {}, h("span", { class: `badge st-${st}` }, `${ICON[st]} ${st}`), item.summary ? h("span", { class: "muted" }, "  ", item.summary) : null),
        issues(item.issues),
        metaTable(item.meta),
        connections(item),
        evidence(item.id, item.details),
      );
    } else {
      fill(el,
        h("div", { class: "insp-kind" }, `edge · ${item.kind}`),
        h("h3", {}, `${nodeById(item.from)?.label} → ${nodeById(item.to)?.label}`),
        h("div", {}, h("span", { class: `badge st-${item.status}` }, `${ICON[item.status]} ${item.status}`), item.label ? h("span", { class: "muted" }, "  ", item.label) : null),
        issues(item.issues),
        h("h4", {}, "Ends"),
        [item.from, item.to].map((id) => h("div", { class: "conn-row", onclick: () => select("node", id) }, ICON[nodeById(id)?.status || "unknown"], " ", nodeById(id)?.label)),
        evidence(item.id, item.details),
      );
    }
    el.scrollTop = scroll;
  }

  function issues(list) {
    if (!list?.length) return null;
    return h("div", {}, h("h4", {}, `Issues (${list.length})`),
      list.map((i) => h("div", { class: `issue ${i.severity}` }, ICON[i.severity], " ", i.message, i.hint ? h("div", { class: "hint-text" }, "→ ", i.hint) : null)));
  }

  function metaTable(meta) {
    const rows = Object.entries(meta || {}).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length));
    if (!rows.length) return null;
    return h("div", {}, h("h4", {}, "Facts"),
      h("table", { class: "meta" }, rows.map(([k, v]) =>
        h("tr", {}, h("td", {}, k), h("td", {}, typeof v === "object" ? pre(v, 3000) : h("code", {}, String(v)))))));
  }

  function connections(node) {
    const out = snap.graph.edges.filter((e) => e.from === node.id);
    const inc = snap.graph.edges.filter((e) => e.to === node.id);
    if (!out.length && !inc.length) return null;
    const row = (e, otherId, arrow) =>
      h("div", { class: "conn-row", onclick: () => select("edge", e.id) }, ICON[e.status], " ", arrow, " ", h("span", { class: "muted" }, e.kind), " ", nodeById(otherId)?.label);
    return h("div", {}, h("h4", {}, "Connections"), inc.map((e) => row(e, e.from, "←")), out.map((e) => row(e, e.to, "→")));
  }

  function evidence(ownerId, details) {
    if (!details?.length) return null;
    const list = details.slice().reverse(); // newest first
    return h("div", {}, h("h4", {}, `Evidence (${details.length})`),
      list.map((d, i) => {
        const key = `${ownerId}|${d.title}|${d.at || ""}`;
        const open = ui.open.has(key) || (i === 0 && !ui.open.has("closed:" + key));
        return h("details", {
            class: "detail",
            open,
            ontoggle: (ev) => {
              if (ev.target.open) { ui.open.add(key); ui.open.delete("closed:" + key); }
              else { ui.open.delete(key); ui.open.add("closed:" + key); }
            },
          },
          h("summary", {}, clip(d.title, 100), d.durationMs != null ? h("span", { class: "muted" }, ` · ${d.durationMs}ms`) : null),
          d.note ? h("div", { class: "note" }, d.note) : null,
          d.ref && callById(d.ref) ? h("button", { class: "link", onclick: () => openXray(d.ref) }, "Open in Context X-ray →") : null,
          d.request !== undefined ? h("div", {}, h("div", { class: "field-label" }, "request"), pre(d.request)) : null,
          d.response !== undefined ? h("div", {}, h("div", { class: "field-label" }, "response"), pre(d.response)) : null);
      }));
  }

  /** <pre> with a size cap and a "show all" button for big payloads. */
  function pre(value, max = 20000) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const el = h("pre", { class: "code" }, text.length > max ? text.slice(0, max) : text);
    if (text.length <= max) return el;
    const more = h("button", { class: "link", onclick: () => { el.textContent = text; more.remove(); } }, `show all (${fmt(text.length)} chars)`);
    return h("div", {}, el, more);
  }

  // ---------------------------------------------------------------------------
  // Bottom tabs
  // ---------------------------------------------------------------------------
  function renderTabs() {
    const sess = snap.session;
    const nIssues = (sess?.findings.length || 0) + checkIssues().length;
    const tabs = [
      ["xray", `Context X-ray${sess ? ` (${sess.modelCalls.length})` : ""}`],
      ["findings", `Findings (${nIssues})`],
      ["timeline", `Timeline${sess ? ` (${sess.timeline.length})` : ""}`],
    ];
    fill($("#tabs"), tabs.map(([id, label]) =>
      h("button", { role: "tab", class: "tab" + (ui.tab === id ? " active" : ""), "aria-selected": String(ui.tab === id), onclick: () => setTab(id) }, label)));
    const body = $("#tab-body");
    const scroll = body.scrollTop;
    fill(body, ui.tab === "findings" ? findingsView() : ui.tab === "timeline" ? timelineView() : xrayView());
    body.scrollTop = scroll;
  }

  function setTab(id) {
    ui.tab = id;
    try { localStorage.setItem("agentmap.tab", id); } catch (_) { /* ignore */ }
    renderTabs();
  }

  function emptyState(msg, cmd) {
    return h("div", { class: "empty" }, h("p", {}, msg), cmd ? h("code", {}, cmd) : null);
  }

  // ---- Context X-ray ----
  function xrayView() {
    const calls = snap.session?.modelCalls || [];
    if (!calls.length) return emptyState("No model calls recorded yet. Run your agent through agentmap:", "agentmap run -- python agent.py");
    const current = calls.find((c) => c.id === ui.callId) || calls[calls.length - 1];
    const list = h("div", { class: "call-list" }, calls.map((c) => {
      const fl = callFindings(c.id);
      const st = c.response.error || fl.some((f) => f.severity === "error") ? "error" : fl.length ? "warn" : "ok";
      return h("button", { class: "call" + (c.id === current.id ? " active" : ""), onclick: () => { ui.callId = c.id; renderTabs(); } },
        h("span", { class: `dot st-${st}` }), h("strong", {}, c.id), " ", clip(c.model, 20),
        h("div", { class: "muted small" }, `~${fmt(c.xray.estimatedTokens)} tok · `, outcome(c)));
    }));
    return h("div", { class: "xray" }, list, callDetail(current));
  }

  const outcome = (c) => (c.response.error ? "error" : c.response.toolCalls.length ? "→ " + c.response.toolCalls.map((t) => t.name).join(", ") : "answer");

  function callDetail(c) {
    const x = c.xray;
    const total = Math.max(1, x.estimatedTokens);
    const sources = Object.entries(x.bySource).filter(([, n]) => n > 0);
    return h("div", { class: "call-detail" },
      h("div", {}, h("strong", {}, `${c.id} · ${c.model}`),
        h("span", { class: "muted" }, `  ${c.provider} ${c.api} · HTTP ${c.httpStatus ?? "—"} · ${c.durationMs}ms${c.streamed ? " · streamed" : ""}`)),
      h("div", { class: "muted" }, `~${fmt(x.estimatedTokens)} tokens (estimated)`,
        x.reportedInputTokens != null ? ` · ${fmt(x.reportedInputTokens)} input tokens reported by the provider` : ""),
      h("div", { class: "tokbar" }, sources.map(([src, n]) =>
        h("span", { class: `src-${src}`, style: `width:${((n / total) * 100).toFixed(2)}%`, title: `${SOURCE[src]}: ~${fmt(n)} tokens` }))),
      h("div", { class: "tok-legend" }, sources.map(([src, n]) => h("span", {}, h("i", { class: `sw src-${src}` }), `${SOURCE[src]} ~${fmt(n)}`))),
      x.notes.map((n) => h("div", { class: "flag warn" }, "⚠ ", n)),
      callFindings(c.id).map(findingRow),
      h("h4", {}, `What the model received (${x.segments.length} segments)`),
      x.segments.map(segmentView),
      h("h4", {}, "What the model answered"),
      answerView(c));
  }

  function segmentView(seg, i) {
    const LIMIT = 1500;
    const long = seg.text.length > LIMIT;
    const body = h("pre", { class: "seg-text" }, long ? seg.text.slice(0, LIMIT) : seg.text || "(empty)");
    const more = long ? h("button", { class: "link", onclick: () => { body.textContent = seg.text; more.remove(); } }, `show all (${fmt(seg.text.length)} chars)`) : null;
    return h("div", { class: `seg src-${seg.source}`, id: `seg-${i}` },
      h("div", { class: "seg-head" },
        h("span", { class: "src" }, SOURCE[seg.source]),
        seg.toolName ? h("code", {}, seg.toolName) : null,
        seg.role && seg.role !== seg.source ? h("span", { class: "muted small" }, `role: ${seg.role}`) : null,
        h("span", { class: "spacer" }),
        h("span", { class: "muted small" }, `~${fmt(seg.tokens)} tok`)),
      seg.flags.map((f) => h("div", { class: `flag ${f.severity}` }, ICON[f.severity], " ", f.message)),
      body, more);
  }

  function answerView(c) {
    const r = c.response;
    const parts = [];
    if (r.error) parts.push(h("div", { class: "flag error" }, "✖ ", r.error));
    if (r.text) parts.push(h("div", { class: "answer" }, highlightClaims(r.text, c.claims)));
    for (const tc of r.toolCalls) {
      parts.push(h("div", { class: "seg src-tool_call" }, h("div", { class: "seg-head" }, h("span", { class: "src" }, "tool call"), h("code", {}, tc.name)), h("pre", { class: "seg-text" }, tc.arguments)));
    }
    if (r.truncated) parts.push(h("div", { class: "flag warn" }, "⚠ Output hit the max-tokens limit and was cut off"));
    parts.push(h("div", { class: "muted small" }, `finish reason: ${r.finishReason || "—"}`, r.usage?.outputTokens != null ? ` · ${fmt(r.usage.outputTokens)} output tokens` : ""));
    if (c.claims.length) {
      parts.push(h("h4", {}, "Source tracing — where did each fact come from?"),
        h("table", { class: "claims" },
          h("tr", {}, h("th", {}, "claim"), h("th", {}, "found in")),
          c.claims.map((cl) => h("tr", {},
            h("td", {}, h("code", {}, cl.text)),
            h("td", {}, cl.grounded
              ? cl.sources.slice(0, 2).map((src) => h("div", {},
                  h("button", { class: "link", onclick: () => jumpTo(src.segmentIndex) }, src.toolName ? `tool result · ${src.toolName}` : SOURCE[src.source]),
                  h("span", { class: "muted" }, "  …", clip(src.snippet, 70), "…")))
              : h("span", { class: "bad-text" }, "✖ nowhere — in no tool output or user input"))))));
    }
    return parts;
  }

  /** Wrap each claim in a <mark>: green underline = traced, red = ungrounded. */
  function highlightClaims(text, claims) {
    const out = [];
    let pos = 0;
    for (const cl of [...claims].sort((a, b) => a.start - b.start)) {
      if (cl.start < pos) continue;
      out.push(text.slice(pos, cl.start));
      out.push(h("mark", {
        class: cl.grounded ? "claim ok" : "claim bad",
        title: cl.grounded ? "found in: " + cl.sources.map((x) => x.toolName || x.source).join(", ") : "appears in no tool output or user input",
      }, cl.text));
      pos = cl.start + cl.text.length;
    }
    out.push(text.slice(pos));
    return out;
  }

  function jumpTo(i) {
    const el = document.getElementById(`seg-${i}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("flash");
    void el.getBoundingClientRect(); // restart the CSS animation
    el.classList.add("flash");
  }

  // ---- Findings ----
  function checkIssues() {
    return snap.graph.nodes
      .filter((n) => n.meta?.source !== "live")
      .flatMap((n) => n.issues.map((i) => ({ ...i, nodeId: n.id, nodeLabel: n.label, kind: n.kind })));
  }

  function findingRow(f) {
    return h("div", { class: `finding ${f.severity}` },
      h("div", {}, ICON[f.severity], " ", f.message),
      f.hint ? h("div", { class: "hint-text" }, "→ ", f.hint) : null,
      h("div", { class: "links" },
        f.modelCallId ? h("button", { class: "link", onclick: () => openXray(f.modelCallId) }, `X-ray ${f.modelCallId}`) : null,
        f.toolCallId ? h("button", { class: "link", onclick: () => selectTool(f.toolCallId) }, "show tool") : null,
        f.httpCallId ? h("button", { class: "link", onclick: () => selectHttp(f.httpCallId) }, "show HTTP call") : null));
  }

  function findingsView() {
    const live = snap.session?.findings || [];
    const checks = checkIssues().sort((a, b) => RANK[b.severity] - RANK[a.severity]);
    if (!live.length && !checks.length) return emptyState("No problems found.", snap.session ? null : "agentmap check");
    return h("div", { class: "pad" },
      live.length ? [h("h4", {}, `Live session (${live.length})`), live.map(findingRow)] : null,
      checks.length ? [h("h4", {}, `Map & health check (${checks.length})`),
        checks.map((i) => h("div", { class: `finding ${i.severity}` },
          h("div", {}, ICON[i.severity], " ", h("strong", {}, `${KIND[i.kind]} ${i.nodeLabel}: `), i.message),
          i.hint ? h("div", { class: "hint-text" }, "→ ", i.hint) : null,
          h("div", { class: "links" }, h("button", { class: "link", onclick: () => select("node", i.nodeId) }, "show on map"))))] : null);
  }

  // ---- Timeline ----
  function timelineView() {
    const sess = snap.session;
    if (!sess) return emptyState("No session recorded yet.", "agentmap run -- <your agent command>");
    const t0 = Date.parse(sess.startedAt || sess.timeline[0]?.ts || new Date().toISOString());
    const rel = (ts) => `+${((Date.parse(ts) - t0) / 1000).toFixed(2)}s`;
    return h("table", { class: "timeline" },
      sess.timeline.map((item) => h("tr", { class: "tl", onclick: () => timelineClick(item) },
        h("td", { class: "muted mono" }, rel(item.ts)),
        h("td", {}, h("span", { class: "pill small" }, item.type)),
        h("td", {}, item.label))),
      sess.pending.map((p) => h("tr", {},
        h("td", { class: "muted mono" }, rel(p.startedAt)),
        h("td", {}, h("span", { class: "pill small live" }, "in flight")),
        h("td", {}, p.label))));
  }

  function timelineClick(item) {
    if (!item.ref) return;
    if (callById(item.ref)) return openXray(item.ref);
    selectHttp(item.ref);
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  function select(type, id) {
    ui.sel = { type, id };
    renderGraph();
    renderInspector();
  }
  function openXray(callId) {
    const c = callById(callId);
    ui.callId = callId;
    ui.tab = "xray";
    if (c) ui.sel = { type: "node", id: `llm:${c.provider}/${c.model}` };
    renderAll();
  }
  function selectTool(callId) {
    const inv = snap.session?.tools.find((t) => t.callId === callId);
    if (inv) select("node", `tool:live/${inv.name}`);
  }
  function selectHttp(id) {
    const hc = snap.session?.http.find((x) => x.id === id);
    if (hc) select("node", `http_endpoint:${hc.origin}`);
  }

  function renderAll() {
    renderHeader();
    renderGraph();
    renderInspector();
    renderTabs();
  }

  // Deep links: report.html#node=<id> or #call=<id> opens straight to it.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("node")) ui.sel = { type: "node", id: hash.get("node") };
  if (hash.get("call")) ui.callId = hash.get("call");

  renderAll();

  // ---------------------------------------------------------------------------
  // Live updates (Server-Sent Events)
  // ---------------------------------------------------------------------------
  if (snap.live && location.protocol.startsWith("http")) {
    const es = new EventSource("/events"); // reconnects automatically if dropped
    es.addEventListener("snapshot", (ev) => {
      snap = JSON.parse(ev.data);
      renderAll();
    });
    es.onopen = () => { ui.connected = true; renderHeader(); };
    es.onerror = () => { ui.connected = false; renderHeader(); };
  }
})();
