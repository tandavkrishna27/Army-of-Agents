#!/usr/bin/env node
/**
 * Mutation corpus for check-bundled-snapshot-inputs.mjs.
 *
 * Run with: node --test scripts/check-bundled-snapshot-inputs.test.mjs
 *
 * Each case builds a self-contained temporary tree (the pinned manifest + the
 * two bundled snapshot files at their real relative paths, with correct
 * digests), applies exactly one mutation, and asserts the checker fails with the
 * expected cause. The valid baseline passes with zero errors. The tree is
 * synthesized (small JSON) so the test never depends on the ~1.5MB generated
 * catalog snapshot.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import {
  runSnapshotCheck,
  writeManifest,
  EXPECTED_SNAPSHOTS,
  MANIFEST_REL,
} from "./check-bundled-snapshot-inputs.mjs";

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function hasError(errors, substr) {
  return errors.some((e) => e.includes(substr));
}
function report(errors) {
  return `\nActual errors:\n${errors.map((e) => `  - ${e}`).join("\n") || "  (none)"}`;
}

// Deterministic small snapshot bodies keyed by file.
const BODIES = {
  "ui/src/aoa-marketplace-snapshot.json": Buffer.from(
    JSON.stringify({ schemaVersion: "1.0.0", generatedAt: "2026-01-01T00:00:00.000Z", itemCount: 0, items: [] }),
  ),
  "ui/src/aoa-connectors-snapshot.json": Buffer.from(
    JSON.stringify({ schemaVersion: "1.0.0", generatedAt: "2026-01-01T00:00:00.000Z", entryCount: 0, entries: [] }),
  ),
};

function buildManifest() {
  return {
    version: 1,
    description: "test fixture manifest",
    snapshots: EXPECTED_SNAPSHOTS.map((s, i) => ({
      file: s.file,
      sourceUrl: s.sourceUrl,
      version: "2026-01-01T00:00:00.000Z",
      sha256: sha256Hex(BODIES[s.file]),
      order: i + 1,
    })),
  };
}

function makeTree(t, { mutateManifest, mutateFiles } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-snap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Write snapshot files (unless a mutation drops/replaces them).
  const bodies = { ...BODIES };
  if (mutateFiles) mutateFiles(bodies);
  for (const [rel, body] of Object.entries(bodies)) {
    if (body === null) continue; // omit this file
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  // Write manifest.
  const manifest = buildManifest();
  if (mutateManifest) mutateManifest(manifest);
  const manAbs = path.join(root, MANIFEST_REL);
  fs.mkdirSync(path.dirname(manAbs), { recursive: true });
  fs.writeFileSync(manAbs, JSON.stringify(manifest, null, 2) + "\n");
  return root;
}

test("valid: a correctly pinned tree passes with zero errors", async (t) => {
  const root = makeTree(t);
  const { errors } = await runSnapshotCheck(root);
  assert.deepEqual(errors, [], report(errors));
});

test("valid: the real repository manifest passes (shape + present-digest)", async () => {
  const { errors } = await runSnapshotCheck(repoRoot);
  assert.deepEqual(errors, [], report(errors));
});

test("missing manifest fails", async (t) => {
  const root = makeTree(t);
  fs.rmSync(path.join(root, MANIFEST_REL));
  const { errors } = await runSnapshotCheck(root);
  assert.ok(hasError(errors, `${MANIFEST_REL}: missing`), report(errors));
});

test("mutate a snapshot's bytes: digest mismatch fails", async (t) => {
  const root = makeTree(t, {
    mutateFiles: (bodies) => {
      bodies["ui/src/aoa-marketplace-snapshot.json"] = Buffer.from(
        JSON.stringify({ schemaVersion: "1.0.0", generatedAt: "2026-01-01T00:00:00.000Z", itemCount: 1, items: [{ id: "x" }] }),
      );
    },
  });
  const { errors } = await runSnapshotCheck(root);
  assert.ok(
    hasError(errors, "ui/src/aoa-marketplace-snapshot.json: sha256"),
    report(errors),
  );
  assert.ok(hasError(errors, "does not match the pinned digest"), report(errors));
});

test("corrupt a pinned digest: mismatch fails", async (t) => {
  const root = makeTree(t, {
    mutateManifest: (m) => {
      m.snapshots[0].sha256 = "0".repeat(64);
    },
  });
  const { errors } = await runSnapshotCheck(root);
  assert.ok(hasError(errors, "does not match the pinned digest"), report(errors));
});

test("change a source URL: source mismatch fails", async (t) => {
  const root = makeTree(t, {
    mutateManifest: (m) => {
      m.snapshots[0].sourceUrl = "https://evil.example.com/catalog.json";
    },
  });
  const { errors } = await runSnapshotCheck(root);
  assert.ok(hasError(errors, "sourceUrl"), report(errors));
  assert.ok(hasError(errors, "must be"), report(errors));
});

test("reorder pinned entries: order-position mismatch fails", async (t) => {
  const root = makeTree(t, {
    mutateManifest: (m) => {
      // Swap the two order values while leaving array order unchanged.
      m.snapshots[0].order = 2;
      m.snapshots[1].order = 1;
    },
  });
  const { errors } = await runSnapshotCheck(root);
  assert.ok(hasError(errors, "matching position"), report(errors));
});

test("swap array position: order-position mismatch fails", async (t) => {
  const root = makeTree(t, {
    mutateManifest: (m) => {
      m.snapshots.reverse(); // array order now [connectors, marketplace] but order stays 1,2
    },
  });
  const { errors } = await runSnapshotCheck(root);
  assert.ok(hasError(errors, "matching position"), report(errors));
});

test("drop a required entry field: missing-field fails", async (t) => {
  const root = makeTree(t, {
    mutateManifest: (m) => {
      delete m.snapshots[0].sha256;
    },
  });
  const { errors } = await runSnapshotCheck(root);
  assert.ok(hasError(errors, 'is missing required field "sha256"'), report(errors));
});

test("remove a known snapshot from the manifest: unpinned fails", async (t) => {
  const root = makeTree(t, {
    mutateManifest: (m) => {
      m.snapshots = [m.snapshots[0]];
    },
  });
  const { errors } = await runSnapshotCheck(root);
  assert.ok(
    hasError(errors, `known bundled snapshot "ui/src/aoa-connectors-snapshot.json" is not pinned`),
    report(errors),
  );
});

test("absent snapshot file: shape-only pass (no digest error)", async (t) => {
  const root = makeTree(t, {
    mutateFiles: (bodies) => {
      bodies["ui/src/aoa-marketplace-snapshot.json"] = null; // omit
    },
  });
  const { errors, notes } = await runSnapshotCheck(root);
  assert.deepEqual(errors, [], report(errors));
  assert.ok(notes.some((n) => n.includes("absent")), `expected an absent note, got ${JSON.stringify(notes)}`);
});

test("--write re-pins digests from present files", async (t) => {
  const root = makeTree(t, {
    mutateManifest: (m) => {
      m.snapshots[0].sha256 = "0".repeat(64); // stale
    },
  });
  // Before: stale digest fails.
  const before = await runSnapshotCheck(root);
  assert.ok(before.errors.length > 0, report(before.errors));
  // Re-pin, then it passes.
  const write = await writeManifest(root);
  assert.deepEqual(write.errors, [], report(write.errors));
  const after = await runSnapshotCheck(root);
  assert.deepEqual(after.errors, [], report(after.errors));
});
