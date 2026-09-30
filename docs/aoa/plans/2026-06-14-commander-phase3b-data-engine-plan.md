# Commander Phase 3b — Cockpit Data Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Populate the cockpit with real, RBAC-scoped, live data via ONE batched `GET /companies/:cid/cockpit` endpoint + a `cockpitScope(actor)` multi-human helper, with the default cards (▶ Running · ✅ Review · 🗂 My tasks · 📅 Today · 💬 Discussions) and row interactions (open task as a viewer tab, **Ask ↩**, open-full-page). **Approvals card deferred to its own slice.**

**Architecture:** Mirror `sidebar-badges` (route factory + `service(db)` + `Promise.all` batch, mounted in `app.ts`). The endpoint returns all default-card data in one response, each card's query scoped server-side by the requester's role via `cockpitScope` (founder = company-wide; team_lead = their departments; team_member = own work). The **card model is refactored from 3a's self-fetch to shared batched data**: the panel runs one `useCockpit()` query and passes each card its data slice + interaction callbacks (the 3a Running card folds into `/cockpit.running`). Live updates: `LiveUpdatesProvider` invalidates the cockpit query on the relevant `LiveEvent`s. Interactions reuse Phase 2's `viewer.openTask`, the composer's `sendText` (Ask ↩), and the router (open-full-page for discussions).

**Tech Stack:** Express 5 + Drizzle (read-only queries; NO schema change — all data exists). React + react-query. `cockpitScope` security is unit-tested (multi-human can't be exercised in the local_trusted e2e harness, which is single founder-actor).

**Scope (locked with founder): ENGINE + INTERACTIONS; Approvals deferred.**
- IN: `/cockpit` endpoint + `cockpitScope` + 5 cards (Running/Review/MyTasks/Today/Discussions) populated/scoped/live + interactions (openTask, Ask↩, navigate). Card-model refactor to shared data.
- OUT: the 6-source Approvals card (own slice); `user_entity_pins` + opt-in cards + "In this conversation" zone (3c/3d); inline approve/deny forms (ride with Approvals); mobile tab-bar. **No DB schema change.**

**Verified anchors (read before editing):**
- Scaffold template: `server/src/routes/sidebar-badges.ts:11-54` + `server/src/services/sidebar-badges.ts:9-71`; mounted at `server/src/app.ts:331` (`api.use(sidebarBadgeRoutes(db))`).
- Authz: `server/src/routes/authz.ts:10-26` `assertCompanyAccess`; `:28-56` `getActorInfo` (`{actorType, actorId,...}`); `req.actor` carries `source` (`local_implicit`) + `isInstanceAdmin`.
- Scope primitives: `server/src/services/permissions.ts:47-53` `getEffectiveRole`, `:58-61` `isFounder`, `:66-71` `getTeamLeadDepartments`. Owner-bypass: `server/src/routes/internal-agent.ts:101-134`.
- Queries: `server/src/services/issues.ts` `list(companyId, filters)` (`IssueFilters` `:111-152`: `status` (comma-sep), `assigneeUserId`, `projectId`); `packages/db/src/schema/issues.ts:40-41,65` (`assigneeUserId`, `status`, `dueDate`, `projectId`). Terminal statuses: `done`,`cancelled`. `internal_agent_reminders` schema `packages/db/src/schema/internal_agent.ts:316-352` (`userId`,`triggerAt`,`status`). Discussions pending query `server/src/services/sidebar-badges.ts:45-58`; schema `packages/db/src/schema/discussions.ts:45-131,148-242` (`pendingItemCount`, `extractionStatus`, `proposalStatus`, `ownerUserId`). Due-today pattern `server/src/services/home.ts:90-114`. Live-runs reuse: `server/src/routes/agents-live-runs.ts:178-202` `liveRunsForCompany(db, companyId)`.
- Server test pattern: `server/src/__tests__/issues-list-source-discussion-filter.test.ts:1-100` (vi.hoisted + vi.mock services + supertest + injected `req.actor`).
- Frontend: `ui/src/components/InternalAgentPanel.tsx` — `sendText` (~:555-628), `viewer` (with `openTask` from Phase 2), the cockpit Panel render (Phase 3a, ~:1461-1482). `ui/src/context/LiveUpdatesProvider.tsx` `handleLiveEvent` (routes by `event.type`, invalidates queries). `ui/src/lib/queryKeys.ts` (add `cockpit`). `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx` + `cockpitCardModel.ts` + `CockpitRunningCard.tsx` (3a — refactored here). Router: `ui/src/lib/router` `useNavigate`; discussion route (grep `/discussions/` or `/threads/`).
- Shared types live in `packages/shared/src/`; `LIVE_EVENT_TYPES` in `packages/shared/src/constants.ts:269-327`.

---

## Task 1: Shared cockpit types

**Files:** Create `packages/shared/src/cockpit.ts`; export from `packages/shared/src/index.ts`.

- [ ] **Step 1:** Define the response contract (one batched payload). Keep item shapes minimal (what the cards render).
```ts
// packages/shared/src/cockpit.ts
export interface CockpitTaskItem {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  dueDate: string | null;
}
export interface CockpitRunItem {
  id: string;
  agentName: string | null;
  status: string;
  startedAt: string | null;
  issueId: string | null;
}
export interface CockpitReminderItem { id: string; content: string; triggerAt: string; }
export interface CockpitDiscussionItem {
  id: string;
  title: string | null;
  pendingItemCount: number;
  reason: "pending_items" | "extraction_failed";
}
export interface CockpitData {
  running: CockpitRunItem[];
  review: CockpitTaskItem[];
  myTasks: CockpitTaskItem[];
  today: { reminders: CockpitReminderItem[]; dueTasks: CockpitTaskItem[] };
  discussions: CockpitDiscussionItem[];
}
```
- [ ] **Step 2:** Re-export from `packages/shared/src/index.ts`. `pnpm --filter @armyofagents/shared build` (or the repo's shared build) clean. Commit:
```bash
git add packages/shared/src/cockpit.ts packages/shared/src/index.ts
git commit -m "feat(shared): CockpitData types (Phase 3b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `cockpitScope` helper (TDD — the security-critical pure logic)

**Files:** Create `server/src/services/cockpit-scope.ts` + `server/src/__tests__/cockpit-scope.test.ts`.

- [ ] **Step 1: Failing test** for the PURE scoping decisions (no db). The helper resolves an actor to a scope, then exposes per-card predicates.
```ts
import { describe, it, expect } from "vitest";
import { resolveCockpitScope, type CockpitScope } from "../services/cockpit-scope";

const founder: CockpitScope = { userId: "u1", isFounder: true, leadDepartmentIds: [] };
const lead: CockpitScope = { userId: "u2", isFounder: false, leadDepartmentIds: ["dep-a"] };
const member: CockpitScope = { userId: "u3", isFounder: false, leadDepartmentIds: [] };

describe("cockpitScope review filter", () => {
  it("founder → no department/assignee restriction", () => {
    expect(reviewFilterFor(founder)).toEqual({}); // all in_review
  });
  it("lead → restricted to their departments", () => {
    expect(reviewFilterFor(lead)).toEqual({ projectIds: ["dep-a"] });
  });
  it("member → restricted to their own assigned reviews", () => {
    expect(reviewFilterFor(member)).toEqual({ assigneeUserId: "u3" });
  });
});
```
(Define `reviewFilterFor` in the module — a pure function returning a filter descriptor the service translates to a query. My-tasks + Today self-scope; Discussions uses `threadService.list` canonical visibility, so no discussions filter fn here.)

- [ ] **Step 2: Implement.**
```ts
// server/src/services/cockpit-scope.ts
import type { Db } from "@armyofagents/db";
import { permissionService } from "./permissions";

export interface CockpitScope {
  userId: string;
  role: "founder" | "team_lead" | "team_member";
  isFounder: boolean;
  leadDepartmentIds: string[];
}
export interface ActorLike { actorId: string; source?: string; isInstanceAdmin?: boolean; }

/** Resolve the requester to a cockpit scope. Owner-bypass: local_implicit / instance-admin
 *  are treated as founder (mirrors internal-agent.ts:101-134). Carries `role` so the
 *  Discussions query can build the threadService Actor (canonical visibility). */
export async function resolveCockpitScope(db: Db, companyId: string, actor: ActorLike): Promise<CockpitScope> {
  const bypass = actor.source === "local_implicit" || actor.isInstanceAdmin === true;
  const perm = permissionService(db);
  const role = bypass ? "founder" : await perm.getEffectiveRole(companyId, actor.actorId);
  const isFounder = role === "founder";
  const leadDepartmentIds = isFounder ? [] : await perm.getTeamLeadDepartments(companyId, actor.actorId);
  return { userId: actor.actorId, role, isFounder, leadDepartmentIds };
}

export type ReviewFilter = {} | { projectIds: string[] } | { assigneeUserId: string };
/** Review = agent work awaiting a human's verdict. founder→all; lead→their departments;
 *  member→their own assigned in-review items. */
export function reviewFilterFor(s: CockpitScope): ReviewFilter {
  if (s.isFounder) return {};
  if (s.leadDepartmentIds.length > 0) return { projectIds: s.leadDepartmentIds };
  return { assigneeUserId: s.userId };
}
// NOTE: Discussions scoping is NOT hand-rolled here — it uses the canonical thread
// visibility via threadService.list (Codex #3). cockpitScope only carries role/userId so
// the Discussions query can build the threadService Actor. My-tasks + Today self-scope.
```
- [ ] **Step 3: Run → PASS. Commit.**
```bash
git add server/src/services/cockpit-scope.ts server/src/__tests__/cockpit-scope.test.ts
git commit -m "feat(cockpit): cockpitScope multi-human scoping helper (Phase 3b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `cockpitService` — batched, scoped queries

**Files:** Create `server/src/services/cockpit.ts` + `server/src/__tests__/cockpit-service.test.ts`.

- [ ] **Step 1:** `cockpitService(db).get(companyId, actor): Promise<CockpitData>`. Resolve scope once, then `Promise.all` the 5 queries (mirror `sidebar-badges`/`home` batching). Each query applies its scope:
  - **running:** `liveRunsForCompany(db, companyId)` → map to `CockpitRunItem[]`, filter `status ∈ {running,queued}`. (Company-wide live runs; scoping for crew is a 3c refinement — note it.)
  - **review:** `issueService(db).list(companyId, { status: "in_review", taskScope: "all", ...translate(reviewFilterFor(scope)) })`. **`taskScope: "all"` is REQUIRED** (Codex #2 — `list` defaults to org-scope, which hides crew-assigned tasks via `notCrewAssigned`; Review IS agent work, so crew-assigned `in_review` tasks must be included). Translate the filter: `{}`→nothing extra; `{assigneeUserId}`→that filter; `{projectIds}`→ `list` takes only ONE `projectId` (Codex-confirmed `issues.ts:117,648`), so loop per dept + dedupe by issue id (bounded N = dept count).
  - **myTasks:** `list(companyId, { assigneeUserId: scope.userId })` (default org-scope is correct — My tasks = the human's own tasks, excludes agent-delegated per design §13), then drop terminal (`done`,`cancelled`).
  - **today:** reminders (`internal_agent_reminders` where `userId=scope.userId`, `status='pending'`, `triggerAt < tomorrowMidnight`) + dueTasks (issues `assigneeUserId=scope.userId`, `dueDate <= endOfToday`, non-terminal — `home.ts:90-114` pattern).
  - **discussions:** use the CANONICAL thread visibility (Codex #3 — participant access lives in `thread_participants`, not `discussions`). `threadService(db).list(companyId, { userId: scope.userId, role: scope.role })` (confirm the `Actor` shape at `threads.ts:557`) returns only the discussions this actor may see (founder=all; else participant OR dept-role, `threads.ts:557-614`). Then filter to "needs me": `pendingItemCount > 0` OR a `discussion_entries` row with `extractionStatus IN ('pending','failed')` over the visible ids (one batched query, `sidebar-badges:45-58` style). Do NOT hand-roll owner/dept scoping. Map to `CockpitDiscussionItem[]` with `reason`.
- [ ] **Step 2:** Unit-test the service with the mocked-db pattern (`vi.hoisted` + `vi.mock` the sub-services), asserting: scope is resolved; each sub-query is called with the scoped filter (e.g. a member's review query passes `assigneeUserId`, a founder's doesn't). This is the security gate — assert a member does NOT get an unrestricted review query.
- [ ] **Step 3: Commit.**

---

## Task 4: `/cockpit` route + mount

**Files:** Create `server/src/routes/cockpit.ts`; modify `server/src/app.ts`; route test `server/src/__tests__/cockpit-route.test.ts`.

- [ ] **Step 1:** Route factory mirroring `sidebar-badges.ts`:
```ts
import { assertBoard, assertCompanyAccess } from "./authz";
import { unauthorized } from "../errors";
// ...
export function cockpitRoutes(db: Db) {
  const router = Router();
  const svc = cockpitService(db);
  router.get("/companies/:companyId/cockpit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // BOARD-ONLY (Codex #1): the cockpit is a person's mission control. assertCompanyAccess
    // alone admits same-company agent/MCP actors; gate them out (mirrors requireBoardUserId
    // in sidebar-preferences.ts:9-16 / inbox-dismissals.ts:9).
    assertBoard(req);
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    res.json(
      await svc.get(companyId, {
        actorId: req.actor.userId,
        source: req.actor.source,
        isInstanceAdmin: req.actor.isInstanceAdmin,
      }),
    );
  });
  return router;
}
```
- [ ] **Step 2:** Mount in `app.ts` near `:331`: `api.use(cockpitRoutes(db));`.
- [ ] **Step 3:** Route test (supertest + mocked `cockpitService`): board actor → 200 + `svc.get` called with the board user id; `assertCompanyAccess` enforced (no-access → 403); **an agent/MCP actor → 401/403 (board-only, Codex #1) and `svc.get` NOT called.** Commit.

---

## Task 5: Frontend — api + hook + queryKey + live invalidation

**Files:** Create `ui/src/api/cockpit.ts`; modify `ui/src/lib/queryKeys.ts`, `ui/src/context/LiveUpdatesProvider.tsx`.

- [ ] **Step 1:** `ui/src/api/cockpit.ts`:
```ts
import { api } from "./client"; // confirm the shared client import
import type { CockpitData } from "@armyofagents/shared";
export const cockpitApi = {
  get: (companyId: string) => api.get<CockpitData>(`/companies/${companyId}/cockpit`),
};
```
Add `cockpit: (companyId: string) => ["cockpit", companyId] as const` to `queryKeys`.
- [ ] **Step 2:** In `LiveUpdatesProvider.handleLiveEvent`, invalidate `queryKeys.cockpit(companyId)` on the cockpit-relevant event types: `issue.status_changed`, `heartbeat.run.status`, `internal_agent.run.status`, `internal_agent.reminder`, `discussion.extraction.completed`, `discussion.extraction.failed`, `discussion.entry.created`. (Add the invalidate alongside the existing ones in each branch, or a single guard listing these types.)
- [ ] **Step 3:** Commit.

---

## Task 6: Card-model refactor to shared data + the 5 cards + interactions

**Files:** Modify `ui/src/components/commander/cockpit/cockpitCardModel.ts`, `CommanderCockpitPanel.tsx`, `CockpitRunningCard.tsx`; create `CockpitReviewCard.tsx`, `CockpitMyTasksCard.tsx`, `CockpitTodayCard.tsx`, `CockpitDiscussionsCard.tsx`; modify `ui/src/components/InternalAgentPanel.tsx` (thread interaction callbacks).

- [ ] **Step 1: Refactor the card model to shared data.** The panel runs ONE `useQuery({ queryKey: queryKeys.cockpit(companyId), queryFn: () => cockpitApi.get(companyId), refetchInterval: 8000 })` — the `refetchInterval` is the crew-run liveness fallback that folding the 3a Running card off its own 5s poll would otherwise lose (Codex #4); LiveEvents invalidation (T5) gives instant updates for covered events. Cards become PRESENTATIONAL: each registry entry gets `isActive(data)` (slice non-empty) + `render({ data, companyId, onOpenTask, onAsk, onOpenFullPage })`. Replace 3a's per-card `onActiveChange` self-report with central `active` derived from `data` (so `selectVisibleCards`/show-only-active is computed from the one payload). Update `CockpitCardDef`:
```ts
export interface CockpitCardDef {
  id: string;
  title: string;
  defaultOn: boolean;
}
// in the registry (panel file): isActive(data) + render(props) per card.
```
- [ ] **Step 2: Rework `CockpitRunningCard`** to take `runs: CockpitRunItem[]` as a prop (no own query); render rows; row click → `onOpenTask(run.issueId, …)` when `issueId` present; Ask↩ per row.
- [ ] **Step 3: New cards** (presentational, ~40 lines each), each with the shared row affordances — a primary click + an **Ask ↩** button:
  - `CockpitReviewCard({ items, onOpenTask, onAsk })` — rows = `CockpitTaskItem`; click → `onOpenTask(item.id, item.title)`; Ask↩ → `onAsk(\`About ${item.identifier ?? item.title} — what changed and should I approve it?\`)`.
  - `CockpitMyTasksCard` — rows grouped by status; click → `onOpenTask`; Ask↩.
  - `CockpitTodayCard` — reminders (display + Ask↩) + dueTasks (click → openTask).
  - `CockpitDiscussionsCard({ items, onOpenFullPage, onAsk })` — rows; click → `onOpenFullPage(\`/${companyPrefix}/discussions/${item.id}\`)` (confirm route); Ask↩. (No discussion viewer-tab kind yet — open full page.)
  Every row uses a consistent `CockpitRow` shell (title + a trailing **Ask ↩** icon-button, `aria-label="Ask Commander about this"`).
- [ ] **Step 4: Thread interactions** from `AgentPanelContent` → `CommanderCockpitPanel` → cards: `onOpenTask = viewer.openTask`; `onAsk = (text) => void sendText(text)`; `onOpenFullPage = (href) => navigate(href)`. Pass `companyPrefix`/`companyId` as needed (grep how the page gets `companyPrefix`).
- [ ] **Step 5:** `cd ui ; pnpm tsc -b` clean. Commit.

---

## Task 7: Tests + full verification

**Files:** Create `ui/src/components/commander/cockpit/cockpitCards.test.tsx`; a throwaway e2e for live verify.

- [ ] **Step 1: Component tests** (mock `cockpitApi.get`): the panel renders each card when its slice has data; show-only-active hides empty slices ("All clear" when all empty); a Review row click calls `onOpenTask(id,title)`; an Ask↩ click calls `onAsk` with a scoped string; a Discussions row click calls `onOpenFullPage`.
- [ ] **Step 2: Backend unit/contract** green: `pnpm --filter @armyofagents/server vitest run` for `cockpit-scope`, `cockpit-service`, `cockpit-route`. `pnpm tsc` across packages.
- [ ] **Step 3: Frontend** green: `cd ui ; pnpm vitest run src/components/commander/` + `pnpm tsc -b`.
- [ ] **Step 4: Live e2e (pgvector)** — seed a company + a task assigned to the board user + a task in `in_review` + a reminder; open `/commander`, expand the cockpit; assert the **Review** + **My tasks** + **Today** cards populate; click a task row → it opens as a **viewer tab** (`commander-viewer-panel` shows the task); click **Ask ↩** → a user message appears in the chat. Run the existing viewer + 3a e2e for regression. Screenshot the populated cockpit. **Note:** multi-human scoping is NOT exercisable in the local_trusted harness (single founder actor) — it's covered by the Task 2/3 unit tests; record that explicitly.
- [ ] **Step 5:** Tear down; clean tree; do NOT finish the branch (3c/3d remain).

---

## Self-review (run after drafting; fix inline)

- **Spec coverage (§5/§6):** batched `/cockpit` ✅ (T3/T4); `cockpitScope` multi-human ✅ (T2, founder/lead/member); default cards Review/MyTasks/Today/Discussions + Running ✅ (T3/T6); LiveEvents→refresh ✅ (T5); interactions openTask/Ask↩/navigate ✅ (T6); Approvals deferred ✅; one batched call (Running folded in) ✅.
- **Security:** the route is **board-only** (`assertBoard` — agents/MCP can't read a person's cockpit, Codex #1); scoping is server-side + unit-tested (T2 pure + T3 asserts a member's review query carries `assigneeUserId`, a founder's doesn't); Discussions uses the canonical `threadService` visibility — no hand-rolled scoping (Codex #3); Review passes `taskScope:"all"` so crew agent work in review shows (Codex #2). Owner-bypass mirrors internal-agent. No new auth surface — composes existing `permissionService`/`threadService`. Multi-human not e2e-able in the local_trusted harness → unit-tested + noted.
- **No schema change** — all reads against existing tables. No `user_entity_pins`/prefs-table (those are 3a localStorage / 3c).
- **Card-model refactor risk:** 3a's self-fetch cards → shared-data presentational cards; the Running card moves off `/live-runs` onto `/cockpit.running`. The 3a panel/rail/collapse/responsive-cap + the localStorage prefs are PRESERVED — only the data-source + render-signature change. The 3a `CommanderCockpitPanel.test` must be updated to the new shared-data shape (note in T7).
- **Type consistency:** `CockpitData` (T1) is the contract used by the service (T3 return), the api (T5), and the cards (T6); `CockpitScope` (T2) used by the service (T3); `queryKeys.cockpit` (T5) used by the panel query (T6) + the live invalidation (T5).
- **Live:** invalidation on the listed event types (T5) for instant updates **+ a modest `refetchInterval` (~8s)** as the crew-run liveness fallback (Codex #4 — `internal_agent.run.status` isn't a covered invalidation; this replaces the 3a Running card's own 5s poll that folding removes).
- **Bug-watch:** the multi-query Review union for leads (loop per dept → dedupe by issue id); "today" timezone (reuse `home.ts` end-of-day pattern); don't return data for cards the user hid (acceptable for 3b — bounded set; optimize later); the discussions route path (confirm `/discussions/:id` vs `/threads/:id`).
