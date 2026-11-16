/**
 * check/schemaSample.ts — generate a plausible input from a JSON Schema.
 *
 * To health-check a tool we must CALL it, and to call it we need arguments.
 * The tool's inputSchema tells us what's valid, e.g.
 *     { "type": "object",
 *       "properties": { "service": { "type": "string", "enum": ["api","db"] } },
 *       "required": ["service"] }
 * → we generate { "service": "api" }.
 *
 * Strategy: the most BORING valid value, in this priority order:
 *   const → default → examples[0] → enum[0] → a minimal value for the type.
 * And for objects: ONLY required properties. Fewer arguments = fewer ways for
 * our guess to be wrong, and less chance of triggering optional behavior.
 *
 * This is a best effort, not a solver: a schema can demand things we can't
 * satisfy generically (a `pattern` regex, an id that must exist in a DB).
 * So check/mcp.ts treats "invalid params" errors as a WARNING ("our guess
 * was rejected"), not as proof the tool is broken.
 */

// JSON Schema is huge; we model the subset we use. Everything else is ignored.
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  minLength?: number;
  minItems?: number;
  [key: string]: unknown;
}

const MAX_DEPTH = 8; // guards against recursive schemas (a tree node containing tree nodes...)

export function sampleFromSchema(schema: JsonSchema | undefined, root: JsonSchema = schema ?? {}, depth = 0): unknown {
  if (!schema || depth > MAX_DEPTH) return null;

  // $ref: "#/$defs/Address" points elsewhere in the same document.
  if (schema.$ref) return sampleFromSchema(resolveRef(schema.$ref, root), root, depth + 1);

  if ("const" in schema) return schema.const;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  // Composition: anyOf/oneOf = "one of these shapes" → take the first.
  // allOf = "all of these at once" → merge the object parts.
  const alternative = schema.anyOf?.[0] ?? schema.oneOf?.[0];
  if (alternative) return sampleFromSchema(alternative, root, depth + 1);
  if (schema.allOf) {
    const merged: JsonSchema = { type: "object", properties: {}, required: [] };
    for (const part of schema.allOf) {
      const p = part.$ref ? resolveRef(part.$ref, root) ?? {} : part;
      Object.assign(merged.properties!, p.properties);
      merged.required!.push(...(p.required ?? []));
    }
    return sampleFromSchema(merged, root, depth + 1);
  }

  switch (pickType(schema)) {
    case "string":
      return sampleString(schema);
    case "integer": {
      const n = numericFloor(schema);
      return Math.ceil(n);
    }
    case "number":
      return numericFloor(schema);
    case "boolean":
      return false; // "off" is the conservative choice for flags
    case "null":
      return null;
    case "array": {
      const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      const count = schema.minItems ?? 0; // empty array unless at least one is required
      return Array.from({ length: count }, () => sampleFromSchema(itemSchema, root, depth + 1));
    }
    case "object":
    default: {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        out[key] = sampleFromSchema(schema.properties?.[key], root, depth + 1);
      }
      return out;
    }
  }
}

/** `type` may be a list like ["string", "null"]; prefer the non-null one. */
function pickType(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type)) return schema.type.find((t) => t !== "null") ?? schema.type[0];
  if (schema.type) return schema.type;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return undefined;
}

function sampleString(schema: JsonSchema): string {
  switch (schema.format) {
    case "date-time":
      return new Date().toISOString();
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "email":
      return "test@example.com";
    case "uri":
    case "url":
      return "https://example.com";
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
  }
  const base = "test";
  const min = schema.minLength ?? 0;
  return base.length >= min ? base : base.padEnd(min, "x");
}

function numericFloor(schema: JsonSchema): number {
  if (typeof schema.minimum === "number") return schema.minimum;
  // Draft-06+: exclusiveMinimum is a number. (Draft-04: a boolean next to minimum.)
  if (typeof schema.exclusiveMinimum === "number") return schema.exclusiveMinimum + 1;
  if (typeof schema.maximum === "number" && schema.maximum < 0) return schema.maximum;
  return 0;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  // Only local refs ("#/..."). Remote refs would need network access — no.
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    // JSON Pointer escaping: "~1" means "/", "~0" means "~".
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    node = (node as Record<string, unknown> | undefined)?.[key];
  }
  return node as JsonSchema | undefined;
}
