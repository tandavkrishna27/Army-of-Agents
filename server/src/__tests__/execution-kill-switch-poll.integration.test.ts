/**
 * REL-004 Lane C (clause 3a) — a kill switch stops NEW leases, on the REAL poll path.
 *
 * The Wave-4 gate requires "a kill switch can actually stop new leases, proven by a test that
 * exercises the poll path, not only the decision function". So this suite runs
 * `createJobLeasingService(...).poll(...)` against embedded PostgreSQL under the non-owner
 * `aoa_app` role, with a real `createKillSwitchPolicyReader`, and asserts on BOTH the poll
 * response and the `leases` table.
 *
 * Clause 3a has two halves and both are here:
 *
 *   - new leases STOP           -> cases 1-6, 10
 *   - in-flight work FINISHES   -> cases 8-9 (ack + renew still succeed under a thrown switch)
 *
 * The second half held by OMISSION before this suite existed: `ack` and `renew` are separate
 * code paths that simply have no kill check. A property that holds because nobody wrote the
 * opposite is the vacuously-true class, and it stops being vacuous the moment someone "helpfully"
 * adds a gate to those paths and orphans a run inside its sandbox.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres, { type Sql } from "postgres";
import {
  applyPendingMigrations,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import {
  canonicalProviderConstraintProfileDigestInputV1,
  canonicalizeJsonV1,
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type LeaseRenewOperationRequestV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import {
  KILL_SWITCH_DRAIN_RETRY_AFTER_MS,
  createJobLeasingService,
  type VerifiedWorkerOperation,
} from "../services/job-leasing.js";
import { createJobLeaseRenewalService } from "../services/job-fencing.js";
import { createKillSwitchPolicyReader } from "../services/execution-kill-switch-policy.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "a4000000-0000-4000-8000-000000000001";
const COMPANY = "a4000000-0000-4000-8000-000000000002";
const TARGET = "a4000000-0000-4000-8000-000000000003";
const WORKER = "a4000000-0000-4000-8000-000000000004";
const PASSWORD = "rel-004-role-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);

/** The target's `execution_targets.kind` — the provider axis a switch names. */
const TARGET_KIND = "dedicated_worker";
/** A real kind that is NOT this target's, for the non-vacuity case. */
const OTHER_KIND = "e2b";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "rel-004-provider",
    version: 1,
    maxContinuousRuntimeSeconds: 3_600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2_000, memoryMiB: 4_096, pids: 512, diskMiB: 8_192 },
    maxConcurrentOperations: 2,
    supportedOperations: [
      "create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup",
    ],
    localityTags: ["organization_target_only"],
    checkpointMode: "none",
    healthMode: "none",
  } as const;
  const digest = sha256(canonicalProviderConstraintProfileDigestInputV1(unsigned as never));
  return { ...unsigned, digest } as unknown as ProviderConstraintProfileV1;
}

function registeredProfile(provider: ProviderConstraintProfileV1): RegisteredTargetProfileV1 {
  return {
    protocolVersion: 1,
    targetId: TARGET,
    targetClass: "organization_dedicated",
    scope: "organization",
    organizationId: ORG,
    ownerPrincipalId: null,
    trustCeiling: "organization_isolated",
    credentialCeiling: "organization_brokered",
    dataLocalityCeiling: "organization_target_only",
    providerConstraints: {
      profileId: provider.profileId,
      version: provider.version,
      digest: provider.digest,
    },
    capabilityCeiling: ["workload.batch", "sandbox.process_isolated"],
    deviceGeneration: 1,
    revokedAt: null,
    policyHash: POLICY_HASH,
  };
}

function workerHello() {
  return {
    protocolVersion: 1 as const,
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 1,
    agentVersion: "rel-004-integration",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux" as const, arch: "x64" as const, runtime: "worker" },
    reportedCapabilities: ["workload.batch" as const, "sandbox.process_isolated" as const],
    capacity: {
      batchSlots: 2,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 2_000,
      freeMemoryMiB: 4_096,
      freeDiskMiB: 8_192,
    },
    policyHash: POLICY_HASH,
  };
}

function pollRequest(): PollRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `poll-${randomUUID()}`,
    audience: "worker_poll",
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 1,
    capacity: {
      batchSlots: 2,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 2_000,
      freeMemoryMiB: 4_096,
      freeDiskMiB: 8_192,
    },
  };
}

function ackRequest(offer: LeaseOfferV1): LeaseAckOperationRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `ack-${randomUUID()}`,
    audience: "worker_run",
    idempotencyKey: randomUUID(),
    body: {
      protocolVersion: 1,
      workerId: offer.workerId,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      ackedAt: new Date().toISOString(),
      extensions: [],
    },
  };
}

function renewRequest(offer: LeaseOfferV1): LeaseRenewOperationRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `renew-${randomUUID()}`,
    audience: "worker_run",
    idempotencyKey: randomUUID(),
    body: {
      protocolVersion: 1,
      workerId: offer.workerId,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      observedAt: new Date().toISOString(),
      extensions: [],
    },
  };
}

integration("REL-004 clause 3a — a kill switch stops new leases on the real poll path", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;
  let seq = 0;

  function guard() {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!admin || !app) throw new Error("test setup incomplete");
    return { admin, app };
  }

  function auth(): VerifiedWorkerOperation {
    return {
      organizationId: ORG,
      workerId: WORKER,
      targetId: TARGET,
      targetGeneration: 1,
      deviceThumbprint: THUMBPRINT,
      profileHash: sha256(JSON.stringify(workerHello())),
      publicKey: "rel-004-public-key",
      proofId: `proof-${randomUUID()}`,
      proofIssuedAt: new Date(),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  /**
   * The service under test. Nothing is injected: the leasing service builds its own kill-switch
   * reader from the same `appDb`, so this exercises the REAL production wiring rather than a
   * reader the test handed it.
   */
  function leasing() {
    const { app } = guard();
    return createJobLeasingService({ appDb: app.db });
  }

  async function setSwitches(document: unknown): Promise<void> {
    const { admin } = guard();
    await admin`UPDATE instance_settings SET kill_switches = ${
      document === null ? admin`NULL` : admin.json(document as never)
    } WHERE singleton_key = 'default'`;
  }

  async function seedQueuedJob(): Promise<{ jobId: string }> {
    const { admin } = guard();
    seq += 1;
    const suffix = seq.toString().padStart(12, "0");
    const jobId = `a4100000-0000-4000-8000-${suffix}`;
    const attemptId = `a4200000-0000-4000-8000-${suffix}`;
    const provider = providerProfile();
    const profile = registeredProfile(provider);
    const availableAt = new Date(Date.now() - 60_000);
    await admin`INSERT INTO jobs
      (id, organization_id, company_id, workload_type, source_kind, source_identity, source_intent,
       requester_principal_kind, requester_principal_id, executor_principal_kind, executor_principal_id,
       input, input_hash, policy_snapshot, policy_hash, requirements, placement_request,
       available_at, priority, status, created_at, updated_at)
      VALUES (${jobId}, ${ORG}, ${COMPANY}, 'batch', 'one_shot', ${jobId},
        ${{ kind: "one_shot", operationId: jobId, operationKind: "extraction" }},
        'system', 'rel-004-test', 'worker', ${WORKER},
        ${{ command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds: 600 }},
        ${"5".repeat(64)}, ${{ policyId: "job-submission-default", version: 1 }}, ${POLICY_HASH},
        ${{ workloadType: "batch", requiredCapabilities: ["sandbox.process_isolated"] }},
        ${{ policyId: "job-submission-default", policyVersion: 1, requestedTarget: TARGET }},
        ${availableAt}, 50, 'queued', ${availableAt}, ${availableAt})`;
    await admin`INSERT INTO job_attempts
      (id, organization_id, company_id, job_id, attempt_number, status,
       placement_disposition, placement_owner, placement_target_id, placement_target_class,
       placement_target_scope, placement_target_generation, placement_profile_hash,
       placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
       placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
       placement_decided_at, created_at, updated_at)
      VALUES (${attemptId}, ${ORG}, ${COMPANY}, ${jobId}, 1, 'pending',
        'selected', 'organization_dedicated', ${TARGET}, 'organization_dedicated',
        'organization', 1, ${sha256(canonicalizeJsonV1(profile))}, ${provider.digest},
        'primary', 'target_selected', 'active', true, ${"6".repeat(64)}, ${"6".repeat(64)},
        clock_timestamp(), ${availableAt}, ${availableAt})`;
    return { jobId };
  }

  async function leaseCount(): Promise<number> {
    const { admin } = guard();
    const rows = await admin`SELECT count(*)::int AS n FROM leases`;
    return rows[0]!.n as number;
  }

  async function resetRuntimeRows(): Promise<void> {
    const { admin } = guard();
    await admin`DELETE FROM worker_operation_receipts`;
    await admin`DELETE FROM leases`;
    await admin`DELETE FROM job_attempts`;
    await admin`DELETE FROM jobs`;
    await admin`DELETE FROM worker_proof_replays`;
    await setSwitches(null);
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-rel-004-kill-"));
      const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
        default: EmbeddedPostgresCtor;
      };
      const port = await allocateEmbeddedPgPort();
      embedded = new EmbeddedPostgres({
        databaseDir: join(dataDir, "db"),
        user: "test",
        password: "test",
        port,
        persistent: false,
        initdbFlags: ["--encoding=UTF8", "--locale=C"],
      });
      await embedded.initialise();
      await embedded.start();
      const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
      await applyPendingMigrations(adminUrl);
      admin = postgres(adminUrl, { max: 4 });
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
      app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 8 });

      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'REL-004 org', 'rel-004-org')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'REL-004 company', 'R004')`;
      // The singleton the reader looks for. `kill_switches` stays NULL: the absent document.
      await admin`INSERT INTO instance_settings (singleton_key, general, experimental)
        VALUES ('default', '{}', '{}')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'rel-004-target', ${TARGET_KIND}, 'dedicated_tenant', 'active',
          '{}', '{}', 'organization', ${`organization:${ORG}`}, 1, ${profile},
          ${sha256(canonicalizeJsonV1(profile))}, ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${`organization:${ORG}`},
          'rel-004-public-key', ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello},
          clock_timestamp(), clock_timestamp(), 'REL-004 worker', 'enrolled')`;
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close({ timeoutSeconds: 5 }).catch(() => {});
    await admin?.end().catch(() => {});
    await embedded?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  it("0. I11 — the aoa_app role can actually READ the policy (migration 0261's grant)", async () => {
    // `assertExactServingRoleAuthority` enforces EXACT ACLs, so before the grant the serving
    // role held ZERO privileges on instance_settings and this read failed at runtime with
    // permission denied. Asserted explicitly because the failure is otherwise INVISIBLE: a
    // denied read is caught and reported as `policy_unreadable`, which drains — so cases 3-5
    // would pass for entirely the wrong reason. (Cases 1, 2 and 6 catch it too, by expecting an
    // offer, but only this one names the cause.)
    const { admin, app } = guard();
    await setSwitches({ schema: 1, switches: [] });
    const document = await createKillSwitchPolicyReader({ appDb: app.db }).read();
    expect(document).toEqual({ schema: 1, switches: [] });

    const granted = await admin`
      SELECT has_table_privilege('aoa_app', 'instance_settings', 'SELECT') AS can_select,
             has_table_privilege('aoa_app', 'instance_settings', 'UPDATE') AS can_update`;
    expect(granted[0]).toMatchObject({ can_select: true, can_update: false });
    await setSwitches(null);
  }, 60_000);

  it("1+2. offers a lease when no switch is set, and when a switch names a DIFFERENT provider", async () => {
    // Non-vacuity for every drain below: this exact fixture DOES produce an offer.
    await resetRuntimeRows();
    await seedQueuedJob();
    const first = await leasing().poll({ auth: auth(), request: pollRequest() });
    expect(first.outcome).toBe("offer");
    expect(await leaseCount()).toBe(1);

    await resetRuntimeRows();
    await seedQueuedJob();
    await setSwitches({
      schema: 1,
      switches: [{ dimension: "provider", value: OTHER_KIND, reason: "unrelated incident" }],
    });
    const second = await leasing().poll({ auth: auth(), request: pollRequest() });
    expect(second.outcome).toBe("offer");
    expect(await leaseCount()).toBe(1);
  }, 60_000);

  it("3. answers DRAIN and creates NO lease when this target's provider is killed", async () => {
    await resetRuntimeRows();
    await seedQueuedJob();
    await setSwitches({
      schema: 1,
      switches: [{ dimension: "provider", value: TARGET_KIND, reason: "provider incident 2026-08-22" }],
    });
    const response = await leasing().poll({ auth: auth(), request: pollRequest() });
    expect(response.outcome).toBe("drain");
    expect(response).toMatchObject({
      outcome: "drain",
      reason: "provider incident 2026-08-22",
      retryAfterMs: KILL_SWITCH_DRAIN_RETRY_AFTER_MS,
    });
    // The half that matters: a leasable job was sitting right there and no lease was created.
    expect(await leaseCount()).toBe(0);
  }, 60_000);

  it("3b. the drain hint is NON-NULL, so the switch is reversible without a fleet restart", async () => {
    // A `retryAfterMs: null` drain is terminal in the worker daemon: the poll loop exits and the
    // only way back is restarting every worker. That would make the Wave-4 stop button a grenade.
    await resetRuntimeRows();
    await seedQueuedJob();
    await setSwitches({ schema: 1, switches: [{ dimension: "provider", value: TARGET_KIND, reason: "x" }] });
    const response = await leasing().poll({ auth: auth(), request: pollRequest() });
    expect(response.outcome === "drain" && response.retryAfterMs).toBeGreaterThan(0);
  }, 60_000);

  it("4. answers DRAIN with policy_unreadable for a document that exists but is not understood", async () => {
    // `{}` is exactly what a column DEFAULT would have produced. It must refuse, which is why
    // the column is nullable with no default.
    await resetRuntimeRows();
    await seedQueuedJob();
    await setSwitches({});
    const response = await leasing().poll({ auth: auth(), request: pollRequest() });
    expect(response).toMatchObject({ outcome: "drain", reason: "policy_unreadable" });
    expect(await leaseCount()).toBe(0);
  }, 60_000);

  it("5. answers DRAIN with placement_unknown for a TEMPLATE switch the control plane cannot evaluate", async () => {
    // The control plane holds no template fact for a distributed worker. Over-broad and loud
    // beats a silent no-op that tells an operator a compromised template is blocked.
    await resetRuntimeRows();
    await seedQueuedJob();
    await setSwitches({ schema: 1, switches: [{ dimension: "template", value: "aoa-base", reason: "cve" }] });
    const response = await leasing().poll({ auth: auth(), request: pollRequest() });
    expect(response).toMatchObject({ outcome: "drain", reason: "placement_unknown" });
    expect(await leaseCount()).toBe(0);
  }, 60_000);

  it("6. offers again once the switch is removed — the switch is a switch, not a fuse", async () => {
    await resetRuntimeRows();
    await seedQueuedJob();
    await setSwitches({ schema: 1, switches: [{ dimension: "provider", value: TARGET_KIND, reason: "x" }] });
    expect((await leasing().poll({ auth: auth(), request: pollRequest() })).outcome).toBe("drain");
    expect(await leaseCount()).toBe(0);

    await setSwitches(null);
    expect((await leasing().poll({ auth: auth(), request: pollRequest() })).outcome).toBe("offer");
    expect(await leaseCount()).toBe(1);
  }, 60_000);

  it("7. I7 — killing a provider does NOT revoke the target", async () => {
    // Design D1: "may this device work" is JOB-007's generation-fenced identity surgery, and
    // "may work be placed on this provider" is a policy opinion. Merging them would mean killing
    // one bad provider destroyed enrollment state.
    const { admin } = guard();
    await resetRuntimeRows();
    await seedQueuedJob();
    await setSwitches({ schema: 1, switches: [{ dimension: "provider", value: TARGET_KIND, reason: "x" }] });
    await leasing().poll({ auth: auth(), request: pollRequest() });

    const target = await admin`SELECT status, device_generation FROM execution_targets WHERE id = ${TARGET}`;
    expect(target[0]).toMatchObject({ status: "active", device_generation: 1 });
    const worker = await admin`SELECT status, revoked_at FROM workers WHERE id = ${WORKER}`;
    expect(worker[0]).toMatchObject({ status: "enrolled", revoked_at: null });
    const revocations = await admin`SELECT count(*)::int AS n FROM execution_target_revocations`;
    expect(revocations[0]!.n).toBe(0);
  }, 60_000);

  it("7b. a drained poll still advances worker liveness — drain is policy, not death", async () => {
    // D7. Suppressing the touch would make a paused fleet look dead to every heartbeat-age guard,
    // and the worker would fail authority revalidation once the switch was lifted.
    const { admin } = guard();
    await resetRuntimeRows();
    await seedQueuedJob();
    await admin`UPDATE workers SET last_seen_at = clock_timestamp() - interval '30 seconds' WHERE id = ${WORKER}`;
    const before = await admin`SELECT last_seen_at FROM workers WHERE id = ${WORKER}`;
    await setSwitches({ schema: 1, switches: [{ dimension: "provider", value: TARGET_KIND, reason: "x" }] });
    await leasing().poll({ auth: auth(), request: pollRequest() });
    const after = await admin`SELECT last_seen_at FROM workers WHERE id = ${WORKER}`;
    expect(new Date(after[0]!.last_seen_at as string).getTime())
      .toBeGreaterThan(new Date(before[0]!.last_seen_at as string).getTime());
  }, 60_000);

  it("8+9+10. I12 — in-flight work finishes: ack and renew still succeed under a thrown switch", async () => {
    await resetRuntimeRows();
    await seedQueuedJob();
    const service = leasing();
    const offered = await service.poll({ auth: auth(), request: pollRequest() });
    expect(offered.outcome).toBe("offer");
    const offer = (offered as { outcome: "offer"; body: LeaseOfferV1 }).body;

    // The switch is thrown while the worker holds an un-ACKed offer.
    await setSwitches({
      schema: 1,
      switches: [{ dimension: "provider", value: TARGET_KIND, reason: "provider incident" }],
    });

    // 8. The ACK still succeeds. Refusing here would abandon an offered lease and leave the
    // attempt to the reaper — the opposite of "in-flight work finishes".
    const acked = await service.ack({ auth: auth(), request: ackRequest(offer) });
    expect(acked.outcome).toBe("acknowledged");

    // 9. Renewal still succeeds. Killing renewal would let the lease expire under a run that is
    // still executing inside its sandbox.
    const renewal = createJobLeaseRenewalService({ appDb: guard().app.db });
    const renewed = await renewal.renew({ auth: auth(), request: renewRequest(offer) });
    expect(renewed.outcome).toBe("renewed");

    // 10. But the same worker's NEXT poll drains — which is what makes 8 and 9 statements about
    // the existing lease rather than a hole in the gate.
    await seedQueuedJob();
    const next = await service.poll({ auth: auth(), request: pollRequest() });
    expect(next).toMatchObject({ outcome: "drain", reason: "provider incident" });
    expect(await leaseCount()).toBe(1);
  }, 60_000);
});
