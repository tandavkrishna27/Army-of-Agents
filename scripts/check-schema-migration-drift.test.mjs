// -----------------------------------------------------------------------------
// E8-F005 schema↔migration drift gate — self-test (node:test, dependency-free).
//
//   node --test scripts/check-schema-migration-drift.test.mjs
//
// Two layers, mirroring the repo's other check-*.test.mjs:
//   1. THE DECISION LOGIC (`classifyDrift`) is proven non-vacuously: a clean
//      before/after listing yields NO drift, and a new NNNN_*.sql / snapshot
//      appearing after `drizzle-kit generate` yields drift with the added files
//      named. This is the exact signal the CLI turns an exit code on, tested
//      WITHOUT a database or a build.
//   2. THE WIRING IS REAL. A check that no workflow runs is not a check
//      (`check-guard-inventory`), so this asserts a NON-COMMENT line of
//      .github/workflows/pr.yml actually invokes this script by name — the same
//      easy-direction confirmation the guard inventory performs.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { classifyDrift, ROOT } from "./check-schema-migration-drift.mjs";

const CLEAN = [
  "0279_service_instance_terminalized_by.sql",
  "meta/_journal.json",
  "meta/0279_snapshot.json",
];

test("clean tree: identical before/after => no drift", () => {
  const { drift, added } = classifyDrift({ before: CLEAN, after: [...CLEAN] });
  assert.equal(drift, false);
  assert.deepEqual(added, []);
});

test("drift: a new migration + snapshot appears => drift, with added files named", () => {
  const after = [
    ...CLEAN,
    "0280_sour_catseye.sql",
    "meta/0280_snapshot.json",
  ];
  const { drift, added } = classifyDrift({ before: CLEAN, after });
  assert.equal(drift, true);
  // Both freshly-emitted artifacts are reported (sorted).
  assert.deepEqual(added, ["0280_sour_catseye.sql", "meta/0280_snapshot.json"]);
});

test("removals alone are not counted as drift (only additions signal a delta)", () => {
  const after = CLEAN.slice(0, 1);
  const { drift, added } = classifyDrift({ before: CLEAN, after });
  assert.equal(drift, false);
  assert.deepEqual(added, []);
});

test("malformed input is inert, never a phantom drift", () => {
  assert.deepEqual(classifyDrift(undefined), { drift: false, added: [] });
  assert.deepEqual(classifyDrift({}), { drift: false, added: [] });
});

test("pr.yml invokes this gate on a non-comment line (a check nothing runs is not a check)", () => {
  const workflow = readFileSync(
    path.join(ROOT, ".github", "workflows", "pr.yml"),
    "utf8",
  );
  const invoked = workflow.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) return false;
    return trimmed.includes("check-schema-migration-drift.mjs");
  });
  assert.ok(
    invoked,
    "expected .github/workflows/pr.yml to invoke check-schema-migration-drift.mjs on a non-comment line",
  );
});
