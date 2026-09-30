# Revision B — Re-Review Fixes + Amended Contracts (TOP AUTHORITY)

> **This is the top authoritative document.** It layers on Revision A (`revA-codex-fixes.md`) and **supersedes revA and the stage docs wherever they overlap**. Applied after the 2026-07-12 Codex *re-review* (which found the revA fixes directionally correct but with precision gaps + 8 P1 edge cases). Read revB → revA → Stage 0 before executing anything.

**Re-review verdict on the pre-revB plan:** "not safe to start Stage A" — R4/R5/R8/R9 + returning-plus-invited affect Stage A contracts directly. All resolved below. Housekeeping already done: stageC null-byte repaired; residual non-canonical commands swept (0 remaining).

---

## 1. Amended contracts (AUTHORITATIVE — replace Stage 0's versions)

### 1.1 `onboarding_progress` — add `version` + split partial unique indexes
```ts
import { integer, jsonb, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

export const onboardingProgress = pgTable("onboarding_progress", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }), // null = user-layer
  journey: text("journey").notNull(),                                   // "founder" | "invited"
  currentState: text("current_state").notNull(),
  completedStates: jsonb("completed_states").$type<string[]>().notNull().default([]),
  version: integer("version").notNull().default(0),                     // NEW: monotonic ETag (two-device)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userCompanyUq: uniqueIndex("onboarding_progress_user_company_uq")
    .on(t.userId, t.companyId).where(sql`${t.companyId} IS NOT NULL`),   // org-layer: one per (user, company)
  userLayerUq: uniqueIndex("onboarding_progress_user_layer_uq")
    .on(t.userId).where(sql`${t.companyId} IS NULL`),                    // user-layer: exactly one per user
}));
```

### 1.2 `advanceState` semantics — monotonic + union + optimistic version (covers R2, R13, edge #3)
1. Read row `{ version:V, currentState:S, completedStates:C }`.
2. **Validate** the requested state is a legal next state for the journey's ordered state list (reject skipped/out-of-order).
3. `newCompleted = union(C, [requestedState])`; `newCurrent = furthestInOrder(S, requestedState)` — **never regress**.
4. Optimistic write: `UPDATE … SET current_state=newCurrent, completed_states=newCompleted, version=V+1, updated_at=now() WHERE id=? AND version=V`. If 0 rows updated (a concurrent device advanced), **re-read and re-merge** (bounded retry). Net effect: forward-only, union of completed, no lost progress across devices/tabs.
5. Upsert (create-or-advance) uses split branches matching the partial indexes (see 3.RB2).

### 1.3 `ONBOARDING_STATES` — add `JOIN_REQUESTED`
Insert `"JOIN_REQUESTED"` after `"PROFILE_SET"`. Lists:
- `FOUNDER_PHASE1_STATES` unchanged.
- `INVITED_PHASE1_STATES = ["AUTHENTICATED","PROFILE_SET","JOIN_REQUESTED","SETUP_COMPLETE"]`.

### 1.4 `PostAuthJourneyResult` — add `pendingInvitations`
```ts
export type PendingInvitation = { companyId: string; companyName: string; inviteId: string; role: string; createdAt: string };
export type PostAuthJourneyResult = {
  journey: "founder" | "invited" | "returning";
  targetCompanyId: string | null;
  pendingInvitations: PendingInvitation[];   // NEW
  inviteToken?: string | null;
};
```
**Resolver precedence:** active membership → `returning` (populate `pendingInvitations` with any open invites); else open **human** join_request/invite (verified-email matched) → `invited` (`targetCompanyId` = chosen/only invite; `pendingInvitations` = all eligible); else `founder`. **Rejected** join_requests never route `invited`.

### 1.5 `StepDefinition` — add `order` + `shouldInclude` (extensibility hardening)
```ts
export type StepDefinition = {
  id: string;
  order: number;                                 // NEW: explicit ordering (engine sorts by this, not array index)
  state: OnboardingState;
  journeys: OnboardingJourney[];
  dependsOn: OnboardingState[];
  canSkip: boolean;
  shouldInclude: (ctx: StepContext) => boolean;  // NEW: is this step APPLICABLE (policy)? — distinct from…
  isComplete: (ctx: StepContext) => boolean;     // …is it already DONE?
  Component: React.LazyExoticComponent<React.ComponentType<StepProps>>;
  title: string;
};
```
`resolveNextStep` = first (by `order`) step where `journeys.includes(journey)` AND `shouldInclude(ctx)` AND `dependsOn ⊆ completedStates` AND `!isComplete(ctx)`. **Startup guard (test + boot):** assert unique `id`s and **no dependency cycles**; throw otherwise.
**Deferred (all additive, add when a journey needs them — do NOT build now):** `facts: Record<string,unknown>` on `StepContext` + `branch(ctx)` for dynamic mid-flow branch selection; namespaced `substate` for resumable sub-flows; an `onboarding_step_instances` table for repeatable steps.

---

## 2. The three product decisions (LOCKED by the founder 2026-07-12)
- **D-Invite:** a **returning user who is also invited** lands in their normal Lobby with the pending invite shown as a **card** (`pendingInvitations`); never auto-routed. Multiple invites → multiple cards; user picks.
- **D-Sync:** **local-first two-device model = forward-only + union + version** (§1.2). Progress can only move forward; no completed step is ever lost.
- **D-Scope:** contract-level edge cases fold into Phase 1 **now** (this doc); recovery paths (Commander-expiry, GitHub-unusable) are sequenced **Stage C tasks** — still Phase 1, just later in build order.

---

## 3. Tightened fixes (supersede the matching revA items)

**RB1 (R1 handoff race).** `setSelectedCompanyId(created.id)` then `onComplete()` is unsafe under React batching. FlowEngine must advance in a `useEffect` that fires only once `selectedCompanyId === created.id` (ref-guarded to prevent double-advance). Test: create → assert state written with the new id → EnvironmentStep renders.

**RB2 (R2 upsert target).** `onConflictDoUpdate` cannot infer a partial index from `target: userId` alone. Split: user-layer → `target: userId, targetWhere: sql\`company_id IS NULL\``; org-layer → `target: [userId, companyId], targetWhere: sql\`company_id IS NOT NULL\``. Add generated-migration + real-Postgres concurrency tests.

**RB3 (R4 promotion location).** Move `promoteFirstUserToInstanceAdmin` out of the `/journey` endpoint into the **post user-create / first-sign-in hook** (better-auth `databaseHooks.user.create.after`, or a session-established server hook) so "first user" = first real Google user, not first endpoint caller. Keep the `pg_advisory_xact_lock`. Test two *distinct* concurrent users → exactly one admin.

**RB4 (R5 + escape-hatch on populated instance).** (a) call `ensureLocalTrustedBoardPrincipal` only when `devLocalIdentity`; (b) **refuse to enable `devLocalIdentity` when real (non-synthetic) users already exist**, unless an explicit recovery flag (`AOA_DEV_LOCAL_IDENTITY_FORCE=1`) is set; log the transition. Define the one-time cleanup of the synthetic `local-board` `instance_admin` once a real Google admin exists. Tests: fresh instance promotes first Google user; populated instance refuses the hatch without the force flag.

**RB5 (R7 approval-advance).** Extract an **internal accept service** reused by `/invite/:token/accept` and `/onboarding/join`. Invited progress advances to `SETUP_COMPLETE` **inside the approval transaction** (or an idempotent post-approval reconciliation) *after* `ensureMembership(...,"active")` + `applyInviteRole` — and only after verifying **both** active membership **and** the expected role (edge #8). Delete Stage D's superseded three-state block.

**RB6 (R8 token round-trip).** Carry the invite token across OAuth via **better-auth generated-state `additionalData`** (≥1.6.11) **or** a server-side nonce record + HttpOnly `SameSite=Lax` cookie. The nonce → a **hashed** invite token stored server-side, **bound to the authenticated user/email**, **one-time consumption**, TTL expiry, Origin/CSRF checks. Consume it **in the accept operation**, not merely at journey resolution. Never in a URL/`sessionStorage`. Do NOT hand-roll/replace better-auth's own `state`/PKCE.

**RB7 (R9 detection).** Query open **human** join_requests (`requestType="human"`, `status="pending_approval"`) by `requestingUserId` + normalized `requestEmailSnapshot` (**verified email only** — edge #2). Precedence per §1.4; **rejected never routes invited**. Return `pendingInvitations` for returning users (edge #1). Multiple eligible invites → return all, user picks (edge #9).

**RB8 (R14 Commander login precedes agent).** The existing `claude-login` route requires an already-created `claude_local` agent, but Commander verify runs **before** agent creation. Build a **company/Commander-scoped login route for Claude** AND a **net-new Codex login route** (parity), each surfacing a `loginUrl`/device flow + re-probe. Plus the earlier Commander tasks: `T-ProbeBlocking` (block on `status:"fail"`), `T-CommanderProbeSurface` (return a normalized installed/authenticated/method summary).

---

## 4. Edge-case behaviors folded in
| # | Edge case | Behavior | Where |
|---|-----------|----------|-------|
| 1 | Returning user also invited | Lobby shows `pendingInvitations` cards; no auto-route | RB7 + Lobby task |
| 2 | Missing/unverified Google email | Require provider-verified email before email-based invite match; never match on absent email | RB7 |
| 3 | Two-device progress race | Forward-only + union + version | §1.2 |
| 4 | Partial org-create | Company-create uses an **idempotency key** (`setupKey`) so resume reuses the same company; persist `ORGANIZATION_CREATED` transactionally with the create | Stage C C4 (amended) |
| 5 | Commander creds expire/fail | Distinguish invalid/expired/rate-limit/network/CLI; transient = retryable without clearing choice; re-validate before first real run | **Stage C recovery task** |
| 6 | GitHub repo unusable | Validate install+repo access at selection AND before first use; reconnect or local-folder fallback without losing department state | **Stage C recovery task** |
| 7 | Invite role in completion | Verify active membership + expected role in the approval txn | RB5 |
| 8 | Escape hatch on populated instance | Refuse unless `..._FORCE`; log | RB4 |
| 9 | Multiple simultaneous invites | Return all, user picks | RB7 |
| 10 | Rejection after `JOIN_REQUESTED` | Show rejection, clear target-company context, allow founder flow or another invite | Stage D (amended) |

---

## 5. Test rigor (acceptance-level — no "add tests" placeholders)
- **Per-task TDD** (red proven against current code — fixes R12/A3).
- **Real-Postgres concurrency tests** (not mocks): two-distinct-user first-admin (RB3), duplicate user-layer row (RB2), two-device advance race (§1.2), partial-index upsert.
- **Security integration:** better-auth social start/callback `state`/PKCE, mismatch/replay rejection, session binding, cookie flags; invite-token nonce lifecycle (hashed, bound, one-time, expiry, CSRF); escape-hatch refused in hosted + refused-on-populated.
- **Invited:** returning+invitations, verified-email gating, approval-gated completion with role check, rejected-never-routes, multi-invite pick, rejection recovery.
- **Commander:** `testEnvironment` parse, both auth methods, probe-blocks-on-fail, pre-agent login routes (Claude + Codex), credential-expiry recovery.
- **Extensibility guard:** boot/test rejects duplicate step ids + dependency cycles.
- **E2E (Google mocked):** founder happy path, resume-after-abandon, invited join, 2nd-org-skips-user-layer (Windows embedded-pg skip noted).
- **Gates each stage:** `pnpm typecheck` + `pnpm test:run` + `pnpm build`.

---

## 6. Execution order
1. **RB4 + R6** (startup-lockout / escape-hatch) — first.
2. **RB3** (first-admin in the sign-in hook).
3. **RB1** (org→engine handoff), **RB2** (upsert/indexes), **§1.2** advance semantics, **R13** (real probe).
4. **RB5 / RB6 / RB7** (invited: accept service, token round-trip, detection + verified email + pending invitations).
5. **RB8** (Commander login routes) + edge #4 idempotency + Stage C recovery tasks (edge #5/#6) + edge #10.
6. **Tests + gates** throughout; then a final targeted re-review before Stage A ships.
