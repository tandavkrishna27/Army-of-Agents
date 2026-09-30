# Marketplace Auto-Apply Skill Updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `skillUpdatePolicy = "auto"`, the update checker automatically applies catalog skill updates for unmodified skills and falls back to notify-only for skills the founder has edited.

**Architecture:** Extend the existing update checker inline — no new tables (only one new column), no new background jobs. The shared content-fetch helper is promoted from a private function in `skill-installer.ts` to an export in `fetch-resource.ts`. A new `skill-auto-updater.ts` owns the transactional apply logic. Two routes (`merge` endpoint + direct edit) set `customized = true` to protect founder edits.

**Tech Stack:** TypeScript, Drizzle ORM (postgres-js), Vitest, Express

**Spec:** `docs/superpowers/specs/2026-05-02-marketplace-auto-apply-design.md`

---

## File Map

| File | Status | Responsibility |
|------|--------|---------------|
| `packages/db/src/schema/company_skills.ts` | Modify | Add `customized` boolean column |
| `server/src/services/marketplace-install/fetch-resource.ts` | Modify | Export `loadSkillContent` (was private in skill-installer) |
| `server/src/services/marketplace-install/skill-installer.ts` | Modify | Import `loadSkillContent` from fetch-resource instead of local |
| `server/src/services/marketplace-install/skill-auto-updater.ts` | Create | `isWithinUpdateWindow`, typed errors, `applySkillUpdate` |
| `server/src/services/marketplace-update-checker.ts` | Modify | Settings-aware auto-apply logic, per-skill error isolation, return `{ inserted }` from upsert |
| `server/src/routes/marketplace-company.ts` | Modify | Merge endpoint sets `customized = true` |
| `server/src/routes/company-skills.ts` | Modify | Direct edit sets `customized = true` |
| `server/src/__tests__/skill-content.test.ts` | Create | Tests for `loadSkillContent` |
| `server/src/__tests__/skill-auto-updater.test.ts` | Create | Tests for `isWithinUpdateWindow` + `applySkillUpdate` |
| `server/src/__tests__/marketplace-update-checker.test.ts` | Create | Tests for update checker auto-apply logic |
| `server/src/__tests__/marketplace-company-customized.test.ts` | Create | Test merge endpoint sets `customized = true` |
| `server/src/__tests__/company-skills-customized.test.ts` | Create | Test direct edit sets `customized = true` |

---

### Task 1: Add `customized` column to `company_skills`

**Files:**
- Modify: `packages/db/src/schema/company_skills.ts`

No failing test first — schema changes are structural. After adding the column, subsequent tasks will use it in their tests.

- [ ] **Step 1: Add `boolean` import and the column**

Open `packages/db/src/schema/company_skills.ts`. Add `boolean` to the drizzle imports and the column definition:

```ts
import {
  pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, boolean,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companySkills = pgTable(
  "company_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    markdown: text("markdown").notNull(),
    sourceType: text("source_type").notNull().default("local_path"),
    sourceLocator: text("source_locator"),
    sourceRef: text("source_ref"),
    trustLevel: text("trust_level").notNull().default("markdown_only"),
    compatibility: text("compatibility").notNull().default("compatible"),
    fileInventory: jsonb("file_inventory")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    customized: boolean("customized").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUniqueIdx: uniqueIndex("company_skills_company_key_idx").on(
      table.companyId, table.key,
    ),
    companyNameIdx: index("company_skills_company_name_idx").on(
      table.companyId, table.name,
    ),
  }),
);
```

- [ ] **Step 2: Generate migration**

Run from the worktree root:

```bash
pnpm db:generate
```

Expected: a new migration file appears in `packages/db/drizzle/`. It should contain `ALTER TABLE "company_skills" ADD COLUMN "customized" boolean NOT NULL DEFAULT false;`

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema/company_skills.ts packages/db/drizzle/
git commit -m "feat(db): add customized column to company_skills"
```

---

### Task 2: Export `loadSkillContent` from `fetch-resource.ts`

`loadSkillContent` is currently a private function inside `skill-installer.ts`. Moving it to `fetch-resource.ts` makes it reusable by the auto-updater without duplication.

**Files:**
- Modify: `server/src/services/marketplace-install/fetch-resource.ts`
- Modify: `server/src/services/marketplace-install/skill-installer.ts`
- Create: `server/src/__tests__/skill-content.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/skill-content.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { CatalogItem } from "@armyofagents/shared";

// loadSkillContent doesn't exist as a named export yet — this import will fail
import { loadSkillContent } from "../services/marketplace-install/fetch-resource.js";

const BASE_ITEM: CatalogItem = {
  id: "skill:aoa-curated/code-review",
  type: "skill",
  name: "Code Review",
  description: "Reviews code for issues",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "https://example.com", locator: "content/skills/code-review", commitSha: "abc123" },
  resourceUrl: "https://raw.githubusercontent.com/example/abc123/SKILL.md",
  content: undefined,
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

describe("loadSkillContent", () => {
  it("returns inline content without making any HTTP request", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    const item = { ...BASE_ITEM, content: { inline: "# Code Review\n\nCheck for bugs." } };
    const result = await loadSkillContent(item);

    expect(result).toBe("# Code Review\n\nCheck for bugs.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches from resourceUrl when no inline content present", async () => {
    const body = "# Web Search\n\nFetched from CDN.";
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => body,
    })) as any;

    const result = await loadSkillContent(BASE_ITEM);

    expect(result).toBe(body);
    expect(global.fetch).toHaveBeenCalledWith(BASE_ITEM.resourceUrl, expect.any(Object));
  });

  it("throws an error containing 'HTTP 404' when fetch returns non-ok", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 })) as any;

    await expect(loadSkillContent(BASE_ITEM)).rejects.toThrow("HTTP 404");
  });

  it("throws when item has no inline content and no resourceUrl", async () => {
    const broken = { ...BASE_ITEM, resourceUrl: undefined };

    await expect(loadSkillContent(broken)).rejects.toThrow(/no resourceUrl/i);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd server && npx vitest run src/__tests__/skill-content.test.ts
```

Expected: FAIL — `loadSkillContent` is not exported from `fetch-resource.ts`.

- [ ] **Step 3: Add `loadSkillContent` export to `fetch-resource.ts`**

The full file after the change:

```ts
import type { CatalogItem } from "@armyofagents/shared";

export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetch the body of a catalog item's resourceUrl.
 *
 * Used by snapshot installers (skill/agent/team) for the HTTP-fetch path.
 * Returns the response body as text. Caller is responsible for parsing.
 *
 * @param item - Catalog item with a resourceUrl
 * @param kind - Human-readable label for error messages (e.g. "skill content", "agent template")
 * @throws Error if resourceUrl missing or HTTP returns non-ok
 */
export async function fetchCatalogResource(item: CatalogItem, kind: string): Promise<string> {
  if (!item.resourceUrl) {
    throw new Error(`${kind}: ${item.id} has no resourceUrl`);
  }
  const res = await fetch(item.resourceUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${kind}: HTTP ${res.status} from ${item.resourceUrl}`);
  }
  return await res.text();
}

/**
 * Resolve skill content from a catalog item.
 * Returns inline content if present (no network call), otherwise fetches from resourceUrl.
 *
 * Used by both the initial install flow and the auto-updater.
 */
export async function loadSkillContent(item: CatalogItem): Promise<string> {
  if (item.content?.inline) return item.content.inline;
  return fetchCatalogResource(item, "skill content");
}
```

- [ ] **Step 4: Update `skill-installer.ts` to import from `fetch-resource`**

Remove the private `loadSkillContent` function at the bottom of `skill-installer.ts` and add the import at the top. The full file after changes:

```ts
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companySkills } from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import { loadSkillContent } from "./fetch-resource.js";

export interface InstallSkillOpts {
  catalogItem: CatalogItem;
  companyId: string;
  db: Db;
}

export interface InstallSkillResult {
  skillId: string;
  alreadyInstalled?: boolean;
}

/**
 * Install a skill catalog item into a company's company_skills table.
 *
 * - Uses inline content if present (faster, no network).
 * - Falls back to HTTP GET on resourceUrl (commit-pinned by aggregator).
 * - Stores sourceType=catalog, sourceLocator=catalogItemId, sourceRef=version
 *   so future updates and idempotency checks can find the row.
 *
 * Includes an idempotency guard: returns `alreadyInstalled: true` if the same
 * version is already installed; throws a clean error if a different version
 * exists (use the update flow to upgrade instead of re-installing).
 */
export async function installSkill(opts: InstallSkillOpts): Promise<InstallSkillResult> {
  const { catalogItem, companyId, db } = opts;

  if (catalogItem.type !== "skill") {
    throw new Error(`installSkill called with non-skill item: ${catalogItem.id} (type=${catalogItem.type})`);
  }

  const key = catalogItem.id;

  const existing = await db
    .select({ id: companySkills.id, sourceRef: companySkills.sourceRef })
    .from(companySkills)
    .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, key)))
    .limit(1);

  if (existing.length > 0) {
    if (existing[0].sourceRef === catalogItem.version) {
      return { skillId: existing[0].id, alreadyInstalled: true };
    }
    throw new Error(
      `Skill ${key} is already installed at version ${existing[0].sourceRef}; ` +
      `catalog version is ${catalogItem.version}. Use the update flow to upgrade.`,
    );
  }

  const markdown = await loadSkillContent(catalogItem);

  const slug = catalogItem.id.split("/").pop() ?? catalogItem.id;

  const inserted = await db
    .insert(companySkills)
    .values({
      companyId,
      key,
      slug,
      name: catalogItem.name,
      description: catalogItem.description,
      markdown,
      sourceType: "catalog",
      sourceLocator: catalogItem.id,
      sourceRef: catalogItem.version,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [],
      metadata: {
        catalogCategory: catalogItem.category,
        catalogTags: catalogItem.tags,
        catalogTrustTier: catalogItem.trust.tier,
        installedAt: new Date().toISOString(),
      },
    })
    .returning();

  return { skillId: inserted[0].id };
}
```

- [ ] **Step 5: Run all skill-content tests and the existing install-skill tests**

```bash
cd server && npx vitest run src/__tests__/skill-content.test.ts src/__tests__/marketplace-install-skill.test.ts
```

Expected: all tests PASS. The existing install-skill tests verify the refactor didn't break behaviour.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/marketplace-install/fetch-resource.ts \
        server/src/services/marketplace-install/skill-installer.ts \
        server/src/__tests__/skill-content.test.ts
git commit -m "refactor: export loadSkillContent from fetch-resource for reuse"
```

---

### Task 3: Create `skill-auto-updater.ts`

This service owns the window check logic and the transactional apply function. Both are TDD'd before implementation.

**Files:**
- Create: `server/src/services/marketplace-install/skill-auto-updater.ts`
- Create: `server/src/__tests__/skill-auto-updater.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/skill-auto-updater.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { companySkills: tableProxy, marketplacePendingUpdates: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
}));
vi.mock("../services/marketplace-install/fetch-resource.js", () => ({
  loadSkillContent: vi.fn(),
}));
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: { updateCompleted: vi.fn() },
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn() },
}));

import {
  isWithinUpdateWindow,
  applySkillUpdate,
  SkillCustomizedError,
  SkillDeletedError,
} from "../services/marketplace-install/skill-auto-updater.js";
import { loadSkillContent } from "../services/marketplace-install/fetch-resource.js";
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
import type { CatalogItem } from "@armyofagents/shared";

const SKILL_ITEM: CatalogItem = {
  id: "skill:aoa-curated/code-review",
  type: "skill",
  name: "Code Review",
  description: "...",
  version: "1.1.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  resourceUrl: "https://raw.githubusercontent.com/.../SKILL.md",
  content: { inline: "# Code Review v1.1.0" },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

// ── isWithinUpdateWindow ──────────────────────────────────────────────────────

describe("isWithinUpdateWindow", () => {
  it("anytime — always returns true regardless of time", () => {
    expect(isWithinUpdateWindow("anytime", new Date("2026-05-04T10:00:00Z"))).toBe(true);
    expect(isWithinUpdateWindow("anytime", new Date("2026-05-04T03:00:00Z"))).toBe(true);
  });

  it("off_hours — returns true before 08:00 UTC", () => {
    expect(isWithinUpdateWindow("off_hours", new Date("2026-05-04T07:59:00Z"))).toBe(true);
  });

  it("off_hours — returns true at or after 20:00 UTC", () => {
    expect(isWithinUpdateWindow("off_hours", new Date("2026-05-04T20:00:00Z"))).toBe(true);
    expect(isWithinUpdateWindow("off_hours", new Date("2026-05-04T21:30:00Z"))).toBe(true);
  });

  it("off_hours — returns false during business hours (08:00–19:59 UTC)", () => {
    expect(isWithinUpdateWindow("off_hours", new Date("2026-05-04T10:00:00Z"))).toBe(false);
    expect(isWithinUpdateWindow("off_hours", new Date("2026-05-04T08:00:00Z"))).toBe(false);
  });

  it("weekends — returns true on Saturday (day=6)", () => {
    // 2026-05-02 is a Saturday
    expect(isWithinUpdateWindow("weekends", new Date("2026-05-02T12:00:00Z"))).toBe(true);
  });

  it("weekends — returns true on Sunday (day=0)", () => {
    // 2026-05-03 is a Sunday
    expect(isWithinUpdateWindow("weekends", new Date("2026-05-03T12:00:00Z"))).toBe(true);
  });

  it("weekends — returns false on a weekday", () => {
    // 2026-05-04 is a Monday
    expect(isWithinUpdateWindow("weekends", new Date("2026-05-04T12:00:00Z"))).toBe(false);
  });
});

// ── applySkillUpdate ──────────────────────────────────────────────────────────

function buildTx({
  skillRow = { id: "skill-1", customized: false },
  skillRows = skillRow ? [skillRow] : [],
}: { skillRow?: { id: string; customized: boolean } | null; skillRows?: any[] } = {}) {
  const updatedSkillValues: any[] = [];
  const updatedPendingValues: any[] = [];

  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(skillRows),
        }),
      }),
    }),
    update: (_table: any) => ({
      set: (values: any) => ({
        where: () => {
          if ("markdown" in values) updatedSkillValues.push(values);
          else updatedPendingValues.push(values);
          return Promise.resolve();
        },
      }),
    }),
    _updatedSkillValues: updatedSkillValues,
    _updatedPendingValues: updatedPendingValues,
  };
  return tx;
}

function buildDb(tx: any) {
  return {
    transaction: async (cb: (tx: any) => Promise<void>) => cb(tx),
  };
}

describe("applySkillUpdate", () => {
  const APPLY_ARGS = {
    catalogItemId: SKILL_ITEM.id,
    catalogItemName: SKILL_ITEM.name,
    companyId: "c1",
    catalogItem: SKILL_ITEM,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadSkillContent).mockResolvedValue("# Code Review v1.1.0");
    vi.mocked(marketplaceNotifications.updateCompleted).mockResolvedValue(undefined as any);
  });

  it("updates skill markdown, bumps sourceRef, marks pending applied, fires notification", async () => {
    const tx = buildTx();
    const db = buildDb(tx);

    await applySkillUpdate({ db: db as any, ...APPLY_ARGS });

    expect(tx._updatedSkillValues[0]).toMatchObject({
      markdown: "# Code Review v1.1.0",
      sourceRef: "1.1.0",
    });
    expect(tx._updatedPendingValues[0]).toMatchObject({ status: "applied" });
    expect(marketplaceNotifications.updateCompleted).toHaveBeenCalledWith(db, "c1", "Code Review");
  });

  it("throws SkillCustomizedError and makes no DB writes when customized=true inside tx", async () => {
    const tx = buildTx({ skillRow: { id: "skill-1", customized: true } });
    const db = buildDb(tx);

    await expect(applySkillUpdate({ db: db as any, ...APPLY_ARGS }))
      .rejects.toThrow(SkillCustomizedError);

    expect(tx._updatedSkillValues).toHaveLength(0);
    expect(tx._updatedPendingValues).toHaveLength(0);
    expect(marketplaceNotifications.updateCompleted).not.toHaveBeenCalled();
  });

  it("throws SkillDeletedError when skill row not found in DB", async () => {
    const tx = buildTx({ skillRow: null });
    const db = buildDb(tx);

    await expect(applySkillUpdate({ db: db as any, ...APPLY_ARGS }))
      .rejects.toThrow(SkillDeletedError);

    expect(tx._updatedSkillValues).toHaveLength(0);
  });

  it("does not rethrow when updateCompleted notification fails — DB is already committed", async () => {
    const tx = buildTx();
    const db = buildDb(tx);
    vi.mocked(marketplaceNotifications.updateCompleted).mockRejectedValue(new Error("Network error"));

    // Should resolve, not reject
    await expect(applySkillUpdate({ db: db as any, ...APPLY_ARGS })).resolves.toBeUndefined();

    // DB was still written
    expect(tx._updatedSkillValues[0]).toMatchObject({ markdown: "# Code Review v1.1.0" });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd server && npx vitest run src/__tests__/skill-auto-updater.test.ts
```

Expected: FAIL — `skill-auto-updater.js` does not exist.

- [ ] **Step 3: Create `skill-auto-updater.ts`**

Create `server/src/services/marketplace-install/skill-auto-updater.ts`:

```ts
/**
 * @fileoverview Auto-applies a catalog skill update for a company.
 *
 * Gating logic (policy + window) lives in the update checker. This module
 * owns the transactional apply: re-checks the `customized` flag inside the
 * transaction to avoid acting on stale data, then updates the skill's markdown
 * and marks the pending row as applied.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companySkills, marketplacePendingUpdates } from "@armyofagents/db";
import type { CatalogItem, MarketplaceSettings } from "@armyofagents/shared";
import { loadSkillContent } from "./fetch-resource.js";
import { marketplaceNotifications } from "../marketplace-notifications.js";
import { logger } from "../../middleware/logger.js";

export type UpdateWindow = MarketplaceSettings["updateWindow"];

/**
 * Returns true if the current UTC time falls within the configured update window.
 * @param window - The update window setting from company marketplace settings.
 * @param now - Defaults to new Date(). Pass a fixed date in tests.
 */
export function isWithinUpdateWindow(window: UpdateWindow, now: Date = new Date()): boolean {
  const hour = now.getUTCHours();
  const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday

  switch (window) {
    case "anytime":   return true;
    case "off_hours": return hour < 8 || hour >= 20;
    case "weekends":  return day === 0 || day === 6;
  }
}

/** Thrown when the skill was customized by the founder — fall back to notify. */
export class SkillCustomizedError extends Error {
  constructor(catalogItemId: string) {
    super(`Skill ${catalogItemId} has been customized by the founder; skipping auto-apply`);
    this.name = "SkillCustomizedError";
  }
}

/** Thrown when the skill row no longer exists — skip silently, no notification. */
export class SkillDeletedError extends Error {
  constructor(catalogItemId: string) {
    super(`Skill ${catalogItemId} not found in company_skills; may have been deleted`);
    this.name = "SkillDeletedError";
  }
}

/**
 * Auto-applies a catalog skill update to a company's installed skill.
 *
 * Steps:
 * 1. Fetch the new content (network call, outside transaction).
 * 2. Inside a transaction: re-read `customized` flag; throw typed errors if
 *    customized or deleted; update markdown + sourceRef; mark pending as applied.
 * 3. Fire updateCompleted notification (outside transaction — failure is logged,
 *    not rethrown, because the DB is already committed).
 *
 * Throws: SkillCustomizedError | SkillDeletedError | Error (fetch/DB failures).
 * Callers are responsible for catching and deciding the fallback.
 */
export async function applySkillUpdate(args: {
  db: Db;
  catalogItemId: string;
  catalogItemName: string;
  companyId: string;
  catalogItem: CatalogItem;
}): Promise<void> {
  const { db, catalogItemId, catalogItemName, companyId, catalogItem } = args;

  // Step 1: fetch content outside transaction (network call — don't hold tx open)
  const newMarkdown = await loadSkillContent(catalogItem);

  // Step 2: transaction — re-read customized, update skill, mark pending applied
  await db.transaction(async (tx) => {
    const [skillRow] = await tx
      .select({ id: companySkills.id, customized: companySkills.customized })
      .from(companySkills)
      .where(
        and(
          eq(companySkills.companyId, companyId),
          eq(companySkills.sourceLocator, catalogItemId),
        ),
      )
      .limit(1);

    if (!skillRow) throw new SkillDeletedError(catalogItemId);
    if (skillRow.customized) throw new SkillCustomizedError(catalogItemId);

    await tx
      .update(companySkills)
      .set({ markdown: newMarkdown, sourceRef: catalogItem.version, updatedAt: new Date() })
      .where(eq(companySkills.id, skillRow.id));

    // Mark the pending row applied (filter by catalogItemId + status=pending so a
    // concurrent run that already applied it is a no-op, not an error)
    await tx
      .update(marketplacePendingUpdates)
      .set({ status: "applied", updatedAt: new Date() })
      .where(
        and(
          eq(marketplacePendingUpdates.companyId, companyId),
          eq(marketplacePendingUpdates.catalogItemId, catalogItemId),
          eq(marketplacePendingUpdates.status, "pending"),
        ),
      );
  });

  // Step 3: notify — swallow errors so they don't unwind the committed transaction
  try {
    await marketplaceNotifications.updateCompleted(db, companyId, catalogItemName);
  } catch (err) {
    logger.error({ err, companyId, catalogItemId }, "marketplace: updateCompleted notification failed after auto-apply");
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd server && npx vitest run src/__tests__/skill-auto-updater.test.ts
```

Expected: all 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/marketplace-install/skill-auto-updater.ts \
        server/src/__tests__/skill-auto-updater.test.ts
git commit -m "feat: add skill-auto-updater service with window utility and transactional apply"
```

---

### Task 4: Extend the update checker with settings-aware auto-apply

**Files:**
- Modify: `server/src/services/marketplace-update-checker.ts`
- Create: `server/src/__tests__/marketplace-update-checker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/marketplace-update-checker.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return {
    marketplacePendingUpdates: tableProxy,
    companies: tableProxy,
    companySkills: tableProxy,
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
}));
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: {
    updateAvailable: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../services/marketplace-settings.js", () => ({
  marketplaceSettingsService: vi.fn(() => ({
    get: vi.fn().mockResolvedValue({
      skillUpdatePolicy: "notify",
      updateWindow: "anytime",
    }),
  })),
}));
vi.mock("../services/marketplace-install/skill-auto-updater.js", () => ({
  applySkillUpdate: vi.fn().mockResolvedValue(undefined),
  isWithinUpdateWindow: vi.fn().mockReturnValue(true),
  SkillCustomizedError: class SkillCustomizedError extends Error {
    constructor(id: string) { super(id); this.name = "SkillCustomizedError"; }
  },
  SkillDeletedError: class SkillDeletedError extends Error {
    constructor(id: string) { super(id); this.name = "SkillDeletedError"; }
  },
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn() },
}));

import { runUpdateCheck, upsertPendingUpdate, compareVersions } from "../services/marketplace-update-checker.js";
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
import { marketplaceSettingsService } from "../services/marketplace-settings.js";
import { applySkillUpdate, isWithinUpdateWindow, SkillCustomizedError, SkillDeletedError } from "../services/marketplace-install/skill-auto-updater.js";
import type { CatalogItem } from "@armyofagents/shared";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SKILL_CATALOG_ITEM: CatalogItem = {
  id: "skill:aoa-curated/code-review",
  type: "skill",
  name: "Code Review",
  description: "...",
  version: "1.1.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  resourceUrl: "https://example.com/SKILL.md",
  content: { inline: "# Code Review v1.1.0" },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

function buildMockDb({
  skillRows = [{ sourceLocator: SKILL_CATALOG_ITEM.id, sourceRef: "1.0.0" }],
  insertReturning = [{ id: "upd-1" }],
}: {
  skillRows?: Array<{ sourceLocator: string; sourceRef: string }>;
  insertReturning?: Array<{ id: string }>;
} = {}) {
  let selectCall = 0;
  return {
    select: () => {
      selectCall++;
      const n = selectCall;
      return {
        from: () => {
          if (n === 1) return Promise.resolve([{ id: "c1" }]); // companies
          return { where: () => Promise.resolve(skillRows) };   // companySkills
        },
      };
    },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(insertReturning),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
}

// ─── compareVersions ──────────────────────────────────────────────────────────

describe("compareVersions", () => {
  it("returns positive when latest > current", () => {
    expect(compareVersions("1.1.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });
  it("returns 0 when versions are equal", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
  it("returns negative when latest < current", () => {
    expect(compareVersions("0.9.0", "1.0.0")).toBeLessThan(0);
  });
});

// ─── upsertPendingUpdate ──────────────────────────────────────────────────────

describe("upsertPendingUpdate", () => {
  it("returns { inserted: false } when latest version is not newer than current", async () => {
    const db = buildMockDb();
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.0.0",
      latestVersion: "1.0.0", // same version
    });
    expect(result).toEqual({ inserted: false });
  });

  it("returns { inserted: true } when a new row is inserted", async () => {
    const db = buildMockDb({ insertReturning: [{ id: "upd-1" }] });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
    });
    expect(result).toEqual({ inserted: true });
  });

  it("returns { inserted: false } on conflict (row already exists)", async () => {
    const db = buildMockDb({ insertReturning: [] }); // empty = conflict
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
    });
    expect(result).toEqual({ inserted: false });
  });
});

// ─── runUpdateCheck auto-apply logic ─────────────────────────────────────────

describe("runUpdateCheck — notify policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(marketplaceSettingsService).mockReturnValue({
      get: vi.fn().mockResolvedValue({ skillUpdatePolicy: "notify", updateWindow: "anytime" }),
    } as any);
    vi.mocked(isWithinUpdateWindow).mockReturnValue(true);
  });

  it("fires updateAvailable and does NOT call applySkillUpdate when policy is notify", async () => {
    const db = buildMockDb();
    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledOnce();
    expect(applySkillUpdate).not.toHaveBeenCalled();
  });
});

describe("runUpdateCheck — auto policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(marketplaceSettingsService).mockReturnValue({
      get: vi.fn().mockResolvedValue({ skillUpdatePolicy: "auto", updateWindow: "anytime" }),
    } as any);
    vi.mocked(isWithinUpdateWindow).mockReturnValue(true);
    vi.mocked(applySkillUpdate).mockResolvedValue(undefined);
  });

  it("calls applySkillUpdate (not updateAvailable) when policy=auto and in window", async () => {
    const db = buildMockDb();
    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(applySkillUpdate).toHaveBeenCalledOnce();
    expect(marketplaceNotifications.updateAvailable).not.toHaveBeenCalled();
  });

  it("fires updateAvailable as fallback when outside update window", async () => {
    vi.mocked(isWithinUpdateWindow).mockReturnValue(false);
    const db = buildMockDb();
    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(applySkillUpdate).not.toHaveBeenCalled();
    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledOnce();
  });

  it("fires updateAvailable as fallback when applySkillUpdate throws SkillCustomizedError", async () => {
    vi.mocked(applySkillUpdate).mockRejectedValue(new SkillCustomizedError("skill:x"));
    const db = buildMockDb();
    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledOnce();
  });

  it("fires updateAvailable as fallback when applySkillUpdate throws a fetch error", async () => {
    vi.mocked(applySkillUpdate).mockRejectedValue(new Error("HTTP 503"));
    const db = buildMockDb();
    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledOnce();
  });

  it("skips notification (but continues) when SkillDeletedError is thrown", async () => {
    vi.mocked(applySkillUpdate).mockRejectedValue(new SkillDeletedError("skill:x"));
    const db = buildMockDb();
    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(marketplaceNotifications.updateAvailable).not.toHaveBeenCalled();
  });

  it("processes remaining skills even when one skill throws", async () => {
    const SKILL_2: CatalogItem = { ...SKILL_CATALOG_ITEM, id: "skill:aoa-curated/web-search", name: "Web Search" };
    vi.mocked(applySkillUpdate)
      .mockRejectedValueOnce(new Error("Unexpected error for skill 1"))
      .mockResolvedValueOnce(undefined);

    const db = {
      ...buildMockDb({
        skillRows: [
          { sourceLocator: SKILL_CATALOG_ITEM.id, sourceRef: "1.0.0" },
          { sourceLocator: SKILL_2.id, sourceRef: "1.0.0" },
        ],
      }),
    };

    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM, SKILL_2]);

    // Both skills attempted; second succeeds
    expect(applySkillUpdate).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd server && npx vitest run src/__tests__/marketplace-update-checker.test.ts
```

Expected: multiple failures — the update checker doesn't yet import settings or call `applySkillUpdate`.

- [ ] **Step 3: Rewrite `marketplace-update-checker.ts`**

Full file after changes (import `CatalogItem` from shared instead of local type, change `upsertPendingUpdate` return type, add settings-aware logic to `checkCompany`):

```ts
/**
 * @fileoverview Marketplace update checker.
 *
 * Compares installed catalog items against the current catalog version,
 * creates/updates rows in marketplace_pending_updates.
 *
 * Called after catalog sync completes and on startup.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  marketplacePendingUpdates,
  companies,
  companySkills,
} from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import { marketplaceNotifications } from "./marketplace-notifications.js";
import { marketplaceSettingsService } from "./marketplace-settings.js";
import {
  applySkillUpdate,
  isWithinUpdateWindow,
  SkillCustomizedError,
  SkillDeletedError,
} from "./marketplace-install/skill-auto-updater.js";
import { logger } from "../middleware/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pure utility functions (exported for unit testing)
// ─────────────────────────────────────────────────────────────────────────────

export function compareVersions(latest: string, current: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((p) => parseInt(p, 10) || 0);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj! > cMaj! ? 1 : -1;
  if (lMin !== cMin) return lMin! > cMin! ? 1 : -1;
  if (lPat !== cPat) return lPat! > cPat! ? 1 : -1;
  return 0;
}

type UpdatePolicy = "auto_patch" | "auto_minor" | "notify_all" | "auto" | "notify";

export function isUpdateAvailable(current: string, latest: string, policy: UpdatePolicy): boolean {
  if (compareVersions(latest, current) <= 0) return false;

  if (policy === "auto" || policy === "notify" || policy === "notify_all") return true;

  const [lMaj, lMin] = latest.split(".").map(Number);
  const [cMaj, cMin] = current.split(".").map(Number);

  if (policy === "auto_minor") return lMaj === cMaj;
  if (policy === "auto_patch") return lMaj === cMaj && lMin === cMin;

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main checker
// ─────────────────────────────────────────────────────────────────────────────

export async function runUpdateCheck(db: Db, catalogItems: CatalogItem[]): Promise<void> {
  const allCompanies = await db.select({ id: companies.id }).from(companies);

  for (const company of allCompanies) {
    await checkCompany(db, catalogItems, company.id);
  }
}

async function checkCompany(db: Db, catalogItems: CatalogItem[], companyId: string): Promise<void> {
  try {
    const catalogMap = new Map<string, { version: string; name: string; type: string }>();
    for (const item of catalogItems) {
      if (item.version) {
        catalogMap.set(item.id, { version: item.version, name: item.name, type: item.type });
      }
    }

    // Read settings once per company — not per skill
    const settings = await marketplaceSettingsService(db).get(companyId);

    // Check skills (sourceType=catalog means they came from marketplace)
    const skillRows = await db
      .select({ sourceLocator: companySkills.sourceLocator, sourceRef: companySkills.sourceRef })
      .from(companySkills)
      .where(
        and(
          eq(companySkills.companyId, companyId),
          eq(companySkills.sourceType, "catalog"),
        ),
      );

    for (const skill of skillRows) {
      if (!skill.sourceLocator || !skill.sourceRef) continue;
      const catalogEntry = catalogMap.get(skill.sourceLocator);
      if (!catalogEntry) continue;

      try {
        const { inserted } = await upsertPendingUpdate(db, companyId, {
          catalogItemId: skill.sourceLocator,
          catalogItemName: catalogEntry.name,
          itemType: "skill",
          currentVersion: skill.sourceRef,
          latestVersion: catalogEntry.version,
        });

        if (!inserted) continue; // Already knew about this update — no action needed

        if (
          settings.skillUpdatePolicy === "auto" &&
          isWithinUpdateWindow(settings.updateWindow)
        ) {
          // Note: customized flag is re-checked inside applySkillUpdate's transaction.
          // We intentionally do NOT pre-check it here to avoid stale data.
          const catalogItem = catalogItems.find((i) => i.id === skill.sourceLocator);
          if (!catalogItem) {
            // Defensive: full CatalogItem not in the provided list
            void marketplaceNotifications
              .updateAvailable(db, companyId, catalogEntry.name, skill.sourceRef, catalogEntry.version)
              .catch((err) => logger.error({ err }, "marketplace: updateAvailable notification failed"));
            continue;
          }

          try {
            await applySkillUpdate({
              db,
              catalogItemId: skill.sourceLocator,
              catalogItemName: catalogEntry.name,
              companyId,
              catalogItem,
            });
            // updateCompleted notification fired inside applySkillUpdate
          } catch (err) {
            if (err instanceof SkillDeletedError) {
              // Skill was deleted between check and apply — skip silently
              logger.error({ err, catalogItemId: skill.sourceLocator }, "marketplace: skill deleted during auto-apply");
            } else {
              // SkillCustomizedError or any other error — fall back to notify
              logger.error({ err, catalogItemId: skill.sourceLocator }, "marketplace: auto-apply failed, falling back to notify");
              void marketplaceNotifications
                .updateAvailable(db, companyId, catalogEntry.name, skill.sourceRef, catalogEntry.version)
                .catch((notifErr) => logger.error({ notifErr }, "marketplace: fallback updateAvailable failed"));
            }
          }
        } else {
          // notify-only path (policy=notify or outside window)
          void marketplaceNotifications
            .updateAvailable(db, companyId, catalogEntry.name, skill.sourceRef, catalogEntry.version)
            .catch((err) => logger.error({ err }, "marketplace: updateAvailable notification failed"));
        }
      } catch (err) {
        // Per-skill isolation: one skill error doesn't block the rest
        logger.error({ err, catalogItemId: skill.sourceLocator, companyId }, "marketplace-update-checker: per-skill error");
      }
    }
    // TODO: Add agent + team template checks when templateOrigin/templateVersion
    // columns are added to those schemas.
  } catch (err) {
    logger.error({ err, companyId }, "marketplace-update-checker: error checking company");
  }
}

export async function upsertPendingUpdate(
  db: Db,
  companyId: string,
  data: {
    catalogItemId: string;
    catalogItemName: string;
    itemType: string;
    currentVersion: string;
    latestVersion: string;
  },
): Promise<{ inserted: boolean }> {
  if (compareVersions(data.latestVersion, data.currentVersion) <= 0) return { inserted: false };

  // Two-step: insert ignoring conflict, then update only if still pending
  const inserted = await db
    .insert(marketplacePendingUpdates)
    .values({
      companyId,
      catalogItemId: data.catalogItemId,
      catalogItemName: data.catalogItemName,
      itemType: data.itemType,
      currentVersion: data.currentVersion,
      latestVersion: data.latestVersion,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning({ id: marketplacePendingUpdates.id });

  if (inserted.length > 0) {
    // New row inserted — caller decides whether to notify or auto-apply
    return { inserted: true };
  }

  // Existing pending row — bump latestVersion in case it has advanced since last check
  await db
    .update(marketplacePendingUpdates)
    .set({ latestVersion: data.latestVersion, updatedAt: new Date() })
    .where(
      and(
        eq(marketplacePendingUpdates.companyId, companyId),
        eq(marketplacePendingUpdates.catalogItemId, data.catalogItemId),
        eq(marketplacePendingUpdates.status, "pending"),
      ),
    );

  return { inserted: false };
}
```

- [ ] **Step 4: Run all update checker tests**

```bash
cd server && npx vitest run src/__tests__/marketplace-update-checker.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Run existing route tests to check for regressions**

```bash
cd server && npx vitest run src/__tests__/marketplace-routes.test.ts src/__tests__/marketplace-install-routes.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/marketplace-update-checker.ts \
        server/src/__tests__/marketplace-update-checker.test.ts
git commit -m "feat: settings-aware auto-apply in marketplace update checker"
```

---

### Task 5: Set `customized = true` when founder merges a skill update

**Files:**
- Modify: `server/src/routes/marketplace-company.ts` (the merge endpoint, ~line 293)
- Create: `server/src/__tests__/marketplace-company-customized.test.ts`

- [ ] **Step 1: Write failing test**

Create `server/src/__tests__/marketplace-company-customized.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return {
    marketplacePendingUpdates: tableProxy,
    companySkills: tableProxy,
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  ne: () => Symbol("ne"),
}));
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: {
    installRequested: vi.fn(),
  },
}));
vi.mock("../services/marketplace-settings.js", () => ({
  marketplaceSettingsService: vi.fn(() => ({ get: vi.fn(), patch: vi.fn() })),
}));
vi.mock("../services/marketplace-merge.js", () => ({
  computeSectionDiff: vi.fn(() => [{ heading: "## Overview", mine: "old", theirs: "new" }]),
  applyMergeDecisions: vi.fn(() => "# Merged Content"),
}));
vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));

import { createMarketplaceCompanyRouter } from "../routes/marketplace-company.js";

function buildApp(dbOverrides: any = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.actor = { type: "board", source: "local_implicit", userId: "u1", companyId: "c1" };
    next();
  });

  const UPDATE_ROW = {
    id: "upd-1",
    companyId: "c1",
    catalogItemId: "skill:aoa-curated/code-review",
    catalogItemName: "Code Review",
    itemType: "skill",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    status: "pending",
  };
  const SKILL_ROW = { id: "skill-1", markdown: "# Old Content" };

  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([UPDATE_ROW]),
        then: (r: any) => r([UPDATE_ROW]),
      }),
    }),
    update: () => ({
      set: (values: any) => ({
        where: () => {
          dbOverrides.capturedSets?.push(values);
          return Promise.resolve();
        },
      }),
    }),
    ...dbOverrides.db,
  };

  // Second select for skill row needs different data
  let selectCall = 0;
  const smartDb = {
    select: () => {
      selectCall++;
      const n = selectCall;
      return {
        from: () => ({
          where: () => Promise.resolve(n === 1 ? [UPDATE_ROW] : [SKILL_ROW]),
        }),
      };
    },
    update: db.update,
  };

  const router = createMarketplaceCompanyRouter({
    db: smartDb as any,
    catalogService: {
      readCache: async () => ({
        schemaVersion: "1.0.0",
        generatedAt: "2026-04-30T00:00:00Z",
        itemCount: 1,
        items: [{
          id: "skill:aoa-curated/code-review",
          type: "skill" as const,
          name: "Code Review",
          description: "...",
          version: "1.1.0",
          source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
          resourceUrl: "https://example.com/SKILL.md",
          trust: { tier: "verified" as const, source: "aoa-curated" },
          status: "active" as const,
          addedAt: "2026-04-30T00:00:00Z",
          category: "engineering" as const,
          tags: [],
        }],
      }),
    },
  });

  app.use("/api/companies/:companyId/marketplace", router);
  return { app, smartDb };
}

describe("POST /updates/:id/merge — sets customized = true", () => {
  it("includes customized: true in the skill update SET clause", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => "# New upstream content",
    })) as any;

    const capturedSets: any[] = [];
    const { app } = buildApp({ capturedSets });

    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/merge")
      .send({ decisions: { "## Overview": "theirs" } });

    expect(res.status).toBe(200);
    // Fails before the fix — current code omits customized from the SET clause
    expect(capturedSets.some((s) => s.customized === true)).toBe(true);
  });
});
```

The test captures SET clause arguments and asserts `customized: true` — this fails before the fix because the current merge endpoint only sets `markdown + sourceRef`.

- [ ] **Step 2: Run test — verify it fails**

```bash
cd server && npx vitest run src/__tests__/marketplace-company-customized.test.ts
```

Expected: FAIL — `skillSets[0]` does not contain `customized: true` (the current code only sets `markdown + sourceRef`).

- [ ] **Step 3: Add `customized: true` to the merge endpoint SET clause**

In `server/src/routes/marketplace-company.ts`, find the skill update inside `POST /updates/:id/merge` (~line 293):

```ts
// Before (current code):
await db
  .update(companySkills)
  .set({ markdown: merged, sourceRef: update.latestVersion })
  .where(eq(companySkills.id, skill.id));
```

Change to:

```ts
// After:
await db
  .update(companySkills)
  .set({ markdown: merged, sourceRef: update.latestVersion, customized: true, updatedAt: new Date() })
  .where(eq(companySkills.id, skill.id));
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd server && npx vitest run src/__tests__/marketplace-company-customized.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the existing marketplace-company tests too**

```bash
cd server && npx vitest run src/__tests__/marketplace-routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/marketplace-company.ts \
        server/src/__tests__/marketplace-company-customized.test.ts
git commit -m "feat: set customized=true on skill when founder accepts a merge"
```

---

### Task 6: Set `customized = true` when founder directly edits a skill

**Files:**
- Modify: `server/src/routes/company-skills.ts` (after `svc.updateFile()` call, ~line 134)
- Create: `server/src/__tests__/company-skills-customized.test.ts`

- [ ] **Step 1: Write failing test**

Create `server/src/__tests__/company-skills-customized.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../services/index.js", () => ({
  accessService: vi.fn(() => ({ canUser: vi.fn().mockResolvedValue(true) })),
  agentService: vi.fn(() => ({})),
  companySkillService: vi.fn(() => ({
    updateFile: vi.fn().mockResolvedValue({ id: "skill-1", path: "SKILL.md", markdown: "# New" }),
    list: vi.fn(),
  })),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn(() => ({ actorType: "board", actorId: "u1", agentId: null, runId: null })),
}));
vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { companySkills: tableProxy };
});
vi.mock("drizzle-orm", () => ({ eq: () => Symbol("eq") }));

import express from "express";
import request from "supertest";
import { companySkillRoutes } from "../routes/company-skills.js";

describe("PATCH /companies/:companyId/skills/:skillId/files — sets customized = true", () => {
  it("calls db.update(companySkills).set({ customized: true }) after updateFile", async () => {
    const skillSets: any[] = [];
    const db = {
      update: (_table: any) => ({
        set: (values: any) => ({
          where: () => {
            skillSets.push(values);
            return Promise.resolve();
          },
        }),
      }),
    };

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.actor = { type: "board", source: "local_implicit", userId: "u1", isInstanceAdmin: true };
      next();
    });
    app.use(companySkillRoutes(db as any));

    const res = await request(app)
      .patch("/companies/c1/skills/skill-1/files")
      .send({ path: "SKILL.md", content: "# Updated skill" });

    expect(res.status).toBe(200);
    expect(skillSets.some((s) => s.customized === true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd server && npx vitest run src/__tests__/company-skills-customized.test.ts
```

Expected: FAIL — the route doesn't yet set `customized = true`.

- [ ] **Step 3: Add imports and `customized = true` update to `company-skills.ts`**

At the top of `server/src/routes/company-skills.ts`, add the two new imports (after existing imports):

```ts
import { eq } from "drizzle-orm";
import { companySkills } from "@armyofagents/db";
```

Then in the `PATCH /companies/:companyId/skills/:skillId/files` handler, add the update right after `svc.updateFile()` returns. The full handler after the change:

```ts
  router.patch(
    "/companies/:companyId/skills/:skillId/files",
    validate(companySkillFileUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.updateFile(
        companyId,
        skillId,
        String(req.body.path ?? ""),
        String(req.body.content ?? ""),
      );

      // Mark the skill as customized so the auto-updater skips it in future runs
      await db.update(companySkills).set({ customized: true }).where(eq(companySkills.id, skillId));

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_file_updated",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          path: result.path,
          markdown: result.markdown,
        },
      });

      res.json(result);
    },
  );
```

- [ ] **Step 4: Run tests**

```bash
cd server && npx vitest run src/__tests__/company-skills-customized.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full server test suite to check for regressions**

```bash
cd server && npx vitest run
```

Expected: all tests PASS (or only previously-known failures remain — compare against baseline on `main`).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/company-skills.ts \
        server/src/__tests__/company-skills-customized.test.ts
git commit -m "feat: set customized=true on skill when founder edits directly"
```

---

## Done

All 6 tasks complete. The auto-apply feature is fully implemented:

- `customized` column tracks founder edits from both paths
- `loadSkillContent` is shared between installer and auto-updater  
- `applySkillUpdate` transactionally updates skill content and marks the pending row applied
- `isWithinUpdateWindow` gates updates by time of day / day of week
- The update checker reads settings per company, auto-applies when policy=auto + in-window, falls back to notify on any failure
- Both edit paths (`merge` endpoint + direct edit) correctly flip `customized = true`
