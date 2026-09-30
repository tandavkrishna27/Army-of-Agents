// DE-18 + DE-04, admission + session + heartbeat arms — the dominant PRODUCTION
// `target_revoked`/`unauthorized` denials, durably recorded with the CROSSING
// derived from the actual failed conjunct(s): an authoritative generation
// cutoff is DE-18; every other worker-authority-currency refusal is DE-04's
// worker-authority-currency arm (register amendment 2026-09-13 — the follow-on
// PR #448 documented). Each arm below drives the REAL refusing path over
// embedded PostgreSQL under the non-owner `aoa_app` role and asserts the
// durable row's WHO/TENANT/RESOURCE/WHY separately. Observed RED against the
// unchanged wiring before the sinks landed (both waves).
//
// Windows CI can't start embedded-postgres on the runneradmin runner (Issue
// #114) — gated; opt in with AOA_RUN_WIN_INTEGRATION=1.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ControlAckOperationRequestV1, LeaseOfferV1 } from "@armyofagents/worker-protocol";
import {
  setupJobControlFixture,
  auth,
  pollRequest,
  workerHello,
  sha256,
  ORG,
  COMPANY,
  TARGET,
  WORKER,
  THUMBPRINT,
  WORKER_PROFILE_HASH,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";
import {
  registerProofBoundHeartbeat,
  type VerifiedTargetPrincipal,
} from "../middleware/worker-session-auth.js";
import { createJobControlAckService } from "../services/job-control-ack.js";

/** A worker→server control-ACK envelope for `offer` (mirrors de-04-18's helper). The ACK
 * never reaches its mutator in these arms — the authority recheck refuses first. */
function controlAckRequest(offer: LeaseOfferV1): ControlAckOperationRequestV1 {
  const correlationId = randomUUID();
  return {
    protocolVersion: 1,
    correlationId,
    issuedAt: new Date().toISOString(),
    nonce: `ca-${randomUUID()}`,
    audience: "worker_run",
    body: {
      organizationId: ORG,
      companyId: COMPANY,
      workerId: WORKER,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      ack: {
        protocolVersion: 1,
        correlationId,
        commandId: randomUUID(),
        commandSeq: 1,
        status: "accepted",
        observedAt: new Date().toISOString(),
        detail: null,
      },
    },
  };
}

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

interface DenialRow {
  action: string;
  actor_type: string;
  actor_id: string;
  company_id: string | null;
  organization_id: string | null;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
}

integration("DE-18 admission/session target_revoked denial audit", () => {
  let fx: JobControlFixture;

  beforeAll(async () => {
    fx = await setupJobControlFixture("de18adm");
  }, 240_000);

  afterAll(async () => {
    await fx?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await fx.resetRuntimeRows();
    await fx.admin`DELETE FROM activity_log WHERE action LIKE ${"security.denied.%"}`;
  });

  async function denialRows(): Promise<DenialRow[]> {
    return await fx.admin<DenialRow[]>`
      SELECT action, actor_type, actor_id, company_id, organization_id,
             entity_type, entity_id, details
      FROM activity_log WHERE action LIKE ${"security.denied.%"}
      ORDER BY created_at ASC`;
  }

  // ---- POLL admission arm (job-leasing.ts:poll) ----------------------------

  it("DE-18 CLAUSE (poll): a superseded target generation is refused target_revoked AND leaves one row keyed to DE-18 naming the generation conjunct", async () => {
    await fx.seedPlacedJob(9101);
    await fx.admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET}`;
    await expect(
      fx.leasing.poll({ auth: auth("de18-p1"), request: pollRequest("de18-p1") }),
    ).rejects.toMatchObject({ code: "target_revoked" });
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("security.denied.worker_poll_authority");
    // ★ A GENERATION conjunct failed → DE-18, and details.failed names it.
    expect(row.details.reason).toBe("poll_generation_superseded");
    expect(row.details.crossing).toBe("DE-18");
    expect(row.details.failed).toContain("target_generation_drift");
    // WHO — the refused worker; TENANT — organization axis only (no lease resolved).
    expect(row.actor_type).toBe("system");
    expect(row.actor_id).toBe(WORKER);
    expect(row.organization_id).toBe(ORG);
    expect(row.company_id).toBeNull();
    // RESOURCE — the superseded target.
    expect(row.entity_type).toBe("execution_target");
    expect(row.entity_id).toBe(TARGET);
    expect(row.details.operation).toBe("lease_poll");
  }, 60_000);

  it("DE-04 discrimination (poll): a NON-generation authority failure (stale heartbeat) writes ONE row keyed to DE-04's worker-authority-currency arm, NOT DE-18", async () => {
    await fx.seedPlacedJob(9105);
    // Age the worker + target liveness past maxHeartbeatAgeMs (default 300s) while
    // leaving every generation conjunct intact, so `authorityCurrent` fails ONLY on
    // the heartbeat freshness check — an authority-currency refusal, not a
    // generation change, so the classifier files it under DE-04 (register
    // amendment 2026-09-13), never DE-18.
    await fx.admin`UPDATE workers SET last_seen_at = clock_timestamp() - interval '1 hour' WHERE id = ${WORKER}`;
    await fx.admin`UPDATE execution_targets SET last_seen_at = clock_timestamp() - interval '1 hour' WHERE id = ${TARGET}`;
    await expect(
      fx.leasing.poll({ auth: auth("de18-p5"), request: pollRequest("de18-p5") }),
    ).rejects.toMatchObject({ code: "target_revoked" });
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("security.denied.worker_poll_authority");
    expect(row.details.reason).toBe("poll_authority_stale");
    expect(row.details.crossing).toBe("DE-04");
    expect(row.details.failed).toEqual(["heartbeat_stale"]);
    expect(row.actor_type).toBe("system");
    expect(row.actor_id).toBe(WORKER);
    expect(row.organization_id).toBe(ORG);
    expect(row.company_id).toBeNull();
    expect(row.entity_type).toBe("execution_target");
    expect(row.entity_id).toBe(TARGET);
  }, 60_000);

  it("poll: a post-authority data-integrity refusal (unparseable stored hello) writes NO row — no applicable crossing", async () => {
    await fx.seedPlacedJob(9102);
    const hash = sha256(JSON.stringify(workerHello()));
    await fx.admin`UPDATE workers SET profile_snapshot = ${"{}"}::jsonb, profile_hash = ${hash} WHERE id = ${WORKER}`;
    await expect(
      fx.leasing.poll({ auth: auth("de18-p2"), request: pollRequest("de18-p2") }),
    ).rejects.toMatchObject({ code: "target_revoked" });
    expect(await denialRows()).toHaveLength(0);
  }, 60_000);

  it("poll: a post-authority data-integrity refusal (unreadable current target) writes NO row — no applicable crossing", async () => {
    await fx.seedPlacedJob(9103);
    await fx.admin`UPDATE execution_targets SET registered_profile = ${"{}"}::jsonb WHERE id = ${TARGET}`;
    await expect(
      fx.leasing.poll({ auth: auth("de18-p3"), request: pollRequest("de18-p3") }),
    ).rejects.toMatchObject({ code: "target_revoked" });
    expect(await denialRows()).toHaveLength(0);
  }, 60_000);

  it("ANTI-VACUITY: a healthy poll (offer or no_work) writes ZERO security.denied rows", async () => {
    await fx.seedPlacedJob(9104);
    const res = await fx.leasing.poll({ auth: auth("de18-p4"), request: pollRequest("de18-p4") });
    expect(["offer", "no_work"]).toContain(res.outcome);
    expect(await denialRows()).toHaveLength(0);
  }, 60_000);

  // ---- ACK admission arm (job-control-ack.ts: the ackAuthorityCurrent recheck) -----
  // The ack path runs the SAME worker-authority-currency recheck as poll — `ackAuthorityCurrent`
  // — BEFORE its guarded mutator, and refuses `target_revoked` when the worker's authority has
  // drifted. That is the "separate, still-unaudited surface tracked as the follow-on" named in
  // de-04-18-fence-denial-audit's header. These arms drive the REAL ack service through it and
  // assert the same DE-18(generation)/DE-04(other) split the poll arm proves, on the shared
  // `worker_poll_authority` surface.

  it("DE-18 CLAUSE (ack): a superseded target generation refuses the control-ACK target_revoked AND leaves one DE-18 worker_poll_authority row naming the generation conjunct", async () => {
    const { offer } = await fx.activateLease(9201);
    await fx.admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET}`;
    await expect(
      createJobControlAckService({ appDb: fx.app.db })
        .ack({ auth: auth("de18-ack1"), request: controlAckRequest(offer) }),
    ).rejects.toMatchObject({ code: "target_revoked" });
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("security.denied.worker_poll_authority");
    // ★ A GENERATION conjunct failed → DE-18, and details.failed names it.
    expect(row.details.reason).toBe("ack_generation_superseded");
    expect(row.details.crossing).toBe("DE-18");
    expect(row.details.failed).toContain("target_generation_drift");
    // WHO — the refused worker; TENANT — organization axis only (no lease context resolved yet).
    expect(row.actor_type).toBe("system");
    expect(row.actor_id).toBe(WORKER);
    expect(row.organization_id).toBe(ORG);
    expect(row.company_id).toBeNull();
    // RESOURCE — the superseded target.
    expect(row.entity_type).toBe("execution_target");
    expect(row.entity_id).toBe(TARGET);
    expect(row.details.operation).toBe("control_command_ack");
  }, 90_000);

  it("DE-04 discrimination (ack): a NON-generation authority failure (stale heartbeat) writes ONE row keyed to DE-04's worker-authority-currency arm, NOT DE-18", async () => {
    const { offer } = await fx.activateLease(9202);
    // Age worker + target liveness past maxHeartbeatAgeMs (default 300s) while leaving every
    // generation conjunct intact, so `ackAuthorityCurrent` fails ONLY on heartbeat freshness.
    await fx.admin`UPDATE workers SET last_seen_at = clock_timestamp() - interval '1 hour' WHERE id = ${WORKER}`;
    await fx.admin`UPDATE execution_targets SET last_seen_at = clock_timestamp() - interval '1 hour' WHERE id = ${TARGET}`;
    await expect(
      createJobControlAckService({ appDb: fx.app.db })
        .ack({ auth: auth("de18-ack2"), request: controlAckRequest(offer) }),
    ).rejects.toMatchObject({ code: "target_revoked" });
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("security.denied.worker_poll_authority");
    expect(row.details.reason).toBe("ack_authority_stale");
    expect(row.details.crossing).toBe("DE-04");
    expect(row.details.failed).toEqual(["heartbeat_stale"]);
    expect(row.actor_type).toBe("system");
    expect(row.actor_id).toBe(WORKER);
    expect(row.organization_id).toBe(ORG);
    expect(row.company_id).toBeNull();
    expect(row.entity_type).toBe("execution_target");
    expect(row.entity_id).toBe(TARGET);
    expect(row.details.operation).toBe("control_command_ack");
  }, 90_000);

  // ---- HEARTBEAT arm (worker-session-auth.ts:registerProofBoundHeartbeat) ----
  // The six boolean-write refusal branches are classified by a per-branch
  // generation RE-READ of the same authority row each write predicates on (the
  // follow-on PR #448 documented), then recorded as
  // `security.denied.worker_session` rows with `details.branch` naming the
  // branch and the crossing derived from `details.failed`.

  const TARGET_PLATFORM = "a6000000-0000-4000-8000-000000000013";
  const WORKER_PLATFORM = "a6000000-0000-4000-8000-000000000015";

  function tenantPrincipal(): VerifiedTargetPrincipal {
    return {
      workerId: WORKER,
      targetId: TARGET,
      targetGeneration: 1,
      deviceThumbprint: THUMBPRINT,
      profileHash: WORKER_PROFILE_HASH,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      organizationId: ORG,
      scope: "organization",
      targetScope: "organization",
    };
  }

  function platformPrincipal(): VerifiedTargetPrincipal {
    return {
      workerId: WORKER_PLATFORM,
      targetId: TARGET_PLATFORM,
      targetGeneration: 1,
      deviceThumbprint: THUMBPRINT,
      profileHash: WORKER_PROFILE_HASH,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      organizationId: null,
      scope: "platform",
      targetScope: "platform",
    };
  }

  async function seedPlatformAuthority(): Promise<void> {
    await fx.admin`DELETE FROM workers WHERE id = ${WORKER_PLATFORM}`;
    await fx.admin`DELETE FROM execution_targets WHERE id = ${TARGET_PLATFORM}`;
    await fx.admin`INSERT INTO execution_targets
      (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
       target_authority_key, device_generation, last_seen_at)
      VALUES (${TARGET_PLATFORM}, NULL, 'de18-hb-platform', 'dedicated_worker', 'dedicated_tenant',
        'active', '{}', '{}', 'platform', 'platform', 1, clock_timestamp())`;
    await fx.admin`INSERT INTO workers
      (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
       device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
       last_seen_at, label, status)
      VALUES (${WORKER_PLATFORM}, 'platform', NULL, ${TARGET_PLATFORM}, 'platform', 'de18-hb-pk',
        ${THUMBPRINT}, 1, ${WORKER_PROFILE_HASH}, '{}', clock_timestamp(),
        clock_timestamp(), 'DE-18 heartbeat platform worker', 'enrolled')`;
  }

  it("ANTI-VACUITY (heartbeat): a healthy tenant heartbeat succeeds and writes ZERO security.denied rows", async () => {
    await expect(registerProofBoundHeartbeat({
      appDb: fx.app.db, principal: tenantPrincipal(), status: "active",
    })).resolves.toBe(true);
    expect(await denialRows()).toHaveLength(0);
  }, 60_000);

  it("DE-18 CLAUSE (heartbeat, tenant_target): a superseded target generation refuses AND leaves one DE-18 row naming branch + conjunct", async () => {
    await fx.admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET}`;
    await expect(registerProofBoundHeartbeat({
      appDb: fx.app.db, principal: tenantPrincipal(), status: "active",
    })).resolves.toBe(false);
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("security.denied.worker_session");
    expect(row.details.reason).toBe("heartbeat_authority_revoked");
    expect(row.details.crossing).toBe("DE-18");
    expect(row.details.branch).toBe("tenant_target");
    expect(row.details.failed).toEqual(["generation_drift"]);
    expect(row.actor_type).toBe("system");
    expect(row.actor_id).toBe(WORKER);
    expect(row.organization_id).toBe(ORG);
    expect(row.company_id).toBeNull();
    expect(row.entity_type).toBe("execution_target");
    expect(row.entity_id).toBe(TARGET);
  }, 60_000);

  it("DE-04 discrimination (heartbeat, tenant_target): a DISABLED target refuses AND files under DE-04, not DE-18", async () => {
    await fx.admin`UPDATE execution_targets SET status = 'disabled' WHERE id = ${TARGET}`;
    await expect(registerProofBoundHeartbeat({
      appDb: fx.app.db, principal: tenantPrincipal(), status: "active",
    })).resolves.toBe(false);
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("security.denied.worker_session");
    expect(rows[0]!.details.reason).toBe("heartbeat_authority_revoked");
    expect(rows[0]!.details.crossing).toBe("DE-04");
    expect(rows[0]!.details.branch).toBe("tenant_target");
    expect(rows[0]!.details.failed).toEqual(["target_disabled"]);
  }, 60_000);

  it("DE-04 (heartbeat, tenant_profile): a REVOKED worker refuses target_revoked (the one throwing branch) AND files under DE-04", async () => {
    await fx.admin`UPDATE workers SET status = 'revoked' WHERE id = ${WORKER}`;
    await expect(registerProofBoundHeartbeat({
      appDb: fx.app.db, principal: tenantPrincipal(), status: "active",
    })).rejects.toMatchObject({ code: "target_revoked" });
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details.reason).toBe("heartbeat_authority_revoked");
    expect(rows[0]!.details.crossing).toBe("DE-04");
    expect(rows[0]!.details.branch).toBe("tenant_profile");
    expect(rows[0]!.details.failed).toEqual(["worker_revoked"]);
  }, 60_000);

  it("DE-18 (heartbeat, platform_liveness): a superseded PLATFORM generation refuses AND leaves one DOUBLY-NULL DE-18 row", async () => {
    await seedPlatformAuthority();
    await fx.admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET_PLATFORM}`;
    await expect(registerProofBoundHeartbeat({
      appDb: fx.app.db, operatorDb: fx.operator.db, principal: platformPrincipal(), status: "active",
    })).resolves.toBe(false);
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("security.denied.worker_session");
    expect(row.details.reason).toBe("heartbeat_authority_revoked");
    expect(row.details.crossing).toBe("DE-18");
    expect(row.details.branch).toBe("platform_liveness");
    expect(row.details.failed).toEqual(["generation_drift"]);
    // A platform-scope refusal is the doubly-null row the E0-F013 (a2) CHECK admits.
    expect(row.organization_id).toBeNull();
    expect(row.company_id).toBeNull();
    expect(row.actor_id).toBe(WORKER_PLATFORM);
    expect(row.entity_id).toBe(TARGET_PLATFORM);
  }, 60_000);

  it("DE-04 (heartbeat, platform_status_transition): an INACTIVE platform target refuses a draining transition under DE-04", async () => {
    await seedPlatformAuthority();
    await fx.admin`UPDATE execution_targets SET status = 'disabled' WHERE id = ${TARGET_PLATFORM}`;
    await expect(registerProofBoundHeartbeat({
      appDb: fx.app.db, operatorDb: fx.operator.db, principal: platformPrincipal(), status: "draining",
    })).resolves.toBe(false);
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details.reason).toBe("heartbeat_authority_revoked");
    expect(rows[0]!.details.crossing).toBe("DE-04");
    expect(rows[0]!.details.branch).toBe("platform_status_transition");
    expect(rows[0]!.details.failed).toEqual(["target_inactive"]);
  }, 60_000);

  it("DE-18 (heartbeat, shared_platform): a superseded platform generation refuses a TENANT logical heartbeat under DE-18, org-attributed", async () => {
    await seedPlatformAuthority();
    await fx.admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET_PLATFORM}`;
    const principal: VerifiedTargetPrincipal = {
      ...tenantPrincipal(),
      targetId: TARGET_PLATFORM,
      targetScope: "platform",
      sharedPlatformAuthority: {
        physicalWorkerId: WORKER_PLATFORM,
        physicalProfileHash: WORKER_PROFILE_HASH,
        devicePublicKey: "de18-hb-pk",
      },
    };
    await expect(registerProofBoundHeartbeat({
      appDb: fx.app.db, operatorDb: fx.operator.db, principal, status: "active",
    })).resolves.toBe(false);
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details.reason).toBe("heartbeat_authority_revoked");
    expect(rows[0]!.details.crossing).toBe("DE-18");
    expect(rows[0]!.details.branch).toBe("shared_platform");
    expect(rows[0]!.details.failed).toEqual(["generation_drift"]);
    expect(rows[0]!.organization_id).toBe(ORG);
  }, 60_000);
});
