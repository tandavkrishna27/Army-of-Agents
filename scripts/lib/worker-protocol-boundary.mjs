/**
 * worker-protocol-boundary.mjs — pure, dependency-free boundary logic.
 *
 * This module holds ALL parsing and import-policy validation for the
 * `@armyofagents/worker-protocol` leaf package. It performs NO filesystem I/O:
 * the command wrapper `scripts/check-worker-protocol-boundary.mjs` supplies the
 * bytes (manifest JSON, source text, directory listings) and this module
 * decides what is allowed.
 *
 * "Dependency-free" means no npm dependency and no AoA package import — only the
 * Node standard `node:path` builtin for pure path arithmetic (no reads).
 *
 * The module-specifier extractor and the forbidden-global detector are built on
 * a single small lexical scanner (`tokenizeSource`) that understands line and
 * block comments, single/double-quoted strings (with escapes), template
 * literals (including `${…}` interpolation and nesting), and regular-expression
 * literals. Because it tokenizes rather than regex-matches raw text, a
 * specifier- or global-looking sequence inside a comment, a string, or a
 * template's literal text is never mistaken for real code, and multiline
 * `import`/`export` statements are handled correctly.
 *
 * Runtime source (files under `packages/worker-protocol/src`, excluding
 * `*.test.ts`) may import ONLY `zod` or a relative path that normalizes inside
 * the package `src` directory. Everything else — Node builtins, `node:*`,
 * other AoA packages, any other bare package, `.test` sources, and relative
 * escapes — fails. Runtime source is `.ts` only; alternate extensions and
 * symlinks are rejected by the command wrapper via the classifier below.
 */

import path from "node:path";

/** Runtime dependencies the package manifest is permitted to declare. */
export const REQUIRED_RUNTIME_DEPENDENCIES = ["zod"];

/** The package's required name. */
export const EXPECTED_PACKAGE_NAME = "@armyofagents/worker-protocol";

/**
 * Bare identifiers that denote Node/runtime globals. Using any of them as a
 * value (i.e. not as a `.member` access) is forbidden in runtime source.
 */
export const FORBIDDEN_GLOBAL_WORDS = new Set([
  "process",
  "Buffer",
  "globalThis",
  "global",
  "Deno",
  "Bun",
  "__dirname",
  "__filename",
]);

/**
 * Alternate runtime-source file extensions that must never appear under `src`.
 * Runtime source is `.ts` only (test source is `.test.ts`, excluded from tsc).
 * Ordered so `.d.ts` is matched before a bare `.ts`.
 */
const ALTERNATE_EXTENSION_RE = /\.(?:d\.ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** A relative specifier that points at a `.test` module (any JS/TS variant). */
const TEST_SPECIFIER_RE = /\.test(?:\.[cm]?[jt]s)?$/;

/**
 * Keywords after which a `/` begins a regular-expression literal rather than a
 * division operator. Used to disambiguate the scanner.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "else",
  "do",
  "yield",
  "await",
  "case",
]);

const isIdStart = (c) => c === "_" || c === "$" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isIdPart = (c) => isIdStart(c) || (c >= "0" && c <= "9");
const isDigit = (c) => c >= "0" && c <= "9";
const isWhitespace = (c) =>
  c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v";

/**
 * Classify a filename found under `src`.
 * @returns {"alternate-extension"|"test"|"runtime"|"other"}
 */
export function classifyRuntimeSourceFileName(name) {
  if (ALTERNATE_EXTENSION_RE.test(name)) return "alternate-extension";
  if (name.endsWith(".test.ts")) return "test";
  if (name.endsWith(".ts")) return "runtime";
  return "other";
}

/**
 * Tokenize JS/TS source into the minimal token stream the boundary logic needs.
 * Comments and the literal text of strings/templates/regexes are consumed but
 * never emitted as code tokens. Code inside a template interpolation `${…}`
 * IS scanned (so `${process}` still yields a `process` word token).
 *
 * Token shapes:
 *   { type: "word", value }            — an identifier or keyword
 *   { type: "punct", value }           — one of ( ) { } . , ; *
 *   { type: "string", value }          — a quoted string, or a template with
 *                                        no interpolation; value is its content
 *   { type: "template" }               — marker for a template WITH interpolation
 *
 * @param {string} source
 * @returns {Array<{type:string, value?:string}>}
 */
export function tokenizeSource(source) {
  const n = source.length;
  const tokens = [];
  let i = 0;
  // Mode stack. Base frame is top-level code. `${` pushes an interpolation code
  // frame (tracks its own brace depth); a backtick pushes a template-text frame.
  const stack = [{ mode: "code", interp: false, braceDepth: 0 }];
  // Tracks whether a `/` should be read as a regex (true) or division (false),
  // based on the previous significant code element.
  let regexAllowed = true;

  const top = () => stack[stack.length - 1];

  function readString(quote) {
    // `i` is at the opening quote.
    i += 1;
    let value = "";
    while (i < n) {
      const ch = source[i];
      if (ch === "\\") {
        // Preserve termination correctness; append the escaped char literally.
        // Runtime specifiers never use escapes, so imperfect decoding of an
        // obfuscated specifier only makes it look non-`zod`/non-relative — i.e.
        // it fails closed.
        if (i + 1 < n) value += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        i += 1;
        break;
      }
      if (ch === "\n") break; // unterminated single-line string
      value += ch;
      i += 1;
    }
    tokens.push({ type: "string", value });
    regexAllowed = false;
  }

  function readLineComment() {
    i += 2;
    while (i < n && source[i] !== "\n") i += 1;
  }

  function readBlockComment() {
    i += 2;
    while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
    i += 2;
  }

  function readRegex() {
    // `i` is at the opening `/`.
    i += 1;
    let inClass = false;
    while (i < n) {
      const ch = source[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n") break; // unterminated
      if (ch === "[") {
        inClass = true;
      } else if (ch === "]") {
        inClass = false;
      } else if (ch === "/" && !inClass) {
        i += 1;
        break;
      }
      i += 1;
    }
    // flags
    while (i < n && isIdPart(source[i])) i += 1;
    regexAllowed = false;
  }

  while (i < n) {
    const frame = top();

    if (frame.mode === "template") {
      const ch = source[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        // End of this template. The template's overall token was already
        // emitted when it opened, so just pop.
        i += 1;
        stack.pop();
        regexAllowed = false;
        continue;
      }
      if (ch === "$" && source[i + 1] === "{") {
        i += 2;
        stack.push({ mode: "code", interp: true, braceDepth: 0 });
        regexAllowed = true;
        continue;
      }
      // ordinary template text char — consumed, not emitted
      i += 1;
      continue;
    }

    // code mode
    const c = source[i];

    if (isWhitespace(c)) {
      i += 1;
      continue;
    }

    if (c === "/" && source[i + 1] === "/") {
      readLineComment();
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      readBlockComment();
      continue;
    }
    if (c === "/" && regexAllowed) {
      readRegex();
      continue;
    }

    if (c === '"' || c === "'") {
      readString(c);
      continue;
    }

    if (c === "`") {
      // A template literal. If it contains no interpolation it behaves like a
      // string; we decide that by scanning ahead cheaply. To keep a single
      // pass, emit a marker now and let the template-text frame consume the
      // body; interpolation (if any) yields real code tokens inside `${…}`.
      // We look ahead once to label the marker precisely.
      tokens.push(templateToken(source, i));
      i += 1;
      stack.push({ mode: "template" });
      regexAllowed = true;
      continue;
    }

    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(source[j])) j += 1;
      const word = source.slice(i, j);
      tokens.push({ type: "word", value: word });
      i = j;
      regexAllowed = REGEX_PRECEDING_KEYWORDS.has(word);
      continue;
    }

    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && (isIdPart(source[j]) || source[j] === ".")) j += 1;
      i = j;
      regexAllowed = false;
      continue;
    }

    // punctuation
    if (c === "(" || c === "{" || c === "[" || c === ",") {
      if (c === "{" && frame.interp) frame.braceDepth += 1;
      if (c === "(" || c === "{" || c === "," || c === "[") {
        if (c !== "[") tokens.push({ type: "punct", value: c });
      }
      i += 1;
      regexAllowed = true;
      continue;
    }
    if (c === "}") {
      if (frame.interp && frame.braceDepth === 0) {
        stack.pop(); // close the `${…}` interpolation, back to template text
        i += 1;
        regexAllowed = false;
        continue;
      }
      if (frame.interp) frame.braceDepth -= 1;
      tokens.push({ type: "punct", value: c });
      i += 1;
      regexAllowed = false;
      continue;
    }
    if (c === ")" || c === "]") {
      if (c === ")") tokens.push({ type: "punct", value: c });
      i += 1;
      regexAllowed = false;
      continue;
    }
    if (c === "." || c === ";" || c === "*") {
      tokens.push({ type: "punct", value: c });
      i += 1;
      regexAllowed = c !== "."; // after `.` a `/` cannot start a regex
      continue;
    }

    // any other operator/punctuation: not emitted, but resets regex context
    // (after most operators a `/` is a regex start).
    i += 1;
    regexAllowed = true;
  }

  return tokens;
}

/** Decide whether a `` `…` `` at position `start` contains a `${` interpolation. */
function templateToken(source, start) {
  const n = source.length;
  let i = start + 1;
  while (i < n) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return { type: "string", value: source.slice(start + 1, i) };
    if (ch === "$" && source[i + 1] === "{") return { type: "template" };
    i += 1;
  }
  return { type: "string", value: source.slice(start + 1, i) };
}

/**
 * Extract every module specifier introduced by a real `import`/`export`
 * statement or a literal dynamic `import(...)`.
 * @param {string} source
 * @returns {Array<{value: string|null, kind: string, nonLiteral?: boolean}>}
 */
export function extractModuleSpecifiers(source) {
  const tokens = tokenizeSource(source);
  const out = [];
  const isWord = (t, v) => t && t.type === "word" && t.value === v;
  const isPunct = (t, v) => t && t.type === "punct" && t.value === v;

  for (let j = 0; j < tokens.length; j += 1) {
    const tk = tokens[j];
    if (tk.type === "word" && tk.value === "import") {
      const next = tokens[j + 1];
      if (isPunct(next, "(")) {
        const arg = tokens[j + 2];
        if (arg && arg.type === "string") out.push({ value: arg.value, kind: "dynamic" });
        else out.push({ value: null, kind: "dynamic", nonLiteral: true });
        continue;
      }
      if (isPunct(next, ".")) continue; // import.meta
      if (next && next.type === "string") {
        out.push({ value: next.value, kind: "side-effect" });
        continue;
      }
      // static import: scan forward for `from "<spec>"`
      for (let k = j + 1; k < tokens.length; k += 1) {
        const t2 = tokens[k];
        if (isPunct(t2, ";")) break;
        if (t2.type === "word" && (t2.value === "import" || t2.value === "export") && k !== j) break;
        if (isWord(t2, "from")) {
          const s = tokens[k + 1];
          if (s && s.type === "string") out.push({ value: s.value, kind: "static" });
          else if (s && s.type === "template") out.push({ value: null, kind: "static", nonLiteral: true });
          break;
        }
      }
      continue;
    }
    if (tk.type === "word" && tk.value === "export") {
      for (let k = j + 1; k < tokens.length; k += 1) {
        const t2 = tokens[k];
        if (isPunct(t2, ";")) break;
        if (t2.type === "word" && (t2.value === "import" || t2.value === "export")) break;
        if (isWord(t2, "from")) {
          const s = tokens[k + 1];
          if (s && s.type === "string") out.push({ value: s.value, kind: "export" });
          else if (s && s.type === "template") out.push({ value: null, kind: "export", nonLiteral: true });
          break;
        }
      }
      continue;
    }
  }
  return out;
}

/**
 * Find every use of a forbidden Node/runtime global (as a value, not a
 * `.member`) and every CommonJS `require(...)` / `module.require(...)` call.
 * @param {string} source
 * @returns {string[]} the offending global names / call forms, in order
 */
export function findForbiddenGlobals(source) {
  const tokens = tokenizeSource(source);
  const found = [];
  for (let j = 0; j < tokens.length; j += 1) {
    const tk = tokens[j];
    if (tk.type !== "word") continue;
    const prev = tokens[j - 1];
    const next = tokens[j + 1];
    if (tk.value === "require" && next && next.type === "punct" && next.value === "(") {
      found.push("require(");
      continue;
    }
    if (FORBIDDEN_GLOBAL_WORDS.has(tk.value)) {
      // Allow `foo.process` (member access); forbid a bare global value.
      if (prev && prev.type === "punct" && prev.value === ".") continue;
      found.push(tk.value);
    }
  }
  return found;
}

/**
 * Validate the imports of a single runtime source file.
 * @param {{relPath:string, absPath:string, sourceRoot:string, source:string}} args
 * @returns {string[]} policy-violation messages (empty ⇒ clean)
 */
export function evaluateRuntimeSourceImports({ relPath, absPath, sourceRoot, source }) {
  const errors = [];
  for (const spec of extractModuleSpecifiers(source)) {
    if (spec.nonLiteral || spec.value == null) {
      errors.push(`${relPath}: non-literal ${spec.kind} import is forbidden in runtime source`);
      continue;
    }
    const value = spec.value;
    if (value === "zod") continue;
    if (value.startsWith("./") || value.startsWith("../")) {
      if (TEST_SPECIFIER_RE.test(value)) {
        errors.push(`${relPath}: runtime import of test source is forbidden: ${JSON.stringify(value)}`);
        continue;
      }
      const resolved = path.resolve(path.dirname(absPath), value);
      if (resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path.sep}`)) continue;
      errors.push(`${relPath}: relative import escapes package src: ${JSON.stringify(value)}`);
      continue;
    }
    errors.push(`${relPath}: forbidden runtime import ${JSON.stringify(value)}`);
  }
  for (const name of findForbiddenGlobals(source)) {
    errors.push(`${relPath}: forbidden Node/runtime global ${JSON.stringify(name)}`);
  }
  return errors;
}

/**
 * Validate the package manifest's boundary-relevant fields.
 * @param {unknown} manifest a parsed package.json object
 * @returns {string[]} policy-violation messages (empty ⇒ clean)
 */
export function evaluateManifest(manifest) {
  const errors = [];
  if (manifest == null || typeof manifest !== "object") {
    errors.push("packages/worker-protocol/package.json: not an object");
    return errors;
  }
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {}).sort();
  if (JSON.stringify(runtimeDependencies) !== JSON.stringify(REQUIRED_RUNTIME_DEPENDENCIES)) {
    errors.push(
      `packages/worker-protocol/package.json: runtime dependencies must equal ${JSON.stringify(
        REQUIRED_RUNTIME_DEPENDENCIES,
      )}, got ${JSON.stringify(runtimeDependencies)}`,
    );
  }
  if (manifest.name !== EXPECTED_PACKAGE_NAME) {
    errors.push(
      `packages/worker-protocol/package.json: unexpected package name ${JSON.stringify(manifest.name)}`,
    );
  }
  return errors;
}
