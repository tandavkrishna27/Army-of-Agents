# Plugin Admin Authz Audit + Audit-Log Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden plugin admin routes so only instance admins can install/delete/configure plugins, and ensure all mutating operations produce audit-log entries.

**Architecture:** Extract the private `assertCanManageInstanceSettings` function from `instance-settings.ts` into `authz.ts` as a named export, then add that call to all 9 mutating plugin routes and the marketplace catalog-sync route. Add the two missing `logPluginMutationActivity` / `logActivity` calls.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM, Vitest

---

## File Map

| File | Change |
|------|--------|
| `server/src/routes/authz.ts` | Add exported `assertCanManageInstanceSettings` |
| `server/src/routes/instance-settings.ts` | Remove private copy, import from authz |
| `server/src/routes/feedback.ts` | Remove private copy, import from authz |
| `server/src/routes/plugins.ts` | Add `assertCanManageInstanceSettings()` to 9 routes + `logPluginMutationActivity` to jobs/trigger |
| `server/src/routes/marketplace.ts` | Add `assertCanManageInstanceSettings()` to catalog/sync + `db: Db` dep + `logActivity` call |
| `server/src/__tests__/plugin-admin-authz.test.ts` | **New** — 403 tests for non-admin board actors |

---

## Task 1: Export `assertCanManageInstanceSettings` from authz.ts

**Files:**
- Modify: `server/src/routes/authz.ts`
- Modify: `server/src/routes/instance-settings.ts`
- Modify: `server/src/routes/feedback.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/__tests__/plugin-admin-authz.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// We're testing the exported function directly, not via HTTP.
// Import after vi.mock so the module system is ready.
let assertCanManageInstanceSettings: (req: unknown) => void;

beforeEach(async () => {
  const mod = await import("../routes/authz.js");
  assertCanManageInstanceSettings = mod.assertCanManageInstanceSettings;
});

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    actor: {
      type: "board",
      source: "session",
      isInstanceAdmin: false,
      ...overrides,
    },
  };
}

describe("assertCanManageInstanceSettings", () => {
  it("allows local_implicit board regardless of isInstanceAdmin", () => {
    expect(() =>
      assertCanManageInstanceSettings(makeReq({ source: "local_implicit" }))
    ).not.toThrow();
  });

  it("allows session board with isInstanceAdmin=true", () => {
    expect(() =>
      assertCanManageInstanceSettings(makeReq({ isInstanceAdmin: true }))
    ).not.toThrow();
  });

  it("throws 403 for session board with isInstanceAdmin=false", () => {
    expect(() =>
      assertCanManageInstanceSettings(makeReq())
    ).toThrow();
  });

  it("throws 403 for non-board actor", () => {
    expect(() =>
      assertCanManageInstanceSettings({ actor: { type: "agent" } })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to confirm it fails (function not exported yet)**

```bash
cd server && pnpm test __tests__/plugin-admin-authz.test.ts
```
Expected: import error — `assertCanManageInstanceSettings` is not exported from `authz.ts`.

- [ ] **Step 3: Add the export to authz.ts**

Open `server/src/routes/authz.ts` and append after the existing exports:

```ts
export function assertCanManageInstanceSettings(req: Request): void {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}
```

- [ ] **Step 4: Remove the private copy from instance-settings.ts**

In `server/src/routes/instance-settings.ts`:

Replace lines 1-17 (the private function + its import of `forbidden`) with:

```ts
import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import { patchInstanceExperimentalSettingsSchema, patchInstanceGeneralSettingsSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { assertCanManageInstanceSettings, getActorInfo } from "./authz.js";
```

(Remove the `import { forbidden } from "../errors.js"` line and the private `assertCanManageInstanceSettings` function body — lines 4 and 9-17.)

- [ ] **Step 5: Remove the private copy from feedback.ts**

In `server/src/routes/feedback.ts` lines 12-23:

Replace:
```ts
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden } from "../errors.js";

// Mirror of instance-settings.ts's `assertCanManageInstanceSettings`. Bundle
// history is an admin view — it exposes metadata across every company on this
// instance (timestamps, sizes, vote direction), matching the scope of the
// PrivacyTab toggle that triggers the bundles in the first place.
function assertCanManageInstanceSettings(req: import("express").Request) {
  if (req.actor.type !== "board") throw forbidden("Board access required");
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  throw forbidden("Instance admin access required");
}
```

With:
```ts
import { assertCanManageInstanceSettings, assertCompanyAccess, getActorInfo } from "./authz.js";
```

(Keep `forbidden` import only if it's used elsewhere in feedback.ts — check with grep first.)

- [ ] **Step 6: Run tests to confirm they pass**

```bash
cd server && pnpm test __tests__/plugin-admin-authz.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 7: Run full typecheck to ensure no import errors**

```bash
cd server && pnpm tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/authz.ts server/src/routes/instance-settings.ts server/src/routes/feedback.ts server/src/__tests__/plugin-admin-authz.test.ts
git commit -m "refactor: extract assertCanManageInstanceSettings to authz.ts"
```

---

## Task 2: Add `assertCanManageInstanceSettings` to plugin routes in plugins.ts

**Files:**
- Modify: `server/src/routes/plugins.ts`

The 9 routes are at these approximate lines (verify with grep before editing):

| Route | Approx line |
|-------|-------------|
| `POST /plugins/install` | 607 |
| `DELETE /plugins/:pluginId` | 1244 |
| `POST /plugins/:pluginId/enable` | 1280 |
| `POST /plugins/:pluginId/disable` | 1318 |
| `POST /plugins/:pluginId/upgrade` | 1477 |
| `PUT /plugins/:pluginId/config` | 1574 |
| `POST /plugins/:pluginId/config/test` | 1679 |
| `POST /plugins/:pluginId/jobs/:jobId/trigger` | 1870 |
| `POST /plugins/:pluginId/rollback` | 2292 |

- [ ] **Step 1: Write the failing tests**

Add to `server/src/__tests__/plugin-admin-authz.test.ts` a section that tests the HTTP layer using the real router mounted on a test app. Use the established pattern from `server/src/__tests__/instance-settings-routes.test.ts`.

Append to the existing test file:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// We need to mock the heavy plugin dependencies to avoid loading the full stack.
vi.mock("../services/index.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  instanceSettingsService: vi.fn(),
}));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistry: vi.fn(() => ({
    list: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
  })),
}));

// A non-admin board actor (session, not instance admin)
const NON_ADMIN_ACTOR = {
  type: "board",
  source: "session",
  isInstanceAdmin: false,
  userId: "user-1",
  companyIds: [],
};

function makeApp(actor = NON_ADMIN_ACTOR) {
  const app = express();
  app.use(express.json());
  // Inject actor onto req before routes
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).actor = actor;
    next();
  });
  // Mount plugin routes with minimal stubs — only enough for authz to run
  // before the route body executes.
  // NOTE: This is a simplified integration test focusing only on authz.
  // The route body will 404/500 due to missing deps — we only check for 403.
  return app;
}

describe("plugin route authz — non-admin board gets 403", () => {
  const ROUTES = [
    { method: "post", path: "/api/plugins/install" },
    { method: "delete", path: "/api/plugins/plugin-id-1" },
    { method: "post", path: "/api/plugins/plugin-id-1/enable" },
    { method: "post", path: "/api/plugins/plugin-id-1/disable" },
    { method: "post", path: "/api/plugins/plugin-id-1/upgrade" },
    { method: "put", path: "/api/plugins/plugin-id-1/config" },
    { method: "post", path: "/api/plugins/plugin-id-1/config/test" },
    { method: "post", path: "/api/plugins/plugin-id-1/jobs/job-1/trigger" },
    { method: "post", path: "/api/plugins/plugin-id-1/rollback" },
  ];

  for (const { method, path } of ROUTES) {
    it(`${method.toUpperCase()} ${path} returns 403 for non-admin`, async () => {
      // NOTE: This test structure requires mounting the actual pluginRoutes.
      // See existing test files for the full mounting pattern.
      // The key assertion is that assertCanManageInstanceSettings fires before
      // any route body logic runs.
      expect(true).toBe(true); // placeholder — replace with actual supertest call
    });
  }
});
```

**Important:** The actual implementation of these tests requires mounting the full `pluginRoutes()` factory. Look at how `instance-settings-routes.test.ts` mounts `instanceSettingsRoutes(db)` for the pattern. Mock the db and loader deps minimally. The goal is to confirm the 403 fires before any route body logic.

- [ ] **Step 2: Run test to confirm placeholder passes (tests not real yet)**

```bash
cd server && pnpm test __tests__/plugin-admin-authz.test.ts
```

- [ ] **Step 3: Add import to plugins.ts**

In `server/src/routes/plugins.ts`, find the existing import of `assertBoard` from `authz.js` and add `assertCanManageInstanceSettings`:

```ts
import { assertBoard, assertCanManageInstanceSettings, assertCompanyAccess, getActorInfo } from "./authz.js";
```

- [ ] **Step 4: Add `assertCanManageInstanceSettings(req)` to each of the 9 routes**

For each route, add the call immediately after `assertBoard(req)`:

```ts
router.post("/plugins/install", async (req, res) => {
  assertBoard(req);
  assertCanManageInstanceSettings(req);   // <-- add this line
  // ... existing body unchanged
```

```ts
router.delete("/plugins/:pluginId", async (req, res) => {
  assertBoard(req);
  assertCanManageInstanceSettings(req);   // <-- add this line
  // ... existing body unchanged
```

```ts
router.post("/plugins/:pluginId/enable", async (req, res) => {
  assertBoard(req);
  assertCanManageInstanceSettings(req);   // <-- add this line
  // ... existing body unchanged
```

```ts
router.post("/plugins/:pluginId/disable", async (req, res) => {
  assertBoard(req);
  assertCanManageInstanceSettings(req);   // <-- add this line
  // ... existing body unchanged
```

Repeat this pattern for upgrade, config PUT, config/test POST, jobs/trigger POST, and rollback POST.

- [ ] **Step 5: Run typecheck**

```bash
cd server && pnpm tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 6: Run full server test suite**

```bash
cd server && pnpm test
```
Expected: no new failures (existing tests that were already testing these routes should still pass, since they use local_implicit actors which bypass the instance-admin check).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/plugins.ts
git commit -m "security: require instance-admin on all plugin mutating routes"
```

---

## Task 3: Add authz + audit-log to marketplace catalog/sync and jobs/trigger

**Files:**
- Modify: `server/src/routes/marketplace.ts`
- Modify: `server/src/routes/plugins.ts` (jobs/trigger only)

### Part A — marketplace.ts: authz + logActivity for catalog/sync

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/plugin-admin-authz.test.ts`:

```ts
describe("marketplace catalog/sync — non-admin board gets 403", () => {
  it("POST /api/marketplace/catalog/sync returns 403 for non-admin board", async () => {
    // Mount createMarketplaceRouter with a stub service and non-admin actor
    // Verify 403 is returned before the sync runs
    expect(true).toBe(true); // placeholder — replace with actual supertest call
  });
});
```

- [ ] **Step 2: Run to confirm placeholder passes**

```bash
cd server && pnpm test __tests__/plugin-admin-authz.test.ts
```

- [ ] **Step 3: Add assertCanManageInstanceSettings to catalog/sync in marketplace.ts**

`logActivity` requires `companyId: string` (NOT NULL in schema), so audit-logging this instance-level action is deferred. Only the authz guard is added in this PR.

Change is minimal — add one import and one call:

```ts
// In server/src/routes/marketplace.ts, update the import line:
import { assertBoard, assertCanManageInstanceSettings } from "./authz.js";

// In the catalog/sync handler:
router.post("/catalog/sync", async (req, res) => {
  assertBoard(req);
  assertCanManageInstanceSettings(req);   // <-- add this line only
  const catalog = await service.sync();
  // ... rest unchanged
});
```

No `db` dep needed — `MarketplaceRoutesDeps` stays as `{ service: MarketplaceCatalogService }`.

- [ ] **Step 4: Run typecheck to confirm no regressions**

```bash
cd server && pnpm tsc --noEmit
```

- [ ] **Step 5: Add logPluginMutationActivity to jobs/trigger in plugins.ts**

In `server/src/routes/plugins.ts`, the jobs/trigger route ends at ~line 1897. After the successful `triggerJob` call, add:

```ts
try {
  const result = await jobDeps.scheduler.triggerJob(jobId, "manual");
  await logPluginMutationActivity(req, "plugin.job.triggered", plugin.id, {
    pluginId: plugin.id,
    pluginKey: plugin.pluginKey,
    jobId,
    trigger: "manual",
  });   // <-- add these lines
  res.json(result);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  res.status(400).json({ error: message });
}
```

- [ ] **Step 6: Run typecheck**

```bash
cd server && pnpm tsc --noEmit
```

- [ ] **Step 5: Add logPluginMutationActivity to jobs/trigger in plugins.ts**

In `server/src/routes/plugins.ts`, the jobs/trigger route ends at ~line 1897. After the successful `triggerJob` call, add:

```ts
try {
  const result = await jobDeps.scheduler.triggerJob(jobId, "manual");
  await logPluginMutationActivity(req, "plugin.job.triggered", plugin.id, {
    pluginId: plugin.id,
    pluginKey: plugin.pluginKey,
    jobId,
    trigger: "manual",
  });   // <-- add these lines
  res.json(result);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  res.status(400).json({ error: message });
}
```

- [ ] **Step 6: Run full test suite**

```bash
cd server && pnpm test
```
Expected: no new failures.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/marketplace.ts server/src/routes/plugins.ts
git commit -m "security: add assertCanManageInstanceSettings to catalog/sync + audit log to jobs/trigger"
```

---

## Task 4: Implement and complete the authz route tests

**Files:**
- Modify: `server/src/__tests__/plugin-admin-authz.test.ts`

Replace the placeholder test bodies with real supertest calls. This task fills in the test implementation after the actual routes are hardened.

- [ ] **Step 1: Read the existing instance-settings-routes.test.ts for the mounting pattern**

```bash
cat server/src/__tests__/instance-settings-routes.test.ts | head -80
```

Copy the test app setup pattern. The key elements:
- Create a minimal Express app
- Inject a fake actor onto `req.actor` via middleware
- Mount the route factory
- Use supertest to call the route
- Assert 403 status

- [ ] **Step 2: Write the plugin route authz tests**

Replace the placeholder `expect(true).toBe(true)` bodies. For each plugin route, the test should:

```ts
it("POST /plugins/install returns 403 for non-admin board", async () => {
  // Minimal db mock
  const db = {} as unknown as Db;
  // Minimal loader mock — enough to not throw before authz check
  const loader = {} as ReturnType<typeof pluginLoader>;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = NON_ADMIN_ACTOR;
    next();
  });
  // pluginRoutes returns a router
  const { router } = pluginRoutes(db, loader);
  app.use("/api", router);

  const res = await request(app).post("/api/plugins/install").send({});
  expect(res.status).toBe(403);
});
```

Repeat for each of the 9 plugin routes and the marketplace catalog/sync route.

**Important:** `pluginRoutes` may need additional mock deps (jobDeps, webhookDeps, etc.). Pass `undefined` for optional deps. The goal is: authz check fires before any body logic that would need real deps.

- [ ] **Step 3: Run tests and verify all pass**

```bash
cd server && pnpm test __tests__/plugin-admin-authz.test.ts
```
Expected: all route authz tests return 403 for non-admin, non-403 for local_implicit.

- [ ] **Step 4: Run full test suite**

```bash
cd server && pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/plugin-admin-authz.test.ts
git commit -m "test: route-level authz tests for plugin admin endpoints"
```

---

## Self-Review Checklist

- [ ] All 9 plugin routes + catalog/sync now call `assertCanManageInstanceSettings` after `assertBoard`
- [ ] jobs/trigger now calls `logPluginMutationActivity`
- [ ] catalog/sync has `assertCanManageInstanceSettings` (logActivity deferred — requires companyId which is NOT NULL)
- [ ] `assertCanManageInstanceSettings` is exported from `authz.ts` and both private copies removed
- [ ] Tests cover: local_implicit passes, isInstanceAdmin=true passes, session non-admin gets 403, non-board gets 403
- [ ] typecheck clean, test suite green
