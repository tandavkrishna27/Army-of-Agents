# Marketplace P1 Bug Fixes — Round 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two P1 bugs found by Codex in the second review of PR #94: (1) idempotency-key constraint collision after the 24h window expires, and (2) the `decision === "request"` RBAC path returns 202 without persisting anything or notifying founders.

**Architecture:** Bug 1 — `createOperation` in `operation-store.ts` does a plain insert with no conflict handling, but the schema has an unbounded unique index; fix adds `.onConflictDoNothing().returning()` with a fallback fetch-and-return. Bug 2 — the `decision === "request"` branch in `marketplace-installs.ts` must persist a "requested" operation row and fire `marketplaceNotifications.installRequested` before returning 202.

**Tech Stack:** TypeScript, Drizzle ORM, Express 5.x, Vitest.

---

## File Map

| File | Change |
|------|--------|
| `server/src/services/marketplace-install/operation-store.ts` | Add conflict handling to `createOperation` — `.onConflictDoNothing().returning()` + fetch-existing fallback |
| `server/src/routes/marketplace-installs.ts` | In `decision === "request"` branch: persist operation row + fire `installRequested` notification |
| `server/src/__tests__/marketplace-operation-store.test.ts` | **Create** — unit tests for `createOperation` conflict path |
| `server/src/__tests__/marketplace-installs-request.test.ts` | **Create** — unit tests for `resolveInstallDecision` + the "request" route branch |

---

## Task 1: Fix `createOperation` — handle idempotency-key constraint collision

**Context:**
The DB has an unbounded unique index on `(companyId, idempotencyKey)` in `marketplace_install_operations`. `findExistingByIdempotencyKey` only searches within a 24h window (`gt(createdAt, cutoff)`). After 24h, it returns `null`, so `startInstallOperation` calls `createOperation`, which does a plain `.insert().returning()`. That insert hits the stale unique row → constraint violation → 500 error.

Fix: change `createOperation` to `.onConflictDoNothing().returning()`. If the insert returns empty (conflict), fetch the existing row by `(companyId, idempotencyKey)` and return it. This makes repeated calls safe at all ages, not just within 24h.

**Files:**
- Modify: `server/src/services/marketplace-install/operation-store.ts:76-90`
- Create: `server/src/__tests__/marketplace-operation-store.test.ts`

- [ ] **Step 1: Write the failing test (conflict path)**

Create `server/src/__tests__/marketplace-operation-store.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { marketplaceInstallOperations: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  gt: () => Symbol("gt"),
}));

import { createOperation } from "../services/marketplace-install/operation-store.js";
import type { CreateOperationInput } from "../services/marketplace-install/operation-store.js";
import type { CatalogItem } from "@armyofagents/shared";

const SKILL_ITEM: CatalogItem = {
  id: "skill:aoa-curated/code-review",
  type: "skill",
  name: "Code Review",
  description: "...",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

const EXISTING_ROW = {
  id: "existing-op-uuid",
  companyId: "c1",
  catalogItemId: "skill:aoa-curated/code-review",
  itemType: "skill" as const,
  targetDepartmentId: null,
  status: "success" as const,
  resultEntityId: "skill-uuid-1",
  errorMessage: null,
  cascadeResults: null,
  idempotencyKey: "idem-key-1",
  requestedByUserId: "user-1",
  startedAt: new Date("2026-04-01T00:00:00Z"),
  completedAt: new Date("2026-04-01T00:01:00Z"),
  createdAt: new Date("2026-04-01T00:00:00Z"),
};

const INPUT: CreateOperationInput = {
  companyId: "c1",
  catalogItem: SKILL_ITEM,
  idempotencyKey: "idem-key-1",
  requestedByUserId: "user-1",
};

describe("createOperation — conflict handling", () => {
  it("returns the new row when insert succeeds (happy path)", async () => {
    const NEW_ROW = { ...EXISTING_ROW, id: "new-op-uuid", createdAt: new Date() };
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([NEW_ROW]),
          }),
        }),
      }),
    };

    const result = await createOperation(db as any, INPUT);
    expect(result.id).toBe("new-op-uuid");
  });

  it("fetches and returns existing row when insert conflicts (stale idempotency key)", async () => {
    // Simulate: insert hits unique constraint → onConflictDoNothing returns []
    // Then: select by (companyId, idempotencyKey) returns the old row
    let selectCalled = false;
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([]), // conflict — empty
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => {
            selectCalled = true;
            return {
              limit: () => Promise.resolve([EXISTING_ROW]),
            };
          },
        }),
      }),
    };

    const result = await createOperation(db as any, INPUT);
    expect(selectCalled).toBe(true);
    expect(result.id).toBe("existing-op-uuid");
  });

  it("throws if insert conflicts and the fallback select finds nothing (extreme race)", async () => {
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([]), // conflict
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]), // gone — should not happen but be safe
          }),
        }),
      }),
    };

    await expect(createOperation(db as any, INPUT)).rejects.toThrow(
      /idempotency conflict.*not found/i,
    );
  });

  it("skips the fallback select when insert succeeds (no idempotencyKey provided)", async () => {
    const NEW_ROW = { ...EXISTING_ROW, id: "new-op-no-key", idempotencyKey: null };
    let selectCalled = false;
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([NEW_ROW]),
          }),
        }),
      }),
      select: () => {
        selectCalled = true;
        return {} as any;
      },
    };

    const inputNoKey: CreateOperationInput = { ...INPUT, idempotencyKey: undefined };
    const result = await createOperation(db as any, inputNoKey);
    expect(result.id).toBe("new-op-no-key");
    expect(selectCalled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-2.5\.claude\worktrees\marketplace-v1"
pnpm --filter server test -- --reporter=verbose marketplace-operation-store
```

Expected: 4 tests FAIL — `createOperation` does not yet have conflict handling.

- [ ] **Step 3: Implement the fix in `operation-store.ts`**

Replace lines 69-90 (the `createOperation` function) in `server/src/services/marketplace-install/operation-store.ts`.

Change the import line at the top from:
```typescript
import { eq, and, gt } from "drizzle-orm";
```
to:
```typescript
import { eq, and, gt } from "drizzle-orm";
```
(no change needed — `eq` and `and` already imported; they're needed for the fallback select)

Replace the `createOperation` function body:

```typescript
/**
 * Insert a new operation row in `pending` status.
 *
 * Uses `.onConflictDoNothing().returning()` so that a stale idempotency-key
 * row (past the 24h app-level window but still present in the DB's unbounded
 * unique index) does not cause a constraint violation. When the insert is
 * suppressed by the conflict, we fetch and return the existing row so the
 * caller gets a usable OperationRow regardless.
 */
export async function createOperation(db: Db, input: CreateOperationInput): Promise<OperationRow> {
  const [row] = await db
    .insert(marketplaceInstallOperations)
    .values({
      companyId: input.companyId,
      catalogItemId: input.catalogItem.id,
      itemType: input.catalogItem.type,
      targetDepartmentId: input.targetDepartmentId ?? null,
      status: "pending",
      idempotencyKey: input.idempotencyKey ?? null,
      requestedByUserId: input.requestedByUserId,
    })
    .onConflictDoNothing()
    .returning();

  if (row) return row as OperationRow;

  // Insert was suppressed by the unique index on (companyId, idempotencyKey).
  // Fetch the existing row so the caller gets a valid OperationRow back.
  const existing = await db
    .select()
    .from(marketplaceInstallOperations)
    .where(
      and(
        eq(marketplaceInstallOperations.companyId, input.companyId),
        eq(marketplaceInstallOperations.idempotencyKey, input.idempotencyKey!),
      ),
    )
    .limit(1);

  if (!existing[0]) {
    // Extremely unlikely race: another process deleted the row between our
    // insert conflict and this select. Throw so the caller can retry.
    throw new Error(
      `createOperation: idempotency conflict for key "${input.idempotencyKey}" but row not found — possible concurrent delete`,
    );
  }

  return existing[0] as OperationRow;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter server test -- --reporter=verbose marketplace-operation-store
```

Expected: 4 tests PASS.

- [ ] **Step 5: Run the full server test suite to check for regressions**

```bash
pnpm --filter server test
```

Expected: all tests pass (or same pre-existing failures as before this change).

- [ ] **Step 6: Commit**

```bash
git add "server/src/services/marketplace-install/operation-store.ts" \
        "server/src/__tests__/marketplace-operation-store.test.ts"
git commit -m "fix(marketplace): handle stale idempotency-key constraint in createOperation

After the 24h app-level window, findExistingByIdempotencyKey returns null
but the unique index (companyId, idempotencyKey) still holds the old row.
Plain insert would crash. Switch to onConflictDoNothing + fallback fetch
so repeated calls succeed regardless of row age."
```

---

## Task 2: Fix the `decision === "request"` route branch — persist + notify

**Context:**
When RBAC resolves to `"request"`, the route currently does:
```typescript
res.status(202).json({ queued: true, message: "..." });
return;
```
No operation row is created and no notification fires — founders never see the request.

Fix: before returning 202, call `startInstallOperation` to persist a `pending` operation row (so the founder can see it later via `GET /install/:operationId`), then fire `marketplaceNotifications.installRequested`. The notification is fire-and-forget (`.catch(logger.error)`) — same pattern used elsewhere in the orchestrator.

The response body should include `operationId` (not just `queued: true`) so the client can poll for status if needed.

**Files:**
- Modify: `server/src/routes/marketplace-installs.ts:157-164`
- Create: `server/src/__tests__/marketplace-installs-request.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/marketplace-installs-request.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { resolveInstallDecision, canInstallType } from "../routes/marketplace-installs.js";

// ─── Pure-function tests (no mocks needed) ───────────────────────────────────

describe("canInstallType", () => {
  it("founder can install anything", () => {
    expect(canInstallType("founder", "plugin", false)).toBe(true);
    expect(canInstallType("founder", "skill", false)).toBe(true);
  });

  it("team_lead can install skill/agent/team always", () => {
    expect(canInstallType("team_lead", "skill", false)).toBe(true);
    expect(canInstallType("team_lead", "agent", false)).toBe(true);
    expect(canInstallType("team_lead", "team", false)).toBe(true);
  });

  it("team_lead can only install plugin when allowTeamLeadPlugins=true", () => {
    expect(canInstallType("team_lead", "plugin", false)).toBe(false);
    expect(canInstallType("team_lead", "plugin", true)).toBe(true);
  });

  it("team_member cannot install anything via canInstallType", () => {
    expect(canInstallType("team_member", "skill", true)).toBe(false);
    expect(canInstallType("team_member", "plugin", true)).toBe(false);
  });
});

describe("resolveInstallDecision", () => {
  const settings = { allowTeamLeadPlugins: false, teamMemberCanRequestInstall: true };

  it("returns 'allow' for founder", () => {
    expect(resolveInstallDecision("founder", "skill", settings)).toBe("allow");
  });

  it("returns 'allow' for team_lead on skill", () => {
    expect(resolveInstallDecision("team_lead", "skill", settings)).toBe("allow");
  });

  it("returns 'request' for team_member when teamMemberCanRequestInstall=true", () => {
    expect(resolveInstallDecision("team_member", "skill", settings)).toBe("request");
  });

  it("returns 'deny' for team_member when teamMemberCanRequestInstall=false", () => {
    const noRequest = { ...settings, teamMemberCanRequestInstall: false };
    expect(resolveInstallDecision("team_member", "skill", noRequest)).toBe("deny");
  });

  it("returns 'deny' for team_lead trying plugin with allowTeamLeadPlugins=false", () => {
    // team_lead cannot install plugin when disabled AND is not team_member, so deny
    expect(resolveInstallDecision("team_lead", "plugin", settings)).toBe("deny");
  });
});

// ─── Route-level: request path persists + notifies ───────────────────────────

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { marketplaceInstallOperations: tableProxy, userRoles: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  isNull: () => Symbol("isNull"),
}));
vi.mock("../services/marketplace-install/index.js", () => ({
  startInstallOperation: vi.fn().mockResolvedValue({ id: "op-request-uuid", status: "pending" }),
  dispatchInstall: vi.fn(),
  installSkill: vi.fn(),
  installAgent: vi.fn(),
  installTeam: vi.fn(),
  installMarketplacePlugin: vi.fn(),
  findOperationById: vi.fn(),
  resolveInstallPlan: vi.fn(),
}));
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: {
    installRequested: vi.fn().mockResolvedValue(undefined),
    installCompleted: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: vi.fn().mockResolvedValue("team_member"),
  })),
}));
vi.mock("../services/marketplace-settings.js", () => ({
  marketplaceSettingsService: vi.fn(() => ({
    get: vi.fn().mockResolvedValue({
      allowTeamLeadPlugins: false,
      teamMemberCanRequestInstall: true,
    }),
  })),
}));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: { error: vi.fn() } }));

import { createMarketplaceInstallRouter } from "../routes/marketplace-installs.js";
import { startInstallOperation } from "../services/marketplace-install/index.js";
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
import express from "express";
import request from "supertest";

function buildApp() {
  const mockCatalogItem = {
    id: "skill:aoa-curated/code-review",
    type: "skill" as const,
    name: "Code Review",
    description: "...",
    version: "1.0.0",
    source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
    trust: { tier: "verified", source: "aoa-curated" },
    status: "active",
    addedAt: "2026-04-30T00:00:00Z",
    category: "engineering",
    tags: [],
  };
  const mockCatalog = {
    schemaVersion: "1.0.0",
    generatedAt: "2026-04-30T00:00:00Z",
    itemCount: 1,
    items: [mockCatalogItem],
  };
  const mockDb = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: "op-request-uuid", status: "pending" }]) }) }) }),
  };
  const mockCatalogService = { readCache: vi.fn().mockResolvedValue(mockCatalog) };
  const mockPluginLoader = {} as any;

  const app = express();
  app.use(express.json());

  // Attach a fake actor + params middleware (simulates assertBoard + assertCompanyAccess)
  app.use("/api/companies/:companyId/marketplace", (req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "cloud_auth",
      isInstanceAdmin: false,
      userId: "user-team-member",
    };
    next();
  });

  app.use(
    "/api/companies/:companyId/marketplace",
    createMarketplaceInstallRouter({
      db: mockDb as any,
      catalogService: mockCatalogService as any,
      pluginLoader: mockPluginLoader,
    }),
  );

  return app;
}

describe("POST /install — decision=request path", () => {
  it("returns 202 with operationId (not just queued:true)", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({ catalogItemId: "skill:aoa-curated/code-review" });

    expect(res.status).toBe(202);
    expect(res.body.operationId).toBe("op-request-uuid");
    expect(res.body.queued).toBe(true);
  });

  it("calls startInstallOperation to persist the pending row", async () => {
    vi.clearAllMocks();
    const app = buildApp();
    await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({ catalogItemId: "skill:aoa-curated/code-review" });

    expect(startInstallOperation).toHaveBeenCalledOnce();
  });

  it("fires installRequested notification for founders", async () => {
    vi.clearAllMocks();
    const app = buildApp();
    await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({ catalogItemId: "skill:aoa-curated/code-review" });

    expect(marketplaceNotifications.installRequested).toHaveBeenCalledOnce();
    const [, , itemName, requestingUserId] = vi.mocked(marketplaceNotifications.installRequested).mock.calls[0];
    expect(itemName).toBe("Code Review");
    expect(requestingUserId).toBe("user-team-member");
  });

  it("does NOT call dispatchInstall (request stays pending for founder review)", async () => {
    const { dispatchInstall } = await import("../services/marketplace-install/index.js");
    vi.clearAllMocks();
    const app = buildApp();
    await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({ catalogItemId: "skill:aoa-curated/code-review" });

    expect(dispatchInstall).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Install `supertest` if not already a dev dependency**

Check first:
```bash
pnpm --filter server list supertest 2>/dev/null | head -5
```

If missing:
```bash
pnpm --filter server add -D supertest @types/supertest
```

If already present, skip this step.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm --filter server test -- --reporter=verbose marketplace-installs-request
```

Expected: the `POST /install — decision=request path` describe block has 4 FAILING tests — `startInstallOperation` is never called, `installRequested` is never called, response has no `operationId`.

The pure-function tests (`canInstallType`, `resolveInstallDecision`) should PASS already.

- [ ] **Step 4: Implement the fix in `marketplace-installs.ts`**

In `server/src/routes/marketplace-installs.ts`, add the `marketplaceNotifications` import and update the `decision === "request"` block.

First, add the import at the top of the file (after the existing imports, around line 37):
```typescript
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
```

Then replace lines 158-164 (the `decision === "request"` branch):

**Before:**
```typescript
      if (decision === "request") {
        res.status(202).json({
          queued: true,
          message: "Install request submitted. A founder will review it.",
        });
        return;
      }
```

**After:**
```typescript
      if (decision === "request") {
        // Persist a pending operation row so the founder can review it,
        // then notify founders that a team member requested the install.
        const requestedOp = await startInstallOperation({
          request, catalogItem, companyId, requestedByUserId: userId, db,
        });
        void marketplaceNotifications
          .installRequested(db, companyId, catalogItem.name, userId)
          .catch((err) => logger.error({ err }, "marketplace installRequested notification failed"));
        res.status(202).json({
          queued: true,
          operationId: requestedOp.id,
          message: "Install request submitted. A founder will review it.",
        });
        return;
      }
```

Also add `logger` to the imports at the top of `marketplace-installs.ts` since it's now used:
```typescript
import { logger } from "../middleware/logger.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter server test -- --reporter=verbose marketplace-installs-request
```

Expected: all 7 tests PASS (4 route tests + 3 pure-function tests).

- [ ] **Step 6: Run the full server test suite**

```bash
pnpm --filter server test
```

Expected: all tests pass (or same pre-existing failures as before).

- [ ] **Step 7: Commit**

```bash
git add "server/src/routes/marketplace-installs.ts" \
        "server/src/__tests__/marketplace-installs-request.test.ts"
git commit -m "fix(marketplace): persist operation row + notify founders on install request

When decision=request, the route was returning 202 but never writing to DB
and never notifying founders. Add startInstallOperation + installRequested
notification before the early return so founders see the pending request."
```
