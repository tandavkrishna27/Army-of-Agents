# Multi-Tenant #316 Follow-up Bundle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Land the audited #316 follow-up bundle on branch `claude/multitenant-cloud`: M1 (cross-tenant IDOR fix), D1 (explicit unsandboxed-multitenant execution gate + M7 comment correction), D2 (full bundle-import fix — org placement + restoration semantics + authz), D3 (cloud provider onboarding guidance), and the M2/L-c execution_targets scans + L-a/L-b onboarding copy fixes.

**Architecture:** Cloud-only (tenantIsolationEnforced()) behaviors; self-hosted preserved throughout. D1 adds a shared guard at all three execution sinks (heartbeat, crew runAoaAgent, Commander). D2 threads an owning org through the import→create path and stops promoting the caller. Everything else is small + behavior-preserving.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM + PostgreSQL (embedded-postgres for integration tests), React + Vite, Vitest + RTL (jsdom), supertest.

**Source audit:** the problem map is in `tasks/w1pzuurge.output`; founder decisions D1=gate-now, D2=full-fix, D3=guidance.

---

## Build order & constraints

**Recommended build order:**

1. **Small safe cluster** — M1, M2, L-c, L-a, L-b, and the M7 comment. Every item except the M7 comment is independent and may run in any order.
2. **D1 isolation gate** (re-scoped to `tenantIsolationEnforced()` — see the ★ correction in the D1 section).
3. **D2 full import fix** — internal order **D2.1 → D2.2 → D2.3 → D2.4 → D2.5 is mandatory**.
4. **D3 provider onboarding.**

**Sequencing rule for M7 (from adversarial review):** the M7 comment sub-task references **D1 as the actual guard**. Although M7 is grouped with the small safe cluster above, its heartbeat comment + Decision #117 prose must land **with or after D1**, or the cross-reference dangles. **Do the M7 comment sub-task after D1 (step 2), not during step 1.** M7 and D1 touch different regions of `heartbeat.ts` (M7 = comment at `:3202-3215`; D1 = imports `@37`, helper `@~332`, dispatch `@~4512`) so there is no textual conflict — the ordering is purely so the reference resolves.

**Hard constraints (do not violate):**

- **Self-hosted / `local_trusted` behavior is unchanged** by every item in this bundle. `authenticated` self-hosts (single org, own box, multiple humans) also stay running — see the D1 signal correction below.
- **The D1 gate must cover ALL three execution sinks — heartbeat (org agent), crew (`runAoaAgent`), and Commander (cli-mode) — with no bypass.** A shared exported helper is the single surface so the sinks cannot drift.
- **D2 must close BOTH the `team_member`→owner escalation (H2) AND the sentinel-org mis-tenanting (H3)** without breaking self-hosted import or legit new-company founder provisioning.
- **Any new `AOA_*` env** (D1's `AOA_ALLOW_UNSANDBOXED_MULTITENANT`) MUST be documented in `docs/deploy/environment-variables.md` (brand-check guard 9). No other item in this bundle adds an env var.
- **Integration tests** (`*.integration.test.ts`, only in D2.4) run on Windows via a temporary `skipIf(process.platform === "win32") → skipIf(false)` flip; **revert the flip before committing.** Linux CI is the authoritative gate.

**Cross-item file collisions the reviewer flagged, with the rule to avoid conflict:**

| File | Touched by | Rule |
|------|-----------|------|
| `server/src/services/heartbeat.ts` | M7 (comment `:3202-3215`) **and** D1 (imports `@37`, helper `@~332`, dispatch `@~4512`) | Different regions → no textual conflict, but **M7 comment must land with/after D1** (it references D1 by name). Sequence: **D1 → M7.** |
| `server/src/services/execution-target-resolver.ts` | M2 (edits the query) **and** D1 (only *consumes* `executionTargetToAdapterConfig`) | D1 does not edit it → **no conflict.** |
| `server/src/services/company-portability.ts`, `server/src/routes/companies.ts` | D2.2 (service) + D2.3 (route) | **D2.1 → D2.2 → D2.3 order is mandatory:** D2.3 reads `target.organizationId` (needs the D2.1 schema field + `pnpm --filter @armyofagents/shared build`) and passes the 4th `opts` arg + destructures `importsAgents` (needs D2.2). |
| `server/src/services/access.ts` | **Read only** by D2 (the reviewer's "access.ts … by D2" premise is inaccurate — D2 does not edit it) | **No conflict.** |

---

## 1. Small Safe Cluster (M1, M2, L-c, L-a, L-b, M7)

Branch: `claude/multitenant-cloud`. All commands run from the worktree ROOT `C:/Users/TK/.aoa/wt/mt-cloud`. Five of the six tasks (M1, M2, L-c, L-a, L-b) are independent and may run in any order; **the M7 comment sub-task must be applied after D1** (see Build order above). None touch `*.integration.test.ts`, so every test here runs on Windows unmodified.

---

### Task M1 — Fix IDOR on `GET /heartbeat-runs/:runId/issues` (missing company authz)

The handler returns another company's run→issues with no authorization. Its siblings (`activity.ts:85-107`) resolve the resource, then call `assertCompanyAccess`. Mirror that: resolve the run's `companyId` via a new thin service resolver, 404 if the run is gone, then `assertCompanyAccess`, then return the data.

> **Reviewer note (behavior change — confirm, do not block):** the current handler returns `200 []` for a *missing* run (`activity.ts:124` — `issuesForRun` returns `[]`); the M1 route below returns **404** for a missing run. This is the correct authz posture (don't leak "run exists but empty" vs "run absent"), but **confirm the runs UI tolerates a 404** on this endpoint before merge. M1 also issues a second `heartbeatRuns` query (`companyIdForRun`) on top of `issuesForRun`'s own run fetch — 2 round-trips; acceptable (could thread `companyId` through as a later optimization).

**Files:**
- Create: `server/src/__tests__/activity-heartbeat-runs-authz.test.ts` (route + source-contract test)
- Modify: `server/src/services/activity.ts` (add `companyIdForRun` resolver, insert before `issuesForRun:` at line 115)
- Modify: `server/src/routes/activity.ts` (lines 109-113 — add the auth gate)

#### Steps

- [ ] **Step 1: Write the failing test.** Create `server/src/__tests__/activity-heartbeat-runs-authz.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mockActivityService = vi.hoisted(() => ({
  companyIdForRun: vi.fn(),
  issuesForRun: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => ({}),
}));

import { activityRoutes } from "../routes/activity.js";

const RUN_ID = "run-1";
const RUN_COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const RUN_ISSUES = [
  { issueId: "i-1", identifier: "PAP-1", title: "t", status: "todo", priority: "medium" },
];

function createApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", activityRoutes({} as never));
  app.use(errorHandler);
  return app;
}

// self-hosted board branch of assertCompanyAccess (tenantIsolationEnforced() is
// false in tests) authorizes iff companyIds includes the resource's company —
// DB-free and deterministic, matching activity-human-filters.test.ts.
const memberActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "u1",
  companyIds: [RUN_COMPANY],
  isInstanceAdmin: false,
};
const nonMemberActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "u2",
  companyIds: [OTHER_COMPANY],
  isInstanceAdmin: false,
};

describe("GET /heartbeat-runs/:runId/issues — company authz (M1 IDOR fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActivityService.companyIdForRun.mockResolvedValue(RUN_COMPANY);
    mockActivityService.issuesForRun.mockResolvedValue(RUN_ISSUES);
  });

  it("a member of the run's company gets the issues (regression floor)", async () => {
    const res = await request(createApp(memberActor)).get(`/api/heartbeat-runs/${RUN_ID}/issues`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(RUN_ISSUES);
    expect(mockActivityService.issuesForRun).toHaveBeenCalledWith(RUN_ID);
  });

  it("an actor NOT in the run's company is 403 and never sees the issues", async () => {
    const res = await request(createApp(nonMemberActor)).get(`/api/heartbeat-runs/${RUN_ID}/issues`);
    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller is 401 (assertCompanyAccess floor)", async () => {
    const res = await request(createApp({ type: "none" })).get(`/api/heartbeat-runs/${RUN_ID}/issues`);
    expect(res.status).toBe(401);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("a missing run is 404 and never reaches issuesForRun", async () => {
    mockActivityService.companyIdForRun.mockResolvedValue(null);
    const res = await request(createApp(memberActor)).get(`/api/heartbeat-runs/${RUN_ID}/issues`);
    expect(res.status).toBe(404);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("source contract: resolves run company -> assertCompanyAccess -> issuesForRun (covers cloud_auth path too)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "../routes/activity.ts"), "utf8");
    expect(source).toMatch(
      /\/heartbeat-runs\/:runId\/issues[\s\S]*await svc\.companyIdForRun\(runId\)[\s\S]*await assertCompanyAccess\(db, req, companyId\)[\s\S]*await svc\.issuesForRun\(runId\)/,
    );
  });
});
```

- [ ] **Step 2: Run it — confirm RED.**

```bash
pnpm exec vitest run --root server src/__tests__/activity-heartbeat-runs-authz.test.ts
```

Expected: the 403, 401, 404, and contract tests FAIL (the current route calls `issuesForRun` unconditionally with no `companyIdForRun`/`assertCompanyAccess`). Output ends with something like:

```
 Test Files  1 failed (1)
      Tests  4 failed | 1 passed (5)
```

- [ ] **Step 3: Add the `companyIdForRun` service resolver.** In `server/src/services/activity.ts`, insert the method immediately before the `issuesForRun:` property (currently line 115). `eq` and `heartbeatRuns` are already imported (lines 1 and 3):

Current (line 115):
```ts
    issuesForRun: async (runId: string) => {
```

New (insert the block above it):
```ts
    companyIdForRun: async (runId: string): Promise<string | null> => {
      const run = await db
        .select({ companyId: heartbeatRuns.companyId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.companyId ?? null;
    },

    issuesForRun: async (runId: string) => {
```

- [ ] **Step 4: Add the auth gate in the route.** In `server/src/routes/activity.ts`, replace lines 109-113:

Current:
```ts
  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    const runId = req.params.runId as string;
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });
```

New:
```ts
  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    const runId = req.params.runId as string;
    const companyId = await svc.companyIdForRun(runId);
    if (!companyId) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    await assertCompanyAccess(db, req, companyId);
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });
```

(`assertCompanyAccess` and `db` are already in scope — imported at line 6, `db` is the `activityRoutes(db)` param.)

- [ ] **Step 5: Run it — confirm GREEN.**

```bash
pnpm exec vitest run --root server src/__tests__/activity-heartbeat-runs-authz.test.ts
```

Expected:
```
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

- [ ] **Step 6: Guard against regression in the neighboring suite.**

```bash
pnpm exec vitest run --root server src/__tests__/activity-human-filters.test.ts
```

Expected: `Tests  N passed`. Then commit:

```bash
git add server/src/routes/activity.ts server/src/services/activity.ts server/src/__tests__/activity-heartbeat-runs-authz.test.ts
git commit -m "fix(activity): authorize GET /heartbeat-runs/:runId/issues by run company (IDOR)"
```

---

### Task M2 — Scope `resolveExecutionTargetForRun` in SQL (drop the full-table scan)

`execution-target-resolver.ts:54-65` selects **every** `execution_targets` row then filters in JS. Replace with a `WHERE or(isNull(organizationId), eq(organizationId, orgId))` — the index `execution_targets_org_idx` (schema/execution_targets.ts:41) exists. Behavior-preserving: for a null org, `isNull(...)` still yields exactly the system rows.

**Files:**
- Create: `server/src/__tests__/execution-target-resolver-scope.test.ts`
- Modify: `server/src/services/execution-target-resolver.ts` (imports line 2; function body lines 53-65)

#### Steps

- [ ] **Step 1: Write the failing test.** Create `server/src/__tests__/execution-target-resolver-scope.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({ executionTargets: makeTableProxy("execution_targets") }));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

import { resolveExecutionTargetForRun } from "../services/execution-target-resolver.js";

const pooled = {
  id: "t-pool",
  slug: "pool-1",
  kind: "pooled_gvisor",
  trustClass: "shared_multitenant",
  status: "active",
  organizationId: null,
};

// A thenable that ALSO exposes `.where`, so BOTH the old (`await …from()`) and the
// new (`…from().where()`) code paths resolve to rows; the discriminator is whether
// `.where` was invoked. Mirrors execution-targets-service.test.ts's mock shape.
function dbCapturingWhere(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const fromResult: unknown = Object.assign(Promise.resolve(rows), { where });
  const from = vi.fn().mockReturnValue(fromResult);
  const select = vi.fn().mockReturnValue({ from });
  return {
    db: { select } as unknown as Parameters<typeof resolveExecutionTargetForRun>[0],
    where,
    from,
  };
}

describe("resolveExecutionTargetForRun scopes execution_targets in SQL (M2 — no full-table scan)", () => {
  it("filters to system-OR-own-org via a WHERE clause (or(isNull, eq)), not a JS post-filter", async () => {
    const { db, where, from } = dbCapturingWhere([pooled]);
    const chosen = await resolveExecutionTargetForRun(db, {
      organizationId: "org-1",
      companyId: "co-1",
      credentialKind: "company_api_key",
      pinnedTargetId: null,
      executionTargetSlug: null,
    });
    expect(from).toHaveBeenCalled();
    // or(isNull(organizationId), eq(organizationId, orgId)) -> stub returns "or"
    expect(where).toHaveBeenCalledWith("or");
    // Behavior preserved: a business key still routes to the pooled target.
    expect(chosen?.id).toBe("t-pool");
  });
});
```

- [ ] **Step 2: Run it — confirm RED.**

```bash
pnpm exec vitest run --root server src/__tests__/execution-target-resolver-scope.test.ts
```

Expected FAIL: `expected "where" to have been called with "or"` (current code never calls `.where`). `chosen?.id` assertion passes, so:
```
      Tests  1 failed (1)
```

- [ ] **Step 3: Implement the SQL scope.** In `server/src/services/execution-target-resolver.ts`, add the operator imports (line 2, above the two existing `@armyofagents/db` imports):

Current (lines 1-3):
```ts
// server/src/services/execution-target-resolver.ts
import type { Db } from "@armyofagents/db";
import { executionTargets } from "@armyofagents/db";
```

New:
```ts
// server/src/services/execution-target-resolver.ts
import { or, isNull, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { executionTargets } from "@armyofagents/db";
```

Then replace the select+filter (lines 53-65):

Current:
```ts
  // System/shared targets (organizationId null) + this org's targets are both eligible.
  const rows = (await db
    .select({
      id: executionTargets.id,
      slug: executionTargets.slug,
      kind: executionTargets.kind,
      trustClass: executionTargets.trustClass,
      status: executionTargets.status,
      organizationId: executionTargets.organizationId,
      config: executionTargets.config,
    })
    .from(executionTargets)) as ExecutionTargetRow[];
  const scoped = rows.filter((t) => t.organizationId == null || t.organizationId === input.organizationId);
```

New:
```ts
  // System/shared targets (organizationId null) + this org's targets are both
  // eligible — scoped in SQL (index execution_targets_org_idx) rather than a
  // full-table scan + JS filter. For a null org, isNull() alone yields the system
  // rows (eq(col, null) never matches), preserving the prior JS-filter behavior.
  const scoped = (await db
    .select({
      id: executionTargets.id,
      slug: executionTargets.slug,
      kind: executionTargets.kind,
      trustClass: executionTargets.trustClass,
      status: executionTargets.status,
      organizationId: executionTargets.organizationId,
      config: executionTargets.config,
    })
    .from(executionTargets)
    .where(
      or(
        isNull(executionTargets.organizationId),
        eq(executionTargets.organizationId, input.organizationId),
      ),
    )) as ExecutionTargetRow[];
```

- [ ] **Step 4: Run it — confirm GREEN, plus no regression in the pure-function suite** (that file imports the real module unmocked; the new imports must not break it):

```bash
pnpm exec vitest run --root server src/__tests__/execution-target-resolver-scope.test.ts src/__tests__/execution-target-resolver.test.ts
```

Expected:
```
 Test Files  2 passed (2)
      Tests  ... passed
```

- [ ] **Step 5: Commit.**

```bash
git add server/src/services/execution-target-resolver.ts server/src/__tests__/execution-target-resolver-scope.test.ts
git commit -m "perf(execution-targets): scope resolver query in SQL via org index (drop full-table scan)"
```

---

### Task L-c — Scope `listExecutionTargets` in SQL (admin cold path)

`execution-targets.ts:58-63` selects all rows then JS-filters, and only early-returns for a null org **after** scanning. Move the null-org early-return before the query and scope the query with `eq(organizationId, orgId)`. `eq` is already imported (line 1).

**Files:**
- Modify: `server/src/__tests__/execution-targets-service.test.ts` (rewrite the `listExecutionTargets` describe block, lines 7-28)
- Modify: `server/src/services/execution-targets.ts` (lines 58-63)

#### Steps

- [ ] **Step 1: Rewrite the failing test.** In `server/src/__tests__/execution-targets-service.test.ts`, replace the entire `describe("listExecutionTargets ...")` block (lines 7-28) with:

```ts
describe("listExecutionTargets (P5 finding #1 — no system-row leak; L-c: scoped in SQL)", () => {
  // Thenable-with-.where: the OLD (`await …from()`) and NEW (`…from().where()`)
  // paths both resolve rows; the discriminator is whether `.where` ran.
  function dbWith(scopedRows: unknown[]) {
    const where = vi.fn().mockResolvedValue(scopedRows);
    const fromResult: unknown = Object.assign(Promise.resolve(scopedRows), { where });
    const from = vi.fn().mockReturnValue(fromResult);
    const select = vi.fn().mockReturnValue({ from });
    return {
      db: { select } as unknown as Parameters<typeof listExecutionTargets>[0],
      where,
      select,
    };
  }

  it("scopes to the org's own rows via a WHERE clause (eq), not a full scan + JS filter", async () => {
    const { db, where } = dbWith([
      { id: "a-ded", organizationId: "org-A", slug: "a-box", kind: "dedicated_worker" },
    ]);
    const out = (await listExecutionTargets(db, "org-A")) as Array<{
      id: string;
      organizationId: string | null;
    }>;
    expect(where).toHaveBeenCalledWith("eq"); // eq(organizationId, orgId) — SQL scope
    expect(out.map((t) => t.id)).toEqual(["a-ded"]);
  });

  it("returns nothing for a null org WITHOUT scanning the table (early-return before the query)", async () => {
    const { db, select } = dbWith([]);
    expect(await listExecutionTargets(db, null)).toEqual([]);
    expect(select).not.toHaveBeenCalled(); // no ambient system-row scan for a null org
  });
});
```

- [ ] **Step 2: Run it — confirm RED.**

```bash
pnpm exec vitest run --root server src/__tests__/execution-targets-service.test.ts
```

Expected: the two `listExecutionTargets` tests FAIL (current code never calls `.where`, and calls `select` even for a null org); the `registerWorkerHeartbeat` tests still pass:
```
      Tests  2 failed | 2 passed (4)
```

- [ ] **Step 3: Implement.** In `server/src/services/execution-targets.ts`, replace lines 58-63:

Current:
```ts
export async function listExecutionTargets(db: Db, organizationId: string | null) {
  const rows = await db.select().from(executionTargets);
  // organizationId is required to see any target; a null org sees nothing here.
  if (organizationId == null) return [];
  return rows.filter((r) => r.organizationId === organizationId);
}
```

New:
```ts
export async function listExecutionTargets(db: Db, organizationId: string | null) {
  // organizationId is required to see any target; a null org sees nothing — and
  // must not even scan the table (its id doubles as the worker bearer token).
  if (organizationId == null) return [];
  // Scope in SQL (index execution_targets_org_idx); the no-system/cross-org
  // guarantee is the WHERE clause, not a JS post-filter.
  return db.select().from(executionTargets).where(eq(executionTargets.organizationId, organizationId));
}
```

- [ ] **Step 4: Run it — confirm GREEN.**

```bash
pnpm exec vitest run --root server src/__tests__/execution-targets-service.test.ts
```

Expected:
```
      Tests  4 passed (4)
```

- [ ] **Step 5: Commit.**

```bash
git add server/src/services/execution-targets.ts server/src/__tests__/execution-targets-service.test.ts
git commit -m "perf(execution-targets): scope listExecutionTargets in SQL, early-return null org before query"
```

---

### Task L-a — Fix the ambiguous-org onboarding copy (points at nonexistent UI)

`CreateAnotherCompany.tsx:126-136` tells a multi-org founder to "Open the organization you want this company under, then create it from there" — there is no such flow (the org picker is a deferred follow-up; see the comment at lines 124-125). Rewrite to honest copy and update the assertion in the component test.

> **Open question (product/design, non-blocking):** the title "More than one organization" and both copy strings are a proposal — a design pass may reword them. The test asserts on the substring `/more than one organization/i`, so **any retitle must update `CreateAnotherCompany.test.tsx:112` in lockstep.**

**Files:**
- Modify: `ui/src/onboarding/CreateAnotherCompany.tsx` (lines 126-136)
- Modify: `ui/src/onboarding/__tests__/CreateAnotherCompany.test.tsx` (line 112)

#### Steps

- [ ] **Step 1: Update the test to the new copy (this makes it RED).** In `ui/src/onboarding/__tests__/CreateAnotherCompany.test.tsx`, change line 112:

Current:
```ts
    expect(await screen.findByText(/pick an organization/i)).toBeTruthy();
```

New:
```ts
    expect(await screen.findByText(/more than one organization/i)).toBeTruthy();
```

- [ ] **Step 2: Run it — confirm RED.**

```bash
pnpm exec vitest run --root ui src/onboarding/__tests__/CreateAnotherCompany.test.tsx
```

Expected: the "two create-capable orgs: friendly message" test FAILS — `Unable to find an element with the text: /more than one organization/i` (the current title is "Pick an organization first"):
```
      Tests  1 failed | 5 passed (6)
```

- [ ] **Step 3: Rewrite the copy.** In `ui/src/onboarding/CreateAnotherCompany.tsx`, replace the ambiguous `EmptyState` (lines 124-136):

Current:
```tsx
  // resolution.kind === "ambiguous" (>=2 create-capable orgs). A picker is a
  // deferred follow-up; a friendly message is sufficient for the beta.
  return (
    <EmptyState
      title="Pick an organization first"
      description="You can create companies in more than one organization. Open the organization you want this company under, then create it from there."
      action={
        <Button variant="secondary" onClick={onBack}>
          Back to your workspace
        </Button>
      }
    />
  );
```

New:
```tsx
  // resolution.kind === "ambiguous" (>=2 create-capable orgs). A picker is a
  // deferred follow-up; an honest message is sufficient for the beta. Do NOT
  // reference an "open the organization … create it from there" flow — no such UI
  // exists yet.
  return (
    <EmptyState
      title="More than one organization"
      description="You belong to more than one organization, so we can't tell which one to create this company under. Choosing an organization here is coming soon — for now, go back to your workspace."
      action={
        <Button variant="secondary" onClick={onBack}>
          Back to your workspace
        </Button>
      }
    />
  );
```

- [ ] **Step 4: Run it — confirm GREEN.**

```bash
pnpm exec vitest run --root ui src/onboarding/__tests__/CreateAnotherCompany.test.tsx
```

Expected:
```
      Tests  6 passed (6)
```

- [ ] **Step 5: Commit.**

```bash
git add ui/src/onboarding/CreateAnotherCompany.tsx ui/src/onboarding/__tests__/CreateAnotherCompany.test.tsx
git commit -m "fix(onboarding): honest ambiguous-org copy (no nonexistent 'open the organization' flow)"
```

---

### Task L-b — Soften the "You can rename it later" org-step promise (no rename UI exists)

`CreateOrganizationStep.tsx:93` subtitle promises "You can rename it later" but no rename route/UI exists. Drop that sentence. Add a small guard so the false promise cannot creep back.

**Files:**
- Modify: `ui/src/onboarding/steps/CreateOrganizationStep.tsx` (line 93)
- Modify: `ui/src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx` (add one test to the existing `describe("CreateOrganizationStep", …)` block)

#### Steps

- [ ] **Step 1: Add the failing guard test.** In `ui/src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx`, add inside the `describe("CreateOrganizationStep", …)` block (e.g. after the "requires an organization name" test, ~line 31):

```ts
  it("does not promise renaming the organization later (no rename route/UI exists)", () => {
    render(<CreateOrganizationStep ctx={ctx} onComplete={() => {}} onBack={() => {}} />);
    // Using body text (not queryByText) avoids throwing on partial multi-node matches.
    expect(document.body.textContent).not.toMatch(/rename it later/i);
  });
```

- [ ] **Step 2: Run it — confirm RED.**

```bash
pnpm exec vitest run --root ui src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx
```

Expected FAIL: `expected '…You can rename it later.' not to match /rename it later/i`:
```
      Tests  1 failed | N passed
```

- [ ] **Step 3: Soften the copy.** In `ui/src/onboarding/steps/CreateOrganizationStep.tsx`, change line 93:

Current:
```tsx
          subtitle="Your organization is the account that owns your companies and billing. You can rename it later."
```

New:
```tsx
          subtitle="Your organization is the account that owns your companies and billing."
```

- [ ] **Step 4: Run it — confirm GREEN.**

```bash
pnpm exec vitest run --root ui src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx
```

Expected:
```
      Tests  all passed
```

- [ ] **Step 5: Commit.**

```bash
git add ui/src/onboarding/steps/CreateOrganizationStep.tsx ui/src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx
git commit -m "fix(onboarding): drop false 'rename it later' org promise (no rename UI)"
```

---

### Task M7 — Correct the false safety claim in the heartbeat comment + Decision #117 §4 (prose only)

> **★ SEQUENCING (from adversarial review): apply this sub-task AFTER D1 (build-order step 2), NOT during step 1.** The corrected comment + Decision #117 prose name **D1 as the actual guard**; if M7 lands before D1 the reference dangles. M7 and D1 edit different regions of `heartbeat.ts`, so there is no textual merge conflict — the ordering is only so the cross-reference resolves.

`heartbeat.ts:3206-3210` claims the null-target local fallback "can only ever land on a self-hosted trusted box." False: `provider-resolution.ts:327` only skips `personal_subscription` candidates on shared hosts — it says nothing about `company_api_key`. A `company_api_key` run on **shared** infra whose org has no `pooled_gvisor` target configured (DEFAULT-OFF gVisor) also resolves to `null` and falls back to local. **This task changes only a comment and a doc paragraph — no guard is added here (the guard is D1).** There is no test step: the change has no runtime behavior.

**Files:**
- Modify: `server/src/services/heartbeat.ts` (comment at lines 3202-3216)
- Modify: `docs/architecture/decisions.md` (Decision #117 §4, line 1791)

#### Steps

- [ ] **Step 1: Rewrite the heartbeat comment.** In `server/src/services/heartbeat.ts`, replace the comment block (lines 3202-3215):

Current:
```ts
    // ── P5 Task 9: route this run to the credential-appropriate execution target ──
    // Consume P4's normalized seam (p4CredentialHint) directly — do NOT re-read
    // provider_credentials. Business key ("company_api_key") → shared pool;
    // "personal_subscription" → its pinned dedicated target (fail-closed on a slug
    // mismatch). The multi_tenant fail-closed invariant is upheld UPSTREAM by the
    // resolver (provider-resolution.ts:327 skips personal_subscription candidates
    // when !selfHostedSingleTenant), so credentialKind is NEVER
    // "personal_subscription" on a shared host — a null-target local fallback below
    // can only ever land on a self-hosted trusted box. When no execution target is
    // configured (DEFAULT-OFF gVisor / self-hosted single tenant) the resolver
    // returns null → the run keeps its existing (environment or local)
    // executionTarget untouched (config reference preserved). Routing is best-effort:
    // a routing error (e.g. an unavailable environment pin) logs and falls back to
    // local rather than failing the run.
```

New:
```ts
    // ── P5 Task 9: route this run to the credential-appropriate execution target ──
    // Consume P4's normalized seam (p4CredentialHint) directly — do NOT re-read
    // provider_credentials. Business key ("company_api_key") → shared pool;
    // "personal_subscription" → its pinned dedicated target (fail-closed on a slug
    // mismatch). The resolver gate at provider-resolution.ts:327 skips
    // personal_subscription candidates when !selfHostedSingleTenant, so
    // credentialKind is NEVER "personal_subscription" on a shared host. That gate
    // does NOT, however, make the null-target local fallback below self-hosted-only:
    // a company_api_key run on SHARED infra whose org has no pooled_gvisor target
    // configured (DEFAULT-OFF gVisor) also resolves to null and falls back to the
    // local driver — on shared infra. Closing that shared-infra-no-pool fallback is
    // a separate guard (tracked as D1), NOT added here. When no execution target is
    // configured (DEFAULT-OFF gVisor / self-hosted single tenant) the resolver
    // returns null → the run keeps its existing (environment or local)
    // executionTarget untouched (config reference preserved). Routing is best-effort:
    // a routing error (e.g. an unavailable environment pin) logs and falls back to
    // local rather than failing the run.
```

- [ ] **Step 2: Correct Decision #117 §4 prose.** In `docs/architecture/decisions.md` (line 1791), replace the misleading parenthetical:

Current substring:
```
a `company_api_key` (business key) run routes to the org's `pooled_gvisor` target (or falls back to the local driver if none exists — self-hosted stays local);
```

New substring:
```
a `company_api_key` (business key) run routes to the org's `pooled_gvisor` target (or falls back to the local driver if no pooled target is configured — this local fallback also occurs on SHARED infra when the org has no pooled target, not only self-hosted; blocking a shared-infra `company_api_key` run from silently running locally is a separate guard tracked as D1);
```

- [ ] **Step 3: Verify the false phrase is gone and the correction is present** (no test — prose only):

```bash
grep -n "can only ever land on a self-hosted trusted box" server/src/services/heartbeat.ts docs/architecture/decisions.md
grep -n "shared-infra-no-pool fallback is" server/src/services/heartbeat.ts
grep -n "not only self-hosted; blocking a shared-infra" docs/architecture/decisions.md
```

Expected: the first `grep` prints **nothing** (exit 1 — the false claim is removed); the second and third each print one match.

- [ ] **Step 4: Confirm the touched TS file still typechecks (comment-only edit is inert but cheap to prove).** *(Reviewer correction: a comment-only change cannot fail a runtime test, so running `heartbeat-execution-target-routing.test.ts` proves nothing — use a typecheck instead.)*

```bash
pnpm --filter @armyofagents/server typecheck
```

Expected: exits 0 (no behavior changed).

- [ ] **Step 5: Commit.**

```bash
git add server/src/services/heartbeat.ts docs/architecture/decisions.md
git commit -m "docs(heartbeat): correct false 'self-hosted-only local fallback' claim (D1 is the actual guard)"
```

---

### Cluster-wide notes for the executor

- No item introduces an `AOA_*` env var, so `docs/deploy/environment-variables.md` / brand-check guard 9 is not engaged by this cluster.
- No item touches a `*.integration.test.ts` file — all test files run on Windows with no `skipIf` flip.
- **M1, M2, L-c, L-a, L-b are independent** — reorder/parallelize freely, each is its own commit. **M7 is the exception: apply it after D1** (see its ★ SEQUENCING note).

---

## 2. D1 — Explicit "unsandboxed multi-tenant" execution gate (Option A) — C1/H4/M5

**Branch:** `claude/multitenant-cloud`. The worktree `C:/Users/TK/.aoa/wt/mt-cloud` is the writable checkout for this bundle; run every command from its ROOT.

### Problem / decision

On `cloud_auth` (tenant isolation enforced — `tenantIsolationEnforced()`, `server/src/config/deployment-mode.ts`), agent, crew, and Commander runs today silently fall back to executing on the **local, unsandboxed control-plane host** whenever no sandbox execution target is configured:

- `packages/adapter-utils/src/execution-target.ts:58` — `resolveAdapterExecutionTarget` returns `{ type: "local" }` for an unset/`"local"` target **before** the `hardenForMultiTenant` branch (`:132`); the hardening only rewrites *docker/sandbox* targets, never the local fallback.
- Heartbeat (org agents): `server/src/services/heartbeat.ts:4512-4519` resolves that target and dispatches it to `adapter.execute`.
- Crew (`runAoaAgent`): `server/src/services/internal-agent/aoa-agents/runner.ts:667-671` → `adapter.execute({ … executionTarget … })` at `:923-929`.
- Commander: `server/src/services/internal-agent/cli-mode.ts` always `spawn`s the CLI directly on the host (`:1086`) — there is no execution target at all.

Real per-tenant isolation is a deferred initiative. D1 makes the current unsafe fallback a **conscious, opted-in gate**: on `cloud_auth`, an unsandboxed local run is **refused** unless a documented env `AOA_ALLOW_UNSANDBOXED_MULTITENANT=1` is set; when set, it logs one loud warning. Self-hosted deployments — including `authenticated` self-hosts (single org, own box, multiple humans) — and already-sandboxed targets are unaffected.

### ★ Signal correction (from adversarial review — this was the blocking finding)

The refusal keys off **`tenantIsolationEnforced()` (`deploymentMode === "cloud_auth"`)**, **NOT** `topology.trustBoundary === "multi_tenant"`. The two are **not equivalent**: every non-`local_trusted` deployment — including a standard `authenticated` self-host — derives `trustBoundary === "multi_tenant"` (`config.ts:178-181` forces `deploymentExposure="private"` only for `local_trusted`; `cli-auth-topology.ts:80-84` then maps everything else to `hosted_multi_tenant`, whose `trustBoundary = "multi_tenant"`). Gating the **refusal** on `multi_tenant` would silently break `authenticated` self-hosters on upgrade (org-agent + crew + Commander all refused until the env is set).

The existing execution-target **hardening** safely keeps the broad `multi_tenant` signal because it is a **no-op on a local target** (`execution-target.ts:58,132` only rewrites docker/sandbox targets). A **refusing** gate cannot borrow that signal. So the two are intentionally **DECOUPLED**:

| Concern | Signal | Why |
|---------|--------|-----|
| Hardening (neutralize tenant-authored docker/sandbox target) | `trustBoundary === "multi_tenant"` (broad) | No-op on a local target; safe to run on `authenticated` self-hosts. Unchanged from today. |
| **Refusal** (D1 — refuse an unsandboxed local run) | `tenantIsolationEnforced()` i.e. `cloud_auth` (narrow) | Only cloud multi-tenant must fail closed. `authenticated`/`local_trusted` self-hosters keep running. |

### ⚠ Deploy-critical + crew asymmetry (from adversarial review — surface loudly in the PR body)

- **(a) The QA/cloud deploy MUST set the env.** On any `cloud_auth` deployment (incl. the QA server) every host-local agent/crew/Commander run fails closed until `AOA_ALLOW_UNSANDBOXED_MULTITENANT=1` is set in that deployment's environment. Document this in the PR description and the deploy runbook.
- **(b) Crew is refused even when a gVisor pool IS configured.** The heartbeat sink pre-routes `company_api_key` runs to a `pooled_gvisor` sandbox (`resolveExecutionTargetForRun`, `heartbeat.ts:3216` → merged into `runScopedConfig`), so a configured pool makes the guard a **no-op** there. The **crew** sink (`runAoaAgent`, `runner.ts:667`) has **no** `resolveExecutionTargetForRun` call — its only target is the agent's `adapterConfig.executionTarget` (tenants don't set one), so on cloud **crew always resolves to `local` and the guard always fires, even with a pool configured**. Net: the single opt-in is **effectively mandatory for any crew on cloud**, and enabling it simultaneously permits unsandboxed org-agent local-fallback AND unsandboxed Commander. This is the intended Option-A tradeoff (make the unsafe fallback conscious), **not** real isolation. Wiring crew to `resolveExecutionTargetForRun` so a pool covers it too is a follow-up, out of D1's scope.

### Scope — the 4th unsandboxed sink is intentionally out of scope

CLI **extraction** (discussion / debrief-push / file-import) also runs the provider CLI unsandboxed on the shared host and is **NOT** one of D1's three sinks. D1 gates agent + crew + Commander **dispatch** only. Do not read "every execution sink" as including extraction; fail-closed enforcement for extraction is a separate, deferred item (D3 openQuestion #3 flags the sibling ambient-login concern).

### Risks (corrected)

- **DEPLOY GOTCHA:** cloud_auth/QA deployments fail-closed for ALL host-local runs until `AOA_ALLOW_UNSANDBOXED_MULTITENANT=1` is set — call out in the PR + QA-server env.
- **Crew-on-cloud all-or-nothing:** because crew has no pool pre-routing, the opt-in is effectively mandatory for any crew on cloud and re-permits org-agent local-fallback + Commander at the same time (see ⚠(b)).
- **Lease/workspace cleanup:** the org-agent guard throw at `heartbeat.ts:~4512` fires **after** environment-lease acquisition (`~:3968`) and workspace realization (`~:3478`). The final-verification step below requires confirming the surrounding `finally` (`~:5128`) releases the lease + worktree on this throw (or adding a pre-lease refusal) so a misconfigured cloud deployment does not leak a lease/worktree on every tick.
- **Crew-sink wiring** is verified via the shared helper's contract test + typecheck + a sanity grep rather than a full end-to-end `runAoaAgent` test (the runner's existing execution-target coverage is also helper-level).
- **Commander gate** resolves `tenantIsolationEnforced()` (module-level singleton, default `local_trusted`) per turn — cheap, and no longer depends on a per-turn `loadConfig()`/topology resolution.

All tests below are unit/route/jsdom-class (no `*.integration.test.ts`) → they run on Windows with **no skipIf flip needed**.

---

### Task D1.1 — Shared guard module + unit test

**Files:**
- Create `server/src/services/unsandboxed-multitenant-guard.ts`
- Test (create) `server/src/__tests__/unsandboxed-multitenant-guard.test.ts`

Steps:

- [ ] **Step 1: Write the failing unit test.** Create `server/src/__tests__/unsandboxed-multitenant-guard.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard imports the app logger; stub it so importing the module has no side
// effects. The tests inject their own `log`, so this stub is belt-and-suspenders.
vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => ({ warn: vi.fn() }) },
}));

import {
  assertUnsandboxedMultitenantAllowed,
  isUnsandboxedLocalTarget,
  resetUnsandboxedMultitenantWarning,
  UNSANDBOXED_MULTITENANT_OPT_IN_ENV,
} from "../services/unsandboxed-multitenant-guard.js";

describe("assertUnsandboxedMultitenantAllowed (D1)", () => {
  beforeEach(() => resetUnsandboxedMultitenantWarning());

  const local = { type: "local" as const };
  const dockerSandbox = { type: "sandbox-docker" as const, image: "node:22" };
  const providerSandbox = {
    type: "provider-sandbox" as const,
    provider: "modal",
    providerLeaseId: "lease-1",
    remoteCwd: "/workspace",
    shell: "sh" as const,
    env: {},
    runner: { execute: async () => ({}) } as any,
  };
  const noEnv: NodeJS.ProcessEnv = {};
  const optedIn: NodeJS.ProcessEnv = { [UNSANDBOXED_MULTITENANT_OPT_IN_ENV]: "1" };

  it("throws on cloud_auth (isolation enforced) + local target + no opt-in", () => {
    expect(() =>
      assertUnsandboxedMultitenantAllowed(local, { tenantIsolationEnforced: true, sink: "org agent", env: noEnv }),
    ).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
    expect(() =>
      assertUnsandboxedMultitenantAllowed(local, { tenantIsolationEnforced: true, sink: "org agent", env: noEnv }),
    ).toThrow(/org agent/);
  });

  it("throws on cloud_auth + null/undefined target (treated as local) + no opt-in", () => {
    expect(() =>
      assertUnsandboxedMultitenantAllowed(null, { tenantIsolationEnforced: true, sink: "crew agent", env: noEnv }),
    ).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
    expect(() =>
      assertUnsandboxedMultitenantAllowed(undefined, { tenantIsolationEnforced: true, sink: "Commander", env: noEnv }),
    ).toThrow();
  });

  it("allows (no throw) and warns ONCE on cloud_auth + local + opt-in", () => {
    const log = { warn: vi.fn() };
    expect(() =>
      assertUnsandboxedMultitenantAllowed(local, { tenantIsolationEnforced: true, sink: "org agent", env: optedIn, log }),
    ).not.toThrow();
    // second call in the same process must NOT warn again
    assertUnsandboxedMultitenantAllowed(local, { tenantIsolationEnforced: true, sink: "org agent", env: optedIn, log });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][1]).toContain(UNSANDBOXED_MULTITENANT_OPT_IN_ENV);
  });

  it("is a no-op when tenant isolation is NOT enforced (self-hosted local_trusted / authenticated)", () => {
    const log = { warn: vi.fn() };
    // A plain self-hosted install...
    expect(() =>
      assertUnsandboxedMultitenantAllowed(local, { tenantIsolationEnforced: false, sink: "org agent", env: noEnv, log }),
    ).not.toThrow();
    // ...and an `authenticated` self-host (multi_tenant boundary but NOT cloud_auth):
    // still allowed — this is the whole point of gating on cloud_auth, not trustBoundary.
    expect(() =>
      assertUnsandboxedMultitenantAllowed(null, { tenantIsolationEnforced: false, sink: "org agent", env: noEnv, log }),
    ).not.toThrow();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("is a no-op on cloud_auth when the target is already sandboxed", () => {
    const log = { warn: vi.fn() };
    expect(() =>
      assertUnsandboxedMultitenantAllowed(dockerSandbox, { tenantIsolationEnforced: true, sink: "org agent", env: noEnv, log }),
    ).not.toThrow();
    expect(() =>
      assertUnsandboxedMultitenantAllowed(providerSandbox, { tenantIsolationEnforced: true, sink: "org agent", env: noEnv, log }),
    ).not.toThrow();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("isUnsandboxedLocalTarget classifies targets", () => {
    expect(isUnsandboxedLocalTarget(local)).toBe(true);
    expect(isUnsandboxedLocalTarget(null)).toBe(true);
    expect(isUnsandboxedLocalTarget(undefined)).toBe(true);
    expect(isUnsandboxedLocalTarget(dockerSandbox)).toBe(false);
    expect(isUnsandboxedLocalTarget(providerSandbox)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — confirm it FAILS** (module does not exist yet):

```
pnpm exec vitest run --root server unsandboxed-multitenant-guard
```
Expected: suite fails to load — `Error: Failed to load url ../services/unsandboxed-multitenant-guard.js` / `Cannot find module`. (0 tests pass.)

- [ ] **Step 3: Minimal implementation.** Create `server/src/services/unsandboxed-multitenant-guard.ts`:

```ts
// server/src/services/unsandboxed-multitenant-guard.ts
//
// D1 (PR #316 multi-tenant follow-up): explicit "unsandboxed multi-tenant"
// execution gate. When tenant isolation is ENFORCED (cloud_auth), a run whose
// RESOLVED execution target is the local, unsandboxed control-plane host is a
// tenant-code-on-shared-host hazard. Real per-tenant execution isolation is a
// separate, deferred initiative; until it lands, an unsandboxed local run on a
// cloud_auth deployment must be an EXPLICIT operator opt-in rather than the
// silent default fallback.
//
// This guard REFUSES (throws) such a run unless AOA_ALLOW_UNSANDBOXED_MULTITENANT
// is set, and when it is set it logs one loud SECURITY warning per process. It is
// a no-op on every self-hosted deployment (tenantIsolationEnforced() === false —
// local_trusted AND authenticated single-tenant) and a no-op when the resolved
// target is already isolated (sandbox-docker / provider-sandbox). It does NOT
// implement isolation — it makes the current unsafe fallback conscious.
//
// SIGNAL: gate on tenantIsolationEnforced() (cloud_auth), NOT trustBoundary ===
// "multi_tenant". The latter is TRUE for `authenticated` self-hosts too and would
// wrongly refuse them. The caller passes the boolean so this stays pure/testable.
import type { AdapterExecutionTarget } from "@armyofagents/adapter-utils";
import { logger } from "../middleware/logger.js";

/** Documented opt-in env (see docs/deploy/environment-variables.md). */
export const UNSANDBOXED_MULTITENANT_OPT_IN_ENV = "AOA_ALLOW_UNSANDBOXED_MULTITENANT";

/** True when the resolved target executes directly on the unsandboxed host. */
export function isUnsandboxedLocalTarget(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return !target || target.type === "local";
}

function optInEnabled(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes)$/i.test(env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV]?.trim() ?? "");
}

// One loud warning per process when the operator has opted in.
let hasWarnedUnsandboxedMultitenant = false;

/** Test-only: reset the per-process warn-once latch. */
export function resetUnsandboxedMultitenantWarning(): void {
  hasWarnedUnsandboxedMultitenant = false;
}

export interface UnsandboxedMultitenantGuardOptions {
  /**
   * Whether tenant isolation is enforced for this deployment — pass
   * `tenantIsolationEnforced()` (true iff deploymentMode === "cloud_auth").
   * Do NOT pass a trustBoundary-derived signal: `authenticated` self-hosts are
   * multi_tenant but must NOT be refused.
   */
  tenantIsolationEnforced: boolean;
  /** Human label for the run kind ("org agent" / "crew agent" / "Commander"). */
  sink: string;
  /** Env source (default process.env) — injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Logger sink (default the app logger) — injectable for tests. */
  log?: Pick<typeof logger, "warn">;
}

/**
 * Refuse an unsandboxed local run on an enforced-isolation (cloud_auth) deployment
 * unless the operator has explicitly opted in via AOA_ALLOW_UNSANDBOXED_MULTITENANT.
 * No-op on every self-hosted deployment and on already-isolated (sandbox) targets.
 * When opted in, logs one loud warning per process.
 *
 * @throws Error when tenant isolation is enforced (cloud_auth), the target is
 *   local/unsandboxed, and the opt-in env is not set.
 */
export function assertUnsandboxedMultitenantAllowed(
  target: AdapterExecutionTarget | null | undefined,
  opts: UnsandboxedMultitenantGuardOptions,
): void {
  // Only cloud_auth (tenant isolation enforced) gates. Every self-hosted
  // deployment — local_trusted AND authenticated single-tenant — is exempt.
  if (!opts.tenantIsolationEnforced) return;
  // Already isolated (sandbox-docker / provider-sandbox): safe on shared infra.
  if (!isUnsandboxedLocalTarget(target)) return;

  const env = opts.env ?? process.env;
  if (!optInEnabled(env)) {
    throw new Error(
      `Refusing to dispatch a ${opts.sink} run on the unsandboxed control-plane host ` +
        `under enforced tenant isolation (cloud_auth). Per-tenant execution isolation is ` +
        `not yet implemented; set ${UNSANDBOXED_MULTITENANT_OPT_IN_ENV}=1 to explicitly ` +
        `allow unsandboxed local runs on this shared deployment, or configure a sandboxed ` +
        `execution target.`,
    );
  }

  if (!hasWarnedUnsandboxedMultitenant) {
    hasWarnedUnsandboxedMultitenant = true;
    (opts.log ?? logger).warn(
      { sink: opts.sink, optIn: UNSANDBOXED_MULTITENANT_OPT_IN_ENV },
      `SECURITY: ${UNSANDBOXED_MULTITENANT_OPT_IN_ENV} is set — executing ${opts.sink} ` +
        `runs UNSANDBOXED on the shared cloud_auth host. Tenant code runs directly on the ` +
        `control-plane host with NO per-tenant isolation. This is an explicit operator ` +
        `override; do not use it in production multi-tenant deployments.`,
    );
  }
}
```

Note: the guard reads the flag via the injectable `env` param (mirrors `enabledFlag(env, name)` in `cli-auth-topology.ts:123`), so brand-check guard 9's `process\.env\.AOA_*` grep does not require the doc — but Task D1.5 documents it regardless (mandatory per plan rules).

- [ ] **Step 4: Run — confirm it PASSES:**

```
pnpm exec vitest run --root server unsandboxed-multitenant-guard
```
Expected: `Test Files  1 passed (1)` / `Tests  6 passed (6)`.

- [ ] **Step 5: Commit.** `git add server/src/services/unsandboxed-multitenant-guard.ts server/src/__tests__/unsandboxed-multitenant-guard.test.ts && git commit -m "feat(multitenant): add unsandboxed multi-tenant execution guard (D1)"`

---

### Task D1.2 — Wire the heartbeat (org-agent) sink via a shared guarded helper

Introduce one exported combinator `resolveGuardedAdapterExecutionContext` (resolve + guard) so the org-agent and crew sinks share identical behavior and a single test surface. **The two signals it takes are decoupled** (see the ★ correction): `trustBoundary` drives hardening, `tenantIsolationEnforced` drives the refusal.

**Files:**
- Modify `server/src/services/heartbeat.ts` — add imports after `:37`; add helper after `:332`; swap the dispatch call at `:4512-4519`.
- Test (modify) `server/src/__tests__/heartbeat-execution-target.test.ts` — extend the vitest import; append a describe block.

Steps:

- [ ] **Step 1: Write the failing test.** In `server/src/__tests__/heartbeat-execution-target.test.ts`, change the first import line:

```ts
import { describe, expect, it, vi } from "vitest";
```
to:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```
add `resolveGuardedAdapterExecutionContext` to the existing import-from-`../services/heartbeat.js` list (the block starting `import {` at `:67`), and append this describe to the file:

```ts
describe("resolveGuardedAdapterExecutionContext — org-agent sink (D1)", () => {
  const OPT_IN = "AOA_ALLOW_UNSANDBOXED_MULTITENANT";
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[OPT_IN]; delete process.env[OPT_IN]; });
  afterEach(() => { if (saved === undefined) delete process.env[OPT_IN]; else process.env[OPT_IN] = saved; });

  it("refuses a local target on cloud_auth (isolation enforced) without the opt-in", () => {
    expect(() =>
      resolveGuardedAdapterExecutionContext({}, { getRuntimeCommandSpec: vi.fn(() => null) }, {
        trustBoundary: "multi_tenant",
        tenantIsolationEnforced: true,
        sink: "org agent",
      }),
    ).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
  });

  it("allows a local target on cloud_auth when the opt-in is set", () => {
    process.env[OPT_IN] = "1";
    const result = resolveGuardedAdapterExecutionContext({}, { getRuntimeCommandSpec: vi.fn(() => null) }, {
      trustBoundary: "multi_tenant",
      tenantIsolationEnforced: true,
      sink: "org agent",
    });
    expect(result.executionTarget).toEqual({ type: "local" });
  });

  it("honors a local target on an authenticated self-host (multi_tenant boundary, isolation NOT enforced) without any opt-in", () => {
    // ★ This is the regression the signal correction fixes: multi_tenant hardening
    // signal is TRUE but tenant isolation is NOT enforced (cloud_auth false), so the
    // authenticated self-hoster keeps running a local target with no opt-in.
    const result = resolveGuardedAdapterExecutionContext({}, { getRuntimeCommandSpec: vi.fn(() => null) }, {
      trustBoundary: "multi_tenant",
      tenantIsolationEnforced: false,
      sink: "org agent",
    });
    expect(result.executionTarget).toEqual({ type: "local" });
  });

  it("no-ops the guard on cloud_auth when the resolved target is a hardened sandbox (hardening still applies)", () => {
    const result = resolveGuardedAdapterExecutionContext(
      { executionTarget: { type: "sandbox-docker", image: "node:22", network: "host", allowHostGateway: true } },
      { getRuntimeCommandSpec: vi.fn(() => null) },
      { trustBoundary: "multi_tenant", tenantIsolationEnforced: true, sink: "org agent" },
    );
    if (result.executionTarget.type !== "sandbox-docker") throw new Error("expected sandbox-docker");
    // sink hardening still applied (mirrors the existing multi_tenant test above)
    expect(result.executionTarget.allowHostGateway).toBe(false);
    expect(result.executionTarget.network).toBe("none");
  });
});
```

- [ ] **Step 2: Run — confirm it FAILS** (helper not exported yet):

```
pnpm exec vitest run --root server heartbeat-execution-target
```
Expected: new describe's 4 tests fail — `resolveGuardedAdapterExecutionContext is not a function` (undefined import). Existing tests still pass.

- [ ] **Step 3: Implementation.** In `server/src/services/heartbeat.ts`, after the existing line `:37` (`import { mergeResolvedExecutionTarget } from "./heartbeat-execution-target.js";`) add:

```ts
import type { TrustBoundary } from "./cli-auth-topology.js";
import { assertUnsandboxedMultitenantAllowed } from "./unsandboxed-multitenant-guard.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
```

Then, immediately after the close of `resolveAdapterExecutionContext` (after `:332`), add the combinator:

```ts
// D1: resolve the run's execution target AND apply the unsandboxed multi-tenant
// gate in one call, so every dispatch sink (org-agent heartbeat + crew runner)
// gets identical refuse/allow behavior. NOTE the two signals are intentionally
// DECOUPLED (see the ★ signal correction): hardening keys off
// `trustBoundary === "multi_tenant"` (broad — also neutralizes a tenant-authored
// docker target on an `authenticated` self-host, a safe no-op on a local target),
// while the REFUSAL keys off `tenantIsolationEnforced` (cloud_auth only). This
// keeps `authenticated` self-hosters running (hardening no-ops on their local
// target; the guard does not fire) while cloud_auth refuses.
export function resolveGuardedAdapterExecutionContext(
  config: unknown,
  adapter: Pick<ServerAdapterModule, "getRuntimeCommandSpec">,
  opts: { trustBoundary: TrustBoundary; tenantIsolationEnforced: boolean; sink: string },
) {
  const resolved = resolveAdapterExecutionContext(
    config,
    adapter,
    opts.trustBoundary === "multi_tenant",
  );
  assertUnsandboxedMultitenantAllowed(resolved.executionTarget, {
    tenantIsolationEnforced: opts.tenantIsolationEnforced,
    sink: opts.sink,
  });
  return resolved;
}
```

Then swap the dispatch call at `:4512-4519`. Current:

```ts
      const { executionTarget, runtimeCommandSpec } = resolveAdapterExecutionContext(
        runScopedConfig,
        adapter,
        // Sink-level multi_tenant hardening: neutralize a tenant-authored
        // adapterConfig.executionTarget on shared infra; honor it on the
        // founder's own box. hbTopology is already resolved above (:3081).
        hbTopology.trustBoundary === "multi_tenant",
      );
```
New:
```ts
      const { executionTarget, runtimeCommandSpec } = resolveGuardedAdapterExecutionContext(
        runScopedConfig,
        adapter,
        // Sink-level multi_tenant hardening (trustBoundary) + D1 unsandboxed gate
        // (cloud_auth): neutralize a tenant-authored adapterConfig.executionTarget on
        // shared infra, and REFUSE an unsandboxed local dispatch on cloud_auth unless
        // the operator opted in (AOA_ALLOW_UNSANDBOXED_MULTITENANT). hbTopology is
        // resolved above (:3081); tenantIsolationEnforced() is the cloud_auth signal.
        {
          trustBoundary: hbTopology.trustBoundary,
          tenantIsolationEnforced: tenantIsolationEnforced(),
          sink: "org agent",
        },
      );
```
(A throw here terminalizes the run via the surrounding heartbeat run catch — the intended "refuse to dispatch" behavior. See the lease/workspace-cleanup verification in Final verification.)

- [ ] **Step 4: Run — confirm it PASSES:**

```
pnpm exec vitest run --root server heartbeat-execution-target
```
Expected: `Test Files  1 passed (1)` / `Tests  15 passed (15)` (11 pre-existing + 4 new).

- [ ] **Step 5: Commit.** `git add server/src/services/heartbeat.ts server/src/__tests__/heartbeat-execution-target.test.ts && git commit -m "feat(multitenant): gate the org-agent dispatch sink on unsandboxed multi-tenant (D1)"`

---

### Task D1.3 — Wire the crew (`runAoaAgent`) sink

The crew runner imports and calls the heartbeat helper; switch it to the guarded variant. Its behavior is identical to the org-agent sink (same shared helper); the new test asserts the crew-sink contract that the runner's call site passes.

> **Crew asymmetry reminder (⚠(b) above):** the crew sink has NO `resolveExecutionTargetForRun` pre-routing, so on cloud its target is always `local` and the guard **always** fires — even when a gVisor pool is configured. Enabling the opt-in for crew therefore also re-permits org-agent local-fallback + Commander. Intended for Option A; note it in the PR.

**Files:**
- Modify `server/src/services/internal-agent/aoa-agents/runner.ts` — import at `:14`; add the deployment-mode import; call site at `:667-671`.
- Test (modify) `server/src/__tests__/heartbeat-execution-target.test.ts` — append one describe.

Steps:

- [ ] **Step 1: Write the failing test.** Append to `server/src/__tests__/heartbeat-execution-target.test.ts`:

```ts
describe("resolveGuardedAdapterExecutionContext — crew-agent sink (D1)", () => {
  // The crew runner (aoa-agents/runner.ts) dispatches through this SAME guarded
  // helper, passing sink:"crew agent". This is that call site's contract.
  const OPT_IN = "AOA_ALLOW_UNSANDBOXED_MULTITENANT";
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[OPT_IN]; delete process.env[OPT_IN]; });
  afterEach(() => { if (saved === undefined) delete process.env[OPT_IN]; else process.env[OPT_IN] = saved; });

  it("refuses a local crew run on cloud_auth without the opt-in and names the crew sink", () => {
    expect(() =>
      resolveGuardedAdapterExecutionContext({}, { getRuntimeCommandSpec: vi.fn(() => null) }, {
        trustBoundary: "multi_tenant",
        tenantIsolationEnforced: true,
        sink: "crew agent",
      }),
    ).toThrow(/crew agent/);
  });

  it("allows a local crew run on cloud_auth when opted in", () => {
    process.env[OPT_IN] = "1";
    const result = resolveGuardedAdapterExecutionContext({}, { getRuntimeCommandSpec: vi.fn(() => null) }, {
      trustBoundary: "multi_tenant",
      tenantIsolationEnforced: true,
      sink: "crew agent",
    });
    expect(result.executionTarget).toEqual({ type: "local" });
  });
});
```

- [ ] **Step 2: Run — confirm it PASSES already** (the shared helper exists from D1.2; this locks the crew-sink contract before the runner edit):

```
pnpm exec vitest run --root server heartbeat-execution-target
```
Expected: `Tests  17 passed (17)`. (If it fails, D1.2 was not applied.)

- [ ] **Step 3: Implementation.** In `server/src/services/internal-agent/aoa-agents/runner.ts`, change the import at `:14`:

```ts
import { resolveAdapterExecutionContext } from "../../heartbeat.js";
```
to:
```ts
import { resolveGuardedAdapterExecutionContext } from "../../heartbeat.js";
```
and add the deployment-mode import alongside the other service imports:
```ts
import { tenantIsolationEnforced } from "../../../config/deployment-mode.js";
```
Then the call site at `:667-671`. Current:
```ts
    const { executionTarget, runtimeCommandSpec } = resolveAdapterExecutionContext(
      config,
      adapter,
      topology.trustBoundary === "multi_tenant",
    );
```
New:
```ts
    const { executionTarget, runtimeCommandSpec } = resolveGuardedAdapterExecutionContext(
      config,
      adapter,
      // Sink-level multi_tenant hardening (trustBoundary) + D1 unsandboxed gate
      // (cloud_auth) for CREW runs. `topology` is already resolved above (:544);
      // tenantIsolationEnforced() is the cloud_auth signal.
      {
        trustBoundary: topology.trustBoundary,
        tenantIsolationEnforced: tenantIsolationEnforced(),
        sink: "crew agent",
      },
    );
```
(A throw here fails the crew run — `runAoaAgent` terminalizes the claimed entry and posts a failure card via its existing catch, so the founder sees a clear reason.)

- [ ] **Step 4: Verify the runner still typechecks and its existing suites are green:**

```
pnpm --filter @armyofagents/server typecheck
pnpm exec vitest run --root server aoa-runner
```
Expected: typecheck exits 0 (no "resolveAdapterExecutionContext is not exported / unused" errors); `aoa-runner*` suites pass unchanged.

- [ ] **Step 5: Commit.** `git add server/src/services/internal-agent/aoa-agents/runner.ts server/src/__tests__/heartbeat-execution-target.test.ts && git commit -m "feat(multitenant): gate the crew dispatch sink on unsandboxed multi-tenant (D1)"`

---

### Task D1.4 — Wire the Commander (cli-mode) sink

Commander always spawns its CLI on the host — there is no execution target — so it passes a synthetic `{ type: "local" }`. The gate is placed as the FIRST statement of `chat` (before CLI-tool validation) so a refusal is deterministic and spawn-free.

> **Reviewer correction applied:** the gate reads the module-level **`tenantIsolationEnforced()`** (`config/deployment-mode.ts`, default `local_trusted`) instead of a per-turn `loadConfig()` + `resolveCliAuthTopology()`. This is cheaper and removes the old dependency on "existing cli-mode tests default to single_user" (which was only true if the test env had no config file / `AOA_DEPLOYMENT_MODE`). Existing cli-mode tests are unaffected: the module default is `local_trusted` → `tenantIsolationEnforced()` false → gate no-op.

**Files:**
- Modify `server/src/services/internal-agent/cli-mode.ts` — insert a guard block at the top of `chat` (after `:755`, before `// 1. Validate CLI tool config` at `:756`).
- Test (modify) `server/src/__tests__/cli-mode.test.ts` — append a describe.

Steps:

- [ ] **Step 1: Write the failing test.** Append to `server/src/__tests__/cli-mode.test.ts` (uses `setDeploymentMode` imported from within the reset-module graph, so the mode the test sets and the mode the gate reads are the SAME fresh singleton — a top-level import would be a stale instance after `vi.resetModules()`):

```ts
describe("cliModeService.chat — D1 multi-tenant unsandboxed gate", () => {
  const OPT_IN = "AOA_ALLOW_UNSANDBOXED_MULTITENANT";
  let savedOptIn: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    savedOptIn = process.env[OPT_IN];
    delete process.env[OPT_IN];
  });
  afterEach(() => {
    if (savedOptIn === undefined) delete process.env[OPT_IN];
    else process.env[OPT_IN] = savedOptIn;
  });

  // cliTool:null makes the turn deterministic — the D1 gate runs FIRST; if it
  // passes, the very next chunk is the "No CLI tool configured" error. No CLI
  // detection, no spawn, no provider resolution, no hang. The deployment mode is
  // set on the SAME freshly-reset module graph the gate will import.
  async function firstError(
    deploymentMode: "cloud_auth" | "local_trusted" | "authenticated",
    configOverride: Record<string, unknown> = {},
  ) {
    const { setDeploymentMode } = await import("../config/deployment-mode.js");
    setDeploymentMode(deploymentMode);
    const { cliModeService } = await import("../services/internal-agent/cli-mode.js");
    const service = cliModeService({} as any);
    const chunks: any[] = [];
    for await (const chunk of service.chat(
      {
        companyId: "comp1",
        userId: "user1",
        userRole: "founder",
        content: "hi",
        enabledCapabilities: [],
        conversationId: "conv-a",
      } as any,
      { cliTool: null, executionMode: "cli", ...configOverride } as any,
    )) {
      chunks.push(chunk);
      if (chunk.type === "error") break;
    }
    return chunks.find((c) => c.type === "error");
  }

  it("refuses a Commander turn on cloud_auth without the opt-in", async () => {
    const err = await firstError("cloud_auth");
    expect(err).toBeDefined();
    expect(err.message).toContain(OPT_IN);
    expect(err.message).toContain("Commander");
  });

  it("proceeds past the gate when the opt-in is set (falls through to the config check)", async () => {
    process.env[OPT_IN] = "1";
    const err = await firstError("cloud_auth");
    expect(err).toBeDefined();
    expect(err.message).not.toContain(OPT_IN);
    expect(err.message).toContain("No CLI tool configured");
  });

  it("is a no-op on a self-hosted (local_trusted) install", async () => {
    const err = await firstError("local_trusted");
    expect(err).toBeDefined();
    expect(err.message).not.toContain(OPT_IN);
    expect(err.message).toContain("No CLI tool configured");
  });

  it("is a no-op on a self-hosted authenticated (single-tenant) install", async () => {
    // ★ authenticated is NOT cloud_auth → tenantIsolationEnforced() false → no gate.
    const err = await firstError("authenticated");
    expect(err).toBeDefined();
    expect(err.message).not.toContain(OPT_IN);
    expect(err.message).toContain("No CLI tool configured");
  });
});
```

- [ ] **Step 2: Run — confirm it FAILS** (gate not wired: the cloud_auth-without-opt-in case yields "No CLI tool configured" instead of the refusal):

```
pnpm exec vitest run --root server cli-mode.test
```
Expected: the first new test fails — `expect(err.message).toContain("AOA_ALLOW_UNSANDBOXED_MULTITENANT")` — received "No CLI tool configured…". Existing cli-mode tests still pass.

- [ ] **Step 3: Implementation.** In `server/src/services/internal-agent/cli-mode.ts`, insert the gate as the first statement of `chat`. Current (`:755-757`):

```ts
    ): AsyncGenerator<AgentStreamChunk> {
      // 1. Validate CLI tool config
      if (!config.cliTool) {
```
New:
```ts
    ): AsyncGenerator<AgentStreamChunk> {
      // ── D1: multi-tenant unsandboxed execution gate ──────────────────────
      // Commander always spawns its CLI directly on the control-plane host —
      // there is no execution-target sandbox for a Commander turn. When tenant
      // isolation is enforced (cloud_auth) that is an unsandboxed shared-host run,
      // which must be an explicit operator opt-in. Read the module-level
      // tenantIsolationEnforced() (cheap; no per-turn loadConfig/topology) and
      // REFUSE the turn (loud error chunk) unless AOA_ALLOW_UNSANDBOXED_MULTITENANT
      // is set. No-op on every self-hosted deployment (local_trusted / authenticated
      // single-tenant) → byte-identical for local/self-hosted installs.
      try {
        const { tenantIsolationEnforced } = await import("../../config/deployment-mode.js");
        const { assertUnsandboxedMultitenantAllowed } = await import(
          "../unsandboxed-multitenant-guard.js"
        );
        assertUnsandboxedMultitenantAllowed(
          { type: "local" },
          { tenantIsolationEnforced: tenantIsolationEnforced(), sink: "Commander" },
        );
      } catch (guardErr) {
        yield {
          type: "error",
          message: guardErr instanceof Error ? guardErr.message : String(guardErr),
        };
        return;
      }

      // 1. Validate CLI tool config
      if (!config.cliTool) {
```
(Dynamic imports match the file's existing pattern in `resolveCommanderSpawnEnvPatch` at `:685-695`.)

- [ ] **Step 4: Run — confirm it PASSES:**

```
pnpm exec vitest run --root server cli-mode.test
```
Expected: `Test Files  1 passed (1)` / all pre-existing cli-mode tests + 4 new = pass.

- [ ] **Step 5: Commit.** `git add server/src/services/internal-agent/cli-mode.ts server/src/__tests__/cli-mode.test.ts && git commit -m "feat(multitenant): gate Commander CLI turns on unsandboxed multi-tenant (D1)"`

---

### Task D1.5 — Document `AOA_ALLOW_UNSANDBOXED_MULTITENANT`

Mandatory per plan rules (brand-check guard 9, `.github/workflows/pr.yml:328-343`).

**Files:**
- Modify `docs/deploy/environment-variables.md` — insert a subsection at the end of the "Execution targets & gVisor pool egress" section (after `:91`, before `## Agent JWT` at `:93`).

Steps:

- [ ] **Step 1: Add the doc entry.** Insert between the line ending `` `bridge`. `` (`:91`) and `## Agent JWT (signing for `AOA_API_KEY`)` (`:93`):

```md
### Unsandboxed multi-tenant execution gate

| Variable | Default | Description |
| --- | --- | --- |
| `AOA_ALLOW_UNSANDBOXED_MULTITENANT` | unset (runs refused) | **Multi-tenant safety gate (D1).** When tenant isolation is enforced (`cloud_auth`), any agent, crew, or Commander run that would execute on the **local, unsandboxed control-plane host** is REFUSED unless this is set to `1`/`true`/`yes`. Real per-tenant execution isolation is a deferred initiative; until it lands, unsandboxed local execution on shared infra must be an explicit operator choice. When set, the process logs one loud SECURITY warning. Self-hosted deployments (`local_trusted` and `authenticated` single-tenant) ignore this — their local runs are always allowed. **A cloud/QA deployment that runs agents/crew/Commander on the host must set this deliberately, or every dispatch fails closed.** Note: because the crew sink has no gVisor-pool pre-routing, enabling crew on cloud requires this env even if a pool is configured. |
```

- [ ] **Step 2: Verify guard 9 is satisfied** (the doc mentions the var):

```
grep -oE 'AOA_[A-Z_]+' docs/deploy/environment-variables.md | grep -x AOA_ALLOW_UNSANDBOXED_MULTITENANT
```
Expected: prints `AOA_ALLOW_UNSANDBOXED_MULTITENANT` (present). Optionally sanity-check the brand-check env-doc step from `.github/workflows/pr.yml:331-343` locally.

- [ ] **Step 3: Commit.** `git add docs/deploy/environment-variables.md && git commit -m "docs(deploy): document AOA_ALLOW_UNSANDBOXED_MULTITENANT (D1)"`

---

### Final verification (whole item)

- [ ] `pnpm --filter @armyofagents/server typecheck` → exits 0.
- [ ] `pnpm exec vitest run --root server unsandboxed-multitenant-guard heartbeat-execution-target cli-mode.test` → all three suites green.
- [ ] **Sanity grep — every sink routes through the gate:**
  - `grep -n "resolveGuardedAdapterExecutionContext" server/src/services/heartbeat.ts server/src/services/internal-agent/aoa-agents/runner.ts` → helper defined + used in heartbeat (`~:4512`), used in runner (`~:667`).
  - `grep -n "assertUnsandboxedMultitenantAllowed" server/src/services/internal-agent/cli-mode.ts` → Commander block present.
- [ ] **★ Lease/workspace-cleanup verification (reviewer MED).** Confirm the org-agent guard throw at `heartbeat.ts:~4512` is enclosed by the run's outer `try` whose `finally` (`~:5128`) releases the environment lease (acquired `~:3968`) and the realized workspace/worktree (`realizedWorkspace`, `~:3478`). Read the region to confirm the throw path hits that `finally`. **If it does NOT** (guard throws outside the try), add an EARLY refusal: call `assertUnsandboxedMultitenantAllowed(resolvedRunTarget, { tenantIsolationEnforced: tenantIsolationEnforced(), sink: "org agent" })` immediately after `resolveExecutionTargetForRun` merges the target into `runScopedConfig` (`~:3246`), BEFORE lease acquisition + workspace realization, so a refusal on a misconfigured cloud deployment cannot leak a lease/worktree on every heartbeat tick.
- [ ] **Coverage note (reviewer).** All D1 coverage is helper-level + route/jsdom + a sanity grep — no test exercises a *real* end-to-end crew/heartbeat dispatch being refused. The helper+grep floor is a defensible pragmatic minimum; **optionally** add one integration test (a `cloud_auth` run refused without the env, allowed with it) if the reviewer wants runtime proof. Not required to land.

---

## 3. D2 — Full bundle-import fix (H2 + H3)

### Root cause (verified against source @ `claude/multitenant-cloud` HEAD b7634e22)

**H2 — agent-import privilege escalation.** `server/src/services/company-portability.ts:2213-2215` runs
`await access.ensureRealOperator(targetCompany.id, actorUserId)` **unconditionally whenever `include.agents`** — for BOTH
`new_company` and `existing_company` targets. `accessService.ensureRealOperator` (`server/src/services/access.ts:284-334`)
takes the *passed caller* and, with **no existing-founder lookup**, (a) inserts an `owner` `company_memberships` row
(`access.ts:304`, and `ensureMembership` **upgrades** member→owner at `:259-266`), (b) inserts a `role='founder'`
`user_roles` row (`access.ts:308-310`), and (c) inserts an `owner` `organization_memberships` row for the company's org
(`access.ts:322-332`). So **any board caller who imports an agents-bundle into a company they already belong to is promoted
to founder + org owner.** The route authorize callback (`server/src/routes/companies.ts:172-180`) does **not** gate this:
`getImportAuthorizationContext` (`company-portability.ts:171-226`) never inspects `include.agents`, so an agents-only bundle
(no assigned issues, no workflow templates) passes `authorize` as a **no-op**. The comment at `company-portability.ts:2205-2212`
("Idempotent: returns the existing founder when one is already present, so it is safe for the existing-company path too") is
**factually wrong** — `ensureRealOperator` never looks up an existing founder; it always writes rows for the *caller*.

**H3 — new_company lands in the DEFAULT sentinel org.** `POST /import` (`companies.ts:160-199`) runs only `assertBoard`
(+ `assertCompanyAccess` for existing). For `new_company` it does **not** call `resolveCompanyOrganizationId` /
`assertCompanyCreateAuthorized` the way `POST /` does (`companies.ts:216-226`). `importBundle`'s `new_company` branch
(`company-portability.ts:2160-2173`) calls `companies.create({...})` with **no `organizationId`**, and
`createCompanyWithUniquePrefix` (`companies.ts:131`) then defaults it to `DEFAULT_ORGANIZATION_ID`
(`00000000-0000-0000-0000-000000000001`). Under `cloud_auth` an imported company therefore lands in the **shared
sentinel tenant**, not the importer's org. It also only gets `access.ensureMembership(...,"owner",...)`
(`company-portability.ts:2174`) — a company-membership but **no org membership and no founder role**, so the importer can
be self-locked-out of their own imported company at the org layer.

### The fix (per founder's decision)

1. **new_company org placement** — thread an owning org through route → `importBundle` → `companies.create`, mirroring
   `POST /` exactly: `resolveCompanyOrganizationId(explicit body.target.organizationId else the actor's single
   create-capable org, else 403)` + `assertCompanyCreateAuthorized`. Self-hosted (`!enforced`) still resolves the DEFAULT
   sentinel and keeps the `local_implicit`/`isInstanceAdmin` operator bypass — unchanged.
2. **agent-restoration semantics** — `ensureRealOperator` runs **only** in the `new_company` branch (genuine founder
   provisioning). The `existing_company` path **never** calls it; `agentService.create` already parents restored org
   agents to the company's existing human founder via `orgHierarchy.getFounderUserId` (`org-hierarchy.ts:180-199`) and
   `backfillHumanAtTop` (`company-portability.ts:3474`) is the safety net. The route requires **founder/team_lead** to
   import agents (new `importsAgents` authorize flag). The misleading comment is corrected.
3. **no self-lockout** — the `new_company` branch uses `ensureRealOperator` (not bare `ensureMembership`), which now
   seeds company owner membership **and** founder role **and** org owner membership for the importer.

**★ Intentional hole — make it explicit (from adversarial review).** The `new_company` branch passes `authorize: undefined`
(the callback is built only for `existingCompanyId`, `companies.ts:171`), so the `importsAgents` founder/team_lead gate does
**NOT** run for `new_company`. That is **correct** — the importer becomes the founder of the brand-new company, so there is
nothing to escalate. State plainly in the PR: **agent-import authz is deliberately existing-company-only.**

**★ Behavior change — confirm intended (from adversarial review, draft acknowledges).** Mirroring `POST /` means a
self-hosted **`authenticated` non-operator** session user (not `local_implicit`, not `isInstanceAdmin`) importing a
`new_company` now hits `assertCompanyCreateAuthorized(DEFAULT_ORGANIZATION_ID, userId)` → `canOrg` (`companies.ts:64-71`) —
a possible **403** where today `POST /import` did `assertBoard` only. This is **identical to `POST /`'s existing behavior**
for that persona (the mandate was "mirror `POST /`"), and the `local_implicit`/`isInstanceAdmin` operator bypass is
preserved so common self-hosted paths are unaffected. Confirm the founder wants the mirror-`POST /` behavior (the plan
implements it as specified).

**No new `AOA_*` env var is introduced** (pure authz threading) — the `docs/deploy/environment-variables.md` /
brand-check guard-9 step does not apply to this item.

Execution order: **D2.1 → D2.2 → D2.3 → D2.4 → D2.5 (mandatory).** Commands assume CWD = repo root of the executor's
writable checkout (`C:/Users/TK/.aoa/wt/mt-cloud`).

---

### Task D2.1 — Shared schema: accept `organizationId` on the `new_company` import target

**Files:**
- Modify: `packages/shared/src/validators/company-portability.ts` (lines 381-390, `portabilityTargetSchema`)
- Test (Create): `packages/shared/src/validators/company-portability-import-target.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/shared/src/validators/company-portability-import-target.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { companyPortabilityImportSchema } from "./company-portability.js";

// Minimal known-valid inline source (mirrors the shape validated by the import route).
const baseSource = {
  type: "inline" as const,
  manifest: {
    schemaVersion: 2,
    generatedAt: "2026-07-31T00:00:00.000Z",
    source: null,
    includes: { company: false, agents: false },
    company: null,
    agents: [],
    projects: [],
    requiredSecrets: [],
  },
  files: {},
};

const ORG = "00000000-0000-0000-0000-0000000000a1";

describe("companyPortabilityImportSchema — new_company target organizationId", () => {
  it("preserves an explicit organizationId on a new_company target", () => {
    const parsed = companyPortabilityImportSchema.parse({
      source: baseSource,
      target: { mode: "new_company", newCompanyName: "X", organizationId: ORG },
    });
    expect(parsed.target).toMatchObject({ mode: "new_company", organizationId: ORG });
  });

  it("accepts a new_company target with no organizationId (optional)", () => {
    const parsed = companyPortabilityImportSchema.parse({
      source: baseSource,
      target: { mode: "new_company" },
    });
    expect((parsed.target as { organizationId?: string }).organizationId).toBeUndefined();
  });

  it("rejects a non-uuid organizationId", () => {
    expect(() =>
      companyPortabilityImportSchema.parse({
        source: baseSource,
        target: { mode: "new_company", organizationId: "not-a-uuid" },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm fail.**
  `pnpm exec vitest run --root packages/shared src/validators/company-portability-import-target.test.ts`
  Expected: the first test **fails** — `parsed.target` has no `organizationId` (discriminatedUnion strips the unknown key today).

- [ ] **Step 3: Minimal implementation.** In `packages/shared/src/validators/company-portability.ts`, edit the
  `new_company` variant of `portabilityTargetSchema` (currently lines 381-390):

  Current:
  ```ts
  export const portabilityTargetSchema = z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("new_company"),
      newCompanyName: z.string().min(1).optional().nullable(),
    }),
    z.object({
      mode: z.literal("existing_company"),
      companyId: z.string().uuid(),
    }),
  ]);
  ```

  New:
  ```ts
  export const portabilityTargetSchema = z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("new_company"),
      newCompanyName: z.string().min(1).optional().nullable(),
      // Multi-tenant (cloud_auth): the owning Organization a bundle-imported
      // company is created under. Server-authorized in POST /import exactly like
      // POST / (resolveCompanyOrganizationId + assertCompanyCreateAuthorized).
      // Omit -> the actor's single org is auto-picked (cloud) or the DEFAULT
      // sentinel is used (self-hosted).
      organizationId: z.string().uuid().optional().nullable(),
    }),
    z.object({
      mode: z.literal("existing_company"),
      companyId: z.string().uuid(),
    }),
  ]);
  ```

- [ ] **Step 4: Run to confirm pass.**
  `pnpm exec vitest run --root packages/shared src/validators/company-portability-import-target.test.ts`
  Expected: **3 passed.** Then rebuild shared types so downstream server imports see the new field:
  `pnpm --filter @armyofagents/shared build` (expected: exit 0, no type errors).

- [ ] **Step 5: Commit.**
  `git add packages/shared/src/validators/company-portability.ts packages/shared/src/validators/company-portability-import-target.test.ts`
  `git commit` — message: `feat(portability): accept organizationId on new_company import target (D2/H3)`

---

### Task D2.2 — Service: `importBundle` full fix (org threading + operator scoping + `importsAgents`)

**Files:**
- Modify: `server/src/services/company-portability.ts`
  - `ImportAuthorizationContext` type (lines 165-169)
  - `getImportAuthorizationContext` return (lines 219-225)
  - `importBundle` signature (lines 2117-2126)
  - `new_company` branch `companies.create` + operator seeding (lines 2160-2176)
  - delete the unconditional existing-path `ensureRealOperator` + wrong comment (lines 2203-2215)
  - update the backfill safety-net comment (lines 3470-3475)
- Test (Create): `server/src/__tests__/company-portability-import-authz.test.ts`

- [ ] **Step 1: Write the failing test.** Create `server/src/__tests__/company-portability-import-authz.test.ts` (mirrors the
  mock structure of `company-portability-crew-provisioning.test.ts`, extended with a real agent + an `existing_company` case):

```ts
/**
 * D2 (H2 + H3) — importBundle authorization + operator-scoping unit tests.
 *
 *  - new_company threads the resolved organizationId into companies.create and
 *    provisions the IMPORTER as a real operator (ensureRealOperator), never a
 *    bare "board" membership.
 *  - existing_company + include.agents does NOT call ensureRealOperator (no
 *    caller promotion); agent restoration parents to the pre-existing founder
 *    (proven at the DB layer in mt-import-authz.integration.test.ts).
 *  - getImportAuthorizationContext surfaces importsAgents so the route can gate
 *    agent imports on founder/team_lead.
 */
import { describe, expect, it, vi } from "vitest";

const createMock = vi.hoisted(() =>
  vi.fn(async (input: { name: string; organizationId?: string | null }) => ({
    id: "created-co",
    name: input.name,
  })),
);
const ensureRealOperatorMock = vi.hoisted(() => vi.fn(async () => "operator-user-id"));
const ensureMembershipMock = vi.hoisted(() => vi.fn(async () => undefined));
const agentCreateMock = vi.hoisted(() =>
  vi.fn(async (_companyId: string, patch: { name: string }) => ({ id: "agent-1", name: patch.name })),
);

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getById: vi.fn(async (id: string) => ({ id, name: "Target Co" })),
    create: createMock,
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      id,
      name: (patch.name as string) ?? "Target Co",
    })),
  }),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    backfillHumanAtTop: vi.fn(async () => 0),
    list: vi.fn(async () => []),
    create: agentCreateMock,
    update: vi.fn(),
  }),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    ensureMembership: ensureMembershipMock,
    ensureRealOperator: ensureRealOperatorMock,
  }),
}));

import { companyPortabilityService } from "../services/company-portability.js";
import type { CompanyPortabilityManifest } from "@armyofagents/shared";

const AGENT_MD = "---\nname: Atlas\nslug: atlas\n---\nDo the thing.\n";

function manifestWithAgent(): CompanyPortabilityManifest {
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-31T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: true },
    company: {
      path: "COMPANY.md",
      name: "Imported Co",
      description: null,
      brandColor: null,
      requireBoardApprovalForNewAgents: true,
    },
    agents: [
      {
        slug: "atlas",
        name: "Atlas",
        path: "agents/atlas/AGENTS.md",
        role: "Engineer",
        title: null,
        icon: null,
        capabilities: null,
        reportsToSlug: null,
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        metadata: null,
      },
    ],
    requiredSecrets: [],
  } as unknown as CompanyPortabilityManifest;
}

const svc = companyPortabilityService({
  select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
} as never);

const files = {
  "COMPANY.md": "---\nkind: company\nname: Imported Co\n---\n",
  "agents/atlas/AGENTS.md": AGENT_MD,
};

const ORG = "00000000-0000-0000-0000-0000000000a1";

describe("importBundle authorization + operator scoping (D2)", () => {
  it("new_company threads organizationId into create and provisions the importer via ensureRealOperator", async () => {
    createMock.mockClear();
    ensureRealOperatorMock.mockClear();
    ensureMembershipMock.mockClear();

    await svc.importBundle(
      {
        source: { type: "inline" as const, manifest: manifestWithAgent(), files },
        target: { mode: "new_company" as const, newCompanyName: "Imported Co" },
        include: { company: true, agents: true },
      } as never,
      "importing-user-1",
      undefined,
      { organizationId: ORG },
    );

    // (H3) the resolved org is stamped on the create.
    expect(createMock).toHaveBeenCalledOnce();
    expect(createMock.mock.calls[0][0]).toMatchObject({ organizationId: ORG });

    // (no self-lockout) the importer is seeded as a real operator (founder + org owner),
    // NOT a bare "board" company membership.
    expect(ensureRealOperatorMock).toHaveBeenCalledWith("created-co", "importing-user-1");
    expect(ensureMembershipMock).not.toHaveBeenCalled();
  });

  it("existing_company + include.agents does NOT promote the caller (no ensureRealOperator)", async () => {
    ensureRealOperatorMock.mockClear();
    agentCreateMock.mockClear();

    await svc.importBundle(
      {
        source: { type: "inline" as const, manifest: manifestWithAgent(), files },
        target: { mode: "existing_company" as const, companyId: "11111111-1111-4111-8111-111111111111" },
        include: { company: false, agents: true },
      } as never,
      "member-user-2",
    );

    // (H2) the existing-company path must NEVER re-own the caller.
    expect(ensureRealOperatorMock).not.toHaveBeenCalled();
    // agent restoration still runs (parenting to the pre-existing founder is proven in the integration suite).
    expect(agentCreateMock).toHaveBeenCalledOnce();
  });

  it("getImportAuthorizationContext (via authorize) reports importsAgents=true when agents are imported", async () => {
    const authorize = vi.fn(async () => undefined);
    await svc.importBundle(
      {
        source: { type: "inline" as const, manifest: manifestWithAgent(), files },
        target: { mode: "existing_company" as const, companyId: "11111111-1111-4111-8111-111111111111" },
        include: { company: false, agents: true },
      } as never,
      "member-user-2",
      authorize,
    );
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ importsAgents: true }));
  });

  it("importsAgents=false for a company-only import (no agents section)", async () => {
    const authorize = vi.fn(async () => undefined);
    const m = manifestWithAgent();
    (m as unknown as { agents: unknown[] }).agents = [];
    await svc.importBundle(
      {
        source: { type: "inline" as const, manifest: m, files: { "COMPANY.md": files["COMPANY.md"] } },
        target: { mode: "existing_company" as const, companyId: "11111111-1111-4111-8111-111111111111" },
        include: { company: true, agents: false },
      } as never,
      "member-user-2",
      authorize,
    );
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ importsAgents: false }));
  });
});
```

- [ ] **Step 2: Run to confirm fail.**
  `pnpm exec vitest run --root server src/__tests__/company-portability-import-authz.test.ts`
  Expected failures: test 1 — `ensureRealOperator` not called with `("created-co", ...)` (today the `new_company` branch
  calls `ensureMembership`, and `ensureRealOperator` only fires later gated on `include.agents`); `createMock` has no
  `organizationId`. Test 2 — `ensureRealOperator` **was** called (today's unconditional `include.agents` path). Test 3 —
  `authorize` received an object with no `importsAgents` key (property absent → `objectContaining({importsAgents:true})` fails).

- [ ] **Step 3a: Implement — `importsAgents` on the authorization context.** In `company-portability.ts`, edit the type
  (lines 165-169):

  Current:
  ```ts
  type ImportAuthorizationContext = {
    changesCompletionPolicy: boolean;
    requiresTaskAssignmentPermission: boolean;
    importsWorkflowTemplates: boolean;
  };
  ```
  New:
  ```ts
  type ImportAuthorizationContext = {
    changesCompletionPolicy: boolean;
    requiresTaskAssignmentPermission: boolean;
    importsWorkflowTemplates: boolean;
    // D2/H2: an existing-company agent import is a company-structure mutation and
    // must require founder/team_lead. Surfaced so the route can gate it; the
    // service no longer re-owns the caller via ensureRealOperator.
    importsAgents: boolean;
  };
  ```

  And the return of `getImportAuthorizationContext` (lines 219-225):

  Current:
  ```ts
    return {
      changesCompletionPolicy,
      requiresTaskAssignmentPermission:
        changesCompletionPolicy || mutableRoutines.length > 0 || importsAssignedIssues,
      importsWorkflowTemplates:
        plan.include.workflowTemplates === true && (manifest.workflowTemplates?.length ?? 0) > 0,
    };
  ```
  New:
  ```ts
    return {
      changesCompletionPolicy,
      requiresTaskAssignmentPermission:
        changesCompletionPolicy || mutableRoutines.length > 0 || importsAssignedIssues,
      importsWorkflowTemplates:
        plan.include.workflowTemplates === true && (manifest.workflowTemplates?.length ?? 0) > 0,
      importsAgents: plan.include.agents === true && plan.selectedAgents.length > 0,
    };
  ```

- [ ] **Step 3b: Implement — `importBundle` signature (add `opts.organizationId`).** Edit lines 2117-2121:

  Current:
  ```ts
    async function importBundle(
      input: CompanyPortabilityImport,
      actorUserId: string | null | undefined,
      authorize?: (context: ImportAuthorizationContext) => Promise<void>,
    ): Promise<CompanyPortabilityImportResult> {
  ```
  New:
  ```ts
    async function importBundle(
      input: CompanyPortabilityImport,
      actorUserId: string | null | undefined,
      authorize?: (context: ImportAuthorizationContext) => Promise<void>,
      opts?: { organizationId?: string | null },
    ): Promise<CompanyPortabilityImportResult> {
  ```

- [ ] **Step 3c: Implement — `new_company` branch (thread org + seed the importer as a real operator).** Edit lines 2160-2176:

  Current:
  ```ts
        const created = await companies.create({
          name: companyName,
          description: include.company ? (sourceManifest.company?.description ?? null) : null,
          brandColor: include.company ? (sourceManifest.company?.brandColor ?? null) : null,
          requireBoardApprovalForNewAgents: include.company
            ? (sourceManifest.company?.requireBoardApprovalForNewAgents ?? true)
            : true,
          agentCompletionPolicyDefault: include.company
            ? (sourceManifest.company?.agentCompletionPolicyDefault ?? "review_required")
            : "review_required",
          agentCompletionReviewGuardrail: include.company
            ? (sourceManifest.company?.agentCompletionReviewGuardrail ?? false)
            : false,
        }, { requestedByUserId: actorUserId ?? null });
        await access.ensureMembership(created.id, "user", actorUserId ?? "board", "owner", "active");
        targetCompany = created;
        companyAction = "created";
  ```
  New:
  ```ts
        const created = await companies.create({
          name: companyName,
          description: include.company ? (sourceManifest.company?.description ?? null) : null,
          brandColor: include.company ? (sourceManifest.company?.brandColor ?? null) : null,
          requireBoardApprovalForNewAgents: include.company
            ? (sourceManifest.company?.requireBoardApprovalForNewAgents ?? true)
            : true,
          agentCompletionPolicyDefault: include.company
            ? (sourceManifest.company?.agentCompletionPolicyDefault ?? "review_required")
            : "review_required",
          agentCompletionReviewGuardrail: include.company
            ? (sourceManifest.company?.agentCompletionReviewGuardrail ?? false)
            : false,
          // D2/H3: the owning Organization is server-resolved + authorized in the
          // route (mirrors POST /). undefined -> companies.create falls back to the
          // DEFAULT sentinel (self-hosted single-tenant), unchanged.
          organizationId: opts?.organizationId ?? undefined,
        }, { requestedByUserId: actorUserId ?? null });
        // D2/H2 + no-self-lockout: seed the IMPORTER as a genuine founder of the
        // freshly created company — company owner membership + founder role + org
        // owner membership (ensureRealOperator, access.ts). This also guarantees a
        // real human founder for the agent-restoration parenting below. Replaces
        // the old bare "board" company-only membership.
        await access.ensureRealOperator(created.id, actorUserId);
        targetCompany = created;
        companyAction = "created";
  ```

- [ ] **Step 3d: Implement — delete the unconditional existing-path `ensureRealOperator` + wrong comment.** Edit lines
  2203-2215:

  Current:
  ```ts
      if (!targetCompany) throw notFound("Target company not found");

      // W6 human-at-top invariant. Import builds the company via the service layer,
      // bypassing the company-create route's operator seeding — so a freshly created
      // company has no real human founder. If we restored agents now, agentService
      // .create() would either throw ("no human founder exists") or auto-parent them
      // to a non-user owner principal (e.g. the synthetic "board" actor when
      // actorUserId is null). Seed a real operator FIRST so agent restoration parents
      // every org agent to a genuine human. Idempotent: returns the existing founder
      // when one is already present, so it is safe for the existing-company path too.
      if (include.agents) {
        await access.ensureRealOperator(targetCompany.id, actorUserId);
      }
  ```
  New:
  ```ts
      if (!targetCompany) throw notFound("Target company not found");

      // D2/H2: NO ensureRealOperator here. Operator provisioning is a NEW-company
      // concern only and now happens in the new_company branch above (seeding the
      // importer as founder). For an EXISTING company we must never re-own the
      // caller: agentService.create parents restored org agents to the company's
      // pre-existing human founder (orgHierarchy.getFounderUserId), and the route
      // separately requires founder/team_lead to import agents (importsAgents gate).
      // A company with no human founder correctly hard-fails in agentService.create
      // ("no human founder exists") rather than silently promoting the caller.
  ```

- [ ] **Step 3e: Implement — correct the backfill safety-net comment.** Edit lines 3470-3475:

  Current:
  ```ts
      // W6 human-at-top invariant (safety net): re-parent any org agent that still
      // landed rootless up to the founder. ensureRealOperator already ran above
      // (before agent restoration), so a founder is guaranteed to exist here.
      if (include.agents) {
        await agents.backfillHumanAtTop(targetCompany.id);
      }
  ```
  New:
  ```ts
      // W6 human-at-top invariant (safety net): re-parent any org agent that still
      // landed rootless up to the founder. A founder is guaranteed here — either
      // seeded by the new_company branch (ensureRealOperator) or already present on
      // the existing company (route-gated founder/team_lead + getFounderUserId).
      if (include.agents) {
        await agents.backfillHumanAtTop(targetCompany.id);
      }
  ```

- [ ] **Step 4: Run to confirm pass.**
  `pnpm exec vitest run --root server src/__tests__/company-portability-import-authz.test.ts`
  Expected: **4 passed.** Then run the full existing portability suite (regression — the crew-provisioning + all
  section tests mock both `ensureMembership` and `ensureRealOperator`, and none assert `ensureMembership` was called on the
  new_company path):
  `pnpm exec vitest run --root server src/__tests__/company-portability-*.test.ts`
  Expected: all passing (0 failed).

- [ ] **Step 5: Commit.**
  `git add server/src/services/company-portability.ts server/src/__tests__/company-portability-import-authz.test.ts`
  `git commit` — message: `fix(portability): scope operator seeding to new_company + surface importsAgents (D2/H2,H3)`

---

### Task D2.3 — Route: `POST /import` new_company org authz + `importsAgents` role gate + org threading

**Files:**
- Modify: `server/src/routes/companies.ts` (POST `/import`, lines 160-199)
- Test (Create): `server/src/__tests__/companies-import-authz-route.test.ts`

- [ ] **Step 1: Write the failing test.** Create `server/src/__tests__/companies-import-authz-route.test.ts` (mirrors
  `companies-org-scope.test.ts` for mocks + `companies-completion-policy-auth.test.ts` for the mocked-`importBundle`
  authorize wiring):

```ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ORGANIZATION_ID, type DeploymentMode } from "@armyofagents/shared";
import { setDeploymentMode } from "../config/deployment-mode.js";

const importBundle = vi.hoisted(() => vi.fn());
const canOrg = vi.hoisted(() => vi.fn());
const getEffectiveRole = vi.hoisted(() => vi.fn());
const canUser = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  companyPortabilityService: () => ({ importBundle }),
  accessService: () => ({ canUser, ensureMembership: vi.fn(), ensureRealOperator: vi.fn() }),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/organization-access.js", () => ({
  organizationAccessService: () => ({ canOrg }),
}));
// assertRole -> permissionService(db).getEffectiveRole. db is {} in these route
// tests, so mock the permission service module the rbac middleware imports.
vi.mock("../services/permissions.js", () => ({
  permissionService: () => ({ getEffectiveRole }),
}));
// POST /import never calls these (they are POST / seeders) — stub anyway so
// module load never touches real implementations.
vi.mock("../services/internal-agent/aoa-skills-seeder.js", () => ({
  seedAoaNativeSkills: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/team.js", () => ({
  materializeCompanyProfileFromGlobal: vi.fn().mockResolvedValue(undefined),
}));

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";

const ORG_1 = "00000000-0000-0000-0000-0000000000a1";
const ORG_2 = "00000000-0000-0000-0000-0000000000b2";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function makeApp(actor: Record<string, unknown>, deploymentMode: DeploymentMode = "cloud_auth") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "session",
      userId: USER,
      companyIds: [COMPANY],
      organizationIds: [ORG_1],
      isInstanceAdmin: false,
      ...actor,
    };
    (req as any).tenant = { organizationId: null };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any, { deploymentMode }));
  app.use(errorHandler);
  return app;
}

// Mocked importBundle that echoes the real authorize contract for the sections
// under test, then returns a minimal result.
function wireImportBundle(action: "created" | "updated") {
  importBundle.mockImplementation(async (body: any, _actorUserId, authorize) => {
    const include = { company: true, agents: false, ...body.include };
    const agentCount = body.source.manifest.agents?.length ?? 0;
    await authorize?.({
      changesCompletionPolicy: false,
      requiresTaskAssignmentPermission: false,
      importsWorkflowTemplates: false,
      importsAgents: include.agents === true && agentCount > 0,
    });
    return {
      company: { id: action === "created" ? "c-new" : COMPANY, name: "Imported", action },
      agents: [],
      projects: [],
      issues: [],
      skills: [],
      routines: [],
      requiredSecrets: [],
      warnings: [],
    };
  });
}

function bundle(
  target: Record<string, unknown>,
  include: Record<string, boolean> = { company: true },
  agents: unknown[] = [],
) {
  return {
    source: {
      type: "inline",
      manifest: {
        schemaVersion: 2,
        generatedAt: "2026-07-31T00:00:00.000Z",
        source: null,
        includes: { company: !!include.company, agents: !!include.agents },
        company: include.company
          ? {
              path: "COMPANY.md",
              name: "Imported",
              description: null,
              brandColor: null,
              requireBoardApprovalForNewAgents: true,
            }
          : null,
        agents,
        projects: [],
        requiredSecrets: [],
      },
      files: {},
    },
    include,
    target,
  };
}

const AGENT = {
  slug: "atlas",
  name: "Atlas",
  path: "agents/atlas/AGENTS.md",
  role: "Engineer",
  title: null,
  icon: null,
  capabilities: null,
  reportsToSlug: null,
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  permissions: {},
  budgetMonthlyCents: 0,
  metadata: null,
};

describe("POST /import — agent-import authz (H2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDeploymentMode("cloud_auth");
    wireImportBundle("updated");
  });

  it("403: a team_member cannot escalate by importing agents into an existing company", async () => {
    getEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp({}))
      .post("/api/companies/import")
      .send(bundle({ mode: "existing_company", companyId: COMPANY }, { company: false, agents: true }, [AGENT]));
    expect(res.status).toBe(403);
    expect(getEffectiveRole).toHaveBeenCalledWith(COMPANY, USER);
  });

  it("200: a founder may import agents into an existing company", async () => {
    getEffectiveRole.mockResolvedValue("founder");
    const res = await request(makeApp({}))
      .post("/api/companies/import")
      .send(bundle({ mode: "existing_company", companyId: COMPANY }, { company: false, agents: true }, [AGENT]));
    expect(res.status).toBe(200);
    expect(importBundle).toHaveBeenCalledOnce();
  });

  it("200: an existing-company import with no agents does not require founder/team_lead", async () => {
    getEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp({}))
      .post("/api/companies/import")
      .send(bundle({ mode: "existing_company", companyId: COMPANY }, { company: true, agents: false }));
    expect(res.status).toBe(200);
    // company-only import: importsAgents=false -> the founder/team_lead gate is not triggered.
    expect(getEffectiveRole).not.toHaveBeenCalled();
  });
});

describe("POST /import — new_company org placement (H3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDeploymentMode("cloud_auth");
    wireImportBundle("created");
  });

  it("lands in the actor's single org (auto-pick) and passes it to importBundle", async () => {
    canOrg.mockResolvedValue(true);
    const res = await request(makeApp({ organizationIds: [ORG_1] }))
      .post("/api/companies/import")
      .send(bundle({ mode: "new_company", newCompanyName: "New Co" }));
    expect(res.status).toBe(200);
    expect(canOrg).toHaveBeenCalledWith(ORG_1, USER, "company:create");
    // 4th arg: the resolved org is threaded to the service.
    expect(importBundle.mock.calls[0][3]).toMatchObject({ organizationId: ORG_1 });
    expect(importBundle.mock.calls[0][3].organizationId).not.toBe(DEFAULT_ORGANIZATION_ID);
  });

  it("honors an explicit target.organizationId and authorizes against it", async () => {
    canOrg.mockResolvedValue(true);
    const res = await request(makeApp({ organizationIds: [ORG_1, ORG_2] }))
      .post("/api/companies/import")
      .send(bundle({ mode: "new_company", newCompanyName: "New Co", organizationId: ORG_2 }));
    expect(res.status).toBe(200);
    expect(canOrg).toHaveBeenCalledWith(ORG_2, USER, "company:create");
    expect(importBundle.mock.calls[0][3]).toMatchObject({ organizationId: ORG_2 });
  });

  it("403 when canOrg('company:create') is false", async () => {
    canOrg.mockResolvedValue(false);
    const res = await request(makeApp({ organizationIds: [ORG_1] }))
      .post("/api/companies/import")
      .send(bundle({ mode: "new_company", newCompanyName: "New Co" }));
    expect(res.status).toBe(403);
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("403 when the actor belongs to multiple orgs and omits organizationId (ambiguous)", async () => {
    const res = await request(makeApp({ organizationIds: [ORG_1, ORG_2] }))
      .post("/api/companies/import")
      .send(bundle({ mode: "new_company", newCompanyName: "New Co" }));
    expect(res.status).toBe(403);
    expect(canOrg).not.toHaveBeenCalled();
    expect(importBundle).not.toHaveBeenCalled();
  });
});

describe("POST /import — self-hosted new_company unchanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireImportBundle("created");
  });

  it("authenticated local_implicit import lands in the DEFAULT sentinel and never calls canOrg", async () => {
    setDeploymentMode("authenticated");
    const res = await request(
      makeApp({ source: "local_implicit", userId: null, organizationIds: [] }, "authenticated"),
    )
      .post("/api/companies/import")
      .send(bundle({ mode: "new_company", newCompanyName: "Legacy Co" }));
    expect(res.status).toBe(200);
    expect(canOrg).not.toHaveBeenCalled();
    expect(importBundle.mock.calls[0][3]).toMatchObject({ organizationId: DEFAULT_ORGANIZATION_ID });
  });
});
```

- [ ] **Step 2: Run to confirm fail.**
  `pnpm exec vitest run --root server src/__tests__/companies-import-authz-route.test.ts`
  Expected failures: H2 403 test — today no `importsAgents` gate, returns 200. H3 tests — today no
  `resolveCompanyOrganizationId`/`assertCompanyCreateAuthorized`, so `canOrg` is never called and `importBundle` has no 4th
  arg (`mock.calls[0][3]` is `undefined` → `toMatchObject` throws); the two 403 cases return 200.

- [ ] **Step 3: Implement.** In `server/src/routes/companies.ts`, replace the `POST /import` handler (lines 160-199).

  Current:
  ```ts
    router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
      assertBoard(req);
      const existingCompanyId =
        req.body.target.mode === "existing_company" ? req.body.target.companyId : null;
      if (req.body.target.mode === "existing_company") {
        await assertCompanyAccess(db, req, req.body.target.companyId);
      }
      const actor = getActorInfo(req);
      const result = await portability.importBundle(
        req.body,
        req.actor.type === "board" ? req.actor.userId : null,
        existingCompanyId
          ? async ({ requiresTaskAssignmentPermission, importsWorkflowTemplates }) => {
            if (requiresTaskAssignmentPermission) {
              await assertCanAssignTasks(req, existingCompanyId);
            }
            if (importsWorkflowTemplates) {
              await assertRole(db, req, existingCompanyId, "founder", "team_lead");
            }
          }
          : undefined,
      );
  ```
  New:
  ```ts
    router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
      assertBoard(req);
      const existingCompanyId =
        req.body.target.mode === "existing_company" ? req.body.target.companyId : null;
      if (req.body.target.mode === "existing_company") {
        await assertCompanyAccess(db, req, req.body.target.companyId);
      }

      // D2/H3: a new_company import creates a company and MUST be placed + authorized
      // exactly like POST / — never the shared DEFAULT sentinel under cloud_auth.
      // resolveCompanyOrganizationId derives a server-side org (explicit
      // target.organizationId, else the actor's single org, else 403);
      // assertCompanyCreateAuthorized gates canOrg against that exact org. The
      // self-hosted operator bypass + DEFAULT-sentinel fallback are preserved.
      let newCompanyOrganizationId: string | undefined;
      if (req.body.target.mode === "new_company") {
        const enforced = tenantIsolationEnforced();
        const isSelfHostedOperator =
          !enforced && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin);
        const organizationId = resolveCompanyOrganizationId(
          { organizationId: req.body.target.organizationId },
          { enforced, actorOrganizationIds: req.actor.organizationIds ?? [] },
        );
        if (!isSelfHostedOperator) {
          if (!req.actor.userId) throw forbidden("Sign in to import a company");
          await assertCompanyCreateAuthorized(
            organizationAccessService(db),
            organizationId,
            req.actor.userId,
          );
        }
        newCompanyOrganizationId = organizationId;
      }

      const actor = getActorInfo(req);
      const result = await portability.importBundle(
        req.body,
        req.actor.type === "board" ? req.actor.userId : null,
        existingCompanyId
          ? async ({ requiresTaskAssignmentPermission, importsWorkflowTemplates, importsAgents }) => {
            // D2/H2: importing agents into an existing company is a company-structure
            // mutation — require founder/team_lead. The service no longer re-owns the
            // caller, so this gate is the primary defense against escalation.
            if (importsAgents) {
              await assertRole(db, req, existingCompanyId, "founder", "team_lead");
            }
            if (requiresTaskAssignmentPermission) {
              await assertCanAssignTasks(req, existingCompanyId);
            }
            if (importsWorkflowTemplates) {
              await assertRole(db, req, existingCompanyId, "founder", "team_lead");
            }
          }
          : undefined,
        { organizationId: newCompanyOrganizationId },
      );
  ```

  > **★ Reviewer correction to the executor note.** The draft's original note said "all referenced symbols are already
  > *imported* in this file, lines 14-26." That is only partly true. Correct facts:
  > - `resolveCompanyOrganizationId` and `assertCompanyCreateAuthorized` are **module-local exported functions defined in
  >   this same file (`companies.ts:42-71`)** — NOT imports. Do not hunt for an import line for them.
  > - `organizationAccessService`, `tenantIsolationEnforced`, `forbidden`, and `assertRole` **are** imported at the top of
  >   the file. `assertBoard`, `assertCompanyAccess`, `assertCanAssignTasks`, `getActorInfo`, `validate`,
  >   `companyPortabilityImportSchema` are likewise already in scope.
  >
  > **★ Intentional hole (make explicit):** the `new_company` branch passes `authorize: undefined` (the callback is built
  > only for `existingCompanyId`), so the `importsAgents` founder/team_lead gate does **not** run for `new_company` — by
  > design (the importer becomes the founder). Agent-import authz is existing-company-only.

  (Leave the `logActivity` block + `res.json(result)` that follow, lines 182-199, unchanged.)

- [ ] **Step 4: Run to confirm pass.**
  `pnpm exec vitest run --root server src/__tests__/companies-import-authz-route.test.ts`
  Expected: **all passed.** Then regress the sibling route suites that exercise the same handler:
  `pnpm exec vitest run --root server src/__tests__/companies-completion-policy-auth.test.ts src/__tests__/companies-org-scope.test.ts`
  Expected: all passing (the completion-policy suite's mocked `importBundle` calls `authorize` without `importsAgents`, so
  the new `if (importsAgents)` gate is simply never triggered there — no regression).

- [ ] **Step 5: Commit.**
  `git add server/src/routes/companies.ts server/src/__tests__/companies-import-authz-route.test.ts`
  `git commit` — message: `fix(companies): authorize new_company import org + gate agent import on founder/team_lead (D2)`

---

### Task D2.4 — Integration (embedded-PG): real-DB proof of H2 (no promotion) + H3 (org placement, no lockout)

**Files:**
- Test (Create): `server/src/__tests__/mt-import-authz.integration.test.ts`
  (embedded-postgres harness; no production code changes in this task — it proves the D2.2/D2.3 changes at the DB layer)

> **Windows note:** this is a `*.integration.test.ts` gated with `describe.skipIf(process.platform === "win32")`. To run it
> locally on Windows: temporarily change `skipIf(process.platform === "win32")` to `skipIf(false)`, run, then **revert to
> `skipIf(process.platform === "win32")` before committing.** Linux CI is the authoritative gate.

> **★ Reviewer test-infra note (apply before hand-rolling SQL).** Prefer **reusing the existing
> `w6-org-reporting.integration.test.ts` seed helper** (its `seedCompanyWithFounder` / user + org seeders) over the
> hand-rolled raw SQL below — hand-rolled column lists drift from the schema. If you keep the raw SQL, the reviewer verified
> these columns against the schema: `"user"` (`auth.ts:3`), `company_memberships.principal_type/principal_id/membership_role`
> (`:9-12`), `organization_memberships (organization_id, user_id, role, status)` (`:10-13`), `organizations (name, slug,
> status, plan)` (`:9-14`), `agents.parent_type/parent_id` (`:29-30`), minimal `companies (id, name, issue_prefix)`.
> **Residual you MUST verify before landing:** the `user_roles` column list (`id, company_id, user_id, role`) and that the
> role check accepts `team_member` / `founder` (the seeds below insert both). Confirm against `packages/db/src/schema/` and
> adjust if the schema differs.

- [ ] **Step 1: Write the failing test.** Create `server/src/__tests__/mt-import-authz.integration.test.ts`:

```ts
/**
 * D2 (H2 + H3) — real-DB integration proof.
 *
 *  H2: importing agents into an EXISTING company must NOT promote the caller.
 *      The caller keeps their member role; the restored org agent parents to the
 *      company's pre-existing human founder.
 *  H3: a new_company import lands in the resolved Organization (opts.organizationId)
 *      or the DEFAULT sentinel when none is threaded (self-hosted), and the importer
 *      is provisioned with company owner membership + founder role + org owner
 *      membership (no self-lockout).
 *
 * Skipped on Windows (embedded-postgres / migration chain — Issue #114). Mirrors
 * w6-org-reporting.integration.test.ts — PREFER reusing that file's seed helpers
 * over the hand-rolled SQL here (see the reviewer note above).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID, type CompanyPortabilityManifest } from "@armyofagents/shared";
import { orgHierarchyService } from "../services/org-hierarchy.js";
import { companyPortabilityService } from "../services/company-portability.js";

type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: Pg | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const PORT = 58300 + Math.floor(Math.random() * 1000);

function rows<T = Record<string, unknown>>(r: unknown): T[] {
  return (Array.isArray(r) ? r : (r as { rows?: T[] }).rows ?? []) as T[];
}
function firstId(r: unknown): string {
  const id = rows<{ id: string }>(r)[0]?.id;
  if (!id) throw new Error("firstId: no id returned");
  return id;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-d2-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: new (o: object) => Pg;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    const cs = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(cs);
    db = createDb(cs);
  } catch (err) {
    setupError = err;
    console.error("[d2-integration] setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}, 60_000);

async function seedUser(email: string): Promise<string> {
  return firstId(
    await db.execute(
      sql`INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at)
          VALUES (gen_random_uuid()::text, ${email}, 'U', false, now(), now()) RETURNING id`,
    ),
  );
}

async function seedCompanyWithFounder(): Promise<{ companyId: string; founderId: string }> {
  const companyId = firstId(
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix)
          VALUES (gen_random_uuid(), 'D2 Co', upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)))
          RETURNING id`,
    ),
  );
  const founderId = await seedUser(`f-${companyId.slice(0, 8)}@d2.test`);
  await db.execute(
    sql`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at)
        VALUES (gen_random_uuid(), ${companyId}, 'user', ${founderId}, 'owner', 'active', now(), now())`,
  );
  await db.execute(
    sql`INSERT INTO user_roles (id, company_id, user_id, role) VALUES (gen_random_uuid(), ${companyId}, ${founderId}, 'founder')`,
  );
  return { companyId, founderId };
}

async function seedOrg(): Promise<string> {
  return firstId(
    await db.execute(
      sql`INSERT INTO organizations (id, name, slug, status, plan)
          VALUES (gen_random_uuid(), 'D2 Org', ${"d2-" + Math.random().toString(36).slice(2, 10)}, 'active', 'beta')
          RETURNING id`,
    ),
  );
}

function agentBundleSource(companyName: string) {
  const manifest: CompanyPortabilityManifest = {
    schemaVersion: 2,
    generatedAt: "2026-07-31T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: true },
    company: {
      path: "COMPANY.md",
      name: companyName,
      description: null,
      brandColor: null,
      requireBoardApprovalForNewAgents: true,
    },
    agents: [
      {
        slug: "atlas",
        name: "Atlas",
        path: "agents/atlas/AGENTS.md",
        role: "Engineer",
        title: null,
        icon: null,
        capabilities: null,
        reportsToSlug: null,
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        metadata: null,
      },
    ],
    requiredSecrets: [],
  } as unknown as CompanyPortabilityManifest;
  return {
    type: "inline" as const,
    manifest,
    files: {
      "COMPANY.md": `---\nkind: company\nname: ${companyName}\n---\n`,
      "agents/atlas/AGENTS.md": "---\nname: Atlas\nslug: atlas\n---\nDo the thing.\n",
    },
  };
}

describe.skipIf(process.platform === "win32")("D2 import authz — real DB", () => {
  it("setup harness boots", () => {
    if (setupError) throw new Error(String(setupError));
    expect(db).toBeTruthy();
  });

  it("H2: importing agents into an existing company does NOT promote the caller", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();

    // A non-founder member (the malicious/mistaken importer).
    const memberId = await seedUser(`m-${companyId.slice(0, 8)}@d2.test`);
    await db.execute(
      sql`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at)
          VALUES (gen_random_uuid(), ${companyId}, 'user', ${memberId}, 'member', 'active', now(), now())`,
    );
    await db.execute(
      sql`INSERT INTO user_roles (id, company_id, user_id, role) VALUES (gen_random_uuid(), ${companyId}, ${memberId}, 'team_member')`,
    );

    const result = await companyPortabilityService(db).importBundle(
      {
        source: agentBundleSource("D2 Co"),
        target: { mode: "existing_company", companyId },
        include: { company: false, agents: true },
      } as never,
      memberId, // actorUserId = the member
    );

    // (a) the caller was NOT granted a founder role.
    const founderRows = rows(
      await db.execute(
        sql`SELECT id FROM user_roles WHERE company_id = ${companyId} AND user_id = ${memberId} AND role = 'founder'`,
      ),
    );
    expect(founderRows.length).toBe(0);

    // (b) the caller's company membership was NOT upgraded to owner.
    const memRole = rows<{ membership_role: string }>(
      await db.execute(
        sql`SELECT membership_role FROM company_memberships WHERE company_id = ${companyId} AND principal_type = 'user' AND principal_id = ${memberId}`,
      ),
    )[0]?.membership_role;
    expect(memRole).toBe("member");

    // (c) the caller was NOT made an org owner (company is in the DEFAULT org).
    const orgMem = rows(
      await db.execute(
        sql`SELECT id FROM organization_memberships WHERE organization_id = ${DEFAULT_ORGANIZATION_ID} AND user_id = ${memberId}`,
      ),
    );
    expect(orgMem.length).toBe(0);

    // (d) the restored org agent parents to the PRE-EXISTING founder, not the caller.
    const created = result.agents.find((a) => a.slug === "atlas");
    expect(created?.id).toBeTruthy();
    const parent = rows<{ parent_type: string; parent_id: string }>(
      await db.execute(sql`SELECT parent_type, parent_id FROM agents WHERE id = ${created!.id}`),
    )[0];
    expect(parent.parent_type).toBe("user");
    expect(parent.parent_id).toBe(founderId);
    expect(await orgHierarchyService(db).getFounderUserId(companyId)).toBe(founderId);
  });

  it("H3: new_company import lands in the threaded org + provisions the importer (no lockout)", async () => {
    if (setupError) throw new Error(String(setupError));
    const orgId = await seedOrg();
    const importerId = await seedUser(`imp-${orgId.slice(0, 8)}@d2.test`);

    const result = await companyPortabilityService(db).importBundle(
      {
        source: agentBundleSource("Imported D2 Co"),
        target: { mode: "new_company", newCompanyName: "Imported D2 Co" },
        include: { company: true, agents: true },
      } as never,
      importerId,
      undefined,
      { organizationId: orgId },
    );

    const companyId = result.company.id;
    expect(result.company.action).toBe("created");

    // (a) company placed in the threaded org (NOT the DEFAULT sentinel).
    const orgOnCompany = rows<{ organization_id: string }>(
      await db.execute(sql`SELECT organization_id FROM companies WHERE id = ${companyId}`),
    )[0]?.organization_id;
    expect(orgOnCompany).toBe(orgId);

    // (b) importer got founder role + owner company membership + org owner membership.
    expect(
      rows(
        await db.execute(
          sql`SELECT id FROM user_roles WHERE company_id = ${companyId} AND user_id = ${importerId} AND role = 'founder'`,
        ),
      ).length,
    ).toBe(1);
    expect(
      rows(
        await db.execute(
          sql`SELECT id FROM company_memberships WHERE company_id = ${companyId} AND principal_type = 'user' AND principal_id = ${importerId} AND membership_role = 'owner' AND status = 'active'`,
        ),
      ).length,
    ).toBe(1);
    expect(
      rows(
        await db.execute(
          sql`SELECT id FROM organization_memberships WHERE organization_id = ${orgId} AND user_id = ${importerId} AND role = 'owner'`,
        ),
      ).length,
    ).toBe(1);
  });

  it("H3 self-hosted: new_company import with no threaded org lands in the DEFAULT sentinel", async () => {
    if (setupError) throw new Error(String(setupError));
    const result = await companyPortabilityService(db).importBundle(
      {
        source: agentBundleSource("Self Hosted D2 Co"),
        target: { mode: "new_company", newCompanyName: "Self Hosted D2 Co" },
        include: { company: true, agents: true },
      } as never,
      null, // self-hosted board (no user)
    );
    const orgOnCompany = rows<{ organization_id: string }>(
      await db.execute(sql`SELECT organization_id FROM companies WHERE id = ${result.company.id}`),
    )[0]?.organization_id;
    expect(orgOnCompany).toBe(DEFAULT_ORGANIZATION_ID);
  });
});
```

- [ ] **Step 2: Confirm fail on Windows (temporary flip).** Change the `describe.skipIf(process.platform === "win32")` on
  the `describe` block to `describe.skipIf(false)`, then run:
  `pnpm exec vitest run --root server src/__tests__/mt-import-authz.integration.test.ts`
  Expected: the **H2** test fails against the PRE-D2.2 code (the caller `memberId` gets a `founder` `user_roles` row + owner
  membership + org owner membership from the unconditional `ensureRealOperator`), and **H3** fails (company lands in
  `DEFAULT_ORGANIZATION_ID`, importer has no org membership). If D2.2 was already applied, the tests pass — in that case
  temporarily `git stash` the D2.2 change, confirm red, then `git stash pop` before Step 3. (This task ships no production
  change; it is the DB-level regression guard for D2.2/D2.3.)

- [ ] **Step 3: Confirm pass on Windows (temporary flip still in place).**
  `pnpm exec vitest run --root server src/__tests__/mt-import-authz.integration.test.ts`
  Expected: **4 passed** (setup + H2 + H3 + H3-self-hosted).

- [ ] **Step 4: REVERT the Windows flip.** Change `describe.skipIf(false)` back to
  `describe.skipIf(process.platform === "win32")`. Re-run once to confirm it now reports skipped on Windows:
  `pnpm exec vitest run --root server src/__tests__/mt-import-authz.integration.test.ts`
  Expected: the suite is **skipped** on Windows (0 failed).

- [ ] **Step 5: Commit.**
  `git add server/src/__tests__/mt-import-authz.integration.test.ts`
  `git commit` — message: `test(portability): real-DB proof of D2 import authz (H2 no-promotion + H3 org placement)`

---

### Task D2.5 — Final verification (typecheck + full regression + brand-check)

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the touched packages.**
  `pnpm --filter @armyofagents/shared typecheck && pnpm --filter @armyofagents/server typecheck`
  Expected: exit 0, no errors. (If the repo uses a single root `pnpm typecheck`, run that instead.)

- [ ] **Step 2: Full portability + companies route regression.**
  `pnpm exec vitest run --root server src/__tests__/company-portability-*.test.ts src/__tests__/companies-*.test.ts`
  Expected: all passing (the integration file is skipped on Windows; unit + route files run green).

- [ ] **Step 3: Shared validator regression.**
  `pnpm exec vitest run --root packages/shared src/validators`
  Expected: all passing.

- [ ] **Step 4: Brand-check (guard suite).**
  `pnpm brand-check` (or the repo's documented brand-check invocation).
  Expected: pass. This item adds **no `AOA_*` env var**, so guard-9 (env-var documentation) has nothing to enforce; this
  step only confirms no incidental violation was introduced.

- [ ] **Step 5 (Linux CI parity — do before opening the PR):** push the branch and let Linux CI run the `*.integration.test.ts`
  suite (it is skipped locally on Windows). Confirm `mt-import-authz.integration.test.ts` is green on Linux before requesting
  review.

---

## 4. D3 — Cloud provider onboarding guidance (M4)

### Problem (verified against the real code)

On `cloud_auth` (multi-tenant) keyless-CLI cannot work on the shared host:

- `server/src/services/provider-resolution.ts:420-425` — `resolveProviderCredential` returns `host_login_fallback` **only** when `deps.selfHostedSingleTenant`; otherwise it **throws `ProviderUnavailableError`**. That error is therefore *inherently cloud-only* (self-hosted never reaches it).
- `server/src/services/provider-resolution.ts:327-333` — a `personal_subscription` candidate is skipped when `!selfHostedSingleTenant`.
- Result: a fresh cloud company with no per-company provider connection fails closed for **agents / Commander / extraction** with copy that either (a) says "never uses a host login" (a *negation*, not an action — `provider-resolution.ts:281`) or (b) tells the founder to run a keyless-CLI login they cannot perform on the shared host (`ui/src/pages/DiscussionDetail.tsx:157-162` extraction `not_authed` → "Run its login flow").

**Founder decision:** add fail-closed **guidance** (non-blocking) — route the founder to set a per-company provider API key in **Settings → Providers** during onboarding, and make the fail-closed run/extraction copy point there (never at a keyless-CLI login). NOT a hard requirement, NOT org-level key sharing. Self-hosted behavior stays byte-identical (keyless-CLI still works).

**No new `AOA_*` env var is introduced** → brand-check guard 9 / `docs/deploy/environment-variables.md` is not triggered. Deployment mode is read from the existing `/api/health` response (`ui/src/api/health.ts:7`, `deploymentMode`). *(Reviewer verified `queryKeys.health` (`queryKeys.ts:108`) and `healthApi.deploymentMode` (`health.ts:7`) both exist.)*

**Test surfaces (all run on Windows, no skipIf flip needed):**
- `server/src/__tests__/provider-unavailable-error.test.ts` — plain node unit test (NOT `*.integration.test.ts`).
- `ui/src/pages/__tests__/DiscussionDetail.extraction.test.ts` — jsdom pure-fn test.
- `ui/src/onboarding/__tests__/CloudProviderKeyNotice.test.tsx` — jsdom.
- `ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx` — jsdom.

Commands are run from the worktree ROOT `C:/Users/TK/.aoa/wt/mt-cloud`.

---

### Task D3.1 — Cloud fail-closed **run** copy points at Settings → Providers

`ProviderUnavailableError` is the single fail-closed error thrown for agent + Commander runs in cloud. Re-word its message from a bare negation into an action that names Settings → Providers. It stays cloud-only by construction (the self-hosted path returns `host_login_fallback` and never constructs this error).

**Files:**
- Modify: `server/src/services/provider-resolution.ts:271-285` (the `ProviderUnavailableError` constructor's `super(...)` message, lines 278-284).
- Test (Create): `server/src/__tests__/provider-unavailable-error.test.ts`.

#### Steps

- [ ] **Step 1: Write the failing unit test.** Create `server/src/__tests__/provider-unavailable-error.test.ts`:

```ts
// server/src/__tests__/provider-unavailable-error.test.ts
import { describe, it, expect } from "vitest";
import { ProviderUnavailableError } from "../services/provider-resolution.js";

describe("ProviderUnavailableError (cloud fail-closed run copy)", () => {
  it("preserves the machine-readable diagnostic fields", () => {
    const err = new ProviderUnavailableError("anthropic", "no_assignment", "conn-1");
    expect(err.code).toBe("provider_unavailable");
    expect(err.provider).toBe("anthropic");
    expect(err.reason).toBe("no_assignment");
    expect(err.connectionId).toBe("conn-1");
    expect(err.name).toBe("ProviderUnavailableError");
    expect(err).toBeInstanceOf(Error);
  });

  it("routes the founder to Settings -> Providers (never a keyless-CLI login)", () => {
    const err = new ProviderUnavailableError("anthropic", "assignment_rejected", "conn-9");
    // Actionable: names the per-company key surface.
    expect(err.message).toMatch(/Settings\s*→\s*Providers/);
    // Honest fail-closed: must NOT instruct a keyless-CLI / host login.
    expect(err.message).not.toMatch(
      /host login|CLI login|log ?in to the CLI|claude auth login|codex login|run the CLI/i,
    );
    // Keeps the diagnostic breadcrumb for support.
    expect(err.message).toContain("assignment_rejected");
    expect(err.message).toContain("conn-9");
  });

  it("omits the connection clause when there is no connection id", () => {
    const err = new ProviderUnavailableError("openai", "no_assignment", null);
    expect(err.message).not.toContain("connection ");
    expect(err.message).toMatch(/Settings\s*→\s*Providers/);
  });
});
```

- [ ] **Step 2: Run — confirm it fails.** The current message contains "never uses a host login" (fails the `.not.toMatch(/host login/i)` assertion) and has no "Settings → Providers".

```
pnpm exec vitest run --root server src/__tests__/provider-unavailable-error.test.ts
```
Expected: `2 failed | 1 passed` (the diagnostic-fields test passes; the two copy tests fail on the `Settings → Providers` / `host login` assertions).

- [ ] **Step 3: Minimal implementation.** In `server/src/services/provider-resolution.ts`, replace the `super(...)` call (currently lines 278-284):

Current:
```ts
    super(
      `No usable ${provider} provider credential for this run (${reason}` +
        (connectionId ? `, connection ${connectionId}` : "") +
        "). Cloud resolution fails closed and never uses a host login.",
    );
```

New:
```ts
    super(
      `No usable ${provider} provider credential for this run (${reason}` +
        (connectionId ? `, connection ${connectionId}` : "") +
        "). On AoA Cloud, agents and Commander run on a per-company provider key — " +
        "set one for this company in Settings → Providers, then retry.",
    );
```

- [ ] **Step 4: Run — confirm pass.**
```
pnpm exec vitest run --root server src/__tests__/provider-unavailable-error.test.ts
```
Expected: `Test Files 1 passed` / `Tests 3 passed`.

- [ ] **Step 5: Regression — the resolver matrix still passes** (it asserts `toBeInstanceOf(ProviderUnavailableError)`, not the message text; `provider-resolution-matrix.test.ts:84,96,194,202`):
```
pnpm exec vitest run --root server src/__tests__/provider-resolution-matrix.test.ts
```
Expected: all green (`Tests N passed`).

- [ ] **Step 6: Commit.**
```
git add server/src/services/provider-resolution.ts server/src/__tests__/provider-unavailable-error.test.ts
git commit -m "fix(provider): cloud fail-closed run error routes founder to Settings → Providers"
```

---

### Task D3.2 — Cloud-aware **extraction** failure copy (Discussion banner)

Extraction failures render via the pure helper `extractionFailureMessage(kind, message)` in `DiscussionDetail.tsx:144-185`; the entry banner reads `failureCopy.primary` (`DiscussionDetail.tsx:889-891`). `showSettings` already exists on the return shape but is dead (always `false`, never rendered). In cloud, the credential-shaped kinds (`not_authed`, `not_installed`) must point at Settings → Providers instead of the keyless-CLI login copy the server message carries. Self-hosted stays unchanged.

**Files:**
- Modify: `ui/src/pages/DiscussionDetail.tsx` — `extractionFailureMessage` (144-185); `ThreadEntryRow` health read + call site (668, 756-758); banner render (878-893).
- Test (Modify): `ui/src/pages/__tests__/DiscussionDetail.extraction.test.ts`.

#### Steps

- [ ] **Step 1: Write the failing pure-fn tests.** Append to `ui/src/pages/__tests__/DiscussionDetail.extraction.test.ts` (inside the top-level `describe("extractionFailureMessage", …)`):

```ts
  describe("cloud (multiTenant) credential-shaped failures", () => {
    it("not_authed in cloud points at Settings -> Providers, not a CLI login", () => {
      const result = extractionFailureMessage(
        "not_authed",
        "claude CLI is not authenticated. Run the CLI's login flow, then retry.",
        { multiTenant: true },
      );
      expect(result.primary).toMatch(/Settings\s*→\s*Providers/);
      expect(result.primary).not.toMatch(/login flow|Run the CLI|not logged in/i);
      expect(result.showSettings).toBe(true);
    });

    it("not_installed in cloud points at Settings -> Providers", () => {
      const result = extractionFailureMessage(
        "not_installed",
        "claude CLI not found on PATH. Install the Claude Code CLI and ensure it is on your PATH.",
        { multiTenant: true },
      );
      expect(result.primary).toMatch(/Settings\s*→\s*Providers/);
      expect(result.primary).not.toMatch(/PATH|Install the/i);
      expect(result.showSettings).toBe(true);
    });

    it("does NOT rewrite non-credential kinds in cloud (timeout/nonzero_exit)", () => {
      expect(extractionFailureMessage("timeout", null, { multiTenant: true }).showSettings).toBe(false);
      const nz = extractionFailureMessage("nonzero_exit", "exit code 1", { multiTenant: true });
      expect(nz.primary).toContain("try Reprocess");
      expect(nz.showSettings).toBe(false);
    });

    it("self-hosted (default / multiTenant:false) keeps the CLI copy verbatim", () => {
      const dflt = extractionFailureMessage("not_authed", null);
      expect(dflt.primary).toContain("not logged in");
      expect(dflt.showSettings).toBe(false);
      const explicit = extractionFailureMessage("not_authed", null, { multiTenant: false });
      expect(explicit.primary).toContain("not logged in");
      expect(explicit.showSettings).toBe(false);
    });
  });
```

- [ ] **Step 2: Run — confirm it fails.**
```
pnpm exec vitest run --root ui src/pages/__tests__/DiscussionDetail.extraction.test.ts
```
Expected: the 4 new cases fail (current signature ignores a 3rd arg → cloud cases return the CLI copy with `showSettings:false`); the pre-existing cases still pass.

- [ ] **Step 3: Minimal implementation — the pure helper.** In `ui/src/pages/DiscussionDetail.tsx`, replace the `extractionFailureMessage` signature + the `not_installed` / `not_authed` cases (currently 144-162):

Current:
```ts
export function extractionFailureMessage(
  kind: CliExtractionErrorKind | null,
  message: string | null,
): { primary: string; showSettings: boolean } {
  switch (kind) {
    case "not_installed":
      // Prefer the server's CLI-specific message (e.g. "codex CLI not found")
      // so codex-configured companies aren't told to fix Claude (P3, Codex).
      return {
        primary:
          message ?? "Extraction CLI not detected. Install your configured CLI and sign in.",
        showSettings: false,
      };
    case "not_authed":
      return {
        primary:
          message ?? "Extraction CLI is not logged in. Run its login flow.",
        showSettings: false,
      };
```

New:
```ts
export function extractionFailureMessage(
  kind: CliExtractionErrorKind | null,
  message: string | null,
  opts: { multiTenant?: boolean } = {},
): { primary: string; showSettings: boolean } {
  // On AoA Cloud (multi-tenant) the shared host has no per-company keyless CLI
  // login to borrow, so a credential-shaped failure is fixed by setting a
  // per-company provider key — NOT by a CLI login the founder can't perform.
  // The server's CLI-flavored `message` is intentionally dropped here.
  if (opts.multiTenant && (kind === "not_authed" || kind === "not_installed")) {
    return {
      primary:
        "This company has no usable provider key, so extraction can't run. " +
        "Set one in Settings → Providers, then Reprocess.",
      showSettings: true,
    };
  }
  switch (kind) {
    case "not_installed":
      // Prefer the server's CLI-specific message (e.g. "codex CLI not found")
      // so codex-configured companies aren't told to fix Claude (P3, Codex).
      return {
        primary:
          message ?? "Extraction CLI not detected. Install your configured CLI and sign in.",
        showSettings: false,
      };
    case "not_authed":
      return {
        primary:
          message ?? "Extraction CLI is not logged in. Run its login flow.",
        showSettings: false,
      };
```

(Leave the `timeout` / `nonzero_exit` / `unparseable` / `default` cases untouched.)

- [ ] **Step 4: Run — confirm the pure helper passes.**
```
pnpm exec vitest run --root ui src/pages/__tests__/DiscussionDetail.extraction.test.ts
```
Expected: `Test Files 1 passed` / all cases green.

- [ ] **Step 5: Wire `multiTenant` + the Settings link into the banner** (render wiring; consistent with the existing choice not to full-page-render `DiscussionDetail` in tests — the copy logic is what's unit-covered above; this wiring is covered by `tsc`).

In `ui/src/pages/DiscussionDetail.tsx`:

(a) Add the health import next to the other `../api/*` imports (after line 9, `import { agentsApi } from "../api/agents";`):
```ts
import { healthApi } from "../api/health";
```

(b) In `ThreadEntryRow` (component begins line 668), read deployment mode and pass it to the helper. Replace line 758:

Current:
```ts
  const failureCopy = extractionFailureMessage(extractionErrorKind, extractionError);
```
New:
```ts
  const { data: health } = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get() });
  const failureCopy = extractionFailureMessage(extractionErrorKind, extractionError, {
    multiTenant: health?.deploymentMode === "cloud_auth",
  });
```
(`useQuery` is already imported at line 3; `queryKeys` at line 10, `queryKeys.health` exists at `ui/src/lib/queryKeys.ts:108`. React-Query dedupes the health key across every entry row.)

(c) Render the Settings link in the failed-extraction banner. After the `<p>{failureCopy.primary}</p>` block (currently lines 889-891), add:
```tsx
              {failureCopy.showSettings && (
                <Link
                  to="/settings?tab=providers"
                  className="ml-6 text-xs text-red-700 dark:text-red-400 underline underline-offset-2"
                >
                  Open Settings → Providers
                </Link>
              )}
```
(`Link` is already imported from `@/lib/router` at line 2; the same `/settings?tab=providers` target used by `AgentReadinessBadge.tsx:177`.)

- [ ] **Step 6: Typecheck + full extraction suite.**
```
pnpm exec vitest run --root ui src/pages/__tests__/DiscussionDetail.extraction.test.ts
pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit
```
Expected: tests green; no TS errors. (If the ui package name differs, use `pnpm exec tsc --noEmit` from the `ui/` dir — verify the package's typecheck script name with `pnpm -C ui run` first.)

- [ ] **Step 7: Commit.**
```
git add ui/src/pages/DiscussionDetail.tsx ui/src/pages/__tests__/DiscussionDetail.extraction.test.ts
git commit -m "fix(discussions): cloud extraction failure copy routes to Settings → Providers"
```

---

### Task D3.3 — Non-blocking cloud provider-key **onboarding notice**

A small, self-contained, cloud-only callout that routes the founder to Settings → Providers during onboarding. Made a **pure presentational** component (prop `deploymentMode`) so its jsdom test needs no QueryClient/Router providers; the mount site (`VerifyStep`) does the health fetch. It renders `null` off-cloud, so mounting it in `VerifyStep` leaves the existing self-hosted VerifyStep tests visually unchanged.

> **Reviewer note (jsdom/RTL):** `VerifyStep.test.tsx` renders `<VerifyStep>` **without** a `QueryClientProvider` (bare `render`) — this is exactly why `CloudProviderKeyNotice` is a pure prop component and `VerifyStep` fetches health via a plain effect (not `useQuery`). Do not refactor the notice to `useQuery` without first wrapping every `VerifyStep` render.

**Files:**
- Create: `ui/src/onboarding/CloudProviderKeyNotice.tsx`.
- Test (Create): `ui/src/onboarding/__tests__/CloudProviderKeyNotice.test.tsx`.
- Modify: `ui/src/onboarding/steps/VerifyStep.tsx` (imports + a resilient health effect + render one component).
- Test (Modify): `ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx` (add a health mock + one cloud assertion).

#### Steps

- [ ] **Step 1: Write the failing component test.** Create `ui/src/onboarding/__tests__/CloudProviderKeyNotice.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CloudProviderKeyNotice } from "../CloudProviderKeyNotice";

describe("CloudProviderKeyNotice", () => {
  it("routes to Settings -> Providers on cloud_auth", () => {
    render(<CloudProviderKeyNotice deploymentMode="cloud_auth" />);
    const link = screen.getByRole("link", { name: /providers/i });
    expect(link.getAttribute("href")).toBe("/settings?tab=providers");
    // Guidance is non-blocking / advisory.
    expect(screen.getByTestId("cloud-provider-key-notice").textContent).toMatch(
      /isn't required|not required/i,
    );
  });

  it("renders nothing on self-hosted (local_trusted)", () => {
    const { container } = render(<CloudProviderKeyNotice deploymentMode="local_trusted" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when deploymentMode is undefined (legacy/self-hosted)", () => {
    const { container } = render(<CloudProviderKeyNotice />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run — confirm it fails.** (Module does not exist yet.)
```
pnpm exec vitest run --root ui src/onboarding/__tests__/CloudProviderKeyNotice.test.tsx
```
Expected: fails to resolve `../CloudProviderKeyNotice`.

- [ ] **Step 3: Minimal implementation.** Create `ui/src/onboarding/CloudProviderKeyNotice.tsx`. Uses a plain `<a href>` (not the router `Link`) so it needs no Router/CompanyContext and stays trivially testable; a hard nav out of the onboarding dark shell into Settings is the intended affordance:

```tsx
/**
 * Non-blocking cloud onboarding guidance. On AoA Cloud (`cloud_auth`) the shared
 * host has no per-company keyless-CLI login to borrow, so agents / Commander /
 * extraction fail closed until the founder sets a per-company provider key. This
 * callout routes them to Settings → Providers. Renders nothing on self-hosted
 * (keyless-CLI still works there). Pure/presentational — the mount site supplies
 * `deploymentMode`.
 */
export function CloudProviderKeyNotice({
  deploymentMode,
}: {
  deploymentMode?: string | null;
}) {
  if (deploymentMode !== "cloud_auth") return null;
  return (
    <div
      data-testid="cloud-provider-key-notice"
      className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-left text-xs text-dim"
    >
      <p className="text-text">You're on AoA Cloud.</p>
      <p>
        Agents, Commander, and extraction run on a per-company provider key. Set one in
        Settings → Providers so your agents can run — you can finish setup first, this
        isn't required to continue.
      </p>
      <a
        href="/settings?tab=providers"
        className="inline-block font-medium text-brand-hover underline underline-offset-2"
      >
        Open Settings → Providers
      </a>
    </div>
  );
}
```

- [ ] **Step 4: Run — confirm pass.**
```
pnpm exec vitest run --root ui src/onboarding/__tests__/CloudProviderKeyNotice.test.tsx
```
Expected: `Test Files 1 passed` / `Tests 3 passed`.

- [ ] **Step 5: Write the failing mount test.** In `ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx`, add a health mock alongside the other hoisted mocks (after the `commander-auth` mock block, ~line 61):

```tsx
const getHealth = vi.hoisted(() =>
  vi.fn(async () => ({ status: "ok", deploymentMode: "local_trusted" })),
);
vi.mock("../../../api/health", () => ({ healthApi: { get: getHealth } }));
```

Then add one test (inside the top-level `describe`):
```tsx
  it("shows the cloud provider-key notice in cloud_auth", async () => {
    getHealth.mockResolvedValueOnce({ status: "ok", deploymentMode: "cloud_auth" });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    const link = await screen.findByRole("link", { name: /providers/i });
    expect(link.getAttribute("href")).toBe("/settings?tab=providers");
  });
```

- [ ] **Step 6: Run — confirm the new test fails, existing pass.**
```
pnpm exec vitest run --root ui src/onboarding/steps/__tests__/VerifyStep.test.tsx
```
Expected: the new cloud test fails (VerifyStep doesn't render the notice yet); all pre-existing VerifyStep tests still pass (the default mock returns `local_trusted` → notice renders null → no visual change).

- [ ] **Step 7: Mount in VerifyStep.** In `ui/src/onboarding/steps/VerifyStep.tsx`:

(a) Add imports (after line 3, `import { api, ApiError } from "../../api/client";`):
```ts
import { healthApi } from "../../api/health";
import { CloudProviderKeyNotice } from "../CloudProviderKeyNotice";
```

(b) Add state next to the other `useState` decls in the component body (after line 139, `const [checks, setChecks] = useState<VerifyCheck[]>([]);`):
```ts
  const [deploymentMode, setDeploymentMode] = useState<string | null>(null);
```

(c) Add a resilient health effect (place it near the existing config-fetch effect, e.g. after the block that ends at line 203). Failure is swallowed so an unmocked/offline `/api/health` just leaves the notice hidden:
```ts
  useEffect(() => {
    let alive = true;
    void healthApi
      .get()
      .then((h) => {
        if (alive) setDeploymentMode(h.deploymentMode ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
```

(d) Render the notice under the heading. Immediately after the `StepHeading` `<Reveal>` block closes (currently line 514, the `</Reveal>` after the `<StepHeading … />`), add:
```tsx
      <CloudProviderKeyNotice deploymentMode={deploymentMode} />
```
(It returns `null` off-cloud, so no wrapper/`Reveal` is used — an empty `Reveal` would still render an animated div.)

- [ ] **Step 8: Run — confirm all VerifyStep tests pass.**
```
pnpm exec vitest run --root ui src/onboarding/steps/__tests__/VerifyStep.test.tsx
```
Expected: `Test Files 1 passed`, all tests green (the new cloud test + every pre-existing test). If React logs `act(...)` noise from the added async effect, it is non-fatal (the existing `getConfig`/capabilities effects already resolve async the same way); existing tests already await a query/button before asserting.

- [ ] **Step 9: Registry + onboarding regression** (the notice mount must not disturb the spine):
```
pnpm exec vitest run --root ui src/onboarding
```
Expected: all onboarding suites green.

- [ ] **Step 10: Commit.**
```
git add ui/src/onboarding/CloudProviderKeyNotice.tsx ui/src/onboarding/__tests__/CloudProviderKeyNotice.test.tsx ui/src/onboarding/steps/VerifyStep.tsx ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx
git commit -m "feat(onboarding): non-blocking cloud provider-key notice → Settings → Providers"
```

---

### Final verification (all three D3 tasks)

- [ ] **Server unit tests:**
```
pnpm exec vitest run --root server src/__tests__/provider-unavailable-error.test.ts src/__tests__/provider-resolution-matrix.test.ts
```
- [ ] **UI tests:**
```
pnpm exec vitest run --root ui src/pages/__tests__/DiscussionDetail.extraction.test.ts src/onboarding/__tests__/CloudProviderKeyNotice.test.tsx src/onboarding/steps/__tests__/VerifyStep.test.tsx
```
- [ ] **Typecheck** (both packages) is clean.
- [ ] **Self-hosted unchanged confirmed:** `provider-resolution.ts` still returns `host_login_fallback` for `selfHostedSingleTenant` (untouched); `extractionFailureMessage` with default/`multiTenant:false` returns the verbatim CLI copy; `CloudProviderKeyNotice` renders `null` for `local_trusted`/undefined.
- [ ] **No `AOA_*` env var added** → `docs/deploy/environment-variables.md` / brand-check guard 9 untouched (confirm: `git diff --name-only` lists only the 8 D3 files).

---

## Open questions carried from the drafts (for the orchestrator / design reviewer)

- **D2 organizationId placement:** the plan puts `organizationId` on the `new_company` target variant (`target.organizationId`); `POST /` reads it top-level (`body.organizationId`). Both work with `resolveCompanyOrganizationId`. Confirm the import wizard wiring.
- **D2 legacy founderless companies:** importing agents into a legacy `board`-only company now 422s in `agentService.create` rather than escalating — safer, but a behavior change for legacy data (not repaired here).
- **D3 mount point:** `VerifyStep` (order 5) chosen for lowest blast radius + correct timing; alternatives (dedicated spine step, FirstRunHome tail, EnvironmentStep) weighed and rejected.
- **D3 Commander vs provider key stores:** a Commander key-paste at Verify does NOT satisfy crew/extraction (they need a verified `provider_connection`). Consider clarifying copy.
- **D1 sink label strings** ("org agent" / "crew agent" / "Commander") are baked into the thrown message + asserted by tests — confirm they are the desired operator-facing strings.
