// BRW-hostspawn-gate — self-test for the boot-root browser-spawn guard.
//
//   node --test scripts/lib/__tests__/boot-roots-browser-spawn-free.test.mjs
//
// ONE suite covers BOTH layers (design § "Why one test file, not two"):
//   * the PURE evaluator `evaluateBrowserSpawnFree` (arms A0-A6), fixture inputs; and
//   * the fs DISCOVERY layer `discoverHostSpawnSites` / `countSignatureOccurrences`
//     (imported from the driver, whose main() is guarded), run against mkdtemp trees.
//
// NON-VACUOUS, POSITIVE CONTROL FIRST: T0 asserts an UNDECLARED found site over an EMPTY
// manifest reds (A3) — the arm a set-difference guard needs — and was watched RED before
// the evaluator existed. Every other arm has a killing test named in the mutation table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateBrowserSpawnFree } from "../boot-roots-browser-spawn-free.mjs";
import {
  discoverHostSpawnSites,
  countSignatureOccurrences,
  SCAN_ROOTS,
  SIGNATURES,
} from "../../check-boot-roots-browser-spawn-free.mjs";

const CLI = "server/src/services/internal-agent/cli-mode.ts";
const GOOD_DECL = { owner: "BRW-008", reason: "declared owned deferral", signatureOccurrences: 3 };
const EXPECT_OK = { deferredHostSpawns: { [CLI]: GOOD_DECL } };

function evalWith(overrides) {
  return evaluateBrowserSpawnFree({
    foundSites: [{ path: CLI, occurrences: 3 }],
    expectation: EXPECT_OK,
    unreadableSources: [],
    scannedFileCount: 1,
    signatures: SIGNATURES,
    ...overrides,
  });
}

/** Build a temp fixture tree {relPath: content}; auto-removed after the test. */
function makeTree(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "brwspawn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

// ── T0 — POSITIVE CONTROL (A3). Watched RED before the evaluator existed. ──────────────
test("T0 — POSITIVE CONTROL: an undeclared found site over an EMPTY manifest reds (A3)", () => {
  const v = evaluateBrowserSpawnFree({
    foundSites: [{ path: "server/src/new-spawn.ts", occurrences: 1 }],
    expectation: { deferredHostSpawns: {} },
    unreadableSources: [],
    scannedFileCount: 1,
    signatures: SIGNATURES,
  });
  assert.ok(v.length > 0, "an undeclared spawn must never read green");
  assert.ok(v.some((m) => /undeclared host spawn: server\/src\/new-spawn\.ts/.test(m)));
});

// ── T1 — green at rest ─────────────────────────────────────────────────────────────────
test("T1 — green at rest: the single declared spawn (occurrences 3, pinned 3) yields ZERO violations", () => {
  assert.deepEqual(evalWith({}), []);
});

// ── T2 — undeclared (A3) ────────────────────────────────────────────────────────────────
test("T2 — undeclared (A3): one of two found sites is undeclared → exactly one undeclared violation", () => {
  const v = evalWith({
    foundSites: [{ path: CLI, occurrences: 3 }, { path: "packages/adapters/x/rogue.ts", occurrences: 1 }],
    scannedFileCount: 2,
  });
  const undeclared = v.filter((m) => /undeclared host spawn:/.test(m));
  assert.equal(undeclared.length, 1);
  assert.ok(/rogue\.ts/.test(undeclared[0]));
});

// ── T3 — stale (A4) ─────────────────────────────────────────────────────────────────────
test("T3 — stale (A4): a declared path absent from foundSites reds", () => {
  const v = evalWith({ foundSites: [], scannedFileCount: 5 });
  assert.ok(v.some((m) => /stale declaration:/.test(m) && /cli-mode\.ts/.test(m)));
});

// ── T4/T5/T6 — malformed owner/reason (A5) ─────────────────────────────────────────────
test("T4 — malformed: missing owner (A5)", () => {
  const v = evalWith({ expectation: { deferredHostSpawns: { [CLI]: { reason: "x", signatureOccurrences: 3 } } } });
  assert.ok(v.some((m) => /'owner' must be a ticket-id token/.test(m)));
});

test("T5 — malformed: missing/blank reason (A5)", () => {
  const missing = evalWith({ expectation: { deferredHostSpawns: { [CLI]: { owner: "BRW-008", signatureOccurrences: 3 } } } });
  assert.ok(missing.some((m) => /'reason' must be a non-empty string/.test(m)));
  const blank = evalWith({ expectation: { deferredHostSpawns: { [CLI]: { owner: "BRW-008", reason: "   ", signatureOccurrences: 3 } } } });
  assert.ok(blank.some((m) => /'reason' must be a non-empty string/.test(m)));
});

test("T6 — malformed: owner not a ticket shape (A5)", () => {
  const v = evalWith({ expectation: { deferredHostSpawns: { [CLI]: { owner: "someone", reason: "x", signatureOccurrences: 3 } } } });
  assert.ok(v.some((m) => /'owner' must be a ticket-id token/.test(m)));
});

// ── T7 — unreadable source (A2) ─────────────────────────────────────────────────────────
test("T7 — unreadable source (A2, fail closed)", () => {
  const v = evalWith({ unreadableSources: ["server/src/services/internal-agent/unreadable.ts"], scannedFileCount: 2 });
  assert.ok(v.some((m) => /unreadable source \(fail closed\)/.test(m)));
});

// ── T8 — manifest fail-closed (A0) ──────────────────────────────────────────────────────
test("T8 — manifest fail-closed (A0): null expectation reds structurally AND reds the found site (A3)", () => {
  const v = evalWith({ expectation: null });
  assert.ok(v.some((m) => /manifest fail-closed/.test(m)), "structural A0 violation");
  assert.ok(v.some((m) => /undeclared host spawn/.test(m)), "found site reds over the empty set");
});

// ── T9 — vacuous scan (A1) ──────────────────────────────────────────────────────────────
test("T9 — vacuous scan (A1): scannedFileCount 0 reds even with empty foundSites and empty manifest", () => {
  const v = evaluateBrowserSpawnFree({
    foundSites: [],
    expectation: { deferredHostSpawns: {} },
    unreadableSources: [],
    scannedFileCount: 0,
    signatures: SIGNATURES,
  });
  assert.ok(v.some((m) => /vacuous scan/.test(m)));
});

// ── T-occ — malformed signatureOccurrences (A5) ────────────────────────────────────────
test("T-occ — malformed signatureOccurrences (A5): missing, zero, and string all red", () => {
  const cases = [
    { owner: "BRW-008", reason: "x" }, // missing
    { owner: "BRW-008", reason: "x", signatureOccurrences: 0 }, // not positive
    { owner: "BRW-008", reason: "x", signatureOccurrences: "3" }, // not an integer
  ];
  for (const decl of cases) {
    const v = evalWith({ expectation: { deferredHostSpawns: { [CLI]: decl } } });
    assert.ok(
      v.some((m) => /'signatureOccurrences' must be a positive integer/.test(m)),
      `case ${JSON.stringify(decl)}`,
    );
  }
});

// ── T-count — spawn-count mismatch (A6, the F2 arm) ────────────────────────────────────
test("T-count — spawn-count mismatch (A6): 4 reds (second spawn), 1 reds (spawn removed), 3 clean", () => {
  assert.ok(evalWith({ foundSites: [{ path: CLI, occurrences: 4 }] }).some((m) => /spawn-count mismatch/.test(m)));
  assert.ok(evalWith({ foundSites: [{ path: CLI, occurrences: 1 }] }).some((m) => /spawn-count mismatch/.test(m)));
  assert.deepEqual(evalWith({ foundSites: [{ path: CLI, occurrences: 3 }] }), []);
});

// ── discovery-layer counting ────────────────────────────────────────────────────────────
test("countSignatureOccurrences: the two cli-mode.ts lines total 3 (the at-rest pin)", () => {
  const text =
    'export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.75";\n' +
    '      args: [PLAYWRIGHT_MCP_PACKAGE, "--headless"],\n';
  assert.equal(countSignatureOccurrences(text, SIGNATURES), 3);
});

// ── T10 — signature completeness (discovery) ────────────────────────────────────────────
test("T10 — discovery: identifier-only AND bumped-literal files are both found, occurrences counted", (t) => {
  const root = makeTree(t, {
    "server/src/a-identifier-only.ts": "const x = PLAYWRIGHT_MCP_PACKAGE;\n",
    "server/src/b-bumped-literal.ts": 'const y = "@playwright/mcp@9.9.9";\n',
  });
  const { foundSites } = discoverHostSpawnSites(root, { scanRoots: SCAN_ROOTS, signatures: SIGNATURES });
  const byPath = Object.fromEntries(foundSites.map((s) => [s.path, s.occurrences]));
  assert.equal(byPath["server/src/a-identifier-only.ts"], 1, "identifier-only spawn is discovered");
  assert.equal(byPath["server/src/b-bumped-literal.ts"], 1, "a bumped version literal is still discovered");
});

// ── T11 — scope EXCLUSION (discovery) ───────────────────────────────────────────────────
test("T11 — discovery EXCLUDES governed browser-runtime + test/spec/d.ts/__tests__ under a scan root", (t) => {
  const root = makeTree(t, {
    "packages/browser-runtime/src/index.ts": 'const z = "@playwright/mcp@0.0.75";\n', // governed, EXCLUDED_SUBTREES
    "server/src/locked.test.ts": "const t = PLAYWRIGHT_MCP_PACKAGE;\n", // behaviour-lock .test.ts excluded
    "server/src/locked.spec.ts": "const s = PLAYWRIGHT_MCP_PACKAGE;\n", // .spec.ts excluded (repo isTestFile convention)
    "server/src/__tests__/y.ts": "const u = PLAYWRIGHT_MCP_PACKAGE;\n", // __tests__ excluded
    "server/src/typedefs.d.ts": "declare const PLAYWRIGHT_MCP_PACKAGE: string;\n", // .d.ts excluded
  });
  const { foundSites } = discoverHostSpawnSites(root, { scanRoots: SCAN_ROOTS, signatures: SIGNATURES });
  assert.deepEqual(foundSites, []);
});

// ── T12 — scope INCLUSION (discovery, anti-vacuity for F3) ──────────────────────────────
test("T12 — discovery INCLUDES a signature file under packages/adapters (F3 host config-writer surface)", (t) => {
  const root = makeTree(t, {
    "packages/adapters/codex-local/src/server/rogue.ts": 'const c = "@playwright/mcp@0.0.75";\n',
  });
  const { foundSites } = discoverHostSpawnSites(root, { scanRoots: SCAN_ROOTS, signatures: SIGNATURES });
  assert.deepEqual(
    foundSites.map((s) => s.path),
    ["packages/adapters/codex-local/src/server/rogue.ts"],
  );
});

// ── T13 — scope INCLUSION: the SHARED MCP-spec sibling package (skeptic V3 gap) ─────────
// packages/adapter-utils holds the McpServerSpec constructor cli-mode.ts already imports; a
// host @playwright/mcp spec relocated there must NOT escape the scan. A server/src +
// packages/adapters-only scope missed this sibling entirely.
test("T13 — discovery INCLUDES a signature file under packages/adapter-utils (the shared MCP-spec sibling)", (t) => {
  const root = makeTree(t, {
    "packages/adapter-utils/src/mcp-server-spec.ts": 'const s = "@playwright/mcp@0.0.75";\n',
  });
  const { foundSites } = discoverHostSpawnSites(root, { scanRoots: SCAN_ROOTS, signatures: SIGNATURES });
  assert.deepEqual(
    foundSites.map((s) => s.path),
    ["packages/adapter-utils/src/mcp-server-spec.ts"],
  );
});
