# W6 — Org Reporting Prerequisite Implementation Plan (rev. 2, post-review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee every org agent always resolves to a real human owner — so the Inbox hub's ownership (§7/§19) and W5 routing have a human to assign/route to in every deployment mode, including `local_trusted`.

**Architecture:** Add an ownership-resolution layer + invariants on the existing mixed agent/human `parentType`/`parentId` tree. Enforce "human at the top" on agent create, re-parent (not orphan-to-root) on removal, seed a real human operator at company create (shared helper, also used on import), and backfill via an admin route. No new tables.

**Tech Stack:** TypeScript, Express 5, Drizzle/Postgres, Vitest. Tests = `*.integration.test.ts` on embedded-postgres (Linux-gated, **Windows-skipped** per CLAUDE.md CI status / Issue #114). UI: React + Vite.

**Spec:** master scope §19. **Dependency for:** W1a owner resolution.

> **Rev-2 changes (independent review, 2026-06-28):** all tests rewritten to the real `*.integration.test.ts` harness (P0-1); `kind` guard inverted to default-to-org (P0-3); backfill wired to a real admin route, not a phantom boot path (P0-2); `reparentChildren` threads `companyId` into **all 4** `orphanChildren` callers + updates existing tests (P1-1); **dropped the humans-report-to-humans task** — already enforced at `team.ts:363-365` (P1-2); `authUsers` insert gets required `createdAt`/`updatedAt` (P1-3); `terminate`/`remove` use `existing.companyId` (P1-4); import path seeds the operator before backfill (P1-5); stale UI line refs fixed (P2-1).

**Verified refs (main `c8dbbd2fa`):** `org-hierarchy.ts` (163 lines); `agents.ts:459` create, `:529/:535` terminate→orphanChildren, `:551/:557` remove→orphanChildren, `:416` backfillParentFields, `:2054` admin backfill route, `:378` optimistic-concurrency precedent. `orphanChildren` other callers: `access.ts:197`, `team.ts:422`. Existing enforcement: `team.ts:363-365` (humans→humans). `authUsers` insert shape: `team.ts:577`. `auth.ts:3-15` (authUsers schema: `createdAt`/`updatedAt` NOT NULL, no default). `permissions.ts:47/:58`. `companies.ts:126-152` create (`:136` ensureMembership). `NewAgentDialog.tsx:315` role-disabled, `:345` reports-to disabled. Existing tests to update: `org-hierarchy.test.ts:425-485`.

---

## File structure

| File | Change |
|------|--------|
| `server/src/services/org-hierarchy.ts` | add `getFounderUserId`, `getFirstHumanAncestor`; rename `orphanChildren`→`reparentChildren(companyId, …)` (re-parent logic) |
| `server/src/services/agents.ts` | enforce human-at-top in `create()`; thread `existing.companyId` to `reparentChildren` at `:535/:557`; add `backfillHumanAtTop(companyId)`; add admin backfill route |
| `server/src/services/access.ts` | thread `row.companyId` to `reparentChildren` at `:197`; add `ensureRealOperator(db, companyId, userId?)` helper |
| `server/src/services/team.ts` | thread `companyId` to `reparentChildren` at `:422` |
| `server/src/routes/companies.ts` | replace `:136` with `ensureRealOperator(...)` |
| `server/src/services/company-portability.ts` | `ensureRealOperator` + `backfillHumanAtTop` at end of `importBundle` |
| `ui/src/components/NewAgentDialog.tsx` | remove `:345` `disabled`; default first-agent parent to founder; keep CXO editable |
| `server/src/__tests__/w6-org-reporting.integration.test.ts` | **Create** — one integration file, harness + all server tests |
| `server/src/services/__tests__/org-hierarchy.test.ts:425-485` | update for re-parent semantics |
| `ui/src/components/__tests__/NewAgentDialog.firstagent.test.tsx` | **Create** — UI test |

---

## Task 0: W6 integration-test harness

**Files:** Create `server/src/__tests__/w6-org-reporting.integration.test.ts`

- [ ] **Step 1: Create the harness** (copied from `crew-org-scope.integration.test.ts:17-76`). Subsequent tasks add `it(...)` blocks inside the `describe.skipIf` body.

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { orgHierarchyService } from "../services/org-hierarchy.js";
import { agentService } from "../services/agents.js";

type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: Pg | null = null; let dataDir = ""; let db: Db; let setupError: unknown = null;
const PORT = 58200 + Math.floor(Math.random() * 1000);
function firstId(r: unknown): string { return Array.isArray(r) ? (r[0] as { id: string })?.id : (r as { rows?: { id: string }[] }).rows?.[0]?.id; }

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-w6-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: new (o: object) => Pg };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise(); await pg.start();
    const cs = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(cs); db = createDb(cs);
  } catch (err) { setupError = err; console.error("[w6-integration] setup failed:", err); }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

// Seeds a company + a real founder human (authUsers + membership + user_roles). Returns ids.
async function seedCompanyWithFounder(): Promise<{ companyId: string; founderId: string }> {
  const companyId = firstId(await db.execute(sql`INSERT INTO companies (id, name) VALUES (gen_random_uuid(), 'W6 Co') RETURNING id`));
  const founderId = firstId(await db.execute(sql`INSERT INTO auth_users (id, email, name, email_verified, created_at, updated_at) VALUES (gen_random_uuid(), 'f@w6.test', 'Founder', false, now(), now()) RETURNING id`));
  await db.execute(sql`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at) VALUES (gen_random_uuid(), ${companyId}, 'user', ${founderId}, 'owner', 'active', now(), now())`);
  await db.execute(sql`INSERT INTO user_roles (id, company_id, user_id, role) VALUES (gen_random_uuid(), ${companyId}, ${founderId}, 'founder')`);
  return { companyId, founderId };
}

describe.skipIf(process.platform === "win32")("W6 org reporting — real DB", () => {
  // tasks add `it(...)` blocks here
  it("setup harness boots", () => { if (setupError) throw new Error(String(setupError)); expect(db).toBeTruthy(); });
});
```

> Verify the real column names for `auth_users` / `company_memberships` / `user_roles` against the generated migration SQL in `packages/db/src/migrations/` (snake_case). Adjust the `INSERT` column lists if they differ.

- [ ] **Step 2: Run** `cd server && pnpm vitest run src/__tests__/w6-org-reporting.integration.test.ts` (on Linux/CI; on Windows it skips). Expected: PASS (harness boots) or skipped.

- [ ] **Step 3: Commit**
```bash
git add server/src/__tests__/w6-org-reporting.integration.test.ts
git commit -m "test(org): W6 integration-test harness (embedded-postgres)"
```

---

## Task 1: Ownership-resolution helpers

**Files:** Modify `org-hierarchy.ts`; add `it` blocks to the harness.

- [ ] **Step 1: Write failing tests** (add inside the `describe.skipIf` body):

```typescript
  it("getFounderUserId returns the founder, else the owner-membership principal", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = orgHierarchyService(db);
    expect(await svc.getFounderUserId(companyId)).toBe(founderId);
    await db.execute(sql`DELETE FROM user_roles WHERE company_id = ${companyId} AND role = 'founder'`);
    expect(await svc.getFounderUserId(companyId)).toBe(founderId); // owner-membership fallback
  });

  it("getFirstHumanAncestor walks agent -> agent -> human", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const leadId = firstId(await db.execute(sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id) VALUES (gen_random_uuid(), ${companyId}, 'Lead', 'org', 'idle', 'user', ${founderId}) RETURNING id`));
    const workerId = firstId(await db.execute(sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id) VALUES (gen_random_uuid(), ${companyId}, 'Worker', 'org', 'idle', 'agent', ${leadId}) RETURNING id`));
    expect(await orgHierarchyService(db).getFirstHumanAncestor(companyId, "agent", workerId)).toBe(founderId);
  });
```

- [ ] **Step 2: Run → FAIL** (`getFounderUserId is not a function`).

- [ ] **Step 3: Implement in `org-hierarchy.ts`** — add `userRoles` to the `@armyofagents/db` import, then inside `orgHierarchyService` add `getFounderUserId` and `getFirstHumanAncestor` (full code is in rev-1; unchanged) and export both. `getFounderUserId`: `user_roles` where `role='founder'` → else owner-role `company_memberships` principal. `getFirstHumanAncestor`: walk `parentType/parentId` to the first `user`, depth-capped at `MAX_CHAIN_DEPTH`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(org): ownership resolution helpers (founder + first-human-ancestor)`

---

## Task 2: Auto-parent first/rootless org agent to the founder

**Files:** Modify `agents.ts:459-494` (`create()`); add harness test.

- [ ] **Step 1: Write the failing test** — the key case is **no `kind` field** (the default path the review flagged):

```typescript
  it("a rootless org agent (no kind field) auto-parents to the founder", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const agent = await agentService(db).create(companyId, { name: "Atlas", role: "cxo" }); // no kind, no parent
    expect(agent.parentType).toBe("user");
    expect(agent.parentId).toBe(founderId);
  });

  it("an aoa crew agent is NOT force-parented", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId } = await seedCompanyWithFounder();
    const crew = await agentService(db).create(companyId, { name: "X", kind: "aoa", role: "general" });
    expect(crew.parentId).toBeNull();
  });
```

- [ ] **Step 2: Run → FAIL** (`agent.parentType` is null).

- [ ] **Step 3: Implement in `create()`** — after parent resolution (`:461-463`), before `assertCxoParentConstraint`:

```typescript
      // W6: human-at-top. An org agent with no parent auto-parents to the founder.
      // kind defaults to "org" at the DB but is usually ABSENT from `data`, so we
      // default-to-org here (mirrors list()'s `options?.kind ?? "org"`): only the
      // explicit non-org kinds (aoa crew, platform) are exempt.
      let resolvedParentType = parentType;
      let resolvedParentId = parentId;
      if (data.kind !== "aoa" && data.kind !== "platform" && !resolvedParentId) {
        const founderId = await orgHierarchy.getFounderUserId(companyId);
        if (!founderId) throw unprocessable("Cannot create an org agent: no human founder exists for this company");
        resolvedParentType = "user";
        resolvedParentId = founderId;
      }
      const resolvedReportsTo = resolvedParentType === "agent" ? resolvedParentId : null;
```

Use `resolvedParentType`/`resolvedParentId`/`resolvedReportsTo` in `assertCxoParentConstraint`, `ensureParent`, and `insert(...).values({...})`. (Import `unprocessable` from `../errors.js` if not present.)

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(org): auto-parent rootless org agents to the founder (human-at-top)`

---

## Task 3: Re-parent on removal (rename `orphanChildren` → `reparentChildren`, all 4 callers)

**Files:** Modify `org-hierarchy.ts`; update `agents.ts:535,:557`, `access.ts:197`, `team.ts:422`; update `org-hierarchy.test.ts:425-485`; add harness test.

- [ ] **Step 1: Write the failing harness test** — children of a removed agent re-parent to the removed agent's parent.

```typescript
  it("removing an agent re-parents its reports to the removed agent's parent", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const leadId = firstId(await db.execute(sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id) VALUES (gen_random_uuid(), ${companyId}, 'Lead', 'org', 'idle', 'user', ${founderId}) RETURNING id`));
    const workerId = firstId(await db.execute(sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id) VALUES (gen_random_uuid(), ${companyId}, 'Worker', 'org', 'idle', 'agent', ${leadId}) RETURNING id`));
    await orgHierarchyService(db).reparentChildren(companyId, leadId, "agent");
    const row = await db.execute<{ parent_type: string; parent_id: string }>(sql`SELECT parent_type, parent_id FROM agents WHERE id = ${workerId}`);
    const w = Array.isArray(row) ? row[0] : (row as { rows: { parent_type: string; parent_id: string }[] }).rows[0];
    expect(w.parent_type).toBe("user");
    expect(w.parent_id).toBe(founderId);
  });
```

- [ ] **Step 2: Run → FAIL** (`reparentChildren is not a function`).

- [ ] **Step 3: Implement** — rename `orphanChildren` to `reparentChildren(companyId, entityId, entityType, txOrDb?)` with the re-parent logic (full code in rev-1: look up the removed entity's own parent; fallback to `getFounderUserId`; update child agents + child memberships to point at it). Export `reparentChildren`.

  Update **all 4 callers** to pass `companyId`:
  - `agents.ts:535` → `reparentChildren(existing.companyId, id, "agent", tx)` (companyId from `existing = getById(id)` at `:530`).
  - `agents.ts:557` → `reparentChildren(existing.companyId, id, "agent", tx)` (from `:552`).
  - `access.ts:197` → `reparentChildren(row.companyId, userId, "user", tx)` (verify the local var holding companyId; grep `orphanChildren` in access.ts).
  - `team.ts:422` → `reparentChildren(companyId, userId, "user", tx)` (companyId is a function param there).

- [ ] **Step 4: Update the existing suite** — rewrite `org-hierarchy.test.ts:425-485` (5 cases) from null-orphan assertions to re-parent assertions (children point at the grandparent/founder, not null). Run both that file and the harness test.

- [ ] **Step 5: Commit** `feat(org): re-parent reports on removal instead of orphaning to root`

---

## Task 4: `ensureRealOperator` helper + seed at company create

**Files:** Add `ensureRealOperator` in `access.ts`; use it in `companies.ts:136`; add a route/service test.

- [ ] **Step 1: Write the failing test** — create a company with no `userId` (local_trusted); assert a real `auth_users` row + `founder` `user_roles` row exist and `getFounderUserId` returns it. (Harness or a route test; if route, mirror an existing `companies` route test.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `ensureRealOperator(db, companyId, userId?)`** in `access.ts` (mirror the `authUsers` insert at `team.ts:577` — required cols `id, email, name, email_verified, created_at, updated_at`):

```typescript
  async function ensureRealOperator(companyId: string, userId: string | null | undefined): Promise<string> {
    let operatorId = userId ?? null;
    // local_trusted passes a synthetic principal (e.g. "local-board") with NO auth-user
    // row, and it is TRUTHY — so treat a missing OR non-existent user id as "needs a real operator".
    if (operatorId) {
      const exists = await db.select({ id: authUsers.id }).from(authUsers)
        .where(eq(authUsers.id, operatorId)).limit(1).then((r) => r[0]);
      if (!exists) operatorId = null;
    }
    if (!operatorId) {
      operatorId = crypto.randomUUID();
      await db.insert(authUsers).values({
        id: operatorId,
        email: `operator-${operatorId.slice(0, 8)}@local.invalid`,
        name: "Operator",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    await ensureMembership(companyId, "user", operatorId, "owner", "active");
    // founder user_role: company create does NOT assign one today (verified) — create it.
    const existing = await db.select({ id: userRoles.id }).from(userRoles)
      .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, operatorId), eq(userRoles.role, "founder"))).limit(1);
    if (!existing[0]) await db.insert(userRoles).values({ companyId, userId: operatorId, role: "founder" });
    return operatorId;
  }
```

Export it. Replace `companies.ts:136` `await access.ensureMembership(company.id, "user", req.actor.userId ?? "local-board", "owner", "active");` with `await access.ensureRealOperator(company.id, req.actor.userId);`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(org): seed a real human operator at company create (incl. local_trusted)`

---

## Task 5: First-agent UX (NewAgentDialog)

**Files:** Modify `NewAgentDialog.tsx:345` (+ default parent); create `NewAgentDialog.firstagent.test.tsx`.

- [ ] **Step 1: Write the failing test** — render as first agent (`agents=[]`); assert the **reports-to** picker is enabled and defaults to the founder.
- [ ] **Step 2: Run → FAIL** (`disabled={isFirstAgent}` at `:345`).
- [ ] **Step 3: Implement** — remove `disabled={isFirstAgent}` at `:345` (the reports-to picker; **leave the role button at `:315` as-is**, role stays CXO editable). Default the first-agent parent value to the founder from the org-tree humans the dialog loads. Keep `effectiveRole = isFirstAgent ? "cxo" : role` at `:84` (editable default).
- [ ] **Step 4: Run → PASS** — `cd ui && pnpm vitest run src/components/__tests__/NewAgentDialog.firstagent.test.tsx`.
- [ ] **Step 5: Commit** `feat(org-ui): enable reports-to picker for the first agent, default to founder`

---

## Task 6: `backfillHumanAtTop` + admin route

**Files:** Add `backfillHumanAtTop(companyId)` in `agents.ts`; add admin route mirroring `agents.ts:2054`; harness test.

- [ ] **Step 1: Write the failing test** — seed a company + founder + an org agent with `parent_id = null`; call `agentService(db).backfillHumanAtTop(companyId)`; assert the agent now parents to the founder and the return count is 1.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `backfillHumanAtTop`** (full code in rev-1: query `kind='org'`, not terminated, `parent_id IS NULL`; set parent to founder; return count). Then add an admin route **mirroring `agents.ts:2054`** (`POST /agents/admin/backfill-human-at-top`) that iterates companies and calls `backfillHumanAtTop(c.id)`. (There is **no boot path** — the existing `backfillParentFields` is exposed the same way.)
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(org): backfill rootless org agents to the founder (admin route)`

---

## Task 7: Import repair (operator + backfill)

**Files:** Modify `company-portability.ts` (end of `importBundle`); harness/route test.

- [ ] **Step 1: Write the failing test** — import a bundle creating a new company with a rootless org agent; assert post-import the company has a founder operator AND the agent parents to it.
- [ ] **Step 2: Run → FAIL** (import-created companies bypass route seeding → no founder → backfill no-ops).
- [ ] **Step 3: Implement** — at the end of `importBundle`, for the `new_company` path, call `access.ensureRealOperator(result.company.id, importingUserId)` **then** `agentService(db).backfillHumanAtTop(result.company.id)`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(org): seed operator + validate human-at-top on company import`

---

## Task 8: Comprehensive test coverage (eng-review additions)

Closes the 11 gaps from `/plan-eng-review`: e2e user flow, caller-level integration, error path, and the critical contract-reversal regression.

**Files:**
- Create: `tests/e2e/w6-first-agent.e2e.ts` (Playwright, Linux-gated, Windows-skipped per `tests/e2e/playwright.config.ts`)
- Modify: `server/src/__tests__/w6-org-reporting.integration.test.ts` (add `it` blocks)
- Modify: `server/src/services/__tests__/agent-parent-fields.test.ts:240-250` (regression)

- [ ] **8a — E2E: first-agent → founder (Playwright).** Reuse the `tests/e2e/seed-company.ts` helper (the de-duped wizard/seed helper). Flow: open the **New Agent** dialog as the first agent → assert the **reports-to picker is enabled** and its value is the founder → submit → assert (via the agents API or the org-tree view) the new agent's `parentType="user"`, `parentId=<founder>`. Mirror an existing spec's structure (e.g. the onboarding/agent specs already in `tests/e2e/`).
  - Verify: `cd tests/e2e && pnpm playwright test w6-first-agent` (Linux/CI).
  - Commit: `test(e2e): first agent reports to founder + reports-to picker enabled`

- [ ] **8b — Caller-level integration** (add `it` blocks to the harness; each `if (setupError) throw`):
  - **terminate re-parents reports:** seed founder → lead(org, parent=founder) → worker(org, parent=lead); call `agentService(db).terminate(leadId)`; assert worker now parents to the founder (the real caller path, not just `reparentChildren`).
  - **remove re-parents reports:** same via `agentService(db).remove(leadId)`.
  - **user-offboarding callers:** a human manager with an agent + a human report; call the `team`/`access` offboarding path that hits `reparentChildren(companyId, userId, "user", …)`; assert both reports re-parent (covers `access.ts:197` + `team.ts:422`, which changed signature).
  - **company-create yields a real human at the org-tree top:** call the company-create path (or `ensureRealOperator`) with no `userId`; assert a real `auth_users` row + `founder` `user_roles` exist AND `agentService(db).orgForCompany(companyId)` includes that human as a root (not just the membership row).
  - Commit: `test(org): caller-level integration for re-parent + real operator`

- [ ] **8c — Error path:** create an org agent in a company with **no founder** (delete the founder role + owner membership first); assert `agentService(db).create(companyId, { name: "X" })` rejects with the "no human founder" message (422). Add a UI assertion in the component test that a 422 surfaces a visible error (not a silent failure).
  - Commit: `test(org): no-founder create rejects (error path)`

- [ ] **8d — CRITICAL regression:** the human-at-top change in `create()` changes the contract documented at `server/src/__tests__/agent-parent-fields.test.ts:240-250` ("all null when no parent info provided"). NOTE (review): that file is a **pure-logic** test (re-derives the old expression inline; does NOT call `create()`), so it won't *fail* CI — but it now asserts a contract `create()` no longer honors, so update it. (Also: the real break was `agents-update-concurrency.integration.test.ts` seeding a founder-less company then calling `create()` — fixed in the Task 2 follow-up commit.) Update that test: a `kind="org"`/no-kind create with no parent now yields `parentType="user"` + founder; keep the **`kind="aoa"`/`platform`** case asserting `null` (the exemption). Add a one-line comment pointing at §19 / this plan so the reversal is intentional and documented.
  - Commit: `test(org): update agent-parent-fields contract for human-at-top (regression)`

---

## Self-review (rev-2)

- **Spec coverage (§19):** first-agent→founder = Task 2; picker enabled = Task 5; CXO editable = Task 5 (unchanged role button); enforce human-at-top = Tasks 1+2; real-human operator = Task 4 (+import Task 7); humans-report-to-humans = **already enforced (team.ts:363-365), no task**; reportsTo sync = unchanged; re-parent-on-removal = Task 3; backfill = Task 6 (+import Task 7). ✓
- **All 4 `orphanChildren` callers** threaded (Task 3). **No phantom harness** — every test uses the embedded-postgres pattern (Task 0). **kind guard** defaults-to-org (Task 2). **authUsers** insert has `created_at`/`updated_at` (Task 4). **Backfill** wired to a real admin route (Task 6).
- **Type consistency:** `getFounderUserId`, `getFirstHumanAncestor`, `reparentChildren(companyId,…)`, `ensureRealOperator`, `backfillHumanAtTop(companyId)` — names/signatures consistent across tasks.

## Residual verify-on-execute (low-risk)
- Exact snake_case columns for `auth_users`/`company_memberships`/`user_roles` in the seed SQL (Task 0) vs the generated migrations.
- The local var holding `companyId` at `access.ts:197` (Task 3 caller).
- The importing-user variable name in `company-portability.ts` (Task 7).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean (issues resolved) | 1 test-coverage finding (11 sub-gaps) → resolved via Task 8 |
| Adversarial | independent Claude review | Correctness | 1 | clean (issues resolved) | rev-1: 3 P0 + 5 P1 → all fixed in rev-2 |
| Outside Voice | Codex | 2nd opinion | 0 | n/a | Codex unavailable; two prior independent Claude passes substitute |
| CEO Review | `/plan-ceo-review` | Scope/strategy | 0 | — | not run (prerequisite/infra plan) |
| Design Review | `/plan-design-review` | UI/UX | 0 | — | not run (one small UI change, covered by 8a e2e + component test) |

**Step 0 (scope):** accepted as-is — 7 files, 0 new services, reuses existing seams (boring-by-default).
**Architecture/Code-quality:** no blocking findings; `ensureRealOperator` extraction is the right DRY move.
**Test review:** 11 gaps found, **all added to the plan (Task 8)** — e2e Playwright first-agent flow, caller-level integration (terminate/remove/company-create + 2 offboarding callers), error path, and the CRITICAL contract-reversal regression.
**Performance:** `getFirstHumanAncestor` walks one query per level (shallow, depth-capped) — not an N+1 concern.
**Failure modes / critical gaps:** the contract reversal + 2 signature-changed callers were untested → now covered (Task 8d, 8b). **0 remaining critical gaps.**
**NOT in scope:** W1a hub data core (separate plan); the W6 *enforcement* of humans-report-to-humans (already enforced at `team.ts:363-365`); login/signup wiring for the seeded operator (deferred per §19).
**UNRESOLVED:** 0.
**VERDICT:** **ENG CLEARED — ready to implement.** Plan = W6 rev-2 (correctness fixes) + Task 8 (full test coverage).
