# Multi-Tenant Journey Correctness Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four reachable breaks in the AoA cloud_auth (multi-tenant) journey — add-member lockout, multi-org create-company 403, ghost-org-on-reload + empty-Lobby strand — plus Lobby scalability push-downs and org-create transaction hardening, all on branch `claude/multitenant-cloud`.

**Architecture:** Deployment-mode-aware fixes: cloud_auth routes human admission through the audited invite chokepoint and auto-picks the founder's own org; onboarding persists the created org across reload; Lobby queries push the tenant filter into SQL; org-create is transactional. Self-hosted / local_trusted behavior is preserved unchanged throughout.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM + PostgreSQL (embedded-postgres for tests), React + Vite + Tailwind v4, Vitest + RTL (jsdom), embedded-PG integration tests.

**Spec:** `docs/aoa/plans/2026-07-31-mt-journey-correctness-fixes-design.md`

---

## Build order & hard constraints

**Implement in this order** (smallest/highest-severity first; ship each behind its own tests + commit):

1. **Fix 1** — Add-member invite-only in cloud (removes the lockout).
2. **Fix 3** — Ghost-org localStorage durability + empty-Lobby strand resume (ship the two halves together).
3. **Fix 2** — Multi-org create-company auto-pick (UI-only; correct the stale `DEFAULT_ORGANIZATION_ID` comments in the same change).
4. **Fix 4** — Lobby scalability push-downs (behind the two invariants below).
5. **Fix 5** — Org-create transaction hardening (watch the slug-retry-not-in-one-tx caveat).
6. **Integration harness (Task H)** — the full 4-actor `cloud_auth` embedded-PG suite; author and run it **last** (it couples to Fixes 1/2/5 being on the branch). Then code review, then the live/local multi-user test.

**Hard constraints (from the spec, do not violate):**

- **No server owner-dedup on `POST /organizations`** (P3). Several users legitimately already own >1 org (`ensureRealOperator` + the `0188` default-org backfill), so an owner-only dedup would return the wrong org and break tests. The ghost-org fix is **client durability only**; the strand fix is a read-only resume signal computed from already-fetched rows.
- **Fix 2 auto-pick is scoped to create-capable orgs** (`role ∈ {owner, admin}`), never "the owned org" singular — a user can own/administer ≥2 orgs. Exactly-one create-capable org → auto-send its id; zero → `CreateOrganizationStep`; ≥2 → friendly message (not a raw 403, not a picker).
- **Fix 4 must preserve both invariants:** (1) keep the `legacyAdmin` **unfiltered early-return** for the self-hosted `!enforced && (local_implicit || isInstanceAdmin)` operator view; (2) an **empty allowed-set degrades to "return none"** (`inArray(id, [])` must emit a false predicate / short-circuit, never scan or return-all). **Never rewrite the `notCrewAssigned` `NOT EXISTS` anti-join to `NOT IN`** (three-valued-logic bug on NULL assignees).
- **Self-hosted / `local_trusted` behavior is unchanged throughout.** Every gate keys on `tenantIsolationEnforced()` (cloud_auth only).

**Cross-fix file collisions (from the plan review) — sequencing rules:**

- `ui/src/api/health.ts` (widen `deploymentMode` union with `"cloud_auth"`) is owned by **Fix 1 only**. Fix 2's duplicate widen was **removed** (it would have failed as a double edit against the same line); Fix 2 still depends on the widened union for its `isCloud` typecheck, so **land Fix 1 before Fix 2** (already the order).
- `ui/src/onboarding/steps/__tests__/OrgStep.test.tsx`: **Fix 3 adds one case (→ 10 tests)**. Fix 2's expected counts were updated to the **post-Fix-3** world (OrgStep = 10, not 9), so **land Fix 3 before Fix 2** (already the order).
- `ui/src/onboarding/steps/OrgStep.tsx`: edited by both Fix 3 (import insert after line 11 + two `clearPendingTenant` lines) and Fix 2 (comment region near lines 75-81). Both use content-exact anchors so the edits still land; the stale line numbers shift **+1** after Fix 3 — trust the anchor text, not the cited line.
- `server/src/__tests__/companies-org-scope.test.ts`: Fix 4 rewrites its `GET` tests; Fix 2 only runs it read-only (asserting the untouched `POST` tests at 125-156). Order is **Fix 2 before Fix 4**, so Fix 2 sees the original file — fine either way.
- **Harness ↔ Fix 5 signature:** Fix 5 changes `createSelfServeOrganization`'s 3rd parameter to an **orgAccess factory** `(handle: Db) => { ensureOrgOwner }`. The harness therefore passes `organizationAccessService` (the un-invoked factory), **not** `organizationAccessService(db)` — authoring the harness last guarantees it targets the post-Fix-5 signature.

**Integration-test convention (harmonized across all three embedded-PG suites — Fix 4, Fix 5, Task H):** committed as `describe.skipIf(process.platform !== "linux")` with `initdbFlags: ["--encoding=UTF8", "--locale=C"]` **baked into the `EmbeddedPostgres` ctor**. Linux CI is the authoritative gate (Issue #114); to run locally on Windows, temporarily flip the predicate to `describe.skipIf(false)` (the initdb flags are already present), then revert before committing. (Fix 4's draft originally used `=== "win32"` with temporary flags; it was harmonized up to the embedded-PG convention that Fix 5 / Task H / the `work-questions.integration.test.ts` template already use.)

**Accepted coverage notes (flagged by the plan review, signed off here):**

- **Fix 3 client routing** (`App.tsx` `LobbyOrOnboardingRedirect` seeds `pendingTenant` + navigates to `/onboarding`) ships with **server-signal coverage as the substitute** for a dedicated jsdom test: the resolver emits `resumeCompanyCreationOrgId` (2 unit tests) and the Tier A 4-actor harness (Task H) proves the end-to-end "org-owner with 0 companies is routed into company creation, not an empty Lobby" assertion. Add a small `LobbyOrOnboardingRedirect` jsdom test only if a reviewer wants belt-and-suspenders.
- **Fix 3 "must not loop":** the resolver re-emits the resume signal on every `/` visit for a create-capable owner with 0 companies, so such a user is routed to company creation each visit until they create one. This repeated routing is **not** the infinite loop the spec forbids (the user exits by creating a company) — accepted per P3/P4.

---

## Fix 1 — Add-member: invite-only in cloud (removes the lockout)

**Design ref:** `docs/aoa/plans/2026-07-31-mt-journey-correctness-fixes-design.md` §"Fix 1" + decision P2.

**Root cause (grounded).** `team.addMember` (`server/src/services/team.ts:737`) writes only the **company** membership via `access.ensureMembership(...)` and never an **org** membership. In `cloud_auth`, `assertCompanyAccess` requires **both** (`server/src/routes/authz.ts:71` — `orgs.includes(tenantId) && companyIds.includes(companyId)`), so a directly-added teammate 403s on every request. The invite path `approveHumanJoinRequestTx` already writes both (`server/src/services/join-approval.ts:210` company + `:217-219` org). Fix = reject direct-add in cloud (server guard, defense-in-depth) + hide the direct-add mode in the UI; self-hosted (`!tenantIsolationEnforced()`) is untouched.

**Enforcement primitive.** `tenantIsolationEnforced()` returns `deploymentMode === "cloud_auth"` (`server/src/config/deployment-mode.ts:12-14`). It is **already imported** into `team.ts` at line 36. The health route emits the raw `"cloud_auth"` string (`server/src/routes/health.ts:44`), so the UI can key off `health.deploymentMode === "cloud_auth"`.

---

### Task 1.1 — Server: reject direct-add in `cloud_auth` (service guard) + unit test

**Files:**
- Modify: `server/src/services/team.ts` (line 35 import; guard inserted at line 688, first statement of `addMember`)
- Modify (test): `server/src/__tests__/team-direct-add.test.ts` (line 1 import; line 68 import; new `describe` inserted after line 308)

**Steps:**

- [ ] **Step 1: Write the failing test.** In `server/src/__tests__/team-direct-add.test.ts`, change the vitest import (line 1) and add the `setDeploymentMode` import after line 68, then insert a new `describe` block immediately after the `teamService.addMember` block closes (after line 308, before `describe("teamService.getReportsFor"...)`).

  Change line 1 from:
  ```ts
  import { describe, it, expect, vi } from "vitest";
  ```
  to:
  ```ts
  import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
  ```

  After line 68 (`import { teamService } from "../services/team.js";`) add:
  ```ts
  import { setDeploymentMode } from "../config/deployment-mode.js";
  ```

  Insert this new block after line 308 (the `});` that closes `describe("teamService.addMember", ...)`):
  ```ts
  describe("teamService.addMember — cloud_auth invite-only guard (Fix 1)", () => {
    // cloud_auth admits humans ONLY through the invite chokepoint
    // (approveHumanJoinRequestTx), which writes BOTH org + company memberships.
    // Direct-add writes only the company membership -> assertCompanyAccess
    // (authz.ts:71) 403s the added user on every request. Reject it here.
    beforeEach(() => {
      resetMocks();
      setDeploymentMode("cloud_auth");
    });
    afterEach(() => {
      // Never leak cloud_auth into the other describes in this file.
      setDeploymentMode("local_trusted");
    });

    it("rejects direct-add in cloud with an actionable invite message", async () => {
      // The guard fires FIRST — no DB access, so no select sequences needed.
      const db = createSequenceDb({});
      const svc = teamService(db as any);
      await expect(
        svc.addMember(
          "c1",
          { name: "New User", email: "new@test.com", role: "team_member" },
          "founder-user",
        ),
      ).rejects.toThrow(/Send an email invite instead/);
    });

    it("still one-click direct-adds in self-hosted (guard does NOT fire when not enforced)", async () => {
      // Divergence lock: self-hosted has no tenant boundary and is unchanged.
      setDeploymentMode("local_trusted");
      mockAccessService.getMembership.mockResolvedValue({ id: "m1", status: "active" });
      mockAccessService.ensureMembership.mockResolvedValue({ id: "m2" });
      mockAccessService.setPrincipalGrants.mockResolvedValue(undefined);

      const db = createSequenceDb({
        selects: [
          // assertFounder -> isInstanceAdmin
          [],
          // assertFounder -> userRoles -> founder
          [{ role: "founder", projectId: null }],
          // email uniqueness -> clean
          [],
          // find authUser by email -> not found (create new)
          [],
          // updateUserRole -> getUserRole -> isInstanceAdmin
          [],
          // updateUserRole -> getUserRole -> userRoles
          [{ role: "team_member", projectId: null }],
          // updateUserRole final getUserRole -> isInstanceAdmin
          [],
          // updateUserRole final getUserRole -> userRoles
          [{ role: "team_member", projectId: null }],
        ],
        inserts: [
          // insert authUser
          [],
        ],
      });
      const svc = teamService(db as any);
      const result = await svc.addMember(
        "c1",
        { name: "New User", email: "new@test.com", role: "team_member" },
        "founder-user",
      );
      expect(typeof result.userId).toBe("string");
    });
  });
  ```

- [ ] **Step 2: Run — confirm the cloud test fails.** From repo root:
  ```
  pnpm exec vitest run --root server src/__tests__/team-direct-add.test.ts
  ```
  Expected: the new `"rejects direct-add in cloud..."` test FAILS — without the guard, `addMember` falls through to `assertFounder`, which throws `"Only founders can manage team roles"` (empty `userRoles` sequence), not the invite message, so `rejects.toThrow(/Send an email invite instead/)` does not match. The `"still one-click..."` test passes (regression lock). The other 15 tests still pass.

- [ ] **Step 3: Add the guard (minimal implementation).** In `server/src/services/team.ts`, add `badRequest` to the errors import at line 35.

  Change line 35 from:
  ```ts
  import { conflict, notFound } from "../errors.js";
  ```
  to:
  ```ts
  import { badRequest, conflict, notFound } from "../errors.js";
  ```

  Then insert the guard as the first statement of `addMember`. Current code (lines 683-688):
  ```ts
    async function addMember(
      companyId: string,
      input: { name: string; email: string; role: UserRole; projectId?: string | null; parentType?: "user" | null; parentId?: string | null },
      addedByUserId: string,
    ): Promise<{ userId: string }> {
      await assertFounder(companyId, addedByUserId);
  ```
  New code:
  ```ts
    async function addMember(
      companyId: string,
      input: { name: string; email: string; role: UserRole; projectId?: string | null; parentType?: "user" | null; parentId?: string | null },
      addedByUserId: string,
    ): Promise<{ userId: string }> {
      // Fix 1 (P2): in cloud_auth, humans are admitted ONLY through the invite
      // chokepoint (approveHumanJoinRequestTx), which writes BOTH the org and the
      // company membership. Direct-add writes only the company membership, so
      // assertCompanyAccess (authz.ts:71 — org AND company required) would 403 the
      // added user on every request — a full lockout. Reject the path instead of
      // patching it; this also collapses cloud admission onto the single audited
      // seam that future seat-quota / SSO / SCIM enforcement hooks into.
      // Self-hosted has no tenant boundary and is unchanged.
      if (tenantIsolationEnforced()) {
        throw badRequest(
          "Direct add is not available in cloud mode. Send an email invite instead — it grants organization and company access together.",
        );
      }

      await assertFounder(companyId, addedByUserId);
  ```

- [ ] **Step 4: Run — confirm all green.** From repo root:
  ```
  pnpm exec vitest run --root server src/__tests__/team-direct-add.test.ts
  ```
  Expected: `Tests 17 passed (17)` (the original 15 + 2 new).

- [ ] **Step 5: Typecheck the server package.** From repo root:
  ```
  pnpm --filter @armyofagents/server typecheck
  ```
  Expected: exits 0 (no errors) — `badRequest` is now a real export used in `team.ts`.

- [ ] **Step 6: Commit.**
  ```
  git add server/src/services/team.ts server/src/__tests__/team-direct-add.test.ts
  git commit -m "fix(team): reject direct add-member in cloud_auth (invite-only)"
  ```
  (Include the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.)

**Note (route surface).** The route `POST /companies/:companyId/team/members` (`server/src/routes/team.ts:271-294`) delegates straight to `team.addMember` and has no bespoke test harness; the `badRequest` `HttpError(400)` propagates through the global error handler, so the service-level test fully covers the guard. The full 4-actor integration harness (separate task) also asserts direct-add rejection end-to-end per design §"Add-member (Fix 1)".

---

### Task 1.2 — UI: gate `AddMemberDialog` to invite-only in cloud + jsdom test

**Files:**
- Modify: `ui/src/api/health.ts` (line 7 — widen the `deploymentMode` union to include `"cloud_auth"`)
- Modify: `ui/src/components/team/AddMemberDialog.tsx` (interface line 31-38; params line 40-47; description line 182-184; mode-toggle block line 205-241)
- Modify: `ui/src/components/team/HumansTab.tsx` (import after line 8; health query after line 435; prop at line 742-749)
- Modify (test): `ui/src/components/team/__tests__/AddMemberDialog.test.tsx` (new `describe` appended after line 224)

**Steps:**

- [ ] **Step 1: Write the failing jsdom test.** Append this new `describe` block to `ui/src/components/team/__tests__/AddMemberDialog.test.tsx` after line 224 (the `});` closing the `"invite is the primary path"` block). It reuses the file's existing `inviteResponse` helper and mocks:
  ```tsx
  describe("AddMemberDialog — cloud invite-only gating (Fix 1)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(accessApi.createCompanyInvite).mockResolvedValue(inviteResponse());
      vi.mocked(teamApi.addMember).mockResolvedValue({ userId: "user-2" });
    });

    function renderWith(inviteOnly: boolean) {
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: 0 },
          mutations: { retry: false },
        },
      });
      function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
      }
      render(
        <AddMemberDialog
          companyId="company-1"
          departments={[]}
          members={[]}
          isSystemAdmin={false}
          inviteOnly={inviteOnly}
          open
          onOpenChange={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
    }

    it("hides the manual-add path entirely in cloud mode", () => {
      renderWith(true);
      // Invite form is still present...
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
      // ...but there is no way to switch to (or reach) direct add.
      expect(screen.queryByRole("button", { name: /Add manually/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Invite by email/ })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    });

    it("keeps both modes in self-hosted (inviteOnly=false)", () => {
      renderWith(false);
      expect(screen.getByRole("button", { name: /Invite by email/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Add manually/ })).toBeInTheDocument();
    });
  });
  ```

- [ ] **Step 2: Run — confirm the cloud test fails.** From repo root:
  ```
  pnpm --filter @armyofagents/ui exec vitest run src/components/team/__tests__/AddMemberDialog.test.tsx
  ```
  Expected: `"hides the manual-add path entirely in cloud mode"` FAILS — the component ignores the unknown `inviteOnly` prop and still renders the `/Add manually/` and `/Invite by email/` toggle buttons, so the `not.toBeInTheDocument()` assertions fail. `"keeps both modes..."` passes (regression lock); the original 8 tests pass.

- [ ] **Step 3: Widen the health type.** In `ui/src/api/health.ts`, change line 7 from:
  ```ts
    deploymentMode?: "local_trusted" | "authenticated";
  ```
  to:
  ```ts
    deploymentMode?: "local_trusted" | "authenticated" | "cloud_auth";
  ```

- [ ] **Step 4: Add the `inviteOnly` prop to the dialog.** In `ui/src/components/team/AddMemberDialog.tsx`:

  Interface (lines 31-38) — add the prop. Change:
  ```tsx
  interface AddMemberDialogProps {
    companyId: string;
    departments: Project[];
    members: TeamMemberSummary[];
    isSystemAdmin: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }
  ```
  to:
  ```tsx
  interface AddMemberDialogProps {
    companyId: string;
    departments: Project[];
    members: TeamMemberSummary[];
    isSystemAdmin: boolean;
    /**
     * cloud_auth (Fix 1): humans are admitted only via invite, which writes both
     * org + company membership. Hide the direct-add mode so the surface can only
     * mint invites. Self-hosted leaves this false and keeps both modes.
     */
    inviteOnly?: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }
  ```

  Params (lines 40-47) — destructure with a default. Change:
  ```tsx
  export function AddMemberDialog({
    companyId,
    departments,
    members,
    isSystemAdmin,
    open,
    onOpenChange,
  }: AddMemberDialogProps) {
  ```
  to:
  ```tsx
  export function AddMemberDialog({
    companyId,
    departments,
    members,
    isSystemAdmin,
    inviteOnly = false,
    open,
    onOpenChange,
  }: AddMemberDialogProps) {
  ```

- [ ] **Step 5: Gate the description + mode toggle.** In `ui/src/components/team/AddMemberDialog.tsx`:

  Description (lines 182-184). Change:
  ```tsx
          <DialogDescription>
            Invite by email, or add someone manually.
          </DialogDescription>
  ```
  to:
  ```tsx
          <DialogDescription>
            {inviteOnly
              ? "Invite a teammate by email."
              : "Invite by email, or add someone manually."}
          </DialogDescription>
  ```

  Mode toggle block (lines 205-241) — wrap in `{!inviteOnly && (...)}`. Current code:
  ```tsx
          {/* Mode toggle — invite is primary, manual add is demoted. */}
          <div className="space-y-2">
            <button
              type="button"
              aria-pressed={mode === "invite"}
              onClick={() => setMode("invite")}
              className={cn(
                "w-full rounded-lg border p-3 text-left transition-colors",
                mode === "invite"
                  ? "border-foreground bg-accent/40"
                  : "border-border hover:bg-accent/20",
              )}
            >
              <span className="block text-sm font-medium">Invite by email</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                They accept a link and join with their Google account.
              </span>
            </button>
            <button
              type="button"
              aria-pressed={mode === "direct"}
              onClick={() => setMode("direct")}
              className={cn(
                "w-full rounded-lg border p-3 text-left transition-colors",
                mode === "direct"
                  ? "border-foreground bg-accent/40"
                  : "border-border hover:bg-accent/20",
              )}
            >
              <span className="block text-sm font-medium text-muted-foreground">
                Add manually
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Instant access, no invite or email verification.
              </span>
            </button>
          </div>
  ```
  New code (only the wrapper `{!inviteOnly && (` … `)}` is added around the existing `<div>`; body unchanged):
  ```tsx
          {/* Mode toggle — invite is primary, manual add is demoted. Hidden
              entirely in cloud (inviteOnly): direct-add is server-rejected there,
              so `mode` stays "invite" and can never switch to "direct". */}
          {!inviteOnly && (
          <div className="space-y-2">
            <button
              type="button"
              aria-pressed={mode === "invite"}
              onClick={() => setMode("invite")}
              className={cn(
                "w-full rounded-lg border p-3 text-left transition-colors",
                mode === "invite"
                  ? "border-foreground bg-accent/40"
                  : "border-border hover:bg-accent/20",
              )}
            >
              <span className="block text-sm font-medium">Invite by email</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                They accept a link and join with their Google account.
              </span>
            </button>
            <button
              type="button"
              aria-pressed={mode === "direct"}
              onClick={() => setMode("direct")}
              className={cn(
                "w-full rounded-lg border p-3 text-left transition-colors",
                mode === "direct"
                  ? "border-foreground bg-accent/40"
                  : "border-border hover:bg-accent/20",
              )}
            >
              <span className="block text-sm font-medium text-muted-foreground">
                Add manually
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Instant access, no invite or email verification.
              </span>
            </button>
          </div>
          )}
  ```
  (`mode` initializes to `"invite"` at line 52 and, with the toggle hidden, has no `setMode("direct")` caller — so the `mode === "direct"` name/branches never render, and the `ConfirmDialog` never opens.)

- [ ] **Step 6: Run — confirm the dialog tests are green.** From repo root:
  ```
  pnpm --filter @armyofagents/ui exec vitest run src/components/team/__tests__/AddMemberDialog.test.tsx
  ```
  Expected: `Tests 10 passed (10)` (the original 8 + 2 new).

- [ ] **Step 7: Wire `inviteOnly` from `HumansTab` (cloud signal).** In `ui/src/components/team/HumansTab.tsx`:

  Add the health API import after line 8 (`import { projectsApi } from "../../api/projects";`):
  ```tsx
  import { healthApi } from "../../api/health";
  ```

  Add the health query + derived flag immediately after the `projects` query (after line 435, the `});` closing `const { data: projects } = useQuery({...})`):
  ```tsx
    // Fix 1: cloud_auth admits humans invite-only (direct-add is server-rejected
    // because it never writes the org membership). Reuse the app-level health
    // query cache (same key) — no extra network round-trip.
    const { data: health } = useQuery({
      queryKey: queryKeys.health,
      queryFn: () => healthApi.get(),
    });
    const inviteOnly = health?.deploymentMode === "cloud_auth";
  ```

  Pass the prop at the `AddMemberDialog` usage (lines 742-749). Change:
  ```tsx
          <AddMemberDialog
            companyId={selectedCompanyId}
            departments={departments}
            members={members}
            isSystemAdmin={isSystemAdmin}
            open={addMemberOpen}
            onOpenChange={setAddMemberOpen}
          />
  ```
  to:
  ```tsx
          <AddMemberDialog
            companyId={selectedCompanyId}
            departments={departments}
            members={members}
            isSystemAdmin={isSystemAdmin}
            inviteOnly={inviteOnly}
            open={addMemberOpen}
            onOpenChange={setAddMemberOpen}
          />
  ```

- [ ] **Step 8: Typecheck the UI package.** From repo root:
  ```
  pnpm --filter @armyofagents/ui typecheck
  ```
  Expected: exits 0. This confirms the `health.deploymentMode === "cloud_auth"` comparison typechecks against the widened union (Step 3) and that `inviteOnly` is a valid prop.

- [ ] **Step 9: Commit.**
  ```
  git add ui/src/api/health.ts ui/src/components/team/AddMemberDialog.tsx ui/src/components/team/HumansTab.tsx ui/src/components/team/__tests__/AddMemberDialog.test.tsx
  git commit -m "feat(team-ui): invite-only add-member surface in cloud_auth"
  ```
  (Include the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.)

---

### Task 1.3 — Lock the invite path: it grants BOTH memberships to an already-registered invitee

**Design ref:** Fix 1 part (c). **Confirmed by reading the code:** the verified-email auto-admit finalize (`server/src/routes/onboarding-join.ts:182-224`) admits an already-registered user (`user.emailVerified` + email match) by calling `approveHumanJoinRequestTx`, which writes the **company** membership (`join-approval.ts:210`) AND the **org** membership (`join-approval.ts:217-219`). It DOES auto-grant — so per the design this task **adds a regression-lock test asserting it** (no implementation change).

**Files:**
- Modify (test only): `server/src/__tests__/invited-joins-correct-org.test.ts` (new `it` inserted after line 98)

**Steps:**

- [ ] **Step 1: Add the both-memberships assertion.** In `server/src/__tests__/invited-joins-correct-org.test.ts`, insert this `it` inside the existing `describe` immediately after line 98 (the `});` closing the `"...auto-admit (verified-email) path too..."` test):
  ```ts
    it("grants BOTH company and org membership so an already-registered invitee passes assertCompanyAccess (Fix 1 anti-lockout)", async () => {
      // This is the positive counterpart to Fix 1's server guard: the invite
      // chokepoint writes the company membership (the piece direct-add also
      // writes) AND the org membership (the piece direct-add OMITS). Both are
      // required by assertCompanyAccess (authz.ts:71), which is why cloud
      // direct-add locks a user out while an invite does not.
      const services = makeServices();
      const db = makeTxDb({ id: "r1", status: "approved" });
      await approveHumanJoinRequestTx(db, services, {
        ...baseArgs,
        requestingUserId: "u9",
        ...autoAdmitApprovalIdentity(),
      });
      // Company membership: (companyId, "user", userId, role, "active").
      expect(services.access.ensureMembership).toHaveBeenCalledWith(
        "company-C1",
        "user",
        "u9",
        "member",
        "active",
      );
      // Org membership for the invited company's own tenant.
      expect(services.orgAccess.ensureOrgMembership).toHaveBeenCalledWith(
        "org-T1",
        "u9",
        "member",
      );
    });
  ```

- [ ] **Step 2: Run — confirm green (regression lock, no code change).** From repo root:
  ```
  pnpm exec vitest run --root server src/__tests__/invited-joins-correct-org.test.ts
  ```
  Expected: `Tests 6 passed (6)` (the original 5 + 1 new). The new assertion passes immediately because `approveHumanJoinRequestTx` already calls both `access.ensureMembership(...,"active")` (`join-approval.ts:210`) and `orgAccess.ensureOrgMembership("org-T1", ...)` (`:219`). This proves the invite path is the correct, non-locking admission for existing users — no implementation needed.

- [ ] **Step 3: Commit.**
  ```
  git add server/src/__tests__/invited-joins-correct-org.test.ts
  git commit -m "test(join): lock that invite path grants both company + org membership"
  ```
  (Include the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.)

---

### Fix 1 — final verification (run before handing off)

- [ ] **All three touched suites green.** From repo root:
  ```
  pnpm exec vitest run --root server src/__tests__/team-direct-add.test.ts src/__tests__/invited-joins-correct-org.test.ts
  pnpm --filter @armyofagents/ui exec vitest run src/components/team/__tests__/AddMemberDialog.test.tsx
  ```
  Expected: server `Tests 23 passed (23)` (17 + 6); UI `Tests 10 passed (10)`.
- [ ] **Typecheck both packages.**
  ```
  pnpm --filter @armyofagents/server typecheck
  pnpm --filter @armyofagents/ui typecheck
  ```
  Expected: both exit 0.

**Risks / divergence guards baked in.**
- *Self-hosted must stay one-click* — locked by Task 1.1 Step 1's `"still one-click direct-adds in self-hosted"` test and Task 1.2's `"keeps both modes in self-hosted"` test. The guard only fires under `tenantIsolationEnforced()`.
- *Test cross-contamination* — Task 1.1's `afterEach` resets `setDeploymentMode("local_trusted")` so `cloud_auth` never leaks into the other describes in `team-direct-add.test.ts` (default module state is `local_trusted`, `deployment-mode.ts:3`).
- *UI type honesty* — the health endpoint already emits `"cloud_auth"` (`health.ts:44`); only the client `HealthStatus` union lagged, widened in Task 1.2 Step 3.

---

## Fix 3 — Ghost org on reload + the empty-Lobby strand (ship together)

Design: `docs/aoa/plans/2026-07-31-mt-journey-correctness-fixes-design.md` §"Fix 3" (P3/P4 = client localStorage durability, NOT server owner-dedup; keep the explicit org step; add a journey-resume so an org-owner with 0 companies is routed back into company creation).

**Hard constraint (do NOT violate):** no server owner-dedup on `POST /organizations` (P3). The ghost-org fix is client durability only; the strand fix is a read-only resume signal computed from already-fetched rows (no new query, no write).

**Two coupled parts, shipped in one change:**
- **3a durability (client):** persist the created org id in localStorage so a reload between the org step and the company step ADOPTS the org instead of POSTing a duplicate.
- **3b strand (server + client wiring):** a `returning` founder who owns an org but has 0 companies gets a resume signal; the index gate seeds the durability hint and routes them into `/onboarding` at the company step.

Command conventions for this fix:
- **UI (jsdom, Windows-safe):** run from the `ui/` dir — `cd ui && pnpm exec vitest run <path-relative-to-ui>`.
- **Server resolver test:** `server/src/__tests__/onboarding-journey-route.test.ts` is a **seqDb-mock unit test (no embedded Postgres)** — it runs on Windows unchanged; NO `initdbFlags` / skip-flip needed. Run from the `server/` dir — `cd server && pnpm exec vitest run src/__tests__/onboarding-journey-route.test.ts`.

---

### Task 3.1 — `pendingTenant` localStorage durability module (mirror `pendingOrganization`)

**Files:**
- Create: `ui/src/onboarding/pendingTenant.ts`
- Create (test): `ui/src/onboarding/__tests__/pendingTenant.test.ts`

Mirrors the proven `ui/src/onboarding/pendingOrganization.ts` shape exactly (key `aoa.onboarding.pendingTenant.<userId>`; stores `{id, name}`; try/catch around every localStorage call).

- [ ] **Step 1: Write the failing test.** Create `ui/src/onboarding/__tests__/pendingTenant.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  pendingTenantKey,
  readPendingTenant,
  writePendingTenant,
  clearPendingTenant,
} from "../pendingTenant";

describe("pendingTenant durability", () => {
  beforeEach(() => localStorage.clear());

  it("namespaces the storage key by userId", () => {
    expect(pendingTenantKey("u1")).toBe("aoa.onboarding.pendingTenant.u1");
  });

  it("round-trips a written tenant", () => {
    writePendingTenant("u1", { id: "org1", name: "Acme Org" });
    expect(readPendingTenant("u1")).toEqual({ id: "org1", name: "Acme Org" });
  });

  it("returns null when nothing is stored", () => {
    expect(readPendingTenant("u1")).toBeNull();
  });

  it("returns null for malformed / partial JSON", () => {
    localStorage.setItem(pendingTenantKey("u1"), "not json");
    expect(readPendingTenant("u1")).toBeNull();
    localStorage.setItem(pendingTenantKey("u1"), JSON.stringify({ id: "org1" }));
    expect(readPendingTenant("u1")).toBeNull();
  });

  it("clear removes the hint", () => {
    writePendingTenant("u1", { id: "org1", name: "Acme Org" });
    clearPendingTenant("u1");
    expect(readPendingTenant("u1")).toBeNull();
  });
});
```
- [ ] **Step 2: Run — confirm it fails (module missing).** `cd ui && pnpm exec vitest run src/onboarding/__tests__/pendingTenant.test.ts`
  Expected: fails at import — `Failed to resolve import "../pendingTenant"` / "No test suite found" (the module does not exist yet).
- [ ] **Step 3: Create the module.** Write `ui/src/onboarding/pendingTenant.ts` in full:
```ts
export type PendingTenant = { id: string; name: string };

export function pendingTenantKey(userId: string): string {
  return `aoa.onboarding.pendingTenant.${userId}`;
}

export function readPendingTenant(userId: string): PendingTenant | null {
  try {
    const raw = localStorage.getItem(pendingTenantKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingTenant>;
    return typeof parsed.id === "string" && typeof parsed.name === "string"
      ? { id: parsed.id, name: parsed.name }
      : null;
  } catch {
    return null;
  }
}

export function writePendingTenant(userId: string, tenant: PendingTenant): void {
  try {
    localStorage.setItem(pendingTenantKey(userId), JSON.stringify(tenant));
  } catch {
    // Same-page retries still use CreateOrganizationStep's in-memory ref when
    // storage is unavailable.
  }
}

export function clearPendingTenant(userId: string): void {
  try {
    localStorage.removeItem(pendingTenantKey(userId));
  } catch {
    // A stale recovery hint is harmless: re-adopting the same org id is idempotent.
  }
}
```
- [ ] **Step 4: Run — confirm pass.** `cd ui && pnpm exec vitest run src/onboarding/__tests__/pendingTenant.test.ts`
  Expected: `Test Files 1 passed` · `Tests 5 passed`.
- [ ] **Step 5: Commit.**
```
git add ui/src/onboarding/pendingTenant.ts ui/src/onboarding/__tests__/pendingTenant.test.ts
git commit -m "$(cat <<'EOF'
feat(onboarding): add pendingTenant localStorage durability module

Mirrors pendingOrganization for the multi-tenant Organization step so a
reload between the org step and the company step can adopt the created org
instead of minting a ghost (Fix 3a).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.2 — `CreateOrganizationStep`: adopt on reload, persist after create, guard against duplicate POST

**Files:**
- Modify: `ui/src/onboarding/steps/CreateOrganizationStep.tsx` (imports line 1–6; body 28–48; JSX 50–83 unchanged)
- Modify (test): `ui/src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx` (add `beforeEach` + reload cases)

The mount effect reads a persisted tenant and auto-advances (adopt, no re-create). `submit` persists the tenant BEFORE `onComplete` and uses `createdRef` so a same-mount retry never mints a second org. **`beforeEach` clearing localStorage is REQUIRED:** the new `submit` writes localStorage on success, so without a per-test reset the existing "surfaces a create failure" test would auto-adopt a leftover hint and break.

- [ ] **Step 1: Write the failing tests.** In `ui/src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx`, change the vitest import to add `beforeEach`, add a `beforeEach` + a `setOrganizationId` spy, and add two reload cases. Replace the current header (lines 1–16) and add tests inside the existing `describe("CreateOrganizationStep", …)`.

  The **only** change to the header is adding `beforeEach` to the vitest import. The current line 2 is `import { describe, it, expect, vi } from "vitest";`; add `beforeEach` so it reads `import { describe, it, expect, vi, beforeEach } from "vitest";`. Everything else in the block below (original lines 1 and 3-16) is shown unchanged for context, not to be rewritten:
```ts
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreateOrganizationStep } from "../CreateOrganizationStep";
import { validateRegistry, type StepContext } from "../../registry";
import { ONBOARDING_STEPS } from "../index";

const createOrg = vi.fn(async (_: { name: string }) => ({ id: "org1", name: "Acme" }));
vi.mock("../../../api/organizations", () => ({ organizationsApi: { create: (a: any) => createOrg(a) } }));

const ctx: StepContext = {
  userId: "u1",
  journey: "founder",
  companyId: null,
  completedStates: ["AUTHENTICATED", "PROFILE_SET"],
  organizationId: null,
};
```
  Add a `beforeEach` as the FIRST statement inside `describe("CreateOrganizationStep", () => {` (immediately after the opening brace on the current line 18):
```ts
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });
```
  Add these two tests inside the same `describe` block (after the existing "surfaces a create failure" test, before the describe closes at the current line 57):
```ts
  it("persists a pending tenant on create (before completing)", async () => {
    const onComplete = vi.fn();
    const setOrganizationId = vi.fn();
    render(
      <CreateOrganizationStep
        ctx={{ ...ctx, setOrganizationId }}
        onComplete={onComplete}
        onBack={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(createOrg).toHaveBeenCalledTimes(1);
    expect(setOrganizationId).toHaveBeenCalledWith("org1");
    expect(localStorage.getItem("aoa.onboarding.pendingTenant.u1")).toContain('"id":"org1"');
  });

  it("does NOT create a second org after a reload (remount) — adopts the persisted tenant", async () => {
    const setOrganizationId = vi.fn();

    // First mount: create the org.
    const firstComplete = vi.fn();
    const first = render(
      <CreateOrganizationStep
        ctx={{ ...ctx, setOrganizationId }}
        onComplete={firstComplete}
        onBack={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(firstComplete).toHaveBeenCalled());
    expect(createOrg).toHaveBeenCalledTimes(1);

    // Simulate a hard reload between the org step and the company step: the
    // component unmounts and remounts, but localStorage survives.
    first.unmount();
    setOrganizationId.mockClear();

    const secondComplete = vi.fn();
    render(
      <CreateOrganizationStep
        ctx={{ ...ctx, setOrganizationId }}
        onComplete={secondComplete}
        onBack={() => {}}
      />,
    );
    // Adopts the persisted org id and advances WITHOUT a second POST.
    await waitFor(() => expect(secondComplete).toHaveBeenCalled());
    expect(setOrganizationId).toHaveBeenCalledWith("org1");
    expect(createOrg).toHaveBeenCalledTimes(1);
  });
```
- [ ] **Step 2: Run — confirm the new tests fail.** `cd ui && pnpm exec vitest run src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx`
  Expected: the two new tests fail — "persists a pending tenant" fails on `localStorage.getItem(...)` being `null` (submit does not write yet); "does NOT create a second org after a reload" fails with `createOrg` called `2` times (remount re-creates). Existing 5 tests still pass.
- [ ] **Step 3: Implement the durability + adopt logic.** Rewrite the top of `ui/src/onboarding/steps/CreateOrganizationStep.tsx`. Change the import (current line 1):
```ts
import { useEffect, useRef, useState } from "react";
```
  Add the pendingTenant import after the organizationsApi import (current line 3):
```ts
import {
  readPendingTenant,
  writePendingTenant,
  type PendingTenant,
} from "../pendingTenant";
```
  Replace the component body from the function signature through the end of `submit` (current lines 28–48) with:
```ts
export function CreateOrganizationStep({ ctx, onComplete }: StepProps) {
  // Reload durability (Fix 3a): a tenant persisted on a prior mount means the
  // org was already created — a hard reload between this step and the company
  // step must NOT POST a second (ghost) organization. Mirror OrgStep's
  // pendingOrganization pattern: read once at mount into a ref, then adopt it
  // instead of re-creating.
  const [pendingAtMount] = useState(() => readPendingTenant(ctx.userId));
  const [name, setName] = useState(pendingAtMount?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createdRef = useRef<PendingTenant | null>(pendingAtMount);

  // Auto-resolve on mount when a persisted tenant exists (post-reload / strand
  // resume): adopt its id and advance to the company step without re-creating.
  useEffect(() => {
    if (!pendingAtMount) return;
    ctx.setOrganizationId?.(pendingAtMount.id);
    onComplete();
    // Mount-only: pendingAtMount is frozen for this mount; re-running on
    // ctx/onComplete identity changes would double-advance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    // Same-mount retry after a downstream failure: reuse the already-created org.
    if (createdRef.current) {
      ctx.setOrganizationId?.(createdRef.current.id);
      onComplete();
      return;
    }
    if (!name.trim()) {
      setError("Please enter a name for your organization.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const org = await organizationsApi.create({ name: name.trim() });
      const pending: PendingTenant = { id: org.id, name: org.name };
      createdRef.current = pending;
      // Persist BEFORE onComplete so a reload during the engine's re-read still
      // finds the recovery hint (OrgStep clears it once the company consumes it).
      writePendingTenant(ctx.userId, pending);
      ctx.setOrganizationId?.(org.id);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create your organization.");
      setBusy(false);
    }
  };
```
  (The JSX `return (…)` at current lines 50–83 is unchanged.)
- [ ] **Step 4: Run — confirm pass.** `cd ui && pnpm exec vitest run src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx`
  Expected: `Test Files 1 passed` · `Tests 7 passed` (5 existing + 2 new). Note the existing "surfaces a create failure" test now relies on the `beforeEach` localStorage.clear — verify it is still green.
- [ ] **Step 5: Commit.**
```
git add ui/src/onboarding/steps/CreateOrganizationStep.tsx ui/src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx
git commit -m "$(cat <<'EOF'
fix(onboarding): make the tenant step reload-durable (no ghost org)

CreateOrganizationStep now persists the created org to pendingTenant before
completing and adopts a persisted tenant on remount, so a hard reload between
the org step and the company step no longer POSTs a duplicate organization.
createdRef guards same-mount retries (Fix 3a).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.3 — `OrgStep` clears the pending tenant when the company consumes the org

**Files:**
- Modify: `ui/src/onboarding/steps/OrgStep.tsx` (import block lines 6–11; call sites lines 91 and 110)
- Modify (test): `ui/src/onboarding/steps/__tests__/OrgStep.test.tsx` (add one case)

Clear the tenant hint only AFTER the company create+advance succeeds (design: "clear on company-create, not before"), at both existing `clearPendingOrganization` sites (the normal submit path and the revisited re-advance path).

- [ ] **Step 1: Write the failing test.** Add this case inside `describe("OrgStep (Stage C / order 2)", …)` in `ui/src/onboarding/steps/__tests__/OrgStep.test.tsx` (after the existing "creates the company…" test):
```ts
  it("clears the pending tenant once the company consumes the org", async () => {
    localStorage.setItem(
      "aoa.onboarding.pendingTenant.u1",
      JSON.stringify({ id: "org1", name: "Acme Org" }),
    );
    const onComplete = vi.fn();
    render(<OrgStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Acme" } });
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(localStorage.getItem("aoa.onboarding.pendingTenant.u1")).toBeNull();
  });
```
  (This file already has `beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); })`, so the hint is seeded inside the test after the reset.)
- [ ] **Step 2: Run — confirm it fails.** `cd ui && pnpm exec vitest run src/onboarding/steps/__tests__/OrgStep.test.tsx`
  Expected: the new test fails — after company create the tenant hint is still present, so `localStorage.getItem("aoa.onboarding.pendingTenant.u1")` is the seeded JSON string, not `null`.
- [ ] **Step 3: Implement the clear.** In `ui/src/onboarding/steps/OrgStep.tsx`, add the import after the existing `pendingOrganization` import block (which ends at line 11):
```ts
import { clearPendingTenant } from "../pendingTenant";
```
  Then add `clearPendingTenant(ctx.userId);` immediately after EACH `clearPendingOrganization(ctx.userId);` (lines 91 and 110). Use a single replace-all: replace
```ts
      clearPendingOrganization(ctx.userId);
```
  with
```ts
      clearPendingOrganization(ctx.userId);
      clearPendingTenant(ctx.userId);
```
  (both occurrences — the submit-success path at line 91 and the `continueRevisited` path at line 110).
- [ ] **Step 4: Run — confirm pass.** `cd ui && pnpm exec vitest run src/onboarding/steps/__tests__/OrgStep.test.tsx`
  Expected: `Test Files 1 passed` · `Tests 10 passed` (9 existing + 1 new). The existing test that asserts `pendingOrganization.u1` is null (line ≈63) is unaffected.
- [ ] **Step 5: Commit.**
```
git add ui/src/onboarding/steps/OrgStep.tsx ui/src/onboarding/steps/__tests__/OrgStep.test.tsx
git commit -m "$(cat <<'EOF'
fix(onboarding): clear pendingTenant when the company consumes the org

Once OrgStep creates the company + advances COMPANY_CREATED, the tenant
recovery hint is no longer needed; clear it alongside pendingOrganization at
both the submit and revisited re-advance paths (Fix 3a).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.4 — Server strand-resume signal (`resumeCompanyCreationOrgId`) + index-gate routing

**Files:**
- Modify: `packages/shared/src/onboarding.ts` (add field to `PostAuthJourneyResult`, after line 131)
- Modify: `server/src/routes/onboarding-journey.ts` (imports line 12 + 14; new block after line 216)
- Modify (test): `server/src/__tests__/onboarding-journey-route.test.ts` (add 2 resolver cases)
- Modify: `ui/src/App.tsx` (import after line 8; `LobbyOrOnboardingRedirect` lines 295–323)

The signal is computed from rows already fetched in `getJourneyForUser` (`orgMembershipRows` + `returningCompanyIds`) — **no new DB query, no write** (respects the P3 no-owner-dedup constraint). It fires only for a `returning` user with ZERO company memberships who holds a **create-capable** (owner/admin) org role — scoping to create-capable roles means a cross-invited `member` (P5, who anyway always has a company membership) never triggers it, and we never route a user to a create-company screen they'd 403 on. The index gate seeds the pending-tenant hint (Task 3.1/3.2) for that org and resumes into `/onboarding`, where CreateOrganizationStep adopts it and drops the user at the company step.

- [ ] **Step 1: Write the failing resolver tests.** Add these two cases to `server/src/__tests__/onboarding-journey-route.test.ts`, inside `describe("getJourneyForUser (A5 + RB7/RB9 wiring)", …)` (e.g. right after the "returning via ORGANIZATION membership alone" test at line ≈135). The 5-result seqDb shape matches that test's ordering (user, company memberships, org memberships, pending, open invites — no resume query runs because `returningCompanyIds` is empty):
```ts
  it("returning ORG-OWNER with ZERO companies → resumeCompanyCreationOrgId set (strand resume)", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }], // user
      [], // company memberships — none yet
      [{ organizationId: "org1", role: "owner" }], // org memberships — owns a fresh tenant
      [], // pending requests
      [], // open invites
      // NOTE: no resume-first-run query runs (returningCompanyIds is empty).
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("returning");
    expect(r.targetCompanyId).toBeNull();
    expect(r.resumeCompanyCreationOrgId).toBe("org1");
  });

  it("returning MEMBER (not create-capable) with zero companies → no company-creation resume", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }], // user
      [], // company memberships — none
      [{ organizationId: "org1", role: "member" }], // cross-invited member, not owner/admin
      [], // pending requests
      [], // open invites
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("returning");
    expect(r.resumeCompanyCreationOrgId ?? null).toBeNull();
  });
```
- [ ] **Step 2: Run — confirm the new tests fail.** `cd server && pnpm exec vitest run src/__tests__/onboarding-journey-route.test.ts`
  Expected: the owner case fails — `resumeCompanyCreationOrgId` is `undefined`, not `"org1"` (the field/logic does not exist yet). The member case passes vacuously (`undefined ?? null === null`). Existing cases stay green.
- [ ] **Step 3: Add the shared type field.** In `packages/shared/src/onboarding.ts`, insert into `PostAuthJourneyResult` immediately BEFORE the closing `};` (i.e. after the `resumeFirstRunCompanyId?: string | null;` at line 131):
```ts
  /**
   * A `returning` founder who OWNS (owner/admin) an org but has created ZERO
   * companies — the empty-Lobby strand: the org was created (e.g. a reload
   * minted/kept it) but the company step was never reached. The index gate seeds
   * a pending-tenant recovery hint for this org and resumes them into
   * `/onboarding` at the company step, rather than stranding them on an empty
   * Lobby. Only ever set for `journey === "returning"` with no company
   * membership; null otherwise. Scoped to create-capable roles so a cross-invited
   * `member` never triggers it (and never lands on a create-company screen they'd
   * 403 on).
   */
  resumeCompanyCreationOrgId?: string | null;
```
- [ ] **Step 4: Compute the signal in the route service.** In `server/src/routes/onboarding-journey.ts`:
  Add `OrganizationRole` to the shared type import (current line 12):
```ts
import type { PostAuthJourneyResult, PendingInvitation, OrganizationRole } from "@armyofagents/shared";
```
  Add `orgRoleCan` to the organization-access import (current line 14):
```ts
import { organizationAccessService, orgRoleCan } from "../services/organization-access.js";
```
  Insert this block AFTER the existing `resumeFirstRunCompanyId` block closes (after line 216) and BEFORE `return result;` (line 218):
```ts
  // Empty-Lobby strand resume (Fix 3b): a `returning` founder who is an
  // OWNER/ADMIN of an org but holds ZERO company memberships created the org
  // step then never made a company (e.g. a reload minted/kept the org, then they
  // landed on an empty Lobby). Route them back into company creation UNDER that
  // org. Computed purely from rows already fetched above — NO extra query, NO
  // write (the ghost-org fix is client durability; no owner-dedup on
  // POST /organizations). Scoped to create-capable roles so a cross-invited
  // `member` (P5) — who anyway always holds a company membership, making
  // returningCompanyIds non-empty for them — never triggers it, and so we never
  // send a user to a create-company screen they'd 403 on. Mutually exclusive with
  // the resumeFirstRunCompanyId branch above (that requires returningCompanyIds
  // non-empty), so the query sequence is unchanged.
  if (result.journey === "returning" && returningCompanyIds.length === 0) {
    const creatable = orgMembershipRows.find((row) =>
      orgRoleCan(row.role as OrganizationRole, "company:create"),
    );
    result.resumeCompanyCreationOrgId = creatable?.organizationId ?? null;
  }
```
- [ ] **Step 5: Run — confirm the resolver tests pass.** `cd server && pnpm exec vitest run src/__tests__/onboarding-journey-route.test.ts`
  Expected: `Test Files 1 passed`; all cases green including the 2 new ones. (Sanity: the existing "returning via ORGANIZATION membership alone" test at line ≈124 still passes — its mock org row omits `role`, so `orgRoleCan(undefined, …)` is `false` → `resumeCompanyCreationOrgId` resolves to `null`, and that test never asserts the field.)
- [ ] **Step 6: Wire the index-gate routing (App.tsx).** In `ui/src/App.tsx`, add the import after the `fetchJourney` import (current line 8):
```ts
import { writePendingTenant } from "./onboarding/pendingTenant";
```
  Replace the entire `LobbyOrOnboardingRedirect` function (current lines 295–323) with:
```tsx
// The index gate (Stage B / B7). Fetches the post-auth journey and redirects a
// founder to /onboarding, an invited user to /onboarding/join; a returning user
// sees the Lobby (with their pending invitations surfaced there).
function LobbyOrOnboardingRedirect() {
  const navigate = useNavigate();
  const { setSelectedCompanyId } = useCompany();
  const { data, isLoading } = useQuery({
    queryKey: ["onboarding", "journey"],
    queryFn: () => fetchJourney(),
    retry: false,
  });
  // Only needed to key the pending-tenant recovery hint for the strand-resume
  // branch below; deduped against CloudAccessGate's own session query, so this is
  // effectively free (returns the warm cache).
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  useEffect(() => {
    if (!data) return;
    if (data.journey === "founder") {
      navigate("/onboarding", { replace: true });
    } else if (data.journey === "invited") {
      navigate(`/onboarding/join?company=${data.targetCompanyId ?? ""}`, { replace: true });
    } else if (data.resumeFirstRunCompanyId) {
      // Returning founder who abandoned their first-run tail: select that company
      // and drop them back into /onboarding to finish it. The spine is already
      // complete, so OnboardingFlow's FlowEngine resolves no step and jumps
      // straight to the inline tail — onboarding never appears on the dashboard.
      setSelectedCompanyId(data.resumeFirstRunCompanyId);
      navigate("/onboarding", { replace: true });
    } else if (data.resumeCompanyCreationOrgId) {
      // Empty-Lobby strand (Fix 3b): a founder who created their org but never a
      // company. Wait for the session so we can key the hint (the effect re-runs
      // when it loads); seed the tenant recovery hint (mirrors the org step's own
      // localStorage durability) so CreateOrganizationStep ADOPTS this org instead
      // of minting a ghost, then resume into /onboarding at the company step.
      if (!session?.user?.id) return;
      writePendingTenant(session.user.id, { id: data.resumeCompanyCreationOrgId, name: "" });
      navigate("/onboarding", { replace: true });
    }
  }, [data, navigate, setSelectedCompanyId, session]);
  if (isLoading) return <RouteFallback />;
  // Redirecting (founder / invited) OR resuming an unfinished founder tail OR the
  // empty-Lobby strand — render nothing so the Lobby doesn't flash underneath
  // before the redirect.
  if (
    data &&
    (data.journey !== "returning" ||
      data.resumeFirstRunCompanyId ||
      data.resumeCompanyCreationOrgId)
  )
    return null;
  return <Lobby pendingInvitations={data?.pendingInvitations ?? []} />;
}
```
- [ ] **Step 7: Typecheck the touched packages (no dedicated App.tsx unit test — routing is covered by the Tier A harness, assembled task #21).** Run from repo root:
```
pnpm --filter @armyofagents/shared typecheck && pnpm --filter @armyofagents/server typecheck && pnpm --filter @armyofagents/ui typecheck
```
  Expected: no errors (the new `resumeCompanyCreationOrgId` field, `orgRoleCan`/`OrganizationRole` imports, and the App.tsx `writePendingTenant`/`session` usages all resolve).
- [ ] **Step 8: Re-run the full onboarding-journey suite + the three UI suites to confirm nothing regressed.**
```
pnpm --filter @armyofagents/server exec vitest run src/__tests__/onboarding-journey-route.test.ts
pnpm --filter @armyofagents/ui exec vitest run src/onboarding/__tests__/pendingTenant.test.ts src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx src/onboarding/steps/__tests__/OrgStep.test.tsx
```
  Expected: all green.
- [ ] **Step 9: Commit.**
```
git add packages/shared/src/onboarding.ts server/src/routes/onboarding-journey.ts server/src/__tests__/onboarding-journey-route.test.ts ui/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(onboarding): resume org-owner-with-0-companies into company creation

getJourneyForUser now emits resumeCompanyCreationOrgId for a returning founder
who owns (owner/admin) an org but has no companies — computed from already
fetched rows, no new query and no owner-dedup on POST /organizations (P3). The
index gate seeds the pendingTenant hint for that org and resumes into
/onboarding, where CreateOrganizationStep adopts it and lands the user on the
company step instead of an empty Lobby (Fix 3b).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

**Fix 3 done-when:** `pendingTenant` module + tests green; `CreateOrganizationStep` adopts on remount and POSTs exactly once across a reload (jsdom test proves `organizationsApi.create` called once); `OrgStep` clears the hint on company-create; the server emits `resumeCompanyCreationOrgId` only for create-capable org owners with 0 companies (2 resolver tests) and the index gate seeds+routes it. End-to-end "org-owner with 0 companies hitting `/` lands in company creation, not an empty Lobby" is asserted in the Tier A 4-actor embedded-PG harness (assembled task #21).

---

## Fix 2 — Multi-org create-company (auto-pick own create-capable org, no picker)

**Design:** `docs/aoa/plans/2026-07-31-mt-journey-correctness-fixes-design.md` § "Fix 2" + decision P1.
**Nature:** UI-only. Zero server contract change (`server/src/routes/companies.ts:42-71` already honors an explicit `organizationId` and re-authorizes via `canOrg`; `server/src/__tests__/companies-org-scope.test.ts` stays green untouched).

**Root cause (grounded).** The only product path to "create another company" is `/onboarding?new=1` (`ui/src/pages/Companies.tsx:101`, `ui/src/components/LobbyLayout.tsx:33`). `OnboardingFlow.tsx:104` hardcodes `organizationId: null`; `OrgStep.tsx:83` omits it; for a founder in ≥2 orgs the server 403s "you belong to multiple organizations" (`companies.ts:50-54`), rendered raw in `OrgStep.tsx:94`. Single-org founders are unaffected (server auto-picks their one org, `companies.ts:49`).

**Approach.** Before the company step, in **cloud_auth only** (`health.deploymentMode === "cloud_auth"`), call `organizationsApi.list()`, filter to create-capable orgs (`role ∈ {owner, admin}`, per `server/src/services/organization-access.ts` MATRIX), then: exactly one → auto-pick + send its id; zero → `CreateOrganizationStep`; ≥2 → friendly `EmptyState` message (never a raw 403, never a picker). Self-hosted keeps today's omit-the-id behavior. Correct the stale "server derives DEFAULT_ORGANIZATION_ID" comments (which describe the self-hosted branch only).

**Windows/test invocation.** Every test here is a UI jsdom test (Windows-safe). Run each from **repo root** with:
`pnpm exec vitest run --root ui <repo-relative-path>` (verified working: root resolves to `.../ui`, positional `ui/src/...` path matches). No `initdbFlags`/skip-flag dance — that is only for `server/**/*.integration.test.ts`, and Fix 2 has none.

---

### Task 2.1 — Pure resolver `resolveCreateCompanyOrg`

**Files:**
- Create `ui/src/onboarding/resolveCreateCompanyOrg.ts`
- Test: create `ui/src/onboarding/__tests__/resolveCreateCompanyOrg.test.ts`

- [ ] **Step 1: Write the failing unit test.** Create `ui/src/onboarding/__tests__/resolveCreateCompanyOrg.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveCreateCompanyOrg } from "../resolveCreateCompanyOrg";
import type { OrganizationMembership } from "../../api/organizations";

const m = (over: Partial<OrganizationMembership>): OrganizationMembership => ({
  id: "mem-1",
  organizationId: "org",
  userId: "u1",
  role: "owner",
  status: "active",
  ...over,
});

describe("resolveCreateCompanyOrg", () => {
  it("one create-capable org among mixed roles -> auto-picks it (orgA owner, orgB member)", () => {
    expect(
      resolveCreateCompanyOrg([
        m({ id: "m1", organizationId: "orgA", role: "owner" }),
        m({ id: "m2", organizationId: "orgB", role: "member" }),
      ]),
    ).toEqual({ kind: "org", organizationId: "orgA" });
  });

  it("admin also counts as create-capable", () => {
    expect(resolveCreateCompanyOrg([m({ organizationId: "orgA", role: "admin" })])).toEqual({
      kind: "org",
      organizationId: "orgA",
    });
  });

  it("no create-capable orgs (member + billing) -> needs-org", () => {
    expect(
      resolveCreateCompanyOrg([
        m({ id: "m1", organizationId: "orgB", role: "member" }),
        m({ id: "m2", organizationId: "orgC", role: "billing" }),
      ]),
    ).toEqual({ kind: "needs-org" });
  });

  it("empty memberships -> needs-org", () => {
    expect(resolveCreateCompanyOrg([])).toEqual({ kind: "needs-org" });
  });

  it("two or more create-capable orgs -> ambiguous (no picker)", () => {
    expect(
      resolveCreateCompanyOrg([
        m({ id: "m1", organizationId: "orgA", role: "owner" }),
        m({ id: "m2", organizationId: "orgB", role: "admin" }),
      ]),
    ).toEqual({ kind: "ambiguous", organizationIds: ["orgA", "orgB"] });
  });

  it("dedupes multiple create-capable memberships in the same org", () => {
    expect(
      resolveCreateCompanyOrg([
        m({ id: "m1", organizationId: "orgA", role: "owner" }),
        m({ id: "m2", organizationId: "orgA", role: "admin" }),
      ]),
    ).toEqual({ kind: "org", organizationId: "orgA" });
  });
});
```

- [ ] **Step 2: Run — confirm it fails (module missing).**
`pnpm exec vitest run --root ui ui/src/onboarding/__tests__/resolveCreateCompanyOrg.test.ts`
Expected: collect error `Failed to resolve import "../resolveCreateCompanyOrg"` → `Test Files 1 failed`.

- [ ] **Step 3: Create the resolver.** Create `ui/src/onboarding/resolveCreateCompanyOrg.ts`:
```ts
import type { OrganizationMembership } from "../api/organizations";

/**
 * Fix 2 (design P1). Given the caller's org memberships (GET /organizations =
 * organizationsApi.list()), decide which Organization a *new* company should be
 * created under. Only owner/admin may create companies (the MATRIX in
 * server/src/services/organization-access.ts), so filter to those
 * "create-capable" roles first:
 *   - exactly one create-capable org -> "org": auto-pick it silently.
 *   - zero                           -> "needs-org": mint one first
 *                                       (CreateOrganizationStep).
 *   - two or more                    -> "ambiguous": a friendly message, not a
 *                                       picker (YAGNI in the beta).
 * The "org" case always carries a concrete id — cloud_auth requires an explicit
 * organizationId (the server never guesses for a >=2-org founder).
 */
export type CreateCompanyOrgResolution =
  | { kind: "org"; organizationId: string }
  | { kind: "needs-org" }
  | { kind: "ambiguous"; organizationIds: string[] };

const CREATE_CAPABLE_ROLES: ReadonlySet<OrganizationMembership["role"]> = new Set([
  "owner",
  "admin",
]);

export function resolveCreateCompanyOrg(
  memberships: OrganizationMembership[],
): CreateCompanyOrgResolution {
  const organizationIds = [
    ...new Set(
      memberships
        .filter((membership) => CREATE_CAPABLE_ROLES.has(membership.role))
        .map((membership) => membership.organizationId),
    ),
  ];
  if (organizationIds.length === 1) {
    return { kind: "org", organizationId: organizationIds[0]! };
  }
  if (organizationIds.length === 0) return { kind: "needs-org" };
  return { kind: "ambiguous", organizationIds };
}
```

- [ ] **Step 4: Run — confirm green.**
`pnpm exec vitest run --root ui ui/src/onboarding/__tests__/resolveCreateCompanyOrg.test.ts`
Expected: `Test Files 1 passed (1)` / `Tests 6 passed (6)`.

- [ ] **Step 5: Commit.**
```
git add ui/src/onboarding/resolveCreateCompanyOrg.ts ui/src/onboarding/__tests__/resolveCreateCompanyOrg.test.ts
git commit -m "$(cat <<'EOF'
feat(onboarding): create-company org resolver (Fix 2, P1)

Pure resolver: filter org memberships to create-capable roles
(owner/admin) and classify as org/needs-org/ambiguous.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.2 — `CreateAnotherCompany` component (cloud-aware resolution + render)

**Files:**
- Modify `ui/src/lib/queryKeys.ts` (add `organizations` key after the `companies` block, ends line 6)
- Create `ui/src/onboarding/CreateAnotherCompany.tsx`
- Test: create `ui/src/onboarding/__tests__/CreateAnotherCompany.test.tsx`

- [ ] **Step 1: Add the `organizations` query key.** In `ui/src/lib/queryKeys.ts`, after the `companies` block (lines 2-6):
```ts
  companies: {
    all: ["companies"] as const,
    detail: (id: string) => ["companies", id] as const,
    stats: ["companies", "stats"] as const,
  },
```
insert:
```ts
  organizations: {
    list: ["organizations"] as const,
  },
```

- [ ] **Step 2: (No edit here — `ui/src/api/health.ts` is widened by Fix 1.)** Fix 1 lands first (build order) and widens the `deploymentMode` union at `ui/src/api/health.ts` line 7 to `"local_trusted" | "authenticated" | "cloud_auth"`. Fix 2 **depends** on that widened union for its `isCloud` check (`healthQuery.data?.deploymentMode === "cloud_auth"`) but must **not** re-edit `health.ts` and must **not** `git add` it in this fix. (Assembler note: the duplicate widen originally in this step was removed to avoid a double edit against the same line, per the plan review cross-fix conflict; confirm Fix 1 has landed before starting Fix 2.)

- [ ] **Step 3: Write the failing component test.** Create `ui/src/onboarding/__tests__/CreateAnotherCompany.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../../__tests__/test-utils";
import { CreateAnotherCompany } from "../CreateAnotherCompany";
import type { OrganizationMembership } from "../../api/organizations";

const state = vi.hoisted(() => ({
  health: { deploymentMode: "cloud_auth" } as { deploymentMode: string },
  orgs: [] as OrganizationMembership[],
  orgStepProps: null as unknown as {
    ctx: { organizationId: string | null; companyId: string | null };
    onComplete: () => void;
  },
  createOrgProps: null as unknown as {
    ctx: { setOrganizationId?: (id: string) => void };
    onComplete: () => void;
  },
}));

vi.mock("../../api/health", () => ({
  healthApi: { get: () => Promise.resolve(state.health) },
}));
vi.mock("../../api/organizations", () => ({
  organizationsApi: { list: () => Promise.resolve(state.orgs) },
}));
vi.mock("../steps/OrgStep", () => ({
  OrgStep: (props: {
    ctx: { organizationId: string | null; companyId: string | null };
    onComplete: () => void;
  }) => {
    state.orgStepProps = props;
    return <div>org-step</div>;
  },
}));
vi.mock("../steps/CreateOrganizationStep", () => ({
  CreateOrganizationStep: (props: {
    ctx: { setOrganizationId?: (id: string) => void };
    onComplete: () => void;
  }) => {
    state.createOrgProps = props;
    return (
      <button type="button" onClick={() => props.ctx.setOrganizationId?.("orgNEW")}>
        mint-org
      </button>
    );
  },
}));

const membership = (over: Partial<OrganizationMembership>): OrganizationMembership => ({
  id: "mem-1",
  organizationId: "org",
  userId: "u1",
  role: "owner",
  status: "active",
  ...over,
});

describe("CreateAnotherCompany", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.health = { deploymentMode: "cloud_auth" };
    state.orgs = [];
    state.orgStepProps = null as never;
    state.createOrgProps = null as never;
  });

  it("cloud_auth + one create-capable org: auto-picks it and sends its id to the company step", async () => {
    state.orgs = [
      membership({ id: "m1", organizationId: "orgA", role: "owner" }),
      membership({ id: "m2", organizationId: "orgB", role: "member" }),
    ];
    const onCompleteCompany = vi.fn();
    renderWithProviders(
      <CreateAnotherCompany
        userId="u1"
        journey="founder"
        onCompleteCompany={onCompleteCompany}
        onBack={() => {}}
      />,
    );
    await screen.findByText("org-step");
    expect(state.orgStepProps.ctx.organizationId).toBe("orgA");
    expect(state.orgStepProps.ctx.companyId).toBeNull();
    state.orgStepProps.onComplete();
    expect(onCompleteCompany).toHaveBeenCalled();
  });

  it("cloud_auth + two create-capable orgs: friendly message, no picker and no company step", async () => {
    state.orgs = [
      membership({ id: "m1", organizationId: "orgA", role: "owner" }),
      membership({ id: "m2", organizationId: "orgB", role: "admin" }),
    ];
    const onBack = vi.fn();
    renderWithProviders(
      <CreateAnotherCompany
        userId="u1"
        journey="founder"
        onCompleteCompany={() => {}}
        onBack={onBack}
      />,
    );
    expect(await screen.findByText(/pick an organization/i)).toBeTruthy();
    expect(screen.queryByText("org-step")).toBeNull();
    fireEvent.click(screen.getByText(/back to your workspace/i));
    expect(onBack).toHaveBeenCalled();
  });

  it("cloud_auth + zero create-capable orgs: routes to CreateOrganizationStep, then into the company step under the new org", async () => {
    state.orgs = [membership({ id: "m1", organizationId: "orgB", role: "member" })];
    renderWithProviders(
      <CreateAnotherCompany
        userId="u1"
        journey="founder"
        onCompleteCompany={() => {}}
        onBack={() => {}}
      />,
    );
    fireEvent.click(await screen.findByText("mint-org"));
    await screen.findByText("org-step");
    expect(state.orgStepProps.ctx.organizationId).toBe("orgNEW");
  });

  it("self-hosted (not cloud_auth): omits the org id so the server derives the default sentinel", async () => {
    state.health = { deploymentMode: "authenticated" };
    renderWithProviders(
      <CreateAnotherCompany
        userId="u1"
        journey="founder"
        onCompleteCompany={() => {}}
        onBack={() => {}}
      />,
    );
    await screen.findByText("org-step");
    expect(state.orgStepProps.ctx.organizationId).toBeNull();
  });
});
```

- [ ] **Step 4: Run — confirm it fails (component missing).**
`pnpm exec vitest run --root ui ui/src/onboarding/__tests__/CreateAnotherCompany.test.tsx`
Expected: collect error `Failed to resolve import "../CreateAnotherCompany"` → `Test Files 1 failed`.

- [ ] **Step 5: Create the component.** Create `ui/src/onboarding/CreateAnotherCompany.tsx`:
```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OnboardingJourney, OnboardingState } from "@armyofagents/shared";
import { healthApi } from "../api/health";
import { organizationsApi } from "../api/organizations";
import { queryKeys } from "../lib/queryKeys";
import { OrgStep } from "./steps/OrgStep";
import { CreateOrganizationStep } from "./steps/CreateOrganizationStep";
import type { StepContext } from "./registry";
import { resolveCreateCompanyOrg } from "./resolveCreateCompanyOrg";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";

const BASE_COMPLETED: OnboardingState[] = ["AUTHENTICATED", "PROFILE_SET"];

/**
 * The standalone "create another company" surface (OnboardingFlow `?new=1`).
 * Fix 2 (design P1): in cloud_auth we must hand the company step an EXPLICIT
 * create-capable Organization id — the server 403s a >=2-org founder who omits
 * it and never guesses (companies.ts:50-54). We resolve it from the founder's
 * own org memberships: exactly one create-capable org -> auto-pick; zero ->
 * mint one via CreateOrganizationStep; >=2 -> a friendly message (no picker).
 * Self-hosted preserves the prior behavior: omit the id and let the server
 * derive DEFAULT_ORGANIZATION_ID (companies.ts:56).
 */
export function CreateAnotherCompany({
  userId,
  journey,
  onCompleteCompany,
  onBack,
}: {
  userId: string;
  journey: OnboardingJourney;
  onCompleteCompany: () => void;
  onBack: () => void;
}) {
  // Set once CreateOrganizationStep mints a fresh org (the zero-org branch); it
  // then overrides the resolver and drops us into the company step under it.
  const [chosenOrgId, setChosenOrgId] = useState<string | null>(null);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const isCloud = healthQuery.data?.deploymentMode === "cloud_auth";

  const orgsQuery = useQuery({
    queryKey: queryKeys.organizations.list,
    queryFn: () => organizationsApi.list(),
    enabled: isCloud,
    retry: false,
  });

  const buildCtx = (organizationId: string | null): StepContext => ({
    userId,
    companyId: null,
    journey,
    completedStates: BASE_COMPLETED,
    organizationId,
    setOrganizationId: (id: string) => setChosenOrgId(id),
  });

  const loading = <p className="text-sm text-dim">Loading…</p>;

  if (healthQuery.isLoading) return loading;

  // Self-hosted (or health unresolved): preserve prior behavior — omit the org
  // id (null) so the server derives DEFAULT_ORGANIZATION_ID. No org lookup here.
  if (!isCloud) {
    return <OrgStep ctx={buildCtx(null)} onComplete={onCompleteCompany} onBack={onBack} />;
  }

  // cloud_auth: reuse a just-minted org if we took the zero-org branch.
  if (chosenOrgId) {
    return <OrgStep ctx={buildCtx(chosenOrgId)} onComplete={onCompleteCompany} onBack={onBack} />;
  }

  if (orgsQuery.isLoading) return loading;
  if (!orgsQuery.data) {
    return (
      <EmptyState
        title="Couldn't load your organizations"
        description="We couldn't reach your organizations just now. Go back and try again."
        action={
          <Button variant="secondary" onClick={onBack}>
            Back to your workspace
          </Button>
        }
      />
    );
  }

  const resolution = resolveCreateCompanyOrg(orgsQuery.data);
  if (resolution.kind === "org") {
    return (
      <OrgStep
        ctx={buildCtx(resolution.organizationId)}
        onComplete={onCompleteCompany}
        onBack={onBack}
      />
    );
  }
  if (resolution.kind === "needs-org") {
    // Zero create-capable orgs: mint one; setOrganizationId re-renders into the
    // company step under it. onComplete is a no-op — the state change drives it.
    return <CreateOrganizationStep ctx={buildCtx(null)} onComplete={() => {}} onBack={onBack} />;
  }
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
}
```

- [ ] **Step 6: Run — confirm green.**
`pnpm exec vitest run --root ui ui/src/onboarding/__tests__/CreateAnotherCompany.test.tsx`
Expected: `Test Files 1 passed (1)` / `Tests 4 passed (4)`.

- [ ] **Step 7: Commit.**
```
git add ui/src/lib/queryKeys.ts ui/src/onboarding/CreateAnotherCompany.tsx ui/src/onboarding/__tests__/CreateAnotherCompany.test.tsx
git commit -m "$(cat <<'EOF'
feat(onboarding): CreateAnotherCompany org resolution surface (Fix 2, P1)

cloud_auth: auto-pick the founder's single create-capable org, mint
one when zero, friendly message when >=2 (no picker, no raw 403).
Self-hosted keeps omitting the org id (server derives the default).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.3 — Wire `CreateAnotherCompany` into `OnboardingFlow` `?new=1`

**Files:**
- Modify `ui/src/pages/OnboardingFlow.tsx` (imports lines 5 + 11; `?new=1` block lines 89-117)
- Test: modify `ui/src/pages/__tests__/OnboardingFlow.test.tsx` (hoisted state, mock, beforeEach, and the two `?new=1` tests + one assertion in the FlowEngine test)

- [ ] **Step 1: Update the OnboardingFlow test to the new intent (RED first).** Apply these four edits to `ui/src/pages/__tests__/OnboardingFlow.test.tsx`.

  (a) In the `vi.hoisted` state object (lines 6-13), replace the `orgProps` line:
```tsx
  orgProps: null as unknown as { ctx: { companyId: string | null }; onComplete: () => void },
```
  →
```tsx
  newCompanyProps: null as unknown as {
    userId: string;
    journey: string;
    onCompleteCompany: () => void;
    onBack: () => void;
  },
```

  (b) Replace the OrgStep mock (lines 56-61):
```tsx
vi.mock("../../onboarding/steps/OrgStep", () => ({
  OrgStep: (props: { ctx: { companyId: string | null }; onComplete: () => void }) => {
    state.orgProps = props;
    return <div>org-step-direct</div>;
  },
}));
```
  →
```tsx
vi.mock("../../onboarding/CreateAnotherCompany", () => ({
  CreateAnotherCompany: (props: {
    userId: string;
    journey: string;
    onCompleteCompany: () => void;
    onBack: () => void;
  }) => {
    state.newCompanyProps = props;
    return <div>create-another-company</div>;
  },
}));
```

  (c) In `beforeEach`, replace line 87 `state.orgProps = null as never;` with `state.newCompanyProps = null as never;`; and in the "runs the FlowEngine" test replace line 101 `expect(state.orgProps).toBeNull();` with `expect(state.newCompanyProps).toBeNull();`.

  (d) Replace the two `?new=1` tests (lines 128-152):
```tsx
  it("founder + ?new=1: drives org-create directly on the user layer, then resumes clean", async () => {
    state.selectedCompanyId = "existing-co"; // already-complete company must be ignored
    state.searchParams = new URLSearchParams("new=1");
    renderWithProviders(<OnboardingFlowPage journey="founder" />);
    await screen.findByText("org-step-direct");
    expect(state.orgProps.ctx.companyId).toBeNull(); // user layer, not existing-co
    // finishing the org step resumes the NEW company via a clean /onboarding
    state.orgProps.onComplete();
    expect(mockNavigate).toHaveBeenCalledWith("/onboarding", { replace: true });
  });

  it("founder + ?new=1: persists PROFILE_SET before rendering OrgStep for a legacy user", async () => {
    state.searchParams = new URLSearchParams("new=1");
    mockGetOnboardingProgress.mockResolvedValue(null);

    renderWithProviders(<OnboardingFlowPage journey="founder" />);

    await screen.findByText("org-step-direct");
    expect(mockGetOnboardingProgress).toHaveBeenCalledWith(null);
    expect(mockAdvanceOnboarding).toHaveBeenCalledWith({
      companyId: null,
      journey: "founder",
      requestedState: "PROFILE_SET",
    });
  });
```
  →
```tsx
  it("founder + ?new=1: renders the create-another-company resolver on the user layer, then resumes clean", async () => {
    state.selectedCompanyId = "existing-co"; // already-complete company must be ignored
    state.searchParams = new URLSearchParams("new=1");
    renderWithProviders(<OnboardingFlowPage journey="founder" />);
    await screen.findByText("create-another-company");
    expect(state.newCompanyProps.userId).toBe("u1");
    expect(state.newCompanyProps.journey).toBe("founder");
    // finishing the company step resumes the NEW company via a clean /onboarding
    state.newCompanyProps.onCompleteCompany();
    expect(mockNavigate).toHaveBeenCalledWith("/onboarding", { replace: true });
  });

  it("founder + ?new=1: persists PROFILE_SET before rendering the resolver for a legacy user", async () => {
    state.searchParams = new URLSearchParams("new=1");
    mockGetOnboardingProgress.mockResolvedValue(null);

    renderWithProviders(<OnboardingFlowPage journey="founder" />);

    await screen.findByText("create-another-company");
    expect(mockGetOnboardingProgress).toHaveBeenCalledWith(null);
    expect(mockAdvanceOnboarding).toHaveBeenCalledWith({
      companyId: null,
      journey: "founder",
      requestedState: "PROFILE_SET",
    });
  });
```

- [ ] **Step 2: Run — confirm the two `?new=1` tests fail (RED).**
`pnpm exec vitest run --root ui ui/src/pages/__tests__/OnboardingFlow.test.tsx`
Expected: the two `?new=1` tests fail (`Unable to find an element with the text: create-another-company` — OnboardingFlow still renders the real OrgStep). The other tests still pass.

- [ ] **Step 3: Rewire OnboardingFlow.** In `ui/src/pages/OnboardingFlow.tsx`:

  (a) Line 5 — drop the now-unused `OnboardingState`:
```tsx
import type { OnboardingJourney, OnboardingState } from "@armyofagents/shared";
```
  →
```tsx
import type { OnboardingJourney } from "@armyofagents/shared";
```

  (b) Line 11 — replace the OrgStep import (OrgStep is no longer rendered here):
```tsx
import { OrgStep } from "../onboarding/steps/OrgStep";
```
  →
```tsx
import { CreateAnotherCompany } from "../onboarding/CreateAnotherCompany";
```

  (c) Replace the `?new=1` block (lines 89-117):
```tsx
  if (isNewFounderOrganization) {
    const orgCtx = {
      userId,
      companyId: null,
      journey,
      completedStates: ["AUTHENTICATED", "PROFILE_SET"] as OnboardingState[],
      // This standalone surface bypasses CreateOrganizationStep entirely, so
      // there is no live Organization id to hand OrgStep — it omits
      // organizationId from the create-company call when null (see
      // OrgStep.tsx submit()), and the server derives DEFAULT_ORGANIZATION_ID.
      // KNOWN GAP (flagged, not fixed here — out of Phase 2 Task 2/3/12
      // scope): in cloud_auth, a returning founder using this "create another
      // company" surface will land the new company in the default org rather
      // than their own, until this looks up the founder's real organization
      // membership (e.g. via organizationsApi.list()).
      organizationId: null,
    };
    return (
      <DarkShell>
        <div className="relative z-10 flex min-h-screen items-center justify-center px-6 py-8">
          <OrgStep
            ctx={orgCtx}
            onComplete={() => navigate("/onboarding", { replace: true })}
            onBack={() => navigate("/", { replace: true })}
          />
        </div>
      </DarkShell>
    );
  }
```
  →
```tsx
  if (isNewFounderOrganization) {
    // Fix 2 (design P1): resolve the founder's own create-capable Organization
    // before the company step. In cloud_auth an explicit org id is mandatory —
    // the server 403s a >=2-org founder who omits it and never guesses
    // (companies.ts:50-54); a single-org founder is auto-picked silently. Only
    // self-hosted omits the id (server derives DEFAULT_ORGANIZATION_ID,
    // companies.ts:56). CreateAnotherCompany owns that whole resolution.
    return (
      <DarkShell>
        <div className="relative z-10 flex min-h-screen items-center justify-center px-6 py-8">
          <CreateAnotherCompany
            userId={userId}
            journey={journey}
            onCompleteCompany={() => navigate("/onboarding", { replace: true })}
            onBack={() => navigate("/", { replace: true })}
          />
        </div>
      </DarkShell>
    );
  }
```

- [ ] **Step 4: Run — confirm the whole OnboardingFlow suite is green.**
`pnpm exec vitest run --root ui ui/src/pages/__tests__/OnboardingFlow.test.tsx`
Expected: `Test Files 1 passed (1)` / all tests passed (5).

- [ ] **Step 5: Commit.**
```
git add ui/src/pages/OnboardingFlow.tsx ui/src/pages/__tests__/OnboardingFlow.test.tsx
git commit -m "$(cat <<'EOF'
fix(onboarding): route ?new=1 through CreateAnotherCompany (Fix 2, P1)

Replaces the hardcoded organizationId:null create-another-company
surface with the cloud-aware resolver, fixing the >=2-org 403 dead-end.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.4 — Correct the stale "derives DEFAULT_ORGANIZATION_ID" comments

**Files:**
- Modify `ui/src/onboarding/steps/OrgStep.tsx` (comment lines 75-80)
- Modify `ui/src/context/CompanyContext.tsx` (comment lines 30-38)

(The third stale comment, `OnboardingFlow.tsx:96-103`, was already removed in Task 2.3.)

- [ ] **Step 1: Fix the OrgStep comment.** In `ui/src/onboarding/steps/OrgStep.tsx`, replace lines 75-80:
```tsx
      // organizationId is normally set by the preceding CreateOrganizationStep
      // (ctx.organizationId truthy). It's absent only on the standalone
      // "create another company" surface (OnboardingFlow.tsx `?new=1`, which
      // renders this step directly, bypassing CreateOrganizationStep) — omit
      // it there rather than send a literal `null` the create-company route
      // would reject; the server derives DEFAULT_ORGANIZATION_ID instead.
```
  →
```tsx
      // organizationId is set by the preceding CreateOrganizationStep on the
      // founder spine, and by CreateAnotherCompany on the standalone "create
      // another company" surface (OnboardingFlow.tsx `?new=1`). In cloud_auth
      // it is always an explicit create-capable org id (CreateAnotherCompany
      // resolves it — the server 403s an omitted id for a founder in >=2 orgs).
      // It is null only on the self-hosted path, where omitting it makes the
      // server derive DEFAULT_ORGANIZATION_ID (companies.ts:56).
```

- [ ] **Step 2: Fix the CompanyContext comment.** In `ui/src/context/CompanyContext.tsx`, replace lines 30-38 (the block above `organizationId?: string;`):
```tsx
    // Phase 2 Task 12: the founder wizard's org-first sequence always creates
    // the tenant Organization (CreateOrganizationStep) before OrgStep calls
    // this, so it's normally supplied. Optional (not required) because
    // OnboardingFlow.tsx's standalone "create another company" surface
    // (`/onboarding?new=1`, which renders OrgStep directly, bypassing
    // CreateOrganizationStep) has no organizationId to pass — omitting it
    // makes the server derive DEFAULT_ORGANIZATION_ID, matching prior
    // (pre-Phase-2) behavior. See OrgStep.tsx's submit().
    organizationId?: string;
```
  →
```tsx
    // Phase 2 Task 12: the founder wizard's org-first sequence creates the
    // tenant Organization (CreateOrganizationStep) before OrgStep calls this.
    // Optional because the value is threaded through from onboarding. In
    // cloud_auth it is always an explicit create-capable org id — the standalone
    // "create another company" surface (`/onboarding?new=1`) resolves it via
    // CreateAnotherCompany before calling createCompany, since the server 403s
    // an omitted id for a founder in >=2 orgs and never guesses. It is omitted
    // only on the self-hosted path, where the server derives
    // DEFAULT_ORGANIZATION_ID (companies.ts:56). See OrgStep.tsx's submit().
    organizationId?: string;
```

- [ ] **Step 3: Run — confirm the touched components' tests still pass (comment-only edits).**
`pnpm exec vitest run --root ui ui/src/onboarding/steps/__tests__/OrgStep.test.tsx`
Expected: `Test Files 1 passed (1)` / `Tests 10 passed (10)`.

- [ ] **Step 4: Commit.**
```
git add ui/src/onboarding/steps/OrgStep.tsx ui/src/context/CompanyContext.tsx
git commit -m "$(cat <<'EOF'
docs(onboarding): correct stale DEFAULT_ORGANIZATION_ID comments (Fix 2)

The server derives DEFAULT_ORGANIZATION_ID only on the self-hosted
branch; cloud_auth now always sends an explicit create-capable org id.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.5 — Full Fix-2 verification (all touched tests + UI typecheck)

**Files:** none (verification only).

- [ ] **Step 1: Run all four Fix-2 test files together.**
`pnpm exec vitest run --root ui ui/src/onboarding/__tests__/resolveCreateCompanyOrg.test.ts ui/src/onboarding/__tests__/CreateAnotherCompany.test.tsx ui/src/pages/__tests__/OnboardingFlow.test.tsx ui/src/onboarding/steps/__tests__/OrgStep.test.tsx`
Expected: `Test Files 4 passed (4)` — 6 + 4 + 5 + 10 = 25 tests passed.

- [ ] **Step 2: Typecheck the UI package** (covers the new component + edited non-test files; test dirs are excluded by `ui/tsconfig.json`).
`pnpm --filter @armyofagents/ui typecheck`
Expected: exits 0, no errors (in particular no "unused OrgStep import" or "OnboardingState" error, and `deploymentMode === "cloud_auth"` narrows cleanly against the widened union).

- [ ] **Step 3 (regression guard): confirm the server route contract is unchanged and still green** — Fix 2 ships zero server change; this is the lock referenced by the design (`companies-org-scope.test.ts:125-156`).
`pnpm exec vitest run --root server server/src/__tests__/companies-org-scope.test.ts`
Expected: `Test Files 1 passed (1)` — 1-org → own org, 2+ omitted → 403, 0 → 403 all still green (unmodified).

---

## Summary of change sites (exact anchors)

| File | Site | Change |
|------|------|--------|
| `ui/src/onboarding/resolveCreateCompanyOrg.ts` | new | Pure role-filter resolver → org / needs-org / ambiguous |
| `ui/src/onboarding/__tests__/resolveCreateCompanyOrg.test.ts` | new | 6 unit cases incl. `[owner:orgA, member:orgB] → orgA` and the ≥2 ambiguous branch |
| `ui/src/onboarding/CreateAnotherCompany.tsx` | new | Cloud-aware resolution + render (OrgStep / CreateOrganizationStep / EmptyState) |
| `ui/src/onboarding/__tests__/CreateAnotherCompany.test.tsx` | new | 4 jsdom branch tests (1-org, ≥2, 0-org chain, self-hosted omit) |
| `ui/src/lib/queryKeys.ts` | after line 6 | Add `organizations.list` key |
| `ui/src/pages/OnboardingFlow.tsx` | lines 5, 11, 89-117 | Drop `OnboardingState`/`OrgStep` imports; render `CreateAnotherCompany` for `?new=1` |
| `ui/src/pages/__tests__/OnboardingFlow.test.tsx` | state obj, mock 56-61, beforeEach 87, line 101, tests 128-152 | Mock `CreateAnotherCompany`; rewrite the two `?new=1` tests |
| `ui/src/onboarding/steps/OrgStep.tsx` | lines 75-80 | Correct stale DEFAULT_ORGANIZATION_ID comment |
| `ui/src/context/CompanyContext.tsx` | lines 30-38 | Correct stale DEFAULT_ORGANIZATION_ID comment |

**Reference-only (NOT changed):** `server/src/routes/companies.ts:42-71` (resolver + create authz — already honors an explicit id), `server/src/services/organization-access.ts` (owner/admin `company:create` matrix), `server/src/routes/organizations.ts:28-35` (`GET /organizations` = `listOrgMemberships`), `ui/src/App.tsx:82` (prefetches `queryKeys.health`, so `isCloud` is warm).

---

## Fix 4 — Scalability push-downs (Lobby hot path)

Push the already-materialized allowed-company-id set into SQL for `GET /companies` (list) and `GET /companies/stats`, replacing the instance-wide table scan + JS `.filter()`. Two invariants preserved: (1) the `legacyAdmin` self-hosted-operator branch stays **unfiltered**; (2) an empty allow-set **degrades to "return none"** (never scan, never return-all). The `notCrewAssigned` `NOT EXISTS` anti-join is untouched.

**Design ref:** `docs/aoa/plans/2026-07-31-mt-journey-correctness-fixes-design.md` §"Fix 4" (lines 92-105) and hard constraint line 152.

**Change sites (verified against the worktree):**
- Service `list`: `server/src/services/companies.ts:211` (`list: () => db.select().from(companies),`).
- Service `stats`: `server/src/services/companies.ts:315-377`.
- Service import: `server/src/services/companies.ts:1` (`import { eq, count, isNull, sql } from "drizzle-orm";`).
- Route `GET /`: `server/src/routes/companies.ts:85-102`.
- Route `GET /stats`: `server/src/routes/companies.ts:104-118`.
- Existing route tests to update: `server/src/__tests__/companies-org-scope.test.ts:84-98, 186-199`.

**Callers audited (grep, worktree):** only `routes/companies.ts:88,111` and `services/plugin-host-services.ts:542` call `companyService(...).list()/stats()`. The plugin-host caller is `companies.list()` (no arg) → unchanged under an optional param. `mcp/server.ts` `companiesSvc` calls only `getById`. Signature change is therefore safe.

**Test convention (this repo):**
- Unit + route tests run in Node/jsdom and are Windows-safe. Command (from repo root, verified working): `pnpm exec vitest run --root server src/__tests__/<file>`.
- This fix's `*.integration.test.ts` boots embedded-postgres and is committed as `describe.skipIf(process.platform !== "linux")` with `initdbFlags: ["--encoding=UTF8", "--locale=C"]` **baked into the `EmbeddedPostgres` ctor**; **Linux CI (`pnpm test:run`, `.github/workflows/pr.yml:387`) is the authoritative gate.** To run it locally on Windows: temporarily change `describe.skipIf(process.platform !== "linux")` -> `describe.skipIf(false)` (the initdb flags are already present; do NOT commit that edit), then `pnpm exec vitest run --root server src/__tests__/<file>`.

---

### Task 4.1 — Service `list(allowedCompanyIds?)`: push `inArray`/`false` into SQL

**Files:**
- Create: `server/src/__tests__/companies-scope-pushdown.test.ts` (unit, Windows-safe — capturing-Db SQL-shape proof; mirrors `crew-scope-counts.test.ts:51-110`).
- Modify: `server/src/services/companies.ts:1` (import), `:211` (`list`).

- [ ] **Step 1: Write the failing unit test file (list block only).** Create `server/src/__tests__/companies-scope-pushdown.test.ts` with the copied capturing-Db harness + the three list cases:

```ts
/**
 * Fix 4 — SQL push-down shape proof for companyService.list()/stats().
 * Windows-safe: a capturing Db records each select's serialized WHERE (no PG).
 * Harness copied from crew-scope-counts.test.ts (capturingDb is not exported).
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { companies, agents, issues, approvals, notifications } from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";

const dialect = new PgDialect();

interface Captured {
  table: unknown;
  whereSql: string | null;
}

function capturingDb(rows: unknown[] = []): { db: Db; captured: Captured[] } {
  const captured: Captured[] = [];
  function makeChain(rec: Captured) {
    const resolved = Promise.resolve(rows);
    const chain: Record<string, unknown> = {
      from(table: unknown) { rec.table = table; return chain; },
      innerJoin() { return chain; },
      leftJoin() { return chain; },
      where(cond: unknown) {
        try { rec.whereSql = cond == null ? null : dialect.sqlToQuery(cond as never).sql; }
        catch { rec.whereSql = null; }
        return chain;
      },
      groupBy() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) { return resolved.then(onF, onR); },
      catch(onR: (e: unknown) => unknown) { return resolved.catch(onR); },
    };
    return chain;
  }
  const db = {
    select() {
      const rec: Captured = { table: null, whereSql: null };
      captured.push(rec);
      return makeChain(rec);
    },
  } as unknown as Db;
  return { db, captured };
}

/** The serialized WHERE of the (single) select that ran against `table`, or null. */
function whereFor(captured: Captured[], table: unknown): string | null {
  const rec = captured.find((c) => c.table === table);
  return rec ? rec.whereSql : null;
}

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

describe("companyService.list() tenant push-down (Fix 4)", () => {
  it("undefined allow-set → unfiltered (no WHERE on companies) [operator/self-hosted view]", async () => {
    const { db, captured } = capturingDb([]);
    await companyService(db).list();
    expect(whereFor(captured, companies)).toBeNull();
  });

  it("empty allow-set → an explicit `false` predicate (degrade-to-none, never return-all)", async () => {
    const { db, captured } = capturingDb([]);
    await companyService(db).list([]);
    expect(whereFor(captured, companies)).toBe("false");
  });

  it("non-empty allow-set → inArray on companies.id is pushed into SQL", async () => {
    const { db, captured } = capturingDb([]);
    await companyService(db).list(IDS);
    expect(whereFor(captured, companies)).toContain('"companies"."id" in (');
  });
});
```

- [ ] **Step 2: Run the test; confirm 2 of 3 fail.** `list()` currently ignores its argument (`() => db.select().from(companies)`), so `list([])` and `list(IDS)` produce no WHERE.

```
pnpm exec vitest run --root server src/__tests__/companies-scope-pushdown.test.ts
```
Expected: `Tests  1 passed | 2 failed (3)` — the "empty" case fails `expected null to be "false"`, the "non-empty" case fails `expected null to contain '"companies"."id" in ('`. The "undefined" case passes.

- [ ] **Step 3: Add `inArray` to the drizzle import.** In `server/src/services/companies.ts:1`, change:

```ts
import { eq, count, isNull, sql } from "drizzle-orm";
```
to:
```ts
import { eq, count, inArray, isNull, sql } from "drizzle-orm";
```

- [ ] **Step 4: Implement the `list` push-down.** In `server/src/services/companies.ts`, replace line 211:

```ts
    list: () => db.select().from(companies),
```
with:
```ts
    list: (allowedCompanyIds?: string[]) => {
      // Fix 4: push the actor's allowed-company set into SQL instead of scanning
      // every tenant's companies and filtering in JS. undefined → unfiltered
      // (self-hosted operator view, unchanged); empty → a `false` predicate
      // (explicit degrade-to-none, never return-all). drizzle also lowers
      // inArray(id, []) to `false`, but this keeps it version-independent.
      if (allowedCompanyIds === undefined) {
        return db.select().from(companies);
      }
      return db
        .select()
        .from(companies)
        .where(
          allowedCompanyIds.length === 0
            ? sql`false`
            : inArray(companies.id, allowedCompanyIds),
        );
    },
```

- [ ] **Step 5: Re-run; confirm all 3 pass.**

```
pnpm exec vitest run --root server src/__tests__/companies-scope-pushdown.test.ts
```
Expected: `Tests  3 passed (3)`.

- [ ] **Step 6: Commit.**

```
git add server/src/services/companies.ts server/src/__tests__/companies-scope-pushdown.test.ts
git commit -m "$(cat <<'EOF'
fix(companies): push tenant allow-set into list() SQL (Fix 4)

Replaces the instance-wide company scan with an inArray push-down; empty
allow-set degrades to a `false` predicate (return-none); undefined stays
unfiltered for the self-hosted operator view.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.2 — Service `stats(allowedCompanyIds?)`: push `inArray` into the four aggregations

**Files:**
- Modify: `server/src/__tests__/companies-scope-pushdown.test.ts` (append a stats describe block).
- Modify: `server/src/services/companies.ts:1` (add `and`), insert a `CompanyStatsEntry` type after the imports, rewrite `:315-377` (`stats`).

- [ ] **Step 1: Append the failing stats tests.** At the end of `server/src/__tests__/companies-scope-pushdown.test.ts`, append:

```ts
describe("companyService.stats() tenant push-down (Fix 4)", () => {
  it("non-empty allow-set → inArray on company_id pushed into all four aggregations", async () => {
    const { db, captured } = capturingDb([]);
    await companyService(db).stats(IDS);
    expect(whereFor(captured, agents)).toContain('"agents"."company_id" in (');
    expect(whereFor(captured, issues)).toContain('"issues"."company_id" in (');
    expect(whereFor(captured, approvals)).toContain('"approvals"."company_id" in (');
    expect(whereFor(captured, notifications)).toContain('"notifications"."company_id" in (');
  });

  it("empty allow-set → short-circuits to {} with NO database query (degrade-to-none)", async () => {
    const { db, captured } = capturingDb([]);
    const result = await companyService(db).stats([]);
    expect(result).toEqual({});
    expect(captured).toHaveLength(0);
  });

  it("undefined allow-set → base predicates only, NO company_id inArray [operator view]", async () => {
    const { db, captured } = capturingDb([]);
    await companyService(db).stats();
    expect(whereFor(captured, agents)).not.toContain('"agents"."company_id" in (');
    expect(whereFor(captured, issues)).not.toContain('"issues"."company_id" in (');
    expect(whereFor(captured, approvals)).not.toContain('"approvals"."company_id" in (');
    expect(whereFor(captured, notifications)).not.toContain('"notifications"."company_id" in (');
    // base predicate is still present (unchanged from today).
    expect(whereFor(captured, agents)).toContain('"agents"."kind" =');
  });
});
```

- [ ] **Step 2: Run; confirm 2 of the 3 new stats tests fail.** `stats()` currently ignores its arg: `stats([])` runs the four selects (`captured.length === 4`, not 0) and `stats(IDS)` emits no inArray.

```
pnpm exec vitest run --root server src/__tests__/companies-scope-pushdown.test.ts
```
Expected: the list block (3) still passes; stats "non-empty" fails (`expected null to contain '"agents"."company_id" in ('`), stats "empty" fails (`expected length 4 to be 0`), stats "undefined" passes. Net `4 passed | 2 failed (6)`.

- [ ] **Step 3: Add `and` to the drizzle import.** In `server/src/services/companies.ts:1`, change:

```ts
import { eq, count, inArray, isNull, sql } from "drizzle-orm";
```
to:
```ts
import { and, eq, count, inArray, isNull, sql } from "drizzle-orm";
```

- [ ] **Step 4: Add the `CompanyStatsEntry` type.** In `server/src/services/companies.ts`, insert immediately after the import block (after line 57 `import { notCrewAssigned } from "./issue-crew-scope.js";`, before line 59 `export interface CreateCompanyOptions`):

```ts
type CompanyStatsEntry = {
  agentCount: number;
  issueCount: number;
  pendingApprovalCount: number;
  unreadNotificationCount: number;
};
```

- [ ] **Step 5: Rewrite the `stats` method.** In `server/src/services/companies.ts`, replace the entire `stats:` method (lines 315-377), i.e. from `    stats: () =>` through its closing `      }),` immediately before the closing `  };` of the returned object, with:

```ts
    stats: (allowedCompanyIds?: string[]) => {
      // Fix 4: empty allow-set → return none WITHOUT four instance-wide GROUP BY
      // scans (explicit degrade-to-none; mirrors the list() guard).
      if (allowedCompanyIds?.length === 0) {
        return Promise.resolve<Record<string, CompanyStatsEntry>>({});
      }
      // undefined allow-set → unscoped (self-hosted operator view, unchanged).
      // A non-empty allow-set is AND-ed into each aggregation as an inArray on
      // the table's company_id, pushing the tenant filter into SQL. The
      // `=== undefined` ternary (not a derived boolean) narrows allowedCompanyIds
      // to string[] in the scoped branch so inArray typechecks; the base branch
      // returns the predicate UNCHANGED so the correlated-crew SQL stays byte-
      // identical to today (crew-scope-counts.test.ts).
      return Promise.all([
        db
          .select({ companyId: agents.companyId, count: count() })
          .from(agents)
          // Per-company agent counts exclude platform (Commander-team) agents.
          .where(
            allowedCompanyIds === undefined
              ? eq(agents.kind, "org")
              : and(eq(agents.kind, "org"), inArray(agents.companyId, allowedCompanyIds)),
          )
          .groupBy(agents.companyId),
        db
          .select({ companyId: issues.companyId, count: count() })
          .from(issues)
          // Per-company issue (active-tasks) counts exclude crew-agent tasks, so
          // the lobby card mirrors the agent count's org-only intent. This is a
          // CROSS-COMPANY batch (groupBy company_id, no fixed company), so the
          // crew predicate is the CORRELATED form (no arg → agents.company_id =
          // issues.company_id). Crew tasks live only on the Crew Board.
          .where(
            allowedCompanyIds === undefined
              ? notCrewAssigned()
              : and(notCrewAssigned(), inArray(issues.companyId, allowedCompanyIds)),
          )
          .groupBy(issues.companyId),
        db
          .select({ companyId: approvals.companyId, count: count() })
          .from(approvals)
          .where(
            allowedCompanyIds === undefined
              ? eq(approvals.status, "pending")
              : and(eq(approvals.status, "pending"), inArray(approvals.companyId, allowedCompanyIds)),
          )
          .groupBy(approvals.companyId),
        db
          .select({ companyId: notifications.companyId, count: count() })
          .from(notifications)
          .where(
            allowedCompanyIds === undefined
              ? isNull(notifications.readAt)
              : and(isNull(notifications.readAt), inArray(notifications.companyId, allowedCompanyIds)),
          )
          .groupBy(notifications.companyId),
      ]).then(([agentRows, issueRows, approvalRows, notificationRows]) => {
        const result: Record<string, CompanyStatsEntry> = {};
        function ensure(companyId: string) {
          if (!result[companyId]) {
            result[companyId] = {
              agentCount: 0,
              issueCount: 0,
              pendingApprovalCount: 0,
              unreadNotificationCount: 0,
            };
          }
          return result[companyId];
        }
        for (const row of agentRows) {
          ensure(row.companyId).agentCount = row.count;
        }
        for (const row of issueRows) {
          ensure(row.companyId).issueCount = row.count;
        }
        for (const row of approvalRows) {
          ensure(row.companyId).pendingApprovalCount = row.count;
        }
        for (const row of notificationRows) {
          ensure(row.companyId).unreadNotificationCount = row.count;
        }
        return result;
      });
    },
```

- [ ] **Step 6: Re-run the push-down unit file; confirm all 6 pass.**

```
pnpm exec vitest run --root server src/__tests__/companies-scope-pushdown.test.ts
```
Expected: `Tests  6 passed (6)`.

- [ ] **Step 7: Run the existing crew-scope regression + typecheck.** The unscoped-stats SQL must be unchanged.

```
pnpm exec vitest run --root server src/__tests__/crew-scope-counts.test.ts
pnpm --filter @armyofagents/server typecheck
```
Expected: crew-scope-counts all pass (its `companyService(db).stats()` no-arg test at lines 260-283 still sees the correlated crew NOT-EXISTS predicate); `tsc --noEmit` exits 0.

- [ ] **Step 8: Commit.**

```
git add server/src/services/companies.ts server/src/__tests__/companies-scope-pushdown.test.ts
git commit -m "$(cat <<'EOF'
fix(companies): push tenant allow-set into stats() aggregations (Fix 4)

Each of the four GROUP BY rollups AND-s an inArray(company_id) tenant
filter when a non-empty allow-set is supplied; empty short-circuits to {}
(no scan); undefined stays unscoped (operator view). Unscoped SQL is
byte-identical to before, keeping crew-scope-counts green.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.3 — Route wiring: pass the allow-set to the service, drop the JS filter, keep `legacyAdmin` unfiltered

**Files:**
- Modify: `server/src/routes/companies.ts:85-102` (`GET /`), `:104-118` (`GET /stats`).
- Modify: `server/src/__tests__/companies-org-scope.test.ts:84-98, 186-199` (+ 2 new tests).

- [ ] **Step 1: Update the route tests to the new contract (they will fail against the current JS-filter route).** In `server/src/__tests__/companies-org-scope.test.ts`, replace the two cloud tests at lines 84-98:

```ts
  it("GET /: excludes companies not in the actor's companyIds (operator gets no full list)", async () => {
    list.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    const actor = sessionActor({ companyIds: ["c1"], operator: true });
    const res = await request(makeApp(actor)).get("/api/companies");
    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.id)).toEqual(["c1"]);
  });

  it("GET /stats: excludes stats for companies outside the actor's memberships", async () => {
    stats.mockResolvedValue({ c1: { total: 1 }, c2: { total: 9 } });
    const actor = sessionActor({ companyIds: ["c1"], operator: true });
    const res = await request(makeApp(actor)).get("/api/companies/stats");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["c1"]);
  });
```
with (the route now scopes in SQL and returns the service result verbatim — assert the push-down argument, plus a new empty-set case):

```ts
  it("GET /: pushes the actor's companyIds into the service (SQL scope, no JS post-filter)", async () => {
    list.mockResolvedValue([{ id: "c1" }]);
    const actor = sessionActor({ companyIds: ["c1"], operator: true });
    const res = await request(makeApp(actor)).get("/api/companies");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(["c1"]);
    expect(res.body.map((c: any) => c.id)).toEqual(["c1"]);
  });

  it("GET /: an actor with zero memberships passes the empty allow-set through (degrade-to-none)", async () => {
    list.mockResolvedValue([]);
    const actor = sessionActor({ companyIds: [] });
    const res = await request(makeApp(actor)).get("/api/companies");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith([]);
    expect(res.body).toEqual([]);
  });

  it("GET /stats: pushes the actor's companyIds into the service (SQL scope, no JS post-filter)", async () => {
    stats.mockResolvedValue({ c1: { total: 1 } });
    const actor = sessionActor({ companyIds: ["c1"], operator: true });
    const res = await request(makeApp(actor)).get("/api/companies/stats");
    expect(res.status).toBe(200);
    expect(stats).toHaveBeenCalledWith(["c1"]);
    expect(Object.keys(res.body)).toEqual(["c1"]);
  });
```

- [ ] **Step 2: Update the self-hosted operator test + add a stats operator test.** In the same file, replace the self-hosted list test at lines 186-199:

```ts
  it("authenticated instance_admin still sees the full company list", async () => {
    setDeploymentMode("authenticated");
    list.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    const actor = {
      type: "board",
      source: "session",
      userId: "op",
      companyIds: [],
      isInstanceAdmin: true,
    };
    const res = await request(makeApp(actor, "authenticated")).get("/api/companies");
    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.id)).toEqual(["c1", "c2"]);
  });
```
with (assert the operator branch calls the service **unscoped** — no allow-set — and add the stats counterpart):

```ts
  it("authenticated instance_admin still sees the full company list (unscoped service call)", async () => {
    setDeploymentMode("authenticated");
    list.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    const actor = {
      type: "board",
      source: "session",
      userId: "op",
      companyIds: [],
      isInstanceAdmin: true,
    };
    const res = await request(makeApp(actor, "authenticated")).get("/api/companies");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(); // no allow-set → unscoped
    expect(res.body.map((c: any) => c.id)).toEqual(["c1", "c2"]);
  });

  it("authenticated instance_admin sees full stats (unscoped service call)", async () => {
    setDeploymentMode("authenticated");
    stats.mockResolvedValue({ c1: { total: 1 }, c2: { total: 9 } });
    const actor = {
      type: "board",
      source: "session",
      userId: "op",
      companyIds: [],
      isInstanceAdmin: true,
    };
    const res = await request(makeApp(actor, "authenticated")).get("/api/companies/stats");
    expect(res.status).toBe(200);
    expect(stats).toHaveBeenCalledWith(); // no allow-set → unscoped
    expect(Object.keys(res.body)).toEqual(["c1", "c2"]);
  });
```

- [ ] **Step 3: Run the route test; confirm the new assertions fail against the current route.** The current route JS-filters and always calls `svc.list()`/`svc.stats()` with no args, so `toHaveBeenCalledWith(["c1"])` fails.

```
pnpm exec vitest run --root server src/__tests__/companies-org-scope.test.ts
```
Expected: failures on the two "pushes … into the service" tests (`expected "spy" to be called with [ [ 'c1' ] ]`) and the new empty-set test.

- [ ] **Step 4: Rewrite the `GET /` handler.** In `server/src/routes/companies.ts`, replace lines 85-102:

```ts
  router.get("/", async (req, res) => {
    // rbac: instance-admin-not-required — list endpoint with no companyId in path; result is scope-filtered inline against req.actor.companyIds.
    assertBoard(req);
    const result = await svc.list();
    // The full-list bypass is a self-hosted-only affordance. In cloud_auth
    // (isolation enforced) the operator plane must NOT see every tenant's
    // companies — filter to the actor's own memberships. isInstanceAdmin is
    // already clamped false in cloud (Task 4); the static gate is defense-in-depth.
    const legacyAdmin =
      !tenantIsolationEnforced() &&
      (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin);
    if (legacyAdmin) {
      res.json(result);
      return;
    }
    const allowed = new Set(req.actor.companyIds ?? []);
    res.json(result.filter((company) => allowed.has(company.id)));
  });
```
with:
```ts
  router.get("/", async (req, res) => {
    // rbac: instance-admin-not-required — list endpoint with no companyId in path; result is scope-filtered in SQL against req.actor.companyIds.
    assertBoard(req);
    // The full-list bypass is a self-hosted-only affordance. In cloud_auth
    // (isolation enforced) the operator plane must NOT see every tenant's
    // companies. Fix 4: push the actor's allowed-company set into SQL rather
    // than scanning all companies and filtering in JS. isInstanceAdmin is
    // already clamped false in cloud (Task 4); the static gate is defense-in-depth.
    const legacyAdmin =
      !tenantIsolationEnforced() &&
      (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin);
    const result = legacyAdmin
      ? await svc.list()
      : await svc.list(req.actor.companyIds ?? []);
    res.json(result);
  });
```

- [ ] **Step 5: Rewrite the `GET /stats` handler.** In `server/src/routes/companies.ts`, replace lines 104-118:

```ts
  router.get("/stats", async (req, res) => {
    // rbac: instance-admin-not-required — stats endpoint with no companyId in path; result is scope-filtered inline against req.actor.companyIds.
    assertBoard(req);
    const legacyAdmin =
      !tenantIsolationEnforced() &&
      (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin);
    const allowed = legacyAdmin ? null : new Set(req.actor.companyIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    res.json(filtered);
  });
```
with:
```ts
  router.get("/stats", async (req, res) => {
    // rbac: instance-admin-not-required — stats endpoint with no companyId in path; result is scope-filtered in SQL against req.actor.companyIds.
    assertBoard(req);
    // Self-hosted operator view: unscoped (unchanged). Everyone else: push the
    // actor's allowed-company set into the four aggregations rather than running
    // instance-wide GROUP BYs and filtering in JS (Fix 4).
    const legacyAdmin =
      !tenantIsolationEnforced() &&
      (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin);
    const stats = legacyAdmin
      ? await svc.stats()
      : await svc.stats(req.actor.companyIds ?? []);
    res.json(stats);
  });
```

- [ ] **Step 6: Re-run the route test; confirm all pass.**

```
pnpm exec vitest run --root server src/__tests__/companies-org-scope.test.ts
```
Expected: `Tests  11 passed (11)` (the 9 original minus the 3 rewritten, plus 5 rewritten/added → 11).

- [ ] **Step 7: Typecheck.**

```
pnpm --filter @armyofagents/server typecheck
```
Expected: exit 0.

- [ ] **Step 8: Commit.**

```
git add server/src/routes/companies.ts server/src/__tests__/companies-org-scope.test.ts
git commit -m "$(cat <<'EOF'
fix(companies): route list/stats scope via SQL push-down, drop JS filter (Fix 4)

GET /companies and /companies/stats now hand the actor's companyIds to the
service (empty set included) instead of scanning all tenants and filtering
in JS. legacyAdmin operator branch calls the service unscoped, unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.4 — Real embedded-PG integration proof (invariants i/ii/iii against Postgres)

Proves the SQL push-down actually filters in Postgres — catches a wrong-column/wrong-predicate bug that serializes fine but filters wrong. Service-level (no HTTP), minimal direct-SQL fixture.

**Files:**
- Create: `server/src/__tests__/companies-scope-pushdown.integration.test.ts` (embedded PG; mirrors `agents-list-excludes-platform.integration.test.ts`).

- [ ] **Step 1: Write the integration test.** Create `server/src/__tests__/companies-scope-pushdown.integration.test.ts`:

```ts
/**
 * Real-DB integration test for companyService.list()/stats() tenant push-down
 * (Fix 4). Proves the allowed-company set is filtered in SQL:
 *   (i)   a scoped caller sees only their companies + counts,
 *   (ii)  the operator (undefined allow-set) sees ALL,
 *   (iii) an empty allow-set returns NONE.
 *
 * Boots embedded-postgres, applies all migrations, seeds two companies with
 * distinct agent/issue/approval/notification rows, exercises the service.
 *
 * Skipped off Linux (embedded-postgres / migration-chain, Issue #114); Linux CI
 * is the authoritative gate. `initdbFlags` are baked into the EmbeddedPostgres
 * ctor (committed), so the suite is Windows-runnable by temporarily flipping
 * `describe.skipIf(process.platform !== "linux")` to `describe.skipIf(false)`
 * (do NOT commit that edit), then reverting.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean; initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let svc: ReturnType<typeof companyService>;
let setupError: unknown = null;

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as any)?.id;
  return (result as any).rows?.[0]?.id;
}

const PORT = 58000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-companies-scope-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    svc = companyService(db);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[companies-scope-integration] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")(
  "companyService list()/stats() — real DB tenant push-down",
  () => {
    let companyAId: string;
    let companyBId: string;

    it("setup: seeds two companies with distinct rollup rows", async () => {
      if (setupError) {
        throw new Error(
          `embedded-postgres setup failed; cannot run integration test: ${String(setupError)}`,
        );
      }
      companyAId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO companies (id, name, issue_prefix) VALUES (gen_random_uuid(), 'Scope Co A', 'SCA') RETURNING id
      `));
      companyBId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO companies (id, name, issue_prefix) VALUES (gen_random_uuid(), 'Scope Co B', 'SCB') RETURNING id
      `));
      expect(companyAId).toBeTruthy();
      expect(companyBId).toBeTruthy();

      // Company A: 1 org agent, 1 unassigned (→ non-crew) issue, 1 pending
      // approval (status defaults 'pending'), 1 unread notification (read_at null).
      await db.execute(sql`INSERT INTO agents (id, company_id, name, kind) VALUES (gen_random_uuid(), ${companyAId}, 'A-agent', 'org')`);
      await db.execute(sql`INSERT INTO issues (id, company_id, title) VALUES (gen_random_uuid(), ${companyAId}, 'A task')`);
      await db.execute(sql`INSERT INTO approvals (id, company_id, type, payload) VALUES (gen_random_uuid(), ${companyAId}, 'test', '{}'::jsonb)`);
      await db.execute(sql`INSERT INTO notifications (id, company_id, user_id, type, title) VALUES (gen_random_uuid(), ${companyAId}, 'u', 'test', 'A note')`);

      // Company B: 2 org agents, 3 issues — distinct counts, 0 approvals/notifications.
      await db.execute(sql`INSERT INTO agents (id, company_id, name, kind) VALUES (gen_random_uuid(), ${companyBId}, 'B-agent-1', 'org')`);
      await db.execute(sql`INSERT INTO agents (id, company_id, name, kind) VALUES (gen_random_uuid(), ${companyBId}, 'B-agent-2', 'org')`);
      await db.execute(sql`INSERT INTO issues (id, company_id, title) VALUES (gen_random_uuid(), ${companyBId}, 'B task 1')`);
      await db.execute(sql`INSERT INTO issues (id, company_id, title) VALUES (gen_random_uuid(), ${companyBId}, 'B task 2')`);
      await db.execute(sql`INSERT INTO issues (id, company_id, title) VALUES (gen_random_uuid(), ${companyBId}, 'B task 3')`);
    });

    it("list([A]) returns only company A (invariant i: caller sees only their own)", async () => {
      if (setupError) throw new Error(String(setupError));
      const rows = await svc.list([companyAId]);
      expect(rows.map((c: any) => c.id)).toEqual([companyAId]);
    });

    it("list() returns ALL companies (invariant ii: operator sees all)", async () => {
      if (setupError) throw new Error(String(setupError));
      const ids = (await svc.list()).map((c: any) => c.id);
      expect(ids).toContain(companyAId);
      expect(ids).toContain(companyBId);
    });

    it("list([]) returns none (invariant iii: empty allow-set → degrade-to-none)", async () => {
      if (setupError) throw new Error(String(setupError));
      const rows = await svc.list([]);
      expect(rows).toEqual([]);
    });

    it("stats([A]) counts only company A", async () => {
      if (setupError) throw new Error(String(setupError));
      const stats = await svc.stats([companyAId]);
      expect(Object.keys(stats)).toEqual([companyAId]);
      expect(stats[companyAId]).toEqual({
        agentCount: 1,
        issueCount: 1,
        pendingApprovalCount: 1,
        unreadNotificationCount: 1,
      });
    });

    it("stats([A,B]) counts both companies with per-tenant rollups", async () => {
      if (setupError) throw new Error(String(setupError));
      const stats = await svc.stats([companyAId, companyBId]);
      expect(stats[companyAId].agentCount).toBe(1);
      expect(stats[companyBId].agentCount).toBe(2);
      expect(stats[companyBId].issueCount).toBe(3);
    });

    it("stats() counts ALL companies (invariant ii: operator sees all)", async () => {
      if (setupError) throw new Error(String(setupError));
      const stats = await svc.stats();
      expect(stats[companyAId]).toBeDefined();
      expect(stats[companyBId]).toBeDefined();
    });

    it("stats([]) returns {} (invariant iii: empty allow-set → degrade-to-none)", async () => {
      if (setupError) throw new Error(String(setupError));
      const stats = await svc.stats([]);
      expect(stats).toEqual({});
    });
  },
);
```

- [ ] **Step 2 (Windows local run, TDD confirm): temporarily un-skip, run, confirm green, then revert.** `initdbFlags` are already baked into the ctor (committed), so make **one** throwaway edit (do NOT commit): `describe.skipIf(process.platform !== "linux")` -> `describe.skipIf(false)`. Then:

```
pnpm exec vitest run --root server src/__tests__/companies-scope-pushdown.integration.test.ts
```
Expected: `Tests  8 passed (8)`. Then **revert the throwaway edit** (restore `skipIf(process.platform !== "linux")`; `initdbFlags` stay baked). If you cannot run embedded-PG locally, skip this step and rely on Linux CI (Step 3) as the authoritative gate; the file is committed skip-gated.

- [ ] **Step 3: Confirm the committed (Windows-skipped) form is inert on Windows / runs on CI.** With the flag restored:

```
pnpm exec vitest run --root server src/__tests__/companies-scope-pushdown.integration.test.ts
```
Expected on Windows: the describe is skipped — `Test Files  1 passed (1)` with `Tests  8 skipped (8)` (0 executed). On Linux CI (`pnpm test:run`) the 8 tests execute for real.

- [ ] **Step 4: Commit.**

```
git add server/src/__tests__/companies-scope-pushdown.integration.test.ts
git commit -m "$(cat <<'EOF'
test(companies): real-PG proof of list/stats tenant push-down (Fix 4)

Seeds two tenants and asserts scoped caller sees only their own
companies+counts, operator sees all, empty allow-set returns none.
Windows-skipped (Issue #114); Linux CI is the authoritative gate.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

**Fix 4 done-when:** `companies-scope-pushdown.test.ts` (6) + `companies-org-scope.test.ts` (11) + `crew-scope-counts.test.ts` green on Windows; `companies-scope-pushdown.integration.test.ts` (8) green on Linux CI; `@armyofagents/server` typecheck clean. Both invariants proven (operator unfiltered; empty→none) and `notCrewAssigned` NOT-EXISTS untouched.

---

## Fix 5 — Org-create transaction hardening

**Problem.** `createSelfServeOrganization` (`server/src/services/organizations.ts:107-115`) inserts the org row via `organizationService(db).create({ name })` and then writes the owner membership via `orgAccess.ensureOrgOwner(...)` as **two un-transactioned awaits**. A transient fault between them leaves an org row with no owner membership (`createdByUserId` null) that the user can neither reach nor adopt — a retry mints a fresh slug-deduped org, compounding the ghost-org problem behind Fix 3.

**Approach.** Wrap the org insert + owner-membership write in **one `db.transaction`**. The owner-membership write must run on the *transaction* handle, so the 3rd parameter of `createSelfServeOrganization` changes from a bound `orgAccess` service to an **orgAccess factory** `(handle: Db) => { ensureOrgOwner }` (the route already has `organizationAccessService`, which *is* exactly this factory shape). **Slug-retry caveat:** a 23505 aborts the whole PG transaction, so the retry loop lives **outside** the transaction — each attempt is a fresh `db.transaction` performing exactly one insert + membership write; a slug conflict aborts (and rolls back) only that attempt's tx and is caught outside it, then the next candidate slug is tried in a brand-new tx. This mirrors the existing `organizationService.create` loop structure (`attempt < 10000`, same candidate formula, same `isOrgSlugConflict` catch) and keeps the low-level `organizationService.create` **untouched** (still always-insert; `organizations-uniqueness.integration.test.ts` stays green).

**Why `ensureOrgOwner` and not `create`'s built-in `createdByUserId` path:** `ensureOrgOwner`→`ensureOrgMembership` (`server/src/services/organization-access.ts:54-81`) additionally **promotes** a pre-existing weaker membership row to owner (idempotent / `onConflictDoNothing`-safe, because P1's `ensureRealOperator`/`0188` backfill may already have touched the same `(org,user)` row). `create`'s built-in path only inserts-or-nothing. Preserve the promote semantics by binding `organizationAccessService(tx)` per attempt.

**Files:**
- **Modify** `server/src/services/organizations.ts` (doc comment + `createSelfServeOrganization`, lines **98-115**).
- **Modify** `server/src/routes/organizations.ts` (call site, line **22**).
- **Modify (test)** `server/src/__tests__/organizations-routes.test.ts` (fakeDb lines **5-13** + call line **19**).
- **Create (test)** `server/src/__tests__/organizations-transaction.integration.test.ts`.

> **Windows note.** `organizations-routes.test.ts` is a node/jsdom-safe unit test — runs anywhere. The new `*.integration.test.ts` is embedded-Postgres-gated: the committed file uses `describe.skipIf(process.platform !== "linux")` and bakes `initdbFlags: ["--encoding=UTF8", "--locale=C"]` (established pattern — `home-board-layout.integration.test.ts:106`). **To run it locally on Windows:** temporarily change `process.platform !== "linux"` to `false` in the `describe.skipIf(...)`, run, then revert to `process.platform !== "linux"` **before commit**. On the Linux `verify` gate it runs for real with no flip.

---

### Step-by-step (strict TDD)

- [ ] **Step 1: Update the unit test `organizations-routes.test.ts` to the new factory + transaction contract.** The current `fakeDb` (lines 5-13) has no `.transaction`, and the call (line 19) passes a bare `{ ensureOrgOwner }` object. Replace the whole file body with the version below (adds a pass-through `transaction` to the fake, and passes a **factory** as the 3rd arg):

  Current (`server/src/__tests__/organizations-routes.test.ts:1-24`):
  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { createSelfServeOrganization } from "../services/organizations.js";

  // Sequence-style fake db (see CLAUDE.md Test Patterns).
  function fakeDb() {
    const inserts: any[] = [];
    const db: any = {
      insert: (tbl: any) => ({
        values: (v: any) => ({ returning: async () => { inserts.push({ tbl, v }); return [{ id: v.id ?? "org-new", ...v }]; } }),
      }),
    };
    return { db, inserts };
  }

  describe("createSelfServeOrganization", () => {
    it("creates the org and makes the caller its owner", async () => {
      const { db, inserts } = fakeDb();
      const ensureOrgOwner = vi.fn(async () => "m1");
      const org = await createSelfServeOrganization(db, { name: "Acme", ownerUserId: "u1" }, { ensureOrgOwner } as any);
      expect(org.name).toBe("Acme");
      expect(ensureOrgOwner).toHaveBeenCalledWith(org.id, "u1");
      expect(inserts.some((i) => i.v.name === "Acme")).toBe(true);
    });
  });
  ```

  New (full file):
  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { createSelfServeOrganization } from "../services/organizations.js";

  // Sequence-style fake db (see CLAUDE.md Test Patterns).
  function fakeDb() {
    const inserts: any[] = [];
    const db: any = {
      insert: (tbl: any) => ({
        values: (v: any) => ({ returning: async () => { inserts.push({ tbl, v }); return [{ id: v.id ?? "org-new", ...v }]; } }),
      }),
      // Fix 5: createSelfServeOrganization now wraps insert + owner-membership in
      // one db.transaction. The fake models a pass-through tx (callback runs on the
      // same fake handle) so the unit test still exercises the happy path. Real
      // rollback is proven in organizations-transaction.integration.test.ts.
      transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
    };
    return { db, inserts };
  }

  describe("createSelfServeOrganization", () => {
    it("creates the org and makes the caller its owner", async () => {
      const { db, inserts } = fakeDb();
      const ensureOrgOwner = vi.fn(async () => "m1");
      // 3rd arg is now a FACTORY (handle) => { ensureOrgOwner } so the membership
      // write can bind to the transaction handle.
      const org = await createSelfServeOrganization(
        db,
        { name: "Acme", ownerUserId: "u1" },
        (() => ({ ensureOrgOwner })) as any,
      );
      expect(org.name).toBe("Acme");
      expect(ensureOrgOwner).toHaveBeenCalledWith(org.id, "u1");
      expect(inserts.some((i) => i.v.name === "Acme")).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Create the integration test `server/src/__tests__/organizations-transaction.integration.test.ts`.** Full file:
  ```ts
  import { afterAll, beforeAll, describe, expect, it } from "vitest";
  import { mkdtemp, rm } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { randomUUID } from "node:crypto";
  import { and, eq } from "drizzle-orm";
  import {
    applyPendingMigrations,
    authUsers,
    createDb,
    organizationMemberships,
    organizations,
    type Db,
  } from "@armyofagents/db";
  import { organizationAccessService } from "../services/organization-access.js";
  import { createSelfServeOrganization } from "../services/organizations.js";
  import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

  type EmbeddedPostgresInstance = {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  type EmbeddedPostgresCtor = new (opts: {
    databaseDir: string;
    user: string;
    password: string;
    port: number;
    persistent: boolean;
    initdbFlags?: string[];
  }) => EmbeddedPostgresInstance;

  let pg: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  // To run locally on Windows, temporarily flip this to `describe.skipIf(false)`.
  describe.skipIf(process.platform !== "linux")(
    "createSelfServeOrganization — atomicity (real PostgreSQL)",
    () => {
      let db: Db;
      const ownerUserId = `org-tx-owner-${randomUUID()}`;

      beforeAll(async () => {
        dataDir = await mkdtemp(join(tmpdir(), "aoa-org-tx-"));
        const port = await allocateEmbeddedPgPort();
        const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
          default: EmbeddedPostgresCtor;
        };
        pg = new EmbeddedPostgres({
          databaseDir: join(dataDir, "db"),
          user: "test",
          password: "test",
          port,
          persistent: false,
          initdbFlags: ["--encoding=UTF8", "--locale=C"],
        });
        await pg.initialise();
        await pg.start();
        const conn = `postgres://test:test@localhost:${port}/postgres`;
        await applyPendingMigrations(conn);
        db = createDb(conn);
        // organization_memberships.user_id -> "user"(id) FK: seed a real user so the
        // happy-path owner-membership write satisfies the FK.
        const now = new Date();
        await db.insert(authUsers).values({
          id: ownerUserId,
          name: "Org Tx Owner",
          email: `${ownerUserId}@example.test`,
          createdAt: now,
          updatedAt: now,
        });
      }, 180_000);

      afterAll(async () => {
        try { if (pg) await pg.stop(); } catch { /* ignore */ }
        try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }, 60_000);

      it("rolls back the org insert when the owner-membership write fails (no orphan org)", async () => {
        const before = await db.select().from(organizations);
        const throwingFactory = (): Pick<
          ReturnType<typeof organizationAccessService>,
          "ensureOrgOwner"
        > => ({
          ensureOrgOwner: async () => {
            throw new Error("forced membership failure");
          },
        });
        await expect(
          createSelfServeOrganization(db, { name: "Rollback Co", ownerUserId }, throwingFactory),
        ).rejects.toThrow();
        const after = await db.select().from(organizations);
        // Atomicity: the org row inserted inside the tx is rolled back together with
        // the failed membership write — no orphan tenant remains.
        expect(after.length).toBe(before.length);
        expect(after.find((o) => o.name === "Rollback Co")).toBeUndefined();
      });

      it("commits the org row AND the owner membership together on success", async () => {
        const org = await createSelfServeOrganization(
          db,
          { name: "Atomic Co", ownerUserId },
          organizationAccessService,
        );
        const rows = await db.select().from(organizations).where(eq(organizations.id, org.id));
        expect(rows).toHaveLength(1);
        const membership = await db
          .select()
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.organizationId, org.id),
              eq(organizationMemberships.userId, ownerUserId),
            ),
          );
        expect(membership).toHaveLength(1);
        expect(membership[0].role).toBe("owner");
        expect(membership[0].status).toBe("active");
      });
    },
  );
  ```

- [ ] **Step 3: Run the unit test — confirm RED.** The updated unit test now passes a factory; the current (un-refactored) `createSelfServeOrganization` treats the 3rd arg as a bound service (`orgAccess.ensureOrgOwner`), so it throws a TypeError.
  ```
  pnpm exec vitest run --root server src/__tests__/organizations-routes.test.ts
  ```
  Expected (RED):
  ```
   ❯ src/__tests__/organizations-routes.test.ts (1 test | 1 failed)
     × createSelfServeOrganization > creates the org and makes the caller its owner
       → orgAccess.ensureOrgOwner is not a function
   Test Files  1 failed (1)
        Tests  1 failed (1)
  ```

- [ ] **Step 4 (recommended, Windows-local): Run the integration test flipped — confirm RED.** Temporarily change `process.platform !== "linux"` to `false` in the new file's `describe.skipIf(...)`, then:
  ```
  pnpm exec vitest run --root server src/__tests__/organizations-transaction.integration.test.ts
  ```
  Expected (RED — the un-refactored code is not atomic): the rollback test leaves an orphan `Rollback Co` row (the two-await path commits the org before the membership throws), so `expect(after.length).toBe(before.length)` fails; the happy-path test throws `orgAccess.ensureOrgOwner is not a function`.
  ```
   ❯ src/__tests__/organizations-transaction.integration.test.ts (2 tests | 2 failed)
     × ... rolls back the org insert ...  → expected 1 to be 0
     × ... commits the org row AND the owner membership together ...  → orgAccess.ensureOrgOwner is not a function
  ```
  (On Windows without flipping, the file reports `2 skipped` — that is not a RED; you must flip to observe the failure.)

- [ ] **Step 5: Implement the fix in `server/src/services/organizations.ts`.** Replace the doc comment + `createSelfServeOrganization` (lines 98-115).

  Current (`server/src/services/organizations.ts:98-115`):
  ```ts
  /**
   * Self-serve Organization creation (Phase 2, Task 6): any signed-in board user
   * creates a fresh tenant and becomes its owner. Reuses this file's own
   * `organizationService(db).create` for the row insert + slug de-dup — NOT
   * passing `createdByUserId` here, since the owner-membership write goes
   * through the injected `orgAccess.ensureOrgOwner` instead (idempotent /
   * onConflictDoNothing-safe — see organization-access.ts — because P1's
   * ensureRealOperator/backfill may also touch the same membership row).
   */
  export async function createSelfServeOrganization(
    db: Db,
    input: { name: string; ownerUserId: string },
    orgAccess: Pick<ReturnType<typeof organizationAccessService>, "ensureOrgOwner">,
  ) {
    const org = await organizationService(db).create({ name: input.name });
    await orgAccess.ensureOrgOwner(org.id, input.ownerUserId);
    return org;
  }
  ```

  New:
  ```ts
  /**
   * Self-serve Organization creation (Phase 2, Task 6): any signed-in board user
   * creates a fresh tenant and becomes its owner.
   *
   * ATOMICITY (Fix 5): the org-row insert and the owner-membership write run in ONE
   * `db.transaction`, so a transient fault between them can never leave an orphan
   * org (a row with no owner membership that the user can neither reach nor adopt).
   *
   * SLUG RETRY: the slug de-dup loop lives OUTSIDE the transaction — each attempt is
   * a fresh transaction with exactly ONE org insert + membership write. A 23505 slug
   * conflict aborts (and rolls back) only that attempt's transaction and is caught
   * outside it; the next attempt retries with a new candidate slug in a brand-new
   * transaction. Retrying INSIDE a single transaction is impossible: a 23505 aborts
   * the whole PG tx. The low-level `organizationService.create` is intentionally left
   * untouched (still always-insert).
   *
   * Owner membership is written via `buildOrgAccess(tx).ensureOrgOwner` (bound to the
   * TRANSACTION handle) rather than `organizationService.create`'s built-in
   * createdByUserId path, because ensureOrgOwner additionally PROMOTES a pre-existing
   * weaker membership row to owner (idempotent / onConflictDoNothing-safe — P1's
   * ensureRealOperator/backfill may also touch the same (org,user) row).
   */
  export async function createSelfServeOrganization(
    db: Db,
    input: { name: string; ownerUserId: string },
    buildOrgAccess: (handle: Db) => Pick<ReturnType<typeof organizationAccessService>, "ensureOrgOwner">,
  ) {
    const base = slugifyOrganizationName(input.name);
    let attempt = 0;
    while (attempt < 10000) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      try {
        return await db.transaction(async (tx) => {
          const rows = await tx
            .insert(organizations)
            .values({ name: input.name, slug: candidate, plan: "beta", createdByUserId: null })
            .returning();
          const org = rows[0];
          await buildOrgAccess(tx as unknown as Db).ensureOrgOwner(org.id, input.ownerUserId);
          return org;
        });
      } catch (error) {
        if (!isOrgSlugConflict(error)) throw error;
      }
      attempt += 1;
    }
    throw new Error("Unable to allocate unique organization slug");
  }
  ```
  (No import changes: `Db` is imported at line 2, `organizations` at line 3, and `slugifyOrganizationName`/`isOrgSlugConflict` are defined above in the same file. `import type { organizationAccessService }` at line 5 stays type-only — it is still referenced only in `ReturnType<typeof ...>`. The `tx as unknown as Db` cast mirrors `server/src/db/with-tenant-tx.ts:29`.)

- [ ] **Step 6: Update the route call site in `server/src/routes/organizations.ts` (line 22).** Pass the factory (`organizationAccessService`, already imported at line 7) instead of the pre-bound service.

  Current (`server/src/routes/organizations.ts:22`):
  ```ts
      const org = await createSelfServeOrganization(db, { name: req.body.name, ownerUserId: req.actor.userId }, orgAccess);
  ```
  New:
  ```ts
      const org = await createSelfServeOrganization(db, { name: req.body.name, ownerUserId: req.actor.userId }, organizationAccessService);
  ```
  (Leave `const orgAccess = organizationAccessService(db);` at line 14 unchanged — it is still used by the GET handler at line 34: `orgAccess.listOrgMemberships(...)`. `organizationAccessService: (db: Db) => {…ensureOrgOwner…}` structurally satisfies the new `buildOrgAccess` param type.)

- [ ] **Step 7: Run the unit test — confirm GREEN.**
  ```
  pnpm exec vitest run --root server src/__tests__/organizations-routes.test.ts
  ```
  Expected:
  ```
   ✓ src/__tests__/organizations-routes.test.ts (1 test)
   Test Files  1 passed (1)
        Tests  1 passed (1)
  ```

- [ ] **Step 8 (Windows-local, still flipped): Run the integration test — confirm GREEN.**
  ```
  pnpm exec vitest run --root server src/__tests__/organizations-transaction.integration.test.ts
  ```
  Expected:
  ```
   ✓ src/__tests__/organizations-transaction.integration.test.ts (2 tests)
   Test Files  1 passed (1)
        Tests  2 passed (2)
  ```
  Then **revert the temporary skip flip** in that file back to `describe.skipIf(process.platform !== "linux")`.

- [ ] **Step 9: Regression-guard the low-level create — `organizations-uniqueness.integration.test.ts` must stay green** (it exercises `organizationService(db).create` directly, which is untouched). This file uses `describe.skipIf(process.platform !== "linux")` and has **no** `initdbFlags`. On Linux CI it just runs. To confirm locally on Windows, temporarily add `initdbFlags: ["--encoding=UTF8", "--locale=C"]` to its `new EmbeddedPostgres({...})` (line 22) **and** flip its skip to `false`, run, then revert both:
  ```
  pnpm exec vitest run --root server src/__tests__/organizations-uniqueness.integration.test.ts
  ```
  Expected: `Tests  5 passed (5)` (revert the two temporary edits afterward).

- [ ] **Step 10: Typecheck the server package — confirm clean.**
  ```
  pnpm --filter @armyofagents/server typecheck
  ```
  Expected: no output / exit 0 (runs `tsc --noEmit`).

- [ ] **Step 11: Commit.**
  ```
  git add server/src/services/organizations.ts server/src/routes/organizations.ts \
    server/src/__tests__/organizations-routes.test.ts \
    server/src/__tests__/organizations-transaction.integration.test.ts
  git commit -m "$(cat <<'EOF'
  fix(organizations): make self-serve org create atomic (Fix 5)

  Wrap the org insert + owner-membership write in one db.transaction so a
  fault between them can no longer orphan a tenant. The slug-retry loop stays
  OUTSIDE the tx (a 23505 aborts the whole PG tx) — each attempt is a fresh
  transaction. 3rd param of createSelfServeOrganization is now an orgAccess
  factory bound to the tx handle. Low-level organizationService.create is
  untouched; new integration test proves full rollback (no orphan org).

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```
  (If not already on a feature branch, branch first per repo convention before committing.)

---

**Test-fidelity note (per the design's "state whether integration"):** the rollback proof **must** be an embedded-Postgres integration test — the `organizations-routes.test.ts` fakeDb cannot model a real transaction (its pass-through `transaction` never rolls back), so it can only assert the happy-path shape (insert happens, `ensureOrgOwner` is invoked inside the tx). The genuine "no orphan on rollback" and "org + owner membership commit together" assertions live in `organizations-transaction.integration.test.ts`.

---

## Task H — Full 4-actor multi-user integration harness (runs LAST, after Fixes 1–5)

End-to-end proof: a real embedded-Postgres suite in `cloud_auth` mode that scripts two founders (A, B), each self-serving an org and creating two companies, then cross-inviting each other, asserting every tenancy invariant against the *actual* enforcement code (`createSelfServeOrganization`, `companyService.create` → `resolveCompanyOrganizationId`, `approveHumanJoinRequestTx`, `assertCompanyAccess`, `assertCompanyCreateAuthorized`, `team.addMember`). No Google-OAuth dependency.

Depends on Fixes 1, 2, 3, 5 already landed. Specifically:
- Fix 1's guard in `server/src/services/team.ts` `addMember` rejecting direct-add in `cloud_auth` with an error message containing **"invite"** (coordinate exact copy with Fix 1).
- The present server resolver `resolveCompanyOrganizationId` (`server/src/routes/companies.ts:42-57`) + `assertCompanyCreateAuthorized` (`:64-71`), unchanged by Fix 2 (UI-only) — the harness proves the server contract the UI mirrors.

**Files:**
- **Create:** `server/src/__tests__/mt-four-actor-journey.integration.test.ts` (new; the whole task)
- **Test path:** same file
- **Reads (no edits):** `server/src/services/organizations.ts:107-115`, `server/src/services/companies.ts:120-127,210-223`, `server/src/services/join-approval.ts:123-136,184-286`, `server/src/routes/authz.ts:36-79`, `server/src/routes/companies.ts:42-71`, `server/src/middleware/auth.ts:61-93`, `server/src/services/access.ts:250-335`, `server/src/services/organization-access.ts:17-33,47-52`.

Templates followed verbatim: `server/src/__tests__/mt-cross-tenant-service.integration.test.ts` (MT sibling), `server/src/__tests__/organizations-uniqueness.integration.test.ts` (real `companyService.create` on embedded PG), `server/src/__tests__/work-questions.integration.test.ts:186-194` (baked-in `initdbFlags` for Windows-local runs).

### Windows run protocol (every run step)
Committed predicate: `describe.skipIf(process.platform !== "linux")` (Linux CI is the gate; macOS/Windows skip). `initdbFlags: ["--encoding=UTF8","--locale=C"]` is baked into the `EmbeddedPostgres` ctor so the suite is Windows-runnable by flipping the predicate to `describe.skipIf(false)`, running, then flipping back before committing. All run commands are from **repo-root** cwd:
```
pnpm exec vitest run --root server src/__tests__/mt-four-actor-journey.integration.test.ts
```

---

- [ ] **Step 1: Create the harness file — imports, helpers, full seeding backbone + the first `boots+seeds` assertion.** `beforeAll` seeds the entire fixture (2 users, 2 orgs, 4 companies via real services, `ensureRealOperator` ×4, 2 cross-invites through the real approval chokepoint), so the first green run proves the highest-risk backbone.

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  companyMemberships,
  organizationMemberships,
  type Db,
} from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { createSelfServeOrganization } from "../services/organizations.js";
import { organizationAccessService, orgRoleCan } from "../services/organization-access.js";
import { companyService } from "../services/companies.js";
import { accessService } from "../services/access.js";
import { teamService } from "../services/team.js";
import {
  approveHumanJoinRequestTx,
  buildHumanJoinApprovalServices,
  founderApprovalIdentity,
} from "../services/join-approval.js";
import { assertCompanyAccess } from "../routes/authz.js";
import {
  resolveCompanyOrganizationId,
  assertCompanyCreateAuthorized,
} from "../routes/companies.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: any[] }).rows) as any[];

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

let A = "", B = "";
let orgA = "", orgB = "";
let a1 = "", a2 = "", b1 = "", b2 = "";
let a2OrgId = "", b1OrgId = "";

/** Rebuild an actor's memberships with the SAME queries the auth middleware runs
 *  (server/src/middleware/auth.ts:67-85) — plus the org role for Fix 2's filter. */
async function rebuildActor(userId: string) {
  const orgRows = await db
    .select({
      organizationId: organizationMemberships.organizationId,
      role: organizationMemberships.role,
    })
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, "active")));
  const companyRows = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    );
  const organizationRoles: Record<string, string> = {};
  for (const r of orgRows) organizationRoles[r.organizationId] = r.role as string;
  return {
    type: "board" as const,
    source: "session" as const,
    userId,
    organizationIds: orgRows.map((r) => r.organizationId),
    organizationRoles,
    companyIds: companyRows.map((r) => r.companyId),
  };
}

/** Seed invite + pending join_request, then admit via the REAL chokepoint
 *  (writes BOTH company + org membership — join-approval.ts:210,217-219). */
async function admitViaInvite(companyId: string, joiningUserId: string, approverUserId: string) {
  const inviteId = rows(
    await db.execute(sql`
      INSERT INTO invites (company_id, invite_type, token_hash, allowed_join_types, defaults_payload, expires_at)
      VALUES (${companyId}, 'company_join', ${randomUUID()}, 'both', NULL, now() + interval '7 days')
      RETURNING id`),
  )[0].id as string;
  const requestId = rows(
    await db.execute(sql`
      INSERT INTO join_requests (invite_id, company_id, request_type, status, request_ip, requesting_user_id)
      VALUES (${inviteId}, ${companyId}, 'human', 'pending_approval', '127.0.0.1', ${joiningUserId})
      RETURNING id`),
  )[0].id as string;
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    return approveHumanJoinRequestTx(txDb, buildHumanJoinApprovalServices(txDb), {
      companyId,
      requestId,
      requestingUserId: joiningUserId,
      invite: { id: inviteId, defaultsPayload: null },
      ...founderApprovalIdentity({ actorUserId: approverUserId, localImplicit: false }),
    });
  });
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mt-4actor-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      // Baked in so the suite runs locally on Windows by flipping the
      // describe.skipIf below to `false`. Harmless on Linux CI.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const conn = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(conn);
    db = createDb(conn);
    setDeploymentMode("cloud_auth");

    const access = accessService(db);

    // 1) Two real auth users. "user".created_at/updated_at NOT NULL, no default.
    A = rows(
      await db.execute(sql`INSERT INTO "user" (id, email, name, created_at, updated_at)
        VALUES (gen_random_uuid()::text, 'founder-a@x.io', 'Founder A', now(), now()) RETURNING id`),
    )[0].id;
    B = rows(
      await db.execute(sql`INSERT INTO "user" (id, email, name, created_at, updated_at)
        VALUES (gen_random_uuid()::text, 'founder-b@x.io', 'Founder B', now(), now()) RETURNING id`),
    )[0].id;

    // 2) A self-serves org A, then creates A1 + A2 via the REAL service path.
    //    resolveCompanyOrganizationId (single-org actor) picks orgA, not the
    //    sentinel (companies.ts:49). ensureRealOperator mirrors POST /companies:240.
    orgA = (await createSelfServeOrganization(db, { name: "Org A", ownerUserId: A }, organizationAccessService)).id;
    a1 = (
      await companyService(db).create({
        name: "A One",
        organizationId: resolveCompanyOrganizationId({}, { enforced: true, actorOrganizationIds: [orgA] }),
      })
    ).id;
    await access.ensureRealOperator(a1, A);
    const a2Company = await companyService(db).create({
      name: "A Two",
      organizationId: resolveCompanyOrganizationId({}, { enforced: true, actorOrganizationIds: [orgA] }),
    });
    a2 = a2Company.id;
    a2OrgId = a2Company.organizationId as string;
    await access.ensureRealOperator(a2, A);

    // 3) B mirrors.
    orgB = (await createSelfServeOrganization(db, { name: "Org B", ownerUserId: B }, organizationAccessService)).id;
    const b1Company = await companyService(db).create({ name: "B One", organizationId: orgB });
    b1 = b1Company.id;
    b1OrgId = b1Company.organizationId as string;
    await access.ensureRealOperator(b1, B);
    b2 = (await companyService(db).create({ name: "B Two", organizationId: orgB })).id;
    await access.ensureRealOperator(b2, B);

    // 4) Cross-invite through the real approval path.
    await admitViaInvite(a1, B, A);
    await admitViaInvite(b1, A, B);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[mt-four-actor-journey] setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

// COMMITTED: Linux CI only (Issue #114). Windows-local: flip to skipIf(false),
// run, flip back before committing.
describe.skipIf(process.platform !== "linux")(
  "4-actor multi-tenant journey (cloud_auth, real embedded PG)",
  () => {
    it("boots embedded PG and seeds the two-founder / four-company fixture", () => {
      if (setupError) throw new Error(String(setupError));
      expect([A, B, orgA, orgB, a1, a2, b1, b2].every(Boolean)).toBe(true);
      expect(orgA).not.toBe(orgB);
    });
  },
);
```

- [ ] **Step 2: Enable local Windows run.** Change `describe.skipIf(process.platform !== "linux")(` to `describe.skipIf(false)(`.

- [ ] **Step 3: Run boots+seeds; confirm backbone green.**
```
pnpm exec vitest run --root server src/__tests__/mt-four-actor-journey.integration.test.ts
```
Expected: `Test Files  1 passed (1)` / `Tests  1 passed (1)`. On red, read the `[mt-four-actor-journey] setup failed:` console line.

- [ ] **Step 4: Append the org-id-stamp test** (after the `boots…` it, before the describe's `},`):
```ts
    it("stamps each company's organizationId to its intended org (A2 is orgA, not the sentinel)", () => {
      if (setupError) throw new Error(String(setupError));
      expect(a2OrgId).toBe(orgA);
      expect(a2OrgId).not.toBe(DEFAULT_ORGANIZATION_ID);
      expect(b1OrgId).toBe(orgB);
      expect(b1OrgId).not.toBe(DEFAULT_ORGANIZATION_ID);
    });
```
Run. Expected `Tests  2 passed (2)`.

- [ ] **Step 5: Append the actor-rebuild + boundary tests** (after the stamp test):
```ts
    it("rebuilt cross-invited actors carry both orgs with the correct roles", async () => {
      if (setupError) throw new Error(String(setupError));
      const a = await rebuildActor(A);
      const b = await rebuildActor(B);
      expect(new Set(a.organizationIds)).toEqual(new Set([orgA, orgB]));
      expect(a.organizationRoles).toEqual({ [orgA]: "owner", [orgB]: "member" });
      expect(new Set(b.organizationIds)).toEqual(new Set([orgA, orgB]));
      expect(b.organizationRoles).toEqual({ [orgB]: "owner", [orgA]: "member" });
    });

    it("company boundary: A opens B's invited company but 403s on B's other company", async () => {
      if (setupError) throw new Error(String(setupError));
      const a = await rebuildActor(A);
      const reqA = { actor: a } as any;
      await expect(assertCompanyAccess(db, reqA, b1)).resolves.toBeUndefined();
      await expect(assertCompanyAccess(db, reqA, b2)).rejects.toThrow(/access/i);
    });
```
Run. Expected `Tests  4 passed (4)`.

- [ ] **Step 6: Append the Fix 2 + Fix 1 tests** (after the boundary test):
```ts
    it("Fix 2: create-another-company resolves to A's own create-capable org with no 403", async () => {
      if (setupError) throw new Error(String(setupError));
      const a = await rebuildActor(A);
      const createCapable = a.organizationIds.filter((id) =>
        orgRoleCan(a.organizationRoles[id] as any, "company:create"),
      );
      expect(createCapable).toEqual([orgA]);
      expect(() =>
        resolveCompanyOrganizationId({}, { enforced: true, actorOrganizationIds: a.organizationIds }),
      ).toThrow(/multiple organizations/i);
      const orgId = resolveCompanyOrganizationId(
        { organizationId: createCapable[0] },
        { enforced: true, actorOrganizationIds: a.organizationIds },
      );
      expect(orgId).toBe(orgA);
      await expect(
        assertCompanyCreateAuthorized(organizationAccessService(db), orgId, A),
      ).resolves.toBeUndefined();
      expect(await organizationAccessService(db).canOrg(orgB, A, "company:create")).toBe(false);
      const a3 = await companyService(db).create({ name: "A Three", organizationId: orgId });
      expect(a3.organizationId).toBe(orgA);
    });

    it("Fix 1: direct add-member is rejected in cloud; the invite path grants access", async () => {
      if (setupError) throw new Error(String(setupError));
      const b = await rebuildActor(B);
      await expect(assertCompanyAccess(db, { actor: b } as any, a1)).resolves.toBeUndefined();
      await expect(
        teamService(db).addMember(
          a1,
          { name: "Direct Add", email: "direct-add@x.io", role: "team_member" },
          A,
        ),
      ).rejects.toThrow(/invite/i);
    });
```
Run. Expected full green: `Tests  6 passed (6)`.

- [ ] **Step 7: Non-vacuity check.** Temporarily change `expect(a2OrgId).toBe(orgA);` to `expect(a2OrgId).toBe("nope");`, run, confirm it REDS on that test (`AssertionError: expected '<uuid>' to be 'nope'`), then restore and re-run to `Tests  6 passed (6)`.

- [ ] **Step 8: Restore committed skip, typecheck, commit.** Change `describe.skipIf(false)(` back to `describe.skipIf(process.platform !== "linux")(`. Then from repo root:
```
pnpm -F @armyofagents/server typecheck
git add server/src/__tests__/mt-four-actor-journey.integration.test.ts
git commit -m "test(mt): full 4-actor multi-user integration harness (cloud_auth)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
`typecheck` must be clean. On Windows the committed suite reports `1 skipped (1)` / `6 skipped (6)` (expected — Linux CI is the gate).

### Assembler notes
- Test count = 6 (`boots`, `stamp`, `roles`, `boundary`, `Fix 2`, `Fix 1`). Update expected counts if you split/merge.
- Fix 1 coupling: last test asserts `team.addMember` throws `/invite/i` in cloud — keep in sync with Fix 1's error copy.
- Fix 2 is UI-only; harness proves the server contract (create-capable filter → explicit id → resolver → `assertCompanyCreateAuthorized`). The `/multiple organizations/i` throw documents the dead-end Fix 2 removes.
- Cost: 5× real `companyService.create` (full crew/Commander seeding). 180s `beforeAll` budget matches sibling suites; `organizations-uniqueness.integration.test.ts` already validates this create path on Linux CI.
