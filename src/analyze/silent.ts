/**
 * analyze/silent.ts — silent failures and source tracing.
 *
 * A "silent failure" is when nothing errors, yet the answer is wrong:
 *   1. a tool failed or returned nothing, and the model answered anyway,
 *      without telling the user anything went wrong;
 *   2. the answer states specific facts that appear in NO input — the model
 *      made them up (or they came from training data, which for "current
 *      weather" or "your account balance" is just as wrong).
 *
 * SOURCE TRACING: extract checkable claims from the answer (numbers,
 * percentages, money, URLs, emails, ISO dates/times, quoted strings), then
 * search for each one in the model's inputs. Found → we can show WHERE it
 * came from (which tool result). Not found → "ungrounded".
 *
 * Limits (be honest about them): this checks surface forms, not meaning. It
 * can't verify "it will rain tomorrow", and a number that appears in a tool
 * result for an unrelated reason counts as grounded. It's a smoke detector,
 * not a fact-checker — and smoke detectors are very useful.
 */
import type { NormalizedResponse, Segment, SegmentSource } from "../live/providers.ts";
import type { XraySegment } from "./xray.ts";

export type ClaimKind = "number" | "percent" | "money" | "temperature" | "measure" | "url" | "email" | "date" | "time" | "quote";

export interface ClaimSource {
  segmentIndex: number;
  source: SegmentSource;
  toolName?: string;
  /** A little context around the match, for display. */
  snippet: string;
}

export interface ClaimTrace {
  text: string;
  kind: ClaimKind;
  /** Character offset in the answer (lets the UI highlight it). */
  start: number;
  grounded: boolean;
  sources: ClaimSource[];
}

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

interface RawClaim {
  text: string;
  kind: ClaimKind;
  start: number;
  /** What we search the inputs for. */
  needle: string | RegExp;
}

const UNIT = String.raw`(?:°\s?[CF]|°|%|km/h|mph|m/s|km|mi|kg|lbs?|ms|GB|MB|KB|TB|USD|EUR|GBP)`;

export function extractClaims(answer: string): RawClaim[] {
  const claims: RawClaim[] = [];
  const taken: [number, number][] = []; // spans already claimed (avoid double-counting)
  const add = (m: RegExpMatchArray, kind: ClaimKind, needle: string | RegExp) => {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (taken.some(([s, e]) => start < e && end > s)) return;
    taken.push([start, end]);
    claims.push({ text: m[0], kind, start, needle });
  };

  // Order matters: specific patterns first, so "https://x.com/2024" isn't read as a number.
  for (const m of answer.matchAll(/https?:\/\/[^\s)<>"'\]]+[^\s)<>"'\].,;:!?]/g)) add(m, "url", m[0]);
  for (const m of answer.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+\w/g)) add(m, "email", m[0]);
  for (const m of answer.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) add(m, "date", m[0]);
  for (const m of answer.matchAll(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g)) add(m, "time", m[0]);
  for (const m of answer.matchAll(/"([^"\n]{3,80})"|“([^”\n]{3,80})”/g)) add(m, "quote", (m[1] ?? m[2])!);

  // Numbers, with optional currency prefix and unit suffix. The lookbehind/
  // lookahead stop us matching the "4" in "gpt-4o" or the "2" in "v2".
  const numberPattern = new RegExp(String.raw`(?<![\w.\-/])([$€£])?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?${UNIT})?(?![\w])`, "g");
  for (const m of answer.matchAll(numberPattern)) {
    const [, currency, intPart, frac, unit] = m;
    const value = (intPart ?? "").replace(/,/g, "") + (frac ?? "");
    // Skip bare single digits ("1.", "3 steps") — too common to be meaningful claims.
    if (!currency && !unit && !frac && value.length < 2) continue;
    const u = (unit ?? "").trim();
    const kind: ClaimKind = currency ? "money" : u === "%" ? "percent" : u.startsWith("°") ? "temperature" : u ? "measure" : "number";
    add(m, kind, numberNeedle(value));
  }
  return claims.sort((a, b) => a.start - b.start);
}

/**
 * Match the NUMBER, not the formatting: 18 should be found in `"temp": 18`,
 * `18.0`, or `18°C`; 1200 should match `1,200`.
 */
function numberNeedle(value: string): RegExp {
  const [int, frac] = value.split(".");
  const intWithCommas = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",?");
  const fracPart = frac ? String.raw`\.${frac}0*` : String.raw`(?:\.0+)?`;
  return new RegExp(String.raw`(?<![\d.])${intWithCommas}${fracPart}(?![\d])`);
}

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

/** Sources that count as evidence. The model's own earlier messages do NOT. */
const EVIDENCE: ReadonlySet<SegmentSource> = new Set(["tool_result", "user", "system"]);

export function traceClaims(answer: string, segments: Segment[]): ClaimTrace[] {
  return extractClaims(answer).map((claim) => {
    const sources: ClaimSource[] = [];
    segments.forEach((seg, segmentIndex) => {
      if (!EVIDENCE.has(seg.source)) return;
      const at = find(seg.text, claim.needle);
      if (at === -1) return;
      const src: ClaimSource = { segmentIndex, source: seg.source, snippet: seg.text.slice(Math.max(0, at - 40), at + 60).replace(/\s+/g, " ") };
      if (seg.toolName) src.toolName = seg.toolName;
      sources.push(src);
    });
    return { text: claim.text, kind: claim.kind, start: claim.start, grounded: sources.length > 0, sources };
  });
}

function find(haystack: string, needle: string | RegExp): number {
  if (typeof needle === "string") return haystack.toLowerCase().indexOf(needle.toLowerCase());
  return needle.exec(haystack)?.index ?? -1;
}

// ---------------------------------------------------------------------------
// Silent failures
// ---------------------------------------------------------------------------

export interface SilentFinding {
  severity: "warn" | "error";
  code: "answered_after_tool_failure" | "answered_after_empty_tool" | "ungrounded_claims" | "unsourced_specifics";
  message: string;
  hint: string;
  toolCallIds: string[];
  claims: string[];
}

/** Phrases that show the model told the user something went wrong. */
const ACKNOWLEDGES_PROBLEM =
  /\b(couldn'?t|could not|unable|wasn'?t able|was not able|no (data|results|information|records)|not available|unavailable|failed|error|sorry|don'?t have|do not have|cannot|can'?t|isn'?t available|not (find|found|retrieve))\b/i;

/**
 * Analyze ONE model call that produced a final answer (text, no tool calls).
 * "This turn" = everything after the last user message: those are the tool
 * results the answer should be built on.
 */
export function detectSilentFailures(segments: XraySegment[], response: NormalizedResponse, traces: ClaimTrace[]): SilentFinding[] {
  if (!response.text.trim() || response.toolCalls.length > 0) return [];

  const lastUser = segments.map((s) => s.source).lastIndexOf("user");
  const turnResults = segments.filter((s, i) => i > lastUser && s.source === "tool_result");
  const failed = turnResults.filter((s) => s.flags.some((f) => f.code === "error_text"));
  const empty = turnResults.filter((s) => s.flags.some((f) => f.code === "empty"));
  const acknowledged = ACKNOWLEDGES_PROBLEM.test(response.text);
  const ungrounded = traces.filter((t) => !t.grounded);
  const toolsOffered = segments.some((s) => s.source === "tool_schema");

  const findings: SilentFinding[] = [];
  const names = (segs: XraySegment[]) => [...new Set(segs.map((s) => s.toolName ?? "?"))].join(", ");
  const ids = (segs: XraySegment[]) => segs.map((s) => s.toolCallId ?? "").filter(Boolean);

  if (failed.length && !acknowledged) {
    findings.push({
      severity: "error",
      code: "answered_after_tool_failure",
      message: `Answered as if nothing went wrong, but ${names(failed)} failed this turn`,
      hint: "Check tool results in your agent loop, and tell the model (or the user) when a tool fails.",
      toolCallIds: ids(failed),
      claims: [],
    });
  }
  if (empty.length && !acknowledged) {
    findings.push({
      severity: "error",
      code: "answered_after_empty_tool",
      message: `Answered confidently, but ${names(empty)} returned no data`,
      hint: "Detect empty results in the tool and return an explicit message like \"no data found\" — models fill silence with guesses.",
      toolCallIds: ids(empty),
      claims: [],
    });
  }
  if (ungrounded.length) {
    const hadProblem = failed.length + empty.length > 0;
    findings.push({
      severity: hadProblem ? "error" : "warn",
      code: turnResults.length === 0 && toolsOffered ? "unsourced_specifics" : "ungrounded_claims",
      message:
        `${ungrounded.length} specific claim${ungrounded.length === 1 ? "" : "s"} appear in no tool output or user input: ` +
        ungrounded.slice(0, 6).map((t) => `"${t.text}"`).join(", ") +
        (turnResults.length === 0 && toolsOffered ? " (no tools were called this turn)" : ""),
      hint: hadProblem
        ? "These were most likely invented to fill the gap left by the failed/empty tool."
        : "Verify these: they may come from the model's training data rather than live data.",
      toolCallIds: [],
      claims: ungrounded.map((t) => t.text),
    });
  }
  return findings;
}
