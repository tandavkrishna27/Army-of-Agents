# Multi-Tenant Journey Correctness Fixes — Design Spec

**Date:** 2026-07-31
**Branch:** `claude/multitenant-cloud` (same branch as the multi-tenant backend P1–P5 and the sibling `2026-07-31-tenant-access-required-polish-design.md`; keeps the one-branch / one-PR model for QA-server deploy testing).
**Status:** approved design, pre-implementation-plan.

## Context

The multi-tenant backend (P1–P5) is complete and Linux-CI-validated (PR #316, `ci-required` green). A journey audit (25 agents) and a follow-up code-grounded investigation (read-only, adversarially verified against the worktree) confirmed that **the happy path works and tenant isolation is sound**, but that several realistic, everyday user actions each break a step of the core journey (Google signup → create org → land in org → create company → add users). This spec covers the correctness fixes for those breaks, plus two cheap scalability/robustness hardenings, and a real multi-user test.

Terminology note (grounded): **`cloud_auth` IS the multi-tenant mode** — there is no separate `multi_tenant` enum value. `tenantIsolationEnforced()` returns true iff `deploymentMode === "cloud_auth"` (`server/src/config/deployment-mode.ts:12-14`). Every behavior below is the `cloud_auth` branch specifically; the self-hosted (`!enforced`) branch is preserved unchanged and called out only where it diverges.

## What the investigation confirmed

- **Happy path is green on rails**, but brittle: it only holds if the founder never reloads mid-onboarding and never gets cross-invited.
- **The company access boundary is correct.** In the A↔B mutual-invite scenario, after cross-inviting, A can open B's *invited* company but NOT B's other company (403). Cross-org membership alone does not open sibling companies — per-company membership is still required (`server/src/routes/authz.ts:71,78`).
- **Four reachable breaks / gaps** (details in each fix below):
  1. Direct "Add member" in cloud locks the added user out entirely (writes company membership, not org membership).
  2. A founder in ≥2 orgs hard-403s when creating another company (no org id sent, server refuses to guess).
  3. A browser reload mid-onboarding mints a duplicate orphan organization; and an org-owner with zero companies is stranded on an empty Lobby with no route back into company creation.
  4. Lobby stats + company-list run instance-wide table scans, then filter in JS (scalability shape).
- **The safe ghost-org fix is client durability, NOT a server "one org per user" rule** — several existing users legitimately already own more than one org (via `ensureRealOperator` and the `0188` default-org backfill), so an owner-only server dedup would return the *wrong* org and break tests.

## Locked product decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| P1 | Multi-org "create another company" | **Auto-pick the user's own (create-capable) org; no picker.** Friendly message if ever 0 or ≥2 create-capable orgs. | Matches "one org per customer" — in the beta a founder normally owns exactly one org. Avoids building a picker for a case that shouldn't occur (YAGNI). |
| P2 | Direct "Add member" | **Invite-only in cloud_auth; one-click direct-add preserved in self-hosted.** | Enterprise-grade: consent + single audited admission chokepoint + SSO/SCIM/quota-ready. Fixes the lockout by *removing* the broken cloud path, not patching it. Self-hosted has no tenant boundary and isn't broken there. |
| P3 | Can a user own >1 org? | **Yes.** | It is the multi-tenant thesis; several users already do. Implies **no** server owner-dedup on `POST /organizations` — the ghost-org fix must be client durability. |
| P4 | Onboarding Organization step | **Keep the explicit named step; make it reload-durable.** | The org is the billing/account identity and deserves a deliberate name; auto-naming trades a step for weaker account hygiene. |
| P5 | Cross-org membership from a company invite | **Accept as-is.** | Access still requires *both* org and company membership, so it is contained. The only downstream cost (create-company friction) is resolved by Fix 2. |
| P6 | Scope of this initiative | **Core fixes 1–3 + scalability push-downs (Fix 4) + org-create transaction hardening (Fix 5).** Import-path org placement → separate follow-up. | Cheap, low-risk extras included; the import-path fix needs its own org-selection UI. |

## The fixes

### Fix 1 — Add-member: invite-only in cloud (removes the lockout)

**Problem.** The Team page "Add member" direct-add path writes only a company membership (`server/src/services/team.ts:737`) and never an org membership. In cloud_auth, `assertCompanyAccess` requires **both** (`server/src/routes/authz.ts:71`), so a directly-added teammate 403s on every request — fully locked out. The invite path (`approveHumanJoinRequestTx`, `server/src/services/join-approval.ts:210,217-219`) correctly writes both memberships.

**Approach (P2 = invite-only in cloud).**
- **Server:** `team.addMember` rejects the direct-add path when `tenantIsolationEnforced()` (cloud_auth), returning an actionable error ("use an invite in cloud"). Self-hosted path unchanged.
- **UI:** the Team → Add Member surface offers **invite mode only** in cloud_auth (hide/disable the direct-add mode); self-hosted keeps both modes. The invite path already grants access correctly and handles already-registered users (verify the verified-email auto-admit behavior for an existing user during implementation — `server/src/routes/onboarding-join.ts:212`).
- **Consolidation benefit:** this collapses cloud human-admission onto the single audited `approveHumanJoinRequestTx` chokepoint, which is the prerequisite the audit flagged for future seat quotas / SSO / SCIM.

**Side effects / risks.** In cloud, founders add an existing teammate via an invite rather than one click (acceptable/desired for enterprise). Confirm the invite UI + role selection reach parity with what direct-add offered. No change to self-hosted.

**Effort:** S (server guard + UI mode gate).

**Tests.** Integration (embedded PG, cloud_auth): direct-add is rejected in cloud; the invite path admits a user who then passes `assertCompanyAccess` and whose rebuilt actor includes the company's org id. Self-hosted: direct-add still works and grants access.

### Fix 2 — Multi-org create-company (the 403 dead-end)

**Problem.** For a user in ≥2 orgs, the only product path to "create another company" (`/onboarding?new=1`) hardcodes `organizationId: null` (`ui/src/pages/OnboardingFlow.tsx:104`), `OrgStep` omits it (`ui/src/onboarding/steps/OrgStep.tsx:83`), and the server 403s "you belong to multiple organizations" (`server/src/routes/companies.ts:50-54`), rendered raw in red (`OrgStep.tsx:94`). Single-org founders are unaffected (server auto-picks their one org, `companies.ts:49`).

**Approach (P1 = auto-pick, no picker).**
- **UI-only, zero server contract change.** Before rendering the create-another-company step, call `organizationsApi.list()` (already returns `role`, `ui/src/api/organizations.ts`) and filter to **create-capable** orgs (`role ∈ {owner, admin}`, per the org matrix in `server/src/services/organization-access.ts`):
  - exactly one → auto-select it silently and send its id;
  - zero → route to `CreateOrganizationStep`;
  - ≥2 → render a **friendly message** (reuse the `AccessRequired`/empty-state surface from the sibling spec), not a raw 403 and not a picker.
- Never send `undefined`/`null` as the org id in cloud_auth. The server already honors an explicit id (`companies.ts:46`) and re-authorizes via `canOrg` (`companies.ts:64`).
- **Correct the stale comments** that claim the server falls back to `DEFAULT_ORGANIZATION_ID` when the org id is omitted — that is the self-hosted branch only (`companies.ts:56`): `OrgStep.tsx:75-80`, `OnboardingFlow.tsx:99-103`, and the `CompanyContext` comment.

**Side effects / risks.** Must scope the auto-pick to create-capable orgs or the user re-hits the `assertCompanyCreateAuthorized` 403; +1 `GET /organizations` round-trip. The ≥2-create-capable case is rare in the beta (would require owning/administering two orgs) — a friendly message is sufficient (a picker is a deferred follow-up if it ever becomes common).

**Effort:** M (UI).

**Tests.** Route behavior is already test-locked in `server/src/__tests__/companies-org-scope.test.ts:125-156` (1-org → own org; 2+ omitted → 403; 0 → 403) — keep it green. New: the 4-actor integration asserts A (cross-invited into org B) creating a 3rd company resolves to org A with no 403; a UI test asserts `organizationsApi.list()` filtered to owner/admin yields exactly the owned org.

### Fix 3 — Ghost org on reload + the empty-Lobby strand (fix together)

**Problem (two coupled parts).**
- **Ghost org:** the created org id lives only in `FlowEngine` React state (`ui/src/onboarding/FlowEngine.tsx:100`), never persisted. A hard reload between the Organization step and the Company step re-fires `CreateOrganizationStep`, which POSTs a brand-new org unconditionally (`ui/src/onboarding/steps/CreateOrganizationStep.tsx:41-43`; `server/src/services/organizations.ts:107-114` always inserts) — one orphan tenant per reload, and this is what pushes a founder into the ≥2-org state behind Fix 2.
- **Strand:** the moment the first org row exists, the founder is reclassified `returning` (`server/src/services/post-auth-journey.ts:37-38`), but the resume signal only fires for founders who already have a *company* (`server/src/routes/onboarding-journey.ts:198-215`). An org-owner with zero companies falls through to an empty Lobby with no route back into company creation.

**Approach (P3/P4 = client durability, keep the step).**
- **Ghost org — client localStorage durability** (mirrors the proven pattern `OrgStep` already uses for the company step, `OrgStep.tsx:38,46,85,91` + `ui/src/onboarding/pendingOrganization.ts`):
  - New `ui/src/onboarding/pendingTenant.ts` (copy `pendingOrganization.ts` shape; key `aoa.onboarding.pendingTenant.<userId>`; stores `{id, name}`).
  - `CreateOrganizationStep`: on mount, if a persisted tenant exists → `ctx.setOrganizationId(id)` + auto-complete (skip re-create); after a successful create → write pending tenant **before** `onComplete`, guarded by a same-mount `createdRef`.
  - Clear the pending tenant when the company step consumes the org (add `clearPendingTenant` alongside the existing `clearPendingOrganization` at `OrgStep.tsx:91`) — clear on company-create, not before.
  - (Equivalent XS wiring alternative: initialize `FlowEngine.tsx:100` `organizationId` from `readPendingTenant(userId)` so the step's `isComplete` is truthy after reload. Pick one variant.)
  - Degrades to today's behavior only if localStorage is unavailable / different device.
- **Strand — journey resume:** emit a resume signal for a `returning` founder who owns an org but has 0 companies (extend `server/src/routes/onboarding-journey.ts:198-215` / `post-auth-journey.ts`) and have the index gate route them back into the company step under that org (or keep them on the founder spine until `COMPANY_CREATED`). Must not loop a founder who *deliberately* owns a company-less org.
- **Ship both together:** the localStorage fix without the resume fix still leaves the empty-Lobby dead-end; the resume fix without the localStorage fix still mints ghost orgs.

**Explicitly NOT doing (P3):** no server owner-dedup on `POST /organizations`. It returns the wrong org for users who already own one via `ensureRealOperator` (`server/src/services/access.ts:328`) or the `0188` backfill, and breaks `organizations-routes.test.ts` (fakeDb stubs only `.insert().returning()`).

**Effort:** S (client durability) + M (resume signal).

**Tests.** jsdom: render `CreateOrganizationStep`, submit, remount (simulate reload), assert `organizationsApi.create` called **once** and the step auto-resolves from `pendingTenant`. Integration: an org-owner with 0 companies hitting `/` is routed into company creation, not an empty Lobby.

### Fix 4 — Scalability push-downs (Lobby hot path)

**Problem.** `GET /companies/stats` runs four instance-wide `GROUP BY company_id` aggregations over agents/issues/approvals/notifications with no tenant predicate, then filters in JS (`server/src/services/companies.ts:315-377`, route `:104-118`); `GET /companies` does `db.select().from(companies)` unscoped then JS-filters (`companies.ts:211`, route `:88-101`). Both are hit on the post-login Lobby (`ui/src/pages/Lobby.tsx`, `ui/src/pages/Companies.tsx`, `ui/src/context/CompanyContext.tsx`). Work scales with the whole platform, not the tenant.

**Approach.** Push the already-materialized allowed-company-id set into SQL (`inArray(companyId, allowedIds)` before `GROUP BY`; `WHERE id = ANY(...)` on list). Needed indexes already exist. **Two invariants that must be preserved (verifier-flagged HAS-RISK):**
1. **Preserve the `legacyAdmin` unfiltered early-return** for the self-hosted `!enforced && (local_implicit || isInstanceAdmin)` operator view (list `companies.ts:93-101`, stats `:107-117`). Do not push the filter down on that branch.
2. **Empty allowed-set must degrade to "return none"** — today `.filter()` → `[]`; an `inArray(id, [])` must emit a false predicate, not error or return-all.
- The `notCrewAssigned` anti-join (`server/src/services/issue-crew-scope.ts`) is `NOT EXISTS` and safe under an outer company filter — do **not** rewrite it to `NOT IN` (three-valued-logic bug on NULL assignees).

**Side effects / risks.** Changing `svc.list()` / `svc.stats()` signatures affects their callers — audit all call sites and keep behavior identical for the operator branch. This is a semantics-preserving refactor; land it behind the two invariants above with tests, not as a blind push-down.

**Effort:** S–M.

**Tests.** Assert stats/list return identical results to today for a multi-tenant fixture (caller sees only their companies); assert the self-hosted operator view still returns all; assert empty-allow-set returns none.

### Fix 5 — Org-create transaction hardening

**Problem.** `createSelfServeOrganization` (`server/src/services/organizations.ts:112-113`) does the org insert then `ensureOrgOwner` as two un-transactioned awaits. A transient fault between them leaves an org row with no owner membership (orphan, `createdByUserId` null), which the user can never reach or adopt (a retry mints a fresh slug-deduped org).

**Approach.** Wrap the org-insert + owner-membership write in one `db.transaction`. **Caveat:** do **not** naively wrap the slug-retry loop — a 23505 unique-violation aborts the whole PG transaction. Allocate a unique slug up-front (or SAVEPOINT-per-attempt) so the retry loop lives outside the final atomic insert+membership.

**Effort:** M.

**Tests.** Force `ensureOrgOwner` to throw; assert no orphan org row remains (full rollback). Keep `organizations-uniqueness.integration.test.ts` green (low-level `organizationService.create` untouched).

## Testing strategy (the multi-user requirement)

The rigorous, automated backbone is a **server/integration harness on embedded Postgres in `cloud_auth` mode** — it runs the *identical* enforcement code the real cloud uses (`tenantIsolationEnforced`, `authz.ts`, `resolveCompanyOrganizationId`, `join-approval`), with no Google OAuth dependency. Windows note: run `*.integration.test.ts` with `initdbFlags: ["--encoding=UTF8","--locale=C"]` and the skip flag flipped (per the Windows embedded-PG memory).

**Tier A — real embedded-PG integration** (highest fidelity). Template: `server/src/__tests__/companies-org-scope.test.ts:50-60` builds an Express app with `companyRoutes(db, { deploymentMode: "cloud_auth" })` and injects `req.actor` per request; `setDeploymentMode("cloud_auth")` flips enforcement process-wide.

Scripted end-to-end **exactly matching the user's scenario**:
1. Two `auth` users A, B (distinct emails).
2. A: `createSelfServeOrganization` → create A1 (org id = orgA) → create A2 (resolver with `actorOrganizationIds=[orgA]`). Mirror for B (B1, B2).
3. A invites B into A1; admit via `approveHumanJoinRequestTx`. Mirror B invites A into B1.

Assertions at each step (against real code):
- Each company's `organizationId` = the intended org (A2 must be orgA, **not** the `DEFAULT_ORGANIZATION_ID` sentinel — `companies.ts:49`).
- After cross-invite, rebuild each actor via the middleware's own query (`organizationMemberships WHERE userId AND status='active'`, `auth.ts:77-85`): `A.organizationIds = [orgA, orgB]`, roles `{orgA:owner, orgB:member}`.
- **Company boundary:** `assertCompanyAccess(B1)` for A returns; `assertCompanyAccess(B2)` for A throws 403.
- **Create-company (Fix 2):** A creating a 3rd company resolves to org A with no 403; `organizationsApi.list()` filtered to owner/admin yields exactly `[orgA]`.
- **Add-member (Fix 1):** direct-add is rejected in cloud; the invite path admits and grants access.
- **Ghost-org (Fix 3):** remount `CreateOrganizationStep` (simulate reload) → `organizationsApi.create` called once; org-owner with 0 companies is routed into company creation, not stranded.

**Tier B — route tests with fake actors** (fast; resolver/picker logic). Extend `companies-org-scope.test.ts`'s `makeApp(actor, "cloud_auth")`.

**Live multi-user smoke (open item).** A literal two-browser, two-Google-account test is gated by Google OAuth at the browser edge (`CloudAccessGate`). During implementation, determine whether the local `cloud_auth` instance has a dev-login / test-session path we can use to click through the scenario with two real accounts. If yes → do the live smoke too; if not → Tier A is the high-fidelity substitute. Either way the deliverable is a genuine multi-user test, not a single-user one.

## Build order & sequencing constraints

1. **Fix 1** (add-member) — smallest, highest-severity, independently shippable.
2. **Fix 3** (ghost-org durability + strand resume) — ship the two halves together.
3. **Fix 2** (multi-org create-company) — UI-only; correct stale comments in the same change.
4. **Fix 4** (scalability push-downs) — behind the two invariants (legacyAdmin early-return; empty-set → none).
5. **Fix 5** (org-create transaction) — watch the slug-retry-not-in-one-tx caveat.
6. **Full 4-actor integration harness** → **code review** → **live/local multi-user test**.

**Hard constraints:**
- Do NOT ship server owner-dedup on `POST /organizations` (P3).
- Fix 2 auto-pick is scoped to **create-capable** orgs, never "the owned org" singular (users can own ≥2).
- Fix 4 must preserve the legacyAdmin early-return and empty-`inArray` degrade-to-none; never rewrite `NOT EXISTS` to `NOT IN`.
- Self-hosted / `local_trusted` behavior is unchanged throughout.

## Out of scope (tracked as follow-ups)

- **Import-path org placement** (`server/src/services/company-portability.ts:2160-2174`): `/import new_company` writes the company under the `DEFAULT_ORGANIZATION_ID` sentinel in cloud_auth with only `assertBoard` authz — a real tenant-mis-placement defect, but it needs its own org-selection UI + route authz. Separate task.
- **Server-side create-company auto-pick refinement** (role-on-actor plumbing): defense-in-depth behind the Fix 2 UI; requires `role` on `req.actor` (two auth paths). Deferred.
- **`ensureOrgMembership` guard → role-rank compare:** the latent admin→member downgrade is unreachable today (no org-role-management writer exists). Harden the guard *before* any org-role-management route ships. Deferred, with a tripwire.
- **Org-picker UI** for the (rare) ≥2-create-capable-org case: only if multi-org ownership becomes common.
- **Sibling spec:** `2026-07-31-tenant-access-required-polish-design.md` (AccessRequired surface, membership-aware routing, naming fix) lands on the same branch; Fix 2's friendly message reuses its `AccessRequired` surface.
