# Onboarding & Auth Redesign — Phase 1 Design (Scope)

- **Date:** 2026-07-12
- **Status:** Design locked, pending user review → implementation plan
- **Owner:** Founder (TK)
- **Supersedes:** the current `OnboardingWizard` (8-step company-create wizard) and the email/password `Auth.tsx` flow.

---

## 1. Context & Problem

AoA is a local-first, cloud-synced, **multitenant** Hybrid Workforce OS: many companies, many humans, one identity model. A person works on their own machine, teammates on theirs, all synced to the cloud (a future full-cloud version and later self-hosted-for-big-clients are anticipated).

Today:
- **Auth** is better-auth with **email + password only**. No Google, no OAuth. Two deployment modes: `local_trusted` (no login — synthetic loopback admin) and `authenticated` (real cookie login).
- **Onboarding** is a single 8-step `OnboardingWizard` that defers company creation to step 4 and seeds crew/skills/memory folders. There is **no persisted "onboarding complete" state** — first-time vs returning is derived purely from "do you have any companies."
- **No user-level identity layer** — everything is company-derived.
- **The `environments` table + probe service exist but onboarding never uses them.**

This redesign replaces both flows with a **Google-only auth layer** and a **modular, resumable, two-phase onboarding**. This document specs **Phase 1 (auth + workspace setup)**. Phase 2 (guided walkthrough) is a fast-follow with its own spec.

**Premise corrections captured during design:**
- There is **no LinkedIn invite/login** anywhere in the codebase. "LinkedIn" exists only as one option in a team member's profile social-links list. Nothing to remove from auth/onboarding.
- There is **no `cloud_auth` deployment mode** — only `local_trusted` and `authenticated`.
- The "admin URL" recollection maps to the CLI **bootstrap-CEO / board-claim** flow, not LinkedIn.

---

## 2. Goals / Non-Goals

### Goals
- **Google is the only sign-in/sign-up door**, via better-auth (engine retained).
- **One identity model everywhere** (local + cloud) with a narrow **dev/offline escape hatch**.
- A **modular, resumable** onboarding: persisted state machine + step registry that supports future branching journeys without rewrites.
- **Two-layer split:** user-level onboarding (once per human) vs org-level onboarding (once per org, replayable from the Lobby).
- **First-class environment** step (register this machine; verify read/write).
- **In-UI Commander install/auth help** so non-technical users never *have* to use a terminal.
- **Detect + route invited humans** away from the create-org flow (minimal join now, full journey later).
- **Enterprise bar:** best-practice patterns, full test coverage (unit → integration → e2e → security), all edge cases, no silent failures.

### Non-Goals (Phase 1)
- The Phase 2 guided walkthrough (specced separately; states reserved).
- Dropping the `account.password` column (kept, dead-but-harmless).
- Full invited-human onboarding journey (only detect + route + minimal join in Phase 1).
- Auto-installing CLIs silently (we detect → guide → verify).
- Mission/vision/industry capture during onboarding (deferred to org settings).

---

## 3. Locked Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Auth engine | **Keep better-auth**; configure Google as the *only* provider; remove email/password provider + UI. |
| D2 | Identity across deployments | **Google everywhere + narrow dev/offline escape hatch.** Local app authenticates to cloud once, then operates local-first via a persisted local session. |
| D3 | Build order | **Phase 1 first** (auth + workspace setup + resumable state machine); Phase 2 walkthrough fast-follow. |
| D4 | Environment step | **First-class** — creates a real `environments` record (driver `local`), verifies read/write via existing `probeEnvironmentConfig`. |
| D5 | Instance-admin bootstrap | **First Google user on a fresh instance auto-becomes instance admin.** Remove CLI bootstrap-ceo + board-claim URL from the human flow; keep a guarded headless-CLI fallback for future self-hosted servers. |
| D6 | Invited-human scope | **Detect + route now, minimal join.** Full invited journey deferred but structurally supported by the step registry. |
| D7 | User-level profile | **New global `user_profiles`** (per-human: name/avatar/title/bio/socialLinks). Seeds `company_user_profiles` on org create/join. |
| D8 | Department taxonomy | **Add `sales`**, relabel `support` → "Customer Support"; consolidate to a **single shared source of truth** in `packages/shared`, consumed by both onboarding and `NewProjectDialog`. |
| D9 | Workspace connection | **Local folder default (optional), GitHub App picker optional.** Root set once at Environment step; departments auto-nest a prefilled, editable subfolder; never mandatory in the happy path. |
| D10 | Agent runtime | **Inherit from Commander by default**; override behind collapsed advanced settings. |
| D11 | Crew agents | Remain **system-managed / auto-seeded**; onboarding surfaces only the one execution agent the founder creates. |

---

## 4. Architecture Spine

### 4.1 Persisted onboarding state machine
A new `onboarding_progress` record (per user, per org) tracks the canonical state and drives resume-on-return.

```
AUTHENTICATED
  → PROFILE_SET
  → ORGANIZATION_CREATED
  → ENVIRONMENT_READY
  → COMMANDER_SELECTED
  → COMMANDER_VERIFIED
  → DEPARTMENT_CREATED
  → AGENT_ASSIGNED
  → SETUP_COMPLETE
  → [Phase 2 reserved: WALKTHROUGH_STARTED → … → ONBOARDING_COMPLETE]
```

Each step writes its completion state server-side as it finishes. On return, the app reads `onboarding_progress` and drops the user at the **first incomplete state**. This replaces today's "guess from whether you have companies."

### 4.2 Step registry (the modularity)
Each step is a declarative unit rather than a hardcoded `switch`:

```
Step = {
  id,
  state,               // the completion state it satisfies
  journey,             // which journeys include it (founder | invited | …)
  completionCondition, // predicate over server state (idempotent re-entry)
  canSkip,
  dependsOn,           // prior states required
  render,              // UI
}
```

A flow engine walks the registry filtered by journey. This is what lets future journeys **insert / skip / branch** steps (learn-more paths, non-software journeys, "just exploring") without rewriting the flow — satisfying "structure must allow expansion even if we don't build the branches now."

### 4.3 Two-layer split
- **User-level onboarding** (Google auth + profile) — once per human.
- **Org-level onboarding** (org → environment → commander → dept → agent) — once per org, **replayable from the Lobby**.

Creating a 2nd org from the Lobby re-enters **only** the org-level flow (states `ORGANIZATION_CREATED` → `SETUP_COMPLETE`), skipping the user layer.

---

## 5. Auth & Identity Model

### 5.1 Google OAuth (the only door)
- Add `socialProviders.google` to `createBetterAuthInstance()` (`server/src/auth/better-auth.ts`); plumb `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` through `server/src/config.ts`; ensure callback origin ∈ `trustedOrigins` and `baseURL` is set for the redirect.
- `Auth.tsx` becomes a single **"Continue with Google"** screen — no mode toggle, no email/password/name fields. Google's account chooser *is* the sign-up-vs-sign-in decision.
- `account` table already has all OAuth columns (`providerId`/`accessToken`/`refreshToken`/`idToken`/`scope`) — **no migration** for provider links.

### 5.2 Post-auth router — three journeys
Immediately after a successful Google callback, one resolver decides the destination from (Google identity + deep-linked invite token + existing memberships):

| Detected state | Journey | Runs |
|---|---|---|
| Has ≥1 org membership | **Returning** | Straight to Lobby / last org |
| Arrived via `/invite/:token` **or** has a pending `join_request`/invite for their email | **Invited** | Profile → join existing org (no org/env/commander/dept creation) → [Phase 2 tour later] |
| Brand new, no memberships, no invite | **Founder** | Full Phase 1 (org → environment → commander → dept → agent) |

Phase 1 builds detection + routing for all three; the invited journey ships as a **minimal** "profile → join your org" path.

### 5.3 Identity across deployments + dev/offline escape hatch
- **Normal (local + cloud):** the app resolves a **real Google identity**. After the *first* online Google auth we persist a **long-lived local session**, so day-to-day launches don't require a live round-trip — authenticate to cloud once, then operate local-first.
- **Dev/offline escape hatch:** an explicit opt-in flag (`AOA_DEV_LOCAL_IDENTITY=1`) restores today's synthetic-admin behavior for development / air-gapped use. **Hard-blocked (fail-closed) in `authenticated`/hosted deployments**, clearly labeled in-UI when active.
- `actorMiddleware` (`server/src/middleware/auth.ts`) changes: the synthetic admin is produced **only** under the escape-hatch flag, never by default. Default becomes the Google/persisted-local session.
- **First Google user on a fresh instance → instance admin** (replaces CLI bootstrap-ceo for the normal case; guarded headless CLI fallback retained).

### 5.4 Removals (careful, with a deprecation pass)
- Email/password `Auth.tsx` UI + `/sign-in/email`, `/sign-up/email`, `/forget-password` routes + their rate-limiters + client methods (`signInEmail`/`signUpEmail`).
- CLI `bootstrap-ceo` + `board-claim` URL removed from the human flow (guarded headless fallback kept).
- **Keep** `account.password` column (dead but harmless; dropping it is a separate, riskier migration).
- Everything else in better-auth (sessions, actor-middleware core, board keys, CLI auth) is **untouched** — the reason we keep the engine.

---

## 6. Per-Step Contracts (Founder journey)

Every step is **idempotent** and writes its completion state to `onboarding_progress`.

| # | Step | Completion state | Writes on success | Recovery / edge |
|---|------|------------------|-------------------|-----------------|
| 1 | **Your profile** | `PROFILE_SET` | `user_profiles` (name prefilled from Google, avatar from Google image, optional title/social links) | Skippable except name |
| 2 | **Create organization** | `ORGANIZATION_CREATED` | `companies` row → creator = owner/founder (`ensureRealOperator`); unique-prefix retry; seeds `company_user_profiles` from `user_profiles` | Name-only; mission/vision deferred |
| 3 | **Set up environment** | `ENVIRONMENT_READY` | `environments` row (`driver:"local"`) + `companies.rootFolder`; runs `probeEnvironmentConfig` | **Blocking** on probe fail (no write perms / missing path) → pick another path / create folder → re-probe |
| 4 | **Choose Commander** | `COMMANDER_SELECTED` | `internal_agent_config` (cliTool/provider) | Claude / Codex cards; no model internals |
| 5 | **Verify tooling** | `COMMANDER_VERIFIED` | Verified flag; API key (if that path) → per-company encrypted secret | In-UI install/auth help (§8); **blocking** until verified or user picks the other runtime |
| 6 | **First department** | `DEPARTMENT_CREATED` | `projects` (type=department) + taskboard + workspace source | Software → workspace config inline; folder default nested under root (editable) or GitHub picker |
| 7 | **First agent** | `AGENT_ASSIGNED` | `agents` row **+ immediate department assignment** + workspace grant; runtime inherits Commander | Advanced settings (heartbeat/crawl/context/retry/permissions) collapsed |
| 8 | **Review** | `SETUP_COMPLETE` | — | Summary table; "Start walkthrough" (Phase 2) / "Go to dashboard" |

### Cross-cutting (enterprise-grade), every step
- **Resume:** return drops the user at the first incomplete state; re-entering a completed step never double-writes (org-create checks existing, environment upserts by name, commander config upserts, agent-create guards).
- **No silent failure:** environment probe and Commander verify are **blocking** (fixes today's non-fatal folder-create).
- **Replay from Lobby:** creating a 2nd org re-enters only steps 2–8.

---

## 7. Workspace / Environment / Department Nesting

- **Root set once** at the Environment step (Step 3), prefilled to home dir, verified writable → `companies.rootFolder` + the `environments` record.
- **Departments auto-nest**: the Software department's local folder defaults to a subfolder under the root (e.g. `…/AcmeLabs/engineering`), prefilled + one-click, **editable**. Or swap for a GitHub repo (App connect + repo picker; backend exists). "Both" (folder + repo) supported.
- **Always changeable** later in department settings.
- Local folder is **never mandatory** in the happy path; GitHub is an optional swap.

---

## 8. Commander Install / Auth Help (Step 5)

Designed **detect → guide → verify**, never silent-install:
1. **Detect:** CLI installed? launchable? authenticated (subscription login *or* API key)? app has permission? (reuses/extends the existing adapter environment-probe.)
2. **Guide (recovery branch):** plain-language reason + OS-specific copy-paste install command + "Open terminal / docs" + **"Check again"** loop. For auth: walk through the CLI's subscription login **or** paste an API key into the UI (stored as the per-company encrypted secret).
3. **Verify:** green "ready" state unlocks Continue.

The user remains on this step until verification succeeds or they go back and pick the other runtime.

---

## 9. Data Model Changes

### New tables
- **`user_profiles`** — global per-human identity: `userId` (PK), `displayName`, `avatarUrl`, `title`, `bio`, `socialLinks` (jsonb). Filled at signup; seeds `company_user_profiles` on org create/join.
- **`onboarding_progress`** — resumable state: `userId`, `companyId?`, `journey` (`founder` | `invited`), `currentState`, `completedStates[]`, timestamps.

### Modified
- **better-auth config** — add Google provider, remove email/password provider.
- **`environments`** — now written during onboarding (Step 3) via existing CRUD + probe.
- **department taxonomy** — add `sales`; single shared source of truth in `packages/shared` consumed by onboarding + `NewProjectDialog`.
- **`actorMiddleware`** — default identity = Google/persisted-local session; synthetic admin only under escape-hatch flag; first Google user → instance admin.

### Removed
- Email/password UI + routes + limiters + client methods (§5.4).
- CLI bootstrap-ceo + board-claim URL from the human flow (guarded headless fallback kept).
- `account.password` column **kept** (not dropped).

### Object mapping (no new "organization vs company" split)
Organization = `companies` · Environment = `environments` · Department = `projects` (type=department) · Commander = `internal_agent_config` · Agent = `agents` · Human profile = `user_profiles` (global) + `company_user_profiles` (per-org).

---

## 10. Test & Security Strategy (Enterprise Bar)

- **Unit:** state-machine transitions + idempotency; post-auth router (all 3 journeys); profile → company-profile seeding; taxonomy single-source; actor resolution ±escape-hatch.
- **Integration:** Google callback → user create/link → membership; environment probe pass/fail (blocking); Commander verify pass/fail/recovery; invite-token → invited routing; resume-from-any-state.
- **E2E:** Google mocked (deterministic test IdP); full founder onboarding; resume-after-abandon; invited-human minimal join; 2nd-org-from-Lobby skips user layer.
- **Security:** OAuth `state`/PKCE; cookie flags (`HttpOnly`/`Secure`/`SameSite`); escape hatch refused in hosted mode; no secrets in URLs/logs; API-key-paste stored as encrypted per-company secret.

---

## 11. Defaults chosen now, configurable later

(From the transcript's "unresolved" list — sensible defaults for the happy path; made configurable post-Phase-1.)

- **Agent runtime** inherits Commander by default (override in advanced).
- **Crew agents** system-managed / auto-seeded (not surfaced as editable org agents in onboarding).
- **Memory destination**, **task granularity**, **automatic-execution-after-approval** — deferred to Phase 2 (walkthrough) scope.

---

## 12. Phase 2 (Reserved, specced separately)

Guided **Discussion → Delivery** walkthrough (sample portfolio project): analyze → clarify → scope → approve → persist memory + create tasks → assign agent → execute → land on the task. Reserves states `WALKTHROUGH_STARTED → DISCUSSION_ANALYZED → CLARIFICATIONS_RESOLVED → SCOPE_CREATED → SCOPE_APPROVED → MEMORY_SAVED → TASKS_CREATED → AGENT_EXECUTION_STARTED → ONBOARDING_COMPLETE`.

**Hard dependency:** the Assist-mode timing fix (no real tasks created before human approval) that Codex flagged in the current `thread-agent-actions` behavior.

---

## 13. Acceptance Criteria (Phase 1)

Phase 1 is complete when:
1. A user can authenticate **only** via Google (email/password fully removed).
2. First Google user on a fresh instance is instance admin; subsequent users route correctly (returning / invited / founder).
3. The dev/offline escape hatch works locally and is refused in hosted mode.
4. A founder completes: profile → org → environment (probe-verified) → commander (verify-passed) → software department (workspace connected or nested folder) → agent (assigned to department, inheriting Commander).
5. Leaving mid-onboarding and returning resumes at the first incomplete state.
6. Creating a 2nd org from the Lobby skips the user layer.
7. An invited human is routed to the minimal join path, never to create-org.
8. All test layers (unit/integration/e2e/security) pass; no silent failures on probe/verify.
```