#!/usr/bin/env node
/**
 * check-artifact-commit-vectors.mjs
 *
 * Independent reference verifier for the DAT-002 artifact-commit acceptance
 * fixture `tests/fixtures/artifact-commit/v1/vectors.json`. It owns a THIRD,
 * from-scratch re-derivation of the fenced-commit VERIFICATION decision (the
 * post-fence half of `artifact_commit`): given a manifest + the store-observed
 * actual size/sha + the authenticated org + the locked lease's company, it decides
 * accept | reject(reason) purely, mirroring but NOT importing the server logic or
 * the frozen worker-protocol zod schema. Because two independent implementations
 * (the server and this reference) pin to one fixture, neither can silently diverge
 * on which manifests may be committed and which must be refused.
 *
 * Reasons (INTERNAL, pre-wire — the server maps these onto the frozen closed
 * protocol vocabulary): `malformed_manifest` (structural/schema reject),
 * `wrong_prefix`, `tenant_mismatch`, `size_mismatch`, `hash_mismatch`, or `accept`.
 * Precedence here is structural → prefix → tenant → size → hash (the guarded-fence
 * check is a live-DB concern, out of scope for this pure re-derivation; the fixture
 * carries no fence state).
 *
 * The helpers are exported for the dependency-free node:test corpus
 * (`check-artifact-commit-vectors.test.mjs`).
 *
 * Usage:
 *   node scripts/check-artifact-commit-vectors.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const FIXTURE_SEGMENTS = ["tests", "fixtures", "artifact-commit", "v1", "vectors.json"];

/** Thrown by the reference validation for any fixture problem. */
export class ArtifactCommitVectorError extends Error {}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const ARTIFACT_KINDS = new Set([
  "workspace_snapshot", "workspace_patch", "log", "screenshot", "dom_snapshot",
  "browser_cookie_state", "browser_storage_state", "playwright_trace", "browser_video",
  "download", "service_checkpoint", "other",
]);
const RETENTION_CLASSES = new Set(["ephemeral", "run", "audit", "checkpoint"]);

/** Re-derived path-safety predicate (mirrors worker-protocol `isSafeWorkspacePath`). */
export function isSafeObjectKey(p) {
  if (typeof p !== "string") return false;
  if (p.length === 0 || p.length > 1024) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  if (p.includes(":")) return false;
  for (let i = 0; i < p.length; i += 1) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  for (const seg of p.split("/")) {
    if (seg.length === 0) return false;
    if (seg === "." || seg === "..") return false;
    if (seg.length > 255) return false;
  }
  return true;
}

/** Re-derived attempt object-key prefix (mirrors `expectedAttemptObjectPrefix`). */
export function attemptPrefix(organizationId, jobId, attempt) {
  return `organizations/${organizationId}/jobs/${jobId}/attempts/${attempt}/`;
}

/** True iff `key` is safe, has the exact `prefix`, and a non-empty suffix. */
export function objectKeyHasPrefix(key, prefix) {
  return isSafeObjectKey(key) && key.startsWith(prefix) && key.length > prefix.length;
}

/** Fail-closed structural validation of a manifest (mirrors the frozen schema's
 * shape + the self-binding objectKey-prefix refinement). Returns true iff valid. */
export function isStructurallyValidManifest(m) {
  if (typeof m !== "object" || m === null) return false;
  if (m.protocolVersion !== 1) return false;
  if (!UUID.test(m.organizationId) || !UUID.test(m.companyId) || !UUID.test(m.jobId) || !UUID.test(m.artifactId)) return false;
  if (!Number.isInteger(m.attempt) || m.attempt < 1 || m.attempt > 1_000_000) return false;
  if (!ARTIFACT_KINDS.has(m.kind)) return false;
  if (m.sensitivity !== "restricted") return false; // the ONLY v1 sensitivity
  if (!RETENTION_CLASSES.has(m.retention)) return false;
  if (typeof m.objectKey !== "string" || m.objectKey.length < 1 || m.objectKey.length > 1024) return false;
  if (!Number.isInteger(m.sizeBytes) || m.sizeBytes < 0) return false;
  if (typeof m.sha256 !== "string" || !SHA256_HEX.test(m.sha256)) return false;
  if (typeof m.contentType !== "string" || m.contentType.length < 3 || !CONTENT_TYPE.test(m.contentType)) return false;
  if (typeof m.createdAt !== "string") return false;
  // The manifest binds its OWN objectKey to its OWN org/job/attempt (frozen refinement).
  if (!objectKeyHasPrefix(m.objectKey, attemptPrefix(m.organizationId, m.jobId, m.attempt))) return false;
  return true;
}

/**
 * Decide the post-fence commit verification purely. `authOrganizationId` +
 * `leaseCompanyId` come from the authenticated worker + the locked lease (NEVER the
 * manifest's self-assertion). Returns "accept" or a reject reason.
 */
export function decideCommit(input) {
  const { manifest, authOrganizationId, leaseCompanyId, actualSizeBytes, actualSha256 } = input;
  if (!isStructurallyValidManifest(manifest)) return "malformed_manifest";
  // BRW-003d-5 — the ABSOLUTE size ceiling, modelled here because the server
  // enforces one and this reference did not. The header below claims the two
  // implementations "cannot silently diverge"; they already had, on exactly this
  // axis, which is the axis the ticket's large-download case sits on.
  //
  // PRECEDENCE IS LOAD-BEARING: artifact-commit.ts applies the ceiling to the
  // store-observed size BEFORE tenant/prefix validity, so an oversized object
  // under a wrong prefix is refused for SIZE. Ordering this after the prefix check
  // would model a different server.
  if (typeof input.maxArtifactBytes === "number" && actualSizeBytes > input.maxArtifactBytes) {
    return "size_ceiling_exceeded";
  }
  const prefix = attemptPrefix(authOrganizationId, manifest.jobId, manifest.attempt);
  if (!manifest.objectKey.startsWith(prefix)) return "wrong_prefix";
  if (String(manifest.organizationId) !== String(authOrganizationId)) return "tenant_mismatch";
  if (String(manifest.companyId) !== String(leaseCompanyId)) return "tenant_mismatch";
  if (manifest.sizeBytes !== actualSizeBytes) return "size_mismatch";
  if (manifest.sha256 !== actualSha256) return "hash_mismatch";
  return "accept";
}

export function verifyFixture(fixture) {
  const problems = [];
  if (fixture?.version !== "1") problems.push(`version must be "1", got ${JSON.stringify(fixture?.version)}`);
  if (fixture?.schema !== "aoa-artifact-commit-vectors/v1") problems.push("schema id mismatch");
  const ctx = fixture?.context;
  if (typeof ctx !== "object" || ctx === null) problems.push("context missing");
  const accepts = Array.isArray(fixture?.acceptVectors) ? fixture.acceptVectors : null;
  const rejects = Array.isArray(fixture?.rejectVectors) ? fixture.rejectVectors : null;
  if (!accepts || accepts.length === 0) problems.push("acceptVectors must be a non-empty array");
  if (!rejects || rejects.length === 0) problems.push("rejectVectors must be a non-empty array");

  const seen = new Set();
  const authOrg = ctx?.authOrganizationId;
  const leaseCompany = ctx?.leaseCompanyId;

  for (const [i, v] of (accepts ?? []).entries()) {
    const label = v?.name ?? `#${i}`;
    if (!v?.name || seen.has(v.name)) problems.push(`accept vector ${label}: missing or duplicate name`);
    seen.add(v?.name);
    const decision = decideCommit({
      maxArtifactBytes: ctx?.maxArtifactBytes,
      manifest: v.manifest,
      authOrganizationId: authOrg,
      leaseCompanyId: leaseCompany,
      actualSizeBytes: v.actualSizeBytes,
      actualSha256: v.actualSha256,
    });
    if (decision !== "accept") {
      problems.push(`accept vector ${label}: reference decided ${decision}, expected accept`);
    }
  }

  for (const [i, r] of (rejects ?? []).entries()) {
    const label = r?.name ?? `#${i}`;
    if (!r?.name || seen.has(r.name)) problems.push(`reject vector ${label}: missing or duplicate name`);
    seen.add(r?.name);
    if (typeof r?.reason !== "string") { problems.push(`reject vector ${label}: missing reason`); continue; }
    const decision = decideCommit({
      maxArtifactBytes: ctx?.maxArtifactBytes,
      manifest: r.manifest,
      authOrganizationId: authOrg,
      leaseCompanyId: leaseCompany,
      actualSizeBytes: r.actualSizeBytes,
      actualSha256: r.actualSha256,
    });
    if (decision === "accept") {
      problems.push(`reject vector ${label}: reference ACCEPTED a manifest that must be rejected`);
    } else if (decision !== r.reason) {
      problems.push(`reject vector ${label}: reference decided ${decision}, expected ${r.reason}`);
    }
  }

  if (problems.length > 0) {
    throw new ArtifactCommitVectorError(`artifact-commit fixture invalid:\n - ${problems.join("\n - ")}`);
  }
  return { accepts: accepts.length, rejects: rejects.length };
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
    console.error(`artifact-commit vectors: FAIL — cannot read/parse fixture: ${error.message}`);
    process.exit(1);
  }
  try {
    const { accepts, rejects } = verifyFixture(fixture);
    console.log(`artifact-commit vectors: PASS (${accepts} accept vectors, ${rejects} reject vectors)`);
  } catch (error) {
    console.error(`artifact-commit vectors: FAIL — ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
