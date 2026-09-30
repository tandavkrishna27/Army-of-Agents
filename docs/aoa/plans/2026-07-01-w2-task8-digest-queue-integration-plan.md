# W2 Task 8 Digest Queue Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Queue digest deliveries automatically when hub items are emitted and a visible user's notification preferences call for digest delivery.

**Architecture:** Keep delivery decisions server-side in the hub emit path. `notificationDigestService.queueForUser` remains the idempotent persistence API, returns whether a pending row was newly created, and publishes `hub.digest.changed` from queue and ack operations when no caller transaction is supplied. `hubItemsService.emit` resolves visible human candidates, evaluates their preferences independently, and queues digest rows only for digest or quiet-hours fallback-to-digest delivery.

**Tech Stack:** Express service layer, Drizzle ORM, existing notification preference schemas, Vitest unit/integration tests, embedded Postgres integration harness.

---

## File Structure

- Modify: `server/src/services/notification-digest.ts`
  - Return `{ queued: boolean }` from `queueForUser`.
  - Accept optional `publish?: boolean` so transactional emit callers can suppress live events.
  - Publish `hub.digest.changed` with `{ reason: "queued" }` on new rows.
  - Publish `hub.digest.changed` with `{ reason: "acked" }` when ack updates at least one row.
- Modify: `server/src/services/hub-items.ts`
  - Add digest queue orchestration after successful emit persistence.
  - Resolve active human candidates from `company_memberships` and existing `permissionService` visibility semantics.
  - Evaluate `notificationPreferencesService.get(userId, companyId)` per candidate.
- Modify: `server/src/__tests__/notification-digest.test.ts`
  - Add service-level tests for idempotent queueing and publish-on-queue/ack behavior.
- Modify: `server/src/__tests__/hub-items-emit.integration.test.ts`
  - Add real-DB integration coverage proving emit queues digest rows for a digest-preferring visible user and does not queue for silent preferences.

---

## Task 1: Digest Service Queue Result And Live Events

**Files:**
- Modify: `server/src/services/notification-digest.ts`
- Modify: `server/src/__tests__/notification-digest.test.ts`

- [x] **Step 1: Write failing service tests**

Append a new `describe("notificationDigestService", ...)` block to `server/src/__tests__/notification-digest.test.ts`.

Use a lightweight fake DB that records insert/update calls:

```ts
const publishLiveEvent = vi.hoisted(() => vi.fn());

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent,
}));

function digestDb({
  insertReturning = [{ id: "digest-1" }],
  updateReturning = [{ id: "digest-1" }],
}: {
  insertReturning?: { id: string }[];
  updateReturning?: { id: string }[];
} = {}) {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue(insertReturning),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue(updateReturning),
        })),
      })),
    })),
  } as never;
}
```

Add tests:

```ts
it("reports whether queueForUser created a pending digest row", async () => {
  const created = await notificationDigestService(digestDb()).queueForUser({
    companyId: COMPANY_A,
    userId: "user-1",
    hubItemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    semanticType: "reminder",
  });
  const duplicate = await notificationDigestService(
    digestDb({ insertReturning: [] }),
  ).queueForUser({
    companyId: COMPANY_A,
    userId: "user-1",
    hubItemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    semanticType: "reminder",
  });

  expect(created).toEqual({ queued: true });
  expect(duplicate).toEqual({ queued: false });
});

it("publishes digest changed only when queue or ack changes rows", async () => {
  await notificationDigestService(digestDb()).queueForUser({
    companyId: COMPANY_A,
    userId: "user-1",
    hubItemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    semanticType: "reminder",
  });
  await notificationDigestService(digestDb({ insertReturning: [] })).queueForUser({
    companyId: COMPANY_A,
    userId: "user-1",
    hubItemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    semanticType: "reminder",
  });
  await notificationDigestService(digestDb()).ackForUser({
    companyId: COMPANY_A,
    userId: "user-1",
  });
  await notificationDigestService(digestDb({ updateReturning: [] })).ackForUser({
    companyId: COMPANY_A,
    userId: "user-1",
  });

  expect(publishLiveEvent).toHaveBeenCalledTimes(2);
  expect(publishLiveEvent).toHaveBeenCalledWith({
    companyId: COMPANY_A,
    type: "hub.digest.changed",
    payload: { reason: "queued" },
  });
  expect(publishLiveEvent).toHaveBeenCalledWith({
    companyId: COMPANY_A,
    type: "hub.digest.changed",
    payload: { reason: "acked" },
  });
});
```

- [x] **Step 2: Run digest tests and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/notification-digest.test.ts
```

Expected: FAIL because `queueForUser` currently returns `void`, does not call `.returning()`, and no digest live events are published.

- [x] **Step 3: Implement digest service changes**

In `server/src/services/notification-digest.ts`:

- Import `HubDigestChangedLivePayload` and `publishLiveEvent`.
- Change `queueForUser` args to include `publish?: boolean`.
- Chain `.returning({ id: notificationDigestItems.id })` after `.onConflictDoNothing()`.
- Return `{ queued: created.length > 0 }`.
- Publish when `args.publish !== false && created.length > 0`.
- In `ackForUser`, publish when `updated.length > 0`.

- [x] **Step 4: Run digest tests and verify GREEN**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/notification-digest.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit Task 1**

```sh
git add server/src/services/notification-digest.ts server/src/__tests__/notification-digest.test.ts
git commit -m "feat(notifications): publish digest queue changes"
```

---

## Task 2: Hub Emit Queues Digest Rows From Preferences

**Files:**
- Modify: `server/src/services/hub-items.ts`
- Modify: `server/src/__tests__/hub-items-emit.integration.test.ts`

- [x] **Step 1: Write failing emit integration tests**

In `server/src/__tests__/hub-items-emit.integration.test.ts`, add helpers:

```ts
async function seedUser(
  companyId: string,
  role: "founder" | "team_lead" | "team_member",
  projectId: string | null = null,
): Promise<string> {
  const userId = firstId(await db.execute(sql`
    INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at)
    VALUES (gen_random_uuid()::text, ${`${role}-${PORT}-${Math.random()}@hub.test`}, ${role}, false, now(), now())
    RETURNING id
  `));
  await db.execute(sql`
    INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at)
    VALUES (gen_random_uuid(), ${companyId}, 'user', ${userId}, ${role}, 'active', now(), now())
  `);
  await db.execute(sql`
    INSERT INTO user_roles (id, company_id, user_id, role, project_id)
    VALUES (gen_random_uuid(), ${companyId}, ${userId}, ${role}, ${projectId})
  `);
  return userId;
}

async function setNotificationRule(
  companyId: string,
  userId: string,
  deliveryMode: "realtime" | "digest" | "silent",
) {
  await db.execute(sql`
    INSERT INTO notification_preferences (id, user_id, company_id, rules, quiet_hours, digest, created_at, updated_at)
    VALUES (
      gen_random_uuid(),
      ${userId},
      ${companyId},
      ${JSON.stringify([{ semanticType: "approval_request", deliveryMode, toastEnabled: true }])}::jsonb,
      ${JSON.stringify({ enabled: false, start: "18:00", end: "09:00", timezone: "UTC" })}::jsonb,
      ${JSON.stringify({ enabled: true, cadence: "daily" })}::jsonb,
      now(),
      now()
    )
    ON CONFLICT (user_id, company_id) DO UPDATE SET
      rules = excluded.rules,
      quiet_hours = excluded.quiet_hours,
      digest = excluded.digest,
      updated_at = now()
  `);
}
```

Add tests:

```ts
it("queues digest delivery for a digest-preferring visible user when emitting a hub item", async () => {
  if (setupError) throw new Error(String(setupError));
  const { companyId, founderId } = await seedCompanyWithFounder();
  await setNotificationRule(companyId, founderId, "digest");

  const item = await hubItemsService(db).emit({
    companyId,
    semanticType: "approval_request",
    sourceType: "approval",
    sourceId: "digest-visible",
    title: "Needs digest",
    ownerUserId: founderId,
  });

  const rows = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM notification_digest_items
    WHERE company_id = ${companyId}
      AND user_id = ${founderId}
      AND hub_item_id = ${item.id}
      AND acked_at IS NULL
  `);
  expect(firstRow<{ n: number }>(rows).n).toBe(1);
});

it("does not queue digest delivery for silent preferences", async () => {
  if (setupError) throw new Error(String(setupError));
  const { companyId, founderId } = await seedCompanyWithFounder();
  await setNotificationRule(companyId, founderId, "silent");

  const item = await hubItemsService(db).emit({
    companyId,
    semanticType: "approval_request",
    sourceType: "approval",
    sourceId: "digest-silent",
    title: "Silent item",
    ownerUserId: founderId,
  });

  const rows = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM notification_digest_items
    WHERE company_id = ${companyId}
      AND user_id = ${founderId}
      AND hub_item_id = ${item.id}
  `);
  expect(firstRow<{ n: number }>(rows).n).toBe(0);
});
```

- [x] **Step 2: Run emit tests and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-items-emit.integration.test.ts
```

Expected on Linux: FAIL because emit does not queue digest rows. Expected on Windows: skipped by existing `describe.skipIf(process.platform === "win32")`; rely on service tests locally and CI for embedded Postgres.

- [x] **Step 3: Implement candidate and preference evaluation**

In `server/src/services/hub-items.ts`:

- Import `companyMemberships` from `@armyofagents/db`.
- Import `notificationDigestService` and `notificationPreferencesService`.
- Add a local helper `isQuietHoursActive(quietHours, now)` using `Intl.DateTimeFormat` with the configured timezone and same-day/overnight window logic matching `ui/src/lib/hub-toast-bridge.ts`.
- Add `findDigestCandidateUserIds(companyId, row)`:
  - select active user memberships in the company;
  - include founders;
  - include `row.ownerUserId`;
  - include `team_lead` users when `row.scopeKey` is in `permissionService(db).getTeamLeadDepartments(companyId, userId)`;
  - dedupe user ids.
- Add `queueDigestDeliveries(row, publish)`:
  - skip if `row.status !== "open"` or `!row.semanticType`;
  - for each candidate, read preferences;
  - find the matching rule for `row.semanticType`;
  - queue if `rule.deliveryMode === "digest"`;
  - queue if `rule.deliveryMode === "realtime"` and quiet hours are active and `preferences.digest.enabled`;
  - do not queue when `rule.deliveryMode === "silent"` or digest is disabled.
- Call `await queueDigestDeliveries(row, !a.executor)` after counter invalidation and before live item/count publish.

- [x] **Step 4: Run server tests and typecheck**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/notification-digest.test.ts server/src/__tests__/hub-items-emit.integration.test.ts
corepack pnpm@9.15.4 --filter @armyofagents/server typecheck
```

Expected: PASS. On Windows, the embedded Postgres emit integration remains skipped.

- [x] **Step 5: Commit Task 2**

```sh
git add server/src/services/hub-items.ts server/src/__tests__/hub-items-emit.integration.test.ts
git commit -m "feat(notifications): queue digest delivery from hub emits"
```

---

## Self-Review

- Spec coverage: Covers idempotent digest queueing, queue/list compatibility, digest changed live events for queue and ack, emit-driven preference evaluation, digest/silent behavior, and transactional live-event suppression.
- Placeholder scan: No placeholder implementation steps remain.
- Type consistency: Uses existing `NotificationPreferences`, `HubSemanticType`, `UserRole`, `notificationDigestItems`, `notificationPreferencesService`, and `notificationDigestService` names already present in the codebase.
