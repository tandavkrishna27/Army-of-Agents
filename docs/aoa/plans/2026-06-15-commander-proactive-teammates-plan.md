# Commander Cockpit — Proactive findings + Teammates' activity (opt-in) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add two more read-only opt-in cockpit cards via the batched `/cockpit` endpoint: **Proactive findings** (the Commander's proactive check results, per-user) and **Teammates' activity** (what human teammates did, RBAC-scoped per the founder's decision: **founder → company-wide; team_lead → their departments; member → none**).

**Architecture:** Exact same pattern as the just-shipped opt-in cards (Goals-at-risk / Budget pulse / Done-today). Two new `CockpitData` fields + two resolvers in `cockpitService.get`'s `Promise.all` + two `defaultOn:false` registry entries + the config-popover "Optional" section (already exists). No schema change.
- **Proactive findings:** recent unread + undismissed `notifications` of `type='internal_agent_proactive'` for `scope.userId` (per-user; index `(companyId,userId,readAt)` covers it).
- **Teammates' activity (option 2):** `activity_log`, **human actors only** (exclude agents/system — agents are covered by Running/Review, and this is "teammates" = people), excluding self. `founder` → all human activity company-wide; `team_lead` → activity by users who belong to the lead's departments (`user_roles.projectId ∈ leadDepartmentIds`); `team_member` → `[]` (no card). Dept-scoping is **actor-based** (the teammate's department), since `activity_log` has no dept column.

**Tech Stack:** Express + Drizzle (2 read queries), React (2 cards). No schema/migration.

**Scope (v1):**
- IN: both cards; proactive per-user; teammates option-2 (founder/lead/member) human-actor scoping; activity humanization (reuse `ActivityRow` verb/link logic); fan-out; tests.
- OUT → follow-ups: a company "full transparency" toggle (members see teammates) ; entity-based dept-scoping (we use actor-based); agent activity in this card (intentionally excluded). Quick-capture card (deferred separately).

**Verified anchors (read before editing):**
- Pattern to mirror: `server/src/services/cockpit.ts` (resolvers `cockpitGoalsAtRisk`/`cockpitDoneToday` ~:283/:361, the `Promise.all` ~:455-567 + destructure, the `return {...}` ~:651, imports ~:27-42); `cockpit-scope.ts` (`CockpitScope {userId,role,isFounder,leadDepartmentIds}`, `permissionService.getTeamLeadDepartments`); `packages/shared/src/cockpit.ts` + root export `packages/shared/src/index.ts`; `CommanderCockpitPanel.tsx` (`COCKPIT_REGISTRY` opt-in entries, `EMPTY_DATA`, the popover Optional section); sibling cards `CockpitGoalsAtRiskCard.tsx`/`CockpitDoneTodayCard.tsx`.
- Proactive source: `packages/db/src/schema/notifications.ts` (`type` incl. `'internal_agent_proactive'`, `userId`, `readAt`, `dismissedAt`, `title`, `relatedEntityType`, `relatedEntityId`, `createdAt`; index `(companyId,userId,readAt)`).
- Teammates source: `packages/db/src/schema/activity_log.ts` (`actorType`, `actorId`, `action`, `entityType`, `entityId`, `companyId`, `createdAt` — NO dept column); `packages/db/src/schema/user_roles.ts` (`userId`, `companyId`, `role`, `projectId`); humanizer `ui/src/components/ActivityRow.tsx` (action→verb map + `entityLink(entityType,entityId)` switch). **Verified `actorType` values:** humans = `"user"` AND `"board"`; non-humans = `"agent"`/`"system"`/`"commander"` (e.g. write-tools.ts:134 `"user"`, agent-in-review-guard.test.ts:222 `"board"`). → EXCLUDE the non-human set (don't match a single human value).
- Stub coupling: the sequence-mock stubs in `server/src/__tests__/cockpit-service.test.ts` + `cockpit-approvals.test.ts` (+ `cockpit-pinned.test.ts`) — adding resolvers adds `db.select()` calls in the `Promise.all`; update the sequence rows/counts (same as the first opt-in batch).

---

## Task 1: Shared types + `CockpitData` fan-out

**Files:** `packages/shared/src/cockpit.ts` + `packages/shared/src/index.ts`.

- [ ] Add + export from root:
```ts
export interface CockpitProactiveItem {
  id: string;
  title: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  createdAt: string;          // ISO
}
export interface CockpitTeammatesActivityItem {
  id: string;
  actorId: string;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;          // ISO
}
```
Add to `CockpitData`: `proactiveFindings: CockpitProactiveItem[]`, `teammatesActivity: CockpitTeammatesActivityItem[]`. Export both from `index.ts`.
- [ ] **Fan-out** `proactiveFindings: [], teammatesActivity: []` to every `CockpitData` literal: `EMPTY_DATA` (CommanderCockpitPanel.tsx), `cockpitCards.test.tsx` (mock + all `satisfies CockpitData`), `CommanderCockpitPanel.test.tsx`, `server/src/__tests__/cockpit-route.test.ts` fixture, `cockpit-approvals.test.ts`, + the server return (Task 2). Grep `proactiveFindings` after to confirm none missed. Commit.

---

## Task 2: Backend resolvers

**Files:** `server/src/services/cockpit.ts`; tests `server/src/__tests__/cockpit-optin-2.test.ts`.

- [ ] **Imports:** add `notifications`, `activityLog`, `userRoles` from `@armyofagents/db`; `ne`, `isNull`, `notInArray` from `drizzle-orm` (confirm which already imported); the 2 new shared types.
- [ ] **Proactive (per-user):**
```ts
async function cockpitProactiveFindings(db, companyId, scope): Promise<CockpitProactiveItem[]> {
  const rows = await db.select({ id: notifications.id, title: notifications.title,
      relatedEntityType: notifications.relatedEntityType, relatedEntityId: notifications.relatedEntityId,
      createdAt: notifications.createdAt })
    .from(notifications)
    .where(and(eq(notifications.companyId, companyId), eq(notifications.userId, scope.userId),
      // Codex #1: the WRITER inserts "internal_agent_proactive" (proactive.ts:102) but the
      // constant/schema comment say "internal_agent.proactive" (constants.ts:967). Query BOTH
      // to be robust to the codebase inconsistency.
      inArray(notifications.type, ["internal_agent.proactive", "internal_agent_proactive"]),
      isNull(notifications.readAt), isNull(notifications.dismissedAt)))
    .orderBy(desc(notifications.createdAt)).limit(20);
  return rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
```
- [ ] **Teammates (option 2 — founder/lead/member):**
```ts
// "Teammates" = humans. Verified: activity is logged with actorType "user" AND "board"
// for human actors (+ "agent"/"system"/"commander" for non-humans). EXCLUDE non-humans
// (robust to which human label a route uses) rather than match a single value.
const NON_HUMAN_ACTORS = ["agent", "system", "commander"];
async function cockpitTeammatesActivity(db, companyId, scope): Promise<CockpitTeammatesActivityItem[]> {
  if (!scope.isFounder && scope.leadDepartmentIds.length === 0) return []; // member → no card
  const conds = [eq(activityLog.companyId, companyId), notInArray(activityLog.actorType, NON_HUMAN_ACTORS), ne(activityLog.actorId, scope.userId)];
  if (!scope.isFounder) {
    // team_lead → only actors who belong to one of the lead's departments.
    // Use plain select + JS Set dedup (NOT db.selectDistinct — the cockpit test mocks
    // only stub `select`, and selectDistinct would throw; Codex #2/#5).
    const deptRows = await db.select({ userId: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.companyId, companyId), inArray(userRoles.projectId, scope.leadDepartmentIds)));
    const ids = [...new Set(deptRows.map(u => u.userId))].filter(id => id !== scope.userId);
    if (ids.length === 0) return [];
    conds.push(inArray(activityLog.actorId, ids));
  }
  const rows = await db.select({ id: activityLog.id, actorId: activityLog.actorId, actorType: activityLog.actorType,
      action: activityLog.action, entityType: activityLog.entityType, entityId: activityLog.entityId, createdAt: activityLog.createdAt })
    .from(activityLog).where(and(...conds)).orderBy(desc(activityLog.createdAt)).limit(20);
  return rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
```
  (`userRoles.projectId` may be nullable for company-wide roles — `inArray` over `leadDepartmentIds` naturally excludes null projectId rows. Confirm `leadDepartmentIds` are project/dept ids.)
- [ ] Wire both into the `Promise.all` (append AFTER `doneToday`, in this order: proactive, then teammates) + add `proactiveFindings`/`teammatesActivity` to the `return {...}` + extend the destructure. **Update the existing sequence-mock stubs** (`cockpit-service.test.ts`, `cockpit-approvals.test.ts`, `cockpit-pinned.test.ts`) for the added `db.select()` calls so those suites stay green — proactive adds **1 select**; teammates adds **founder 1 / lead 2 (deptRows + activity) / member 0** selects, appended after the doneToday slot in each existing sequence (Codex #3 — get the ORDER right, not just the count; the cockpit-service founder + lead suites and the cockpit-pinned member suite each need their sequence arrays extended). Plain `db.select` only (no `selectDistinct`), so no new stub method is needed.
- [ ] **Unit tests** (`cockpit-optin-2.test.ts`): proactive → maps shape, filters to the user's unread proactive notifications; teammates → founder gets company-wide human activity excluding self; member gets `[]`; lead gets only dept-member activity (mock the deptUsers select + assert the `inArray(actorId, …)`); agents/system excluded (actorType filter). Commit.

---

## Task 3: Frontend — two cards

**Files:** new `CockpitProactiveFindingsCard.tsx` + `CockpitTeammatesActivityCard.tsx`; modify `CommanderCockpitPanel.tsx` (registry + EMPTY_DATA done in T1); tests.

- [ ] **`CockpitProactiveFindingsCard`** `({ items, onOpenFullPage, onAsk })` — presentational, null when empty, `data-testid="cockpit-card-proactiveFindings"`, `Zap` icon + "Proactive findings" + count; rows: title; click → if `relatedEntityType`+`relatedEntityId` `onOpenFullPage('/inbox')` (or the entity), else `onAsk(item.title)`. Mirror `CockpitGoalsAtRiskCard` chrome.
- [ ] **`CockpitTeammatesActivityCard`** `({ items, onOpenFullPage })` — presentational, null when empty, `data-testid="cockpit-card-teammatesActivity"`, `Users` icon + "Teammates' activity" + count; rows: humanized `action` verb + entity type + relative time; click → `onOpenFullPage(entityLink(entityType, entityId))` when the link is non-null. **Reuse `ActivityRow`'s verb map + `entityLink`** — extract them to a shared helper (e.g. `ui/src/lib/activityFormat.ts`) imported by BOTH `ActivityRow.tsx` and this card (DRY — don't copy the maps). Use the existing relative-time util.
- [ ] **Registry:** add 2 `defaultOn:false` entries (`isActive: d.proactiveFindings.length>0` / `d.teammatesActivity.length>0`) + the imports.
- [ ] `cd ui ; pnpm tsc -b` clean. Commit.

---

## Task 4: Tests + verification

- [ ] **Component tests** (`cockpitProactiveTeammates.test.tsx`): each card render/null-empty; proactive click → onOpenFullPage/onAsk; teammates click → onOpenFullPage(entityLink); humanizer maps a known action; the extracted `activityFormat` helper has a unit test (verb + link). Update `ActivityRow.tsx` to import the shared helper (and confirm its existing tests still pass).
- [ ] **Static + unit:** `(cd server && pnpm vitest run cockpit && pnpm typecheck)`; `(cd ui && pnpm vitest run src/components/commander/ && pnpm tsc -b)`; `pnpm --filter @armyofagents/shared typecheck`.
- [ ] **Live (reuse running Docker DB + app / "Pinned Demo Co", local-board = founder):** seed via psql — a `notifications` row (`type='internal_agent_proactive'`, `user_id='local-board'`, unread) + an `activity_log` row (`actor_type='user'`, `actor_id='someone-else'`, a real action like `issue.created`). `GET /cockpit` → assert `proactiveFindings` has the notification, `teammatesActivity` has the other-user row (and NOT local-board's own). In the browser: enable both cards in the Optional popover section → they render; screenshot. (Founder path is what local-board exercises; lead/member dept-scoping is unit-covered.)
- [ ] **Clean tree; do NOT finish the branch.**

---

## Self-review + Codex review (both applied)

**Codex review — 6 findings, all applied:**
1. BLOCKER — proactive type: query BOTH `"internal_agent.proactive"` and `"internal_agent_proactive"` (writer uses underscore, constant uses dot — codebase inconsistency).
2/5. teammates dept-members use plain `db.select` + JS `Set` dedup (NOT `selectDistinct`, which the test mocks don't stub); imports = `ne`/`isNull`/`notInArray` only.
3. sequence-mock stubs (`cockpit-service`/`cockpit-approvals`/`cockpit-pinned`) extended with the new selects appended after `doneToday` (proactive +1; teammates founder +1 / lead +2 / member +0) — order matters.
4. the panel is `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx` (the `cockpit/` subdir) — all EMPTY_DATA/registry edits land there.
Plus my own pre-checks: human `actorType` = `"user"` AND `"board"` (exclude `agent`/`system`/`commander`); proactive notifications DO carry per-user `userId`.

- **Decision honored:** Teammates' activity implements **option 2** (founder=company / lead=dept via actor's `user_roles` / member=none) — NOT the investigation's company-wide fallback. Dept-scoping is actor-based (the only cheap path; `activity_log` has no dept column).
- **"Teammates" = humans:** filter `actorType` to the human value (BUILD-VERIFY) — agents/system excluded (agents already surfaced by Running/Review; also avoids the "agent has no dept" hole). This may make the card empty on agent-heavy companies — fine (opt-in + show-only-active).
- **Proactive = per-user:** `notifications.userId = scope.userId`, unread + undismissed; never cross-user.
- **RBAC:** member gets `[]` for teammates (server-side, before query); lead scoped to their dept members; founder company-wide. No cross-tenant (every query `eq(companyId)`).
- **DRY:** the activity verb-map + `entityLink` are EXTRACTED to a shared `activityFormat.ts` used by both `ActivityRow` and the new card — no duplicated maps.
- **Fan-out + stubs:** both new `CockpitData` fields added to every literal; the sequence-mock stubs updated for the new selects (same discipline as the first opt-in batch — Codex flagged this last time).
- **Bug-watch:** confirm the `actorType` human value; `userRoles.projectId` nullable handled by `inArray`; `createdAt` → ISO string in the resolver (shared type is `string`); lead with no dept members → `[]` (guarded).
