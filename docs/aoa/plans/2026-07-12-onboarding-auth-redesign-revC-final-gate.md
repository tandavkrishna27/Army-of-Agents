# Revision C — Final Gate Amendments (TOP AUTHORITY)

> **Top authority: revC > revB > revA > stage docs.** Closes the 3 remaining P1 contract gaps + tightening notes from the 2026-07-12 final Codex gate review. After revC, the plan is intended to be execution-ready (Stage A first, per revB §6 with the numbering fix in §RC-P2 below). Confirmed by Codex: `drizzle-orm 0.45.2` supports partial indexes + `targetWhere`; better-auth 1.6.11 has `databaseHooks.user.create.after` and callback-scoped `additionalData`.

---

## RC1 — Advance-state algorithm, fully specified (supersedes revB §1.2 retry)

`advanceState(db, { userId, companyId | null, requestedState, journey, expectedVersion? })`:

```
statesOrder = orderedStatesFor(journey)              // e.g. FOUNDER_PHASE1_STATES / INVITED_PHASE1_STATES
assert requestedState ∈ statesOrder                  // 400 otherwise
for attempt in 1..3:
  row = read progress for (userId, companyId)         // null-company via the user-layer partial index
  if row is null: INSERT { currentState:"AUTHENTICATED", completedStates:["AUTHENTICATED"], version:0 }
                  via conflict-safe upsert on the matching partial index, then re-read and continue
                  // MUST seed completedStates:["AUTHENTICATED"] — the schema default [] would leave
                  // PROFILE_SET's dependsOn unsatisfied and make replay a silent no-op.
  reqIdx = statesOrder.indexOf(requestedState)
  curIdx = statesOrder.indexOf(row.currentState)
  // IDEMPOTENT / BEHIND = success no-op (do NOT reject):
  if requestedState ∈ row.completedStates OR reqIdx <= curIdx:
     return { status: "ok", noop: true, row }
  // GENUINELY FORWARD — validate it's a legal next step:
  if reqIdx > curIdx + 1 AND requestedState's dependsOn ⊄ row.completedStates:
     return 409/400 "illegal transition"              // skipping unmet dependencies
  newCurrent = statesOrder[max(curIdx, reqIdx)]        // never regress
  newCompleted = union(row.completedStates, [requestedState, ...statesOrder.slice(0, reqIdx+1) that are already implied? NO — union only with requestedState])
  n = UPDATE progress SET current_state=newCurrent, completed_states=newCompleted,
         version=row.version+1, updated_at=now()
      WHERE id=row.id AND version=row.version
  if n == 1: return { status: "ok", row: updated }
  // else: another writer advanced — loop and re-read
return 409 "version conflict after 3 attempts"
```
Notes: only append `requestedState` to `completedStates` (union), not a backfilled range — dependency-gating already guarantees prerequisites are present. `expectedVersion` (from the client ETag) is optional; when present and stale, treat as the conflict path. Tests: idempotent replay = no-op ok; concurrent two-device forward = both succeed, union preserved, never regress; illegal skip = rejected; >3 conflicts = 409.

---

## RC2 — Invited completion lives in the APPROVAL transaction (supersedes revB RB5)

The real approval happens in `server/src/routes/access.ts` (~:2419), **separate** from `/invites/:token/accept`. Therefore:
- The **accept service** (reused by `/invite/:token/accept` and `/onboarding/join`) ONLY creates/reuses the `join_request` (status `pending_approval`) and advances invited progress to `JOIN_REQUESTED`. It does NOT complete onboarding.
- **Amend the approval transaction** (`access.ts` ~:2419): after `ensureMembership(...,"active")` + `applyInviteRole`, call a **transaction-bound** onboarding service that:
  1. derives the expected role via `parseInviteRoleMetadata` (the real helper — **currently private; export it or expose it through `teamService` before use**),
  2. verifies the active `company_memberships` row AND the matching `user_roles` row exist,
  3. advances the invited `onboarding_progress` to `SETUP_COMPLETE` — **before commit**, in the same transaction.
- Idempotent: if progress is already `SETUP_COMPLETE`, the advance is a no-op (RC1). Rejection path: on reject, leave invited progress at `JOIN_REQUESTED` and surface rejection (edge #10) — do not complete.
Tests: approve → membership+role+progress all committed atomically; reject → no completion; replay approve → no-op.

---

## RC3 — Invite-token round-trip lifecycle, fully specified (supersedes revB RB6)

`additionalData` is **callback-scoped only** — it cannot itself survive until `/onboarding/join`. So:
- New table `onboarding_invite_handoffs`: `{ nonce (pk, opaque random), inviteTokenHash, boundUserId (nullable until callback), boundEmail, createdAt, expiresAt, consumedAt (nullable) }`.
- **Before Google:** on `/invite/:token`, server stores `{ nonce, inviteTokenHash=sha256(token), expiresAt=now+15m }` and passes `nonce` into the OAuth start via better-auth `additionalData` (opaque; no token in URL). Optionally also set an HttpOnly `SameSite=Lax` cookie carrying the nonce as a fallback.
- **OAuth callback hook:** read `nonce` from `additionalData`, look up the handoff row, and **bind** it: set `boundUserId = authedUser.id` after verifying `authUsers.emailVerified === true` AND the invite's email matches the authed verified email. Reject on mismatch.
- **Consume in the accept transaction:** the accept service resolves the invite from the handoff and performs a single atomic update `UPDATE onboarding_invite_handoffs SET consumed_at=now() WHERE nonce=? AND bound_user_id = :currentUserId AND bound_user_id IS NOT NULL AND consumed_at IS NULL AND expires_at > now()` — 0 rows ⇒ replay/expired/**not-bound-to-this-user** ⇒ reject. The `bound_user_id = :currentUserId` predicate (plus the verified-email match set at binding) prevents one authenticated user from consuming another user's handoff. Clear the cookie.
- Never place the token in a URL, query string, or `sessionStorage`. CSRF/Origin validated on the accept POST.
Tests: happy path `/invite/:token → Google → bound → accept → consumed`; replay (consumed) rejected; expired rejected; email-mismatch rejected; missing nonce → treated as no-invite (founder path).

---

## RC4 — Tightening notes (fold into the matching tasks)

- **RB3 (first-admin hook):** gate `databaseHooks.user.create.after` promotion to a **Google** account specifically — verify a Google `authAccounts.providerId` for the new user (or gate to the OAuth callback), so a non-Google creation path can't be promoted. Keep the advisory lock inside the service's own transaction.
- **RB7 / §1.4 (verified email):** the current session result does **not** expose `emailVerified`. The journey endpoint + callback binding must read `authUsers.emailVerified` directly. Only verified emails participate in email-snapshot invite matching.
- **§1.5 (Stage B resolver):** Stage B's existing `resolveNextStep` and its tests must be **replaced** to honor `order` + `shouldInclude` (not merely appended).
- **RB4 (identity ordering + cleanup):** `actorMiddleware` order must stay **session → run-id fallback → synthetic default** (preserves agent loopback + board sessions). Synthetic cleanup deletes **only** `local-board`'s `instance_admin` role, transactionally, after a real Google admin exists.
- **RB8 (Codex login):** the net-new Codex login needs a **managed, bounded login-challenge process** (no equivalent helper exists today); both Claude and Codex Commander-login routes are **board/company-authorized**.

---

## RC-P2 — Minor items to do with Stage A
- **§1.5 startup guard** also rejects **duplicate `order` values** and `dependsOn` entries referencing states **not available to that journey**.
- **revB §6 numbering:** read "RB4 + R6" as **"RB4 + revA R6"** (the missing-Google-creds startup check) — it collides with RB6's number; no behavior change, just disambiguation.
- **Define precisely:** "real user" = `authUsers.id !== "local-board"`; "real Google admin" = a user holding `instance_admin` who has a Google `authAccounts.providerId` (not merely any non-synthetic auth row).

---

## Status
Everything else in revB is **sound as written** (RB3 hook exists, RB7 columns match, §1.5 doesn't break Stage B, RB4 feasible, RB8 shape correct). With RC1–RC3 closing the contract gaps and RC4 folded, the plan set is execution-ready. Begin with **RB4 + revA R6** (startup/escape-hatch), then RB3, then RB1/RB2/§1.2(RC1)/R13, then RC2/RC3/RB7, then RB8 + edges.
