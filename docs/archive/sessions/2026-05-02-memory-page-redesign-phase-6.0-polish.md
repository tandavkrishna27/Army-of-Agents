# Memory Page Redesign — Phase 6.0 Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two data-completeness gaps surfaced by Phase 6.0's final review: (1) wire the unused `COMPANY_SEED_FOLDERS` export into company creation so every company has a `Company` root folder, and (2) backfill `memory_folders` rows for the companies and departments that existed before Phase 6.0 shipped.

**Architecture:** Three changes — a `seedCompanyRootFolder` helper alongside the existing `seedFoldersOnDepartmentCreate` (TS), wiring into the company creation path (TS), and a one-time data migration `0075_seed_existing_companies_and_departments.sql` (SQL) that idempotently inserts the seed folder rows for pre-existing data. All work continues on branch `memory-phase-6-0`.

**Tech Stack:** Existing AoA patterns — Drizzle ORM 0.38, Express 5.x, Vitest with mocked DB, raw SQL migration files. No new dependencies.

**Spec reference:** [`docs/superpowers/specs/2026-05-02-memory-page-redesign-design.md`](../specs/2026-05-02-memory-page-redesign-design.md) and the parent plan [`2026-05-02-memory-page-redesign-phase-6.0-foundation.md`](2026-05-02-memory-page-redesign-phase-6.0-foundation.md).

**Branch + worktree:** `memory-phase-6-0` in `.claude/worktrees/memory-phase-6-0/`. Most recent commit at plan-write time: `c14d053`.

---

## File Structure

### New files

```
packages/db/src/migrations/0075_seed_existing_companies_and_departments.sql   ← idempotent backfill
packages/db/src/migrations/meta/0075_snapshot.json                              ← copy of 0074, fresh id
server/src/__tests__/seed-company-root-folder.test.ts                           ← TDD test for helper
server/src/__tests__/seed-existing-backfill-migration.test.ts                   ← contract test for SQL
```

### Modified files

```
server/src/services/memory-folders.ts          ← +seedCompanyRootFolder export
server/src/services/companies.ts (or wherever createCompany lives — verify w/ grep)  ← invoke seed on create
packages/db/src/migrations/meta/_journal.json  ← +entry idx 75
```

### Why this split

The new helper sits next to `seedFoldersOnDepartmentCreate` because they share the same shape (idempotent, best-effort, calls the underlying CRUD). Backfill is a SQL migration because that's the standard AoA pattern for one-time data fixes (mirrors `0069_wide_earthquake.sql` precedent for the teams pre-flight cleanup). Both new tests follow existing conventions: helper test mocks the service, contract test reads the SQL file and asserts on its content.

---

## Task 1: Add `seedCompanyRootFolder` helper + wire into company creation

**Files:**
- Modify: `server/src/services/memory-folders.ts`
- Create: `server/src/__tests__/seed-company-root-folder.test.ts`

- [ ] **Step 1: Branch safety**

```bash
cd "C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.claude/worktrees/memory-phase-6-0"
git rev-parse --abbrev-ref HEAD
```

Expected: `memory-phase-6-0`. STOP if not.

- [ ] **Step 2: Write the failing test**

Create `server/src/__tests__/seed-company-root-folder.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { seedCompanyRootFolder } from "../services/memory-folders.js";

describe("seedCompanyRootFolder", () => {
  it("creates the Company folder for a new company", async () => {
    const createSpy = vi.fn(async () => ({ id: "f-1", path: "Company" }));
    const fakeSvc = { create: createSpy };
    await seedCompanyRootFolder(fakeSvc as never, { companyId: "co-1" });
    expect(createSpy).toHaveBeenCalledWith({
      companyId: "co-1",
      departmentId: null,
      path: "Company",
      displayName: "Company",
      icon: "🏛️",
      seedKey: "company.root",
    });
  });

  it("is idempotent — does not throw on duplicate seed", async () => {
    // The unique index on (companyId, path) will reject the second insert; the
    // helper catches and treats as "already seeded".
    const createSpy = vi.fn(async () => {
      throw new Error("duplicate key value violates unique constraint \"memory_folders_unique_path_per_company\"");
    });
    const fakeSvc = { create: createSpy };
    // Should not throw.
    await expect(
      seedCompanyRootFolder(fakeSvc as never, { companyId: "co-1" }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter server test seed-company-root-folder`
Expected: FAIL — `seedCompanyRootFolder` is not exported from `../services/memory-folders.js`.

- [ ] **Step 4: Implement the helper**

Open `server/src/services/memory-folders.ts`. Append at the end (after the existing `seedFoldersOnDepartmentCreate` function):

```typescript
import { COMPANY_SEED_FOLDERS } from "./memory-folder-seeds.js";

/**
 * Phase 6.0 polish: seed the Company root folder for a new company. Best-effort
 * — duplicate key violations (from a re-run on a company that already has the
 * folder) are caught and ignored. The unique index on (companyId, path)
 * provides the idempotency guarantee at the DB level.
 */
export async function seedCompanyRootFolder(
  svc: MemoryFoldersService,
  input: { companyId: string },
): Promise<void> {
  const seed = COMPANY_SEED_FOLDERS[0];
  if (!seed) return;
  try {
    await svc.create({
      companyId: input.companyId,
      departmentId: null,
      path: seed.path,
      displayName: seed.displayName,
      icon: seed.icon ?? null,
      seedKey: seed.seedKey,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("memory_folders_unique_path_per_company")) {
      // Already seeded — fine. Best-effort idempotence.
      return;
    }
    throw err;
  }
}
```

The `import { COMPANY_SEED_FOLDERS }` line goes at the top of the file alongside the existing `import { getSeedFoldersForFunctionType } from "./memory-folder-seeds.js";` — combine them:

```typescript
import { getSeedFoldersForFunctionType, COMPANY_SEED_FOLDERS } from "./memory-folder-seeds.js";
```

- [ ] **Step 5: Run test, expect PASS**

Run: `pnpm --filter server test seed-company-root-folder`
Expected: PASS — both cases (creates folder, swallows duplicate-key).

- [ ] **Step 6: Find the company creation callsite**

Run from the worktree:
```bash
grep -rn "INSERT INTO companies\|insert(companies)\|insert.*companies\b" server/src/services/companies.ts 2>&1 | head -10
```

Note the function name (likely `createCompany`) and the line where the new company row is returned from the insert.

- [ ] **Step 7: Wire the helper into company creation**

Open the companies service file you found. After the `INSERT INTO companies` returns the new row, call:

```typescript
import { memoryFoldersService, seedCompanyRootFolder } from "./memory-folders.js";

// inside the createCompany function, AFTER the new row is returned:
await seedCompanyRootFolder(memoryFoldersService(db), {
  companyId: company.id,
}).catch((err: unknown) => {
  logger.warn({ err, companyId: company.id }, "memory company-root folder seeding failed");
});
```

Verify the imports: `memoryFoldersService` and `seedCompanyRootFolder` from `./memory-folders.js`, and `logger` from `../middleware/logger.js` (add if not already present).

If the existing companies service has multiple distinct create paths (e.g. for different deployment modes), wire into each — or extract a single post-create helper that all paths call. Match the existing AoA pattern for that file.

- [ ] **Step 8: Run typecheck**

Run: `pnpm --filter server typecheck`
Expected: 0 errors.

- [ ] **Step 9: Run the helper test + a quick sanity check on existing tests**

Run: `pnpm --filter server test seed-company-root-folder memory-folder-seeds memory-folders-service`
Expected: All cases PASS (2 + 9 + 5 = 16).

- [ ] **Step 10: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD   # must show memory-phase-6-0
git add server/src/services/memory-folders.ts server/src/services/companies.ts server/src/__tests__/seed-company-root-folder.test.ts
git commit -m "feat(memory): seed Company root folder on company create (closes COMPANY_SEED_FOLDERS gap)"
```

If the companies service file path is different from `server/src/services/companies.ts`, adjust the `git add` accordingly.

---

## Task 2: Backfill migration `0075` for pre-existing companies and departments

**Files:**
- Create: `packages/db/src/migrations/0075_seed_existing_companies_and_departments.sql`
- Create: `packages/db/src/migrations/meta/0075_snapshot.json`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Create: `server/src/__tests__/seed-existing-backfill-migration.test.ts`

- [ ] **Step 1: Branch safety**

```bash
cd "C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.claude/worktrees/memory-phase-6-0"
git rev-parse --abbrev-ref HEAD
```

Expected: `memory-phase-6-0`. STOP if not.

- [ ] **Step 2: Write the failing contract test**

Create `server/src/__tests__/seed-existing-backfill-migration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "../../../packages/db/src/migrations",
);

function findMigrationFile(): string | undefined {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  return files.find((f) =>
    f.startsWith("0075_") && f.includes("seed_existing") && f.endsWith(".sql"),
  );
}

describe("0075 backfill migration — seed existing companies + departments", () => {
  it("file exists with the expected name pattern", () => {
    expect(findMigrationFile()).toBeDefined();
  });

  it("seeds Company root folder for every existing company", () => {
    const target = findMigrationFile()!;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, target), "utf8");
    expect(sql).toContain("INSERT INTO memory_folders");
    expect(sql).toContain("'Company'");
    expect(sql).toContain("'company.root'");
    // Selects from companies table, not just a literal — proves it iterates existing rows.
    expect(sql).toMatch(/FROM\s+companies/);
  });

  it("seeds dept folders per functionType for every existing department", () => {
    const target = findMigrationFile()!;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, target), "utf8");
    // The migration should reference projects with type='department'.
    expect(sql).toContain("'department'");
    // It should include the seed-folder names from the seed map (at least the engineering set).
    expect(sql).toContain("'Decisions'");
    expect(sql).toContain("'Architecture'");
    expect(sql).toContain("'Files'");
    // It should include seedKeys with the function-type prefix.
    expect(sql).toContain("software_development.decisions");
    expect(sql).toContain("marketing.brand");
    expect(sql).toContain("customer_support.macros");
    expect(sql).toContain("generic.policies");
  });

  it("uses ON CONFLICT DO NOTHING for idempotency", () => {
    const target = findMigrationFile()!;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, target), "utf8");
    expect(sql.toLowerCase()).toContain("on conflict");
    expect(sql.toLowerCase()).toContain("do nothing");
  });

  it("derives department slug from urlKey or name (matches Phase 6.0 backfill convention)", () => {
    const target = findMigrationFile()!;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, target), "utf8");
    // Either urlKey is read directly, or name → slug via regexp_replace, matching 0074.
    const usesUrlKey = sql.includes("url_key");
    const usesNameRegex = sql.includes("regexp_replace") && sql.includes("[^a-z0-9]+");
    expect(usesUrlKey || usesNameRegex).toBe(true);
  });
});
```

- [ ] **Step 3: Run test, expect FAIL**

Run: `pnpm --filter server test seed-existing-backfill-migration`
Expected: FAIL — file does not exist yet.

- [ ] **Step 4: Write the SQL migration**

Create `packages/db/src/migrations/0075_seed_existing_companies_and_departments.sql`:

```sql
-- Phase 6.0 polish: seed memory_folders rows for companies and departments
-- that existed before Phase 6.0 shipped.
--
-- Idempotent: relies on the unique index memory_folders_unique_path_per_company
-- to silently skip rows that already exist (covers the case where a company or
-- department was created AFTER 6.0 shipped via the create-hook).
--
-- Safe to re-run: ON CONFLICT DO NOTHING short-circuits duplicate inserts.

-- ── 1. Company root folder for every existing company ────────────────────────
INSERT INTO memory_folders (company_id, department_id, path, display_name, icon, seed_key, sort_order)
SELECT c.id, NULL, 'Company', 'Company', '🏛️', 'company.root', 0
FROM companies c
ON CONFLICT (company_id, path) DO NOTHING;
--> statement-breakpoint

-- ── 2. Department-scoped seed folders ────────────────────────────────────────
-- For each department (projects with type='department'), insert the appropriate
-- seed-folder set based on its functionType. Path is derived as
-- `<deptSlug>/<seedFolder>` where deptSlug is `urlKey` if non-null, else
-- regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g') trimmed of leading/trailing
-- dashes (matches the Phase 6.0 0074 backfill convention).

WITH dept_slugs AS (
  SELECT
    p.id,
    p.company_id,
    COALESCE(
      NULLIF(p.url_key, ''),
      regexp_replace(
        regexp_replace(lower(p.name), '[^a-z0-9]+', '-', 'g'),
        '^-+|-+$',
        '',
        'g'
      )
    ) AS slug,
    p.function_type
  FROM projects p
  WHERE p.type = 'department'
),
seed_rows AS (
  -- software_development
  SELECT id, company_id, slug, 'Decisions' AS path, 'Decisions' AS display_name, NULL::text AS icon, 'software_development.decisions' AS seed_key FROM dept_slugs WHERE function_type = 'software_development'
  UNION ALL SELECT id, company_id, slug, 'Playbooks', 'Playbooks', NULL, 'software_development.playbooks' FROM dept_slugs WHERE function_type = 'software_development'
  UNION ALL SELECT id, company_id, slug, 'References', 'References', NULL, 'software_development.references' FROM dept_slugs WHERE function_type = 'software_development'
  UNION ALL SELECT id, company_id, slug, 'Architecture', 'Architecture', NULL, 'software_development.architecture' FROM dept_slugs WHERE function_type = 'software_development'
  UNION ALL SELECT id, company_id, slug, 'Files', 'Files', '📁', 'software_development.files' FROM dept_slugs WHERE function_type = 'software_development'
  -- marketing
  UNION ALL SELECT id, company_id, slug, 'Decisions', 'Decisions', NULL, 'marketing.decisions' FROM dept_slugs WHERE function_type = 'marketing'
  UNION ALL SELECT id, company_id, slug, 'Brand', 'Brand', NULL, 'marketing.brand' FROM dept_slugs WHERE function_type = 'marketing'
  UNION ALL SELECT id, company_id, slug, 'Campaigns', 'Campaigns', NULL, 'marketing.campaigns' FROM dept_slugs WHERE function_type = 'marketing'
  UNION ALL SELECT id, company_id, slug, 'References', 'References', NULL, 'marketing.references' FROM dept_slugs WHERE function_type = 'marketing'
  UNION ALL SELECT id, company_id, slug, 'Files', 'Files', '📁', 'marketing.files' FROM dept_slugs WHERE function_type = 'marketing'
  -- customer_support
  UNION ALL SELECT id, company_id, slug, 'Playbooks', 'Playbooks', NULL, 'customer_support.playbooks' FROM dept_slugs WHERE function_type = 'customer_support'
  UNION ALL SELECT id, company_id, slug, 'Macros', 'Macros', NULL, 'customer_support.macros' FROM dept_slugs WHERE function_type = 'customer_support'
  UNION ALL SELECT id, company_id, slug, 'References', 'References', NULL, 'customer_support.references' FROM dept_slugs WHERE function_type = 'customer_support'
  UNION ALL SELECT id, company_id, slug, 'Files', 'Files', '📁', 'customer_support.files' FROM dept_slugs WHERE function_type = 'customer_support'
  -- generic (everything else, including null functionType)
  UNION ALL SELECT id, company_id, slug, 'Decisions', 'Decisions', NULL, 'generic.decisions' FROM dept_slugs WHERE function_type IS NULL OR function_type NOT IN ('software_development', 'marketing', 'customer_support')
  UNION ALL SELECT id, company_id, slug, 'Policies', 'Policies', NULL, 'generic.policies' FROM dept_slugs WHERE function_type IS NULL OR function_type NOT IN ('software_development', 'marketing', 'customer_support')
  UNION ALL SELECT id, company_id, slug, 'References', 'References', NULL, 'generic.references' FROM dept_slugs WHERE function_type IS NULL OR function_type NOT IN ('software_development', 'marketing', 'customer_support')
  UNION ALL SELECT id, company_id, slug, 'Files', 'Files', '📁', 'generic.files' FROM dept_slugs WHERE function_type IS NULL OR function_type NOT IN ('software_development', 'marketing', 'customer_support')
)
INSERT INTO memory_folders (company_id, department_id, path, display_name, icon, seed_key, sort_order)
SELECT
  sr.company_id,
  sr.id AS department_id,
  sr.slug || '/' || sr.path AS path,
  sr.display_name,
  sr.icon,
  sr.seed_key,
  0
FROM seed_rows sr
WHERE sr.slug IS NOT NULL AND sr.slug <> ''
ON CONFLICT (company_id, path) DO NOTHING;
--> statement-breakpoint
```

- [ ] **Step 5: Add to journal**

Open `packages/db/src/migrations/meta/_journal.json`. Find the entry for `0074_memory_folder_path_backfill` and add a new entry right after it:

```json
{
  "idx": 75,
  "version": "7",
  "when": <Date.now() value as integer>,
  "tag": "0075_seed_existing_companies_and_departments",
  "breakpoints": true
}
```

Use Node's `Date.now()` to get the timestamp — paste a literal integer (e.g. `1746210000000` or whatever the actual current millis are). The value must be greater than the 0074 entry's `when` to keep ordering monotonic.

- [ ] **Step 6: Create the snapshot**

This migration is data-only, so we copy `0074_snapshot.json` verbatim and update the `id` and `prevId` fields:

```bash
cp packages/db/src/migrations/meta/0074_snapshot.json packages/db/src/migrations/meta/0075_snapshot.json
```

Then read both files and edit `0075_snapshot.json`:
- Set `id` to a fresh UUID v4 (use `node -e "console.log(require('crypto').randomUUID())"` to generate one).
- Set `prevId` to the value of the `id` field in `0074_snapshot.json`.

Leave all other fields (especially `tables`, `enums`, `dialect`) untouched — schema is unchanged.

- [ ] **Step 7: Run contract test, expect PASS**

Run: `pnpm --filter server test seed-existing-backfill-migration`
Expected: PASS — all 5 cases.

- [ ] **Step 8: Sanity check the existing 0074 contract test still passes**

Run: `pnpm --filter server test memory-folder-path-migration`
Expected: PASS — the existing 4 cases unchanged.

- [ ] **Step 9: Run the full server test suite to confirm no regressions**

Run: `pnpm --filter server test:run 2>&1 | tail -10`

Compare against the Task 14/16 baseline (29 failed / 2128 or 2130 passed). The new tests should add to the pass count without introducing any new failures.

- [ ] **Step 10: Run workspace typecheck**

Run: `pnpm -r typecheck`
Expected: 0 errors across all packages.

- [ ] **Step 11: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD   # must show memory-phase-6-0
git add packages/db/src/migrations/0075_seed_existing_companies_and_departments.sql packages/db/src/migrations/meta/_journal.json packages/db/src/migrations/meta/0075_snapshot.json server/src/__tests__/seed-existing-backfill-migration.test.ts
git commit -m "feat(db): backfill memory_folders for existing companies and departments (0075)"
```

---

## Task 3: Final verification + summary commit (optional)

**Files:** none modified — verification only.

- [ ] **Step 1: Branch safety**

```bash
cd "C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.claude/worktrees/memory-phase-6-0"
git rev-parse --abbrev-ref HEAD
```

Expected: `memory-phase-6-0`.

- [ ] **Step 2: Confirm clean working tree**

Run: `git status`
Expected: `nothing to commit, working tree clean`.

- [ ] **Step 3: List all commits since plan-write time**

Run: `git log --oneline c14d053..HEAD`
Expected: 2 new commits — the Task 1 and Task 2 commits in order.

- [ ] **Step 4: Workspace typecheck**

Run: `pnpm -r typecheck 2>&1 | tail -5`
Expected: All packages report `Done`.

- [ ] **Step 5: Run the full Phase 6.0 test surface**

Run: `pnpm --filter server test memory- seed-`
Expected: All Phase 6.0 + polish tests pass.

- [ ] **Step 6: Smoke-check both migrations parse**

Run: `cat packages/db/src/migrations/0075_*.sql | head -20`
Expected: SQL is readable, contains the expected `INSERT INTO memory_folders`.

This task produces no new commit — it is a verification-only checkpoint.

---

## Verification — exit criteria for Phase 6.0 polish

After Tasks 1 + 2 are complete:

1. ✅ `pnpm -r typecheck` returns 0 errors.
2. ✅ `pnpm --filter server test:run` passes; new tests (seed-company-root-folder, seed-existing-backfill-migration) all green; pre-existing flake baselines unchanged.
3. ✅ `git status` clean on the worktree.
4. ✅ The branch `memory-phase-6-0` now has 20 commits ahead of `1f08768`.
5. ✅ `cat packages/db/src/migrations/meta/_journal.json` lists 75 entries (0–74 + 75 new).
6. ✅ Both gaps from the final code review are closed.

---

## Self-review — coverage against the surfaced issues

| Issue from final review | Closed by |
|---|---|
| `COMPANY_SEED_FOLDERS` exported but unused | Task 1 — `seedCompanyRootFolder` helper consumes it; company creation invokes it |
| Existing departments missing seed folders | Task 2 — `0075` migration backfills both companies' Company folder + departments' seed folders, idempotently |

Both are best-practice closures: Task 1 makes the data model complete forward-going (every new company gets the Company folder), Task 2 makes the data model complete for the existing population (every pre-existing company + department gets their seeds).

---

## What's NOT in this plan (deferred to Phase 6.1+)

- UI components for the memory tree, file list, viewer (the entire Phase 6.1 scope).
- A unified `/memory/folders/_reseed` admin endpoint for "reset folders to defaults" — not needed because the migration handles backfill and the create hooks handle ongoing.
- `lastAccessedByUserId` index — was flagged in Task 1's review as a deferred decision; revisit when the Recents widget query shape is final.
- Materialized refresh of seed folders if the seed map changes in the future — not needed for v1; if the map ever evolves, write a follow-up migration.
