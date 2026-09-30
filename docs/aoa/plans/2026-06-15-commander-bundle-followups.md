# Commander Page Bundle — Follow-ups Backlog

**Status:** Backlog. Everything deferred during the Commander page bundle (Phases 0 → 3c), captured per the founder's instruction ("everything else we're leaving, put as follow-ups after everything"). Tackle after the current bundle; each is independently planable via the same loop (writing-plans → Codex → subagent build → verify).

**Shipped + verified in the bundle (for context):** Phase 0 chrome · Phase 1 resizable composition + persisted geometry · Phase 2 TaskDetail / task viewer-tab · Phase 3a cockpit shell · Phase 3b cockpit data engine (`/cockpit` + `cockpitScope` + Running/Review/MyTasks/Today/Discussions + interactions) · Phase 3c Approvals card (Core-3: approvals-table + memory + discussion-items, founder-scoped, inline approve/deny).

---

## A. Cockpit — remaining approval families (extend the 3c Approvals card)

The 3c card unifies 3 founder-scoped sources via `cockpitApprovals()` in `server/src/services/cockpit.ts` + the `useCockpitApprovalAction` source-dispatcher. **✅ A1–A4 ALL DONE (2026-06-15)** — plans `2026-06-15-commander-approval-families-plan.md` (A1–A3) + `2026-06-15-commander-approval-scoping-a4-plan.md` (A4); proven live on real PG (incl. the 3-way Deny action; and A4 per-role scoping for founder/lead/member end-to-end).

1. ~~**Join-requests family**~~ **✅ DONE** — `source:"join_request"`, `accessApi.approveJoinRequest/rejectJoinRequest`, full-page → `/inbox/new`.
2. ~~**Tool-trust / runtime family**~~ **✅ DONE** — `source:"runtime_tool_trust"`, `decisionType:"ternary"` (Always=allow_always / Once=allow_once / Deny=deny via `internalAgentApi.confirmAction`); query filters `status='pending'` + `expires_at > now` + **`userId = scope.userId`** (the confirm route is owner-scoped — verified live: expired + other-user rows excluded). NOTE: scoped to the viewer's own (founder), not founder/team_lead — lead/member is A4.
3. ~~**Memory version/archive queues**~~ **✅ DONE** — `source:"memory_version"` (`memoryApi.approveVersion/rejectVersion`, relatedEntityId=versionId) + `source:"memory_archive"` (`suggestionsApi.accept/dismiss`, relatedEntityId=suggestionId); both reuse the existing `memoryService.listPending` `.versions`/`.archives` (no new query).
4. ~~**Lead/member approvals scoping**~~ **✅ DONE (2026-06-15)** — dropped the `!scope.isFounder → []` short-circuit; each of the 7 sources now scoped to who can ACTION it (show-only-actionable). **founder** → all; **team_lead** → memory + memory_version in their depts (`layer≠identity`, replicating `canApproveMemory` in-memory — no per-item DB call) + own runtime; **team_member** → own runtime only. Governance sources (hire/discussion_item/memory_archive/join_request) stay founder-only (join is an intentional UNDER-SHOW — `joins:approve` grant scoping for delegated leads deferred). Queries are role-conditional (non-founders skip founder-only source queries; runtime always-on owner-scoped). Task 0 added `itemDepartmentId` to `listPending().versions[]`. Two independent reviews (Codex self-contained + code-reading subagent) = 0 blockers; caught+fixed an A4 regression in the positional sequence-mocks (pinned/optin/optin-2 — non-founder runtime select shifted slot [2]). Server suite 682 files/5852 green; **live-verified all 3 roles on real PG** (lead sees only dept-A non-identity memory + own runtime; member only own runtime; founder all). Plan: `2026-06-15-commander-approval-scoping-a4-plan.md`. **Follow-up:** grant-based (`joins:approve`) lead delegation for join_request; dept-lead scoping for discussion_item/memory_archive if their routes ever widen beyond founder.

## B. Cockpit — remaining cards (extend `/cockpit` + `COCKPIT_REGISTRY`)

5. ~~**Pinned card** — NEW table `user_entity_pins` + pin/unpin + the card.~~ **✅ DONE (2026-06-15)** — `user_entity_pins` table + migration (`IF NOT EXISTS`), board-only per-user pins CRUD (write-time uuid+ownership 404), `/cockpit.pinned` polymorphic company-scoped resolution, the 📌 Pinned card (open/unpin, show-only-active), and a one-way Pin button on Review/MyTasks/Today task rows. Plan: `2026-06-15-commander-pinned-card-plan.md`. **Deferred to their own follow-ups:** pin affordances for **artifacts** (from the viewer tab) and **goals** (from goal pages/cards) — schema+resolver+card already support all 3 types, only the pin-*from* control for artifact/goal is pending; and finer per-department RBAC on resolved pins (v1 is company-scoped, "pinned overrides hidden").
6. **Opt-in cards** (off by default; query existing data via `/cockpit`, gated by `useCommanderCockpitPrefs`). **✅ MECHANISM + first 3 DONE (2026-06-15)** — `prefs.enabled` (backward-compatible) + `mountableCards` optional `enabled` + the config popover's "Optional" section; **Goals at risk** (`goals.status='at_risk'`, company-scoped), **Budget pulse** (founder-only v1; limit=`company.budgetMonthlyCents`, spend=`cost_events` UTC-month sum, open incidents), **Done today** (`issues.completedAt` today; founder→company / else→own). Plan: `2026-06-15-commander-opt-in-cards-plan.md`. **✅ +2 more DONE (2026-06-15):** **Proactive findings** (per-user unread `notifications` of `internal_agent_proactive` — type queried as BOTH dot+underscore for the writer/constant mismatch) + **Teammates' activity** (option 2: founder→company / team_lead→their depts via actor `user_roles` / member→none; human actors only — `agent`/`system`/`commander` excluded; self excluded). Plan: `2026-06-15-commander-proactive-teammates-plan.md`. **Still TODO:** **Quick capture** (one-line jot → task/discussion — DEFERRED, founder unsure it's wanted); a "full transparency" toggle for teammates (members see it); done-today **artifacts** + per-dept **lead budget**; and a **pre-existing bug** to reconcile the proactive notification type (writer underscore vs constant dot — flagged as a background task).
7. ~~**"In this conversation" zone**~~ **✅ DONE (2026-06-15)** — a fixed conversation-scoped zone at the TOP of the cockpit (above the company cards), fed by the existing `conversationRefs` (the same deduped list the viewer's "Recent from this conversation" uses); rows open the artifact via the FULL ref (preserves `versionId`); null when empty; the All-clear empty-state accounts for it. Frontend-only (no `/cockpit`/schema change). Plan: `2026-06-15-commander-conversation-zone-plan.md`. **Follow-up:** non-artifact "touched entities" (tasks/goals) once `COMMANDER_OUTPUT_REF_KINDS` widens beyond `["artifact"]`.

## C. Cockpit — UX / platform

8. **Mobile tab-bar** — retrofit the Workspace-style `[Chat] [Detail] [Cockpit]` tab bar (deferred since Phase 1; the cockpit + viewer are desktop-only today). Fold the P1 viewer pill into the tab model; all panels CSS-`hidden` to preserve state (mirror `WorkspaceLayout` `workspace-mobile-tabs`).
9. **"Brief me" header button** — Commander triages the whole cockpit in chat ("2 reviews, 3 approvals, 1 blocked — I'd hit the hire first because…"). Needs a triage tool (see D11-adjacent — its own Commander-tools pass).

## D. Sibling features (own epics, per the architecture spec §1)

10. **Suggestion-engine harden** — generation quality + the Accept→execute flow (`merge_memory` stub at `server/src/services/suggestions.ts:1056`). Once trustworthy, ship the **Suggestions** cockpit card (opt-in).
11. **Google epic** — do-once foundation (per-user OAuth + token storage + multi-human privacy + sync), then 3 surfaces: **Calendar** → Today card; **Drive** → viewer tabs / artifact source; **Gmail** → discussion input + a "needs reply" card.

## E. Tidy-ups (minor)

12. **Dedupe `ACTIONABLE_APPROVAL_STATUSES`** — defined independently in `server/src/services/cockpit.ts` and `server/src/services/sidebar-badges.ts` (they agree today). Export one shared constant to prevent drift.

---

**Note:** the pre-existing cross-tenant `query_artifacts` leak is tracked separately (a background task chip), not part of this bundle.
