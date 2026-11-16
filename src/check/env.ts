/**
 * check/env.ts — environment variables: find references, resolve, check.
 *
 * MCP configs rarely contain secrets directly; they REFERENCE them:
 *     "env": { "WEATHER_API_KEY": "${WEATHER_API_KEY}" }
 * The MCP client (Claude Code, Cursor, ...) substitutes the value from its own
 * environment when it starts the server. If the variable isn't set, the
 * server usually crashes at startup — one of the most common "my MCP server
 * shows as failed" causes. So we:
 *   1. find every reference in a server's config   (findEnvRefs)
 *   2. look each one up in process.env, then .env  (checkEnvRefs)
 *   3. substitute values when we spawn the server  (interpolate)
 *
 * Safety: we only ever report PRESENCE ("set" / "missing"), never values.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import type { Issue, Status } from "../graph.ts";

/** Which MCP client wrote the config. Each one interpolates differently. */
export type ClientId = "claude-code" | "cursor" | "vscode" | "claude-desktop" | "cursor-global";

export interface EnvRef {
  /** Variable name, e.g. "WEATHER_API_KEY" (or the input id for ${input:...}). */
  name: string;
  /** dollar = ${VAR}, env = ${env:VAR}, input = ${input:id} (VS Code prompt). */
  syntax: "dollar" | "env" | "input";
  /** From ${VAR:-default}. */
  defaultValue?: string;
  /** Where in the config we saw it, e.g. "env.WEATHER_API_KEY" or "args[2]". */
  location: string;
  /** False if this client does NOT expand this syntax (it gets passed literally!). */
  supported: boolean;
}

// Which syntaxes each client actually expands.
const SUPPORTED_SYNTAX: Record<ClientId, ReadonlySet<EnvRef["syntax"]>> = {
  "claude-code": new Set(["dollar"]),
  cursor: new Set(["env"]),
  "cursor-global": new Set(["env"]),
  vscode: new Set(["env", "input"]),
  "claude-desktop": new Set(), // Claude Desktop does no interpolation at all.
};

// Editor-provided variables like ${workspaceFolder}. These look exactly like
// ${VAR} env references, so we must recognize them FIRST — otherwise we'd
// report "env var workspaceFolder is missing", which would be nonsense.
const BUILTIN_VARIABLES = new Set(["workspaceFolder", "workspaceFolderBasename", "userHome", "pathSeparator", "/"]);

// One regex for all syntaxes:
//   ${input:ID} | ${env:NAME} | ${NAME} | ${NAME:-default}
// Groups: 1=input id, 2="env:" prefix, 3=name, 4=default value.
const REF_PATTERN = /\$\{(?:input:([^}]+)|(env:)?([A-Za-z_/][A-Za-z0-9_]*)(?::-([^}]*))?)\}/g;

/** Find all env references inside one config string. */
export function findEnvRefs(value: string, location: string, client: ClientId): EnvRef[] {
  const refs: EnvRef[] = [];
  for (const m of value.matchAll(REF_PATTERN)) {
    const [, inputId, envPrefix, name, defaultValue] = m;
    let ref: Omit<EnvRef, "supported">;
    if (inputId !== undefined) {
      ref = { name: inputId, syntax: "input", location };
    } else if (name !== undefined) {
      if (!envPrefix && BUILTIN_VARIABLES.has(name)) continue;
      ref = { name, syntax: envPrefix ? "env" : "dollar", location };
      if (defaultValue !== undefined) ref.defaultValue = defaultValue;
    } else {
      continue;
    }
    refs.push({ ...ref, supported: SUPPORTED_SYNTAX[client].has(ref.syntax) });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// .env files
// ---------------------------------------------------------------------------

/**
 * Minimal .env parser: KEY=value lines, optional `export ` prefix, # comments,
 * single/double quotes. (The popular `dotenv` package does the same plus
 * multi-line values; not worth a dependency for us.)
 */
export function parseDotEnv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: strip an inline " # comment".
      value = value.replace(/\s+#.*$/, "");
    }
    vars[m[1]!] = value;
  }
  return vars;
}

export function loadDotEnv(dir: string): Record<string, string> {
  try {
    return parseDotEnv(readFileSync(join(dir, ".env"), "utf8"));
  } catch {
    return {}; // no .env file is perfectly normal
  }
}

// ---------------------------------------------------------------------------
// Resolution + checking
// ---------------------------------------------------------------------------

export interface EnvContext {
  processEnv: Record<string, string | undefined>;
  dotenv: Record<string, string>;
  workspaceFolder: string;
}

export interface EnvCheck {
  name: string;
  syntax: EnvRef["syntax"];
  status: Status;
  /** Where the value would come from. */
  source: "process" | "dotenv" | "default" | "missing" | "prompt" | "literal";
  issues: Issue[];
  locations: string[];
}

/** Check each distinct referenced variable. Never includes values. */
export function checkEnvRefs(refs: EnvRef[], ctx: EnvContext, client: ClientId): EnvCheck[] {
  // Group by variable: the same var can be referenced in env AND args.
  const byName = new Map<string, EnvRef[]>();
  for (const ref of refs) byName.set(ref.name, [...(byName.get(ref.name) ?? []), ref]);

  const results: EnvCheck[] = [];
  for (const [name, group] of byName) {
    const first = group[0]!;
    const locations = group.map((r) => r.location);
    const base = { name, syntax: first.syntax, locations };

    if (!first.supported) {
      results.push({
        ...base,
        status: "warn",
        source: "literal",
        issues: [
          {
            severity: "warn",
            code: "interpolation_unsupported",
            message: `${clientName(client)} does not expand "${refText(first)}" — the server receives that text literally`,
            hint:
              client === "claude-desktop"
                ? "Claude Desktop has no ${VAR} support: put the real value in the env block (and keep that file private)."
                : `Use ${client.startsWith("cursor") || client === "vscode" ? "${env:" + name + "}" : "${" + name + "}"} syntax.`,
          },
        ],
      });
      continue;
    }

    if (first.syntax === "input") {
      results.push({
        ...base,
        status: "unknown",
        source: "prompt",
        issues: [],
      });
      continue;
    }

    const fromProcess = ctx.processEnv[name];
    if (fromProcess !== undefined && fromProcess !== "") {
      results.push({ ...base, status: "ok", source: "process", issues: [] });
    } else if (ctx.dotenv[name]) {
      results.push({
        ...base,
        status: "warn",
        source: "dotenv",
        issues: [
          {
            severity: "warn",
            code: "env_only_in_dotenv",
            message: `${name} is only set in .env`,
            hint: "MCP clients don't read .env files — export it in your shell profile, or the client won't see it.",
          },
        ],
      });
    } else if (first.defaultValue !== undefined) {
      results.push({ ...base, status: "ok", source: "default", issues: [] });
    } else {
      results.push({
        ...base,
        status: "error",
        source: "missing",
        issues: [
          {
            severity: "error",
            code: "env_missing",
            message: `${name} is not set${fromProcess === "" ? " (it's an empty string)" : ""}`,
            hint: `export ${name}=... in the shell that launches ${clientName(client)}, or add it to .env`,
          },
        ],
      });
    }
  }
  return results;
}

/** Issues with LITERAL env values written straight into the config. */
export function checkLiteralEnv(env: Record<string, string>): Issue[] {
  const issues: Issue[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value.includes("${")) continue; // a reference, handled by checkEnvRefs
    if (value.trim() === "") {
      issues.push({ severity: "warn", code: "env_empty", message: `env.${name} is set to an empty string` });
    } else if (/^(your[-_ ]|<.*>$|x{3,}|changeme|replace[-_ ]?me|todo\b|insert[-_ ])/i.test(value.trim())) {
      issues.push({
        severity: "error",
        code: "env_placeholder",
        message: `env.${name} still contains a placeholder value`,
        hint: "Replace the copy-pasted placeholder with a real value.",
      });
    }
  }
  return issues;
}

/**
 * Substitute variables in a config string, the way the MCP client would.
 * Unresolvable references are reported (and replaced with "").
 */
export function interpolate(value: string, ctx: EnvContext, client: ClientId): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = value.replace(REF_PATTERN, (whole, inputId?: string, envPrefix?: string, name?: string, def?: string) => {
    if (inputId !== undefined) {
      unresolved.push(`input:${inputId}`);
      return "";
    }
    if (name === undefined) return whole;
    if (!envPrefix && BUILTIN_VARIABLES.has(name)) {
      switch (name) {
        case "workspaceFolder":
          return ctx.workspaceFolder;
        case "workspaceFolderBasename":
          return basename(ctx.workspaceFolder);
        case "userHome":
          return homedir();
        default:
          return sep; // ${pathSeparator} and ${/}
      }
    }
    // Faithfulness: if this client doesn't expand the syntax, neither do we.
    if (!SUPPORTED_SYNTAX[client].has(envPrefix ? "env" : "dollar")) return whole;
    const resolved = ctx.processEnv[name] || ctx.dotenv[name] || def;
    if (resolved === undefined) {
      unresolved.push(name);
      return "";
    }
    return resolved;
  });
  return { value: out, unresolved };
}

export function clientName(client: ClientId): string {
  switch (client) {
    case "claude-code":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "cursor-global":
      return "Cursor (global)";
    case "vscode":
      return "VS Code";
    case "claude-desktop":
      return "Claude Desktop";
  }
}

function refText(ref: EnvRef): string {
  if (ref.syntax === "input") return "${input:" + ref.name + "}";
  return ref.syntax === "env" ? "${env:" + ref.name + "}" : "${" + ref.name + "}";
}
