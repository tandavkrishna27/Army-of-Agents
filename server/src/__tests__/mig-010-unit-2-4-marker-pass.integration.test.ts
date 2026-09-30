// MIG-010 Unit 2.4a Task 4 — the pass writes a completed-pass marker, and a key rotation
// becomes RECOVERABLE.
//
// ★★★ THE TEST THIS UNIT EXISTS FOR is "a rotation is recoverable" below. Design §12 found
// that the rotation trap is not a race but a STANDING CONDITION with an unbounded window:
// every crosswalk record carries the generation observed at pass start, the crosswalk is
// append-only (`onConflictDoNothing` on `(company_id, resource_key)`), so a re-run CANNOT
// re-tag an existing record — and the shipped gate refuses on any record whose generation
// differs from the current one. A provider-key rotation a month after a perfectly clean pass
// therefore bricked that company permanently, with no remedy in code.
//
// §12's resolution is that the generation belongs to the MARKER, not to each record, because
// the two facts are different in kind: a crosswalk record is a fact about RESOURCES and does
// not go stale when a key rotates, while "under which authority, and when" is a fact about
// the PASS. The sequence below is what that buys, and it is impossible today at any distance
// from the pass:
//
//     clean pass                -> a marker exists, carrying G1
//     rotate the provider key   -> records unchanged (G1), marker unchanged (G1)
//     re-run the pass           -> a NEW marker carrying G2
//                               -> the RECORDS are byte-identical to before
//
// The last two assertions are the point. The new marker proves recovery is possible; the
// unchanged records prove it did NOT depend on re-tagging them, which is exactly what the
// append-only crosswalk makes impossible.
//
// ★ The record comparison is ROW BY ROW, not by count. A count is equal in both the working
// and the broken world — an in-place re-tag would leave two records and two records.
//
// Windows-skipped unless AOA_RUN_WIN_INTEGRATION=1 (Issue #114); Linux CI is the authority.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { Db } from "@armyofagents/db";
import {
  UNGENERATIONED_KEY_GENERATION,
  markerKeyGeneration,
  reconcileOrganizationLegacyResources,
  type LegacyReconciliationStore,
} from "../services/legacy-resource-reconciliation.js";
import { createDrizzleReconciliationStore } from "../services/legacy-resource-reconciliation-store.js";
import { startMigratedDatabase } from "./helpers/migrated-database.js";

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

// Organization 1 — the rotation/recovery sequence.
const ORG = "e4000000-0000-4000-8000-000000000001";
const COMPANY = "e4000000-0000-4000-8000-000000000002";
const ENV = "e4000000-0000-4000-8000-000000000003";
const LEASE_1 = "e4000000-0000-4000-8000-000000000004";
const LEASE_2 = "e4000000-0000-4000-8000-000000000005";
const SECRET = "e4000000-0000-4000-8000-000000000006";

// Organization 2 — the interrupted-pass convergence sequence, deliberately a SEPARATE
// organization: the pass is org-wide, so running it for the interruption test inside ORG
// would also re-mark COMPANY and destroy the marker counts above.
const ORG2 = "e4000000-0000-4000-8000-00000000000a";
const COMPANY2 = "e4000000-0000-4000-8000-00000000000b";
const ENV2 = "e4000000-0000-4000-8000-00000000000c";
const LEASE_2A = "e4000000-0000-4000-8000-00000000000d";
const LEASE_2B = "e4000000-0000-4000-8000-00000000000e";

type Fixture = { admin: Sql; operatorDb: Db; teardown: () => Promise<void> };
let fixture: Fixture | null = null;

type MarkerRow = {
  pass_id: string;
  organization_id: string;
  company_id: string;
  snapshot_at: Date;
  key_generation: string;
  completed_at: Date;
};

const markersFor = (companyId: string) =>
  fixture!.admin<MarkerRow[]>`
    SELECT pass_id, organization_id, company_id, snapshot_at, key_generation, completed_at
    FROM legacy_reconciliation_passes WHERE company_id = ${companyId}
    ORDER BY completed_at, pass_id`;

/** Every column of every crosswalk record, ordered deterministically for row-wise equality. */
const recordsFor = (companyId: string) =>
  fixture!.admin<Record<string, unknown>[]>`
    SELECT * FROM legacy_resource_reconciliation
    WHERE company_id = ${companyId} ORDER BY resource_key`;

const runPass = (organizationId: string, store?: LegacyReconciliationStore) =>
  reconcileOrganizationLegacyResources(organizationId, {
    store: store ?? createDrizzleReconciliationStore(fixture!.operatorDb),
  });

describe.skipIf(!RUN)("MIG-010 Unit 2.4 — the completed-pass marker", () => {
  beforeAll(async () => {
    const database = await startMigratedDatabase({ label: "aoa-mig-010-marker-pass-" });
    const { admin, operatorDb, teardown } = database;
    try {
      await admin`INSERT INTO organizations (id, name, slug) VALUES
        (${ORG}, 'MIG-010 u2.4 org', 'mig-010-u24-org'),
        (${ORG2}, 'MIG-010 u2.4 org 2', 'mig-010-u24-org-2')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix) VALUES
        (${COMPANY}, ${ORG}, 'MIG-010 u2.4 company', 'M24'),
        (${COMPANY2}, ${ORG2}, 'MIG-010 u2.4 company 2', 'M242')`;

      // The provider-control key generation for COMPANY, resolved by the 0267 scalars
      // function as `<secretId>:<version>` -> G1 below. COMPANY2 deliberately gets NONE, so
      // its markers exercise the `'ungenerationed'` sentinel rather than a real generation.
      await admin`INSERT INTO company_secrets (id, company_id, name, latest_version)
        VALUES (${SECRET}, ${COMPANY}, 'e2b-key', 1)`;
      await admin`INSERT INTO company_secret_versions
        (secret_id, version, material, status, value_sha256)
        VALUES (${SECRET}, 1, '{}'::jsonb, 'current', 'sha-not-a-real-digest')`;
      await admin`INSERT INTO runtime_provider_keys
        (company_id, provider, display_name, secret_id, is_default)
        VALUES (${COMPANY}, 'e2b', 'MIG-010 u2.4 e2b key', ${SECRET}, TRUE)`;

      await admin`INSERT INTO environments (id, company_id, name, driver, status) VALUES
        (${ENV}, ${COMPANY}, 'mig-010-u24-env', 'sandbox', 'active'),
        (${ENV2}, ${COMPANY2}, 'mig-010-u24-env-2', 'sandbox', 'active')`;
      // TWO leases per company so "interrupted between records" is a reachable state.
      await admin`INSERT INTO environment_leases
        (id, company_id, environment_id, status, lease_policy, provider, provider_lease_id) VALUES
        (${LEASE_1}, ${COMPANY}, ${ENV}, 'active', 'ephemeral', 'e2b', 'sbx-u24-1'),
        (${LEASE_2}, ${COMPANY}, ${ENV}, 'active', 'ephemeral', 'e2b', 'sbx-u24-2'),
        (${LEASE_2A}, ${COMPANY2}, ${ENV2}, 'active', 'ephemeral', 'e2b', 'sbx-u24-2a'),
        (${LEASE_2B}, ${COMPANY2}, ${ENV2}, 'active', 'ephemeral', 'e2b', 'sbx-u24-2b')`;
    } catch (error) {
      await teardown();
      throw error;
    }
    fixture = { admin, operatorDb, teardown };
  }, 180_000);

  afterAll(async () => {
    await fixture?.teardown();
    fixture = null;
  }, 60_000);

  // --- Step 1-3: the marker exists, carries the pass's facts, and is written LAST ---------

  it("writes ONE marker per company, carrying the DB-clock snapshot and the observed generation", async () => {
    const result = await runPass(ORG);
    expect(result.companies).toHaveLength(1);
    expect(result.companies[0]!.closure.ok).toBe(true);

    const markers = await markersFor(COMPANY);
    expect(markers).toHaveLength(1);
    const marker = markers[0]!;
    expect(marker.pass_id).toBe(result.passId);
    expect(marker.organization_id).toBe(ORG);
    expect(marker.key_generation).toBe(`${SECRET}:1`);

    // The snapshot is the DATABASE's clock, and it was read BEFORE anything was listed —
    // so it precedes the completion instant, which the store stamps with SQL `now()`.
    expect(marker.snapshot_at.getTime()).toBe(result.snapshotAt.getTime());
    expect(marker.snapshot_at.getTime()).toBeLessThanOrEqual(marker.completed_at.getTime());

    // ★ THE MARKER IS THE PASS'S LAST WRITE FOR THE COMPANY. Every record is on disk before
    // any observer can see a completed marker; the reverse order would let the gate read
    // "reconciled" over an inventory that is still being written.
    const records = await recordsFor(COMPANY);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect((record.created_at as Date).getTime()).toBeLessThanOrEqual(
        marker.completed_at.getTime(),
      );
    }
  });

  it("uses the 'ungenerationed' sentinel — never NULL — for a company with no provider key", async () => {
    // ★★★ E7-F005 / design §13. NULL is a NORMAL value for a key generation, and a nullable
    // marker column would concentrate the shipped gate's `!== null` hole into ONE row that
    // disables the staleness check outright. COMPANY2 has no `runtime_provider_keys` row at
    // all, so this is the reachable path, not a contrived one.
    const result = await runPass(ORG2);
    expect(result.companies[0]!.keyGeneration).toBeNull();
    expect(markerKeyGeneration(null)).toBe(UNGENERATIONED_KEY_GENERATION);

    const markers = await markersFor(COMPANY2);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.key_generation).toBe(UNGENERATIONED_KEY_GENERATION);
    expect(markers[0]!.key_generation).not.toBeNull();
  });

  // --- Step 4: the rotation is RECOVERABLE, and recovery does not re-tag anything ---------

  it("★ a rotation after a clean pass leaves records AND marker alone — nothing self-heals", async () => {
    const before = await recordsFor(COMPANY);
    expect(before).toHaveLength(2);
    for (const record of before) expect(record.key_generation).toBe(`${SECRET}:1`);

    // Rotate. The 0267 keygen CTE takes `status='current'` ORDER BY version DESC LIMIT 1, so
    // a second current version IS the new generation.
    await fixture!.admin`UPDATE company_secret_versions SET status = 'superseded'
      WHERE secret_id = ${SECRET} AND version = 1`;
    await fixture!.admin`INSERT INTO company_secret_versions
      (secret_id, version, material, status, value_sha256)
      VALUES (${SECRET}, 2, '{}'::jsonb, 'current', 'sha-not-a-real-digest-2')`;
    await fixture!.admin`UPDATE company_secrets SET latest_version = 2 WHERE id = ${SECRET}`;

    // Nothing ran, so nothing changed. This is the standing condition §12 describes: the
    // records now carry a superseded generation and no code path can re-tag them.
    expect(await recordsFor(COMPANY)).toEqual(before);
    const markers = await markersFor(COMPANY);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.key_generation).toBe(`${SECRET}:1`);
  });

  it("★★★ re-running after the rotation mints a NEW marker at G2 — and the records are byte-identical", async () => {
    const before = await recordsFor(COMPANY);
    const firstMarker = (await markersFor(COMPANY))[0]!;

    const result = await runPass(ORG);
    expect(result.passId).not.toBe(firstMarker.pass_id);

    const markers = await markersFor(COMPANY);
    expect(markers).toHaveLength(2);
    const latest = markers[markers.length - 1]!;
    // RECOVERY. The company was permanently ungateable before §12; now the newest completed
    // pass carries the CURRENT generation and the gate (Unit 2.4b) reads staleness from here.
    expect(latest.key_generation).toBe(`${SECRET}:2`);
    expect(latest.pass_id).toBe(result.passId);
    expect(latest.snapshot_at.getTime()).toBeGreaterThan(firstMarker.snapshot_at.getTime());
    // The first marker is untouched — markers are append-only evidence, and `aoa_operator`
    // holds no UPDATE on the table, so it could not be rewritten even by mistake.
    expect(markers[0]).toEqual(firstMarker);

    // ★ AND THE RECORDS DID NOT MOVE. Row by row, every column — not a count, which would be
    // 2 in both the working and the broken world. This is what proves recovery did not
    // depend on re-tagging the crosswalk, which `onConflictDoNothing` makes impossible.
    expect(await recordsFor(COMPANY)).toEqual(before);
    // Still tagged with the SUPERSEDED generation, deliberately: a record is a fact about a
    // resource and does not go stale when a key rotates. It simply stops being what the gate
    // reads (Unit 2.4b).
    for (const record of await recordsFor(COMPANY)) {
      expect(record.key_generation).toBe(`${SECRET}:1`);
    }
    // The pass inserted nothing new — it converged rather than accumulating.
    expect(result.companies[0]!.insertedKeys).toEqual([]);
  });

  // --- Step 5: a partial pass leaves NO marker, and a re-run converges --------------------

  it("an interrupted pass writes NO marker, and the re-run converges to the full set and exactly one more", async () => {
    const markersBefore = await markersFor(COMPANY2);
    expect(markersBefore).toHaveLength(1);
    await fixture!.admin`DELETE FROM legacy_resource_reconciliation WHERE company_id = ${COMPANY2}`;
    await fixture!.admin`DELETE FROM legacy_reconciliation_passes WHERE company_id = ${COMPANY2}`;

    // Interrupt BETWEEN records: the first insert lands, the second throws.
    const real = createDrizzleReconciliationStore(fixture!.operatorDb);
    let inserts = 0;
    const failing: LegacyReconciliationStore = {
      ...real,
      insertRecordIfAbsent: async (record) => {
        if (++inserts > 1) throw new Error("interrupted between records");
        return real.insertRecordIfAbsent(record);
      },
    };
    await expect(runPass(ORG2, failing)).rejects.toThrow("interrupted between records");

    // "records, no marker" — the fail-CLOSED state. The gate reads it as NOT reconciled.
    expect(await recordsFor(COMPANY2)).toHaveLength(1);
    expect(await markersFor(COMPANY2)).toHaveLength(0);

    const result = await runPass(ORG2);
    expect(result.companies[0]!.closure.ok).toBe(true);
    expect(await recordsFor(COMPANY2)).toHaveLength(2);
    const markers = await markersFor(COMPANY2);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.pass_id).toBe(result.passId);
    // The record the interrupted pass DID write was not duplicated — the crosswalk's unique
    // `(company_id, resource_key)` index plus `onConflictDoNothing` is what makes a partial
    // pass re-runnable rather than a mess to clean up by hand.
    expect(result.companies[0]!.insertedKeys).toHaveLength(1);
  });
});
