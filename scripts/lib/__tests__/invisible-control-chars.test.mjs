// Self-test for scripts/check-invisible-control-chars.mjs.
//
// ★ EVERY BANNED BYTE IN THIS FILE IS BUILT WITH String.fromCharCode. Typing one literally
// would make this file its own counterexample, and a scanner whose self-test trips the scanner
// is indistinguishable from a scanner that is broken.
//
// The suite is deliberately half NEGATIVE and half POSITIVE. A ban that reds on everything is
// not a working ban, it is a broken harness -- so the positive controls below are the exact
// shapes the repository must keep being allowed to write: prose that DISCUSSES these regexes,
// the post-mortem comment that exists to prevent recurrence, and the four authored control
// characters expressed as escapes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyPath,
  evaluateTree,
  isBannedByte,
  scanBuffer,
  TEXT_EXTENSIONS,
  BINARY_EXTENSIONS,
} from "../../check-invisible-control-chars.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ch = (code) => String.fromCharCode(code);
const BS = ch(92); // backslash
const NUL = ch(0);
const BSP = ch(8);
const DEL = ch(0x7f);
const ESC = ch(0x1b);
const buf = (s) => Buffer.from(s, "utf8");

/** Run the checker over an in-memory tree. No temp files, so nothing can leak into the repo. */
function evaluate(tree) {
  return evaluateTree(ROOT, {
    files: Object.keys(tree),
    readFile: (rel) => buf(tree[rel]),
  });
}

// ---------------------------------------------------------------- byte set

test("the banned set is C0 minus tab/LF/CR, plus DEL", () => {
  assert.equal(isBannedByte(0x00), true, "NUL");
  assert.equal(isBannedByte(0x08), true, "BS -- the defect byte");
  assert.equal(isBannedByte(0x1b), true, "ESC");
  assert.equal(isBannedByte(0x1f), true, "US -- missed by the six-byte reconnaissance list");
  assert.equal(isBannedByte(0x7f), true, "DEL -- missed by BOTH earlier lists");
  assert.equal(isBannedByte(0x09), false, "TAB");
  assert.equal(isBannedByte(0x0a), false, "LF");
  assert.equal(isBannedByte(0x0d), false, "CR -- this repo has CRLF files");
  assert.equal(isBannedByte(0x20), false, "space");
  assert.equal(isBannedByte(0x41), false, "A");
});

test("a hit names its line and column", () => {
  const hits = scanBuffer(buf(`one\ntwo${BSP}three\n`));
  assert.equal(hits.length, 1);
  assert.deepEqual({ line: hits[0].line, col: hits[0].col, name: hits[0].name }, {
    line: 2, col: 4, name: "BS",
  });
});

// ---------------------------------------------------------------- NEGATIVE controls (must RED)

test("RED: a 0x08 in a regex in a .mjs script", () => {
  const { violations } = evaluate({
    "scripts/thing.mjs": `if (/^pnpm install${BSP}/.test(cmd)) continue;\n`,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, "scripts/thing.mjs");
  assert.equal(violations[0].line, 1);
  assert.equal(violations[0].name, "BS");
});

test("RED: a 0x08 in a .ts source file", () => {
  const { violations } = evaluate({
    "server/src/x.ts": `const re = /${BSP}word/;\nconst ok = 1;\n`,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, "server/src/x.ts");
  assert.equal(violations[0].name, "BS");
});

test("RED: a NUL in a .ts file -- and the file is NOT skipped for containing one", () => {
  // ★ THE CHEAPEST WRONG IMPLEMENTATION. Sniffing "does this file contain a NUL?" to skip
  // binaries would exempt exactly the files this guard exists to catch. Classification is by
  // path, never by content, and this test is what holds that line.
  const { violations } = evaluate({ "server/src/y.ts": `join("${NUL}");\n` });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, "NUL");
});

test("RED: DEL and ESC, the two bytes the reconnaissance lists missed", () => {
  const { violations } = evaluate({
    "packages/a/src/z.ts": `const a = "x${DEL}";\nconst b = "y${ESC}";\n`,
  });
  assert.deepEqual(violations.map((v) => `${v.line}:${v.name}`), ["1:DEL", "2:ESC"]);
});

test("RED: an unclassified file type fails rather than being skipped", () => {
  const { unclassified, violations } = evaluate({ "tools/thing.rb": "puts 1\n" });
  assert.equal(violations.length, 0);
  assert.deepEqual(unclassified.map((u) => u.key), [".rb"]);
});

// ---------------------------------------------------------------- POSITIVE controls (must stay GREEN)

test("GREEN: markdown that DISCUSSES these regexes in prose", () => {
  // The two documents that discuss the defect must remain writable AS THEY ARE. This is the
  // shape the earlier substring scanner got wrong: it flagged the explanation of the bug.
  const doc = [
    `3. **\`${BS}b5${BS}d{2}${BS}b\` was anchored** to \`(?:error|status|HTTP)${BS}D{0,10}${BS}b5${BS}d{2}${BS}b\`,`,
    `Node's upward walk from \`C:${BS}pn${BS}blockab${BS}\` never reaches the hoisted vitest.`,
    "The byte is 0x08, also written <BS>, also called a backspace byte.",
    `A literal ${BS}u0008 or ${BS}x08 in prose is fine; only the raw byte is not.`,
  ].join("\n");
  const { violations } = evaluate({ "docs/plan.md": doc });
  assert.deepEqual(violations, []);
});

test("GREEN: the post-mortem comment that exists to prevent recurrence", () => {
  const comment = [
    "/**",
    " * Two earlier attempts at this line were wrong in instructive ways. The first",
    ` * carried RAW 0x08 backspace bytes where \`${BS}b\` was intended, so the regex matched`,
    " * nothing while the corpus still reported green -- a guard that was dead the day",
    " * it was written. The second was a plain substring scan over raw source, which",
    " * then flagged `command-runner.ts` for the COMMENTS explaining why existsSync was",
    " * removed: a checker that makes you delete the explanation of a bug is a bad",
    " * checker.",
    " */",
  ].join("\n");
  const { violations } = evaluate({ "scripts/lib/boundary.mjs": comment });
  assert.deepEqual(violations, [], "the explanation of the bug must survive the checker");
});

test("GREEN: all four authored control characters, written as escapes", () => {
  const tree = {
    // a deliberate join separator
    "packages/worker-daemon/src/supervisor/provider.ts": `].join("${BS}0");\n`,
    // a fake binary fixture
    "scripts/lib/__tests__/embedded-secret-scan.test.mjs":
      `{ path: "dist/logo.png", text: "${BS}x00${BS}x01${BS}x02${BS}uFFFD" },\n`,
    // a control-character strip range
    "server/src/services/asset-content-guard.ts":
      `.replace(/[${BS}x00-${BS}x1f${BS}x7f]/g, "")\n`,
    // a truthiness sentinel
    "server/src/services/mcp-connectors.ts": `secretValue: hasSecret ? "${BS}u0000bound" : null,\n`,
  };
  const { violations } = evaluate(tree);
  assert.deepEqual(violations, [], "an escape denotes the character without hiding it");
});

test("GREEN: tab, CRLF and ordinary text", () => {
  const { violations } = evaluate({
    "a.ts": "const x = 1;\r\n\tconst y = 2;\r\n",
    "b.md": "# Title\n\n- item\ttabbed\n",
  });
  assert.deepEqual(violations, []);
});

test("GREEN: declared binaries are skipped, and their bytes are not reported", () => {
  const { violations, scanned } = evaluate({
    "ui/public/favicon.ico": `${NUL}${NUL}${BSP}${ESC}`,
    "docs/a.png": `${NUL}${DEL}`,
  });
  assert.deepEqual(violations, []);
  assert.equal(scanned, 0);
});

// ---------------------------------------------------------------- classification

test("classifyPath separates text, binary and unknown", () => {
  assert.equal(classifyPath("server/src/a.ts"), "text");
  assert.equal(classifyPath("docs/a.md"), "text");
  assert.equal(classifyPath("Dockerfile"), "text");
  assert.equal(classifyPath("docker/x/Dockerfile"), "text");
  assert.equal(classifyPath(".gitattributes"), "text");
  assert.equal(classifyPath("ui/public/favicon.ico"), "binary");
  assert.equal(classifyPath("a/b/logo.png"), "binary");
  assert.equal(classifyPath("tools/x.rb"), "unknown");
});

test("no extension is in both the text and the binary list", () => {
  const both = [...TEXT_EXTENSIONS].filter((e) => BINARY_EXTENSIONS.has(e));
  assert.deepEqual(both, []);
});

// ---------------------------------------------------------------- the real tree

test("the repository itself is clean, and every tracked type is classified", () => {
  const { violations, unclassified, scanned } = evaluateTree(ROOT);
  assert.deepEqual(
    unclassified.map((u) => `${u.key} (e.g. ${u.example})`),
    [],
    "a new file type must be classified before it can be skipped",
  );
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line}:${v.col} ${v.name}`),
    [],
  );
  assert.ok(scanned > 5000, `expected the scan to reach the tree, saw ${scanned} files`);
});

// ---------------------------------------------------------------- the evasion boundary

test("bidi overrides and SHY are caught -- 0 legitimate uses, and a known exploit class", () => {
  // Trojan Source (CVE-2021-42574): a bidi override makes source read one way to a human and
  // another to the compiler. Measured over every tracked text file: zero uses, so banning them
  // costs nothing.
  const cp = (n) => String.fromCodePoint(n);
  for (const n of [0x00ad, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    const { violations } = evaluate({ "server/src/a.ts": `const ROOT${cp(n)} = 1;\n` });
    assert.equal(violations.length, 1, `U+${n.toString(16)} must be caught`);
  }
});

test("★ THE DOCUMENTED LIMIT: ZWSP, NBSP and BOM still evade this guard, on purpose", () => {
  // ★★★ THIS TEST ASSERTS A WEAKNESS, AND IT IS SUPPOSED TO. The cheapest evasion of this guard
  // is one zero-width space: cost zero, and a full run passes.
  //
  // So: the BYTE SCAN is a defence against an ACCIDENT that has shipped three times -- a shell
  // eating backslash-b, which can only ever produce a C0 byte -- and it is complete against
  // that. The guard as a whole is NOT a security boundary against a deliberate adversary, and
  // must never be cited as one.
  //
  // ★★★ THE DECISION THIS TEST RECORDS, RULED 2026-09-09 (founder ruling on E6-F020). The
  // boundary is DELIBERATE SCOPE, not a known hole. The guard's rule is "ban the raw byte,
  // permit the ESCAPE" -- and that rule can only be applied where an escape can be written.
  // Inside a block comment there IS no escape, only a REWRITE.
  //
  // ★ SAID PRECISELY, because an earlier wording of this comment said the guard "was never a
  // candidate" for the AUTHORED class and the test DIRECTLY ABOVE refutes it: BANNED_CODEPOINTS
  // bans U+00AD and the bidi overrides/isolates, which are Trojan Source -- a purely AUTHORED
  // adversarial class. The guard does BOTH: (i) ALL raw C0/DEL bytes, a complete range, where
  // "ban the byte, permit the escape" applies in full; and (ii) an ENUMERATED set of authored
  // invisible codepoints, banned because this tree has ZERO legitimate uses of them so the ban
  // costs nobody a rewrite. (ii) is an enumeration, not a decision procedure, so it is not
  // complete against a determined author. The line runs between "banned because nothing here
  // needs it" and "permitted because something here does" -- NOT between accident and intent.
  // The three codepoints asserted below are on the permitted side for exactly that reason.
  //
  // ★ WHAT WAS CORRECTED AT THE SAME TIME. This comment used to say ZWSP stays legal because
  // "no escape-based repair exists", and the guard header used to count "2 uses" as though the
  // set were fixed. E6-F020 refuted both: the excused use RECURRED within hours in a new file,
  // so it is a RECURRING PATTERN (anyone writing a glob or regex inside a JSDoc block reaches
  // for it), and "no ESCAPE-based repair" is not "no repair" -- the REWRITE RECIPE is to
  // convert the block comment to `//` line comments, which have no terminator, so a star
  // followed by a slash can be written literally. That repair cost four characters and kept
  // 24 tests green in the file that hit it.
  //
  // ★ AND THE ALTERNATIVE WAS REFUSED, not deferred: adding ZWSP/NBSP/BOM to the banned set
  // without a rewrite for every legitimate use is the cry-wolf failure that gets a guard
  // switched off. If it is ever revisited, the change is to ban ZWSP/NBSP, repair the
  // legitimate uses with the rewrite recipe, and INVERT this test with a positive control.
  // This test is still the place that decision gets recorded.
  const cp = (n) => String.fromCodePoint(n);
  for (const n of [0x200b, 0x00a0, 0xfeff]) {
    const { violations } = evaluate({ "server/src/a.ts": `const ROOT${cp(n)} = 1;\n` });
    assert.deepEqual(violations, [], `U+${n.toString(16)} is knowingly permitted`);
  }
});

test("this test file and the checker are themselves free of raw control bytes", () => {
  // A scanner whose own source trips the scanner is indistinguishable from a broken one.
  for (const rel of [
    "scripts/check-invisible-control-chars.mjs",
    "scripts/lib/__tests__/invisible-control-chars.test.mjs",
  ]) {
    assert.deepEqual(scanBuffer(readFileSync(path.join(ROOT, rel))), [], rel);
  }
});

// ---------------------------------------------------------------- the ENTRY POINT

/**
 * ★★★ WHY THIS SPAWNS A SUBPROCESS INSTEAD OF CALLING evaluateTree.
 *
 * Every test above this line imports the library and never runs the script. An adversarial
 * mutation pass proved what that leaves open: DELETING `process.exit(1)` FROM main() SURVIVED
 * THE WHOLE SUITE, and survived a clean-tree CI run too, because on a clean tree the exit code
 * is 0 either way. On a DIRTY tree — the only tree this guard exists for — the mutated script
 * printed its violations to stderr, then printed
 *
 *     invisible control characters: PASS (1 text files scanned, 0 raw control bytes)
 *
 * to stdout and exited 0. The CI step would have gone GREEN over a planted backspace byte while
 * naming it on screen. That is precisely "a check that nothing runs", one layer down: the
 * LIBRARY was checked, the EXECUTABLE never was, and the executable is what the workflow calls.
 *
 * So the assertion is on the EXIT STATUS of a real `node scripts/check-invisible-control-chars.mjs`
 * process. An exit code cannot be observed from inside the module, and no import-only test can
 * ever cover it.
 *
 * Cost: ONE `git init` and THREE node spawns over a two-file throwaway tree, ~1s total. The
 * fixture must be a git repository because `listTrackedFiles` follows the index rather than the
 * working tree — pointing `--root` at a plain directory would scan nothing and pass vacuously,
 * which is the same failure in a new costume. Hence the positive control below: run 2 asserts
 * the fixture CAN go green, so run 1's red is a verdict about the byte and not about the harness.
 */
test("the ENTRY POINT exits 1 on a dirty tree, 0 on a clean one, and names what it found", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "w19-control-chars-"));
  const guard = path.join(ROOT, "scripts", "check-invisible-control-chars.mjs");
  // GIT_DIR/GIT_WORK_TREE in the ambient environment (a git hook, a rebase) would silently
  // redirect `git init`/`git add` at the REAL repository. Strip them.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;

  const git = (...args) => execFileSync("git", args, { cwd: root, env, stdio: "ignore" });
  const runGuard = () =>
    spawnSync(process.execPath, [guard, "--root", root], { encoding: "utf8", env });

  try {
    git("init", "-q");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    const planted = path.join(root, "scripts", "planted.mjs");

    // (1) NEGATIVE — a raw 0x08 exactly where the two characters backslash-b belonged. This is
    //     the ci-local.mjs defect, replanted.
    writeFileSync(planted, `if (/^pnpm install${BSP}/.test(cmd)) continue;\n`, "utf8");
    git("add", "-A", "-f");
    const dirty = runGuard();
    assert.equal(dirty.status, 1, `a planted 0x08 must exit 1, saw ${dirty.status}\n${dirty.stderr}`);
    assert.match(dirty.stderr, /scripts\/planted\.mjs:1:\d+\s+BS/, "the violation must be NAMED on stderr");
    assert.match(dirty.stderr, /REPAIR: replace the raw byte with an escape/, "and say how to repair it");
    assert.doesNotMatch(
      dirty.stdout,
      /PASS/,
      "★ the mutant printed both the violations AND `PASS`; a run that found something may never claim to have passed",
    );

    // (2) POSITIVE CONTROL — the SAME line written with the escape it always meant. If this
    //     went red, run (1) would prove nothing: a guard that reds on everything is a broken
    //     harness, not a working ban.
    writeFileSync(planted, `if (/^pnpm install${BS}b/.test(cmd)) continue;\n`, "utf8");
    git("add", "-A", "-f");
    const clean = runGuard();
    assert.equal(clean.status, 0, `the escape form must exit 0, saw ${clean.status}\n${clean.stderr}`);
    assert.match(clean.stdout, /invisible control characters: PASS \(1 text files scanned/);

    // (3) NEGATIVE — the OTHER arm of the same exit condition. `process.exit(1)` fires on
    //     `violations.length > 0 || unclassified.length > 0`, and a mutant that drops the
    //     second disjunct would still pass (1) and (2). Default-deny needs its own spawn.
    writeFileSync(path.join(root, "thing.rb"), "puts 1\n", "utf8");
    git("add", "-A", "-f");
    const unclassified = runGuard();
    assert.equal(
      unclassified.status,
      1,
      `an unclassified file type must exit 1, saw ${unclassified.status}\n${unclassified.stderr}`,
    );
    assert.match(unclassified.stderr, /DEFAULT-DENY/);
    assert.match(unclassified.stderr, /\.rb\s+e\.g\. thing\.rb/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
