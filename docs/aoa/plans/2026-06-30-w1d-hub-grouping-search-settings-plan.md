# W1d Hub Grouping, Search, Settings, Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Inbox/Approvals Hub usable at agent volume with deterministic search, grouping, per-user hub settings, mobile layout, keyboard navigation, and performance hardening.

**Architecture:** Extend the W1a/W1c hub index instead of adding a second inbox surface. Server list queries gain search, keyset pagination, group metadata, and stable query contracts; the UI composes those into grouped rows, saved preferences, and responsive lane/list/viewer navigation. W1d remains deterministic W1 work: no W2 realtime/preferences engine, no W3 Autopilot decisions, no W4 Steward intelligence, and no W5 adapter bridges.

**Tech Stack:** Drizzle ORM schema + generated migrations, Express 5 routes/services, shared Zod validators/types, React/Vite/TanStack Query UI, Vitest unit/integration/component tests, Playwright e2e.

---

## Scope

### In

- Server-side hub search across title, summary, semantic/source metadata, active lists, and history.
- Keyset pagination for lane lists with stable ordering and no unbounded render path.
- Deterministic grouping using existing `hub_items.group_key` plus fallback grouping by semantic type, scope, and source type.
- Per-user company-scoped hub preferences:
  - default landing lane;
  - visible lanes;
  - grouping mode;
  - compact density;
  - Autopilot entry card visibility only, not Autopilot behavior;
  - notification preferences entry link only, not W2 preferences.
- Mobile layout:
  - rail collapses to a drawer;
  - list and viewer stack;
  - bulk toolbar and undo banner stay reachable;
  - touch targets stay stable.
- Keyboard/a11y hardening:
  - `/` focuses hub search;
  - `j` / `k` move selection in the current list;
  - `Escape` closes viewer or drawer;
  - tab order and `aria-expanded` are explicit for groups/drawer.
- Focused desktop and mobile e2e smoke coverage.

### Out

- W2 realtime, toast bridge, anti-spam, digests, and real notification preferences.
- W3 Autopilot policy engine or auto-actions.
- W4 Steward intelligent grouping, explanations, or LLM summaries.
- W5 runtime decision bridges.
- Replacing `/inbox`; final cutover remains the next plan.

---

## Product Decisions

1. **Search is a query filter, not a local-only filter.** The list route accepts `q`; the server filters before pagination so search works across active/history pages instead of only the first 50 rows.

2. **Grouping is deterministic in W1d.** The UI groups by `groupKey` when present, else by `semanticType + scopeKey + sourceType`. Steward-authored group summaries belong to W4.

3. **No new virtualization dependency.** W1d uses keyset pagination, bounded page size, grouped rendering, and a load-more affordance. Add a virtualization dependency only if a measured local or CI performance test proves this is insufficient.

4. **Preferences are per user and company.** A founder can have different hub defaults per company. Preferences never change RBAC visibility.

5. **Autopilot in W1d is an entry point only.** The Home/settings UI may show or hide the Autopilot card and link to future controls, but does not make autonomy decisions.

6. **Maintained counters are not pre-fanned out.** W1d introduces a bounded, invalidated per-user counter snapshot instead of user x item fanout. It is refreshed on demand and invalidated by hub emit/lifecycle/personal-state mutations.

---

## File Map

### Shared Contracts

- Modify `packages/shared/src/validators/hub.ts`
  - Add `q`, `cursor`, `groupMode`, and `density` query/settings validators.
  - Add list response envelope validator/type.
  - Add hub preference get/update schemas.
- Modify `packages/shared/src/hub.ts`
  - Export `HUB_GROUP_MODES`, `HUB_DENSITIES`, and `HUB_LANDING_TARGETS`.
- Modify `packages/shared/src/__tests__/hub-contract.test.ts`
  - Contract tests for query/search/pagination/settings.

### Database

- Create `packages/db/src/schema/hub_preferences.ts`
  - Stores per-user, per-company hub preferences.
- Create `packages/db/src/schema/hub_counter_snapshots.ts`
  - Stores bounded per-user, per-company counter snapshots with invalidation timestamps.
- Modify `packages/db/src/schema/index.ts`
  - Export `hubPreferences` and `hubCounterSnapshots`.
- Modify `packages/db/src/schema/notifications.ts`
  - Add search/group/performance indexes on open hot set.
- Modify `packages/db/src/__tests__/hub-items-schema.test.ts`
  - Assert new preference table and idempotent indexes.
- Generate migration via `pnpm db:generate`, then patch generated `CREATE INDEX` statements with `IF NOT EXISTS` if needed.

### Server

- Modify `server/src/services/hub-items.ts`
  - Add `searchQuery`, cursor encode/decode, list envelope, group metadata fields, counter snapshot invalidation hooks.
- Create `server/src/services/hub-preferences.ts`
  - Get/upsert/reset preferences with defaults.
- Create `server/src/services/hub-counter-snapshots.ts`
  - Get, refresh, and invalidate per-user counter snapshots.
- Modify `server/src/services/index.ts`
  - Export `hubPreferencesService` and `hubCounterSnapshotsService`.
- Modify `server/src/routes/hub-items.ts`
  - Return list envelope and add preference endpoints under the same company-scoped route module.
- Modify `server/src/__tests__/hub-items-lifecycle.test.ts`
  - Query SQL tests for search, cursor, and grouping fields.
- Modify `server/src/__tests__/hub-items-routes.test.ts`
  - Route tests for list query options and preference endpoints.
- Create `server/src/__tests__/hub-preferences.test.ts`
  - Service tests for defaults, upsert, reset, and company scoping.
- Create `server/src/__tests__/hub-counter-snapshots.test.ts`
  - Service tests for refresh, invalidation, and no user-item fanout.

### UI

- Modify `ui/src/api/hub-items.ts`
  - Add list envelope, `q`, `cursor`, group fields, preference client methods.
- Modify `ui/src/api/__tests__/hub-items-api.test.ts`
  - Client URL/body tests for W1d query and preferences.
- Modify `ui/src/lib/queryKeys.ts`
  - Add `hubItems.preferences(companyId)`.
- Modify `ui/src/pages/InboxHub.tsx`
  - Wire search, pagination, preferences, default landing, visible lanes, grouping mode, keyboard navigation.
- Modify `ui/src/components/hub/HubShell.tsx`
  - Add search toolbar, settings popover/drawer, mobile drawer state, keyboard focus boundaries.
- Modify `ui/src/components/hub/HubRail.tsx`
  - Support hidden lanes and mobile drawer presentation.
- Modify `ui/src/components/hub/HubList.tsx`
  - Render grouped rows, group expand/collapse, compact density, load-more state.
- Modify `ui/src/components/hub/HubHome.tsx`
  - Respect Autopilot entry visibility.
- Modify `ui/src/components/hub/hubTypes.ts`
  - Add grouped list types.
- Modify `ui/src/components/hub/__tests__/HubShell.test.tsx`
  - Component tests for search, settings, groups, mobile affordances, keyboard.
- Modify `ui/src/__tests__/InboxHub.test.tsx`
  - Page tests for API params, default landing, lane visibility, load more, and search state.

### E2E

- Create `tests/e2e/inbox-hub-w1d.spec.ts`
  - Desktop and mobile smoke flows for search/group/settings/keyboarding.
- Modify `tests/e2e/inbox-hub-w1c.spec.ts`
  - Keep lifecycle smoke stable if the list response envelope changes.

---

## API Contract

### List Query

`GET /api/companies/:companyId/hub-items`

New query params:

```ts
{
  lane?: "waiting_on_you" | "notifications" | "suggestions";
  status?: "open" | "resolved" | "archived" | "snoozed";
  includeDismissed?: boolean;
  includeSnoozed?: boolean;
  limit?: number;          // 1..50, default 50
  q?: string;              // trimmed, max 120
  cursor?: string;         // opaque keyset cursor
  groupMode?: "auto" | "source" | "scope" | "type" | "none";
}
```

Response changes from a bare array to an envelope:

```ts
{
  items: HubItemListRow[];
  nextCursor: string | null;
  totalKnown: number | null;
}
```

Compatibility requirement: update all W1b/W1c UI call sites and tests in the same task. No external public API has consumed this route yet.

### List Row Additions

```ts
{
  groupKey: string | null;
  groupLabel: string | null;
  groupCount: number | null;
  scopeKey: string | null;
  slaAt: string | null;
}
```

`groupCount` is nullable because W1d grouping is display metadata, not a required aggregate on every row.

### Preferences

Routes:

```http
GET /api/companies/:companyId/hub-items/preferences/me
PATCH /api/companies/:companyId/hub-items/preferences/me
POST /api/companies/:companyId/hub-items/preferences/me/reset
```

Default response:

```ts
{
  defaultLanding: "home",
  visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
  groupMode: "auto",
  density: "comfortable",
  showAutopilotEntry: true,
  updatedAt: string | null
}
```

Patch body is partial but strict:

```ts
{
  defaultLanding?: "home" | "waiting_on_you" | "notifications" | "suggestions";
  visibleLanes?: Array<"waiting_on_you" | "notifications" | "suggestions">;
  groupMode?: "auto" | "source" | "scope" | "type" | "none";
  density?: "comfortable" | "compact";
  showAutopilotEntry?: boolean;
}
```

Validation rule: `visibleLanes` must contain at least one lane and no duplicates.
If `defaultLanding` is a lane, it must either be present in `visibleLanes` or the service must normalize it to `"home"` on read. The UI must also redirect the active lane to `"home"` or the first visible lane after a preference update hides the currently selected lane.

Route ordering requirement: register `preferences/me` routes before any `/:id` hub item routes so Express does not treat `preferences` as a hub item id.

---

## Implementation Tasks

### Task 0: Contract Tests First

**Files:**
- Modify `packages/shared/src/validators/hub.ts`
- Modify `packages/shared/src/hub.ts`
- Modify `packages/shared/src/__tests__/hub-contract.test.ts`

- [ ] **Step 1: Add failing contract tests**

Add tests like:

```ts
it("accepts W1d search, cursor, and group mode list query params", () => {
  expect(
    listHubItemsQuery.parse({
      lane: "waiting_on_you",
      status: "open",
      q: "approval deployment",
      cursor: "eyJjcmVhdGVkQXQiOiIyMDI2LTA2LTMwVDAwOjAwOjAwLjAwMFoiLCJpZCI6ImgifQ",
      groupMode: "auto",
      limit: "25",
    }),
  ).toMatchObject({
    lane: "waiting_on_you",
    status: "open",
    q: "approval deployment",
    groupMode: "auto",
    limit: 25,
  });
});

it("rejects empty visible lane preferences", () => {
  expect(() =>
    updateHubPreferencesSchema.parse({ visibleLanes: [] }),
  ).toThrow();
});

it("rejects duplicate visible lane preferences", () => {
  expect(() =>
    updateHubPreferencesSchema.parse({
      visibleLanes: ["waiting_on_you", "waiting_on_you"],
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/shared test -- hub-contract.test.ts
```

Expected: failures for missing W1d schemas/constants.

- [ ] **Step 3: Implement shared validators/constants**

Add constants:

```ts
export const HUB_LANDING_TARGETS = ["home", ...HUB_LANES] as const;
export const HUB_GROUP_MODES = ["auto", "source", "scope", "type", "none"] as const;
export const HUB_DENSITIES = ["comfortable", "compact"] as const;
```

Add strict schemas in `validators/hub.ts`:

```ts
const visibleLanesSchema = z
  .array(z.enum(HUB_LANES))
  .min(1)
  .refine((lanes) => new Set(lanes).size === lanes.length, {
    message: "visibleLanes must not contain duplicates",
  });
```

- [ ] **Step 4: Run contract tests**

Run:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/shared test -- hub-contract.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```sh
git add packages/shared/src/hub.ts packages/shared/src/validators/hub.ts packages/shared/src/__tests__/hub-contract.test.ts
git commit -m "test(hub): define W1d query and preference contracts"
```

### Task 1: Preference Schema, Service, and Routes

**Files:**
- Create `packages/db/src/schema/hub_preferences.ts`
- Modify `packages/db/src/schema/index.ts`
- Modify `server/src/services/hub-preferences.ts`
- Modify `server/src/services/index.ts`
- Modify `server/src/routes/hub-items.ts`
- Create `server/src/__tests__/hub-preferences.test.ts`
- Modify `server/src/__tests__/hub-items-routes.test.ts`

- [ ] **Step 1: Add failing service tests**

Test defaults, upsert, reset, and company/user uniqueness:

```ts
it("returns default hub preferences when no row exists", async () => {
  const svc = hubPreferencesService(makeDbReturning([]) as never);
  await expect(svc.get("user-1", "company-1")).resolves.toMatchObject({
    defaultLanding: "home",
    visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
    groupMode: "auto",
    density: "comfortable",
    showAutopilotEntry: true,
  });
});
```

- [ ] **Step 2: Add failing route tests**

Add route tests:

```ts
it("GET preferences/me returns user company-scoped preferences", async () => {
  mockHubPreferences.get.mockResolvedValue(defaultHubPreferences());
  const res = await request(app).get(`/api/companies/${COMPANY_A}/hub-items/preferences/me`);
  expect(res.status).toBe(200);
  expect(mockHubPreferences.get).toHaveBeenCalledWith("user-1", COMPANY_A);
});

it("PATCH preferences/me rejects duplicate visible lanes", async () => {
  const res = await request(app)
    .patch(`/api/companies/${COMPANY_A}/hub-items/preferences/me`)
    .send({ visibleLanes: ["notifications", "notifications"] });
  expect(res.status).toBe(400);
});

it("PATCH preferences/me normalizes a hidden default landing", async () => {
  const res = await request(app)
    .patch(`/api/companies/${COMPANY_A}/hub-items/preferences/me`)
    .send({ defaultLanding: "waiting_on_you", visibleLanes: ["notifications"] });
  expect(res.status).toBe(200);
  expect(res.body.defaultLanding).toBe("home");
});
```

- [ ] **Step 3: Add DB schema and migration**

Schema:

```ts
export const hubPreferences = pgTable(
  "hub_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    defaultLanding: text("default_landing").notNull().default("home"),
    visibleLanes: jsonb("visible_lanes").$type<HubLane[]>().notNull(),
    groupMode: text("group_mode").notNull().default("auto"),
    density: text("density").notNull().default("comfortable"),
    showAutopilotEntry: boolean("show_autopilot_entry").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("hub_preferences_company_idx").on(table.companyId),
    userIdx: index("hub_preferences_user_idx").on(table.userId),
    userCompanyUq: uniqueIndex("hub_preferences_user_company_uq").on(table.userId, table.companyId),
  }),
);
```

Do not use a TypeScript array literal as the DB default for `visible_lanes`; keep defaults in `hub-preferences.ts` so Drizzle migration output stays explicit and portable. If a DB default is later required, use a SQL JSONB literal and add a migration snapshot test.

Run:

```sh
corepack pnpm@9.15.4 db:generate
```

- [ ] **Step 4: Implement service/routes**

Service methods:

```ts
get(userId: string, companyId: string): Promise<HubPreferences>
upsert(userId: string, companyId: string, patch: UpdateHubPreferencesInput): Promise<HubPreferences>
reset(userId: string, companyId: string): Promise<HubPreferences>
```

Routes must call `assertCompanyAccess` and require board user context, mirroring `sidebar-preferences.ts`.
Register these routes before `/:id` routes in `server/src/routes/hub-items.ts`.
When `visibleLanes` hides the current/default lane, return a normalized preference payload where `defaultLanding` is `"home"` unless the requested default lane is still visible.

- [ ] **Step 5: Run targeted tests**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-preferences.test.ts server/src/__tests__/hub-items-routes.test.ts packages/db/src/__tests__/hub-items-schema.test.ts
```

- [ ] **Step 6: Commit**

```sh
git add packages/db/src/schema/hub_preferences.ts packages/db/src/schema/index.ts packages/db/src/migrations server/src/services/hub-preferences.ts server/src/services/index.ts server/src/routes/hub-items.ts server/src/__tests__/hub-preferences.test.ts server/src/__tests__/hub-items-routes.test.ts packages/db/src/__tests__/hub-items-schema.test.ts
git commit -m "feat(hub): add per-user hub preferences"
```

### Task 2: Search, Keyset Pagination, and Group Metadata

**Files:**
- Modify `server/src/services/hub-items.ts`
- Modify `server/src/routes/hub-items.ts`
- Modify `packages/db/src/schema/notifications.ts`
- Modify `server/src/__tests__/hub-items-lifecycle.test.ts`
- Modify `server/src/__tests__/hub-items-routes.test.ts`

- [ ] **Step 1: Add failing query tests**

Add SQL rendering tests that prove:

```ts
expect(whereSql).toContain("lower(\"notifications\".\"title\") like");
expect(whereSql).toContain("lower(\"notifications\".\"summary\") like");
expect(whereSql).toContain('"notifications"."created_at" <');
expect(whereSql).toContain('"notifications"."id" <');
```

- [ ] **Step 2: Implement cursor helpers**

In `hub-items.ts`:

```ts
function encodeCursor(row: { createdAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }), "utf8")
    .toString("base64url");
}

function decodeCursor(cursor: string) {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    createdAt: string;
    id: string;
  };
  return { createdAt: new Date(parsed.createdAt), id: parsed.id };
}
```

- [ ] **Step 3: Implement search conditions**

Use escaped lower-case `LIKE`:

```ts
function likePattern(q: string) {
  return `%${q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
```

Filter `title`, `summary`, `sourceType`, `scopeKey`, and `semanticType`.
SQL must use an explicit escape clause for `%`, `_`, and `\`:

```ts
sql`lower(${notifications.title}) like ${pattern} escape '\\'`
```

Add a test with query text `100%_ready\ship` and assert the generated pattern contains escaped `%`, `_`, and `\`.

- [ ] **Step 4: Return list envelope**

Fetch `limit + 1`; return:

```ts
{
  items,
  nextCursor: extraRow ? encodeCursor(lastReturnedRow) : null,
  totalKnown: null,
}
```

- [ ] **Step 5: Add group fields to rows**

For each row:

```ts
groupKey: item.groupKey ?? deriveFallbackGroupKey(item, groupMode),
groupLabel: deriveGroupLabel(item, groupMode),
groupCount: null,
scopeKey: item.scopeKey,
slaAt: item.slaAt,
```

- [ ] **Step 6: Run targeted server tests**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-items-lifecycle.test.ts server/src/__tests__/hub-items-routes.test.ts
```

- [ ] **Step 7: Commit**

```sh
git add server/src/services/hub-items.ts server/src/routes/hub-items.ts packages/db/src/schema/notifications.ts packages/db/src/migrations server/src/__tests__/hub-items-lifecycle.test.ts server/src/__tests__/hub-items-routes.test.ts
git commit -m "feat(hub): add search and paginated list envelope"
```

### Task 3: UI API Client, Search, and Load More

**Files:**
- Modify `ui/src/api/hub-items.ts`
- Modify `ui/src/api/__tests__/hub-items-api.test.ts`
- Modify `ui/src/lib/queryKeys.ts`
- Modify `ui/src/pages/InboxHub.tsx`
- Modify `ui/src/__tests__/InboxHub.test.tsx`

- [ ] **Step 1: Add failing API client tests**

Add tests:

```ts
it("builds W1d list query params", async () => {
  await hubItemsApi.list("company-1", {
    lane: "waiting_on_you",
    status: "open",
    q: "deploy",
    groupMode: "auto",
    cursor: "abc",
    limit: 25,
  });
  expect(api.get).toHaveBeenCalledWith(
    "/companies/company-1/hub-items?lane=waiting_on_you&status=open&q=deploy&groupMode=auto&cursor=abc&limit=25",
  );
});

it("normalizes legacy bare-array responses for focused W1b/W1c tests if needed", () => {
  expect(normalizeHubListResponse([{ id: "hub-1" } as HubItemListRow])).toMatchObject({
    items: [{ id: "hub-1" }],
    nextCursor: null,
    totalKnown: null,
  });
});
```

- [ ] **Step 2: Update API types**

Add:

```ts
export interface HubListResponse {
  items: HubItemListRow[];
  nextCursor: string | null;
  totalKnown: number | null;
}
```

`hubItemsApi.list` returns `HubListResponse`. Keep the production server contract as the envelope; a small UI/test-side `normalizeHubListResponse` helper may accept the old bare array only to keep older focused tests readable while W1b/W1c call sites are converted.

- [ ] **Step 3: Update InboxHub query usage**

Use `listQuery.data?.items ?? []`, `listQuery.data?.nextCursor ?? null`, and include `q/groupMode/cursor` in query keys.

- [ ] **Step 4: Add search state**

Add a debounced `searchText` state. Query param behavior:

```ts
const listOptions = {
  lane: activeLane,
  status: historyStatus,
  q: debouncedSearchText || undefined,
  groupMode: preferences.groupMode,
  limit: 50,
};
```

- [ ] **Step 5: Add load-more action**

Use a second query or simple cursor state. The first implementation may keep pages in local state:

```ts
const [pageCursors, setPageCursors] = useState<string[]>([]);
const cursor = pageCursors.at(-1);
```

Reset pages when lane/status/search/groupMode changes.

- [ ] **Step 6: Run UI tests**

Run:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- hub-items-api.test.ts InboxHub.test.tsx
```

- [ ] **Step 7: Commit**

```sh
git add ui/src/api/hub-items.ts ui/src/api/__tests__/hub-items-api.test.ts ui/src/lib/queryKeys.ts ui/src/pages/InboxHub.tsx ui/src/__tests__/InboxHub.test.tsx
git commit -m "feat(hub): wire search and paginated loading"
```

### Task 4: Grouped List UI and Preferences UI

**Files:**
- Modify `ui/src/components/hub/HubShell.tsx`
- Modify `ui/src/components/hub/HubList.tsx`
- Modify `ui/src/components/hub/HubHome.tsx`
- Modify `ui/src/components/hub/HubRail.tsx`
- Modify `ui/src/components/hub/hubTypes.ts`
- Modify `ui/src/components/hub/__tests__/HubShell.test.tsx`
- Modify `ui/src/__tests__/InboxHub.test.tsx`

- [x] **Step 1: Add failing component tests**

Cover:

```ts
expect(screen.getByRole("button", { name: /5 approvals/i })).toHaveAttribute("aria-expanded", "false");
expect(screen.queryByRole("button", { name: /hidden notification/i })).not.toBeInTheDocument();
expect(screen.getByRole("combobox", { name: /default landing/i })).toHaveValue("waiting_on_you");
```

- [x] **Step 2: Implement grouping model**

Create a local helper in `hubTypes.ts`:

```ts
export type HubListEntry =
  | { kind: "item"; item: HubItemListRow }
  | { kind: "group"; key: string; label: string; items: HubItemListRow[]; unreadCount: number };
```

Group only when `groupMode !== "none"` and the group has at least 3 items. Urgent/high-priority items must remain individually visible above their group; the group header should show urgent and unread counts for the remaining grouped items.

- [x] **Step 3: Render groups without nested cards**

Use full-width row bands inside the list. Group rows must have stable height and an expand/collapse button with `aria-expanded`.

- [x] **Step 4: Add preferences UI**

Add a compact settings control in the shell toolbar:

- Default landing segmented/select control.
- Lane visibility checkboxes.
- Grouping mode select.
- Density toggle.
- Autopilot entry checkbox.
- Notification preferences link button to the future settings section; the link can be disabled if the target does not exist yet, but it must be visibly an entry point only.

If a preference change hides the active lane, immediately navigate to `"home"` or the first visible lane and keep the viewer closed until the new lane data loads.

- [x] **Step 5: Wire preferences mutations**

On successful patch/reset, invalidate:

```ts
queryKeys.hubItems.preferences(companyId)
queryKeys.hubItems.list(companyId, ...)
```

- [x] **Step 6: Run UI tests**

Run:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- HubShell.test.tsx InboxHub.test.tsx
```

Verified with:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- hub-items-api.test.ts HubShell.test.tsx InboxHub.test.tsx
corepack pnpm@9.15.4 --filter @armyofagents/ui typecheck
```

- [x] **Step 7: Commit**

```sh
git add ui/src/components/hub/HubShell.tsx ui/src/components/hub/HubList.tsx ui/src/components/hub/HubHome.tsx ui/src/components/hub/HubRail.tsx ui/src/components/hub/hubTypes.ts ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/__tests__/InboxHub.test.tsx
git commit -m "feat(hub): add grouping and preferences controls"
```

### Task 5: Mobile and Keyboard Hardening

**Files:**
- Modify `ui/src/components/hub/HubShell.tsx`
- Modify `ui/src/components/hub/HubRail.tsx`
- Modify `ui/src/components/hub/HubList.tsx`
- Modify `ui/src/components/hub/HubViewer.tsx`
- Modify `ui/src/components/hub/__tests__/HubShell.test.tsx`
- Modify `ui/src/__tests__/InboxHub.test.tsx`

- [x] **Step 1: Add failing tests**

Component tests:

```ts
it("focuses search when slash is pressed", async () => {
  renderShell();
  await user.keyboard("/");
  expect(screen.getByRole("searchbox", { name: /search hub/i })).toHaveFocus();
});

it("moves selection with j and k", async () => {
  renderShell({ items: [itemA, itemB] });
  await user.keyboard("j");
  expect(onSelectItem).toHaveBeenCalledWith(itemA.id);
  await user.keyboard("j");
  expect(onSelectItem).toHaveBeenCalledWith(itemB.id);
  await user.keyboard("k");
  expect(onSelectItem).toHaveBeenCalledWith(itemA.id);
});
```

- [x] **Step 2: Implement keyboard handler**

Only handle shortcuts when the active element is `body`, the hub shell root, or a non-editable hub row/control. Ignore shortcuts inside input, textarea, select, combobox, dialog text fields, and contenteditable nodes.
`j`/`k` navigation walks the visible flattened entry list only; collapsed group children are skipped until their group is expanded.

- [x] **Step 3: Implement mobile shell**

At widths below the existing `lg` breakpoint:

- rail opens as a drawer controlled by an icon button;
- list and viewer stack;
- selecting an item moves focus to viewer heading;
- closing viewer returns focus to selected row;
- undo and bulk bars use fixed-height rows, not overlapping overlays.

On desktop widths at or above `lg`, preserve the W1b/W1c three-pane shell geometry.

- [x] **Step 4: Run UI tests**

Run:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- HubShell.test.tsx InboxHub.test.tsx
```

Verified with:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- HubShell.test.tsx InboxHub.test.tsx
corepack pnpm@9.15.4 --filter @armyofagents/ui typecheck
```

- [x] **Step 5: Commit**

```sh
git add ui/src/components/hub/HubShell.tsx ui/src/components/hub/HubRail.tsx ui/src/components/hub/HubList.tsx ui/src/components/hub/HubViewer.tsx ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/__tests__/InboxHub.test.tsx
git commit -m "feat(hub): harden mobile and keyboard navigation"
```

### Task 6: Counter Snapshot and Performance Guard

**Files:**
- Create `packages/db/src/schema/hub_counter_snapshots.ts`
- Modify `packages/db/src/schema/index.ts`
- Create `server/src/services/hub-counter-snapshots.ts`
- Modify `server/src/services/hub-items.ts`
- Modify `server/src/services/index.ts`
- Create `server/src/__tests__/hub-counter-snapshots.test.ts`
- Modify `server/src/__tests__/hub-items-lifecycle.test.ts`

- [x] **Step 1: Add failing counter snapshot tests**

Tests must prove snapshots are per user + company and are invalidated by shared and personal mutations:

```ts
it("refreshes one user counter snapshot without creating user-item rows", async () => {
  const svc = hubCounterSnapshotsService(db as never);
  await svc.refresh({ companyId: "company-1", userId: "user-1", role: "founder" });
  expect(db.insert).toHaveBeenCalledWith(hubCounterSnapshots);
  expect(db.insert).not.toHaveBeenCalledWith(hubItemUserState);
});

it("invalidates the actor snapshot after personal state changes", async () => {
  const svc = hubItemsService(db as never);
  await svc.applyPersonalState({
    companyId: "company-1",
    hubItemId: "hub-1",
    actorUserId: "user-1",
    role: "founder",
    state: { kind: "dismiss" },
  });
  expect(mockCounterSnapshots.invalidateUser).toHaveBeenCalledWith("company-1", "user-1");
});
```

- [x] **Step 2: Add DB schema**

Schema:

```ts
export const hubCounterSnapshots = pgTable(
  "hub_counter_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    openCount: integer("open_count").notNull().default(0),
    unreadCount: integer("unread_count").notNull().default(0),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    computedAt: timestamp("computed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUq: uniqueIndex("hub_counter_snapshots_company_user_uq").on(table.companyId, table.userId),
    invalidatedIdx: index("hub_counter_snapshots_invalidated_idx").on(table.companyId, table.invalidatedAt),
  }),
);
```

- [x] **Step 3: Implement refresh and invalidation service**

Rules:

- `getOrRefresh` uses the existing `hubItemsService.counts` query when no valid snapshot exists.
- A snapshot is valid only when `computedAt` exists and `invalidatedAt` is null or `invalidatedAt <= computedAt`.
- If refresh fails, the counts route falls back to the existing live counts query and returns live counts rather than stale snapshot counts.
- `invalidateUser(companyId, userId)` marks one user's snapshot invalid after read/snooze/dismiss.
- `invalidateCompany(companyId)` marks all company snapshots invalid after emit/resolve/archive/claim/release/reconcile.
- No method creates rows for users who have never opened the hub.

- [x] **Step 4: Wire counts route**

`GET /hub-items/counts` should call `hubCounterSnapshotsService.getOrRefresh`, not raw `svc.counts`, while preserving the exact `{ open, unread }` response.

- [x] **Step 5: Run targeted tests**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-counter-snapshots.test.ts server/src/__tests__/hub-items-lifecycle.test.ts server/src/__tests__/hub-items-routes.test.ts
```

Include tests for stale-snapshot fallback:

```ts
it("does not return a stale snapshot when invalidated after compute", async () => {
  mockSnapshots.find.mockResolvedValue({
    openCount: 3,
    unreadCount: 2,
    invalidatedAt: new Date("2026-06-30T10:01:00.000Z"),
    computedAt: new Date("2026-06-30T10:00:00.000Z"),
  });
  mockLiveCounts.mockResolvedValue({ open: 5, unread: 4 });
  await expect(svc.getOrRefresh(ctx)).resolves.toEqual({ open: 5, unread: 4 });
});
```

Verified with:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-counter-snapshots.test.ts server/src/__tests__/hub-items-lifecycle.test.ts server/src/__tests__/hub-items-routes.test.ts packages/db/src/__tests__/hub-items-schema.test.ts
corepack pnpm@9.15.4 --filter @armyofagents/server typecheck
corepack pnpm@9.15.4 --filter @armyofagents/db typecheck
```

- [x] **Step 6: Commit**

```sh
git add packages/db/src/schema/hub_counter_snapshots.ts packages/db/src/schema/index.ts packages/db/src/migrations server/src/services/hub-counter-snapshots.ts server/src/services/hub-items.ts server/src/services/index.ts server/src/__tests__/hub-counter-snapshots.test.ts server/src/__tests__/hub-items-lifecycle.test.ts server/src/__tests__/hub-items-routes.test.ts
git commit -m "feat(hub): add counter snapshots for hub badges"
```

### Task 7: W1d E2E and Final Verification

**Files:**
- Create `tests/e2e/inbox-hub-w1d.spec.ts`
- Modify `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`
- Modify this plan with implementation notes after completion

- [x] **Step 1: Add Playwright user flow**

Cover:

1. Seed at least 12 hub items across two group keys.
2. Open `/inbox-hub`.
3. Confirm default landing preference changes the first lane.
4. Search for a unique item and verify only matching rows appear.
5. Clear search and verify grouped rows collapse/expand.
6. Use `j/k` to move selection.
7. Change lane visibility and verify hidden lane disappears from rail.
8. Run mobile viewport:
   - open rail drawer;
   - switch lane;
   - open item;
   - close viewer;
   - verify no toolbar/viewer overlap.

- [x] **Step 2: Run focused local tests**

Run:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/shared test -- hub-contract.test.ts
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-items-lifecycle.test.ts server/src/__tests__/hub-items-routes.test.ts server/src/__tests__/hub-preferences.test.ts server/src/__tests__/hub-counter-snapshots.test.ts
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- hub-items-api.test.ts HubShell.test.tsx InboxHub.test.tsx
```

Completed:

- `corepack pnpm@9.15.4 --filter @armyofagents/shared test -- hub-contract.test.ts` - PASS, 17 tests.
- `corepack pnpm@9.15.4 test:run server/src/__tests__/hub-items-lifecycle.test.ts server/src/__tests__/hub-items-routes.test.ts server/src/__tests__/hub-preferences.test.ts server/src/__tests__/hub-counter-snapshots.test.ts` - PASS, 43 tests.
- `corepack pnpm@9.15.4 --filter @armyofagents/ui test -- hub-items-api.test.ts HubShell.test.tsx InboxHub.test.tsx` - PASS, 41 tests.

- [x] **Step 3: Run final local verification**

Run:

```sh
corepack pnpm@9.15.4 -r typecheck
corepack pnpm@9.15.4 test:run
corepack pnpm@9.15.4 build
corepack pnpm@9.15.4 exec playwright test tests/e2e/inbox-hub-w1b.spec.ts tests/e2e/inbox-hub-w1c.spec.ts tests/e2e/inbox-hub-w1d.spec.ts --config tests/e2e/playwright.config.ts
```

Known local caveat: on Windows without `DATABASE_URL`, the e2e config may select the embedded-Postgres skip spec and report `No tests found`. If so, record that exact output and rely on Linux CI as the Playwright gate.

Completed:

- `corepack pnpm@9.15.4 -r typecheck` - PASS after using the local pnpm 9 shim for nested scripts.
- `corepack pnpm@9.15.4 test:run` - PASS, 10,580 tests passed, 189 skipped.
- `corepack pnpm@9.15.4 build` - PASS.
- `corepack pnpm@9.15.4 exec playwright test tests/e2e/inbox-hub-w1b.spec.ts tests/e2e/inbox-hub-w1c.spec.ts tests/e2e/inbox-hub-w1d.spec.ts --config tests/e2e/playwright.config.ts` - local Windows without `DATABASE_URL` reported `No tests found` because the config switches to the embedded-Postgres skip spec.
- `corepack pnpm@9.15.4 exec playwright test windows-embedded-postgres-skip.spec.ts --config tests/e2e/playwright.config.ts` - PASS as expected with 1 skipped sentinel.

- [x] **Step 4: Update roadmap**

Mark W1d implemented and set next step to final cutover and acceptance plan.

- [ ] **Step 5: Commit**

```sh
git add tests/e2e/inbox-hub-w1d.spec.ts docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md docs/aoa/plans/2026-06-30-w1d-hub-grouping-search-settings-plan.md packages/db/src/migrations/0154_dusty_karen_page.sql packages/db/src/migrations/0156_pretty_the_call.sql server/src/services/hub-items.ts
git commit -m "test(hub): add W1d grouping and mobile e2e coverage"
```

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---:|---|
| List response envelope breaks W1b/W1c UI tests | High | Convert API client and page tests in the same task; no server-only commit that leaves UI stale. |
| Search becomes slow at volume | High | Use bounded `q`, open hot-set indexes, keyset pagination, and no unbounded client filtering. |
| Grouping hides urgent items | High | Group headers show unread/urgent counts; urgent items remain visible when group expands; search bypasses collapsed ambiguity. |
| Preference routes shadow item routes | High | Register `preferences/me` routes before `/:id` routes and add route tests for all three preference endpoints. |
| LIKE search treats `%` and `_` as wildcards | High | Escape `%`, `_`, and `\` and use SQL `escape '\\'`; add a regression test using all three characters. |
| Counter snapshots return stale badge counts | High | Treat snapshots as valid only when `computedAt` is newer than `invalidatedAt`; fall back to live counts if refresh fails. |
| Preferences hide all lanes | Medium | Shared validator requires at least one visible lane and dedupes/rejects duplicates. |
| Mobile controls overlap undo/bulk bars | Medium | Stable heights and Playwright mobile assertions. |
| Keyboard shortcuts steal text input | Medium | Ignore shortcuts while focus is inside form fields or editable content. |
| Maintained counters revive MxN fanout | High | Use per-user counter snapshots/invalidation only; do not pre-create rows for every user-item pair. |
| W1d drifts into W2/W3/W4 | High | Keep notification preferences as link-only, Autopilot as display-only, grouping deterministic. |

---

## Review Checklist

- [x] Shared contracts cover search, cursor, group mode, density, and preferences.
- [x] Every new route is company-scoped and board-user scoped.
- [x] Search is server-side and works for active and history statuses.
- [x] Pagination is keyset-based, stable, and deterministic.
- [x] Grouping is deterministic and never hides access to individual items.
- [x] Preferences are per user + company and cannot hide all lanes.
- [x] Mobile layout has no rail/list/viewer overlap.
- [x] Keyboard shortcuts preserve form input behavior.
- [x] Unit, integration, component, and e2e coverage exist before handoff.
- [x] No W2/W3/W4/W5 implementation code enters this PR.
- [ ] PR #244 CI is green or any red check is triaged as unrelated before starting W1d implementation commits.

---

## Review Notes

### Scope Notes

- W1d completes the W1 user-experience hardening phase for PR #244.
- The next plan after W1d is final Inbox cutover and acceptance.
- W2, W3, W4, and W5 stay as separate later PRs.

### Execution Recommendation

Use subagent-driven development for this plan:

1. Contract + DB/preferences agent.
2. Server search/pagination agent.
3. UI search/group/settings agent.
4. Mobile/keyboard/e2e agent.

Each agent should return a focused diff and verification output before the next one starts.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | Not run | Scope unchanged from master W1d; no new product expansion proposed. |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | Not run | No committed W1d diff exists yet; run before PR handoff after implementation. |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | Clear after patch | Patched route ordering, JSONB defaults, search escaping, list envelope compatibility, preference normalization, and stale counter fallback. |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | Clear after patch | Patched mobile breakpoint behavior, active-lane fallback, urgent grouping visibility, and visible-only keyboard navigation. |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | Light clear | Internal operator UI; plan includes targeted commands, final verification, and local Windows e2e caveat. |

- **LOCAL VERIFICATION NOTE:** Windows local e2e cannot execute the hub browser specs without `DATABASE_URL`; the config intentionally selects `windows-embedded-postgres-skip.spec.ts` because embedded Postgres cannot start as an administrative Windows runner. Linux CI or a local external Postgres `DATABASE_URL` remains the browser-flow gate.
- **VERDICT:** W1d implementation complete locally through typecheck, full unit/integration suite, build, and Windows e2e sentinel; PR #244 CI should run the real Playwright hub specs on a supported environment.
