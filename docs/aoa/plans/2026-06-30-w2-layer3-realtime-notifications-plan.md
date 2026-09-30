# W2 Layer 3 Realtime Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add W2 Layer 3 for Inbox Hub: metadata-only realtime events, WebSocket-driven hub refresh, toast bridging, per-user notification preferences, anti-spam, quiet hours, and in-app digest queue.

**Architecture:** Keep hub items as the canonical notification store. Server mutations publish safe `LiveEvents` metadata, the WebSocket server filters hub events through hub RBAC before delivery, clients hydrate content through RBAC-scoped hub routes, and the toast bridge uses the existing `LiveUpdatesProvider` + `ToastContext`. Notification preferences and digest queue get dedicated DB/service/route surfaces because they are delivery settings, not W1d layout preferences.

**Tech Stack:** Express 5, Drizzle/Postgres, React/Vite, TanStack Query, Vitest, Playwright, existing `LiveEvents` WebSocket, existing unified Toast Layer 1.

---

## Scope

### In

- Shared W2-L3 live event and notification preference contracts, reusing existing `NOTIFICATION_PREFERENCES`.
- `notification_preferences` and `notification_digest_items` schema, migration, services, and routes.
- Metadata-only hub live event publishing from hub emit/state/lifecycle/bulk/undo/reconcile paths.
- Hub-event delivery filtering in the existing WebSocket server.
- Inbox Hub invalidation from the existing `LiveUpdatesProvider`.
- Client-side toast bridge from authorized hub rows.
- Notification preferences controls in the existing Hub settings shell.
- Unit, integration, UI, and Playwright e2e verification.

### Out

- W3 Autopilot, W4 Steward, W5 adapter bridges, email delivery, second notification store, second toast system.

## Review Changes Applied

An independent Codex plan review found several real issues in the first draft.
This plan incorporates the fixes:

- Reuses existing `NOTIFICATION_PREFERENCES` instead of adding a second delivery-mode contract.
- Extends `LiveUpdatesProvider` instead of opening a second company WebSocket.
- Adds WebSocket-side RBAC filtering before delivering `hub.item.changed` metadata.
- Blocks hub events from agent sockets because the hub is a human attention plane.
- Adds RBAC-scoped `GET /hub-items/:id` hydration for toast content.
- Uses a partial unique index for pending digest rows so acknowledged rows can be queued again.
- Adds activity logging requirements for preference mutations and digest ack.
- Adds digest summary UI so the e2e can verify digest behavior honestly.
- Adds invalid timezone and corrupt persisted preference tests.

## File Map

- Modify `packages/shared/src/constants.ts`: add live event types and digest cadence constants; reuse existing `NOTIFICATION_PREFERENCES`.
- Modify `packages/shared/src/types/live.ts`: add typed hub live event payloads.
- Create `packages/shared/src/notification-preferences.ts`: defaults, normalizers, zod schemas.
- Modify `packages/shared/src/index.ts`: export notification preference helpers.
- Modify `packages/shared/src/__tests__/constants.test.ts`: contract tests.
- Create `packages/shared/src/__tests__/notification-preferences.test.ts`: validator/default tests.
- Create `packages/db/src/schema/notification_preferences.ts`: per-user preferences table.
- Create `packages/db/src/schema/notification_digest_items.ts`: per-user digest queue table.
- Modify `packages/db/src/schema/index.ts`: export new schema.
- Modify `packages/db/src/__tests__/hub-items-schema.test.ts`: schema export/index tests.
- Run `corepack pnpm@9.15.4 db:generate`: create Drizzle migration.
- Create `server/src/services/notification-preferences.ts`: get/upsert/reset defaults.
- Create `server/src/services/notification-digest.ts`: queue/list/ack digest items.
- Modify `server/src/services/index.ts`: export new services.
- Create `server/src/routes/notification-preferences.ts`: preference and digest routes.
- Modify `server/src/app.ts`: import and mount `notificationPreferenceRoutes(db)` next to `notificationRoutes(db)`.
- Modify `server/src/services/hub-items.ts`: publish metadata-only live events and enqueue digest candidates.
- Modify `server/src/routes/hub-items.ts`: add RBAC-scoped `GET /companies/:companyId/hub-items/:id` hydration route.
- Create `server/src/__tests__/notification-preferences.test.ts`: route/service tests.
- Create `server/src/__tests__/notification-digest.test.ts`: digest queue tests.
- Modify `server/src/__tests__/hub-items-emit.integration.test.ts`: publish payload tests.
- Modify `server/src/__tests__/hub-items-lifecycle.test.ts`: lifecycle publish tests.
- Modify `ui/src/context/LiveUpdatesProvider.tsx`: handle hub live events in the existing company WebSocket provider.
- Modify or create `ui/src/context/__tests__/LiveUpdatesProvider.test.tsx`: provider live-event tests.
- Modify `ui/src/lib/queryKeys.ts`: notification preference/digest query keys.
- Modify `ui/src/api/hub-items.ts`: notification preference and digest client methods.
- Create `ui/src/lib/hub-toast-bridge.ts`: pure toast decision helpers.
- Create `ui/src/lib/__tests__/hub-toast-bridge.test.ts`: decision tests.
- Modify `ui/src/pages/InboxHub.tsx`: hook up realtime invalidation and toast bridge.
- Modify `ui/src/components/hub/HubShell.tsx`: active notification settings panel.
- Modify `ui/src/components/hub/__tests__/HubShell.test.tsx`: settings tests.
- Modify `ui/src/__tests__/InboxHub.test.tsx`: realtime/toast behavior tests.
- Create `tests/e2e/inbox-hub-realtime-notifications.spec.ts`: full operator flow.
- Modify `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`: mark W2-L3 active/in PR.

---

## Task 1: Shared W2-L3 Contracts

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types/live.ts`
- Create: `packages/shared/src/notification-preferences.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/__tests__/constants.test.ts`
- Create: `packages/shared/src/__tests__/notification-preferences.test.ts`

- [ ] **Step 1: Write failing constants tests**

Add tests asserting the new constants exist and are literal-stable:

```ts
import {
  LIVE_EVENT_TYPES,
  NOTIFICATION_PREFERENCES,
  NOTIFICATION_DIGEST_CADENCES,
} from "../constants";

it("includes metadata-only hub live event types", () => {
  expect(LIVE_EVENT_TYPES).toContain("hub.item.changed");
  expect(LIVE_EVENT_TYPES).toContain("hub.counts.changed");
  expect(LIVE_EVENT_TYPES).toContain("hub.digest.changed");
});

it("exposes W2-L3 notification preference modes", () => {
  expect(NOTIFICATION_PREFERENCES).toEqual(["silent", "digest", "realtime"]);
  expect(NOTIFICATION_DIGEST_CADENCES).toEqual(["daily"]);
});
```

- [ ] **Step 2: Run constants tests and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run packages/shared/src/__tests__/constants.test.ts
```

Expected: FAIL because `NOTIFICATION_DIGEST_CADENCES` and the hub live event constants do not exist yet.

- [ ] **Step 3: Add constants and live payload types**

Add to `packages/shared/src/constants.ts`:

```ts
export const NOTIFICATION_DIGEST_CADENCES = ["daily"] as const;
export type NotificationDigestCadence = (typeof NOTIFICATION_DIGEST_CADENCES)[number];
```

Extend `LIVE_EVENT_TYPES` with:

```ts
"hub.item.changed",
"hub.counts.changed",
"hub.digest.changed",
```

Add to `packages/shared/src/types/live.ts`:

```ts
import type { HubItemStatus, HubLane, HubSemanticType } from "../hub.js";

export interface HubItemChangedLivePayload {
  itemId: string;
  semanticType: HubSemanticType;
  lane: HubLane;
  status: HubItemStatus;
  version: number;
  change: "created" | "updated" | "state_changed" | "resolved" | "archived";
}

export interface HubCountsChangedLivePayload {
  reason: "item_changed" | "personal_state_changed" | "digest_changed";
}

export interface HubDigestChangedLivePayload {
  reason: "queued" | "acked";
}
```

- [ ] **Step 4: Write failing preference schema tests**

Create `packages/shared/src/__tests__/notification-preferences.test.ts`:

```ts
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  notificationPreferencesSchema,
  updateNotificationPreferencesSchema,
} from "../notification-preferences";

it("returns realtime toast defaults for every semantic type", () => {
  expect(DEFAULT_NOTIFICATION_PREFERENCES.rules.length).toBeGreaterThan(0);
  expect(DEFAULT_NOTIFICATION_PREFERENCES.rules.every((rule) => rule.deliveryMode === "realtime")).toBe(true);
  expect(DEFAULT_NOTIFICATION_PREFERENCES.rules.every((rule) => rule.toastEnabled === true)).toBe(true);
});

it("rejects duplicate semantic type rules", () => {
  const [first] = DEFAULT_NOTIFICATION_PREFERENCES.rules;
  expect(() =>
    updateNotificationPreferencesSchema.parse({
      rules: [first, first],
    }),
  ).toThrow(/duplicate/i);
});

it("rejects invalid quiet-hours clock values", () => {
  expect(() =>
    notificationPreferencesSchema.parse({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      quietHours: { enabled: true, start: "25:00", end: "09:00", timezone: "UTC" },
    }),
  ).toThrow();
});

it("rejects invalid IANA timezones", () => {
  expect(() =>
    notificationPreferencesSchema.parse({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      quietHours: { enabled: true, start: "18:00", end: "09:00", timezone: "Mars/Base" },
    }),
  ).toThrow(/timezone/i);
});

it("requires complete nested quiet-hours objects in patches", () => {
  expect(() =>
    updateNotificationPreferencesSchema.parse({
      quietHours: { enabled: true },
    }),
  ).toThrow();
});
```

- [ ] **Step 5: Run preference schema tests and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run packages/shared/src/__tests__/notification-preferences.test.ts
```

Expected: FAIL because `notification-preferences.ts` does not exist.

- [ ] **Step 6: Implement preference schemas and exports**

Create `packages/shared/src/notification-preferences.ts` with:

```ts
import { z } from "zod";
import { HUB_SEMANTIC_TYPES } from "./hub.js";
import {
  NOTIFICATION_PREFERENCES,
  type NotificationPreference,
  NOTIFICATION_DIGEST_CADENCES,
  type NotificationDigestCadence,
} from "./constants.js";
import type { HubSemanticType } from "./hub.js";

const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezoneSchema = z.string().min(1).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}, { message: "Invalid IANA timezone" });

export interface NotificationPreferenceRule {
  semanticType: HubSemanticType;
  deliveryMode: NotificationPreference;
  toastEnabled: boolean;
}

export interface NotificationPreferences {
  rules: NotificationPreferenceRule[];
  quietHours: { enabled: boolean; start: string; end: string; timezone: string };
  digest: { enabled: boolean; cadence: NotificationDigestCadence };
  updatedAt: string | null;
}

export const notificationPreferenceRuleSchema = z.object({
  semanticType: z.enum(HUB_SEMANTIC_TYPES),
  deliveryMode: z.enum(NOTIFICATION_PREFERENCES),
  toastEnabled: z.boolean(),
});

export const notificationPreferencesSchema = z.object({
  rules: z.array(notificationPreferenceRuleSchema).superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (const rule of rules) {
      if (seen.has(rule.semanticType)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate rule for ${rule.semanticType}` });
      }
      seen.add(rule.semanticType);
    }
  }),
  quietHours: z.object({
    enabled: z.boolean(),
    start: clockSchema,
    end: clockSchema,
    timezone: timezoneSchema,
  }),
  digest: z.object({
    enabled: z.boolean(),
    cadence: z.enum(NOTIFICATION_DIGEST_CADENCES),
  }),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
});

export const updateNotificationPreferencesSchema = notificationPreferencesSchema
  .omit({ updatedAt: true })
  .partial();

export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  rules: HUB_SEMANTIC_TYPES.map((semanticType) => ({
    semanticType,
    deliveryMode: "realtime",
    toastEnabled: true,
  })),
  quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
  digest: { enabled: true, cadence: "daily" },
  updatedAt: null,
};
```

Export from `packages/shared/src/index.ts`:

```ts
export * from "./notification-preferences.js";
```

- [ ] **Step 7: Run shared tests and commit**

Run:

```sh
corepack pnpm@9.15.4 test:run packages/shared/src/__tests__/constants.test.ts packages/shared/src/__tests__/notification-preferences.test.ts
```

Expected: PASS.

Commit:

```sh
git add packages/shared/src/constants.ts packages/shared/src/types/live.ts packages/shared/src/notification-preferences.ts packages/shared/src/index.ts packages/shared/src/__tests__/constants.test.ts packages/shared/src/__tests__/notification-preferences.test.ts
git commit -m "feat(shared): add W2 layer 3 notification contracts"
```

---

## Task 2: Notification Preferences And Digest Schema

**Files:**
- Create: `packages/db/src/schema/notification_preferences.ts`
- Create: `packages/db/src/schema/notification_digest_items.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/__tests__/hub-items-schema.test.ts`
- Create: generated files under `packages/db/src/migrations/`

- [ ] **Step 1: Write failing schema export tests**

Extend `packages/db/src/__tests__/hub-items-schema.test.ts`:

```ts
import { notificationPreferences } from "../schema/notification_preferences";
import { notificationDigestItems } from "../schema/notification_digest_items";

it("exports W2-L3 notification preference and digest tables", () => {
  expect(notificationPreferences).toBeDefined();
  expect(notificationDigestItems).toBeDefined();
});
```

- [ ] **Step 2: Run schema test and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run packages/db/src/__tests__/hub-items-schema.test.ts
```

Expected: FAIL because the schema files do not exist.

- [ ] **Step 3: Add schema files**

Create `notification_preferences.ts`:

```ts
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { NotificationPreferenceRule } from "@armyofagents/shared";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    rules: jsonb("rules").$type<NotificationPreferenceRule[]>().notNull(),
    quietHours: jsonb("quiet_hours").$type<{ enabled: boolean; start: string; end: string; timezone: string }>().notNull(),
    digest: jsonb("digest").$type<{ enabled: boolean; cadence: "daily" }>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("notification_preferences_company_idx").on(table.companyId),
    userIdx: index("notification_preferences_user_idx").on(table.userId),
    userCompanyUq: uniqueIndex("notification_preferences_user_company_uq").on(table.userId, table.companyId),
  }),
);
```

Create `notification_digest_items.ts`:

```ts
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { hubItems } from "./notifications.js";

export const notificationDigestItems = pgTable(
  "notification_digest_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    hubItemId: uuid("hub_item_id").notNull().references(() => hubItems.id, { onDelete: "cascade" }),
    semanticType: text("semantic_type").notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (table) => ({
    companyUserIdx: index("notification_digest_items_company_user_idx").on(table.companyId, table.userId),
    pendingIdx: index("notification_digest_items_pending_idx").on(table.companyId, table.userId, table.ackedAt),
    uniquePendingItem: uniqueIndex("notification_digest_items_pending_item_uq")
      .on(table.companyId, table.userId, table.hubItemId)
      .where(sql`${table.ackedAt} is null`),
  }),
);
```

Export both from `packages/db/src/schema/index.ts`.

- [ ] **Step 4: Generate migration**

Run:

```sh
corepack pnpm@9.15.4 db:generate
```

Expected: migration generated for both new tables.

- [ ] **Step 5: Run schema tests and typecheck db package**

Run:

```sh
corepack pnpm@9.15.4 test:run packages/db/src/__tests__/hub-items-schema.test.ts
corepack pnpm@9.15.4 --filter @armyofagents/db typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/db/src/schema/notification_preferences.ts packages/db/src/schema/notification_digest_items.ts packages/db/src/schema/index.ts packages/db/src/migrations packages/db/src/__tests__/hub-items-schema.test.ts
git commit -m "feat(db): add notification preferences and digest tables"
```

---

## Task 3: Preferences And Digest Services + Routes

**Files:**
- Create: `server/src/services/notification-preferences.ts`
- Create: `server/src/services/notification-digest.ts`
- Modify: `server/src/services/index.ts`
- Create: `server/src/routes/notification-preferences.ts`
- Modify: `server/src/app.ts`
- Create: `server/src/__tests__/notification-preferences.test.ts`
- Create: `server/src/__tests__/notification-digest.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `server/src/__tests__/notification-preferences.test.ts` with tests for:

```ts
it("GET preferences/me returns defaults for the current board user", async () => {
  const res = await request(app).get(`/api/companies/${COMPANY_A}/notifications/preferences/me`);
  expect(res.status).toBe(200);
  expect(res.body.rules.length).toBeGreaterThan(0);
  expect(res.body.quietHours.enabled).toBe(false);
});

it("PATCH preferences/me rejects duplicate rules", async () => {
  const first = DEFAULT_NOTIFICATION_PREFERENCES.rules[0]!;
  const res = await request(app)
    .patch(`/api/companies/${COMPANY_A}/notifications/preferences/me`)
    .send({ rules: [first, first] });
  expect(res.status).toBe(400);
});

it("PATCH preferences/me logs an activity row", async () => {
  await request(app)
    .patch(`/api/companies/${COMPANY_A}/notifications/preferences/me`)
    .send({ digest: { enabled: true, cadence: "daily" } })
    .expect(200);
  const rows = await db.select().from(activityLog).where(eq(activityLog.action, "notification_preferences.updated"));
  expect(rows).toHaveLength(1);
});

it("reset restores defaults after an update", async () => {
  await request(app)
    .patch(`/api/companies/${COMPANY_A}/notifications/preferences/me`)
    .send({ quietHours: { enabled: true, start: "18:00", end: "09:00", timezone: "UTC" } })
    .expect(200);
  const res = await request(app).post(`/api/companies/${COMPANY_A}/notifications/preferences/me/reset`).send({});
  expect(res.status).toBe(200);
  expect(res.body.quietHours.enabled).toBe(false);
});
```

Create `server/src/__tests__/notification-digest.test.ts` with tests for:

```ts
it("lists only pending digest rows visible to the current user", async () => {
  const res = await request(app).get(`/api/companies/${COMPANY_A}/notifications/digest/me`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.items)).toBe(true);
});

it("does not return digest rows for hub items hidden by hub RBAC", async () => {
  const res = await request(app).get(`/api/companies/${COMPANY_A}/notifications/digest/me`);
  expect(res.body.items.every((item: { ownerUserId: string | null }) => item.ownerUserId !== OTHER_USER_ID)).toBe(true);
});

it("ack marks current user's pending digest rows as acknowledged", async () => {
  const res = await request(app).post(`/api/companies/${COMPANY_A}/notifications/digest/me/ack`).send({});
  expect(res.status).toBe(200);
  expect(res.body.acked).toEqual(expect.any(Number));
});

it("ack logs an activity row", async () => {
  await request(app).post(`/api/companies/${COMPANY_A}/notifications/digest/me/ack`).send({}).expect(200);
  const rows = await db.select().from(activityLog).where(eq(activityLog.action, "notification_digest.acked"));
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 2: Run route tests and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/notification-preferences.test.ts server/src/__tests__/notification-digest.test.ts
```

Expected: FAIL because routes/services are missing.

- [ ] **Step 3: Implement services**

`notification-preferences.ts` mirrors `hub-preferences.ts`: read row, normalize through shared schema/defaults, upsert merged patch, reset to defaults, and normalize corrupt persisted JSON back to defaults on read rather than returning invalid preference shapes.

Required exports:

```ts
export function notificationPreferencesService(db: Db) {
  return {
    get(userId: string, companyId: string): Promise<NotificationPreferences>;
    upsert(userId: string, companyId: string, patch: UpdateNotificationPreferencesInput): Promise<NotificationPreferences>;
    reset(userId: string, companyId: string): Promise<NotificationPreferences>;
  };
}
```

`notification-digest.ts` required exports:

```ts
export function notificationDigestService(db: Db) {
  return {
    queueForUser(args: { companyId: string; userId: string; hubItemId: string; semanticType: HubSemanticType }): Promise<void>;
    listForUser(args: { companyId: string; userId: string; role?: UserRole }): Promise<{ items: HubListRow[] }>;
    ackForUser(args: { companyId: string; userId: string }): Promise<{ acked: number }>;
  };
}
```

Implementation rules:

- `queueForUser` uses `onConflictDoNothing` against the partial pending unique index `(companyId,userId,hubItemId) WHERE acked_at IS NULL`, so an acknowledged digest item can be queued again later.
- `listForUser` joins through visible hub items or calls `hubItemsService.query`/`getVisible` so visibility is enforced before rows return.
- `ackForUser` updates only rows for `(companyId,userId)` where `ackedAt IS NULL`.
- Preference updates, preference resets, and digest ack write activity rows with actions `notification_preferences.updated`, `notification_preferences.reset`, and `notification_digest.acked`.
- Invalid persisted JSON rows are covered by a service test that inserts malformed JSON through the DB helper and verifies `get()` returns `DEFAULT_NOTIFICATION_PREFERENCES`.

- [ ] **Step 4: Implement routes**

Create `server/src/routes/notification-preferences.ts` with board-only routes:

```ts
router.get("/companies/:companyId/notifications/preferences/me", async (req, res) => {});
router.patch("/companies/:companyId/notifications/preferences/me", validate(updateNotificationPreferencesSchema), async (req, res) => {});
router.post("/companies/:companyId/notifications/preferences/me/reset", async (req, res) => {});
router.get("/companies/:companyId/notifications/digest/me", async (req, res) => {});
router.post("/companies/:companyId/notifications/digest/me/ack", async (req, res) => {});
```

Each route calls `assertCompanyAccess(req, companyId)` and a local `requireBoardUserId` helper copied from `hub-items.ts`.

- [ ] **Step 5: Mount routes and export services**

Add service exports to `server/src/services/index.ts`.

In `server/src/app.ts`, import `notificationPreferenceRoutes` from
`./routes/notification-preferences.js` and mount it near the existing
`api.use(notificationRoutes(db))` call:

```ts
api.use(notificationPreferenceRoutes(db));
api.use(notificationRoutes(db));
```

- [ ] **Step 6: Run route tests and commit**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/notification-preferences.test.ts server/src/__tests__/notification-digest.test.ts
```

Expected: PASS.

Commit:

```sh
git add server/src/services/notification-preferences.ts server/src/services/notification-digest.ts server/src/services/index.ts server/src/routes/notification-preferences.ts server/src/__tests__/notification-preferences.test.ts server/src/__tests__/notification-digest.test.ts
git commit -m "feat(server): add notification preferences and digest routes"
```

---

## Task 4: Metadata-Only Hub Live Publishing

**Files:**
- Modify: `server/src/services/hub-items.ts`
- Modify: `server/src/routes/hub-items.ts`
- Modify: `server/src/realtime/live-events-ws.ts`
- Modify: `server/src/__tests__/hub-items-emit.integration.test.ts`
- Modify: `server/src/__tests__/hub-items-lifecycle.test.ts`
- Modify: `server/src/__tests__/hub-items-action.integration.test.ts`
- Modify or create: `server/src/__tests__/hub-live-events-ws.test.ts`

- [ ] **Step 1: Write failing emit live-event test**

In `hub-items-emit.integration.test.ts`, spy/mock `publishLiveEvent` and assert:

```ts
it("publishes metadata-only hub item changed events after emit", async () => {
  const item = await svc.emit(validEmitArgs);
  expect(publishLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
    companyId: item.companyId,
    type: "hub.item.changed",
    payload: expect.objectContaining({
      itemId: item.id,
      semanticType: item.semanticType,
      lane: item.lane,
      status: item.status,
      version: item.version,
      change: expect.stringMatching(/created|updated/),
    }),
  }));
  const payload = vi.mocked(publishLiveEvent).mock.calls[0]![0].payload as Record<string, unknown>;
  expect(payload.title).toBeUndefined();
  expect(payload.summary).toBeUndefined();
  expect(payload.message).toBeUndefined();
  expect(payload.relatedEntityId).toBeUndefined();
  expect(payload.sourceId).toBeUndefined();
});
```

- [ ] **Step 2: Run emit test and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-items-emit.integration.test.ts
```

Expected: FAIL because hub emits do not publish live events yet.

- [ ] **Step 3: Add live publish helpers**

In `hub-items.ts`, import `publishLiveEvent` and add private helpers:

```ts
function publishHubItemChanged(item: { companyId: string; id: string; semanticType: string | null; status: string; version: number }, change: HubItemChangedLivePayload["change"]) {
  if (!item.semanticType) return;
  publishLiveEvent({
    companyId: item.companyId,
    type: "hub.item.changed",
    payload: {
      itemId: item.id,
      semanticType: item.semanticType as HubSemanticType,
      lane: laneForSemanticType(item.semanticType as HubSemanticType),
      status: item.status as HubItemStatus,
      version: item.version,
      change,
    },
  });
}

function publishHubCountsChanged(companyId: string, reason: HubCountsChangedLivePayload["reason"]) {
  publishLiveEvent({ companyId, type: "hub.counts.changed", payload: { reason } });
}
```

Call helpers after successful mutations only when the service owns the committed
write (`a.executor` absent). For transaction-backed callers that pass a
transaction-like `executor`, do not publish from inside `emit`; publish from the
outer non-transactional caller after commit, or rely on the next query/count
refresh path. This prevents a live event for a row that later rolls back.

Call helpers after successful:

- `emit` returns row: change is `"created"` for new insert, `"updated"` for upsert refresh.
- `applyPersonalState`: `hub.counts.changed` with `"personal_state_changed"`.
- `recordLifecycleAction`: item change plus counts change.
- `undoAction`: item change plus counts change.
- `bulkAction`: publish per changed item and one counts change.
- `reconcile`/sweeper return paths: item change plus counts change.

- [ ] **Step 3b: Add WebSocket hub-event RBAC filtering**

In `server/src/realtime/live-events-ws.ts`, add a hub-event branch before the
generic company-wide send:

```ts
function isHubEvent(event: LiveEvent) {
  return event.type === "hub.item.changed" || event.type === "hub.counts.changed" || event.type === "hub.digest.changed";
}

function hubItemIdOf(event: LiveEvent) {
  const id = event.payload?.itemId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
```

Delivery rules:

- Agent WebSocket connections do not receive `hub.*` events.
- Authenticated board sockets receive `hub.item.changed` only if
  `hubItemsService(db).getVisible(companyId, { hubItemId, actorUserId, role, status: "any" })`
  returns a row.
- `local_trusted` synthetic board sockets may receive hub events because local
  trusted mode is a single-operator loopback boundary.
- `hub.counts.changed` and `hub.digest.changed` are sent only to board sockets;
  they carry no item id.

Add a WebSocket unit/integration test that verifies a team member socket does not
receive a founder-only item event, and an agent socket receives no `hub.*` event.

- [ ] **Step 3c: Expose RBAC-scoped single-item hydration**

Make `getVisible` part of the returned `hubItemsService` API. Add
`GET /companies/:companyId/hub-items/:id` before the existing `/:id/action`,
`/:id/undo`, `/:id/audit`, and `/:id/state` routes:

```ts
router.get("/companies/:companyId/hub-items/:id", async (req, res) => {
  const companyId = req.params.companyId as string;
  const hubItemId = req.params.id as string;
  assertCompanyAccess(req, companyId);
  const userId = requireBoardUserId(req);
  const role = await resolveRole(req, companyId, userId);
  const item = await svc.getVisible(companyId, {
    hubItemId,
    actorUserId: userId,
    role,
    status: "any",
  });
  if (!item) throw notFound("Hub item not found");
  res.json(item);
});
```

Add route tests proving founder-visible rows return `200` and RBAC-hidden rows
return `404`, not metadata.

- [ ] **Step 4: Add lifecycle tests**

In lifecycle/action tests, assert `resolve` emits:

```ts
expect(publishLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
  type: "hub.item.changed",
  payload: expect.objectContaining({ change: "resolved" }),
}));
expect(publishLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
  type: "hub.counts.changed",
}));
```

- [ ] **Step 5: Run focused server tests**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-items-emit.integration.test.ts server/src/__tests__/hub-items-lifecycle.test.ts server/src/__tests__/hub-items-action.integration.test.ts server/src/__tests__/hub-live-events-ws.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add server/src/services/hub-items.ts server/src/realtime/live-events-ws.ts server/src/__tests__/hub-items-emit.integration.test.ts server/src/__tests__/hub-items-lifecycle.test.ts server/src/__tests__/hub-items-action.integration.test.ts server/src/__tests__/hub-live-events-ws.test.ts
git commit -m "feat(hub): publish metadata-only realtime events"
```

---

## Task 5: Extend LiveUpdatesProvider For Hub Events

**Files:**
- Modify: `ui/src/context/LiveUpdatesProvider.tsx`
- Modify or create: `ui/src/context/__tests__/LiveUpdatesProvider.test.tsx`
- Modify: `ui/src/lib/queryKeys.ts`
- Modify: `ui/src/pages/InboxHub.tsx`
- Modify: `ui/src/__tests__/InboxHub.test.tsx`

- [ ] **Step 1: Write failing provider invalidation tests**

In the existing live updates provider test file, or a new `LiveUpdatesProvider.test.tsx` if no provider-level suite exists, mock a WebSocket message and assert that hub events invalidate the same query families the Hub page uses:

```ts
it("invalidates hub list and counts when a hub item event arrives", async () => {
  renderWithLiveUpdatesProvider();
  fakeSocket.emitMessage({
    id: 1,
    companyId: "company-1",
    type: "hub.item.changed",
    createdAt: new Date().toISOString(),
    payload: { itemId: "hub-1", semanticType: "reminder", lane: "notifications", status: "open", version: 1, change: "created" },
  });
  expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["hub-items", "company-1"] });
  expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.hubItems.counts("company-1") });
});

it("invalidates notification digest when a digest event arrives", async () => {
  renderWithLiveUpdatesProvider();
  fakeSocket.emitMessage({ id: 2, companyId: "company-1", type: "hub.digest.changed", createdAt: now, payload: { reason: "queued" } });
  expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.notifications.digest("company-1") });
});
```

- [ ] **Step 2: Run provider tests and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run ui/src/context/__tests__/LiveUpdatesProvider.test.tsx
```

Expected: FAIL because `LiveUpdatesProvider` does not handle `hub.*` events yet.

- [ ] **Step 3: Add query keys**

Add to `queryKeys`:

```ts
notifications: {
  preferences: (companyId: string) => ["notifications", companyId, "preferences"] as const,
  digest: (companyId: string) => ["notifications", companyId, "digest"] as const,
},
```

If an existing `queryKeys.notifications(companyId)` function exists, replace it with the object form and update its current callers to use `queryKeys.notifications.legacy(companyId)` or `queryKeys.notifications.list(companyId)` in the same commit. Do not leave two `notifications` keys with different shapes.

- [ ] **Step 4: Extend LiveUpdatesProvider**

In `handleLiveEvent` inside `ui/src/context/LiveUpdatesProvider.tsx`, add `hub.*` branches near the other company-wide invalidations:

```ts
if (event.type === "hub.item.changed") {
  queryClient.invalidateQueries({ queryKey: ["hub-items", expectedCompanyId] });
  queryClient.invalidateQueries({ queryKey: queryKeys.hubItems.counts(expectedCompanyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(expectedCompanyId) });
  notifyHubItemListeners(event.payload.itemId);
  return;
}

if (event.type === "hub.counts.changed") {
  queryClient.invalidateQueries({ queryKey: queryKeys.hubItems.counts(expectedCompanyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(expectedCompanyId) });
  return;
}

if (event.type === "hub.digest.changed") {
  queryClient.invalidateQueries({ queryKey: queryKeys.notifications.digest(expectedCompanyId) });
  return;
}
```

Extend `LiveUpdatesContextValue` with:

```ts
onHubItemChanged: (cb: (itemId: string) => void) => () => void;
```

Store listeners in a `useRef<Set<(itemId: string) => void>>()`.
`notifyHubItemListeners` validates that `event.payload.itemId` is a non-empty
string before calling listeners. This deliberately reuses the existing socket,
exponential backoff, reconnect suppression, online/offline handling, and toast
gate.

- [ ] **Step 5: Keep InboxHub focused**

Do not open a second WebSocket in `InboxHub.tsx`. InboxHub should only consume normal query data and notification preference/digest queries. Realtime invalidation belongs to `LiveUpdatesProvider`.

- [ ] **Step 6: Run UI focused tests and commit**

Run:

```sh
corepack pnpm@9.15.4 test:run ui/src/context/__tests__/LiveUpdatesProvider.test.tsx ui/src/__tests__/InboxHub.test.tsx
```

Expected: PASS.

Commit:

```sh
git add ui/src/context/LiveUpdatesProvider.tsx ui/src/context/__tests__/LiveUpdatesProvider.test.tsx ui/src/lib/queryKeys.ts ui/src/pages/InboxHub.tsx ui/src/__tests__/InboxHub.test.tsx
git commit -m "feat(ui): refresh Inbox Hub from live updates"
```

---

## Task 6: Toast Bridge Decision Logic

**Files:**
- Create: `ui/src/lib/hub-toast-bridge.ts`
- Create: `ui/src/lib/__tests__/hub-toast-bridge.test.ts`
- Modify: `ui/src/api/hub-items.ts`
- Modify: `server/src/routes/hub-items.ts`
- Modify: `ui/src/pages/InboxHub.tsx`
- Modify: `ui/src/__tests__/InboxHub.test.tsx`

- [ ] **Step 1: Write failing pure decision tests**

Create `hub-toast-bridge.test.ts`:

```ts
it("allows realtime toast when preference is realtime and toast is enabled", () => {
  expect(shouldToastHubItem({ item, preferences: realtimePrefs, now: noonUtc })).toEqual({ show: true });
});

it("suppresses digest and silent delivery", () => {
  expect(shouldToastHubItem({ item, preferences: digestPrefs, now: noonUtc }).show).toBe(false);
  expect(shouldToastHubItem({ item, preferences: silentPrefs, now: noonUtc }).show).toBe(false);
});

it("suppresses realtime during quiet hours", () => {
  expect(shouldToastHubItem({ item, preferences: quietPrefs, now: nightUtc }).show).toBe(false);
});
```

- [ ] **Step 2: Run decision tests and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run ui/src/lib/__tests__/hub-toast-bridge.test.ts
```

Expected: FAIL because bridge file is missing.

- [ ] **Step 3: Implement pure bridge helpers**

Create:

```ts
export function shouldToastHubItem(args: {
  item: Pick<HubItemListRow, "semanticType" | "id" | "version" | "status">;
  preferences: NotificationPreferences;
  now: Date;
}): { show: boolean; reason?: "digest" | "silent" | "quiet_hours" | "closed" } {}

export function buildHubToastInput(companyId: string, item: HubItemListRow): ToastInput {
  return {
    dedupeKey: `hub:${companyId}:${item.id}:${item.version}`,
    title: item.title,
    body: item.summary ?? undefined,
    tone: item.priority === "urgent" || item.priority === "high" ? "warn" : "info",
    action: { label: "Open", href: `/inbox/${laneSlugForItem(item)}/${item.id}` },
    meta: { ref: item.sourceType ?? item.semanticType },
  };
}
```

Quiet-hours logic handles same-day and overnight windows by converting current
time to minutes in the stored timezone through `Intl.DateTimeFormat`. Invalid
timezone values return `{ show: false, reason: "quiet_hours" }` and the settings
validator rejects them on save.

- [ ] **Step 4: Add API methods**

In `ui/src/api/hub-items.ts`, add:

```ts
export interface NotificationDigestResponse { items: HubItemListRow[]; }
export interface NotificationDigestAckResponse { acked: number; }

notificationPreferences: {
  get: (companyId: string) => api.get<NotificationPreferences>(`/companies/${companyId}/notifications/preferences/me`),
  update: (companyId: string, patch: UpdateNotificationPreferencesInput) => api.patch<NotificationPreferences>(`/companies/${companyId}/notifications/preferences/me`, patch),
  reset: (companyId: string) => api.post<NotificationPreferences>(`/companies/${companyId}/notifications/preferences/me/reset`, {}),
},
notificationDigest: {
  list: (companyId: string) => api.get<NotificationDigestResponse>(`/companies/${companyId}/notifications/digest/me`),
  ack: (companyId: string) => api.post<NotificationDigestAckResponse>(`/companies/${companyId}/notifications/digest/me/ack`, {}),
},
getOne: (companyId: string, itemId: string) =>
  api.get<HubItemListRow>(`/companies/${companyId}/hub-items/${itemId}`),
```

- [ ] **Step 5: Wire InboxHub toast bridge**

In `InboxHub.tsx`:

- query notification preferences;
- subscribe to authorized `hub.item.changed` item ids with `useLiveUpdates().onHubItemChanged`;
- call `hubItemsApi.getOne(companyId, itemId)` to hydrate the row through the RBAC route;
- call `shouldToastHubItem`;
- call `pushToast(buildHubToastInput(companyId, item))` only when allowed.

The bridge must not build toasts from live event payload text.

- [ ] **Step 6: Add InboxHub toast behavior tests**

Test realtime emits one toast and digest/silent do not:

```ts
expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
  dedupeKey: expect.stringContaining("hub:"),
  title: "Authorized row title",
}));
```

- [ ] **Step 7: Run UI tests and commit**

Run:

```sh
corepack pnpm@9.15.4 test:run ui/src/lib/__tests__/hub-toast-bridge.test.ts ui/src/__tests__/InboxHub.test.tsx
```

Expected: PASS.

Commit:

```sh
git add ui/src/lib/hub-toast-bridge.ts ui/src/lib/__tests__/hub-toast-bridge.test.ts ui/src/api/hub-items.ts ui/src/pages/InboxHub.tsx ui/src/__tests__/InboxHub.test.tsx
git commit -m "feat(ui): bridge hub notifications to toasts"
```

---

## Task 7: Notification Settings UI

**Files:**
- Modify: `ui/src/components/hub/HubShell.tsx`
- Modify: `ui/src/components/hub/__tests__/HubShell.test.tsx`
- Modify: `ui/src/pages/InboxHub.tsx`

- [ ] **Step 1: Write failing settings tests**

In `HubShell.test.tsx`:

```ts
it("opens notification preferences from hub settings", async () => {
  render(<HubShell {...propsWithNotificationPreferences} />);
  await user.click(screen.getByRole("button", { name: /settings/i }));
  await user.click(screen.getByRole("button", { name: /notification preferences/i }));
  expect(screen.getByRole("heading", { name: /notification preferences/i })).toBeInTheDocument();
});

it("changes a semantic type delivery mode", async () => {
  render(<HubShell {...propsWithNotificationPreferences} />);
  await user.selectOptions(screen.getByLabelText(/reminder delivery/i), "digest");
  expect(onUpdateNotificationPreferences).toHaveBeenCalledWith(expect.objectContaining({
    rules: expect.arrayContaining([expect.objectContaining({ semanticType: "reminder", deliveryMode: "digest" })]),
  }));
});
```

- [ ] **Step 2: Run settings tests and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run ui/src/components/hub/__tests__/HubShell.test.tsx
```

Expected: FAIL because the settings entry is disabled and props do not exist.

- [ ] **Step 3: Add HubShell props and panel**

Add props:

```ts
notificationPreferences?: NotificationPreferences;
notificationPreferencesPending?: boolean;
onUpdateNotificationPreferences?: (patch: UpdateNotificationPreferencesInput) => void;
onResetNotificationPreferences?: () => void;
digestItems?: HubItemListRow[];
onAckDigest?: () => void;
```

Replace the disabled entry with an active panel that renders:

- delivery mode `<select>` per semantic type;
- toast checkbox disabled unless delivery mode is `realtime`;
- quiet-hours checkbox/start/end/timezone;
- digest enabled checkbox;
- digest summary list from pending digest items;
- acknowledge digest button;
- reset button.

Keep the panel inside the existing settings drawer styling.

- [ ] **Step 4: Wire page mutations**

In `InboxHub.tsx`, create preference query/mutations using `hubItemsApi.notificationPreferences` and `queryKeys.notifications.preferences(companyId)`. Create digest list/ack queries using `hubItemsApi.notificationDigest` and `queryKeys.notifications.digest(companyId)`. Use optimistic update with rollback matching the existing W1d preferences mutation.

- [ ] **Step 5: Run UI tests and commit**

Run:

```sh
corepack pnpm@9.15.4 test:run ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/__tests__/InboxHub.test.tsx
```

Expected: PASS.

Commit:

```sh
git add ui/src/components/hub/HubShell.tsx ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/pages/InboxHub.tsx
git commit -m "feat(ui): add notification preferences controls"
```

---

## Task 8: Digest Queue Integration

**Files:**
- Modify: `server/src/services/hub-items.ts`
- Modify: `server/src/services/notification-digest.ts`
- Modify: `server/src/__tests__/notification-digest.test.ts`
- Modify: `server/src/__tests__/hub-items-emit.integration.test.ts`

- [ ] **Step 1: Write failing digest enqueue tests**

In `notification-digest.test.ts`:

```ts
it("queues digest delivery once for a user and hub item", async () => {
  await digest.queueForUser({ companyId, userId, hubItemId, semanticType: "reminder" });
  await digest.queueForUser({ companyId, userId, hubItemId, semanticType: "reminder" });
  const result = await digest.listForUser({ companyId, userId, role: "founder" });
  expect(result.items.filter((item) => item.id === hubItemId)).toHaveLength(1);
});
```

- [ ] **Step 2: Run digest tests and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/notification-digest.test.ts
```

Expected: FAIL until queue/list visibility is complete.

- [ ] **Step 3: Implement digest queue behavior**

After `hubItemsService.emit` creates/updates an item:

- resolve delivery candidates with the same visibility model used by hub queries:
  the resolved owner user, founders, team leads whose scope includes the item's
  `scopeKey`, and board-pool claimants where applicable;
- evaluate each candidate's preference and quiet-hours state independently;
- if `deliveryMode === "digest"`, queue a digest row for that candidate;
- if quiet hours are active and digest is enabled, queue a digest row for that candidate;
- if `deliveryMode === "silent"` or quiet-hours fallback is silent, do not queue.

Publish `hub.digest.changed` when a digest row is created or acknowledged.

- [ ] **Step 4: Run digest/server tests and commit**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/notification-digest.test.ts server/src/__tests__/hub-items-emit.integration.test.ts
```

Expected: PASS.

Commit:

```sh
git add server/src/services/hub-items.ts server/src/services/notification-digest.ts server/src/__tests__/notification-digest.test.ts server/src/__tests__/hub-items-emit.integration.test.ts
git commit -m "feat(notifications): queue digest delivery from hub emits"
```

---

## Task 9: E2E Flow And Roadmap Update

**Files:**
- Create: `tests/e2e/inbox-hub-realtime-notifications.spec.ts`
- Modify: `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`

- [x] **Step 1: Write Playwright e2e**

Create an e2e spec that:

1. opens Inbox Hub;
2. seeds or emits a notification-backed hub item through existing test helpers/API;
3. verifies the list/count updates without page reload;
4. verifies a realtime preference shows one toast;
5. switches the semantic type preference to digest;
6. emits another item and verifies no toast plus digest summary entry;
7. switches to silent and verifies no toast/digest entry;
8. enables quiet hours and verifies realtime falls back to digest.

- [x] **Step 2: Run e2e locally if supported**

Run:

```sh
corepack pnpm@9.15.4 test:e2e -- tests/e2e/inbox-hub-realtime-notifications.spec.ts
```

Expected: PASS. If Windows browser/server harness blocks locally, record the failure and rely on CI.

- [x] **Step 3: Update roadmap**

In `2026-06-29-inbox-hub-integration-roadmap.md`, update W2 Layer 3 status to active/in current PR and list W3/W4/W5 as next queue.

- [x] **Step 4: Commit**

```sh
git add tests/e2e/inbox-hub-realtime-notifications.spec.ts docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md
git commit -m "test(e2e): cover realtime notification hub flow"
```

---

## Task 10: Final Verification And PR Readiness

**Files:**
- No planned source edits unless verification exposes a real defect.

- [x] **Step 1: Run focused suites**

```sh
corepack pnpm@9.15.4 test:run packages/shared/src/__tests__/constants.test.ts packages/shared/src/__tests__/notification-preferences.test.ts
corepack pnpm@9.15.4 test:run packages/db/src/__tests__/hub-items-schema.test.ts
corepack pnpm@9.15.4 test:run server/src/__tests__/notification-preferences.test.ts server/src/__tests__/notification-digest.test.ts server/src/__tests__/hub-items-emit.integration.test.ts server/src/__tests__/hub-items-lifecycle.test.ts
corepack pnpm@9.15.4 test:run ui/src/context/__tests__/LiveUpdatesProvider.test.tsx ui/src/lib/__tests__/hub-toast-bridge.test.ts ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/__tests__/InboxHub.test.tsx
```

- [x] **Step 2: Run full required repo checks**

```sh
corepack pnpm@9.15.4 -r typecheck
corepack pnpm@9.15.4 test:run
corepack pnpm@9.15.4 build
```

- [x] **Step 3: Run e2e gate**

```sh
corepack pnpm@9.15.4 test:e2e -- tests/e2e/inbox-hub-realtime-notifications.spec.ts
```

- [x] **Step 4: Review diff for scope**

Run:

```sh
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- docs/aoa/plans/2026-06-30-w2-layer3-realtime-notifications-design.md docs/aoa/plans/2026-06-30-w2-layer3-realtime-notifications-plan.md
rg -n "autopilot|steward|adapter bridge|email" packages server ui tests docs/aoa/plans/2026-06-30-w2-layer3-realtime-notifications-plan.md
```

Expected: only explicit out-of-scope mentions in docs; no W3/W4/W5 implementation.

- [x] **Step 5: Request code review**

Use `superpowers:requesting-code-review` or `codex review` after implementation is complete. Fix all legitimate findings before PR handoff.

---

## Review Notes

- The live event payload intentionally excludes `title`, `summary`, `message`, `relatedEntityId`, and any source-specific body fields.
- Digest rows store hub item IDs and metadata only; display content is fetched through hub visibility checks.
- The first preference granularity is `HubSemanticType`; category-level grouping can be added later without changing this stored rule contract.
- The WebSocket transport is reused; no SSE endpoint is introduced.
