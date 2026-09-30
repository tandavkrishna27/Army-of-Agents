# Marketplace Packages — Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side derivation of "marketplace packages" — groups of catalog items by their GitHub source repo, with optional explicit `packageId` override. Exposed via a new `GET /api/marketplace/packages` endpoint and a `usePackages()` React Query hook. No UI wiring yet — Phase C consumes this.

**Architecture:** Pure-function aggregator that runs against the existing cached catalog. Synthesis-first: a "package" is any GitHub `owner/repo` source with ≥ 2 catalog items. An optional `packageId?: string` field on `MarketplaceCatalogItemSchema` lets the upstream catalog repo override the synthesis (forward-compat — the field is added to the AoA schema now, the catalog repo can populate it whenever). No DB changes, no schema-version bump (the new field is optional and Zod strips unknown fields, so this is fully backward-compat with both directions of catalog drift).

**Tech Stack:** TypeScript, Zod (`packages/shared/src/marketplace.ts`), Express (`server/src/routes/marketplace.ts`), Vitest, supertest, `@tanstack/react-query` v5 (`ui/src/hooks/usePackages.ts`).

**Spec:** Conversation thread on 2026-05-08 — "synthesis with explicit override" hybrid. Phase A delivered the chrome + cards. Phase B is the data layer. Phase C will render packages in the UI.

---

## Files

| Action | Path | What changes |
|--------|------|--------------|
| Modify | `packages/shared/src/marketplace.ts` | Add `packageId?: string` field to `MarketplaceCatalogItemSchema` + new `MarketplacePackageSchema` + `MarketplacePackage` type export |
| Create | `server/src/services/derivePackages.ts` | Pure aggregator: `derivePackages(items): MarketplacePackage[]` |
| Create | `server/src/services/__tests__/derivePackages.test.ts` | Unit tests for the aggregator (no DB, no HTTP) |
| Modify | `server/src/routes/marketplace.ts` | Add `GET /api/marketplace/packages` route handler |
| Create | `server/src/__tests__/marketplace-packages-route.test.ts` | Supertest-based route test |
| Modify | `ui/src/api/marketplace.ts` | Add `marketplaceApi.getPackages()` API client function |
| Create | `ui/src/hooks/usePackages.ts` | React Query hook + exported query key |
| Create | `ui/src/hooks/__tests__/usePackages.test.tsx` | Hook unit test (mocked API) |

**Total:** 3 modified, 5 created. No migrations, no UI page changes.

---

## Verification rules (apply to every task)

1. **TDD order.** Failing test first, see it fail with the expected error, implement, see it pass, commit.
2. **Per-task scoped run** before commit; **broader suite** at end (`pnpm test:run` from repo root, or scoped `pnpm vitest run <path>` for fast iteration).
3. **Conventional commit prefixes:** `feat(shared):`, `feat(server):`, `feat(ui):`, `test(...)`, `chore(...)`.
4. **Typecheck after Tasks 1, 4, 7** — `pnpm exec tsc --noEmit` from `ui/` and from `server/` (run separately; they have separate tsconfigs).
5. **No DB changes.** This phase is purely additive at the type/route/hook level.
6. **Synthesis rule (locked):** group by GitHub `owner/repo` extracted from `source.url`; threshold = ≥ 2 items per group; explicit `packageId` overrides synthesis (1+ item is valid for explicit packages); items with non-github source URLs are skipped (no package).

---

## Task 1: Add `packageId` field + `MarketplacePackage` schema to shared types

**Files:**
- Modify: `packages/shared/src/marketplace.ts`

The `packageId` field is optional and has no current consumer (the catalog repo doesn't emit it yet). It's added now so the schema can accept it cleanly when it lands. The `MarketplacePackage` type is the derived/synthesized shape that `derivePackages` (Task 2) returns.

- [ ] **Step 1: Read the current file**

Run: `cat packages/shared/src/marketplace.ts | head -130`

Confirm the existing `MarketplaceCatalogItemSchema` ends with `runtimeRequires: z.array(z.string()).optional(),` and is closed by `});` followed by the `export type MarketplaceCatalogItem = z.infer<...>` line.

- [ ] **Step 2: Add `packageId?: string` to `MarketplaceCatalogItemSchema`**

In `packages/shared/src/marketplace.ts`, find the `MarketplaceCatalogItemSchema` definition. Inside the `z.object({...})`, add this line **immediately before** `category: MarketplaceCategorySchema,`:

```ts
  packageId: z.string().optional(),
```

The surrounding context after the change:

```ts
  content: z
    .object({
      inline: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  packageId: z.string().optional(),
  category: MarketplaceCategorySchema,
  tags: z.array(MarketplaceTagSchema),
  featured: z.boolean().optional(),
  runtimeRequires: z.array(z.string()).optional(),
});
```

- [ ] **Step 3: Add `MarketplacePackageSchema` + type export**

At the end of `packages/shared/src/marketplace.ts` — **after** the `MarketplaceCatalogFile` type export and **before** the `CatalogSyncStatus` interface — add:

```ts
/**
 * A "package" is a synthetic grouping of catalog items that share a GitHub
 * source repo (or an explicit `packageId`). Synthesis rule: items grouped by
 * `owner/repo` extracted from `source.url`, with threshold ≥ 2 items.
 *
 * Synthesized packages don't have a description; UI shows "N skills" instead.
 * If the upstream catalog repo later wants curated names/descriptions, items
 * can carry an explicit `packageId` whose metadata can be looked up elsewhere.
 */
export const MarketplacePackageSchema = z.object({
  /** Stable identifier — `owner/repo` for synthesized, the literal `packageId` for explicit. */
  id: z.string(),
  /** Display name — repo name for synthesized (`gstack`), literal `packageId` for explicit. */
  name: z.string(),
  /** Canonical GitHub URL (e.g. `https://github.com/garrytan/gstack`). */
  sourceUrl: z.string(),
  /** Catalog item IDs that belong to this package, sorted ascending. */
  memberItemIds: z.array(z.string()),
  /** Number of member items. Always equal to `memberItemIds.length`. */
  count: z.number().int().nonnegative(),
  /** True iff every member item has `trust.tier === "verified"`. */
  verified: z.boolean(),
  /** Whether this package was created via an explicit `packageId` override. False = synthesized. */
  explicit: z.boolean(),
});
export type MarketplacePackage = z.infer<typeof MarketplacePackageSchema>;
```

- [ ] **Step 4: Verify typecheck across packages**

Run from repo root:

```bash
pnpm -r exec tsc --noEmit
```

Expected: no errors. The `packageId` is `.optional()`, so existing test fixtures and consumers compile cleanly.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/marketplace.ts
git commit -m "feat(shared): add MarketplacePackage schema + optional packageId on items"
```

---

## Task 2: Implement `derivePackages` pure function (TDD)

**Files:**
- Create: `server/src/services/derivePackages.ts`
- Create: `server/src/services/__tests__/derivePackages.test.ts`

A pure function over `MarketplaceCatalogItem[]` that returns `MarketplacePackage[]`. No DB, no HTTP, no `MarketplaceCatalogService` dependency — completely isolated.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/__tests__/derivePackages.test.ts
import { describe, it, expect } from "vitest";
import type { MarketplaceCatalogItem } from "@armyofagents/shared";
import { derivePackages } from "../derivePackages.js";

function makeItem(overrides: Partial<MarketplaceCatalogItem> & { id: string }): MarketplaceCatalogItem {
  return {
    id: overrides.id,
    type: "skill",
    name: overrides.id,
    description: "test item",
    version: "1.0.0",
    source: {
      adapter: "github-skills",
      url: "https://github.com/example/repo",
      locator: "default",
    },
    trust: { tier: "verified", source: "x" },
    status: "active",
    addedAt: "2026-05-01T00:00:00Z",
    category: "engineering",
    tags: [],
    ...overrides,
  } as MarketplaceCatalogItem;
}

describe("derivePackages", () => {
  it("returns [] for an empty input", () => {
    expect(derivePackages([])).toEqual([]);
  });

  it("groups items by github owner/repo extracted from source.url", () => {
    const items = [
      makeItem({ id: "skill:gstack/office-hours", source: { adapter: "g", url: "https://github.com/garrytan/gstack/tree/abc/skills/office-hours", locator: "office-hours" } }),
      makeItem({ id: "skill:gstack/qa", source: { adapter: "g", url: "https://github.com/garrytan/gstack/tree/abc/skills/qa", locator: "qa" } }),
      makeItem({ id: "skill:sp/brainstorming", source: { adapter: "g", url: "https://github.com/anthropic/superpowers/tree/main/skills/brainstorming", locator: "brainstorming" } }),
      makeItem({ id: "skill:sp/code-review", source: { adapter: "g", url: "https://github.com/anthropic/superpowers/tree/main/skills/code-review", locator: "code-review" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(2);
    const gstack = packages.find((p) => p.id === "garrytan/gstack")!;
    const sp = packages.find((p) => p.id === "anthropic/superpowers")!;
    expect(gstack.memberItemIds.sort()).toEqual(["skill:gstack/office-hours", "skill:gstack/qa"]);
    expect(sp.memberItemIds.sort()).toEqual(["skill:sp/brainstorming", "skill:sp/code-review"]);
  });

  it("strips a trailing .git suffix from the repo name", () => {
    const items = [
      makeItem({ id: "a", source: { adapter: "g", url: "https://github.com/owner/repo.git", locator: "x" } }),
      makeItem({ id: "b", source: { adapter: "g", url: "https://github.com/owner/repo.git/tree/main/y", locator: "y" } }),
    ];
    const [pkg] = derivePackages(items);
    expect(pkg.id).toBe("owner/repo");
    expect(pkg.name).toBe("repo");
  });

  it("excludes single-item synthesized groups (threshold = 2)", () => {
    const items = [
      makeItem({ id: "loner", source: { adapter: "g", url: "https://github.com/foo/bar", locator: "z" } }),
      makeItem({ id: "p1", source: { adapter: "g", url: "https://github.com/qux/quux/tree/main/a", locator: "a" } }),
      makeItem({ id: "p2", source: { adapter: "g", url: "https://github.com/qux/quux/tree/main/b", locator: "b" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]!.id).toBe("qux/quux");
  });

  it("excludes items with non-github source URLs from synthesis", () => {
    const items = [
      makeItem({ id: "x1", source: { adapter: "g", url: "https://gitlab.com/foo/bar", locator: "x" } }),
      makeItem({ id: "x2", source: { adapter: "g", url: "https://gitlab.com/foo/bar", locator: "y" } }),
    ];
    expect(derivePackages(items)).toEqual([]);
  });

  it("explicit packageId overrides synthesis and accepts groups of size 1", () => {
    const items = [
      makeItem({ id: "alone", packageId: "my-curated", source: { adapter: "g", url: "https://example.com/anywhere", locator: "x" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      id: "my-curated",
      name: "my-curated",
      explicit: true,
      count: 1,
      memberItemIds: ["alone"],
    });
  });

  it("explicit packageId pulls items together even from different source URLs", () => {
    const items = [
      makeItem({ id: "a", packageId: "joint", source: { adapter: "g", url: "https://github.com/o1/r1", locator: "x" } }),
      makeItem({ id: "b", packageId: "joint", source: { adapter: "g", url: "https://github.com/o2/r2", locator: "y" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]!.memberItemIds.sort()).toEqual(["a", "b"]);
  });

  it("explicit packageId on one item promotes only that item; others still synthesize separately", () => {
    const items = [
      makeItem({ id: "ex", packageId: "explicit-pkg", source: { adapter: "g", url: "https://github.com/owner/repo/tree/main/a", locator: "a" } }),
      makeItem({ id: "syn1", source: { adapter: "g", url: "https://github.com/owner/repo/tree/main/b", locator: "b" } }),
      makeItem({ id: "syn2", source: { adapter: "g", url: "https://github.com/owner/repo/tree/main/c", locator: "c" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(2);
    const ex = packages.find((p) => p.id === "explicit-pkg")!;
    const syn = packages.find((p) => p.id === "owner/repo")!;
    expect(ex.explicit).toBe(true);
    expect(ex.memberItemIds).toEqual(["ex"]);
    expect(syn.explicit).toBe(false);
    expect(syn.memberItemIds.sort()).toEqual(["syn1", "syn2"]);
  });

  it("verified=true only when every member is verified", () => {
    const items = [
      makeItem({ id: "v1", trust: { tier: "verified", source: "x" }, source: { adapter: "g", url: "https://github.com/x/y/tree/main/a", locator: "a" } }),
      makeItem({ id: "v2", trust: { tier: "verified", source: "x" }, source: { adapter: "g", url: "https://github.com/x/y/tree/main/b", locator: "b" } }),
    ];
    expect(derivePackages(items)[0]!.verified).toBe(true);

    const mixed = [
      ...items,
      makeItem({ id: "c", trust: { tier: "community", source: "x" }, source: { adapter: "g", url: "https://github.com/x/y/tree/main/c", locator: "c" } }),
    ];
    expect(derivePackages(mixed)[0]!.verified).toBe(false);
  });

  it("returns memberItemIds sorted ascending and packages sorted by id ascending", () => {
    const items = [
      makeItem({ id: "z", source: { adapter: "g", url: "https://github.com/zz/zz/tree/main/a", locator: "a" } }),
      makeItem({ id: "a", source: { adapter: "g", url: "https://github.com/aa/aa/tree/main/a", locator: "a" } }),
      makeItem({ id: "m", source: { adapter: "g", url: "https://github.com/aa/aa/tree/main/m", locator: "m" } }),
      makeItem({ id: "b", source: { adapter: "g", url: "https://github.com/zz/zz/tree/main/b", locator: "b" } }),
    ];
    const packages = derivePackages(items);
    expect(packages.map((p) => p.id)).toEqual(["aa/aa", "zz/zz"]);
    expect(packages[0]!.memberItemIds).toEqual(["a", "m"]);
    expect(packages[1]!.memberItemIds).toEqual(["b", "z"]);
  });

  it("count always equals memberItemIds.length", () => {
    const items = [
      makeItem({ id: "a", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "b", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
      makeItem({ id: "c", source: { adapter: "g", url: "https://github.com/o/r/tree/main/c", locator: "c" } }),
    ];
    const [pkg] = derivePackages(items);
    expect(pkg!.count).toBe(pkg!.memberItemIds.length);
    expect(pkg!.count).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from repo root: `pnpm vitest run server/src/services/__tests__/derivePackages.test.ts`
Expected: FAIL — `Cannot find module '../derivePackages.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/derivePackages.ts
import type { MarketplaceCatalogItem, MarketplacePackage } from "@armyofagents/shared";

const SYNTHESIS_THRESHOLD = 2;

/**
 * Extract canonical `owner/repo` from a github URL, stripping any `tree/SHA/path`
 * suffix and a trailing `.git`. Returns `null` for non-github URLs.
 */
function repoRootFromUrl(url: string): string | null {
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/i);
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/i, "");
  return `${owner}/${repo}`;
}

/**
 * Derive the package list from catalog items. Items with an explicit
 * `packageId` group under that key (overrides any synthesis); remaining items
 * group by github owner/repo and only emit a package when the group has at
 * least {@link SYNTHESIS_THRESHOLD} members. Items with non-github source URLs
 * and no explicit packageId are skipped (no package).
 *
 * The result is deterministic: packages sorted by `id` ascending, member item
 * IDs sorted ascending. `verified` is true iff every member has
 * `trust.tier === "verified"`.
 */
export function derivePackages(items: ReadonlyArray<MarketplaceCatalogItem>): MarketplacePackage[] {
  const explicitGroups = new Map<string, MarketplaceCatalogItem[]>();
  const synthesizedGroups = new Map<string, MarketplaceCatalogItem[]>();

  for (const item of items) {
    if (item.packageId) {
      const list = explicitGroups.get(item.packageId);
      if (list) list.push(item);
      else explicitGroups.set(item.packageId, [item]);
      continue;
    }
    const root = repoRootFromUrl(item.source.url);
    if (!root) continue;
    const list = synthesizedGroups.get(root);
    if (list) list.push(item);
    else synthesizedGroups.set(root, [item]);
  }

  const packages: MarketplacePackage[] = [];

  for (const [id, members] of explicitGroups) {
    packages.push(buildPackage(id, id, members[0]!.source.url, members, /* explicit */ true));
  }

  for (const [id, members] of synthesizedGroups) {
    if (members.length < SYNTHESIS_THRESHOLD) continue;
    const repoName = id.split("/")[1] ?? id;
    const sourceUrl = `https://github.com/${id}`;
    packages.push(buildPackage(id, repoName, sourceUrl, members, /* explicit */ false));
  }

  packages.sort((a, b) => a.id.localeCompare(b.id));
  return packages;
}

function buildPackage(
  id: string,
  name: string,
  sourceUrl: string,
  members: ReadonlyArray<MarketplaceCatalogItem>,
  explicit: boolean,
): MarketplacePackage {
  const memberItemIds = members.map((m) => m.id).sort((a, b) => a.localeCompare(b));
  const verified = members.every((m) => m.trust.tier === "verified");
  return {
    id,
    name,
    sourceUrl,
    memberItemIds,
    count: memberItemIds.length,
    verified,
    explicit,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/derivePackages.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/derivePackages.ts server/src/services/__tests__/derivePackages.test.ts
git commit -m "feat(server): add derivePackages aggregator (synthesis + explicit override)"
```

---

## Task 3: Wire `derivePackages` into `MarketplaceCatalogService`

**Files:**
- Modify: `server/src/services/aoa-marketplace.ts`

Add a thin method on `MarketplaceCatalogService` that reads the cached catalog and runs `derivePackages` over its items. This keeps the route handler simple — one service call.

- [ ] **Step 1: Read the current service file**

Run: `grep -n "class MarketplaceCatalogService\|async readCache\|async getStatus" server/src/services/aoa-marketplace.ts | head -10`

Note the line numbers of the `readCache()` method declaration. The new `getPackages()` method goes immediately after it.

- [ ] **Step 2: Add the import**

In `server/src/services/aoa-marketplace.ts`, find the existing imports at the top of the file. Add this line (alphabetically placed near other local imports):

```ts
import { derivePackages } from "./derivePackages.js";
```

- [ ] **Step 3: Add the method to the class**

Inside the `MarketplaceCatalogService` class body, immediately after the `async readCache(): Promise<MarketplaceCatalogFile | null>` method, insert:

```ts
  /**
   * Read the cached catalog and derive the marketplace package list.
   * Returns `null` if no catalog has been cached yet (caller should respond
   * 503 to mirror `readCache()` semantics).
   *
   * Derivation is in-memory and cheap (~hundreds of items max). No DB write.
   */
  async getPackages(): Promise<MarketplacePackage[] | null> {
    const catalog = await this.readCache();
    if (!catalog) return null;
    return derivePackages(catalog.items);
  }
```

- [ ] **Step 4: Add the type to the imports from shared**

At the top of the file, find the line that imports types from `@armyofagents/shared`. The existing import probably looks like:

```ts
import type {
  CatalogSyncStatus,
  MarketplaceCatalogFile,
} from "@armyofagents/shared";
```

Add `MarketplacePackage` to this import:

```ts
import type {
  CatalogSyncStatus,
  MarketplaceCatalogFile,
  MarketplacePackage,
} from "@armyofagents/shared";
```

If the existing import structure is different (e.g., a single-line import or splits between `import` and `import type`), make the same conceptual change — `MarketplacePackage` should come from `@armyofagents/shared` as a type-only import.

- [ ] **Step 5: Run typecheck**

Run from repo root: `pnpm -r exec tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Run server test suite to confirm no regression**

Run: `pnpm vitest run server/src/services/__tests__ server/src/__tests__ --reporter=basic`
Expected: existing tests all pass; new `derivePackages` tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/aoa-marketplace.ts
git commit -m "feat(server): expose getPackages() on MarketplaceCatalogService"
```

---

## Task 4: Add `GET /api/marketplace/packages` route + supertest test

**Files:**
- Modify: `server/src/routes/marketplace.ts`
- Create: `server/src/__tests__/marketplace-packages-route.test.ts`

The route mirrors `/catalog`'s shape: 200 with the body, 503 if no catalog cached yet. Auth: `assertBoard(req)` only (read-only, no instance-settings permission needed — same as `/catalog`).

- [ ] **Step 1: Write the failing route test**

```ts
// server/src/__tests__/marketplace-packages-route.test.ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMarketplaceRouter } from "../routes/marketplace.js";
import { errorHandler } from "../middleware/index.js";
import type { MarketplacePackage } from "@armyofagents/shared";

const mockService = vi.hoisted(() => ({
  readCache: vi.fn(),
  sync: vi.fn(),
  getStatus: vi.fn(),
  getPackages: vi.fn(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api/marketplace", createMarketplaceRouter({ service: mockService as any }));
  app.use(errorHandler);
  return app;
}

const SAMPLE_PACKAGE: MarketplacePackage = {
  id: "garrytan/gstack",
  name: "gstack",
  sourceUrl: "https://github.com/garrytan/gstack",
  memberItemIds: ["skill:gstack/office-hours", "skill:gstack/qa"],
  count: 2,
  verified: true,
  explicit: false,
};

describe("GET /api/marketplace/packages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with the package list when catalog is cached", async () => {
    mockService.getPackages.mockResolvedValue([SAMPLE_PACKAGE]);

    const res = await request(createApp()).get("/api/marketplace/packages");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([SAMPLE_PACKAGE]);
    expect(mockService.getPackages).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when no catalog has been cached yet", async () => {
    mockService.getPackages.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/marketplace/packages");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/not yet synced/i) });
  });

  it("returns an empty array when catalog has zero packages", async () => {
    mockService.getPackages.mockResolvedValue([]);

    const res = await request(createApp()).get("/api/marketplace/packages");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/__tests__/marketplace-packages-route.test.ts`
Expected: FAIL — the route doesn't exist yet, so the request returns 404.

- [ ] **Step 3: Add the route**

In `server/src/routes/marketplace.ts`, find the existing `router.get("/catalog/status", ...)` route. Add a new route immediately after it (before `return router;`):

```ts
  router.get("/packages", async (req, res) => {
    assertBoard(req);
    const packages = await service.getPackages();
    if (!packages) {
      res.status(503).json({ error: "Catalog not yet synced" });
      return;
    }
    res.json(packages);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/src/__tests__/marketplace-packages-route.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Run the broader server suite**

Run: `pnpm vitest run server/src/__tests__ server/src/services/__tests__ --reporter=basic`
Expected: all green.

- [ ] **Step 6: Run typecheck**

Run from repo root: `pnpm -r exec tsc --noEmit`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/marketplace.ts server/src/__tests__/marketplace-packages-route.test.ts
git commit -m "feat(server): add GET /api/marketplace/packages route"
```

---

## Task 5: Add `marketplaceApi.getPackages()` UI client function

**Files:**
- Modify: `ui/src/api/marketplace.ts`

Mirrors the shape of `getCatalog()` and `getStatus()`. No tests at this layer — it's a one-line API call covered by the hook test in Task 6.

- [ ] **Step 1: Read the current `marketplaceApi` object**

Run: `grep -n "export const marketplaceApi\|async getCatalog\|async getStatus\|async sync" ui/src/api/marketplace.ts | head -10`

Note the start/end of the `marketplaceApi` object (so the new function lands inside it).

- [ ] **Step 2: Add the type-only import**

At the top of `ui/src/api/marketplace.ts`, find the import from `@armyofagents/shared`. Add `MarketplacePackage` to it. If the existing import is:

```ts
import type {
  CatalogItem,
  CatalogSyncStatus,
  MarketplaceCatalogFile,
  // ...
} from "@armyofagents/shared";
```

Update to include `MarketplacePackage`:

```ts
import type {
  CatalogItem,
  CatalogSyncStatus,
  MarketplaceCatalogFile,
  MarketplacePackage,
  // ...
} from "@armyofagents/shared";
```

- [ ] **Step 3: Add `getPackages` to `marketplaceApi`**

Inside the `marketplaceApi` object literal, immediately after the `async getStatus()` method, add:

```ts
  async getPackages(): Promise<MarketplacePackage[]> {
    return api.get<MarketplacePackage[]>("/marketplace/packages");
  },
```

(Note the trailing comma if there are more methods after; check the existing style.)

- [ ] **Step 4: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Run UI test suite to confirm no regression**

Run from `ui/`: `pnpm vitest run --reporter=basic 2>&1 | tail -10`
Expected: all 1083 (or whatever the post-Phase-A count is) tests pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/marketplace.ts
git commit -m "feat(ui): add marketplaceApi.getPackages() client function"
```

---

## Task 6: Add `usePackages` React Query hook (TDD)

**Files:**
- Create: `ui/src/hooks/usePackages.ts`
- Create: `ui/src/hooks/__tests__/usePackages.test.tsx`

Models on `useCatalog`. Same `staleTime` (5min) and `gcTime` (30min). Exports `packagesQueryKey` for consumers that need it for invalidation.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/hooks/__tests__/usePackages.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MarketplacePackage } from "@armyofagents/shared";
import { usePackages, packagesQueryKey } from "../usePackages";

vi.mock("@/api/marketplace", () => ({
  marketplaceApi: {
    getPackages: vi.fn(),
  },
}));

import { marketplaceApi } from "@/api/marketplace";

const SAMPLE: MarketplacePackage = {
  id: "garrytan/gstack",
  name: "gstack",
  sourceUrl: "https://github.com/garrytan/gstack",
  memberItemIds: ["skill:a", "skill:b"],
  count: 2,
  verified: true,
  explicit: false,
};

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("usePackages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls marketplaceApi.getPackages and returns the data", async () => {
    vi.mocked(marketplaceApi.getPackages).mockResolvedValue([SAMPLE]);
    const { result } = renderHook(() => usePackages(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([SAMPLE]);
    expect(marketplaceApi.getPackages).toHaveBeenCalledTimes(1);
  });

  it("propagates errors from the API", async () => {
    vi.mocked(marketplaceApi.getPackages).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePackages(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("boom");
  });

  it("exports packagesQueryKey as a tuple matching the queryKey used by the hook", () => {
    expect(packagesQueryKey).toEqual(["marketplace", "packages"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `ui/`: `pnpm vitest run src/hooks/__tests__/usePackages.test.tsx`
Expected: FAIL — `Cannot find module '../usePackages'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/hooks/usePackages.ts
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { MarketplacePackage } from "@armyofagents/shared";
import { marketplaceApi } from "@/api/marketplace";

const PACKAGES_QUERY_KEY = ["marketplace", "packages"] as const;
const STALE_TIME_MS = 5 * 60 * 1000;
const GC_TIME_MS = 30 * 60 * 1000;

/**
 * Fetch the marketplace package list. Packages are derived server-side from
 * the cached catalog (group by github owner/repo, threshold ≥ 2, with
 * explicit `packageId` override). See server/src/services/derivePackages.ts.
 *
 * Returns 503 from the server (surfaces here as a query error) if no catalog
 * has been cached yet.
 */
export function usePackages(): UseQueryResult<MarketplacePackage[], Error> {
  return useQuery({
    queryKey: PACKAGES_QUERY_KEY,
    queryFn: () => marketplaceApi.getPackages(),
    staleTime: STALE_TIME_MS,
    gcTime: GC_TIME_MS,
  });
}

export const packagesQueryKey = PACKAGES_QUERY_KEY;
```

- [ ] **Step 4: Run test to verify it passes**

Run from `ui/`: `pnpm vitest run src/hooks/__tests__/usePackages.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 5: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Run UI test suite**

Run from `ui/`: `pnpm vitest run --reporter=basic 2>&1 | tail -10`
Expected: all tests pass (count is the prior total + 3 from `usePackages.test.tsx`).

- [ ] **Step 7: Commit**

```bash
git add ui/src/hooks/usePackages.ts ui/src/hooks/__tests__/usePackages.test.tsx
git commit -m "feat(ui): add usePackages React Query hook"
```

---

## Task 7: Final verification — manual API smoke + clean test run

**Files:** none (verification only)

- [ ] **Step 1: Confirm both servers are running (or restart)**

Check via the preview MCP listing. The "app" server must be on a known port (the prior session settled on 3101 because 3100 was busy) and the "ui" dev server on 5175 (or whatever port Vite chose).

If they're not running, start them via the preview MCP (`name: "app"` and `name: "ui"`).

- [ ] **Step 2: Trigger a manual catalog sync (if catalog is empty)**

The endpoint requires a board cookie. Easiest path: open the AoA UI in the browser at the dev URL, log in (already logged in from prior sessions in `local_trusted` mode), then in the browser DevTools console run:

```js
await fetch("/api/marketplace/catalog/sync", { method: "POST", credentials: "include" }).then(r => r.json())
```

Expected: a JSON response with `itemCount` and `status`. If the response says "no catalog" or you'd rather skip the sync, the bundled snapshot is sufficient — no action needed.

- [ ] **Step 3: Hit `GET /api/marketplace/packages` directly**

In the browser DevTools console (same session as above):

```js
await fetch("/api/marketplace/packages", { credentials: "include" }).then(r => r.json())
```

Expected: an array of package objects. Verify a few rows look reasonable:

- At least one package with `id` like `MeteoriteLabs/aoa-marketplace` (the curated plugins, likely several members).
- Each package has all the fields: `id`, `name`, `sourceUrl`, `memberItemIds`, `count`, `verified`, `explicit`.
- `count === memberItemIds.length` for every row.
- `verified` is a boolean, not a tier string.
- `explicit` is `false` for synthesized packages.

If the response is empty (`[]`) but the catalog has items, that means no source URL produced a group of size ≥ 2 — possible if the catalog is sparse. Hit `GET /api/marketplace/catalog` to inspect the items and confirm the synthesis rule is doing the right thing.

- [ ] **Step 4: Run the full UI + server test suites (split per workspace, matches Phase A's verified pattern)**

```bash
cd ui && pnpm vitest run --reporter=basic 2>&1 | tail -10
```

Expected: UI baseline (post-Phase-A: 1083 passing) plus the 3 new `usePackages` tests = 1086 passing.

```bash
cd ../server && pnpm vitest run --reporter=basic 2>&1 | tail -15
```

Expected: existing server tests all pass, plus 11 new from `derivePackages.test.ts` and 3 new from the route test. The exact server-side baseline isn't tracked in this plan — confirm by running the same command before Task 1 (or compare to git's pre-Task-1 SHA: `pnpm vitest run` from `server/` should be identical except for the +14 new tests).

- [ ] **Step 5: Final typecheck across the repo**

```bash
pnpm -r exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: No commit needed** — verification only.

---

## Out-of-scope (explicit deferrals to Phase C)

- **Package cards on the marketplace hub** (stacked-Sparkles + amber accent rule + "N skills" pill)
- **Package detail page** (`/marketplace/package/:id` with 2-col compact skill grid + flow-stage sub-filters)
- **"Part of [pkg] →" badge** above the name on individual skill detail pages
- **`PackageMetadata` augmentation** (curated names/descriptions per package — would either come from the catalog repo via explicit `packageId` + a separate metadata block, or from a hand-maintained AoA-side `packages.json`). Phase B leaves the package `name` as the bare repo name (e.g. `"gstack"`); Phase C UI can render `name` as-is until metadata enrichment is needed.
- **Empty package state in UI** (no packages yet → display a hint or fall back to flat item list). Phase C concern.
- **Cache layer for derived packages** — current implementation re-derives on every request. The catalog itself is cached in the DB; derivation walks the in-memory item list (~hundreds of items, microseconds). Add a memoization or in-memory cache only if a real performance issue appears.
- **Package sort order on the API** — currently `id ASC`. UI can resort client-side per its needs.
- **Pagination** — packages list is bounded by catalog size; ~10–20 packages typical. No pagination needed.
