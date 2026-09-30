# Codex #316 Follow-up Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the confirmed-open Codex findings on branch `claude/multitenant-cloud` in three batches. **Batch A** — company tenant-key immutability (Codex ①, schema `.omit` + service defensive strip) + provider-resolution dead-key try/catch (Codex ②). **Batch B** — break-glass org-scoping (Finding #1) + break-glass membership provenance (Finding #2) + a rotatable, hashed worker token so an execution-target row id is no longer a credential (Finding #3). **Batch C** — forward-migration hardening: org-scoped provider uniqueness, cutover member-backfill, secrets `organization_id` create-path stamp, plus a staged pre-0188 upgrade test.

**Architecture:** Cloud-only (`tenantIsolationEnforced()` / `deploymentMode === "cloud_auth"`) fixes; self-hosted (`local_trusted` / `authenticated`) behavior is preserved byte-for-byte throughout (each task cites why its path is cloud-only). Batch C uses NEW forward migrations (never edits to `0188`/`0189`/`0190`); schema defs are updated so `pnpm db:generate` stays no-drift.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM + PostgreSQL (embedded-postgres for integration tests), Zod, Vitest (jsdom + node), React + Vite.

**Source:** the Codex triage / problem map is in `tasks/wjuq8sf5z.output` (confirmed-open findings on `claude/multitenant-cloud`).

---

## Build order & constraints

**Recommended build order: A → B → C (mandatory).**

1. **Batch A first — code-only, no migration.** Three bite-sized TDD tasks (A1 → A2 → A3). Nothing here touches the migration journal, so it lands independently and de-risks the rest.
2. **Batch B second — mints the first two forward migrations.** Order B1 → B2 → B3 → B4 (B2 consumes B1's 4-arg signature; B4 consumes B3's column + migration). **B2 = `0193`** (`organization_memberships.created_by_break_glass`), **B3 = `0194`** (`execution_targets.worker_token_hash`).
3. **Batch C third — mints the next forward migration.** Order C1 → C2 → C3 → C4 → C5. **C = `0195`** (the folded provider-org-scoped-uniqueness DDL + cutover member-backfill + defensive secrets re-backfill DML). C4's staged upgrade test re-runs the same member-backfill DML C introduces, so C must land after B.

These three migrations are **consecutive** on top of the current journal tip `0192_thin_valkyrie` (idx 192): `0193` (B2) → `0194` (B3) → `0195` (C), keeping the journal chain clean and contiguous.

**Migration-number decision (resolves the BLK-1 collision).** Each draft was written assuming it minted `0193` next. They cannot both own `0193`. This plan assigns FIXED, non-overlapping numbers — **B2 = `0193`, B3 = `0194`, C = `0195`** — and every Batch-C `0193` reference has been rewritten to `0195`: the SQL filename (`0195_provider_org_scoped_uniqueness.sql`), the journal tag, the snapshot (`meta/0195_snapshot.json`), the contract-test filename (`migration-0195-provider-uniqueness-contract.test.ts`), the `startsWith("0195_")` / `0195_` regexes, the in-SQL comments, and the "Keep in sync with `0195_…`" strings in the C2/C4 integration tests. Do NOT fall back to the drafts' "whichever batch lands second re-runs `pnpm db:generate` to renumber" — C's number is baked into ~8 places including a test filename, so a floating renumber is unworkable; use the fixed numbers above.

**Hard constraints (do not violate):**

- **NEW forward migrations only.** Never edit `0188`/`0189`/`0190` (or any already-applied migration). `0193`/`0194`/`0195` do not yet exist anywhere, so they are free to author.
- **Schema-def updates keep `db:generate` no-drift.** B2/B3/C1 each edit the Drizzle schema `.ts` so the regenerated snapshot matches; after each, `pnpm db:generate` must print `No schema changes, nothing to migrate`.
- **Idempotent DML.** C1's constraint swap uses `DROP CONSTRAINT IF EXISTS` + a `DO $$ … duplicate_object` guarded `ADD`; C2's backfills use `ON CONFLICT DO NOTHING` / `WHERE … IS NULL`. B2/B3 are `ADD COLUMN` (not `CREATE TABLE/INDEX`, so `migration-idempotency.test.ts` never flags them and no `IF NOT EXISTS` hand-edit is needed).
- **Self-hosted unchanged.** Every fix is gated to `cloud_auth`, or is additive/mode-agnostic schema that self-hosted also carries.
- **Windows integration tests run via a temporary flip, then REVERT.** For each `*.integration.test.ts`: flip `describe.skipIf(process.platform !== "linux")` (or `=== "win32"`) → `skipIf(false)`, add `initdbFlags: ["--encoding=UTF8", "--locale=C"]` to the `new EmbeddedPostgres({…})` options (+ the `initdbFlags?: string[]` type field where the file declares a ctor type), run, then restore both edits by hand (never `git checkout` a file that also holds new test cases). C4 must additionally be committed with `RUN_BACKFILL = true`.
- **Any new `AOA_*` env var must be documented** in `docs/deploy/environment-variables.md` (brand-check guard 9). **None is introduced by any batch** — the worker token is minted at registration, not read from env; the C3 test only reads the already-documented `AOA_SECRETS_MASTER_KEY`.

**Cross-batch coordination (flagged by the reviewer):**

- **`packages/db/src/migrations/meta/_journal.json` is a shared-write file for B and C.** In the A → B → C order, B appends the `0193` and `0194` journal entries first, then C appends `0195` after them. Snapshots (`0193_snapshot.json`, `0194_snapshot.json`, `0195_snapshot.json`) are per-idx and do not collide once the numbers are fixed.
- **Does B's worker-token need a migration that must sequence with C?** Yes — B3 mints `0194` (`execution_targets.worker_token_hash`) and C mints `0195`, so they occupy consecutive journal slots and B must land before C. **No physical relocation of B3's migration into Batch C is required** (BLK-1 punch-list item 4): the migration stays where its schema change lives (B3); the only requirement is the fixed-number coordination above.
- **No source file is edited by two batches.** `authz.ts` is edited only by B1 (C4 merely imports `assertCompanyAccess` in a test). The only shared-write artifacts across batches are `meta/_journal.json` + the snapshots.
- **`migration-journal-contiguity.test.ts`** is the guard that catches a bad merge/renumber — run it after B and after C.

> **Reviewer punch-list folded in.** The blockers and should-fixes from the adversarial review (`review:codexfix-punchlist`) are applied inline in the batches below: BLK-1 (fixed migration numbers, above), BLK-2 (a B1 step updating `assert-company-access-tenant.test.ts` to the 4-arg call), SF-1 (C3 test raw-inserts a company instead of driving `companyService.create`), SF-2 (B3 rollout note on already-issued worker credentials), SF-3 (C1 generate/rename/replace/tag sub-checklist), and the A1/A3 citation nits.

---

# Batch A — 2 live must-fixes (cloud_auth / multi-tenant)

Worktree: `C:/Users/TK/.aoa/wt/mt-cloud`, branch `claude/multitenant-cloud` @ `83115cda`. All commands run **from the repo root**. Three independent TDD tasks; execute in order **A1 → A2 → A3**. A1+A2 are the two layers of Codex ① (schema + service defense-in-depth); A3 is Codex ②.

## Preconditions verified (do not re-litigate)
- No `*.integration.test.ts` in this batch → **no skipIf predicate flip / no initdbFlags** needed. A1 runs under the `packages/shared` node vitest project; A2/A3 are mock-based server unit tests. All run natively on Windows.
- **No new `AOA_*` env var** is introduced → **no `docs/deploy/environment-variables.md` change** (brand-check guard 9 not triggered).
- **Self-hosted / local_trusted unchanged.** A1/A2: `organizationId` on a company *update* was never a legitimate operation in any mode — only create sets it (`companies.ts:131`), and the only non-route update caller (`company-portability.ts:2207`) passes just `name/description/brandColor/requireBoardApprovalForNewAgents`. A3: the happy path is unchanged; only the previously-broken dead-key path changes (self-hosted → legacy/host fallback; multi-tenant → next candidate / `ProviderUnavailableError`).
- Run-command shapes confirmed live: `pnpm exec vitest run --root packages/shared <relpath>` and `pnpm exec vitest run --root server <relpath>` both work from repo root.
- A2 mock harness + A3 resolver test were run against the current (pre-fix) code: both fail exactly as the TDD "confirm-fail" steps below describe (A2 captured `.set()` payload contains `organizationId`; A3 rejects with `secret_not_found` at `provider-resolution.ts:369`). Harnesses proven; scratch files removed.

---

## TASK A1 — `updateCompanySchema` must omit the tenant key (Codex ①, schema layer)

**Files:**
- Impl: `packages/shared/src/validators/company.ts:30-45` (the `updateCompanySchema` definition; `organizationId` is inherited from `createCompanySchema` at `:19` via `.partial()` at `:31`).
- Test (NEW): `packages/shared/src/validators/company.test.ts`

**Why:** `updateCompanySchema = createCompanySchema.partial().extend(...)` inherits `organizationId`, so `PATCH /companies/:id` (`server/src/routes/companies.ts:328`, `validate(updateCompanySchema)`) accepts it. Zod strips unknown keys by default: the actual strip happens where the `validate()` middleware reassigns `req.body = schema.parse(req.body)` (`server/src/middleware/validate.ts:6` — NIT: not `routes/companies.ts`, which only imports the middleware), so omitting the key from the schema makes the route silently drop any `organizationId` in the body.

### Steps (strict TDD)

- [ ] **1. Write the failing test.** Create `packages/shared/src/validators/company.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createCompanySchema, updateCompanySchema } from "./company.js";

const ORG = "00000000-0000-0000-0000-0000000000a1";

describe("updateCompanySchema — tenant key (organizationId) is immutable on update", () => {
  it("strips organizationId from a PATCH body (never reparent a company cross-tenant)", () => {
    const parsed = updateCompanySchema.parse({ name: "Renamed", organizationId: ORG });
    expect(parsed).not.toHaveProperty("organizationId");
    expect(parsed.name).toBe("Renamed");
  });

  it("still accepts the other mutable update fields", () => {
    const parsed = updateCompanySchema.parse({
      vision: "V",
      requireBoardApprovalForNewAgents: true,
      budgetMonthlyCents: 5000,
    });
    expect(parsed).toMatchObject({
      vision: "V",
      requireBoardApprovalForNewAgents: true,
      budgetMonthlyCents: 5000,
    });
    expect(parsed).not.toHaveProperty("organizationId");
  });

  it("createCompanySchema still accepts organizationId (create-time tenant pick unchanged)", () => {
    const parsed = createCompanySchema.parse({ name: "New Co", organizationId: ORG });
    expect(parsed.organizationId).toBe(ORG);
  });
});
```

- [ ] **2. Run — confirm FAIL.**
  ```
  pnpm exec vitest run --root packages/shared src/validators/company.test.ts
  ```
  Expected: `Tests  1 failed | 2 passed (3)`. The failing one is "strips organizationId…" with `AssertionError: expected { name: 'Renamed', organizationId: '…a1' } to not have property "organizationId"`. (The other two pass pre-fix — they are non-regression guards.)

- [ ] **3. Minimal impl.** In `packages/shared/src/validators/company.ts`, insert `.omit({ organizationId: true })` **before** `.partial()`.

  Current (`:30-32`):
  ```ts
  export const updateCompanySchema = createCompanySchema
    .partial()
    .extend({
  ```
  New:
  ```ts
  export const updateCompanySchema = createCompanySchema
    // organizationId is the tenant key: set once at create, immutable thereafter.
    // Omit it BEFORE .partial() so PATCH /companies/:id can never accept it and
    // reparent a company across organizations (Codex ①). createCompanySchema is
    // untouched — create-time tenant pick in cloud_auth is unchanged.
    .omit({ organizationId: true })
    .partial()
    .extend({
  ```

- [ ] **4. Run — confirm PASS.**
  ```
  pnpm exec vitest run --root packages/shared src/validators/company.test.ts
  ```
  Expected: `Tests  3 passed (3)`.

- [ ] **5. Commit.**
  ```
  git add packages/shared/src/validators/company.ts packages/shared/src/validators/company.test.ts
  git commit -m "fix(cloud): make organizationId immutable on company update (Codex ①)"
  ```

---

## TASK A2 — `companyService.update` defensive strip (Codex ①, service layer)

**Files:**
- Impl: `server/src/services/companies.ts:252-258` (the `update` closure — `db.update(companies).set({ ...data, updatedAt })…`).
- Test (NEW): `server/src/__tests__/companies-update-tenant-immutable.test.ts`

**Why:** Defense-in-depth for any direct/non-route caller of the service. `.set({ ...data })` blind-spreads whatever it's given; the strip guarantees `organizationId` is never written on update even if a caller bypasses the route validator.

### Steps (strict TDD)

- [ ] **1. Write the failing test.** Create `server/src/__tests__/companies-update-tenant-immutable.test.ts` (mock harness proven to load `companies.ts` + capture the `.set()` payload):

```ts
import { describe, it, expect, vi } from "vitest";

// companies.ts imports these table names from @armyofagents/db. Vitest's named-
// export guard requires each accessed name to exist on the mock, so enumerate
// the full import list (hoisted so the vi.mock factory can read it).
const { DB_TABLES } = vi.hoisted(() => ({
  DB_TABLES: [
    "companies", "agents", "agentApiKeys", "agentConfigRevisions", "agentProjects",
    "agentRuntimeState", "agentTaskSessions", "agentWakeupRequests", "issues",
    "issueApprovals", "issueAttachments", "issueComments", "issueDocuments",
    "issueReadStates", "assets", "projects", "projectGoals", "projectWorkspaces",
    "executionWorkspaces", "goals", "heartbeatRuns", "heartbeatRunEvents",
    "heartbeatRunWatchdogDecisions", "costEvents", "financeEvents", "approvalComments",
    "approvals", "activityLog", "companySecrets", "companySkills", "documents",
    "documentRevisions", "feedbackExports", "feedbackVotes", "joinRequests", "invites",
    "notifications", "principalPermissionGrants", "companyMemberships", "mcpApiKeys",
    "mcpClientConnections", "workspaceOperations", "workspaceRuntimeServices",
  ] as string[],
}));

vi.mock("@armyofagents/db", () => {
  const stubs: Record<string, unknown> = {};
  for (const name of DB_TABLES) stubs[name] = { _tableName: name };
  return stubs;
});

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  count: (...a: unknown[]) => ({ count: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
  isNull: (...a: unknown[]) => ({ isNull: a }),
  sql: (...a: unknown[]) => a,
}));

import { companyService } from "../services/companies.js";

function makeCaptureDb(captured: { payload?: Record<string, unknown> }) {
  return {
    update: (_table: unknown) => ({
      set: (payload: Record<string, unknown>) => {
        captured.payload = payload;
        return {
          where: (..._a: unknown[]) => ({
            returning: () => ({
              then: (resolve: (rows: unknown[]) => unknown) =>
                Promise.resolve(resolve([{ id: "co-1", name: "Renamed" }])),
            }),
          }),
        };
      },
    }),
  };
}

describe("companyService.update — tenant key immutability (Codex ①)", () => {
  it("strips organizationId out of the .set() payload (no cross-tenant reparent)", async () => {
    const captured: { payload?: Record<string, unknown> } = {};
    const svc = companyService(makeCaptureDb(captured) as never);
    await svc.update("co-1", { name: "Renamed", organizationId: "other-tenant" } as never);
    expect(captured.payload).not.toHaveProperty("organizationId");
  });

  it("still writes the other mutable fields", async () => {
    const captured: { payload?: Record<string, unknown> } = {};
    const svc = companyService(makeCaptureDb(captured) as never);
    await svc.update("co-1", { name: "Renamed", vision: "V" } as never);
    expect(captured.payload).toMatchObject({ name: "Renamed", vision: "V" });
    expect(captured.payload).toHaveProperty("updatedAt");
  });
});
```

- [ ] **2. Run — confirm FAIL.**
  ```
  pnpm exec vitest run --root server src/__tests__/companies-update-tenant-immutable.test.ts
  ```
  Expected: `Tests  1 failed | 1 passed (2)`. The failing one is "strips organizationId…": `AssertionError: expected { name: 'Renamed', … } to not have property "organizationId"` / Received `"other-tenant"`. (The "still writes the other mutable fields" test passes pre-fix.)

- [ ] **3. Minimal impl.** In `server/src/services/companies.ts`, change the `update` closure to destructure-strip `organizationId` (mirrors the existing `heartbeat.ts:5706` `const { KEY: _strip, ...rest }` discard idiom — lint-safe with the `_`-prefix).

  Current (`:252-258`):
  ```ts
    update: (id: string, data: Partial<typeof companies.$inferInsert>) =>
      db
        .update(companies)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(companies.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  ```
  New:
  ```ts
    update: (id: string, data: Partial<typeof companies.$inferInsert>) => {
      // Tenant-key immutability (Codex ①): organizationId is assigned once at
      // create and must NEVER be rewritten by an update — a cross-tenant reparent
      // is a tenant-isolation breach. The update validator already omits it
      // (validators/company.ts); this strip is the defense-in-depth at the service
      // seam for any direct/non-route caller. No legitimate caller passes
      // organizationId here (company-portability import update passes only
      // name/description/brandColor/requireBoardApprovalForNewAgents).
      const { organizationId: _omitOrganizationId, ...mutable } = data;
      return db
        .update(companies)
        .set({ ...mutable, updatedAt: new Date() })
        .where(eq(companies.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  ```

- [ ] **4. Run — confirm PASS.**
  ```
  pnpm exec vitest run --root server src/__tests__/companies-update-tenant-immutable.test.ts
  ```
  Expected: `Tests  2 passed (2)`.

- [ ] **5. Commit.**
  ```
  git add server/src/services/companies.ts server/src/__tests__/companies-update-tenant-immutable.test.ts
  git commit -m "fix(cloud): strip organizationId in companyService.update (Codex ① defense-in-depth)"
  ```

---

## TASK A3 — guard the `secretRef` materialize against a dead-key lockout (Codex ②)

**Files:**
- Impl: `server/src/services/provider-resolution.ts:368-370` (the `else if (row.secretRef)` materialize branch — no try/catch, unlike the sibling `personal_subscription` branch at `:359-367` which catches → `lastRejection` → `continue`).
- Test (EXTEND existing): `server/src/__tests__/provider-resolution-resolve.test.ts` (already has the `makeDeps` + `args` fixtures and `describe("resolveProviderCredential", …)` block).

**Why:** `deps.resolveSecretValueForConnection` throws on a deleted/inactive/rotated secret (`provider-resolution-deps.ts:86`, cite approximate — this resolver is not load-bearing for the test, which mocks `resolveSecretValueForConnection` to throw). Because this branch has no try/catch, the throw propagates out of `resolveProviderCredential`, aborting the whole resolver — it skips the next candidate, the legacy fallback (`:399`), and the guided `ProviderUnavailableError` (`:422`). One dead higher-priority key locks the run out entirely.

### Steps (strict TDD)

- [ ] **1. Add the failing tests.** In `server/src/__tests__/provider-resolution-resolve.test.ts`, insert these two `it` blocks **inside** the existing `describe("resolveProviderCredential", () => { … })`, immediately before its closing `});` (currently at line 81). Uses the existing `makeDeps`/`args`/`vi`/`resolveProviderCredential` already imported at the top of the file:

```ts
  it("higher-priority secretRef throws (deleted secret) → skips + resolves via valid company_default (dead-key lockout fix — Codex ②)", async () => {
    const deps = makeDeps({
      loadCandidateRows: vi.fn(async () => [
        {
          connectionId: "conn-dead", authMethod: "api_key", scopeType: "agent_override",
          priority: 0, connectionUpdatedAt: 2, state: "verified", termsAttestedAt: new Date(),
          sharingPolicy: "company_agents", connectionCompanyId: "co1", connectionOwnerUserId: null,
          executionTargetId: null, config: {}, secretRef: "deleted-sec",
        },
        {
          connectionId: "conn-ok", authMethod: "api_key", scopeType: "company_default",
          priority: 0, connectionUpdatedAt: 1, state: "verified", termsAttestedAt: new Date(),
          sharingPolicy: "company_agents", connectionCompanyId: "co1", connectionOwnerUserId: null,
          executionTargetId: null, config: {}, secretRef: "sec-ok",
        },
      ]),
      resolveSecretValueForConnection: vi.fn(
        async (_db: unknown, row: { secretRef: string | null }) => {
          if (row.secretRef === "deleted-sec") throw new Error("secret_not_found");
          return "sk-company";
        },
      ),
    });
    const r = await resolveProviderCredential({} as never, args, deps as never);
    expect(r.source).toBe("connection");
    if (r.source === "connection") {
      expect(r.connectionId).toBe("conn-ok");
      expect(r.envPatch).toEqual({ ANTHROPIC_API_KEY: "sk-company" });
    }
  });

  it("sole secretRef candidate throws → continues to legacy fallback, never aborts (Codex ②)", async () => {
    const deps = makeDeps({
      loadCandidateRows: vi.fn(async () => [
        {
          connectionId: "conn-dead", authMethod: "api_key", scopeType: "company_default",
          priority: 0, connectionUpdatedAt: 1, state: "verified", termsAttestedAt: new Date(),
          sharingPolicy: "company_agents", connectionCompanyId: "co1", connectionOwnerUserId: null,
          executionTargetId: null, config: {}, secretRef: "deleted-sec",
        },
      ]),
      resolveSecretValueForConnection: vi.fn(async () => {
        throw new Error("secret_not_found");
      }),
    });
    const r = await resolveProviderCredential({} as never, args, deps as never);
    // makeDeps default selfHostedSingleTenant:true → a dead key falls through to
    // the legacy ladder instead of aborting the resolver.
    expect(r.source).toBe("legacy");
  });
```

- [ ] **2. Run — confirm FAIL.**
  ```
  pnpm exec vitest run --root server src/__tests__/provider-resolution-resolve.test.ts
  ```
  Expected: `Tests  2 failed | 4 passed (6)`. Both new tests reject with `Error: secret_not_found`, the stack pointing at `src/services/provider-resolution.ts:369:32` (the un-guarded `resolveSecretValueForConnection` call). The 4 pre-existing tests still pass.

- [ ] **3. Minimal impl.** In `server/src/services/provider-resolution.ts`, wrap the secretRef materialize in a try/catch mirroring the `personal_subscription` branch (`:359-367`).

  Current (`:368-370`):
  ```ts
      } else if (row.secretRef) {
        secretValue = await deps.resolveSecretValueForConnection(db, row, args);
      }
  ```
  New:
  ```ts
      } else if (row.secretRef) {
        // A throw here (deleted / inactive / rotated-away secret) is NOT fatal to
        // resolution — mirror the personal_subscription branch above: record the
        // rejection and try the NEXT candidate. Without this, one dead higher-
        // priority secretRef aborts the whole resolver, skipping the valid
        // company_default fallback + legacy ladder + guided ProviderUnavailableError
        // — a dead-key lockout (Codex ②).
        try {
          secretValue = await deps.resolveSecretValueForConnection(db, row, args);
        } catch (err) {
          lastRejection = {
            connectionId: row.connectionId,
            reason: err instanceof Error ? err.message : "secret_unavailable",
          };
          continue;
        }
      }
  ```

- [ ] **4. Run — confirm PASS.**
  ```
  pnpm exec vitest run --root server src/__tests__/provider-resolution-resolve.test.ts
  ```
  Expected: `Tests  6 passed (6)`.

- [ ] **5. Commit.**
  ```
  git add server/src/services/provider-resolution.ts server/src/__tests__/provider-resolution-resolve.test.ts
  git commit -m "fix(cloud): guard secretRef materialize against dead-key lockout (Codex ②)"
  ```

---

## Batch-close verification (after A1+A2+A3 committed)

- [ ] **Typecheck both touched packages** (from repo root):
  ```
  pnpm --filter @armyofagents/shared exec tsc --noEmit
  pnpm --filter @armyofagents/server exec tsc --noEmit
  ```
  Expected: no errors. (If the shared filter name differs, use `pnpm -r --filter ./packages/shared exec tsc --noEmit`; confirm exact package names via `pnpm -r list --depth -1` if needed.)
- [ ] **Re-run all three test files together** to confirm no cross-interference:
  ```
  pnpm exec vitest run --root packages/shared src/validators/company.test.ts
  pnpm exec vitest run --root server src/__tests__/companies-update-tenant-immutable.test.ts src/__tests__/provider-resolution-resolve.test.ts
  ```
  Expected: shared `3 passed`; server `8 passed` (2 A2 + 6 A3).
- [ ] `git status --porcelain` → clean (no stray scratch files).

---

# Batch B — Latent-security controls (PR #316 multi-tenant cloud)

Worktree under fix (you EDIT this one): `C:/Users/TK/.aoa/wt/mt-cloud`, branch `claude/multitenant-cloud` @ HEAD `83115cda`.
`cloud_auth === multi-tenant` (`tenantIsolationEnforced()` true iff `deploymentMode === "cloud_auth"`). All three fixes live in code that is only reached in `cloud_auth`; self-hosted / `local_trusted` never enters these paths (proof cited per task). Self-hosted behavior must stay byte-for-byte unchanged.

## Batch conventions (read once, apply to every task)

- **Invoke tests from repo ROOT.** Server: `pnpm exec vitest run --root server <relative-path-under-server>`. DB pkg: `pnpm exec vitest run --root packages/db <relative-path-under-packages/db>`. (Confirmed working: `pnpm exec vitest run --root server src/__tests__/operator-break-glass.test.ts` → `6 passed`.)
- **Server typecheck:** `pnpm --filter @armyofagents/server typecheck` (runs `tsc --noEmit`). **DB build+generate:** `pnpm db:generate` (runs `tsc -p packages/db/tsconfig.json && drizzle-kit generate`; offline, no DB needed).
- **Windows integration-test flip (temporary — REVERT before committing):** server `*.integration.test.ts` are platform-gated and Windows can't boot embedded-postgres by default. To run one on Windows:
  1. change the file's `describe.skipIf(...)` argument to `false`;
  2. in the `new EmbeddedPostgres({ ... })` options object add `initdbFlags: ["--encoding=UTF8", "--locale=C"],` and add `initdbFlags?: string[];` to that file's `EmbeddedPostgresCtor` options type so it typechecks;
  3. run the test; confirm result;
  4. `git checkout -- <file>` (or manually restore) so the COMMITTED file keeps the platform gate and has NO `initdbFlags`.
  Unit/route tests (`createSequenceDb`/value-carrying mocks/jsdom) run on Windows unmodified.
- **No new `AOA_*` env var is introduced anywhere in this batch** (the worker token is minted at registration, not read from env). Brand-check guard 9 (`docs/deploy/environment-variables.md`) is therefore N/A — do NOT add an env var.
- **Migration coordination — FIXED numbers (BLK-1 resolution; see *Build order & constraints*).** Because Batch B lands **before** Batch C, B2 owns migration `0193_*` (org_memberships column) and B3 owns `0194_*` (execution_targets column), on top of current tip `0192_thin_valkyrie`; Batch C then owns `0195`. These are FIXED assignments — do NOT use the drafts' "whichever batch lands second re-runs `pnpm db:generate` to renumber" flow (C's number is baked into ~8 places including a test filename, so a floating renumber is unworkable). `meta/_journal.json` is a shared-write file: B appends the `0193` + `0194` entries first, then C appends `0195`. Both of B's new migrations are `ALTER TABLE ... ADD COLUMN` only (no `CREATE TABLE/INDEX`), so `migration-idempotency.test.ts` needs no hand-edit of the generated SQL.
- Commit after each task with a message referencing the Codex finding. Do NOT push.

Execute tasks strictly in order **B1 → B2 → B3 → B4** (B2's integration file consumes B1's new signature; B4 consumes B3's schema column + migration).

---

## Task B1 — break-glass org-scoping (Finding #1)

**Bug.** `server/src/services/operator-break-glass.ts:83` — `hasActiveBreakGlass` selects only `companyId` and returns `rows.some(r => r.companyId === null || r.companyId === companyId)`. A `companyId = NULL` (org-wide) grant for org A therefore returns `true` for EVERY company in EVERY org. `authz.ts:73` calls it with only `(db, userId, companyId)`. `operator-break-glass.test.ts:212-229` currently asserts `toBe(true)` for `"any-other-company"` and thereby **codifies the bug**.

**Fix.** Thread the caller's already-resolved tenant org into `hasActiveBreakGlass` and scope the grant lookup to it in SQL. A `companyId = NULL` grant now matches ONLY when the grant's `organizationId` equals the requested company's owning org.

**Why self-hosted is unaffected.** `hasActiveBreakGlass` is reached only inside the `cloud_auth` branch of `assertCompanyAccess` (`authz.ts:67+`, after the `if (!tenantIsolationEnforced()) { ... return; }` early-return at `authz.ts:58-65`). Self-hosted returns before ever touching break-glass.

### Files

- Impl: `server/src/services/operator-break-glass.ts` (`hasActiveBreakGlass`, lines 62-84; doc-comment 62-67)
- Caller: `server/src/routes/authz.ts` (line 73; `tenantId` is resolved at line 68 and in scope)
- Unit test (drives RED→GREEN): `server/src/__tests__/operator-break-glass.test.ts` (const `ORG` line 132; codified-bug test 212-229; other call sites 181, 186, 205, 206, 209, 276, 281)
- Integration test (compile-fix only in B1): `server/src/__tests__/operator-break-glass.integration.test.ts` (call sites 132, 137, 159, 161)
- Pre-existing regression test (BLK-1 punch-list — must update): `server/src/__tests__/assert-company-access-tenant.test.ts` (line 29 asserts the OLD 3-arg `hasActiveBreakGlass` call; the 4-arg signature breaks it)

### Steps

- [ ] **RED — rewrite the codified-bug test.** In `operator-break-glass.test.ts`, replace the whole `it("org-wide grant (companyId null) matches ANY company", ...)` block (lines 212-229) with:
  ```ts
  it("org-wide grant (companyId null) matches any company IN ITS ORG — never another org", async () => {
    const db = makeFakeDb();
    const { deps } = makeDeps();
    const svc = operatorBreakGlassService(db, deps);

    await svc.grant({
      operatorUserId: "op2",
      organizationId: ORG, // org A
      companyId: null, // org-wide within org A
      role: "founder",
      reason: "x",
      grantedByUserId: "op2",
      ttlMinutes: 60,
    });

    // Any company whose owning org is ORG (org A) is authorized...
    expect(await hasActiveBreakGlass(db, "op2", CO, ORG)).toBe(true);
    expect(await hasActiveBreakGlass(db, "op2", "any-company-in-org-a", ORG)).toBe(true);
    // ...but a company in a DIFFERENT org must NOT be (Finding #1: a NULL-company
    // grant for org A used to authorize every company in every org).
    expect(await hasActiveBreakGlass(db, "op2", "co-in-org-b", "org-b")).toBe(false);
  });
  ```
  (The value-carrying `makeFakeDb` at lines 76-112 already evaluates `eq`/`and`/`isNull`/`gt` descriptors, and `grant()` stores `organizationId` on each fake row, so this fake models the new SQL WHERE faithfully.)
- [ ] **Run RED:** `pnpm exec vitest run --root server src/__tests__/operator-break-glass.test.ts`
      Expected: the suite FAILS on the new test — the `"co-in-org-b" ... toBe(false)` assertion gets `true` (current impl ignores org; extra 4th arg is silently dropped at runtime). Other 5 tests still pass.
- [ ] **GREEN — change the impl signature + SQL scope.** In `operator-break-glass.ts`, replace lines 68-84.
      Current:
      ```ts
      export async function hasActiveBreakGlass(
        db: Db,
        operatorUserId: string,
        companyId: string,
      ): Promise<boolean> {
        const rows = await db
          .select({ companyId: operatorBreakGlassGrants.companyId })
          .from(operatorBreakGlassGrants)
          .where(
            and(
              eq(operatorBreakGlassGrants.operatorUserId, operatorUserId),
              isNull(operatorBreakGlassGrants.revokedAt),
              gt(operatorBreakGlassGrants.expiresAt, new Date()),
            ),
          );
        return rows.some((r) => r.companyId === null || r.companyId === companyId);
      }
      ```
      New:
      ```ts
      export async function hasActiveBreakGlass(
        db: Db,
        operatorUserId: string,
        companyId: string,
        organizationId: string,
      ): Promise<boolean> {
        // Org-scope in SQL (Finding #1): an org-wide grant (company_id NULL)
        // authorizes ONLY the organization it was granted for — never every org.
        // Company-scoped grants still match by exact companyId within that org.
        const rows = await db
          .select({ companyId: operatorBreakGlassGrants.companyId })
          .from(operatorBreakGlassGrants)
          .where(
            and(
              eq(operatorBreakGlassGrants.operatorUserId, operatorUserId),
              eq(operatorBreakGlassGrants.organizationId, organizationId),
              isNull(operatorBreakGlassGrants.revokedAt),
              gt(operatorBreakGlassGrants.expiresAt, new Date()),
            ),
          );
        return rows.some((r) => r.companyId === null || r.companyId === companyId);
      }
      ```
      Also update the doc comment at lines 62-67: change the trailing sentence "An org-wide grant (company_id NULL) matches any company in the organization." → "An org-wide grant (company_id NULL) matches any company **in that same organization only** (org is scoped in the WHERE)."
- [ ] **GREEN — update the caller.** In `authz.ts`, replace lines 73-75.
      Current:
      ```ts
        if (req.actor.operator && req.actor.userId && (await hasActiveBreakGlass(db, req.actor.userId, companyId))) {
          return;
        }
      ```
      New:
      ```ts
        if (
          req.actor.operator &&
          req.actor.userId &&
          tenantId !== null &&
          (await hasActiveBreakGlass(db, req.actor.userId, companyId, tenantId))
        ) {
          return;
        }
      ```
      (`tenantId` from line 68. The `tenantId !== null` guard fails closed for an unknown company AND satisfies the `organizationId: string` type.)
- [ ] **GREEN — update the remaining unit call sites** in `operator-break-glass.test.ts` (add `, ORG` as the 4th arg):
      - line 181 `hasActiveBreakGlass(db, "op", CO)` → `hasActiveBreakGlass(db, "op", CO, ORG)`
      - line 186 `hasActiveBreakGlass(db, "op", CO)` → `hasActiveBreakGlass(db, "op", CO, ORG)`
      - line 205 `hasActiveBreakGlass(db, "op", CO)` → `hasActiveBreakGlass(db, "op", CO, ORG)`
      - line 206 `hasActiveBreakGlass(db, "op", "co-other")` → `hasActiveBreakGlass(db, "op", "co-other", ORG)` (still `false`: company-scoped grant for `CO` won't match `"co-other"`)
      - line 209 `hasActiveBreakGlass(db, "op", CO)` → `hasActiveBreakGlass(db, "op", CO, ORG)`
      - line 276 `hasActiveBreakGlass(db, "op2", CO)` → `hasActiveBreakGlass(db, "op2", CO, ORG)`
      - line 281 `hasActiveBreakGlass(db, "op2", CO)` → `hasActiveBreakGlass(db, "op2", CO, ORG)`
- [ ] **GREEN — compile-fix the integration call sites** in `operator-break-glass.integration.test.ts` (real proof is added in B2, but the file must typecheck now): add `, ORG` to the calls at lines 132, 137, 159, 161 (e.g. `hasActiveBreakGlass(db, "op", CO)` → `hasActiveBreakGlass(db, "op", CO, ORG)`; the `ORG` const already exists at line 36).
- [ ] **GREEN — fix the pre-existing regression test (BLK-1 punch-list).** `server/src/__tests__/assert-company-access-tenant.test.ts:29` asserts the OLD 3-arg call and will FAIL after the signature change (`toHaveBeenCalledWith` is exact-arity; typecheck does NOT catch it because the spy is an untyped `vi.fn`). Change:
      ```ts
      expect(hasActiveBreakGlass).toHaveBeenCalledWith(expect.anything(), "op", "c1");
      ```
      to (the tenant is `"org-1"` per the file's `db("org-1")` mock):
      ```ts
      expect(hasActiveBreakGlass).toHaveBeenCalledWith(expect.anything(), "op", "c1", "org-1");
      ```
      The other three referencing files are unaffected (`index.ts:1377` is a comment; `tenant-isolation-matrix.test.ts:11` and `assert-company-access-failclosed.test.ts:6` replace the symbol via untyped `vi.mock` factories). Run it to confirm GREEN: `pnpm exec vitest run --root server src/__tests__/assert-company-access-tenant.test.ts`.
- [ ] **Run GREEN:** `pnpm exec vitest run --root server src/__tests__/operator-break-glass.test.ts`
      Expected: `Test Files 1 passed` / `Tests 6 passed`.
- [ ] **Typecheck:** `pnpm --filter @armyofagents/server typecheck` → exit 0 (proves the caller + integration file compile against the new 4-arg signature).
- [ ] **Commit:** `fix(security): scope break-glass org-wide grants to their own org (Codex #1)`

---

## Task B2 — break-glass membership provenance (Finding #2)

**Bug.** `operator-break-glass.ts:191-206` (`realBreakGlassDeps`): `materializeMembership` inserts the org membership with `onConflictDoNothing()` (no provenance), while `revokeMembership` (and the sweeper via it) **unconditionally** `DELETE`s the `(org, user)` membership row. Two failure modes:
1. A user who is ALREADY an owner/admin of the org AND is granted break-glass loses their **real** membership when the grant expires/revokes.
2. Two overlapping grants to the same operator share one materialized row; the **first** to expire deletes it out from under the still-active second grant.

**Fix (marker + ref-count).** Ref-counting alone cannot distinguish a pre-existing real row from a break-glass-created one, so a persisted marker is required. Add `organization_memberships.created_by_break_glass boolean NOT NULL DEFAULT false`. `materializeMembership` inserts with the marker `true` (a pre-existing row hits `onConflictDoNothing` and keeps `false`). `revokeMembership` deletes ONLY a row it owns (`created_by_break_glass = true`) AND ONLY when no other still-active grant for `(org, operator)` needs it.

**Why self-hosted is unaffected.** Same as B1 — `realBreakGlassDeps`/materialize/revoke only run for cloud-operator grants; the sweeper is wired at `server/src/index.ts:1382` and processes only rows in `operator_break_glass_grants`, which self-hosted never creates.

### Files

- Schema: `packages/db/src/schema/organization_memberships.ts` (import line 1; add column after `status`, line 12-13)
- Migration (generated): `packages/db/src/migrations/0193_*.sql` + `meta/_journal.json` + `meta/*_snapshot.json`
- Impl: `server/src/services/operator-break-glass.ts` (`realBreakGlassDeps` materialize 191-196, revoke 197-206; NOTE comment 179-188)
- Integration test (RED→GREEN via Windows flip): `server/src/__tests__/operator-break-glass.integration.test.ts` (import `realBreakGlassDeps`; add consts + new `it`s; seeds in the file's `deps()`/`sql` style)

### Steps

- [ ] **RED — add integration cases** to `operator-break-glass.integration.test.ts`. First extend the import at line 21 to include `realBreakGlassDeps`:
      ```ts
      import { operatorBreakGlassService, hasActiveBreakGlass, realBreakGlassDeps } from "../services/operator-break-glass.js";
      ```
      Add consts near line 37:
      ```ts
      const ORG_B = "00000000-0000-0000-0000-0000000000a2";
      const CO_B = "00000000-0000-0000-0000-0000000000c2";
      ```
      Then, inside the `describe.skipIf(...)` block (after the existing `it`s), add THREE cases:
      ```ts
      it("an org-wide grant for org A does NOT authorize a company in org B (Finding #1, real DB)", async () => {
        if (setupError) throw new Error(String(setupError));
        await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ('opX','OpX','opx@x.invalid',now(),now()) ON CONFLICT DO NOTHING`);
        await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG_B}, 'Org B', 'org-b') ON CONFLICT DO NOTHING`);
        await db.execute(sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO_B}, 'Co B', 'PPB', ${ORG_B}) ON CONFLICT DO NOTHING`);
        const svc = operatorBreakGlassService(db, deps());
        await svc.grant({ operatorUserId: "opX", organizationId: ORG, companyId: null, role: "founder", reason: "x", grantedByUserId: "opX", ttlMinutes: 60 });
        expect(await hasActiveBreakGlass(db, "opX", CO, ORG)).toBe(true); // company in org A
        expect(await hasActiveBreakGlass(db, "opX", CO_B, ORG_B)).toBe(false); // company in org B — denied
      }, 90_000);

      it("a PRE-EXISTING org membership survives break-glass revoke (Finding #2)", async () => {
        if (setupError) throw new Error(String(setupError));
        await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ('op3','Op3','op3@x.invalid',now(),now()) ON CONFLICT DO NOTHING`);
        // Real standing owner membership — created_by_break_glass defaults false.
        await db.execute(sql`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES (${ORG}, 'op3', 'owner', 'active') ON CONFLICT (organization_id, user_id) DO NOTHING`);
        const svc = operatorBreakGlassService(db, realBreakGlassDeps(db)); // exercise the REAL deps
        await svc.grant({ operatorUserId: "op3", organizationId: ORG, companyId: null, role: "founder", reason: "SEV-1", grantedByUserId: "op3", ttlMinutes: 60 });
        await svc.revoke("op3", ORG);
        const rows = await db.execute(sql`SELECT role FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'op3'`);
        const arr = Array.isArray(rows) ? rows : (rows as any).rows;
        expect(arr.length).toBe(1); // pre-existing membership REMAINS
        expect(arr[0].role).toBe("owner"); // and is untouched
      }, 90_000);

      it("two overlapping grants: the first to expire keeps the shared row; the second removes it (Finding #2)", async () => {
        if (setupError) throw new Error(String(setupError));
        await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ('op4','Op4','op4@x.invalid',now(),now()) ON CONFLICT DO NOTHING`);
        const svc = operatorBreakGlassService(db, realBreakGlassDeps(db));
        const g1 = await svc.grant({ operatorUserId: "op4", organizationId: ORG, companyId: null, role: "founder", reason: "a", grantedByUserId: "op4", ttlMinutes: 60 });
        await svc.grant({ operatorUserId: "op4", organizationId: ORG, companyId: null, role: "founder", reason: "b", grantedByUserId: "op4", ttlMinutes: 60 });
        // Expire ONLY grant #1, then sweep — grant #2 still active.
        await db.execute(sql`UPDATE operator_break_glass_grants SET expires_at = now() - interval '1 minute' WHERE id = ${(g1 as any).id}`);
        await svc.sweepExpired();
        let rows = await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'op4'`);
        expect(count(rows)).toBe(1); // shared row survives while a grant is still active
        // Expire the rest, sweep again — now nobody needs the row.
        await db.execute(sql`UPDATE operator_break_glass_grants SET expires_at = now() - interval '1 minute' WHERE operator_user_id = 'op4'`);
        await svc.sweepExpired();
        rows = await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'op4'`);
        expect(count(rows)).toBe(0); // reclaimed once no active grant remains
      }, 90_000);
      ```
- [ ] **Run RED via the flip** (Batch conventions → flip; this file uses `describe.skipIf(process.platform !== "linux")` → set to `describe.skipIf(false)`; ctor type has no `initdbFlags` — add `initdbFlags?: string[];` to `EmbeddedPostgresCtor` opts and `initdbFlags: ["--encoding=UTF8", "--locale=C"],` to the `new EmbeddedPostgres({...})` at ~line 56):
      `pnpm exec vitest run --root server src/__tests__/operator-break-glass.integration.test.ts`
      Expected RED: the "PRE-EXISTING org membership survives" case FAILS with `expected 1, got 0` (current `revokeMembership` deletes unconditionally). The overlapping case also fails (`expected 1, got 0` at the first assertion). The org A/B case PASSES (B1 already fixed it). Keep the flip in place for the GREEN run.
- [ ] **GREEN — add the schema column.** In `organization_memberships.ts`, extend the import (line 1) to include `boolean`:
      ```ts
      import { pgTable, uuid, text, timestamp, index, uniqueIndex, check, boolean } from "drizzle-orm/pg-core";
      ```
      Add the column right after `status` (line 13):
      ```ts
        status: text("status").notNull().default("active"),
        // Provenance (Finding #2): true only for a row break-glass materialization
        // created. A pre-existing owner/admin row stays false and must never be
        // reclaimed by the sweeper.
        createdByBreakGlass: boolean("created_by_break_glass").notNull().default(false),
      ```
- [ ] **GREEN — generate the migration:** from repo root run `pnpm db:generate`.
      Expected: prints one new statement and writes `packages/db/src/migrations/0193_<name>.sql` containing exactly
      `ALTER TABLE "organization_memberships" ADD COLUMN "created_by_break_glass" boolean DEFAULT false NOT NULL;`
      plus updates `meta/_journal.json` (new entry `idx: 193`) and a new snapshot. Do NOT rename the file; do NOT hand-edit the SQL (ADD COLUMN needs no `IF NOT EXISTS`).
- [ ] **GREEN — fix `realBreakGlassDeps`.** In `operator-break-glass.ts`, replace `materializeMembership` (191-196) and `revokeMembership` (197-206).
      materialize new:
      ```ts
          materializeMembership: async ({ organizationId, userId, role }) => {
            await db
              .insert(organizationMemberships)
              .values({ organizationId, userId, role, status: "active", createdByBreakGlass: true })
              .onConflictDoNothing();
          },
      ```
      revoke new:
      ```ts
          revokeMembership: async ({ organizationId, userId }) => {
            // Provenance + ref-count (Finding #2): reclaim ONLY a row break-glass
            // itself created (created_by_break_glass = true), and ONLY when no other
            // still-active grant for this (organization, operator) needs it — two
            // overlapping grants share one materialized row.
            const active = await db
              .select({ id: operatorBreakGlassGrants.id })
              .from(operatorBreakGlassGrants)
              .where(
                and(
                  eq(operatorBreakGlassGrants.organizationId, organizationId),
                  eq(operatorBreakGlassGrants.operatorUserId, userId),
                  isNull(operatorBreakGlassGrants.revokedAt),
                  gt(operatorBreakGlassGrants.expiresAt, new Date()),
                ),
              );
            if (active.length > 0) return;
            await db
              .delete(organizationMemberships)
              .where(
                and(
                  eq(organizationMemberships.organizationId, organizationId),
                  eq(organizationMemberships.userId, userId),
                  eq(organizationMemberships.createdByBreakGlass, true),
                ),
              );
          },
      ```
      (`and`, `eq`, `gt`, `isNull` and both tables are already imported at lines 1-7 — no import changes.) Also rewrite the NOTE comment block at lines 179-188 to state the new contract: "revokeMembership reclaims ONLY the membership break-glass materialized (created_by_break_glass = true) and ONLY when no other active grant needs it; a pre-existing member's real row is never deleted."
      Sequencing note: after `revoke()` sets `revokedAt` on all active grants (lines 123-132) it calls `revokeMembership`, so the `active` query correctly sees zero and reclaims the marker row; the sweeper's live-TTL filter (`expires_at > now`) correctly excludes the just-expired grant it is processing.
- [ ] **Run GREEN (flip still applied):** `pnpm exec vitest run --root server src/__tests__/operator-break-glass.integration.test.ts`
      Expected: all cases pass (existing + the 3 new).
- [ ] **REVERT the flip** in `operator-break-glass.integration.test.ts`: `git checkout -- server/src/__tests__/operator-break-glass.integration.test.ts` would discard the NEW cases too — instead restore ONLY the two flip lines by hand: `describe.skipIf(false)` → `describe.skipIf(process.platform !== "linux")`, and remove `initdbFlags` from the ctor call + the `initdbFlags?: string[];` from the type. Confirm with `git diff` that the 3 new `it`s + 2 consts + import remain and no `initdbFlags`/`skipIf(false)` survive.
- [ ] **Migration gates + regression (Windows-visible):**
      - `pnpm exec vitest run --root packages/db src/__tests__/migration-journal-contiguity.test.ts` → `4 passed` (0193 contiguous + file-aligned).
      - `pnpm exec vitest run --root packages/db src/__tests__/migration-idempotency.test.ts` → passes (ADD COLUMN not gated).
      - `pnpm exec vitest run --root server src/__tests__/operator-break-glass.test.ts` → `6 passed` (B1 unit unaffected).
- [ ] **No-drift check:** re-run `pnpm db:generate` → expected `No schema changes, nothing to migrate` (0193 already captures the column).
- [ ] **Typecheck:** `pnpm --filter @armyofagents/server typecheck` → exit 0.
- [ ] **Commit:** `fix(security): give break-glass membership provenance so real/overlapping members survive expiry (Codex #2)`

---

## Task B3 — worker bearer-token: issue + verify a rotatable token (Finding #3, impl + unit)

**Bug.** `server/src/routes/execution-targets.ts:20-38` — `requireWorkerToken` accepts `Bearer <executionTargets.id>` (the DB row PK) and the heartbeat route mutates status/capabilities with no ownership proof beyond possessing that id. `environments.executionTargetId` is a real FK returned in the full env row by `environmentService.list/get` (`server/src/services/environments.ts:16-26`) to any company member (team_member included) → the PK-as-credential leaks.

**Fix.** Mint a SEPARATE rotatable worker token at registration; persist only its SHA-256 hash on the target row (`execution_targets.worker_token_hash`), return the plaintext ONCE in the create response. `requireWorkerToken` verifies by hashing the presented token and looking up the row; the row id no longer authorizes anything. `environmentService` needs NO change: the secret now lives on `execution_targets` (a table `environments` only references by id), so the leaked FK id is inert — proven in B4.

**Why self-hosted is unaffected.** `requireWorkerToken` has no deployment-mode branch; the change is mode-agnostic. In self-hosted the only execution target is the seeded control-plane row (`ensureControlPlaneExecutionTarget`, `execution-targets.ts:10-23`), which has `worker_token_hash = NULL` and never self-heartbeats.

**Rollout note (SF-2 — operational edge, pre-GA acceptable).** After the `worker_token_hash` column is added, any ALREADY-registered `dedicated_worker` row has `worker_token_hash = NULL`, so its old `Bearer <targetId>` credential stops authorizing (heartbeat → 401) until the worker is re-registered through the create route to mint a fresh token. This is fine pre-GA (no live external workers yet); state it in the release/rollout note so operators re-register any standing worker. Seeded/system control-plane rows correctly keep a NULL hash and can never self-heartbeat — no regression there.

### Files

- Schema: `packages/db/src/schema/execution_targets.ts` (import line 1; add column in the columns object ~line 26)
- Schema test (RED-first for the column): `packages/db/src/__tests__/execution-targets-schema.test.ts`
- Migration (generated): `packages/db/src/migrations/0194_*.sql` + `meta/_journal.json` + snapshot
- Service: `server/src/services/execution-targets.ts` (imports 1-3; add helpers; `listExecutionTargets` line 64)
- Route: `server/src/routes/execution-targets.ts` (import line 9; `UUID_RE` line 14; `requireWorkerToken` 16-38; create route 67-71; heartbeat mount line 91)
- Unit test (new, Windows-visible): `server/src/__tests__/execution-targets-worker-token.test.ts`

### Steps

- [ ] **RED #1 — schema column test.** In `execution-targets-schema.test.ts` add inside `describe("execution_targets schema", ...)`:
      ```ts
      it("carries a nullable worker_token_hash (hashed rotatable worker credential — never the row id)", () => {
        const cfg = getTableConfig(executionTargets);
        const col = cfg.columns.find((c) => c.name === "worker_token_hash");
        expect(col).toBeTruthy();
        expect(col!.notNull).toBe(false); // system/seeded rows have no token
      });
      ```
      Run RED: `pnpm exec vitest run --root packages/db src/__tests__/execution-targets-schema.test.ts` → FAILS (`col` is `undefined`).
- [ ] **GREEN #1 — add the column.** In `execution_targets.ts` add after `config` (line 26), before `lastSeenAt`:
      ```ts
        config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
        // Finding #3: rotatable worker credential — SHA-256 hash only; the plaintext
        // is returned once at registration. The row id is no longer a credential.
        workerTokenHash: text("worker_token_hash"),
      ```
      (`text` is already imported at line 1.)
      Run GREEN: `pnpm exec vitest run --root packages/db src/__tests__/execution-targets-schema.test.ts` → all pass.
- [ ] **RED #2 — worker-token unit test.** Create `server/src/__tests__/execution-targets-worker-token.test.ts`:
      ```ts
      import { describe, expect, it, vi } from "vitest";

      // Value-carrying drizzle mock so the fake DB can honour the hash predicate.
      vi.mock("drizzle-orm", () => ({
        eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
      }));
      vi.mock("@armyofagents/db", () => {
        const table = new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) });
        return { executionTargets: table };
      });

      import {
        createWorkerToken,
        hashWorkerToken,
        resolveWorkerTargetId,
        stripWorkerSecret,
      } from "../services/execution-targets.js";

      // select({id}).from().where({op:"eq",col:"workerTokenHash",val}) → matching ids.
      function makeFakeDb(rows: Array<{ id: string; workerTokenHash: string | null }>) {
        return {
          select: () => ({
            from: () => ({
              where: (clause: any) =>
                Promise.resolve(
                  rows
                    .filter((r) => clause.op === "eq" && (r as any)[clause.col] === clause.val)
                    .map((r) => ({ id: r.id })),
                ),
            }),
          }),
        } as any;
      }

      describe("worker-token helpers (Finding #3 — the row id is no longer the credential)", () => {
        it("createWorkerToken is prefixed + high-entropy; hashWorkerToken is deterministic and not the token", () => {
          const a = createWorkerToken();
          const b = createWorkerToken();
          expect(a).toMatch(/^aoa_wtk_[0-9a-f]{48}$/);
          expect(a).not.toBe(b);
          expect(hashWorkerToken(a)).toBe(hashWorkerToken(a));
          expect(hashWorkerToken(a)).not.toBe(a);
        });

        it("resolveWorkerTargetId returns the id for the matching token hash", async () => {
          const token = createWorkerToken();
          const db = makeFakeDb([{ id: "t-1", workerTokenHash: hashWorkerToken(token) }]);
          expect(await resolveWorkerTargetId(db, token)).toBe("t-1");
        });

        it("the raw target-id UUID no longer authorizes (its hash matches no row)", async () => {
          const token = createWorkerToken();
          const db = makeFakeDb([{ id: "t-1", workerTokenHash: hashWorkerToken(token) }]);
          expect(await resolveWorkerTargetId(db, "t-1")).toBeNull();
        });

        it("empty / unknown tokens resolve to null (fail closed)", async () => {
          const db = makeFakeDb([{ id: "t-1", workerTokenHash: hashWorkerToken("real") }]);
          expect(await resolveWorkerTargetId(db, "")).toBeNull();
          expect(await resolveWorkerTargetId(db, "   ")).toBeNull();
          expect(await resolveWorkerTargetId(db, "not-a-real-token")).toBeNull();
        });

        it("stripWorkerSecret removes only the hash, keeping the FK id", () => {
          const safe = stripWorkerSecret({ id: "t-1", organizationId: "org-A", workerTokenHash: "deadbeef" });
          expect(safe).toEqual({ id: "t-1", organizationId: "org-A" });
          expect("workerTokenHash" in safe).toBe(false);
        });
      });
      ```
      Run RED: `pnpm exec vitest run --root server src/__tests__/execution-targets-worker-token.test.ts` → FAILS (helpers not exported).
- [ ] **GREEN #2 — add the service helpers.** In `execution-targets.ts` change the imports (lines 1-3) to:
      ```ts
      import { createHash, randomBytes } from "node:crypto";
      import { eq } from "drizzle-orm";
      import type { Db } from "@armyofagents/db";
      import { executionTargets } from "@armyofagents/db";
      ```
      Add, directly below the imports (before `ensureControlPlaneExecutionTarget`):
      ```ts
      // Rotatable worker credential (Finding #3). The row id is NOT a credential;
      // this token is. Only its hash is persisted (execution_targets.worker_token_hash);
      // the plaintext is shown once at registration.
      export function createWorkerToken(): string {
        return `aoa_wtk_${randomBytes(24).toString("hex")}`;
      }
      export function hashWorkerToken(token: string): string {
        return createHash("sha256").update(token).digest("hex");
      }
      export async function resolveWorkerTargetId(db: Db, token: string): Promise<string | null> {
        const trimmed = token.trim();
        if (!trimmed) return null;
        const rows = await db
          .select({ id: executionTargets.id })
          .from(executionTargets)
          .where(eq(executionTargets.workerTokenHash, hashWorkerToken(trimmed)));
        return rows[0]?.id ?? null;
      }
      export function stripWorkerSecret<T extends { workerTokenHash?: unknown }>(row: T): Omit<T, "workerTokenHash"> {
        const { workerTokenHash: _omit, ...rest } = row;
        return rest;
      }
      ```
      Then defend the list path — change `listExecutionTargets`'s return (line 64) from:
      ```ts
        return db.select().from(executionTargets).where(eq(executionTargets.organizationId, organizationId));
      ```
      to:
      ```ts
        return (await db.select().from(executionTargets).where(eq(executionTargets.organizationId, organizationId))).map(
          stripWorkerSecret,
        );
      ```
      Run: `pnpm exec vitest run --root server src/__tests__/execution-targets-worker-token.test.ts` → all pass. Also re-run the existing `pnpm exec vitest run --root server src/__tests__/execution-targets-service.test.ts` → still `passed` (mock rows have no `workerTokenHash`, so `stripWorkerSecret` is a no-op there).
- [ ] **GREEN #2 — wire the route.** In `execution-targets.ts` (route) replace the import at line 9:
      ```ts
      import {
        createWorkerToken,
        hashWorkerToken,
        listExecutionTargets,
        registerWorkerHeartbeat,
        resolveWorkerTargetId,
        stripWorkerSecret,
      } from "../services/execution-targets.js";
      ```
      Delete `UUID_RE` (line 14 — it becomes unused). Replace the `requireWorkerToken` doc-comment + function (lines 16-38) with:
      ```ts
      /**
       * Worker self-auth (Finding #3). The bearer credential is a rotatable worker
       * token minted at registration; only its SHA-256 hash is stored on the target
       * row. We hash the presented token and resolve it to exactly one target id.
       * The row id itself is NO LONGER a credential.
       */
      function requireWorkerToken(db: Db) {
        return async (req: Request, res: Response, next: NextFunction) => {
          try {
            const header = req.header("authorization") ?? "";
            const match = /^Bearer\s+(.+)$/i.exec(header.trim());
            const token = match?.[1]?.trim();
            if (!token) {
              next(unauthorized());
              return;
            }
            const targetId = await resolveWorkerTargetId(db, token);
            if (!targetId) {
              next(unauthorized());
              return;
            }
            (req as Request & { workerTargetId?: string }).workerTargetId = targetId;
            next();
          } catch (err) {
            next(err);
          }
        };
      }
      ```
      In the create route, replace lines 67-71:
      ```ts
            const [row] = await opts.db
              .insert(executionTargets)
              .values({ organizationId: orgId, ...parsed.data })
              .returning();
            res.status(201).json(row);
      ```
      with:
      ```ts
            // Mint a rotatable worker credential: persist only its hash, return the
            // plaintext ONCE. The row id is no longer a credential (Finding #3).
            const workerToken = createWorkerToken();
            const [row] = await opts.db
              .insert(executionTargets)
              .values({ organizationId: orgId, ...parsed.data, workerTokenHash: hashWorkerToken(workerToken) })
              .returning();
            res.status(201).json({ ...stripWorkerSecret(row!), workerToken });
      ```
      Change the heartbeat mount (line 91) from `requireWorkerToken` to `requireWorkerToken(opts.db)`:
      ```ts
        router.post("/execution-targets/heartbeat", requireWorkerToken(opts.db), async (req, res, next) => {
      ```
- [ ] **GREEN #2 — generate the migration:** `pnpm db:generate`.
      Expected: writes `packages/db/src/migrations/0194_<name>.sql` = `ALTER TABLE "execution_targets" ADD COLUMN "worker_token_hash" text;` + `meta/_journal.json` entry `idx: 194` + snapshot. No hand-edit.
- [ ] **Migration gates + no-drift:**
      - `pnpm exec vitest run --root packages/db src/__tests__/migration-journal-contiguity.test.ts` → `4 passed` (0193+0194 contiguous).
      - `pnpm exec vitest run --root packages/db src/__tests__/migration-idempotency.test.ts` → passes.
      - `pnpm db:generate` again → `No schema changes, nothing to migrate`.
- [ ] **Typecheck:** `pnpm --filter @armyofagents/server typecheck` → exit 0 (confirms `UUID_RE` removal left no dangling ref and the route compiles).
- [ ] **Commit:** `fix(security): issue+hash a rotatable worker token so the execution-target row id is no longer a credential (Codex #3)`

---

## Task B4 — worker bearer-token: real-DB round-trip + env-leak-is-inert proof (Finding #3, integration)

Proves the fix end-to-end against real Postgres: an issued token authorizes; the raw row id does not; rotation invalidates the old token; and `environmentService` surfaces the `executionTargetId` FK but never any worker secret. Runs on Linux CI; on Windows use the flip.

### Files

- New: `server/src/__tests__/execution-targets-worker-token.integration.test.ts`

### Steps

- [ ] **RED — author the integration test** `server/src/__tests__/execution-targets-worker-token.integration.test.ts` (mirrors the inline embedded-pg bootstrap + `try/catch → setupError` pattern of `operator-break-glass.integration.test.ts`; committed form is Windows-skipped):
      ```ts
      // Real-Postgres proof for the rotatable worker token (Finding #3). The
      // execution-target row id is NO LONGER a credential; a separately-issued
      // token (hash stored, plaintext shown once) is. Also proves environmentService
      // surfaces the executionTargetId FK but never the worker secret.
      // Linux-only in CI (skipIf); Windows runs it via the temporary flip documented
      // in the batch plan. Windows-visible unit coverage lives in
      // execution-targets-worker-token.test.ts.
      import { afterAll, beforeAll, describe, expect, it } from "vitest";
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { sql } from "drizzle-orm";
      import { applyPendingMigrations, createDb, executionTargets, type Db } from "@armyofagents/db";
      import {
        createWorkerToken,
        hashWorkerToken,
        registerWorkerHeartbeat,
        resolveWorkerTargetId,
      } from "../services/execution-targets.js";
      import { environmentService } from "../services/environments.js";

      type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
      type EmbeddedPostgresCtor = new (opts: {
        databaseDir: string;
        user: string;
        password: string;
        port: number;
        persistent: boolean;
      }) => EmbeddedPostgresInstance;

      const ORG = "00000000-0000-0000-0000-0000000000d1";
      const CO = "00000000-0000-0000-0000-0000000000d2";
      const PORT = 56000 + Math.floor(Math.random() * 1000);

      let pg: EmbeddedPostgresInstance | null = null;
      let dataDir = "";
      let db: Db;
      let setupError: unknown = null;

      beforeAll(async () => {
        try {
          dataDir = await mkdtemp(join(tmpdir(), "aoa-wtk-"));
          const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
          pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
          await pg.initialise();
          await pg.start();
          const url = `postgres://test:test@localhost:${PORT}/postgres`;
          await applyPendingMigrations(url);
          db = createDb(url);
          await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org WTK', 'org-wtk')`);
          await db.execute(sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co WTK', 'WTK', ${ORG})`);
        } catch (e) {
          setupError = e;
        }
      }, 180_000);

      afterAll(async () => {
        try { if (pg) await pg.stop(); } catch { /* ignore */ }
        try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }, 60_000);

      describe.skipIf(process.platform === "win32")("worker token round-trip (real DB, Finding #3)", () => {
        it("an issued token authorizes; the raw row id does NOT", async () => {
          if (setupError) throw new Error(String(setupError));
          const token = createWorkerToken();
          const [row] = await db
            .insert(executionTargets)
            .values({ organizationId: ORG, slug: "wkr-1", kind: "dedicated_worker", trustClass: "dedicated_tenant", status: "offline", workerTokenHash: hashWorkerToken(token) })
            .returning();
          expect(await resolveWorkerTargetId(db, token)).toBe(row!.id); // token → id
          expect(await resolveWorkerTargetId(db, row!.id)).toBeNull(); // raw PK → nothing
          const { updated } = await registerWorkerHeartbeat(db, { targetId: row!.id, status: "active" });
          expect(updated).toBe(1);
        }, 90_000);

        it("rotating the token invalidates the old one", async () => {
          if (setupError) throw new Error(String(setupError));
          const token1 = createWorkerToken();
          const [row] = await db
            .insert(executionTargets)
            .values({ organizationId: ORG, slug: "wkr-2", kind: "dedicated_worker", trustClass: "dedicated_tenant", status: "offline", workerTokenHash: hashWorkerToken(token1) })
            .returning();
          const token2 = createWorkerToken();
          await db.execute(sql`UPDATE execution_targets SET worker_token_hash = ${hashWorkerToken(token2)} WHERE id = ${row!.id}`);
          expect(await resolveWorkerTargetId(db, token1)).toBeNull();
          expect(await resolveWorkerTargetId(db, token2)).toBe(row!.id);
        }, 90_000);

        it("environmentService exposes the executionTargetId FK but NEVER the worker secret", async () => {
          if (setupError) throw new Error(String(setupError));
          const token = createWorkerToken();
          const [target] = await db
            .insert(executionTargets)
            .values({ organizationId: ORG, slug: "wkr-3", kind: "dedicated_worker", trustClass: "dedicated_tenant", status: "active", workerTokenHash: hashWorkerToken(token) })
            .returning();
          await db.execute(sql`INSERT INTO environments (company_id, name, execution_target_id) VALUES (${CO}, 'prod', ${target!.id})`);
          const got = (await environmentService(db).list(CO))[0]! as Record<string, unknown>;
          expect(got.executionTargetId).toBe(target!.id); // FK id present (now inert)...
          expect("workerTokenHash" in got).toBe(false); // ...secret absent
          expect("workerToken" in got).toBe(false);
        }, 90_000);
      });
      ```
- [ ] **Run RED via the flip** (this file: `describe.skipIf(process.platform === "win32")` → `describe.skipIf(false)`; add `initdbFlags?: string[];` to `EmbeddedPostgresCtor` opts + `initdbFlags: ["--encoding=UTF8", "--locale=C"],` to `new EmbeddedPostgres({...})`):
      `pnpm exec vitest run --root server src/__tests__/execution-targets-worker-token.integration.test.ts`
      Expected: GREEN immediately (B3 already shipped the impl + migration 0194, which `applyPendingMigrations` picks up). This task is RED-authored but proves against the B3 impl; if any case fails, the fault is in B3 — fix there. (If you want a genuine RED first, run this file BEFORE B3's impl lands — out of order — otherwise treat B4 as the real-DB verification of B3.)
- [ ] **REVERT the flip** (restore the two lines to `describe.skipIf(process.platform === "win32")` and remove `initdbFlags` + its type field). `git diff` must show a Windows-skipped committed file with no `skipIf(false)`/`initdbFlags`.
- [ ] **Typecheck:** `pnpm --filter @armyofagents/server typecheck` → exit 0.
- [ ] **Commit:** `test(security): real-DB proof that the worker token — not the row id — authorizes heartbeats (Codex #3)`

---

## Batch-close verification

- [ ] `pnpm exec vitest run --root server src/__tests__/operator-break-glass.test.ts` → `6 passed`.
- [ ] `pnpm exec vitest run --root server src/__tests__/execution-targets-worker-token.test.ts` → `5 passed`.
- [ ] `pnpm exec vitest run --root server src/__tests__/execution-targets-service.test.ts` → passes (list path still scoped, no leak).
- [ ] `pnpm exec vitest run --root packages/db src/__tests__/execution-targets-schema.test.ts src/__tests__/migration-journal-contiguity.test.ts src/__tests__/migration-idempotency.test.ts` → all pass.
- [ ] `pnpm db:generate` → `No schema changes, nothing to migrate` (both columns captured).
- [ ] `pnpm --filter @armyofagents/server typecheck` → exit 0.
- [ ] Confirm the two integration files are committed in their platform-gated form (no `skipIf(false)`, no `initdbFlags`).
- [ ] Confirm no `AOA_*` env var was added (no `docs/deploy/environment-variables.md` change).

---

# Batch C — Migration hardening + upgrade test (AoA PR #316 multi-tenant cloud)

Worktree under test (READ-ONLY reference): `C:/Users/TK/.aoa/wt/mt-cloud`, branch `claude/multitenant-cloud` @ `83115cda`. Execute in a WRITABLE checkout of the same branch. `cloud_auth === multi-tenant`.

## Ground truth (verified by reading the code)

- **Highest existing migration = `0192_thin_valkyrie`** (journal idx 192 in `packages/db/src/migrations/meta/_journal.json:1350`). **Batch B lands before Batch C and mints `0193` (B2) + `0194` (B3), so Batch C's new forward migration number is `0195`** (journal idx 195) — see the BLK-1 fixed-number decision in *Build order & constraints*. Do NOT edit 0188/0189/0190 (forward-only; the branch's 0188–0192 may already be applied to a QA DB — 0193/0194/0195 do not yet exist anywhere, so they are free to author/edit).
- The two constraints in 0190 are **table CONSTRAINTS** (created inline in `CREATE TABLE`), so the fix is `ALTER TABLE ... DROP CONSTRAINT` / `ADD CONSTRAINT`, and `constraintExists()` in `packages/db/src/client.ts:349` reasons about them for manual-replay idempotency.
- `packages/db/src/schema/provider_connections.ts` holds BOTH `providerConnections` (identityUq at lines 83–91) and `providerAssignments` (scopeUq at lines 144–146).
- `assertCompanyAccess` (`server/src/routes/authz.ts:36`, the memberOk line is **:71**) requires, in cloud_auth: `tenantId !== null && orgs.includes(tenantId) && companyIds.includes(companyId)`. A user with company membership but NO org membership → `memberOk=false` → 403.
- 0188 (`0188_organizations.sql:92`) seeds org membership ONLY for instance_admins + one fallback founder.
- `secretService.create` (`server/src/services/secrets.ts:656`) inserts `companySecrets` without `organizationId` → new secrets are org-NULL. `company_secrets.organization_id` is a NULLABLE denormalized canary (`packages/db/src/schema/company_secrets.ts:12-14`), no FK, no default.
- **No new `AOA_*` env var is added by this batch** → brand-check guard 9 (`pnpm check:tokens`) is not triggered. `AOA_SECRETS_MASTER_KEY` (used by the C3 test) is ALREADY documented (`docs/deploy/environment-variables.md:113`).
- Self-hosted (`local_trusted`/`authenticated`) behavior is unchanged: the uniqueness fix only WIDENS keys, the member-backfill is idempotent data, the secrets fix stamps a column that self-hosted also has.

## Design decisions (locked)

1. **ONE folded forward migration `0195`** carries: (a) the org-scoped uniqueness DDL (C1) AND (b) the member-backfill + defensive secrets re-backfill DML (C2). Precedent: `0188_organizations.sql` folds DDL + data backfill in one file. This keeps the highest-idx journal entry with a real `0195_snapshot.json` (avoids the snapshot-gap ambiguity that DML-only migrations like 0110/0123 carry — those have NO snapshot).
2. **NOT NULL / FK on `company_secrets.organization_id` is DEFERRED** (see C3 rationale). C3 is a pure SERVICE change; 0195 adds a one-line defensive re-backfill of any org-NULL secrets as insurance.
3. Integration tests re-execute the migration's DML **verbatim** after seeding — the accepted pattern in this repo (`mt-combined-migrations.integration.test.ts:74-75,101`, `migration-0189-backfill.integration.test.ts:99-102`) because `applyPendingMigrations` has no "migrate to N then stop" seam.

## Windows execution note (applies to every `*.integration.test.ts` step)

Server integration tests are `skipIf(process.platform !== "linux")`-gated and use embedded-postgres, which fails `initdb` on Windows unless UTF-8/C locale is forced. To run one locally on Windows:
1. Temporarily change its `describe.skipIf(process.platform !== "linux")` → `describe.skipIf(false)`.
2. Temporarily add `initdbFlags: ["--encoding=UTF8", "--locale=C"]` to the `new EmbeddedPostgres({ ... })` options object.
3. Run it. **REVERT both edits before committing.**
Unit/contract tests (jsdom / `readFileSync` / no DB) run on Windows unmodified.

Invoke every test from the repo ROOT: `pnpm exec vitest run --root server <path-relative-to-server>` (or `--root packages/db` for the db idempotency test).

---

## Task C1 — 0195: org-scope the two provider uniqueness constraints

**Files:**
- `packages/db/src/schema/provider_connections.ts` — edit `providerConnections` identityUq (lines 83–91) and `providerAssignments` scopeUq (lines 144–146): prepend `table.organizationId` to `.on(...)`.
- `packages/db/src/migrations/0195_provider_org_scoped_uniqueness.sql` — NEW (generated by drizzle-kit, then renamed, then body replaced with idempotent hand-written SQL).
- `packages/db/src/migrations/meta/_journal.json` — the new idx-195 entry's `tag` set to `0195_provider_org_scoped_uniqueness`.
- `packages/db/src/migrations/meta/0195_snapshot.json` — NEW (generated; leave as-is).
- Test (Windows-visible, no DB): `server/src/__tests__/migration-0195-provider-uniqueness-contract.test.ts` — NEW (mirrors `migration-0189-contract.test.ts`).

**Steps (strict TDD):**

- [ ] **Write the failing contract test.** Create `server/src/__tests__/migration-0195-provider-uniqueness-contract.test.ts`:
```ts
// Static (cross-platform, Windows-visible) contract test for migration 0195.
// 0195 (multi-tenant cloud hardening) folds:
//   - org-scoping the two provider uniqueness constraints from 0190 (C1)
//   - the cutover member-backfill + defensive secrets re-backfill DML (C2)
// Reads the .sql text directly -- no DB needed.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migDir = fileURLToPath(new URL("../../../packages/db/src/migrations/", import.meta.url));

describe("migration 0195 contract", () => {
  const files = readdirSync(migDir).filter((f) => f.startsWith("0195_") && f.endsWith(".sql"));
  const file = files[0];
  const sqlText = file
    ? readFileSync(new URL(`../../../packages/db/src/migrations/${file}`, import.meta.url), "utf8")
    : "";

  it("exists as exactly one 0195 migration", () => {
    expect(files).toHaveLength(1);
  });

  it("re-creates provider_assignments_scope_uq with organization_id as the leading column", () => {
    expect(sqlText).toMatch(/DROP CONSTRAINT IF EXISTS "provider_assignments_scope_uq"/);
    expect(sqlText).toMatch(
      /ADD CONSTRAINT "provider_assignments_scope_uq" UNIQUE NULLS NOT DISTINCT\("organization_id","company_id","provider","scope_type","scope_id"\)/,
    );
  });

  it("re-creates provider_connections_identity_uq with organization_id as the leading column", () => {
    expect(sqlText).toMatch(/DROP CONSTRAINT IF EXISTS "provider_connections_identity_uq"/);
    expect(sqlText).toMatch(
      /ADD CONSTRAINT "provider_connections_identity_uq" UNIQUE NULLS NOT DISTINCT\("organization_id","company_id","provider","auth_method","owner_user_id","execution_target_id"\)/,
    );
  });
});
```
- [ ] **Run it — confirm RED** (no 0195 file yet → `files` length 0 → first assertion fails):
  `pnpm exec vitest run --root server src/__tests__/migration-0195-provider-uniqueness-contract.test.ts`
  Expected: `1 failed` (e.g. `expected [] to have a length of 1`).

- [ ] **Edit the schema** `packages/db/src/schema/provider_connections.ts`.
  `providerConnections` identityUq — CURRENT (lines 81–91):
```ts
    // Identity — mirrors provider_credentials_identity_uq. nullsNotDistinct so a
    // second company-scoped api_key (owner NULL / target NULL) cannot duplicate.
    identityUq: unique("provider_connections_identity_uq")
      .on(
        table.companyId,
        table.provider,
        table.authMethod,
        table.ownerUserId,
        table.executionTargetId,
      )
      .nullsNotDistinct(),
```
  NEW:
```ts
    // Identity — mirrors provider_credentials_identity_uq. nullsNotDistinct so a
    // second company-scoped api_key (owner NULL / target NULL) cannot duplicate.
    // organization_id LEADS the key (0195): org-level connections carry company_id
    // NULL, so without it two tenants' org-level api_keys collapse to one row per
    // provider per install under NULLS NOT DISTINCT.
    identityUq: unique("provider_connections_identity_uq")
      .on(
        table.organizationId,
        table.companyId,
        table.provider,
        table.authMethod,
        table.ownerUserId,
        table.executionTargetId,
      )
      .nullsNotDistinct(),
```
  `providerAssignments` scopeUq — CURRENT (lines 142–146):
```ts
    // nullsNotDistinct REQUIRED so a second company_default (scope_id NULL) cannot
    // be minted (same reason as provider_readiness_scope_uq, PG15+).
    scopeUq: unique("provider_assignments_scope_uq")
      .on(table.companyId, table.provider, table.scopeType, table.scopeId)
      .nullsNotDistinct(),
```
  NEW:
```ts
    // nullsNotDistinct REQUIRED so a second company_default (scope_id NULL) cannot
    // be minted (same reason as provider_readiness_scope_uq, PG15+). organization_id
    // LEADS the key (0195): org_default rows carry company_id NULL, so without it
    // two tenants' org_default assignments collapse to one row per provider.
    scopeUq: unique("provider_assignments_scope_uq")
      .on(table.organizationId, table.companyId, table.provider, table.scopeType, table.scopeId)
      .nullsNotDistinct(),
```

> **SF-3 — the generate → rename → replace-body → fix-tag sequence is the highest-risk part of this batch.** A missed rename or a tag that doesn't match the `.sql` filename means the runtime migrator (which reads the journal `tag` → loads `<tag>.sql`) can't find the file. Treat the four steps below as one atomic sub-checklist and verify with `git status --porcelain` before AND after: assert exactly ONE new `0195_*.sql` and ONE new `meta/0195_snapshot.json` appear, and after the rename assert the journal `tag` string equals the on-disk `.sql` basename (minus extension). The no-drift reasoning is sound — drizzle diffs schema→snapshot, not SQL text — so replacing the generated SQL body does not reintroduce drift.

- [ ] **Generate the migration:** from repo root run `pnpm db:generate` (= `pnpm --filter @armyofagents/db generate`; compiles schema to `dist/` then `drizzle-kit generate`). Expected: prints a new file, e.g. `Your SQL migration file ➜ src/migrations/0195_<random>.sql`. It also writes `meta/0195_snapshot.json` and appends idx-195 to `meta/_journal.json`.

- [ ] **Confirm exactly one new 0195 sql appeared** and capture its name:
  `git status --porcelain packages/db/src/migrations` (expect EXACTLY one new `0195_*.sql`, EXACTLY one new `meta/0195_snapshot.json`, and a modified `meta/_journal.json` — nothing else new).

- [ ] **Rename the sql + fix the journal tag.** Rename `packages/db/src/migrations/0195_<random>.sql` → `packages/db/src/migrations/0195_provider_org_scoped_uniqueness.sql`. In `meta/_journal.json`, change the idx-195 entry's `"tag"` from `"0195_<random>"` to `"0195_provider_org_scoped_uniqueness"`. (Leave `meta/0195_snapshot.json` filename untouched — snapshots are idx-named, not tag-named; precedent: 0187's tag is `0187_daily_liz_osborn` but its snapshot is `0187_snapshot.json`.)

- [ ] **Verify the rename stuck.** `ls packages/db/src/migrations/0195_*.sql` shows exactly `0195_provider_org_scoped_uniqueness.sql` (no stray `0195_<random>.sql`), and the idx-195 `tag` in `meta/_journal.json` equals `0195_provider_org_scoped_uniqueness` (matches the filename basename). A mismatch here is the single most common way this migration fails to load at runtime.

- [ ] **Replace the sql body** of `0195_provider_org_scoped_uniqueness.sql` entirely (drizzle's generated DROP/ADD is not replay-idempotent). The snapshot already encodes the new key columns, so any SQL that reaches the same final schema keeps `db:generate` no-drift. Content:
```sql
-- 0195 (multi-tenant cloud hardening): org-scope the two provider uniqueness
-- constraints introduced by 0190. Before this, provider_assignments_scope_uq and
-- provider_connections_identity_uq omit organization_id, so org-level rows
-- (company_id NULL) collapse to ONE row per provider per INSTALL under
-- NULLS NOT DISTINCT -- a second tenant could never mint its own org_default
-- assignment or org-level connection. Adding organization_id as the LEADING
-- column strictly WIDENS the key (can only reduce collisions), so it is safe on
-- populated data. Idempotent: DROP ... IF EXISTS + guarded ADD (duplicate_object).
ALTER TABLE "provider_assignments" DROP CONSTRAINT IF EXISTS "provider_assignments_scope_uq";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_scope_uq" UNIQUE NULLS NOT DISTINCT("organization_id","company_id","provider","scope_type","scope_id");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "provider_connections" DROP CONSTRAINT IF EXISTS "provider_connections_identity_uq";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_identity_uq" UNIQUE NULLS NOT DISTINCT("organization_id","company_id","provider","auth_method","owner_user_id","execution_target_id");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;
```
  (Note: `DROP CONSTRAINT IF EXISTS` and `ADD CONSTRAINT` are ALTERs, not `CREATE TABLE/INDEX`, so the `migration-idempotency.test.ts` grep does not apply; the DO-block ADD mirrors the 0137 replay-guard precedent.)

- [ ] **Run the contract test — confirm GREEN:**
  `pnpm exec vitest run --root server src/__tests__/migration-0195-provider-uniqueness-contract.test.ts`
  Expected: `Test Files 1 passed`, `Tests 3 passed`. (The 3rd `it` for the leading column of identity_uq passes; the C2 member-backfill assertions are added in C2.)

- [ ] **Verify no schema drift** (the whole point of updating the schema defs): `pnpm db:generate`
  Expected: `No schema changes, nothing to migrate` and NO new `.sql` under `packages/db/src/migrations`. Confirm with `git status --porcelain packages/db/src/migrations` showing no unexpected new file.

- [ ] **Commit:** `feat(db): org-scope provider uniqueness constraints (0195)`

---

## Task C2 — 0195: cutover member-backfill (+ defensive secrets re-backfill)

**Files:**
- `packages/db/src/migrations/0195_provider_org_scoped_uniqueness.sql` — APPEND two idempotent DML statements to the file authored in C1.
- `server/src/__tests__/migration-0195-provider-uniqueness-contract.test.ts` — extend with the member-backfill static assertion.
- Test (integration, Linux / Windows-flip): `server/src/__tests__/organization-member-backfill.integration.test.ts` — NEW (harness mirrors `migration-0189-backfill.integration.test.ts`).

**Steps (strict TDD):**

- [ ] **Write the failing integration test.** Create `server/src/__tests__/organization-member-backfill.integration.test.ts`:
```ts
// Real-Postgres proof for the 0195 cutover member-backfill (multi-tenant cloud).
// 0188 seeded org membership ONLY for instance_admins. cloud_auth
// assertCompanyAccess (server/src/routes/authz.ts:71) needs BOTH an active org
// membership AND a company membership, so every NON-admin member would 403 after
// cutover. 0195 grants each active company member an 'active' 'member' row in the
// company's organization. This test seeds the pre-cutover shape (company members,
// NO org memberships) and re-runs the migration's INSERT verbatim (idempotent),
// exactly as migration-0189-backfill.integration.test.ts re-runs 0189's UPDATE.
//
// Linux-only (skipIf); Windows flip: skipIf(false) + initdbFlags, then revert.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as any).rows) as any[];

// Keep in sync with 0195_provider_org_scoped_uniqueness.sql (the member-backfill INSERT).
const MEMBER_BACKFILL_SQL = `
INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status", "joined_at")
SELECT DISTINCT c."organization_id", cm."principal_id", 'member', 'active', now()
FROM "company_memberships" cm
JOIN "companies" c ON c."id" = cm."company_id"
JOIN "user" u ON u."id" = cm."principal_id"
WHERE cm."principal_type" = 'user'
  AND cm."status" = 'active'
ON CONFLICT ("organization_id", "user_id") DO NOTHING`;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-0195-member-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false });
    await pg.initialise();
    await pg.start();
    const url = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[0195-member-backfill] setup failed:", e);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")("0195 member backfill", () => {
  const ORG = DEFAULT_ORGANIZATION_ID;
  const U_MEMBER = "u-nonadmin-1";
  const U_OWNER = "u-owner-1";

  it("grants every active company member an org 'member' row; keeps existing owners", async () => {
    if (setupError) throw new Error(String(setupError));

    // Seed the pre-cutover shape: users + a company on the sentinel org + active
    // company memberships, and NO org memberships for the non-admin member.
    await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (${U_MEMBER}, 'Member', 'm@x.invalid', now(), now())`);
    await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (${U_OWNER}, 'Owner', 'o@x.invalid', now(), now())`);
    const co = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('Cutover Co', 'CUT', ${ORG}) RETURNING id`))[0].id;
    await db.execute(sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status) VALUES (${co}, 'user', ${U_MEMBER}, 'active')`);
    await db.execute(sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status) VALUES (${co}, 'user', ${U_OWNER}, 'active')`);
    // U_OWNER already has an OWNER org membership (as 0188 would have seeded for an admin).
    await db.execute(sql`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES (${ORG}, ${U_OWNER}, 'owner', 'active')`);

    // Sanity: the non-admin member has NO org membership yet.
    const before = rows(await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = ${U_MEMBER}`));
    expect(before[0].c).toBe(0);

    // Run the migration's backfill statement verbatim.
    await db.execute(sql.raw(MEMBER_BACKFILL_SQL));

    // The non-admin member is now an ACTIVE 'member' of the org.
    const member = rows(await db.execute(sql`SELECT role, status FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = ${U_MEMBER}`));
    expect(member).toHaveLength(1);
    expect(member[0].role).toBe("member");
    expect(member[0].status).toBe("active");

    // The pre-existing owner is NOT downgraded (ON CONFLICT DO NOTHING).
    const owner = rows(await db.execute(sql`SELECT role FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = ${U_OWNER}`));
    expect(owner).toHaveLength(1);
    expect(owner[0].role).toBe("owner");
  }, 90_000);

  it("is idempotent: a second run creates no duplicate rows", async () => {
    await db.execute(sql.raw(MEMBER_BACKFILL_SQL));
    const member = rows(await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = ${U_MEMBER}`));
    expect(member[0].c).toBe(1);
  }, 90_000);
});
```
- [ ] **Run it — confirm RED.** With the Windows flip (skipIf(false) + initdbFlags) if on Windows:
  `pnpm exec vitest run --root server src/__tests__/organization-member-backfill.integration.test.ts`
  Expected: FAIL — the `MEMBER_BACKFILL_SQL` INSERT throws because the 0195 migration does not yet contain the member-backfill DML? No — the SQL string is self-contained in the test, so it would actually PASS prematurely. To get a genuine RED here, the RED signal for C2 is the **contract-test assertion** (next bullet). Treat this integration test as the behavioral proof that goes GREEN once the DML lands in 0195; run it now and confirm it passes against the seeded rows (it exercises the exact statement 0195 will ship). If it errors on setup, fix setup before proceeding.

- [ ] **Add the RED contract assertion.** In `server/src/__tests__/migration-0195-provider-uniqueness-contract.test.ts`, append inside the `describe`:
```ts
  it("includes the cutover member-backfill INSERT into organization_memberships", () => {
    expect(sqlText).toMatch(/INSERT INTO "organization_memberships"[\s\S]*FROM "company_memberships" cm/);
    expect(sqlText).toMatch(/ON CONFLICT \("organization_id", "user_id"\) DO NOTHING/);
  });

  it("includes the defensive company_secrets.organization_id re-backfill", () => {
    expect(sqlText).toMatch(/UPDATE "company_secrets" SET "organization_id" = c\."organization_id" FROM "companies" c/);
  });
```
  Run the contract test — confirm these two new cases are RED:
  `pnpm exec vitest run --root server src/__tests__/migration-0195-provider-uniqueness-contract.test.ts`
  Expected: `2 failed` (the member-backfill + re-backfill assertions), the 3 C1 cases still pass.

- [ ] **Append the DML to 0195.** Add to the END of `packages/db/src/migrations/0195_provider_org_scoped_uniqueness.sql` (add a `--> statement-breakpoint` after the last C1 DO-block first):
```sql
--> statement-breakpoint
-- Cutover member backfill (multi-tenant cloud): 0188 seeded org membership ONLY
-- for instance_admins (+ one fallback founder). cloud_auth assertCompanyAccess
-- (server/src/routes/authz.ts:71) requires BOTH an active org membership AND a
-- company membership, so on an existing multi-user install every NON-admin
-- member would 403 after cutover. Grant every active company member (principal
-- 'user') an 'active' 'member' row in that company's organization. JOIN "user"
-- guards the FK (organization_memberships.user_id -> user.id). Idempotent
-- (ON CONFLICT DO NOTHING on organization_memberships_org_user_uq); NEVER
-- downgrades an existing owner/admin (conflict skipped). DISTINCT collapses a
-- user who belongs to multiple companies in the SAME org to one row.
INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status", "joined_at")
SELECT DISTINCT c."organization_id", cm."principal_id", 'member', 'active', now()
FROM "company_memberships" cm
JOIN "companies" c ON c."id" = cm."company_id"
JOIN "user" u ON u."id" = cm."principal_id"
WHERE cm."principal_type" = 'user'
  AND cm."status" = 'active'
ON CONFLICT ("organization_id", "user_id") DO NOTHING;--> statement-breakpoint
-- Defensive re-backfill of company_secrets.organization_id: belt for any org-NULL
-- secret minted by the pre-fix create path (server/src/services/secrets.ts) between
-- 0189 and the C3 service fix. Verbatim from 0189 + idempotent (WHERE ... IS NULL);
-- a no-op once C3 ships. NOT NULL/FK on the column stays DEFERRED (see C3).
UPDATE "company_secrets" SET "organization_id" = c."organization_id" FROM "companies" c WHERE "company_secrets"."company_id" = c."id" AND "company_secrets"."organization_id" IS NULL;
```

- [ ] **Run the contract test — confirm GREEN:**
  `pnpm exec vitest run --root server src/__tests__/migration-0195-provider-uniqueness-contract.test.ts`
  Expected: `Test Files 1 passed`, `Tests 5 passed`.

- [ ] **Run the integration test — confirm GREEN** (Linux, or Windows-flip then revert):
  `pnpm exec vitest run --root server src/__tests__/organization-member-backfill.integration.test.ts`
  Expected: `Tests 2 passed` on Linux (or after the flip on Windows). If skipped (Linux gate on Windows without the flip), that is expected — do the flip once to see green, then revert.

- [ ] **Re-verify no drift** (DML changes are invisible to drizzle's schema snapshot): `pnpm db:generate` → `No schema changes, nothing to migrate`.

- [ ] **Commit:** `fix(db): backfill org membership for existing company members on cutover (0195)`

---

## Task C3 — secrets create path stamps `organization_id` (service change; NOT NULL/FK deferred)

**Decision on NOT NULL / FK (recorded):** DEFER both. Rationale — (1) `company_secrets.organization_id` is a NULLABLE denormalized canary by design (`company_secrets.ts:12-14`, 0189); (2) a NOT NULL now could abort on any straggler org-NULL row created between 0189 and this fix; (3) no FK matches the FK-less sibling `provider_assignments.organizationId`; (4) this service fix + the 0195 defensive re-backfill together drive the population to zero NULLs, so a follow-up "verify zero NULLs → add NOT NULL + FK" can land later with confidence. **Codex's "fails RLS" premise is false** (no RLS exists); this is latent correctness, fixed at the write path.

**Files:**
- `server/src/services/secrets.ts` — add `companies` to the `@armyofagents/db` import (lines 3–10); resolve + stamp `organizationId` in `create` (around line 655–673).
- Test (integration, Linux / Windows-flip): `server/src/__tests__/secret-create-organization-id.integration.test.ts` — NEW.

**Steps (strict TDD):**

- [ ] **Write the failing integration test.** Create `server/src/__tests__/secret-create-organization-id.integration.test.ts`:
```ts
// Real-Postgres proof that secretService.create stamps organization_id from the
// owning company (multi-tenant cloud, C3). Pre-fix, the create path omitted the
// column and every new secret was org-NULL. Linux-only; Windows flip + revert.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { secretService } from "../services/secrets.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

// SF-1 (punch-list): raw-insert a company (mirroring C2/C4) instead of driving
// the whole companyService.create provisioning path (root-folder seeding,
// internal_agent_config, Commander agent seeding) — faster, less flaky, and
// consistent with the other C integration tests. The sentinel org is seeded by
// 0188 (0188_organizations.sql:87), so DEFAULT_ORGANIZATION_ID is reachable.
const ORG = DEFAULT_ORGANIZATION_ID;

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as any).rows) as any[];

beforeAll(async () => {
  // Fixed master key -> deterministic, no data/secrets/master.key fs write.
  process.env.AOA_SECRETS_MASTER_KEY = "0".repeat(64);
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-secret-orgid-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false });
    await pg.initialise();
    await pg.start();
    const url = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[secret-create-org-id] setup failed:", e);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")("secretService.create stamps organization_id", () => {
  it("a newly created secret carries the company's organization_id", async () => {
    if (setupError) throw new Error(String(setupError));
    // Raw-insert the company on the sentinel org (SF-1) — no companyService.create.
    const companyId = rows(
      await db.execute(
        sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('Secret Co', 'SEC', ${ORG}) RETURNING id`,
      ),
    )[0].id;

    const secret = await secretService(db).create(companyId, {
      name: "MY_SECRET",
      value: "hunter2",
      provider: "local_encrypted",
    });

    const stored = rows(await db.execute(sql`SELECT organization_id FROM company_secrets WHERE id = ${secret.id}`))[0];
    expect(stored.organization_id).toBe(ORG);
    expect(stored.organization_id).not.toBeNull();
  }, 90_000);
});
```
- [ ] **Run it — confirm RED** (Linux, or Windows-flip):
  `pnpm exec vitest run --root server src/__tests__/secret-create-organization-id.integration.test.ts`
  Expected: FAIL — `expected null to be '<org-uuid>'` (create path omits `organizationId`).

- [ ] **Fix the service.** In `server/src/services/secrets.ts`:
  Import block — CURRENT (lines 3–10):
```ts
import {
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  runtimeProviderKeys,
  secretAccessEvents,
} from "@armyofagents/db";
```
  NEW:
```ts
import {
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  runtimeProviderKeys,
  secretAccessEvents,
} from "@armyofagents/db";
```
  `create` body — CURRENT (lines 655–666):
```ts
      if (!prepared) throw unprocessable("Provider does not support external references");
      return db.transaction(async (tx) => {
        const secret = await tx
          .insert(companySecrets)
          .values({
            companyId,
            name: input.name,
            key,
            status: "active",
            managedMode,
            provider: input.provider,
            providerConfigId: input.providerConfigId ?? null,
```
  NEW:
```ts
      if (!prepared) throw unprocessable("Provider does not support external references");
      // Tenant denormalization (multi-tenant cloud, C3): stamp the owning org so a
      // new secret is never org-NULL. 0189 backfilled existing rows but the create
      // path never wrote it. Company->org is immutable, so a pre-tx read is safe.
      const companyOrg = await db
        .select({ organizationId: companies.organizationId })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((r) => r[0] ?? null);
      return db.transaction(async (tx) => {
        const secret = await tx
          .insert(companySecrets)
          .values({
            companyId,
            organizationId: companyOrg?.organizationId ?? null,
            name: input.name,
            key,
            status: "active",
            managedMode,
            provider: input.provider,
            providerConfigId: input.providerConfigId ?? null,
```
  (`eq` is already imported at `secrets.ts:1`.)

- [ ] **Run it — confirm GREEN:**
  `pnpm exec vitest run --root server src/__tests__/secret-create-organization-id.integration.test.ts`
  Expected: `Tests 1 passed` (Linux / after flip). Revert the Windows flip.

- [ ] **Typecheck the server package:** `pnpm --filter @armyofagents/server typecheck` → no errors.

- [ ] **Commit:** `fix(secrets): stamp organization_id on secret create (multi-tenant cloud)`

---

## Task C4 — staged pre-0188 upgrade test: assertCompanyAccess after cutover

Proves the END-TO-END authz outcome the C2 migration exists to guarantee: after a cutover, EVERY prior `(user, company)` passes `assertCompanyAccess` (org + company membership present). FAILS without the member-backfill, PASSES with it. Extends coverage beyond the existing `organizations-backfill.integration.test.ts` (which only asserts "one sentinel org + companies attach").

**Files:**
- Test (integration, Linux / Windows-flip): `server/src/__tests__/mt-cutover-access.integration.test.ts` — NEW (harness from `organizations-backfill.integration.test.ts`; authz from `assert-company-access-tenant.test.ts`).

**Steps (strict TDD):**

- [ ] **Write the test WITHOUT the backfill execution (RED).** Create `server/src/__tests__/mt-cutover-access.integration.test.ts` with the `RUN_BACKFILL` flag set to `false` for the first run:
```ts
// Staged cutover proof (multi-tenant cloud, C4): seed a PRE-0188 multi-user shape
// (users + companies + active company_memberships, NO org memberships), then run
// the 0195 member-backfill, then assert every prior (user,company) passes
// cloud_auth assertCompanyAccess (server/src/routes/authz.ts). Without the
// backfill each non-admin member 403s (Phase A); with it every pair resolves
// (Phase B). Harness = organizations-backfill.integration.test.ts; authz shape =
// assert-company-access-tenant.test.ts. Linux-only; Windows flip + revert.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  type Db,
  companyMemberships,
  organizationMemberships,
} from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { assertCompanyAccess } from "../routes/authz.js";
import { __resetTenantCache } from "../routes/authz-tenant.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

// Toggle: false proves Phase B fails without the backfill (RED); true = GREEN.
const RUN_BACKFILL = false;

// Keep in sync with 0195_provider_org_scoped_uniqueness.sql (member-backfill INSERT).
const MEMBER_BACKFILL_SQL = `
INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status", "joined_at")
SELECT DISTINCT c."organization_id", cm."principal_id", 'member', 'active', now()
FROM "company_memberships" cm
JOIN "companies" c ON c."id" = cm."company_id"
JOIN "user" u ON u."id" = cm."principal_id"
WHERE cm."principal_type" = 'user'
  AND cm."status" = 'active'
ON CONFLICT ("organization_id", "user_id") DO NOTHING`;

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as any).rows) as any[];

const ORG = DEFAULT_ORGANIZATION_ID;
// (user, company) pairs to seed. u1 spans two companies (exercises DISTINCT).
const SEED = [
  { user: "cut-u1", company: "co-a" },
  { user: "cut-u1", company: "co-b" },
  { user: "cut-u2", company: "co-a" },
];
const companyIds: Record<string, string> = {};

async function actorFor(userId: string) {
  const orgs = await db
    .select({ organizationId: organizationMemberships.organizationId })
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, "active")));
  const comps = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
    ));
  return {
    type: "board" as const,
    source: "session" as const,
    userId,
    organizationIds: orgs.map((r) => r.organizationId),
    companyIds: comps.map((r) => r.companyId),
  };
}

beforeAll(async () => {
  setDeploymentMode("cloud_auth");
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mt-cutover-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false });
    await pg.initialise();
    await pg.start();
    const url = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);

    // Seed the PRE-0188 multi-user shape via raw SQL (no service auto-creates an
    // org membership): users + companies on the sentinel org + active company
    // memberships, and deliberately NO organization_memberships.
    const users = [...new Set(SEED.map((s) => s.user))];
    for (const u of users) {
      await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (${u}, ${u}, ${u + "@x.invalid"}, now(), now())`);
    }
    const companies = [...new Set(SEED.map((s) => s.company))];
    let prefixSeq = 0;
    for (const c of companies) {
      const prefix = `C${prefixSeq++}X`;
      const id = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES (${c}, ${prefix}, ${ORG}) RETURNING id`))[0].id;
      companyIds[c] = id;
    }
    for (const { user, company } of SEED) {
      await db.execute(sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status) VALUES (${companyIds[company]}, 'user', ${user}, 'active')`);
    }
    __resetTenantCache();
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[mt-cutover-access] setup failed:", e);
  }
}, 180_000);

afterAll(async () => {
  setDeploymentMode("local_trusted");
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")("cutover: assertCompanyAccess after 0195 member backfill", () => {
  it("Phase A (regression): a non-admin member is denied BEFORE the backfill", async () => {
    if (setupError) throw new Error(String(setupError));
    const req = { actor: await actorFor("cut-u2") } as any;
    await expect(assertCompanyAccess(db, req, companyIds["co-a"])).rejects.toThrow();
  }, 90_000);

  it("Phase B: after the backfill, every prior (user,company) passes assertCompanyAccess", async () => {
    if (RUN_BACKFILL) {
      await db.execute(sql.raw(MEMBER_BACKFILL_SQL));
    }
    __resetTenantCache();
    for (const { user, company } of SEED) {
      const req = { actor: await actorFor(user) } as any;
      await expect(assertCompanyAccess(db, req, companyIds[company])).resolves.toBeUndefined();
    }
  }, 90_000);

  it("idempotent: re-running the backfill leaves each user with exactly one org membership", async () => {
    if (RUN_BACKFILL) {
      await db.execute(sql.raw(MEMBER_BACKFILL_SQL));
    }
    const c = rows(await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'cut-u1'`))[0].c;
    expect(c).toBe(RUN_BACKFILL ? 1 : 0);
  }, 90_000);
});
```
- [ ] **Run it — confirm RED** (Linux, or Windows-flip). With `RUN_BACKFILL = false`, Phase A passes (denied), but Phase B FAILS (no org membership → `assertCompanyAccess` rejects instead of resolves):
  `pnpm exec vitest run --root server src/__tests__/mt-cutover-access.integration.test.ts`
  Expected: Phase A `passed`, Phase B `failed` (`expected promise to resolve but it rejected with "...not have access to this company"`).

- [ ] **Flip to GREEN.** Change `const RUN_BACKFILL = false;` → `const RUN_BACKFILL = true;`.

- [ ] **Run it — confirm GREEN:**
  `pnpm exec vitest run --root server src/__tests__/mt-cutover-access.integration.test.ts`
  Expected: `Tests 3 passed`. (Revert any Windows skipIf/initdbFlags flip; KEEP `RUN_BACKFILL = true`.)

- [ ] **Commit:** `test(mt): staged cutover proof — assertCompanyAccess passes after 0195 member backfill`

---

## Task C5 — full verification (run before finishing)

- [ ] **No schema drift:** `pnpm db:generate` → `No schema changes, nothing to migrate`; `git status --porcelain packages/db/src/migrations` shows no unexpected new `.sql`.
- [ ] **Migration idempotency gate** (0195's ALTER/DML are not `CREATE TABLE/INDEX`, so must pass unchanged): `pnpm exec vitest run --root packages/db src/__tests__/migration-idempotency.test.ts` (if no vitest config resolves under `packages/db`, fall back to `pnpm exec vitest run packages/db/src/__tests__/migration-idempotency.test.ts`). Expected: all pass; 0195 is NOT flagged.
- [ ] **Real-DB chain still boots** (0195 applies cleanly on top of the full chain through 0194 — Batch B's 0193/0194 landed first in the A→B→C order): `pnpm exec vitest run --root server src/__tests__/mt-combined-migrations.integration.test.ts` (Linux / Windows-flip). Expected: all pass.
- [ ] **Contract test** green: `pnpm exec vitest run --root server src/__tests__/migration-0195-provider-uniqueness-contract.test.ts` → `Tests 5 passed`.
- [ ] **Typecheck workspace:** `pnpm typecheck` (= `pnpm -r typecheck`) → no errors (covers `@armyofagents/db` schema + `@armyofagents/server` secrets change + tests).
- [ ] **Brand-check (guard 9):** `pnpm check:tokens` → passes. Confirm NO new `AOA_*` env var was introduced (none is; the C3 test only reads the already-documented `AOA_SECRETS_MASTER_KEY`).
- [ ] **Revert confirmation:** grep the four integration test files for `skipIf(false)` and `initdbFlags` — none must remain (`git grep -n "skipIf(false)\|initdbFlags" server/src/__tests__` returns nothing from these files). `RUN_BACKFILL` in `mt-cutover-access.integration.test.ts` MUST be `true`.
- [ ] **Self-hosted unchanged:** confirm no edit touched `local_trusted`/`authenticated` code paths (the schema/migration/secrets changes are mode-agnostic and additive).

## Commit summary (4 commits)
1. `feat(db): org-scope provider uniqueness constraints (0195)` — C1
2. `fix(db): backfill org membership for existing company members on cutover (0195)` — C2
3. `fix(secrets): stamp organization_id on secret create (multi-tenant cloud)` — C3
4. `test(mt): staged cutover proof — assertCompanyAccess passes after 0195 member backfill` — C4
