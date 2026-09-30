/**
 * Self-test for the test-inventory guard (incident remediation, 2026-08-22).
 *
 * WHY THIS EXISTS. Commit 65c86ba4f deleted 154 test files from this repository —
 * the desktop assembler's prune step followed pnpm-deploy symlinks out of its staging
 * root and back into `packages/*`. CI then went GREEN four times in a row, because
 * deleting a test removes a failure rather than causing one. Nothing anywhere in the
 * pipeline noticed that a third of three packages' suites had ceased to exist.
 *
 * The lstat fix stops THAT assembler. This guard stops the next script that walks a
 * tree with `rmSync`, because the property worth enforcing is not "the assembler is
 * careful" but "the suite cannot silently shrink".
 *
 * The verdict is pure: counting files touches the disk, deciding whether a count is
 * acceptable does not.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXCLUDED_DIRECTORY_NAMES,
  evaluateInventory,
  isExcludedDirectory,
  isTestFile,
  treeForPath,
} from "../test-inventory.mjs";

describe("membership — what counts as a test file", () => {
  it("counts every suffix the runners actually discover", () => {
    for (const rel of [
      "server/src/a.test.ts",
      "ui/src/a.test.tsx",
      "scripts/a.test.mjs",
      "packages/db/a.test.js",
      "packages/x/src/a.spec.ts",
    ]) {
      assert.equal(isTestFile(rel), true, rel);
    }
  });

  it("counts HELPER files inside a __tests__ directory, not only *.test.*", () => {
    // The prune deleted whole `__tests__/` directories. A fixture or helper lost
    // there breaks the suite just as surely as a lost spec, so the blast radius is
    // what gets measured.
    for (const rel of [
      "packages/worker-daemon/src/__tests__/helpers.ts",
      "scripts/lib/__tests__/fixture.mjs",
    ]) {
      assert.equal(isTestFile(rel), true, rel);
    }
  });

  it("does not count ordinary source, or a directory merely NAMED like a test", () => {
    for (const rel of [
      "server/src/index.ts",
      "server/src/testing/util.ts",
      "server/src/latest.ts",
      "docs/testing.md",
      "packages/worker-daemon/src/__tests__/README.md",
    ]) {
      assert.equal(isTestFile(rel), false, rel);
    }
  });
});

describe("exclusions — vendored and generated trees are not the suite", () => {
  it("excludes node_modules, build output and VCS metadata", () => {
    for (const name of ["node_modules", ".git", "dist", "coverage"]) {
      assert.equal(isExcludedDirectory(name), true, name);
    }
    assert.ok(EXCLUDED_DIRECTORY_NAMES.has("node_modules"));
  });

  it("does not exclude an ordinary source directory", () => {
    for (const name of ["src", "packages", "server", "distribution"]) {
      assert.equal(isExcludedDirectory(name), false, name);
    }
  });
});

describe("tree attribution", () => {
  it("splits packages/* one level deeper than everything else", () => {
    assert.equal(treeForPath("packages/worker-daemon/src/a.test.ts"), "packages/worker-daemon");
    assert.equal(treeForPath("server/src/a.test.ts"), "server");
    assert.equal(treeForPath("a.test.mjs"), ".");
  });
});

describe("verdict — pinned trees are an exact contract", () => {
  const expectations = { "packages/worker-daemon": { mode: "pinned", count: 122 } };

  it("passes on the pinned count", () => {
    const r = evaluateInventory({ counts: { "packages/worker-daemon": 122 }, expectations });
    assert.deepEqual(r.violations, []);
    assert.equal(r.ok, true);
  });

  it("FAILS when a pinned tree loses files — the incident", () => {
    const r = evaluateInventory({ counts: { "packages/worker-daemon": 0 }, expectations });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].kind, "pinned_mismatch");
    assert.equal(r.violations[0].tree, "packages/worker-daemon");
    assert.equal(r.violations[0].actual, 0);
    assert.equal(r.violations[0].expected, 122);
  });

  it("FAILS when a pinned tree GAINS files, so the pin cannot rot", () => {
    // A pin that only checks one direction decays into a floor, and a decayed floor
    // is what lets a later deletion pass.
    const r = evaluateInventory({ counts: { "packages/worker-daemon": 123 }, expectations });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].kind, "pinned_mismatch");
  });
});

describe("verdict — floor trees may grow but never shrink", () => {
  const expectations = { server: { mode: "floor", count: 1421 } };

  it("passes at the floor and above it", () => {
    assert.equal(evaluateInventory({ counts: { server: 1421 }, expectations }).ok, true);
    assert.equal(evaluateInventory({ counts: { server: 9999 }, expectations }).ok, true);
  });

  it("FAILS below the floor", () => {
    const r = evaluateInventory({ counts: { server: 1420 }, expectations });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].kind, "below_floor");
  });
});

describe("verdict — coverage is default-deny", () => {
  it("FAILS on a tree that has tests but no expectation", () => {
    // Otherwise a new package is born uncovered, and the guard reports green about a
    // tree it has never looked at.
    const r = evaluateInventory({ counts: { "packages/brand-new": 12 }, expectations: {} });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].kind, "unmanaged_tree");
    assert.equal(r.violations[0].tree, "packages/brand-new");
  });

  it("FAILS on an expected tree that has VANISHED from the walk entirely", () => {
    // The absent-key case is the catastrophic one: not "fewer files" but "no such
    // directory". It must not read as an empty, satisfied expectation.
    const r = evaluateInventory({
      counts: {},
      expectations: { "packages/worker-keystore": { mode: "pinned", count: 16 } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].actual, 0);
  });

  it("reports EVERY violating tree, not just the first", () => {
    const r = evaluateInventory({
      counts: { server: 0, ui: 0 },
      expectations: { server: { mode: "floor", count: 10 }, ui: { mode: "floor", count: 10 } },
    });
    assert.equal(r.violations.length, 2);
  });
});

describe("verdict — a malformed manifest is refused, never assumed", () => {
  it("refuses an unknown mode rather than defaulting to the lenient one", () => {
    const r = evaluateInventory({
      counts: { server: 5 },
      expectations: { server: { mode: "advisory", count: 10 } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].kind, "malformed_expectation");
  });

  it("refuses a non-integer or negative count", () => {
    for (const count of [1.5, -1, "10", undefined, null]) {
      const r = evaluateInventory({
        counts: { server: 5 },
        expectations: { server: { mode: "floor", count } },
      });
      assert.equal(r.violations[0].kind, "malformed_expectation", JSON.stringify(count));
    }
  });

  it("never throws on caller-supplied garbage", () => {
    for (const bad of [undefined, null, 0, "", [], { counts: 7 }, { expectations: 7 }]) {
      assert.equal(evaluateInventory(bad).ok, false, JSON.stringify(bad) ?? "undefined");
    }
  });
});
