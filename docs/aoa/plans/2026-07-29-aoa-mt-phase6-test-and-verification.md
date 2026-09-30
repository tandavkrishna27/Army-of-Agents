# AoA Multi-Tenant Cloud — Phase 6: Test & Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Test-authoring tasks are TDD (write failing test → run → implement → run → commit). Manual stages are explicit numbered RUNBOOKS with exact commands, URLs, and pass/fail criteria.

**Goal:** Consolidate every test tier for the P1–P5 multi-tenant program (which lands on ONE branch, ONE PR) into a single verification plan, and CLOSE the tiers the phase plans left empty: **local e2e browser journeys, a local UI-verification pass, load/concurrency, an executed migration-on-populated-DB rollback drill, a repeatable gVisor real-execution gate, and — the headline gap — post-deploy QA on the deployed `cloud_auth` instance `https://testing.armyofagents.org` (Hetzner).** The master scope frames delivery as *"ALL phases → ONE branch → ONE PR (QA-server deploy testing)"* (`2026-07-29-aoa-multitenant-cloud-master-scope.md:4`) yet no phase doc owns that QA-server testing. This plan does.

**Architecture:** Two verification GATES.
- **Gate A — LOCAL "inside and out":** everything provable on a dev box. Unit/contract (`pnpm test:run`, cross-platform); embedded-pg integration (`applyPendingMigrations` + `describe.skipIf(process.platform !== "linux")` — real on Linux/WSL, run locally on Windows only via `AOA_E2E_FORCE_WINDOWS=1`); component/UI (Vitest + RTL, mirroring `ui/src/onboarding/steps/__tests__/OrgStep.test.tsx`); e2e browser journeys (`tests/e2e/*.spec.ts` via the local_trusted webServer config + a strict-mode config + the `POST /api/test-support/session` identity mint); a scripted browser UI-verification pass via `.claude/launch.json`; and a local load/concurrency lane. Gate A is green before the branch is pushed for merge.
- **Gate B — POST-DEPLOY QA on `testing.armyofagents.org`:** the whole system verified ON the deployed Hetzner `cloud_auth` instance — a release-smoke Playwright suite (no `webServer`; points at `AOA_RELEASE_SMOKE_BASE_URL`, exactly like `tests/release-smoke/playwright.config.ts`) plus a manual canary checklist. Gate B is the go/no-go for opening the invite-only beta. CI cannot drive a real Google account (see `tests/release-smoke/docker-auth-onboarding.spec.ts:6-8`), so Gate B is a **documented manual release gate**, not a required CI check.

**Reversibility levers drilled in this plan (all must be fired at least once, not merely shipped):** the P1 pre-migration `snapshot-gate.ts` (`instance_settings.general.migrationSnapshots += "0188"`); the P1 single-org compensating script `packages/db/src/revert-0188.ts`; the P4 resolver kill-switch `AOA_PROVIDER_RESOLVER=legacy`; the `deploymentMode` flags; and the shipped ops scripts `pnpm db:backup` / `pnpm release:rollback`.

**Tech Stack:** Vitest 3 (unit + integration), `embedded-postgres` + `@armyofagents/db` `applyPendingMigrations`/`createDb` (integration harness), React Testing Library (component), Playwright (`tests/e2e/*` local + `tests/release-smoke/*` post-deploy), GitHub Actions (`.github/workflows/pr.yml`), Docker/gVisor on Hetzner (P5 worker image). Migration head after the full program = **0192** (P1 0188, P3 0189, P4 0190, P5 0191/0192).

---

## Cross-platform honesty (read once, applies to every task)

| Tier | Windows dev | Linux CI | Notes |
|---|---|---|---|
| unit/contract | runs | runs (`verify`) | the cross-platform floor |
| `*.integration.test.ts` | SKIPPED (`skipIf`) unless `AOA_E2E_FORCE_WINDOWS=1` + local embedded-pg works | runs (real) | initdb encoding issue on GH `runneradmin` (Issue #114) |
| e2e `tests/e2e/*.spec.ts` | SKIPPED unless `AOA_E2E_FORCE_WINDOWS=1` | runs (`e2e`) | `playwright.config.ts:27-30` |
| load/concurrency (§6) | advisory local | advisory Linux lane | never a required gate |
| gVisor real-exec (§8) | n/a | advisory Linux/Hetzner | never runs in the standard suite |
| post-deploy QA (§9) | n/a | manual (not CI) | real Google → manual release gate |

**Never claim a `skipIf` integration/e2e suite "passed" from a bare Windows run — it SKIPPED.** Validate on Linux CI (push) or locally via `AOA_E2E_FORCE_WINDOWS=1`.

---

## §0 — Scope map + gate wiring (no code; orientation task)

- [ ] **Step 1: Confirm the P1–P5 test inventory this plan builds on.** These already exist per the phase plans and are the regression floor — do NOT re-author them, only ensure they run in the right lane:
  - P1: `organization-constants`, `organization-validators`, `organizations-schema`, `migration-0188-organizations-contract`, `organizations-migration-journal`, `migration-journal-contiguity`, `revert-0188-guard`, `snapshot-gate.test`; integration `organizations-backfill.integration`, `organizations-uniqueness.integration`.
  - P2: `cloud-auth-promotion-paths-inert`, `cloud-auth-no-instance-admin-minted`, `invited-joins-correct-org`, org role×capability matrix, `OrgStep.test.tsx`, `CreateOrganizationStep.test.tsx`.
  - P3: `tenant-isolation-matrix`, `mcp-cross-tenant`, `assert-company-access-failclosed`, `instance-admin-neutralized`, `migration-0189-contract`; integration `operator-break-glass.integration`, `rls-canary.integration`, `migration-0189-backfill.integration`.
  - P4: `provider-resolution-matrix`, `provider-resolution-overlay-keys`, `provider-resolution-killswitch`, `migration 0190` contract; integration `provider-connections-backfill.integration`.
  - P5: `buildDockerRunArgs`, `resolveAdapterExecutionTarget`, `chooseExecutionTargetRow`, `orgAvailableSlots`/`normalizeOrgConcurrencyCap`, `summarizeOrgSpend`, `execution-targets-service`; integration `execution-targets-heartbeat-isolation.integration`; manual `gvisor-worker-image.md` spike.
- [ ] **Step 2: Record the two gates + lever inventory** in this doc's header (done above). No code. This section is the map; §1–§10 are the work.

---

## §1 — Unit/contract consolidation (the Windows-visible floor)

No new tests. This section pins the P1–P5 pure/contract suites as the cross-platform floor picked up by `pnpm test:run` (the `verify` job, `pr.yml:387`), and names the two suites that act as **oracles** for the load lane (§6):

- **Per-Org concurrency-cap oracle:** `server/src/__tests__/*orgAvailableSlots*` / `normalizeOrgConcurrencyCap` (P5 Task 10) — the pure math the §6 concurrent-dispatch test asserts against a real DB.
- **Resolver-precedence oracle:** `server/src/__tests__/provider-resolution-matrix.test.ts` (P4 Task 15) — the precedence/leakage contract the §6 concurrent-resolve test must not violate under contention.

- [ ] **Step 1: Verify the floor is green cross-platform**

Run: `pnpm -r typecheck && pnpm test:run`
Expected: PASS on Windows AND Linux (no `*.integration.test.ts`/e2e in this command's scope; those are separate lanes). If a P1–P5 pure suite is red here, that phase regressed — fix before proceeding.

- [ ] **Step 2: No commit** (verification-only). Proceed to §2.

---

## §2 — Integration ADDITIONS (embedded-pg, Linux-real)

Two new suites the phase plans do not have. Both use the exact harness of `server/src/__tests__/companies-delete-integration.test.ts:59-102` (embedded-postgres + `applyPendingMigrations` + `createDb`) and are Linux-gated.

### Task 2.1: `mt-combined-migrations.integration.test.ts` — full chain data-integrity on populated rows

**Files:**
- Create: `server/src/__tests__/mt-combined-migrations.integration.test.ts`

> Design note (honest): `applyPendingMigrations` applies the WHOLE chain to head 0192 — the repo exposes no "migrate to 0186 then stop" seam. So this AUTOMATED suite proves the chain's backfill statements are **correct and idempotent on populated rows** and that cross-migration invariants (per-org uniqueness, tenant-column population, cross-phase FKs) hold on a populated DB. The TRUE staged "seed a pre-0188 backup → apply → assert → rollback" is the executed drill in **§7** against a real `pnpm db:backup` snapshot (staging is natural there). Together they cover migration-on-populated-DB end to end.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/mt-combined-migrations.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null; let dataDir = ""; let db: Db; let setupError: unknown = null;
const PORT = 55000 + Math.floor(Math.random() * 1000);
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as any).rows) as any[];

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mt-chain-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise(); await pg.start();
    const conn = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(conn); // whole chain -> head 0192
    db = createDb(conn);
  } catch (err) { setupError = err; console.error("[mt-combined-migrations] setup failed:", err); }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch {}
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch {}
}, 60_000);

describe.skipIf(process.platform !== "linux")("MT chain 0188->0192 on populated rows", () => {
  it("0188 seeded exactly one sentinel default organization", async () => {
    if (setupError) throw new Error(String(setupError));
    const r = rows(await db.execute(sql`SELECT id, slug FROM organizations WHERE id = ${DEFAULT_ORGANIZATION_ID}`));
    expect(r.length).toBe(1);
    expect(r[0].slug).toBe("default");
  });

  it("re-running 0188's companies backfill on a NULL-tenant row populates it, leaves set rows untouched", async () => {
    // A populated pre-migration company shape: organization_id explicitly NULL.
    await db.execute(sql`ALTER TABLE companies ALTER COLUMN organization_id DROP NOT NULL`);
    const ins = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('Legacy Co', 'LEG', NULL) RETURNING id`));
    const legacyId = ins[0].id;
    // 0188's idempotent backfill statement (verbatim WHERE-guarded UPDATE).
    await db.execute(sql`UPDATE companies SET organization_id = ${DEFAULT_ORGANIZATION_ID} WHERE organization_id IS NULL`);
    const after = rows(await db.execute(sql`SELECT organization_id FROM companies WHERE id = ${legacyId}`));
    expect(after[0].organization_id).toBe(DEFAULT_ORGANIZATION_ID);
    await db.execute(sql`ALTER TABLE companies ALTER COLUMN organization_id SET NOT NULL`);
  });

  it("0188 per-org prefix uniqueness holds; same prefix in a DIFFERENT org is allowed", async () => {
    const a = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org A', 'org-a-chain') RETURNING id`))[0].id;
    const b = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org B', 'org-b-chain') RETURNING id`))[0].id;
    await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('CA', 'DUP', ${a})`);
    await expect(db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('CB', 'DUP', ${b})`)).resolves.toBeDefined();
    await expect(db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('CA2', 'DUP', ${a})`)).rejects.toThrow();
  });

  it("0188 per-company identifier uniqueness: same identifier string in two companies is allowed", async () => {
    const org = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org D', 'org-d-chain') RETURNING id`))[0].id;
    const c1 = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('D1','DA',${org}) RETURNING id`))[0].id;
    const c2 = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('D2','DB',${org}) RETURNING id`))[0].id;
    await db.execute(sql`INSERT INTO issues (company_id, title, identifier, status) VALUES (${c1}, 'x', 'DUP-1', 'backlog')`);
    await expect(db.execute(sql`INSERT INTO issues (company_id, title, identifier, status) VALUES (${c2}, 'y', 'DUP-1', 'backlog')`)).resolves.toBeDefined();
  });

  it("0189 company_secrets backfill populates organization_id from companies (idempotent on populated rows)", async () => {
    const org = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org S', 'org-s-chain') RETURNING id`))[0].id;
    const co = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('S1','SS',${org}) RETURNING id`))[0].id;
    await db.execute(sql`INSERT INTO company_secrets (id, company_id, organization_id, name) VALUES (gen_random_uuid(), ${co}, NULL, 'sec')`);
    await db.execute(sql`UPDATE company_secrets SET organization_id = c.organization_id FROM companies c WHERE company_secrets.company_id = c.id AND company_secrets.organization_id IS NULL`);
    const sec = rows(await db.execute(sql`SELECT organization_id FROM company_secrets WHERE company_id = ${co}`));
    expect(sec[0].organization_id).toBe(org);
  });

  it("0191/0192 execution_targets FK to organizations resolves (cross-phase integrity)", async () => {
    const org = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org T', 'org-t-chain') RETURNING id`))[0].id;
    await expect(db.execute(sql`INSERT INTO execution_targets (organization_id, slug, kind, trust_class, status) VALUES (${org}, 'pool-chain', 'pooled_gvisor', 'shared_multitenant', 'offline')`)).resolves.toBeDefined();
    await expect(db.execute(sql`INSERT INTO execution_targets (organization_id, slug, kind, trust_class, status) VALUES ('00000000-0000-0000-0000-0000000000ff', 'pool-bad', 'pooled_gvisor', 'shared_multitenant', 'offline')`)).rejects.toThrow();
  });

  it("data integrity: NO company row is left with a NULL tenant column after the chain", async () => {
    const orphan = rows(await db.execute(sql`SELECT count(*)::int AS c FROM companies WHERE organization_id IS NULL`));
    expect(orphan[0].c).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails / skips honestly**

Run (Linux/WSL): `pnpm --filter @armyofagents/server exec vitest run src/__tests__/mt-combined-migrations.integration.test.ts`
Expected: FAIL before P1–P5 land (tables/columns missing); SKIPPED on Windows (0 assertions — honest). Locally on Windows use `AOA_E2E_FORCE_WINDOWS=1` only if embedded-pg boots (see MEMORY: MAX_PATH/initdb caveats).

- [ ] **Step 3: No production code** — this exercises the shipped migrations. A Linux failure is a real chain defect to fix in the owning phase's `.sql`.

- [ ] **Step 4: Run to verify it passes (Linux)** → PASS (Linux) / SKIPPED (Windows).

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/mt-combined-migrations.integration.test.ts
git commit -m "test(mt): combined 0188->0192 chain data-integrity + idempotent backfill on populated rows (linux-only)"
```

### Task 2.2: `mt-cross-tenant-service.integration.test.ts` — two real orgs, every service path, org-2 never reads org-1

**Files:**
- Create: `server/src/__tests__/mt-cross-tenant-service.integration.test.ts`

Live version of P3 Task 15's mocked matrix: seed two Organizations each with a Company + data, then drive the real service/authz layer and assert an org-2 principal cannot read org-1 across tasks, goals, memory, artifacts, storage, and provider resolution.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/mt-cross-tenant-service.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { assertCompanyAccess } from "../routes/authz.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null; let dataDir = ""; let db: Db; let setupError: unknown = null;
const PORT = 55000 + Math.floor(Math.random() * 1000);
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as any).rows) as any[];
let ORG1 = "", ORG2 = "", CO1 = "", CO2 = "", U1 = "", U2 = "";

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mt-xtenant-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise(); await pg.start();
    const conn = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(conn);
    db = createDb(conn);
    setDeploymentMode("cloud_auth"); // strict tenant path
    ORG1 = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org One', 'org-one') RETURNING id`))[0].id;
    ORG2 = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org Two', 'org-two') RETURNING id`))[0].id;
    CO1 = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('Co One','ONE',${ORG1}) RETURNING id`))[0].id;
    CO2 = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('Co Two','TWO',${ORG2}) RETURNING id`))[0].id;
    U1 = rows(await db.execute(sql`INSERT INTO "user" (id, email, name) VALUES (gen_random_uuid()::text, 'u1@x.io', 'U1') RETURNING id`))[0].id;
    U2 = rows(await db.execute(sql`INSERT INTO "user" (id, email, name) VALUES (gen_random_uuid()::text, 'u2@x.io', 'U2') RETURNING id`))[0].id;
    await db.execute(sql`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES (${ORG1}, ${U1}, 'owner', 'active')`);
    await db.execute(sql`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES (${ORG2}, ${U2}, 'owner', 'active')`);
  } catch (err) { setupError = err; console.error("[mt-cross-tenant-service] setup failed:", err); }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch {}
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch {}
}, 60_000);

const req = (userId: string, orgId: string, companyIds: string[]) =>
  ({ actor: { type: "board", source: "session", userId, companyIds, organizationIds: [orgId] } }) as any;

describe.skipIf(process.platform !== "linux")("cross-tenant service isolation (two real orgs, cloud_auth)", () => {
  it("org-1 owner CAN access their own company", async () => {
    if (setupError) throw new Error(String(setupError));
    await expect(assertCompanyAccess(db, req(U1, ORG1, [CO1]), CO1)).resolves.toBeUndefined();
  });
  it("org-2 owner CANNOT access org-1's company (tenant IDOR denied)", async () => {
    await expect(assertCompanyAccess(db, req(U2, ORG2, [CO2]), CO1)).rejects.toThrow(/organization|access/i);
  });
  it("company list is org-scoped: org-2's principal never sees CO1", async () => {
    const visible = rows(await db.execute(sql`SELECT id FROM companies WHERE organization_id = ${ORG2}`)).map((r) => r.id);
    expect(visible).toContain(CO2);
    expect(visible).not.toContain(CO1);
  });
  it("a company_secrets row is only reachable via its own org", async () => {
    await db.execute(sql`INSERT INTO company_secrets (id, company_id, organization_id, name) VALUES (gen_random_uuid(), ${CO1}, ${ORG1}, 'k')`);
    const leak = rows(await db.execute(sql`SELECT count(*)::int AS c FROM company_secrets WHERE company_id = ${CO1} AND organization_id = ${ORG2}`));
    expect(leak[0].c).toBe(0);
  });
});
```

> If the exact `assertCompanyAccess` import path or actor shape differs after P3 lands, mirror `server/src/__tests__/tenant-isolation-matrix.test.ts` (P3 Task 15) — that suite is the source of truth for the actor shape; this test only swaps its mocked db for the real embedded-pg one.

- [ ] **Step 2: Run to verify it fails/skips** → FAIL before P3's async `assertCompanyAccess` lands; SKIPPED on Windows.
- [ ] **Step 3: No production code** (validates P3 authz on real data).
- [ ] **Step 4: Run to verify it passes (Linux)** → PASS / SKIPPED.
- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/mt-cross-tenant-service.integration.test.ts
git commit -m "test(mt): two-org cross-tenant service isolation on real DB (linux-only)"
```

---

## §3 — Component/UI tests (Vitest + RTL, mirror `OrgStep.test.tsx`)

Each mirrors the existing `ui/src/onboarding/steps/__tests__/OrgStep.test.tsx` harness (RTL `render` + `@testing-library/user-event` + mocked API client). One task per surface; each is a standard TDD write-fail → implement-assertion → pass → commit. Author the failing test, run `pnpm --filter @armyofagents/ui test -- <name>`, then adjust the component only if the test reveals a real gap.

### Task 3.1: `ProvidersPage.test.tsx` — connect / assign / inherit / revoked states

**Files:**
- Create: `ui/src/pages/__tests__/ProvidersPage.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/pages/__tests__/ProvidersPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProvidersPage } from "../ProvidersPage"; // adjust to the real export
import * as api from "../../api/providers"; // adjust to the real client module

vi.mock("../../api/providers");

describe("Providers page states", () => {
  beforeEach(() => vi.resetAllMocks());

  it("shows a Connect affordance when no connection exists", async () => {
    (api.listProviderConnections as any).mockResolvedValue([]);
    render(<ProvidersPage />);
    expect(await screen.findByRole("button", { name: /connect/i })).toBeInTheDocument();
  });

  it("shows an inherited badge on a company when an org_default connection is assigned", async () => {
    (api.listProviderConnections as any).mockResolvedValue([
      { id: "c1", provider: "anthropic", scopeType: "org_default", state: "verified" },
    ]);
    render(<ProvidersPage />);
    expect(await screen.findByText(/inherited|org default/i)).toBeInTheDocument();
  });

  it("marks a revoked connection as unusable (no assign action)", async () => {
    (api.listProviderConnections as any).mockResolvedValue([
      { id: "c2", provider: "anthropic", scopeType: "company_default", state: "revoked" },
    ]);
    render(<ProvidersPage />);
    expect(await screen.findByText(/revoked/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^assign$/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails** → `pnpm --filter @armyofagents/ui test -- ProvidersPage` (import/selector mismatch until wired).
- [ ] **Step 3: Align selectors/props with the real P4 Providers page** (component exists; adjust the test to its real API OR fix a genuine state-rendering gap).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** `test(ui): Providers page connect/assign/inherit/revoked states`.

### Task 3.2: `OrgSwitcher.test.tsx`

**Files:** Create `ui/src/components/__tests__/OrgSwitcher.test.tsx`
- [ ] Assert: lists the user's orgs (multi-membership), highlights the active org, and calling the switch action invokes the context setter with the target org id. Mirror the mocked-context pattern in `OrgStep.test.tsx`. Run `pnpm --filter @armyofagents/ui test -- OrgSwitcher`. Commit `test(ui): org switcher renders memberships + switches active org`.

### Task 3.3: `AccessRequired.test.tsx`

**Files:** Create `ui/src/pages/__tests__/AccessRequired.test.tsx`
- [ ] Assert: when the company API returns 403/`access_denied`, the page renders the access-required state (heading + "request access"/"back") and NO company data. Run `pnpm --filter @armyofagents/ui test -- AccessRequired`. Commit `test(ui): access-required page renders on 403, leaks no company data`.

### Task 3.4: `OperatorConsole.test.tsx`

**Files:** Create `ui/src/pages/__tests__/OperatorConsole.test.tsx`
- [ ] Assert: an operator (`operator:true`, `isInstanceAdmin:false`) sees the metadata-scoped company list (names only, no drill-in) and a "break-glass" action; a non-operator sees neither. Run `pnpm --filter @armyofagents/ui test -- OperatorConsole`. Commit `test(ui): operator console is metadata-scoped, exposes break-glass only to operators`.

### Task 3.5: `BreakGlassCard.test.tsx`

**Files:** Create `ui/src/components/__tests__/BreakGlassCard.test.tsx`
- [ ] Assert: the request card requires a reason + TTL before submit enables; shows an active-grant countdown when a live grant exists; hides the action after expiry. Run `pnpm --filter @armyofagents/ui test -- BreakGlassCard`. Commit `test(ui): break-glass card requires reason+ttl, shows live-grant countdown`.

### Task 3.6: `EnvironmentsSection.gvisor.test.tsx`

**Files:** Create `ui/src/components/workspace/__tests__/EnvironmentsSection.gvisor.test.tsx`
- [ ] Assert: the gVisor option renders, selecting it pins the execution target (the P5 Task 12 pure mapping helper output), and the target pin appears in the submitted config. Run `pnpm --filter @armyofagents/ui test -- EnvironmentsSection`. Commit `test(ui): gVisor option pins execution target in EnvironmentsSection`.

---

## §4 — E2E browser journeys (LOCAL, Gate A)

Eight journeys as real `tests/e2e/*.spec.ts`. Mode strategy (honest):
- **Mode-independent journeys** (spine, org-switch, provider connect→assign→inherit, personal-sub target) run on the **standard local_trusted webServer** (`tests/e2e/playwright.config.ts`) with the existing helpers. They prove the org-first UX + wiring without needing strict-mode auth.
- **Strict-DENY journeys** (invited-join-correct-org, access-required, break-glass, cross-tenant negative) require a **strict-mode** instance so the P3 tenant clamp is live. They depend on **§4.0** (the hard-gated `POST /api/test-support/session` mint seam) + **§4.0b** (the strict-mode config `tests/e2e/playwright.cloud-auth.config.ts`), and mint identities via `tests/e2e/helpers/second-identity.ts`.

**Google/verify-probe mock (reuse in every spec that reaches the engine step):**
```ts
await page.route("**/internal-agent/verify", (route) =>
  route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ outcome: "verified", result: { status: "pass" } }) }));
```
(verbatim from `tests/e2e/onboarding-founder-happy-path.spec.ts:19-25`; the fake-claude fixture otherwise classifies the probe as `needs_auth`).

### Task 4.0: Hard-gated `cloud_auth` e2e session-mint seam (PREREQUISITE for 4.3/4.4/4.7/4.8)

Today `POST /api/test-support/session` (the second-identity mint used by `tests/e2e/helpers/second-identity.ts`) is mounted only in `local_trusted` + `AOA_DEV_LOCAL_IDENTITY` (`second-identity.ts:9-13`, `server/src/routes/test-support.ts`). Real Google OAuth cannot run in CI (`tests/release-smoke/docker-auth-onboarding.spec.ts:6-8`), so strict-mode (`authenticated`/`cloud_auth`) tenant-DENY journeys need a way to mint a verified better-auth session without Google. This task adds a **dedicated, hard-gated, prod-fail-closed** seam.

> **P2/P3 coordination (inline):** the auth/test-support route + `deploymentMode` (`cloud_auth`) are **P2-owned** (P2 Task 0 config-schema + Task 10 cutover). The guard below reads P2's `deploymentMode` AND the NEW dedicated flag `AOA_E2E_TEST_SUPPORT`. Land this on the P2 authz surface; P3's tenant clamp is what the minted identities then exercise. The new flag is **distinct from `AOA_DEV_LOCAL_IDENTITY`** so the local-trusted escape hatch and the strict-mode e2e mint never share a switch.

**Files:**
- Modify: `server/src/routes/test-support.ts` (mount guard reads the new flag; mint works in any mode when the flag is set)
- Create: `server/src/services/test-support-safety.ts` (pure `assertTestSupportFlagSafe` + `TestSupportFlagUnsafeError`)
- Modify: `server/src/index.ts` (call the fail-closed assertion at boot, BEFORE routes mount)
- Test: `server/src/__tests__/test-support-cloud-auth-seam.test.ts` (route mount behavior)
- Test: `server/src/__tests__/test-support-safety.test.ts` (pure boot-guard predicate)
- Test: `server/src/__tests__/test-support-flag-not-in-deploy.test.ts` (policy grep — cross-platform, the brand-check-style gate)

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/__tests__/test-support-safety.test.ts
import { describe, expect, it } from "vitest";
import { assertTestSupportFlagSafe, TestSupportFlagUnsafeError } from "../services/test-support-safety.js";

const base = {
  testSupportEnabled: true,
  deploymentExposure: "private" as const,
  bind: "loopback",
  authPublicBaseUrl: "http://127.0.0.1:3210",
  nodeEnv: "test",
};

describe("assertTestSupportFlagSafe — fail-closed prod guard", () => {
  it("allows the flag on a private loopback e2e instance", () => {
    expect(() => assertTestSupportFlagSafe(base)).not.toThrow();
  });
  it("no-ops when the flag is off (never blocks a normal boot)", () => {
    expect(() => assertTestSupportFlagSafe({ ...base, testSupportEnabled: false, deploymentExposure: "public" })).not.toThrow();
  });
  it("REFUSES on a public exposure", () => {
    expect(() => assertTestSupportFlagSafe({ ...base, deploymentExposure: "public" })).toThrow(TestSupportFlagUnsafeError);
  });
  it("REFUSES on a non-loopback bind", () => {
    expect(() => assertTestSupportFlagSafe({ ...base, bind: "0.0.0.0" })).toThrow(TestSupportFlagUnsafeError);
  });
  it("REFUSES on a public base URL", () => {
    expect(() => assertTestSupportFlagSafe({ ...base, authPublicBaseUrl: "https://testing.armyofagents.org" })).toThrow(TestSupportFlagUnsafeError);
  });
  it("REFUSES when NODE_ENV=production", () => {
    expect(() => assertTestSupportFlagSafe({ ...base, nodeEnv: "production" })).toThrow(TestSupportFlagUnsafeError);
  });
});
```

```ts
// server/src/__tests__/test-support-cloud-auth-seam.test.ts
import express from "express";
import request from "supertest";
import { describe, expect, it, afterEach } from "vitest";
import { mountTestSupportRoutes } from "../routes/test-support.js";

function appWith(env: Record<string, string | undefined>, deploymentMode: string) {
  const prev = { ...process.env };
  Object.assign(process.env, env);
  const app = express();
  app.use(express.json());
  // mountTestSupportRoutes must be a no-op (route absent -> 404) unless enabled.
  mountTestSupportRoutes(app, { deploymentMode } as any);
  return { app, restore: () => { process.env = prev; } };
}

describe("test-support session mint seam is hard-gated", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("404s in cloud_auth when AOA_E2E_TEST_SUPPORT is unset (not mounted)", async () => {
    const t = appWith({ AOA_E2E_TEST_SUPPORT: undefined, AOA_DEV_LOCAL_IDENTITY: undefined }, "cloud_auth");
    restore = t.restore;
    const res = await request(t.app).post("/api/test-support/session").send({ email: "x@y.io" });
    expect(res.status).toBe(404);
  });

  it("mounts + mints in cloud_auth when AOA_E2E_TEST_SUPPORT=1", async () => {
    const t = appWith({ AOA_E2E_TEST_SUPPORT: "1" }, "cloud_auth");
    restore = t.restore;
    const res = await request(t.app).post("/api/test-support/session").send({ email: "x@y.io", name: "X" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("userId");
    expect(res.body.cookie).toHaveProperty("name");
  });

  it("legacy path still works: local_trusted + AOA_DEV_LOCAL_IDENTITY", async () => {
    const t = appWith({ AOA_E2E_TEST_SUPPORT: undefined, AOA_DEV_LOCAL_IDENTITY: "1" }, "local_trusted");
    restore = t.restore;
    const res = await request(t.app).post("/api/test-support/session").send({ email: "x@y.io" });
    expect(res.status).toBe(200);
  });
});
```

```ts
// server/src/__tests__/test-support-flag-not-in-deploy.test.ts
// Cross-platform policy gate (brand-check style): the auth-bypass flag must
// appear ONLY in the e2e Playwright webServer config — never in any prod/deploy
// path. Runs on Windows + Linux (pure fs, no DB).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TOKEN = "AOA_E2E_TEST_SUPPORT";
// The ONLY file allowed to reference the flag (the e2e webServer env).
const ALLOWED = ["tests/e2e/playwright.cloud-auth.config.ts"];

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

describe("AOA_E2E_TEST_SUPPORT never leaks into a deploy/prod path", () => {
  // Every place a real deployment reads env from.
  const deployGlobsRoots = [
    join(REPO, ".github", "workflows"),
    join(REPO, "docs", "deploy"),
  ];
  const deployFiles = [
    ...deployGlobsRoots.flatMap((d) => walk(d)),
    ...["docker-compose.yml", "docker-compose.yaml", "docker-compose.prod.yml", "Dockerfile", ".env.example", ".env.production"]
      .map((f) => join(REPO, f))
      .filter((f) => existsSync(f)),
  ];

  it("appears in NO deploy config file", () => {
    const offenders = deployFiles.filter((f) => {
      try { return readFileSync(f, "utf8").includes(TOKEN); } catch { return false; }
    });
    expect(offenders, `AOA_E2E_TEST_SUPPORT leaked into deploy paths:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("appears ONLY in the allow-listed e2e config across the whole repo (excluding tests/docs about the flag)", () => {
    const all = walk(join(REPO, "server", "src"))
      .concat(walk(join(REPO, "cli", "src")))
      .concat(walk(join(REPO, "packages")))
      .filter((f) => /\.(ts|tsx|js|mjs|cjs|ya?ml)$/.test(f) && !/__tests__|\.test\./.test(f));
    const configHit = existsSync(join(REPO, ALLOWED[0])) && readFileSync(join(REPO, ALLOWED[0]), "utf8").includes(TOKEN);
    // The flag is READ by server code (test-support.ts + index.ts) — allowed.
    // It must be SET (assigned a value) only in the e2e config. Assert the
    // config sets it and no docker/workflow/deploy file does (covered above).
    expect(configHit, "playwright.cloud-auth.config.ts must SET AOA_E2E_TEST_SUPPORT=1").toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/test-support-safety.test.ts src/__tests__/test-support-cloud-auth-seam.test.ts src/__tests__/test-support-flag-not-in-deploy.test.ts`
Expected: FAIL — `test-support-safety.js` missing; `mountTestSupportRoutes` does not honor the new flag; the config does not yet set it.

- [ ] **Step 3: Implement**

```ts
// server/src/services/test-support-safety.ts
export interface TestSupportFlagInput {
  testSupportEnabled: boolean;
  deploymentExposure: string; // "private" | "public"
  bind: string;               // "loopback" | "0.0.0.0" | ...
  authPublicBaseUrl?: string | null;
  nodeEnv?: string;
}

export class TestSupportFlagUnsafeError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to boot: AOA_E2E_TEST_SUPPORT (an auth-bypass e2e mint seam) is set on a ` +
        `non-e2e instance (${reason}). This flag may ONLY run on a private loopback e2e ` +
        `instance. Unset AOA_E2E_TEST_SUPPORT.`,
    );
    this.name = "TestSupportFlagUnsafeError";
  }
}

const LOOPBACK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;

/** Fail-closed: throws if the e2e mint flag is set on anything resembling a real deploy. */
export function assertTestSupportFlagSafe(input: TestSupportFlagInput): void {
  if (!input.testSupportEnabled) return; // off -> never blocks a normal boot
  if (input.deploymentExposure === "public") throw new TestSupportFlagUnsafeError("deploymentExposure=public");
  if (input.bind !== "loopback") throw new TestSupportFlagUnsafeError(`bind=${input.bind} (non-loopback)`);
  const url = (input.authPublicBaseUrl ?? "").trim();
  if (url !== "" && !LOOPBACK_URL.test(url)) throw new TestSupportFlagUnsafeError(`authPublicBaseUrl=${url} (public)`);
  if ((input.nodeEnv ?? "") === "production") throw new TestSupportFlagUnsafeError("NODE_ENV=production");
}
```

```ts
// server/src/routes/test-support.ts — the mount guard.
// (1) Route factory refuses to mount unless the seam is explicitly enabled.
import { assertTestSupportFlagSafe } from "../services/test-support-safety.js";

export function testSupportEnabled(deploymentMode: string): boolean {
  // NEW dedicated flag: works in ANY mode (authenticated/cloud_auth e2e).
  if (process.env.AOA_E2E_TEST_SUPPORT === "1") return true;
  // Legacy local_trusted escape hatch (unchanged).
  return deploymentMode === "local_trusted" && process.env.AOA_DEV_LOCAL_IDENTITY === "1";
}

export function mountTestSupportRoutes(app: Express, deps: { deploymentMode: string }): void {
  if (!testSupportEnabled(deps.deploymentMode)) return; // not mounted -> 404
  // ... existing router: POST /api/test-support/session (mint verified better-auth
  //     user + session cookie), DELETE /api/test/onboarding-progress, etc.
}
```

```ts
// server/src/index.ts — BEFORE mountTestSupportRoutes / any route mount:
import { assertTestSupportFlagSafe } from "./services/test-support-safety.js";
// (2) Startup fail-closed assertion: the flag must never coexist with a real
//     public/prod instance. LOG-AND-REFUSE-TO-BOOT.
assertTestSupportFlagSafe({
  testSupportEnabled: process.env.AOA_E2E_TEST_SUPPORT === "1",
  deploymentExposure: config.deploymentExposure,
  bind: config.bind, // "loopback" for e2e
  authPublicBaseUrl: config.authPublicBaseUrl ?? null,
  nodeEnv: process.env.NODE_ENV,
});
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/test-support-safety.test.ts src/__tests__/test-support-cloud-auth-seam.test.ts src/__tests__/test-support-flag-not-in-deploy.test.ts`
Expected: PASS (the flag mounts the mint in cloud_auth; unset → 404; boot refuses on any public/non-loopback/prod signal; the token is set only in the e2e config).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/test-support.ts server/src/services/test-support-safety.ts server/src/index.ts server/src/__tests__/test-support-safety.test.ts server/src/__tests__/test-support-cloud-auth-seam.test.ts server/src/__tests__/test-support-flag-not-in-deploy.test.ts
git commit -m "feat(mt): hard-gated AOA_E2E_TEST_SUPPORT session-mint seam for strict-mode e2e (fail-closed on prod)"
```

---

### Task 4.0b: strict-mode e2e config (depends on §4.0 seam)

**Files:**
- Create: `tests/e2e/playwright.cloud-auth.config.ts`

> With §4.0 landed, the strict e2e instance boots `AOA_DEPLOYMENT_MODE: "cloud_auth"` — the TRUE target mode — and mints identities via the hard-gated `AOA_E2E_TEST_SUPPORT` seam (no Google needed). **This hard-depends on P2's "cloud_auth-test-boot" task** (P2 makes `cloud_auth` bootable under `AOA_E2E_TEST_SUPPORT=1` WITHOUT real Google client id/secret). **`authenticated` mode is NOT a valid proxy for the isolation journeys:** the `isInstanceAdmin` data-plane clamp (P3 Task 4) and the enforced tenant gate are **`cloud_auth`-gated**, so under `authenticated` the clamp/gate would be off, isolation would not be enforced, and the cross-tenant-negative assertion (§4.8) would be meaningless. Only real `cloud_auth` exercises the live boundary. Real Google signup remains verified in §9 (Gate B) only. The seam's boot guard (§4.0) keeps this safe: it refuses to run on any public/non-loopback instance.

- [ ] **Step 1: Author the config** (mirror `tests/e2e/playwright.authenticated.config.ts` exactly; change only the testMatch + the mint flag):

```ts
// tests/e2e/playwright.cloud-auth.config.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.AOA_CLOUD_E2E_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PORT = Number(process.env.AOA_CLOUD_E2E_DB_PORT ?? PORT + 52_000);
const AOA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-cloud-e2e-home-"));

export default defineConfig({
  testDir: ".",
  // Only the strict-DENY journeys run here; the rest use playwright.config.ts.
  testMatch: "**/mt-{invited-join,access-required,break-glass,cross-tenant-negative}.spec.ts",
  timeout: 90_000,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: BASE_URL, headless: true, screenshot: "only-on-failure", trace: "on-first-retry" },
  projects: [{ name: "cloud-auth-chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "corepack pnpm@9.15.4 aoa onboard --yes --run",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 150_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      AOA_HOME,
      AOA_INSTANCE_ID: "playwright-cloud-e2e",
      AOA_BIND: "loopback",
      // TRUE target mode: the isInstanceAdmin clamp (P3 Task 4) + enforced tenant
      // gate are cloud_auth-gated, so isolation is only LIVE here. `authenticated`
      // is NOT a valid proxy for §4.3/4.4/4.7/4.8. HARD-DEPENDS on P2's
      // "cloud_auth-test-boot" (boots cloud_auth under AOA_E2E_TEST_SUPPORT=1
      // WITHOUT real Google client id/secret). Real Google signup = §9 (Gate B).
      AOA_DEPLOYMENT_MODE: "cloud_auth",
      AOA_DEPLOYMENT_EXPOSURE: "private",
      AOA_ALLOWED_HOSTNAMES: "127.0.0.1,localhost",
      AOA_AUTH_BASE_URL_MODE: "explicit",
      AOA_AUTH_PUBLIC_BASE_URL: BASE_URL,
      BETTER_AUTH_SECRET: "cloud-auth-e2e-secret-32-bytes-minimum-xx",
      // Hard-gated e2e mint seam (§4.0). DISTINCT from AOA_DEV_LOCAL_IDENTITY:
      // mounts POST /api/test-support/session in this strict-mode instance so
      // second-identity.ts can mint verified sessions without Google. The §4.0
      // boot guard refuses to start this flag on any public/non-loopback
      // instance, so it is safe only here (private loopback e2e).
      AOA_E2E_TEST_SUPPORT: "1",
      AOA_EMBEDDED_POSTGRES_PORT: String(DB_PORT),
      AOA_EMBEDDED_POSTGRES_STRICT_PORT: "1",
      AOA_VITE_HMR_PORT: String(PORT + 10_000),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    },
  },
  outputDir: "./test-results/cloud-auth",
  reporter: [["list"]],
});
```

- [ ] **Step 2: Add scripts** to root `package.json`:
```jsonc
"test:e2e:cloud": "playwright test --config=tests/e2e/playwright.cloud-auth.config.ts",
```
- [ ] **Step 3: Commit** `test(e2e): strict-mode e2e config driven by the §4.0 hard-gated mint seam`.

### Task 4.1: `mt-spine.spec.ts` — signup → Org → Company → agent → run

**Files:** Create `tests/e2e/mt-spine.spec.ts`
- [ ] **Step 1: Write the spec** (local_trusted config; base on `onboarding-founder-happy-path.spec.ts`):

```ts
import { test, expect } from "@playwright/test";
import { freshOnboardingState, fillFounderProfileStep } from "./helpers/onboarding-e2e";

test.beforeEach(async ({ request }) => { await freshOnboardingState(request); });

test("founder: signup -> create Organization -> Company -> agent -> run", async ({ page, request }) => {
  await page.route("**/internal-agent/verify", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ outcome: "verified", result: { status: "pass" } }) }));
  await page.goto("/onboarding");
  await fillFounderProfileStep(page, "E2E Founder");
  await page.getByRole("button", { name: /continue/i }).click();

  // NEW Create-Organization step (P2 Task 3) precedes the company step.
  await expect(page.getByRole("heading", { name: /create your organization|your organization/i })).toBeVisible({ timeout: 20_000 });
  const orgName = `E2E-Org-${Date.now()}`;
  await page.getByRole("textbox").first().fill(orgName);
  await page.getByRole("button", { name: /continue/i }).click();

  // Company step (renamed copy, P2 Task 3).
  await expect(page.getByRole("heading", { name: /your company|create your company/i })).toBeVisible({ timeout: 20_000 });
  const coName = `E2E-Co-${Date.now()}`;
  await page.getByRole("textbox").first().fill(coName);
  await page.getByRole("button", { name: /continue/i }).click();

  // Environment + engine (Claude fake fixture) — mirror the happy-path spec.
  await expect(page.getByRole("heading", { name: /set up your environment/i })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /verify & continue/i }).click();
  await expect(page.getByRole("heading", { name: /bring your engine online/i })).toBeVisible();
  await page.getByText("Claude", { exact: true }).click();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByRole("button", { name: /^verify$/i }).click();

  // Assert org + company persisted and tenant-linked via the API.
  const cos = await (await request.get("/api/companies")).json();
  const co = (cos as Array<{ id: string; name: string; organizationId?: string }>).find((c) => c.name === coName);
  expect(co).toBeTruthy();
  expect(co!.organizationId, "company must be tenant-linked to the new org").toBeTruthy();
});
```
- [ ] **Step 2: Run** `AOA_E2E_FORCE_WINDOWS=1 pnpm test:e2e -- mt-spine` (Windows local) / `pnpm test:e2e mt-spine` (Linux). Expected FAIL until P1/P2 UI lands, then PASS.
- [ ] **Step 3–5:** align to real headings if the P2 copy differs; commit `test(e2e): signup->org->company->agent spine`.

### Task 4.2: `mt-org-switch.spec.ts`
**Files:** Create `tests/e2e/mt-org-switch.spec.ts`
- [ ] Create two orgs for one identity (via API seed + UI), open the org switcher, switch, assert the company list + URL prefix change to the second org's scope and the first org's companies vanish. Commit `test(e2e): org/workspace switching re-scopes the app`.

### Task 4.3: `mt-invited-join.spec.ts` (strict config — depends on §4.0 seam + §4.0b)
**Files:** Create `tests/e2e/mt-invited-join.spec.ts`
- [ ] Founder (identity A) creates Org+Company; mint identity B via `newIdentityContext(browser, request, { email })`; B accepts the invite; assert B lands in the SAME org (browser form of P2 Task 11 `invited-joins-correct-org`). Run `pnpm test:e2e:cloud -- mt-invited-join`. Commit `test(e2e): invited user joins the correct org`.

### Task 4.4: `mt-access-required.spec.ts` (strict config — depends on §4.0 seam + §4.0b)
**Files:** Create `tests/e2e/mt-access-required.spec.ts`
- [ ] Identity A owns Org-1/Co-1; mint identity B (Org-2). B navigates to Co-1's URL; assert the access-required page renders (heading present) and NO Co-1 task/name is visible. Run `pnpm test:e2e:cloud -- mt-access-required`. Commit `test(e2e): foreign-company URL shows access-required, no data`.

### Task 4.5: `mt-provider-inherit.spec.ts`
**Files:** Create `tests/e2e/mt-provider-inherit.spec.ts`
- [ ] Connect a provider at Org scope in the UI; assign as org_default; create a second company; assert the second company shows the inherited provider (no per-company key) and a Commander/crew dispatch resolves it (assert via run metadata or the resolver's env presence). Commit `test(e2e): provider connect->assign->inherit across companies`.

### Task 4.6: `mt-personal-sub-target.spec.ts`
**Files:** Create `tests/e2e/mt-personal-sub-target.spec.ts`
- [ ] Owner configures a personal_subscription connection pinned to an execution target; assert an owner-initiated run routes to that target, and a non-owner crew run does NOT inherit it (falls back / denied per P4 fail-closed). Commit `test(e2e): personal-subscription routes to its dedicated target, owner-only`.

### Task 4.7: `mt-break-glass.spec.ts` (strict config — depends on §4.0 seam + §4.0b)
**Files:** Create `tests/e2e/mt-break-glass.spec.ts`
- [ ] Operator identity with no grant is denied a foreign company; grant break-glass (reason+TTL) via the operator console; assert access now works; expire the grant (API fast-forward like P3 Task 10) + assert denied again. Run `pnpm test:e2e:cloud -- mt-break-glass`. Commit `test(e2e): break-glass grant enables then expiry denies`.

### Task 4.8: `mt-cross-tenant-negative.spec.ts` (strict config — depends on §4.0 seam + §4.0b)
**Files:** Create `tests/e2e/mt-cross-tenant-negative.spec.ts`
- [ ] Mint identities in two orgs; from org-2's browser context assert every cross read is denied: open org-1 company (403 page), `request.get('/api/companies/<co1>/issues')` → 403, org-1 company absent from `/api/companies`, org-1 memory/artifacts endpoints 403. This is the browser-level IDOR/list-leak sweep. Run `pnpm test:e2e:cloud -- mt-cross-tenant-negative`. Commit `test(e2e): cross-tenant negative sweep (IDOR + list-leak) in a real browser`.

---

## §5 — LOCAL UI-verification RUNBOOK (Gate A, "inside and out")

Scripted human/browser pass on a locally-booted `authenticated`-mode (strict) instance. Not CI. Purpose: the "does it actually render + work + not leak" check the automated tiers can't fully assert.

1. **Boot a strict local instance.** From the repo root, use `.claude/launch.json`'s `server` config (sets `AOA_MIGRATION_AUTO_APPLY=true`) but override the mode:
   `cd server && set AOA_MIGRATION_AUTO_APPLY=true && set AOA_DEPLOYMENT_MODE=authenticated && set AOA_DEV_LOCAL_IDENTITY=1 && set PORT=3100 && pnpm exec tsx src/index.ts`
   PASS: server logs "listening on :3100"; `GET http://127.0.0.1:3100/api/health` returns `{"deploymentMode":"authenticated"}`.
2. **Migration head.** `GET /api/health` (or logs) shows the applied head = **0192**. PASS: 0192; FAIL: any pending migration or head < 0192.
3. **Open the app** at `http://127.0.0.1:3100` via `/browse` (or the browser preview). Complete onboarding: create Org → Company → agent. PASS: each new surface renders without a blank/error state.
4. **Org switcher renders + works.** Create a 2nd org; open the switcher; switch. PASS: company list + URL prefix change; no console errors (`read_console_messages` shows zero `error`).
5. **Providers page.** Connect a provider at org scope; assign; open a 2nd company. PASS: 2nd company shows the inherited provider badge; no key re-entry prompt.
6. **Access-required.** In a second browser context (mint via `POST /api/test-support/session`) as a non-member, open the first company's URL. PASS: access-required page; NO company data in the DOM (`get_page_text` contains no Co-1 task titles).
7. **Operator console.** As an operator, confirm the company list is metadata-only (names, no drill-in) and the break-glass action is present. PASS: no cross-tenant drill-in without a grant.
8. **No-console-error sweep.** On every surface visited, `read_console_messages` returns zero `error`-level entries and `read_network_requests` shows no cross-tenant `200` (a foreign company id in a URL must be `403`, never `200`). PASS: clean.
9. **Record evidence.** Save a short note (surfaces visited + pass/fail per step) to the PR description. FAIL on any step blocks the push for merge.

---

## §6 — Load / concurrency (advisory lane)

Proves the per-Org cap holds under contention (the P5 Task 10 math is only a unit oracle today) and the resolver is correct under concurrent dispatch. Embedded-pg, Linux-gated, advisory (never a required gate).

### Task 6.1: `mt-org-cap-concurrency.integration.test.ts`

**Files:** Create `server/src/__tests__/mt-org-cap-concurrency.integration.test.ts`

- [ ] **Step 1: Write the failing test** (same embedded-pg beforeAll as §2; body):

```ts
describe.skipIf(process.platform !== "linux")("per-org concurrency cap under N>cap concurrent dispatch", () => {
  it("with concurrency_cap=2, firing 8 simultaneous dispatches admits exactly 2, queues/rejects 6", async () => {
    if (setupError) throw new Error(String(setupError));
    const org = rows(await db.execute(sql`INSERT INTO organizations (name, slug, concurrency_cap) VALUES ('Cap Org','cap-org',2) RETURNING id`))[0].id;
    const co = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('Cap Co','CAP',${org}) RETURNING id`))[0].id;
    // Fire N concurrent admission checks against the same org (import the real
    // P5 admission fn, e.g. tryAcquireOrgSlot(db, org) or the heartbeat gate).
    const results = await Promise.all(
      Array.from({ length: 8 }, () => tryAcquireOrgSlot(db, org, co)),
    );
    const admitted = results.filter((r) => r.admitted).length;
    expect(admitted).toBe(2);        // cap enforced under contention, no over-admit
    expect(results.length - admitted).toBe(6);
  }, 90_000);

  it("noisy-neighbor: Org-A saturating its cap does NOT reduce Org-B's available slots", async () => {
    const a = rows(await db.execute(sql`INSERT INTO organizations (name, slug, concurrency_cap) VALUES ('A','nn-a',1) RETURNING id`))[0].id;
    const b = rows(await db.execute(sql`INSERT INTO organizations (name, slug, concurrency_cap) VALUES ('B','nn-b',1) RETURNING id`))[0].id;
    await tryAcquireOrgSlot(db, a); // saturate A
    const bSlot = await tryAcquireOrgSlot(db, b);
    expect(bSlot.admitted).toBe(true); // B unaffected
  });
});
```
> Replace `tryAcquireOrgSlot` with the actual P5 admission entry point (the fn behind `orgAvailableSlots`); do not invent a second one. If admission is DB-transactional (`SELECT ... FOR UPDATE`), `Promise.all` against the same embedded-pg pool exercises the real race.

- [ ] **Step 2–4:** run `pnpm --filter @armyofagents/server exec vitest run src/__tests__/mt-org-cap-concurrency.integration.test.ts` (Linux). A failure = a real over-admit / cross-org bleed to fix in the P5 gate.
- [ ] **Step 5: Commit** `test(load): per-org cap holds under concurrent dispatch + noisy-neighbor (linux, advisory)`.

### Task 6.2: `mt-resolver-concurrency.test.ts`
**Files:** Create `server/src/__tests__/mt-resolver-concurrency.test.ts` (mock-DB, cross-platform)
- [ ] Fire 50 concurrent `resolveProviderCredential` calls across mixed scopes (org/company/agent) and assert every result still satisfies the P4 precedence contract (no wrong-scope win, no cross-tenant leak, fail-closed on the multi-tenant no-assignment case). Reuse the deps factory from `provider-resolution-matrix.test.ts`. Commit `test(resolver): precedence + fail-closed hold under 50x concurrency`.

---

## §7 — Migration-on-populated-DB + ROLLBACK DRILL (executed runbook)

The TRUE staged drill: a real populated DB, migrate the whole chain, then FIRE every reversibility lever and assert restoration. Manual (uses `pnpm db:backup` / `pnpm release:rollback` + `tsx`). Run against a throwaway local Postgres, then repeated on the QA server in §9.4.

**Preconditions:** a local Postgres (or embedded) with `DATABASE_URL` set; the branch checked out at a commit BEFORE the chain (or a DB already at head 0186).

1. **Snapshot the pre-chain DB.** `pnpm db:backup` → note the snapshot path. PASS: backup file exists and is non-empty.
2. **Seed populated pre-0188 data.** Insert ≥3 companies + issues + company_secrets under the (pre-org) schema (or restore a real pre-chain dump). PASS: `SELECT count(*) FROM companies` ≥ 3.
3. **Apply the full chain.** `pnpm db:migrate`. PASS: exit 0; journal head = **0192**; `SELECT count(*) FROM organizations` ≥ 1 (default org backfilled); `SELECT count(*) FROM companies WHERE organization_id IS NULL` = 0.
4. **Assert data integrity.** No row lost (company/issue counts unchanged from step 2); `company_secrets.organization_id` populated for every row; per-org prefix + per-company identifier indexes present (`\d companies` shows `companies_org_issue_prefix_idx`). PASS: all hold.
5. **Snapshot-gate proof (cloud_auth).** With `AOA_DEPLOYMENT_MODE=cloud_auth` and NO `migrationSnapshots` marker on a populated DB, boot the server. PASS: it REFUSES with `SnapshotGateError` (P1 Task 18). Then set `instance_settings.general.migrationSnapshots += "0188"` and reboot → boots. FAIL: it applied 0188 without the marker.
6. **Fire lever — resolver kill-switch.** Set `AOA_PROVIDER_RESOLVER=legacy`, restart, dispatch a run. PASS: run resolves credentials via the legacy ladder (P4 Task 16); unset → new model resumes. No redeploy needed.
7. **Fire lever — deploymentMode flip.** Flip `cloud_auth`→`authenticated`→`local_trusted` across reboots. PASS: each mode boots; self-hosted single-tenant behavior intact (companies still reachable).
8. **Fire lever — single-org compensating revert.** While STILL single-org (exactly one Organization), run `DATABASE_URL=... pnpm exec tsx packages/db/src/revert-0188.ts`. PASS: script completes; global `companies_issue_prefix_idx` + `issues_identifier_idx` restored; org tables dropped; the 0188 journal row removed. Verify `SELECT count(*) FROM organizations` errors (table gone).
9. **Prove the one-way door.** Re-apply the chain, then insert a SECOND Organization. Re-run `revert-0188.ts`. PASS: it REFUSES (`expected exactly 1 organization, found 2`) — the guard blocks; rollback is now snapshot-restore-only.
10. **Fire lever — snapshot restore.** `pnpm release:rollback` (or restore the step-1 backup). PASS: DB returns to the pre-chain state; app boots at head 0186.
11. **Record the drill.** Write a dated result block into `docs/aoa/guides/mt-rollback-drill.md` (create) listing each lever fired + pass/fail. Commit `docs(mt): executed migration + rollback drill results`.

---

## §8 — gVisor real-execution gate (repeatable; Linux/Hetzner, advisory)

Promotes P5 Task 0's one-time spike into a re-runnable checklist that gates any worker-image change. References the P5-generated `docs/aoa/guides/gvisor-worker-image.md`. Run on a Hetzner worker (or any Linux box with docker + runsc).

1. **runsc present.** `docker info | grep -A3 Runtimes` lists `runsc`. PASS: present without KVM/nested-virt (checkpoint A).
2. **Pinned CLIs run under runsc.** `docker run --rm --runtime=runsc aoa/agent-base:latest claude --version` prints `2.1.x`; `... codex --version` prints `0.145.x`. PASS: neither dies on an unimplemented syscall (checkpoint B).
3. **Hardened one-shot.** Run the full flag set from P5 Task 0 Step 3 (`--user 1000:1000 --cap-drop=ALL --security-opt no-new-privileges --read-only --tmpfs ... --network none`). PASS: prints `write-ok`; memory/pids limits don't starve Node (checkpoint C).
4. **Egress firewall live-proof (checkpoint D — the security gate).** On the FILTERED `bridge` (DOCKER-USER deny rules applied), inside a real run: `claude -p "say hi"` SUCCEEDS (provider egress allowed) AND `curl -sS --max-time 3 http://169.254.169.254/` times out/refused (metadata DENIED) AND `curl` to an RFC1918 addr + the control-plane CIDR are refused. PASS: metadata + RFC1918 + control-plane unreachable while provider API reachable. **FAIL = a cloud pool on `bridge` is unshippable.**
5. **Record.** Append the run date + runsc version + pass/fail per checkpoint to `docs/aoa/guides/gvisor-worker-image.md`. This gate is advisory in CI (a Linux lane) but a HARD manual precondition for any pool-on-bridge deploy.

---

## §9 — POST-DEPLOY QA on `testing.armyofagents.org` (Gate B — the headline)

Verifies the WHOLE system on the deployed `cloud_auth` Hetzner instance. Two parts: (a) a scripted release-smoke Playwright suite, (b) a manual canary checklist. Real Google signup cannot run in CI (`docker-auth-onboarding.spec.ts:6-8`), so Gate B is a **documented manual release gate** — the go/no-go for opening the beta.

### Task 9.1: release-smoke specs pointed at the deployed instance

**Files:**
- Create: `tests/release-smoke/mt-cloud-auth-smoke.spec.ts`
- Create: `tests/release-smoke/mt-two-org-isolation.spec.ts`

Both run via the existing `tests/release-smoke/playwright.config.ts` (NO `webServer`; `baseURL = AOA_RELEASE_SMOKE_BASE_URL`). Invoke with:
```bash
AOA_RELEASE_SMOKE_BASE_URL=https://testing.armyofagents.org pnpm test:release-smoke -- mt-
```

- [ ] **Step 1: Write `mt-cloud-auth-smoke.spec.ts`** (health + mode + head; the parts that need no Google):

```ts
import { expect, test } from "@playwright/test";

test.describe("MT post-deploy smoke (testing.armyofagents.org)", () => {
  test("health reports cloud_auth and migration head 0192", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.deploymentMode).toBe("cloud_auth");            // Gate B mode
    // Head is surfaced by the health/migrations endpoint post-P1..P5.
    expect(String(body.migrationHead ?? body.migrations?.head ?? "")).toContain("0192");
  });

  test("unauthenticated MCP/company reads are rejected (cloud_auth is not open)", async ({ request }) => {
    const res = await request.get("/api/companies");
    expect([401, 403]).toContain(res.status());   // cloud_auth rejects unauth'd
  });
});
```
- [ ] **Step 2: Write `mt-two-org-isolation.spec.ts`** — drives two pre-provisioned QA accounts (org-A owner, org-B owner) via API keys/session cookies supplied by env (`AOA_QA_ORG_A_COOKIE`, `AOA_QA_ORG_B_COOKIE`), asserts org-B cannot read any org-A company/task/memory/artifact/secret (all 403), and org-A's company is absent from org-B's `/api/companies`. No Google needed at runtime (sessions pre-minted by the human operator in step (b)).
- [ ] **Step 3: Run against the deployed instance** (after deploy):
  `AOA_RELEASE_SMOKE_BASE_URL=https://testing.armyofagents.org AOA_QA_ORG_A_COOKIE=... AOA_QA_ORG_B_COOKIE=... pnpm test:release-smoke -- mt-`
  Expected: PASS.
- [ ] **Step 4: Commit** `test(release-smoke): cloud_auth health + two-org isolation on the QA server`.

### Task 9.2: manual post-deploy checklist (run once per QA deploy)

Against `https://testing.armyofagents.org` in a real browser (real Google account). PASS/FAIL each; ALL must pass to open the beta:

1. **Migration applied cleanly.** `GET /api/health` → `deploymentMode:"cloud_auth"`, head contains `0192`, no pending. PASS/FAIL.
2. **Snapshot gate honored.** Deploy logs show the snapshot marker was recorded before 0188 applied (no `SnapshotGateError`). PASS/FAIL.
3. **Real signup → org → company → agent → run.** Sign in with a real Google account, create an Org, create a Company, create an agent, dispatch a task, run COMPLETES. PASS/FAIL.
4. **Two-real-org isolation.** With a second real Google account in a second Org, confirm neither account can see/open the other's company (browser + a direct foreign-company URL → access-required). PASS/FAIL.
5. **Provider inheritance live.** Connect a provider once at Org scope; a real Commander turn AND a real crew run both resolve it with no per-company key. PASS/FAIL.
6. **gVisor executes on the box.** A dispatched software run actually runs under `runsc` on the worker (confirm via run metadata / worker logs). PASS/FAIL.
7. **Egress firewall live-proof from a real run.** From inside a real agent run, metadata (`169.254.169.254`) + RFC1918 + control-plane are unreachable while the provider API is reachable. PASS/FAIL.
8. **Kill-switch / rollback on the box.** Set `AOA_PROVIDER_RESOLVER=legacy` on the instance, confirm runs still resolve; then unset. Confirm the documented `release:rollback` path is available. PASS/FAIL.

### Task 9.3: manual CANARY checklist (post-first-deploy watch window)

Mirror the `/canary` cadence + the `docs/aoa/guides/remote-cli-auth.md` post-deploy precedent. Watch for the first N hours:
1. **Error rate** within baseline (no 5xx spike after cutover). PASS/FAIL.
2. **No cross-tenant `200`s in logs** — grep the access log for any foreign-company id returning `200`; every cross-tenant attempt must be `403`. PASS/FAIL.
3. **Per-Org cap counters** show the cap being enforced (no org exceeds its `concurrency_cap`). PASS/FAIL.
4. **No metadata-endpoint hits from agent egress** — worker egress logs show zero successful `169.254.169.254`/RFC1918 connections. PASS/FAIL.
5. **Break-glass audit rows present** — every operator access has a matching `operator_break_glass_grants` + audit row; no operator data-plane access without a live grant. PASS/FAIL.
6. **Spend rollup sane** — the org spend rollup (P5 Task 11) reports non-negative, per-org-attributed costs. PASS/FAIL.

- [ ] **Step (doc): Record Gate B results** in `docs/aoa/guides/mt-post-deploy-qa.md` (create) with the dated checklist + smoke output. Commit `docs(mt): post-deploy QA + canary results for testing.armyofagents.org`.

### Task 9.4: repeat the §7 rollback drill on the QA server

- [ ] Before opening the beta, execute §7 steps 1–10 against the QA instance's DB (using `pnpm db:backup` on the box) to prove the levers work on real infra, not just locally. Record in `mt-post-deploy-qa.md`. This is the last go/no-go.

---

## §10 — CI wiring + beta exit criteria

### Task 10.1: wire the new lanes into `pr.yml`

**Files:** Modify `.github/workflows/pr.yml`

- [ ] **Required (feed `ci-required`, `pr.yml:696`):**
  - `verify` (`pnpm test:run`) — already includes the new §1 floor + §2/§6 suites' cross-platform units.
  - `migrations` — add a **populated-DB variant** step: after the existing scratch apply, seed a few companies/issues on the postgres:16 service THEN re-run the chain's backfill assertions (or run `mt-combined-migrations.integration.test.ts` against the CI Postgres via `DATABASE_URL`). Keeps the PR #94-style chain check AND adds populated coverage.
  - `e2e` (Linux) — the mode-independent §4 journeys (4.1/4.2/4.5/4.6) land in `tests/e2e/*.spec.ts` and run here automatically (local_trusted config). The strict-DENY journeys (4.3/4.4/4.7/4.8) are CI-gated via `pnpm test:e2e:cloud` (the §4.0b config) **only after §4.0 (the hard-gated `AOA_E2E_TEST_SUPPORT` mint seam) has landed** — add that step to the `e2e` job in the same commit as §4.0, not before.
  - `policy` (`pr.yml:75`) — the §4.0 leak gate `test-support-flag-not-in-deploy.test.ts` is cross-platform and runs inside `verify`; ALSO add its intent to `brand-check`/`policy` (a grep asserting `AOA_E2E_TEST_SUPPORT` never appears in `docker-compose*.yml`, `.github/workflows/*`, `docs/deploy/*`, or release/env templates) so an auth-bypass flag can never reach a deploy path even if the vitest suite is skipped.
  - `e2e-pgvector` — unchanged (still covers the vector write/retrieval path).
- [ ] **Advisory (non-required, do NOT feed `ci-required`):**
  - a Linux `load` lane running `mt-org-cap-concurrency.integration.test.ts` (§6).
  - a Linux/Hetzner `gvisor` lane (§8) — advisory only; `gVisor EXECUTION is never a required gate` (P5 test-strategy summary).
- [ ] **Do NOT** make any individual job a required check or add a `paths-ignore` trigger (CLAUDE.md CI rules) — route everything through `ci-required`.
- [ ] **Commit** `ci(mt): wire populated-DB migration variant + strict e2e + advisory load/gvisor lanes`.

### Beta EXIT CRITERIA (Gate A ∧ Gate B)

**Gate A (must be green before push-for-merge):**
- `pnpm -r typecheck && pnpm test:run` PASS (Windows + Linux).
- Linux CI `verify` + `migrations`(+populated) + `e2e`(+§4 journeys) + `e2e-pgvector` GREEN via `ci-required`.
- §2 integration suites PASS on Linux (`mt-combined-migrations`, `mt-cross-tenant-service`).
- §3 component suites PASS.
- §5 local UI-verification runbook: every step PASS, recorded in the PR.
- §6 load lane: cap holds under N>cap, no noisy-neighbor bleed (advisory but must be green before beta).
- §7 rollback drill executed locally, every lever fired, one-way-door guard proven.

**Gate B (must be green before opening the invite-only beta):**
- §9.1 release-smoke specs PASS against `https://testing.armyofagents.org`.
- §9.2 manual checklist: all 8 PASS (real signup→run, two-real-org isolation, provider inherit, gVisor on box, egress live-proof, kill-switch).
- §8 gVisor checkpoint D (egress firewall) PASS on the worker image.
- §9.3 canary: all 6 clean over the watch window.
- §9.4 rollback drill repeated on the QA server.

**CI-can't-drive-Google note (record in the PR + release checklist):** the real Google OAuth signup path cannot run in CI — the same limitation `tests/release-smoke/docker-auth-onboarding.spec.ts:6-8` documents ("CI cannot automate a real Google account"). Therefore §9 (Gate B) is a **manual release gate**, not a `ci-required` check. The Linux `e2e` lane mocks the verify probe and uses the `POST /api/test-support/session` mint seam for multi-user coverage; true `cloud_auth` + Google is proven only on the deployed QA server.

---

## Self-Review

- **Pyramid coverage:** unit floor (§1) ✓; integration additions — combined-chain-on-populated + two-org service isolation (§2) ✓; component/UI — Providers/org-switcher/access-required/operator/break-glass/gVisor (§3) ✓; 8 e2e journeys + strict-mode config (§4) ✓; local UI-verification runbook (§5) ✓; load/concurrency for the per-org cap + resolver (§6) ✓; executed migration-on-populated-DB + rollback drill firing every lever + one-way-door proof (§7) ✓; repeatable gVisor real-exec gate incl. egress live-proof (§8) ✓; post-deploy QA on testing.armyofagents.org — smoke suite + manual checklist + canary + QA-server rollback (§9) ✓; CI wiring + exit criteria (§10) ✓.
- **Grounded in real patterns:** embedded-pg harness (`companies-delete-integration.test.ts` + `applyPendingMigrations`/`createDb`), `describe.skipIf(process.platform!=="linux")`, `playwright.config.ts` (+`AOA_E2E_FORCE_WINDOWS`), `playwright.authenticated.config.ts` (strict mode), `onboarding-founder-happy-path.spec.ts` + `helpers/onboarding-e2e.ts` + `helpers/second-identity.ts` (mint seam), `tests/release-smoke/playwright.config.ts` + `AOA_RELEASE_SMOKE_BASE_URL` (post-deploy model), `pr.yml` (verify/e2e/migrations/e2e-pgvector/ci-required), `.claude/launch.json`, and the shipped scripts (`test:run`, `test:e2e`, `test:release-smoke`, `db:backup`, `release:rollback`, `db:migrate`).
- **Windows/Linux honesty:** integration + e2e are Linux-real / Windows-skip (or `AOA_E2E_FORCE_WINDOWS=1` local); load/gVisor/post-deploy never gate merge.
- **Resolved dependency (now a built prerequisite):** strict-mode local e2e (§4.3/4.4/4.7/4.8) is unblocked by **§4.0 — the hard-gated `AOA_E2E_TEST_SUPPORT` session-mint seam** (route-mount guard + fail-closed boot assertion + policy leak-gate). Those journeys are CI-gated only after §4.0 lands (§10). They run in **TRUE `cloud_auth`** (§4.0b) — the `isInstanceAdmin` clamp + enforced tenant gate are `cloud_auth`-gated, so `authenticated` is NOT a valid proxy for the isolation assertions — which **hard-depends on P2's "cloud_auth-test-boot" task**; real Google signup remains Gate-B-only. The seam is auth-bypass, so its prod-safety is triple-guarded: (1) route refuses to mount unless `AOA_E2E_TEST_SUPPORT==="1"`; (2) startup refuses to boot the flag on any public/non-loopback/prod instance; (3) a cross-platform policy test asserts the flag never appears in any deploy/CI/docker/docs-deploy path — only in `tests/e2e/playwright.cloud-auth.config.ts`.
