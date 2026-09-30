// server/src/__tests__/u0-d1-placement-reachability.test.ts
//
// U0-PLACEMENT — CAN A REAL DAEMON POLL EVER BE OFFERED A JOB IN D1?
//
// Nothing before this asked it. D1 has a live enrolling worker container (`worker-b`,
// WRK-017) and a live control plane, and `tests/d1/e6f-*` prove the fenced routes work —
// but every one of those suites drives the wire from the TEST RUNNER, whose hello is
// hand-built in `tests/d1/lib/e6f-harness.mjs:217` with `reportedCapabilities:
// [...WORKER_CAPABILITIES]`. The SHIPPED daemon does not build its hello that way. It
// derives it, and the derivation is narrower than the harness's by construction.
//
// This file joins the two halves that had never been put in the same room:
//
//   the hello the SHIPPED daemon derives  ×  the target profile D1 actually COMMITS
//
// and runs the REAL server-side matcher over the pair. Not a copy of the matcher — the
// same `evaluateStaticLeaseEligibility` the poll transaction calls
// (`server/src/services/job-leasing.ts:749`), which calls the frozen
// `workerSatisfiesRequirements` (`packages/worker-protocol/src/capabilities.ts:452`).
//
// ── WHAT IT MEASURED, AND THE PREMISE IT CORRECTED ───────────────────────────
//
// The costing arrived here believing the empty capability set came from
// `SUPERVISABLE_WORKLOAD_CAPABILITIES ∩ capabilitiesForIsolation("none")`. It does not.
// `hello-provisioning.ts:44-47` is a UNION:
//
//     const deviceCanProvide = new Set([...SUPERVISABLE_WORKLOAD_CAPABILITIES,
//                                       ...capabilitiesForIsolation(input.isolation)]);
//
// so at isolation `none` the device can provide exactly {"workload.batch"} — non-empty.
// The INTERSECTION is with the admin-ratified ceiling, one line later:
//
//     const reportedCapabilities = parsed.data.capabilityCeiling
//       .filter((cap) => deviceCanProvide.has(cap));
//
// The empty set is real, but it is a property of THE COMMITTED SEED, not of isolation
// `none` and not of the daemon: `docker/d1/worker-b.profile.json` ratified a ceiling of
// ["workload.service", "provider.lifecycle_v1", "provider.cleanup_v1",
// "provider.health_v1"] — disjoint from {"workload.batch"}. A ceiling that grants only a
// workload the shipped daemon cannot supervise (batch only; `hello-provisioning.ts:27`)
// leaves that daemon reporting NOTHING, and step 5 of the matcher then refuses every
// candidate job forever, silently, as `static_requirements_mismatch`.
//
// The fix is a ceiling that grants what the device can actually do. That is a seed change,
// not a shipped-code change, and it is not a lie: the daemon really does supervise batch,
// and `composed-journey.component.test.ts` runs a real supervisor through
// create→execute→destroy to prove it.
//
// ── EVERY CONJUNCT A SEEDED ATTEMPT MUST SATISFY TO REACH A DAEMON ───────────
// Measured, not assumed. A later unit that misses one of these gets a silent `no_work`.
//
//   SQL pre-filter (`job-control.ts:1912` `lockEligibleLeaseCandidates`, one `.where(and(...))`):
//     attempt.status='pending', placementDisposition='selected', placementMode='active',
//     placementLeaseEligible=true, placementOwner=targetClass, placementTargetId,
//     placementTargetClass, placementTargetScope, placementTargetGeneration,
//     placementProfileHash, placementProviderConstraintHash, job.status='queued',
//     job.workloadType ∈ admissibleWorkloadTypes, job.availableAt <= now,
//     and NO matching `worker_lease_rejections` row (the negative-certificate anti-join —
//     one earlier mismatch under the SAME staticContextHash suppresses the candidate FOREVER
//     until the context hash changes).
//
//   `deriveAdmissibleWorkloadTypes` (`job-leasing.ts:489`) over min(storedHello.capacity,
//     pollRequest.capacity): live.total < provider.maxConcurrentOperations; free cpu/mem/disk
//     ≤ the provider ceiling AND ≥ the bounded demand (min(1000,·)/min(1024,·)/min(1024,·));
//     batchSlots > live.batch.
//
//   `workerSatisfiesRequirements` (`capabilities.ts:452`), all eight steps:
//     1 hello.targetId == profile.targetId, deviceGeneration equal, profile.revokedAt null
//     2 the verified provider ref equals BOTH the target's and the job's ref
//     3 protocol ranges overlap
//     4 job.policyHash == profile.policyHash == hello.policyHash
//     5 `workload.<type>` ∈ (ceiling ∩ reported); every requirements.capability likewise;
//       every mustUnderstand token is KNOWN and in the intersection
//     6 targetClass/trustClass allowed, matrix row consistent, credential + locality in-row
//     6a requested credential/locality within the target's committed ceiling (ordered)
//     6b owner binding when requiredOwnerPrincipalId is non-null
//     7 free resources ≤ the provider resource ceiling
//     8 a free slot for the workload type
//
//   ★ Steps 7 and 8 are NEUTRALISED at the server: `evaluateStaticLeaseEligibility`
//     substitutes `NEUTRAL_LEASE_MATCHER_CAPACITY` (`job-lease-eligibility.ts:213`), whose
//     slots are 1/1/1 and free resources 0. They bite for real only in the WORKER's own
//     `offerSatisfiesWorker` self-check (`poll/capacity.ts:143`), over measured capacity.
//
//   ★ Steps 2, 4, 6, 6a, 6b are SELF-SATISFYING on this path and prove nothing:
//     `normalizeSubmittedJobPlacementFacts` builds `targetRequirements` and `policyHash`
//     FROM the resolved target's own profile (`job-placement.ts:284-297`). The only clause
//     a stored job can actually fail is step 5.
//
//   ★ And within step 5, the `workload.<type>` check is REDUNDANT on this path — measured:
//     disabling it (`if (false && !effective.has(workloadCapability))`) left all four tests
//     below GREEN, because `submittedCapabilities` (`job-placement.ts:176-189`) always folds
//     `workload.<type>` INTO `requirements.capabilities`, so the loop underneath catches it.
//     Mutating THAT loop is what reds the last test here. Recorded so a future reader does
//     not mistake a surviving mutant for an untested clause.
//
//   ★ NOT SATISFIED TODAY, by anything: D1 seeds NO job and NO attempt for worker-b's target
//     (`22222222-…`). `seed-d1-worker-enrolment.mjs` writes the target, the route and the
//     code, and stops. Every queued job in D1 belongs to a per-test org minted by
//     `seedScenario`. Making the ceiling right makes the daemon OFFERABLE; it does not make
//     an offer EXIST.
//
// ── WHY THE FIRST TEST READS THE FILE INSTEAD OF RESTATING IT ────────────────
// If a future edit takes `workload.batch` back out of worker-b's ceiling, D1's only real
// daemon goes back to being permanently unofferable and NOTHING else in the tree notices:
// the poll answers `no_work`, which is a legal answer. That silence is the defect class.
// This test is the noise.

import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildDesktopHello,
  deriveHelloProvisioning,
  SUPERVISABLE_WORKLOAD_CAPABILITIES,
  capabilitiesForIsolation,
} from "@armyofagents/worker-daemon";
import type { WorkerCapacity, WorkerHelloV1 } from "@armyofagents/worker-protocol";

import {
  normalizePlacementRegistryTarget,
  type ExecutionTargetRow,
  type NormalizedPlacementRegistryTarget,
} from "../services/execution-target-resolver.js";
import { normalizeSubmittedJobPlacementFacts } from "../services/job-placement.js";
import { evaluateStaticLeaseEligibility } from "../services/job-lease-eligibility.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const WORKER_B_PROFILE_FILE = "docker/d1/worker-b.profile.json";
const DAEMON_BIN = "packages/worker-daemon/src/bin/worker-daemon.ts";
const JOB_LEASING = "server/src/services/job-leasing.ts";

// The seed's PURE exports. `postgres` is imported lazily inside its `main()`, precisely so
// these stay importable off a plain checkout — its own header says so, and
// `docker/d1/__tests__/enrolment-seed.test.mjs` already relies on it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const seed: any = await import(
  /* @vite-ignore */ pathToImportSpecifier("docker/control-plane/seed-d1-worker-enrolment.mjs")
);

function pathToImportSpecifier(rel: string): string {
  return new URL(`file://${path.join(repoRoot, rel).replace(/\\/g, "/")}`).href;
}

/** The isolation the SHIPPED daemon uses. A literal in the composition root, not config:
 * `worker-daemon.ts:536` passes `isolation: "none"`, because the per-OS probes DSK-002
 * described belong to DSK-003 and no container boot path sets one. Read it out of the
 * source so this test cannot keep asserting `none` after the bin stops meaning it. */
function shippedDaemonIsolation(): "none" | "docker" | "os_native" {
  const src = read(DAEMON_BIN);
  const match = /deriveHelloProvisioning\(\{[\s\S]{0,400}?isolation:\s*"(none|docker|os_native)"/.exec(src);
  expect(
    match,
    `${DAEMON_BIN} no longer passes a literal isolation to deriveHelloProvisioning; ` +
      "this test pinned that literal and must be re-derived rather than left asserting a stale one",
  ).not.toBeNull();
  return match![1] as "none" | "docker" | "os_native";
}

/** Mirror of `inferredCredentialBinding` (`job-leasing.ts:191`), which is module-private.
 * Pinned to the source text below so a drift fails HERE rather than silently changing what
 * "the requirements the poll would build" means. */
function inferredCredentialBinding(target: NormalizedPlacementRegistryTarget) {
  const src = read(JOB_LEASING);
  expect(
    src.includes(`credentialId: "stored-organization-authority"`) &&
      src.includes(`credentialKind: "company_api_key" as const`),
    `${JOB_LEASING} changed inferredCredentialBinding; this mirror must be updated`,
  ).toBe(true);
  expect(
    target.targetClass,
    "worker-b is organization_dedicated; the owner_desktop branch of inferredCredentialBinding is not mirrored here",
  ).not.toBe("owner_desktop");
  return {
    credentialId: "stored-organization-authority",
    credentialKind: "company_api_key" as const,
    executionTargetSlug: null,
    pinnedTargetId: target.targetId,
  };
}

/**
 * Rebuild the `execution_targets` row the D1 migrate job writes for a committed worker
 * profile, using the SEED'S OWN pure exports — `buildProviderConstraintProfile`,
 * `deriveRegisteredProfile`, `targetAuthorityKey` — so the row under test is the row D1
 * inserts, not a restatement of it (`docker/control-plane/seed-d1-worker-enrolment.mjs:249-289`).
 */
async function normalizedTargetForCommittedProfile(
  fileProfile: Record<string, unknown>,
): Promise<NormalizedPlacementRegistryTarget> {
  const { canonicalizeJsonV1, canonicalProviderConstraintProfileDigestInputV1 } = await import(
    "@armyofagents/worker-protocol"
  );
  const constraints = fileProfile.providerConstraints as { profileId: string; version: number };
  const provider = seed.buildProviderConstraintProfile(constraints.profileId, constraints.version);
  const providerDigest = sha256(
    Buffer.from(canonicalProviderConstraintProfileDigestInputV1(provider)),
  );
  const providerProfile = { ...provider, digest: providerDigest };
  const registeredProfile = seed.deriveRegisteredProfile(fileProfile, providerDigest);

  const row: ExecutionTargetRow = {
    id: String(fileProfile.targetId),
    slug: "d1-enrolling-worker",
    kind: "dedicated_worker",
    trustClass: "dedicated_tenant",
    status: "active",
    organizationId: (fileProfile.organizationId as string | null) ?? null,
    ownerUserId: null,
    scope: String(fileProfile.scope),
    targetAuthorityKey: seed.targetAuthorityKey(fileProfile),
    deviceGeneration: Number(fileProfile.deviceGeneration),
    registeredProfile,
    registeredProfileHash: sha256(canonicalizeJsonV1(registeredProfile)),
    providerConstraintProfile: providerProfile,
    lastSeenAt: new Date(),
  };

  const normalized = await normalizePlacementRegistryTarget(row);
  expect(
    normalized,
    "the committed worker profile no longer normalizes into a placement target; D1 bring-up would fail before placement",
  ).not.toBeNull();
  return normalized!;
}

/**
 * Derive the hello EXACTLY as the shipped daemon does.
 *
 * `worker-daemon.ts:534-540` calls `deriveHelloProvisioning` with the self-model's
 * registered profile, the literal isolation, and a nameplate capacity built from the
 * VERIFIED provider ceiling + the configured concurrency (defaults 1/1/1,
 * `config/config.ts:184-186`; the D1 compose sets no override). It then hands that
 * provisioning to `createWorkerIdentity`, whose entire body is
 * `buildDesktopHello({workerId, targetId, deviceGeneration, platform, arch, provisioning})`
 * (`identity/worker-identity.ts:43-50`) — so calling the builder directly here is the same
 * call with the same arguments, minus a device-key re-derivation that touches no field of
 * the hello.
 */
function shippedDaemonHello(input: {
  target: NormalizedPlacementRegistryTarget;
  isolation: "none" | "docker" | "os_native";
  workerId: string;
}): { hello: WorkerHelloV1; reported: readonly string[] } {
  const rc = input.target.providerConstraintProfile.resourceCeiling;
  const nameplate: WorkerCapacity = {
    batchSlots: 1,
    browserSessionSlots: 1,
    serviceSlots: 1,
    freeCpuMillis: rc.cpuMillis,
    freeMemoryMiB: rc.memoryMiB,
    freeDiskMiB: rc.diskMiB,
  };
  const provisioning = deriveHelloProvisioning({
    selfModelResponse: { registeredProfile: input.target.registeredProfile },
    isolation: input.isolation,
    capacity: nameplate,
  });
  expect(
    provisioning,
    "deriveHelloProvisioning returned null for a profile that already normalized — fail-toward-absent fired on a valid profile",
  ).not.toBeNull();
  const hello = buildDesktopHello({
    workerId: input.workerId,
    targetId: input.target.targetId,
    deviceGeneration: input.target.deviceGeneration,
    platform: "linux",
    arch: "x64",
    provisioning: provisioning!,
  });
  return { hello, reported: hello.reportedCapabilities };
}

/**
 * The requirements the poll would build for the D1 seed's own queued batch job
 * (`tests/d1/lib/e6f-harness.mjs:389` — `{ workloadType: "batch", requiredCapabilities: [] }`),
 * through the REAL `normalizeSubmittedJobPlacementFacts` that `job-leasing.ts:208` uses.
 */
function pollRequirementsForBatchJob(target: NormalizedPlacementRegistryTarget) {
  return pollRequirementsForJob(target, "batch");
}

/**
 * SVC-008b — the same builder, over any workload type.
 *
 * ★ Generalised rather than duplicated: the `workload.<type>` conjunct of step 5 is the one
 * clause a stored job can actually fail on this path (see the header), so a second hand-built
 * copy is exactly where a service case would quietly stop testing the same thing as the batch
 * case.
 */
function pollRequirementsForJob(
  target: NormalizedPlacementRegistryTarget,
  workloadType: "batch" | "browser_session" | "service",
) {
  const normalized = normalizeSubmittedJobPlacementFacts({
    sourceKind: "one_shot" as never,
    inputHash: "b".repeat(64),
    policyHash: target.registeredProfile.policyHash,
    requirements: { workloadType, requiredCapabilities: [] },
    placementRequest: { policyId: "job-submission-default", policyVersion: 1, requestedTarget: null },
    rollout: { enabled: true, mode: "active", reason: "stored_placement" },
    credentialBinding: inferredCredentialBinding(target),
    resolvedTarget: target,
  });
  expect(normalized.success && normalized.active, `the D1 ${workloadType} job did not normalize into placement facts`).toBe(true);
  return (normalized as { requirements: ReturnType<typeof Object> } & {
    requirements: Parameters<typeof evaluateStaticLeaseEligibility>[0]["requirements"];
  }).requirements;
}

/** The one decision the poll transaction makes per candidate (`job-leasing.ts:749`). */
async function offerableWithCeiling(
  capabilityCeiling: readonly string[],
  workloadType: "batch" | "browser_session" | "service" = "batch",
) {
  const fileProfile = { ...JSON.parse(read(WORKER_B_PROFILE_FILE)), capabilityCeiling };
  const target = await normalizedTargetForCommittedProfile(fileProfile);
  const { hello, reported } = shippedDaemonHello({
    target,
    isolation: shippedDaemonIsolation(),
    workerId: "99999999-9999-4999-8999-999999999999",
  });
  const evaluation = evaluateStaticLeaseEligibility({
    target: target.registeredProfile,
    verifiedProviderConstraints: target.providerConstraintProfile,
    worker: hello,
    requirements: pollRequirementsForJob(target, workloadType),
  });
  return { reported, evaluation };
}

describe("U0 — a shipped worker daemon's derived hello against D1's committed target profile", () => {
  it("the shipped daemon can supervise batch and service and nothing else, and reports no isolation at all", () => {
    // The two ceilings the union in hello-provisioning.ts is built from. If either widens,
    // every reachability conclusion below is re-derivable rather than silently stale.
    //
    // ★ SVC-008b WIDENED THE FIRST ONE, and this pin going red on that edit is the pin
    // WORKING. It is UPDATED, not deleted, and deliberately NOT weakened to `toContain`:
    // exact equality is what makes the NEXT widening (`workload.browser_session`) announce
    // itself, and `toContain` would let a third workload in silently — the same hole one
    // workload over. The conclusions below were RE-DERIVED against the new set, not
    // re-asserted; see the service case further down.
    expect([...SUPERVISABLE_WORKLOAD_CAPABILITIES]).toEqual(["workload.batch", "workload.service"]);
    expect([...capabilitiesForIsolation(shippedDaemonIsolation())]).toEqual([]);
  });

  it("the committed worker-b ceiling leaves the daemon offerable a real batch job", async () => {
    const { reported, evaluation } = await offerableWithCeiling(
      JSON.parse(read(WORKER_B_PROFILE_FILE)).capabilityCeiling,
    );
    // The daemon narrows the ratified ceiling to what it can actually run. Batch, only batch.
    expect(reported).toContain("workload.batch");
    expect(
      evaluation.eligible,
      "D1's only real worker daemon cannot be offered D1's own batch job: the ratified " +
        `ceiling in ${WORKER_B_PROFILE_FILE} grants no workload the daemon can supervise, so ` +
        "its reported capability set is empty and step 5 of workerSatisfiesRequirements " +
        "refuses every candidate as static_requirements_mismatch — a permanent, silent no_work",
    ).toBe(true);
    expect(evaluation.reasonCode).toBeNull();
  });

  it("a ceiling that grants no supervisable workload makes the daemon permanently unofferable", async () => {
    // The defect this file was written to find, pinned as a class rather than as one file's
    // contents: a ceiling granting only a workload the daemon does not supervise reports
    // nothing at all.
    //
    // ★ RE-DERIVED BY SVC-008b, not re-asserted. This case used `workload.service` as its
    // unsupervisable example. That is no longer true — the daemon supervises service now —
    // so keeping the old literal would have turned a class test into a green statement about
    // a workload that IS supported, which is worse than deleting it. The example is now
    // `workload.browser_session`, which remains unsupervisable (its supervisor is BRW's), and
    // the class the test asserts is unchanged.
    const { reported, evaluation } = await offerableWithCeiling([
      "workload.browser_session",
      "provider.lifecycle_v1",
      "provider.cleanup_v1",
      "provider.health_v1",
    ]);
    expect(reported).toEqual([]);
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.reasonCode).toBe("static_requirements_mismatch");
  });

  // -- SVC-008b T0: THE REACHABILITY TEST -------------------------------------------------
  //
  // ★★★ The clause the whole ticket turns on. Before the widening this was RED FOR A
  // STRUCTURAL REASON — `deriveHelloProvisioning` INTERSECTS the admin ceiling with what the
  // device can provide, so `workload.service` was filtered out of every daemon's hello no
  // matter what the ceiling said, step 5 refused every service candidate, and a service job
  // was `queued` / `static_requirements_mismatch` forever.
  //
  // Note what it does NOT claim: an eligible daemon is not a running service. D1 seeds no
  // service job and no attempt for worker-b's target, and SVC-007 owns the human path to
  // create one. This says a service job CAN now reach a worker.

  it("T0 — the committed worker-b ceiling now leaves the daemon offerable a real SERVICE job", async () => {
    const { reported, evaluation } = await offerableWithCeiling(
      JSON.parse(read(WORKER_B_PROFILE_FILE)).capabilityCeiling,
      "service",
    );
    expect(reported).toContain("workload.service");
    expect(
      evaluation.eligible,
      "a service job cannot be offered to D1's only real worker daemon: `workload.service` is " +
        "in the ratified ceiling but the daemon's derived hello does not report it, so step 5 " +
        "of workerSatisfiesRequirements refuses every service candidate as " +
        "static_requirements_mismatch — a permanent, silent no_work",
    ).toBe(true);
    expect(evaluation.reasonCode).toBeNull();
  });

  it("T0 — and batch is still offerable: the widening ADDED a workload, it did not swap one", async () => {
    const { reported, evaluation } = await offerableWithCeiling(
      JSON.parse(read(WORKER_B_PROFILE_FILE)).capabilityCeiling,
      "batch",
    );
    expect(reported).toContain("workload.batch");
    expect(evaluation.eligible).toBe(true);
  });

  it("adding one required capability the ceiling withholds flips the same match to red", async () => {
    // Proves the eligible case above reads the real matcher rather than a constant: the job
    // asks for `sandbox.process_isolated`, the device (isolation "none") reports none, and the
    // step-5 loop over requirements.capabilities refuses.
    const fileProfile = JSON.parse(read(WORKER_B_PROFILE_FILE));
    const target = await normalizedTargetForCommittedProfile(fileProfile);
    const { hello } = shippedDaemonHello({
      target,
      isolation: shippedDaemonIsolation(),
      workerId: "99999999-9999-4999-8999-999999999999",
    });
    const requirements = pollRequirementsForBatchJob(target);
    const evaluation = evaluateStaticLeaseEligibility({
      target: target.registeredProfile,
      verifiedProviderConstraints: target.providerConstraintProfile,
      worker: hello,
      requirements: { ...requirements, capabilities: [...requirements.capabilities, "sandbox.process_isolated"] },
    });
    expect(evaluation.eligible).toBe(false);
  });
});
