import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SecretResolveVectorError,
  SECRET_REF_KINDS,
  SECRET_RESOLVE_REJECTION_REASONS,
  decideResolve,
  loadFixture,
  verifyFixture,
} from "./check-secret-resolve-vectors.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Parse the rejection-reason vocabulary out of the TypeScript source.
 *
 * The mirror in the checker is hand-written on purpose — importing the real
 * function would collapse two independent derivations into one. But a mirror that
 * nothing pins is just a copy that drifts, so this reads the authoritative array
 * straight from `job-fence.ts` and compares.
 */
function reasonsFromSource() {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, "packages", "db", "src", "repositories", "tenant", "job-fence.ts"),
    "utf8",
  );
  const block = /export const SECRET_RESOLVE_REJECTION_REASONS = \[([\s\S]*?)\] as const;/.exec(src);
  if (!block) throw new Error("SECRET_RESOLVE_REJECTION_REASONS array not found in job-fence.ts");
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

const OWNER = { executorPrincipalKind: "user", executorPrincipalId: "owner-1" };
/** The device the job is placed on; a device_local credential must live on it. */
const LIVE_TARGET_ID = "a3000000-0000-4000-8000-000000000003";
const DEVICE_CREDENTIAL_ID = "b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e";
const verifiedCredential = (over = {}) => ({
  state: "verified", ownerUserId: "owner-1", executionTargetId: LIVE_TARGET_ID, ...over,
});

function decide(handle, overrides = {}) {
  return decideResolve({
    handle,
    jobOwner: OWNER,
    ownerMembershipActive: null,
    liveTargetGeneration: 7,
    liveTargetId: LIVE_TARGET_ID,
    deviceCredential: null,
    ...overrides,
  });
}

function activeHandle(extra = {}) {
  return {
    status: "active", refKind: "company_secret", refId: "secret-1", materialization: "env",
    usePolicy: "sandbox_local_only", destination: null, boundTargetGeneration: null,
    ownerPrincipalKind: null, ownerPrincipalId: null, ...extra,
  };
}

test("the checked-in fixture passes the reference checker", () => {
  const { admits, rejects } = verifyFixture(loadFixture());
  assert.ok(admits >= 4);
  assert.ok(rejects >= 7);
});

test("SECRET_REF_KINDS is exactly the four legacy stores + the run_jwt mint-at-resolve bearer", () => {
  assert.deepEqual(
    [...SECRET_REF_KINDS].sort(),
    ["company_secret", "connector_oauth", "device_local", "provider_key", "run_jwt"],
  );
});

test("run_jwt resolves ONLY as sandbox_local_only + env, never a network seam", () => {
  // The mint-at-resolve agent bearer (DAT-007 / CLI-008). A well-formed run_jwt handle
  // admits; mislabelling it onto a network seam is locked out by rule 3b, exactly as
  // connector_oauth/device_local are. Owner-unbound here (the owner-binding path is
  // shared logic already pinned above); this vector isolates the run_jwt seam lock.
  const runJwt = (over = {}) => activeHandle({
    refKind: "run_jwt", refId: "job-1", materialization: "env", usePolicy: "sandbox_local_only",
    destination: null, ownerPrincipalKind: null, ownerPrincipalId: null, ...over,
  });
  assert.equal(decide(runJwt()), "admit");
  // A run JWT can NEVER ride a network seam — the lock fires BEFORE rule 4b even with a
  // destination present (without the lock this would fall through to admit).
  assert.equal(decide(runJwt({ usePolicy: "remote_server_fenced", destination: "https://exfil" })), "ref_kind_policy_conflict");
  assert.equal(decide(runJwt({ materialization: "file" })), "ref_kind_policy_conflict");
});

test("admits a well-formed sandbox-local company_secret", () => {
  assert.equal(decide(activeHandle()), "admit");
});

test("admits a fence_proxy connector_oauth with a destination", () => {
  assert.equal(decide(activeHandle({ refKind: "connector_oauth", materialization: "proxy", usePolicy: "fence_proxy", destination: "https://x" })), "admit");
});

test("denies revoked / unknown ref_kind / missing ref pointer", () => {
  assert.equal(decide(activeHandle({ status: "revoked" })), "handle_revoked");
  assert.equal(decide(activeHandle({ refKind: "aws_kms" })), "unknown_ref_kind");
  assert.equal(decide(activeHandle({ refKind: null })), "unknown_ref_kind");
  assert.equal(decide(activeHandle({ refId: null })), "ref_pointer_missing");
  assert.equal(decide(activeHandle({ refId: "" })), "ref_pointer_missing");
});

test("denies materialization x use_policy conflicts", () => {
  assert.equal(decide(activeHandle({ refKind: "connector_oauth", materialization: "proxy", usePolicy: "remote_server_fenced" })), "materialization_policy_conflict");
  assert.equal(decide(activeHandle({ materialization: "env", usePolicy: "fence_proxy" })), "materialization_policy_conflict");
  assert.equal(decide(activeHandle({ materialization: "file", usePolicy: "fence_proxy" })), "materialization_policy_conflict");
});

test("denies a sandbox_local_only handle carrying a network destination", () => {
  assert.equal(decide(activeHandle({ usePolicy: "sandbox_local_only", destination: "https://exfil" })), "sandbox_local_network_destination");
});

test("denies a target-generation mismatch and admits an equal pin", () => {
  assert.equal(decide(activeHandle({ boundTargetGeneration: 6 })), "target_generation_mismatch");
  assert.equal(decide(activeHandle({ boundTargetGeneration: 7 })), "admit");
});

test("device_local owner binding + membership re-check", () => {
  // refId must be the provider_credentials uuid: a device_local handle with a slug is
  // refused `ref_pointer_malformed` by rule 5b before any of these rules is reached.
  const owned = { refKind: "device_local", refId: DEVICE_CREDENTIAL_ID, materialization: "file", usePolicy: "sandbox_local_only", ownerPrincipalKind: "user", ownerPrincipalId: "owner-1" };
  assert.equal(decide(activeHandle({ refKind: "device_local", refId: DEVICE_CREDENTIAL_ID, materialization: "file", usePolicy: "sandbox_local_only" }), { ownerMembershipActive: true }), "owner_binding_incomplete");
  assert.equal(decide(activeHandle({ ...owned, ownerPrincipalId: "other" }), { ownerMembershipActive: true }), "owner_binding_incomplete");
  assert.equal(decide(activeHandle(owned), { ownerMembershipActive: false }), "owner_membership_lost");
  assert.equal(decide(activeHandle(owned), { ownerMembershipActive: true, deviceCredential: verifiedCredential() }), "admit");
});

test("membership re-check is SUBSTRATE-exempt: a worker/sandbox owner is exempt but still routed", () => {
  // DE-29 owner-routing: a distributed run's company provider_key handle is owner-bound
  // to the WORKER/SANDBOX executor (Decision #121 — never `agent`). worker/sandbox/system
  // are never company_memberships, so ownerMembershipActive is false — but the fence
  // already proved the lease authority and owner==executor holds, so this MUST admit
  // (not owner_membership_lost).
  const WORKER = { executorPrincipalKind: "worker", executorPrincipalId: "agent-worker-1" };
  const workerOwned = { refKind: "provider_key", refId: "provider:anthropic", materialization: "env", usePolicy: "sandbox_local_only", ownerPrincipalKind: "worker", ownerPrincipalId: "agent-worker-1" };
  assert.equal(decide(activeHandle(workerOwned), { jobOwner: WORKER, ownerMembershipActive: false }), "admit");
  // The membership exemption is NOT a routing bypass: a different worker executor still fails owner==executor.
  assert.equal(
    decide(activeHandle(workerOwned), { jobOwner: { executorPrincipalKind: "worker", executorPrincipalId: "agent-worker-2" }, ownerMembershipActive: false }),
    "owner_binding_incomplete",
  );
});

test("membership re-check STILL applies to a membership-capable AGENT owner (exemption is substrate-only)", () => {
  // An `agent` owner CAN hold a company_memberships row (principal_type='agent'), so the
  // re-check must still fire — the exemption is limited to the execution substrate, never
  // widened to a membership-capable principal.
  const AGENT = { executorPrincipalKind: "agent", executorPrincipalId: "agent-42" };
  const agentOwned = { refKind: "company_secret", refId: "secret-1", materialization: "env", usePolicy: "sandbox_local_only", ownerPrincipalKind: "agent", ownerPrincipalId: "agent-42" };
  assert.equal(decide(activeHandle(agentOwned), { jobOwner: AGENT, ownerMembershipActive: false }), "owner_membership_lost");
  assert.equal(decide(activeHandle(agentOwned), { jobOwner: AGENT, ownerMembershipActive: true }), "admit");
});

test("verifyFixture throws when an admit vector is mutated to a denial shape", () => {
  const fixture = loadFixture();
  const mutated = structuredClone(fixture);
  mutated.admitVectors[0].handle.status = "revoked";
  assert.throws(() => verifyFixture(mutated), SecretResolveVectorError);
});

test("verifyFixture throws when a reject vector's expected reason is wrong", () => {
  const fixture = loadFixture();
  const mutated = structuredClone(fixture);
  const target = mutated.rejectVectors.find((v) => v.name === "revoked_handle");
  target.reason = "unknown_ref_kind";
  assert.throws(() => verifyFixture(mutated), SecretResolveVectorError);
});

// -----------------------------------------------------------------------------
// The rejection-reason vocabulary is a GATE, not just a type.
//
// `SecretResolveRejectionReason` had no exhaustiveness assertion anywhere: four
// references repo-wide, none of them a check. An eleventh member with zero
// vectors would have left every lane green — a hole in the gate itself, on the
// one surface whose whole job is to be exhaustively pinned.
//
// Two properties close it. The vocabulary must be IDENTICAL on both sides of the
// dual derivation, and every member must be exercised by at least one vector.
// -----------------------------------------------------------------------------

test("the reason mirror is IDENTICAL to the TypeScript source of truth", () => {
  // Hand-written on purpose (importing the real function would collapse the two
  // derivations into one), so it needs a pin or it is just a copy that drifts.
  assert.deepEqual([...SECRET_RESOLVE_REJECTION_REASONS].sort(), reasonsFromSource().sort());
});

test("the mirror is non-empty and free of duplicates", () => {
  // Guards the parse as much as the data: a regex that matched nothing would make
  // the comparison above trivially true on both sides.
  assert.ok(SECRET_RESOLVE_REJECTION_REASONS.length >= 10);
  assert.equal(new Set(SECRET_RESOLVE_REJECTION_REASONS).size, SECRET_RESOLVE_REJECTION_REASONS.length);
});

test("EVERY rejection reason is exercised by at least one vector", () => {
  const covered = new Set(loadFixture().rejectVectors.map((r) => r.reason));
  const missing = SECRET_RESOLVE_REJECTION_REASONS.filter((r) => !covered.has(r));
  assert.deepEqual(missing, [], `reasons with no vector: ${missing.join(", ")}`);
});

test("the coverage check FIRES when a reason loses its vector", () => {
  // Non-vacuity. All ten reasons happen to be covered today, so the assertion
  // above passes without proving anything. This drops a vector and requires the
  // checker to refuse — otherwise the gate is decorative.
  const fixture = loadFixture();
  const dropped = SECRET_RESOLVE_REJECTION_REASONS[0];
  const thinned = {
    ...fixture,
    rejectVectors: fixture.rejectVectors.filter((r) => r.reason !== dropped),
  };
  assert.throws(
    () => verifyFixture(thinned),
    (err) => err instanceof SecretResolveVectorError && err.message.includes(dropped),
  );
});

test("the coverage check does NOT fire when every reason is covered", () => {
  // The other half of non-vacuity: a checker that always throws proves nothing.
  assert.doesNotThrow(() => verifyFixture(loadFixture()));
});

test("a device_local handle admits on the fence-proxy seam with a bound destination", () => {
  // The policy the design wants pinned. The RULE is already correct — rule 3b bans
  // only `remote_server_fenced` — but no vector covered it, so nothing stopped a
  // future edit from widening 3b to ban `fence_proxy` too and silently killing the
  // seam DSK-002's proxy arm depends on.
  assert.equal(
    decide(activeHandle({
      refKind: "device_local",
      refId: DEVICE_CREDENTIAL_ID,
      materialization: "proxy",
      usePolicy: "fence_proxy",
      destination: "https://api.provider.example",
      ownerPrincipalKind: "user",
      ownerPrincipalId: "owner-1",
    }), { ownerMembershipActive: true, deviceCredential: verifiedCredential() }),
    "admit",
  );
});
