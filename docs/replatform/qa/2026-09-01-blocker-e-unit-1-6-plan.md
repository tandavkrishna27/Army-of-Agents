# Blocker E / Unit 1.6 Implementation Plan — the canary preflight's read authority

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Let the canary preflight read its own evidence — with **zero** serving-role privilege delta —
and close the `SECURITY DEFINER` blind spot the fix relies on, so the gate's refusal becomes *honest*
instead of masquerading as an unreadability error.

**Architecture:** An owner-owned `SECURITY DEFINER` function becomes the evidence read for the three
tables `aoa_app` cannot touch. No table grant, no column grant, no ACL-manifest edit. Because such a
function is currently **invisible** to `assertExactServingRoleAuthority`, the same commit ships a
`prosecdef` certificate, so the change *narrows* the ACL model rather than silently bypassing it.

**Tech Stack:** PostgreSQL 18, Drizzle ORM, TypeScript/Node, Vitest (`pool: "forks"`), embedded-postgres
for real-role integration tests.

> **Revision 2.** Revision 1 was reviewed by four adversarial lenses, three of which executed the SQL
> against a real PostgreSQL 18.1. It carried **two serious defects** — a cross-tenant existence oracle in
> the function itself, and a **false headline claim** about the post-fix refusal reason — plus a RED step
> that silently skips on Windows and a Task-3 change that breaks an existing test the plan never
> mentioned. All are corrected below and marked **★R2**.

---

## ⛔ READ THIS BEFORE ANY CODE — what this plan does NOT do

**This plan does not unblock the canary, and any claim that it does is false.**

Blocker E is **three** stacked defects. This plan fixes exactly one:

| | Defect | Fixed here? |
|---|---|---|
| **E-1** | The preflight store is bound to the non-owner `aoa_app` pool and is permission-denied on `environment_leases`, `environments`, `runtime_provider_keys`, `company_secret_versions`. Those reads raise 42501; the catch at `canary-preflight.ts:191-200` folds them into `preflight_error`; `run-execution-owner.ts:254-257` returns `owner="legacy"`. | **YES** |
| **E-2** | `reconcileCompanyLegacyResources` (`legacy-resource-reconciliation.ts:324`) has **ZERO non-test callers**. Nothing in a running server writes `legacy_resource_reconciliation`, so `listRecords` returns `[]` forever. | **NO** — Task 6 files it |
| **E-3** | `environments.ts:142` inserts an `environment_leases` row on **every** legacy cloud run, while `legacy-resource-reconciliation.ts:344-350` `continue`s past a lost-CAS paused lease *without recording it*. The pass's inventory is a strict subset of the gate's re-derived inventory **by construction**, so closure is a permanently-losing race on any box with traffic. | **NO** — Task 6 files it |

**★R2 — the outcome, stated correctly.** Revision 1 claimed the gate would move to
`reconciliation_incomplete`. **That is wrong.** `canary-preflight.ts:150-156` checks the key generation
**before** closure is ever evaluated:

```ts
if (keyGeneration === null) {
  return refuse("credential_authority_not_moved", companyId,
    `Company ${companyId} has no current provider-control key generation`);
}
```

`deriveE2bKeyGeneration` returns `null` for **any** company without a default BYO e2b key — its own
docstring calls that "the operator env default — ungenerationed". So after this plan the refusal is
**`credential_authority_not_moved`**, and `reconciliation_incomplete` appears only once a company has a
BYO e2b key provisioned. Both are *policy* refusals. **The only thing this plan promises is that the
refusal is no longer `preflight_error`** — no longer "I could not read", which is unfalsifiable and
indistinguishable from a policy decision.

A previous design in this programme claimed a privilege-only fix would open the gate; two independent
judges refuted it. Do not repeat that, and do not restate Revision 1's wrong reason.

**★R2 — three reads are blocked, not four.** `legacy_resource_reconciliation` **is** granted SELECT to
`aoa_app` (`job-control-legacy-grants.ts:316-318`), so `listRecords` was never blocked. The blocked reads
are `environment_leases`, `environments`, and the `runtime_provider_keys` → `company_secret_versions`
pointer chain.

---

## Constraints — violating any of these breaks production or produces a fake pass

1. **Do NOT wrap the gate in `runInTenant`.** `legacy_resource_reconciliation` has FORCE RLS
   (`0256_dizzy_bedlam.sql:84,87`) and its app policy `CUTOVER_APP_READ_QUAL`
   (`job-control-legacy-grants.ts:475`) is `current_setting('aoa.organization_id', true) IS NULL` —
   **inverted**. `aoa_app` may read it only *outside* tenant context, which is how the preflight runs
   today. Wrapping it returns **zero rows silently**.
2. **Key the certificate on `pg_proc.prosecdef`, never on effective EXECUTE.** `CREATE EXTENSION vector`
   has no `SCHEMA` clause (`0038_marvelous_vapor.sql:1`, `0115_enable_pgvector.sql:29`), so on a fleet
   that *has* pgvector it installs ~100 functions into `public` carrying PostgreSQL's default
   `PUBLIC EXECUTE`. A certificate asserting "EXECUTE must be false unless manifested" fails boot there.
   `prosecdef` is also the security-correct axis: a SECURITY INVOKER function confers nothing beyond the
   caller's own authority.
3. **Never table-grant these four tables.** `company_secret_versions.material` is AES-256-GCM secret
   material (`schema/company_secret_versions.ts:12`), and — less obviously —
   **`environment_leases.metadata` is secret-bearing AT REST**: `sanitizeProviderMetadata`
   (`environment-runtime.ts:386-393`) strips only `apiKey|resolvedApiKey`, at read time, in memory.
4. **Do not route to `aoa_operator`.** It is denied on all four tables *and* lacks `companies` by design
   (`PLAN_DERIVED_ACL_MATRIX`, `job-control-legacy-grants.ts:559`).
5. **Migrations run as the database owner** — required, because
   `0214_e2_serving_role_hardening.sql:10,31` RAISEs if a serving role owns an application object.
6. **★R2 — every integration step must be un-skipped and proven non-vacuous.**
   `distributed-execution-db-startup.integration.test.ts:2156` is
   `describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")`.
   On Windows the whole file reports `73 skipped`, **exit 0**. A "RED step" that skips is not a RED step.
   Every integration command in this plan sets `AOA_RUN_WIN_INTEGRATION=1`, and every one is followed by
   an explicit *"confirm N passed, not N skipped"* check.
7. **Run vitest from the REPO ROOT.** Several contract tests do `join(process.cwd(), "server/src/...")`
   and fail spuriously from `server/`. `--project server` silently matches nothing — use a path.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/migrations/<next>_canary_preflight_evidence_fn.sql` **(new, C14 hand-authored)** | Owner-owned `SECURITY DEFINER` function returning the three evidence scalars. Grants EXECUTE to `aoa_app` only. |
| `server/src/services/canary-preflight-evidence.ts` **(new)** | Typed wrapper over that function. One responsibility: cross the privilege boundary. |
| `server/src/services/canary-preflight-store.ts` **(modify)** | Take `listLeases`/`platformDefaultEnv`/`currentKeyGeneration` from the wrapper instead of the reconciler's store. |
| `server/src/__tests__/cli-006-canary-preflight-store.test.ts` **(modify — ★R2)** | Its three reference-identity cases assert exactly the delegation being removed. Must be rewritten, not left to fail. |
| `server/src/db/security-definer-manifest.ts` **(new)** | `SECURITY_DEFINER_FUNCTION_MANIFEST` — the definer allowlist, as data. |
| `server/src/db/distributed-execution-databases.ts` **(modify)** | `assertSecurityDefinerManifest`, keyed on `prosecdef`, called from the startup assertion path. |
| `server/src/__tests__/canary-preflight-real-role.integration.test.ts` **(new)** | The test that would have caught this class: the gate on a real `aoa_app` connection must not answer `preflight_error`. |
| `server/src/__tests__/security-definer-manifest.test.ts` **(new)** | Manifest unit tests **and** a test that exercises the scan's SQL against a real role (★R2 — the manifest-array-only version proves nothing). |

---

## Task 1: Reproduce E-1 with a real-role integration test

Every existing preflight test injects fakes — `cli-006-canary-preflight-store.test.ts:44` literally
constructs the store with `{} as never`. That is why this shipped.

**Files:**
- Create: `server/src/__tests__/canary-preflight-real-role.integration.test.ts`

- [ ] **Step 1: Write the test**

★R2 — do **not** "reuse the setup verbatim" from `distributed-execution-db-startup.integration.test.ts`;
its setup is entangled with three extra databases and a legacy-owner role. Copy only the role
provisioning and URL rewrite (its `appUrl` construction, `:196`). Note its skip gate (Constraint 6) and
carry the same gate here so CI lanes behave consistently.

```ts
// server/src/__tests__/canary-preflight-real-role.integration.test.ts
//
// BLOCKER E regression. Every other preflight test injects a fake store, so none can observe
// what actually broke: the store runs on the NON-OWNER `aoa_app` pool and is permission-denied
// on three of its evidence reads. The gate then answers `preflight_error` — an unreadability
// refusal indistinguishable from a policy refusal.
//
// This asserts the DISTINCTION, not the outcome. The gate SHOULD still refuse (E-2/E-3 are
// unfixed). It may never refuse because it could not READ.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCanaryPreflight } from "../services/canary-preflight.js";
import { createDrizzleCanaryPreflightStore } from "../services/canary-preflight-store.js";

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

describe.skipIf(!RUN)("BLOCKER E — canary preflight on a real aoa_app connection", () => {
  let fixture: Fixture;
  beforeAll(async () => { fixture = await setUpRealRoleFixture(); }, 120_000);
  afterAll(async () => { await fixture?.teardown(); });

  it("does not refuse with preflight_error", async () => {
    const gate = createCanaryPreflight({
      store: createDrizzleCanaryPreflightStore(fixture.appDb),
    });

    const result = await gate.check({ organizationId: fixture.organizationId });

    expect(
      result.ok ? null : result.reason,
      "an unreadable gate is a closed gate that cannot say why — this is Blocker E",
    ).not.toBe("preflight_error");
  });

  it("gives a policy reason, with no permission error in the detail", async () => {
    const gate = createCanaryPreflight({
      store: createDrizzleCanaryPreflightStore(fixture.appDb),
    });

    const result = await gate.check({ organizationId: fixture.organizationId });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // ★R2 — the expected reason is credential_authority_not_moved, NOT
      // reconciliation_incomplete: canary-preflight.ts:150-156 checks the key generation
      // BEFORE closure, and the fixture seeds no BYO e2b key.
      expect(result.reason).toBe("credential_authority_not_moved");
      expect(result.detail ?? "").not.toMatch(/permission denied/i);
    }
  });
});
```

★ **Assert on the reason, never on which table name appears.** `canary-preflight.ts:139-145` fires the
reads in one unordered `Promise.all`, so which of the three 42501s surfaces is race-dependent.

- [ ] **Step 2: Write the fixture, with teardown**

★R2 — one fixture for the whole describe (`beforeAll`), not per-`it()`, and it must tear down; an
embedded-postgres instance per test leaks processes.

```ts
type Fixture = { appDb: Db; organizationId: string; teardown: () => Promise<void> };

async function setUpRealRoleFixture(): Promise<Fixture> {
  // 1. Start embedded postgres; apply migrations as admin (applyPendingMigrations).
  // 2. Provision `aoa_app` exactly as distributed-execution-db-startup.integration.test.ts
  //    does, and build appUrl by the same replace of the admin credentials.
  // 3. As ADMIN, insert ONE organizations row and ONE companies row whose organization_id
  //    points at it. Seed NOTHING else — no leases, no runtime_provider_keys.
  // 4. Return a drizzle Db built on appUrl, that organizationId, and a teardown that closes
  //    the pools and stops the instance.
}
```

Insert as **admin**, read as **`aoa_app`** — that asymmetry is the whole point. Seeding a company is
mandatory: with none, the gate short-circuits on `no_companies` (`canary-preflight.ts:132-137`) and the
test passes for the wrong reason.

- [ ] **Step 3: Run it and confirm it FAILS — and that it actually RAN**

```bash
cd /c/e3 && AOA_RUN_WIN_INTEGRATION=1 npx vitest run server/src/__tests__/canary-preflight-real-role.integration.test.ts
```

Expected: **`2 failed`**, first assertion receiving `"preflight_error"` with a detail containing
`permission denied for table …`.

★R2 — if the output says `skipped`, **stop**. A skipped RED step proves nothing. Confirm the summary
line reads `Tests 2 failed`, not `2 skipped`.

- [ ] **Step 4: Commit the RED test**

```bash
git add server/src/__tests__/canary-preflight-real-role.integration.test.ts
git commit -m "test(cli-006): reproduce BLOCKER E on a real aoa_app connection"
```

---

## Task 2: The SECURITY DEFINER evidence function

**Files:**
- Create: `packages/db/src/migrations/<next>_canary_preflight_evidence_fn.sql`

- [ ] **Step 1: Generate the custom migration stub**

```bash
cd /c/e3 && pnpm db:generate --custom --name=canary_preflight_evidence_fn
```

★R2 — `--name` is required, or the file lands with a generated name that will not match this plan. This
writes a journal entry plus an empty `.sql`. **No schema DDL may be hand-authored** — this is the C14
narrow exception for security DDL only, the route `0214` and `0261` took.

- [ ] **Step 2: Write the function**

```sql
-- C14 hand-authored security DDL: drizzle-kit cannot emit functions or their ACLs.
-- Every statement is naturally idempotent (CREATE OR REPLACE / idempotent GRANT).
--
-- WHY. The canary preflight (server/src/services/canary-preflight.ts:139-145) fires its
-- evidence reads on the NON-OWNER `aoa_app` pool (server/src/index.ts:1214). Three of them
-- hit tables `aoa_app` holds ZERO privileges on; each raises 42501, the catch at
-- canary-preflight.ts:191-200 folds it into reason="preflight_error", and
-- run-execution-owner.ts:254-257 returns owner="legacy". The gate could never open.
--
-- WHY NOT A GRANT. `company_secret_versions.material` is AES-256-GCM secret material and
-- `environment_leases.metadata` is secret-bearing AT REST (sanitizeProviderMetadata strips
-- only apiKey|resolvedApiKey, at read time, in memory). The gate needs THREE SCALARS. A
-- definer function narrows the PREDICATE as well as the projection; a column grant would
-- narrow only the projection and still let `aoa_app` enumerate every company's rows.
--
-- OWNERSHIP is load-bearing: migrations run as the database owner, and
-- 0214_e2_serving_role_hardening.sql:10,31 RAISEs if a serving role owns an application object.
--
-- search_path is pinned EMPTY and every relation is schema-qualified, so a caller's
-- search_path cannot redirect the body. pg_catalog stays implicitly resolvable.

CREATE OR REPLACE FUNCTION public.canary_preflight_evidence(p_company_id uuid, p_default_env_id uuid)
RETURNS TABLE (
  lease_id uuid,
  platform_default_environment_id uuid,
  key_generation text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH leases AS (
    SELECT l.id FROM public.environment_leases l WHERE l.company_id = p_company_id
  ),
  default_env AS (
    -- ★R2 COMPANY-SCOPED. Without `company_id = p_company_id` this is a cross-tenant
    -- existence oracle: a caller passing company A with company B's environment id gets
    -- B's row echoed back through an OWNER-authority function. Demonstrated empirically in
    -- review. `ensurePlatformDefaultEnvironmentRow` writes the row with that companyId
    -- (platform-default-environment.ts:186-204), so this predicate is behaviour-preserving.
    SELECT e.id FROM public.environments e
    WHERE e.id = p_default_env_id AND e.company_id = p_company_id
    LIMIT 1
  ),
  keygen AS (
    SELECT k.secret_id, v.version
    FROM public.runtime_provider_keys k
    JOIN LATERAL (
      SELECT cv.version FROM public.company_secret_versions cv
      WHERE cv.secret_id = k.secret_id AND cv.status = 'current'
      ORDER BY cv.version DESC LIMIT 1
    ) v ON TRUE
    WHERE k.company_id = p_company_id AND k.provider = 'e2b' AND k.is_default = TRUE
    LIMIT 1
  )
  SELECT leases.id,
         (SELECT id FROM default_env),
         (SELECT secret_id::text || ':' || version::text FROM keygen)
  FROM leases
  UNION ALL
  SELECT NULL::uuid,
         (SELECT id FROM default_env),
         (SELECT secret_id::text || ':' || version::text FROM keygen)
  WHERE NOT EXISTS (SELECT 1 FROM leases);
$$;

REVOKE ALL ON FUNCTION public.canary_preflight_evidence(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.canary_preflight_evidence(uuid, uuid) TO "aoa_app";
```

★ The `UNION ALL … WHERE NOT EXISTS` branch makes a **zero-lease** company still return one row carrying
the env and key-generation scalars. Without it the function returns no rows and the wrapper cannot tell
"no leases" from "no key generation" — resurrecting exactly the conflation this unit exists to remove.

★ **`INNER JOIN LATERAL` is deliberate.** A `runtime_provider_keys` row with no `status='current'`
version must yield **no** `keygen` row, so `key_generation` is `NULL` — matching
`deriveE2bKeyGeneration`, which returns `null` in that case (`e2b-credential-authority-wiring.ts:45`).
A `LEFT JOIN` would emit `secretId:` with a null version and change behaviour.

★ **The default-environment id is passed IN, and this is settled.**
`derive_platform_default_environment_id` does **not** exist in SQL (zero hits across
`packages/db/src/migrations/`); it is a TypeScript uuidv5 (`platform-default-environment.ts:109-111`).
A PL/pgSQL reimplementation would be a *second* derivation of a determinism-critical value and would
drift **silently**, because a mismatched id reads as "no default env" rather than raising.

- [ ] **Step 3: Apply, then verify the privilege boundary from a script**

```bash
cd /c/e3 && pnpm db:migrate
```

★R2 — the verification cannot be pasted into `psql` as literals, because the second argument is a
TypeScript-derived uuid. Run it as a script:

```bash
cd /c/e3 && npx tsx -e '
import postgres from "postgres";
import { derivePlatformDefaultEnvironmentId } from "./server/src/services/platform-default-environment.js";
const appSql = postgres(process.env.AOA_APP_DATABASE_URL!, { max: 1 });
const [co] = await appSql`SELECT id FROM companies LIMIT 1`;
const env = derivePlatformDefaultEnvironmentId(co.id);
console.log("evidence:", await appSql`SELECT * FROM public.canary_preflight_evidence(${co.id}::uuid, ${env}::uuid)`);
for (const t of ["company_secret_versions", "environment_leases", "environments", "runtime_provider_keys"]) {
  try { await appSql.unsafe(`SELECT * FROM ${t} LIMIT 1`); console.log("LEAK:", t); }
  catch (e) { console.log("still denied (correct):", t); }
}
await appSql.end();
'
```

Expected: the evidence call returns a row; **all four** tables still report `still denied (correct)`.
A `LEAK:` line means a grant crept in — stop and find it.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/migrations/
git commit -m "feat(cli-006): owner-owned SECURITY DEFINER evidence read for the canary preflight"
```

---

## Task 3: The typed wrapper, and rewiring the store

**Files:**
- Create: `server/src/services/canary-preflight-evidence.ts`
- Modify: `server/src/services/canary-preflight-store.ts` (imports + the three delegated members)
- Modify: `server/src/__tests__/cli-006-canary-preflight-store.test.ts` (★R2)

- [ ] **Step 1: Write the wrapper**

```ts
// server/src/services/canary-preflight-evidence.ts
//
// BLOCKER E. These reads cross a privilege boundary: `aoa_app` holds ZERO privileges on
// environment_leases / environments / runtime_provider_keys / company_secret_versions. They
// are served by an owner-owned SECURITY DEFINER function
// (migration <next>_canary_preflight_evidence_fn.sql) which narrows both the projection and
// the predicate — the return type structurally cannot carry secret material.
//
// ★R2 — NO ATOMICITY IS CLAIMED. The store calls this once per member, so a `check()` makes
// three round trips, exactly as the code it replaces did (three separate drizzle queries).
// Revision 1's "one round trip, so no torn read" comment was false and has been removed
// rather than papered over. If a future change needs a consistent snapshot across the three
// scalars, memoize per `check()` — do not assert consistency this code does not provide.

import { sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { derivePlatformDefaultEnvironmentId } from "./platform-default-environment.js";

type EvidenceRow = {
  lease_id: string | null;
  platform_default_environment_id: string | null;
  key_generation: string | null;
};

export type CanaryPreflightEvidence = {
  leaseIds: readonly string[];
  platformDefaultEnvironmentId: string | null;
  keyGeneration: string | null;
};

export async function readCanaryPreflightEvidence(
  db: Db,
  companyId: string,
): Promise<CanaryPreflightEvidence> {
  // The default-env id is derived HERE and passed in: it is a TypeScript uuidv5
  // (platform-default-environment.ts:109-111) with no SQL equivalent, and a second
  // derivation would drift silently (a mismatch reads as "no default env", not an error).
  const defaultEnvId = derivePlatformDefaultEnvironmentId(companyId);
  const result = await db.execute(
    sql`SELECT lease_id, platform_default_environment_id, key_generation
        FROM public.canary_preflight_evidence(${companyId}::uuid, ${defaultEnvId}::uuid)`,
  );
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as EvidenceRow[];
  return {
    leaseIds: rows.map((row) => row.lease_id).filter((id): id is string => id !== null),
    platformDefaultEnvironmentId: rows[0]?.platform_default_environment_id ?? null,
    keyGeneration: rows[0]?.key_generation ?? null,
  };
}
```

★ `db.execute` returns array-vs-`{rows}` depending on driver. The defensive unwrap handles both; do not
"simplify" it without checking which driver `appDb` uses.

- [ ] **Step 2: Rewire the store**

★R2 — fix the imports too, or this will not compile. In `canary-preflight-store.ts`:
**add** `import type { LegacyLeaseInput } from "./legacy-resource-reconciliation.js";` and
`import { readCanaryPreflightEvidence } from "./canary-preflight-evidence.js";`; **remove** the now-unused
`createDrizzleReconciliationStore` import and the `const reconciliation = …` line at `:33`.

Replace the three delegated members (`:73-76`):

```ts
    // BLOCKER E — these three no longer delegate to the reconciler's drizzle store, which
    // queries environment_leases / environments / runtime_provider_keys /
    // company_secret_versions DIRECTLY. This store runs on the NON-OWNER `aoa_app` pool and
    // is permission-denied on all four, so every call raised 42501 and the gate answered
    // `preflight_error`. The reads now go through the owner-owned SECURITY DEFINER function.
    //
    // The original delegation existed so the gate saw exactly the inventory the reconciler
    // recorded. That guarantee is PRESERVED: the function reads the same rows with the same
    // predicates. It changes WHO may read them, not WHAT is read.
    listLeases: async (companyId: string): Promise<readonly LegacyLeaseInput[]> => {
      const evidence = await readCanaryPreflightEvidence(db, companyId);
      // The gate consumes ONLY `lease.id`: `inventoryKeysForCompany`
      // (canary-preflight.ts:115-122) maps `resourceKeyForLease(lease.id)`, and
      // `resourceKeyForLease` is the identity function
      // (legacy-resource-reconciliation.ts:194-196). The other twelve fields on
      // LegacyLeaseInput serve the reconciler's classifier, which this gate never runs.
      return evidence.leaseIds.map((id) => ({ id }) as LegacyLeaseInput);
    },
    platformDefaultEnv: async (companyId: string) => {
      const evidence = await readCanaryPreflightEvidence(db, companyId);
      return evidence.platformDefaultEnvironmentId
        ? { environmentId: evidence.platformDefaultEnvironmentId }
        : null;
    },
    currentKeyGeneration: async (companyId: string) => {
      const evidence = await readCanaryPreflightEvidence(db, companyId);
      return evidence.keyGeneration;
    },
```

★ The `as LegacyLeaseInput` cast is a real narrowing. If a future change makes the gate read any field
beyond `id`, the cast becomes a runtime lie — Task 4 pins that.

- [ ] **Step 3 ★R2: Rewrite the store test that asserts the delegation you just removed**

`server/src/__tests__/cli-006-canary-preflight-store.test.ts:46-52` asserts **reference identity** for
exactly these three members against `createDrizzleReconciliationStore`'s, and its header (`:1-11`) argues
the delegation must never be forked. Three tests will fail **by design**. Do not leave them failing and
do not "fix" them by widening the drizzle mock.

Delete those three cases and replace with:

```ts
  it("routes the three privileged reads through the definer-function wrapper", async () => {
    // BLOCKER E inverted this file's original rationale. The delegation to
    // createDrizzleReconciliationStore was correct about WHAT to read and wrong about WHO
    // reads it: that store queries four tables the non-owner `aoa_app` pool cannot touch.
    // Reference identity with the reconciler's store is now the WRONG invariant.
    const store = createDrizzleCanaryPreflightStore({} as never);
    for (const member of ["listLeases", "platformDefaultEnv", "currentKeyGeneration"] as const) {
      expect(typeof store[member], member).toBe("function");
      expect(store[member], member).not.toBe(reconciliationStore[member]);
    }
  });
```

Then rewrite the file header `:1-11` to say why the delegation was removed. Test count is safe:
`scripts/test-inventory.json` records `server: {mode:"floor", count:1487}` and the tree measures 1493, so
`check-test-inventory` will not red.

- [ ] **Step 4: Run both test files**

```bash
cd /c/e3 && npx vitest run server/src/__tests__/cli-006-canary-preflight-store.test.ts
cd /c/e3 && AOA_RUN_WIN_INTEGRATION=1 npx vitest run server/src/__tests__/canary-preflight-real-role.integration.test.ts
```

Expected: store test passes; the integration test now reports **`2 passed`** — and confirm it says
`passed`, not `skipped`.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/canary-preflight-evidence.ts server/src/services/canary-preflight-store.ts \
        server/src/__tests__/cli-006-canary-preflight-store.test.ts
git commit -m "fix(cli-006): read canary preflight evidence through the definer function"
```

---

## Task 4: Pin the narrowing, so the cast cannot silently become a lie

**Files:**
- Modify: `server/src/__tests__/cli-006-canary-preflight.test.ts` (append a describe block)

- [ ] **Step 1: Write the test**

```ts
describe("BLOCKER E — the gate consumes only lease.id", () => {
  it("reaches a policy verdict when leases carry ONLY an id", async () => {
    // canary-preflight-store.ts constructs `{ id } as LegacyLeaseInput`. If the gate ever
    // reads another field it would see `undefined` in production while every fake-store test
    // kept passing. This asserts the narrowing the cast asserts.
    const gate = createCanaryPreflight({
      store: {
        listOrganizationCompanyIds: async () => ["co-1"],
        listLeases: async () => [{ id: "lease-1" } as never],
        platformDefaultEnv: async () => null,
        listRecords: async () => [],
        currentKeyGeneration: async () => "sec-1:1",
      },
    });

    const result = await gate.check({ organizationId: "org-1" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A key generation IS supplied here, so the gate gets past the credential check and
      // reaches closure — which is the branch that touches lease fields.
      expect(result.reason).toBe("reconciliation_incomplete");
    }
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd /c/e3 && npx vitest run server/src/__tests__/cli-006-canary-preflight.test.ts
```

Expected: PASS.

- [ ] **Step 3 ★R2: Mutation-check it — in a scope where the variable exists**

Revision 1 said to add `if (!lease.status) throw` "inside `inventoryKeysForCompany`". `lease` exists only
inside the `.map()` callback at `canary-preflight.ts:119`; anywhere else it is a `ReferenceError`, which
the catch at `:191-200` converts to `preflight_error` — the test would go red for the wrong reason and
look like a passing mutation check.

Put the mutation **inside the map callback**:

```ts
.map((lease) => { if (!(lease as { status?: string }).status) throw new Error("mutant"); return resourceKeyForLease(lease.id); })
```

Re-run: the test must report `reason: "preflight_error"` instead of `"reconciliation_incomplete"` — i.e.
**RED**. Revert. A guard that cannot go red is not a guard.

- [ ] **Step 4: Commit**

```bash
git add server/src/__tests__/cli-006-canary-preflight.test.ts
git commit -m "test(cli-006): pin that the gate consumes only lease.id"
```

---

## Task 5: The `prosecdef` certificate — close the blind spot the fix relies on

Task 2 works *only because* `assertExactServingRoleAuthority` scans tables, columns and sequences but
**never functions** (`grep prosecdef` returns zero hits repo-wide). Shipping the definer function without
a certificate turns a documented ACL model into one with an undocumented hole.

**Files:**
- Create: `server/src/db/security-definer-manifest.ts`
- Modify: `server/src/db/distributed-execution-databases.ts`
- Create: `server/src/__tests__/security-definer-manifest.test.ts`

- [ ] **Step 1: Write the manifest**

```ts
// server/src/db/security-definer-manifest.ts
//
// Every SECURITY DEFINER function in the application schema, as data.
//
// A definer function runs with the OWNER's authority regardless of caller, so it is the
// entire privilege-escalation surface that the table, column and sequence scans cannot see.
// Anything not listed here is drift.

export type SecurityDefinerFunction = {
  readonly schema: string;
  readonly name: string;
  /** `pg_get_function_identity_arguments` output, matched exactly. */
  readonly identityArguments: string;
  /** Why this function may hold owner authority. */
  readonly rationale: string;
};

export const SECURITY_DEFINER_FUNCTION_MANIFEST: readonly SecurityDefinerFunction[] = [
  {
    schema: "public",
    name: "canary_preflight_evidence",
    identityArguments: "p_company_id uuid, p_default_env_id uuid",
    rationale:
      "BLOCKER E. Returns three scalars the CLI-006 canary gate needs from tables the " +
      "non-owner aoa_app pool holds zero privileges on. Both arguments are company-scoped in " +
      "the body, and the return type structurally cannot carry company_secret_versions.material " +
      "or environment_leases.metadata.",
  },
];
```

- [ ] **Step 2: Write the scan**

Append to `server/src/db/distributed-execution-databases.ts` and call it from the same function that runs
the sequence scan (immediately after the block ending at `:336`). ★R2 — add
`import { SECURITY_DEFINER_FUNCTION_MANIFEST } from "./security-definer-manifest.js";` at the top;
`sql` and `rowsOf` are already in scope there.

```ts
// ★ Role-independent by construction: `prosecdef` is a property of the FUNCTION, not of the
// caller. It is invoked once per serving role only because that is where the existing
// assertion path runs; the `role` argument appears in the message for provenance, and the
// verdict is identical for both roles.
async function assertSecurityDefinerManifest(db: SqlExecutor, role: string): Promise<void> {
  // KEYED ON prosecdef, NOT effective EXECUTE. On a fleet with pgvector, `CREATE EXTENSION
  // vector` (no SCHEMA clause: 0038_marvelous_vapor.sql:1, 0115_enable_pgvector.sql:29)
  // installs ~100 functions into `public` carrying PostgreSQL's default PUBLIC EXECUTE, so an
  // EXECUTE-keyed certificate fails boot there. prosecdef is also the security-correct axis:
  // a SECURITY INVOKER function confers nothing beyond the caller's own authority.
  const rows = rowsOf<{ schema_name: string; function_name: string; identity_arguments: string }>(
    await db.execute(sql`
      SELECT
        namespace.nspname AS schema_name,
        proc.proname AS function_name,
        pg_get_function_identity_arguments(proc.oid) AS identity_arguments
      FROM pg_proc proc
      JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
      WHERE proc.prosecdef
        AND namespace.nspname <> 'information_schema'
        AND namespace.nspname NOT LIKE 'pg_%'
    `),
  );

  // Compare as SETS keyed by identity, never by sorted index: Postgres orders by
  // (nspname, proname, identity_arguments) while JS localeCompare orders differently, so
  // index pairing spuriously reds boot the moment a second definer function exists.
  const key = (s: string, n: string, a: string) => `${s}.${n}(${a})`;
  const allowed = new Set(
    SECURITY_DEFINER_FUNCTION_MANIFEST.map((fn) => key(fn.schema, fn.name, fn.identityArguments)),
  );
  const actual = new Set(rows.map((r) => key(r.schema_name, r.function_name, r.identity_arguments)));

  for (const found of actual) {
    if (!allowed.has(found)) {
      throw new Error(`${role} security-definer drift: unmanifested SECURITY DEFINER function ${found}`);
    }
  }
  for (const expected of allowed) {
    if (!actual.has(expected)) {
      throw new Error(`${role} security-definer drift: manifested SECURITY DEFINER function ${expected} is absent`);
    }
  }
}
```

★R2 — type the parameter `SqlExecutor` (`= Pick<Db,"execute">`, already defined at `:65` and used at
`:782`, `:800`, `:866`), matching the sibling scans.

- [ ] **Step 3 ★R2: Test the SCAN, not just the manifest array**

Revision 1 tested only properties of a constant — which cannot fail for any reason that matters. Exercise
the real query against a real database.

```ts
// server/src/__tests__/security-definer-manifest.test.ts
import { describe, expect, it } from "vitest";
import { SECURITY_DEFINER_FUNCTION_MANIFEST } from "../db/security-definer-manifest.js";

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

describe("SECURITY DEFINER manifest — shape", () => {
  it("lists the canary preflight evidence function exactly once", () => {
    const hits = SECURITY_DEFINER_FUNCTION_MANIFEST.filter((fn) => fn.name === "canary_preflight_evidence");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.identityArguments).toBe("p_company_id uuid, p_default_env_id uuid");
  });

  it("requires a rationale on every entry — owner authority is never granted silently", () => {
    for (const fn of SECURITY_DEFINER_FUNCTION_MANIFEST) {
      expect(fn.rationale.length, `${fn.name} has no rationale`).toBeGreaterThan(40);
    }
  });

  it("has no duplicate identities", () => {
    const keys = SECURITY_DEFINER_FUNCTION_MANIFEST.map((fn) => `${fn.schema}.${fn.name}(${fn.identityArguments})`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe.skipIf(!RUN)("SECURITY DEFINER manifest — the scan actually matches the database", () => {
  it("finds exactly the manifested set after migrations", async () => {
    const { db, teardown } = await startMigratedDatabase(); // embedded PG + applyPendingMigrations
    try {
      const rows = await db.execute(/* the same query as assertSecurityDefinerManifest */);
      const actual = new Set(rows.map((r) => `${r.schema_name}.${r.function_name}(${r.identity_arguments})`));
      const allowed = new Set(
        SECURITY_DEFINER_FUNCTION_MANIFEST.map((fn) => `${fn.schema}.${fn.name}(${fn.identityArguments})`),
      );
      expect(actual).toEqual(allowed);
    } finally {
      await teardown();
    }
  }, 120_000);

  it("REJECTS an unmanifested definer function", async () => {
    const { db, admin, teardown } = await startMigratedDatabase();
    try {
      await admin.unsafe(
        "CREATE FUNCTION public.mutant_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'",
      );
      // assertSecurityDefinerManifest must throw /unmanifested SECURITY DEFINER function/
      await expect(assertSecurityDefinerManifest(db, "aoa_app")).rejects.toThrow(/unmanifested/);
    } finally {
      await teardown();
    }
  }, 120_000);
});
```

★R2 — the second case is the mutation check, **automated**. Revision 1 asked the engineer to perform it
by hand; a hand-run check is not a regression guard.

★R2 — **do not attempt a "pgvector regression" proof on embedded-postgres.** The bundle ships no pgvector
and `0115_enable_pgvector.sql:28-32` no-ops via `DO $$ … EXCEPTION`, so such a test is structurally
incapable of failing on *every* lane, not just Windows. The pgvector hazard is handled by Constraint 2
(key on `prosecdef`) and is stated in the scan's comment; do not add a test that pretends to prove it.

- [ ] **Step 4: Run the startup assertion suite and confirm it RAN**

```bash
cd /c/e3 && AOA_RUN_WIN_INTEGRATION=1 npx vitest run server/src/__tests__/distributed-execution-db-startup.integration.test.ts
cd /c/e3 && AOA_RUN_WIN_INTEGRATION=1 npx vitest run server/src/__tests__/security-definer-manifest.test.ts
```

Expected: both PASS, and the summary must read `passed` — `73 skipped` means the gate was not lifted.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/security-definer-manifest.ts server/src/db/distributed-execution-databases.ts \
        server/src/__tests__/security-definer-manifest.test.ts
git commit -m "feat(e2): certificate the SECURITY DEFINER surface, keyed on prosecdef"
```

---

## Task 6: File E-2 and E-3 honestly, and correct the status

**Files:**
- Modify: `docs/replatform/qa/2026-08-31-campaign-blockers-and-fleet-terrain.md` (§9e.2)
- Modify: `docs/replatform/GO-BOOK.md`

- [ ] **Step 1: Record what shipped, with the CORRECT reason**

E-1 fixed; the gate now refuses **`credential_authority_not_moved`** (★R2 — *not*
`reconciliation_incomplete`; the key-generation check at `canary-preflight.ts:150-156` precedes closure,
and returns null for any company without a BYO e2b key). The canary **still cannot flip**. E-2 and E-3
remain open, with the evidence already in §9e.2.1.

- [ ] **Step 2: State the E-2/E-3 design question**

> `legacy-resource-reconciliation.ts:344-350` `continue`s past a lost-CAS paused lease *without recording
> it*, while `environments.ts:142` inserts a lease on **every** legacy cloud run. The pass's inventory is
> a strict subset of the gate's re-derived inventory **by construction**. Re-deriving live inventory
> against a batch-written crosswalk is a permanently-losing race on any box with traffic.
>
> **The question is not "who calls the reconciler" — it is what closure should mean.** Candidates:
> (a) freeze inventory at a watermark and assert closure only below it; (b) have the gate verify an
> *attestation* the pass emits rather than re-deriving inventory itself; (c) scope closure to leases
> predating the canary decision. Each changes what the gate promises. Pick deliberately.

- [ ] **Step 3: Run the doc checks and commit**

```bash
cd /c/e3 && node scripts/check-guard-inventory.mjs && node scripts/check-finding-ownership.mjs \
  && node scripts/check-ticket-graph-coverage.mjs
git add docs/replatform/
git commit -m "docs(campaign): E-1 fixed; E-2/E-3 remain — the canary is still gated shut"
```

---

## Task 7: Full verification before opening the PR

- [ ] **Step 1: Whole server suite, from the REPO ROOT, sharded — and gate on exit codes**

```bash
cd /c/e3 && rc=0; for s in 1 2 3 4; do npx vitest run --shard=$s/4 server/src/__tests__ || rc=1; done; echo "SUITE_RC=$rc"
```

★R2 — `SUITE_RC=0` is the pass condition. Revision 1 looped without capturing status, so a failing shard
scrolled past. Six tests are cwd-sensitive and fail only when vitest runs from `server/`.

- [ ] **Step 2: The policy suite — all 24 scripts, exit codes captured**

```bash
cd /c/e3 && for s in check-adapter-manager-boundary check-artifact-commit-vectors \
  check-boot-roots-browser-spawn-free check-boot-roots-provider-free check-d1-dispatch-declared \
  check-dependency-graph check-device-proof-vectors check-distributed-execution-foundation \
  check-execution-census check-finding-ownership check-gate-clause-wiring check-guard-inventory \
  check-sandbox-coding-disposition check-sandbox-e2b-provider-boundary check-sandbox-fake-provider-boundary \
  check-test-inventory check-ticket-graph-coverage check-worker-daemon-boundary check-worker-keystore-boundary \
  check-worker-path-parity check-worker-protocol-boundary check-workspace-patch-vectors \
  check-workspace-snapshot-vectors; do \
  node scripts/$s.mjs >/dev/null 2>&1 && echo "ok   $s" || echo "FAIL $s"; done
cd /c/e3 && pnpm check:frozen-worker-protocol-v1
```

★R2 — that is 23 scripts plus `check:frozen-worker-protocol-v1`; Revision 1 listed 16 and called it "the
whole policy suite". `check-embedded-secrets.mjs` takes a directory argument and is an artifact scan, not
a source check — it is not part of this gate. A new construction seam can red `check-gate-clause-wiring`
(it tracks symbol ref-counts); that is a real signal.

- [ ] **Step 3: Confirm the migration is journalled and no schema DDL was hand-authored**

```bash
cd /c/e3 && git diff --stat main -- packages/db/src/migrations/
```

★R2 — do **not** rely on `pnpm db:generate --check`; that flag reports schema drift, not journal
membership, and will not tell you what you want here. Inspect the diff: exactly one new `.sql` plus its
`meta/_journal.json` entry, containing only the function, its `REVOKE` and its `GRANT`.

- [ ] **Step 4: Open the PR against `docs/replatform-program`**

The PR body must carry the ⛔ section verbatim. A reviewer who skims must not come away believing the
canary is unblocked.

---

## Self-review of this plan (Revision 2)

**Spec coverage.** E-1 → Tasks 1-4. The definer blind spot → Task 5. E-2/E-3 → Task 6 (filed, not fixed).
Constraint 1 (RLS inversion) → no task wraps anything in `runInTenant`. Constraint 2 (pgvector) →
Task 5 Step 2's comment, and Step 3 explicitly *refuses* to fake a proof of it. Constraint 3 (no table
grants) → Task 2 Step 3 pins it negatively with a four-table leak check. Constraint 6 (skip gates) →
every integration command carries `AOA_RUN_WIN_INTEGRATION=1` plus a passed-not-skipped check.

**Placeholders.** None. The one conditional in Revision 1 (whether
`derive_platform_default_environment_id` exists in SQL) was resolved by inspection — it does not — and the
two-argument signature is now used consistently in the DDL, the `REVOKE`/`GRANT`, the verification
script, the wrapper, the manifest, and the manifest test.

**Type consistency.** `readCanaryPreflightEvidence` returns `{leaseIds, platformDefaultEnvironmentId,
keyGeneration}`; all three store members consume exactly those names. `CanaryPreflightStore`'s signatures
are unchanged, so `canary-preflight.ts` needs no edit. `assertSecurityDefinerManifest` takes
`SqlExecutor`, matching its sibling scans.

**Known residuals, stated rather than hidden.**
1. Three round trips per `check()` — parity with the code being replaced, and the false atomicity claim
   has been removed rather than the behaviour changed.
2. The scan's namespace filter (`nspname NOT LIKE 'pg_%'`) is broader than the manifest's `public`-only
   entries. Deliberate: a definer function appearing in a *new* schema is exactly the drift worth
   catching.
3. `security-definer-manifest.test.ts`'s integration cases need a `startMigratedDatabase()` helper. If
   one does not already exist in the harness, factor it out of
   `distributed-execution-db-startup.integration.test.ts` rather than writing a second bootstrap.
