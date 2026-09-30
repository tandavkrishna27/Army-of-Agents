# MIG-010 Unit 2.2 — reproduce E10-F002 and E7-F004 before fixing either

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove both filed defects against embedded PostgreSQL with real serving roles, in a test
that will still be there — inverted — when the fix lands. **No production code changes in this unit.**

**Architecture:** One new integration suite beside the existing E-1 regression, reusing its
`startMigratedDatabase` harness. It seeds an organization that can actually reach the closure check
(which requires a provider-key generation), asserts the gate refuses because nothing writes the
crosswalk, then hand-writes the records a pass *would* have written to prove the gate CAN open, then
inserts one lease to prove it slams shut again.

**Tech stack:** vitest, drizzle, `postgres` (postgres.js) admin client, embedded-postgres.

---

## Why this unit exists, and why it is first

Every existing preflight test injects a fake store — `cli-006-canary-preflight-store.test.ts:44`
literally constructs it with `{} as never`. None of them can observe either filed defect. Unit 1.6
learned this the hard way: the defect it was built to fix was invisible to the whole suite until a
test ran on a real connection.

**The order matters more than the content.** Task 3's positive control (the gate CAN return `ok`)
must land *before* Task 4's race proof, or Task 4 passes for the wrong reason — the gate refuses
everything today, so "it refuses after I add a lease" is vacuous without first showing it stopped
refusing.

★ **The trap this unit must not fall into.** `canary-preflight.ts:150-156` checks the key generation
**before** closure. A fixture with no `runtime_provider_keys` row refuses with
`credential_authority_not_moved` and **never reaches the closure logic at all** — so a test asserting
"the gate refuses" would pass while proving nothing about E7-F004. Task 1 seeds a real key
generation, and Task 2's first assertion is that the reason is *not* the credential one.

---

## File structure

- **Create:** `server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts` — the whole unit.
- **Read, do not modify:** `server/src/__tests__/helpers/migrated-database.ts` (the harness),
  `server/src/__tests__/canary-preflight-real-role.integration.test.ts` (the shape to follow).

Nothing else is touched. If you find yourself editing a service, stop — that is Unit 2.3+.

---

## Task 1: The fixture that can actually reach the closure check

**Files:**
- Create: `server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts`

- [ ] **Step 1: Write the file header and fixture**

```ts
// MIG-010 Unit 2.2 — E10-F002 and E7-F004 REPRODUCED on real serving roles.
//
// E10-F002: `reconcileCompanyLegacyResources` and `createDrizzleReconciliationStore` each have
// ZERO non-test callers, so `legacy_resource_reconciliation` is never written and every
// inventory key is unmapped.
//
// E7-F004: the gate re-derives inventory from LIVE `environment_leases` rows, so a lease created
// after a pass is an unmapped key. On a box with traffic the gate can never close.
//
// ★ These tests assert TODAY'S broken behaviour on purpose. When Units 2.3-2.6 land they must be
// INVERTED, not deleted — a deleted test subtracts a failure instead of proving a fix (DSK-003).
//
// Windows-skipped unless AOA_RUN_WIN_INTEGRATION=1 (Issue #114); Linux CI is the authority.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      // would pass while proving nothing. deriveE2bKeyGeneration walks
      // runtime_provider_keys(provider='e2b', is_default) -> company_secret_versions(status='current').
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
    } catch (error) {
      await teardown();
      throw error;
    }
    fixture = { operatorDb, admin, teardown };
  }, 180_000);

  afterAll(async () => {
    await fixture?.teardown();
    fixture = null;
  });

  // The gate reads through the operator pool since Unit 1.7 moved EXECUTE there
  // (`index.ts:1256`). Building it per-call keeps each assertion independent.
  const check = () =>
    createCanaryPreflight({
      store: createDrizzleCanaryPreflightStore(fixture!.operatorDb),
    }).check({ organizationId: ORG });
});
```

- [ ] **Step 2: Run it — an empty describe must still boot the fixture**

```bash
cd /c/e3 && AOA_RUN_WIN_INTEGRATION=1 npx vitest run server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts
```

Expected: **0 tests, no failures**, and no leaked postgres process. If `beforeAll` throws on a
column that does not exist, fix the seed — do not proceed with a half-seeded fixture.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts
git commit -m "test(mig-010): fixture that reaches the closure check, not the credential one"
```

---

## Task 2: E10-F002 — the crosswalk is never written, so nothing can close

**Files:**
- Modify: `server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts`

- [ ] **Step 1: Add both assertions inside the describe, after `check`**

```ts
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

  it("[E10-F002] the crosswalk is EMPTY, because nothing in production writes it", async () => {
    const rows = await fixture!.admin`
      SELECT count(*)::int AS n FROM legacy_resource_reconciliation WHERE company_id = ${COMPANY}`;
    expect(rows[0]!.n).toBe(0);

    const result = await check();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // One lease, no platform-default env row -> inventory is exactly one key, and it is unmapped.
    expect(result.detail).toContain("unmapped=1");
    expect(result.companyId).toBe(COMPANY);
  });
```

- [ ] **Step 2: Run**

```bash
cd /c/e3 && AOA_RUN_WIN_INTEGRATION=1 npx vitest run server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts
```

Expected: **2 passed.** If the first test fails with `credential_authority_not_moved`, the key
generation seed is wrong — `deriveE2bKeyGeneration` needs `is_default = TRUE` **and** a
`company_secret_versions` row with `status = 'current'`.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts
git commit -m "test(mig-010): E10-F002 reproduced — nothing writes the crosswalk, so closure fails"
```

---

## Task 3: The positive control — the gate CAN open

Without this, Task 4 is vacuous. The gate refuses everything today; "it refuses after I add a lease"
proves nothing until you have first made it stop refusing.

**Files:**
- Modify: `server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts`

- [ ] **Step 1: Add the test**

```ts
  it("[positive control] hand-writing the records a pass WOULD write opens the gate", async () => {
    // This is what `reconcileCompanyLegacyResources` would have inserted for LEASE_1: one
    // `mapped` record keyed on the lease id, tagged with the current key generation. Written
    // through the OPERATOR pool, which proves the write authority the real pass will need.
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
```

Add `import { sql } from "drizzle-orm";` to the imports.

- [ ] **Step 2: Run**

```bash
cd /c/e3 && AOA_RUN_WIN_INTEGRATION=1 npx vitest run server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts
```

Expected: **3 passed.** A `credential_authority_not_moved` here means the `key_generation` string
does not match `deriveE2bKeyGeneration`'s `<secretId>:<version>` — print both and compare.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts
git commit -m "test(mig-010): positive control — a fully recorded company DOES pass the gate"
```

---

## Task 4 ★: E7-F004 — one new lease slams it shut again

This is the unit's point. Everything before it exists so this assertion means something.

**Files:**
- Modify: `server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts`

- [ ] **Step 1: Add the test — it MUST run after Task 3's**

```ts
  it("[E7-F004] ONE lease created after the pass re-closes the gate — the losing race", async () => {
    // Exactly what `acquireLease` does on every legacy cloud run (`environments.ts:141-165`).
    await fixture!.admin`INSERT INTO environment_leases
      (id, company_id, environment_id, status, lease_policy, provider, provider_lease_id)
      VALUES (${LEASE_2}, ${COMPANY}, ${ENV}, 'active', 'ephemeral', 'e2b', 'sbx-2')`;

    const result = await check();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("reconciliation_incomplete");
    // The NEW lease is the unmapped one. The recorded lease is still fine — this is not a
    // regression of Task 3, it is a strictly larger inventory over the same records.
    expect(result.detail).toContain("unmapped=1");

    // ★ And the crosswalk did NOT change. The gate is read-only; it cannot heal itself, and no
    // pass ran. This is what makes it a permanently-losing race rather than a transient.
    const rows = await fixture!.admin`
      SELECT count(*)::int AS n FROM legacy_resource_reconciliation WHERE company_id = ${COMPANY}`;
    expect(rows[0]!.n).toBe(1);
  });
```

- [ ] **Step 2: Run**

```bash
cd /c/e3 && AOA_RUN_WIN_INTEGRATION=1 npx vitest run server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts
```

Expected: **4 passed.**

- [ ] **Step 3: Prove the ordering dependency is real (mutation check, do not commit the mutation)**

Temporarily move Task 4's `it(...)` **above** Task 3's, re-run, and confirm Task 4 still passes —
because the gate refuses for the *original* reason. That is the vacuity this ordering prevents.
Restore the order and re-run to 4 passed before committing.

- [ ] **Step 4: Commit**

```bash
git add server/src/__tests__/mig-010-reconciliation-repro.integration.test.ts
git commit -m "test(mig-010): E7-F004 reproduced — one post-pass lease re-closes a closed gate"
```

---

## Task 5: Full verification before pushing

- [ ] **Step 1: The whole server suite, sharded**

```bash
cd /c/e3 && rc=0; for s in 1 2 3 4; do AOA_RUN_WIN_INTEGRATION=1 npx vitest run --shard=$s/4 server/src/__tests__ || rc=1; done; echo "SUITE_RC=$rc"
```

★ The flag is **required**, not optional. Without it the integration suites skip and `SUITE_RC=0`
means nothing.

- [ ] **Step 2: The policy guards**

```bash
cd /c/e3 && for g in $(grep -o "node scripts/check-[a-z0-9-]*\.mjs" .github/workflows/pr.yml | sed 's|node scripts/||' | sort -u); do node scripts/$g >/dev/null 2>&1 || echo "FAIL: $g"; done; echo done
```

Expected: only `check-browser-suite-executed.mjs` and `check-embedded-secrets.mjs` report — both take
CI-supplied arguments and are not run bare.

★ `check-test-inventory.mjs` counts tests in PINNED trees. A new test file may require a floor bump —
bump only the tree you touched; do not commit a `--write` sweep of every floor.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin claude/mig-010-unit-2-2-repro
```

The PR body states plainly: **this unit fixes nothing.** It reproduces E10-F002 and E7-F004 so the
fix has something to invert, and it is `code=true`, so `ci-required` rides the full heavy suite.

---

## Self-review

**Spec coverage.** E10-F002 → Tasks 2. E7-F004 → Task 4, with Task 3 as its positive control. The
credential-check trap → Task 1's seed plus Task 2's anti-vacuity assertion.

**Placeholders.** None. Every step carries its code or its exact command.

**Not covered, deliberately.** The lost-CAS arm of E7-F004 produces the same gate-level symptom as a
post-pass lease, so it is proven at the pass level in Unit 2.4, not duplicated here. The "zero
callers" fact behind E10-F002 is a source property, not a behaviour; it becomes "exactly one caller"
in Unit 2.4 and is asserted there.
