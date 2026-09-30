# M.4 Plugin Management — Post-Review Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 correctness bugs found in the M.4 code review and add 2 missing test cases covering critical business logic.

**Architecture:** Each fix is a targeted, minimal change to one or two files. Tasks 1–4 fix the bugs; Tasks 5–6 add the missing tests. All tasks are independent — each produces a clean commit.

**Tech Stack:** TypeScript, Vitest ^3.0.5, Drizzle ORM, Express 5.x

---

## File Map

| File | Change |
|------|--------|
| `server/src/services/plugin-lifecycle.ts` | Replace raw `db.insert(pluginVersionSnapshots)` with `pluginRollbackService(db).saveSnapshot()` |
| `server/src/services/plugin-registry.ts` | Add `companyId` filter to `nextInstallOrder()` |
| `server/src/routes/company-plugins.ts` | Two changes: (a) delete snapshot after successful auto-rollback; (b) parallelize GET / queries |
| `server/src/services/marketplace-update-checker.ts` | Export `checkPluginUpdates` for testability |
| `server/src/__tests__/plugin-lifecycle-upgrade.test.ts` | Add `upgrade()` state machine tests (2 new describe blocks) |
| `server/src/__tests__/marketplace-update-checker-plugins.test.ts` | Add `checkPluginUpdates` company-scoping test |

---

### Task 1: Fix snapshot trimming — use pluginRollbackService.saveSnapshot in lifecycle.upgrade()

**Bug:** `lifecycle.upgrade()` saves the rollback snapshot with a raw `db.insert()`, bypassing the `pluginRollbackService` trim logic. After 3 upgrades a plugin accumulates 3 snapshots; after N upgrades it accumulates N. The `MAX_SNAPSHOTS = 2` limit is never enforced.

**Files:**
- Modify: `server/src/services/plugin-lifecycle.ts:38-50` (imports section)
- Modify: `server/src/services/plugin-lifecycle.ts:673-679` (raw insert)
- Test: `server/src/__tests__/plugin-lifecycle-upgrade.test.ts`

- [ ] **Step 1: Write the failing test**

Add this block to `server/src/__tests__/plugin-lifecycle-upgrade.test.ts`. Place the new `vi.hoisted` call and `vi.mock` calls **before** the existing `describe("plugin lifecycle upgrade helpers"` block. The existing `diffCapabilities` tests remain unchanged.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks (vi.mock factories run before imports) ─────────────────────

const { mockSaveSnapshot, mockGetById, mockUpdateStatus } = vi.hoisted(() => {
  const basePlugin = {
    id: "plugin-1",
    pluginKey: "test.plugin",
    companyId: "co-a",
    status: "ready" as const,
    version: "1.0.0",
    packageName: "@test/plugin",
    manifestJson: { capabilities: ["tools.register"] },
    installOrder: 1,
    apiVersion: "1.0",
    categories: [],
    lastError: null,
    installedAt: new Date(),
    updatedAt: new Date(),
    catalogItemId: null,
    packagePath: null,
  };
  const mockSaveSnapshot = vi.fn().mockResolvedValue(undefined);
  const mockGetById = vi.fn().mockResolvedValue(basePlugin);
  const mockUpdateStatus = vi.fn().mockImplementation(
    async (_id: string, { status }: { status: string }) => ({ ...basePlugin, status }),
  );
  return { mockSaveSnapshot, mockGetById, mockUpdateStatus };
});

vi.mock("@armyofagents/db", () => ({
  plugins: new Proxy({}, { get: () => Symbol("col") }),
}));
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  asc: () => Symbol("asc"),
}));
vi.mock("../services/plugin-rollback.js", () => ({
  pluginRollbackService: () => ({ saveSnapshot: mockSaveSnapshot }),
}));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getById: mockGetById,
    updateStatus: mockUpdateStatus,
  }),
}));
vi.mock("../services/plugin-loader.js", () => ({ pluginLoader: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
  },
}));
```

Then add this new describe block **inside** the existing `describe("plugin lifecycle upgrade helpers"` — after the three `diffCapabilities` tests:

```typescript
  describe("upgrade() routes snapshot through pluginRollbackService", () => {
    beforeEach(() => vi.clearAllMocks());

    it("calls pluginRollbackService.saveSnapshot with plugin fields (not raw db.insert)", async () => {
      const { pluginLifecycleManager } = await import(
        "../services/plugin-lifecycle.js"
      );
      const mockLoader = {
        upgradePlugin: vi.fn().mockResolvedValue({
          oldManifest: { version: "1.0.0", capabilities: ["tools.register"] },
          newManifest: { version: "2.0.0", capabilities: ["tools.register"] },
          discovered: { version: "2.0.0" },
        }),
      };
      const lifecycle = pluginLifecycleManager({} as any, {
        loader: mockLoader as any,
      });
      await lifecycle.upgrade("plugin-1");

      expect(mockSaveSnapshot).toHaveBeenCalledOnce();
      expect(mockSaveSnapshot).toHaveBeenCalledWith(
        "plugin-1",
        "co-a",
        "1.0.0",
        "@test/plugin",
        { capabilities: ["tools.register"] },
      );
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && pnpm vitest run src/__tests__/plugin-lifecycle-upgrade.test.ts
```

Expected: FAIL — `TypeError: db.insert is not a function` (the raw insert path tries to call `db.insert` on `{}`)

- [ ] **Step 3: Add the import and remove the stale pluginVersionSnapshots import**

In `server/src/services/plugin-lifecycle.ts`, replace lines 38–50:

```typescript
// BEFORE
import type { Db } from "@armyofagents/db";
import { pluginVersionSnapshots } from "@armyofagents/db";
import type {
  PluginStatus,
  PluginRecord,
  PaperclipPluginManifestV1,
} from "@armyofagents/shared";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginLoader, type PluginLoader } from "./plugin-loader.js";
```

```typescript
// AFTER
import type { Db } from "@armyofagents/db";
import type {
  PluginStatus,
  PluginRecord,
  PaperclipPluginManifestV1,
} from "@armyofagents/shared";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginLoader, type PluginLoader } from "./plugin-loader.js";
import { pluginRollbackService } from "./plugin-rollback.js";
```

- [ ] **Step 4: Replace the raw insert with pluginRollbackService.saveSnapshot**

In `server/src/services/plugin-lifecycle.ts`, replace lines 672–679:

```typescript
// BEFORE
      // Save rollback snapshot so we can roll back if the upgrade fails
      await db.insert(pluginVersionSnapshots).values({
        pluginId: plugin.id,
        companyId: plugin.companyId,
        version: plugin.version,
        packageName: plugin.packageName,
        manifestJson: plugin.manifestJson,
      });
```

```typescript
// AFTER
      // Save rollback snapshot so we can roll back if the upgrade fails.
      // Uses pluginRollbackService so trimming (MAX_SNAPSHOTS=2) is enforced.
      await pluginRollbackService(db).saveSnapshot(
        plugin.id,
        plugin.companyId,
        plugin.version,
        plugin.packageName,
        plugin.manifestJson,
      );
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server && pnpm vitest run src/__tests__/plugin-lifecycle-upgrade.test.ts
```

Expected: PASS — all tests pass including the new `saveSnapshot` assertion

- [ ] **Step 6: Verify full test suite is still clean**

```bash
cd server && pnpm vitest run --reporter=verbose 2>&1 | tail -5
```

Expected: same pass/fail counts as before (no regressions)

- [ ] **Step 7: Commit**

```bash
git add server/src/services/plugin-lifecycle.ts server/src/__tests__/plugin-lifecycle-upgrade.test.ts
git commit -m "fix(plugins): route upgrade snapshot through pluginRollbackService to enforce MAX_SNAPSHOTS trim"
```

---

### Task 2: Fix nextInstallOrder() company scoping in plugin-registry.ts

**Bug:** `nextInstallOrder()` queries `max(installOrder)` across ALL plugins (no `companyId` filter). If company B has plugins with high install orders, company A's next install order is inflated. Under concurrent installs, two companies can also race and get the same order number.

**Files:**
- Modify: `server/src/services/plugin-registry.ts:113-118` (nextInstallOrder function)
- Modify: `server/src/services/plugin-registry.ts:226` (call site)
- Test: `server/src/__tests__/plugin-installer-company-scope.test.ts` (add a new test at the bottom)

- [ ] **Step 1: Write the failing test**

Open `server/src/__tests__/plugin-installer-company-scope.test.ts`. The existing mocks at the top of that file already mock `@armyofagents/db` and `drizzle-orm`. Add these two items:

First, capture the `companyId` column Symbol so we can assert `eq` was called with it. Replace the existing mock block at the top of the file with:

```typescript
import { describe, it, expect, vi } from "vitest";

const capturedEqArgs: unknown[][] = [];

vi.mock("@armyofagents/db", () => {
  const companyIdSymbol = Symbol("companyId");
  const pluginsProxy = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "companyId") return companyIdSymbol;
      return Symbol(String(prop));
    },
  });
  (global as any).__pluginsCompanyIdSymbol = companyIdSymbol;
  return { plugins: pluginsProxy, companies: new Proxy({}, { get: () => Symbol("col") }) };
});
vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => {
    capturedEqArgs.push(args);
    return Symbol("op:eq");
  },
  and: () => Symbol("op:and"),
  asc: () => Symbol("op:asc"),
  sql: new Proxy(
    Object.assign(function () { return Symbol("sql"); }, {}),
    { get: () => () => Symbol("sql") },
  ),
}));
```

Then add this new test at the bottom of the file, after the existing tests:

```typescript
describe("pluginRegistryService.install — nextInstallOrder company scoping", () => {
  it("passes companyId to eq() when computing MAX install order", async () => {
    capturedEqArgs.length = 0; // reset between tests

    const { pluginRegistryService } = await import(
      "../services/plugin-registry.js"
    );

    let selectN = 0;
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => {
            selectN++;
            // call 1: getByKeyScoped existence check → no existing row
            // call 2: nextInstallOrder MAX query → maxOrder = 2
            return selectN === 1
              ? Promise.resolve([])
              : Promise.resolve([{ maxOrder: 2 }]);
          },
        }),
      }),
      insert: () => ({
        values: (vals: any) => ({
          returning: () => Promise.resolve([{ ...vals, id: "plug-new" }]),
        }),
      }),
    };

    const registry = pluginRegistryService(mockDb as any);
    await registry.install(
      { packageName: "@test/plugin" } as any,
      {
        id: "test.plugin",
        version: "1.0.0",
        apiVersion: "1.0",
        categories: [],
        capabilities: [],
      } as any,
      "co-a",
    );

    const companyIdSymbol = (global as any).__pluginsCompanyIdSymbol;
    // eq must have been called with (plugins.companyId, "co-a") at some point
    const scopedEqCall = capturedEqArgs.find(
      ([col, val]) => col === companyIdSymbol && val === "co-a",
    );
    expect(scopedEqCall).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && pnpm vitest run src/__tests__/plugin-installer-company-scope.test.ts
```

Expected: FAIL — `expect(scopedEqCall).toBeDefined()` fails because `nextInstallOrder()` doesn't call `eq(plugins.companyId, ...)` before the fix

- [ ] **Step 3: Add companyId parameter and WHERE clause to nextInstallOrder()**

In `server/src/services/plugin-registry.ts`, replace lines 113–118:

```typescript
// BEFORE
  async function nextInstallOrder(): Promise<number> {
    const result = await db
      .select({ maxOrder: sql<number>`coalesce(max(${plugins.installOrder}), 0)` })
      .from(plugins);
    return (result[0]?.maxOrder ?? 0) + 1;
  }
```

```typescript
// AFTER
  async function nextInstallOrder(companyId: string): Promise<number> {
    const result = await db
      .select({ maxOrder: sql<number>`coalesce(max(${plugins.installOrder}), 0)` })
      .from(plugins)
      .where(eq(plugins.companyId, companyId));
    return (result[0]?.maxOrder ?? 0) + 1;
  }
```

- [ ] **Step 4: Update the call site to pass finalCompanyId**

In `server/src/services/plugin-registry.ts`, replace line 226:

```typescript
// BEFORE
      const installOrder = await nextInstallOrder();
```

```typescript
// AFTER
      const installOrder = await nextInstallOrder(finalCompanyId);
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server && pnpm vitest run src/__tests__/plugin-installer-company-scope.test.ts
```

Expected: PASS — `scopedEqCall` is defined because `eq(plugins.companyId, "co-a")` is now called in `nextInstallOrder`

- [ ] **Step 6: Verify typecheck and existing tests clean**

```bash
cd server && pnpm tsc --noEmit && pnpm vitest run --reporter=verbose 2>&1 | tail -5
```

Expected: 0 type errors, no regressions

- [ ] **Step 7: Commit**

```bash
git add server/src/services/plugin-registry.ts server/src/__tests__/plugin-installer-company-scope.test.ts
git commit -m "fix(plugins): scope nextInstallOrder() MAX query to companyId to prevent cross-tenant ordering"
```

---

### Task 3: Fix auto-rollback snapshot cleanup in upgrade route

**Bug:** After a successful auto-rollback (`lifecycle.upgrade()` throws → old version reinstalled via `loader.installPlugin()`), the rollback snapshot row is NOT deleted. The next upgrade attempt will again find a snapshot and attempt the same rollback — and if the underlying issue was transient, repeated successful rollbacks silently accumulate orphaned snapshot rows.

**Files:**
- Modify: `server/src/routes/company-plugins.ts:183-195` (auto-rollback catch block)
- Test: add one test to a new file `server/src/__tests__/company-plugin-upgrade-rollback.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/company-plugin-upgrade-rollback.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const t = new Proxy({}, { get: () => Symbol("col") });
  return {
    plugins: t,
    pluginConfig: t,
    pluginCompanySettings: t,
    pluginVersionSnapshots: t,
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  desc: () => Symbol("desc"),
}));
vi.mock("./authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));

import { companyPluginRoutes } from "../routes/company-plugins.js";

describe("POST /:pluginId/upgrade — auto-rollback snapshot cleanup", () => {
  it("deletes the consumed snapshot after a successful auto-rollback", async () => {
    const deletedIds: string[] = [];

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    id: "snap-1",
                    packageName: "@test/plugin",
                    version: "1.0.0",
                    companyId: "co-a",
                    pluginId: "plugin-1",
                  },
                ]),
            }),
          }),
          limit: () =>
            Promise.resolve([
              {
                id: "plugin-1",
                pluginKey: "test.plugin",
                companyId: "co-a",
                status: "ready",
              },
            ]),
        }),
      }),
      delete: () => ({
        where: (cond: any) => {
          // Capture deletes so we can assert the snapshot was removed
          deletedIds.push("snap-deleted");
          return Promise.resolve();
        },
      }),
    };

    const mockLifecycle = {
      upgrade: vi.fn().mockRejectedValue(new Error("upgrade failed")),
      load: vi.fn().mockResolvedValue(undefined),
    };
    const mockLoader = {
      installPlugin: vi.fn().mockResolvedValue(undefined),
    };

    const router = companyPluginRoutes(
      mockDb as any,
      mockLifecycle as any,
      mockLoader as any,
    );

    // Simulate Express req/res for POST /:pluginId/upgrade
    const req = {
      params: { companyId: "co-a", pluginId: "plugin-1" },
      body: {},
      session: {},
    } as any;
    const res = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    } as any;

    // Find the upgrade route handler and call it
    const upgradeLayer = router.stack.find(
      (l: any) => l.route?.path === "/:pluginId/upgrade" && l.route?.methods?.post,
    );
    expect(upgradeLayer).toBeDefined();
    await upgradeLayer.route.stack[0].handle(req, res, vi.fn());

    // Snapshot should have been deleted after successful rollback
    expect(deletedIds).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && pnpm vitest run src/__tests__/company-plugin-upgrade-rollback.test.ts
```

Expected: FAIL — `expect(deletedIds).toHaveLength(1)` fails because snapshot is never deleted

- [ ] **Step 3: Add snapshot delete after successful rollback**

In `server/src/routes/company-plugins.ts`, replace lines 183–195:

```typescript
// BEFORE
      if (snapshot) {
        try {
          await loader.installPlugin({
            packageName: snapshot.packageName,
            version: snapshot.version,
            companyId,
          });
          await lifecycle.load(plugin.id);
        } catch (revertErr) {
          // Plugin is in broken state — log but don't mask the original error
          console.error("Auto-rollback failed", revertErr);
        }
      }
```

```typescript
// AFTER
      if (snapshot) {
        try {
          await loader.installPlugin({
            packageName: snapshot.packageName,
            version: snapshot.version,
            companyId,
          });
          await lifecycle.load(plugin.id);
          // Consume the snapshot — rollback succeeded, row is no longer needed
          await db
            .delete(pluginVersionSnapshots)
            .where(eq(pluginVersionSnapshots.id, snapshot.id));
        } catch (revertErr) {
          // Plugin is in broken state — log but don't mask the original error
          console.error("Auto-rollback failed", revertErr);
        }
      }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && pnpm vitest run src/__tests__/company-plugin-upgrade-rollback.test.ts
```

Expected: PASS

- [ ] **Step 5: Run full suite to verify no regressions**

```bash
cd server && pnpm vitest run --reporter=verbose 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/company-plugins.ts server/src/__tests__/company-plugin-upgrade-rollback.test.ts
git commit -m "fix(plugins): delete consumed snapshot after successful auto-rollback in upgrade route"
```

---

### Task 4: Parallelize GET / DB queries in company-plugins route

**Perf issue:** `GET /api/companies/:companyId/plugins` makes 3 sequential DB round-trips (installed plugins, company settings, plugin configs). All three are independent reads and can run concurrently.

**Files:**
- Modify: `server/src/routes/company-plugins.ts:42-56`

No new test needed — this is a pure parallelisation with identical observable behaviour. The existing test suite covers the route.

- [ ] **Step 1: Replace 3 sequential awaits with Promise.all**

In `server/src/routes/company-plugins.ts`, replace lines 42–56:

```typescript
// BEFORE
    const installed = await db
      .select()
      .from(plugins)
      .where(eq(plugins.companyId, companyId))
      .orderBy(plugins.installedAt);

    const settings = await db
      .select()
      .from(pluginCompanySettings)
      .where(eq(pluginCompanySettings.companyId, companyId));

    const configs = await db
      .select()
      .from(pluginConfig)
      .where(eq(pluginConfig.companyId, companyId));
```

```typescript
// AFTER
    const [installed, settings, configs] = await Promise.all([
      db
        .select()
        .from(plugins)
        .where(eq(plugins.companyId, companyId))
        .orderBy(plugins.installedAt),
      db
        .select()
        .from(pluginCompanySettings)
        .where(eq(pluginCompanySettings.companyId, companyId)),
      db
        .select()
        .from(pluginConfig)
        .where(eq(pluginConfig.companyId, companyId)),
    ]);
```

- [ ] **Step 2: Verify typecheck and test suite clean**

```bash
cd server && pnpm tsc --noEmit && pnpm vitest run --reporter=verbose 2>&1 | tail -5
```

Expected: 0 type errors, no regressions

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/company-plugins.ts
git commit -m "perf(plugins): parallelize GET / installed+settings+config queries with Promise.all"
```

---

### Task 5: Add upgrade() state machine unit tests

**Gap:** `upgrade()` has two critical branches (caps gate → `upgrade_pending`; no caps → `ready`) with no unit tests. A future refactor could break the branching logic silently.

**Files:**
- Test: `server/src/__tests__/plugin-lifecycle-upgrade.test.ts`

This task extends the file from Task 1. The mocks added in Task 1 are already in place.

- [ ] **Step 1: Add the two state machine tests**

Inside the existing `describe("upgrade() routes snapshot through pluginRollbackService"` block added in Task 1, add two more tests after the saveSnapshot test:

```typescript
    it("returns { version, status: 'ready' } when no new capabilities are added", async () => {
      const { pluginLifecycleManager } = await import(
        "../services/plugin-lifecycle.js"
      );
      const mockLoader = {
        upgradePlugin: vi.fn().mockResolvedValue({
          oldManifest: { version: "1.0.0", capabilities: ["tools.register"] },
          newManifest: { version: "2.0.0", capabilities: ["tools.register"] },
          discovered: { version: "2.0.0" },
        }),
      };
      const lifecycle = pluginLifecycleManager({} as any, {
        loader: mockLoader as any,
      });
      const result = await lifecycle.upgrade("plugin-1");
      expect(result).toEqual({ version: "2.0.0", status: "ready" });
    });

    it("returns { version, status: 'upgrade_pending', delta } when new capabilities are added", async () => {
      const { pluginLifecycleManager } = await import(
        "../services/plugin-lifecycle.js"
      );
      const mockLoader = {
        upgradePlugin: vi.fn().mockResolvedValue({
          oldManifest: { version: "1.0.0", capabilities: ["tools.register"] },
          newManifest: {
            version: "2.0.0",
            capabilities: ["tools.register", "jobs.create"],
          },
          discovered: { version: "2.0.0" },
        }),
      };
      const lifecycle = pluginLifecycleManager({} as any, {
        loader: mockLoader as any,
      });
      const result = await lifecycle.upgrade("plugin-1");
      expect(result).toEqual({
        version: "2.0.0",
        status: "upgrade_pending",
        delta: ["jobs.create"],
      });
    });
```

- [ ] **Step 2: Run the tests to verify they pass**

```bash
cd server && pnpm vitest run src/__tests__/plugin-lifecycle-upgrade.test.ts
```

Expected: PASS — 6 tests total (3 diffCapabilities + 3 upgrade state machine)

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/plugin-lifecycle-upgrade.test.ts
git commit -m "test(plugins): add upgrade() state machine unit tests for ready and upgrade_pending branches"
```

---

### Task 6: Export checkPluginUpdates and add company scoping test

**Gap:** `checkPluginUpdates` has no test. It is the function that scans a company's installed plugins and queues update notifications. A regression (e.g., removing the `companyId` WHERE clause) would go undetected.

**Files:**
- Modify: `server/src/services/marketplace-update-checker.ts:157` (add `export`)
- Test: `server/src/__tests__/marketplace-update-checker-plugins.test.ts`

- [ ] **Step 1: Export checkPluginUpdates**

In `server/src/services/marketplace-update-checker.ts`, replace line 157:

```typescript
// BEFORE
async function checkPluginUpdates(
```

```typescript
// AFTER
export async function checkPluginUpdates(
```

- [ ] **Step 2: Write the failing test**

Append to `server/src/__tests__/marketplace-update-checker-plugins.test.ts`:

```typescript
// ── checkPluginUpdates company-scoping tests ─────────────────────────────────

import { describe as describe2, it as it2, expect as expect2, vi as vi2, beforeEach as beforeEach2 } from "vitest";

vi2.mock("@armyofagents/db", async (importOriginal) => {
  const t = new Proxy({}, { get: () => Symbol("col") });
  return {
    plugins: t,
    marketplacePendingUpdates: t,
    companies: t,
    companySkills: t,
  };
});
vi2.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: { updateAvailable: vi2.fn().mockResolvedValue(undefined) },
}));
vi2.mock("../middleware/logger.js", () => ({
  logger: { error: vi2.fn(), info: vi2.fn() },
}));

import { checkPluginUpdates } from "../services/marketplace-update-checker.js";
import type { CatalogItem } from "@armyofagents/shared";

const PLUGIN_CATALOG_ITEM: CatalogItem = {
  id: "plugin:test/discord",
  type: "plugin",
  name: "Discord",
  description: "Discord plugin",
  version: "2.0.0",
  npm: { packageName: "@test/discord", version: "2.0.0" },
  source: { adapter: "npm", url: "https://registry.npmjs.org", locator: "@test/discord", commitSha: "" },
  resourceUrl: "",
  content: { inline: "" },
  trust: { tier: "community", source: "npm" },
  status: "active",
  addedAt: "2026-01-01T00:00:00Z",
  category: "integrations",
  tags: [],
} as any;

function buildPluginDb(pluginRows: Array<{ packageName: string; version: string }>) {
  const insertedValues: any[] = [];
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(pluginRows),
        }),
      }),
      insert: () => ({
        values: (vals: any) => {
          insertedValues.push(vals);
          return {
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve([{ id: "upd-1" }]),
            }),
          };
        },
      }),
    } as any,
    insertedValues,
  };
}

describe2("checkPluginUpdates — company scoping", () => {
  beforeEach2(() => vi2.clearAllMocks());

  it2("upserts pending update with the provided companyId", async () => {
    const { db, insertedValues } = buildPluginDb([
      { packageName: "@test/discord", version: "1.0.0" },
    ]);

    await checkPluginUpdates(db, "co-a", [PLUGIN_CATALOG_ITEM]);

    expect2(insertedValues).toHaveLength(1);
    expect2(insertedValues[0].companyId).toBe("co-a");
    expect2(insertedValues[0].latestVersion).toBe("2.0.0");
    expect2(insertedValues[0].currentVersion).toBe("1.0.0");
  });

  it2("different companyIds produce independent upserts", async () => {
    const { db: dbA, insertedValues: insertedA } = buildPluginDb([
      { packageName: "@test/discord", version: "1.0.0" },
    ]);
    const { db: dbB, insertedValues: insertedB } = buildPluginDb([
      { packageName: "@test/discord", version: "1.0.0" },
    ]);

    await checkPluginUpdates(dbA, "co-a", [PLUGIN_CATALOG_ITEM]);
    await checkPluginUpdates(dbB, "co-b", [PLUGIN_CATALOG_ITEM]);

    expect2(insertedA[0]?.companyId).toBe("co-a");
    expect2(insertedB[0]?.companyId).toBe("co-b");
  });

  it2("skips plugins that are already at the latest version", async () => {
    const { db, insertedValues } = buildPluginDb([
      { packageName: "@test/discord", version: "2.0.0" }, // already latest
    ]);

    await checkPluginUpdates(db, "co-a", [PLUGIN_CATALOG_ITEM]);

    expect2(insertedValues).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails initially (no export yet)**

Wait — we already added the export in Step 1. Run directly:

```bash
cd server && pnpm vitest run src/__tests__/marketplace-update-checker-plugins.test.ts
```

Expected: PASS — all 3 new tests pass (they test the existing correct implementation)

If any test fails, the implementation has a bug that needs investigation before proceeding.

- [ ] **Step 4: Verify full suite clean**

```bash
cd server && pnpm vitest run --reporter=verbose 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add server/src/services/marketplace-update-checker.ts server/src/__tests__/marketplace-update-checker-plugins.test.ts
git commit -m "test(plugins): add checkPluginUpdates company-scoping tests; export function for testability"
```

---

## Self-Review

### Spec coverage

| Code review finding | Task that fixes it |
|---|---|
| `lifecycle.upgrade()` raw insert bypasses snapshot trim | Task 1 |
| `nextInstallOrder()` no company filter | Task 2 |
| Auto-rollback orphaned snapshot | Task 3 |
| GET / 3 sequential queries | Task 4 |
| `upgrade()` state machine untested | Task 5 |
| `checkPluginUpdates` company scoping untested | Task 6 |

All 6 findings addressed.

### Placeholder scan

No TBD, TODO, or vague steps — every step has complete code.

### Type consistency

- Task 1: `pluginRollbackService(db).saveSnapshot(pluginId, companyId, version, packageName, manifestJson)` — matches the `saveSnapshot` signature in `plugin-rollback.ts:20–26` exactly.
- Task 2: `nextInstallOrder(companyId: string)` — `eq` is already imported at line 1 of `plugin-registry.ts`.
- Task 3: `db.delete(pluginVersionSnapshots).where(eq(pluginVersionSnapshots.id, snapshot.id))` — `pluginVersionSnapshots` and `eq` are already imported in `company-plugins.ts`.
- Task 4: destructuring `[installed, settings, configs]` matches the existing variable names used in the `result` mapping below.
