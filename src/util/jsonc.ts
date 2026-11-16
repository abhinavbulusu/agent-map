/**
 * JSONC ("JSON with Comments") parsing.
 *
 * VS Code's config files (including .vscode/mcp.json) allow // line comments,
 * /* block comments *\/ and trailing commas. JSON.parse rejects all three, so
 * we strip them first.
 *
 * The subtle part: comment markers INSIDE STRINGS must survive. A URL like
 * "https://example.com" contains "//", and a naive regex would cut it in half.
 * So we walk the text character by character and track whether we're inside
 * a string (and whether the previous character was a backslash escape).
 * This is a tiny "lexer" — the first stage of every parser.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Copy the escaped character verbatim, so \" doesn't end the string.
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
    } else if (ch === "/" && next === "/") {
      // Line comment: skip to end of line (keep the newline for line numbers).
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      // Block comment: skip to the closing */.
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }

  // Trailing commas (`[1, 2,]`). A regex like /,\s*}/ would also hit the text
  // "a,}" INSIDE a string, so this needs the same string-aware walk.
  return removeTrailingCommas(out);
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      // Look ahead past whitespace: if the next real char closes a container, drop the comma.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/** JSON.parse that accepts comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}
