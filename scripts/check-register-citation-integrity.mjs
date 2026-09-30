#!/usr/bin/env node
/**
 * check-register-citation-integrity.mjs
 *
 * A CITATION THAT POINTS AT THE WRONG LINE IS A RECORD DISAGREEING WITH ITS OWN CODE.
 *
 * The threat-control register `docs/architecture/distributed-execution-threat-controls.json`
 * cites source locations as `path/to/file.ts:LINE` and `:LINE-RANGE`. These citations SILENTLY
 * ROT whenever any PR shifts lines in a cited file — including sibling crossings a PR never
 * intended to touch. On PR #443 that cost TEN Codex review rounds of manual re-anchoring,
 * because a diff-scoped reviewer cannot see whole-register drift. This guard closes the class:
 * it verifies every enforced citation against the working-tree HEAD on every PR, in the
 * always-on `policy` job.
 *
 * WHAT IT ENFORCES, AND WHY THAT SCOPE (all four decisions are MEASURED, not assumed — see
 * the measurement note at the bottom of this header):
 *
 *   ENFORCED = an EXPLICIT, REPO-ANCHORED citation: a `path:LINE` (or `:LINE-RANGE`) whose path
 *   contains a `/` and whose first segment is a known repo root (server/, packages/, docs/,
 *   scripts/, .github/, …). 211 of the register's citations are of this kind, and on the tree this
 *   guard shipped against every one of them resolves. Anchoring is decided against a STATIC root
 *   set (KNOWN_REPO_ROOTS, unioned with dirs that currently exist), NOT against the dirs present at
 *   HEAD — so a PR that DELETES a whole cited root cannot reclassify its citations as unanchored and
 *   skip the missing-file error the guard exists to raise. Line counts are PHYSICAL: the empty
 *   sentinel that split() appends for a file's trailing newline is dropped, so a citation one line
 *   past EOF reds instead of passing.
 *
 *   Per enforced citation, at working-tree HEAD:
 *     (a) EXISTS      — the file exists. A deleted or moved file reds.
 *     (b) IN-RANGE    — the line (or the whole range) is within the file. A file that shrank
 *                       below a cited line reds. This is the PR #443 rot class.
 *     (c) REACHES-CODE— for a SINGLE-LINE citation into a code file (.ts/.tsx/.js/.jsx/.mjs/.cjs)
 *                       the cited line must not be BLANK. A citation that has drifted onto a
 *                       blank line has reached nothing. It does NOT fail on a comment, JSDoc, or
 *                       import line: the register cites those DELIBERATELY (measured: 27 such
 *                       citations today, e.g. DE-01 job-input-staging.ts:25 → a `//` line the
 *                       row itself calls "only prose"), so a "not a comment/import" rule would
 *                       be a false-fail machine — the very defect this programme has paid for.
 *                       The task scoped (c) to a "three-services class"; the blank-only rule is
 *                       false-positive-free across ALL code files (a strict superset), so it is
 *                       applied broadly rather than to an under-defined subset.
 *     (d) SYMBOL-ANCHOR (REQUIRED + VERIFIED — cite by symbol) — every enforced citation MUST
 *                       carry a BACKTICKED anchor adjacent to it (`` path:LINE (`insertJobOnce`) ``
 *                       or `` `admit()` at path:LINE ``). A missing anchor REDS. The anchor — or the
 *                       call name stripped of its argument list — MUST appear within ±5 lines of the
 *                       cited line (a range's window is [lo-5, hi+5]); if it does not, the construct
 *                       moved (re-point) or was deleted (re-anchor) and it REDS. The anchor is the
 *                       source of truth and the line is a hint: this is what catches a line that
 *                       drifted WITHIN range but off its construct (the DE-15/DE-27 class), which
 *                       (b) alone cannot see, and which the earlier blank-only (c) false-greened
 *                       when the drift landed on other non-blank code. All 211 enforced citations
 *                       were migrated to carry a distinctive, verified anchor; anchor matching is
 *                       deliberately STRICT (no generic-fragment fallback — see `anchorVariants`).
 *
 *   BEST-EFFORT, NOT ENFORCED (a documented, MEASURED decision — this is the escape hatch the
 *   task granted for infeasible robust attribution):
 *     - BARE `:LINE` refs (attributed to the most recent path named earlier in the same string).
 *       They are narrative-contaminated in this register: sentences discuss OLD, re-measured, and
 *       superseded line numbers ("stale citations re-measured: :1983 -> :3527", "these read
 *       `:5399`, `:5451`"), and intervening bare filenames break "most recent path" attribution.
 *       Even with improved attribution (resolving bare filenames to a unique repo file) 73 bare
 *       refs across ~20 files land out of range, almost all of them legacy/frozen-block numbers.
 *       Enforcing them would demand a ~73-entry grandfather list of pure noise — a worse control
 *       surface than the drift it would catch. They are counted and reported, never failed.
 *     - UNANCHORED / relative-shorthand paths (`routes/projects.ts`, `services/heartbeat.ts`) —
 *       11 citations whose first segment is not a top-level dir. They cannot be resolved from the
 *       repo root unambiguously and were never repo-root citations. Counted, not failed.
 *     - FILENAME-ONLY mentions with no directory. Counted, not failed.
 *
 *   GRANDFATHER — `scripts/register-citation-grandfather.json`. An enforced citation that
 *   legitimately cannot resolve (a frozen historical block pointing at since-moved code) is
 *   listed there with a one-line reason, and is then not an error. The list is SELF-CLEANING:
 *   an entry that no longer corresponds to a live violation (someone fixed the citation, or the
 *   file grew back) REDS as STALE, exactly like the audit-debt `ownerTicketDeferrals` arm — a
 *   grandfather that outlives its reason is silent debt. An ABSENT manifest is a FAIL, never an
 *   empty allow-list. On the tree this guard shipped against the list is EMPTY: the only two
 *   strict-scope violations were real line-drift (DE-14 index.ts:164→:171 onto a blank line, and
 *   DE-28 quarantine-grant.ts:91→:101) and were FIXED rather than grandfathered, because they
 *   could resolve — grandfathering is for citations that cannot.
 *
 *   CENSUS — `scripts/register-citation-census.json` pins how many enforced citations exist, in
 *   TOTAL and PER REPO-ROOT. The guard would otherwise only check the citations it still emits, so
 *   a parser/scope regression that silently dropped some (e.g. losing the `packages` root removes
 *   71) would shrink coverage while policy stayed green. On the real-register run the live census
 *   must equal the manifest, per root, or the guard REDs. A legitimate register change is a
 *   DELIBERATE re-pin: `node scripts/check-register-citation-integrity.mjs --update-census` rewrites
 *   the manifest (sorted, deterministic); commit it alongside the register change, like a snapshot.
 *   An ABSENT census manifest is a FAIL. The census check runs only when the manifest is present in
 *   the input — the pure unit tests pass synthetic inputs without it; `collect` always loads it.
 *
 * THIS GUARD IS ADDITIVE. It does not touch and does not duplicate
 * check-distributed-execution-foundation.mjs clause 4, which is about crossing-ID tokens (DE-NN)
 * appearing in OPEN findings — a different contract over different text.
 *
 * MEASUREMENT PROVENANCE: every count above was measured against
 * docs/architecture/distributed-execution-threat-controls.json at origin/docs/replatform-program
 * tip 9200a66c4 (DE-27 merged). The self-test's POSITIVE CONTROL re-establishes on every run
 * that the shipped tree is green, so any red is attributable to a change and not to this guard.
 *
 * Usage:
 *   node scripts/check-register-citation-integrity.mjs
 *   node scripts/check-register-citation-integrity.mjs --root <fixture-dir>   # tests only
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export const THREAT_CONTROLS_JSON = "docs/architecture/distributed-execution-threat-controls.json";
export const GRANDFATHER_JSON = "scripts/register-citation-grandfather.json";
export const CENSUS_JSON = "scripts/register-citation-census.json";

/**
 * Extensions we recognise as a citable source/asset file.
 *
 * ★ CODEX P2 (:106) — ORDER LONGEST-FIRST AND REQUIRE AN EXTENSION BOUNDARY. With `ts` before
 * `tsx` and `js` before `json`/`jsx`, `scripts/guard-inventory.json:189` matched `.js` inside
 * `.json`, leaving `on:189` — so the citation parsed as a path `scripts/guard-inventory.js`
 * (no line) plus a stray bare `:189`, i.e. an unenforced mis-parse of what is really an enforced
 * `.json` citation. Two independent defences: longer alternatives come first, AND the extension
 * must be followed by a non-alphanumeric (so `.js` cannot match the head of `.json`).
 */
const EXT = "(?:tsx|ts|jsx|json|js|cjs|mjs|sql|ya?ml|md|sh|ps1)";
const EXT_BOUNDARY = "(?![A-Za-z0-9])";
/** A path with at least one `/` and a recognised extension. */
const SLASH_PATH = `(?:[A-Za-z0-9_.\\-]+/)+[A-Za-z0-9_.\\-]+\\.${EXT}${EXT_BOUNDARY}`;
/** A bare filename (no `/`) with a recognised extension. */
const BARE_FILENAME = `[A-Za-z0-9_.\\-]+\\.${EXT}${EXT_BOUNDARY}`;
/**
 * One combined left-to-right scanner. Order matters: a slash path is tried before a bare
 * filename before a lone `:LINE`, so `a/b.ts:10` is one explicit slash citation, not a bare
 * filename plus a bare line. A `:LINE(-LINE)?` is captured when present.
 */
const SCAN = new RegExp(
  `(${SLASH_PATH})(?::(\\d+(?:-\\d+)?))?` + // slash path (+ optional line)
    `|(${BARE_FILENAME})(?::(\\d+(?:-\\d+)?))?` + // bare filename (+ optional line)
    `|:(\\d+(?:-\\d+)?)`, // bare line
  "gi",
);

/** Code-file extensions for the reaches-real-code (c) check. */
const CODE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

/**
 * The repo's top-level directory names, as a STATIC list — the source of truth for whether a
 * citation's path is "repo-root-anchored". It is deliberately NOT derived by filtering to the
 * directories that happen to exist at HEAD: a PR that DELETES or renames a whole cited root
 * (e.g. removes `server/`) must NOT thereby reclassify every `server/src/*.ts:LINE` citation as
 * unanchored → best-effort → silently skipped. With the root name fixed here, such a citation
 * stays anchored, hits the (a) file-exists check, and REDS — which is the whole point of the
 * guard. `computeRepoRoots` unions this static set with whatever directories currently exist, so
 * a NEW top-level directory added by a later PR is picked up automatically while a DELETED one is
 * still recognised. Derived once from the repo root at tip 9200a66c4.
 */
export const KNOWN_REPO_ROOTS = new Set([
  ".github",
  "cli",
  "doc",
  "docker",
  "docs",
  "e2b",
  "evals",
  "packages",
  "patches",
  "plans",
  "releases",
  "scripts",
  "server",
  "skills",
  "tests",
  "ui",
]);

/**
 * How far a verified anchor may sit from the cited line, in either direction (a range citation's
 * anchor may sit within [lo-N, hi+N]).
 *
 * ★ N = 5, chosen deliberately. The anchor is the source of truth and the line is a hint, so the
 * window absorbs the small line-drift routine edits cause (a few lines added above) WITHOUT a
 * false red, while still catching the real rot class: a construct that MOVED far (the DE-27
 * shape) or was DELETED falls outside ±5 and reds. The teeth against a nearby-but-wrong match are
 * not the window size but ANCHOR DISTINCTIVENESS — the migration picks anchors that are rare in
 * the file, so a distinctive anchor cannot silently re-match an unrelated neighbour inside the
 * window. Too tight (±0-1) would red on ordinary edits; too loose (±20) would let a construct
 * drift far and still pass. ±5 is the balance.
 */
const ANCHOR_RADIUS = 5;

/** The violation categories a grandfather entry may excuse (one per entry). */
export const VIOLATION_CATEGORIES = new Set([
  "missing-file",
  "out-of-range",
  "blank-line",
  "missing-anchor",
  "anchor-not-found",
  "ambiguous-anchor",
]);

/** A backtick anchor immediately AFTER `path:LINE` (optionally wrapped in `(`). */
const ANCHOR_AFTER_RE = /^\s*\(?\s*`([^`\n]{1,80})`/;
/** A backtick anchor immediately BEFORE the path (e.g. `` `admit()` at path:LINE ``). */
const ANCHOR_BEFORE_RE = /`([^`\n]{1,80})`\s*(?:\(|at |in |,\s*)?$/;

/**
 * Parse every source citation out of one string.
 *
 * Returns records `{ path, line, kind, anchorToken }` where `kind` is:
 *   - "explicit-slash"    a `path/with/slash.ts:LINE`
 *   - "explicit-filename" a bare `filename.ts:LINE` (no directory)
 *   - "bare"              a lone `:LINE`, attributed to the most recent path named earlier
 * A path mentioned WITHOUT a line still updates the "most recent path" used to attribute a
 * following bare `:LINE` — that is the attribution rule the task specified. Slash paths and
 * bare filenames both count as "a path named earlier".
 *
 * `anchorToken` is the backticked construct token sitting adjacent to an explicit citation, or
 * null. It is extracted here (where the surrounding text is in hand) so the evaluator stays a
 * pure function of already-parsed records.
 */
export function parseCitations(text) {
  if (typeof text !== "string") return [];
  const out = [];
  let lastPath = null;
  SCAN.lastIndex = 0;
  let m;
  while ((m = SCAN.exec(text)) !== null) {
    const [whole, slashPath, slashLine, fileName, fileLine, bareLine] = m;
    const start = m.index;
    const end = m.index + whole.length;
    if (slashPath) {
      lastPath = slashPath;
      if (slashLine) {
        out.push({ path: slashPath, line: slashLine, kind: "explicit-slash", anchorToken: anchorFor(text, start, end) });
      }
    } else if (fileName) {
      lastPath = fileName;
      if (fileLine) {
        out.push({ path: fileName, line: fileLine, kind: "explicit-filename", anchorToken: anchorFor(text, start, end) });
      }
    } else if (bareLine && lastPath) {
      out.push({ path: lastPath, line: bareLine, kind: "bare", anchorToken: null });
    }
  }
  return out;
}

/** Extract a backtick anchor adjacent to a citation spanning [start, end) in `text`. */
function anchorFor(text, start, end) {
  const after = ANCHOR_AFTER_RE.exec(text.slice(end, end + 90));
  if (after) return after[1].trim();
  // ★ CODEX P2 (:230) — slice enough for the 80-char token ANCHOR_BEFORE_RE accepts. At 40 chars
  // a before-style anchor longer than ~34 chars lost its opening backtick from the window and
  // parsed as null (a false RED). 90 = 80-char token + two backticks + the small ` at `/` in `/`,`
  // delimiters the regex allows before the citation.
  const before = ANCHOR_BEFORE_RE.exec(text.slice(Math.max(0, start - 90), start));
  if (before) return before[1].trim();
  return null;
}

/**
 * Close variants of an anchor token that "the token appears" may match against.
 *
 * ★ DELIBERATELY STRICT — no generic-fragment fallback. An earlier version also returned the
 * anchor's LEADING IDENTIFIER, so `count > config.max` matched a nearby bare `count` and
 * `authority.recordProof` matched a bare `authority` — which made verification LENIENT in exactly
 * the direction that lets drift pass. The only variant beyond the raw anchor is the call name with
 * its argument list stripped (`admit(payload)` written as `admit()` still matches `admit(`), which
 * is a spelling of the SAME symbol, not a weaker fragment of it. A distinctive multi-token anchor
 * must therefore appear (nearly) verbatim within the window.
 */
export function anchorVariants(token) {
  const raw = String(token || "").trim();
  const out = new Set();
  if (raw.length >= 2) out.add(raw);
  // `foo(...)` / `foo()` / `a.b(...)` -> the call name, stripped of its argument list.
  const call = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(raw);
  if (call && call[1].length >= 3) out.add(call[1]);
  return [...out];
}

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A bare identifier or dotted path — no whitespace, operators, quotes or parens. */
const IDENTIFIER_SHAPED = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * How many times does the anchor `token` occur in `hay`?  [THE DISTINCTIVENESS ORACLE]
 *
 * A migration chose anchors that ALSO appeared near the WRONG cited line, so the ±5 check passed
 * on the wrong construct. An anchor that resolves to EXACTLY ONE location in its window cannot do
 * that, so the guard counts occurrences (0 = drift/deletion, 1 = distinctive, ≥2 = ambiguous)
 * rather than testing mere presence.
 *
 * ★ CODEX P2 (:317, completing :251) — CLOSE THE WHOLE SUBSTRING CLASS. An IDENTIFIER-SHAPED anchor
 * (a bare identifier or dotted path) is counted at IDENTIFIER BOUNDARIES — the match must not be
 * flanked by `[\w$]` — so `admit` does NOT count inside `admittedUserRequester` or `preadmit`. That
 * closes the plain-identifier false-pass that a raw `indexOf` left open after :251 fixed only the
 * call-shaped (`admit()`) path. A SNIPPET-shaped anchor (whitespace / operators / quotes / parens,
 * e.g. `count > config.max`, `if (inserted[0])`, a path string) is counted VERBATIM, since such a
 * snippet legitimately matches only where it literally appears. A call-shaped anchor (`foo()`) with
 * no verbatim hit falls back to `name(` at an identifier boundary.
 *
 * ★ task_94660c59 (dotted-boundary) — a DOTTED anchor (`config.max`, `services.companyId`) must pin
 * the WHOLE member path, so its boundary class ALSO excludes `.`: `config.max` must NOT match as the
 * tail of `app.config.max` or the head of `config.max.deep` — a wrong-construct false-pass of the
 * same family the `[\w$]` boundary closed for bare identifiers. A BARE identifier keeps the `[\w$]`
 * boundary (a leading `.` is NOT excluded) so an ordinary method access still matches — `admit`
 * legitimately counts in `gate.admit(x)`; only a dotted anchor demands full-path exactness.
 */
export function anchorMatchCount(hay, token) {
  const raw = String(token || "").trim();
  if (raw.length < 2) return 0;
  if (IDENTIFIER_SHAPED.test(raw)) {
    // Dotted anchor -> `[\w$.]` boundary (pin the full path); bare identifier -> `[\w$]` (allow `obj.method`).
    const b = raw.includes(".") ? "[\\w$.]" : "[\\w$]";
    return (hay.match(new RegExp(`(?<!${b})${escapeRegExp(raw)}(?!${b})`, "g")) || []).length;
  }
  // snippet / call-shaped: count verbatim occurrences first.
  let n = 0;
  for (let i = hay.indexOf(raw); i !== -1; i = hay.indexOf(raw, i + raw.length)) n += 1;
  if (n > 0) return n;
  // call-shaped with no verbatim hit: the call name at an identifier boundary + `(`.
  const call = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(raw);
  if (call && call[1].length >= 3) {
    return (hay.match(new RegExp(`(?<![\\w$.])${escapeRegExp(call[1])}\\s*\\(`, "g")) || []).length;
  }
  return 0;
}

/** Does the anchor `token` appear in `hay`? Boundary-correct — delegates to the count oracle. */
export function anchorMatches(hay, token) {
  return anchorMatchCount(hay, token) > 0;
}

/** Is `p` repo-root-anchored — path with a `/` whose first segment is a known repo root? */
export function isAnchored(p, repoRoots) {
  if (!p.includes("/")) return false;
  return repoRoots.has(p.split("/")[0]);
}

/** [lo, hi] line bounds from a "N" or "N-M" spec. */
function lineBounds(spec) {
  const [a, b] = spec.split("-").map((n) => Number(n));
  return [a, b != null && !Number.isNaN(b) ? b : a];
}

/** The stable signature of a citation (and of a grandfather entry): crossing|path|line. */
export function citationSignature(crossingId, p, line) {
  return `${crossingId}|${p}|${line}`;
}

/**
 * Read the tree into the pure evaluator's input shape. Fail-closed (throws) on an absent or
 * unparseable register or grandfather manifest — an absent manifest must NEVER read as an
 * empty allow-list.
 */
export function collect(root) {
  const readJson = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      throw new Error(`${rel} is missing (an absent manifest is a FAIL, not an empty allow-list)`);
    }
    return JSON.parse(readFileSync(abs, "utf8"));
  };

  const register = readJson(THREAT_CONTROLS_JSON);
  const grandfather = readJson(GRANDFATHER_JSON);
  const census = readJson(CENSUS_JSON);
  const citations = parseRegisterCitations(register, computeRepoRoots(root));

  // Read the files that in-scope citations point at (only those — pure, bounded file reads).
  const files = {};
  for (const c of citations) {
    if (!c.inScope || files[c.path]) continue;
    const abs = path.join(root, c.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      files[c.path] = { exists: false, lines: [] };
    } else {
      files[c.path] = { exists: true, lines: splitPhysicalLines(readFileSync(abs, "utf8")) };
    }
  }

  return { citations, files, grandfather, census };
}

/** Parse every string field of every crossing into scoped citation records. */
export function parseRegisterCitations(register, repoRoots) {
  const citations = [];
  for (const crossing of register.crossings ?? []) {
    if (!crossing || crossing.id == null) continue;
    for (const [field, value] of Object.entries(crossing)) {
      const strings = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
      for (const s of strings) {
        for (const c of parseCitations(s)) {
          const anchored = c.kind === "explicit-slash" && isAnchored(c.path, repoRoots);
          const inScope = anchored; // explicit + repo-anchored
          citations.push({ crossingId: crossing.id, field, ...c, anchored, inScope });
        }
      }
    }
  }
  return citations;
}

/**
 * The enforced-citation CENSUS: the count of unique enforced (explicit, repo-anchored) citations,
 * in total and grouped by repo root. Pinning it (see `register-citation-census.json`) makes a
 * silent coverage drop — a parser/scope regression that stops emitting some citations — fail
 * loudly instead of leaving the guard quietly checking fewer citations while policy stays green.
 */
export function computeCensus(citations) {
  const seen = new Set();
  const byRoot = {};
  for (const c of citations ?? []) {
    if (!c.inScope) continue;
    const sig = citationSignature(c.crossingId, c.path, c.line);
    if (seen.has(sig)) continue;
    seen.add(sig);
    const root = c.path.split("/")[0];
    byRoot[root] = (byRoot[root] || 0) + 1;
  }
  return { total: seen.size, byRoot };
}

/**
 * The set of repo-root names used to decide anchoring: the STATIC KNOWN_REPO_ROOTS, and ONLY that.
 *
 * ★ CODEX P2 (:340) — DO NOT union in the directories that happen to exist at `root`. An earlier
 * version did, and it made classification depend on the filesystem in a way that was inconsistent
 * across a directory's lifetime: a top-level dir NOT in the static list was classified anchored
 * while it existed (picked up by the dynamic scan) but silently reclassified UNANCHORED once
 * deleted (dropped from the scan, never in the static list) — so a citation into a since-deleted
 * root skipped instead of red-ing on file-exists. Anchoring is now a pure function of the static
 * allowlist, so it never changes when the tree does: a deleted KNOWN root still classifies anchored
 * and reds via file-exists. The list is the explicit, reviewed record of the repo's roots — a NEW
 * top-level source directory must be ADDED here (a deliberate, reviewed act), exactly as an
 * allowlist is meant to be maintained. `root` is accepted for API stability and intentionally
 * unused.
 */
export function computeRepoRoots(_root) {
  return new Set(KNOWN_REPO_ROOTS);
}

/**
 * Split file content into its PHYSICAL lines. A file that ends with the ordinary final newline
 * makes `split(/\r?\n/)` append one empty sentinel element; left in, it lets a citation exactly
 * ONE line past EOF pass the in-range check. Drop that single trailing sentinel (and only it, so a
 * file whose genuine last line is blank keeps that line). A citation to the true last line still
 * resolves; a citation one past it is now out of range.
 */
export function splitPhysicalLines(content) {
  const lines = String(content).split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The whole verdict, as a pure function of already-read text.
 *
 * @param {{citations: object[], files: Record<string,{exists:boolean,lines:string[]}>, grandfather: object}} input
 * @returns {{errors: string[], notes: string[]}}
 */
export function evaluateCitationIntegrity(input) {
  const errors = [];
  const notes = [];
  const citations = Array.isArray(input.citations) ? input.citations : [];
  const files = input.files ?? {};
  const grandfather = input.grandfather ?? {};

  // --- validate the grandfather manifest shape -----------------------------------------
  const entries = Array.isArray(grandfather.entries) ? grandfather.entries : null;
  if (entries == null) {
    errors.push(
      `${GRANDFATHER_JSON}: must be a JSON object with an "entries" array. An absent or malformed ` +
        "allow-list is a FAIL, not an empty allow-list — deleting it would retire the guard's grandfather arm silently.",
    );
    return { errors, notes };
  }
  // ★ CODEX P2 (:468) — a grandfather entry excuses ONE violation CATEGORY, not the signature
  // wholesale. Before, an entry keyed only on crossing|path|line suppressed ANY violation there,
  // so a citation grandfathered for "can't be anchored" (missing-anchor) would ALSO silently mask
  // a NEW missing-file or out-of-range at the same line. Each entry now declares the exact category
  // it excuses, and only that category is suppressed; any other failure at that signature still reds.
  const grandfatherSigs = new Map(); // "sig|category" -> reason
  const grandfatherKeys = new Map(); // "sig|category" -> {crossing,p,line,category,reason} for stale reporting
  for (const [i, e] of entries.entries()) {
    if (e == null || typeof e !== "object" || Array.isArray(e)) {
      errors.push(`${GRANDFATHER_JSON}: entry #${i} is not an object`);
      continue;
    }
    const { crossing, path: p, line, reason, category } = e;
    if (typeof crossing !== "string" || typeof p !== "string" || typeof line !== "string") {
      errors.push(`${GRANDFATHER_JSON}: entry #${i} must carry string "crossing", "path", and "line" (got ${JSON.stringify(e)})`);
      continue;
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      errors.push(`${GRANDFATHER_JSON}: entry for ${crossing} ${p}:${line} needs a non-empty "reason" — a grandfather without a reason is silent debt`);
      continue;
    }
    if (typeof category !== "string" || !VIOLATION_CATEGORIES.has(category)) {
      errors.push(
        `${GRANDFATHER_JSON}: entry for ${crossing} ${p}:${line} needs a "category" naming the SINGLE violation it excuses ` +
          `(one of ${[...VIOLATION_CATEGORIES].join(", ")}); a category-less grandfather would mask unrelated new failures at the same line.`,
      );
      continue;
    }
    const key = `${citationSignature(crossing, p, line)}|${category}`;
    grandfatherSigs.set(key, reason);
    grandfatherKeys.set(key, { crossing, p, line, category, reason });
  }

  // --- compute raw violations (ignoring the grandfather list) --------------------------
  // Group the in-scope occurrences by signature: N occurrences of the same citation collapse to
  // one verdict, and the citation is anchored if ANY occurrence carries a verifying anchor (so a
  // repeated citation need only be anchored once).
  const rawViolations = new Map(); // sig -> [{ category, message }]  (ALL applicable, not just the first)
  const bySig = new Map(); // sig -> occurrences[]
  const bestEffort = { bare: 0, unanchored: 0, filenameOnly: 0 };

  for (const c of citations) {
    if (!c.inScope) {
      if (c.kind === "bare") bestEffort.bare += 1;
      else if (c.kind === "explicit-slash") bestEffort.unanchored += 1;
      else if (c.kind === "explicit-filename") bestEffort.filenameOnly += 1;
      continue;
    }
    const sig = citationSignature(c.crossingId, c.path, c.line);
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(c);
  }
  const enforced = bySig.size;

  for (const [sig, occs] of bySig) {
    const c = occs[0];
    const cite = `${c.crossingId} (${c.field}) ${c.path}:${c.line}`;
    const f = files[c.path];
    // ★ CODEX P2 (:516) — COLLECT ALL INDEPENDENT VIOLATIONS, never short-circuit after the first.
    // A citation can fail more than one INDEPENDENT check at once (e.g. a blank cited line AND a
    // missing anchor). The earlier code recorded only the first and `continue`d, so a category-
    // scoped grandfather for that first category (blank-line) silently suppressed the whole
    // citation — masking a co-located missing-anchor. Category-scoped grandfathering only works if
    // each independent failure is recorded separately, so a grandfather excuses ONLY its own.
    const vs = [];
    const add = (category, message) => vs.push({ category, message });

    if (!f || !f.exists) {
      // Terminal: with no file there are no lines against which to assess range/blank/anchor.
      add("missing-file", `${cite}: cited file does not exist at HEAD (moved, renamed, or deleted).`);
    } else {
      const [lo, hi] = lineBounds(c.line);
      if (!Number.isInteger(lo) || lo < 1 || !Number.isInteger(hi) || hi < lo || hi > f.lines.length) {
        // Terminal: the cited line is not in the file, so blank/anchor cannot be assessed against it.
        add("out-of-range", `${cite}: line ${c.line} is outside the file, which has ${f.lines.length} lines (the file shifted or shrank under a citation that did not move).`);
      } else {
        // The two checks below are INDEPENDENT and are both assessed for this citation.
        // (c) reaches-real-code: a single-line code citation must not land on a blank line.
        if (CODE_EXT_RE.test(c.path) && lo === hi && (f.lines[lo - 1] ?? "").trim() === "") {
          add("blank-line", `${cite}: cites a BLANK line — the citation has drifted onto whitespace and reaches no code.`);
        }
        // (d) REQUIRED + (e) DISTINCTIVE anchor. Count occurrences in the ±N window, not presence:
        //   0 -> anchor-not-found (moved/deleted), 1 -> distinctive (good), ≥2 -> ambiguous.
        const tokens = [...new Set(occs.map((o) => o.anchorToken).filter((t) => typeof t === "string" && t.trim() !== ""))];
        if (tokens.length === 0) {
          add(
            "missing-anchor",
            `${cite}: MISSING anchor — every enforced citation must carry an adjacent backtick anchor naming a ` +
              `distinctive symbol/snippet on the cited line, e.g. \`${c.path}:${c.line} (\`someDistinctiveSymbol\`)\`. ` +
              "Cite by symbol: the anchor is the source of truth, the line is a hint.",
          );
        } else {
          const windowText = f.lines
            .slice(Math.max(0, lo - 1 - ANCHOR_RADIUS), Math.min(f.lines.length, hi + ANCHOR_RADIUS))
            .join("\n");
          const counts = tokens.map((t) => ({ t, n: anchorMatchCount(windowText, t) }));
          if (counts.some((x) => x.n === 1)) {
            // distinctive anchor found — OK
          } else if (counts.some((x) => x.n >= 2)) {
            const worst = counts.find((x) => x.n >= 2);
            add(
              "ambiguous-anchor",
              `${cite}: anchor \`${worst.t}\` is NON-DISTINCTIVE — it appears ${worst.n} times within ±${ANCHOR_RADIUS} lines of ` +
                `line ${c.line}, so it does not pin a single construct (a drifted line with a coincidental token slips through this way). ` +
                "Choose an anchor unique in the window.",
            );
          } else {
            add(
              "anchor-not-found",
              `${cite}: anchor ${tokens.map((t) => "`" + t + "`").join(" / ")} does not appear within ±${ANCHOR_RADIUS} lines of ` +
                `line ${c.line} — the construct moved (re-point the line) or was deleted/renamed (re-anchor).`,
            );
          }
        }
      }
    }
    if (vs.length > 0) rawViolations.set(sig, vs);
  }

  // --- apply grandfather PER VIOLATION (by category), then flag stale grandfather entries ------
  // A grandfather entry suppresses ONLY violations of its own category at that signature; every
  // OTHER-category violation at the same citation still fails. This is what closes the P2 :516
  // masking hole — a blank-line grandfather can no longer hide a co-located missing-anchor.
  for (const [sig, vs] of [...rawViolations].sort()) {
    for (const v of vs) {
      if (grandfatherSigs.has(`${sig}|${v.category}`)) continue; // this category is excused
      errors.push(v.message);
    }
  }
  for (const [, meta] of [...grandfatherKeys].sort()) {
    const vs = rawViolations.get(citationSignature(meta.crossing, meta.p, meta.line)) || [];
    if (!vs.some((v) => v.category === meta.category)) {
      const others = vs.map((v) => `"${v.category}"`).join(", ");
      errors.push(
        `${GRANDFATHER_JSON}: the entry for ${meta.crossing} ${meta.p}:${meta.line} (category "${meta.category}") is STALE — ` +
          `that citation no longer produces a "${meta.category}" violation` +
          `${vs.length ? ` (it now produces ${others}, which this entry does NOT excuse)` : ""} ` +
          `(reason on file: ${JSON.stringify(meta.reason)}). Remove or re-categorise the entry; a grandfather that outlives its reason is silent debt.`,
      );
    }
  }

  // --- CENSUS: pin coverage so a silent drop REDs (runs on the real register; the manifest is
  // absent for the pure-function unit tests, which pass synthetic inputs). ★ CODEX P2 (:70) —
  // a loose "> 100" let a scope regression that dropped a whole root stay green while the guard
  // silently checked fewer citations. The pinned total + per-root counts make that fail loudly.
  if (input.census && typeof input.census === "object") {
    const actual = computeCensus(citations);
    const exp = input.census;
    const repin = `re-pin deliberately with \`node scripts/check-register-citation-integrity.mjs --update-census\` (and commit ${CENSUS_JSON}) if the register change is intended`;
    if (!Number.isInteger(exp.total)) {
      errors.push(`${CENSUS_JSON}: "total" must be an integer (got ${JSON.stringify(exp.total)})`);
    } else if (actual.total !== exp.total) {
      errors.push(
        `${CENSUS_JSON}: enforced-citation census changed — expected total ${exp.total}, got ${actual.total}. ` +
          `A citation was added/removed or the parser/scope regressed; ${repin}.`,
      );
    }
    const expByRoot = exp.byRoot && typeof exp.byRoot === "object" ? exp.byRoot : {};
    for (const root of [...new Set([...Object.keys(expByRoot), ...Object.keys(actual.byRoot)])].sort()) {
      const e = expByRoot[root] ?? 0;
      const a = actual.byRoot[root] ?? 0;
      if (e !== a) {
        errors.push(
          `${CENSUS_JSON}: enforced-citation census for root "${root}" changed — expected ${e}, got ${a} ` +
            `(a whole-root scope drop, or a citation added/removed under it); ${repin}.`,
        );
      }
    }
  }

  notes.push(
    `citation integrity: ${enforced} enforced (explicit, repo-anchored) citations checked; ` +
      `best-effort (unenforced): ${bestEffort.bare} bare :LINE, ${bestEffort.unanchored} unanchored, ${bestEffort.filenameOnly} filename-only. ` +
      `${grandfatherSigs.size} grandfathered.`,
  );
  return { errors, notes };
}

/** Re-pin the enforced-citation census from the live register (does NOT require the manifest). */
function updateCensus(root) {
  const registerAbs = path.join(root, THREAT_CONTROLS_JSON);
  if (!existsSync(registerAbs)) throw new Error(`${THREAT_CONTROLS_JSON} is missing`);
  const register = JSON.parse(readFileSync(registerAbs, "utf8"));
  const census = computeCensus(parseRegisterCitations(register, computeRepoRoots(root)));
  const prior = existsSync(path.join(root, CENSUS_JSON)) ? JSON.parse(readFileSync(path.join(root, CENSUS_JSON), "utf8")) : {};
  const byRoot = {}; // sorted keys, for a deterministic manifest (stable diffs)
  for (const k of Object.keys(census.byRoot).sort()) byRoot[k] = census.byRoot[k];
  const manifest = { version: prior.version ?? 1, note: prior.note ?? "Pinned enforced-citation census; see the guard header.", total: census.total, byRoot };
  writeFileSync(path.join(root, CENSUS_JSON), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`re-pinned ${CENSUS_JSON}: total ${census.total}, byRoot ${JSON.stringify(census.byRoot)}`);
}

function main() {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? process.argv[rootFlag + 1] : process.cwd();
  if (process.argv.includes("--update-census")) {
    try {
      updateCensus(root);
    } catch (error) {
      console.error(`--update-census: FAIL\n  ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    return;
  }
  let result;
  try {
    result = evaluateCitationIntegrity(collect(root));
  } catch (error) {
    console.error(`register citation integrity: FAIL\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }
  for (const note of result.notes) console.log(`  ${note}`);
  if (result.errors.length > 0) {
    console.error("register citation integrity: FAIL");
    for (const e of result.errors) console.error(`  - ${e}`);
    console.error(
      `\nFix the citation in ${THREAT_CONTROLS_JSON}, or — for a citation that legitimately cannot resolve ` +
        `(a frozen historical block pointing at since-moved code) — add it to ${GRANDFATHER_JSON} with a one-line reason.`,
    );
    process.exit(1);
    return;
  }
  console.log("register citation integrity: PASS");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-register-citation-integrity.mjs")) {
  main();
}
