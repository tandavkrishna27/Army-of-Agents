# Onboarding & Auth Redesign — Roadmap for the Remaining Phases

> **Purpose:** a forward-looking handoff. Phase 1 (Google-only auth + the founder onboarding flow) is **built, green, and live-validated**. This document scopes everything that remains, in recommended execution order, so any future session can pick up a track without re-deriving context.
>
> **Read first:** `2026-07-12-onboarding-auth-redesign-HANDOFF.md` (authoritative status + §9 Session-2 fixes). Authority order for design questions: `revC > revB > revA > stage docs`.

---

## 0. Where we are (2026-07-13)

- **Branch:** `feat/onboarding-auth-redesign` (~50 commits ahead of `main`). Not yet PR'd.
- **Founder path:** COMPLETE + **live-validated against real Google OAuth** (first-user→admin RB3, founder journey, two-layer advance profile→org→env→dept all proven on a live round-trip).
- **Green:** UI suite 3178 pass / 3 skip, UI typecheck clean; server suite 7467 (pre Session-2; Session-2 changed only UI + e2e config).
- **Session-2 fixes shipped:** redirect bfcache, agent-runtime transparency + getConfig race, 2nd-company `?new=1`, invited-loop terminal gate, org-create idempotency, swallowed-error surfacing, e2e escape-hatch. See HANDOFF §9.

**Recommended track order:** A (finish Phase-1 hardening) → **ship the branch** → B (invited journey) → D (e2e) alongside B → C (in-app CLI login) → E (Phase-2 walkthrough). C and E are independent and can slot in whenever there's appetite.

---

## Track A — Finish Phase-1 hardening (small, do next)

Polish items the Session-2 audit surfaced but scoped out. All founder-facing, all unit-testable, no new infra. Ship these, then PR the branch.

| # | Item | Where | Fix | Risk |
|---|---|---|---|---|
| A1 | **Interrupted founder isn't auto-resumed.** After `ORGANIZATION_CREATED` the user has membership → journey resolver returns `returning` → Lobby, with no nudge to finish env/commander/dept/agent. (Manual `/onboarding` resumes fine.) | `server/src/services/post-auth-journey.ts`, `ui/src/App.tsx` `LobbyOrOnboardingRedirect` | Either: resolver returns `founder` while the selected company's org layer is `< SETUP_COMPLETE`; **or** surface a "Finish setting up {company}" card in the Lobby that deep-links to `/onboarding`. Prefer the Lobby card (less churn to the resolver's returning/invited precedence). | Low. Touches the journey gate — full server suite after. |
| A2 | **DepartmentStep idempotent guard skips workspace creation on retry-after-partial-failure.** If dept was created but mkdir/workspace failed, a retry finds the existing dept and skips the whole workspace block. | `ui/src/onboarding/steps/DepartmentStep.tsx` (the `if (!deptId)` block, ~L64-96) | Move the folder/workspace creation OUT of the `if (!deptId)` guard so it runs whether the dept was just created or already exists; make `createWorkspace` idempotent (guard on an existing workspace for the dept) so a retry doesn't duplicate. | Medium — needs `createWorkspace` idempotency check; add a test for the retry path. |
| A3 | **`validateRegistry` never runs on the real registry.** Only fixtures are validated (`registry.test.ts`); `ONBOARDING_STEPS` is validated neither at boot nor in a test (contra RC-P2). | `ui/src/onboarding/steps/index.ts` or a test | Add a test asserting `validateRegistry(ONBOARDING_STEPS) === []`. (Several step tests already assert this incidentally — make it a dedicated, intentional guard.) | Trivial. |
| A4 | **No working Back button.** `OnboardingFlow` never passes `onBack`; `VerifyStep` copy ("Go back to pick Claude or Codex") references a control that doesn't exist. | `ui/src/pages/OnboardingFlow.tsx`, `ui/src/onboarding/FlowEngine.tsx`, `VerifyStep.tsx` | Decide: wire a real Back (engine walks to the previous completed step) OR remove the misleading copy. Back is genuinely useful at the commander/verify steps — recommend wiring it. | Low-medium. |
| A5 | **P3 correctness nits.** (a) `advanceState` trusts `args.journey` not the persisted `row.journey` (`onboarding.ts:140`) — a founder+invited user sharing a user-layer row could reset `currentState`. (b) Best-effort admin promotion swallows errors (`better-auth.ts:185`) — a transient failure could leave the instance adminless with no retry. | `server/src/services/onboarding.ts`, `server/src/auth/better-auth.ts` | (a) Prefer `row.journey` when present, or validate the requested state is in the row's journey. (b) Log at error level + add a idempotent backfill on next admin-less sign-in. | Low; both low-reachability. |

**Exit criteria:** A1–A4 done + tested; A5 optional. Then **ship the branch** (see §Ship gate).

---

## Track B — Invited-teammate journey (the big deferred piece)

> **STATUS 2026-07-16: IMPLEMENTED** on branch feat/invited-teammate-journey — reframed + built per docs/aoa/plans/2026-07-16-invited-teammate-journey-{scope,plan}.md (guided Human Operating Profile step, auto-admit on verified email match, polling terminal, approval-time seeding). Remaining: live 2nd-account validation + Track D e2e.


The core multi-human story. Today the invited path is safely **gated** (Session-2 terminal "pending approval" page) so no one loops — but a teammate can't actually complete a guided join. This builds the real flow. **Requires a 2nd Google account to validate end-to-end.**

Three interlocking parts (all originally Stage D; see HANDOFF §6):

### B1 — JoinOrg step (invited terminal step)
- Build `ui/src/onboarding/steps/JoinOrg.tsx`; register `journeys:["invited"]`, `state:"JOIN_REQUESTED"`, `dependsOn:["PROFILE_SET"]`, unique per-journey order (e.g. 20).
- Advances `JOIN_REQUESTED` on the **user layer** (`companyId:null`) via the existing `advanceOnboarding` — the invited user has no membership, and PATCH `/onboarding/progress` only membership-checks non-null companyIds, so no new server route.
- Replace the Session-2 `InvitedPendingPage` stub in `OnboardingFlow.tsx` with the real step + its terminal pending state (keep the no-`onFinished`-navigate property that prevents the loop).

### B2 — Invite-token handoff table (RC3)
- New `onboarding_invite_handoffs` table (`nonce`, hashed token, `bound_user_id`, `expires_at`, `consumed_at`) via Drizzle (`pnpm db:generate`).
- Carry the nonce through OAuth via better-auth `additionalData`; atomic single-use consume.
- This is how JoinOrg obtains a plaintext token to call `accessApi.acceptInvite`. **Also closes the Session-2 backlog item** "invite token transits the URL through OAuth" (`/auth?next=/invite/:token`). Build against a real OAuth round-trip.

### B3 — Approval → `SETUP_COMPLETE` (RC2)
- In the human-approval txn (`server/src/routes/access.ts` ~L2461, after `ensureMembership`/`setPrincipalGrants`/`applyInviteRole`): best-effort `advanceState(txDb, { userId: requestingUserId, companyId: null, journey:"invited", requestedState:"SETUP_COMPLETE" })`.
- **Low value / handle carefully:** an approved user gains membership → resolver routes them "returning" regardless, so this is cosmetic. It touches the critical approval path and `computeAdvance` may reject a non-contiguous jump. Guard: `ensureProgress` first, wrap in try/catch, never fail the approval. Defer until B1/B2 are live-validated.

**Superseded doc tasks — do NOT redo:** D1 constants (`JOIN_REQUESTED` already present), D3 resolver rewrite (A5 redesign is current), D4 widen-profile (already `["founder","invited"]`), D7 no-secret-leak test (no token flows through the resolver).

**Testing:** needs the isolated authenticated instance + a **2nd Google account** (or a mocked second identity). Flow: founder invites → teammate opens invite link → Google login → journey resolves `invited` → profile → JoinOrg (request) → founder approves in Inbox → teammate gains access. Validate no loop at each re-entry.

---

## Track C — In-app CLI login (T-CodexLogin + D8)

> **STATUS 2026-07-16: IMPLEMENTED (ported).** The parallel branch's Plan 3 (encrypted API-key storage, streaming CLI-login runners + URL detector, durable login-challenge lifecycle + boot reaper, founder-gated login routes, terminal-free VerifyStep sign-in, live-QA fixes) was cherry-picked onto `feat/onboarding-auth-reconciled` with the commander_login_challenges migration regenerated as 0172 (byte-identical parity). Remaining: live smoke on the reconciled build.


Removes the "drop to a terminal and run `claude login` / `codex login`" step in the Commander-verify gate. Independent of B; slot in anytime.

- **Claude:** `claude login` is currently agent-scoped — needs a pre-agent login variant.
- **Codex:** has **no** login runner at all — net-new (revC RB8/R14).
- **D8:** encrypted per-company API-key paste path (Settings secret + binding route) as the alternative to subscription login.
- The blocking verify gate (`VerifyStep` + `commander-verify` service, 200 verified / 422 else) already works with the terminal-login fallback — this is a UX upgrade, not a correctness gap.
- **Needs a live CLI to verify.** Fake-claude/fake-codex e2e fixtures exist but don't cover login.

---

## Track D — e2e coverage (A12)

> **STATUS 2026-07-16: PARTIAL (ported).** The founder e2e suite (happy-path + resume + visual) + the gated test-support reset route were ported from the parallel branch onto `feat/onboarding-auth-reconciled`. The INVITED e2e (auto-admit + consent + pending paths) remains blocked on the mocked-Google second-identity helper — local_trusted e2e has a single synthetic actor, so a second verified-email user cannot exist without it. That helper is the remaining core of A12.


Run alongside Track B so the invited journey lands with tests.

- **Prerequisite (partly done):** Session-2 set `AOA_DEV_LOCAL_IDENTITY=1` in `tests/e2e/playwright.config.ts`, which restores the board actor for the whole local_trusted suite. The `onboarding.spec.ts` walk-through is currently `test.skip` under this track.
- **Build:** the mocked-Google `injectGoogleSession` helper (`tests/e2e/helpers/google-mock`, still unbuilt) + specs: founder happy path, resume mid-flow, invited join, 2nd-org-skips-user-layer, and the `?new=1` second-company flow.
- **CI/Linux only** (Windows e2e is skipped — embedded-pg on `runneradmin`, Issue #114). The environment/commander steps need the fake-claude/fake-codex fixtures (already wired) + a stable filesystem sandbox + progress reset between runs.

---

## Track E — Phase 2 product walkthrough (the guided demo)

The originally-envisioned "Phase 2": a guided **Discussion → Delivery** walkthrough on a sample portfolio, launched from the Review step's "Start walkthrough" button (today a stub that just advances `SETUP_COMPLETE`).

- **Reserved but undriven:** `WALKTHROUGH_*` states exist in `packages/shared/src/onboarding.ts`.
- **Hard dependency:** the Assist-mode "no real tasks before approval" fix that Codex flagged in `thread-agent-actions` — the walkthrough must not dispatch real crew work before the founder approves. Resolve that first.
- Own spec — scope separately when Phase 1 is shipped and the invited journey is stable.

---

## Ship gate — merge `feat/onboarding-auth-redesign`

Recommended **after Track A**, before B/C/E (don't let a 50→80-commit branch keep growing).

- **CI expectations:** the branch's first `pr.yml` run exercises the full gate. Session-2's e2e escape-hatch fix is what keeps the Linux e2e lane from 401-ing across the board — watch it land green. Confirm `brand-check` passes (no undocumented `AOA_*` in `server/src`; `AOA_DEV_LOCAL_IDENTITY` is documented).
- **Migrations:** `onboarding_progress` (0166) is the only schema change so far; the `migrations` gate should be clean. Track B adds `onboarding_invite_handoffs` — regenerate + commit all (`pnpm db:generate`).
- **Squash vs stacked:** one squash PR is fine given the branch is a coherent feature. If B/C land later, they're separate PRs.
- **Required check:** `ci-required` aggregator (see CLAUDE.md CI Platform Status). Human review + CODEOWNERS are deferred until a 2nd committer exists.

---

## Live-test infra reference (how to re-run the real-Google instance)

Isolated authenticated instance used for live QA this session:

- **Config:** `C:/Users/TK/.aoa/instances/onboarding-test/config.json` — `deploymentMode: authenticated`, port 3199, embedded PG 54399. **Outside the repo; the Google client secret is passed via env, never committed.**
- **Build UI first:** `pnpm --filter @armyofagents/ui build` (server serves `ui/dist` in static mode and computes CSP script-hashes from the built `index.html` **at boot** — so **rebuild → restart** after any UI change).
- **Start:** `AOA_CONFIG=<instance>/config.json GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… pnpm --filter @armyofagents/server dev` (background). Health: `GET http://localhost:3199/api/health`.
- **The user performs their own Google login** — credentials are never entered by the agent. First Google user on the fresh instance becomes instance admin (RB3).
- **Escape-hatch alternative (no Google):** flip the config to `local_trusted` + `AOA_DEV_LOCAL_IDENTITY=1` to drive the founder flow without a real login (can't exercise the bfcache-redirect path, which is authenticated-only).
