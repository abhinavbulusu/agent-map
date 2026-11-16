/**
 * analyze/xray.ts — Context X-ray: what did the model ACTUALLY receive?
 *
 * Agent bugs are usually data bugs. The model is only as good as the text in
 * its context window, and that text is assembled by your code from many
 * sources. The X-ray takes one model request, splits it into segments by
 * source (system / user / assistant / tool calls / tool results / tool
 * schemas), estimates tokens for each, and flags data that is known to make
 * models fail quietly.
 *
 * Every detector is a HEURISTIC: cheap pattern checks, not understanding.
 * They're tuned to be specific (few false alarms) rather than complete.
 */
import type { NormalizedRequest, NormalizedResponse, Segment, SegmentSource } from "../live/providers.ts";
import { estimateTokens } from "../util/tokens.ts";

export type FlagCode = "empty" | "error_text" | "truncated" | "html" | "base64" | "deep_nesting" | "huge";

export interface XrayFlag {
  code: FlagCode;
  severity: "warn" | "error";
  message: string;
}

export interface XraySegment extends Segment {
  tokens: number;
  flags: XrayFlag[];
}

export interface XRay {
  segments: XraySegment[];
  /** Sum of our per-segment estimates. */
  estimatedTokens: number;
  /** Ground truth from the provider's `usage`, when available. */
  reportedInputTokens?: number;
  bySource: Record<SegmentSource, number>;
  /** Request-level notes (e.g. "context is stored server-side"). */
  notes: string[];
  /** The response was cut off by max tokens. */
  outputTruncated: boolean;
}

export const HUGE_SEGMENT_TOKENS = 20_000;
const MAX_JSON_DEPTH = 6;

export function xrayRequest(req: NormalizedRequest, res?: NormalizedResponse): XRay {
  const bySource: Record<SegmentSource, number> = { system: 0, user: 0, assistant: 0, tool_call: 0, tool_result: 0, tool_schema: 0 };
  const segments = req.segments.map((seg) => {
    const tokens = estimateTokens(seg.text);
    bySource[seg.source] += tokens;
    return { ...seg, tokens, flags: detectFlags(seg, tokens) };
  });
  const xray: XRay = {
    segments,
    estimatedTokens: segments.reduce((n, s) => n + s.tokens, 0),
    bySource,
    notes: [...req.notes],
    outputTruncated: res?.truncated ?? false,
  };
  if (res?.usage?.inputTokens !== undefined) xray.reportedInputTokens = res.usage.inputTokens;
  return xray;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

export function detectFlags(seg: Segment, tokens: number): XrayFlag[] {
  const flags: XrayFlag[] = [];
  // Data-quality checks apply to what came from OUTSIDE the model: tool
  // results and user input. (System prompts and the model's own messages are
  // written by you / by the model.)
  if (seg.source !== "tool_result" && seg.source !== "user") return flags;
  const text = seg.text;
  const isTool = seg.source === "tool_result";

  if (isTool) {
    if (seg.isError) flags.push({ code: "error_text", severity: "error", message: "Tool result is marked as an error" });
    else if (looksLikeError(text)) flags.push({ code: "error_text", severity: "error", message: "Tool result looks like an error message, not data" });

    const empty = emptiness(text);
    if (empty) flags.push({ code: "empty", severity: "error", message: empty });

    // Only for tool data: people end sentences with "..." all the time.
    const cut = truncation(text);
    if (cut) flags.push({ code: "truncated", severity: "warn", message: cut });
  }

  if (looksLikeHtml(text)) flags.push({ code: "html", severity: "warn", message: "Raw HTML: markup noise buries the content (extract text first)" });

  const b64 = base64Blob(text);
  if (b64) flags.push({ code: "base64", severity: "warn", message: `Base64 blob of ~${estimateTokens(b64).toLocaleString("en-US")} tokens: meaningless to the model` });

  const depth = jsonDepth(text);
  if (depth > MAX_JSON_DEPTH) flags.push({ code: "deep_nesting", severity: "warn", message: `JSON nested ${depth} levels deep: models lose track of structure (flatten it)` });

  if (tokens > HUGE_SEGMENT_TOKENS) flags.push({ code: "huge", severity: "warn", message: `~${tokens.toLocaleString("en-US")} tokens in one segment: crowds out everything else` });

  return flags;
}

/**
 * "Effectively empty": not just "", but also shapes like
 *   []  {}  null  {"results": []}  {"city":"Paris","observations":[]}
 * Rule: parsed JSON where every collection (array/object, up to depth 2) is
 * empty, and what's left is at most a few scalar fields (usually an echo of
 * the query, a count of 0, or a status string).
 */
export function emptiness(text: string): string | undefined {
  const t = text.trim();
  if (t === "") return "Tool returned nothing (empty string)";
  if (["null", "none", "undefined", "[]", "{}", '""', "no results", "no results found", "not found"].includes(t.toLowerCase())) {
    return `Tool returned an empty value: ${t}`;
  }
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;

  const emptyKeys: string[] = [];
  let scalarCount = 0;
  let hasData = false;
  const visit = (v: unknown, key: string, depth: number) => {
    if (Array.isArray(v)) {
      if (v.length === 0) emptyKeys.push(key);
      else hasData = true;
    } else if (typeof v === "object" && v !== null) {
      const entries = Object.entries(v);
      if (entries.length === 0) emptyKeys.push(key);
      else if (depth >= 2) hasData = true;
      else for (const [k, child] of entries) visit(child, k, depth + 1);
    } else if (depth <= 1) {
      scalarCount++; // top-level scalar: typically metadata (echoed query, count, status)
    } else {
      hasData = true; // a scalar inside a nested object is real data: {"user": {"name": "A"}}
    }
  };
  visit(value, "(root)", 0);
  if (!hasData && emptyKeys.length > 0 && scalarCount <= 4) {
    return `Tool returned no data: ${emptyKeys.map((k) => (k === "(root)" ? "empty collection" : `"${k}" is empty`)).join(", ")}`;
  }
  return undefined;
}

export function looksLikeError(text: string): boolean {
  const t = text.trim().slice(0, 500);
  if (/^(error|exception|traceback|fatal)\b/i.test(t)) return true;
  // {"error": "..."} or {"error": {...}} — but not {"error": null}.
  // NOTE the \s* is INSIDE the lookahead. Written as `:\s*(?!null)`, the regex
  // engine would backtrack \s* to match zero spaces, then the lookahead sees
  // " null" (with a space), which isn't "null", so the check wrongly passes.
  if (/^\{[\s\S]*"(error|errors|error_message)"\s*:(?!\s*(null|false|\[\s*\]))/i.test(t)) return true;
  if (/\b(internal server error|bad gateway|service unavailable|gateway timeout|rate limit(ed)?|too many requests|unauthorized|forbidden|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/i.test(t)) return true;
  if (/^<!doctype html>[\s\S]{0,300}\b(404|500|502|503|error)\b/i.test(t)) return true;
  return false;
}

export function truncation(text: string): string | undefined {
  // Markers must be at the very END: "...", "[truncated]", "… [1,234 more chars]".
  const tail = text.trimEnd().slice(-80);
  if (/(\.\.\.|…|\[\.\.\.\]|\btruncated\b\W*|\d[\d,]* more (chars|characters|bytes|lines|items|rows)\W*)$/i.test(tail)) {
    return "Ends with a truncation marker: data was cut off before reaching the model";
  }
  const t = text.trim();
  if ((t.startsWith("{") || t.startsWith("[")) && t.length > 20) {
    try {
      JSON.parse(t);
    } catch {
      if (unclosedBrackets(t) > 0) return "JSON is cut off mid-structure (unbalanced brackets)";
    }
  }
  return undefined;
}

function unclosedBrackets(t: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return depth;
}

export function looksLikeHtml(text: string): boolean {
  if (/<!doctype html|<html[\s>]/i.test(text)) return true;
  const tags = text.match(/<\/?(div|span|script|style|table|tr|td|p|a|ul|li|meta|link|head|body|img|section|nav)\b[^>]*>/gi);
  return (tags?.length ?? 0) >= 5;
}

export function base64Blob(text: string): string | undefined {
  const dataUri = /data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{100,}/.exec(text);
  if (dataUri) return dataUri[0];
  // 200+ chars of pure base64 alphabet with no spaces is almost never prose.
  return /[A-Za-z0-9+/]{200,}={0,2}/.exec(text)?.[0];
}

export function jsonDepth(text: string): number {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return 0;
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    return 0;
  }
  const depth = (v: unknown): number => {
    if (Array.isArray(v)) return 1 + Math.max(0, ...v.slice(0, 50).map(depth));
    if (typeof v === "object" && v !== null) return 1 + Math.max(0, ...Object.values(v).slice(0, 50).map(depth));
    return 0;
  };
  return depth(value);
}
