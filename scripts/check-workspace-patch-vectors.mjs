#!/usr/bin/env node
/**
 * check-workspace-patch-vectors.mjs
 *
 * Independent reference verifier for the DAT-003 patch fixture
 * `tests/fixtures/workspace-patch/v1/vectors.json`. It owns a THIRD, from-scratch
 * re-derivation of BOTH halves of DAT-003 — pinned to one fixture so the producer
 * (`packages/worker-daemon/src/patch/build-patch.ts`) and the apply mutator
 * (`recordPatchApplyState`) cannot silently diverge:
 *
 *   1. The producer SET-DIFF: given two manifest entry lists (base → result), it
 *      re-derives the create/modify/delete/rename operations in the pinned UTF-8
 *      byte order over the (unique) destination path, mirroring but NOT importing
 *      the worker-daemon producer.
 *   2. The apply DECISION `decideApply(patchBaseManifestHash, currentBase)`: a
 *      matching base → "applied"; a mismatched or absent base → "conflict_quarantined"
 *      (NEVER auto-applied), mirroring the pure decision inside the fenced
 *      `recordPatchApplyState` mutator.
 *
 * The helpers are exported for the dependency-free node:test corpus
 * (`check-workspace-patch-vectors.test.mjs`).
 *
 * Usage:
 *   node scripts/check-workspace-patch-vectors.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const FIXTURE_SEGMENTS = ["tests", "fixtures", "workspace-patch", "v1", "vectors.json"];

/** Thrown by the reference validation for any fixture problem. */
export class WorkspacePatchVectorError extends Error {}

/**
 * Compare two paths by their UTF-8 byte sequence (NOT JS's default UTF-16 order).
 * The SOLE ordering authority over the (unique) destination paths — mirrors the
 * producer's `compareUtf8`.
 */
export function compareUtf8(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.min(ba.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    if (ba[i] !== bb[i]) return ba[i] < bb[i] ? -1 : 1;
  }
  if (ba.length === bb.length) return 0;
  return ba.length < bb.length ? -1 : 1;
}

/** Index FILE entries by path (directory entries are ignored by the diff). */
function fileEntries(entries) {
  const map = new Map();
  for (const e of entries ?? []) {
    if (e?.kind !== "file") continue;
    map.set(e.path, { path: e.path, sha256: e.sha256, sizeBytes: e.sizeBytes });
  }
  return map;
}

function groupBySha(entries) {
  const map = new Map();
  for (const e of entries) {
    const list = map.get(e.sha256);
    if (list) list.push(e);
    else map.set(e.sha256, [e]);
  }
  return map;
}

/**
 * Re-derive the patch operations for a base→result diff. Independent of the
 * worker-daemon producer; returns the ops in the pinned UTF-8 destination-path order.
 */
export function diffManifests(baseEntries, resultEntries) {
  const base = fileEntries(baseEntries);
  const result = fileEntries(resultEntries);

  const modifies = [];
  const createCandidates = [];
  const deleteCandidates = [];
  for (const e of result.values()) {
    const prior = base.get(e.path);
    if (!prior) createCandidates.push(e);
    else if (prior.sha256 !== e.sha256) modifies.push({ op: "modify", path: e.path, resultSha256: e.sha256, sizeBytes: e.sizeBytes });
  }
  for (const e of base.values()) {
    if (!result.has(e.path)) deleteCandidates.push(e);
  }

  const createsBySha = groupBySha(createCandidates);
  const deletesBySha = groupBySha(deleteCandidates);
  const renamedCreates = new Set();
  const renamedDeletes = new Set();
  const renames = [];
  for (const [sha, dels] of deletesBySha) {
    const crs = createsBySha.get(sha);
    if (dels.length === 1 && crs && crs.length === 1) {
      const from = dels[0];
      const to = crs[0];
      renames.push({ op: "rename", fromPath: from.path, path: to.path, resultSha256: to.sha256, sizeBytes: to.sizeBytes });
      renamedDeletes.add(from.path);
      renamedCreates.add(to.path);
    }
  }
  const creates = createCandidates
    .filter((c) => !renamedCreates.has(c.path))
    .map((c) => ({ op: "create", path: c.path, resultSha256: c.sha256, sizeBytes: c.sizeBytes }));
  const deletes = deleteCandidates
    .filter((d) => !renamedDeletes.has(d.path))
    .map((d) => ({ op: "delete", path: d.path }));

  return [...modifies, ...creates, ...deletes, ...renames].sort((a, b) => compareUtf8(a.path, b.path));
}

/** Deep structural equality for two operation arrays (order-sensitive). */
export function operationsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The pure apply decision (D3): apply iff there IS an accepted base AND it equals
 * the patch's declared base; otherwise conflict-quarantine (NEVER auto-applies).
 * `currentBase` is `null` when the job has no committed base yet.
 */
export function decideApply(patchBaseManifestHash, currentBase) {
  return currentBase !== null && currentBase !== undefined && patchBaseManifestHash === currentBase
    ? "applied"
    : "conflict_quarantined";
}

export function verifyFixture(fixture) {
  const problems = [];
  if (fixture?.version !== "1") problems.push(`version must be "1", got ${JSON.stringify(fixture?.version)}`);
  if (fixture?.schema !== "aoa-workspace-patch-vectors/v1") problems.push("schema id mismatch");
  const diffs = Array.isArray(fixture?.diffVectors) ? fixture.diffVectors : null;
  const applies = Array.isArray(fixture?.applyVectors) ? fixture.applyVectors : null;
  if (!diffs || diffs.length === 0) problems.push("diffVectors must be a non-empty array");
  if (!applies || applies.length === 0) problems.push("applyVectors must be a non-empty array");

  const seen = new Set();
  for (const [i, v] of (diffs ?? []).entries()) {
    const label = v?.name ?? `#${i}`;
    if (!v?.name || seen.has(v.name)) problems.push(`diff vector ${label}: missing or duplicate name`);
    seen.add(v?.name);
    if (!Array.isArray(v?.operations)) { problems.push(`diff vector ${label}: missing operations`); continue; }
    const derived = diffManifests(v.base, v.result);
    if (!operationsEqual(derived, v.operations)) {
      problems.push(`diff vector ${label}: reference derived ${JSON.stringify(derived)}, expected ${JSON.stringify(v.operations)}`);
    }
    // Determinism: a second derivation is byte-identical.
    if (!operationsEqual(derived, diffManifests(v.base, v.result))) {
      problems.push(`diff vector ${label}: non-deterministic re-derivation`);
    }
  }

  for (const [i, v] of (applies ?? []).entries()) {
    const label = v?.name ?? `#${i}`;
    if (!v?.name || seen.has(v.name)) problems.push(`apply vector ${label}: missing or duplicate name`);
    seen.add(v?.name);
    if (v?.decision !== "applied" && v?.decision !== "conflict_quarantined") {
      problems.push(`apply vector ${label}: decision must be applied|conflict_quarantined`);
      continue;
    }
    const decision = decideApply(v.patchBaseManifestHash, v.currentBase ?? null);
    if (decision !== v.decision) {
      problems.push(`apply vector ${label}: reference decided ${decision}, expected ${v.decision}`);
    }
  }

  if (problems.length > 0) {
    throw new WorkspacePatchVectorError(`workspace-patch fixture invalid:\n - ${problems.join("\n - ")}`);
  }
  return { diffs: diffs.length, applies: applies.length };
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadFixture(root = repoRoot()) {
  return JSON.parse(fs.readFileSync(path.join(root, ...FIXTURE_SEGMENTS), "utf8"));
}

function main() {
  let fixture;
  try {
    fixture = loadFixture();
  } catch (error) {
    console.error(`workspace-patch vectors: FAIL — cannot read/parse fixture: ${error.message}`);
    process.exit(1);
  }
  try {
    const { diffs, applies } = verifyFixture(fixture);
    console.log(`workspace-patch vectors: PASS (${diffs} diff vectors, ${applies} apply vectors)`);
  } catch (error) {
    console.error(`workspace-patch vectors: FAIL — ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
