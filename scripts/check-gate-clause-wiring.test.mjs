/**
 * W5U1 — walk-level tests for the gate-clause wiring guard's CALLER COUNT.
 *
 * The pure verdict is tested in `lib/__tests__/gate-clause-wiring.test.mjs`. What is tested
 * HERE is the filesystem/lexical layer, and specifically the one defect that made the
 * guard's only DEFINITIVE verdict — "0 production callers" — forgeable by prose:
 *
 *   `countProductionCallers` stripped comments but NOT string literals. Measured at
 *   `e1f723df2`, `createResultCommitter`'s only non-test, non-comment, non-re-export
 *   reference in the whole tree was the STRING at
 *   `server/src/services/e7-distributed-run-verifier.ts:513`, whose text reads
 *   "buildWorkspacePatch/createResultCommitter have zero production callers". The guard
 *   counted that sentence as a production caller. `createSupervisor` measured 4, of which
 *   2 were its own `throw new Error("createSupervisor: …")` messages.
 *
 * The mutation these tests exist to catch is REVERTING the string-blindness, i.e. dropping
 * the `stripStringLiterals` call from `countProductionCallers`. MEASURED under that revert:
 * exactly the TWO tests labelled `THE MUTATION` fail (1 !== 0 and 3 !== 1) and the other
 * eight — the real call, the interpolated call, the blanked import, the excluded test path,
 * and the four `stripStringLiterals` unit cases — stay GREEN. `node
 * scripts/check-gate-clause-wiring.mjs` also stays exit 0 on the real register in BOTH
 * states (`createSupervisor` measures 4 mutated, 2 fixed; either way > 0, so no declared
 * verdict moves). If everything reds, the harness broke, not the defect.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { countProductionCallers, stripStringLiterals } from "./check-gate-clause-wiring.mjs";

function fixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aoa-gcw-"));
  for (const [rel, body] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, body, "utf8");
  }
  return root;
}

describe("countProductionCallers — a sentence is not a call site", () => {
  it("★ THE MUTATION — a symbol whose ONLY reference is a string literal counts ZERO", () => {
    // This is the real defect, transcribed: a diagnostic message that says the symbol has
    // no callers was itself counted as the caller.
    const root = fixture({
      "server/src/verifier.ts": [
        "export function verdict() {",
        '  return {',
        '    reason:',
        '      "output capture is UNBUILT — buildWorkspacePatch/createResultCommitter have zero " +',
        '      "production callers, so this run cannot be distinguished from a context-free one.",',
        "  };",
        "}",
        "",
      ].join("\n"),
      "packages/worker-daemon/src/result-commit.ts":
        "export function createResultCommitter() {\n  return { commit: () => undefined };\n}\n",
    });
    assert.equal(countProductionCallers(root, "createResultCommitter"), 0);
  });

  it("★ POSITIVE CONTROL — a symbol with a REAL call keeps its count", () => {
    const root = fixture({
      "packages/worker-daemon/src/supervisor.ts": "export function createSupervisor() {\n  return {};\n}\n",
      "packages/worker-daemon/src/runtime.ts": [
        'import { createSupervisor } from "./supervisor.js";',
        "",
        "export function compose() {",
        "  return createSupervisor();",
        "}",
        "",
      ].join("\n"),
    });
    assert.equal(countProductionCallers(root, "createSupervisor"), 1);
  });

  it("★ THE MUTATION, second case — its OWN error-message strings no longer inflate it", () => {
    // Labelled a MUTATION case, not a positive control, because it reds under the same
    // revert (3 !== 1) — measured. Calling it a control would have overstated how many
    // independent green signals survive the mutation.
    // The shipped shape: one real reference plus two `throw new Error("createSupervisor: …")`.
    const root = fixture({
      "packages/worker-daemon/src/supervisor.ts": [
        "export function createSupervisor(deps) {",
        '  if (deps.a && deps.b) throw new Error("createSupervisor: a and b are mutually exclusive");',
        '  if (deps.c) throw new Error("createSupervisor: c requires d");',
        "  return {};",
        "}",
        "",
      ].join("\n"),
      "packages/worker-daemon/src/runtime.ts": [
        'import { createSupervisor } from "./supervisor.js";',
        "export const make = () => createSupervisor({});",
        "",
      ].join("\n"),
    });
    assert.equal(countProductionCallers(root, "createSupervisor"), 1);
  });

  it("★ POSITIVE CONTROL — a real call inside a template interpolation still counts", () => {
    // The over-stripping direction. Blanking a whole template literal would fake a zero,
    // which is the one error this guard must never make.
    const root = fixture({
      "server/src/label.ts": "export function makeLabel() {\n  return 'x';\n}\n",
      "server/src/use.ts": [
        'import { makeLabel } from "./label.js";',
        "export const banner = `run ${makeLabel()} done`;",
        "",
      ].join("\n"),
    });
    assert.equal(countProductionCallers(root, "makeLabel"), 1);
  });

  it("an import specifier is still blanked — string stripping runs AFTER, never before", () => {
    // If `stripStringLiterals` ran first, `from ""` would stop matching the import
    // expression and every import in the tree would be counted as a reference.
    const root = fixture({
      "server/src/thing.ts": "export function stageJobInputFiles() {\n  return [];\n}\n",
      "server/src/only-imports.ts": 'import { stageJobInputFiles } from "./thing.js";\n',
    });
    assert.equal(countProductionCallers(root, "stageJobInputFiles"), 0);
  });

  it("test paths are still excluded", () => {
    const root = fixture({
      "server/src/thing.ts": "export function widget() {\n  return 1;\n}\n",
      "server/src/__tests__/thing.test.ts": 'import { widget } from "../thing.js";\nwidget();\n',
    });
    assert.equal(countProductionCallers(root, "widget"), 0);
  });
});

describe("stripStringLiterals — bounded mis-detection", () => {
  it("drops quoted contents but keeps the delimiters", () => {
    assert.equal(stripStringLiterals('const a = "createSupervisor";'), 'const a = "";');
    assert.equal(stripStringLiterals("const a = 'createSupervisor';"), "const a = '';");
  });

  it("keeps template interpolations verbatim and drops the literal text", () => {
    assert.equal(
      stripStringLiterals("`text createSupervisor ${createSupervisor()} more`"),
      "`${createSupervisor()}`",
    );
  });

  it("★ an unterminated quote is abandoned at the newline, never at EOF", () => {
    // A stray apostrophe or a quote inside a regex literal must cost ONE line, not the file.
    // Eating to EOF could manufacture a zero, and a zero is the guard's hanging verdict.
    const out = stripStringLiterals("const re = /'/;\ncreateSupervisor();\n");
    assert.match(out, /createSupervisor\(\)/);
  });

  it("preserves newlines inside a multi-line template so line structure survives", () => {
    const out = stripStringLiterals("const q = `\nSELECT 1\n`;\ncreateSupervisor();\n");
    assert.equal(out.split("\n").length, "const q = `\nSELECT 1\n`;\ncreateSupervisor();\n".split("\n").length);
    assert.match(out, /createSupervisor\(\)/);
  });
});
