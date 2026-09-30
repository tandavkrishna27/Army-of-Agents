# Invited-Teammate Onboarding Journey — Design (Track B)

> **Status:** IMPLEMENTED 2026-07-16 — all 11 plan tasks executed subagent-driven with two-stage review per task (see `2026-07-16-invited-teammate-journey-plan.md`). Server 7,867 / UI 3,373 tests green, typechecks clean. Live multi-account validation + e2e remain (plan §Post-plan notes / Track D).
> **Branch:** `feat/invited-teammate-journey` (off `main` after PR #287 merged the founder onboarding + auth redesign).
> **Predecessor:** `docs/aoa/plans/2026-07-13-onboarding-auth-remaining-phases.md` §Track B (this supersedes that section's framing — see "Reframing" below).

---

## 1. Summary

A guided onboarding journey for an **invited human teammate**. When someone accepts an invite and signs in, they build their **Human Operating Profile** (so agents know how to work with them), and — when their verified Google email matches the invite — they're admitted **immediately on completing it**: the invitation itself carries the approval. Mismatched or open-link accepts fall back to founder approval with a live-polling pending screen. Reuses the existing invite-accept + approval machinery and fills the gaps that leave invited teammates as bare names today.

**Reframing (important):** the roadmap's original Track B framing ("JoinOrg step *creates* the join_request + invite-handoff table + a JOIN_REQUESTED→SETUP_COMPLETE state machine") is partly redundant. Ground-truth exploration confirmed the join_request is already created at invite-accept, approval already grants membership+role+grants, and the journey resolver already returns `returning` post-approval. So Track B is really about a **coherent guided profile experience + bundling approval into the invitation + materializing the company human record** — not new plumbing.

## 2. Locked decisions (the design contract)

1. **Fields the teammate fills:** Name (prefilled from Google), Title, Timezone — **required**; Bio, Social links — **optional**. Nothing else. Submit is blocked until the required three are set.
2. **Capabilities** (Responsibilities / Skills / Preferences / Availability / Resume / Background): **deferred** — seeded as editable stubs, filled later on the Human page or pre-filled by the inviter.
3. **Authority** (role, department, reports-to): **inviter-set** in the invite `defaultsPayload`; the teammate only *sees/confirms* it.
4. **Auto-admit on verified email match (approval bundled with the invitation):** an email-targeted invite *is* the approval. At **profile submit** (not at accept — this preserves decision 1's required-profile gate), if the acceptor's **verified** Google email matches the invited email (`defaultsPayload.teamInvite.email`, case-insensitive), the approval transaction runs immediately — system-approved with an audit marker, no founder action, no pending wait. **Fallbacks to pending founder approval:** email mismatch, unverified email, open-link invites (no email), or an abandoned profile (request stays `pending_approval`; the founder can still approve manually).
5. **Profile step** is a **shared, journey-agnostic component**, wired **invited-only now** (founder-journey wiring is a later follow-up).
6. **Data flow (§7):** global `user_profiles` written **live** during onboarding; the company-scoped human record is **materialized by the approval transaction** (whether founder-triggered or auto-admit). All company-scoped writes stay behind membership.
7. **Pending → approved transition (fallback path only):** **poll** (~5–10s) the journey endpoint; auto-enter on `returning`. Realtime (SSE) is a later upgrade.
8. **Onboarding is journey-tagged + modular** (existing FlowEngine + step registry); invited = steps tagged `journeys:["invited"]`. Future journeys just add tagged steps.
9. **Out of scope:** the RC3 invite-token handoff table (current URL-token flow stays), realtime transition, capability-doc *content* collection, founder-journey wiring, `JOIN_REQUESTED`/`SETUP_COMPLETE` state driving, a per-invite "require approval" toggle (can be added later if a founder wants review even for named invitees).

## 3. Current state (ground truth — what already works vs. the gaps)

**Works today:**
- Invite link `/invite/:token` → Google sign-in (token replayed via `?next=`) → accept → creates the `join_request` (`server/src/routes/access.ts` accept handler; `requestingUserId` + `requestEmailSnapshot`, `status='pending_approval'`). One join_request per invite (unique index) — invites are single-accept for humans.
- Founder approval (`access.ts` approve txn) → `ensureMembership` + `setPrincipalGrants` + `applyInviteRole` (role from `invite.defaultsPayload.teamInvite.role`).
- Journey resolver (`server/src/services/post-auth-journey.ts` + `routes/onboarding-journey.ts`) → `invited` with `targetCompanyId` + `pendingInvitations`; post-approval → `returning`. Verified-email matching already reads `authUsers.emailVerified`.
- Human Operating Profile model: global `user_profiles` (name/avatar/title/bio/socialLinks) + company-scoped `company_user_profiles` (title/timezone/bio/location/social/avatarAsset) + `company_user_capability_documents` (6 standard markdown docs) + `user_roles` + `company_memberships` (reporting chain). Prefilled `HUMAN_TITLE_OPTIONS` + `getTimezoneOptions()` live in `ui/src/pages/HumanDetail.tsx`.

**Gaps this feature fills:**
- Invited onboarding is just `ProfileStep` (global name) → a **static "Request sent" stub** (`InvitedPendingPage`). No guided profile, no live transition.
- Every invited teammate waits on founder approval even when the founder explicitly named them — the invitation doesn't carry the approval.
- **Approval creates NO company profile and seeds NO capability docs** for an invited member (both are lazy-created later, only on first edit/view). Even manual `addMember` skips the `company_user_profiles` insert.
- No live pending→approved transition — the invitee sits on the stub until a manual reload re-resolves the journey to `returning`.

## 4. End-to-end flow

1. Founder invites (existing) → invite carries the invited **email** + role/department in `defaultsPayload`.
2. Teammate opens `/invite/:token` → Google sign-in (existing).
3. Accept creates the `join_request` (existing) → **redirect into `/onboarding/join`** (today it stops on InviteLanding's own pending screen; we route it into the guided flow so there is one invited surface).
4. Guided invited onboarding: **HumanProfileStep** (Name / Title / Timezone required; Bio / Social optional) advances `PROFILE_SET` on the user layer.
5. FlowEngine resolves no further invited step → the **InvitedJoinTerminal** renders and calls **finalize** once:
   - **Email match (common path):** the approval transaction runs now — membership + role + grants + company profile + capability stubs — and the teammate is navigated **straight into the company**. No pending screen.
   - **No match / unverified / open link:** the request stays `pending_approval` → the terminal shows the "You're joining {Company} as {role}" summary and **polls** `GET /api/onboarding/journey` every ~5–10s.
6. (Fallback path) founder approves (existing) → next poll returns `returning` → auto-navigate into the company. Rejected → terminal "not approved" state (never loops).

## 5. Field set + validation

| Field | Required | Written to (§7) | Source |
|---|---|---|---|
| Name | ✅ | global `user_profiles.displayName` | prefilled from Google |
| Title | ✅ | global `user_profiles.title` → mirrored to company at approval | shared `HUMAN_TITLE_OPTIONS` |
| Timezone | ✅ | carried on join_request → `company_user_profiles.timezone` at approval | shared timezone list (auto-detect + confirm) |
| Bio | — | global `user_profiles.bio` | free text |
| Social links | — | global `user_profiles.socialLinks` | add-your-own |

Submit is blocked until Name + Title + Timezone are set (Name is prefilled, so effectively Title + Timezone are the two the teammate must touch).

## 6. Components

**New:**
- **`HumanProfileStep`** (shared, journey-agnostic; `ui/src/onboarding/steps/`): the 5 fields, using the shared Title/Timezone constants. Registered `journeys:["invited"]`, advancing `PROFILE_SET`. **It supersedes the bare `ProfileStep` for the invited journey** — retag the existing `ProfileStep` to `journeys:["founder"]` so invited uses the richer step and founder is untouched. Writes the global profile, then advances.
- **`InvitedJoinTerminal`** (the terminal render — replaces the static `InvitedPendingPage`, NOT a registry step, so no `JOIN_REQUESTED` state is needed): on mount, calls the **finalize** endpoint once. `admitted` → navigate into the company. Not admitted → shows the "joining {Company} as {role}" confirm summary and polls the journey endpoint; auto-enters on `returning`; renders a terminal **"not approved"** state if the request is rejected (never loops).

**Changed:**
- **`InviteLanding`**: after a successful human accept, route to `/onboarding/join` instead of its inline pending screen.
- **Shared constants**: extract `HUMAN_TITLE_OPTIONS` + `getTimezoneOptions()` (currently in `HumanDetail.tsx`) into a shared module both `HumanDetail` and the onboarding step import — so they can never drift.

## 7. Data model & data flow

- **Global `user_profiles`** (name, title, bio, socialLinks): written **live** during onboarding via the existing `saveUserProfile` (self-owned; already allowed). The founder therefore sees the teammate's identity at approval time on the fallback path.
- **Company-scoped human record** — materialized by the **approval transaction** (single choke point, whether founder-approve or auto-admit finalize):
  - Create `company_user_profiles` (idempotent): copy identity from the invitee's global `user_profiles` + set `timezone` (carried on the `join_request` — a small nullable column/payload added at profile submit).
  - Seed the 6 standard capability docs (`humanCapabilities.ensureStandardDocuments`) — the same call manual `addMember` already makes.
- **Auto-admit audit:** the auto-admitted join_request is recorded as approved with a distinct approval-source marker (system/invite-email-match), never impersonating the founder.
- **No new state machine:** `JOIN_REQUESTED`/`SETUP_COMPLETE` stay unused. The `join_request` status + membership are the source of truth. The invited FlowEngine advances `PROFILE_SET` on the user layer (as today) and ends on the terminal.

## 8. Backend changes

- **Extract the human-approval transaction into a shared service** callable from both the founder approve route and the new finalize path (membership + grants + role + company profile + capability stubs; idempotent; profile/capability seeding is best-effort and must NOT fail the approval).
- **Finalize endpoint** (self-scoped; e.g. `POST /api/onboarding/join/finalize`): for the caller's own `pending_approval` human join_request on the target company — recompute the email match **fresh** (acceptor's `authUsers.email` + `emailVerified` vs `invite.defaultsPayload.teamInvite.email`, case-insensitive; invite not revoked — expiry is NOT re-checked, see §9). Match → run the shared approval transaction (system-approved) → `{ admitted: true }`. No match → `{ admitted: false }` (request remains pending). Idempotent: already-approved → `{ admitted: true }`.
- **Approval seeding** (both paths): upsert `company_user_profiles` from global identity + carried timezone, and `ensureStandardDocuments`. **Bonus:** apply the same company-profile insert to manual `addMember` so all three paths converge.
- **`join_requests`** gains a small nullable column/payload to carry the invitee's timezone captured at profile submit.
- **No new route for the journey poll** — the fallback pending state reuses `GET /api/onboarding/journey`.

## 9. Edge cases

- **Unverified Google email** → never auto-admits; falls back to pending (matches the resolver's existing verified-email discipline).
- **Email match is case-insensitive**; compared fresh at finalize (not a stale snapshot).
- **Invite validity is established AT ACCEPT, not re-checked at finalize.** Company invites carry a 10-minute TTL (`COMPANY_INVITE_TTL_MS`) and are consumed at accept — the clock keeps ticking through Google sign-in + the profile form, so re-checking `expiresAt` at finalize would degrade nearly every real auto-admit to pending. Finalize keeps only a defensive `revokedAt` check (revoke-after-accept isn't possible via the normal route — `revokeInvite` throws on accepted invites). A revoked invite surfaces a distinct "invite no longer valid" state, not generic pending. *(Amended post-review: the original "expired between accept and finalize → refuses" wording predated the TTL ground truth.)*
- **Abandoned profile** → request stays `pending_approval`; the founder can still approve manually (graceful degradation of the auto-admit).
- Request **rejected** → poll detects it → terminal "not approved" screen (no navigate to `/`, which would re-loop).
- **Already a member** on re-visit → resolver returns `returning` → straight into the app; finalize is idempotent.
- **Multiple pending invites** → target the deep-linked (`?company=`) or first company (existing resolver behavior).
- **Abandon mid-profile + return** → FlowEngine resumes at the incomplete step (existing resumable behavior).
- **Poll lifecycle** → stops on unmount; bounded interval; tolerant of transient errors.
- **Approval retry / double-finalize** → all seeding idempotent (upsert + `ensureStandardDocuments` already idempotent).

## 10. Testing strategy (TDD)

- **UI unit (RTL):** `HumanProfileStep` — required-field gating (submit blocked until Name/Title/Timezone), writes global profile, advances; uses shared constants. `InvitedJoinTerminal` — calls finalize once; navigates on `admitted`; falls back to pending + poll on not-admitted; auto-navigates on `returning`; terminal "not approved" on rejection; stops polling on unmount. `InviteLanding` — routes to `/onboarding/join` after accept.
- **Server:** finalize — admits on verified match (case-insensitive) even after the invite's 10-minute `expiresAt` has passed (validity was established at accept), refuses on mismatch/unverified/revoked, idempotent on re-call, never impersonates the founder in the audit trail; the shared approval transaction materializes `company_user_profiles` + seeds capability stubs idempotently from BOTH trigger paths; manual `addMember` convergence; join_request timezone carry.
- **Shared:** constants extraction keeps `HumanDetail` behavior identical.
- **e2e (Track D overlap, deferred):** full invited journey with a 2nd (mocked) Google identity — matched auto-admit path AND mismatch pending path. Not blocking; folds into the A12 mocked-Google helper.

## 11. Out of scope / deferred

Capability-doc **content** collection (stubs only); **realtime** transition (poll only); wiring the shared profile step into the **founder** journey; the RC3 **invite-token handoff table** (URL-token flow stays); driving `JOIN_REQUESTED`/`SETUP_COMPLETE`; a per-invite **"require approval" toggle** (auto-admit is unconditional for verified email matches in v1).

## 12. Open follow-ups (post-Track-B)

- Add the shared `HumanProfileStep` to the **founder** journey so founders also get a company Human Operating Profile during onboarding (today lazy-created).
- Per-invite "require my approval" toggle for founders who want review even for named invitees.
- Capability-doc collection UX (in onboarding and/or inviter-seeded).
- Realtime approval transition over LiveEvents.
- RC3 invite-token handoff table (keep token out of URLs).
- Enrich the founder's approval card with the invitee's profile summary (fallback path).
