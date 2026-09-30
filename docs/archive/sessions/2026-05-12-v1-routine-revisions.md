# feat/v1-routine-revisions — D9 Routine Revision History

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent plan:** `docs/archive/sessions/2026-05-11-v1-upgrade-master.md`
**Branch:** `feat/v1-routine-revisions` (off `v1-upgrade`)
**Migration slot:** `0089_*` — runs AFTER `0088_*` (planning-mode)
**Source commit being ported:** `d6d7a7ce` (Paperclip routine revision history)

---

## Decision D9 Summary

Routines are live automation definitions. When a founder or agent edits a routine, the previous state is silently overwritten — there is no audit trail, no way to see what changed, and no way to undo a bad edit. D9 adds an **append-only revision table** that records every mutation, a **409-on-stale-base** conflict check to prevent lost updates in concurrent edit scenarios, a **line-diff viewer** in the History tab, and a **Restore** button that reinstates any prior revision (with webhook secret rotation for security).

---

## Scope

1. **Task 1 — DB schema + migration 0089**
2. **Task 2 — Shared types + validators** (new types + `baseRevisionId` on UpdateRoutine)
3. **Task 3 — Service layer** (`routineRevisionService`: createRevision, listRevisions, restoreRevision + 409 + webhook rotation)
4. **Task 4 — Routes** (GET revisions, POST restore, hook PATCH to write revisions)
5. **Task 5 — `ui/src/lib/line-diff.ts`** (LCS-based line differ, zero deps, ~91 lines)
6. **Task 6 — UI History tab** (new "History" tab on `RoutineDetail.tsx`)
7. **Task 7 — Plugin SDK test fixture update** (add `latestRevisionId` to fixture)

---

## Cross-cutting rules (from master plan)

- **Drizzle ORM only** — never hand-edit SQL migration files; run `pnpm db:generate`
- **Migration 0089** — must be generated AFTER migration 0088 is on `v1-upgrade` HEAD (it already is)
- **Brand-check** — no `[paperclip]` log prefix, no `paperclip-*` CSS classes, no `pcp_*` tokens, use `aoa.*` localStorage keys
- **AoA naming** — log prefix `[aoa-revision]`, localStorage key `aoa.routine-revisions.*`
- **Test policy** — new schema → ≥1 embedded-postgres integration test; new service → ≥1 unit test + ≥1 integration test; new route → ≥1 supertest route test; new UI component → ≥1 vitest test; new lib function → unit tests
- **Verification triple** after each task: `pnpm -r typecheck && pnpm test:run && pnpm build`

---

## Task 1 — DB schema + migration 0089

**What:** Add two schema changes:
1. New table `routine_revisions` (append-only revision log for routines)
2. Add column `latest_revision_id` (nullable FK) on `routines`

**File changes:**
- `packages/db/src/schema/routines.ts` — add `routineRevisions` table definition + `latestRevisionId` column to `routines`
- Run `pnpm db:generate` from repo root — this generates `packages/db/src/migrations/0089_*.sql` automatically
- `packages/db/src/index.ts` — export `routineRevisions` table

**Schema definition to add to `packages/db/src/schema/routines.ts`:**

```typescript
// Add to imports at top:
import { pgEnum } from "drizzle-orm/pg-core";

// New table after routineRuns:
export const routineRevisions = pgTable(
  "routine_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").notNull().references(() => routines.id, { onDelete: "cascade" }),
    // Snapshot of the routine's mutable fields at the time this revision was created
    snapshot: jsonb("snapshot").$type<RoutineSnapshot>().notNull(),
    // Who created this revision
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    routineCreatedAtIdx: index("routine_revisions_routine_created_at_idx").on(table.routineId, table.createdAt),
    companyIdx: index("routine_revisions_company_idx").on(table.companyId),
  }),
);
```

**`RoutineSnapshot` type** (define in `packages/shared/src/types/routine.ts` before the schema is referenced):
```typescript
export interface RoutineSnapshot {
  title: string;
  description: string | null;
  assigneeAgentId: string | null;
  priority: string;
  status: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  variables: RoutineVariable[];
  projectId: string | null;
  goalId: string | null;
  parentIssueId: string | null;
}
```

**Add `latestRevisionId` to `routines` table** (add inside the existing `pgTable` definition):
```typescript
latestRevisionId: uuid("latest_revision_id"),  // no FK constraint here — set after insert via update
```

**Note:** `latestRevisionId` has no FK constraint in the column definition because Drizzle would create a circular dependency (routines → routineRevisions → routines). Instead, the service code updates it after inserting the revision. The column is nullable.

**After schema edit:** Run `pnpm db:generate` from the AoA-2.5 root. Verify the generated migration file is numbered `0089_*.sql`. **Never edit the generated SQL file.**

**Exports to add to `packages/db/src/index.ts`:**
```typescript
export { routineRevisions } from "./schema/routines.js";
```

**Verification:**
```bash
pnpm -r typecheck
pnpm db:generate   # must produce 0089_*.sql, no manual SQL edits
```

---

## Task 2 — Shared types + validators

**What:** Add revision-related types and update the `updateRoutineSchema` validator to accept an optional `baseRevisionId` for conflict detection.

**File changes:**
- `packages/shared/src/types/routine.ts` — add `RoutineRevision`, `RoutineRevisionListItem` interfaces; add `latestRevisionId` to `Routine` and `RoutineDetail`
- `packages/shared/src/validators/routine.ts` — add `baseRevisionId` to `updateRoutineSchema`; add `restoreRoutineRevisionSchema`

**Type changes in `packages/shared/src/types/routine.ts`:**

Add `latestRevisionId` to the `Routine` interface:
```typescript
export interface Routine {
  // ... existing fields ...
  latestRevisionId: string | null;  // NEW
}
```

Add new interfaces:
```typescript
export interface RoutineRevision {
  id: string;
  companyId: string;
  routineId: string;
  snapshot: RoutineSnapshot;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface RoutineRevisionListItem extends RoutineRevision {
  // Author info resolved from createdByAgentId / createdByUserId
  author: { type: "agent"; name: string; urlKey: string } | { type: "user"; userId: string } | null;
}
```

**Validator changes in `packages/shared/src/validators/routine.ts`:**

Add `baseRevisionId` to `updateRoutineSchema`:
```typescript
export const updateRoutineSchema = createRoutineSchema.partial().extend({
  baseRevisionId: z.string().uuid().optional(),
});
```

Add restore schema:
```typescript
export const restoreRoutineRevisionSchema = z.object({
  revisionId: z.string().uuid(),
});
export type RestoreRoutineRevision = z.infer<typeof restoreRoutineRevisionSchema>;
```

**Exports:** Make sure `RoutineRevision`, `RoutineRevisionListItem`, `RoutineSnapshot`, `RestoreRoutineRevision`, `restoreRoutineRevisionSchema` are exported from `packages/shared/src/index.ts`.

**Tests:** Add unit tests in `packages/shared/src/__tests__/routine-validators.test.ts` (or extend existing) verifying:
- `updateRoutineSchema` accepts `baseRevisionId` UUID
- `updateRoutineSchema` rejects non-UUID `baseRevisionId`
- `restoreRoutineRevisionSchema` validates correctly

**Verification:**
```bash
pnpm -r typecheck
pnpm test:run
```

---

## Task 3 — Service layer

**What:** Add `routineRevisionService` function to `server/src/services/routines.ts` with three capabilities:
1. `createRevision` — snapshot the current routine state and insert a `routine_revisions` row, then update `routines.latestRevisionId`
2. `listRevisions` — fetch all revisions for a routine ordered by `createdAt DESC`
3. `restoreRevision` — restore a routine to a prior revision's snapshot, with 409 check and webhook secret rotation

**Internal function `captureSnapshot(routine: RoutineRow): RoutineSnapshot`** — extracts the mutable fields from a raw routine DB row into a `RoutineSnapshot`.

**Service function additions** (add inside `routineService(db, deps)`):

```typescript
createRevision: async (routineId: string, actor: Actor): Promise<void> => {
  const routine = await getRoutineById(routineId);
  if (!routine) return;
  const snapshot = captureSnapshot(routine);
  const [rev] = await db.insert(routineRevisions).values({
    companyId: routine.companyId,
    routineId: routine.id,
    snapshot,
    createdByAgentId: actor.agentId ?? null,
    createdByUserId: actor.userId ?? null,
  }).returning();
  await db.update(routines)
    .set({ latestRevisionId: rev.id })
    .where(eq(routines.id, routineId));
},

listRevisions: async (routineId: string): Promise<RoutineRevisionListItem[]> => {
  // fetch routine_revisions ordered by createdAt DESC, resolve author names
  // ...
},

restoreRevision: async (
  routineId: string,
  revisionId: string,
  actor: Actor,
): Promise<Routine | null> => {
  // 1. Fetch revision + current routine in one transaction
  // 2. Apply snapshot fields to routines row
  // 3. createRevision to capture the post-restore state as the new HEAD
  // 4. If routine has webhook triggers, rotate each one's secret (security property)
  // 5. Return updated routine
},
```

**409 conflict check in `update()` function** — modify the existing `update: async (id, patch, actor)` to check `baseRevisionId`:

```typescript
// At the top of update():
if (patch.baseRevisionId && existing.latestRevisionId && patch.baseRevisionId !== existing.latestRevisionId) {
  throw conflict("Routine has been modified since your last load. Reload and retry.");
}
// Before executing the update:
await createRevision(id, actor);  // snapshot current state before overwriting
```

**`conflict` error helper** — import from `../errors.js` (already has `conflict` exported).

**Webhook secret rotation on restore:** When restoring, for each `webhook` trigger belonging to the routine, call `secretService(db).rotate(secret.id, actor)` to regenerate the HMAC signing secret. This prevents a restored webhook trigger from being usable with a secret that may have been leaked.

**Tests to write:**

1. `server/src/__tests__/routines-service-revisions.test.ts` — unit tests with mock DB (`createSequenceDb` pattern from `routines-service.test.ts`):
   - `createRevision` inserts a revision row and updates latestRevisionId
   - `update` with matching `baseRevisionId` succeeds
   - `update` with stale `baseRevisionId` throws conflict (409)
   - `update` without `baseRevisionId` succeeds (backward-compat)
   - `restoreRevision` applies snapshot fields to routine
   - `restoreRevision` rotates webhook trigger secrets

2. `server/src/__tests__/routine-revisions-integration.test.ts` — embedded-postgres integration test:
   - Boot embedded-postgres, apply migrations, create routine, update it (creates revision), list revisions (count = 1), restore (count = 2), verify fields match snapshot

**Verification:**
```bash
pnpm -r typecheck
pnpm test:run --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|routines-service-revisions|routine-revisions-integration)"
```

---

## Task 4 — Routes

**What:** Add two new route handlers to `server/src/routes/routines.ts` and hook `createRevision` into the existing PATCH handler.

**New routes:**

```
GET  /companies/:cid/routines/:id/revisions         → list all revisions (most-recent first)
POST /companies/:cid/routines/:id/revisions/restore → restore routine to a given revision
```

**Note:** The existing router is registered under `/companies/:cid` context (verify by reading the route registration in `server/src/index.ts` or route file header). If routes are under a different prefix, follow the actual pattern.

**Handler for `GET /routines/:id/revisions`:**
```typescript
router.get("/routines/:id/revisions", async (req, res) => {
  const routine = await assertCanViewRoutine(req, req.params.id);
  if (!routine) { res.status(404).json({ error: "Routine not found" }); return; }
  const revisions = await svc.listRevisions(routine.id);
  res.json(revisions);
});
```

**Handler for `POST /routines/:id/revisions/restore`:**
```typescript
router.post("/routines/:id/revisions/restore", validate(restoreRoutineRevisionSchema), async (req, res) => {
  const routine = await assertCanManageExistingRoutine(req, req.params.id);
  if (!routine) { res.status(404).json({ error: "Routine not found" }); return; }
  const updated = await svc.restoreRevision(routine.id, req.body.revisionId, {
    agentId: req.actor.type === "agent" ? req.actor.agentId : null,
    userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
  });
  if (!updated) { res.status(404).json({ error: "Revision not found" }); return; }
  const actor = getActorInfo(req);
  await logActivity(db, {
    companyId: routine.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    action: "routine.restored",
    entityType: "routine",
    entityId: routine.id,
    details: { title: updated.title, revisionId: req.body.revisionId },
  });
  res.json(updated);
});
```

**PATCH handler update:** Ensure `createRevision` is called before the update executes. The service's `update()` function already does this when `baseRevisionId` is provided — but we also want to ensure a revision is written even when `baseRevisionId` is absent (to capture all edits). Revise the `update()` service method to ALWAYS call `createRevision` before applying the patch (not just when `baseRevisionId` is present). The 409 check only fires when `baseRevisionId` is provided.

**UI API client additions** in `ui/src/api/routines.ts`:
```typescript
export async function listRoutineRevisions(companyPrefix: string, routineId: string): Promise<RoutineRevisionListItem[]>
export async function restoreRoutineRevision(companyPrefix: string, routineId: string, revisionId: string): Promise<Routine>
```

**Tests:**

1. `server/src/__tests__/routines-routes-revisions.test.ts` — supertest route tests (follow `routines-routes.test.ts` mock pattern):
   - `GET /routines/:id/revisions` returns 200 with list
   - `GET /routines/:id/revisions` returns 404 for unknown routine
   - `POST /routines/:id/revisions/restore` returns 200 with updated routine
   - `POST /routines/:id/revisions/restore` returns 404 for unknown revision
   - `PATCH /routines/:id` with stale `baseRevisionId` returns 409

**Verification:**
```bash
pnpm -r typecheck
pnpm test:run --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|routines-routes-revisions)"
```

---

## Task 5 — `ui/src/lib/line-diff.ts`

**What:** Port the LCS-based line differ from Paperclip (`d6d7a7ce`). This is a pure function utility (~91 lines, zero external deps) that computes a unified-style diff between two text strings at the line level. It is reusable for future memory/artifact diff views.

**File to create:** `ui/src/lib/line-diff.ts`

**Public API:**

```typescript
export type DiffLine =
  | { type: "context"; text: string }
  | { type: "added"; text: string }
  | { type: "removed"; text: string };

export type DiffHunk = {
  lines: DiffLine[];
};

/**
 * Compute a line-level diff between oldText and newText.
 * Returns an array of hunks (groups of changed lines with surrounding context).
 * Context lines: 2 lines around each changed region.
 */
export function diffLines(oldText: string, newText: string, contextLines?: number): DiffHunk[];

/**
 * Returns true if oldText and newText are identical (no diff).
 */
export function isDiffEmpty(hunks: DiffHunk[]): boolean;
```

**Implementation:** LCS algorithm (standard Longest Common Subsequence). The implementation must:
1. Split both strings by `\n`
2. Compute LCS of the two line arrays
3. Walk the LCS edit script to produce `added`/`removed`/`context` lines
4. Group changed + context lines into `DiffHunk[]` (default 2 context lines)
5. Have zero external dependencies

**Tests:** `ui/src/__tests__/line-diff.test.ts`
- Identical texts → empty diff
- Single line added → one hunk with 1 added line
- Single line removed → one hunk with 1 removed line
- Line modified (appears as remove+add) → correct sequence
- Multi-line text with changes in two regions → two hunks with correct context separation
- Empty old text, non-empty new text → all added
- Non-empty old text, empty new text → all removed

**Verification:**
```bash
pnpm -r typecheck
pnpm test:run --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|line-diff)"
```

---

## Task 6 — UI History tab

**What:** Add a "History" tab to the existing `RoutineDetail.tsx` page. The tab renders the revision list with per-revision expansion showing:
- Timestamp (formatted) + author name/type
- Structured change summary (fields that changed between this revision and the previous one)
- Inline line-diff of `description` field (using `diffLines` from Task 5)
- "Restore" button that calls the restore API and confirms success via toast

**File changes:**
- `ui/src/pages/RoutineDetail.tsx` — add "History" tab to the existing `Tabs` component
- `ui/src/components/routines/RoutineRevisionHistory.tsx` — new component (extract History tab content here for testability)

**`RoutineRevisionHistory` component spec:**

```typescript
interface Props {
  companyPrefix: string;
  routineId: string;
  onRestored: () => void;  // callback to invalidate routine query after restore
}
```

Renders:
1. A `useQuery` for `listRoutineRevisions(companyPrefix, routineId)`
2. If loading: skeleton rows
3. If empty: `EmptyState` with message "No revision history yet. Edits will appear here."
4. If has revisions: a list of `RoutineRevisionCard` items (can be inline, no separate file needed)

Each `RoutineRevisionCard`:
- Header row: timestamp (use `timeAgo(rev.createdAt)` + tooltip with full ISO date) + author badge ("You" for current user, agent name for agent, "Board" for other board actors)
- Expandable body (click header to expand): structured diff summary + description line-diff
- Structured diff summary: compare `rev.snapshot` to the previous revision's snapshot (or the current routine state for the latest). Show which field changed (e.g. "Title: 'Old title' → 'New title'", "Assignee changed", "Priority: medium → high")
- Description diff: only shown when `description` field changed; render `DiffHunk[]` as colored lines (green bg for added, red bg for removed, neutral for context)
- Restore button: calls `restoreRoutineRevision`, shows loading state, on success calls `onRestored()` + toast "Routine restored to this revision"

**Design system compliance:**
- Use existing design tokens from `docs/architecture/design-system.md`
- Added lines: `bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300`
- Removed lines: `bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300`
- Context lines: `text-muted-foreground`
- Diff rendered in `font-mono text-xs` pre block

**Adding the tab to `RoutineDetail.tsx`:**
The page already uses `Tabs` component. Add:
```tsx
<TabsTrigger value="history">History</TabsTrigger>
// ...
<TabsContent value="history">
  <RoutineRevisionHistory
    companyPrefix={company.urlKey}
    routineId={id}
    onRestored={() => queryClient.invalidateQueries({ queryKey: queryKeys.routine(id) })}
  />
</TabsContent>
```

**Tests:** `ui/src/__tests__/RoutineRevisionHistory.test.tsx`
- Renders empty state when revisions array is empty
- Renders revision cards for each revision
- Clicking "Restore" calls `restoreRoutineRevision` and fires `onRestored`
- Description diff section is hidden when description field did not change

**Query key:** Add `routineRevisions: (routineId: string) => ["routineRevisions", routineId]` to `ui/src/lib/queryKeys.ts`.

**Verification:**
```bash
pnpm -r typecheck
pnpm test:run --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|RoutineRevisionHistory|line-diff)"
pnpm build
```

---

## Task 7 — Plugin SDK test fixture update

**What:** The AoA plugin SDK (`packages/plugin-sdk/`) has test fixtures describing the `Routine` shape. Since we added `latestRevisionId` to `Routine`, the fixture must be updated to include this field (as `null`).

**Files to locate and update:**
1. `grep -r "latestRevisionId\|routine.*fixture\|fixture.*routine" packages/plugin-sdk/ --include="*.ts" -l`
2. Any fixture file that contains a `Routine` object literal — add `latestRevisionId: null`
3. If the plugin SDK has its own `Routine` type mirror, verify it's either imported from `@armyofagents/shared` (preferred) or manually updated to include `latestRevisionId`.

**Also update:** Any test in `server/src/__tests__/` that constructs a `Routine` fixture object inline (e.g. `routines-routes.test.ts`, `routines-service.test.ts`, `routines-routes-contract.test.ts`) — add `latestRevisionId: null` to keep TypeScript happy after the type change.

**Verification:**
```bash
pnpm -r typecheck   # must be 0 errors
pnpm test:run
```

---

## Verification commands (per task)

```bash
# After each task:
pnpm -r typecheck 2>&1 | tail -5
pnpm test:run 2>&1 | tail -20

# After all tasks (final check):
pnpm -r typecheck && pnpm test:run && pnpm build
```

---

## Brand-check pre-flight (run before opening PR)

```bash
cd AoA-2.5
# No paperclip log prefixes:
grep -rn "\[paperclip\]" --include="*.ts" --include="*.tsx" server/src/services/routines.ts ui/src/components/routines/ ui/src/lib/line-diff.ts
# No pcp_ tokens:
grep -rn "pcp_" --include="*.ts" --include="*.tsx" packages/shared/src/validators/routine.ts
# No paperclip-* CSS classes:
grep -rn "paperclip-" --include="*.tsx" ui/src/components/routines/ ui/src/pages/RoutineDetail.tsx
```

Expected: 0 hits on all.

---

## Definition of done

- [ ] Migration `0089_*.sql` generated (Drizzle only, not hand-edited)
- [ ] `routine_revisions` table exported from `@armyofagents/db`
- [ ] `latestRevisionId` on `Routine` shared type (nullable)
- [ ] `baseRevisionId` accepted by `updateRoutineSchema`
- [ ] `RoutineRevision`, `RoutineRevisionListItem`, `RoutineSnapshot` types exported from `@armyofagents/shared`
- [ ] Service: `createRevision`, `listRevisions`, `restoreRevision` implemented and tested
- [ ] 409 conflict check fires when `baseRevisionId` mismatches `latestRevisionId`
- [ ] Webhook secrets rotated on restore
- [ ] Routes: `GET .../revisions` and `POST .../revisions/restore` implemented and tested
- [ ] PATCH routine always creates a revision before applying the update
- [ ] `ui/src/lib/line-diff.ts` implemented with unit tests
- [ ] History tab visible on `RoutineDetail.tsx` page
- [ ] `RoutineRevisionHistory` component implemented with unit tests
- [ ] Plugin SDK fixtures updated (typecheck passes at 0 errors)
- [ ] All tests: `pnpm test:run` passes with 0 new failures
- [ ] `pnpm -r typecheck` → 0 errors
- [ ] `pnpm build` → 0 errors
- [ ] Brand-check pre-flight: 0 violations
