#!/usr/bin/env node
/**
 * Self-test for `scripts/check-register-citation-integrity.mjs`.
 *
 * A GUARD WITH NO POSITIVE CONTROL IS ITSELF THE FAILURE CLASS IT FIGHTS. The first test is the
 * positive control: the migrated tree passes with zero errors, so a red below is attributable to
 * the mutation and not to a broken harness. Every check — (a) exists, (b) in-range, (c) reaches
 * real code, (d) REQUIRED + VERIFIED symbol anchor — plus the grandfather arm and the fail-closed
 * posture is driven to RED by a specific mutation, and each red is asserted to carry the message
 * naming that check. NEGATIVE controls prove the scope narrowings (bare refs, unanchored paths,
 * comment/import lines, strict anchor variants) neither swallow nor over-fire.
 *
 * Usage: node --test scripts/check-register-citation-integrity.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collect,
  evaluateCitationIntegrity,
  parseCitations,
  anchorVariants,
  anchorMatches,
  anchorMatchCount,
  isAnchored,
  computeRepoRoots,
  computeCensus,
  splitPhysicalLines,
  KNOWN_REPO_ROOTS,
  GRANDFATHER_JSON,
} from "./check-register-citation-integrity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const report = (errors) => `errors:\n${errors.map((e) => `  - ${e}`).join("\n") || "  (none)"}`;
const hasError = (errors, needle) => errors.some((e) => e.includes(needle));

/** A default in-scope, explicit, repo-anchored, ANCHORED citation (anchors are required). */
function cit(overrides = {}) {
  return {
    crossingId: "DE-01",
    field: "deliveryEvidence",
    path: "server/src/foo.ts",
    line: "2",
    kind: "explicit-slash",
    anchored: true,
    inScope: true,
    anchorToken: "doThing",
    ...overrides,
  };
}
/** A files map whose server/src/foo.ts line 2 carries the default anchor `doThing`. */
const passFiles = () => ({ "server/src/foo.ts": { exists: true, lines: ["first();", "doThing();", "third();"] } });
function makeInput({ citations = [], files = {}, entries = [] } = {}) {
  return { citations, files, grandfather: { version: 1, entries } };
}

// --- POSITIVE CONTROLS ------------------------------------------------------------------

test("POSITIVE CONTROL: the migrated tree passes with zero errors", () => {
  const { errors, notes } = evaluateCitationIntegrity(collect(REPO_ROOT));
  assert.deepEqual(errors, [], report(errors));
  assert.ok(notes.some((n) => n.includes("enforced")), notes.join("\n"));
});

test("POSITIVE CONTROL: the enforced set is non-trivial (>100 citations actually checked)", () => {
  const { notes } = evaluateCitationIntegrity(collect(REPO_ROOT));
  const m = /(\d+) enforced/.exec(notes.join("\n"));
  assert.ok(m && Number(m[1]) > 100, `expected >100 enforced, got: ${notes.join("\n")}`);
});

test("POSITIVE CONTROL: a fully-correct anchored citation passes", () => {
  const { errors } = evaluateCitationIntegrity(makeInput({ citations: [cit()], files: passFiles() }));
  assert.deepEqual(errors, [], report(errors));
});

// --- (a) EXISTS -------------------------------------------------------------------------

test("(a) EXISTS: a cited file absent at HEAD reds", () => {
  const input = makeInput({ citations: [cit({ path: "server/src/gone.ts", line: "5" })], files: { "server/src/gone.ts": { exists: false, lines: [] } } });
  const { errors } = evaluateCitationIntegrity(input);
  assert.ok(hasError(errors, "cited file does not exist at HEAD"), report(errors));
  assert.ok(hasError(errors, "server/src/gone.ts:5"), report(errors));
});

test("(a) EXISTS on the REAL tree: deleting a real cited file reds [required control iv]", () => {
  const input = collect(REPO_ROOT);
  const target = input.citations.find((c) => c.inScope);
  assert.ok(target, "fixture drift: no in-scope citation");
  input.files[target.path] = { exists: false, lines: [] };
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "cited file does not exist at HEAD"));
});

// --- (b) IN-RANGE -----------------------------------------------------------------------

test("(b) IN-RANGE: a line past EOF reds [required control iv]", () => {
  const input = makeInput({ citations: [cit({ line: "99" })], files: { "server/src/foo.ts": { exists: true, lines: ["a", "b", "c"] } } });
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "is outside the file, which has 3 lines"));
});

test("(b) IN-RANGE: a range overshoot reds", () => {
  const input = makeInput({ citations: [cit({ line: "2-9" })], files: { "server/src/foo.ts": { exists: true, lines: ["a", "b", "c"] } } });
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "line 2-9 is outside the file"));
});

test("(b) IN-RANGE on the REAL tree: bumping a real citation past EOF reds (the PR #443 rot class)", () => {
  const input = collect(REPO_ROOT);
  const target = input.citations.find((c) => c.inScope && input.files[c.path]?.exists);
  assert.ok(target, "fixture drift");
  target.line = String(input.files[target.path].lines.length + 25);
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "is outside the file"));
});

// --- (c) REACHES-REAL-CODE --------------------------------------------------------------

test("(c) REACHES-CODE: a single-line code citation onto a BLANK line reds", () => {
  const input = makeInput({ citations: [cit({ line: "2", anchorToken: "doThing" })], files: { "server/src/foo.ts": { exists: true, lines: ["doThing();", "   ", "x"] } } });
  // anchor `doThing` is within ±5 (line 1) so only the blank check can speak here.
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "cites a BLANK line"));
});

test("NEGATIVE CONTROL (c): a citation onto a COMMENT line passes (register cites comments on purpose)", () => {
  const input = makeInput({ citations: [cit({ line: "2", anchorToken: "deliberatelyCited" })], files: { "server/src/foo.ts": { exists: true, lines: ["x();", "// deliberatelyCited comment", "y();"] } } });
  assert.deepEqual(evaluateCitationIntegrity(input).errors, []);
});

test("NEGATIVE CONTROL (c): a citation onto an IMPORT line passes", () => {
  const input = makeInput({ citations: [cit({ line: "1", anchorToken: "uniqueImportedThing" })], files: { "server/src/foo.ts": { exists: true, lines: ['import { uniqueImportedThing } from "./x";', "", "run();"] } } });
  assert.deepEqual(evaluateCitationIntegrity(input).errors, []);
});

test("NEGATIVE CONTROL (c): a blank line in a NON-code file does not red — (c) is code-only", () => {
  const input = makeInput({ citations: [cit({ path: "docs/x.md", line: "2", anchorToken: "heading" })], files: { "docs/x.md": { exists: true, lines: ["# heading", "", "body"] } } });
  assert.deepEqual(evaluateCitationIntegrity(input).errors, []);
});

// --- (d) SYMBOL ANCHOR — REQUIRED + VERIFIED --------------------------------------------

test("(d) REQUIRED: an enforced citation with NO anchor reds [required control ii]", () => {
  const input = makeInput({ citations: [cit({ anchorToken: null })], files: passFiles() });
  const { errors } = evaluateCitationIntegrity(input);
  assert.ok(hasError(errors, "MISSING anchor"), report(errors));
  assert.ok(hasError(errors, "server/src/foo.ts:2"), report(errors));
});

test("(d) VERIFY: correct anchor within ±5 passes [required control iii]", () => {
  const lines = ["l1", "l2", "l3", "l4", "insertJobOnce(row);", "l6"]; // anchor at line 5
  const input = makeInput({ citations: [cit({ line: "1", anchorToken: "insertJobOnce" })], files: { "server/src/foo.ts": { exists: true, lines } } });
  assert.deepEqual(evaluateCitationIntegrity(input).errors, []); // 5 is within 1±5
});

test("(d) VERIFY: the construct moved OUT of the ±5 window reds [required control i]", () => {
  const lines = Array.from({ length: 40 }, (_, i) => (i === 29 ? "  insertJobOnce(row);" : `line ${i + 1}`)); // construct at line 30
  const good = makeInput({ citations: [cit({ line: "30", anchorToken: "insertJobOnce" })], files: { "server/src/foo.ts": { exists: true, lines } } });
  assert.deepEqual(evaluateCitationIntegrity(good).errors, [], "correct citation must be green first");
  const moved = makeInput({ citations: [cit({ line: "10", anchorToken: "insertJobOnce" })], files: { "server/src/foo.ts": { exists: true, lines } } }); // cite says 10, construct at 30
  assert.ok(hasError(evaluateCitationIntegrity(moved).errors, "does not appear within ±5 lines"));
});

test("(d) VERIFY: a range citation's anchor within [lo-5, hi+5] passes", () => {
  const lines = Array.from({ length: 30 }, (_, i) => (i === 24 ? "  placementLeaseEligible: true," : `line ${i + 1}`)); // anchor at 25
  const input = makeInput({ citations: [cit({ line: "18-22", anchorToken: "placementLeaseEligible" })], files: { "server/src/foo.ts": { exists: true, lines } } });
  assert.deepEqual(evaluateCitationIntegrity(input).errors, []); // 25 within [13, 27]
});

test("(d) STRICT variants: a multi-token anchor does NOT match on a bare leading identifier nearby", () => {
  // line 2 has a bare `authority`; the real `authority.recordProof` is far away (line 30).
  const lines = Array.from({ length: 40 }, (_, i) => (i === 1 ? "const authority = x;" : i === 29 ? "authority.recordProof(p);" : `line ${i + 1}`));
  const input = makeInput({ citations: [cit({ line: "2", anchorToken: "authority.recordProof" })], files: { "server/src/foo.ts": { exists: true, lines } } });
  // If variants leaked a bare-`authority` fallback this would falsely PASS; strict variants red it.
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "does not appear within ±5 lines"));
});

test("(d) call variant: `admit()` matches `admit(payload)` within ±5", () => {
  const input = makeInput({ citations: [cit({ line: "1", anchorToken: "admit()" })], files: { "server/src/foo.ts": { exists: true, lines: ["x", "return admit(payload);", "y"] } } });
  assert.deepEqual(evaluateCitationIntegrity(input).errors, []);
});

// --- EXTENSION BUG (Codex P2 :106) ------------------------------------------------------

test("EXT BUG: `guard-inventory.json:189` classifies as an enforced .json citation [required control v]", () => {
  const cits = parseCitations("declared at scripts/guard-inventory.json:189 in the manifest");
  assert.equal(cits.length, 1, `expected one citation, got ${JSON.stringify(cits)}`);
  assert.equal(cits[0].kind, "explicit-slash");
  assert.equal(cits[0].path, "scripts/guard-inventory.json");
  assert.equal(cits[0].line, "189");
  assert.equal(isAnchored(cits[0].path, KNOWN_REPO_ROOTS), true);
});

test("EXT BUG: .tsx / .jsx do not truncate to .ts / .js", () => {
  assert.equal(parseCitations("ui/src/App.tsx:10")[0].path, "ui/src/App.tsx");
  assert.equal(parseCitations("ui/src/App.jsx:10")[0].path, "ui/src/App.jsx");
});

// --- P2 REGRESSION CONTROLS (prior commit) ----------------------------------------------

test("P2-1 STATIC ROOTS: a citation under a repo root ABSENT at HEAD is still anchored → reds (a)", () => {
  const rootsFromScripts = computeRepoRoots(path.join(REPO_ROOT, "scripts"));
  assert.ok(rootsFromScripts.has("server"), "static roots must contain `server` even scanning a dir without it");
  const anchored = isAnchored("server/src/gone.ts", rootsFromScripts);
  assert.equal(anchored, true);
  const input = makeInput({ citations: [cit({ crossingId: "DE-09", path: "server/src/gone.ts", line: "5", anchored, inScope: anchored })], files: { "server/src/gone.ts": { exists: false, lines: [] } } });
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "cited file does not exist at HEAD"));
});

test("P2-2 PHYSICAL COUNT: one line past EOF of a trailing-newline file reds; the true last line passes", () => {
  const content = "l1();\nl2();\ndoThing();\n";
  assert.equal(content.split(/\r?\n/).length, 4, "raw split appends the sentinel (the bug)");
  const lines = splitPhysicalLines(content);
  assert.equal(lines.length, 3);
  const files = { "server/src/foo.ts": { exists: true, lines } };
  assert.ok(hasError(evaluateCitationIntegrity(makeInput({ citations: [cit({ line: "4" })], files })).errors, "is outside the file, which has 3 lines"));
  assert.deepEqual(evaluateCitationIntegrity(makeInput({ citations: [cit({ line: "3", anchorToken: "doThing" })], files })).errors, []);
  assert.deepEqual(splitPhysicalLines("a\n\n"), ["a", ""]);
});

// --- BEST-EFFORT SCOPE (negative controls) ----------------------------------------------

test("NEGATIVE CONTROL: an out-of-range BARE :LINE ref does NOT red (bare refs are best-effort)", () => {
  const input = makeInput({ citations: [cit({ kind: "bare", inScope: false, anchored: false, anchorToken: null, line: "9999" })], files: {} });
  const { errors, notes } = evaluateCitationIntegrity(input);
  assert.deepEqual(errors, [], report(errors));
  assert.ok(notes.some((n) => n.includes("1 bare :LINE")));
});

test("NEGATIVE CONTROL: an unanchored/relative path does NOT red (out of scope)", () => {
  const input = makeInput({ citations: [cit({ path: "routes/projects.ts", anchored: false, inScope: false, anchorToken: null, line: "5" })], files: {} });
  const { errors, notes } = evaluateCitationIntegrity(input);
  assert.deepEqual(errors, [], report(errors));
  assert.ok(notes.some((n) => n.includes("1 unanchored")));
});

// --- GRANDFATHER ------------------------------------------------------------------------

test("GRANDFATHER: a grandfathered violation passes; removing the entry re-reds", () => {
  const citations = [cit({ crossingId: "DE-05", path: "server/src/legacy.ts", line: "500", anchorToken: null })];
  const files = { "server/src/legacy.ts": { exists: true, lines: ["only one line"] } };
  const withGf = evaluateCitationIntegrity(makeInput({ citations, files, entries: [{ crossing: "DE-05", path: "server/src/legacy.ts", line: "500", category: "out-of-range", reason: "frozen historical block; code since moved" }] }));
  assert.deepEqual(withGf.errors, [], report(withGf.errors));
  assert.ok(hasError(evaluateCitationIntegrity(makeInput({ citations, files })).errors, "is outside the file"));
});

test("GRANDFATHER (bug 3, category-scoped): a missing-anchor entry does NOT mask a missing-FILE at the same signature", () => {
  // The citation now fails with a DIFFERENT category (missing-file) than the entry excuses.
  const citations = [cit({ crossingId: "DE-05", path: "server/src/legacy.ts", line: "500", anchorToken: null })];
  const files = { "server/src/legacy.ts": { exists: false, lines: [] } }; // missing file, not missing-anchor
  const { errors } = evaluateCitationIntegrity(makeInput({
    citations,
    files,
    entries: [{ crossing: "DE-05", path: "server/src/legacy.ts", line: "500", category: "missing-anchor", reason: "excuses only the anchor" }],
  }));
  assert.ok(hasError(errors, "cited file does not exist at HEAD"), report(errors)); // the missing-file is NOT masked
  assert.ok(hasError(errors, "is STALE"), report(errors)); // and the mis-categorised entry is flagged stale
});

test("GRANDFATHER (bug 3): the matching category IS suppressed", () => {
  const citations = [cit({ crossingId: "DE-05", path: "server/src/legacy.ts", line: "500", anchorToken: null })];
  const files = { "server/src/legacy.ts": { exists: false, lines: [] } };
  const { errors } = evaluateCitationIntegrity(makeInput({
    citations, files,
    entries: [{ crossing: "DE-05", path: "server/src/legacy.ts", line: "500", category: "missing-file", reason: "the file is legitimately gone" }],
  }));
  assert.deepEqual(errors, [], report(errors));
});

test("GRANDFATHER: an entry with NO category reds (a category-less grandfather would mask unrelated failures)", () => {
  const citations = [cit({ crossingId: "DE-05", path: "server/src/legacy.ts", line: "500", anchorToken: null })];
  const files = { "server/src/legacy.ts": { exists: true, lines: ["x"] } };
  const { errors } = evaluateCitationIntegrity(makeInput({ citations, files, entries: [{ crossing: "DE-05", path: "server/src/legacy.ts", line: "500", reason: "no category" }] }));
  assert.ok(hasError(errors, 'needs a "category"'), report(errors));
});

test("GRANDFATHER: a STALE entry (its citation no longer violates) reds — self-cleaning", () => {
  const input = makeInput({
    citations: [cit({ crossingId: "DE-05", path: "server/src/foo.ts", line: "2", anchorToken: "doThing" })],
    files: passFiles(),
    entries: [{ crossing: "DE-05", path: "server/src/foo.ts", line: "2", category: "missing-anchor", reason: "stale — was drift, now fixed" }],
  });
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "is STALE"));
});

test("GRANDFATHER: an entry with an empty reason reds", () => {
  const input = makeInput({ citations: [cit({ path: "server/src/legacy.ts", line: "500", anchorToken: null })], files: { "server/src/legacy.ts": { exists: true, lines: ["x"] } }, entries: [{ crossing: "DE-01", path: "server/src/legacy.ts", line: "500", reason: "   " }] });
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "needs a non-empty"));
});

test("GRANDFATHER: a malformed entries array (missing) reds fail-closed", () => {
  const { errors } = evaluateCitationIntegrity({ citations: [], files: {}, grandfather: { version: 1 } });
  assert.ok(hasError(errors, 'must be a JSON object with an "entries" array'));
});

test("collect(): an absent manifest FAILS rather than reading as an empty allow-list", () => {
  assert.throws(
    () => collect(path.join(REPO_ROOT, "scripts")),
    (e) => e instanceof Error && (e.message.includes(GRANDFATHER_JSON) || e.message.includes("threat-controls.json")),
  );
});

// --- PARSER -----------------------------------------------------------------------------

test("parseCitations: explicit slash + range, and bare :LINE attribution to the most recent path", () => {
  const cits = parseCitations("see server/src/a.ts:10 and packages/db/b.ts:20-25, then :30 in the same file");
  assert.deepEqual(cits.map((c) => `${c.path}:${c.line}:${c.kind}`), [
    "server/src/a.ts:10:explicit-slash",
    "packages/db/b.ts:20-25:explicit-slash",
    "packages/db/b.ts:30:bare",
  ]);
});

test("parseCitations: a bare filename with a line is explicit-filename", () => {
  const cits = parseCitations("worker-session-auth.ts:103 handles it");
  assert.equal(cits[0].kind, "explicit-filename");
});

test("parseCitations: backtick anchors after and before the citation are captured", () => {
  assert.equal(parseCitations("the gate at server/src/a.ts:10 (`admit()`) denies")[0].anchorToken, "admit()");
  assert.equal(parseCitations("`insertJobOnce` at packages/db/b.ts:20 inserts once")[0].anchorToken, "insertJobOnce");
});

test("anchorVariants: strips a call's argument list but adds NO generic fragment", () => {
  assert.deepEqual(anchorVariants("admit()"), ["admit()", "admit"]);
  assert.deepEqual(anchorVariants("admit(payload)"), ["admit(payload)", "admit"]);
  // a member/operator anchor keeps only the raw form — no leading-identifier leak
  assert.deepEqual(anchorVariants("authority.recordProof"), ["authority.recordProof"]);
  assert.deepEqual(anchorVariants("count > config.max"), ["count > config.max"]);
});

test("isAnchored: only a slash-path whose first segment is a repo root", () => {
  const roots = new Set(["server", "packages"]);
  assert.equal(isAnchored("server/src/a.ts", roots), true);
  assert.equal(isAnchored("routes/a.ts", roots), false);
  assert.equal(isAnchored("a.ts", roots), false);
});

// --- CENSUS: pin coverage so a silent drop reds (Codex P2 :70) ---------------------------

test("computeCensus: the real register matches the pinned census manifest (total + per-root)", () => {
  const input = collect(REPO_ROOT);
  const actual = computeCensus(input.citations);
  assert.equal(actual.total, input.census.total, "pinned total drifted from the live register");
  assert.deepEqual(actual.byRoot, input.census.byRoot, "pinned per-root census drifted");
});

test("CENSUS (RED-first): dropping a whole repo root REDs the census, not a silent green", () => {
  const input = collect(REPO_ROOT);
  const before = evaluateCitationIntegrity(input);
  assert.deepEqual(before.errors, [], `the real tree must be green first:\n${report(before.errors)}`);
  const droppedRootTotal = computeCensus(input.citations).byRoot.packages;
  const newTotal = input.census.total - droppedRootTotal;
  // simulate a parser/scope regression that stops emitting `packages` citations
  input.citations = input.citations.filter((c) => c.path.split("/")[0] !== "packages");
  const { errors } = evaluateCitationIntegrity(input);
  assert.ok(hasError(errors, `census changed — expected total ${input.census.total}, got ${newTotal}`), report(errors));
  assert.ok(hasError(errors, 'root "packages" changed — expected'), report(errors));
});

test("CENSUS: a total mismatch reds and points at the --update-census re-pin", () => {
  const input = makeInput({ citations: [cit()], files: passFiles() });
  input.census = { total: 5, byRoot: { "server": 5 } };
  const { errors } = evaluateCitationIntegrity(input);
  assert.ok(hasError(errors, "expected total 5, got 1"), report(errors));
  assert.ok(hasError(errors, "--update-census"), report(errors));
});

test("CENSUS: absent manifest (no census on synthetic input) skips the check — real run loads it fail-closed", () => {
  // makeInput carries no census, so the pure evaluator does not run the census check on fixtures.
  const { errors } = evaluateCitationIntegrity(makeInput({ citations: [cit()], files: passFiles() }));
  assert.deepEqual(errors, [], report(errors));
});

// --- CODEX P2 GUARD-LOGIC CONTROLS ------------------------------------------------------

test("BUG1 (call-name boundary): a moved `admit()` is NOT satisfied by an unrelated `admittedUserRequester`", () => {
  // unit: the stripped call name matches only at an identifier boundary + call syntax
  assert.equal(anchorMatches("  return admit(payload);", "admit()"), true);
  assert.equal(anchorMatches("async function admittedUserRequester(input) {", "admit()"), false);
  assert.equal(anchorMatches("const x = preadmit(y);", "admit()"), false);
  // integration: anchor `admit()` whose ±5 window holds only `admittedUserRequester` reds
  const lines = ["l1", "l2", "async function admittedUserRequester(input) {", "l4", "l5"];
  const input = makeInput({ citations: [cit({ line: "3", anchorToken: "admit()" })], files: { "server/src/foo.ts": { exists: true, lines } } });
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "does not appear within ±5 lines"), "the substring-match false-pass must be gone");
});

test("BUG2 (static roots): classification is filesystem-independent — no dynamic union of existing dirs", () => {
  // computeRepoRoots ignores the tree: it never picks up a currently-existing non-repo dir...
  assert.equal(computeRepoRoots(REPO_ROOT).has("node_modules"), false, "a currently-existing non-repo dir must NOT be auto-classified a root");
  // ...and always returns exactly the static set, whatever path is passed
  assert.deepEqual([...computeRepoRoots("/nonexistent")].sort(), [...KNOWN_REPO_ROOTS].sort());
  // so a KNOWN root that does NOT exist on disk still classifies anchored -> reds on file-exists
  assert.equal(isAnchored("server/src/gone.ts", computeRepoRoots("/whatever")), true);
});

test("BUG4 (before-slice): a ~60-char before-style backtick anchor is captured, not lost", () => {
  const anchor = "a sixty character distinctive before-anchor phrase here yes"; // 59 chars, > the old 40 window
  assert.ok(anchor.length > 40 && anchor.length <= 80);
  const cits = parseCitations("`" + anchor + "` at server/src/a.ts:10 does the thing");
  assert.equal(cits.length, 1);
  assert.equal(cits[0].anchorToken, anchor, "the before-style anchor must survive the widened slice");
});

test("BUG4: an after-style anchor still wins over a before-style one (precedence unchanged)", () => {
  const cits = parseCitations("`before` at server/src/a.ts:10 (`after`) end");
  assert.equal(cits[0].anchorToken, "after");
});

// --- DISTINCTIVENESS ORACLE (the structural fix for the wrong-line false-pass class) ----

test("anchorMatchCount: counts in-window occurrences (0 / 1 / 2)", () => {
  assert.equal(anchorMatchCount("a\nfooBar()\nb", "fooBar"), 1);
  assert.equal(anchorMatchCount("fooBar()\nx\nfooBar()", "fooBar"), 2);
  assert.equal(anchorMatchCount("nothing here", "fooBar"), 0);
  // call anchor with no verbatim hit counts boundary call sites, not substrings
  assert.equal(anchorMatchCount("admit(x)\nadmit(y)", "admit()"), 2);
  assert.equal(anchorMatchCount("admittedUserRequester(z)", "admit()"), 0);
});

test("BUG6 (identifier-boundary COUNT, closing the :317 substring class):", () => {
  // a plain-identifier anchor is NOT counted inside a longer identifier (was 1 by substring)
  assert.equal(anchorMatchCount("const admittedUserRequester = true", "admit"), 0);
  assert.equal(anchorMatchCount("preadmit(x)", "admit"), 0);
  // real identifier tokens ARE counted (boundary, not substring)
  assert.equal(anchorMatchCount("admit(x); admit(y)", "admit"), 2);
  assert.equal(anchorMatchCount("services.companyId, foo", "services.companyId"), 1);
  // a snippet anchor (operators/spaces) still substring-counts correctly
  assert.equal(anchorMatchCount("if (count > config.max) {", "count > config.max"), 1);
  assert.equal(anchorMatchCount("a\nb\nc", "count > config.max"), 0);
});

test("BUG6 end-to-end (RED-first): a plain-identifier anchor whose construct moved off, leaving only a LONGER identifier containing it, REDs", () => {
  // Cited line holds `admittedUserRequester` (which contains the substring "admit"); the real
  // `admit` token is nowhere in the ±5 window. Pre-fix (raw indexOf) counted 1 -> false GREEN.
  const lines = ["l1", "const admittedUserRequester = gate();", "l3", "l4", "l5"];
  const input = makeInput({ citations: [cit({ line: "2", anchorToken: "admit" })], files: { "server/src/foo.ts": { exists: true, lines } } });
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "does not appear within ±5 lines"), "boundary count must RED, not false-green");
  // control: the real `admit` token in-window passes
  const ok = makeInput({ citations: [cit({ line: "2", anchorToken: "admit" })], files: { "server/src/foo.ts": { exists: true, lines: ["l1", "return admit(payload);", "l3"] } } });
  assert.deepEqual(evaluateCitationIntegrity(ok).errors, [], "a real admit token in-window must pass");
});

test("AMBIGUITY: an anchor present TWICE within ±5 reds as non-distinctive", () => {
  // `handle` appears on both the cited line and a neighbour — it cannot pin one construct.
  const lines = ["l1", "const handle = openHandle();", "mid", "reuse(handle);", "l5"];
  const input = makeInput({ citations: [cit({ line: "2", anchorToken: "handle" })], files: { "server/src/foo.ts": { exists: true, lines } } });
  const { errors } = evaluateCitationIntegrity(input);
  assert.ok(hasError(errors, "NON-DISTINCTIVE"), report(errors));
  assert.ok(hasError(errors, "appears 2 times within ±5"), report(errors));
});

test("AMBIGUITY: a DISTINCTIVE anchor (present exactly once in-window) passes", () => {
  const lines = ["l1", "const handle = openDistinctHandleXYZ();", "mid", "reuse(handle);", "l5"];
  const input = makeInput({ citations: [cit({ line: "2", anchorToken: "openDistinctHandleXYZ" })], files: { "server/src/foo.ts": { exists: true, lines } } });
  assert.deepEqual(evaluateCitationIntegrity(input).errors, [], "count===1 must pass");
});

test("BUG5 (collect-all): a blank-line grandfather does NOT mask a co-located MISSING anchor", () => {
  // The cited line is BLANK (code, single line) AND the citation has no anchor -> TWO independent
  // violations (blank-line + missing-anchor). Grandfathering the blank-line must leave the
  // missing-anchor RED (the P2 :516 masking hole).
  const files = { "server/src/foo.ts": { exists: true, lines: ["code();", "   ", "more();"] } };
  const citations = [cit({ crossingId: "DE-05", line: "2", anchorToken: null })];
  const { errors } = evaluateCitationIntegrity(makeInput({
    citations, files,
    entries: [{ crossing: "DE-05", path: "server/src/foo.ts", line: "2", category: "blank-line", reason: "cites a deliberate blank anchor row" }],
  }));
  assert.ok(hasError(errors, "MISSING anchor"), report(errors));
  assert.ok(!hasError(errors, "cites a BLANK line"), "the blank-line grandfather DID suppress its own category");
});

test("BUG5 (collect-all): a blank-line grandfather with an anchor present nearby still passes", () => {
  // Only the blank-line violation exists (the anchor `nearbySym` resolves once in-window), so the
  // blank-line grandfather cleanly suppresses it and the run is green.
  const files = { "server/src/foo.ts": { exists: true, lines: ["nearbySym();", "   ", "more();"] } };
  const citations = [cit({ crossingId: "DE-05", line: "2", anchorToken: "nearbySym" })];
  assert.deepEqual(
    evaluateCitationIntegrity(makeInput({
      citations, files,
      entries: [{ crossing: "DE-05", path: "server/src/foo.ts", line: "2", category: "blank-line", reason: "cites a deliberate blank anchor row" }],
    })).errors,
    [],
  );
});

test("AMBIGUITY: an ambiguous-anchor grandfather entry excuses ONLY that category", () => {
  const lines = ["l1", "const handle = openHandle();", "reuse(handle);"];
  const citations = [cit({ crossingId: "DE-05", line: "2", anchorToken: "handle" })];
  const files = { "server/src/foo.ts": { exists: true, lines } };
  // grandfathering the ambiguity passes; a wrong CATEGORY (missing-file) would still red
  assert.deepEqual(
    evaluateCitationIntegrity(makeInput({ citations, files, entries: [{ crossing: "DE-05", path: "server/src/foo.ts", line: "2", category: "ambiguous-anchor", reason: "two legit uses of the symbol flank the construct" }] })).errors,
    [],
  );
});

// --- DOTTED-BOUNDARY (task_94660c59): a dotted anchor must pin the WHOLE member path -----
// The identifier-boundary count (BUG6) rejects `[\w$]` neighbours so `admit` does not match
// inside `admittedUserRequester`. But `.` was NOT in that boundary class, so a DOTTED anchor
// (`config.max`, `services.companyId`) still matched as the tail of a LONGER, different chain
// (`app.config.max`, `this.services.companyId`) — a wrong-construct false-pass, the same class
// BUG6 closed for bare identifiers. The fix tightens the boundary to `[\w$.]` for a dotted
// anchor only; a BARE identifier keeps `[\w$]` so an ordinary method call still matches.

test("BUG7 (dotted-boundary): a dotted anchor does NOT match as the tail of a longer member chain", () => {
  // false-pass class: `config.max` inside `app.config.max` (was 1 by the [\w$]-only boundary)
  assert.equal(anchorMatchCount("x = app.config.max;", "config.max"), 0);
  assert.equal(anchorMatchCount("y = this.services.companyId;", "services.companyId"), 0);
  // ...nor as the HEAD of a longer chain
  assert.equal(anchorMatchCount("config.max.deep", "config.max"), 0);
  // the exact dotted construct still counts
  assert.equal(anchorMatchCount("x = config.max;", "config.max"), 1);
  assert.equal(anchorMatchCount("return services.companyId;", "services.companyId"), 1);
});

test("BUG7 (dotted-boundary): a BARE identifier anchor STILL matches an ordinary method call (no regression)", () => {
  // a bare identifier keeps the [\w$] boundary: a leading `.` (method access) is a legit match
  assert.equal(anchorMatchCount("gate.admit(x)", "admit"), 1);
  assert.equal(anchorMatchCount("this.reconcile()", "reconcile"), 1);
  // still boundary-correct inside a longer identifier (unchanged from BUG6)
  assert.equal(anchorMatchCount("preadmit(x)", "admit"), 0);
});

test("BUG7 end-to-end (RED-first): a dotted anchor whose construct moved off, leaving only a LONGER member chain containing it, REDs", () => {
  // Cited line holds `app.config.max` (contains the sub-path `config.max`); the real bare
  // `config.max` construct is nowhere in the ±5 window. Pre-fix counted 1 -> false GREEN.
  const lines = ["l1", "const ceiling = app.config.max;", "l3", "l4", "l5"];
  const input = makeInput({ citations: [cit({ line: "2", anchorToken: "config.max" })], files: { "server/src/foo.ts": { exists: true, lines } } });
  assert.ok(hasError(evaluateCitationIntegrity(input).errors, "does not appear within ±5 lines"), "dotted sub-path must RED, not false-green");
  // control: the real `config.max` construct in-window passes
  const ok = makeInput({ citations: [cit({ line: "2", anchorToken: "config.max" })], files: { "server/src/foo.ts": { exists: true, lines: ["l1", "const ceiling = config.max;", "l3"] } } });
  assert.deepEqual(evaluateCitationIntegrity(ok).errors, [], "the exact dotted construct in-window must pass");
});
