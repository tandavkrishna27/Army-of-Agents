# Commander Cockpit — Pinned Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a user **pin** tasks (v1 pin source) and see them — plus any pinned artifacts/goals — in a cockpit **📌 Pinned** card with live status, backed by a new `user_entity_pins` table. **First schema change in the bundle.**

**Architecture:** Mirror `inbox_dismissals` for the per-user table + service + board-only CRUD routes. Extend `/cockpit` with a `pinned: CockpitPinnedItem[]` array resolved by batched, **company-scoped** id-set queries against issues/artifacts/goals (the `getById`s don't self-scope). Frontend: a `useCockpitPin(companyId)` hook (pin/unpin + toast + cockpit invalidation, mirroring `useCockpitApprovalAction`); a `CockpitPinnedCard` (open per type + unpin); and a 📌 pin button on the existing task rows (Review/MyTasks/Today). Pinned is `defaultOn: true` + `isActive: pinned.length>0`, so show-only-active keeps it hidden until you pin something.

**Tech Stack:** Drizzle (NEW table + `pnpm db:generate` migration — **never hand-write SQL**), Express, React + react-query.

**Scope (v1):**
- IN: `user_entity_pins` table + migration; pins CRUD (board-only, per-user); `/cockpit.pinned` resolution for all 3 entity types (company-scoped); the Pinned card (open task→tab, artifact→viewer tab, goal→full page; unpin); **pin affordance on cockpit TASK rows** (Review/MyTasks/Today).
- OUT → follow-ups: pin affordances for **artifacts** (from the viewer tab) and **goals** (from goal pages/cards) — the schema+resolver+card already support them, only the pin-FROM control is deferred; finer per-department RBAC on resolved pins (v1 is company-scoped — you pinned it deliberately within your company).

**Verified anchors (read before editing):**
- Schema template: `packages/db/src/schema/inbox_dismissals.ts:1-26`; register in `packages/db/src/schema/index.ts:21`. Migrations: `packages/db/src/migrations/` (format `NNNN_name.sql` + `meta/`); generate via `pnpm db:generate` (self-compiles, see Task 1 Step 3a). **Generated SQL must get `IF NOT EXISTS` added** (Task 1 Step 3b; enforced by `migration-idempotency.test.ts`). Application paths (Codex #7): a non-embedded DB applies pending migrations only when `AOA_MIGRATION_AUTO_APPLY=true` (`server/src/index.ts:140`); a fresh **embedded** DB auto-applies on first-run regardless (`server/src/index.ts:429,433` `autoApply:true`) — the Playwright e2e harness does NOT set the flag (`tests/e2e/playwright.config.ts:78`); it relies on that embedded first-run path. `drizzle.config.ts` reads `./dist/schema/*.js`.
- Service/route template: `server/src/services/inbox-dismissals.ts:26-88` (list/dismiss/undismiss + `onConflictDoUpdate`) + `server/src/routes/inbox-dismissals.ts:9-55` (`requireBoardUserId` + `assertCompanyAccess`, GET/POST/DELETE). Mount near other routers in `server/src/app.ts`.
- Entity rows (resolve by id-set, scope by companyId): `issues` (`id, identifier, title, status, companyId`), `artifacts` (`id, title, status, type, companyId`), `goals` (`id, title, status, companyId`). (Don't use the per-item `getById`s — batch with `inArray` + `eq(companyId)`.)
- Cockpit engine: `server/src/services/cockpit.ts` (the `Promise.all` + `scope.userId`/`companyId`); `packages/shared/src/cockpit.ts` + root export `packages/shared/src/index.ts`; `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx` (`CockpitInteractions` ~:26, `COCKPIT_REGISTRY`, render props now include `companyId`); task-row card pattern `CockpitReviewCard.tsx:26-59`; the viewer `useCommanderViewer` (`openTask(id,title)`, `openRef(ref: CommanderOutputRef)`); `ui/src/api` client pattern + `queryKeys`.

---

## Task 1: `user_entity_pins` schema + migration

**Files:** Create `packages/db/src/schema/user_entity_pins.ts`; modify `packages/db/src/schema/index.ts`; generate a migration.

- [ ] **Step 1: Schema** (mirror inbox_dismissals):
```ts
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export const userEntityPins = pgTable(
  "user_entity_pins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(), // "task" | "artifact" | "goal"
    entityId: uuid("entity_id").notNull(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyIdx: index("user_entity_pins_user_company_idx").on(table.userId, table.companyId),
    uniq: uniqueIndex("user_entity_pins_user_company_entity_uq").on(
      table.userId, table.companyId, table.entityType, table.entityId,
    ),
  }),
);
```
- [ ] **Step 2: Register** — add `export { userEntityPins } from "./user_entity_pins.js";` to `packages/db/src/schema/index.ts`.
- [ ] **Step 3a: Generate the migration** — run `pnpm db:generate` (verified: the `@armyofagents/db` `generate` script is `tsc -p tsconfig.json && drizzle-kit generate`, so it **self-compiles** `dist/schema/*.js` first — NO separate build step needed). Confirm drizzle-kit created a new `packages/db/src/migrations/NNNN_*.sql` containing `CREATE TABLE "user_entity_pins"` AND updated `migrations/meta/_journal.json` + a new `meta/NNNN_snapshot.json`.
- [ ] **Step 3b: Add `IF NOT EXISTS` (REQUIRED repo convention — Codex BLOCKER).** drizzle-kit emits bare `CREATE TABLE`/`CREATE INDEX`/`CREATE UNIQUE INDEX` (no `IF NOT EXISTS`), but `packages/db/src/__tests__/migration-idempotency.test.ts` **gates every new migration** on it (an unguarded re-applied CREATE throws 42P07 and permanently wedges the DB — see the test's C14/PR#121 note). Hand-edit ONLY the generated `NNNN_*.sql` to insert `IF NOT EXISTS` after each `CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX` (pattern: `CREATE TABLE IF NOT EXISTS "user_entity_pins" (...)`, `CREATE INDEX IF NOT EXISTS "user_entity_pins_user_company_idx" ...`, `CREATE UNIQUE INDEX IF NOT EXISTS "user_entity_pins_user_company_entity_uq" ...` — exactly as `migrations/0035_living_zzzax.sql` does). This is NOT "writing a raw migration" (CLAUDE.md rule); it's the mandatory post-`generate` idempotency tweak the whole repo follows. Do not touch the column DDL otherwise. Do NOT add to the test's `GRANDFATHERED_MIGRATIONS` allowlist.
- [ ] **Step 3c: Verify + commit.** Run `pnpm --filter @armyofagents/db vitest run migration-idempotency` → PASS. Commit schema + index + the whole `migrations/` dir (sql + meta) together — `git add packages/db/src/migrations/` captures the journal + snapshot too.
```bash
git add packages/db/src/schema/user_entity_pins.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): user_entity_pins table + migration (Pinned card)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Shared `CockpitPinnedItem` type

**Files:** Modify `packages/shared/src/cockpit.ts` (interface ~:52) + `packages/shared/src/index.ts`.

- [ ] Add + export from root:
```ts
export type CockpitPinnedEntityType = "task" | "artifact" | "goal";
export interface CockpitPinnedItem {
  entityType: CockpitPinnedEntityType;
  entityId: string;
  title: string;
  status: string;        // task/goal status, or artifact status
  identifier?: string | null; // task identifier (e.g. TEAM-12)
}
```
Add `pinned: CockpitPinnedItem[]` to `CockpitData`. Export both new symbols from `index.ts`.
- [ ] **⚠ Required-field fan-out (Codex #4 — do ALL of these or typecheck/tests fail; same pattern as 3c's `approvals: []`):** because `pinned` is non-optional on `CockpitData`, add `pinned: []` to every `CockpitData`-typed literal:
  - `EMPTY_DATA` in `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx:36`
  - the `cockpitService.get()` returned object in `server/src/services/cockpit.ts` (~:407, the final `return {...}`) — wired in Task 4
  - test fixtures: the `cockpitApi.get` mock + every `satisfies CockpitData` literal in `ui/src/components/commander/cockpit/cockpitCards.test.tsx` (≈6 sites) and any `CockpitData` shape in `server/src/__tests__/cockpit-approvals.test.ts` — covered in Task 6.
- [ ] Shared typecheck clean. Commit.

---

## Task 3: pins service + board-only CRUD routes

**Files:** Create `server/src/services/user-entity-pins.ts` + `server/src/routes/user-entity-pins.ts`; mount in `app.ts`; validator in `packages/shared`; tests.

- [ ] **Step 1: Shared validator** — in `packages/shared` add `createUserEntityPinSchema = z.object({ entityType: z.enum(["task","artifact","goal"]), entityId: z.string().uuid() })` (Codex #3: `entity_id` is a uuid column + all three target ids are uuid, so reject non-uuids at the edge). Export it.
- [ ] **Step 2: Service** (mirror inbox-dismissals): `list(userId, companyId)`; `pin(userId, companyId, entityType, entityId)` (insert `onConflictDoNothing` on the unique index, returning the row); `unpin(userId, companyId, entityType, entityId)` (delete). **Add `entityExistsInCompany(companyId, entityType, entityId)`** — a single `eq(id, entityId) AND eq(companyId, companyId)` existence check against the matching table (issues/artifacts/goals); the POST route calls it before inserting (Codex #3: prevents storing junk pins for arbitrary/foreign uuids).
- [ ] **Step 3: Routes** (mirror inbox-dismissals — `requireBoardUserId` + `assertCompanyAccess` + `validate(createUserEntityPinSchema)`): `GET /companies/:cid/pins`; `POST /companies/:cid/pins` (`{entityType, entityId}`) → if `!entityExistsInCompany(...)` return `404`, else pin → `201`; `DELETE /companies/:cid/pins/:entityType/:entityId`. Mount `userEntityPinRoutes(db)` in `app.ts`. **No `logActivity` (DECIDED, Codex #6 declined):** pins are a personal per-user UI toggle — the exact analog `server/src/routes/inbox-dismissals.ts` does NOT log activity; logging every pin/unpin would spam the shared activity feed with no audit value (unlike goals, which are shared-entity mutations). Deliberate, evidence-backed divergence from the goals pattern.
- [ ] **Step 4: Route test** (supertest + mocked service): board → 200/201/204 + service called with the board userId; non-board → 401/403 + not called; invalid entityType OR non-uuid entityId → 400; POST for a non-existent/foreign entity → 404 (mock `entityExistsInCompany`→false) + pin NOT called.
- [ ] **Step 5: Commit.**

---

## Task 4: `/cockpit` pinned resolution (company-scoped, batched)

**Files:** Modify `server/src/services/cockpit.ts`; test `server/src/__tests__/cockpit-pinned.test.ts`.

- [ ] **Step 1:** Add `cockpitPinned(db, companyId, scope)`:
```ts
async function cockpitPinned(db, companyId, scope): Promise<CockpitPinnedItem[]> {
  const pins = await db.select({ entityType: userEntityPins.entityType, entityId: userEntityPins.entityId, pinnedAt: userEntityPins.pinnedAt })
    .from(userEntityPins)
    .where(and(eq(userEntityPins.userId, scope.userId), eq(userEntityPins.companyId, companyId)))
    .orderBy(desc(userEntityPins.pinnedAt));
  if (pins.length === 0) return [];
  const taskIds = pins.filter(p => p.entityType === "task").map(p => p.entityId);
  const artifactIds = pins.filter(p => p.entityType === "artifact").map(p => p.entityId);
  const goalIds = pins.filter(p => p.entityType === "goal").map(p => p.entityId);
  // Company-scoped id-set lookups (the getById's don't scope; we MUST add eq(companyId)).
  const [tasks, arts, gls] = await Promise.all([
    taskIds.length ? db.select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
      .from(issues).where(and(inArray(issues.id, taskIds), eq(issues.companyId, companyId))) : [],
    artifactIds.length ? db.select({ id: artifacts.id, title: artifacts.title, status: artifacts.status })
      .from(artifacts).where(and(inArray(artifacts.id, artifactIds), eq(artifacts.companyId, companyId))) : [],
    goalIds.length ? db.select({ id: goals.id, title: goals.title, status: goals.status })
      .from(goals).where(and(inArray(goals.id, goalIds), eq(goals.companyId, companyId))) : [],
  ]);
  // Key by `${entityType}:${id}` — pins are polymorphic; a bare-id map could
  // mis-resolve a cross-table uuid collision (Codex #2).
  const byKey = new Map<string, CockpitPinnedItem>();
  for (const t of tasks) byKey.set(`task:${t.id}`, { entityType: "task", entityId: t.id, title: t.title, status: t.status, identifier: t.identifier });
  for (const a of arts) byKey.set(`artifact:${a.id}`, { entityType: "artifact", entityId: a.id, title: a.title, status: a.status });
  for (const g of gls) byKey.set(`goal:${g.id}`, { entityType: "goal", entityId: g.id, title: g.title, status: g.status });
  // Preserve pin order (pinnedAt desc); drop pins whose entity no longer resolves (deleted / out-of-company).
  return pins.map(p => byKey.get(`${p.entityType}:${p.entityId}`)).filter((x): x is CockpitPinnedItem => !!x);
}
```
Wire `cockpitPinned(db, companyId, scope)` into `cockpitService.get`'s `Promise.all` and add `pinned` to the final `return {...}` (~cockpit.ts:407) — this is one of the Task 2 fan-out sites; without it the `CockpitData` return is a type error.
- [ ] **Step 2:** Unit-test (`cockpit-pinned.test.ts`, sequence-mock db like `cockpit-approvals.test.ts`): pins resolve to the right shape per type; company filter drops out-of-company ids; deleted/unresolved entity is dropped (not in `byKey`); polymorphic key prevents cross-type mis-resolution; order preserved (pinnedAt desc). Also update any existing cockpit service test asserting the full return shape for the new `pinned` field. Commit.

---

## Task 5: Frontend — pins api/hook + Pinned card + pin button on task rows

**Files:** Create `ui/src/api/pins.ts`, `ui/src/components/commander/cockpit/useCockpitPin.ts`, `ui/src/components/commander/cockpit/CockpitPinnedCard.tsx`; modify `ui/src/lib/queryKeys.ts`, `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx` (registry + `CockpitInteractions` + panel-owned hook), the task cards (`CockpitReviewCard`/`CockpitMyTasksCard`/`CockpitTodayCard`), and **`ui/src/components/InternalAgentPanel.tsx`** (verified owner — the `<CommanderCockpitPanel>` render site at ~:1487 passing `onOpenTask`/`onAsk`/`onOpenFullPage`; thread `onOpenArtifact` there. NOTE: the panel is at `components/InternalAgentPanel.tsx`, NOT `components/commander/`.)

- [ ] **Step 1:** `pins.ts` — `pinsApi.pin(companyId, entityType, entityId)` (POST), `unpin(companyId, entityType, entityId)` (DELETE). Add `queryKeys.cockpit` is reused (invalidate it).
- [ ] **Step 2:** `useCockpitPin(companyId)` (mirror `useCockpitApprovalAction`): `pin`/`unpin` mutations → toast + invalidate `queryKeys.cockpit(companyId)`.
- [ ] **Step 3:** `CockpitPinnedCard({ items, onOpenTask, onOpenArtifact, onOpenFullPage, onUnpin })` (presentational — callbacks only, no hook) — rows show title + a type chip (task/artifact/goal) + status; click opens per type (task→`onOpenTask(id, title)`; artifact→`onOpenArtifact(id, title)`; goal→`onOpenFullPage('/goals/'+id)`); a hover-revealed **Unpin** button → `onUnpin?.(item.entityType, item.entityId)`. `data-testid="cockpit-card-pinned"`; returns null when `items` empty.
- [ ] **Step 4 (wiring — DECIDED):** Leaf cards stay **presentational** (callbacks only). Verified: the render bag passes `companyId` to `render()` (CommanderCockpitPanel.tsx:55,249) but the leaf task cards (Review/MyTasks/Today) receive only `items`/`onOpenTask`/`onAsk` — they do NOT get `companyId`. So the hook lives at the **panel**, not the leaves (one hook instance; callbacks down — mirrors how 3c threaded `companyId`).
  - `CockpitInteractions` (CommanderCockpitPanel.tsx:26) += `onPin?: (entityType: CockpitPinnedEntityType, entityId: string) => void`, `onUnpin?: (entityType: CockpitPinnedEntityType, entityId: string) => void`, `onOpenArtifact?: (artifactId: string, title: string) => void`.
  - **`CommanderCockpitPanel` owns the hook:** `const { pin, unpin } = useCockpitPin(companyId);` then extend the `render({...})` call (line ~249) with `onPin: (t,id)=>pin(t,id)`, `onUnpin: (t,id)=>unpin(t,id)`; also add `onOpenArtifact` to the panel's destructured props (line ~184-193) and forward it in the same render bag.
  - Register the Pinned card: `{ id:"pinned", title:"Pinned", defaultOn: true, isActive: (d) => d.pinned.length > 0, render: ({data, onOpenTask, onOpenArtifact, onOpenFullPage, onUnpin}) => <CockpitPinnedCard items={data.pinned} onOpenTask={onOpenTask} onOpenArtifact={onOpenArtifact} onOpenFullPage={onOpenFullPage} onUnpin={onUnpin} /> }`.
  - Add a 📌 **Pin** button (hover-revealed via the existing `group-hover:flex` pattern at `CockpitReviewCard.tsx:43-56`, alongside the Ask↩ button) to the task rows in Review/MyTasks/Today; calls `onPin?.("task", item.id)` — **one-way** pin from rows (unpin lives only in the Pinned card → no `pinnedIds` set threaded in v1).
  - `CockpitPinnedCard` takes `onUnpin` (not the hook) and calls `onUnpin?.(item.entityType, item.entityId)` per row.
  - In `AgentPanelContent` (InternalAgentPanel.tsx, where `<CommanderCockpitPanel>` is rendered with the other `on*` handlers), add `onOpenArtifact={(id, title) => viewer.openRef({ v: 1, kind: "artifact", id, title, action: "referenced" })}`. **Verified shape:** `CommanderOutputRef` = `{v:1, kind, id, versionId?, title?, action, ...}` (commander-output-refs.ts:15-25); the kind enum is exactly `["artifact"]` (line 9); `openRefTab` opens any ref as an artifact tab with `refId: ref.id` (commanderViewerModel.ts:42-52). `onPin`/`onUnpin` are owned by the panel, so `AgentPanelContent` does NOT pass them.
- [ ] **Step 5:** `cd ui ; pnpm tsc -b` clean. Commit.

---

## Task 6: Tests + verification

- [ ] **Component tests** (`CockpitPinnedCard.test.tsx`): renders pinned items per type; click dispatches the right open; Unpin calls `pinsApi.unpin`; empty → null. A task-row Pin test: clicking 📌 calls `pinsApi.pin("task", id)`.
- [ ] **Static + unit:** `(cd server && pnpm vitest run cockpit user-entity-pins && pnpm typecheck)`; `(cd ui && pnpm vitest run src/components/commander/ && pnpm tsc -b)`; `pnpm --filter @armyofagents/shared typecheck`.
- [ ] **Live (Docker pgvector — non-embedded, so apply the migration explicitly):** boot the server against the Docker DB with `AOA_MIGRATION_AUTO_APPLY=true` (triggers `server/src/index.ts:140` → applies the new migration); confirm the `user_entity_pins` table exists (`\d user_entity_pins` or a probe select). Then exercise the endpoint end-to-end using a **goal** (no D8 dispatch gate — avoids the `POST /issues` 500 that bit 3b/3c live seeding): seed a company; `POST /companies/:cid/goals {title}` → goalId; `POST /companies/:cid/pins {entityType:"goal", entityId: goalId}` → **201**; `POST /companies/:cid/pins {entityType:"goal", entityId: <random uuid>}` → **404** (existence check, Codex #3); `GET /companies/:cid/cockpit` → assert `pinned` contains `{entityType:"goal", entityId: goalId, title, status}`; `DELETE /companies/:cid/pins/goal/:goalId` → `GET /cockpit` → `pinned: []`. Then open `/commander`, expand cockpit → the **Pinned** card renders the goal; click → navigates to `/goals/:id`. (The task-row 📌 Pin button + artifact/task open paths are covered by the component tests in Task 6 — live task creation is the flaky part, hence goal here.) Run the viewer + cockpit regression. Screenshot.
- [ ] **Teardown; clean tree; do NOT finish the branch.**

---

## Self-review + Codex review (both applied)

**Codex review (152k tokens, read-only against real code) — 8 findings, all resolved in this plan:**
1. **BLOCKER — `IF NOT EXISTS`:** generated SQL must add it (enforced by `migration-idempotency.test.ts`) → Task 1 Step 3b + 3c.
2. polymorphic resolver map keyed `${entityType}:${id}` → Task 4 Step 1.
3. write-time `entityId` uuid + existence/ownership (`404`) → Task 3 Steps 1–4.
4. `CockpitData` required-field fan-out (`EMPTY_DATA` + server return + fixtures) → Task 2 + Task 4 Step 1 + Task 6.
5. correct owner path `ui/src/components/InternalAgentPanel.tsx:1487` + thread `onOpenArtifact` → Task 5.
6. `logActivity` — **declined with evidence** (pins = personal pref; `inbox-dismissals.ts` doesn't log) → Task 3 Step 3.
7. e2e migration applies via embedded first-run, not the flag; Docker live-verify sets `AOA_MIGRATION_AUTO_APPLY=true` → anchors + Task 6.
8. build-before-generate redundant — removed → Task 1 Step 3a.

- **Schema:** generated via `pnpm db:generate`, then `IF NOT EXISTS` added (repo convention, NOT a hand-authored raw migration); table mirrors inbox_dismissals; unique on (userId, companyId, entityType, entityId); migration-idempotency test must pass.
- **Security:** pins are per-user (board-only routes, `requireBoardUserId`); **write-time** validates entityId is a uuid AND exists in the company (404 otherwise); **read-time** resolution is company-scoped (every id-set query has `eq(companyId)`) so no cross-tenant leak; finer per-dept RBAC on pinned items is a documented follow-up. Pin/unpin only touch the caller's own rows.
- **Resolution robustness:** deleted / out-of-company pins are dropped (not in the resolved map), so the card never shows a dangling pin; order preserved (pinnedAt desc).
- **Show-only-active:** Pinned `defaultOn:true` + `isActive: pinned.length>0` → hidden until you pin something (no opt-in-enable mechanism needed; that's the separate opt-in-cards follow-up).
- **Reuse:** inbox_dismissals (table+service+routes), useCockpitApprovalAction (the pin hook), the task-row card pattern, viewer.openTask/openRef. No new viewer surface (artifact opens via the existing openRef).
- **Type consistency:** `CockpitPinnedItem` (T2) built by the resolver (T4), shaped by the card (T5), exercised by tests (T6); `entityType` union shared across schema/type/routes/card.
- **Bug-watch:** the migration must actually generate (build dist first); entityId is uuid for all 3 types (confirm goals/artifacts ids are uuid); the artifact open builds a valid `CommanderOutputRef`; the row Pin button is one-way (unpin from the card) to avoid threading a pinnedIds set in v1.
