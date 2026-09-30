# Whole-PR Re-Review Fix Batch 3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remediate the 4 findings both reviewers converged on for HEAD `f00e13fb` (branch `claude/multitenant-cloud`, worktree `C:/Users/TK/.aoa/wt/mt-cloud`, PR #316): the P1 WS role re-elevation, the getByIdentifier scoping regression, the migration-exception doc contradiction, and the break-glass claims gap.

**Architecture:** Four independent, file-disjoint changes. #1 and #2 are runtime; #3 and #4 are docs + one code comment. No schema change, no migration. Deployment-mode discipline: #1 changes ONLY cloud_auth behavior; #2 preserves self-hosted/loopback/admin via an all-access sentinel. Self-hosted `local_trusted`/`authenticated` runtime behavior must otherwise stay byte-identical.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM, vitest. Server test command (server has NO `test` script): from the worktree root run `pnpm test:run <pattern>`. Typecheck: `pnpm -r typecheck`.

---

## Findings → Task map

| # | Finding | Severity / origin | Task |
|---|---------|-------------------|------|
| 1 | WS `resolveBoardRole` elevates `instance_admin`→`founder` in cloud_auth (over-shares private threads + non-owned hub items over `/events/ws`) | P1 merge-blocker; pre-existing (`264750fc7`) | Task 1 |
| 2 | `getByIdentifier` global `LIMIT 2`+409 counts inaccessible tenants → spurious 409 + collision-existence leak for legit single-org users | P2; regression from `540c713f` (last batch) | Task 2 |
| 3 | `AGENTS.md` migration exception contradicts `CLAUDE.md:21`, `CLAUDE.md:345`, and Decision #19 (`decisions.md:43`) which still say "never" | P2 docs | Task 3 |
| 4 | Break-glass grant/revoke are inert (only `sweepExpired` wired) but docs describe it as delivered; `grant()` non-transactional + WS ignores the grant (both LATENT) | P2 claims-gap; pre-existing | Task 4 |

---

## File Structure

- `server/src/realtime/live-events-ws.ts` (`resolveBoardRole` closure ~:340-352; callers `mayReceiveThreadEvent` :372, `mayReceiveHubEvent` :391) — Task 1. **This file is git-flagged BINARY** (pre-existing NUL byte) — read it directly to verify edits; don't trust git diff.
- `server/src/__tests__/` — Task 1 pure-helper unit test (new small file or added to `upgrade-auth.test.ts` which already imports this module).
- `server/src/services/issues.ts` (`getByIdentifier` ~:1220-1241) + `server/src/routes/authz.ts` (new `accessibleCompanyIdsForActor` helper beside `assertCompanyAccess`) + the 4 bare-route call sites (`routes/issue-param-normalizer.ts:27`, `routes/issues.ts:765`/`:775`, `routes/agents.ts:2130`/`:2148`, `routes/activity.ts:74`) — Task 2.
- `server/src/__tests__/issue-identifier-company-scope.integration.test.ts` (+ a small unit test for the actor helper) — Task 2 tests.
- `CLAUDE.md` (:21, :345), `docs/architecture/decisions.md` (:43, Decision #19), `AGENTS.md` (:87 — already has the exception; keep consistent) — Task 3.
- `server/src/services/operator-break-glass.ts` (`grant()` ~:92-123) + `docs/aoa/plans/2026-07-29-aoa-multitenant-cloud-master-scope.md` (D8 ~:24) + `docs/aoa/plans/2026-07-29-aoa-mt-phase3-authz-isolation.md` (~:5, :37) — Task 4.

---

### Task 1: Clamp WS `instance_admin`→`founder` elevation in cloud_auth

**Root cause:** `resolveBoardRole` (a private closure in `live-events-ws.ts:340-352`) returns `"founder"` for any `instance_user_roles` row with role `instance_admin` in EVERY non-local mode. REST clamps this in cloud via `req.actor.isInstanceAdmin` (`middleware/auth.ts`: `isInstanceAdmin: cloud ? false : isOperator`), so REST readers fall through to `perms.getEffectiveRole` (which reads only `user_roles`, never `instance_user_roles`). The WS fan-out is the ONE place that re-reads the raw `instance_user_roles` table, so the clamp never applies — a cloud operator who is really a `team_member` receives private/unclaimed thread events + non-owned hub items. Fix: in cloud_auth, skip the elevation and use the real per-company role. `authenticated` keeps the elevation (parity with REST there); `local_trusted` unchanged.

**Files:**
- Modify: `server/src/realtime/live-events-ws.ts` (`resolveBoardRole`)
- Test: `server/src/__tests__/live-events-board-role.test.ts` (new) OR add to `upgrade-auth.test.ts`

- [ ] **Step 1: Write the failing test for a pure, exported decision helper**

To make the closure testable without a DB, extract the mode×admin decision into a pure exported helper. Write the test first (new file `server/src/__tests__/live-events-board-role.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { resolveBoardRoleForMode } from "../realtime/live-events-ws.js";

describe("resolveBoardRoleForMode (WS board-role clamp)", () => {
  it("local_trusted → founder (no queries needed)", () => {
    expect(resolveBoardRoleForMode("local_trusted", true, "team_member")).toBe("founder");
    expect(resolveBoardRoleForMode("local_trusted", false, "team_member")).toBe("founder");
  });
  it("authenticated + instance_admin → founder (parity with REST there)", () => {
    expect(resolveBoardRoleForMode("authenticated", true, "team_member")).toBe("founder");
  });
  it("authenticated without instance_admin → the real per-company role", () => {
    expect(resolveBoardRoleForMode("authenticated", false, "team_lead")).toBe("team_lead");
  });
  it("cloud_auth + instance_admin + real team_member → team_member (NOT founder) — the fix", () => {
    expect(resolveBoardRoleForMode("cloud_auth", true, "team_member")).toBe("team_member");
  });
  it("cloud_auth + instance_admin + real founder → founder (real role honored)", () => {
    expect(resolveBoardRoleForMode("cloud_auth", true, "founder")).toBe("founder");
  });
});
```

- [ ] **Step 2: Run — verify it FAILS (helper doesn't exist yet)**

Run: `pnpm test:run live-events-board-role`
Expected: fail to import `resolveBoardRoleForMode`.

- [ ] **Step 3: Implement the helper + rewire the closure**

In `live-events-ws.ts`, add an exported pure helper (place it near the top-level, outside `setupLiveEventsWebSocketServer`):

```ts
/**
 * WS board-role decision. Mirrors the REST data-plane clamp in
 * middleware/auth.ts (`isInstanceAdmin: cloud ? false : isOperator`): an
 * `instance_admin` is a founder for tenant fan-out ONLY in local_trusted and
 * authenticated — in cloud_auth the real per-company role is used, so an
 * operator who is only a team_member does not receive private/unclaimed threads
 * or non-owned hub items over the event bus.
 */
export function resolveBoardRoleForMode(
  mode: DeploymentMode,
  hasInstanceAdminRow: boolean,
  effectiveRole: "founder" | "team_lead" | "team_member",
): "founder" | "team_lead" | "team_member" {
  if (mode === "local_trusted") return "founder";
  if (mode !== "cloud_auth" && hasInstanceAdminRow) return "founder";
  return effectiveRole;
}
```

Rewire the `resolveBoardRole` closure so it (a) does NOT query `instance_user_roles` in cloud_auth (perf: the elevation is clamped anyway), (b) does NOT eagerly call `getEffectiveRole` in the authenticated-admin short-circuit (preserve current per-event query cost), and (c) delegates the decision to the helper:

```ts
  async function resolveBoardRole(
    actorId: string,
    companyId: string,
  ): Promise<"founder" | "team_lead" | "team_member"> {
    if (opts.deploymentMode === "local_trusted") return "founder";
    // Only consult instance_user_roles where it can elevate (non-cloud). In
    // cloud_auth the elevation is clamped off, so skip the query.
    if (opts.deploymentMode !== "cloud_auth") {
      const adminRow = await db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, actorId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null);
      if (adminRow) return resolveBoardRoleForMode(opts.deploymentMode, true, "team_member");
    }
    const effectiveRole = await perms.getEffectiveRole(companyId, actorId);
    return resolveBoardRoleForMode(opts.deploymentMode, false, effectiveRole);
  }
```

(The `hasInstanceAdminRow=true` branch passes a throwaway `"team_member"` effectiveRole because the helper returns `"founder"` before reading it in non-cloud; keeping the query out of the cloud path and the getEffectiveRole call out of the authenticated-admin path preserves the exact per-event query cost of the original.) Confirm `DeploymentMode` is imported (it is — used in `setupLiveEventsWebSocketServer` opts).

- [ ] **Step 4: Run — verify PASS**

Run: `pnpm test:run live-events-board-role`
Expected: all 5 pass. Then run the WS/RBAC neighbors for no regression: `pnpm test:run upgrade-auth` and `pnpm test:run "hub-items-live-events|thread-event"`.

- [ ] **Step 5: Verify the source by READING `live-events-ws.ts` (binary — not via git diff), then commit**

```bash
git add server/src/realtime/live-events-ws.ts server/src/__tests__/live-events-board-role.test.ts
git commit -m "fix(realtime): clamp instance_admin->founder WS elevation in cloud_auth (data-plane parity)"
```

---

### Task 2: Scope `getByIdentifier` ambiguity to the actor's accessible companies

**Root cause:** `getByIdentifier` (`issues.ts:1220-1241`, from `540c713f`) runs a global `LIMIT 2` + throws 409 BEFORE caller authorization. Identifiers are only company-unique, so an inaccessible tenant owning the same `ACM-1` turns a legit single-org user's bare route into a 409 and leaks that a collision exists. Fix: resolve/count ambiguity only among the companies the actor can access. The accessible set MUST be derived from the actor (mirroring `assertCompanyAccess`), NOT read from one field: agent/mcp actors have a single `companyId`; self-hosted loopback (`source:"local_implicit"`) and self-hosted `isInstanceAdmin` board actors are ALL-ACCESS and must stay unfiltered (else single-tenant + admin-bypass break).

**Files:**
- Modify: `server/src/services/issues.ts` (`getByIdentifier`)
- Modify: `server/src/routes/authz.ts` (new exported `accessibleCompanyIdsForActor`)
- Modify: `server/src/routes/issue-param-normalizer.ts`, `server/src/routes/issues.ts`, `server/src/routes/agents.ts`, `server/src/routes/activity.ts` (thread the accessible set at the 4 bare-route call sites)
- Test: `server/src/__tests__/issue-identifier-company-scope.integration.test.ts` + a small unit test for the helper

- [ ] **Step 1: Add the actor helper + its unit test (RED first)**

First READ `server/src/middleware/auth.ts` (actor construction: session ~:138, board_key ~:238, local_implicit ~:86, `resolveActorCompanyIds` ~:35-59) and `server/src/routes/authz.ts` `assertCompanyAccess` (~:36-84) to confirm the exact `req.actor` shape (`type`, `source`, `companyId`, `companyIds`, `isInstanceAdmin`) and the all-access rules.

Write a unit test (new `server/src/__tests__/accessible-company-ids-for-actor.test.ts`) asserting the derivation:
- agent actor `{type:"agent", companyId:"c1"}` → `["c1"]`
- mcp actor `{type:"mcp", companyId:"c1"}` → `["c1"]`
- board self-hosted loopback `{type:"board", source:"local_implicit"}` → `undefined` (all-access sentinel)
- board self-hosted instance-admin (`!tenantIsolationEnforced()` + `isInstanceAdmin:true`) → `undefined`
- board cloud `{type:"board", companyIds:["c1","c2"], isInstanceAdmin:false}` → `["c1","c2"]`
- board cloud with `companyIds` undefined → `[]`
- `none`/no actor → `[]`

> `tenantIsolationEnforced()` is a global singleton (`config/deployment-mode.ts`). Set it via `setDeploymentMode(...)` per-case and reset in `afterEach`. Match the real actor field names discovered in the read above; do not invent fields.

Then implement `accessibleCompanyIdsForActor` in `authz.ts` (exported), returning `string[] | undefined`. **The actor type is the GLOBAL AMBIENT `Actor`** (declared in `server/src/types/express.d.ts` — script-scope `.d.ts`, so `Actor` is global; do NOT import it, and do NOT use `RequestActor`, which does not exist):
```ts
// undefined = all-access (self-hosted loopback / self-hosted instance-admin);
// [] = access nothing. Mirrors assertCompanyAccess's allow rules so bare-route
// identifier resolution is scoped to what the actor can reach.
// NOTE: this intentionally does NOT mirror assertCompanyAccess's cloud
// break-glass branch (authz.ts ~:73-80). A cloud operator with an active
// break-glass grant hitting a BARE identifier route for a non-member company
// resolves to []→null→404 (fail-closed) rather than the task. That is
// acceptable and unreachable today (break-glass grant/revoke are inert — see
// Task 4); if governed break-glass endpoints ever ship, revisit this helper.
export function accessibleCompanyIdsForActor(actor: Actor | undefined): string[] | undefined {
  if (!actor) return [];
  if (actor.type === "agent" || actor.type === "mcp") return actor.companyId ? [actor.companyId] : [];
  if (actor.type === "board") {
    if (actor.source === "local_implicit") return undefined;
    if (!tenantIsolationEnforced() && actor.isInstanceAdmin) return undefined;
    return actor.companyIds ?? [];
  }
  return [];
}
```
(Confirm the exact `Actor` field names against `server/src/types/express.d.ts` in the read above. Import `tenantIsolationEnforced` from `../config/deployment-mode.js` if not already present in `authz.ts`.)

- [ ] **Step 2: Run the helper unit test — PASS**

Run: `pnpm test:run accessible-company-ids-for-actor`

- [ ] **Step 3: Scope `getByIdentifier` (integration RED first)**

In `issue-identifier-company-scope.integration.test.ts` (guard `describe.skipIf(process.platform !== "linux")`; flip to `skipIf(false)` locally to run, REVERT before commit), the harness seeds raw orgs+companies+issues (no memberships) and calls the service directly. Convert/extend the existing dual-`ACM-1` test to cover the scoped param:
```ts
it("getByIdentifier scoped to one accessible company resolves that row (no 409, no leak)", async () => {
  if (setupError) throw new Error(String(setupError));
  expect((await svc.getByIdentifier("ACM-1", [companyAId]))?.id).toBe(issueAId);
  expect((await svc.getByIdentifier("ACM-1", [companyBId]))?.id).toBe(issueBId);
});
it("getByIdentifier throws 409 only when the actor can access BOTH colliding rows", async () => {
  await expect(svc.getByIdentifier("ACM-1", [companyAId, companyBId])).rejects.toMatchObject({ status: 409 });
});
it("getByIdentifier returns null when the actor can access none of the colliding rows", async () => {
  expect(await svc.getByIdentifier("ACM-1", [])).toBeNull();
});
it("getByIdentifier with the all-access sentinel (undefined) keeps global reject-ambiguous", async () => {
  await expect(svc.getByIdentifier("ACM-1")).rejects.toMatchObject({ status: 409 });
});
```
Also add a single-tenant preservation case: seed an identifier that exists in only ONE company (e.g. `ACM-2` in company A) and assert `svc.getByIdentifier("ACM-2")` (undefined) resolves it (proves self-hosted unqualified resolve still works).

- [ ] **Step 4: Implement the scoped `getByIdentifier`**

```ts
    getByIdentifier: async (identifier: string, accessibleCompanyIds?: string[]) => {
      // undefined = all-access sentinel (self-hosted loopback / instance-admin):
      //   keep the global unfiltered reject-ambiguous resolve.
      // [] = actor can access nothing → null (404). Never pass [] to inArray.
      if (accessibleCompanyIds && accessibleCompanyIds.length === 0) return null;
      const upper = identifier.toUpperCase();
      const where = accessibleCompanyIds
        ? and(eq(issues.identifier, upper), inArray(issues.companyId, accessibleCompanyIds))
        : eq(issues.identifier, upper);
      const rows = await db.select().from(issues).where(where).limit(2);
      if (rows.length > 1) {
        throw conflict(
          "Ambiguous task identifier — it exists in more than one company you can access. Use a company-scoped route or the task UUID.",
        );
      }
      const row = rows[0] ?? null;
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },
```
Confirm `and`, `inArray`, `conflict`, `eq` are all imported in `issues.ts` (they are — `getByIdentifierInCompany` uses `and`; `inArray`/`conflict` confirmed by prior investigation). Update the doc comment above `getByIdentifier` to describe the actor-scoped ambiguity behavior.

- [ ] **Step 5: Thread the accessible set at the bare-route call sites**

The `getByIdentifier(` calls at `issue-param-normalizer.ts:27` and `issues.ts:765` are inside req-LESS helper functions (`normalizeIssueParam`/`normalizeIssueIdentifier`). The `req`-bearing closures are the `router.param` callbacks: `issue-param-normalizer.ts:53`, `issues.ts:775` (`"id"`) and `:788` (`"issueId"`). Add a parameter to the helper so the callback can thread `accessibleCompanyIdsForActor(req.actor)` down to `getByIdentifier`:

- `routes/issue-param-normalizer.ts` — add an accessible-set param to `normalizeIssueParam`; compute `accessibleCompanyIdsForActor(req.actor)` in the `router.param` callback (~:53) and pass it through. **IMPORTANT FAN-OUT:** `registerIssueParamNormalizer` is shared by 5 route files — `artifacts.ts`, `feedback.ts`, `output-detection.ts`, `task-outputs.ts`, `dependencies.ts` — so fixing the normalizer ONCE covers all of them (do not edit those 5 individually; verify by grep that they go through the shared normalizer).
- `routes/issues.ts` — add the param to `normalizeIssueIdentifier`; compute + pass the set from the `router.param("id")` (~:775) and `router.param("issueId")` (~:788) callbacks.
- `routes/agents.ts:2130` and `:2148` — inside `router.get(... async (req,res) => …)`; `req` is directly in scope; pass `accessibleCompanyIdsForActor(req.actor)` as the 2nd arg.
- `routes/activity.ts:74` — inside `router.param("id", (req,res,next,rawId) => …)`; `req` in scope; pass it.

Read each call site first and match its exact resolve path. Import `accessibleCompanyIdsForActor` from `authz.js` (or the correct relative path) in each file that computes it.

- [ ] **Step 6: Run tests + typecheck; REVERT the skipIf flip**

Run: `pnpm test:run issue-identifier-company-scope` and `pnpm test:run accessible-company-ids-for-actor`, then `pnpm -r typecheck`.
Revert the integration `skipIf` to EXACTLY `describe.skipIf(process.platform !== "linux")`. Confirm via `git diff` that no `skipIf(false)` remains.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/issues.ts server/src/routes/authz.ts server/src/routes/issue-param-normalizer.ts server/src/routes/issues.ts server/src/routes/agents.ts server/src/routes/activity.ts server/src/__tests__/issue-identifier-company-scope.integration.test.ts server/src/__tests__/accessible-company-ids-for-actor.test.ts
git commit -m "fix(issues): scope bare-identifier ambiguity to the actor's accessible companies (no cross-tenant 409/leak)"
```

---

### Task 3: Synchronize the migration-exception across all authoritative docs

**Root cause:** `AGENTS.md:87` now documents a narrow hand-appended-migration exception, but `CLAUDE.md:21`, `CLAUDE.md:345`, and Decision #19 (`decisions.md:43`, a table row `| 19 | Drizzle only, no raw SQL | ... |`) still state it unconditionally. The user has approved editing CLAUDE.md. Make all four consistent and describe the actual 0195 workflow.

**Files:**
- Modify: `CLAUDE.md` (:21 Rule #1, :345 schema section)
- Modify: `docs/architecture/decisions.md` (:43 Decision #19 row)
- (verify `AGENTS.md:87` wording matches — adjust only if needed for consistency)

- [ ] **Step 1: CLAUDE.md Rule #1 (:21)**

Append the narrow exception to the rule, e.g.: "Schema DDL is always `db:generate` output (no-drift enforced). **Narrow exception:** drizzle-kit cannot emit (a) idempotency guards (`IF NOT EXISTS` / `DO $$ … duplicate_object`, per C14) or (b) data-only backfills; a few migrations (e.g. `0189`, `0195`) hand-APPEND these after generation, always with an inline comment and always idempotent (`WHERE … IS NULL` / `ON CONFLICT DO NOTHING`). Never hand-author schema DDL."

- [ ] **Step 2: CLAUDE.md schema section (:345)**

Update "Schema changes use Drizzle ORM only — never raw SQL." to carry the same narrow-exception qualifier (one sentence, cross-referencing the rule / C14).

- [ ] **Step 3: Decision #19 (`decisions.md:43`)**

The row is `| 19 | Drizzle only, no raw SQL | Matches Paperclip patterns. \`pnpm db:generate\` for all migrations. |`. Extend the rationale cell to note the narrow exception: "…`pnpm db:generate` for all schema DDL. Narrow exception (C14): idempotency guards + data-only backfills may be hand-appended post-generation (e.g. 0189/0195), always idempotent; schema DDL is never hand-authored." Keep it a single table row.

- [ ] **Step 4: Describe the actual 0195 workflow**

In the `AGENTS.md:87` exception (or a one-line adjacent note), state the actual workflow used for 0195: generate the schema DDL via `pnpm db:generate`, then hand-append the C14 idempotency guards on the constraint swap + the data backfills (`UPDATE`/`INSERT … ON CONFLICT DO NOTHING`). Ensure the four sources tell the same story.

- [ ] **Step 5: Verify + commit**

Run: `git diff CLAUDE.md docs/architecture/decisions.md AGENTS.md` — only the exception clauses; no unrelated edits.
```bash
git add CLAUDE.md docs/architecture/decisions.md AGENTS.md
git commit -m "docs: synchronize the hand-appended-migration exception across CLAUDE.md, Decision #19, and AGENTS.md"
```

---

### Task 4: Mark break-glass grant/revoke as deferred/inert with accurate claims

**Root cause:** The break-glass service exposes `{grant, revoke, sweepExpired}`, but production wires ONLY `sweepExpired` (`index.ts` boot sweeper) + the REST read `hasActiveBreakGlass` (`authz.ts`). There is no grant/revoke route/CLI/tool, so no running server can create a grant row → the non-transactional `grant()` and the WS-ignores-grant gaps are LATENT. But the plan docs describe break-glass as a delivered "time-boxed, audited operator break-glass" with no caveat. Fix (in-scope): accurate claims + a defensive comment; do NOT build endpoints.

**Files:**
- Modify: `server/src/services/operator-break-glass.ts` (`grant()` / factory ~:92-123)
- Modify: `docs/aoa/plans/2026-07-29-aoa-multitenant-cloud-master-scope.md` (D8 ~:24)
- Modify: `docs/aoa/plans/2026-07-29-aoa-mt-phase3-authz-isolation.md` (~:5 goal, ~:37 service listing)

- [ ] **Step 1: Defensive comment on `grant()`**

Add a comment at the `operatorBreakGlassService` factory / `grant()` stating: `grant`/`revoke` have NO production trigger today (only `sweepExpired` runs, from `index.ts`; REST honors `hasActiveBreakGlass`), so the row-creation path is unreachable through a running server. `grant()` is intentionally non-transactional and safe ONLY because nothing reaches it — **if a grant/revoke endpoint is ever added**, it MUST wrap the grant insert + `materializeMembership` + `audit` in a single `db.transaction`, REST + both cookie-auth WS upgrade paths must share one access decision (or break-glass must also materialize the COMPANY membership the WS branches require, or those branches must call `hasActiveBreakGlass`).

- [ ] **Step 2: Accurate claims in the two plan docs**

- `2026-07-29-aoa-multitenant-cloud-master-scope.md` D8 (~:24): append a caveat that break-glass is **library + live-TTL check + sweeper wired; grant/revoke have no runtime trigger yet (no route/CLI/MCP tool) and cannot be invoked through a running server — operator-console wiring deferred.** NOTE: D8 is a TABLE ROW — keep the caveat inside the rationale cell (or an adjacent bullet), NOT a multi-line block that would break the markdown table.
- `2026-07-29-aoa-mt-phase3-authz-isolation.md` (~:5 goal, ~:37 service listing): annotate that only `sweepExpired` + `hasActiveBreakGlass` are on a live path; `grant`/`revoke` are library-only pending an operator trigger.

- [ ] **Step 3: Verify + commit**

Run: `git diff server/src/services/operator-break-glass.ts docs/aoa/plans/2026-07-29-*.md`
No behavior change — comment + doc caveats only.
```bash
git add server/src/services/operator-break-glass.ts docs/aoa/plans/2026-07-29-aoa-multitenant-cloud-master-scope.md docs/aoa/plans/2026-07-29-aoa-mt-phase3-authz-isolation.md
git commit -m "docs: mark break-glass grant/revoke deferred/inert + defensive non-transactional note"
```

---

## Post-batch verification (controller)

- [ ] Full server + ui unit suite: `pnpm test:run > /tmp/mt-suite3.log 2>&1; echo EXIT=$?` — **capture the real exit code (do NOT pipe through tail/tee, which masks vitest's exit).** Confirm the only reds (if any) are the known Windows parallel flakes (`execute-env-scrub-fu23`, discussions-routes contract) by re-running them in isolation.
- [ ] `pnpm -r typecheck` (exit 0)
- [ ] `node scripts/check-forbidden-tokens.mjs` (no new AOA_* env)
- [ ] `pnpm db:generate` → `git status` shows no new migration
- [ ] Confirm `live-events-ws.ts` change by READING the file (binary)
- [ ] Confirm `issue-identifier-company-scope.integration.test.ts` `skipIf` back to `process.platform !== "linux"`
- [ ] Final holistic cross-cutting review over the whole batch diff
- [ ] Push; PR comment + `@codex review`; tell the user to run their own review

## Out of scope (deferred, tracked)

- Company-qualified `/companies/:companyId/issues/:id` route (the URL-namespace redesign) — the eventual clean fix for #2; option (a) closes the regression in-place.
- Governed break-glass grant/revoke endpoints (feature build) — #4 only makes claims accurate + adds the defensive note.
- Moving migration backfills into boot reconcilers — the strict alternative to Task 3's documented exception.
