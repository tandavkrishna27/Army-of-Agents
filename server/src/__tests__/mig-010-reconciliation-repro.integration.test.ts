// MIG-010 Unit 2.2 — E10-F002 and E7-F004 REPRODUCED on real serving roles.
//
// E10-F002: `reconcileCompanyLegacyResources` and `createDrizzleReconciliationStore` each have
// ZERO non-test callers, so `legacy_resource_reconciliation` is never written and every
// inventory key is unmapped.
//
// E7-F004: the gate re-derives inventory from LIVE `environment_leases` rows, so a lease created
// after a pass is an unmapped key. On a box with traffic the gate can never close.
//
// ★ These tests assert TODAY'S broken behaviour on purpose. When the units that FIX them land
// they must be INVERTED, not deleted — a deleted test subtracts a failure instead of proving a
// fix (DSK-003).
//
// ★ UNIT 2.3 HAS LANDED AND DID NOT INVERT THEM. That is deliberate, and it is not an
// oversight to be corrected by the next reader:
//
//   * Every assertion below is STILL TRUE, and still guards. This file seeds its own database
//     and never runs the reconciliation pass, so the crosswalk is genuinely empty, `unmapped=1`
//     is genuinely the closure result, and E7-F004's post-pass lease genuinely re-closes the
//     gate. Inverting an accurate test would delete a live regression guard.
//   * Unit 2.3 closes E10-F002 — the pass had no caller and could not have run if it had one —
//     WITHOUT touching the gate. There is no watermark, no `reconciliation_stale` and no change
//     to `canary-preflight.ts`, so nothing here could have changed. The canary is still shut.
//   * The INVERTED counterpart now exists alongside, in
//     `mig-010-unit-2-3-pass.integration.test.ts`: same seed shape, but a real pass runs first,
//     and the same gate then answers `ok: true`. The pair is the evidence — this file pins what
//     happens with no pass, that one pins what happens with one.
//
// E7-F004 (the post-pass lease) is untouched by 2.3 and is Unit 2.4's to invert.
//
// ★★★ UNIT 2.4b HAS NOW INVERTED IT — one test, in place, not by deletion. Read what did NOT
// change first, because that is what makes the change meaningful:
//
//   * `unmapped=1` on an empty crosswalk still holds, and is still this file's single
//     DISCRIMINATING assertion (proven by mutation in Unit 2.2: reorder the tests and it reads
//     unmapped=2 while `reason` is identical either way).
//   * the positive control still opens the gate.
//   * the credential and closure arms are untouched.
//
// The ONE assertion that flipped is E7-F004's: a lease created AFTER the reconciliation
// snapshot no longer re-closes the gate. The old comment beside it called that behaviour
// "self-healing"; it is the permanently-losing race E7-F004 filed, because on a box taking
// legacy traffic there is always another lease. Design section 9.1 names the residual honestly:
// inside the freshness window such a lease IS waved through without a crosswalk record — it is
// current traffic on the legacy path, not an unreconciled legacy resource.
//
// ★ AND ITS ANTI-VACUITY TWIN IS ADDED BESIDE IT. A lease created BEFORE the snapshot still
// re-closes the gate. Without that, "the new lease no longer refuses" would also pass if the
// narrowing had simply stopped looking at leases at all.
//
// ★ THE FIXTURE GAINS A MARKER (migration 0269), seeded directly rather than by running a pass:
// this file's whole identity is "no pass has run", and it must keep asserting closure over an
// EMPTY crosswalk. Without a marker the gate now refuses `reconciliation_stale` before it ever
// reaches closure, and all four assertions below would be testing the marker check instead of
// the thing they were written for.
//
// Windows-skipped unless AOA_RUN_WIN_INTEGRATION=1 (Issue #114); Linux CI is the authority.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Db } from "@armyofagents/db";
import { createCanaryPreflight } from "../services/canary-preflight.js";
import { createDrizzleCanaryPreflightStore } from "../services/canary-preflight-store.js";
import { startMigratedDatabase } from "./helpers/migrated-database.js";

const ORG = "e2000000-0000-4000-8000-000000000001";
const COMPANY = "e2000000-0000-4000-8000-000000000002";
const ENV = "e2000000-0000-4000-8000-000000000003";
const LEASE_1 = "e2000000-0000-4000-8000-000000000004";
const LEASE_2 = "e2000000-0000-4000-8000-000000000005";
const SECRET = "e2000000-0000-4000-8000-000000000006";
const LEASE_3 = "e2000000-0000-4000-8000-000000000007";
const PASS = "e2000000-0000-4000-8000-000000000008";

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

type Fixture = { operatorDb: Db; admin: Sql; teardown: () => Promise<void> };
let fixture: Fixture | null = null;

describe.skipIf(!RUN)("MIG-010 Unit 2.2 — the reconciliation defects, reproduced", () => {
  beforeAll(async () => {
    const database = await startMigratedDatabase({ label: "aoa-mig-010-" });
    const { admin, operatorDb, teardown } = database;
    try {
      await admin`INSERT INTO organizations (id, name, slug)
        VALUES (${ORG}, 'MIG-010 org', 'mig-010-org')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'MIG-010 company', 'M010')`;

      // ★ The key generation. Without it `canary-preflight.ts:150-156` refuses with
      // `credential_authority_not_moved` BEFORE the closure check, and every assertion below
      // would pass while proving nothing.
      //
      // The gate does NOT call `deriveE2bKeyGeneration` — a debugging reader sent there is sent
      // to the wrong place. Since Unit 1.7 the path is `canary-preflight-store.ts:102-105` ->
      // `readCanaryPreflightScalars` -> the `0267` SECURITY DEFINER function, which walks the
      // same two tables in SQL: runtime_provider_keys(provider='e2b', is_default) ->
      // company_secret_versions(status='current'), and formats `<secretId>:<version>`.
      await admin`INSERT INTO company_secrets (id, company_id, name, latest_version)
        VALUES (${SECRET}, ${COMPANY}, 'e2b-key', 1)`;
      await admin`INSERT INTO company_secret_versions
        (secret_id, version, material, status, value_sha256)
        VALUES (${SECRET}, 1, '{}'::jsonb, 'current', 'sha-not-a-real-digest')`;
      await admin`INSERT INTO runtime_provider_keys
        (company_id, provider, display_name, secret_id, is_default)
        VALUES (${COMPANY}, 'e2b', 'MIG-010 e2b key', ${SECRET}, TRUE)`;

      // Exactly ONE lease, and NO platform-default environments row, so the inventory is a
      // single key and `unmapped=1` is unambiguous. `provider_lease_id` is set so
      // classifyLease sees a live handle (it is `mapped`, left for drain).
      await admin`INSERT INTO environments (id, company_id, name, driver, status)
        VALUES (${ENV}, ${COMPANY}, 'mig-010-env', 'sandbox', 'active')`;
      await admin`INSERT INTO environment_leases
        (id, company_id, environment_id, status, lease_policy, provider, provider_lease_id)
        VALUES (${LEASE_1}, ${COMPANY}, ${ENV}, 'active', 'ephemeral', 'e2b', 'sbx-1')`;

      // ★ MIG-010 Unit 2.4b — a completed-pass MARKER, seeded AFTER the lease so its snapshot
      // covers it. Seeded directly, NOT by running a pass: this file's identity is "no pass has
      // run", and every assertion below is about what the gate does over an EMPTY crosswalk.
      // The marker only supplies the WATERMARK the gate now needs before it can read leases at
      // all; it says nothing about closure, which the gate re-derives for itself.
      //
      // `snapshot_at`/`completed_at` come from the DATABASE clock, like the real pass's, so the
      // freshness bound is evaluated against the same clock on both sides. The generation must
      // match the one the 0267 scalars function derives (`<secretId>:<version>`) or the gate
      // refuses `reconciliation_stale` on the generation arm — which would read as a defect in
      // the code under test rather than as a seeding bug.
      await admin`INSERT INTO legacy_reconciliation_passes
        (pass_id, organization_id, company_id, snapshot_at, key_generation, completed_at)
        VALUES (${PASS}, ${ORG}, ${COMPANY}, now(), ${`${SECRET}:1`}, now())`;
    } catch (error) {
      await teardown();
      throw error;
    }
    fixture = { operatorDb, admin, teardown };
  }, 180_000);

  afterAll(async () => {
    await fixture?.teardown();
    fixture = null;
    // 60s to match `canary-preflight-real-role.integration.test.ts:106-108`. On the default hook
    // timeout a slow embedded-postgres teardown fails THIS file, which reads as a defect in the
    // code under test rather than as the shutdown being slow.
  }, 60_000);

  // The gate reads through the operator pool since Unit 1.7 moved EXECUTE there
  // (`index.ts:1256`). Building it per-call keeps each assertion independent.
  const check = () =>
    createCanaryPreflight({
      store: createDrizzleCanaryPreflightStore(fixture!.operatorDb),
    }).check({ organizationId: ORG });

  it("[E10-F002] refuses on CLOSURE, not on credentials — the fixture reaches the real check", async () => {
    const result = await check();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // ★ The anti-vacuity assertion. If this ever reads `credential_authority_not_moved`, the
    // fixture regressed and every closure assertion below is meaningless.
    expect(result.reason).not.toBe("credential_authority_not_moved");
    expect(result.reason).not.toBe("preflight_error");
    expect(result.reason).toBe("reconciliation_incomplete");
  });

  // NAMED for what it asserts. E10-F002's headline claim is a SOURCE property — two symbols
  // with zero non-test callers — and no assertion here establishes it; a behavioural test cannot
  // exercise a caller that does not exist. What it does pin is the filed CONSEQUENCE
  // (findings.md E10-F002: "the gate answers `reconciliation_incomplete` for every organization,
  // forever"). The caller count becomes "exactly one" in Unit 2.4 and is asserted there.
  it("[E10-F002] an empty crosswalk leaves every inventory key unmapped", async () => {
    const rows = await fixture!.admin`
      SELECT count(*)::int AS n FROM legacy_resource_reconciliation WHERE company_id = ${COMPANY}`;
    expect(rows[0]!.n).toBe(0);

    const result = await check();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // One lease, no platform-default env row -> inventory is exactly one key, and it is unmapped.
    // ★ EXACT, not a prefix. This count is the file's single discriminating assertion (proven by
    // mutation: reorder the tests and it reads unmapped=2 while `reason` is unchanged), and a bare
    // `toContain("unmapped=1")` would also match unmapped=10..19 and unmapped=100..199. Pinning
    // the whole closure triple also covers the other two arms `assertClosure` can fail on.
    expect(result.detail).toContain("(unmapped=1, duplicates=0, unattributable=0)");
    expect(result.companyId).toBe(COMPANY);
  });

  it("[positive control] hand-writing the records a pass WOULD write opens the gate", async () => {
    // The record a real pass would key on LEASE_1: `mapped`, tagged with the current key
    // generation. Written through the OPERATOR pool, which proves the write authority the real
    // pass will need.
    //
    // ★ NOT byte-identical to `buildLeaseRecord`, and the earlier comment claiming it was is
    // corrected here. `buildLeaseRecord` (legacy-resource-reconciliation.ts:210-211) sets
    // `resourceLabelsHash = computeResourceLabelsHash(lease)` on EVERY `mapped` record; this row
    // leaves it null. That is deliberate — `assertClosure` reads only `resourceKey` and
    // `disposition` (`:270-295`), so the hash cannot change the verdict, and synthesizing a hash
    // here would be a second derivation of MIG-008 Invariant #2's attribution that could drift
    // from the real one silently. Fidelity to what the CLOSURE CHECK consumes is the property
    // that matters; fidelity to the full record is Unit 2.4's, where the real pass writes it.
    // (Verified: `0256` grants aoa_operator SELECT/INSERT/UPDATE and its policy is
    // `USING (true) WITH CHECK (true)`, so this insert needs no GUC and no tenant context.)
    const keyGeneration = `${SECRET}:1`;
    await fixture!.operatorDb.execute(sql`
      INSERT INTO legacy_resource_reconciliation
        (company_id, environment_lease_id, environment_id, resource_key, resource_type,
         legacy_status, provider, provider_lease_id, disposition, key_generation, reason)
      VALUES (${COMPANY}::uuid, ${LEASE_1}::uuid, ${ENV}::uuid, ${LEASE_1}, 'ephemeral',
              'active', 'e2b', 'sbx-1', 'mapped', ${keyGeneration},
              'active legacy execution — left for drain, no fence synthesized')`);

    const result = await check();
    // ★ If this refuses, read the detail before touching anything else: a `key_generation`
    // mismatch refuses as `credential_authority_not_moved`, which is a SEEDING bug, not a
    // closure result.
    expect(result).toMatchObject({ ok: true });
  });

  // ★★★ E7-F004, INVERTED IN PLACE (DSK-003) — this is the one assertion Unit 2.4b changed.
  //
  // Until this unit it read:
  //
  //     it("[E7-F004] ONE lease created after the pass re-closes the gate — the losing race")
  //       expect(result.reason).toBe("reconciliation_incomplete");
  //       expect(result.detail).toContain("(unmapped=1, duplicates=0, unattributable=0)");
  //
  // and it passed, and it WAS the defect: the gate re-derived its inventory from LIVE rows, so
  // one lease created a second after the pass re-closed it, forever, on any box taking legacy
  // traffic. The lease inventory is now narrowed to the marker's snapshot instant.
  it("[E7-F004, inverted] a lease created AFTER the snapshot no longer re-closes the gate", async () => {
    // Exactly what `acquireLease` does on every legacy cloud run (`environments.ts:141-165`) —
    // and `created_at` comes from the DATABASE default, which Unit 2.4a made load-bearing.
    await fixture!.admin`INSERT INTO environment_leases
      (id, company_id, environment_id, status, lease_policy, provider, provider_lease_id)
      VALUES (${LEASE_2}, ${COMPANY}, ${ENV}, 'active', 'ephemeral', 'e2b', 'sbx-2')`;

    const result = await check();
    // The gate stays OPEN. Section 9.1's residual, stated where it is observable: this lease is
    // waved through without a crosswalk record because it is current traffic on the legacy
    // path, not an unreconciled legacy resource, and the freshness window bounds how much of
    // that can accumulate.
    expect(result).toMatchObject({ ok: true });

    // ★ And the crosswalk STILL did not change. The gate remains read-only — it did not open by
    // recording anything, it opened by asking a narrower question.
    const rows = await fixture!.admin`
      SELECT count(*)::int AS n FROM legacy_resource_reconciliation WHERE company_id = ${COMPANY}`;
    expect(rows[0]!.n).toBe(1);
  });

  // ★ THE ANTI-VACUITY TWIN, and it is not optional: without it, the assertion above would pass
  // just as well if the narrowing had stopped looking at leases altogether. A lease INSIDE the
  // watermark with no crosswalk record must still refuse.
  it("[E7-F004] a lease created BEFORE the snapshot still re-closes the gate", async () => {
    // `created_at` is set explicitly to an instant well before the marker's snapshot. Everything
    // else matches LEASE_2 above, so the ONLY difference between the two tests is which side of
    // the watermark the row falls on.
    await fixture!.admin`INSERT INTO environment_leases
      (id, company_id, environment_id, status, lease_policy, provider, provider_lease_id, created_at)
      VALUES (${LEASE_3}, ${COMPANY}, ${ENV}, 'active', 'ephemeral', 'e2b', 'sbx-3',
              now() - interval '1 hour')`;

    const result = await check();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("reconciliation_incomplete");
    // ★ EXACT, and it is still this file's discriminating assertion: LEASE_1 has a record and
    // LEASE_2 is outside the watermark, so exactly ONE key is unmapped. `unmapped=2` here would
    // mean the narrowing did not exclude LEASE_2 after all, and the refusal REASON is identical
    // in both worlds.
    expect(result.detail).toContain("(unmapped=1, duplicates=0, unattributable=0)");
  });
});
