# Memory Page Redesign — Phase 6.0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the schema, services, routes, and LiveEvents wiring that the new memory page UI (Phase 6.1+) will consume. Zero UI changes — this plan ends with a working API surface and a green test suite.

**Architecture:** Drizzle schema additions (`folderPath` column on `memory_items` + new `memory_assets` and `memory_folders` tables) → Express service+route pairs following existing AoA patterns (`fileImportService` is the closest analogue) → LiveEvents publishes for real-time tree updates → seed-on-department-creation hook → SQL backfill for existing items.

**Tech Stack:** Drizzle ORM 0.38, drizzle-kit 0.31, Express 5.x, Express `Router`, Zod validators, `multer` for multipart upload (already a dep), Vitest with mocked DB pattern (the `createSequenceDb` style used across `server/src/__tests__/`), `StorageService` provider abstraction (already shipped).

**Spec reference:** [`docs/superpowers/specs/2026-05-02-memory-page-redesign-design.md`](../specs/2026-05-02-memory-page-redesign-design.md)

---

## File Structure

### New files

```
packages/db/src/schema/memory_assets.ts                   ← raw uploaded files
packages/db/src/schema/memory_folders.ts                  ← user/seeded folders
packages/db/src/migrations/00XX_*.sql                     ← auto-generated
packages/db/src/migrations/00XY_memory_folder_path_backfill.sql ← data migration
packages/shared/src/types/memory-asset.ts
packages/shared/src/types/memory-folder.ts
packages/shared/src/validators/memory-asset.ts
packages/shared/src/validators/memory-folder.ts
server/src/services/memory-folders.ts                     ← folder CRUD
server/src/services/memory-assets.ts                      ← asset CRUD + streaming
server/src/services/memory-folder-seeds.ts                ← functionType → seed paths
server/src/routes/memory-folders.ts
server/src/routes/memory-assets.ts
server/src/__tests__/memory-folders-service.test.ts
server/src/__tests__/memory-assets-service.test.ts
server/src/__tests__/memory-folders-routes.test.ts
server/src/__tests__/memory-assets-routes.test.ts
server/src/__tests__/memory-folder-seeds.test.ts
server/src/__tests__/memory-folder-path-migration.test.ts
```

### Modified files

```
packages/db/src/schema/memory_items.ts            ← +folderPath, +founderPinnedToTop, +lastAccessedByUserId
packages/db/src/schema/index.ts                   ← export new tables
packages/shared/src/constants.ts                  ← +LIVE_EVENT_TYPES entries (8 new)
packages/shared/src/index.ts                      ← re-export new types/validators
server/src/services/memory.ts                     ← +moveItem, +setPinnedToTop methods
server/src/routes/memory.ts                       ← +/items/:id/move, +/items/:id/pin-to-top
server/src/services/projects.ts                   ← seed folders on dept create
server/src/app.ts                                 ← mount new route modules
```

### Why this split

Schemas are isolated per table (AoA convention — every table has its own file in `packages/db/src/schema/`). Services and routes are paired — `memory-folders.ts` for folders, `memory-assets.ts` for assets — to keep change-together-stay-together. The seed-map is a separate file (`memory-folder-seeds.ts`) because it's a static lookup with no DB access; this keeps the folder service stateless. Modifications to existing files are limited to additive changes (new methods, new exports) — no rewrites.

---

## Task 1: Add columns to `memory_items` schema

**Files:**
- Modify: `packages/db/src/schema/memory_items.ts`

- [ ] **Step 1: Add the three new columns**

Open `packages/db/src/schema/memory_items.ts`. Inside the column definition block (after line 81, before the `createdAt` line), add:

```typescript
    // Phase 6: tree path within the dept's memory hierarchy. Empty string = dept root.
    // POSIX-style with `/` separators. e.g. "Engineering/Decisions" or "Company".
    folderPath: text("folder_path").notNull().default(""),
    // Phase 6: tracks which user last opened this item in the explorer (for Recents on home).
    // Distinct from accessedAt (used by staleness detection).
    lastAccessedByUserId: uuid("last_accessed_by_user_id"),
    // Phase 6: drives the virtual "Pinned" folder at the top of the tree.
    // NOT the same as pinnedToSkill (which materializes into agent skill files).
    founderPinnedToTop: boolean("founder_pinned_to_top").notNull().default(false),
```

- [ ] **Step 2: Add an index for folder-path queries**

In the same file, inside the `(table) => ({ ... })` block (after the existing indexes), add:

```typescript
    folderPathIdx: index("memory_items_folder_path_idx").on(
      table.companyId,
      table.departmentId,
      table.folderPath,
    ),
    foundersPinnedIdx: index("memory_items_founder_pinned_idx").on(
      table.companyId,
      table.founderPinnedToTop,
    ),
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @armyofagents/db typecheck`
Expected: `0 errors`

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/memory_items.ts
git commit -m "feat(memory): add folderPath, founderPinnedToTop, lastAccessedByUserId columns to memory_items"
```

---

## Task 2: Create `memory_assets` schema

**Files:**
- Create: `packages/db/src/schema/memory_assets.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create the schema file**

Create `packages/db/src/schema/memory_assets.ts`:

```typescript
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { fileImportJobs } from "./file_import_jobs.js";

/**
 * Phase 6: raw uploaded files (PDF, DOCX, image, video, PPTX, TXT) as
 * first-class tree nodes. Sibling concept to `memory_items` — both share
 * folderPath. Asset bytes live in StorageService at `storageKey`.
 *
 * Distinct from `memory_items` because the content here is a blob, not text.
 * Many assets generate multiple `memory_items` via the file-import pipeline;
 * those items reference the asset via `memory_items.sourceAssetId` (a column
 * we add in a follow-up phase) or via `importJobId` for assets that came in
 * through the legacy file-import flow.
 */
export const memoryAssets = pgTable(
  "memory_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    folderPath: text("folder_path").notNull().default(""),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    storageKey: text("storage_key").notNull(),
    importJobId: uuid("import_job_id").references((): AnyPgColumn => fileImportJobs.id, {
      onDelete: "set null",
    }),
    extractedItemCount: integer("extracted_item_count").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    uploadedByUserId: uuid("uploaded_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("memory_assets_company_idx").on(table.companyId),
    companyFolderIdx: index("memory_assets_company_folder_idx").on(
      table.companyId,
      table.departmentId,
      table.folderPath,
    ),
    importJobIdx: index("memory_assets_import_job_idx").on(table.importJobId),
  }),
);
```

- [ ] **Step 2: Export from the schema index**

Open `packages/db/src/schema/index.ts`. After the `memoryItems` export (line 40), add:

```typescript
export { memoryAssets } from "./memory_assets.js";
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @armyofagents/db typecheck`
Expected: `0 errors`

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/memory_assets.ts packages/db/src/schema/index.ts
git commit -m "feat(memory): add memory_assets schema for raw uploaded files"
```

---

## Task 3: Create `memory_folders` schema

**Files:**
- Create: `packages/db/src/schema/memory_folders.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create the schema file**

Create `packages/db/src/schema/memory_folders.ts`:

```typescript
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/**
 * Phase 6: user-created and seeded folders within the memory tree.
 *
 * - Seeded folders (e.g. "Engineering/Decisions") get a row when created
 *   via memoryFolderSeedsService on department creation. seedKey is set
 *   so we know not to delete them by accident.
 * - User-created folders also get a row. seedKey is null.
 * - Virtual folders (Pending Review, Active Goals, Pinned, Working) do NOT
 *   live in this table — they're computed at query time.
 *
 * `path` is normalized POSIX with `/` separators. The first segment is
 * either "Company" (for company-root folders) or a department slug.
 */
export const memoryFolders = pgTable(
  "memory_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    path: text("path").notNull(),
    displayName: text("display_name").notNull(),
    icon: text("icon"),
    sortOrder: integer("sort_order").notNull().default(0),
    seedKey: text("seed_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("memory_folders_company_idx").on(table.companyId),
    deptPathIdx: index("memory_folders_dept_path_idx").on(
      table.companyId,
      table.departmentId,
      table.path,
    ),
    uniquePathPerCompany: uniqueIndex("memory_folders_unique_path_per_company").on(
      table.companyId,
      table.path,
    ),
  }),
);
```

- [ ] **Step 2: Export from the schema index**

Open `packages/db/src/schema/index.ts`. Right after the `memoryAssets` export from Task 2, add:

```typescript
export { memoryFolders } from "./memory_folders.js";
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @armyofagents/db typecheck`
Expected: `0 errors`

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/memory_folders.ts packages/db/src/schema/index.ts
git commit -m "feat(memory): add memory_folders schema for tree structure"
```

---

## Task 4: Generate Drizzle migration

**Files:**
- Create: `packages/db/src/migrations/00XX_*.sql` (drizzle-kit generates the name)
- Modify: `packages/db/src/migrations/meta/_journal.json` (auto)
- Create: `packages/db/src/migrations/meta/00XX_snapshot.json` (auto)

- [ ] **Step 1: Run drizzle generate**

Run: `pnpm --filter @armyofagents/db generate`
Expected: a new file under `packages/db/src/migrations/00XX_*.sql` containing:
- `ALTER TABLE memory_items ADD COLUMN folder_path text NOT NULL DEFAULT '';`
- `ALTER TABLE memory_items ADD COLUMN last_accessed_by_user_id uuid;`
- `ALTER TABLE memory_items ADD COLUMN founder_pinned_to_top boolean NOT NULL DEFAULT false;`
- `CREATE TABLE memory_assets (...);`
- `CREATE TABLE memory_folders (...);`
- The new indexes from all three schemas.

- [ ] **Step 2: Read the generated SQL and verify**

Run: `ls packages/db/src/migrations/ | grep -v meta | tail -3`

Open the newest `.sql` file and verify it contains all the column additions, both new tables, and all new indexes. If anything is missing, the schema files have a typo — fix it and re-run generate.

- [ ] **Step 3: Verify the migration is idempotent-friendly**

The drizzle-generated SQL won't be idempotent by default (no `IF NOT EXISTS`). For safety in shared dev environments, edit the generated file to add `IF NOT EXISTS` to the `CREATE TABLE` and `CREATE INDEX` statements. The `ALTER TABLE ADD COLUMN` statements are fine as-is.

Example of what to change:
```sql
-- Before
CREATE TABLE "memory_assets" (...);
-- After
CREATE TABLE IF NOT EXISTS "memory_assets" (...);
```

Apply the same edit to all `CREATE TABLE` and `CREATE INDEX` statements added by this migration.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/migrations/
git commit -m "feat(db): generate migration for memory_assets, memory_folders, memory_items columns"
```

---

## Task 5: Add LIVE_EVENT_TYPES for memory.* events

**Files:**
- Modify: `packages/shared/src/constants.ts:234`

- [ ] **Step 1: Add new event type literals**

Open `packages/shared/src/constants.ts`. The `LIVE_EVENT_TYPES` array starts at line 211. Before the closing `] as const;` (line 234), add:

```typescript
  // Phase 6: Memory page real-time updates
  "memory.item.created",
  "memory.item.updated",
  "memory.item.moved",
  "memory.item.deleted",
  "memory.asset.created",
  "memory.asset.updated",
  "memory.asset.deleted",
  "memory.folder.created",
  "memory.folder.updated",
  "memory.folder.deleted",
  "memory.import.progress",
```

- [ ] **Step 2: Run shared typecheck**

Run: `pnpm --filter @armyofagents/shared typecheck`
Expected: `0 errors`

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(memory): add 11 memory.* LIVE_EVENT_TYPES for tree real-time updates"
```

---

## Task 6: Add types and validators in shared package

**Files:**
- Create: `packages/shared/src/types/memory-asset.ts`
- Create: `packages/shared/src/types/memory-folder.ts`
- Create: `packages/shared/src/validators/memory-asset.ts`
- Create: `packages/shared/src/validators/memory-folder.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/validators/__tests__/memory-folder.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { memoryFolderCreateSchema, normalizeMemoryFolderPath } from "../memory-folder.js";

describe("memoryFolderCreateSchema", () => {
  it("accepts a valid folder", () => {
    const result = memoryFolderCreateSchema.safeParse({
      departmentId: "00000000-0000-0000-0000-000000000001",
      path: "Engineering/Decisions",
      displayName: "Decisions",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty path", () => {
    const result = memoryFolderCreateSchema.safeParse({
      departmentId: null,
      path: "",
      displayName: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects paths starting with /", () => {
    const result = memoryFolderCreateSchema.safeParse({
      departmentId: null,
      path: "/Engineering/Decisions",
      displayName: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects paths with empty segments", () => {
    const result = memoryFolderCreateSchema.safeParse({
      departmentId: null,
      path: "Engineering//Decisions",
      displayName: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    const result = memoryFolderCreateSchema.safeParse({
      departmentId: null,
      path: "Engineering/../Marketing",
      displayName: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("normalizeMemoryFolderPath", () => {
  it("trims whitespace and collapses slashes", () => {
    expect(normalizeMemoryFolderPath("  Engineering / Decisions  ")).toBe("Engineering/Decisions");
  });

  it("strips trailing slashes", () => {
    expect(normalizeMemoryFolderPath("Engineering/Decisions/")).toBe("Engineering/Decisions");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/shared test memory-folder`
Expected: FAIL with "Cannot find module '../memory-folder.js'"

- [ ] **Step 3: Implement validator + types**

Create `packages/shared/src/validators/memory-folder.ts`:

```typescript
import { z } from "zod";

const FOLDER_SEGMENT_RE = /^[a-zA-Z0-9 _-][a-zA-Z0-9 _.-]*$/;
const MAX_PATH_LENGTH = 512;
const MAX_SEGMENTS = 8;

export function normalizeMemoryFolderPath(raw: string): string {
  return raw
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");
}

const memoryFolderPathSchema = z
  .string()
  .min(1, "path cannot be empty")
  .max(MAX_PATH_LENGTH)
  .refine((p) => !p.startsWith("/"), { message: "path cannot start with /" })
  .refine((p) => !p.includes("//"), { message: "path cannot contain empty segments" })
  .refine(
    (p) => p.split("/").every((s) => s !== "." && s !== ".."),
    { message: "path cannot contain . or .. segments" },
  )
  .refine(
    (p) => p.split("/").every((s) => FOLDER_SEGMENT_RE.test(s)),
    { message: "path segments must be alphanumeric with spaces, underscores, dashes, dots" },
  )
  .refine(
    (p) => p.split("/").length <= MAX_SEGMENTS,
    { message: `path cannot exceed ${MAX_SEGMENTS} segments` },
  );

export const memoryFolderCreateSchema = z.object({
  departmentId: z.string().uuid().nullable(),
  path: memoryFolderPathSchema,
  displayName: z.string().min(1).max(120),
  icon: z.string().max(8).nullable().optional(),
});

export const memoryFolderUpdateSchema = z.object({
  path: memoryFolderPathSchema.optional(),
  displayName: z.string().min(1).max(120).optional(),
  icon: z.string().max(8).nullable().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});
```

Create `packages/shared/src/types/memory-folder.ts`:

```typescript
export interface MemoryFolderRecord {
  id: string;
  companyId: string;
  departmentId: string | null;
  path: string;
  displayName: string;
  icon: string | null;
  sortOrder: number;
  seedKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryFolderCreateInput {
  departmentId: string | null;
  path: string;
  displayName: string;
  icon?: string | null;
}

export interface MemoryFolderUpdateInput {
  path?: string;
  displayName?: string;
  icon?: string | null;
  sortOrder?: number;
}
```

Create `packages/shared/src/types/memory-asset.ts`:

```typescript
export interface MemoryAssetRecord {
  id: string;
  companyId: string;
  departmentId: string | null;
  folderPath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageKey: string;
  importJobId: string | null;
  extractedItemCount: number;
  metadata: Record<string, unknown> | null;
  uploadedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryAssetCreateInput {
  departmentId: string | null;
  folderPath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageKey: string;
  importJobId?: string | null;
  metadata?: Record<string, unknown> | null;
  uploadedByUserId?: string | null;
}

export interface MemoryAssetUpdateInput {
  fileName?: string;
  folderPath?: string;
  metadata?: Record<string, unknown> | null;
}
```

Create `packages/shared/src/validators/memory-asset.ts`:

```typescript
import { z } from "zod";
import { normalizeMemoryFolderPath } from "./memory-folder.js";

export const memoryAssetUpdateSchema = z.object({
  fileName: z.string().min(1).max(255).optional(),
  folderPath: z.string().max(512).optional().transform((v) => v === undefined ? undefined : normalizeMemoryFolderPath(v)),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export const memoryAssetMoveSchema = z.object({
  folderPath: z.string().max(512).transform(normalizeMemoryFolderPath),
});
```

- [ ] **Step 4: Re-export from index**

Open `packages/shared/src/index.ts`. Add to the exports (location: alongside other type/validator re-exports):

```typescript
export type {
  MemoryAssetRecord,
  MemoryAssetCreateInput,
  MemoryAssetUpdateInput,
} from "./types/memory-asset.js";
export type {
  MemoryFolderRecord,
  MemoryFolderCreateInput,
  MemoryFolderUpdateInput,
} from "./types/memory-folder.js";
export {
  memoryFolderCreateSchema,
  memoryFolderUpdateSchema,
  normalizeMemoryFolderPath,
} from "./validators/memory-folder.js";
export {
  memoryAssetUpdateSchema,
  memoryAssetMoveSchema,
} from "./validators/memory-asset.js";
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @armyofagents/shared test memory-folder`
Expected: PASS — all 7 cases.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src
git commit -m "feat(memory): add MemoryAsset + MemoryFolder types and validators"
```

---

## Task 7: Create memory-folder-seeds service

**Files:**
- Create: `server/src/services/memory-folder-seeds.ts`
- Create: `server/src/__tests__/memory-folder-seeds.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-folder-seeds.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  getSeedFoldersForFunctionType,
  COMPANY_SEED_FOLDERS,
} from "../services/memory-folder-seeds.js";

describe("memory-folder-seeds", () => {
  it("returns engineering seed folders for software_development", () => {
    const seeds = getSeedFoldersForFunctionType("software_development");
    expect(seeds.map((s) => s.displayName)).toEqual([
      "Decisions",
      "Playbooks",
      "References",
      "Architecture",
      "Files",
    ]);
  });

  it("returns marketing seed folders", () => {
    const seeds = getSeedFoldersForFunctionType("marketing");
    expect(seeds.map((s) => s.displayName)).toEqual([
      "Decisions",
      "Brand",
      "Campaigns",
      "References",
      "Files",
    ]);
  });

  it("returns support seed folders", () => {
    const seeds = getSeedFoldersForFunctionType("customer_support");
    expect(seeds.map((s) => s.displayName)).toEqual([
      "Playbooks",
      "Macros",
      "References",
      "Files",
    ]);
  });

  it("returns generic seed folders for unknown function type", () => {
    const seeds = getSeedFoldersForFunctionType("totally_unknown");
    expect(seeds.map((s) => s.displayName)).toEqual([
      "Decisions",
      "Policies",
      "References",
      "Files",
    ]);
  });

  it("returns generic seed folders when functionType is null", () => {
    const seeds = getSeedFoldersForFunctionType(null);
    expect(seeds.map((s) => s.displayName)).toEqual([
      "Decisions",
      "Policies",
      "References",
      "Files",
    ]);
  });

  it("each seed has a stable seedKey for collision-safe creation", () => {
    const seeds = getSeedFoldersForFunctionType("software_development");
    expect(seeds.find((s) => s.displayName === "Decisions")?.seedKey).toBe(
      "software_development.decisions",
    );
  });

  it("COMPANY_SEED_FOLDERS exposes the company-root folder", () => {
    expect(COMPANY_SEED_FOLDERS).toEqual([
      { path: "Company", displayName: "Company", seedKey: "company.root", icon: "🏛️" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test memory-folder-seeds`
Expected: FAIL with "Cannot find module '../services/memory-folder-seeds.js'"

- [ ] **Step 3: Implement the seeds service**

Create `server/src/services/memory-folder-seeds.ts`:

```typescript
/**
 * Phase 6: maps a department's functionType to a default set of folders that
 * get seeded into memory_folders on creation. This is a static lookup — no DB
 * access — so it can be used both in the service layer and (eventually) in
 * the UI for empty-state previews.
 *
 * Virtual folders (Pending Review, Active Goals, Pinned, Working) are NOT in
 * this list — they're computed at query time, not stored.
 */

export interface FolderSeed {
  path: string;          // path segment relative to dept root (e.g. "Decisions")
  displayName: string;
  seedKey: string;       // stable identifier for idempotent creation
  icon?: string;
}

const ENGINEERING_SEEDS: FolderSeed[] = [
  { path: "Decisions",    displayName: "Decisions",    seedKey: "software_development.decisions" },
  { path: "Playbooks",    displayName: "Playbooks",    seedKey: "software_development.playbooks" },
  { path: "References",   displayName: "References",   seedKey: "software_development.references" },
  { path: "Architecture", displayName: "Architecture", seedKey: "software_development.architecture" },
  { path: "Files",        displayName: "Files",        seedKey: "software_development.files", icon: "📁" },
];

const MARKETING_SEEDS: FolderSeed[] = [
  { path: "Decisions",  displayName: "Decisions",  seedKey: "marketing.decisions" },
  { path: "Brand",      displayName: "Brand",      seedKey: "marketing.brand" },
  { path: "Campaigns",  displayName: "Campaigns",  seedKey: "marketing.campaigns" },
  { path: "References", displayName: "References", seedKey: "marketing.references" },
  { path: "Files",      displayName: "Files",      seedKey: "marketing.files", icon: "📁" },
];

const SUPPORT_SEEDS: FolderSeed[] = [
  { path: "Playbooks",  displayName: "Playbooks",  seedKey: "customer_support.playbooks" },
  { path: "Macros",     displayName: "Macros",     seedKey: "customer_support.macros" },
  { path: "References", displayName: "References", seedKey: "customer_support.references" },
  { path: "Files",      displayName: "Files",      seedKey: "customer_support.files", icon: "📁" },
];

const GENERIC_SEEDS: FolderSeed[] = [
  { path: "Decisions",  displayName: "Decisions",  seedKey: "generic.decisions" },
  { path: "Policies",   displayName: "Policies",   seedKey: "generic.policies" },
  { path: "References", displayName: "References", seedKey: "generic.references" },
  { path: "Files",      displayName: "Files",      seedKey: "generic.files", icon: "📁" },
];

const SEEDS_BY_FUNCTION_TYPE: Record<string, FolderSeed[]> = {
  software_development: ENGINEERING_SEEDS,
  marketing: MARKETING_SEEDS,
  customer_support: SUPPORT_SEEDS,
};

export function getSeedFoldersForFunctionType(
  functionType: string | null | undefined,
): FolderSeed[] {
  if (!functionType) return GENERIC_SEEDS;
  return SEEDS_BY_FUNCTION_TYPE[functionType] ?? GENERIC_SEEDS;
}

export const COMPANY_SEED_FOLDERS: FolderSeed[] = [
  { path: "Company", displayName: "Company", seedKey: "company.root", icon: "🏛️" },
];
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server test memory-folder-seeds`
Expected: PASS — all 7 cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/memory-folder-seeds.ts server/src/__tests__/memory-folder-seeds.test.ts
git commit -m "feat(memory): add seed-folder map keyed by department functionType"
```

---

## Task 8: Create memory-folders service

**Files:**
- Create: `server/src/services/memory-folders.ts`
- Create: `server/src/__tests__/memory-folders-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-folders-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @armyofagents/db with proxy-based table stubs (matches AoA convention).
vi.mock("@armyofagents/db", () => ({
  memoryFolders: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
}));

import { memoryFoldersService } from "../services/memory-folders.js";

function createMockDb() {
  const folders: Array<Record<string, unknown>> = [];
  return {
    folders,
    select: () => ({
      from: () => ({
        where: async () => folders,
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          const created = { ...row, id: `mock-${folders.length}`, createdAt: new Date(), updatedAt: new Date() };
          folders.push(created);
          return [created];
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (folders.length === 0) return [];
            folders[0] = { ...folders[0], ...patch };
            return [folders[0]];
          },
        }),
      }),
    }),
    delete: () => ({
      where: async () => {
        folders.splice(0);
      },
    }),
  };
}

describe("memoryFoldersService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a folder with companyId and normalized path", async () => {
    const db = createMockDb();
    const svc = memoryFoldersService(db as never);
    const created = await svc.create({
      companyId: "co-1",
      departmentId: "dept-1",
      path: "  Engineering/Decisions  ",
      displayName: "Decisions",
    });
    expect(created.path).toBe("Engineering/Decisions");
    expect(created.companyId).toBe("co-1");
  });

  it("lists folders scoped to companyId", async () => {
    const db = createMockDb();
    db.folders.push({ id: "f-1", companyId: "co-1", path: "Engineering/Decisions" });
    const svc = memoryFoldersService(db as never);
    const list = await svc.list({ companyId: "co-1" });
    expect(list).toHaveLength(1);
  });

  it("update normalizes path", async () => {
    const db = createMockDb();
    db.folders.push({ id: "f-1", companyId: "co-1", path: "Engineering" });
    const svc = memoryFoldersService(db as never);
    const updated = await svc.update("f-1", "co-1", { path: "  Engineering/Subfolder  " });
    expect(updated?.path).toBe("Engineering/Subfolder");
  });

  it("seedForDepartment inserts one row per FolderSeed scoped to dept", async () => {
    const db = createMockDb();
    const svc = memoryFoldersService(db as never);
    await svc.seedForDepartment({
      companyId: "co-1",
      departmentId: "dept-1",
      departmentSlug: "engineering",
      functionType: "software_development",
    });
    expect(db.folders).toHaveLength(5);
    expect(db.folders[0].path).toBe("engineering/Decisions");
    expect(db.folders[0].seedKey).toBe("software_development.decisions");
  });

  it("seedForDepartment is idempotent — second call inserts nothing", async () => {
    const db = createMockDb();
    const svc = memoryFoldersService(db as never);
    await svc.seedForDepartment({
      companyId: "co-1",
      departmentId: "dept-1",
      departmentSlug: "engineering",
      functionType: "software_development",
    });
    const before = db.folders.length;
    await svc.seedForDepartment({
      companyId: "co-1",
      departmentId: "dept-1",
      departmentSlug: "engineering",
      functionType: "software_development",
    });
    expect(db.folders.length).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test memory-folders-service`
Expected: FAIL with "Cannot find module '../services/memory-folders.js'"

- [ ] **Step 3: Implement the service**

Create `server/src/services/memory-folders.ts`:

```typescript
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryFolders } from "@armyofagents/db";
import { normalizeMemoryFolderPath } from "@armyofagents/shared";
import { getSeedFoldersForFunctionType } from "./memory-folder-seeds.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "memory-folders" });

interface CreateInput {
  companyId: string;
  departmentId: string | null;
  path: string;
  displayName: string;
  icon?: string | null;
  seedKey?: string | null;
  sortOrder?: number;
}

interface UpdateInput {
  path?: string;
  displayName?: string;
  icon?: string | null;
  sortOrder?: number;
}

interface ListInput {
  companyId: string;
  departmentId?: string | null;
}

interface SeedInput {
  companyId: string;
  departmentId: string;
  departmentSlug: string;
  functionType: string | null;
}

export function memoryFoldersService(db: Db) {
  return {
    list: async ({ companyId, departmentId }: ListInput) => {
      const conditions = [eq(memoryFolders.companyId, companyId)];
      if (departmentId === null) {
        conditions.push(isNull(memoryFolders.departmentId));
      } else if (departmentId !== undefined) {
        conditions.push(eq(memoryFolders.departmentId, departmentId));
      }
      return db.select().from(memoryFolders).where(and(...conditions));
    },

    create: async (input: CreateInput) => {
      const path = normalizeMemoryFolderPath(input.path);
      const [row] = await db
        .insert(memoryFolders)
        .values({
          companyId: input.companyId,
          departmentId: input.departmentId,
          path,
          displayName: input.displayName,
          icon: input.icon ?? null,
          seedKey: input.seedKey ?? null,
          sortOrder: input.sortOrder ?? 0,
        })
        .returning();
      return row;
    },

    update: async (id: string, companyId: string, patch: UpdateInput) => {
      const next: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.path !== undefined) next.path = normalizeMemoryFolderPath(patch.path);
      if (patch.displayName !== undefined) next.displayName = patch.displayName;
      if (patch.icon !== undefined) next.icon = patch.icon;
      if (patch.sortOrder !== undefined) next.sortOrder = patch.sortOrder;
      const [row] = await db
        .update(memoryFolders)
        .set(next)
        .where(and(eq(memoryFolders.id, id), eq(memoryFolders.companyId, companyId)))
        .returning();
      return row ?? null;
    },

    remove: async (id: string, companyId: string): Promise<void> => {
      await db
        .delete(memoryFolders)
        .where(and(eq(memoryFolders.id, id), eq(memoryFolders.companyId, companyId)));
    },

    seedForDepartment: async (input: SeedInput) => {
      const seeds = getSeedFoldersForFunctionType(input.functionType);
      // Idempotent: skip seeds that already exist (matched by seedKey + dept).
      const existing = await db
        .select()
        .from(memoryFolders)
        .where(
          and(
            eq(memoryFolders.companyId, input.companyId),
            eq(memoryFolders.departmentId, input.departmentId),
          ),
        );
      const existingKeys = new Set(
        existing.map((row: { seedKey: string | null }) => row.seedKey).filter(Boolean),
      );
      const toCreate = seeds.filter((s) => !existingKeys.has(s.seedKey));
      if (toCreate.length === 0) return [];
      const created = [];
      for (const seed of toCreate) {
        const [row] = await db
          .insert(memoryFolders)
          .values({
            companyId: input.companyId,
            departmentId: input.departmentId,
            path: `${input.departmentSlug}/${seed.path}`,
            displayName: seed.displayName,
            icon: seed.icon ?? null,
            seedKey: seed.seedKey,
            sortOrder: 0,
          })
          .returning();
        created.push(row);
      }
      log.info({ companyId: input.companyId, departmentId: input.departmentId, count: created.length }, "seeded folders");
      return created;
    },
  };
}

export type MemoryFoldersService = ReturnType<typeof memoryFoldersService>;
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server test memory-folders-service`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/memory-folders.ts server/src/__tests__/memory-folders-service.test.ts
git commit -m "feat(memory): add memory-folders service with CRUD + seed-for-department"
```

---

## Task 9: Create memory-assets service

**Files:**
- Create: `server/src/services/memory-assets.ts`
- Create: `server/src/__tests__/memory-assets-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-assets-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  memoryAssets: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
}));

import { memoryAssetsService } from "../services/memory-assets.js";

function createMockDb() {
  const assets: Array<Record<string, unknown>> = [];
  return {
    assets,
    select: () => ({
      from: () => ({
        where: async () => assets,
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          const created = { ...row, id: `asset-${assets.length}`, createdAt: new Date(), updatedAt: new Date() };
          assets.push(created);
          return [created];
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (assets.length === 0) return [];
            assets[0] = { ...assets[0], ...patch };
            return [assets[0]];
          },
        }),
      }),
    }),
    delete: () => ({ where: async () => { assets.splice(0); } }),
  };
}

describe("memoryAssetsService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an asset row scoped by companyId", async () => {
    const db = createMockDb();
    const svc = memoryAssetsService(db as never);
    const created = await svc.create({
      companyId: "co-1",
      departmentId: "dept-1",
      folderPath: "Engineering/Files",
      fileName: "rfc-9421.pdf",
      mimeType: "application/pdf",
      fileSize: 1024,
      storageKey: "co-1/file-imports/abc-rfc-9421.pdf",
    });
    expect(created.companyId).toBe("co-1");
    expect(created.fileName).toBe("rfc-9421.pdf");
    expect(created.extractedItemCount).toBe(0);
  });

  it("lists assets filtered by folderPath", async () => {
    const db = createMockDb();
    db.assets.push({ id: "a-1", companyId: "co-1", folderPath: "Engineering/Files" });
    db.assets.push({ id: "a-2", companyId: "co-1", folderPath: "Marketing/Files" });
    const svc = memoryAssetsService(db as never);
    const all = await svc.list({ companyId: "co-1" });
    expect(all).toHaveLength(2);
  });

  it("update can rename and move", async () => {
    const db = createMockDb();
    db.assets.push({ id: "a-1", companyId: "co-1", fileName: "old.pdf", folderPath: "X" });
    const svc = memoryAssetsService(db as never);
    const updated = await svc.update("a-1", "co-1", {
      fileName: "new.pdf",
      folderPath: " Y / Z ",
    });
    expect(updated?.fileName).toBe("new.pdf");
    expect(updated?.folderPath).toBe("Y/Z");
  });

  it("incrementExtractedCount increases counter atomically", async () => {
    const db = createMockDb();
    db.assets.push({ id: "a-1", companyId: "co-1", extractedItemCount: 5 });
    const svc = memoryAssetsService(db as never);
    await svc.incrementExtractedCount("a-1", "co-1", 3);
    expect(db.assets[0].extractedItemCount).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test memory-assets-service`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the service**

Create `server/src/services/memory-assets.ts`:

```typescript
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryAssets } from "@armyofagents/db";
import { normalizeMemoryFolderPath } from "@armyofagents/shared";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "memory-assets" });

interface CreateInput {
  companyId: string;
  departmentId: string | null;
  folderPath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageKey: string;
  importJobId?: string | null;
  metadata?: Record<string, unknown> | null;
  uploadedByUserId?: string | null;
}

interface UpdateInput {
  fileName?: string;
  folderPath?: string;
  metadata?: Record<string, unknown> | null;
}

interface ListInput {
  companyId: string;
  departmentId?: string | null;
  folderPath?: string;
  mimeType?: string;
}

export function memoryAssetsService(db: Db) {
  return {
    list: async ({ companyId, departmentId, folderPath, mimeType }: ListInput) => {
      const conditions = [eq(memoryAssets.companyId, companyId)];
      if (departmentId !== undefined && departmentId !== null) {
        conditions.push(eq(memoryAssets.departmentId, departmentId));
      }
      if (folderPath !== undefined) {
        conditions.push(eq(memoryAssets.folderPath, normalizeMemoryFolderPath(folderPath)));
      }
      if (mimeType !== undefined) {
        conditions.push(eq(memoryAssets.mimeType, mimeType));
      }
      return db.select().from(memoryAssets).where(and(...conditions));
    },

    get: async (id: string, companyId: string) => {
      const rows = await db
        .select()
        .from(memoryAssets)
        .where(and(eq(memoryAssets.id, id), eq(memoryAssets.companyId, companyId)));
      return rows[0] ?? null;
    },

    create: async (input: CreateInput) => {
      const [row] = await db
        .insert(memoryAssets)
        .values({
          companyId: input.companyId,
          departmentId: input.departmentId,
          folderPath: normalizeMemoryFolderPath(input.folderPath),
          fileName: input.fileName,
          mimeType: input.mimeType,
          fileSize: input.fileSize,
          storageKey: input.storageKey,
          importJobId: input.importJobId ?? null,
          metadata: input.metadata ?? null,
          uploadedByUserId: input.uploadedByUserId ?? null,
          extractedItemCount: 0,
        })
        .returning();
      return row;
    },

    update: async (id: string, companyId: string, patch: UpdateInput) => {
      const next: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.fileName !== undefined) next.fileName = patch.fileName;
      if (patch.folderPath !== undefined) next.folderPath = normalizeMemoryFolderPath(patch.folderPath);
      if (patch.metadata !== undefined) next.metadata = patch.metadata;
      const [row] = await db
        .update(memoryAssets)
        .set(next)
        .where(and(eq(memoryAssets.id, id), eq(memoryAssets.companyId, companyId)))
        .returning();
      return row ?? null;
    },

    remove: async (id: string, companyId: string): Promise<void> => {
      await db
        .delete(memoryAssets)
        .where(and(eq(memoryAssets.id, id), eq(memoryAssets.companyId, companyId)));
    },

    incrementExtractedCount: async (id: string, companyId: string, delta: number): Promise<void> => {
      await db
        .update(memoryAssets)
        .set({
          extractedItemCount: sql`${memoryAssets.extractedItemCount} + ${delta}`,
          updatedAt: new Date(),
        })
        .where(and(eq(memoryAssets.id, id), eq(memoryAssets.companyId, companyId)));
    },
  };
}

export type MemoryAssetsService = ReturnType<typeof memoryAssetsService>;
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server test memory-assets-service`
Expected: PASS — all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/memory-assets.ts server/src/__tests__/memory-assets-service.test.ts
git commit -m "feat(memory): add memory-assets service with CRUD + extracted-count increment"
```

---

## Task 10: Add `moveItem` and `setPinnedToTop` methods to memory.ts service

**Files:**
- Modify: `server/src/services/memory.ts`
- Create: `server/src/__tests__/memory-move-pin.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-move-pin.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  memoryItems: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
}));

import { memoryService } from "../services/memory.js";

function createMockDb() {
  const items: Array<Record<string, unknown>> = [];
  return {
    items,
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (items.length === 0) return [];
            items[0] = { ...items[0], ...patch };
            return [items[0]];
          },
        }),
      }),
    }),
  };
}

describe("memoryService.moveItem / setPinnedToTop", () => {
  beforeEach(() => vi.clearAllMocks());

  it("moveItem updates folderPath with normalization", async () => {
    const db = createMockDb();
    db.items.push({ id: "i-1", companyId: "co-1", folderPath: "" });
    const svc = memoryService(db as never);
    const updated = await svc.moveItem("i-1", "co-1", " Engineering / Decisions ");
    expect(updated?.folderPath).toBe("Engineering/Decisions");
  });

  it("setPinnedToTop toggles founderPinnedToTop", async () => {
    const db = createMockDb();
    db.items.push({ id: "i-1", companyId: "co-1", founderPinnedToTop: false });
    const svc = memoryService(db as never);
    const updated = await svc.setPinnedToTop("i-1", "co-1", true);
    expect(updated?.founderPinnedToTop).toBe(true);
  });

  it("setPinnedToTop returns null if item not found in this company", async () => {
    const db = createMockDb();
    const svc = memoryService(db as never);
    const updated = await svc.setPinnedToTop("missing", "co-1", true);
    expect(updated).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test memory-move-pin`
Expected: FAIL — `moveItem` is not a function on the returned service object.

- [ ] **Step 3: Add the methods**

Open `server/src/services/memory.ts`. Find the `memoryService(db: Db)` factory function (around line 235 based on conventions; use grep `grep -n "export function memoryService" server/src/services/memory.ts` if needed).

Inside the returned object, after the existing methods, add:

```typescript
    moveItem: async (id: string, companyId: string, folderPath: string) => {
      const path = normalizeMemoryFolderPath(folderPath);
      const [row] = await db
        .update(memoryItems)
        .set({ folderPath: path, updatedAt: new Date() })
        .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)))
        .returning();
      return row ?? null;
    },

    setPinnedToTop: async (id: string, companyId: string, pinned: boolean) => {
      const [row] = await db
        .update(memoryItems)
        .set({ founderPinnedToTop: pinned, updatedAt: new Date() })
        .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)))
        .returning();
      return row ?? null;
    },
```

At the top of the file, ensure the import for `normalizeMemoryFolderPath` exists. If not, add it:

```typescript
import { normalizeMemoryFolderPath } from "@armyofagents/shared";
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server test memory-move-pin`
Expected: PASS — all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/memory.ts server/src/__tests__/memory-move-pin.test.ts
git commit -m "feat(memory): add moveItem + setPinnedToTop to memoryService"
```

---

## Task 11: Create memory-folders routes

**Files:**
- Create: `server/src/routes/memory-folders.ts`
- Create: `server/src/__tests__/memory-folders-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-folders-routes.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { memoryFoldersRoutes } from "../routes/memory-folders.js";

// authz + rbac mocks (matches AoA test convention)
vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: () => undefined,
  getActorInfo: () => ({ userId: "u-1", actorType: "user" }),
}));
vi.mock("../middleware/rbac.js", () => ({
  assertRole: async () => undefined,
}));

function buildApp(mockSvc: unknown) {
  const app = express();
  app.use(express.json());
  // The route module accepts a service factory for test seam.
  app.use(memoryFoldersRoutes({ svc: mockSvc as never }));
  return app;
}

describe("memory-folders routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /companies/:cid/memory/folders returns the list", async () => {
    const svc = {
      list: vi.fn(async () => [{ id: "f-1", path: "Engineering/Decisions" }]),
    };
    const app = buildApp(svc);
    const res = await request(app).get("/companies/co-1/memory/folders");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "f-1", path: "Engineering/Decisions" }]);
    expect(svc.list).toHaveBeenCalledWith({ companyId: "co-1", departmentId: undefined });
  });

  it("POST /companies/:cid/memory/folders creates a folder", async () => {
    const svc = {
      create: vi.fn(async (input: unknown) => ({ id: "f-new", ...(input as object) })),
    };
    const app = buildApp(svc);
    const res = await request(app)
      .post("/companies/co-1/memory/folders")
      .send({
        departmentId: "00000000-0000-0000-0000-000000000001",
        path: "Engineering/Decisions",
        displayName: "Decisions",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("f-new");
    expect(svc.create).toHaveBeenCalled();
  });

  it("POST rejects invalid path with 400", async () => {
    const svc = { create: vi.fn() };
    const app = buildApp(svc);
    const res = await request(app)
      .post("/companies/co-1/memory/folders")
      .send({
        departmentId: null,
        path: "/Engineering",
        displayName: "Decisions",
      });
    expect(res.status).toBe(400);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("PATCH /companies/:cid/memory/folders/:id updates", async () => {
    const svc = {
      update: vi.fn(async () => ({ id: "f-1", path: "Engineering/Renamed" })),
    };
    const app = buildApp(svc);
    const res = await request(app)
      .patch("/companies/co-1/memory/folders/f-1")
      .send({ path: "Engineering/Renamed" });
    expect(res.status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith("f-1", "co-1", { path: "Engineering/Renamed" });
  });

  it("PATCH returns 404 if service returns null", async () => {
    const svc = { update: vi.fn(async () => null) };
    const app = buildApp(svc);
    const res = await request(app)
      .patch("/companies/co-1/memory/folders/missing")
      .send({ displayName: "x" });
    expect(res.status).toBe(404);
  });

  it("DELETE /companies/:cid/memory/folders/:id removes", async () => {
    const svc = { remove: vi.fn(async () => undefined) };
    const app = buildApp(svc);
    const res = await request(app).delete("/companies/co-1/memory/folders/f-1");
    expect(res.status).toBe(204);
    expect(svc.remove).toHaveBeenCalledWith("f-1", "co-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test memory-folders-routes`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the routes**

Create `server/src/routes/memory-folders.ts`:

```typescript
import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import {
  memoryFolderCreateSchema,
  memoryFolderUpdateSchema,
} from "@armyofagents/shared";
import { memoryFoldersService, type MemoryFoldersService } from "../services/memory-folders.js";
import { assertCompanyAccess } from "./authz.js";
import { assertRole } from "../middleware/rbac.js";

interface RoutesOptions {
  // Test seam: callers can inject a pre-built service. Production uses `db`.
  db?: Db;
  svc?: MemoryFoldersService;
}

export function memoryFoldersRoutes(opts: RoutesOptions) {
  const router = Router();
  const svc = opts.svc ?? memoryFoldersService(opts.db!);

  // GET list
  router.get(
    "/companies/:companyId/memory/folders",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        const departmentId =
          typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;
        const list = await svc.list({ companyId, departmentId });
        res.json(list);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST create
  router.post(
    "/companies/:companyId/memory/folders",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        if (opts.db) await assertRole(opts.db, req, companyId, "team_lead");
        const parsed = memoryFolderCreateSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        const created = await svc.create({ companyId, ...parsed.data });
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH update
  router.patch(
    "/companies/:companyId/memory/folders/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertCompanyAccess(req, companyId);
        if (opts.db) await assertRole(opts.db, req, companyId, "team_lead");
        const parsed = memoryFolderUpdateSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        const updated = await svc.update(id, companyId, parsed.data);
        if (!updated) {
          res.status(404).json({ error: "Folder not found" });
          return;
        }
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE
  router.delete(
    "/companies/:companyId/memory/folders/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertCompanyAccess(req, companyId);
        if (opts.db) await assertRole(opts.db, req, companyId, "team_lead");
        await svc.remove(id, companyId);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server test memory-folders-routes`
Expected: PASS — all 6 cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/memory-folders.ts server/src/__tests__/memory-folders-routes.test.ts
git commit -m "feat(memory): add memory-folders routes with Zod validation + RBAC"
```

---

## Task 12: Create memory-assets routes

**Files:**
- Create: `server/src/routes/memory-assets.ts`
- Create: `server/src/__tests__/memory-assets-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-assets-routes.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { Readable } from "node:stream";
import { memoryAssetsRoutes } from "../routes/memory-assets.js";

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: () => undefined,
  getActorInfo: () => ({ userId: "u-1", actorType: "user" }),
}));
vi.mock("../middleware/rbac.js", () => ({
  assertRole: async () => undefined,
}));

function buildApp(svc: unknown, storage: unknown) {
  const app = express();
  app.use(express.json());
  app.use(memoryAssetsRoutes({ svc: svc as never, storage: storage as never }));
  return app;
}

describe("memory-assets routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /companies/:cid/memory/assets returns the list", async () => {
    const svc = {
      list: vi.fn(async () => [{ id: "a-1", fileName: "rfc.pdf" }]),
    };
    const app = buildApp(svc, {});
    const res = await request(app).get("/companies/co-1/memory/assets");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "a-1", fileName: "rfc.pdf" }]);
  });

  it("GET /assets supports folderPath filter", async () => {
    const svc = { list: vi.fn(async () => []) };
    const app = buildApp(svc, {});
    await request(app).get(
      "/companies/co-1/memory/assets?folderPath=Engineering/Files&mimeType=application/pdf",
    );
    expect(svc.list).toHaveBeenCalledWith({
      companyId: "co-1",
      departmentId: undefined,
      folderPath: "Engineering/Files",
      mimeType: "application/pdf",
    });
  });

  it("GET /assets/:id returns a single asset", async () => {
    const svc = {
      get: vi.fn(async () => ({ id: "a-1", fileName: "rfc.pdf" })),
    };
    const app = buildApp(svc, {});
    const res = await request(app).get("/companies/co-1/memory/assets/a-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("a-1");
  });

  it("GET /assets/:id returns 404 when missing", async () => {
    const svc = { get: vi.fn(async () => null) };
    const app = buildApp(svc, {});
    const res = await request(app).get("/companies/co-1/memory/assets/missing");
    expect(res.status).toBe(404);
  });

  it("GET /assets/:id/content streams from StorageService", async () => {
    const svc = {
      get: vi.fn(async () => ({
        id: "a-1",
        fileName: "rfc.pdf",
        mimeType: "application/pdf",
        storageKey: "co-1/file-imports/abc-rfc.pdf",
      })),
    };
    const storage = {
      getObject: vi.fn(async () => ({
        stream: Readable.from(["chunk1", "chunk2"]),
        contentLength: 12,
        lastModified: new Date(),
      })),
    };
    const app = buildApp(svc, storage);
    const res = await request(app).get("/companies/co-1/memory/assets/a-1/content");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(storage.getObject).toHaveBeenCalledWith("co-1", "co-1/file-imports/abc-rfc.pdf");
  });

  it("PATCH /assets/:id updates fileName + folderPath", async () => {
    const svc = {
      update: vi.fn(async () => ({ id: "a-1", fileName: "new.pdf", folderPath: "Y/Z" })),
    };
    const app = buildApp(svc, {});
    const res = await request(app)
      .patch("/companies/co-1/memory/assets/a-1")
      .send({ fileName: "new.pdf", folderPath: "Y/Z" });
    expect(res.status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith("a-1", "co-1", { fileName: "new.pdf", folderPath: "Y/Z" });
  });

  it("DELETE /assets/:id removes", async () => {
    const svc = { remove: vi.fn(async () => undefined) };
    const app = buildApp(svc, {});
    const res = await request(app).delete("/companies/co-1/memory/assets/a-1");
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test memory-assets-routes`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the routes**

Create `server/src/routes/memory-assets.ts`:

```typescript
import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { memoryAssetUpdateSchema } from "@armyofagents/shared";
import { memoryAssetsService, type MemoryAssetsService } from "../services/memory-assets.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess } from "./authz.js";
import { assertRole } from "../middleware/rbac.js";

interface RoutesOptions {
  db?: Db;
  svc?: MemoryAssetsService;
  storage?: { getObject: (companyId: string, key: string) => Promise<{ stream: NodeJS.ReadableStream; contentLength: number; lastModified: Date }> };
  storageService?: StorageService;
}

export function memoryAssetsRoutes(opts: RoutesOptions) {
  const router = Router();
  const svc = opts.svc ?? memoryAssetsService(opts.db!);
  // Test seam: routes accept either a partial { getObject } or a full StorageService.
  const storage = opts.storage ?? opts.storageService;

  router.get(
    "/companies/:companyId/memory/assets",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        const departmentId =
          typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;
        const folderPath =
          typeof req.query.folderPath === "string" ? req.query.folderPath : undefined;
        const mimeType =
          typeof req.query.mimeType === "string" ? req.query.mimeType : undefined;
        const list = await svc.list({ companyId, departmentId, folderPath, mimeType });
        res.json(list);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/companies/:companyId/memory/assets/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertCompanyAccess(req, companyId);
        const asset = await svc.get(id, companyId);
        if (!asset) {
          res.status(404).json({ error: "Asset not found" });
          return;
        }
        res.json(asset);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/companies/:companyId/memory/assets/:id/content",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertCompanyAccess(req, companyId);
        const asset = await svc.get(id, companyId);
        if (!asset) {
          res.status(404).json({ error: "Asset not found" });
          return;
        }
        if (!storage) {
          res.status(500).json({ error: "Storage not configured" });
          return;
        }
        const obj = await storage.getObject(companyId, asset.storageKey);
        res.setHeader("Content-Type", asset.mimeType);
        res.setHeader("Content-Length", String(obj.contentLength));
        res.setHeader(
          "Content-Disposition",
          `inline; filename="${encodeURIComponent(asset.fileName)}"`,
        );
        obj.stream.pipe(res);
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/companies/:companyId/memory/assets/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertCompanyAccess(req, companyId);
        if (opts.db) await assertRole(opts.db, req, companyId, "team_lead");
        const parsed = memoryAssetUpdateSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        const updated = await svc.update(id, companyId, parsed.data);
        if (!updated) {
          res.status(404).json({ error: "Asset not found" });
          return;
        }
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/companies/:companyId/memory/assets/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertCompanyAccess(req, companyId);
        if (opts.db) await assertRole(opts.db, req, companyId, "team_lead");
        await svc.remove(id, companyId);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server test memory-assets-routes`
Expected: PASS — all 7 cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/memory-assets.ts server/src/__tests__/memory-assets-routes.test.ts
git commit -m "feat(memory): add memory-assets routes (list/get/content stream/update/delete)"
```

---

## Task 13: Add `/items/:id/move` and `/items/:id/pin-to-top` to memory routes

**Files:**
- Modify: `server/src/routes/memory.ts`
- Create: `server/src/__tests__/memory-routes-move-pin.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-routes-move-pin.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { memoryRoutes } from "../routes/memory.js";

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: () => undefined,
  getActorInfo: () => ({ userId: "u-1", actorType: "user" }),
}));
vi.mock("../middleware/rbac.js", () => ({
  assertRole: async () => undefined,
}));

vi.mock("../services/memory.js", () => {
  return {
    memoryService: () => ({
      moveItem: vi.fn(async (id: string, companyId: string, folderPath: string) => {
        if (id === "missing") return null;
        return { id, companyId, folderPath };
      }),
      setPinnedToTop: vi.fn(async (id: string, companyId: string, pinned: boolean) => {
        if (id === "missing") return null;
        return { id, companyId, founderPinnedToTop: pinned };
      }),
    }),
  };
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(memoryRoutes({} as never));
  return app;
}

describe("memory routes — move + pin-to-top", () => {
  beforeEach(() => vi.clearAllMocks());

  it("PATCH /companies/:cid/memory/items/:id/move updates folderPath", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/companies/co-1/memory/items/i-1/move")
      .send({ folderPath: "Engineering/Decisions" });
    expect(res.status).toBe(200);
    expect(res.body.folderPath).toBe("Engineering/Decisions");
  });

  it("PATCH /move returns 400 for invalid path", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/companies/co-1/memory/items/i-1/move")
      .send({ folderPath: "/leading/slash" });
    expect(res.status).toBe(400);
  });

  it("PATCH /move returns 404 if item missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/companies/co-1/memory/items/missing/move")
      .send({ folderPath: "Engineering" });
    expect(res.status).toBe(404);
  });

  it("PATCH /pin-to-top sets the flag", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/companies/co-1/memory/items/i-1/pin-to-top")
      .send({ pinned: true });
    expect(res.status).toBe(200);
    expect(res.body.founderPinnedToTop).toBe(true);
  });

  it("PATCH /pin-to-top returns 400 if pinned is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/companies/co-1/memory/items/i-1/pin-to-top")
      .send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test memory-routes-move-pin`
Expected: FAIL — the routes don't exist yet, all assertions fail.

- [ ] **Step 3: Add the routes**

Open `server/src/routes/memory.ts`. Find the route function `memoryRoutes(db: Db)` and the `Router` it returns. Before the `return router;` line, add:

```typescript
  // Phase 6: tree move + pin-to-top
  router.patch(
    "/companies/:companyId/memory/items/:id/move",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertCompanyAccess(req, companyId);
        const parsed = z
          .object({ folderPath: z.string().min(1).max(512) })
          .safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        // Validate path shape via the same rules folders use.
        const { memoryFolderUpdateSchema } = await import("@armyofagents/shared");
        const pathOnly = memoryFolderUpdateSchema.pick({ path: true }).safeParse({ path: parsed.data.folderPath });
        if (!pathOnly.success) {
          res.status(400).json({ error: pathOnly.error.flatten() });
          return;
        }
        const updated = await svc.moveItem(id, companyId, parsed.data.folderPath);
        if (!updated) {
          res.status(404).json({ error: "Memory item not found" });
          return;
        }
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/companies/:companyId/memory/items/:id/pin-to-top",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertCompanyAccess(req, companyId);
        const parsed = z.object({ pinned: z.boolean() }).safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        const updated = await svc.setPinnedToTop(id, companyId, parsed.data.pinned);
        if (!updated) {
          res.status(404).json({ error: "Memory item not found" });
          return;
        }
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );
```

If `z` is not already imported in `memory.ts`, add to top:

```typescript
import { z } from "zod";
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server test memory-routes-move-pin`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/memory.ts server/src/__tests__/memory-routes-move-pin.test.ts
git commit -m "feat(memory): add /items/:id/move and /items/:id/pin-to-top endpoints"
```

---

## Task 14: Mount new route modules in app.ts

**Files:**
- Modify: `server/src/app.ts`

- [ ] **Step 1: Add imports**

Open `server/src/app.ts`. Find the existing imports for `memoryRoutes`, `memoryStarterTemplatesRoutes`, `fileImportRoutes` (around lines 34, 48, 49). After them, add:

```typescript
import { memoryFoldersRoutes } from "./routes/memory-folders.js";
import { memoryAssetsRoutes } from "./routes/memory-assets.js";
```

- [ ] **Step 2: Mount the routes**

Find the existing `api.use(memoryStarterTemplatesRoutes(db));` line (around line 194). After the `fileImportRoutes(...)` line, add:

```typescript
  api.use(memoryFoldersRoutes({ db }));
  api.use(memoryAssetsRoutes({ db, storageService: opts.storageService }));
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter server typecheck`
Expected: `0 errors`

- [ ] **Step 4: Run full server test suite**

Run: `pnpm --filter server test:run`
Expected: All previous tests pass + 6 new test files (folders-service, folders-routes, assets-service, assets-routes, move-pin, seeds) pass.

If any pre-existing test fails, check the failure — if it's a known flake (per CLAUDE.md baselines), it's not blocking. Otherwise stop and diagnose.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts
git commit -m "feat(memory): mount memory-folders and memory-assets routes in app.ts"
```

---

## Task 15: Add LiveEvents publishes to services

**Files:**
- Modify: `server/src/services/memory-folders.ts`
- Modify: `server/src/services/memory-assets.ts`
- Modify: `server/src/services/memory.ts`
- Create: `server/src/__tests__/memory-live-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-live-events.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  memoryFolders: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  memoryAssets: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  memoryItems: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
}));

const publishMock = vi.fn();
vi.mock("./live-events.js", () => ({ publishLiveEvent: publishMock }));

// We import after mocking.
import { memoryFoldersService } from "../services/memory-folders.js";
import { memoryAssetsService } from "../services/memory-assets.js";

function tinyDb() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    select: () => ({ from: () => ({ where: async () => rows }) }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          const created = { ...row, id: `r-${rows.length}`, createdAt: new Date(), updatedAt: new Date() };
          rows.push(created);
          return [created];
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (rows.length === 0) return [];
            rows[0] = { ...rows[0], ...patch };
            return [rows[0]];
          },
        }),
      }),
    }),
    delete: () => ({ where: async () => { rows.splice(0); } }),
  };
}

describe("LiveEvents publishes from memory services", () => {
  beforeEach(() => publishMock.mockClear());

  it("memoryFoldersService.create publishes memory.folder.created", async () => {
    const db = tinyDb();
    const svc = memoryFoldersService(db as never);
    await svc.create({
      companyId: "co-1",
      departmentId: null,
      path: "Engineering",
      displayName: "Engineering",
    });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.folder.created",
        companyId: "co-1",
      }),
    );
  });

  it("memoryAssetsService.create publishes memory.asset.created", async () => {
    const db = tinyDb();
    const svc = memoryAssetsService(db as never);
    await svc.create({
      companyId: "co-1",
      departmentId: null,
      folderPath: "Files",
      fileName: "x.pdf",
      mimeType: "application/pdf",
      fileSize: 1,
      storageKey: "k",
    });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.asset.created",
        companyId: "co-1",
      }),
    );
  });

  it("memoryFoldersService.remove publishes memory.folder.deleted", async () => {
    const db = tinyDb();
    db.rows.push({ id: "f-1", companyId: "co-1" });
    const svc = memoryFoldersService(db as never);
    await svc.remove("f-1", "co-1");
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.folder.deleted",
        companyId: "co-1",
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test memory-live-events`
Expected: FAIL — `publishLiveEvent` is never called.

- [ ] **Step 3: Confirm the existing publishLiveEvent signature**

The helper already exists at `server/src/services/live-events.ts:27` with this exact signature:

```typescript
export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: Record<string, unknown>;
}): LiveEvent;
```

No new helper needed. The mock in our test (`vi.mock("./live-events.js", () => ({ publishLiveEvent: publishMock }))`) shadows it during tests, and the production calls below pass the same shape.

- [ ] **Step 4: Add publishes to memoryFoldersService**

Open `server/src/services/memory-folders.ts`. Add the import:

```typescript
import { publishLiveEvent } from "./live-events.js";
```

In the `create` method, right before `return row;`, add:

```typescript
publishLiveEvent({
  type: "memory.folder.created",
  companyId: input.companyId,
  payload: { folder: row },
});
```

In the `update` method, after the row is fetched and before returning, add (only if `row` is non-null):

```typescript
if (row) {
  publishLiveEvent({
    type: "memory.folder.updated",
    companyId,
    payload: { folder: row },
  });
}
```

In the `remove` method, after the delete completes, add:

```typescript
publishLiveEvent({
  type: "memory.folder.deleted",
  companyId,
  payload: { id },
});
```

- [ ] **Step 5: Add publishes to memoryAssetsService**

Open `server/src/services/memory-assets.ts`. Add the same import and similar publishes in `create` (`memory.asset.created`), `update` (`memory.asset.updated`), `remove` (`memory.asset.deleted`).

- [ ] **Step 6: Add publishes to memoryService.moveItem and setPinnedToTop**

Open `server/src/services/memory.ts`. In `moveItem`, after the row is updated:

```typescript
if (row) {
  publishLiveEvent({
    type: "memory.item.moved",
    companyId,
    payload: { item: row },
  });
}
```

In `setPinnedToTop`, after the update:

```typescript
if (row) {
  publishLiveEvent({
    type: "memory.item.updated",
    companyId,
    payload: { item: row },
  });
}
```

Add the import if missing.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter server test memory-live-events`
Expected: PASS — all 3 cases.

Also run the per-service tests to make sure nothing broke:

Run: `pnpm --filter server test memory-folders-service memory-assets-service memory-move-pin`
Expected: PASS — all unchanged.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/memory-folders.ts server/src/services/memory-assets.ts server/src/services/memory.ts server/src/__tests__/memory-live-events.test.ts
git commit -m "feat(memory): publish memory.* LiveEvents from folders/assets/move/pin operations"
```

---

## Task 16: Hook into project creation to seed folders + backfill existing items

**Files:**
- Modify: `server/src/services/projects.ts` (or wherever `createProject` lives — verify with grep)
- Create: `packages/db/src/migrations/00XY_memory_folder_path_backfill.sql`
- Create: `server/src/__tests__/memory-folder-path-migration.test.ts`

- [ ] **Step 1: Locate project creation**

Run:
```bash
grep -rn "createProject\|insert.*projects" server/src/services/projects.ts | head -5
```

Note the exact function name and shape. The hook needs to call `memoryFoldersService(db).seedForDepartment(...)` after a department is created (i.e. when `type === "department"`).

- [ ] **Step 2: Write the failing test for the seed hook**

Add to `server/src/__tests__/memory-folder-seeds.test.ts` (or create a new sibling test):

```typescript
import { describe, it, expect, vi } from "vitest";
import { seedFoldersOnDepartmentCreate } from "../services/memory-folders.js";

describe("seedFoldersOnDepartmentCreate", () => {
  it("seeds folders for newly-created department", async () => {
    const seedSpy = vi.fn(async () => []);
    const fakeSvc = { seedForDepartment: seedSpy };
    await seedFoldersOnDepartmentCreate(fakeSvc as never, {
      companyId: "co-1",
      project: {
        id: "p-1",
        type: "department",
        slug: "engineering",
        functionType: "software_development",
      },
    });
    expect(seedSpy).toHaveBeenCalledWith({
      companyId: "co-1",
      departmentId: "p-1",
      departmentSlug: "engineering",
      functionType: "software_development",
    });
  });

  it("does NOT seed folders for non-department projects", async () => {
    const seedSpy = vi.fn();
    const fakeSvc = { seedForDepartment: seedSpy };
    await seedFoldersOnDepartmentCreate(fakeSvc as never, {
      companyId: "co-1",
      project: { id: "p-1", type: "project", slug: "x", functionType: null },
    });
    expect(seedSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Implement the hook helper**

Open `server/src/services/memory-folders.ts`. Append:

```typescript
interface SeedHookProject {
  id: string;
  type: string;
  slug: string;
  functionType: string | null;
}

export async function seedFoldersOnDepartmentCreate(
  svc: MemoryFoldersService,
  input: { companyId: string; project: SeedHookProject },
): Promise<void> {
  if (input.project.type !== "department") return;
  await svc.seedForDepartment({
    companyId: input.companyId,
    departmentId: input.project.id,
    departmentSlug: input.project.slug,
    functionType: input.project.functionType,
  });
}
```

- [ ] **Step 4: Wire the hook into project creation**

Open the file you found in Step 1. After the `INSERT INTO projects` returns the new row, call:

```typescript
import { memoryFoldersService, seedFoldersOnDepartmentCreate } from "./memory-folders.js";

// ... inside the createProject function, after `const [project] = await db.insert(...).returning();`
await seedFoldersOnDepartmentCreate(memoryFoldersService(db), {
  companyId: project.companyId,
  project,
}).catch((err) => {
  // Log but don't fail the project creation if seeding fails — folders can be re-seeded later.
  logger.warn({ err, projectId: project.id }, "memory folder seeding failed");
});
```

- [ ] **Step 5: Write the data-migration backfill**

Create `packages/db/src/migrations/00XY_memory_folder_path_backfill.sql` (number after the auto-generated migration from Task 4):

```sql
-- Phase 6: Backfill folderPath for memory_items created before this migration.
--
-- Rule:
--   layer = 'identity' AND department_id IS NULL  → 'Company'
--   department_id IS NOT NULL → '<deptSlug>/<categoryFolder>'
--   layer = 'working'        → '<deptSlug>/Working'
--   else                      → '<deptSlug>' or ''

UPDATE memory_items mi
SET folder_path = CASE
  WHEN mi.layer = 'identity' AND mi.department_id IS NULL THEN 'Company'
  WHEN mi.layer = 'working' AND mi.department_id IS NOT NULL THEN
    (SELECT p.slug FROM projects p WHERE p.id = mi.department_id) || '/Working'
  WHEN mi.department_id IS NOT NULL THEN
    (SELECT p.slug FROM projects p WHERE p.id = mi.department_id)
    || '/'
    || CASE mi.category
         WHEN 'decision'   THEN 'Decisions'
         WHEN 'reference'  THEN 'References'
         WHEN 'context'    THEN 'References'
         WHEN 'insight'    THEN 'References'
         WHEN 'preference' THEN 'References'
         WHEN 'procedure'  THEN 'Playbooks'
         WHEN 'policy'     THEN 'Policies'
         ELSE 'References'
       END
  ELSE ''
END
WHERE mi.folder_path = '';

-- Sanity: every item should now have a folder_path (either set above or already non-empty).
-- Anything still empty is uncategorized — that's fine, just visible at dept root.
```

- [ ] **Step 6: Add migration entry to journal**

Open `packages/db/src/migrations/meta/_journal.json`. Add an entry for the backfill migration in the same format as existing entries (drizzle-kit will normally do this, but a hand-written SQL file needs manual entry):

```json
{
  "idx": <next-index>,
  "version": "7",
  "when": <unix-ms>,
  "tag": "00XY_memory_folder_path_backfill",
  "breakpoints": true
}
```

(Replace `<next-index>` with the next number after your generated migration's index, and `<unix-ms>` with `Date.now()` value.)

- [ ] **Step 7: Write a contract test for the backfill**

Create `server/src/__tests__/memory-folder-path-migration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// This is a contract test — it asserts the SQL file exists and contains the
// expected backfill clauses. It does NOT execute the SQL. Real execution is
// tested via the integration `migrate.ts` runner during CI.

describe("memory-folder-path backfill migration", () => {
  const migrationsDir = path.resolve(
    __dirname,
    "../../../packages/db/src/migrations",
  );

  it("file exists with the expected name pattern", () => {
    const files = fs.readdirSync(migrationsDir);
    const target = files.find((f) =>
      f.includes("memory_folder_path_backfill") && f.endsWith(".sql"),
    );
    expect(target).toBeDefined();
  });

  it("contains the category → folder mapping", () => {
    const files = fs.readdirSync(migrationsDir);
    const target = files.find((f) =>
      f.includes("memory_folder_path_backfill") && f.endsWith(".sql"),
    );
    const sql = fs.readFileSync(path.join(migrationsDir, target!), "utf8");
    expect(sql).toContain("'decision'");
    expect(sql).toContain("'Decisions'");
    expect(sql).toContain("'procedure'");
    expect(sql).toContain("'Playbooks'");
    expect(sql).toContain("'policy'");
    expect(sql).toContain("'Policies'");
  });

  it("handles identity layer with null department_id", () => {
    const files = fs.readdirSync(migrationsDir);
    const target = files.find((f) =>
      f.includes("memory_folder_path_backfill") && f.endsWith(".sql"),
    );
    const sql = fs.readFileSync(path.join(migrationsDir, target!), "utf8");
    expect(sql).toContain("'identity'");
    expect(sql).toContain("'Company'");
  });

  it("handles working layer", () => {
    const files = fs.readdirSync(migrationsDir);
    const target = files.find((f) =>
      f.includes("memory_folder_path_backfill") && f.endsWith(".sql"),
    );
    const sql = fs.readFileSync(path.join(migrationsDir, target!), "utf8");
    expect(sql).toContain("'working'");
    expect(sql).toContain("'/Working'");
  });
});
```

- [ ] **Step 8: Run tests**

Run: `pnpm --filter server test memory-folder-seeds memory-folder-path-migration`
Expected: PASS — all cases including new seed-on-create hook + backfill contract.

- [ ] **Step 9: Run full server suite**

Run: `pnpm --filter server test:run`
Expected: All previous tests pass + the new tests pass. Pre-existing flake baselines unchanged.

- [ ] **Step 10: Run typecheck across the workspace**

Run: `pnpm -r typecheck`
Expected: 0 errors across all packages.

- [ ] **Step 11: Run build**

Run: `pnpm build`
Expected: clean build of server + ui + cli + plugin examples.

- [ ] **Step 12: Commit + push the foundation**

```bash
git add server/src/services/projects.ts server/src/services/memory-folders.ts server/src/__tests__/memory-folder-seeds.test.ts packages/db/src/migrations/ server/src/__tests__/memory-folder-path-migration.test.ts
git commit -m "feat(memory): seed folders on dept create + backfill migration for existing items"
```

---

## Verification — exit criteria for Phase 6.0

After Task 16, the following should be true:

1. ✅ `pnpm -r typecheck` returns 0 errors.
2. ✅ `pnpm --filter server test:run` passes; new test files (folders-service, folders-routes, assets-service, assets-routes, move-pin, seeds, live-events, migration) all green; pre-existing flake baselines unchanged.
3. ✅ `pnpm --filter @armyofagents/db generate` produces no new diff (schemas in sync with migrations).
4. ✅ `pnpm build` clean.
5. ✅ `pnpm --filter @armyofagents/db migrate` (run against a fresh DB) applies cleanly through both new migrations.
6. ✅ Manual smoke (curl from a running server, see below) succeeds for all 8 new endpoints.

### Smoke test (manual, optional but recommended)

With a running server + an authenticated session cookie + a known `companyId` and `departmentId`:

```bash
# List folders (should include seeded ones if the dept was created after this code shipped)
curl -b cookies.txt http://localhost:5174/api/companies/$CID/memory/folders

# Create a folder
curl -b cookies.txt -X POST http://localhost:5174/api/companies/$CID/memory/folders \
  -H 'content-type: application/json' \
  -d '{"departmentId":"'$DID'","path":"Engineering/RFCs","displayName":"RFCs"}'

# Move a memory item
curl -b cookies.txt -X PATCH http://localhost:5174/api/companies/$CID/memory/items/$ITEMID/move \
  -H 'content-type: application/json' \
  -d '{"folderPath":"Engineering/Decisions"}'

# Pin to top
curl -b cookies.txt -X PATCH http://localhost:5174/api/companies/$CID/memory/items/$ITEMID/pin-to-top \
  -H 'content-type: application/json' \
  -d '{"pinned":true}'

# List assets (will be empty until Phase 6.1 wires uploads through this route)
curl -b cookies.txt http://localhost:5174/api/companies/$CID/memory/assets
```

### What's NOT in this plan (handled in 6.1+)

- Any UI components (tree, file list, viewer, home page, ⌘K, etc.)
- The new `/assets/upload` POST endpoint that wraps `fileImportService.upload` — the existing `/memory/import-file` continues to work; we'll add the unified endpoint in Phase 6.1 alongside the upload UI.
- Backfilling `memory_assets` rows from existing `file_import_jobs` — also Phase 6.1 (we don't want stale assets without a viewer to surface them).
- Wiring `memory.import.progress` LiveEvents from the file-import worker — Phase 6.1.

---

## Self-review — coverage against the spec

| Spec section | Covered by tasks |
|---|---|
| Schema: memory_items new columns | Task 1, migration in Task 4 |
| Schema: memory_assets table | Task 2, migration in Task 4 |
| Schema: memory_folders table | Task 3, migration in Task 4 |
| Migration: backfill folderPath | Task 16 |
| Validators: folder + asset Zod schemas | Task 6 |
| Types: MemoryAssetRecord + MemoryFolderRecord | Task 6 |
| LIVE_EVENT_TYPES additions | Task 5 |
| Seed map per functionType | Task 7 |
| Folder service (CRUD + seed) | Task 8 |
| Asset service (CRUD + content seam) | Task 9 |
| Memory item move + pin-to-top | Task 10 (service), Task 13 (route) |
| Routes: folders | Task 11 |
| Routes: assets (list, get, content stream, update, delete) | Task 12 |
| Routes mounted in app.ts | Task 14 |
| LiveEvents publishes | Task 15 |
| Department-creation hook → seed folders | Task 16 |
| RBAC enforcement (founder/team_lead for writes) | Task 11 + Task 12 (assertRole calls) |
| companyId scoping on every query | Service implementations in Tasks 8, 9, 10 |

Open question carried forward to 6.1: the new `/assets/upload` endpoint that wraps `fileImportService.upload`. Spec calls for it; this plan defers it because there's no UI consumer yet, and the existing `/memory/import-file` route still works.
