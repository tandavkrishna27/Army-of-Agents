# Revision A — Codex Review Fixes (AUTHORITATIVE OVERRIDES)

> **This document is authoritative.** Where any Stage 0/A/B/C/D task conflicts with a directive here, **this wins**. Applied after the 2026-07-12 Codex plan review (13 P1 + 4 P2). Execute these as amendments; do not start a stage until its R-items are folded in.

**Verdict being addressed:** Codex judged the plan "not safe to start Stage A" — the first-user-admin design is race-prone, an existing synthetic admin conflicts with it, missing Google creds can lock out an instance, and the org→engine handoff is broken. All fixed below.

---

## P1 — blockers

### R1 — Fix the organization→engine `companyId` handoff (overrides Stage C C4 + Stage B B6; Codex #1)
**Root cause:** C4 discards `companiesApi.create()`'s result and never calls `setSelectedCompanyId`; B6 captures `activeCompanyId = null`; `onComplete()` then persists `ORGANIZATION_CREATED` to an org layer with no company → throws. Contradicts Stage 0's arg-less handoff contract.
**Fix — C4 (Create Organization step):**
```ts
const created = await companiesApi.create({ name });   // capture the result
setSelectedCompanyId(created.id);                       // CompanyContext — activates the org layer
onComplete();                                           // engine re-fetches context with the new companyId
```
**Fix — B6 (FlowEngine):** after `onComplete()` for a user-layer step, do NOT reuse the mount-time `activeCompanyId`. Re-read `selectedCompanyId` from `CompanyContext` (or re-fetch progress for the new id) and build the next `StepContext` with `companyId = created.id`. Recompute context after every `onComplete`.
**Test:** integration — click Create → assert an `onboarding_progress` row is written with the new `companyId` AND `EnvironmentStep` renders next.

### R2 — Unique-constrain the user-layer progress row (overrides Stage 0 §2.2 + Stage B B3; Codex #2)
**Root cause:** `(userId, NULL companyId)` is not unique in Postgres; read-then-insert races create duplicate user-layer rows.
**Fix — two partial unique indexes on `onboarding_progress`:**
```ts
import { sql } from "drizzle-orm";
(table) => ({
  userCompanyUq: uniqueIndex("onboarding_progress_user_company_uq")
    .on(table.userId, table.companyId).where(sql`${table.companyId} IS NOT NULL`),
  userLayerUq: uniqueIndex("onboarding_progress_user_layer_uq")
    .on(table.userId).where(sql`${table.companyId} IS NULL`),
})
```
**Fix — B3 service:** replace read-then-insert with atomic `insert ... onConflictDoUpdate` targeting the matching index. **Test:** real concurrent integration test (two inserts race → exactly one row), not a sequence mock.

### R3 — Authorize progress routes per company (overrides Stage B B4; Codex #3)
**Root cause:** GET/PATCH `/api/onboarding/progress` accept a caller-supplied `companyId` with no access check → cross-company read/write.
**Fix:** for every non-null `companyId`, call the existing `assertCompanyAccess(req, companyId)` (verify exact name/location in `server/src/middleware`/`services`) before `getProgress`/`advanceState`. User-layer (null company) stays self-scoped to `req.actor.userId`. **Tests:** cross-company GET + PATCH → 403.

### R4 — Make first-user promotion race-safe (overrides Stage A A7; Codex #4)
**Root cause:** `instance_user_roles` only uniquely constrains `(userId, role)`; two *different* users both see zero admins and both insert `instance_admin` — `onConflictDoNothing` can't stop it.
**Fix — advisory-lock the bootstrap:**
```ts
return await db.transaction(async (tx) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('aoa:first-admin-bootstrap'))`);
  const existing = await tx.select({ id: instanceUserRoles.id })
    .from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin"));
  if (existing.length > 0) return false;
  await tx.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
  return true;
});
```
**Test:** two concurrent users against a real DB → exactly one `instance_admin`.

### R5 — Gate `ensureLocalTrustedBoardPrincipal` behind the escape hatch (overrides Stage A A6/A7; Codex #5) — **DO THIS FIRST**
**Root cause:** `server/src/index.ts:498` *always* creates `local-board` as `instance_admin` in local mode. So the "first Google user becomes admin" (R4/A7) never fires — an admin already exists — and the synthetic admin is exactly the default identity we're removing.
**Fix:** call `ensureLocalTrustedBoardPrincipal()` ONLY when `config.devLocalIdentity === true`. Otherwise skip it; the real admin is the first Google user (R4).
**Migration/cleanup:** on a pre-existing `local_trusted` instance switching to Google identity, the synthetic `local-board` `instance_admin` row is inert (local-board never signs in via Google). Provide a one-time cleanup that removes the synthetic role once a real Google `instance_admin` exists; document it. **Test:** fresh default `local_trusted` instance (`devLocalIdentity=false`) → NO synthetic admin → first Google user is promoted.

### R6 — Fail startup if Google creds missing in `authenticated` mode (overrides Stage A A2; Codex #6)
**Root cause:** missing `GOOGLE_*` silently builds a provider-less better-auth → in authenticated mode you ship a login screen whose only button can't work → instance locked out.
**Fix:**
- `authenticated`: throw a clear startup error unless BOTH `googleClientId` and `googleClientSecret` are set.
- `local_trusted`: allow missing creds ONLY when `devLocalIdentity` is active; otherwise throw a config error.
**Replace the A2 test** that asserted the provider is silently omitted with: (a) `buildBetterAuthConfig` includes google when creds present; (b) startup THROWS in authenticated mode when creds absent.

### R7 — Bind invited-join completion to a real invite/membership (overrides Stage D D2; Codex #7)
**Root cause:** `membershipExists` is injected but never called; UI acceptance only creates a `pending_approval` join_request, not a membership — so any user could write "completed" invited progress for an arbitrary `companyId`.
**Fix:** `/api/onboarding/join` must NOT write `SETUP_COMPLETE` from a client `companyId`. Resolve the caller's OWN open invite/join_request (by `req.actor.userId` + email snapshot), accept via existing `access.ts` flow, and introduce an explicit **`JOIN_REQUESTED`** state:
- invited progress = `PROFILE_SET → JOIN_REQUESTED` (pending approval) → `SETUP_COMPLETE` **only after** approval + active membership (verified via the real membership check).
- Add `JOIN_REQUESTED` to `ONBOARDING_STATES`; set `INVITED_PHASE1_STATES = [AUTHENTICATED, PROFILE_SET, JOIN_REQUESTED, SETUP_COMPLETE]`.
**Tests:** arbitrary companyId rejected; expired/revoked invite; pending approval; rejected; approved→membership→complete.

### R8 — Preserve the invite token across the OAuth round-trip (overrides Stage A A9 + Stage D D4; Codex #8)
**Root cause:** the token is sent once in a header on the journey fetch; the OAuth redirect→callback loses it; D4 needs it but FlowEngine has no step-prop mechanism; email-detected invitees are blocked.
**Fix — server-side short-lived state:**
- On `/invite/:token` landing (before Google), POST the token to the server, which stores it in a short-TTL server record keyed by a nonce and sets an **HttpOnly, Secure, SameSite=Lax** transient cookie carrying the nonce (or bind to better-auth's OAuth `state`).
- After the Google callback, the journey/join resolver reads the nonce cookie → looks up the token → resolves the invite → **consumes + clears** it.
- Never place the token in a query string, `sessionStorage`, or a route param.
- Email-only invitees (no token) resolve via `join_requests` (R9), so they're not hard-blocked.
**Test:** `/invite/:token` → Google callback → JoinOrg → accept, end-to-end.

### R9 — Journey detection must query `join_requests` (overrides Stage A A5; Codex #9)
**Root cause:** resolver queries memberships + invites only; the locked contract requires pending `join_request` detection. The real invitee email lives in `join_requests.requestEmailSnapshot` (schema: `requestingUserId`, `requestEmailSnapshot`, `status`).
**Fix:** `getJourneyForUser` also queries open human join_requests by `requestingUserId` (normalized `requestEmailSnapshot` as a guarded fallback), `status = pending_approval`. Extend `resolvePostAuthJourney` input with `pendingJoinRequests`. **Precedence:** active membership → `returning`; else pending/approved join_request or open invite → `invited` (targetCompanyId from the request/invite); else `founder`.
> This **supersedes** Stage A A5's `defaultsPayload.teamInvite.email` approach — prefer `join_requests.requestEmailSnapshot`; keep the `invites` match only for not-yet-accepted invite links. **Tests:** pending/approved/rejected precedence + email-snapshot fallback.

### R10 — Remove `company_user_profiles` from Phase 1 contracts (overrides Stage C C2 + Stage D D2; Codex #10)
**Fix:** delete the company-profile seed method, its dependency interfaces, and every test asserting it was called. Do NOT ship a no-op method that creates false confidence. `user_profiles` (global) is the ONLY Phase 1 profile store. C2 creates `user_profiles` + its own-profile route only. Add the mirror when `company_user_profiles` lands on main.

### R11 — Real OAuth `state`/PKCE security tests (overrides Stage D D6; Codex #11)
**Fix:** replace "assert Google configured" with integration tests around better-auth's actual social start + callback:
- authorization request contains `state`;
- PKCE challenge/method present when the provider flow supports it;
- missing/mismatched `state` → rejected;
- replayed callback `state` → rejected;
- callback cannot bind to a different browser session.

### R12 — Make the A3 red phase truly fail (overrides Stage A A3; Codex #12)
**Root cause:** asserting "not 200" passes even before removal (invalid creds already error).
**Fix:** either (a) seed a VALID email/password account and prove sign-in SUCCEEDS (200 + session) against current code, so removal makes it fail; or (b) test the built better-auth config / endpoint error code that identifies the provider as disabled. The red phase must demonstrably fail against current code.

---

## P2 — quality

### R13 — Onboarding probe must require a real path + full FS checks (overrides Stage C C5; Codex #14)
**Fix:** the onboarding environment route requires a non-empty canonical path and performs explicit read + create/write + delete + path-type checks before persisting the environment/`rootFolder`. Keep the generic environment endpoint's backward-compat separate; the generic probe's unconditional `ok:true` (`environment-probe.ts:75`) must not be the onboarding gate.

### R14 — Lock the REAL Commander CLI probe contract + both auth methods (overrides Stage C C7/C8; Codex #15)
Both local adapters export `testEnvironment` (`packages/adapters/claude-local/src/server/test.ts`, `packages/adapters/codex-local/src/server/test.ts`). Specify the adapter-registry lookup + the exact `testEnvironment` argument/result shape used by the existing agent test-connection route; do NOT invent a second probe abstraction.
**Both auth methods (subscription + API key):** see the **Commander Authentication** section below — the Verify step must detect install, detect/select subscription-login vs API-key, and store an API key via the real secret path.

### R15 — Mechanically fix residual commands (all stages; Codex #16)
Replace across A/B/C/D inline steps: `pnpm verify` → `pnpm typecheck`; `pnpm --filter @armyofagents/server test -- <p>` and `pnpm vitest run <p>` → `pnpm test:run <p>`; UI single file → `pnpm --filter @armyofagents/ui test:run <file>`; full suite → `pnpm test:run`; build → `pnpm build`; e2e → `pnpm test:e2e`; migration → `pnpm db:generate`. Remove the now-redundant correction prose once inline commands are fixed.

### R16 — Deepen the bootstrap-retirement tests (overrides Stage A A10; Codex #17)
Add startup-level tests: normal Google mode (no board-claim challenge created; no public `/board-claim` route), explicit headless mode (fallback available), missing-Google config, migration from an existing board-claim instance. Keep the fallback non-public + operator-enabled.

---

## Commander Authentication — both methods (founder question + fills R14)

**Verified against live code. Bottom line: BOTH methods run at the execution level for both CLIs, but the ONBOARDING flow does not yet expose them as a clean choice, and Codex subscription-login has no in-UI trigger.**

### What exists today
- **Both auth methods are wired at run time.** An agent authenticates via **subscription** (the CLI's own login session — `~/.claude` for Claude, `~/.codex/auth.json` for Codex) when no API key env is set, or via **API key** (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in `adapterConfig.env`, plaintext or a `secret_ref` → `company_secrets`). Refs: `packages/adapters/claude-local/src/server/execute.ts:152` (`resolveClaudeBillingType`: key→"api" else "subscription"), `packages/adapters/codex-local/src/server/execute.ts:101` + `codex-home.ts:106-125` (API key → writes `auth.json`; else copies the login `auth.json`). Server env keys are **stripped** from runs, so only per-agent key or login session authenticates.
- **`testEnvironment` is the real probe** (`claude-local/src/server/test.ts:73`, `codex-local/src/server/test.ts:67`). It returns `{ adapterType, status: "pass"|"warn"|"fail", checks: {code, level, message, detail?, hint?}[], testedAt }`. There is **no structured "method" field** — the auth signal is in check *codes*: install = `*_command_resolvable`/`*_unresolvable`; auth-needed = `*_hello_probe_auth_required` (live probe); method hints = Claude `claude_subscription_mode_possible` vs `claude_anthropic_api_key_overrides_subscription`; Codex `codex_openai_api_key_present` vs `codex_auth_json_present` vs `codex_openai_api_key_missing`. A richer `authMode` exists for Codex in `server/src/adapters/provider-status.ts:20` but is NOT returned to the client.
- **Probe route:** `POST /companies/:companyId/adapters/:type/test-environment` (`server/src/routes/agents.ts:528`), redacts secrets, returns the `checks[]`. Onboarding already calls it (`OnboardingWizard.tsx:509 handleStep5Next`) but currently only blocks on a *null* (errored) result — a `status:"fail"` still advances (bug to fix).
- **Subscription-login trigger: Claude YES, Codex NO.** Claude has `POST /agents/:id/claude-login` → returns a clickable `loginUrl` (`agents.ts:1882`, UI `AgentDetail.tsx:1770`) — but it's agent-scoped and on AgentDetail, not onboarding. **Codex has no in-UI login route** — only manual `codex login`.
- **API-key paste:** exists only via the generic per-agent Secrets/`EnvVarEditor` on `AgentConfigForm.tsx:929` (binds env→`company_secrets`), not in onboarding. `runtime_provider_keys` is e2b-only and NOT usable here. Hosted `llm:openai` is embeddings-only.
- **Install:** detected as an error check + install-command hint; **no install button/flow**.

### The C7/C8 "Verify Commander" contract (what the step MUST implement)
1. **Detect** via `agentsApi.testEnvironment(companyId, cliTool, { adapterConfig })` → parse `checks[]` codes: install (`*_command_resolvable`), auth (`*_hello_probe_passed` = ready; `*_hello_probe_auth_required` = needs auth). Treat `status:"fail"` as BLOCKING (fix the wizard's advance-on-fail bug).
2. **Offer BOTH auth methods explicitly** (new onboarding UX — today it's implicit):
   - **Subscription:** for Claude, reuse/port the `claude-login` route to a Commander-scoped login and surface its `loginUrl` + "Check again". **For Codex, BUILD the missing login trigger** (new server route mirroring claude-login: run `codex login`, surface its device/URL flow) — this is net-new work and a real gap, flag it as its own task.
   - **API key:** reuse the secret-binding path to write `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` into the Commander's `internal_agent_config` adapter env as a `company_secrets` `secret_ref` (never plaintext), then re-probe.
3. **Re-probe after either path**; only `*_hello_probe_passed` unlocks `COMMANDER_VERIFIED`.
4. Do NOT invent a second probe abstraction — use `testEnvironment` + the existing secret/login routes. Optionally surface `provider-status.ts` `authMode` to the client so the UI can *show* which method is active.

### New work this implies (add as explicit Stage C tasks)
- **T-CodexLogin:** a Codex subscription-login route + UI trigger (parity with Claude) — currently missing.
- **T-CommanderProbeSurface:** return `authMode` (and a normalized `installed`/`authenticated`/`method` summary) from the test-environment route so the onboarding UI isn't parsing raw check-code prose.
- **T-ProbeBlocking:** fix onboarding to block on `status:"fail"`, not only on a null/errored result.

---

## Execution sequencing (apply in this order)
1. **R5 + R6** (startup-lockout class) — highest priority.
2. **R1** (org→engine handoff).
3. **R2 / R3 / R4 / R13** (concurrency + authz + probe).
4. **R7 / R8 / R9** (invited journey + token round-trip).
5. **R10 / R11 / R12 / R14 / R15 / R16** (honesty, security tests, commands, Commander contract).
Run `pnpm typecheck` + `pnpm test:run` after each stage. Then a targeted Codex re-review of the changed contracts before shipping Stage A.
