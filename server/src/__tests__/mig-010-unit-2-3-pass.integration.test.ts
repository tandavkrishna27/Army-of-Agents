// MIG-010 Unit 2.3 — E10-F002's MECHANISM, reproduced on the real serving role.
//
// The filed headline is a caller count. Its mechanism is narrower and worse: even WITH a
// caller, the pass raises 42501 on its very first read. `OPERATOR_SERVING_RELATIONS`
// (job-control-legacy-grants.ts:319-321) grants `aoa_operator` exactly one crosswalk
// relation — `legacy_resource_reconciliation` — and NOTHING on `environment_leases`,
// `environments`, `runtime_provider_keys` or `company_secret_versions`. So wiring a caller
// to `operatorDb` as the store stood would have produced a permission error, not a pass.
//
// ★ This file asserts TODAY'S broken behaviour on purpose. Unit 2.3 INVERTS it in place
// (Task 7 Step 3) rather than deleting it — a deleted test subtracts a failure instead of
// proving a fix (DSK-003).
//
// Windows-skipped unless AOA_RUN_WIN_INTEGRATION=1 (Issue #114); Linux CI is the authority.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Sql } from "postgres";
import type { Db } from "@armyofagents/db";
import { createCanaryPreflight } from "../services/canary-preflight.js";
import { createDrizzleCanaryPreflightStore } from "../services/canary-preflight-store.js";
import {
  buildLeaseRecord,
  classifyLease,
  reconcileOrganizationLegacyResources,
} from "../services/legacy-resource-reconciliation.js";
import { createDrizzleReconciliationStore } from "../services/legacy-resource-reconciliation-store.js";
import { startMigratedDatabase } from "./helpers/migrated-database.js";

const execFileAsync = promisify(execFile);

// The operator entrypoint is driven as a REAL SUBPROCESS, because that is the only shape in
// which its `current_user` gate means anything: a CLI takes a DATABASE_URL, not a `Db`, and
// the gate's whole job is to discriminate between two connection URLs. Resolved from this
// file so it does not depend on the working directory vitest happens to run in.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CLI = fileURLToPath(new URL("../cli/reconcile-legacy-resources.ts", import.meta.url));
// `tsx` is invoked through its own JS entrypoint under `process.execPath` rather than via a
// `.cmd` shim: `execFile` does not use a shell, and the shim is not directly executable on
// Windows. Resolved, not guessed — a wrong path would fail as ENOENT and read like a broken
// CLI rather than a broken test.
const NPX = createRequire(import.meta.url).resolve("tsx/cli");

const ORG = "e3000000-0000-4000-8000-000000000001";
const COMPANY = "e3000000-0000-4000-8000-000000000002";
const ENV = "e3000000-0000-4000-8000-000000000003";
const LEASE_1 = "e3000000-0000-4000-8000-000000000004";
const SECRET = "e3000000-0000-4000-8000-000000000006";

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

type Fixture = {
  operatorDb: Db;
  admin: Sql;
  adminUrl: string;
  operatorUrl: string;
  teardown: () => Promise<void>;
};
let fixture: Fixture | null = null;

describe.skipIf(!RUN)("MIG-010 Unit 2.3 — the reconciliation pass, made runnable", () => {
  beforeAll(async () => {
    const database = await startMigratedDatabase({ label: "aoa-mig-010-u23-" });
    const { admin, operatorDb, adminUrl, operatorUrl, teardown } = database;
    try {
      await admin`INSERT INTO organizations (id, name, slug)
        VALUES (${ORG}, 'MIG-010 u2.3 org', 'mig-010-u23-org')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'MIG-010 u2.3 company', 'M23')`;

      // ★ The key generation. Without it `canary-preflight.ts:150-156` refuses with
      // `credential_authority_not_moved` BEFORE the closure check, and every gate assertion
      // in this file would pass while proving nothing. The pass reads the same generation
      // through the same `0267` scalars function, so this seeding is load-bearing twice.
      await admin`INSERT INTO company_secrets (id, company_id, name, latest_version)
        VALUES (${SECRET}, ${COMPANY}, 'e2b-key', 1)`;
      await admin`INSERT INTO company_secret_versions
        (secret_id, version, material, status, value_sha256)
        VALUES (${SECRET}, 1, '{}'::jsonb, 'current', 'sha-not-a-real-digest')`;
      await admin`INSERT INTO runtime_provider_keys
        (company_id, provider, display_name, secret_id, is_default)
        VALUES (${COMPANY}, 'e2b', 'MIG-010 u2.3 e2b key', ${SECRET}, TRUE)`;

      // Exactly ONE lease, and NO platform-default environments row, so the inventory is a
      // single key. `provider_lease_id` is set so classifyLease sees a live handle — the
      // record is `mapped`, left for drain, and carries an attribution hash.
      await admin`INSERT INTO environments (id, company_id, name, driver, status)
        VALUES (${ENV}, ${COMPANY}, 'mig-010-u23-env', 'sandbox', 'active')`;
      await admin`INSERT INTO environment_leases
        (id, company_id, environment_id, status, lease_policy, provider, provider_lease_id)
        VALUES (${LEASE_1}, ${COMPANY}, ${ENV}, 'active', 'ephemeral', 'e2b', 'sbx-u23-1')`;
    } catch (error) {
      await teardown();
      throw error;
    }
    fixture = { operatorDb, admin, adminUrl, operatorUrl, teardown };
  }, 180_000);

  afterAll(async () => {
    await fixture?.teardown();
    fixture = null;
    // 60s to match the Unit 2.2 repro: on the default hook timeout a slow embedded-postgres
    // teardown fails THIS file, which reads as a defect in the code under test rather than
    // as the shutdown being slow.
  }, 60_000);

  // ★ INVERTED IN PLACE, NOT DELETED (DSK-003). Until Task 7 this asserted the DENIAL:
  //
  //     await expect(store.listLeases(ORG, COMPANY)).rejects.toMatchObject({
  //       cause: { code: "42501", message: "permission denied for table environment_leases" },
  //     });
  //
  // and it passed, because `aoa_operator` holds no grant on `environment_leases`. Pointing
  // the store at the `0268` SECURITY DEFINER function flipped it: the run before this edit
  // failed with "promise resolved [ { …(13) } ] instead of rejecting". That transition — a
  // reproduction going green for the stated reason — is the evidence this unit turns on, and
  // deleting the test would have subtracted a failure instead of proving a fix.
  it("[E10-F002] the pass CAN now read, through owner authority, as aoa_operator", async () => {
    const store = createDrizzleReconciliationStore(fixture!.operatorDb);
    const leases = await store.listLeases(ORG, COMPANY);

    expect(leases).toHaveLength(1);
    // Field by field, by NAME. The definer function returns eleven named columns and the
    // evidence module assigns each from its own key; a positional swap between two `uuid`
    // columns, or two `text` ones, is invisible to the type system. `environmentId` /
    // `companyId` and `status` / `leasePolicy` / `provider` are exactly those adjacent pairs.
    expect(leases[0]).toMatchObject({
      id: LEASE_1,
      companyId: COMPANY,
      environmentId: ENV,
      status: "active",
      leasePolicy: "ephemeral",
      provider: "e2b",
      providerLeaseId: "sbx-u23-1",
      agentId: null,
      commanderConversationId: null,
      executionWorkspaceId: null,
      cleanupStatus: null,
    });
  });

  it("the definer projection EXCLUDES the secret-bearing columns", async () => {
    // The return type is the security boundary, so assert it holds rather than trusting the
    // migration comment. `metadata` is secret-bearing at rest and `failure_reason` is
    // unbounded operator text; neither may cross into the pass.
    const store = createDrizzleReconciliationStore(fixture!.operatorDb);
    const [lease] = await store.listLeases(ORG, COMPANY);
    expect(lease).toBeDefined();
    expect(lease).not.toHaveProperty("metadata");
    expect(lease).not.toHaveProperty("failureReason");
    expect(lease).not.toHaveProperty("failure_reason");
  });

  it("the ORG predicate is real: a foreign organization id yields nothing", async () => {
    // `p_organization_id` is defence in depth rather than the boundary — the GRANT is the
    // boundary — but a predicate that does not discriminate is worth nothing at all, and a
    // dropped EXISTS clause would be invisible to every other assertion here.
    const store = createDrizzleReconciliationStore(fixture!.operatorDb);
    const foreignOrg = "e3000000-0000-4000-8000-0000000000ff";
    expect(await store.listLeases(foreignOrg, COMPANY)).toEqual([]);
  });

  // --- THE POISON-ROW TEST -----------------------------------------------------
  //
  // ★ THE CASES BELOW SHARE ONE FIXTURE AND RUN IN ORDER, deliberately — the same shape the
  // Unit 2.2 repro uses. The first runs the pass and asserts `insertedKeys === [LEASE_1]`;
  // the second asserts a SECOND pass inserts nothing; the CLI case then asserts `inserted=0`
  // because the rows already exist. That sequence is the point (a first write, then
  // idempotence), so these are not independently runnable with `-t` and are not meant to be.
  //
  // ★ This is the first point at which the pass writes REAL rows, and
  // `legacy_resource_reconciliation` is APPEND-ONLY WITH NO CLEAR PATH: the operator holds
  // SELECT/INSERT/UPDATE and no DELETE, and no application code updates it. A column-mapping
  // bug therefore writes rows the gate can never clear — permanent, on disk, per company.
  //
  // A positional mis-map between two `uuid` columns (company_id / environment_lease_id /
  // environment_id) or two `text` ones (resource_type / legacy_status / provider /
  // provider_lease_id / disposition / key_generation / reason) is invisible to the type
  // system: every one of them is the same TypeScript type. So this asserts FIELD BY FIELD
  // against what `buildLeaseRecord` produces for this exact lease, rather than counting rows
  // or spot-checking one column.

  it("[E10-F002] a real pass writes the crosswalk row FIELD BY FIELD", async () => {
    const store = createDrizzleReconciliationStore(fixture!.operatorDb);
    const result = await reconcileOrganizationLegacyResources(ORG, { store });

    expect(result.ok).toBe(true);
    expect(result.companies.map((c) => c.companyId)).toEqual([COMPANY]);
    expect(result.insertedKeys).toEqual([LEASE_1]);

    // The independently-derived expectation: what the pure builder produces for this lease,
    // at the key generation the gate reads. Deriving it rather than restating it by hand is
    // the point — a hand-written copy can drift from `buildLeaseRecord` silently, which is
    // exactly what the Unit 2.2 positive control had to disclaim about itself.
    const lease = (await store.listLeases(ORG, COMPANY))[0]!;
    const expected = buildLeaseRecord(lease, classifyLease(lease), {
      keyGeneration: `${SECRET}:1`,
    });

    const rows = await fixture!.admin`
      SELECT company_id, environment_lease_id, environment_id, resource_key, resource_type,
             legacy_status, provider, provider_lease_id, disposition, resource_labels_hash,
             key_generation, cleanup_outcome, reason
      FROM legacy_resource_reconciliation WHERE company_id = ${COMPANY}`;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row.company_id).toBe(expected.companyId);
    expect(row.environment_lease_id).toBe(expected.environmentLeaseId);
    expect(row.environment_id).toBe(expected.environmentId);
    expect(row.resource_key).toBe(expected.resourceKey);
    expect(row.resource_type).toBe(expected.resourceType);
    expect(row.legacy_status).toBe(expected.legacyStatus);
    expect(row.provider).toBe(expected.provider);
    expect(row.provider_lease_id).toBe(expected.providerLeaseId);
    expect(row.disposition).toBe(expected.disposition);
    expect(row.key_generation).toBe(expected.keyGeneration);
    expect(row.cleanup_outcome).toBe(expected.cleanupOutcome);
    expect(row.reason).toBe(expected.reason);

    // ★ AND THE VALUES ARE NOT INTERCHANGEABLE, so the field-by-field comparison above is
    // not satisfiable by a swap. Pin the discriminating ones concretely too: `company_id`
    // and `environment_id` are distinct uuids, and `resource_key` is the LEASE id (a third
    // distinct uuid), so a two-way swap among them would fail here.
    expect(row.company_id).toBe(COMPANY);
    expect(row.environment_id).toBe(ENV);
    expect(row.environment_lease_id).toBe(LEASE_1);
    expect(row.resource_key).toBe(LEASE_1);
    expect(row.resource_type).toBe("ephemeral");
    expect(row.legacy_status).toBe("active");
    expect(row.disposition).toBe("mapped");
    expect(row.key_generation).toBe(`${SECRET}:1`);
    // Non-null for a `mapped` record, and it is the attribution HASH — never a fence.
    expect(row.resource_labels_hash).toBe(expected.resourceLabelsHash);
    expect(row.resource_labels_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a second pass is a NO-OP: same row count, same values (append-only)", async () => {
    const before = await fixture!.admin`
      SELECT id, resource_key, disposition, reason, key_generation, created_at
      FROM legacy_resource_reconciliation WHERE company_id = ${COMPANY} ORDER BY resource_key`;

    const store = createDrizzleReconciliationStore(fixture!.operatorDb);
    const result = await reconcileOrganizationLegacyResources(ORG, { store });
    // Still closed, but nothing NEW was inserted — that is what idempotent means here.
    expect(result.ok).toBe(true);
    expect(result.insertedKeys).toEqual([]);

    const after = await fixture!.admin`
      SELECT id, resource_key, disposition, reason, key_generation, created_at
      FROM legacy_resource_reconciliation WHERE company_id = ${COMPANY} ORDER BY resource_key`;
    // Row identity included: `id` and `created_at` unchanged proves the row was not deleted
    // and rewritten, which a count-only assertion would not distinguish.
    expect(after).toEqual(before);
  });

  it("[E10-F002 INVERTED] the gate now CLOSES for the fixture the 2.2 repro left unmapped", async () => {
    // ★ THE INVERSION OF THE UNIT 2.2 REPRO, not a deletion of it. That file asserts
    // `(unmapped=1, duplicates=0, unattributable=0)` for exactly this seed shape — one active
    // lease, no platform-default env row, an empty crosswalk. A real pass has now run against
    // the same shape, so the same gate answers ok.
    const preflight = createCanaryPreflight({
      store: createDrizzleCanaryPreflightStore(fixture!.operatorDb),
    });
    const result = await preflight.check({ organizationId: ORG });

    // ★ If this refuses, read the reason before touching anything else: a `key_generation`
    // mismatch refuses as `credential_authority_not_moved`, which would be a SEEDING bug, not
    // a closure result — and would mean the pass and the gate derive the generation
    // differently, which is the drift `currentKeyGeneration` was re-pointed to prevent.
    if (!result.ok) {
      // Diagnostic first: the reason discriminates a SEEDING bug from a real refusal, and
      // MIG-010 Unit 2.4b added three more reasons this can now be.
      throw new Error(`gate refused ${result.reason}: ${result.detail}`);
    }
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.companyIds).toEqual([COMPANY]);
  });

  // --- THE OPERATOR ENTRYPOINT, END TO END -------------------------------------

  it("★ the CLI REFUSES an owner DATABASE_URL — the role gate is not decorative", async () => {
    // Without this gate the entire SECURITY DEFINER design is ornamental: the owner satisfies
    // every definer function's authority directly and bypasses every EXECUTE grant, so a run
    // with an owner URL goes green while establishing NOTHING about the grant model. It is
    // also the obvious thing an operator reaches for when a run dies on a permission error.
    await expect(
      execFileAsync(
        process.execPath,
        [NPX, CLI, "--organization", ORG],
        { env: { ...process.env, DATABASE_URL: fixture!.adminUrl }, cwd: REPO_ROOT },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('refusing to run as "test"'),
    });
  }, 180_000);

  it("★ the CLI RUNS as aoa_operator, end to end, and exits 0", async () => {
    // The other half of the same proof: the refusal above must be about the ROLE, not about
    // the command being broken. Same command, same fixture, operator URL — exit 0.
    //
    // This is also the only assertion that exercises the CALLER `gate-clause-wiring.json`
    // declares `wired`. The guard proves a call site exists; this proves it works.
    const { stdout } = await execFileAsync(
      process.execPath,
      [NPX, CLI, "--organization", ORG],
      { env: { ...process.env, DATABASE_URL: fixture!.operatorUrl }, cwd: REPO_ROOT },
    );
    expect(stdout).toContain(`organization ${ORG}: 1 company(ies)`);
    expect(stdout).toContain(`OK     ${COMPANY}`);
    // Idempotent: the rows already exist from the earlier passes, so this run inserts none.
    expect(stdout).toContain("inserted=0");
    // ★ And it says so on every run: a green pass is NOT an open canary.
    expect(stdout).toContain("This flips no gate");
  }, 180_000);
});
