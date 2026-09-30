# Onboarding & Auth Redesign — Session Handoff

> **Purpose:** resume this initiative in a fresh session with zero re-derivation. Read this first, then the authority docs in §7.

---

## 1. TL;DR — where we are

Phase 1 (Stages A–D) of the Google-only auth + modular resumable onboarding redesign.

- **Branch:** `feat/onboarding-auth-redesign` — **~44 commits ahead of `main`.**
- **Worktree:** `C:/Users/TK/.aoa/wt/onboarding-auth-redesign` (short path — OneDrive MAX_PATH; `core.longpaths=true`).
- **Green:** server suite **7467** tests, UI suite **3166** tests, both typechecks clean.
- **Done:** all planning (revA/B/C), **Stage A** (auth), **Stage B** (engine), **Stage C COMPLETE** (all 8 founder steps + OnboardingWizard deletion + FlowEngine routing), and **Stage D security hardening** (D6 cookie flags, D7 escape-hatch backstop).
- **Remaining (all Stage D, infra-blocked — see §6):** the invited-journey **JoinOrg** UI + the approval→`SETUP_COMPLETE` amendment, the **invite-token handoff** table + OAuth nonce carry (RC3), the **in-app Codex/Claude subscription-login** routes (T-CodexLogin) + API-key paste (D8), and the **A12 Playwright e2e** (needs the mocked-Google helper; CI-only). These need live Google auth / e2e infra that can't be exercised in a Windows unit-test session — each is scoped below with the integration risk to resolve.

---

## 2. Get set up (fresh session)

```bash
cd "C:/Users/TK/.aoa/wt/onboarding-auth-redesign"     # already exists; git worktree
pnpm install                                          # if node_modules missing
pnpm --filter @armyofagents/plugin-sdk build          # fixes plugin-sdk module-not-found baseline
pnpm --filter @armyofagents/shared build              # if you edit packages/shared
```

**Commands (verified):**
- Single test file: `pnpm test:run <path-substring>` (root vitest; server has NO package `test` script). Do NOT use `|` in the filter — it fails across projects; run separately.
- UI single file: `pnpm --filter @armyofagents/ui test:run <path>`.
- Typecheck: `pnpm --filter @armyofagents/server typecheck` / `pnpm --filter @armyofagents/ui typecheck`.
- Full server suite (~45s): `pnpm test:run server/src`. Full UI suite (~65s): `pnpm --filter @armyofagents/ui test:run`.
- DB schema change: edit `packages/db/src/schema/*.ts` → `pnpm db:generate` (rebuilds db + SQL migration + updates `meta/_journal.json` + snapshot — **commit all**).

**Discipline:** TDD each task (write failing test → verify red → minimal impl → verify green → commit). Run the full server suite after any change to `app.ts`, `index.ts`, `config.ts`, or `middleware/auth.ts`.

---

## 3. What's complete (commit map)

**Stage A (auth) — done except A12 e2e:**
`56715b5c3` A1 config · `5ab8803ff` A2 Google provider + R6 · `307731e8f` A6 identity gating · `0ec2f9a65` RB4/R5/R6 startup wiring + escape-hatch guard · `2705a39cf` RB3/A7 first-admin hook · `6b22976d5` A3 route removal · `c0b2878ea` A4 journey resolver · `615764b93` A5 journey endpoint · `c3551e701` A8 Google screen · `8ea39c1ab` A9 post-auth routing · `4382fdca9` A11 long session · `1174ce9d0` A10 board-claim retire

**Stage B (engine) — done:**
`e3ebc4c0b` B1 table+migration · `99f67058c` B2 state enums · `236904dfd` B3 advance service · `ba7d7d13c` B4 progress route · `40a0470ce` B5 registry · `70255ef29` B6 FlowEngine · `b47a665ee` B7 wiring + gate redirect

**Stage C — COMPLETE (foundation + all 8 steps + wizard deletion):**
`58ee1410c` foundation · `7872d6854` C1 user_profiles · `4d02e8f1d` order-1 profile step (proves the pattern) · `2d3a77c78` order-2 org-create (RB1 handshake via CompanyContext.createCompany) · `198d4b05a` order-3 blocking env write-probe + Set up environment (R13) · `386845808` order-4 Choose Commander · `1d06b02ac` order-5 Verify tooling (blocking; verify service+route classifier) · `2b94639c8` order-6 shared DEPARTMENT_FUNCTION_TYPES + First department · `65923d662` order-7 First agent (dept-assigned at creation) · `8ae510df1` order-8 Review (SETUP_COMPLETE) · `8fda3be0e` C13 delete OnboardingWizard; route onboarding via FlowEngine (+ "onboarding" added to GLOBAL_ROUTE_ROOTS)

**Stage D — security hardening done; invited UI + e2e deferred (§6):**
`384e1cc78` D6 session-cookie hardening + D7 escape-hatch fail-closed backstop

**The proven step recipe (Stage C) — adaptations discovered while executing (authoritative over the stageC-steps.md examples, which predate revB/revC):**
1. Steps register in `ui/src/onboarding/steps/index.ts` `ONBOARDING_STEPS` with the **revB shape** (`order` + `shouldInclude`), NOT the doc's standalone `xxxStep`/`lazy` exports.
2. The FlowEngine is **read-only** — EVERY step calls `advanceOnboarding({ companyId, journey, requestedState })` itself before `onComplete()`. The doc's C6–C12 examples omit this and would infinite-loop the step.
3. Blocking steps (env R13, commander verify) return **422** from their route and the step surfaces the reason + a retry; only success advances.

---

## 4. THE PROVEN STEP RECIPE (repeat for each remaining step)

The profile step (`ui/src/onboarding/steps/ProfileStep.tsx`) is the template. Each remaining step:

1. **Component** `ui/src/onboarding/steps/<X>Step.tsx` — a form/card that on submit:
   - does its data write via the **existing** API (`companiesApi.create`, `environmentsApi`, `internalAgentApi.updateConfig`, `projectsApi.create` + `assignAgent`, `agentsApi.create`, `agentsApi.testEnvironment`),
   - `await advanceOnboarding({ companyId: ctx.companyId, journey: ctx.journey, requestedState: "<STATE>" })` (from `ui/src/api/onboarding.ts`),
   - `onComplete()`.
2. **Register** a `StepDefinition` in `ui/src/onboarding/steps/index.ts` `ONBOARDING_STEPS`:
   `{ id, order, state:"<STATE>", journeys:["founder"], dependsOn:["<prev state>"], canSkip, shouldInclude:()=>true, isComplete:(ctx)=>ctx.completedStates.includes("<STATE>"), Component, title }`.
3. **RTL test** (mock the data API + `advanceOnboarding`), asserting write → advance(state) → onComplete. Confirm `validateRegistry(ONBOARDING_STEPS)` stays `[]`.

The engine (`FlowEngine.tsx`) is READ-only: it resolves the next step, and `onComplete` just re-reads progress. Steps own their advance.

---

## 5. Remaining Stage C steps (orders 2–7)

| Order | State | Step does | Notes |
|---|---|---|---|
| 2 | `ORGANIZATION_CREATED` | ✅ **DONE** `2d3a77c78` — `useCompany().createCompany({name})` (bundles create + invalidate + `setSelectedCompanyId`) → `advanceOnboarding({companyId:new.id,...})` | **RB1 handshake:** the `setSelectedCompanyId` prop-change reloads the FlowEngine to the org layer. Advance targets the NEW companyId. Name only (mission dropped). `ensureProgress` seeds the org-layer from the user-layer so the `PROFILE_SET` dep passes. |
| 3 | `ENVIRONMENT_READY` | ✅ **DONE** `198d4b05a` — probe local branch now does real mkdir+write+delete; `setupOnboardingEnvironment` (probe-first, upsert `environments` by name + set `companies.rootFolder`); route returns **422** on block; `EnvironmentStep` prefills `~/AoA`, POSTs, then advances ENVIRONMENT_READY (engine is read-only). | **BLOCKING** on probe fail (revA R13) implemented — the generic `ok:true` is no longer the gate. Cross-platform unwritable test = a path *under a file* (not `/definitely/invalid`, which Windows creates under `C:\`). |
| 4 | `COMMANDER_SELECTED` | ✅ **DONE** `386845808` — Claude/Codex cards → `internalAgentApi.updateConfig` (cliTool/provider, null models) → advance | No model internals. |
| 5 | `COMMANDER_VERIFIED` | ✅ **DONE (blocking core)** `1d06b02ac` — `commander-verify` service (cliTool→adapterType + classifier verified/needs_auth/not_installed/failed) + route drives `adapter.testEnvironment`, 200 verified / **422** else; `VerifyStep` "Check again" loop + terminal login hint; advances only on `verified`. | **DEFERRED (needs live CLI):** the in-app subscription-login trigger — Claude `claude-login` is agent-scoped (needs a pre-agent variant); **codex has NO login runner at all** (T-CodexLogin, net-new, revC RB8/R14) — and the API-key paste + secret-binding route (D8). Today the founder runs `claude login`/`codex login` in a terminal, then Check again — the blocking gate is fully enforced regardless. |
| 6 | `DEPARTMENT_CREATED` | ✅ **DONE** `2b94639c8` — C9 shared `DEPARTMENT_FUNCTION_TYPES` (adds sales, relabels support→Customer Support; `NewProjectDialog` imports it) + `DepartmentStep` (type picker, nested-local-folder default under rootFolder + optional GitHub, idempotent same-name guard) → advance | — |
| 7 | `AGENT_ASSIGNED` | ✅ **DONE** `65923d662` — `agentsApi.create` inheriting Commander runtime + `projectsApi.assignAgent` **at creation** (fixes the dept-assignment gap); idempotent same-name org-agent reuse | Advanced settings collapsed. |
| 8 | `SETUP_COMPLETE` | ✅ **DONE** `8ae510df1` — Review summary; both "Start walkthrough"(Phase-2 stub) + "Go to dashboard" advance SETUP_COMPLETE; FlowEngine `onFinished` navigates (no router coupling in the step) | — |

**Wizard deletion — ✅ DONE** `8fda3be0e` (C13): removed `OnboardingWizard.tsx` + `OnboardingWizardMount` + the DialogContext onboarding surface; repointed every `openOnboarding()` caller (App/Layout/LobbyLayout/Lobby/Companies/Dashboard) → `navigate("/onboarding")`. **Also added `"onboarding"` to `GLOBAL_ROUTE_ROOTS`** (`ui/src/lib/company-routes.ts`) so the prefix-aware `@/lib/router` never rewrites `/onboarding` → `/<PREFIX>/onboarding`.

---

## 6. Stage D — DONE (security) + DEFERRED (invited UI + e2e, infra-blocked)

**✅ DONE — security hardening (`384e1cc78`):**
- **D6 cookie flags:** `buildBetterAuthConfig` sets `advanced.defaultCookieAttributes` (httpOnly always; secure gated to `authenticated` so loopback http dev isn't dropped; sameSite=lax for OAuth). Test in `better-auth-config.test.ts`.
- **D7 escape-hatch backstop:** `escape-hatch-fail-closed.test.ts` proves the synthetic loopback admin is minted ONLY by the dev hatch in `local_trusted`.
- **Already current (verified, no work needed):** the journey resolver `getJourneyForUser` is the Stage A A5 redesign (uses `joinRequests.requestEmailSnapshot` + verified-email gating + `deepLinkCompanyId` — the doc's D3 token-hash rewrite is **superseded**; no token flows through the resolver, so the D7 "no-secret-leak" test is moot). `INVITED_PHASE1_STATES` already exists in `packages/shared/src/onboarding.ts` **with `JOIN_REQUESTED`** (D1's constant change is superseded). The **profile step is already tagged `["founder","invited"]`** (D4's "widen profile" is done).

**⛔ DEFERRED — needs live Google auth / e2e infra that a Windows unit-test session can't exercise. Each is scoped with the integration risk to resolve:**

1. **JoinOrg step (invited UI).** Build `ui/src/onboarding/steps/JoinOrg.tsx`, register at `journeys:["invited"]`, `state:"JOIN_REQUESTED"`, `dependsOn:["PROFILE_SET"]`, order 20 (unique-per-journey; validator is per-journey so it won't clash with founder order-2). It advances `JOIN_REQUESTED` on the **user layer** (`companyId: null`, `journey:"invited"`) via the existing `advanceOnboarding` — the invited user has no membership, and the PATCH `/onboarding/progress` route only membership-checks non-null companyIds, so `companyId:null` passes with **no new server route**. **INTEGRATION RISK TO RESOLVE FIRST:** after JoinOrg completes, `resolveNextStep` returns null → FlowEngine `onFinished` → `navigate("/")` → the index gate re-resolves `invited` (still no membership) → routes back to `/onboarding/join` → **loop**. Fix by rendering a terminal "pending approval" state in JoinOrg that does NOT trigger `onFinished` navigation, OR by having the index gate show a pending page for an invited user whose join_request is already filed. This must be validated in the live flow — do not ship JoinOrg without exercising it.
2. **Invite-token handoff (RC3).** New `onboarding_invite_handoffs` table (nonce, hashed token, bound_user_id, expires_at, consumed_at) + carry the nonce through OAuth via better-auth `additionalData` + atomic consume. This is how JoinOrg gets a plaintext token to `accessApi.acceptInvite`. Without it, JoinOrg can only advance progress / instruct the user to open their `/invite/:token` link. **Live auth infra — build against a real OAuth round-trip.**
3. **Approval → `SETUP_COMPLETE` (revC RC2).** In the human branch of the approve txn (`access.ts` ~:2461, after `ensureMembership`/`setPrincipalGrants`/`applyInviteRole`), best-effort `advanceState(txDb, { userId: existing.requestingUserId, companyId: null, journey:"invited", requestedState:"SETUP_COMPLETE" })`. **NOTE — low value / risk:** it's cosmetic — an approved user gains membership so the journey resolver routes them "returning" (into the app) regardless. It touches the critical approval path and `computeAdvance` may reject a non-contiguous jump (guard: `ensureProgress` first, wrap in try/catch, never fail the approval). Deferred as not worth the critical-path risk until the invited flow is live-validated.
4. **T-CodexLogin + D8 API-key path** (see §5 order-5 DEFERRED) — in-app subscription login (codex has no login runner; net-new) + encrypted per-company API-key secret. Needs a live CLI to verify.
5. **A12 Playwright e2e** (also outstanding from Stage A): mocked-Google specs (founder happy path, resume, invited join, 2nd-org-skips-user-layer) in `tests/e2e/`. Needs the Stage A `injectGoogleSession` helper (`tests/e2e/helpers/google-mock`) which is **itself unbuilt**. **CI/Linux only** (Windows e2e is skipped — embedded-pg on `runneradmin`, Issue #114); the harness MUST set `AOA_DEV_LOCAL_IDENTITY=1`.

---

## 7. Authority docs (read in this order)

All in `docs/aoa/plans/2026-07-12-onboarding-auth-redesign-*`:
1. `revC-final-gate.md` — **top authority** (RC1 advance, invited approval-txn completion, token handoff)
2. `revB-rereview-fixes.md` — amended contracts (onboarding_progress version+indexes, JOIN_REQUESTED, pendingInvitations, StepDefinition order/shouldInclude) + Commander-auth §
3. `revA-codex-fixes.md` — R1–R16
4. `stage0-contracts.md` — shared contracts + **verified commands** + file map
5. `scope.md` — design/decisions; `stageA/B/C/D-*.md` — per-stage task plans

Authority order: **revC > revB > revA > stage docs**.

---

## 9. Session 2 — live Google validation + live-QA fixes (2026-07-13)

**Real Google login was exercised end-to-end** in `authenticated` mode on an isolated test instance (`~/.aoa/instances/onboarding-test`, port 3199, a real Web OAuth client — secret in local config only, never committed). The server log proved **first-user→instance-admin (RB3) + founder journey + two-layer advance (profile→org→env→dept)** all fire against a live OAuth round-trip — previously only escape-hatch tested. The user performs the Google login themselves (their credentials are never entered by the agent).

A 3-parallel-agent review (redirect trace / agent-model gap / edge-case audit) then drove **7 fixes, all TDD + committed** (UI suite 3178 pass / 3 skip, UI typecheck clean):

1. `e212028e0` **CloudAccessGate** — retired the `BootstrapPendingPage` intercept that blocked the very first Google sign-in on a fresh authenticated instance (A10 retired board-claim but missed this gate). **Real product bug.**
2. `1b13eb7fe` **DepartmentStep** default name (was placeholder-only → silently-disabled Create button).
3. `dcc22b3fa` **Auth.tsx bfcache** — `pageshow`/`persisted` reload so `/auth` can't get stuck on a frozen "Redirecting…" after Back. Root cause: the "already-signed-in → redirect away" guard is effect-based and bfcache restores don't re-run React effects.
4. `682b4c7fe` **AgentStep** — surface the inherited runtime in the happy path ("Codex · gpt-5.5" / "Claude account-default"; the "no model asked" is **by design** — inherits the Commander runtime, VerifyStep guarantees the CLI is installed+authed) AND close a real race: `adapterType` guessed `claude_local` and was corrected by a swallowed `getConfig()`, so a Codex founder could ship a `claude_local` agent that fails at first run. Now the Create button is gated until the runtime resolves, with a Retry on failure.
5. `aa9f0d254` **two live P1 traps** — (a) 2nd-company dead-end: a returning founder at bare `/onboarding` bound to their already-complete company → no step → Lobby; fixed with `/onboarding?new=1` which renders `OrgStep` directly on the user layer (selectedCompanyId hydrates late, so a `companyId=null` pin would loop), wired from `LobbyLayout.onCreateCompany`. (b) Invited redirect loop: the invited resolver+gate are live but JoinOrg is unbuilt → `onFinished`→`/`→gate re-resolves `invited`→loop; fixed with a terminal `InvitedPendingPage` (no navigate).
6. `1b408a1e9` **hardening** — org-create idempotency (retry after a failed advance no longer mints a 2nd company); surface swallowed errors in `ReviewStep.finish()` + `DepartmentStep` mkdir.
7. `b0b3019f9` **e2e whole-suite fix** — post-redesign `local_trusted` grants no board actor without `AOA_DEV_LOCAL_IDENTITY=1` (`config.ts:244` defaults false; `middleware/auth.ts:33`), and `playwright.config.ts` never set it → the **entire** local_trusted e2e suite would 401. Added the hatch env; rewrote the stale `onboarding.spec.ts` (imported the deleted `openOnboardingWizard`) to a health check + A12-skip.

**Backlog surfaced but NOT done (next session):**
- `DepartmentStep` idempotent guard skips workspace creation on a retry-after-partial-failure (deeper refactor than the swallowed-error surfacing done here).
- **Interrupted founder not auto-resumed:** after `ORGANIZATION_CREATED` the user has membership → resolver returns `returning` → Lobby with no nudge to finish env/commander/dept/agent. Manual `/onboarding` resumes correctly; nothing routes them there.
- Invite token still transits the URL through OAuth (`/auth?next=/invite/:token`) — RC3 `onboarding_invite_handoffs` still deferred (§6.2).
- P3s: `advanceState` trusts the caller's `journey` not the persisted row; best-effort admin promotion could leave an instance adminless; `validateRegistry` never runs on the real `ONBOARDING_STEPS` (only fixtures); no working Back button (VerifyStep copy references one).
- Plus the original §6 Stage-D deferrals (full JoinOrg journey, invite_handoffs, approval→SETUP_COMPLETE, T-CodexLogin, A12 e2e).

**Phase 2 = GO** — the founder path is clean and the two live traps are closed. To live re-test the fixes, rebuild the UI + restart the :3199 server (it computes CSP script-hashes from the built `index.html` at boot).

---

## 8. Key gotchas
- `local_trusted` now requires Google creds OR `AOA_DEV_LOCAL_IDENTITY=1` (escape hatch). `AOA_DEV_LOCAL_IDENTITY_FORCE=1` overrides the populated-instance refusal.
- Raw `sed -i` mangles emoji on Windows Git Bash → use **python** for bulk doc edits. `grep -c $'\x00'` in bash = empty pattern = counts ALL lines (false positive).
- `company_user_profiles` is NOT on `main` (only a parallel branch) — Phase 1 uses global `user_profiles` only (revC R10). Don't seed the per-company mirror.
- Codex CLI needed upgrade to 0.144.1 (ChatGPT-account only supports the new default model). Run reviews via `codex exec -C <worktree> -s read-only`, background + medium effort (foreground 9.5-min cap is too short).
- The full onboarding walkthrough (sample-portfolio demo) is **Phase 2** — out of scope here; depends on the Assist-mode "no real tasks before approval" fix.
