// DEP-011 reaper Slice B (B1) — the control-plane READ-ONLY lease-truth classifier,
// end-to-end on embedded PostgreSQL under forced RLS.
//
// Seeds leases / attempts / targets in each state (terminal-lease / terminal-attempt /
// superseded-gen / disabled-target / live / absent) in ONE tenant and asserts
// `classifyLeaseTruth`'s per-leaseId verdict. Also DUAL-ASSERTS the frozen wire fixture
// `tests/fixtures/reaper-lease-truth/v1` (the same fixture the AM client B2 asserts), so
// a field/enum divergence reds here rather than first at Slice-5 live wiring.
//
// Mirrors job-leasing.integration.test.ts's embedded-PG harness. Windows-skipped unless
// AOA_RUN_WIN_INTEGRATION=1 (Linux CI is the authority).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import {
  applyPendingMigrations,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { runInTenantReadOnly } from "../db/tenant-context.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const PASSWORD = "dep-011-b1-role-password";
const HEX64 = "a".repeat(64);

// The frozen fixture identifiers (dual-asserted with the AM client B2).
const ORG = "b0000000-0000-4000-8000-000000000001";
const COMPANY = "b0000000-0000-4000-8000-000000000002";
const LEASE_TERMINAL = "b1000000-0000-4000-8000-000000000001";
const LEASE_LIVE = "b1000000-0000-4000-8000-000000000002";
const LEASE_SUPERSEDED = "b1000000-0000-4000-8000-000000000003";
const LEASE_ABSENT = "b1000000-0000-4000-8000-000000000004";
// Extra discriminating states, beyond the fixture, to prove each independent OR-arm.
const LEASE_TERMINAL_ATTEMPT = "b1000000-0000-4000-8000-000000000005";
const LEASE_DISABLED_TARGET = "b1000000-0000-4000-8000-000000000006";

const TARGET_LIVE = "b2000000-0000-4000-8000-000000000001"; // active, gen 1
const TARGET_SUPERSEDED = "b2000000-0000-4000-8000-000000000002"; // active, gen 2 (moved past)
const TARGET_DISABLED = "b2000000-0000-4000-8000-000000000003"; // disabled, gen 1
const WORKER = "b3000000-0000-4000-8000-000000000001";
const AUTHORITY_KEY = `organization:${ORG}`;

function fixturePath(name: string): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return join(here, "..", "..", "..", "tests", "fixtures", "reaper-lease-truth", "v1", name);
}

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

integration("DEP-011 B1 — classifyLeaseTruth over embedded PostgreSQL", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;

  function guard() {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!admin || !app) throw new Error("test setup incomplete");
    return { admin, app };
  }

  async function seedTarget(id: string, deviceGeneration: number, status: string): Promise<void> {
    const { admin } = guard();
    await admin`INSERT INTO execution_targets
      (id, organization_id, scope, target_authority_key, device_generation, slug, kind,
       trust_class, status, capabilities, config)
      VALUES (${id}, ${ORG}, 'organization', ${AUTHORITY_KEY}, ${deviceGeneration},
        ${`slug-${id}`}, 'dedicated_worker', 'dedicated_tenant', ${status}, '{}', '{}')`;
  }

  async function seedLease(input: {
    leaseId: string;
    ordinal: number;
    targetId: string;
    leaseTargetGeneration: number;
    leaseStatus: string;
    attemptStatus: string;
  }): Promise<void> {
    const { admin } = guard();
    const suffix = input.ordinal.toString().padStart(12, "0");
    const jobId = `b5000000-0000-4000-8000-${suffix}`;
    const attemptId = `b6000000-0000-4000-8000-${suffix}`;
    await admin`INSERT INTO jobs
      (id, organization_id, company_id, workload_type, source_kind, source_identity, source_intent,
       requester_principal_kind, requester_principal_id, executor_principal_kind, executor_principal_id,
       input, input_hash, policy_snapshot, policy_hash, requirements, placement_request,
       available_at, priority, status)
      VALUES (${jobId}, ${ORG}, ${COMPANY}, 'batch', 'one_shot', ${jobId},
        ${{ kind: "one_shot", operationId: jobId, operationKind: "extraction" }},
        'system', 'dep-011-b1', 'worker', ${WORKER},
        ${{ command: "codex", args: [], stdinArtifactId: null, maxRuntimeSeconds: 600 }},
        ${HEX64}, ${{ policyId: "default", version: 1 }}, ${HEX64},
        ${{ workloadType: "batch", requiredCapabilities: [] }},
        ${{ policyId: "default", policyVersion: 1, requestedTarget: input.targetId }},
        clock_timestamp(), 50, 'queued')`;
    await admin`INSERT INTO job_attempts
      (id, organization_id, company_id, job_id, attempt_number, status)
      VALUES (${attemptId}, ${ORG}, ${COMPANY}, ${jobId}, 1, ${input.attemptStatus})`;
    // Rich lease — the authority-atomic check requires the complete tuple. `active`
    // needs activated_at (the activation check); every state needs ack_deadline < expires_at.
    const activatedAt = input.leaseStatus === "active" ? new Date() : null;
    await admin`INSERT INTO leases
      (id, organization_id, attempt_id, company_id, job_id, attempt_number, worker_id, target_id,
       target_authority_key, target_generation, profile_hash, provider_constraint_hash, status,
       fence, ack_deadline, expires_at, activated_at)
      VALUES (${input.leaseId}, ${ORG}, ${attemptId}, ${COMPANY}, ${jobId}, 1, ${WORKER},
        ${input.targetId}, ${AUTHORITY_KEY}, ${input.leaseTargetGeneration}, ${HEX64}, ${HEX64},
        ${input.leaseStatus}, ${`fence-${input.leaseId}`},
        clock_timestamp(), clock_timestamp() + interval '1 hour', ${activatedAt})`;
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-dep011-b1-"));
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

      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DEP-011 B1 org', 'dep-011-b1-org')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'DEP-011 B1 company', 'D11B')`;

      // Targets FIRST — workers.(target_authority_key, execution_target_id) and
      // leases.(target_authority_key, target_id) both FK into execution_targets.
      await seedTarget(TARGET_LIVE, 1, "active");
      await seedTarget(TARGET_SUPERSEDED, 2, "active");
      await seedTarget(TARGET_DISABLED, 1, "disabled");

      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET_LIVE}, ${AUTHORITY_KEY}, 'dep-011-b1-key',
          ${HEX64}, 1, ${HEX64}, '{}', clock_timestamp(), clock_timestamp(), 'DEP-011 B1 worker', 'enrolled')`;

      await seedLease({ leaseId: LEASE_TERMINAL, ordinal: 1, targetId: TARGET_LIVE, leaseTargetGeneration: 1, leaseStatus: "released", attemptStatus: "running" });
      await seedLease({ leaseId: LEASE_LIVE, ordinal: 2, targetId: TARGET_LIVE, leaseTargetGeneration: 1, leaseStatus: "active", attemptStatus: "running" });
      await seedLease({ leaseId: LEASE_SUPERSEDED, ordinal: 3, targetId: TARGET_SUPERSEDED, leaseTargetGeneration: 1, leaseStatus: "active", attemptStatus: "running" });
      await seedLease({ leaseId: LEASE_TERMINAL_ATTEMPT, ordinal: 5, targetId: TARGET_LIVE, leaseTargetGeneration: 1, leaseStatus: "active", attemptStatus: "succeeded" });
      await seedLease({ leaseId: LEASE_DISABLED_TARGET, ordinal: 6, targetId: TARGET_DISABLED, leaseTargetGeneration: 1, leaseStatus: "active", attemptStatus: "running" });
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

  async function classify(leaseIds: string[]): Promise<Map<string, string>> {
    const { app } = guard();
    // `app.db` is the drizzle Db (the NonOwnerDbConnection wraps it); runInTenantReadOnly
    // opens the read-only tenant tx on it.
    return runInTenantReadOnly(app.db, ORG, (repos) => repos.jobControl.classifyLeaseTruth(leaseIds));
  }

  it("classifies each lease state and reports absent for an unknown leaseId", async () => {
    const verdicts = await classify([
      LEASE_TERMINAL,
      LEASE_LIVE,
      LEASE_SUPERSEDED,
      LEASE_ABSENT,
      LEASE_TERMINAL_ATTEMPT,
      LEASE_DISABLED_TARGET,
    ]);
    expect(verdicts.get(LEASE_TERMINAL)).toBe("terminal"); // lease.status='released'
    expect(verdicts.get(LEASE_LIVE)).toBe("live");
    expect(verdicts.get(LEASE_SUPERSEDED)).toBe("superseded"); // target gen 2 > lease gen 1
    expect(verdicts.get(LEASE_ABSENT)).toBe("absent"); // never seeded
    expect(verdicts.get(LEASE_TERMINAL_ATTEMPT)).toBe("terminal"); // attempt.status='succeeded'
    expect(verdicts.get(LEASE_DISABLED_TARGET)).toBe("superseded"); // target status='disabled'
  });

  it("returns a verdict for EVERY requested id — a missing id is always absent, never dropped", async () => {
    const verdicts = await classify([LEASE_ABSENT, LEASE_LIVE]);
    expect([...verdicts.keys()].sort()).toEqual([LEASE_ABSENT, LEASE_LIVE].sort());
    expect(verdicts.get(LEASE_ABSENT)).toBe("absent");
  });

  it("an empty request yields an empty verdict map (no query)", async () => {
    const verdicts = await classify([]);
    expect(verdicts.size).toBe(0);
  });

  it("matches the frozen wire fixture (dual-asserted with the AM client B2)", async () => {
    const request = JSON.parse(readFileSync(fixturePath("request.json"), "utf8")) as {
      orgs: { organizationId: string; leases: { leaseId: string }[] }[];
    };
    const response = JSON.parse(readFileSync(fixturePath("response.json"), "utf8")) as {
      verdicts: Record<string, string>;
    };
    // The fixture is single-org (B1 seeds one tenant); assert exactly its shape.
    expect(request.orgs).toHaveLength(1);
    expect(request.orgs[0]!.organizationId).toBe(ORG);
    const leaseIds = request.orgs[0]!.leases.map((l) => l.leaseId);
    const verdicts = await classify(leaseIds);
    const actual = Object.fromEntries(verdicts);
    expect(actual).toEqual(response.verdicts);
  });
});
