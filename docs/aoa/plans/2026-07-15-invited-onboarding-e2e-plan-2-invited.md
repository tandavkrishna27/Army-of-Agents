> **SUPERSEDED (invited-journey design) 2026-07-16:** the invited flow described here (JoinOrg step, JOIN_REQUESTED state, approval-side SETUP_COMPLETE) was replaced by the auto-admit design in 2026-07-16-invited-teammate-journey-scope.md / -plan.md, implemented + live-validated on this branch. The tokenless open-invite detection + atomic claim from Plan 2 T2/T3 were ported (adapted into the finalize path); everything else Plan-2-specific is dropped. Plan 1 (harness) and Plan 3 (Commander auth) remain valid and are ported.

# Plan 2 — Invited-Teammate Journey (Workstream 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).
> **Spec:** `2026-07-15-invited-onboarding-e2e-design.md` §5 (v4, Codex-hardened over 3 rounds).
> **Depends on:** Plan 1 (harness). **Branch:** `feat/invited-onboarding-e2e`.

**Goal:** An invited teammate signs in with Google, is recognized by their verified email, completes profile → join, waits on a `/pending` screen (no loop), and gains access when a board member approves — verified-email accept, no token/nonce.

**Architecture:** Extend the journey resolver to detect open company-join invites by verified email and emit a `requestFiled` status; add a tokenless, atomic, idempotent accept endpoint; fix `onboarding.ts` so the invited journey lives entirely on the user layer (org seeds inherit only the identity prefix); add the JoinOrg step + `/pending` page + gate routing; advance `SETUP_COMPLETE` after the approval txn commits; prove it end-to-end (through approval→access) with a per-user e2e identity harness.

**Tech Stack:** Express 5, Drizzle (Postgres), Vitest, React + Vite, Playwright, pnpm.

---

## File Structure

- Modify: `server/src/services/onboarding.ts` — advance-against-requested-journey + seed-only-prefix (§5.0).
- Modify: `packages/shared/src/onboarding.ts` — add `requestFiled` to the invited result; export.
- Modify: `server/src/routes/onboarding-journey.ts` — open-invite detection + `requestFiled`.
- Create: `server/src/services/invite-claim.ts` — shared atomic invite-claim + join-row primitive (extracted from `access.ts`).
- Create: `server/src/routes/onboarding-accept-invite.ts` — `POST /api/onboarding/accept-invite`.
- Modify: `server/src/routes/access.ts` — token-accept uses the shared claim helper; approve advances `SETUP_COMPLETE` after commit.
- Create: `ui/src/onboarding/steps/JoinOrg.tsx`, `ui/src/pages/PendingApproval.tsx`; modify `ui/src/pages/OnboardingFlow.tsx`, `ui/src/App.tsx`, `ui/src/onboarding/steps/index.ts`, `ui/src/api/onboarding.ts`.
- Create (e2e identity harness): `server/src/routes/test-support.ts` (extend Plan 1's), `tests/e2e/helpers/google-mock.ts`, specs.

---

## Task 1: `onboarding.ts` — advance against requested journey + seed-only-prefix (§5.0)

> **Real signatures (Codex-verified):** `computeAdvance(order, current, completed, requested)` → `{kind:"illegal"|"noop"|"advance", newCurrent?, newCompleted?}` — 4 positional args, no journey. `advanceState` currently orders by **`orderedStatesFor(row.journey)`** (the bug) and its version-guarded update at `onboarding.ts:~151` is where `journey` must be persisted. `ensureProgress` seeds BOTH `seedCurrent = userLayer.currentState` and `seedCompleted = [...userLayer.completedStates]` (`onboarding.ts:~95`) — both must be filtered.

**Files:**
- Modify: `server/src/services/onboarding.ts`
- Test: `server/src/__tests__/onboarding-journey-reconcile.test.ts`

- [ ] **Step 1: Failing test (real signatures)**

```ts
// server/src/__tests__/onboarding-journey-reconcile.test.ts
import { describe, it, expect } from "vitest";
import { seedFromUserLayer, IDENTITY_PREFIX_STATES } from "../services/onboarding.js";

describe("§5.0 layer hygiene", () => {
  it("IDENTITY_PREFIX_STATES is exactly AUTHENTICATED + PROFILE_SET", () => {
    expect(IDENTITY_PREFIX_STATES).toEqual(["AUTHENTICATED", "PROFILE_SET"]);
  });
  it("seedFromUserLayer keeps only the identity prefix (current + completed)", () => {
    // A user-layer row that went through the invited journey to SETUP_COMPLETE
    const seed = seedFromUserLayer({
      currentState: "SETUP_COMPLETE",
      completedStates: ["AUTHENTICATED", "PROFILE_SET", "JOIN_REQUESTED", "SETUP_COMPLETE"],
    });
    expect(seed.completedStates).toEqual(["AUTHENTICATED", "PROFILE_SET"]);
    expect(seed.currentState).toBe("PROFILE_SET"); // NOT SETUP_COMPLETE
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement — three precise changes in `onboarding.ts`:**

```ts
export const IDENTITY_PREFIX_STATES = ["AUTHENTICATED", "PROFILE_SET"] as const;

// Extracted pure helper (tested above) — used by ensureProgress' org-layer seed.
export function seedFromUserLayer(userLayer: { currentState: OnboardingState; completedStates: OnboardingState[] }) {
  const completedStates = userLayer.completedStates.filter((s) =>
    (IDENTITY_PREFIX_STATES as readonly string[]).includes(s),
  );
  // seedCurrent = the highest prefix state actually present (PROFILE_SET if completed, else AUTHENTICATED)
  const currentState: OnboardingState = completedStates.includes("PROFILE_SET") ? "PROFILE_SET" : "AUTHENTICATED";
  return { currentState, completedStates };
}
```
1. In `ensureProgress` (the `args.companyId != null` seed branch), replace `seedCompleted = [...userLayer.completedStates]; seedCurrent = userLayer.currentState;` with `const s = seedFromUserLayer(userLayer); seedCompleted = s.completedStates; seedCurrent = s.currentState;`.
2. In `advanceState`, order by the **requested** journey: `const order = orderedStatesFor(args.journey);` (NOT `row.journey`).
3. In `advanceState`'s version-guarded `.update(...).set({...})`, add `journey:` — adopt the requested journey ONLY when the requested state is journey-exclusive (keep the row's journey for shared states):

```ts
const isShared = FOUNDER_PHASE1_STATES.includes(args.requestedState) &&
                 INVITED_PHASE1_STATES.includes(args.requestedState);
// ...in .set({ currentState, completedStates, version: row.version + 1, journey: isShared ? row.journey : args.journey })
```

- [ ] **Step 4: Add an `advanceState` behavioral test** — with a sequence-mock db: a `{journey:"founder", currentState:"PROFILE_SET", completedStates:["AUTHENTICATED","PROFILE_SET"]}` row + `advanceState(..., {journey:"invited", requestedState:"JOIN_REQUESTED"})` → `status:"ok"`, and the update `.set` received `journey:"invited"` + `completedStates` incl `JOIN_REQUESTED`.

- [ ] **Step 5: Run, verify PASS; full server suite (this file is central); commit.**

---

## Task 2: Resolver — open-invite detection + `requestFiled` (§5.1)

**Files:**
- Modify: `packages/shared/src/onboarding.ts` — add **required** `requestFiled: boolean` to `PostAuthJourneyResult` (populate it for returning/invited/founder so missing wiring can't silently route as false — Codex P2 #1); `pnpm --filter @armyofagents/shared build`.
- Modify: `server/src/routes/onboarding-journey.ts`.
- Test: `server/src/__tests__/onboarding-journey-invited-detect.test.ts` + integration `*.integration.test.ts` (embedded-pg for the jsonb path).

- [ ] **Step 1: Failing unit tests** — feed `getJourneyForUser` a sequence-mock db: (a) `[]` memberships, `[]` join_requests, one open invite (company_join, human, verified-email) → `journey:"invited"`, `targetCompanyId`, `requestFiled:false`; (b) an existing join_request → `requestFiled:true`; (c) agent-only invite → not matched; (d) **multiple** same-email open invites → the pendingInvitations are **deterministically ordered** (by `createdAt`, then `companyId`) and `targetCompanyId` is the first — no nondeterminism (Codex P1 #6).

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — add an open-invite query in `getJourneyForUser`:

```ts
// only when emailVerified && email — select ALL columns PendingInvitation needs
const openInvites = await db
  .select({
    companyId: invites.companyId,
    companyName: companies.name,          // join companies
    inviteId: invites.id,
    defaults: invites.defaultsPayload,    // role via teamInvite.role
    createdAt: invites.createdAt,
  })
  .from(invites)
  .innerJoin(companies, eq(companies.id, invites.companyId))
  .where(and(
    isNull(invites.acceptedAt), isNull(invites.revokedAt),
    gt(invites.expiresAt, new Date()),
    eq(invites.inviteType, "company_join"),
    inArray(invites.allowedJoinTypes, ["human", "both"]),
    isNotNull(invites.companyId),
    sql`lower(${invites.defaultsPayload} -> 'teamInvite' ->> 'email') = lower(${email})`,
  ))
  .orderBy(invites.createdAt, invites.companyId);   // deterministic (Codex P1 #6)
// requestFiled = a pending/approved human join_request already exists for (user, targetCompany)
```
Map to `PendingInvitation[]` (companyId, companyName, inviteId, role-from-defaults, createdAt), de-dup against the join-request matches, set `requestFiled` per target from the join_requests query, and set `targetCompanyId` to the first ordered invitation. Keep precedence `returning > invited > founder`.

- [ ] **Step 4: Integration test (embedded-pg)** — real jsonb `teamInvite.email` match, verified-email gate, agent-only exclusion. (`initdbFlags: ["--encoding=UTF8","--locale=C"]`.)

- [ ] **Step 5: Run all, full server suite, commit.**

---

## Task 3: Shared invite-claim helper + tokenless accept endpoint (§5.2)

**Files:**
- Create: `server/src/services/invite-claim.ts` (atomic claim + join-row; extracted from `access.ts` accept txn WITHOUT changing token-path behavior).
- Modify: `server/src/routes/access.ts` (token-accept calls the helper; agent-replay branch unchanged).
- Create: `server/src/routes/onboarding-accept-invite.ts` (mount in app.ts).
- Test: unit (`invite-claim.test.ts`) + route (`accept-invite-route.test.ts`) + integration (concurrency).

- [ ] **Step 1: Failing unit test for `claimInviteAndFileJoinRequest`** — mock db; assert: inserts a `pending_approval` human join_request with `requestingUserId=actor`, `requestEmailSnapshot=email`; on unique-conflict (`onConflictDoNothing` returns []), re-selects the winner; **validates winner is `requestType==="human"` && `requestingUserId===actor`** else throws conflict.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement the helper** — the atomic primitive only (claim invite `acceptedAt`, insert join_request, conflict→reselect+validate). Keep it pure of the token/agent branches.

- [ ] **Step 4: Refactor `access.ts` token-accept** to call the helper for the human-claim primitive; run the existing access tests — **must stay green** (agent replay `access.ts:1991/2151` untouched).

- [ ] **Step 5: Implement the route** — `POST /api/onboarding/accept-invite`. **ORDER MATTERS (Codex P1 #3): existing-request lookup FIRST**, because the first accept marks `invites.acceptedAt` so the open-invite query would then miss and 404 a legitimate retry.

```ts
router.post("/onboarding/accept-invite", async (req, res) => {
  const actor = req.actor;
  if (actor.type !== "board" || !actor.userId) return void res.status(401).json({ error: "auth required" });
  const companyId = String(req.body?.companyId ?? "");

  // 1. IDEMPOTENT-FIRST: an existing human join_request owned by this actor for
  //    this company → return it (200), regardless of the invite's acceptedAt.
  const existing = await findHumanJoinRequest(db, companyId, actor.userId); // pending or approved
  if (existing) return void res.json({ status: existing.status, companyId, joinRequestId: existing.id });

  // 2. Already a member → done.
  if (await isMember(db, companyId, actor.userId)) return void res.json({ status: "already_member", companyId });

  // 3. Otherwise require an OPEN verified-email company_join invite, then claim atomically.
  const { invite, email } = await findOpenInviteForVerifiedEmail(db, actor.userId, companyId) ?? {};
  if (!invite) return void res.status(404).json({ error: "no matching invitation" });
  const jr = await claimInviteAndFileJoinRequest(db, { invite, userId: actor.userId, email });
  res.json({ status: "pending_approval", companyId, joinRequestId: jr.id });
});
```
`findHumanJoinRequest` matches `join_requests` where `companyId`, `requestType='human'`, `requestingUserId=actor`, status in `('pending_approval','approved')`. `findOpenInviteForVerifiedEmail` reuses Task 2's predicate (company_join + human/both + unaccepted/unrevoked/unexpired + verified-email match) and returns the invite + the verified email.

- [ ] **Step 6: Route test (401/404/already_member/created) + concurrency integration** (two parallel accepts → one row, both non-error).

- [ ] **Step 7: Full server suite, commit.**

---

## Task 4: `JoinOrg` step (reads `?company=` from the router) (§5.3)

> **Codex P1 #4:** `StepProps` is `{ctx, onComplete, onBack}` (`registry.ts`) — no slot for an invitation context, and `FlowEngine` passes exactly those props. Rather than widen the generic step interface, **JoinOrg reads the company from the router** (`?company=<id>`), matching how the invited route is reached (`App.tsx` → `/onboarding/join?company=`). This keeps `StepProps`/`FlowEngine` untouched.

**Files:**
- Create: `ui/src/onboarding/steps/JoinOrg.tsx`; modify `ui/src/onboarding/steps/index.ts`; add `acceptInvite` to `ui/src/api/onboarding.ts`.
- Test: `ui/src/onboarding/steps/__tests__/JoinOrg.test.tsx`.

- [ ] **Step 1: Failing RTL test** — mock `acceptInvite` + `advanceOnboarding` + the router (`useSearchParams` → `company=c2`); render `JoinOrg`; click "Join organization" → asserts `acceptInvite({companyId:"c2"})` then `advanceOnboarding({companyId:null,journey:"invited",requestedState:"JOIN_REQUESTED"})` then `onComplete`. No `?company=` → button disabled + "open your invite link, or ask an admin to re-invite {your email}".

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — JoinOrg reads `companyId = useSearchParams().get("company")` (NOT `ctx.companyId`, which is null on the invited layer); on Join: `acceptInvite({companyId})` → `advanceOnboarding({companyId:null, journey:"invited", requestedState:"JOIN_REQUESTED"})` → `onComplete()`. Register `{ id:"join", order:20, state:"JOIN_REQUESTED", journeys:["invited"], dependsOn:["PROFILE_SET"], canSkip:false, shouldInclude:()=>true, isComplete:(c)=>c.completedStates.includes("JOIN_REQUESTED"), Component: JoinOrg, title:"Join your organization" }`. Add `acceptInvite` client (`POST /api/onboarding/accept-invite`).

- [ ] **Step 4: Run, verify PASS; UI typecheck; commit.**

---

## Task 5: Pending-approval screen + re-entry (§5.4)

> **Codex P1 #4 reconciliation:** the real `OnboardingFlow` already renders `<InvitedPendingPage/>` in-place when its `invitedDone` state is set (via the invited `onFinished`) — NOT via a route. Keep that in-place pattern (no new `/pending` route). Two entry points must both reach pending: (a) **immediate** — JoinOrg `onComplete` → `onFinished` → `invitedDone=true`; (b) **re-entry** — a returning invited user whose request is already filed.

**Files:**
- Create: `ui/src/pages/PendingApproval.tsx` (upgrades the `InvitedPendingPage` stub).
- Modify: `ui/src/pages/OnboardingFlow.tsx` (render `PendingApproval` when `invitedDone` **OR** the resolver reports `requestFiled` for this invited target).
- Test: `ui/src/__tests__/pending-approval.test.tsx` + an OnboardingFlow re-entry test.

- [ ] **Step 1: Failing test** — (a) OnboardingFlow (invited) with a mocked journey `{journey:"invited", targetCompanyId, requestFiled:true}` renders `PendingApproval` immediately (never the profile/JoinOrg steps). (b) `PendingApproval` refetches the journey on window focus + interval; when it becomes `returning`, it navigates into the company (`/{prefix}/home`).

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — `PendingApproval` ("Your request to join {companyName} is awaiting approval") with `refetchOnWindowFocus` + a polling interval on the journey query; on `returning`, navigate in. In `OnboardingFlow`, gate the invited render: `invitedDone || journey.requestFiled` → `<PendingApproval companyId=… />`, else `<FlowEngine .../>`.

- [ ] **Step 4: Run, typecheck, commit.**

---

## Task 6: Approval → `SETUP_COMPLETE` after commit (§5.5)

**Files:**
- Modify: `server/src/routes/access.ts` (approve route, AFTER the txn commits ~L2576).
- Test: `server/src/__tests__/approve-advances-setup-complete.test.ts`.

- [ ] **Step 1: Failing test** — the approve txn resolves, THEN a spy `advanceState` is invoked with `{ userId: existing.requestingUserId, companyId:null, journey:"invited", requestedState:"SETUP_COMPLETE" }` (the requesting user, **NOT** the approving actor — Codex P2 #4). Assert the transaction promise resolved *before* the advance runs (not merely that both were called). A variant where `advanceState` throws → the route still returns success (approval not rolled back).

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — after the existing approval `db.transaction(...)` **has resolved** (~`access.ts:2576`, outside the txn), for `requestType==="human"`, best-effort `ensureProgress` + `advanceState(db, { userId: existing.requestingUserId, companyId:null, journey:"invited", requestedState:"SETUP_COMPLETE" })` in its own try/catch (never throws out of the handler).

- [ ] **Step 4: Run, full server suite, commit.**

---

## Task 7: Per-user e2e identity harness — REAL session cookie (`injectGoogleSession`)

> **Codex P1 #5:** do NOT add an `x-e2e-identity` impersonation header — it bypasses the production `resolveSession` path and `AOA_DEV_LOCAL_IDENTITY` is the general local escape hatch, not an e2e-only flag. Instead **seed a real Better-Auth `user` + `session` and set the real signed session cookie**, so the middleware's `resolveSession` (`auth.ts:45`) is exercised exactly as in production. Gate the seeding route behind the SAME fail-closed test-support gate as Plan 1's reset route (local_trusted + `AOA_DEV_LOCAL_IDENTITY=1`, loopback) — no new privilege beyond what the trusted-loopback escape hatch already grants.

**Files:**
- Modify: `server/src/routes/test-support.ts` — add `POST /api/test/session`.
- Create: `tests/e2e/helpers/google-mock.ts`.
- Test: `server/src/__tests__/test-session-route.test.ts`.

- [ ] **Step 1: Failing test** — `POST /api/test/session {email, name}` (gated) upserts a verified `user` row, mints a Better-Auth session, and responds with `Set-Cookie` for the session token; returns `{ userId }`. Assert: user row created with `emailVerified=true`; a `session` row exists; the response sets the session cookie.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — the route upserts the user, then creates the session via the Better-Auth instance so the cookie is correctly signed for v1.6.13 (confirm the exact API/cookie name against `server/src/auth/better-auth.ts`; if no server-side "create session" API is exposed, insert the `session` row and sign the `better-auth.session_token` cookie with the server's Better-Auth secret using its cookie util). The point: the cookie must validate through the real `resolveSession`.

- [ ] **Step 4: Helper** — `injectGoogleSession(browser, { email, name })`: POST `/api/test/session`, capture the `Set-Cookie`, return a `browser.newContext({ storageState: { cookies:[…], origins:[] } })` (or add the cookie to a context) so the page acts as that user. Two identities (founder + invitee) = two contexts.

- [ ] **Step 5: Run, verify PASS (route test on Windows; the full session-cookie round-trip is exercised by Task 8's e2e on CI); commit.**

---

## Task 8: Invited e2e — through approval to ACCESS + visual (§5.6)

**Files:**
- Create: `tests/e2e/onboarding-invited-join.spec.ts` (+ visual), `tests/e2e/onboarding-second-org.spec.ts`.

- [ ] **Step 1: Invited-join spec** — founder context (`injectGoogleSession` founder) seeds a company + a human `company_join` invite for `invitee@e2e.test`; invitee context → `/onboarding` resolves invited → profile → JoinOrg files request → **assert pending screen**, never a create-org heading; assert server `pending_approval` exists. Re-entry (`goto /` → `/onboarding`) stays on pending (no loop). Then **founder approves** (API) → invitee reloads → resolver `returning` → company home reachable; **assert membership + role via API**. Capture per-screen screenshots + a **committed baseline for BOTH the invited Join screen and the pending screen** (`toHaveScreenshot`, Codex P1 #7).

- [ ] **Step 2: Second-org + `?new=1` spec (Codex P1 #6)** — a founder who already has one org, from the Lobby "New organization" → `/onboarding?new=1`, **skips the user layer** (no "Your profile"; starts at "Create your organization"); assert it reaches org creation without re-doing profile, and that an invited `SETUP_COMPLETE` on the user layer (seeded) does NOT block this founder flow (the §5.0 regression, proven end-to-end).

- [ ] **Step 3: Run (CI/Linux or local DATABASE_URL), verify PASS; commit.**

---

## Self-review notes
- Every §5 subsection maps to a task: §5.0→T1, §5.1→T2, §5.2→T3, §5.3→T4, §5.4→T5, §5.5→T6, §5.6→T7+T8.
- High-risk matrix (spec §7) covered: concurrent accept (T3), founder→invited reconcile (T1), approval-progress-failure (T6), agent-only/expired invites (T2/T3).
- The invite-claim helper extraction (T3) must keep the token-accept path green — run the existing access suite after T3 Step 4.
