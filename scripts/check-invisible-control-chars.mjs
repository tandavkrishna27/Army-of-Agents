#!/usr/bin/env node
/**
 * check-invisible-control-chars.mjs
 *
 * A RAW CONTROL BYTE IN A TEXT FILE IS ALWAYS A BUG, BECAUSE NOBODY CAN SEE IT.
 *
 * ★★★ THE DEFECT CLASS. Writing a file through a shell heredoc, `echo`, `printf` or `sed`
 * silently turns the two characters backslash-b into ONE literal 0x08 byte. The result renders
 * invisibly in every terminal, editor, diff view and code-review UI, so it survives review by
 * construction. This repository shipped it three times, twice AFTER writing its own post-mortem:
 *
 *   1. scripts/lib/worker-keystore-boundary.mjs -- a guard whose regex matched nothing while
 *      the corpus reported green. Fixed. Its post-mortem comment then carried the same byte,
 *      leaving it reading "where `<0x08>` was intended": the lesson written down, and unable to
 *      enforce itself.
 *   2. scripts/ci-local.mjs -- `if (/^pnpm install<0x08>/.test(cmd)) continue;`. The comment
 *      above it called this "the ONE deliberate deviation from CI". It had never once been in
 *      effect; eight `pnpm install` steps ran, one of them lockfile-MUTATING and in the default
 *      fast gate. Fixed in the same change as this guard, and pinned by
 *      scripts/lib/__tests__/ci-local-install-guard.test.mjs.
 *   3. server/src/__tests__/w17-ipv6-range-closeout.test.ts -- fixed on another branch.
 *
 * ★★★ THE DESIGN CONSTRAINT THIS GUARD IS BUILT AROUND, from that same post-mortem: "a plain
 * substring scan over raw source ... flagged command-runner.ts for the COMMENTS explaining why
 * existsSync was removed: a checker that makes you delete the explanation of a bug is a bad
 * checker." A checker whose only remedy is deletion gets deleted itself, which is worse than no
 * checker.
 *
 * THE UNIT OF SCANNING, AND WHY IT IS HONEST.
 *
 *   The guard bans the raw BYTE and permits every ESCAPE SEQUENCE that denotes the same
 *   character -- `\0`, `\b`, `\x08`, `\u0008`, `0x08`, `<BS>`, or the words "backspace byte".
 *   Because the scan reads bytes, escapes are invisible to it by construction: the rule needs
 *   no exception machinery, no per-file allowlist, and no attempt to read the author's mind.
 *
 *   That is what separates "a control byte the author meant" from "a control byte the shell
 *   injected" WITHOUT guessing: an author who means the character can always say so in a form
 *   a human can see, and the repair for a legitimate use is a rewrite that denotes the
 *   identical character. Nothing is ever deleted. This was measured, not assumed. At the time
 *   this guard was written the tree held SIXTEEN raw control bytes in NINE text files. The count
 *   below is per BYTE, not per file or per repair -- two of these files carry three bytes each,
 *   and counting rows instead of bytes is exactly how this census was first published wrong
 *   ("eight in seven"); see E6-F017 for the correction and the one-line re-derivation.
 *
 *     REPAIRED BY RESTORING MEANING (the byte WAS the corruption; the prose said nothing):
 *       4  docs/aoa/plans/2026-07-20-cli-auth-detection-plan.md   `\b5\d{2}\b` written with the
 *                                                                 four \b eaten
 *       1  docs/replatform/qa/2026-08-31-blocker-ab-fix-design.md `C:\pn\blockab\` likewise
 *       1  scripts/lib/worker-keystore-boundary.mjs               the post-mortem comment above
 *
 *     REPAIRED BY REWRITING AN AUTHORED BYTE AS THE IDENTICAL ESCAPE (behaviour unchanged):
 *       1  packages/worker-daemon/src/supervisor/provider.ts      join("\0") separator
 *       3  scripts/lib/__tests__/embedded-secret-scan.test.mjs    "\x00\x01\x02\uFFFD" fixture
 *       3  server/src/services/asset-content-guard.ts             /[\x00-\x1f\x7f]/ strip class
 *       1  server/src/services/mcp-connectors.ts                  "\u0000bound" sentinel
 *       1  packages/browser-runtime/src/__tests__/path-adapter.test.ts  "evil\x7f.pdf"
 *
 *     FOUND BY THE SAME SCAN, REPAIRED UNDER ITS OWN FINDING (E6-F016, defect 2 above):
 *       1  scripts/ci-local.mjs                                   the dead install guard
 *
 *     15 bytes in 8 files repaired here + 1 byte in 1 file as E6-F016  =  16 bytes in 9 files.
 *
 *   Re-derive it from the parent blobs in one step -- run THIS script (the parent tree has no
 *   copy of it) against a detached checkout of the parent commit:
 *
 *       git worktree add --detach ../w19-parent c78a6827d
 *       node scripts/check-invisible-control-chars.mjs --root ../w19-parent   # exits 1
 *
 *   It prints one line per BYTE: sixteen lines over nine distinct paths.
 *
 *   So the feared annoyance did not materialise: the tree reached zero hits with no allowlist,
 *   no suppression comment, and not one word of explanation removed. Three explanations were
 *   RESTORED. An allowlist of today's findings was rejected outright -- it catches nothing new,
 *   which is the failure mode this repository already names as "a check that nothing runs".
 *
 * ★ AND AN OBJECTIVE HARM, INDEPENDENT OF TASTE. git classifies a file containing a NUL as
 * BINARY and refuses to show its diff. Four source files here were in that state, so every
 * change to them was unreviewable. The escape rewrite restored all four to reviewable text.
 * "The author meant it" is therefore not a sufficient defence for the raw byte.
 *
 * ★★★ WHY FILE TYPE IS DECIDED BY PATH AND NEVER BY CONTENT. The usual way to skip binaries is
 * to sniff for a NUL in the first few KB. That implementation is self-defeating HERE: the NUL
 * this guard hunts would classify its own file as binary and exempt it. The three .ts files
 * above are exactly that case. Classification is therefore by extension/basename only, and is
 * DEFAULT-DENY: a tracked file whose type appears in neither list fails the check until someone
 * classifies it. That rule earned its keep on its first run, surfacing sixteen unclassified
 * types -- most of them text (.mts, .jsonl, .npmrc, .mailmap, .webmanifest, PEM .key/.crt) that
 * a hand-written text list had silently skipped.
 *
 * Usage:
 *   node scripts/check-invisible-control-chars.mjs
 *   node scripts/check-invisible-control-chars.mjs --root <dir>
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * C0 controls except the three whitespace characters text files are made of, plus DEL.
 *
 * ★ WHY A RANGE AND NOT A HAND-PICKED LIST. The reconnaissance for this guard began with six
 * hand-picked bytes (00 07 08 0b 0c 1b). Measured against the census above, that list MISSES FIVE
 * of the sixteen bytes, and one file entirely: the 0x01 and 0x02 in embedded-secret-scan.test.mjs
 * and the 0x1f and 0x7f in asset-content-guard.ts (in both files it catches the NUL, so the file
 * looks handled while two of its bytes are not), plus path-adapter.test.ts, whose only byte is a
 * 0x7f and which the list therefore cannot see at all. Five misses from one list is the argument.
 * (An earlier note here said "three misses"; that was the same count-the-sites error E6-F017
 * corrects, carried through.)
 */
export function isBannedByte(code) {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false; // TAB, LF, CR
  return code < 0x20 || code === 0x7f;
}

export const BYTE_NAMES = new Map([
  [0x00, "NUL"], [0x01, "SOH"], [0x02, "STX"], [0x03, "ETX"], [0x04, "EOT"], [0x05, "ENQ"],
  [0x06, "ACK"], [0x07, "BEL"], [0x08, "BS"], [0x0b, "VT"], [0x0c, "FF"], [0x0e, "SO"],
  [0x0f, "SI"], [0x1a, "SUB"], [0x1b, "ESC"], [0x7f, "DEL"],
]);

export function byteName(code) {
  return BYTE_NAMES.get(code) ?? `0x${code.toString(16).padStart(2, "0")}`;
}

/**
 * Invisible NON-BYTE characters, banned after decoding.
 *
 * ★★★ THIS SET IS THE ANSWER TO "WHAT IS THE CHEAPEST WAY TO EVADE THIS GUARD?", AND IT IS ONLY
 * A PARTIAL ANSWER. The byte scan above is complete against the ACCIDENT it was built for -- a
 * shell heredoc/echo/printf/sed can only ever emit a C0 byte -- but it was measured EVADED, at
 * zero cost, by three invisible characters that are not bytes: U+200B ZERO WIDTH SPACE, U+202E
 * RIGHT-TO-LEFT OVERRIDE and U+00AD SOFT HYPHEN each passed a full run.
 *
 * Two of those three are closed here, and the choice between them was made by MEASUREMENT, not
 * by appetite. Counted over every tracked text file:
 *
 *   BANNED (0 legitimate uses found, and a documented exploit class -- Trojan Source,
 *   CVE-2021-42574, in which a bidi override makes source read differently to a human than to
 *   the compiler):   U+202A..U+202E, U+2066..U+2069, U+00AD.
 *
 *   STILL LEGAL, DELIBERATELY:   U+200B ZWSP, U+00A0 NBSP (deliberate non-breaking spaces in
 *   UI text), U+FEFF BOM (3 files).
 *
 * So the residual is real and is stated rather than papered over: anyone who WANTS to hide a
 * character in this repository can still do it with one zero-width space. This guard is a
 * defence against an accident that has shipped three times, not a security boundary against a
 * deliberate adversary. The test suite pins that limit as a fact, so nobody mistakes it later.
 *
 * ★★★ THE SCOPE BOUNDARY, RULED 2026-09-09 (founder ruling on E6-F020). THIS IS A DELIBERATE
 * SCOPE, NOT A KNOWN HOLE, and the principle that decides it is the guard's own rule stated
 * one level up:
 *
 *     THE RULE IS "BAN THE RAW BYTE, PERMIT THE ESCAPE".
 *
 * That rule can only be applied where an escape can be written. INSIDE A BLOCK COMMENT THERE
 * IS NO ESCAPE -- a backslash-u-200B written inside a comment is six literal characters that
 * denote nothing, not a codepoint the reader can see standing in for one.
 *
 * SO, STATED AS TWO SEPARATE RULES OVER TWO SEPARATE SETS -- because this guard does BOTH and
 * an earlier wording of this paragraph denied the second, in flat contradiction of
 * BANNED_CODEPOINTS eight lines below it:
 *
 *   (i) ALL RAW C0/DEL BYTES ARE BANNED, WITHOUT EXCEPTION. That is `isBannedByte`, it is a
 *       RANGE and not a list, and it is COMPLETE against the accident class -- a shell eating
 *       backslash-b can only ever emit a C0 byte. "Ban the raw byte, permit the escape"
 *       applies here in full, because in every context where a C0 byte can appear an escape
 *       can be written instead.
 *
 *   (ii) AN ENUMERATED SET OF AUTHORED INVISIBLE CODEPOINTS IS ALSO BANNED: U+00AD SHY and the
 *        bidi overrides/isolates U+202A..U+202E and U+2066..U+2069 (BANNED_CODEPOINTS). Those
 *        are NOT an accident class at all -- they are Trojan Source (CVE-2021-42574), a
 *        deliberate adversarial technique -- and they are banned because the measurement found
 *        ZERO legitimate uses of them in this tree, so banning them costs nobody a rewrite.
 *
 * WHAT IS NOT CLAIMED: (ii) is an ENUMERATION, not a decision procedure, so this guard is NOT
 * COMPLETE against an author who deliberately hides a character. The gap is named above and
 * pinned by a test: U+200B ZWSP, U+00A0 NBSP and U+FEFF BOM stay legal because each has
 * legitimate uses here, and a ban whose only remedy is deletion gets the guard switched off.
 * The line therefore runs between "banned because nothing here needs it" and "permitted
 * because something here does" -- NOT between accident and intent. Adding a codepoint to (ii)
 * is a measurement (count the legitimate uses; if non-zero, supply the rewrite first), not a
 * category question.
 *
 * ★ THE COUNT WAS NEVER A FIXED SET, AND SAYING "2 uses" IMPLIED IT WAS. E6-F020 measured the
 * excused ZWSP use RECURRING within hours, in a new file, with nobody deciding to use it:
 * anyone writing a glob or a regex inside a JSDoc block reaches for it, because `*` + `/`
 * closes the comment. Read the census as a RECURRING PATTERN, not as grandfathered sites.
 *
 * ★ THE REWRITE RECIPE, so the next author has an out that is not "type an invisible
 * character". "No ESCAPE-based repair exists" is TRUE and is NOT the same claim as "no repair
 * exists". A repair exists, costs four characters, and is the one this guard's own design
 * constraint asks for (a rewrite that denotes the identical text; nothing is ever deleted):
 *
 *     CONVERT THE BLOCK COMMENT TO `//` LINE COMMENTS. Line comments have no terminator, so
 *     a glob or regex whose star is immediately followed by a slash -- the exact shape that
 *     would otherwise close a block comment -- can be written LITERALLY, with no invisible
 *     character at all.
 *
 * Applied in E6-F020's own repair: a JSDoc block became a run of `//` lines and all 24 tests
 * in that file kept passing. Use it. Do NOT add ZWSP/NBSP/BOM to the banned set to "fix" this
 * -- that was considered and REFUSED: banning them without a rewrite for every legitimate use
 * is the cry-wolf failure that gets a guard switched off, which is strictly worse than a
 * stated boundary.
 */
export const BANNED_CODEPOINTS = new Map([
  [0x00ad, "SHY"],
  [0x202a, "LRE"], [0x202b, "RLE"], [0x202c, "PDF"], [0x202d, "LRO"], [0x202e, "RLO"],
  [0x2066, "LRI"], [0x2067, "RLI"], [0x2068, "FSI"], [0x2069, "PDI"],
]);

/** Extensions whose contents are text a human reads and reviews. */
export const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".md", ".json", ".jsonl", ".yml", ".yaml", ".toml", ".sql", ".sh", ".ps1", ".cmd", ".bat",
  ".css", ".scss", ".html", ".svg", ".txt", ".patch", ".diff", ".example", ".env",
  ".dockerfile", ".sha256", ".webmanifest", ".key", ".crt", ".pem", ".py", ".log", ".3",
]);

/** Extension-less or dot-prefixed files that are text. */
export const TEXT_BASENAMES = new Set([
  "Dockerfile", "Makefile", "LICENSE", "CODEOWNERS",
  ".gitignore", ".gitattributes", ".dockerignore", ".npmrc", ".mailmap", ".nvmrc",
  ".gitkeep", ".editorconfig",
]);

/**
 * Extensions whose contents are NOT text and are never scanned. Listed explicitly rather than
 * inferred, so that adding a binary type is a decision somebody makes on purpose.
 */
export const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp", ".avif",
  ".pdf", ".docx", ".xlsx", ".pptx", ".zip", ".gz", ".tgz", ".br",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".webm", ".wav",
  ".node", ".wasm", ".dll", ".so", ".dylib", ".exe",
]);

/**
 * Basenames and suffixes that carry no type in their name and are known text. Kept SMALL and
 * separate from TEXT_BASENAMES so that adding one is visibly a judgement call.
 */
export const TEXT_NAME_PATTERNS = [
  /(^|\/)[^/]*-trigger$/, // keyed-e2b-*-trigger: one-line marker files
  /(^|\/)codex-session-id$/,
  /(^|\/)aoa$/,
  /(^|\/)claude$/,
  /(^|\/)codex$/,
  /\.onboard-smoke$/,
  /\.enrollment-ticket$/,
];

/**
 * text | binary | unknown. `unknown` FAILS the check: a new file type must be classified before
 * it can be silently skipped. See the default-deny note in the header.
 */
export function classifyPath(relPath) {
  const base = relPath.split("/").pop() ?? relPath;
  if (TEXT_BASENAMES.has(base)) return "text";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  if (ext && BINARY_EXTENSIONS.has(ext)) return "binary";
  if (ext && TEXT_EXTENSIONS.has(ext)) return "text";
  if (TEXT_NAME_PATTERNS.some((re) => re.test(relPath))) return "text";
  return "unknown";
}

/**
 * Every banned byte in one buffer, with 1-based line and column. Column counts BYTES, which is
 * what a human needs to find an invisible character, and avoids a decode step that could
 * normalise the very thing being hunted.
 */
export function scanBuffer(buf) {
  const hits = [];
  let line = 1;
  let col = 1;
  for (const code of buf) {
    if (code === 0x0a) {
      line += 1;
      col = 1;
      continue;
    }
    if (isBannedByte(code)) hits.push({ line, col, code, name: byteName(code) });
    col += 1;
  }
  return hits;
}

/**
 * Banned non-byte characters in decoded text, with 1-based line and CHARACTER column.
 * Separate from scanBuffer because these do not exist at the byte layer.
 */
export function scanText(text) {
  const hits = [];
  let line = 1;
  let col = 1;
  for (const chr of text) {
    if (chr === "\n") {
      line += 1;
      col = 1;
      continue;
    }
    const cp = chr.codePointAt(0);
    if (BANNED_CODEPOINTS.has(cp)) {
      hits.push({ line, col, code: cp, name: `${BANNED_CODEPOINTS.get(cp)} U+${cp.toString(16).toUpperCase().padStart(4, "0")}` });
    }
    col += 1;
  }
  return hits;
}

/** Tracked files, from git. The scan follows the index, not the working tree's stray junk. */
export function listTrackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean);
}

export function evaluateTree(root, opts = {}) {
  const files = opts.files ?? listTrackedFiles(root);
  const readFile = opts.readFile ?? ((rel) => readFileSync(path.join(root, rel)));
  const violations = [];
  const unclassified = new Map();
  let scanned = 0;

  for (const rel of files) {
    const kind = classifyPath(rel);
    if (kind === "binary") continue;
    if (kind === "unknown") {
      const base = rel.split("/").pop() ?? rel;
      const dot = base.lastIndexOf(".");
      const key = dot > 0 ? base.slice(dot).toLowerCase() : base;
      if (!unclassified.has(key)) unclassified.set(key, rel);
      continue;
    }
    let buf;
    try {
      buf = readFile(rel);
    } catch {
      continue;
    }
    scanned += 1;
    for (const hit of scanBuffer(buf)) violations.push({ file: rel, ...hit });
    for (const hit of scanText(buf.toString("utf8"))) violations.push({ file: rel, ...hit });
  }

  return { violations, unclassified: [...unclassified].map(([k, e]) => ({ key: k, example: e })), scanned };
}

export function resolveRoot(argv) {
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return process.cwd();
}

export const REPAIR_ADVICE = [
  "REPAIR: replace the raw byte with an escape that DENOTES it. Never delete the surrounding",
  "text -- an explanation of this defect is exactly what must survive.",
  "  in code   a NUL separator      ->  \"\\0\"  or  \"\\u0000\"",
  "  in code   a regex boundary     ->  /\\bword/      (the two characters backslash and b)",
  "  in code   a control-char class ->  /[\\x00-\\x1f\\x7f]/",
  "  in prose  naming the character ->  `\\b`, 0x08, <BS>, or the words \"backspace byte\"",
  "Write the file with an editor or a program, not a shell heredoc/echo/printf/sed: those turn",
  "backslash-b into one 0x08 byte. Verify with `cat -A` (a backspace shows as ^H).",
].join("\n");

function main() {
  const root = resolveRoot(process.argv.slice(2));
  const { violations, unclassified, scanned } = evaluateTree(root);

  if (unclassified.length > 0) {
    console.error("unclassified file types (this check is DEFAULT-DENY -- classify them):");
    for (const u of unclassified) console.error(`  ${u.key.padEnd(20)} e.g. ${u.example}`);
    console.error(
      "\nAdd each to TEXT_EXTENSIONS / TEXT_BASENAMES / BINARY_EXTENSIONS in this script.",
    );
  }
  if (violations.length > 0) {
    console.error(`\ninvisible control characters in ${new Set(violations.map((v) => v.file)).size} file(s):`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.col}  ${v.name}`);
    }
    console.error(`\n${REPAIR_ADVICE}`);
  }
  if (violations.length > 0 || unclassified.length > 0) process.exit(1);
  console.log(`invisible control characters: PASS (${scanned} text files scanned, 0 raw control bytes)`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
