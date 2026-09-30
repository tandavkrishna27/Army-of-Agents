> **SUPERSEDED (invited-journey design) 2026-07-16:** the invited flow described here (JoinOrg step, JOIN_REQUESTED state, approval-side SETUP_COMPLETE) was replaced by the auto-admit design in 2026-07-16-invited-teammate-journey-scope.md / -plan.md, implemented + live-validated on this branch. The tokenless open-invite detection + atomic claim from Plan 2 T2/T3 were ported (adapted into the finalize path); everything else Plan-2-specific is dropped. Plan 1 (harness) and Plan 3 (Commander auth) remain valid and are ported.

# Invited Onboarding + E2E + Commander Auth — Design Spec

> **Parent roadmap:** `docs/aoa/plans/2026-07-13-onboarding-auth-remaining-phases.md` (defines Tracks A–E). This spec covers **Track B (whole) + Track D + Track C**. Track A (Phase-1 hardening) and Track E (Phase-2 walkthrough) are out of scope here.
> **Worktree/branch:** `feat/invited-onboarding-e2e` off `main @ a0afa102c`.
> **Authority order for design questions:** revC > revB > revA > stage docs.

---

## 1. Goal

Ship the **invited-teammate onboarding journey** with **automated end-to-end coverage**, and add **in-app Commander CLI auth** (login + API-key) so Commander verify no longer requires dropping to a terminal.

After this lands: an invited teammate signs in with Google, is recognized by their invited email, completes *profile → join* through a guided flow, waits on a clear "pending approval" screen (no redirect loop), and gains access when a board member approves — all proven by Playwright specs that also retroactively cover the founder happy-path. And a founder can authenticate Commander's CLI (Claude subscription login, Codex login, or an encrypted API key) from inside the app.

---

## 2. Decisions locked (from brainstorm, 2026-07-15)

1. **Accept model = verified-email (the "C" model).** An invited user is admitted by a **Google-verified email that matches an admin-created invite**, then **board approval**. The invite *token/link* is no longer required to accept — it becomes an optional company hint. Rationale: the token and the emailed link share the same trust root (control of the mailbox), which Google's `emailVerified` already proves; verified-email binds to the *exact* invited identity (an enterprise virtue), removes the secret-in-URL/nonce surface, and keeps the approval gate as the real control.
2. **Token/nonce handoff is SHELVED** (the parent roadmap's B2). Not built unless a concrete email-mismatch need appears. This supersedes roadmap B2's "token-handoff-first."
3. **Email-mismatch = governance dead-end, by design.** If the Google login email ≠ the invited email, the user cannot self-join; an admin re-invites to the address they actually use.
4. **Dedicated `/pending` page + index-gate routing fixes the loop.** After JoinOrg files the request, the user lands on a terminal "pending approval" screen; the index gate, seeing `invited` + a filed request, routes there instead of back to `/onboarding/join`.
5. **Track C built in full now** (API-key + Claude pre-agent login + net-new Codex login). The device-flow login routes are **dogfood-verified** (need a live CLI/account); we unit-test route wiring/parsing/secret storage, and the spec says plainly that headless tests do not prove the live device flow.

---

## 3. What already exists on `main` (reused, not rebuilt)

- **Profile step** already tagged `journeys: ["founder","invited"]`.
- **Invite + approval machinery:** `POST /invites/:token/accept` (files a `join_request`, `access.ts:~2106`) and the approve txn (`access.ts:~2431` → `ensureMembership`/`setPrincipalGrants`/`applyInviteRole`).
- **Journey resolver** `getJourneyForUser` (`server/src/routes/onboarding-journey.ts`) — currently detects invited by a **pending `join_request`** matching the verified email; returns `PostAuthJourneyResult`.
- **Session-2 `InvitedPendingPage` stub** in `OnboardingFlow.tsx` (we complete it).
- **Commander verify gate** (`commander-verify` service + route + `VerifyStep`, 200 verified / 422 else) — Track C is a UX upgrade on top, not a correctness fix.
- **e2e config** already sets `AOA_DEV_LOCAL_IDENTITY=1` (Session-2); `onboarding.spec.ts` is `test.skip`.
- **fake-claude / fake-codex** e2e fixtures on PATH.

**Confirmed gap (the reason Workstream 2 needs new server work):** the `join_request` is created only *at token-accept time*, so the resolver's email-match never fires for a brand-new invitee who hasn't clicked a token link. The verified-email model therefore adds **invite-level detection** + a **tokenless accept endpoint** (§5.1–5.2).

---

## 4. Workstream 1 — E2E harness (build first)

The harness unblocks all verification and retroactively covers the already-merged founder flow.

### 4.1 `injectGoogleSession` helper — `tests/e2e/helpers/google-mock.ts`
- **What it does:** given `{ email, name, emailVerified? }`, seeds an `authUsers` row + a valid `session` row directly in the test DB, and sets the session cookie on the Playwright context. No real OAuth.
- **How it's read:** `actorMiddleware.resolveSession` reads the session cookie → resolves the board actor. This is the same path real Google login populates, so specs exercise the real gate.
- **Interface:** `injectGoogleSession(page, { email, name })` → returns `{ userId }`. Idempotent per email (reuse the user if present).
- **Depends on:** the `session`/`user` (better-auth) tables; the e2e DB handle already used by `seed-company.ts`.

### 4.2 Specs (Playwright, local_trusted, CI/Linux only)
1. **Founder happy path** — profile → org → environment (temp writable root) → commander (fake CLI verifies) → department → agent → review → dashboard.
2. **Resume mid-flow** — complete PROFILE_SET, abandon, return to `/onboarding`, assert it resumes at ORGANIZATION_CREATED (not profile).
3. *(Invited join + second-org specs live in Workstream 2 / and the `?new=1` flow — added there once JoinOrg exists.)*

### 4.3 Constraints
- **Windows skip preserved** (embedded-pg on `runneradmin`, Issue #114) — the config already routes Windows to the skip spec.
- Un-`skip` `onboarding.spec.ts` under this track once the helper lands.
- Environment/commander steps rely on fake-claude/fake-codex fixtures + a stable filesystem sandbox + progress reset between runs.

---

## 5. Workstream 2 — Invited journey (whole of Track B, C model)

> **Revised after Codex review** — P1 fixes folded inline (tagged `[Cx#]`).

### 5.0 A5 journey reconciliation + layer hygiene — PREREQUISITE `[Cx3, re-review #3]`
Two coupled fixes in `server/src/services/onboarding.ts` (roadmap-A5, **mandatory** once invited ships):

**(a) Advance against the REQUESTED journey.** `advanceState` validates against the stored `row.journey`, so a founder-row user can't advance `JOIN_REQUESTED`. Validate the transition against the **requested** journey's ordered states (both share `AUTHENTICATED → PROFILE_SET`); when the requested state is exclusive to that journey, set `row.journey` to it **under the existing version guard**.

**(b) The user layer holds ONLY the identity prefix `{AUTHENTICATED, PROFILE_SET}`.** The re-review's regression: if invited writes `SETUP_COMPLETE` to the user layer (`companyId=null`), a later second-org founder's `ensureProgress` seeds the new org layer from the user layer, inherits `SETUP_COMPLETE`, and every founder advance becomes a false no-op. Fix the invariant:
- **THE load-bearing invariant:** `ensureProgress`'s org-layer seed inherits **only `{AUTHENTICATED, PROFILE_SET}`** from the user layer — never journey-specific later states. This single rule is what makes it safe for the user-layer row to hold the full invited journey.
- **The entire invited journey lives on the user layer** (`companyId=null`): `AUTHENTICATED → PROFILE_SET → JOIN_REQUESTED → SETUP_COMPLETE` — contiguous, so every advance is in-order. (Do NOT split it across layers; round-2's org-layer `SETUP_COMPLETE` broke ordering.) Because of the seed-only-prefix invariant, a later founder org-seed never inherits `JOIN_REQUESTED`/`SETUP_COMPLETE`, so there's no founder no-op regression.
- **Tests:** founder-row user advances `JOIN_REQUESTED` (invited) OK; after an invited `SETUP_COMPLETE` on the user layer, a subsequent **second-org founder flow still advances cleanly**; org-layer seed contains only the identity prefix.

### 5.1 Invite-level detection (resolver) `[Cx1, Cx5]`
- Detect an **open invite** (`invites`: `acceptedAt IS NULL`, `revokedAt IS NULL`, `expiresAt > now()`, **`inviteType = 'company_join'`**, **`allowedJoinTypes IN ('human','both')`**, `companyId NOT NULL`) whose `defaultsPayload->'teamInvite'->>'email'` = the user's **verified** email (`emailVerified` gated) — for a brand-new invitee pre-accept.
- **Emit an explicit request-filed status `[Cx1]`:** extend the shared result with `requestFiled: boolean` (true when a `join_request` already exists for user+targetCompany). The gate uses THIS field — **never** onboarding progress (accept can succeed while the progress PATCH fails).
- Precedence unchanged: `returning` > `invited` > `founder`.
- **Tests:** open company_join+human invite + verified email → invited, `requestFiled=false`; after a filed request → `requestFiled=true`; agent-only / non-`company_join` invite → NOT matched; unverified email → NOT matched.

### 5.2 Tokenless accept endpoint — `POST /api/onboarding/accept-invite` (atomic + idempotent) `[Cx4, Cx5]`
- **Board actor, self-scoped.** Body `{ companyId }` — validated server-side against the actor's verified-email open invite (do **not** trust the client's companyId blindly).
- **Idempotent-first:** look up an existing `join_request` for this user+invite FIRST; if pending/approved → return it (200). Do NOT 404 and do NOT require `acceptedAt IS NULL` (a first accept sets `acceptedAt`; the retry must find the existing row, not 404).
- **Atomic claim:** else insert inside a txn; `join_requests.invite_id` is UNIQUE → handle the conflict with `onConflictDoNothing` + re-select the winner (concurrent claims converge to one row). Mark the invite accepted in the same txn (mirror the token path).
- **Validate the winner `[re-review #4]`:** after the conflict re-select, assert the winning row is `requestType='human'` **and** `requestingUserId = actor` — the token path can insert *agent* requests, and email isn't unique, so never blindly return another principal's/agent's row (mismatch → 409, not a silent wrong-row 200).
- Reuse a **narrow shared helper** — only the atomic invite-claim + join-row primitive — extracted from the token-accept txn (`access.ts`), **preserving the token route's agent-replay behavior** (`access.ts:1991/2151`). Set `requestingUserId = actor`, `requestEmailSnapshot = verified email`.
- Returns `{ status: "pending_approval", companyId, joinRequestId }`. Errors: no matching open invite → **404** (email-mismatch dead-end); already a member → 200 `{ status: "already_member" }`.
- **Tests:** created; idempotent retry (200, same id); **concurrent double-accept → one row, both 200**; conflict-winner-is-agent/other-user → 409; expired/revoked/agent-only invite → 404.

### 5.3 `JoinOrg` step + invitation context `[Cx2]`
- The invited flow must carry the **target companyId explicitly**. `OnboardingFlowPage` (invited) reads `?company=<id>` and passes an explicit `invitationContext={ companyId, companyName }` down to the step — NOT via `ctx.companyId` (which is `null` on the invited layer).
- Register: `journeys:["invited"]`, `state:"JOIN_REQUESTED"`, `dependsOn:["PROFILE_SET"]`, order 20.
- On "Join": `POST /api/onboarding/accept-invite { companyId: invitationContext.companyId }` → `advanceOnboarding({ companyId: null, journey:"invited", requestedState:"JOIN_REQUESTED" })` (user layer; the PATCH route skips the membership check when companyId is null) → terminal pending state. **No `onFinished`-navigate** (loop prevention).
- No invitationContext / email mismatch → disabled + "open your invite link, or ask an admin to re-invite {your email}".

### 5.4 `/pending` page + gate routing + approval-awareness `[Cx1, P2-11]`
- Complete the Session-2 `InvitedPendingPage` into a real `/pending` screen: "Your request to join {company} is awaiting approval."
- **Approval-aware:** the page **refetches the journey on window focus + on an interval**; when membership appears (resolver → `returning`), it redirects into the company. Not a dead terminal.
- **Index gate:** `invited` + `requestFiled=true` → `/pending`; `invited` + `requestFiled=false` → `/onboarding/join`. Uses the resolver's explicit status field, never progress.

### 5.5 Approval → `SETUP_COMPLETE` — AFTER the txn commits `[Cx6]`
- **Do NOT** advance progress *inside* the approval transaction — in Postgres a caught DB error leaves the txn aborted, rolling back the (critical) approval.
- The approve route commits membership/grants/role first; **then, after the committed txn**, best-effort `ensureProgress` + `advanceState(db, { userId, companyId: null, journey:"invited", requestedState:"SETUP_COMPLETE" })` in its own try/catch.
- **On the USER layer (`companyId=null`) `[re-review-3 #1]`:** the ENTIRE invited journey (`AUTHENTICATED → PROFILE_SET → JOIN_REQUESTED → SETUP_COMPLETE`) lives on the one user-layer row, so the advance is **contiguous/in-order** (round-2's move to the org layer broke ordering — the org row has no `JOIN_REQUESTED` prereq). Safety against founder pollution comes **entirely from §5.0b's seed-only-prefix invariant** (a later founder org-seed inherits only `{AUTHENTICATED, PROFILE_SET}`, never this `SETUP_COMPLETE`), NOT from moving the state off the user layer. `advanceState` is called server-side (not the membership-gated HTTP route), so `companyId=null` is fine.
- A failure never touches the committed approval (cosmetic — the approved user is `returning` regardless). **Test:** approval succeeds when the progress advance throws; and a second-org founder after an invited `SETUP_COMPLETE` on the user layer still advances cleanly.

### 5.6 Invited e2e — through approval to ACCESS `[Cx9]`
- Founder (seeded) invites `invitee@e2e.test`; `injectGoogleSession` as invitee → `/onboarding` resolves invited → profile → JoinOrg files request → **assert `/pending`**, never a create-org heading; assert server `pending_approval` request exists. Re-entry stays on `/pending` (no loop).
- **Continue to the core outcome:** founder approves (API or Inbox UI) → invitee's `/pending` refetch → resolver returns `returning` → company **accessible with the intended role/grants** (assert membership + role server-side).
- Plus: second-org-from-Lobby skips the user layer; `?new=1` second-company.

---

## 6. Workstream 3 — Track C (Commander CLI auth)

Removes the "drop to a terminal" step in the verify gate. Independent of B.

> **Revised after Codex review** — the two big P1s here were wrong in v1: API-key storage location + a synchronous login route. Corrected below.

### 6.0 Board-actor gate on every Commander auth route `[re-review #8]`
Correction: `commander-verify` is **already** founder-scoped (v1's "member-scoped regression" premise was stale). The real requirement — **`assertRole` alone is NOT founder-only**: it lets **agent** actors bypass role checks (`rbac.ts:30`). So every new key/login route must **explicitly require a board actor BEFORE `assertRole`**, matching the existing gate at `commander-verify.ts:23`.

### 6.1 API-key path — store on the Commander AGENT, verify the RESOLVED config `[Cx8]`
- The executable Commander config lives on the **Commander `agents.adapterConfig`** row (`ensure-commander.ts`), NOT `internal_agent_config` (which has **no** env/secret column — v1 was wrong).
- `persistCommanderApiKey`: write the pasted key via `secretsService` (encrypted `companySecrets`/versions) and **bind a `secret_ref` into the Commander agent's `adapterConfig.env`** (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) using the existing env-binding path (`syncEnvBindingsForTarget`). Never plaintext on any row.
- **Make verify probe the RESOLVED config `[Cx8, re-review #8]`:** `commander-verify` currently probes `config: {}` — change it to load the Commander agent + **`secretsService.resolveAdapterConfigForRuntime(adapterConfig)`** (preserves the full adapter config and nests resolved secrets under `env`, which the probes read via `config.env`) and pass THAT to `testEnvironment`. Do NOT pass raw `resolveEnvBindings` output — wrong shape.
- Route: `POST /api/companies/:companyId/internal-agent/commander-key { value, provider }`, **founder-scoped**. `VerifyStep` gets an API-key paste affordance in `needs_auth`.
- Idempotent (rotate on secret conflict). **Tests:** key → secrets vault + adapter-env `secret_ref` (never plaintext); verify re-probes the resolved config; founder-only (403 for member).

### 6.2 In-app login = async challenge lifecycle `[Cx7]`
`runClaudeLogin` awaits process **exit**, but `claude login`/`codex login` print a URL then **wait for the user** — so a synchronous route can't return the URL (v1 was wrong). Build an async lifecycle:
- **Streaming runner `[re-review #7, NEW-P2]`:** build on the exported **`spawnTrackedChild`** (returns a terminable handle) — NOT `runChildProcess` (returns only after `close`, exposes no handle). Capture the device/verification URL from **both stdout AND stderr** (the parser combines them) with chunk-boundary buffering, a **bounded URL-discovery timeout**, and termination if the CLI exits before producing a URL. Claude: streaming variant of `runClaudeLogin`; Codex: net-new `runCodexLogin`.
- **Effective auth-home resolution `[re-review-3 #4]`:** define per provider — **codex** → `resolveCodexHome(env)` (`codex-home.ts:16`, i.e. `CODEX_HOME ?? ~/.codex`); **claude** → the resolved claude config home. The **lock key = `(provider, canonical(effectiveAuthHome))`** (canonicalize the path). Codex writes the shared `CODEX_HOME` whose `auth.json` is copied into every company's managed home, so per-**company** locking would let concurrent challenges race the same credential file. One active challenge per `(provider, authHome)`, **across companies**.
- **Durable challenge record + reaper `[re-review-3 #4, NEW-P1]`:** an in-memory map cannot reap a **detached** (`spawnTrackedChild`, POSIX process-group) child after a hard restart. Persist each active challenge `{ challengeId, provider, authHome, pid, pgid, startedAt }` durably (small table or on-disk record), and add a **startup reaper that terminates orphaned login children on boot** — mirror the existing heartbeat process-lost reaper (`heartbeat.ts:2376`). Plus a global shutdown hook. The challenge *record* being "lost on restart" is fine for UX; the *child* must be reaped, never leaked.
- **Routes (founder-scoped):**
  - `POST …/internal-agent/commander-login/start { provider }` → spawn, capture URL, return `{ challengeId, loginUrl }`.
  - `GET …/internal-agent/commander-login/:challengeId` → status (completed when child exits 0 / `auth.json` present).
  - `POST …/internal-agent/commander-login/:challengeId/cancel` → kill child + clean up.
  - Timeout; cleanup on server shutdown.
- `VerifyStep` (`needs_auth`): "Sign in" → start → show `loginUrl` → poll → on `completed`, auto re-verify.
- **Tests:** URL parsing from sample stdout+stderr (claude + codex); lifecycle state machine (pending→completed/timeout/cancel); **cross-company exclusion by `(provider, authHome)`** (two different companies sharing the same codex auth-home cannot both hold an active challenge — `[re-review-3 NEW-P2]`); startup reaper terminates an orphaned child; child cleanup on cancel/shutdown. **Live device flow = dogfood-verified.**

### 6.3 Verification honesty + Track-C visual
The blocking verify gate already works via terminal-login. The device flows (§6.2) are proven only by a live CLI + real account; we unit-test URL parsing + the lifecycle state machine + secret storage + resolved-config verify — the actual login is **dogfood-gated, not CI-asserted**. Track-C **visual** coverage: `needs_auth`, login-URL screen, API-key paste/validation/error, completed state.

---

## 7. Testing strategy — full pyramid + visual, every workstream

Every workstream ships **all four layers**. No feature lands with only one.

- **Unit (TDD, each step red→green→commit).** Pure logic + isolated units with mocks: resolver invite-match rule, `computeAdvance` transitions, tokenless-accept helper, JoinOrg component (RTL), index-gate routing decision, `persistCommanderApiKey` (secret vs config), Claude/Codex login stdout URL parsing.
- **Integration (service + route wired, DB mocked via the proxy pattern or embedded-pg where a real query matters).** The route→service→(mocked db) seam, exercised end-to-end at the API layer: `accept-invite` route (401/404/409/created), the approve txn advancing `SETUP_COMPLETE`, the `commander-key` route writing through the encrypted secret path, the verify route classifying real probe shapes. Where a query's SQL correctness matters (resolver invite-match jsonb path), add an embedded-postgres integration test (`*.integration.test.ts`, Windows-runnable per the memory note: `initdbFlags: ["--encoding=UTF8","--locale=C"]`).
- **E2E — functional (Playwright).** Founder happy-path, resume, invited-join (+ no-loop re-entry), second-org, `?new=1`. CI/Linux (or `AOA_E2E_FORCE_WINDOWS=1` + local `DATABASE_URL`).
- **E2E — visual flow (Playwright).** Every onboarding **step screen is captured** as a named screenshot artifact during the functional specs (`page.screenshot({ path: "test-results/onboarding/<journey>-<step>.png" })`) so the whole flow is visually documented each run. Key stable screens (profile, org, environment, verify, review; invited join + `/pending`) also get a **visual-regression baseline** (`await expect(page).toHaveScreenshot("<step>.png", { maxDiffPixelRatio: 0.02 })`) — masking volatile regions (timestamps, generated ids). Baselines are committed; a diff fails the spec. This is how "the whole flow is taken and tested visually."
- **High-risk branch matrix (mandatory unit/integration) `[Cx4, Cx15]`:** concurrent/replayed tokenless accept; accepted/revoked/expired invites; agent-only invite; multiple same-email invites; accept-success-but-progress-PATCH-fails; founder-row→invited reconciliation (§5.0); approval-progress DB failure (§5.5); API-key probe via a **resolved** secret binding (§6.1). Each is a named test, not a hope.
- **First-user-bootstrap honesty `[Cx13]`:** the fast founder e2e runs as the `local-board` escape-hatch admin — it does NOT cover "first Google user becomes admin (RB3)." Keep a **separate authenticated** integration/live test for that boundary; do not claim the local e2e covers it.
- **Visual baselines `[Cx14]`:** baselines for **all** stable screens (profile, org, environment, verify, review, invited-join, `/pending`) — not just review. Raw screenshots are artifacts, not assertions. Generate the committed baseline in the **same pinned Linux/Chromium** env CI uses, then verify normally (a missing baseline fails a normal run — never rely on `--update-snapshots` in CI).
- **Fake-CLI scripting `[Cx15]`:** in e2e, script the fake-claude/fake-codex response to emit `hello` (its default `Done` only passes because generic warns classify as verified) so the verify assertion is real.
- **Dogfood (live, you).** The two CLI device-flow logins; the full invited round-trip with a real 2nd Google account on the isolated authenticated instance (`C:/Users/TK/.aoa/instances/onboarding-test/`).
- **Adversarial review.** Each plan is reviewed by **Codex** (`codex exec -C <worktree> -s read-only`, background, medium effort) before execution, and the resulting diff is Codex-reviewed again before merge.
- **Gates:** `pnpm --filter @armyofagents/{server,ui} typecheck`; full server suite after `access.ts`/`onboarding.ts`/resolver changes; `pnpm db:generate` for any schema change (none expected under the C model); full UI suite after step/registry changes.

---

## 8. Sequencing

1. **Workstream 1** (e2e harness + founder happy-path/resume) — unblocks all verification, de-risks merged Phase 1.
2. **Workstream 2** (invited journey) — core feature; its e2e rides on WS1.
3. **Workstream 3** (Track C) — independent; land any time after/along WS2. Ship 6.1 (API-key) first (fully testable), then 6.2/6.3.

---

## 9. In / out of scope

- **A5 journey reconciliation — NOW IN SCOPE (§5.0)** `[Cx3]`. Codex showed it's mandatory once invited ships (a founder-row user otherwise can't advance `JOIN_REQUESTED`). A1/A2/A4 verified done on `main`.
- **Token/nonce handoff** (`onboarding_invite_handoffs`) — shelved (§2, decision 2); revisit only for a real email-mismatch need.
- **Track E** Phase-2 walkthrough — separate spec; blocked on the Assist-mode "no real tasks before approval" fix.

---

## 10. Risks

- **Resolver precedence + status field** (§5.1) touches the auth gate — full server suite after; keep `returning > invited > founder`; add `requestFiled` without breaking existing consumers.
- **`onboarding.ts` journey reconciliation** (§5.0) is the highest-blast-radius change (every advance flows through it) — extensive unit coverage + full server suite.
- **Shared join-request helper** (§5.2) extracted without altering the token-accept path — cover both paths incl. concurrency.
- **Post-commit approval progress** (§5.5) — must be genuinely outside the txn, else it can still abort approval.
- **In-memory login challenge store** (§6.2) — lost on restart; that's acceptable (user just restarts login) but must not leak child processes.
- **Live-only Track C device flows** (§6.3) — dogfood-gated, not CI-asserted.
