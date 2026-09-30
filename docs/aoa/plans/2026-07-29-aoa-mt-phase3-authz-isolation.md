# AoA Multi-Tenant Cloud — Phase 3: Tenant Authorization + Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tenant (Organization) authorization + isolation over every company-scoped access path, remove the `instance_admin` **data-plane** bypass in `cloud_auth` (preserving the operator plane and self-hosted single-tenant), fix the pre-existing destructive-route (delete/archive) founder gate, add an audited time-boxed operator break-glass (**partial — see note**), and stand up a flag-gated Postgres RLS canary as (production-inert) defense-in-depth.

> **Break-glass status note:** Only `sweepExpired` (boot + interval sweeper) and `hasActiveBreakGlass` (REST-only, live-TTL authorization read) are on a LIVE runtime path. `grant`/`revoke` are **library-only** — no route/CLI/MCP tool calls them, so no grant row can be created through a running server. Operator-console wiring (grant/revoke trigger) is **deferred**; the WS upgrade paths do not yet consult the grant. See the defensive comment in `operator-break-glass.ts`.

**Architecture:** Enforcement is driven by a **single static source of truth** — `tenantIsolationEnforced()` (true iff `deploymentMode === "cloud_auth"`), set once at boot, read by authz/rbac/access. It is NOT derived from the mutable per-request `req.tenant` (which would fail OPEN if middleware were skipped). The `instance_admin` **data** bypass is neutralized at **one chokepoint** — the actor is derived with `isInstanceAdmin=false` in `cloud_auth`, and `access.ts isInstanceAdmin()` returns false in `cloud_auth` — so every one of the ~20 data-plane readers (rbac, authz, `canUser`, team, and route helpers) fails closed without per-site edits; the per-site rbac/authz changes stay as defense-in-depth. Operator authority (instance settings) is preserved via a separate, unclamped `req.actor.operator` field. `assertCompanyAccess` becomes async, resolves the target company's `organization_id`, and asserts org membership; operators reach tenant data only through a live-TTL `operator_break_glass_grants` check at decision time, with a sweeper deleting materialized rows at expiry.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM (postgres-js driver, real Postgres via embedded-postgres in dev/CI), Vitest + supertest, Zod, ESLint (`@typescript-eslint`). Drizzle only for schema; `pnpm db:generate` for migrations. Windows CI skips `*.integration.test.ts` + e2e — so the isolation guarantees are backed by unit/route tests that DO run on Windows, plus a Windows-visible `no-floating-promises` lint gate.

---

## Preconditions & Ownership Boundaries

**Provided by Phase 1 (schema — assume merged before Task 4+):**
- `organizations` table: `id uuid pk`, `name text`, **`slug text NOT NULL`**, timestamps. (The `slug` NOT NULL matters for test seeds.)
- `organization_memberships` table: `id`, `organization_id uuid FK`, **`user_id text`** (NOT a polymorphic principal), `role text` (`owner|admin|member|billing`), `status text default 'active'`, timestamps; unique `(organization_id, user_id)`.
- `companies.organizationId` = `organization_id uuid` on `companies`, FK → `organizations.id`, backfilled to a default org. **P1 adds `organization_id` ONLY to `companies`.**
- `companies_issue_prefix_idx` re-scoped to `(organization_id, issue_prefix)` (P1 owns).
- `DEPLOYMENT_MODES` includes `cloud_auth` (`packages/shared/src/constants.ts`).
- **Migration numbering:** P1 ends at `0188`. **Phase 3 owns exactly ONE migration: `0189`.** P4 = `0190`, P5 = `0191/0192`. A contiguous-journal CI gate is added in P1.

**Provided by Phase 2:** onboarding org creation, "Company" step rename, `organizationAccessService` (`canOrg(orgId, userId, action)` org role predicate), and `cloud_auth` config-schema validation.

**Owned by THIS plan (Phase 3):** `deployment-mode` chokepoint (`tenantIsolationEnforced`) + `req.actor.operator` split; `req.tenant` reserved hint + middleware; `assertTenantMembership` + `resolveCompanyTenant`; async `assertCompanyAccess` + the full-`server/src` codemod + `no-floating-promises` gate; `instance_admin` data-plane neutralization (chokepoint + defense-in-depth); `operator_break_glass_grants` table + service + sweeper; `company_secrets.organization_id` — **folded with the break-glass table into the single migration `0189`**; RLS canary; storage tenant-scope; create/list authorization (final owner); delete/archive founder-gate (Task 1, no P1 dep).

**Task 1 has zero P1 dependency** and MUST be the first commit. Tasks 4+ assume the P1 schema above; if P1 is not merged, stop after Task 3 and coordinate.

---

## File Structure

**New files:**
- `server/src/config/deployment-mode.ts` — `setDeploymentMode`/`getDeploymentMode`/`tenantIsolationEnforced` (single static enforcement source).
- `server/src/middleware/tenant-context.ts` — sets `req.tenant` (reserved org-id hint; NOT the enforcement source).
- `server/src/routes/authz-tenant.ts` — `assertTenantMembership`, `resolveCompanyTenant` (cached), `invalidateCompanyTenant`, `__resetTenantCache`.
- `server/src/services/operator-break-glass.ts` — `operatorBreakGlassService` (grant/revoke/sweep) + `hasActiveBreakGlass` (check-time read). **Live path today = `sweepExpired` + `hasActiveBreakGlass` only; `grant`/`revoke` are library-only (no route/CLI/MCP trigger) — deferred.**
- `packages/db/src/schema/operator_break_glass_grants.ts` — Drizzle table.
- `server/src/db/with-tenant-tx.ts` — RLS GUC transaction helper.
- `server/src/db/rls-bootstrap.ts` — idempotent non-owner `aoa_app` role + policy bootstrap (mirrors `ensurePostgresDatabase`, `client.ts:723`).
- Tests: `companies-destructive-authz.test.ts`, `deployment-mode.test.ts`, `tenant-context-middleware.test.ts`, `authz-tenant.test.ts`, `assert-company-access-tenant.test.ts`, `assert-company-access-failclosed.test.ts`, `instance-admin-neutralized.test.ts`, `operator-break-glass.integration.test.ts`, `mcp-cross-tenant.test.ts`, `storage-tenant-scope.test.ts`, `tenant-isolation-matrix.test.ts`, `migration-0189-contract.test.ts`, `migration-0189-backfill.integration.test.ts`, `rls-canary.integration.test.ts`.

**Modified files:**
- `server/src/types/express.d.ts` — `organizationIds?`, `operator?`, `req.tenant`.
- `server/src/middleware/auth.ts:61-77,82,132-158,154` — populate `organizationIds` + `operator`; clamp `isInstanceAdmin` in cloud.
- `server/src/routes/authz.ts:16-32,71-74` — async `assertCompanyAccess` (static enforcement + break-glass); `canManageInstanceSettings` reads `operator`.
- `server/src/middleware/rbac.ts:39,78,121,153,183` — mode-aware bypass (defense-in-depth).
- `server/src/services/access.ts:45-53` — `isInstanceAdmin()` returns false in cloud.
- `server/src/routes/companies.ts:23-33,35-60,146-160,284-294` — founder gate, list org-filter, create via `canOrg`, invalidate on delete.
- `server/src/app.ts` — `setDeploymentMode(...)` at boot + mount tenant-context + start break-glass sweeper.
- `server/src/storage/service.ts:46-70` — `ensureTenantScope` + tenant write segment.
- `packages/db/src/schema/company_secrets.ts` — nullable `organization_id` (migration `0189`).
- ~541 non-test `assertCompanyAccess` call sites across **`server/src`** (routes/ + `mcp/server.ts` + `services/{approvals,preview-proxy,thread-deliverables}.ts` + `routes/access.ts`) — codemod (Task 8).
- ESLint config for `@armyofagents/server` — enable `@typescript-eslint/no-floating-promises` + a required `lint` gate.

**Consumed from P1/P2 (no Phase 3 edit):** `DEPLOYMENT_MODES`/`cloud_auth` (P1 `constants.ts`); `cloud_auth` config validation (P2 `config-schema.ts`); `organizationAccessService` (P2).

---

## Task 1: Destructive-route founder gate (self-contained, FIRST commit)

Fixes the pre-existing gap: `POST /:companyId/archive` (`companies.ts:264-282`) and `DELETE /:companyId` (`companies.ts:284-294`) are gated on `assertBoard` + `assertCompanyAccess` only — any `team_member` (or `isInstanceAdmin`) can destroy a company. Contrast `enable-teams` (`companies.ts:247`). No tenant schema required.

**Files:**
- Test: `server/src/__tests__/companies-destructive-authz.test.ts` (create)
- Modify: `server/src/routes/companies.ts:264-294`

- [ ] **Step 1: Write the failing test**

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

const getEffectiveRole = vi.fn();
const remove = vi.fn();
const archive = vi.fn();

vi.mock("../services/permissions.js", () => ({ permissionService: () => ({ getEffectiveRole }) }));
vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn() }),
  companyPortabilityService: () => ({}),
  companyService: () => ({ remove, archive }),
  organizationAccessService: () => ({ canOrg: vi.fn() }),
  logActivity: vi.fn(),
}));
vi.mock("../services/internal-agent/aoa-skills-seeder.js", () => ({ seedAoaNativeSkills: vi.fn() }));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({ ensureCommanderAgent: vi.fn() }));
vi.mock("../services/team.js", () => ({ materializeCompanyProfileFromGlobal: vi.fn() }));

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api/companies", companyRoutes({} as any, { deploymentMode: "authenticated" }));
  app.use(errorHandler);
  return app;
}

const founderActor = { type: "board", source: "session", userId: "u-founder", companyIds: ["c1"], isInstanceAdmin: false };
const memberActor = { type: "board", source: "session", userId: "u-member", companyIds: ["c1"], isInstanceAdmin: false };

describe("companies destructive-route founder gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("403 when a team_member tries to DELETE a company", async () => {
    getEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp(memberActor)).delete("/api/companies/c1");
    expect(res.status).toBe(403);
    expect(remove).not.toHaveBeenCalled();
  });

  it("403 when a team_member tries to archive a company", async () => {
    getEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp(memberActor)).post("/api/companies/c1/archive");
    expect(res.status).toBe(403);
    expect(archive).not.toHaveBeenCalled();
  });

  it("200 when a founder deletes a company", async () => {
    getEffectiveRole.mockResolvedValue("founder");
    remove.mockResolvedValue({ id: "c1" });
    const res = await request(makeApp(founderActor)).delete("/api/companies/c1");
    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith("c1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/companies-destructive-authz.test.ts`
Expected: FAIL — the 403 cases return 200; `remove`/`archive` are called.

- [ ] **Step 3: Write minimal implementation**

In `companies.ts`, add the founder gate to both routes (`assertRole` already imported, `companies.ts:15`):
```ts
  router.post("/:companyId/archive", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertRole(db, req, companyId, "founder");
    const company = await svc.archive(companyId);
```
```ts
  router.delete("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertRole(db, req, companyId, "founder");
    const company = await svc.remove(companyId);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/companies-destructive-authz.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/companies.ts server/src/__tests__/companies-destructive-authz.test.ts
git commit -m "fix(authz): require founder role to archive or delete a company

Pre-existing gap: DELETE /:companyId and POST /:companyId/archive were
gated on assertBoard + assertCompanyAccess only, letting any team_member
(or instance_admin) trigger the destructive cascade. Mirror the
enable-teams founder gate (companies.ts:247)."
```

---

## Task 2: Deployment-mode chokepoint + operator-plane split (B2 + B1 foundation)

Enforcement must derive from the STATIC deployment mode (fail-closed), and neutralizing the data bypass must not break the operator plane (`assertCanManageInstanceSettings`).

**Files:**
- Create: `server/src/config/deployment-mode.ts`
- Modify: `server/src/app.ts` (call `setDeploymentMode` at boot)
- Modify: `server/src/types/express.d.ts` (add `operator?`)
- Modify: `server/src/routes/authz.ts:71-74` (`canManageInstanceSettings` reads `operator`)
- Test: `server/src/__tests__/deployment-mode.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { setDeploymentMode, getDeploymentMode, tenantIsolationEnforced } from "../config/deployment-mode.js";

describe("deployment-mode chokepoint", () => {
  beforeEach(() => setDeploymentMode("local_trusted"));

  it("tenantIsolationEnforced() is true ONLY in cloud_auth", () => {
    setDeploymentMode("local_trusted"); expect(tenantIsolationEnforced()).toBe(false);
    setDeploymentMode("authenticated"); expect(tenantIsolationEnforced()).toBe(false);
    setDeploymentMode("cloud_auth"); expect(tenantIsolationEnforced()).toBe(true);
  });

  it("defaults to a NON-enforcing self-hosted mode before boot sets it (never fail-open)", () => {
    expect(["local_trusted", "authenticated"]).toContain(getDeploymentMode());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/deployment-mode.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

`server/src/config/deployment-mode.ts`:
```ts
import type { DeploymentMode } from "@armyofagents/shared";

let deploymentMode: DeploymentMode = "local_trusted";

export function setDeploymentMode(mode: DeploymentMode): void {
  deploymentMode = mode;
}
export function getDeploymentMode(): DeploymentMode {
  return deploymentMode;
}
/** THE single static enforcement source. Read by authz/rbac/access — never req.tenant. */
export function tenantIsolationEnforced(): boolean {
  return deploymentMode === "cloud_auth";
}
```
In `app.ts`, inside the app factory before routers mount:
```ts
import { setDeploymentMode } from "./config/deployment-mode.js";
// ...
setDeploymentMode(opts.deploymentMode);
```
Add `operator?: boolean` to `Actor` in `express.d.ts` (full type in Task 3). Switch `canManageInstanceSettings` (`authz.ts:71-74`) to the operator-plane field so the Task-4 clamp does not disable instance-settings management:
```ts
export function canManageInstanceSettings(req: Request): boolean {
  if (req.actor.type !== "board") return false;
  return req.actor.source === "local_implicit" || req.actor.operator === true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/deployment-mode.test.ts && pnpm --filter @armyofagents/server typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/config/deployment-mode.ts server/src/app.ts server/src/routes/authz.ts server/src/types/express.d.ts server/src/__tests__/deployment-mode.test.ts
git commit -m "feat(authz): static deployment-mode chokepoint + operator-plane field

tenantIsolationEnforced() (cloud_auth) is the single static enforcement
source (fail-closed). canManageInstanceSettings reads the new
req.actor.operator field so neutralizing the data-plane isInstanceAdmin
bypass (next tasks) does not disable the operator plane."
```

---

## Task 3: Actor + Request type augmentation

**Files:**
- Modify: `server/src/types/express.d.ts`

- [ ] **Step 1: Write the change**

```ts
interface Actor {
  type: "none" | "board" | "agent" | "mcp";
  source: string;
  userId?: string;
  companyId?: string;
  companyIds?: string[];
  organizationIds?: string[];
  /** Operator-plane authority (instance settings). Unclamped. NOT a data-plane bypass. */
  operator?: boolean;
  agentId?: string;
  keyId?: string;
  runId?: string;
  /** Data-plane admin bypass — derived FALSE in cloud_auth (Task 4). Legacy self-hosted only. */
  isInstanceAdmin?: boolean;
}

interface TenantContext {
  /** Reserved org-id hint only. NOT the enforcement source — see tenantIsolationEnforced(). */
  organizationId: string | null;
}

declare namespace Express {
  interface Request {
    actor: Actor;
    tenant?: TenantContext;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @armyofagents/server typecheck`
Expected: PASS (additive optional fields).

- [ ] **Step 3: Commit**

```bash
git add server/src/types/express.d.ts
git commit -m "types(authz): add organizationIds + operator to Actor; req.tenant hint"
```

---

## Task 4: auth.ts — populate `organizationIds` + `operator`, clamp `isInstanceAdmin` in cloud (B1 chokepoint)

The single actor-derivation clamp neutralizes EVERY `req.actor.isInstanceAdmin` data-plane reader in cloud_auth without per-site edits. Assumes P1's `organization_memberships`.

**Files:**
- Modify: `server/src/middleware/auth.ts` (session path `:61-82`, board-key path `:132-158`)
- Test: `server/src/__tests__/tenant-context-middleware.test.ts` (create; actor half)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request } from "express";
import { actorMiddleware } from "../middleware/auth.js";

// Promise.all order in auth.ts session path: [instanceUserRoles, companyMemberships, organizationMemberships]
function fakeDb(isAdmin: boolean, companyIds: string[], orgIds: string[]) {
  const chain = (rows: any[]) => ({ from: () => ({ where: () => ({ then: (r: any) => Promise.resolve(rows).then(r) }) }) });
  const calls: any[] = [];
  return {
    select: (cols: any) => {
      calls.push(cols);
      const idx = calls.length - 1;
      if (idx === 0) return chain(isAdmin ? [{ id: "role-1" }] : []);
      if (idx === 1) return chain(companyIds.map((companyId) => ({ companyId })));
      return chain(orgIds.map((organizationId) => ({ organizationId })));
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as any;
}

async function run(db: any, mode: any) {
  const mw = actorMiddleware(db, { deploymentMode: mode, resolveSession: async () => ({ user: { id: "u1" } }) as any });
  const req = { header: () => undefined } as unknown as Request;
  await new Promise<void>((resolve) => mw(req, {} as any, () => resolve()));
  return req.actor;
}

describe("actorMiddleware org + operator + admin clamp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("carries organizationIds and operator=true for an instance admin", async () => {
    const actor = await run(fakeDb(true, ["c1"], ["org-1", "org-2"]), "cloud_auth");
    expect(actor.organizationIds).toEqual(["org-1", "org-2"]);
    expect(actor.operator).toBe(true);
  });

  it("clamps isInstanceAdmin to FALSE in cloud_auth (data bypass removed)", async () => {
    const actor = await run(fakeDb(true, ["c1"], ["org-1"]), "cloud_auth");
    expect(actor.isInstanceAdmin).toBe(false);
    expect(actor.operator).toBe(true); // operator plane preserved
  });

  it("preserves isInstanceAdmin=true in authenticated (self-hosted)", async () => {
    const actor = await run(fakeDb(true, ["c1"], ["org-1"]), "authenticated");
    expect(actor.isInstanceAdmin).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/tenant-context-middleware.test.ts`
Expected: FAIL — no `organizationIds`/`operator`; `isInstanceAdmin` not clamped.

- [ ] **Step 3: Write minimal implementation**

Import the table (`auth.ts:5`): add `organizationMemberships` to the `@armyofagents/db` import.
Session path (`auth.ts:61-85`):
```ts
const [roleRow, memberships, orgMemberships] = await Promise.all([
  db.select({ id: instanceUserRoles.id }).from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows) => rows[0] ?? null),
  db.select({ companyId: companyMemberships.companyId }).from(companyMemberships)
    .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))),
  db.select({ organizationId: organizationMemberships.organizationId }).from(organizationMemberships)
    .where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, "active"))),
]);
const isOperator = Boolean(roleRow);
const cloud = opts.deploymentMode === "cloud_auth";
req.actor = {
  type: "board",
  userId,
  companyIds: memberships.map((row) => row.companyId),
  organizationIds: orgMemberships.map((row) => row.organizationId),
  operator: isOperator,
  isInstanceAdmin: cloud ? false : isOperator, // B1: data-plane bypass clamped in cloud
  runId: runIdHeader ?? undefined,
  source: "session",
};
```
Apply the identical third-query + `operator` + clamped `isInstanceAdmin` to the board-key path (`auth.ts:132-158`), keyed on `boardKeyRow.userId`. (`company_memberships` stays `principalType`/`principalId` — that table IS polymorphic; only `organization_memberships` uses `userId`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/tenant-context-middleware.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/middleware/auth.ts server/src/__tests__/tenant-context-middleware.test.ts
git commit -m "feat(authz): actor carries organizationIds + operator; clamp isInstanceAdmin in cloud_auth

Single chokepoint: every req.actor.isInstanceAdmin data-plane reader
fails closed in cloud_auth. Operator plane preserved via actor.operator."
```

---

## Task 5: Tenant-context middleware + mount (reserved hint)

`req.tenant` is a reserved org-id hint. It is NOT read for enforcement (B2).

**Files:**
- Create: `server/src/middleware/tenant-context.ts`
- Test: append to `server/src/__tests__/tenant-context-middleware.test.ts`
- Modify: `server/src/app.ts` (mount after `actorMiddleware`, before `boardMutationGuard`)

- [ ] **Step 1: Write the failing test** (append)

```ts
import { tenantContextMiddleware } from "../middleware/tenant-context.js";

describe("tenantContextMiddleware", () => {
  it("sets a reserved req.tenant hint (organizationId null until resolved)", () => {
    const req = {} as any;
    tenantContextMiddleware()(req, {} as any, () => {});
    expect(req.tenant).toEqual({ organizationId: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/tenant-context-middleware.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

`server/src/middleware/tenant-context.ts`:
```ts
import type { RequestHandler } from "express";

export function tenantContextMiddleware(): RequestHandler {
  return (req, _res, next) => {
    req.tenant = { organizationId: null };
    next();
  };
}
```
Mount in `app.ts` after `actorMiddleware` and before `boardMutationGuard`:
```ts
import { tenantContextMiddleware } from "./middleware/tenant-context.js";
// ...after app.use(actorMiddleware(...)):
app.use(tenantContextMiddleware());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/tenant-context-middleware.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/middleware/tenant-context.ts server/src/app.ts server/src/__tests__/tenant-context-middleware.test.ts
git commit -m "feat(authz): tenant-context middleware sets reserved req.tenant hint"
```

---

## Task 6: `assertTenantMembership` + cached `resolveCompanyTenant`

**Files:**
- Create: `server/src/routes/authz-tenant.ts`
- Test: `server/src/__tests__/authz-tenant.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { assertTenantMembership, resolveCompanyTenant, invalidateCompanyTenant, __resetTenantCache } from "../routes/authz-tenant.js";

function dbReturning(orgId: string | null) {
  const calls = { n: 0 };
  const db = { select: () => ({ from: () => ({ where: () => ({ then: (r: any) => { calls.n++; return Promise.resolve(orgId ? [{ organizationId: orgId }] : []).then(r); } }) }) }) } as any;
  return { db, calls };
}

describe("resolveCompanyTenant", () => {
  beforeEach(() => __resetTenantCache());
  it("caches (one DB hit for two calls)", async () => {
    const { db, calls } = dbReturning("org-1");
    expect(await resolveCompanyTenant(db, "c1")).toBe("org-1");
    expect(await resolveCompanyTenant(db, "c1")).toBe("org-1");
    expect(calls.n).toBe(1);
  });
  it("null for a missing company", async () => {
    const { db } = dbReturning(null);
    expect(await resolveCompanyTenant(db, "missing")).toBeNull();
  });
  it("invalidate forces re-fetch", async () => {
    const { db, calls } = dbReturning("org-1");
    await resolveCompanyTenant(db, "c1");
    invalidateCompanyTenant("c1");
    await resolveCompanyTenant(db, "c1");
    expect(calls.n).toBe(2);
  });
});

describe("assertTenantMembership", () => {
  it("passes for a member", () => expect(() => assertTenantMembership({ actor: { organizationIds: ["org-1"] } } as any, "org-1")).not.toThrow());
  it("403s a non-member", () => expect(() => assertTenantMembership({ actor: { organizationIds: ["org-2"] } } as any, "org-1")).toThrow(/organization/i));
  it("no-ops when tenantId null (missing company -> route 404)", () => expect(() => assertTenantMembership({ actor: { organizationIds: [] } } as any, null)).not.toThrow());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/authz-tenant.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

`server/src/routes/authz-tenant.ts`:
```ts
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@armyofagents/db";
import { forbidden } from "../errors.js";

const tenantCache = new Map<string, string>(); // companyId -> organizationId (immutable-ish)

export function invalidateCompanyTenant(companyId: string): void { tenantCache.delete(companyId); }
export function __resetTenantCache(): void { tenantCache.clear(); }

export async function resolveCompanyTenant(db: Db, companyId: string): Promise<string | null> {
  const cached = tenantCache.get(companyId);
  if (cached) return cached;
  const row = await db.select({ organizationId: companies.organizationId }).from(companies)
    .where(eq(companies.id, companyId)).then((rows) => rows[0] ?? null);
  const orgId = row?.organizationId ?? null;
  if (orgId) tenantCache.set(companyId, orgId);
  return orgId;
}

export function assertTenantMembership(req: Request, tenantId: string | null): void {
  if (tenantId === null) return; // missing company: let the route return its own 404
  const orgs = req.actor.organizationIds ?? [];
  if (!orgs.includes(tenantId)) throw forbidden("Actor is not a member of this organization");
}
```
(`companies.organizationId` needs the P1 column; typecheck failure here means P1 isn't merged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/authz-tenant.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/authz-tenant.ts server/src/__tests__/authz-tenant.test.ts
git commit -m "feat(authz): assertTenantMembership + cached resolveCompanyTenant"
```

---

## Task 7: Make `assertCompanyAccess` async, fail-closed, break-glass-aware (B2 + B3 hook)

Enforcement uses `tenantIsolationEnforced()` (static), NOT `req.tenant` — so a handler reached without the tenant middleware still fails CLOSED in cloud_auth. Operators get data only via a live break-glass check.

**Files:**
- Modify: `server/src/routes/authz.ts:16-32`
- Test: `server/src/__tests__/assert-company-access-tenant.test.ts`, `server/src/__tests__/assert-company-access-failclosed.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

`assert-company-access-tenant.test.ts`:
```ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { assertCompanyAccess } from "../routes/authz.js";
import { __resetTenantCache } from "../routes/authz-tenant.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

const hasActiveBreakGlass = vi.fn();
vi.mock("../services/operator-break-glass.js", () => ({ hasActiveBreakGlass: (...a: any[]) => hasActiveBreakGlass(...a) }));

function db(orgId: string | null) {
  return { select: () => ({ from: () => ({ where: () => ({ then: (r: any) => Promise.resolve(orgId ? [{ organizationId: orgId }] : []).then(r) }) }) }) } as any;
}

describe("assertCompanyAccess — cloud_auth", () => {
  beforeEach(() => { __resetTenantCache(); hasActiveBreakGlass.mockReset(); setDeploymentMode("cloud_auth"); });

  it("passes an org member with company membership", async () => {
    const req = { actor: { type: "board", source: "session", userId: "u", companyIds: ["c1"], organizationIds: ["org-1"] } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).resolves.toBeUndefined();
  });
  it("403s an operator with no membership and NO active grant", async () => {
    hasActiveBreakGlass.mockResolvedValue(false);
    const req = { actor: { type: "board", source: "session", userId: "op", companyIds: [], organizationIds: [], operator: true, isInstanceAdmin: false } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).rejects.toThrow();
  });
  it("passes an operator WITH an active break-glass grant (live TTL)", async () => {
    hasActiveBreakGlass.mockResolvedValue(true);
    const req = { actor: { type: "board", source: "session", userId: "op", companyIds: [], organizationIds: [], operator: true, isInstanceAdmin: false } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).resolves.toBeUndefined();
    expect(hasActiveBreakGlass).toHaveBeenCalledWith(expect.anything(), "op", "c1");
  });
  it("403s a member of a DIFFERENT org (IDOR)", async () => {
    const req = { actor: { type: "board", source: "session", userId: "u", companyIds: ["c1"], organizationIds: ["org-2"] } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).rejects.toThrow(/organization/i);
  });
  it("403s an agent key from another company", async () => {
    const req = { actor: { type: "agent", source: "agent_key", companyId: "c2" } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).rejects.toThrow(/another company/i);
  });
});

describe("assertCompanyAccess — self-hosted (not enforced)", () => {
  beforeEach(() => { __resetTenantCache(); setDeploymentMode("authenticated"); });
  it("preserves instance_admin bypass", async () => {
    const req = { actor: { type: "board", source: "session", userId: "op", companyIds: [], isInstanceAdmin: true } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).resolves.toBeUndefined();
  });
  it("preserves local_implicit bypass", async () => {
    const req = { actor: { type: "board", source: "local_implicit", userId: "local-board" } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).resolves.toBeUndefined();
  });
});
```

`assert-company-access-failclosed.test.ts` (B2 — no tenant middleware ran; enforcement still applies):
```ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { assertCompanyAccess } from "../routes/authz.js";
import { __resetTenantCache } from "../routes/authz-tenant.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

vi.mock("../services/operator-break-glass.js", () => ({ hasActiveBreakGlass: async () => false }));
const db = { select: () => ({ from: () => ({ where: () => ({ then: (r: any) => Promise.resolve([{ organizationId: "org-1" }]).then(r) }) }) }) } as any;

describe("assertCompanyAccess fails CLOSED without tenant middleware", () => {
  beforeEach(() => { __resetTenantCache(); setDeploymentMode("cloud_auth"); });
  it("403s a non-member even though req.tenant is undefined (middleware skipped)", async () => {
    const req = { actor: { type: "board", source: "session", userId: "u", companyIds: [], organizationIds: [] } } as any; // no req.tenant
    await expect(assertCompanyAccess(db, req, "c1")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/assert-company-access-tenant.test.ts src/__tests__/assert-company-access-failclosed.test.ts`
Expected: FAIL — `assertCompanyAccess` is sync `(req, companyId)`, no static-mode gate, no break-glass.

- [ ] **Step 3: Write minimal implementation**

Replace `assertCompanyAccess` (`authz.ts:16-32`):
```ts
import type { Db } from "@armyofagents/db";
import { assertTenantMembership, resolveCompanyTenant } from "./authz-tenant.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { hasActiveBreakGlass } from "../services/operator-break-glass.js";

export async function assertCompanyAccess(db: Db, req: Request, companyId: string): Promise<void> {
  if (req.actor.type === "none") throw unauthorized();
  if (req.actor.type === "board" && req.actor.source === "local_implicit") return; // self-hosted loopback

  if (req.actor.type === "agent") {
    if (req.actor.companyId !== companyId) throw forbidden("Agent key cannot access another company");
    return;
  }
  if (req.actor.type === "mcp") {
    if (req.actor.companyId !== companyId) throw forbidden("MCP key cannot access another company");
    return;
  }

  // board (session / board_key). Enforcement from STATIC mode — never req.tenant (fail-closed).
  if (!tenantIsolationEnforced()) {
    if (req.actor.isInstanceAdmin) return; // legacy self-hosted bypass
    const allowed = req.actor.companyIds ?? [];
    if (!allowed.includes(companyId)) throw forbidden("User does not have access to this company");
    return;
  }

  // cloud_auth: tenant + company membership; operators only via live break-glass.
  const tenantId = await resolveCompanyTenant(db, companyId);
  const orgs = req.actor.organizationIds ?? [];
  const companyIds = req.actor.companyIds ?? [];
  const memberOk = tenantId !== null && orgs.includes(tenantId) && companyIds.includes(companyId);
  if (memberOk) return;
  if (req.actor.operator && req.actor.userId && (await hasActiveBreakGlass(db, req.actor.userId, companyId))) return;
  // Surface the org-mismatch error when the tenant boundary is what failed; else company-scope error.
  if (tenantId !== null && !orgs.includes(tenantId)) assertTenantMembership(req, tenantId);
  throw forbidden("User does not have access to this company");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/assert-company-access-tenant.test.ts src/__tests__/assert-company-access-failclosed.test.ts`
Expected: PASS. (Server-wide typecheck fails until Task 8 — expected.)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/authz.ts server/src/__tests__/assert-company-access-tenant.test.ts server/src/__tests__/assert-company-access-failclosed.test.ts
git commit -m "feat(authz): async fail-closed tenant-aware assertCompanyAccess + break-glass check

Enforcement derives from static tenantIsolationEnforced() (not the
mutable req.tenant, which would fail open). Operators reach tenant data
only via a live hasActiveBreakGlass() check. Callers updated next commit."
```

---

## Task 8: Codemod ALL `server/src` call sites + `no-floating-promises` gate (B4)

`assertCompanyAccess` is called ~541× across **all of `server/src`** — routes/ AND `mcp/server.ts` (8×, the most untrusted inbound), `services/approvals.ts`, `services/preview-proxy.ts`, `services/thread-deliverables.ts`, `routes/access.ts`. A missed `await` on the now-async gate silently returns a promise (truthy) and **bypasses the 403** — so a required, Windows-visible lint gate is mandatory.

**Files:**
- Modify: every non-test `server/src` file calling `assertCompanyAccess` (minus `routes/authz.ts` which defines it).
- Modify: `server/.eslintrc` (or `eslint.config.js`) + `server/package.json` (`lint` script) + `.github/workflows/pr.yml` (required lint job).

- [ ] **Step 1: Enumerate the real scope (correct the false "routes only" claim)**

Run:
```bash
grep -rln "assertCompanyAccess(" server/src --include=*.ts | grep -v "__tests__" | grep -v "routes/authz.ts"
```
Expected: routes/* plus `server/src/mcp/server.ts`, `server/src/services/approvals.ts`, `server/src/services/preview-proxy.ts`, `server/src/services/thread-deliverables.ts`, `server/src/routes/access.ts`. Record the list; the MCP + service files are **manual** sites (Step 3).

- [ ] **Step 2: Apply the mechanical replacement to the `req,`-form sites**

```bash
grep -rl "assertCompanyAccess(req," server/src --include=*.ts | grep -v "__tests__" \
  | xargs sed -i 's/assertCompanyAccess(req,/await assertCompanyAccess(db, req,/g'
grep -rn "await await assertCompanyAccess" server/src --include=*.ts   # expect: none
```

- [ ] **Step 3: Fix the MANUAL sites (db not in scope / different request context)**

- `server/src/mcp/server.ts` (8 sites, e.g. `:229,:292,:310,:335,:342,:364,:389`): each handler closes over the router `db`; convert to `await assertCompanyAccess(db, req, companyId)`. For the JSON-RPC tool path (`:229`, inside the shared MCP handler), confirm `db` is threaded into that handler's context; if it is reached from a helper without `db`, pass `db` as a parameter. This is the **highest-value** conversion (untrusted inbound Bearer tokens).
- `server/src/services/preview-proxy.ts:102`: `buildPreviewTargetUrl`/its caller must accept a `db` argument; thread `db` from the calling route (`routes/*preview*`) into the service and `await` the gate.
- `server/src/services/approvals.ts` and `services/thread-deliverables.ts`: thread the service's existing `db` handle; add `await`.

- [ ] **Step 4: Add the `no-floating-promises` required gate**

Enable type-aware linting for `@armyofagents/server`. In the server ESLint config add:
```js
// server eslint config — rules
"@typescript-eslint/no-floating-promises": "error",
```
with `parserOptions: { project: ["./tsconfig.json"] }`. Add to `server/package.json`:
```json
"lint": "eslint \"src/**/*.ts\" --max-warnings=0"
```
Add a required job to `.github/workflows/pr.yml` under the `verify` gate that runs `pnpm --filter @armyofagents/server lint` on **all** platforms (Linux required; keep it visible/green on Windows since ESLint is platform-independent — this is the guard that catches a dropped `await` on `assertCompanyAccess` that Windows unit tests alone would miss).

- [ ] **Step 5: Typecheck + lint + full suite**

Run: `pnpm --filter @armyofagents/server typecheck && pnpm --filter @armyofagents/server lint && pnpm --filter @armyofagents/server exec vitest run`
Expected: PASS. Fix any `db`-out-of-scope or non-async-handler errors surfaced by typecheck; fix any floating-promise the lint flags (a real missed `await`).

- [ ] **Step 6: Commit**

```bash
git add -A server .github
git commit -m "refactor(authz): await tenant-aware assertCompanyAccess across ALL server/src + no-floating-promises gate

Codemod covers routes/ AND mcp/server.ts (untrusted inbound), preview-proxy,
approvals, thread-deliverables. Adds a required @typescript-eslint/
no-floating-promises lint gate so a dropped await (silent 403 bypass) fails CI."
```

---

## Task 9: Neutralize `instance_admin` in access.ts/team + defense-in-depth rbac (B1 completion)

The auth.ts clamp (Task 4) covers `req.actor.isInstanceAdmin` readers. `access.ts isInstanceAdmin()` queries the DB directly (used by `canUser:102` and by `team.ts effectiveRoleFromRows:80`), so it must be independently mode-aware. Keep the rbac per-site changes as defense-in-depth.

**Files:**
- Modify: `server/src/services/access.ts:45-53`
- Modify: `server/src/middleware/rbac.ts:39,78,121,153,183`
- Test: `server/src/__tests__/instance-admin-neutralized.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";

// access.ts isInstanceAdmin() must return false in cloud even with an instance_user_roles row.
function db(hasAdminRow: boolean) {
  return {
    select: () => ({ from: () => ({ where: () => ({ then: (r: any) => Promise.resolve(hasAdminRow ? [{ id: "role-1" }] : []).then(r) }) }) }),
  } as any;
}
import { accessService } from "../services/access.js";

describe("access.isInstanceAdmin mode-aware (B1)", () => {
  beforeEach(() => setDeploymentMode("local_trusted"));
  it("true in self-hosted when the row exists", async () => {
    setDeploymentMode("authenticated");
    expect(await accessService(db(true)).isInstanceAdmin("op")).toBe(true);
  });
  it("FALSE in cloud_auth even when the row exists (no cross-tenant canUser)", async () => {
    setDeploymentMode("cloud_auth");
    const svc = accessService(db(true));
    expect(await svc.isInstanceAdmin("op")).toBe(false);
    // canUser must therefore NOT short-circuit to true for a non-member operator
    // (hasPermission returns false because getMembership finds no active membership).
    expect(await svc.canUser("cB", "op", "tasks:assign" as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/instance-admin-neutralized.test.ts`
Expected: FAIL — `isInstanceAdmin()` returns true regardless of mode; `canUser` short-circuits.

- [ ] **Step 3: Write minimal implementation**

`access.ts:45-53`:
```ts
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
// ...
async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  if (tenantIsolationEnforced()) return false; // B1: no data-plane admin in cloud_auth
  const row = await db.select({ id: instanceUserRoles.id }).from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}
```
This also neutralizes `team.ts effectiveRoleFromRows` (its `isInstanceAdmin` bool is sourced from this function / `req.actor.isInstanceAdmin`, both now false in cloud).
Defense-in-depth in `rbac.ts` — change each bypass (`:39,78,121,153,183`) from `if (req.actor.isInstanceAdmin) return;` to:
```ts
if (req.actor.isInstanceAdmin && !tenantIsolationEnforced()) return;
```
(Redundant with the clamp, but a belt against any future path that sets `isInstanceAdmin` true.) Import `tenantIsolationEnforced` in `rbac.ts`. Leave `local_implicit` bypasses untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/instance-admin-neutralized.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/access.ts server/src/middleware/rbac.ts server/src/__tests__/instance-admin-neutralized.test.ts
git commit -m "feat(authz): neutralize instance_admin data plane in access.ts/team + rbac defense-in-depth

access.isInstanceAdmin() returns false in cloud_auth (kills canUser +
team.effectiveRoleFromRows cross-tenant grant). rbac bypasses gated on
!tenantIsolationEnforced()."
```

---

## Task 10: Break-glass table + service + sweeper (B3) + `company_secrets.organization_id` — single migration 0189 (B5)

Grant materializes an **organization_membership** (the current bug: it never did → operator still failed `assertTenantMembership`). Authorization is decided at **check time** via `hasActiveBreakGlass()` (live TTL). A **sweeper** deletes materialized rows at expiry. Both schema changes (this table + `company_secrets.organization_id`) are generated in ONE `db:generate` pass = the single `0189`.

**Files:**
- Create: `packages/db/src/schema/operator_break_glass_grants.ts`
- Modify: `packages/db/src/schema/index.ts` (export) + `packages/db/src/schema/company_secrets.ts` (add `organization_id`)
- Create: `packages/db/src/migrations/0189_*.sql` (ONE generated migration + appended backfill)
- Create: `server/src/services/operator-break-glass.ts`
- Modify: `server/src/app.ts` / boot (start sweeper interval)
- Test: `server/src/__tests__/operator-break-glass.integration.test.ts` (create)

- [ ] **Step 1: Author BOTH schema changes, then generate the single 0189**

`packages/db/src/schema/operator_break_glass_grants.ts`:
```ts
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

export const operatorBreakGlassGrants = pgTable(
  "operator_break_glass_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorUserId: text("operator_user_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    companyId: uuid("company_id"),           // null = org-wide grant
    role: text("role").notNull().default("founder"),
    reason: text("reason").notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    sweptAt: timestamp("swept_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operatorActiveIdx: index("obg_operator_active_idx").on(table.operatorUserId, table.expiresAt),
    orgIdx: index("obg_org_idx").on(table.organizationId),
  }),
);
```
Export it from `packages/db/src/schema/index.ts`:
```ts
export { operatorBreakGlassGrants } from "./operator_break_glass_grants.js";
```
Add the nullable column to `packages/db/src/schema/company_secrets.ts` (after `companyId`, `:11`):
```ts
    organizationId: uuid("organization_id"),
```
Generate ONE migration for both:

Run: `pnpm db:generate`
Expected: a single `packages/db/src/migrations/0189_*.sql` containing `CREATE TABLE "operator_break_glass_grants" ...` AND `ALTER TABLE "company_secrets" ADD COLUMN "organization_id" uuid;` + one `_journal.json` entry `0189`. (P4 stays `0190`.)

Append the `company_secrets` backfill to the same 0189 file (drizzle emits only the column add; the data step is appended after the breakpoint that `client.ts:28` splits on):
```sql
--> statement-breakpoint
UPDATE "company_secrets" SET "organization_id" = c."organization_id" FROM "companies" c WHERE "company_secrets"."company_id" = c."id" AND "company_secrets"."organization_id" IS NULL;
```

- [ ] **Step 2: Write the failing integration test (real DB; grant → materialized org membership → live check; + expiry + sweep)**

`server/src/__tests__/operator-break-glass.integration.test.ts` — boot embedded-postgres like `companies-delete-integration.test.ts:59-102`, then:
```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { operatorBreakGlassService, hasActiveBreakGlass } from "../services/operator-break-glass.js";

type EPI = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EPC = new (o: { databaseDir: string; user: string; password: string; port: number; persistent: boolean }) => EPI;
const ORG = "00000000-0000-0000-0000-0000000000a1";
const CO = "00000000-0000-0000-0000-0000000000c1";
const PORT = 55000 + Math.floor(Math.random() * 1000);
let pg: EPI | null = null; let dataDir = ""; let db: Db; let err: unknown = null;

function count(res: unknown): number {
  const row = Array.isArray(res) ? res[0] : (res as any).rows[0];
  return Number(row.c);
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-bg-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EPC };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise(); await pg.start();
    const url = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(url); db = createDb(url);
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org A', 'org-a')`);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co A', 'PPA', ${ORG})`);
  } catch (e) { err = e; }
}, 180_000);
afterAll(async () => { try { if (pg) await pg.stop(); } catch {} try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch {} }, 60_000);

const deps = () => ({
  materializeMembership: async ({ organizationId, userId, role }: any) => {
    await db.execute(sql`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES (${organizationId}, ${userId}, ${role}, 'active') ON CONFLICT (organization_id, user_id) DO NOTHING`);
  },
  revokeMembership: async ({ organizationId, userId }: any) => {
    await db.execute(sql`DELETE FROM organization_memberships WHERE organization_id = ${organizationId} AND user_id = ${userId}`);
  },
  audit: async () => {},
});

describe.skipIf(process.platform !== "linux")("operator break-glass (real DB)", () => {
  it("grant materializes org membership AND is live-checkable; expiry denies; sweeper cleans", async () => {
    if (err) throw new Error(String(err));
    const svc = operatorBreakGlassService(db, deps());

    await svc.grant({ operatorUserId: "op", organizationId: ORG, companyId: CO, role: "founder", reason: "SEV-1", grantedByUserId: "op", ttlMinutes: 60 });

    const mem = await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'op'`);
    expect(count(mem)).toBe(1); // operator now passes assertTenantMembership on re-derive

    expect(await hasActiveBreakGlass(db, "op", CO)).toBe(true);

    await db.execute(sql`UPDATE operator_break_glass_grants SET expires_at = now() - interval '1 minute' WHERE operator_user_id = 'op'`);
    expect(await hasActiveBreakGlass(db, "op", CO)).toBe(false); // TTL authoritative BEFORE any sweep

    const swept = await svc.sweepExpired();
    expect(swept).toBeGreaterThanOrEqual(1);
    const after = await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'op'`);
    expect(count(after)).toBe(0);
  }, 90_000);

  it("revoke removes an org-wide grant (companyId null) and its membership", async () => {
    if (err) throw new Error(String(err));
    const svc = operatorBreakGlassService(db, deps());
    await svc.grant({ operatorUserId: "op2", organizationId: ORG, companyId: null, role: "founder", reason: "x", grantedByUserId: "op2", ttlMinutes: 60 });
    expect(await hasActiveBreakGlass(db, "op2", CO)).toBe(true); // null companyId => org-wide, matches any company in the org
    await svc.revoke("op2", ORG);
    expect(await hasActiveBreakGlass(db, "op2", CO)).toBe(false);
  }, 90_000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run (Linux): `pnpm --filter @armyofagents/server exec vitest run src/__tests__/operator-break-glass.integration.test.ts`
Expected: FAIL — service module missing. (Windows: `skipIf`-skipped.)

- [ ] **Step 4: Write minimal implementation**

`server/src/services/operator-break-glass.ts`:
```ts
import { and, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { operatorBreakGlassGrants, type Db } from "@armyofagents/db";

interface Deps {
  materializeMembership: (a: { organizationId: string; companyId: string | null; userId: string; role: string }) => Promise<void>;
  revokeMembership: (a: { organizationId: string; userId: string }) => Promise<void>;
  audit: (e: { action: string; operatorUserId: string; organizationId: string; companyId: string | null }) => Promise<void>;
}
interface GrantInput {
  operatorUserId: string; organizationId: string; companyId: string | null;
  role: string; reason: string; grantedByUserId: string; ttlMinutes: number;
}

/** Live TTL read used at authorization decision time (authoritative — independent of the sweeper). */
export async function hasActiveBreakGlass(db: Db, operatorUserId: string, companyId: string): Promise<boolean> {
  const rows = await db.select({ companyId: operatorBreakGlassGrants.companyId }).from(operatorBreakGlassGrants)
    .where(and(
      eq(operatorBreakGlassGrants.operatorUserId, operatorUserId),
      isNull(operatorBreakGlassGrants.revokedAt),
      gt(operatorBreakGlassGrants.expiresAt, new Date()),
    ));
  return rows.some((r) => r.companyId === null || r.companyId === companyId);
}

export function operatorBreakGlassService(db: Db, deps: Deps) {
  async function grant(input: GrantInput) {
    const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
    const [row] = await db.insert(operatorBreakGlassGrants).values({
      operatorUserId: input.operatorUserId, organizationId: input.organizationId, companyId: input.companyId,
      role: input.role, reason: input.reason, grantedByUserId: input.grantedByUserId, expiresAt,
    }).returning();
    await deps.materializeMembership({ organizationId: input.organizationId, companyId: input.companyId, userId: input.operatorUserId, role: input.role });
    await deps.audit({ action: "operator.break_glass.granted", operatorUserId: input.operatorUserId, organizationId: input.organizationId, companyId: input.companyId });
    return row;
  }

  async function revoke(operatorUserId: string, organizationId: string) {
    await db.update(operatorBreakGlassGrants).set({ revokedAt: new Date() })
      .where(and(eq(operatorBreakGlassGrants.operatorUserId, operatorUserId), eq(operatorBreakGlassGrants.organizationId, organizationId), isNull(operatorBreakGlassGrants.revokedAt)));
    await deps.revokeMembership({ organizationId, userId: operatorUserId });
    await deps.audit({ action: "operator.break_glass.revoked", operatorUserId, organizationId, companyId: null });
  }

  /** Boot + interval: remove materialized rows for grants past expiry or revoked-but-not-swept. */
  async function sweepExpired(): Promise<number> {
    const stale = await db.select().from(operatorBreakGlassGrants)
      .where(and(
        isNull(operatorBreakGlassGrants.sweptAt),
        or(lte(operatorBreakGlassGrants.expiresAt, new Date()), isNotNull(operatorBreakGlassGrants.revokedAt)),
      ));
    for (const g of stale) {
      await deps.revokeMembership({ organizationId: g.organizationId, userId: g.operatorUserId });
      await db.update(operatorBreakGlassGrants).set({ sweptAt: new Date() }).where(eq(operatorBreakGlassGrants.id, g.id));
      await deps.audit({ action: "operator.break_glass.swept", operatorUserId: g.operatorUserId, organizationId: g.organizationId, companyId: g.companyId });
    }
    return stale.length;
  }

  return { grant, revoke, sweepExpired };
}
```
Wire the sweeper at boot in `app.ts` (or `index.ts`) with the real deps (materialize/revoke against `organization_memberships` + optional `user_roles`; `audit` → `activity_log`):
```ts
import { operatorBreakGlassService } from "./services/operator-break-glass.js";
const breakGlass = operatorBreakGlassService(db, realBreakGlassDeps(db));
void breakGlass.sweepExpired();
setInterval(() => { void breakGlass.sweepExpired(); }, 60_000).unref();
```

- [ ] **Step 5: Run test to verify it passes**

Run (Linux): `pnpm --filter @armyofagents/server exec vitest run src/__tests__/operator-break-glass.integration.test.ts && pnpm --filter @armyofagents/db typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/operator_break_glass_grants.ts packages/db/src/schema/company_secrets.ts packages/db/src/schema/index.ts packages/db/src/migrations server/src/services/operator-break-glass.ts server/src/app.ts server/src/__tests__/operator-break-glass.integration.test.ts
git commit -m "feat(authz): operator break-glass (org-membership materialization + live TTL + sweeper)

grant() now writes an organization_membership (was missing -> operator
still failed assertTenantMembership). Authorization decided at check time
via hasActiveBreakGlass() (TTL authoritative); sweeper deletes materialized
rows at expiry; revoke handles org-wide (companyId null) grants. Break-glass
table + company_secrets.organization_id share the single migration 0189."
```

---

## Task 11: RLS canary — `withTenantTx` + `aoa_app`-scoped policy + real seed (M3)

Defense-in-depth only. **State plainly: RLS is INERT in production for the beta** — the runtime app connects as the cluster owner/superuser, which bypasses RLS; the app-layer tenant gate (Tasks 6-9) is the ONLY live boundary. The canary proves the GUC plumbing for a later full-fleet follow-up. RLS is scoped strictly to the non-owner `aoa_app` test role; the owner is never filtered.

**Files:**
- Create: `server/src/db/with-tenant-tx.ts`, `server/src/db/rls-bootstrap.ts`
- Test: `server/src/__tests__/rls-canary.integration.test.ts` (create)

- [ ] **Step 1: Write `withTenantTx`**

`server/src/db/with-tenant-tx.ts`:
```ts
import { sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";

/** Runs fn in a tx with the tenant GUC set transaction-local (is_local=true) so it never
 * leaks across pooled connections. RLS policies read current_setting('aoa.organization_id', true). */
export async function withTenantTx<T>(db: Db, organizationId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('aoa.organization_id', ${organizationId}, true)`);
    return fn(tx as unknown as Db);
  });
}
```

- [ ] **Step 2: Write the RLS bootstrap (owner NOT filtered; policy scoped to `aoa_app`)**

Role/GRANT/`CREATE POLICY` are cluster DDL `drizzle-kit generate` does not emit — use an idempotent bootstrap (precedent: `ensurePostgresDatabase`, `client.ts:723`), NOT a migration file. `server/src/db/rls-bootstrap.ts`:
```ts
import postgres from "postgres";

/**
 * Creates a non-owner, non-superuser role that RLS constrains, enables RLS with a policy
 * that applies to that role via current_setting. The cluster owner/superuser (the real
 * runtime app) is NOT filtered — RLS is INERT for the owner by design. Idempotent.
 */
export async function bootstrapRlsCanary(adminUrl: string, appRole: string, appPassword: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(appRole)) throw new Error(`Unsafe role: ${appRole}`);
  const sql = postgres(adminUrl, { max: 1 });
  try {
    await sql.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appRole}') THEN CREATE ROLE "${appRole}" LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}'; END IF; END $$;`);
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON company_secrets TO "${appRole}"`);
    await sql.unsafe(`ALTER TABLE company_secrets ENABLE ROW LEVEL SECURITY`);
    // NOTE: no FORCE — the table owner (runtime app) is intentionally exempt; only aoa_app is filtered.
    await sql.unsafe(`DROP POLICY IF EXISTS company_secrets_tenant_isolation ON company_secrets`);
    // Policy applies TO the non-owner role only. USING gates reads; WITH CHECK gates writes.
    await sql.unsafe(`CREATE POLICY company_secrets_tenant_isolation ON company_secrets TO "${appRole}" USING (organization_id = current_setting('aoa.organization_id', true)::uuid) WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid)`);
  } finally {
    await sql.end();
  }
}
```

- [ ] **Step 3: Write the failing integration test (real seed WITH `slug`; owner exempt)**

`server/src/__tests__/rls-canary.integration.test.ts` — boot embedded-postgres like `companies-delete-integration.test.ts:59-102`; full body:
```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { applyPendingMigrations } from "@armyofagents/db";
import { bootstrapRlsCanary } from "../db/rls-bootstrap.js";

type EPI = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EPC = new (o: { databaseDir: string; user: string; password: string; port: number; persistent: boolean }) => EPI;
const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b2";
const CO_A = "00000000-0000-0000-0000-0000000000c1";
const CO_B = "00000000-0000-0000-0000-0000000000c2";
const PORT = 55000 + Math.floor(Math.random() * 1000);
let pg: EPI | null = null; let dataDir = ""; let adminUrl = ""; let err: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-rls-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EPC };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise(); await pg.start();
    adminUrl = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(adminUrl);
  } catch (e) { err = e; }
}, 180_000);
afterAll(async () => { try { if (pg) await pg.stop(); } catch {} try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch {} }, 60_000);

describe.skipIf(process.platform !== "linux")("RLS canary — company_secrets isolation (aoa_app role)", () => {
  it("non-owner role sees only its org; owner is NOT filtered; cross-tenant write blocked", async () => {
    if (err) throw new Error(String(err));
    const admin = postgres(adminUrl, { max: 1 });
    // organizations.slug is NOT NULL — include it.
    await admin.unsafe(`INSERT INTO organizations (id, name, slug) VALUES ('${ORG_A}','A','org-a'),('${ORG_B}','B','org-b')`);
    await admin.unsafe(`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES ('${CO_A}','Co A','PPA','${ORG_A}'),('${CO_B}','Co B','PPB','${ORG_B}')`);
    await admin.unsafe(`INSERT INTO company_secrets (id, company_id, organization_id, name) VALUES (gen_random_uuid(),'${CO_A}','${ORG_A}','secret-a'),(gen_random_uuid(),'${CO_B}','${ORG_B}','secret-b')`);

    await bootstrapRlsCanary(adminUrl, "aoa_app", "app_pw");

    // Owner (runtime app) is NOT filtered — sees both rows (RLS inert for owner).
    const ownerRows = await admin.unsafe<{ c: number }[]>(`SELECT count(*)::int AS c FROM company_secrets`);
    expect(Number(ownerRows[0].c)).toBe(2);
    await admin.end();

    const app = postgres(adminUrl.replace("test:test", "aoa_app:app_pw"), { max: 1 });
    // GUC unset -> zero rows for the non-owner role.
    const none = await app.unsafe<{ c: number }[]>(`SELECT count(*)::int AS c FROM company_secrets`);
    expect(Number(none[0].c)).toBe(0);
    // GUC = org A -> exactly org A.
    await app.unsafe(`SELECT set_config('aoa.organization_id','${ORG_A}', false)`);
    const a = await app.unsafe<{ organization_id: string }[]>(`SELECT organization_id FROM company_secrets`);
    expect(a.length).toBe(1); expect(a[0].organization_id).toBe(ORG_A);
    // Cross-tenant write blocked by WITH CHECK.
    await expect(app.unsafe(`INSERT INTO company_secrets (id, company_id, organization_id, name) VALUES (gen_random_uuid(),'${CO_B}','${ORG_B}','x')`)).rejects.toThrow();
    await app.end();
  }, 90_000);
});
```

- [ ] **Step 4: Run test to verify it fails, then passes**

Run (Linux): `pnpm --filter @armyofagents/server exec vitest run src/__tests__/rls-canary.integration.test.ts`
Expected: FAIL first (modules missing), PASS after Steps 1-2. Windows: `skipIf`-skipped.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/with-tenant-tx.ts server/src/db/rls-bootstrap.ts server/src/__tests__/rls-canary.integration.test.ts
git commit -m "feat(authz): flag-gated RLS canary scoped to aoa_app (owner exempt; INERT in prod)

Policy applies TO the non-owner aoa_app role only; the runtime app (owner)
is not filtered, so RLS is production-inert for the beta and app-layer is
the sole live boundary. withTenantTx sets a tx-local GUC. Proves plumbing
for the full-fleet follow-up. Seed includes organizations.slug (NOT NULL)."
```

---

## Task 12: Migration 0189 contract + backfill tests (M8)

**Files:**
- Test: `server/src/__tests__/migration-0189-contract.test.ts` (static, cross-platform)
- Test: `server/src/__tests__/migration-0189-backfill.integration.test.ts` (Linux)

- [ ] **Step 1: Write the static contract test (runs on Windows)**

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migDir = fileURLToPath(new URL("../../../packages/db/src/migrations/", import.meta.url));

describe("migration 0189 contract", () => {
  const file = readdirSync(migDir).find((f) => f.startsWith("0189_") && f.endsWith(".sql"));
  it("exists as exactly one 0189 migration", () => expect(file).toBeTruthy());
  const sqlText = file ? readFileSync(new URL(`../../../packages/db/src/migrations/${file}`, import.meta.url), "utf8") : "";
  it("adds company_secrets.organization_id as NULLABLE (no NOT NULL)", () => {
    expect(sqlText).toMatch(/ALTER TABLE "company_secrets" ADD COLUMN "organization_id" uuid;/);
    expect(sqlText).not.toMatch(/"organization_id" uuid NOT NULL/);
  });
  it("includes the backfill UPDATE from companies", () => {
    expect(sqlText).toMatch(/UPDATE "company_secrets" SET "organization_id" = c\."organization_id" FROM "companies" c/);
  });
  it("creates the operator_break_glass_grants table (single migration)", () => {
    expect(sqlText).toMatch(/CREATE TABLE (IF NOT EXISTS )?"operator_break_glass_grants"/);
  });
});
```

- [ ] **Step 2: Write the Linux backfill test (proves the UPDATE populates a NULL, not a pre-populated seed)**

`migration-0189-backfill.integration.test.ts` — boot embedded-postgres (same harness as other integration tests; `adminUrl` + `db`), then:
```ts
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
// ... same EmbeddedPostgres beforeAll/afterAll producing `db` ...

describe.skipIf(process.platform !== "linux")("0189 backfill populates organization_id from companies", () => {
  it("a company_secrets row with NULL organization_id is populated by the backfill UPDATE", async () => {
    const ORG = "00000000-0000-0000-0000-0000000000a1", CO = "00000000-0000-0000-0000-0000000000c1";
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'A', 'a')`);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'A', 'PPA', ${ORG})`);
    // Pre-0189 shape: organization_id explicitly NULL (NOT pre-populated).
    await db.execute(sql`INSERT INTO company_secrets (id, company_id, organization_id, name) VALUES (gen_random_uuid(), ${CO}, NULL, 'sec')`);
    // Re-run the migration's backfill statement (idempotent) and assert population.
    await db.execute(sql`UPDATE company_secrets SET organization_id = c.organization_id FROM companies c WHERE company_secrets.company_id = c.id AND company_secrets.organization_id IS NULL`);
    const rows = await db.execute<{ organization_id: string | null }>(sql`SELECT organization_id FROM company_secrets WHERE company_id = ${CO}`);
    const orgId = (Array.isArray(rows) ? rows[0] : (rows as any).rows[0]).organization_id;
    expect(orgId).toBe(ORG);
  }, 90_000);
});
```

- [ ] **Step 3: Run both**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/migration-0189-contract.test.ts` (Windows-visible); on Linux also the backfill test.
Expected: PASS after Task 10 produced 0189.

- [ ] **Step 4: Commit**

```bash
git add server/src/__tests__/migration-0189-contract.test.ts server/src/__tests__/migration-0189-backfill.integration.test.ts
git commit -m "test(db): 0189 static contract (nullable add + backfill) + Linux backfill population"
```

---

## Task 13: Storage tenant-scope

`companyId` is a globally-unique UUID, so `{companyId}/...` keys have no cross-tenant collision today. Add `ensureTenantScope` (defense-in-depth) + prefix new writes with the tenant segment; legacy keys keep reading via the stored `assets.object_key`.

**Files:**
- Modify: `server/src/storage/service.ts:46-70,116-129`, `server/src/storage/types.ts`
- Test: `server/src/__tests__/storage-tenant-scope.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { createStorageService } from "../storage/service.js";

function fakeProvider() {
  const store = new Map<string, Buffer>();
  return {
    id: "local_disk" as const,
    putObject: async ({ objectKey, body }: any) => { store.set(objectKey, body); },
    getObject: async ({ objectKey }: any) => ({ stream: store.get(objectKey), contentLength: 1, lastModified: new Date() }) as any,
    headObject: async () => ({ exists: true }) as any,
    deleteObject: async () => {},
  };
}

describe("storage tenant scope", () => {
  it("new writes carry the {organizationId}/{companyId}/ prefix", async () => {
    const res = await createStorageService(fakeProvider()).putFile({ organizationId: "org-1", companyId: "c1", namespace: "assets", contentType: "text/plain", originalFilename: "a.txt", body: Buffer.from("hi") });
    expect(res.objectKey.startsWith("org-1/c1/")).toBe(true);
  });
  it("getObject rejects a key from another tenant", async () => {
    await expect(createStorageService(fakeProvider()).getObject("org-1", "c1", "org-2/c1/assets/2026/01/01/x.txt")).rejects.toThrow(/tenant|organization|belong/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/storage-tenant-scope.test.ts`
Expected: FAIL — no `organizationId` param / tenant guard.

- [ ] **Step 3: Write minimal implementation**

Add `ensureTenantScope` next to `ensureCompanyPrefix` (`service.ts:46`):
```ts
function ensureTenantScope(organizationId: string, objectKey: string): void {
  if (!objectKey.startsWith(`${organizationId}/`)) throw forbidden("Object does not belong to organization");
}
```
Extend `buildObjectKey` (`service.ts:60`):
```ts
function buildObjectKey(organizationId: string, companyId: string, namespace: string, originalFilename: string | null): string {
  const ns = normalizeNamespace(namespace);
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const { stem, ext } = splitFilename(originalFilename);
  return `${organizationId}/${companyId}/${ns}/${year}/${month}/${day}/${randomUUID()}-${stem}${ext}`;
}
```
Add `organizationId` to `PutFileInput` (`storage/types.ts`) and `putFile` (`service.ts:94-96`); pass it to `buildObjectKey`. Add an `organizationId` parameter to `getObject`/`headObject`/`deleteObject` (`service.ts:116-129`); when the key has an org segment (starts with the org id), call `ensureTenantScope(organizationId, objectKey)`; keep `ensureCompanyPrefix` as the authoritative company check for legacy keys (first segment equals `companyId`). Asset-serving routes pass the request-resolved `organizationId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/storage-tenant-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/storage/service.ts server/src/storage/types.ts server/src/__tests__/storage-tenant-scope.test.ts
git commit -m "feat(storage): tenant-scoped object keys + ensureTenantScope guard"
```

---

## Task 14: Org-scoped company create + list filter (final owner of the gate)

`POST /companies` gates on `instance_admin` today (`companies.ts:146-151`). In cloud_auth it must use **Phase 2's `organizationAccessService.canOrg(orgId, userId, "company:create")`** (real org owner/admin predicate — NOT membership-only) and stamp `organizationId`. List/stats (`companies.ts:35-60`) must org-filter. Wire `invalidateCompanyTenant` into delete.

**Files:**
- Modify: `server/src/routes/companies.ts:23-33,35-60,146-160,284-294`
- Test: `server/src/__tests__/companies-org-scope.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";

const list = vi.fn(); const create = vi.fn(); const canOrg = vi.fn();
vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn() }),
  companyPortabilityService: () => ({}),
  companyService: () => ({ list, create, stats: vi.fn().mockResolvedValue({}) }),
  organizationAccessService: () => ({ canOrg }),
  logActivity: vi.fn(),
}));
vi.mock("../services/internal-agent/aoa-skills-seeder.js", () => ({ seedAoaNativeSkills: vi.fn() }));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({ ensureCommanderAgent: vi.fn() }));
vi.mock("../services/team.js", () => ({ materializeCompanyProfileFromGlobal: vi.fn() }));

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; (req as any).tenant = { organizationId: null }; next(); });
  app.use("/api/companies", companyRoutes({} as any, { deploymentMode: "cloud_auth" }));
  app.use(errorHandler);
  return app;
}

describe("companies org scope (cloud_auth)", () => {
  beforeEach(() => { vi.clearAllMocks(); setDeploymentMode("cloud_auth"); });

  it("GET /: excludes companies not in the actor's companyIds", async () => {
    list.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    const actor = { type: "board", source: "session", userId: "u", companyIds: ["c1"], organizationIds: ["org-1"], operator: true, isInstanceAdmin: false };
    const res = await request(makeApp(actor)).get("/api/companies");
    expect(res.body.map((c: any) => c.id)).toEqual(["c1"]);
  });

  it("POST /: 403 when canOrg('company:create') is false", async () => {
    canOrg.mockResolvedValue(false);
    const actor = { type: "board", source: "session", userId: "u", companyIds: [], organizationIds: ["org-1"] };
    const res = await request(makeApp(actor)).post("/api/companies").send({ name: "New Co", organizationId: "org-1" });
    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
    expect(canOrg).toHaveBeenCalledWith("org-1", "u", "company:create");
  });

  it("POST /: org-owner passes and organizationId is stamped", async () => {
    canOrg.mockResolvedValue(true);
    create.mockResolvedValue({ id: "c-new", organizationId: "org-1" });
    const actor = { type: "board", source: "session", userId: "u", companyIds: [], organizationIds: ["org-1"] };
    const res = await request(makeApp(actor)).post("/api/companies").send({ name: "New Co", organizationId: "org-1" });
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-1" }), expect.anything());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/companies-org-scope.test.ts`
Expected: FAIL — list short-circuits on isInstanceAdmin; POST gates on instance_admin, never calls `canOrg`.

- [ ] **Step 3: Write minimal implementation**

Instantiate the org access service in the factory (`companies.ts:23-27`):
```ts
import { organizationAccessService } from "../services/index.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { invalidateCompanyTenant } from "./authz-tenant.js";
// ...
const orgAccess = organizationAccessService(db);
```
List/stats (`companies.ts:35-60`) — gate the admin full-list bypass on the static self-hosted mode:
```ts
router.get("/", async (req, res) => {
  assertBoard(req);
  const result = await svc.list();
  const legacyAdmin = !tenantIsolationEnforced() && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin);
  if (legacyAdmin) { res.json(result); return; }
  const allowed = new Set(req.actor.companyIds ?? []);
  res.json(result.filter((company) => allowed.has(company.id)));
});
```
Apply the same to `/stats`. Create (`companies.ts:146-151`):
```ts
router.post("/", validate(createCompanySchema), async (req, res) => {
  assertBoard(req);
  if (!tenantIsolationEnforced()) {
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) throw forbidden("Instance admin required");
  } else {
    const orgId = req.body.organizationId as string | undefined;
    const userId = req.actor.userId;
    if (!orgId || !userId) throw forbidden("organizationId required");
    if (!(await orgAccess.canOrg(orgId, userId, "company:create"))) throw forbidden("Missing permission: company:create");
  }
  const requireBoardApprovalForNewAgents = opts.deploymentMode !== "local_trusted";
  const company = await svc.create({ ...req.body, requireBoardApprovalForNewAgents }, { requestedByUserId: req.actor.userId ?? null });
  // ... existing seeders / response (companies.ts:158+) ...
```
Delete route (`companies.ts:284-294`) — invalidate the tenant cache after a successful `svc.remove(companyId)` (minor #8):
```ts
invalidateCompanyTenant(companyId);
```
If `organizationAccessService` is not yet exported from `../services/index.js`, this task is blocked on Phase 2 — surface it, do NOT fall back to a membership-only gate.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/companies-org-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/companies.ts server/src/__tests__/companies-org-scope.test.ts
git commit -m "feat(authz): org-scope company list/create via canOrg + invalidate tenant cache on delete"
```

---

## Task 15: Cross-tenant NEGATIVE-test matrix incl. MCP inbound (B4)

Locks the leakage matrix (IDOR, agent/mcp keys, operator-denied, break-glass, **MCP cross-tenant token**). Modeled on `approvals-routes-cross-tenant.test.ts`.

**Files:**
- Test: `server/src/__tests__/tenant-isolation-matrix.test.ts`, `server/src/__tests__/mcp-cross-tenant.test.ts` (create)

- [ ] **Step 1: Write the matrix suite**

```ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { assertCompanyAccess } from "../routes/authz.js";
import { __resetTenantCache } from "../routes/authz-tenant.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

vi.mock("../services/operator-break-glass.js", () => ({ hasActiveBreakGlass: async (_db: any, u: string) => u === "op-granted" }));
const db = (org: string) => ({ select: () => ({ from: () => ({ where: () => ({ then: (r: any) => Promise.resolve([{ organizationId: org }]).then(r) }) }) }) } as any);

describe("tenant isolation matrix (cloud_auth)", () => {
  beforeEach(() => { __resetTenantCache(); setDeploymentMode("cloud_auth"); });

  it("IDOR: org-2 member cannot read an org-1 company", async () => {
    const req = { actor: { type: "board", source: "session", userId: "u", companyIds: ["c1"], organizationIds: ["org-2"] } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).rejects.toThrow(/organization/i);
  });
  it("operator-denied without a grant", async () => {
    const req = { actor: { type: "board", source: "session", userId: "op-none", companyIds: [], organizationIds: [], operator: true, isInstanceAdmin: false } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).rejects.toThrow();
  });
  it("operator-allowed WITH a live grant", async () => {
    const req = { actor: { type: "board", source: "session", userId: "op-granted", companyIds: [], organizationIds: [], operator: true, isInstanceAdmin: false } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).resolves.toBeUndefined();
  });
  it("agent key cannot cross company", async () => {
    const req = { actor: { type: "agent", source: "agent_key", companyId: "cA" } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "cB")).rejects.toThrow(/another company/i);
  });
  it("mcp key cannot cross company", async () => {
    const req = { actor: { type: "mcp", source: "mcp_key", companyId: "cA" } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "cB")).rejects.toThrow(/another company/i);
  });
});
```

- [ ] **Step 2: Write the MCP inbound cross-tenant test**

`mcp-cross-tenant.test.ts` — mount the real MCP router (match `server/src/__tests__/mcp-server.test.ts` for the `mcpRoutes` export + db stub) with a companyA-scoped mcp actor targeting a companyB path:
```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, beforeEach } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";
// import { mcpRoutes } from "../mcp/server.js"; // exact export per mcp-server.test.ts
import { errorHandler } from "../middleware/error-handler.js";

describe("MCP inbound cross-tenant (cloud_auth)", () => {
  beforeEach(() => setDeploymentMode("cloud_auth"));
  it("403s a companyA mcp key hitting a companyB MCP settings route", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "mcp", source: "mcp_key", companyId: "companyA" }; next(); });
    // app.use("/api", mcpRoutes(dbStub));
    app.use(errorHandler);
    const res = await request(app).get("/api/companies/companyB/mcp/settings");
    expect(res.status).toBe(403);
  });
});
```
(Wire the exact `mcpRoutes` export + db stub as used in `mcp-server.test.ts`. The assertion is that the async `assertCompanyAccess` in `mcp/server.ts` — now `await`ed by Task 8 — rejects the cross-company mcp key.)

- [ ] **Step 3: Run both suites**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/tenant-isolation-matrix.test.ts src/__tests__/mcp-cross-tenant.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/__tests__/tenant-isolation-matrix.test.ts server/src/__tests__/mcp-cross-tenant.test.ts
git commit -m "test(authz): cross-tenant negative matrix incl. MCP inbound (companyA token -> companyB = 403)"
```

---

## Task 16: Full-suite regression gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + lint (the no-floating-promises guard)**

Run: `pnpm typecheck && pnpm --filter @armyofagents/server lint`
Expected: PASS (a dropped `await` on `assertCompanyAccess` fails lint).

- [ ] **Step 2: Full server suite**

Run: `pnpm --filter @armyofagents/server exec vitest run`
Expected: PASS. Integration + RLS + break-glass tests `skipIf`-skip on Windows; validate on Linux CI (push).

- [ ] **Step 3: Contract-sync**

Run: `pnpm gen:tools:check`
Expected: PASS.

---

## Self-Review

**Eng-review coverage:** Delete/archive founder-gate — Task 1. **B1** single-chokepoint (auth.ts clamp + access.ts + team + rbac defense-in-depth; operator plane preserved) — Tasks 2/4/9, verified by `instance-admin-neutralized.test.ts`. **B2** fail-closed static enforcement — Tasks 2/7, verified by `assert-company-access-failclosed.test.ts`. **B3** break-glass (org-membership materialization + live-TTL check + sweeper + fixed org-wide revoke) — Task 10. **B4** codemod all `server/src` + manual MCP/service sites + `no-floating-promises` gate + MCP cross-tenant test; false "routes only" claim corrected — Tasks 8/15. **B5** single migration 0189 — Task 10. **M3** RLS scoped to `aoa_app`, owner exempt, INERT-in-prod stated, slug seed — Task 11. **M8** static + backfill migration tests — Task 12. **Minor** invalidate-on-delete — Task 14. Storage — Task 13. Create/list final owner via `canOrg` — Task 14. Negative matrix — Task 15.

**Type consistency:** `assertCompanyAccess(db, req, companyId)` async everywhere (Tasks 7/8); enforcement via `tenantIsolationEnforced()` in authz/rbac/access/companies (Tasks 2/7/9/14) — never `req.tenant`; `req.actor.operator` (operator plane) vs `isInstanceAdmin` (clamped data plane) distinct (Tasks 2/3/4); `hasActiveBreakGlass(db, userId, companyId)` signature consistent across the Task 7 hook, Task 10 impl, and Task 15 mock; `resolveCompanyTenant`/`invalidateCompanyTenant`/`__resetTenantCache` consistent (Tasks 6/7/14).

**Ordering:** Task 1 first (no P1 dep). Task 2 (deployment-mode + operator split) precedes Task 4 (clamp) and Task 7 (enforcement). Tasks 7+8 land back-to-back (typecheck red between them). Task 9 depends on Task 2's `tenantIsolationEnforced`. Task 10 must generate 0189 before Tasks 11/12 rely on `company_secrets.organization_id`.

---

## Execution Handoff

**Plan complete and saved to `docs/aoa/plans/2026-07-29-aoa-mt-phase3-authz-isolation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between. Keep Tasks 6+7+8 in one session (typecheck is intentionally red between 7 and 8).

**2. Inline Execution** — checkpoints after Tasks 1, 8, 11, 15.

**Which approach?**
