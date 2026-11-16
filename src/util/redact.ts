/**
 * Redaction: keep secrets out of everything agentmap writes or displays.
 *
 * Safety rule: agentmap never sends credentials anywhere, and it also never
 * WRITES them anywhere (event logs, check reports, HTML files). Those files are
 * exactly the kind of thing people paste into bug reports or Slack.
 *
 * We redact by NAME (header names / env var names that look secret), not by
 * value-pattern, because values are unpredictable but names are conventional.
 */

const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key", // Anthropic
  "api-key", // Azure OpenAI
  "x-goog-api-key", // Gemini
  "cookie",
  "set-cookie",
]);

// Env var / field names containing any of these fragments are treated as secret.
const SECRET_NAME_PATTERN = /(key|token|secret|password|passwd|credential|auth|cookie|session)/i;

export function isSecretName(name: string): boolean {
  return SECRET_HEADER_NAMES.has(name.toLowerCase()) || SECRET_NAME_PATTERN.test(name);
}

/** "sk-abc...xyz" → "[redacted · 51 chars]". The length helps spot "empty key" bugs. */
export function redactValue(value: string): string {
  return value.length === 0 ? "[empty]" : `[redacted · ${value.length} chars]`;
}

/** Copy of a header/env map with secret-looking values replaced. */
export function redactRecord(record: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(record)) {
    if (raw === undefined) continue;
    const value = Array.isArray(raw) ? raw.join(", ") : raw;
    out[name] = isSecretName(name) ? redactValue(value) : value;
  }
  return out;
}
