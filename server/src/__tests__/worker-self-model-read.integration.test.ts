// WRK-008 slice 1 — `loadWorkerSelfModel` against embedded PostgreSQL.
//
// The unit suite covers the admission DECISION. What it cannot cover is the part that
// crosses a storage boundary, and that is where the real risk lives:
//
//   1. A provider-constraint profile must still BRAND after a live JSONB round trip.
//      `verifyAndBrandProviderConstraintProfileV1` recomputes the digest over every
//      field except `digest` itself, so if storage alters any field or value the
//      worker refuses its own self-model. (Key ORDER is irrelevant — canonicalizeJsonV1
//      sorts — which is precisely why this test asserts the brand rather than ordering.)
//   2. `selfModelHash` must compose BOTH halves, so a constraint-profile change written
//      independently of the registered profile cannot slip past a conditional fetch.
//   3. `revokedAt` must be read from INSIDE the registered profile, not from a column.
//
// Linux CI runs this; Windows needs AOA_RUN_WIN_INTEGRATION=1 or it silently skips.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres, { type Sql } from "postgres";
import { applyPendingMigrations, createTenantAppDbConnection, type NonOwnerDbConnection } from "@armyofagents/db";
import {
  canonicalProviderConstraintProfileDigestInputV1,
  canonicalizeJsonV1,
  verifyAndBrandProviderConstraintProfileV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { loadWorkerSelfModel } from "../services/execution-targets.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "b8000000-0000-4000-8000-000000000001";
const TARGET = "b8000000-0000-4000-8000-000000000003";
const REVOKED_TARGET = "b8000000-0000-4000-8000-000000000004";
const PASSWORD = "wrk-008-role-password";
const AUTHORITY_KEY = `organization:${ORG}`;

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "wrk-008-provider",
    version: 1,
    maxContinuousRuntimeSeconds: 3_600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2_000, memoryMiB: 4_096, pids: 512, diskMiB: 8_192 },
    maxConcurrentOperations: 2,
    supportedOperations: ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup"],
    localityTags: ["organization_target_only"],
    checkpointMode: "none",
    healthMode: "none",
  } as const;
  return { ...unsigned, digest: sha256(canonicalProviderConstraintProfileDigestInputV1(unsigned)) };
}

function registeredProfile(provider: ProviderConstraintProfileV1, over: { revokedAt?: string | null } = {}): RegisteredTargetProfileV1 {
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
    providerConstraints: { profileId: provider.profileId, version: provider.version, digest: provider.digest },
    capabilityCeiling: ["workload.batch", "sandbox.process_isolated"],
    deviceGeneration: 4,
    revokedAt: over.revokedAt ?? null,
    policyHash: "3".repeat(64),
  } as RegisteredTargetProfileV1;
}

integration("WRK-008 slice 1 — loadWorkerSelfModel over embedded PostgreSQL", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  const provider = providerProfile();
  const profile = registeredProfile(provider);
  const profileHash = sha256(canonicalizeJsonV1(profile));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-wrk008-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    const port = await allocateEmbeddedPgPort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"), user: "test", password: "test", port,
      persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(adminUrl);
    admin = postgres(adminUrl, { max: 4 });
    await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
    // The OWNER connection, deliberately - it is what the route actually passes.
    // `executionTargetRoutes({ db })` receives the main app db, and the
    // `execution_targets_tenant_serving` RLS policy is granted TO the `aoa_app` serving
    // role, not to this one. Tenancy on this path is enforced by the authenticated
    // PRINCIPAL (the target id comes from the worker session, never from the request),
    // which is the same pattern `resolveWorkerHeartbeatAuthority` already uses on the
    // sibling heartbeat route. Testing through `aoa_app` without a tenant GUC would
    // exercise a handle production never uses and report a false null.
    app = createTenantAppDbConnection(adminUrl, { max: 8 });

    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'WRK-008 org', 'wrk-008-org')`;
    await admin`INSERT INTO execution_targets
      (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
       target_authority_key, device_generation, registered_profile, registered_profile_hash,
       provider_constraint_profile, last_seen_at)
      VALUES (${TARGET}, ${ORG}, 'wrk-008-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
        'organization', ${AUTHORITY_KEY}, 4, ${profile}, ${profileHash}, ${provider}, clock_timestamp())`;
    // A second target whose PROFILE carries revokedAt — proving the field is read from
    // inside the profile rather than from any column.
    const revoked = registeredProfile(provider, { revokedAt: "2026-08-01T00:00:00.000Z" });
    await admin`INSERT INTO execution_targets
      (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
       target_authority_key, device_generation, registered_profile, registered_profile_hash,
       provider_constraint_profile, last_seen_at)
      VALUES (${REVOKED_TARGET}, ${ORG}, 'wrk-008-revoked', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
        'organization', ${AUTHORITY_KEY}, 4, ${revoked}, ${sha256(canonicalizeJsonV1(revoked))}, ${provider}, clock_timestamp())`;
  }, 180_000);

  afterAll(async () => {
    await app?.close({ timeoutSeconds: 5 });
    await admin?.end({ timeout: 5 });
    await embedded?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, 60_000);

  it("★ the constraint profile still BRANDS after a live JSONB round trip", async () => {
    // The invariant that actually matters. If storage altered any field or value, the
    // worker's own verification would reject the self-model it was just handed.
    const selfModel = await loadWorkerSelfModel(app!.db, TARGET);
    const branded = await verifyAndBrandProviderConstraintProfileV1(
      selfModel!.providerConstraintProfile,
      (bytes) => sha256(bytes),
    );
    expect(branded).not.toBeNull();
  });

  it("brands only because the payload is intact — a mutated field fails the same check", async () => {
    // Anti-vacuity: proves the assertion above can fail. Without this, "it branded"
    // might just mean the verifier is permissive.
    const selfModel = await loadWorkerSelfModel(app!.db, TARGET);
    const tampered = { ...selfModel!.providerConstraintProfile, maxIdleSeconds: 999 };
    expect(await verifyAndBrandProviderConstraintProfileV1(tampered, (bytes) => sha256(bytes))).toBeNull();
  });

  it("composes selfModelHash from BOTH halves", async () => {
    const selfModel = await loadWorkerSelfModel(app!.db, TARGET);
    expect(selfModel!.selfModelHash).toBe(sha256(`${profileHash}:${provider.digest}`));
  });

  it("reads revokedAt from inside the registered profile, not from a column", async () => {
    expect((await loadWorkerSelfModel(app!.db, TARGET))!.revokedAt).toBeNull();
    expect((await loadWorkerSelfModel(app!.db, REVOKED_TARGET))!.revokedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("returns the stored generation and status", async () => {
    const selfModel = await loadWorkerSelfModel(app!.db, TARGET);
    expect(selfModel!.deviceGeneration).toBe(4);
    expect(selfModel!.targetStatus).toBe("active");
  });

  it("returns null for a target that does not exist", async () => {
    expect(await loadWorkerSelfModel(app!.db, "b8000000-0000-4000-8000-0000000000ff")).toBeNull();
  });
});
