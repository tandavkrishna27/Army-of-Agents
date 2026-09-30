// -----------------------------------------------------------------------------
// yaml-lite — a focused, dependency-free YAML parser for the DEP-002 D1 compose
// topology validator.
//
// WHY a bespoke parser (and not js-yaml / yaml): neither `js-yaml` nor `yaml` is
// resolvable from a repository-root ESM script under this pnpm workspace (both are
// pnpm-isolated / transitive), and the DEP-002 static lane (`node
// scripts/check-d1-compose.mjs`) MUST run with zero new dependencies and no
// manifest change (frozen lockfile). This parser handles EXACTLY the YAML subset
// authored in `docker-compose.d1.yml`:
//   * 2-space block indentation, no tabs
//   * block mappings (`key:` / `key: value`)
//   * block sequences of scalars (`- item`)
//   * inline flow sequences (`[a, b, c]`) and inline flow mappings (`{a: b}`)
//   * double/single-quoted and bare scalars, booleans, and integers
//   * full-line (`# …`) and quote-aware inline (` # …`) comments
// It deliberately does NOT support anchors/aliases, block scalars (`|` / `>`),
// multi-document streams, or sequences-of-mappings — none of which appear in the
// authored compose file. It is authoritative ONLY for that file; the live CI lane
// still validates the same file with the real `docker compose` engine.
// -----------------------------------------------------------------------------

/** Strip a quote-aware trailing inline comment (` # …`) from a single line. A `#`
 * inside quotes or brackets, or not preceded by whitespace, is preserved. */
function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble && (ch === "[" || ch === "{")) depth++;
    else if (!inSingle && !inDouble && (ch === "]" || ch === "}")) depth = Math.max(0, depth - 1);
    else if (ch === "#" && !inSingle && !inDouble && depth === 0) {
      const prev = line[i - 1];
      if (i === 0 || prev === " " || prev === "\t") return line.slice(0, i);
    }
  }
  return line;
}

/** Split a flow list body on TOP-LEVEL commas (respecting quotes + nesting). */
function splitTopLevel(body) {
  const parts = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; cur += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; cur += ch; continue; }
    if (!inSingle && !inDouble && (ch === "[" || ch === "{")) { depth++; cur += ch; continue; }
    if (!inSingle && !inDouble && (ch === "]" || ch === "}")) { depth--; cur += ch; continue; }
    if (ch === "," && !inSingle && !inDouble && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "" || parts.length > 0) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === "") return null;
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  return s;
}

/** Parse an inline (single-line) value: flow seq, flow map, or scalar. */
function parseInlineValue(raw) {
  const s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    return splitTopLevel(s.slice(1, -1)).map((e) => parseInlineValue(e));
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const obj = {};
    for (const entry of splitTopLevel(s.slice(1, -1))) {
      const idx = entry.indexOf(":");
      if (idx === -1) continue;
      obj[parseScalar(entry.slice(0, idx))] = parseInlineValue(entry.slice(idx + 1));
    }
    return obj;
  }
  return parseScalar(s);
}

/**
 * Parse a YAML document (of the supported subset) into a plain JS value.
 * @param {string} text
 * @returns {any}
 */
export function parseYaml(text) {
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.includes("\t")) {
      throw new Error(`yaml-lite: tabs are not supported (line: ${JSON.stringify(rawLine)})`);
    }
    if (/^\s*#/.test(rawLine) || /^\s*$/.test(rawLine)) continue;
    const indent = rawLine.match(/^ */)[0].length;
    const content = stripInlineComment(rawLine.slice(indent)).replace(/\s+$/, "");
    if (content === "") continue;
    lines.push({ indent, content });
  }

  let pos = 0;

  function parseBlock() {
    return lines[pos].content.startsWith("- ") || lines[pos].content === "-"
      ? parseSeq(lines[pos].indent)
      : parseMap(lines[pos].indent);
  }

  function parseMap(indent) {
    const obj = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const { content } = lines[pos];
      if (content.startsWith("- ")) break;
      const colon = content.indexOf(":");
      if (colon === -1) {
        throw new Error(`yaml-lite: expected 'key:' mapping, got ${JSON.stringify(content)}`);
      }
      const key = parseScalar(content.slice(0, colon));
      const rest = content.slice(colon + 1).trim();
      pos++;
      if (rest !== "") {
        obj[key] = parseInlineValue(rest);
      } else if (pos < lines.length && lines[pos].indent > indent) {
        obj[key] = parseBlock();
      } else {
        obj[key] = null;
      }
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].content.startsWith("- ") || lines[pos].content === "-")) {
      const item = lines[pos].content === "-" ? "" : lines[pos].content.slice(2).trim();
      pos++;
      if (item === "" && pos < lines.length && lines[pos].indent > indent) {
        arr.push(parseBlock());
      } else {
        arr.push(parseInlineValue(item));
      }
    }
    return arr;
  }

  if (lines.length === 0) return null;
  return parseBlock();
}
