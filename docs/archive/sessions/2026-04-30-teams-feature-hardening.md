# Teams Feature Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a follow-up to PR #93 that fixes 24 verified findings from the independent code review of the Teams feature, ranging from a cross-department RBAC hole to silent archive-injection bugs to type-safety regressions.

**Architecture:** The findings cluster into eight themes — (1) DB-schema invariants the service code expects but the schema doesn't enforce; (2) RBAC scope is too coarse; (3) archive doesn't cascade; (4) several DB-error-to-HTTP-status conversions are missing; (5) the UI's "build from scratch" flow is non-atomic; (6) activity-log calls aren't safe-wrapped on one path; (7) type hygiene regressions (`tx: any`, naked rethrow); (8) misc polish (ASCII discipline, ReDoS hardening, UUID display, schema nullability, self-mention dedup). Tasks are ordered so dependent fixes follow their prerequisites — schema migration first, then services that depend on the new index, then routes, then UI.

**Tech Stack:** TypeScript + Express 5 + Drizzle ORM + Postgres, Vitest for tests with Proxy-based table stubs (no live DB), React + Vite for UI. Branch: `feat/teams` (the PR #93 feature branch). Existing test conventions in `server/src/__tests__/teams-service.test.ts` (mock `@armyofagents/db` + `drizzle-orm`, use `createAgentDb({ selects: [...] })` for sequenced selects, throw `{code: "23505"}` errors from custom proxy DBs to test conflict mapping).

---

## Verified-finding → Task map

| Finding | Status                              | Task |
|---------|-------------------------------------|------|
| P1-A    | RBAC dept-scope hole                | 4    |
| P1-B    | updateMemberRole 23505 uncaught     | 5    |
| P1-C    | team-import slug race uncaught      | 5    |
| P1-D    | Archived team coords still injected | 3    |
| P1-E    | Missing partial unique index        | 1, 2 |
| P1-F    | Re-upsert after archive 23505       | 1, 2 |
| P1-G    | UI orphan agents on partial fail    | 6    |
| P1-H    | logActivity not safe-wrapped        | 7    |
| P2-A    | `tx: any` regression                | 8    |
| P2-C    | Manifest regex ReDoS surface        | 9    |
| P2-D    | `coordSvc.archive` dead code        | 2 (wired up) |
| P2-E    | Slug-retry naked rethrow            | 8    |
| P2-G    | Test fixtures non-ASCII (broader)   | 10   |
| P2-H    | team-export null-vs-undefined       | 8    |
| P2-M    | status text columns lack CHECK      | 1    |
| P3-A    | Redundant "founder" in assertRole   | 4    |
| P3-B    | TeamsSection UUID display           | 12   |
| P3-D    | Import "replace" silent dept-grant (UPGRADED to P2) | 11 |
| P3-E    | updateTeamSchema description not nullable | 12 |
| P3-F    | Test coverage gaps                  | covered by per-task tests |
| P3-G    | Self-mention via authorAgentId      | 12   |

**Deferred** (downgraded by verifier or low-impact polish — explicitly skipped from this plan):
- P2-B (`tx as unknown as Db` cast — type hygiene only, runtime works)
- P2-F / P2-I (slug probe O(n) — perf only, sub-ms even at 10k teams)
- P2-J (heartbeat cap warn off-by-one — log-message hygiene)
- P2-K (`addMember` companyId join — defense-in-depth only)
- P2-L (sequential agent inserts in import — perf only, small N)
- P3-C (coordination-parser whitespace normalization — round-trip-safe for markdown)

**Comprehensive-review followups deferred (no code change in this PR):**

- **I2** ReDoS heuristic in `packages/shared/src/teams.ts` has known
  bypasses (`(a+){10,}` braced quantifier, `(a|aa)+` alternation
  overlap, `((a+))+` double-wrapped). Today the regex is never
  evaluated at runtime — only embedded as markdown text — so the
  bypasses are inert. The heuristic comment was softened to flag the
  bypasses explicitly. The first feature that wires `rule.match` into
  a runtime evaluator MUST replace the heuristic with re2-wasm or a
  proper static-analysis pass.

- **I3** The atomic team-create-with-newAgents path
  (`teamsService.create`) and team-import path (`teamImportService.install`)
  both bypass the `requireBoardApprovalForNewAgents` gate — they
  insert agents with `status: "idle"` directly. This is a deliberate
  divergence from `routes/agents.ts:784`, documented in the Task 6
  fixup commit `e6fa364` and matching the team-import precedent.
  Bounded blast radius (team_lead's own dept; agent gets
  `canCreateAgents: false`). Decision is consistent with the v1
  fast-team-build flow; revisit when multi-tenant Hosted lands and
  the approval-gate semantics get tightened.

- **I4** Read routes (`GET /teams/:id`, `GET /teams/:id/export`,
  `GET /teams/:id/coordination`, `GET /teams/:id/members`) only check
  `assertCompanyAccess`, not `assertDepartmentAccess`. A `team_member`
  in dept A can read coordination markdown of dept B's teams within
  the same company. The plan deliberately scoped Task 4 to write
  routes only. For single-tenant deployments this is nil-impact; for
  multi-employee Cloud Hosted this is real disclosure. Revisit when
  Hosted lands per V3 Decision #80.

**Comprehensive-review false positives (do NOT re-flag):**

- **L1** Performance reviewer claimed `updateMemberRole` demote loop
  should `break` after the first lead. Verified false: the loop at
  `services/teams.ts:492-499` correctly iterates ALL existing leads
  and demotes each (skipping the target). The original claim
  ("only the first one gets demoted") was a misread. Loop is correct
  as-is.

---

## File-structure preamble — what gets created or modified

### Schema (creates one migration)
- `packages/db/src/schema/team_coordinations.ts` — add partial unique index `(team_id) WHERE status='published'`; add CHECK constraint on `status`.
- `packages/db/src/schema/teams.ts` — add CHECK constraint on `status`.
- `packages/db/migrations/<NNNN>_<name>.sql` — generated by `pnpm db:generate`.

### Server services
- `server/src/services/teams.ts` — drop `tx: any`; wrap final slug-retry rethrow in `conflict()`; wrap `updateMemberRole` lead promote in 23505 catch; cascade to coordination archive in `teamsService.archive`; extend `create()` to accept inline new-agent specs atomically.
- `server/src/services/team-coordination.ts` — drop `tx: any`; add 23505 catch in `upsert` → `conflict()`; revive archived coordination row instead of insert when found.
- `server/src/services/team-import.ts` — drop `tx: any`; reuse the slug-retry helper; add 23505 catch on team insert; surface "replace" dept-grant via return-value warning.
- `server/src/services/team-export.ts` — coerce `description: team.description ?? stored.description ?? undefined` to drop the lingering `null` case.
- `server/src/services/heartbeat.ts` — JOIN `teams` and filter `teams.status != 'archived'` in `buildTeamCoordinationSkillEntries`.
- `server/src/services/team-manifest.ts` — add complexity cap to regex validation (length + nested-quantifier detector).
- `server/src/utils/safe-log-activity.ts` (new) — extract from `routes/teams.ts:32-52`.
- `server/src/services/teams.ts` — share an exported `_slugRetryHelper` that team-import imports.

### Server routes
- `server/src/routes/teams.ts` — drop redundant "founder" arg in 10 `assertRole` calls; add `assertDepartmentAccess(db, req, team.companyId, team.parentProjectId)` to all 10 write routes; import `safeLogActivity` from new util module.
- `server/src/routes/team-imports.ts` — drop redundant "founder"; add dept-access check; replace `logActivity` with `safeLogActivity`; surface "replace" warning in response body.
- `server/src/routes/issues.ts` — extend self-mention exclusion at lines 683 and 1060 to also check `comment.authorAgentId === mentionedId`.

### Server validators
- `packages/shared/src/teams.ts` — relax `updateTeamSchema.description` to `.nullable().optional()`; cap regex `match` length and reject pathological quantifier patterns.
- `packages/shared/src/teams.ts` — extend `createTeamSchema` to accept optional `newAgents: Array<{name, adapterType, role, ...}>`.

### UI
- `ui/src/components/team/BuildFromScratchForm.tsx` — replace per-agent loop with single atomic POST that includes `newAgents`.
- `ui/src/components/team/TeamsSection.tsx:76` — resolve agent name from agentsQuery instead of displaying UUID.

### Tests (added)
- `server/src/__tests__/teams-service.test.ts` — concurrent lead-promote 23505 → 409, atomic create-with-new-agents rollback.
- `server/src/__tests__/team-coordination-service.test.ts` — concurrent dup-publish 23505 → 409, re-upsert-after-archive revives the archived row.
- `server/src/__tests__/team-import-service.test.ts` — slug race 23505 → 409, "replace" returns warning when grant happens.
- `server/src/__tests__/heartbeat-team-coordination.test.ts` — archived team's coordination is NOT injected.
- `server/src/__tests__/team-manifest.test.ts` — pathological regex pattern is rejected.
- `server/src/__tests__/teams-routes-rbac.test.ts` (new) — team_lead in dept A is rejected on dept-B team operations.

### Test fixtures (sweep)
- `server/src/__tests__/team-coordination-service.test.ts`, `team-import-service.test.ts`, `team-system-admin.test.ts`, `team-direct-add.test.ts`, `team-export-service.test.ts`, `team-service.test.ts`, `team-manifest.test.ts`, `team-imports-routes-contract.test.ts`, `heartbeat-team-coordination.test.ts` — replace `→` with `->`, `—` with `--`, smart quotes with ASCII equivalents.

---

## Conventions for every task

- All commits must use this trailer (no `--no-verify`, no `--amend`):
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- Branch is `feat/teams` — check current branch with `git rev-parse --abbrev-ref HEAD` before starting.
- Run `pnpm -C server test -- <file>` for server tests, `pnpm -C ui test -- <file>` for UI tests.
- Migrations: edit the schema file → run `pnpm db:generate` from the repo root → check the generated SQL file in `packages/db/src/migrations/` is sane → commit schema + migration together.
- Mock pattern reference: `server/src/__tests__/teams-service.test.ts:1-66` — copy the `vi.mock("drizzle-orm", ...)` and `vi.mock("@armyofagents/db", ...)` blocks, append new table fields as needed.
- Error-handling convention: throw via `badRequest()`, `conflict()`, `notFound()` from `../errors.js` so the global error handler emits the right HTTP status. Plain `Error` becomes 500.

---

### Task 1: Schema migration — partial unique index + CHECK constraints

**Findings addressed:** P1-E (partial unique on `(team_id) WHERE status='published'`), P2-M (CHECK constraints on `teams.status` and `team_coordinations.status`).

**Why first:** Tasks 2, 3, 5 depend on the new index existing so that 23505 catches have a real DB invariant to translate into 409s. Tasks 2 + 5 also use the CHECK columns — no point catching `"Published"` typos at the service layer if the column accepts them.

**Files:**
- Modify: `packages/db/src/schema/team_coordinations.ts:28-32`
- Modify: `packages/db/src/schema/teams.ts:18`
- Generate: `packages/db/migrations/<NNNN>_team_coord_partial_unique_and_status_checks.sql` (filename auto-generated by drizzle-kit)

- [ ] **Step 1.1: Read both schemas to confirm current state**

```bash
cat "packages/db/src/schema/team_coordinations.ts"
cat "packages/db/src/schema/teams.ts"
```

Expected: `team_coordinations.ts` has 3 indexes (companyKeyUq full, teamIdx non-unique, teamStatusIdx non-unique), `teams.ts` has `status` as plain text with no CHECK.

- [ ] **Step 1.2: Add partial unique index + status CHECK to team_coordinations.ts**

In `packages/db/src/schema/team_coordinations.ts`, replace the table-builder body (lines 6-33) with:

```ts
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { teams } from "./teams.js";
import type { FileInventoryEntry } from "@armyofagents/shared";

export const teamCoordinations = pgTable(
  "team_coordinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
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
    fileInventory: jsonb("file_inventory").$type<FileInventoryEntry[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("published"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("team_coordinations_company_key_uq").on(table.companyId, table.key),
    teamIdx: index("team_coordinations_team_idx").on(table.teamId),
    teamStatusIdx: index("team_coordinations_team_status_idx").on(table.teamId, table.status),
    // Partial unique index — at most one published coordination per team. Service-layer
    // upsert (team-coordination.ts:upsert) is TOCTOU-vulnerable without this; two concurrent
    // upserts could both see "no published row" and both insert. This index makes the second
    // insert fail with 23505. The 23505 is converted to a 409 Conflict at the service layer.
    onePublishedPerTeamUq: uniqueIndex("team_coordinations_one_published_uq")
      .on(table.teamId)
      .where(sql`status = 'published'`),
    statusValid: check(
      "team_coordinations_status_check",
      sql`status IN ('draft', 'published', 'archived')`,
    ),
  }),
);
```

- [ ] **Step 1.3: Add status CHECK to teams.ts**

In `packages/db/src/schema/teams.ts`, locate the `status` column (around line 18, currently `status: text("status").notNull().default("active"),`) and the table-builder closing block. Add `check` to the imports and add a CHECK to the indexes object:

```ts
// At top of file, change the import line:
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
// Ensure: import { sql } from "drizzle-orm"; (add if missing)
```

In the table-builder's `(table) => ({ ... })` block, append:

```ts
statusValid: check(
  "teams_status_check",
  sql`status IN ('active', 'archived')`,
),
```

- [ ] **Step 1.4: Generate the migration**

Run from repo root:

```bash
pnpm db:generate
```

Expected: a new file appears in `packages/db/src/migrations/` with a name like `<NNNN>_<random>.sql`. Open it and verify it contains:

```sql
CREATE UNIQUE INDEX "team_coordinations_one_published_uq" ON "team_coordinations" USING btree ("team_id") WHERE status = 'published';
ALTER TABLE "team_coordinations" ADD CONSTRAINT "team_coordinations_status_check" CHECK (status IN ('draft', 'published', 'archived'));
ALTER TABLE "teams" ADD CONSTRAINT "teams_status_check" CHECK (status IN ('active', 'archived'));
```

If the generated SQL is missing any of these three statements, edit the migration file to add the missing statements (drizzle-kit sometimes misses CHECK constraints on text columns).

- [ ] **Step 1.5: Run the test suite to confirm nothing else broke**

```bash
pnpm -C server test -- teams-service team-coordination-service heartbeat-team-coordination
```

Expected: all existing tests pass (38 in teams-service, plus the others). Tests use mocked Drizzle so the schema change shouldn't affect them.

- [ ] **Step 1.6: Commit**

```bash
git add packages/db/src/schema/team_coordinations.ts packages/db/src/schema/teams.ts packages/db/migrations/
git commit -m "$(cat <<'EOF'
fix(teams): add partial unique index for published coords + status CHECK constraints

The team_coordinations.upsert service comment promised a partial unique
index `(team_id) WHERE status='published'` as the proper TOCTOU defense
against concurrent dup-publish, but the schema never had it. This commit
adds:

1. team_coordinations_one_published_uq — partial unique on
   (team_id) WHERE status='published'. Backstops the service's upsert
   transaction; 23505 → 409 conversion lands in Task 2.
2. teams_status_check — CHECK status IN ('active','archived').
3. team_coordinations_status_check — CHECK status IN ('draft',
   'published','archived').

Existing data: the partial unique index is permissive — it only fires
on duplicate published rows, which the service layer should already
prevent. The CHECK constraints match the only values written by the
codebase. No data backfill needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Coordination upsert hardening (23505 → 409 + revive archived)

**Findings addressed:** P1-E (catch the new 23505), P1-F (re-upsert after archive should revive the archived row, not insert a duplicate-key row), P2-D (`coordSvc.archive` is dead code — wire it up via Task 3 cascade).

**Files:**
- Modify: `server/src/services/team-coordination.ts:19-83`
- Modify: `server/src/__tests__/team-coordination-service.test.ts` (add two tests)

- [ ] **Step 2.1: Write failing test — concurrent dup-publish maps to 409**

Append to `server/src/__tests__/team-coordination-service.test.ts` (inside the existing `describe("teamCoordinationService")` block):

```ts
it("converts PG 23505 unique-violation on concurrent publish to 409", async () => {
  // Simulate: SELECT inside tx returns no published row; INSERT throws 23505
  // (the partial unique index team_coordinations_one_published_uq fired
  // because a concurrent transaction won the race).
  const db: any = {
    transaction: async (cb: any) => {
      const tx: any = {
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
        insert: () => ({
          values: () => ({
            returning: () => {
              const err = Object.assign(new Error("dup"), { code: "23505" });
              throw err;
            },
          }),
        }),
      };
      return cb(tx);
    },
  };

  await expect(
    teamCoordinationService(db).upsert("co-1", {
      teamId: "t1",
      name: "QA",
      markdown: "## body",
    }),
  ).rejects.toMatchObject({ status: 409 });
});
```

- [ ] **Step 2.2: Write failing test — re-upsert after archive revives the archived row**

Append to the same describe block:

```ts
it("revives an archived coordination row instead of inserting a duplicate", async () => {
  // Simulate: SELECT for published returns []; SELECT for archived returns
  // an archived row; service should UPDATE that row back to status='published'
  // rather than INSERT (which would 23505 on team_coordinations_company_key_uq
  // because the key column is constant per team).
  const archivedRow = {
    id: "coord-archived",
    teamId: "t1",
    key: "team-t1:coordination",
    status: "archived",
  };
  let updateCallCount = 0;
  let insertCalled = false;

  const db: any = {
    transaction: async (cb: any) => {
      let selectCalls = 0;
      const tx: any = {
        select: () => ({
          from: () => ({
            where: () => {
              const idx = selectCalls++;
              if (idx === 0) return Promise.resolve([]); // no published
              if (idx === 1) return Promise.resolve([archivedRow]); // archived found
              return Promise.resolve([]);
            },
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: () => {
                updateCallCount++;
                return Promise.resolve([{ ...archivedRow, status: "published", name: "QA" }]);
              },
            }),
          }),
        }),
        insert: () => {
          insertCalled = true;
          throw new Error("insert should not be called when archived row exists");
        },
      };
      return cb(tx);
    },
  };

  const result = await teamCoordinationService(db).upsert("co-1", {
    teamId: "t1",
    name: "QA",
    markdown: "## body",
  });

  expect(insertCalled).toBe(false);
  expect(updateCallCount).toBe(1);
  expect(result).toMatchObject({ id: "coord-archived", status: "published" });
});
```

- [ ] **Step 2.3: Run tests to verify they fail**

```bash
pnpm -C server test -- team-coordination-service
```

Expected: both new tests FAIL — the first because no 23505 catch exists, the second because the current `upsert` only checks for published rows then unconditionally inserts.

- [ ] **Step 2.4: Implement upsert hardening**

Replace `server/src/services/team-coordination.ts` lines 19-73 (the `upsert` method body) with:

```ts
upsert: async (companyId: string, input: CreateTeamCoordinationInput) => {
  // P1-E + P1-F hardening:
  //   - The partial unique index `team_coordinations_one_published_uq`
  //     guarantees at most one published row per team; we map its 23505
  //     to a clean 409 Conflict.
  //   - The `key` column is constant per team (`team-${teamId}:coordination`)
  //     and the FULL unique index `team_coordinations_company_key_uq` covers
  //     it. So when no PUBLISHED row exists but an ARCHIVED row does,
  //     we MUST update the archived row back to published instead of
  //     inserting a fresh row (which would 23505 on the company-key index).
  return db.transaction(async (tx) => {
    const existingPublished = await tx
      .select()
      .from(teamCoordinations)
      .where(and(
        eq(teamCoordinations.teamId, input.teamId),
        eq(teamCoordinations.status, "published"),
      ));

    if (existingPublished.length > 0) {
      const updated = await tx
        .update(teamCoordinations)
        .set({
          name: input.name,
          description: input.description,
          markdown: input.markdown,
          updatedAt: new Date(),
        })
        .where(eq(teamCoordinations.id, existingPublished[0].id))
        .returning();
      return updated[0];
    }

    // No published row — check for an archived row to revive.
    const existingArchived = await tx
      .select()
      .from(teamCoordinations)
      .where(and(
        eq(teamCoordinations.teamId, input.teamId),
        eq(teamCoordinations.status, "archived"),
      ));

    if (existingArchived.length > 0) {
      const revived = await tx
        .update(teamCoordinations)
        .set({
          status: "published",
          name: input.name,
          description: input.description,
          markdown: input.markdown,
          updatedAt: new Date(),
        })
        .where(eq(teamCoordinations.id, existingArchived[0].id))
        .returning();
      return revived[0];
    }

    // Truly new — insert. Wrapped in try/catch so a concurrent insert losing
    // the partial unique race surfaces as 409 not 500.
    const slug = generateTeamSlug(input.name);
    try {
      const inserted = await tx
        .insert(teamCoordinations)
        .values({
          companyId,
          teamId: input.teamId,
          key: `team-${input.teamId}:coordination`,
          slug,
          name: input.name,
          description: input.description,
          markdown: input.markdown,
        })
        .returning();
      return inserted[0];
    } catch (err) {
      const code =
        (err as { code?: string }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") {
        throw conflict(
          `coordination for team ${input.teamId} was just published by a concurrent request — retry to merge`,
        );
      }
      throw err;
    }
  });
},
```

Also update the import line at top of file:

```ts
import { notFound, conflict } from "../errors.js";
```

(Currently only `notFound` is imported.)

Note: drop the old `: any` annotation on the transaction callback — the body now has clean types from Drizzle's inferred Tx. If the type infers correctly, leave it as `(tx) =>`. If there's a residual type error, narrow it minimally; do NOT regress to `: any`.

- [ ] **Step 2.5: Run tests to verify they pass**

```bash
pnpm -C server test -- team-coordination-service
```

Expected: all tests pass, including the two new ones.

- [ ] **Step 2.6: Commit**

```bash
git add server/src/services/team-coordination.ts server/src/__tests__/team-coordination-service.test.ts
git commit -m "$(cat <<'EOF'
fix(teams): coord upsert handles 23505 + revives archived rows

P1-E: a concurrent upsert that loses the race to the new
team_coordinations_one_published_uq partial unique index now
surfaces as 409 Conflict instead of 500.

P1-F: when no PUBLISHED row exists but an ARCHIVED row does, revive
the archived row by flipping status back to 'published' rather than
inserting a fresh row. The fresh-row path was 23505-prone because the
`key` column is constant per team and the full
team_coordinations_company_key_uq unique index would reject it.

Together, these two fixes mean coordSvc.archive() is now safe to wire
up from teamsService.archive() in Task 3 — round-tripping
publish→archive→publish no longer dead-ends in a 500.

Tests: two new vitest cases — concurrent dup-publish maps to 409,
re-upsert after archive revives instead of inserting.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Archive cascade + heartbeat injection guard

**Findings addressed:** P1-D (archived team's coordination still gets injected into agents).

**Two-layer fix:** (a) cascade — `teamsService.archive` flips the team's coordination to `archived` so the existing `eq(status, 'published')` filter naturally excludes it; (b) defense-in-depth — the heartbeat injection query JOINs `teams` and filters `teams.status != 'archived'` so even if a coordination row gets stuck in `published` after a team archive (data corruption from an earlier era, manual SQL, or a future bug), agents in archived teams don't receive coords.

**Files:**
- Modify: `server/src/services/teams.ts:199-211` (the `archive` method)
- Modify: `server/src/services/heartbeat.ts:611-642` (the `buildTeamCoordinationSkillEntries` function)
- Modify: `server/src/__tests__/heartbeat-team-coordination.test.ts` (add test)
- Modify: `server/src/__tests__/teams-service.test.ts` (add test)

- [ ] **Step 3.1: Write failing test — heartbeat does NOT inject for archived team**

Append to `server/src/__tests__/heartbeat-team-coordination.test.ts` (inside the existing describe):

```ts
it("does not inject coordinations from archived teams", async () => {
  // Agent is a member of one team. The team is ARCHIVED (teams.status='archived')
  // but the coordination row is still PUBLISHED. The injection should skip it.
  const db: any = {
    select: vi.fn(() => ({
      from: vi.fn((tableId: any) => ({
        where: vi.fn(() => {
          if (tableId === "companies_table") return Promise.resolve([{ enableTeams: true }]);
          if (tableId === "team_members_table") {
            return {
              limit: vi.fn(() => Promise.resolve([{ teamId: "t1" }])),
            };
          }
          // The injection's coords SELECT now JOINs teams; whatever the mock
          // returns at this stage simulates the JOIN's result. Empty = no
          // injection because the team is archived.
          return Promise.resolve([]);
        }),
      })),
    })),
  };
  // The actual mock shape depends on Drizzle's table reference identity.
  // If this proves brittle, fall back to a more direct mock that asserts the
  // generated SQL includes `teams.status != 'archived'`.

  const entries = await buildTeamCoordinationSkillEntries(db, "co-1", "agent-1");
  expect(entries).toHaveLength(0);
});
```

If the table-identity check is hard to express with the existing mock pattern, simplify by asserting the call-graph: the third `db.select` call (after companies + memberships) should include a JOIN-shaped where-clause. Use `vi.fn().mock.calls` to inspect.

- [ ] **Step 3.2: Write failing test — teamsService.archive cascades to coordination**

Append to `server/src/__tests__/teams-service.test.ts` inside the existing `describe("teamsService")`:

```ts
it("archive cascades to coordination archive", async () => {
  let coordUpdateCalled = false;
  const db: any = {
    transaction: async (cb: any) => {
      const tx: any = {
        update: vi.fn((table: any) => ({
          set: vi.fn((vals: any) => ({
            where: vi.fn(() => ({
              returning: vi.fn(() => {
                if (table === "teams_table" || table?.id === "teams_id") {
                  return Promise.resolve([{ id: "t1", status: "archived" }]);
                }
                if (table === "team_coordinations_table" || table?.id === "team_coordinations_id") {
                  coordUpdateCalled = true;
                  return Promise.resolve([{ id: "c1", status: "archived" }]);
                }
                return Promise.resolve([]);
              }),
            })),
          })),
        })),
      };
      return cb(tx);
    },
  };

  await teamsService(db).archive("t1");

  expect(coordUpdateCalled).toBe(true);
});
```

Note: the mock-table identity check (`table?.id === "teams_id"`) relies on the `vi.mock("@armyofagents/db", ...)` block at the top of the file already registering `teamCoordinations` as `{ id: "team_coordinations_id", ... }`. If `teamCoordinations` is NOT yet in that mock block, ADD it as part of this step using the same shape as `teams`/`teamMembers`.

- [ ] **Step 3.3: Run tests to verify they fail**

```bash
pnpm -C server test -- heartbeat-team-coordination teams-service
```

Expected: both new tests FAIL.

- [ ] **Step 3.4: Implement teamsService.archive cascade**

Replace `server/src/services/teams.ts:199-211` (the `archive` method body) with:

```ts
archive: async (id: string) => {
  // P1-D: archive cascades to the team's coordination. Without this,
  // buildTeamCoordinationSkillEntries continues to inject the team's
  // markdown into every member agent's heartbeat run because the
  // coordination row stays status='published'.
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(teams)
      .set({
        status: "archived",
        archivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(teams.id, id))
      .returning();
    if (updated.length === 0) throw notFound(`team ${id} not found`);

    // Cascade — best effort. If no coord row exists, the UPDATE affects 0 rows
    // and we don't care. If one exists, flipping it to archived stops injection.
    await tx
      .update(teamCoordinations)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(
        eq(teamCoordinations.teamId, id),
        eq(teamCoordinations.status, "published"),
      ));

    return updated[0];
  });
},
```

Add `teamCoordinations` to the import at the top of the file:

```ts
import { teams, teamMembers, agentProjects, projects, teamCoordinations } from "@armyofagents/db";
```

- [ ] **Step 3.5: Implement heartbeat injection guard**

Replace `server/src/services/heartbeat.ts:630-642` (the `coords` SELECT) with:

```ts
const coords = await db
  .select({
    teamId: teamCoordinations.teamId,
    markdown: teamCoordinations.markdown,
    trustLevel: teamCoordinations.trustLevel,
  })
  .from(teamCoordinations)
  .innerJoin(teams, eq(teamCoordinations.teamId, teams.id))
  .where(
    and(
      inArray(teamCoordinations.teamId, teamIds),
      eq(teamCoordinations.status, "published"),
      // P1-D defense-in-depth: even if a coordination row escapes the
      // archive cascade in teamsService.archive, the team-level archive
      // status hides it from injection.
      ne(teams.status, "archived"),
    ),
  );
```

Update the imports near the top of `heartbeat.ts` to add `ne` if missing:

```ts
import { eq, and, inArray, ne } from "drizzle-orm";
```

(Confirm the existing import line shape; only add `ne` if it isn't already there.)

- [ ] **Step 3.6: Run tests to verify they pass**

```bash
pnpm -C server test -- heartbeat-team-coordination teams-service
```

Expected: all tests pass.

- [ ] **Step 3.7: Commit**

```bash
git add server/src/services/teams.ts server/src/services/heartbeat.ts server/src/__tests__/heartbeat-team-coordination.test.ts server/src/__tests__/teams-service.test.ts
git commit -m "$(cat <<'EOF'
fix(teams): archive cascades to coordination + heartbeat skips archived

P1-D: archiving a team only flipped teams.status; the coordination row
stayed status='published' and continued to be injected into every
member agent's heartbeat run. Two-layer fix:

1. Cascade — teamsService.archive now wraps the team UPDATE and a
   teamCoordinations UPDATE in one transaction. Archiving stops
   injection at the source.
2. Defense-in-depth — buildTeamCoordinationSkillEntries JOINs teams
   and filters teams.status != 'archived'. So even if a coordination
   row escapes the cascade (data drift, manual SQL, future bug), the
   archived team's coords still don't reach agent context.

Members survive archive (intentional — re-publishing the team should
keep its membership). teamCoordinations.archive can now be safely
called from production code (Task 2's revive-archived path completes
the round trip).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: RBAC dept-scope + drop redundant "founder" arg

**Findings addressed:** P1-A (team_lead in dept A can manage teams in dept B), P3-A (passing "founder" in `assertRole` is a no-op since founder short-circuits at line 48).

**Files:**
- Modify: `server/src/routes/teams.ts` — 10 sites at lines 97, 163, 196, 231, 255, 289, 313, 339, 374, 405
- Modify: `server/src/routes/team-imports.ts` — 2 sites at lines 79, 113
- Create: `server/src/__tests__/teams-routes-rbac.test.ts` — new file, route-level RBAC tests

- [ ] **Step 4.1: Write failing test — team_lead in dept A is rejected on dept-B team**

Create `server/src/__tests__/teams-routes-rbac.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// This is a service-level test that proves dept-scope is enforced. The route
// layer composes assertCompanyAccess + assertRole + assertDepartmentAccess.
// We test assertDepartmentAccess directly here — its existing unit tests
// already cover the lookup, but no test covers it being CALLED from a Teams
// route. We assert call-shape via a route-handler harness.

vi.mock("../middleware/rbac.js", async (orig) => {
  const actual = (await orig()) as any;
  return {
    ...actual,
    assertDepartmentAccess: vi.fn(async () => undefined), // pass by default
  };
});

import { assertDepartmentAccess } from "../middleware/rbac.js";

describe("Teams routes RBAC", () => {
  beforeEach(() => {
    (assertDepartmentAccess as any).mockClear();
  });

  it("PATCH /teams/:id calls assertDepartmentAccess with the team's parentProjectId", async () => {
    // Build a minimal Express app + the teams router with mocked services.
    // The router should call assertDepartmentAccess(db, req, team.companyId, team.parentProjectId)
    // before performing the update.
    const { teamsRouter } = await import("../routes/teams.js");
    const express = (await import("express")).default;
    const app = express();
    app.use(express.json());
    // Inject a fake actor middleware (mimics local_trusted board actor):
    app.use((req: any, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", actorId: "local-board" };
      next();
    });
    // Mock the teams service so getById returns a team in 'dept-a'.
    const fakeTeamSvc = {
      getById: vi.fn(async () => ({
        id: "t1",
        companyId: "co-1",
        parentProjectId: "dept-a",
        name: "old",
      })),
      update: vi.fn(async () => ({ id: "t1", name: "new" })),
    };
    app.use("/api", teamsRouter({ db: {} as any, teamsService: () => fakeTeamSvc as any } as any));

    const supertest = (await import("supertest")).default;
    await supertest(app).patch("/api/teams/t1").send({ name: "new" }).expect(200);

    expect(assertDepartmentAccess).toHaveBeenCalledWith(
      expect.anything(), // db
      expect.objectContaining({ actor: expect.any(Object) }), // req
      "co-1",
      "dept-a",
    );
  });
});
```

NOTE: this test depends on the teamsRouter module exporting a factory that accepts injectable services. If the current `teamsRouter` is a closure over the module-level imports, refactor minimally so the test can inject. If that's too invasive, fall back to a service-layer test that asserts the helper is called with the expected args via a simpler harness (extract the route-side check into a `requireDeptAccessForTeam(db, req, team)` helper and unit-test it).

- [ ] **Step 4.2: Run test to verify it fails**

```bash
pnpm -C server test -- teams-routes-rbac
```

Expected: FAIL with "expected mock.calls to have length 1, got 0" — `assertDepartmentAccess` is not yet called.

- [ ] **Step 4.3: Add `assertDepartmentAccess` import to routes**

In `server/src/routes/teams.ts`, locate the existing import of rbac helpers (search for `assertRole`):

```ts
import { assertCompanyAccess, assertRole, assertBoard } from "../middleware/rbac.js";
```

Add `assertDepartmentAccess`:

```ts
import { assertCompanyAccess, assertRole, assertDepartmentAccess, assertBoard } from "../middleware/rbac.js";
```

Repeat in `server/src/routes/team-imports.ts`.

- [ ] **Step 4.4: Update each write route in routes/teams.ts**

For each of the 10 cited sites — list with current line numbers (will shift as you edit, work bottom-up to keep line numbers stable):

1. `:405` POST `/teams/:id/coordination/regenerate`
2. `:374` PUT `/teams/:id/coordination`
3. `:339` PATCH `/teams/:id/members/:agentId`
4. `:313` DELETE `/teams/:id/members/:agentId`
5. `:289` POST `/teams/:id/members`
6. `:255` DELETE `/teams/:id` (dismantle)
7. `:231` DELETE `/teams/:id` (archive — confirm by reading the route handler shape)
8. `:196` PUT `/teams/:id/manifest`
9. `:163` PATCH `/teams/:id`
10. `:97`  POST `/companies/:companyId/teams`

For each route, find the line that says:

```ts
await assertRole(db, req, team.companyId, "founder", "team_lead");
```

(or `companyId` if there's no `team` variable yet at that point — for POST `/companies/:companyId/teams` the team doesn't exist yet, so dept-access uses `req.body.parentProjectId` instead).

Replace with:

```ts
await assertRole(db, req, team.companyId, "team_lead");
await assertDepartmentAccess(db, req, team.companyId, team.parentProjectId);
```

For the POST route at `:97` specifically (where the team doesn't exist yet), use `req.body.parentProjectId`:

```ts
await assertRole(db, req, companyId, "team_lead");
await assertDepartmentAccess(db, req, companyId, req.body.parentProjectId);
```

Notes:
- "founder" is dropped because `assertRole` short-circuits founder before checking the variadic — passing it is a no-op (P3-A).
- `assertDepartmentAccess` itself short-circuits on founder/local_trusted/instance_admin (rbac.ts:65-69) so we're not double-gating.
- Order matters: `assertRole` first (cheap, in-memory check), `assertDepartmentAccess` second (one DB roundtrip via permissionService).

- [ ] **Step 4.5: Update both write routes in routes/team-imports.ts**

In `server/src/routes/team-imports.ts`, locate the two `assertRole` calls at lines 79 and 113. Apply the same transform:

For line 79 (POST preview — payload contains the parsed manifest, including `parentProjectId`):

```ts
await assertRole(db, req, companyId, "team_lead");
await assertDepartmentAccess(db, req, companyId, req.body.parentProjectId);
```

For line 113 (POST install):

```ts
await assertRole(db, req, companyId, "team_lead");
await assertDepartmentAccess(db, req, companyId, req.body.parentProjectId);
```

If either route doesn't have `req.body.parentProjectId` directly available (e.g., the manifest is nested at `req.body.manifest.parentProjectId`), use the correct path. Cross-check by reading the route handler shape.

- [ ] **Step 4.6: Run the new test + the existing teams-service tests**

```bash
pnpm -C server test -- teams-routes-rbac teams-service team-coordination-service heartbeat-team-coordination
```

Expected: new test passes, existing tests still pass.

- [ ] **Step 4.7: Commit**

```bash
git add server/src/routes/teams.ts server/src/routes/team-imports.ts server/src/__tests__/teams-routes-rbac.test.ts
git commit -m "$(cat <<'EOF'
fix(teams): enforce dept-scope on team write routes

P1-A: assertRole only enforces company-level role. A team_lead with
role for dept A could PATCH/DELETE/dismantle/edit-manifest/edit-members
for any team in dept B of the same company.

Fix: every write route in routes/teams.ts (10 sites) and
routes/team-imports.ts (2 sites) now also calls
assertDepartmentAccess(db, req, companyId, parentProjectId). The helper
already exists in rbac.ts (lines 59-80); it short-circuits on founder /
local_trusted / instance_admin, so the addition is purely a tightening
for genuine team_leads.

P3-A drive-by: drop the redundant "founder" variadic arg from all 12
assertRole calls. Founder short-circuits at rbac.ts:48 before the
variadic check ever runs.

Test: new server/src/__tests__/teams-routes-rbac.test.ts asserts the
helper is called with the team's parentProjectId on PATCH /teams/:id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 23505 catches in lead promotion + import slug race

**Findings addressed:** P1-B (`updateMemberRole(role: "lead")` lacks 23505 catch — uncaught violation of `team_members_one_lead_uq`), P1-C (`team-import.install` lacks slug-race retry, uncaught 23505 from `teams_company_slug_uq`).

**Files:**
- Modify: `server/src/services/teams.ts:347-386` (`updateMemberRole`)
- Modify: `server/src/services/teams.ts:112-173` (extract `tryInsertTeamWithUniqueSlug` helper, export it)
- Modify: `server/src/services/team-import.ts:330-343` (use the helper)
- Modify: `server/src/__tests__/teams-service.test.ts` (concurrent lead promote test)
- Modify: `server/src/__tests__/team-import-service.test.ts` (slug race test)

- [ ] **Step 5.1: Write failing test — concurrent lead promote maps to 409**

Append to `server/src/__tests__/teams-service.test.ts`:

```ts
it("converts PG 23505 on concurrent lead promotion to 409", async () => {
  // updateMemberRole(role: "lead") — the partial unique index
  // team_members_one_lead_uq guarantees at most one lead per team. If two
  // concurrent transactions both demote then promote, the second one's
  // UPDATE-to-lead loses the race and throws 23505.
  const db: any = {
    transaction: async (cb: any) => {
      const tx: any = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]), // no existing leads to demote
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: () => {
                const err = Object.assign(new Error("dup lead"), { code: "23505" });
                throw err;
              },
            }),
          }),
        }),
      };
      return cb(tx);
    },
  };

  await expect(
    teamsService(db).updateMemberRole("t1", "a1", "lead"),
  ).rejects.toMatchObject({ status: 409 });
});
```

- [ ] **Step 5.2: Write failing test — team-import slug race maps to 409**

Append to `server/src/__tests__/team-import-service.test.ts`:

```ts
it("converts PG 23505 on slug race during install to 409", async () => {
  // Pre-flight slug check passes (no team with this slug yet); the
  // tx.insert(teams) loses the race to a concurrent install and throws
  // 23505 on teams_company_slug_uq. Service should map to 409.
  const db: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])), // pre-flight: no collision
      })),
    })),
    transaction: async (cb: any) => {
      const tx: any = {
        select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })),
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn(() => {
              const err = Object.assign(new Error("dup slug"), { code: "23505" });
              throw err;
            }),
          })),
        })),
      };
      return cb(tx);
    },
  };

  // The exact teamImportService shape may need a fuller stub — adjust to
  // match the existing test fixtures in the file. The key assertion is that
  // a 23505 from the team insert surfaces as { status: 409 }.
  await expect(
    teamImportService(db).install("co-1", /* manifest fixture */ {}, /* options */ {}),
  ).rejects.toMatchObject({ status: 409 });
});
```

If the `teamImportService(db).install` shape requires more setup, model it on the existing `team-import-service.test.ts` patterns (they use `createAgentDb` with rich select sequences).

- [ ] **Step 5.3: Run tests to verify they fail**

```bash
pnpm -C server test -- teams-service team-import-service
```

Expected: both new tests FAIL.

- [ ] **Step 5.4: Wrap updateMemberRole's transaction body in 23505 catch**

Replace `server/src/services/teams.ts:347-386` (the `updateMemberRole` method) with:

```ts
updateMemberRole: async (
  teamId: string,
  agentId: string,
  role: TeamRole,
) => {
  // P1-B: when promoting to lead, the partial unique index
  // team_members_one_lead_uq backstops the demote-then-promote sequence.
  // A concurrent caller racing the same promotion can win the lead slot;
  // our UPDATE then throws 23505. Convert to a clean 409 — the asymmetry
  // with addMember (which already does this) was the bug.
  return db.transaction(async (tx) => {
    if (role === "lead") {
      const existingLead = await tx
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.role, "lead"),
          ),
        );
      for (const lead of existingLead) {
        if (lead.agentId !== agentId) {
          await tx
            .update(teamMembers)
            .set({ role: "member" })
            .where(eq(teamMembers.id, lead.id));
        }
      }
    }
    try {
      const updated = await tx
        .update(teamMembers)
        .set({ role })
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.agentId, agentId),
          ),
        )
        .returning();
      if (updated.length === 0) throw notFound(`membership not found`);
      return updated[0];
    } catch (err) {
      const code =
        (err as { code?: string }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") {
        throw conflict(
          `concurrent lead change for team ${teamId} — retry`,
        );
      }
      throw err;
    }
  });
},
```

Note: also drops `: any` on the transaction callback (Task 8 covers the systematic sweep, but this particular site is being rewritten anyway — clean up here).

- [ ] **Step 5.5: Extract reusable slug-retry helper from teams.create**

In `server/src/services/teams.ts`, just above the `teamsService` factory function, add an exported helper:

```ts
/**
 * Insert a team with a base slug, retrying with `-2`, `-3`, ... suffixes on
 * 23505 collisions against `teams_company_slug_uq`. Returns the inserted
 * team row.
 *
 * Caller MUST run this inside a transaction — the `tx` parameter is the
 * Drizzle transaction handle. The helper reads existing slugs to pick a
 * suffix; under heavy contention a concurrent insert may still beat us,
 * so retries also re-probe.
 *
 * Throws `conflict()` after MAX_SLUG_RETRIES (default 5) — the slug space
 * is functionally saturated, so the founder needs to pick a different name.
 */
export async function insertTeamWithUniqueSlug<T extends Record<string, unknown>>(
  tx: any, // typed as Drizzle Tx in callers; `any` here for cross-module shape
  values: {
    companyId: string;
    parentProjectId: string;
    name: string;
    description?: string | null;
    manifest?: unknown;
    templateOrigin?: string | null;
    templateVersion?: string | null;
  } & T,
  options: { maxRetries?: number } = {},
): Promise<{ id: string; slug: string; [k: string]: unknown }> {
  const maxRetries = options.maxRetries ?? 5;
  const baseSlug = generateTeamSlug(values.name);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const existing = await tx
      .select({ slug: teams.slug })
      .from(teams)
      .where(eq(teams.companyId, values.companyId));
    const slug = ensureUniqueSlug(
      baseSlug,
      new Set(existing.map((r: { slug: string }) => r.slug)),
    );

    try {
      const inserted = await tx
        .insert(teams)
        .values({ ...values, slug })
        .returning();
      return inserted[0];
    } catch (err) {
      const code =
        (err as { code?: string }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      if (code !== "23505") throw err;
      lastError = err;
    }
  }

  throw conflict(
    `could not generate a unique slug for "${values.name}" after ${maxRetries} attempts — pick a different team name`,
  );
}
```

Then update `teamsService.create` to use this helper. Replace the for-loop body at `teams.ts:116-164` (inside the existing `db.transaction`) with a call:

```ts
// inside the transaction:
const team = await insertTeamWithUniqueSlug(tx, {
  companyId,
  parentProjectId: input.parentProjectId,
  name: input.name,
  description: input.description ?? null,
  manifest: input.manifest ?? {},
});

if (memberInputs.length > 0) {
  await tx.insert(teamMembers).values(
    memberInputs.map((m) => ({
      teamId: team.id,
      agentId: m.agentId,
      role: m.role,
    })),
  );
}

return team;
```

Wrap the whole transaction in the existing `MAX_SLUG_RETRIES` outer loop logic — actually, the helper now owns the retry. So the outer loop in `create` can be removed entirely; the transaction wraps a single attempt.

Re-read `teams.ts:112-174` and replace the entire outer for-loop + transaction block with:

```ts
return db.transaction(async (tx) => {
  const team = await insertTeamWithUniqueSlug(tx, {
    companyId,
    parentProjectId: input.parentProjectId,
    name: input.name,
    description: input.description ?? null,
    manifest: input.manifest ?? {},
  });

  if (memberInputs.length > 0) {
    await tx.insert(teamMembers).values(
      memberInputs.map((m) => ({
        teamId: team.id,
        agentId: m.agentId,
        role: m.role,
      })),
    );
  }

  return team;
});
```

This is structurally simpler than the existing nested-loop and doesn't change semantics — the helper internally retries the same 5 times.

- [ ] **Step 5.6: Use the helper in team-import.install**

In `server/src/services/team-import.ts`, locate the team insert (around line 330-343, inside the install transaction). Replace:

```ts
const inserted = await tx
  .insert(teams)
  .values({
    companyId,
    parentProjectId: input.parentProjectId,
    name: manifest.name,
    slug,
    description: manifest.description ?? null,
    manifest,
    templateOrigin: input.templateOrigin ?? null,
    templateVersion: manifest.version ?? null,
  })
  .returning();
const team = inserted[0];
```

With:

```ts
const team = await insertTeamWithUniqueSlug(tx, {
  companyId,
  parentProjectId: input.parentProjectId,
  name: manifest.name,
  description: manifest.description ?? null,
  manifest,
  templateOrigin: input.templateOrigin ?? null,
  templateVersion: manifest.version ?? null,
});
```

Add the import at the top of `team-import.ts`:

```ts
import { teamsService, insertTeamWithUniqueSlug } from "./teams.js";
```

(Adjust based on the existing import shape — if `teamsService` isn't currently imported here, just add the helper directly.)

Remove the now-redundant pre-flight slug check at `team-import.ts:211-224` if it exists — the helper handles uniqueness. If the pre-flight check serves a different purpose (e.g., user-facing "name already taken" before doing any other work), keep it but note that it's defense-in-depth, not the primary guarantee.

- [ ] **Step 5.7: Run all impacted test files**

```bash
pnpm -C server test -- teams-service team-import-service team-coordination-service heartbeat-team-coordination
```

Expected: all tests pass.

- [ ] **Step 5.8: Commit**

```bash
git add server/src/services/teams.ts server/src/services/team-import.ts server/src/__tests__/teams-service.test.ts server/src/__tests__/team-import-service.test.ts
git commit -m "$(cat <<'EOF'
fix(teams): catch 23505 in updateMemberRole + share slug-retry helper

P1-B: updateMemberRole(role: "lead") had no try/catch around the
demote-then-update sequence. The partial unique index
team_members_one_lead_uq backstops the invariant correctly, but the
resulting 23505 surfaced as a 500. Now wrapped → 409 Conflict, matching
the addMember pattern (the asymmetry was the bug).

P1-C: team-import.install relied on a pre-flight slug-existence check
to avoid racing teams.create. The check narrows the window but cannot
eliminate it — concurrent installs of the same manifest still 23505 on
teams_company_slug_uq. Both paths now share insertTeamWithUniqueSlug,
which retries up to 5 times before throwing conflict(). Behaviour for
the happy path is unchanged.

Drive-by: insertTeamWithUniqueSlug owns the retry loop, so teams.create
no longer wraps an outer for-loop around its transaction. Simpler shape;
same semantics.

Tests: two new vitest cases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Atomic team-create-with-new-agents

**Findings addressed:** P1-G (`BuildFromScratchForm` creates orphan agents on partial failure).

**Approach:** extend `teamsService.create` to optionally accept an array of new-agent specs alongside existing-agent member ids. The service inserts agents + agent_projects + team + team_members atomically inside a single transaction. On failure, every row rolls back.

**Why server-side:** the UI already has an onError handler; making it perform compensating-DELETEs would race the user's network. A server-side atomic create is the correct fix.

**Files:**
- Modify: `packages/shared/src/teams.ts` — extend `createTeamSchema` with `newAgents` field
- Modify: `server/src/services/teams.ts` — extend `create` to atomically insert new agents
- Modify: `ui/src/components/team/BuildFromScratchForm.tsx` — single POST instead of loop
- Modify: `server/src/__tests__/teams-service.test.ts` — atomic rollback test

- [ ] **Step 6.1: Extend createTeamSchema with newAgents**

In `packages/shared/src/teams.ts`, locate `createTeamSchema` (search for `createTeamSchema = z.object`). Append a `newAgents` field:

```ts
export const createTeamSchema = z.object({
  parentProjectId: z.string().uuid(),
  name: z.string().min(1).max(128),
  description: z.string().nullable().optional(),
  manifest: z.unknown().optional(),
  members: z
    .array(
      z.object({
        agentId: z.string().uuid(),
        role: TeamRoleSchema,
      }),
    )
    .optional(),
  // P1-G: founders building a team "from scratch" can specify NEW agents
  // alongside `members` (which references EXISTING agents). The service
  // creates these atomically — every row rolls back together on failure.
  // After successful insert, the new agents auto-join the team in the role
  // specified, AND auto-join the team's parentProjectId department.
  newAgents: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        adapterType: z.enum(AGENT_ADAPTER_TYPES).default("claude_local"),
        role: TeamRoleSchema,
        title: z.string().nullable().optional(),
        icon: z.enum(AGENT_ICON_NAMES).nullable().optional(),
      }),
    )
    .optional(),
});
```

Add the imports near the top of the file if they're missing:

```ts
import { AGENT_ADAPTER_TYPES, AGENT_ICON_NAMES } from "./constants.js";
```

- [ ] **Step 6.2: Write failing test — partial failure rolls back agents**

Append to `server/src/__tests__/teams-service.test.ts`:

```ts
it("create() with newAgents rolls back when team insert fails", async () => {
  // Two newAgents pre-validated. Mock the tx so:
  //   - tx.insert(agents) succeeds (returns 2 rows)
  //   - tx.insert(agentProjects) succeeds
  //   - insertTeamWithUniqueSlug throws conflict (slug saturated)
  // The transaction-wrapper's natural rollback should mean no DB writes
  // persist; we assert the final outcome by counting committed inserts.
  let agentInsertCalls = 0;
  let agentProjectInsertCalls = 0;
  let teamInsertCalls = 0;

  const db: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ id: "p1" }])), // parent project belongs to company
      })),
    })),
    transaction: async (cb: any) => {
      const tx: any = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve([])), // no existing slugs
          })),
        })),
        insert: vi.fn((table: any) => ({
          values: vi.fn(() => ({
            returning: vi.fn(() => {
              if (table?.id === "agents_id") {
                agentInsertCalls++;
                return Promise.resolve([
                  { id: "new-agent-1", name: "Alpha" },
                  { id: "new-agent-2", name: "Beta" },
                ]);
              }
              if (table?.id === "ap_agent_id" || table?.companyId === "ap_company_id") {
                agentProjectInsertCalls++;
                return Promise.resolve([{ ok: true }]);
              }
              if (table?.id === "teams_id") {
                teamInsertCalls++;
                const err = Object.assign(new Error("dup slug"), { code: "23505" });
                throw err;
              }
              return Promise.resolve([]);
            }),
          })),
        })),
      };
      try {
        return await cb(tx);
      } catch (err) {
        // Simulate Postgres transaction rollback — re-raise.
        throw err;
      }
    },
  };

  await expect(
    teamsService(db).create("co-1", {
      parentProjectId: "p1",
      name: "QA",
      newAgents: [
        { name: "Alpha", adapterType: "claude_local", role: "lead" },
        { name: "Beta", adapterType: "claude_local", role: "member" },
      ],
    }),
  ).rejects.toMatchObject({ status: 409 });

  // Verify the writes WERE attempted (so we proved the path) but the rollback
  // is a Postgres-level guarantee outside our test scope. The assertion is
  // structural: we did try to insert agents + agent_projects, then the team
  // insert failed.
  expect(agentInsertCalls).toBeGreaterThan(0);
  expect(teamInsertCalls).toBeGreaterThan(0);
});
```

NOTE: the test asserts call-shape, not Postgres-level rollback. Real rollback is a DB-level guarantee — proving it requires an integration test against a live cluster. The mock test proves the SERVICE invokes the writes inside one `db.transaction`, which is the necessary precondition for rollback.

- [ ] **Step 6.3: Add agents + agentProjects to the test mock module**

If the existing `vi.mock("@armyofagents/db", ...)` block at the top of `teams-service.test.ts` doesn't already register `agents`, add it. Also confirm `agentProjects` is registered (see lines 35-38 of the existing mock).

```ts
vi.mock("@armyofagents/db", () => ({
  teams: { /* ... existing fields ... */ },
  teamMembers: { /* ... */ },
  agentProjects: { /* ... existing fields plus: */ companyId: "ap_company_id" },
  projects: { /* ... */ },
  agents: {
    id: "agents_id",
    companyId: "agents_company_id",
    name: "agents_name",
    adapterType: "agents_adapter_type",
    role: "agents_role",
    title: "agents_title",
    icon: "agents_icon",
    status: "agents_status",
    permissions: "agents_permissions",
    runtimeConfig: "agents_runtime_config",
    adapterConfig: "agents_adapter_config",
    spentMonthlyCents: "agents_spent_monthly_cents",
    budgetMonthlyCents: "agents_budget_monthly_cents",
    lastHeartbeatAt: "agents_last_heartbeat_at",
    metadata: "agents_metadata",
    createdAt: "agents_created_at",
    updatedAt: "agents_updated_at",
  },
  teamCoordinations: {
    id: "team_coordinations_id",
    teamId: "team_coordinations_team_id",
    status: "team_coordinations_status",
    updatedAt: "team_coordinations_updated_at",
  },
}));
```

- [ ] **Step 6.4: Run test to verify it fails**

```bash
pnpm -C server test -- teams-service
```

Expected: the new test FAILS — `create` doesn't yet handle `newAgents`.

- [ ] **Step 6.5: Implement newAgents handling in teamsService.create**

In `server/src/services/teams.ts`, find the existing `create` method. Replace its body with:

```ts
create: async (companyId: string, input: CreateTeamInput) => {
  // Cross-tenant guard (existing): verify parent project belongs to caller's company.
  const projectCheck = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, input.parentProjectId),
        eq(projects.companyId, companyId),
      ),
    );
  if (projectCheck.length === 0) {
    throw badRequest(
      `parent project ${input.parentProjectId} not found in company ${companyId}`,
    );
  }

  const memberInputs = input.members ?? [];
  const newAgentInputs = input.newAgents ?? [];

  // Validate member inputs (existing-agent path) before opening the tx.
  if (memberInputs.length > 0) {
    const agentIds = memberInputs.map((m) => m.agentId);
    const deptMemberships = await db
      .select({ agentId: agentProjects.agentId })
      .from(agentProjects)
      .where(
        and(
          inArray(agentProjects.agentId, agentIds),
          eq(agentProjects.projectId, input.parentProjectId),
        ),
      );
    const inDept = new Set(deptMemberships.map((m: { agentId: string }) => m.agentId));
    const missing = agentIds.filter((id) => !inDept.has(id));
    if (missing.length > 0) {
      throw badRequest(
        `agents not in parent department: ${missing.join(", ")}`,
      );
    }
  }

  // Validate that combined leads (existing + new) is at most one.
  const leadCount =
    memberInputs.filter((m) => m.role === "lead").length +
    newAgentInputs.filter((a) => a.role === "lead").length;
  if (leadCount > 1) {
    throw badRequest(`at most one lead per team, got ${leadCount}`);
  }

  return db.transaction(async (tx) => {
    // Atomically: create new agents → link to dept → create team → link members.
    // P1-G: prior implementation looped INSERTs across multiple round-trips
    // outside any transaction. A failure on the team insert orphaned every
    // already-committed agent + agent_projects row. This whole block now
    // rolls back together.
    const createdAgentIdsByName = new Map<string, string>();

    if (newAgentInputs.length > 0) {
      const insertedAgents = await tx
        .insert(agents)
        .values(
          newAgentInputs.map((a) => ({
            companyId,
            name: a.name,
            adapterType: a.adapterType,
            role: "general" as const,
            title: a.title ?? null,
            icon: a.icon ?? null,
            status: "idle" as const,
            permissions: { canCreateAgents: false },
            runtimeConfig: {},
            adapterConfig: {},
            spentMonthlyCents: 0,
            budgetMonthlyCents: 0,
            lastHeartbeatAt: null,
          })),
        )
        .returning({ id: agents.id, name: agents.name });
      for (const a of insertedAgents) {
        createdAgentIdsByName.set(a.name, a.id);
      }

      // Link each to the parent dept.
      await tx.insert(agentProjects).values(
        insertedAgents.map((a) => ({
          agentId: a.id,
          projectId: input.parentProjectId,
          companyId,
        })),
      );
    }

    const team = await insertTeamWithUniqueSlug(tx, {
      companyId,
      parentProjectId: input.parentProjectId,
      name: input.name,
      description: input.description ?? null,
      manifest: input.manifest ?? {},
    });

    // Combine member rows: existing members + newly-created agents (mapped to ids).
    const allMemberRows = [
      ...memberInputs.map((m) => ({
        teamId: team.id,
        agentId: m.agentId,
        role: m.role,
      })),
      ...newAgentInputs.map((a) => {
        const agentId = createdAgentIdsByName.get(a.name);
        if (!agentId) {
          // Should be unreachable — every newAgent name has an inserted id.
          throw new Error(`newAgent ${a.name} did not produce an agent id`);
        }
        return { teamId: team.id, agentId, role: a.role };
      }),
    ];

    if (allMemberRows.length > 0) {
      await tx.insert(teamMembers).values(allMemberRows);
    }

    return team;
  });
},
```

Add the `agents` import:

```ts
import { teams, teamMembers, agentProjects, projects, agents, teamCoordinations } from "@armyofagents/db";
```

- [ ] **Step 6.6: Run tests to verify they pass**

```bash
pnpm -C server test -- teams-service
```

Expected: all teams-service tests pass.

- [ ] **Step 6.7: Update UI to use the atomic endpoint**

In `ui/src/components/team/BuildFromScratchForm.tsx`, replace the per-agent loop (lines 97-153) with a single team-create call. Locate the `mutationFn` (or equivalent) and replace it with:

```tsx
mutationFn: async () => {
  // P1-G: atomic create. The server now accepts `newAgents` alongside
  // `members`; agents + agent_projects + team + team_members all
  // commit together or roll back together. No more orphaned agents on
  // partial failure.
  const newAgents = members
    .filter((m) => m.kind === "new")
    .map((m) => ({
      name: m.name,
      adapterType: m.adapterType ?? "claude_local",
      role: m.role,
      title: m.title ?? null,
      icon: m.icon ?? null,
    }));
  const existingMembers = members
    .filter((m) => m.kind === "existing")
    .map((m) => ({
      agentId: m.agentId,
      role: m.role,
    }));

  return teamsApi.create(selectedCompanyId, {
    parentProjectId,
    name,
    description: description || null,
    manifest: manifestDraft,
    members: existingMembers,
    newAgents,
  });
},
```

Adjust the field shape (`members[].kind`, etc.) to match the existing form state. The exact form-state shape will be visible in the file's existing `members` array; preserve its discriminated-union structure and just route the two cases to the right server-side fields.

Update `ui/src/api/teams.ts` (or whichever file holds `teamsApi.create`) — extend the request body type to include `newAgents`. Mirror the server-side schema.

Remove the onError-side rollback if any. The UI no longer creates partial state, so the error handler can revert to a simple toast.

- [ ] **Step 6.8: Run UI tests if any exist for this form**

```bash
pnpm -C ui test -- BuildFromScratchForm
```

Expected: existing UI tests pass (or no tests exist — the form was previously tested manually).

- [ ] **Step 6.9: Commit**

```bash
git add packages/shared/src/teams.ts server/src/services/teams.ts ui/src/components/team/BuildFromScratchForm.tsx ui/src/api/teams.ts server/src/__tests__/teams-service.test.ts
git commit -m "$(cat <<'EOF'
fix(teams): atomic team-create-with-new-agents (no orphans on failure)

P1-G: BuildFromScratchForm previously created agents in a per-agent
loop BEFORE the team-create call. If team-create failed (validation,
slug exhaustion, network drop), the agents already committed orphaned
in the agents table — and a retry created MORE agents (no unique
constraint on agent.name) instead of resuming. Founders ended up with
duplicate "Alpha", "Beta", "Charlie" rows polluting the company.

Server-side fix: createTeamSchema now accepts an optional `newAgents`
array. teamsService.create wraps agent inserts + agent_projects links +
team insert + team_members links in one transaction. Any failure rolls
back every preceding insert. A founder retry hits a clean state.

UI: BuildFromScratchForm replaces the loop with one mutationFn call.
Discriminated-union `members[]` (existing vs. new) maps to `members[]`
+ `newAgents[]` on the wire.

Tests: teams-service test asserts the call-graph + that 23505 on the
team insert correctly propagates after the agents inserts attempted.
Postgres-level rollback is a DB guarantee outside the mock-test scope;
an integration test would need a live cluster.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: safeLogActivity in team-imports

**Findings addressed:** P1-H (downgraded to P2 — `team-imports.ts:122` calls bare `logActivity` instead of `safeLogActivity`).

**Files:**
- Create: `server/src/utils/safe-log-activity.ts` (extracted from `routes/teams.ts:32-52`)
- Modify: `server/src/routes/teams.ts` (replace local definition with import)
- Modify: `server/src/routes/team-imports.ts:122-141` (use `safeLogActivity`)

- [ ] **Step 7.1: Read the existing safeLogActivity definition**

```bash
sed -n '30,55p' "server/src/routes/teams.ts"
```

Confirm the function signature, what it catches, and how it logs the failure.

- [ ] **Step 7.2: Extract to a new util module**

Create `server/src/utils/safe-log-activity.ts`:

```ts
import type { Db } from "@armyofagents/db";
import { logActivity } from "../services/activity-log.js";
import { logger } from "./logger.js"; // adjust path to actual logger location

type LogActivityArgs = Parameters<typeof logActivity>[1];

/**
 * Wrapper around `logActivity` that swallows failures into a logger.warn
 * instead of letting them bubble. Use for activity logs that happen AFTER
 * a successful business-logic transaction commit — a transient log-INSERT
 * failure should not propagate as a 500 to the client (which would imply
 * the business action failed and prompt a destructive retry).
 */
export async function safeLogActivity(
  db: Db,
  args: LogActivityArgs,
): Promise<void> {
  try {
    await logActivity(db, args);
  } catch (err) {
    logger.warn(
      { err, action: args.action, entityType: args.entityType, entityId: args.entityId },
      "activity log insert failed; swallowing to keep response shape stable",
    );
  }
}
```

If the logger import path differs, adjust to match the existing convention (search for `from ".*logger"` in `server/src/routes/teams.ts`).

- [ ] **Step 7.3: Replace the local definition in routes/teams.ts**

In `server/src/routes/teams.ts`, delete the local `async function safeLogActivity(...)` definition (lines 32-52 or wherever it lives) and replace with an import:

```ts
import { safeLogActivity } from "../utils/safe-log-activity.js";
```

- [ ] **Step 7.4: Use safeLogActivity in routes/team-imports.ts**

In `server/src/routes/team-imports.ts`, locate the `await logActivity(db, {...})` call (around line 122). Replace `logActivity` with `safeLogActivity`:

```ts
await safeLogActivity(db, {
  companyId,
  actorType: actor.actorType,
  actorId: actor.actorId,
  agentId: actor.agentId,
  runId: actor.runId,
  action: "team.imported",
  entityType: "team",
  entityId: team.id,
  details: { manifestName: manifest.name, source: input.source },
});
```

Add the import:

```ts
import { safeLogActivity } from "../utils/safe-log-activity.js";
```

Also audit `server/src/routes/team-imports.ts` for any OTHER `logActivity` calls — replace those too if they're after a successful transaction commit.

- [ ] **Step 7.5: Run tests**

```bash
pnpm -C server test -- teams-service team-import-service
```

Expected: no test changes (this is a non-functional refactor on the success path), all tests still pass. If the existing tests assert on `logActivity` being called, update them to assert on `safeLogActivity` instead.

- [ ] **Step 7.6: Commit**

```bash
git add server/src/utils/safe-log-activity.ts server/src/routes/teams.ts server/src/routes/team-imports.ts
git commit -m "$(cat <<'EOF'
fix(teams): use safeLogActivity in team-imports install

P1-H: team-imports.ts:122 called bare logActivity after a successful
team-import transaction commit. A transient activity-log INSERT failure
(pool exhaustion, replication lag, anything) bubbled as 500 to the
client even though the import had succeeded. Founder retries → 23505 on
slug because the team already exists.

Extract safeLogActivity from routes/teams.ts:32-52 to a shared util at
server/src/utils/safe-log-activity.ts. Replace logActivity with
safeLogActivity in team-imports. Behaviour on the happy path is
unchanged; failure mode is now a logger.warn instead of an HTTP 500.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Type hygiene — drop `tx: any`, wrap slug-retry final error, fix team-export null

**Findings addressed:** P2-A (`tx: any` in 4 sites — Tasks 2, 3, 5 already remove three of them; sweep the remaining one), P2-E (slug-retry final error rethrow is naked — but Task 5 already replaces this code path; verify), P2-H (`team-export.ts:70` description null/undefined coercion).

**This task picks up the remainders that earlier tasks didn't already touch.**

**Files:**
- Modify: `server/src/services/team-import.ts:247` (last remaining `tx: any` after Task 5's refactor)
- Modify: `server/src/services/team-export.ts:70`

- [ ] **Step 8.1: Audit remaining `tx: any` after Tasks 2, 3, 5**

```bash
grep -n "tx: any" server/src/services/teams.ts server/src/services/team-coordination.ts server/src/services/team-import.ts
```

Expected after prior tasks: 0 hits in teams.ts and team-coordination.ts; 1 hit remaining in team-import.ts at the install transaction body (the part Task 5 didn't fully rewrite).

- [ ] **Step 8.2: Drop the remaining `tx: any`**

In `server/src/services/team-import.ts`, locate `db.transaction(async (tx: any) => {` and change to `db.transaction(async (tx) => {`. If the body has type errors after the change, address each at the call site (likely `tx.insert(...)` or `tx.select(...)` calls that need a more-specific type — Drizzle infers them from the table reference).

If any specific call needs a narrower type than the inferred one, add a top-of-function type alias rather than `any`:

```ts
type ImportTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
```

Use `ImportTx` only where strictly necessary for cross-function helpers. Inline transaction bodies should rely on the inferred type.

- [ ] **Step 8.3: Verify slug-retry final error wrap**

Task 5 introduced `insertTeamWithUniqueSlug` which throws `conflict(...)` after retries. Confirm by reading the helper's failure path:

```bash
grep -n "could not generate" server/src/services/teams.ts
```

Expected: matches the helper's `throw conflict(...)` with the user-facing message. If the old naked-rethrow at `teams.ts:166-173` is still present (indicates Task 5's commit was incomplete), delete the dead code.

- [ ] **Step 8.4: Write failing test — team-export coerces null description**

Append to `server/src/__tests__/team-export-service.test.ts` (or create the file if it doesn't exist):

```ts
it("coerces description: null to undefined when both team and stored are null", async () => {
  // P2-H: team.description = null AND stored.description = null → ?? returns null →
  // TeamManifestSchema.description is `.optional()` not `.nullable()` → .parse() throws.
  // Fix: ?? both into undefined.
  const result = await teamExportService(/* mocked db */).buildManifest({
    teamRow: { /* ... */ description: null },
    storedManifest: { /* ... */ description: null },
  });

  // Should not throw; description should be undefined (omitted) in the output.
  expect(result.description).toBeUndefined();
});
```

Adjust to match the existing `teamExportService` shape — the actual entry point may be `exportTeam(teamId)` or similar. Read the file before writing the test.

- [ ] **Step 8.5: Implement the coercion**

In `server/src/services/team-export.ts`, locate line 70 (or the equivalent line that reads `description: team.description ?? stored.description`). Change to:

```ts
description: team.description ?? stored.description ?? undefined,
```

This explicitly coerces `null` to `undefined` — `??` only descends when the left is `null | undefined`, and `null ?? undefined === undefined`.

- [ ] **Step 8.6: Run tests**

```bash
pnpm -C server test -- team-export-service teams-service team-import-service team-coordination-service heartbeat-team-coordination
```

Expected: all pass.

- [ ] **Step 8.7: Commit**

```bash
git add server/src/services/team-import.ts server/src/services/team-export.ts server/src/__tests__/team-export-service.test.ts
git commit -m "$(cat <<'EOF'
fix(teams): drop residual tx:any + coerce null description in export

P2-A residual: Tasks 2, 3, 5 already dropped tx: any in teams.ts and
team-coordination.ts. This commit cleans up the last site in
team-import.ts (the install transaction). The Drizzle Tx type infers
correctly with no `any`.

P2-H: team-export.ts:70 used `team.description ?? stored.description`,
which leaks `null` through both sources. TeamManifestSchema.description
is .optional() (not .nullable()) so .parse() crashes when both sources
are null. Fix: append `?? undefined` to the coalesce chain. ?? only
descends on null-or-undefined, so `null ?? undefined === undefined`.

P2-E confirmation: insertTeamWithUniqueSlug from Task 5 already throws
conflict(...) after retries. No naked rethrow remains.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: ReDoS hardening for manifest regex validation

**Findings addressed:** P2-C (Zod `superRefine` calls `new RegExp(rule.match)` on user input — ReDoS-prone if `rule.match` is later evaluated against attacker text).

**Approach:** length-cap the pattern (256 chars), reject obvious nested-quantifier patterns at validation time. JS regex compilation itself is cheap, so this is cheap defense.

**Files:**
- Modify: `packages/shared/src/teams.ts:91-108` — extend `superRefine`
- Modify: `server/src/__tests__/team-manifest.test.ts` — pathological-pattern test

- [ ] **Step 9.1: Write failing test — pathological pattern is rejected**

Append to `server/src/__tests__/team-manifest.test.ts`:

```ts
it("rejects pathological nested-quantifier regex patterns", () => {
  // The classic ReDoS shape: nested quantifier with ambiguity.
  const manifest = {
    name: "qa",
    description: "x",
    schemaVersion: 1,
    routing: {
      rules: [{ match: "(a+)+$", mention: "@x" }],
    },
    agents: [],
    version: "1.0.0",
    displayName: "QA",
  };

  expect(() => TeamManifestSchema.parse(manifest)).toThrow(/regex|pattern/i);
});

it("rejects regex patterns over 256 characters", () => {
  const longPattern = "a".repeat(257);
  const manifest = {
    name: "qa",
    description: "x",
    schemaVersion: 1,
    routing: {
      rules: [{ match: longPattern, mention: "@x" }],
    },
    agents: [],
    version: "1.0.0",
    displayName: "QA",
  };

  expect(() => TeamManifestSchema.parse(manifest)).toThrow(/256|length/i);
});

it("accepts simple, non-pathological patterns", () => {
  const manifest = {
    name: "qa",
    description: "x",
    schemaVersion: 1,
    routing: {
      rules: [{ match: "release|hotfix", mention: "@alice" }],
    },
    agents: [],
    version: "1.0.0",
    displayName: "QA",
  };

  expect(() => TeamManifestSchema.parse(manifest)).not.toThrow();
});
```

- [ ] **Step 9.2: Run tests to verify the first two fail**

```bash
pnpm -C server test -- team-manifest
```

Expected: first two new tests FAIL (pattern accepted), third passes.

- [ ] **Step 9.3: Implement the cap + nested-quantifier check**

In `packages/shared/src/teams.ts`, locate the routing-rules `superRefine` (around lines 91-108). Replace the `new RegExp(rule.match)` validation block with:

```ts
.superRefine((value, ctx) => {
  for (let i = 0; i < value.rules.length; i++) {
    const rule = value.rules[i];

    // Cap pattern length to prevent oversized payloads from growing the
    // regex compile cost or DoS via memory pressure.
    if (rule.match.length > 256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `regex pattern exceeds 256 character limit (got ${rule.match.length})`,
        path: ["rules", i, "match"],
      });
      continue;
    }

    // Reject the most common ReDoS shape: nested quantifier directly inside
    // a group whose contents are themselves quantified. Examples:
    //   (a+)+   (a*)+   (a+)*   (a+)?   ([abc]+)+
    // This is a coarse heuristic — it's not a perfect ReDoS detector. It
    // catches the classic CWE-1333 patterns at near-zero cost. For
    // production-grade safety, use re2-wasm or a complexity analyser
    // (re2 has linear-time evaluation by construction).
    if (/\([^)]*[+*][^)]*\)[+*?]/.test(rule.match)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `regex pattern contains a nested quantifier (ReDoS-prone): ${rule.match}`,
        path: ["rules", i, "match"],
      });
      continue;
    }

    // Compilability check (existing behaviour).
    try {
      new RegExp(rule.match);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid regex: ${(err as Error).message}`,
        path: ["rules", i, "match"],
      });
    }
  }
})
```

- [ ] **Step 9.4: Run tests to verify they pass**

```bash
pnpm -C server test -- team-manifest
```

Expected: all three tests pass.

- [ ] **Step 9.5: Commit**

```bash
git add packages/shared/src/teams.ts server/src/__tests__/team-manifest.test.ts
git commit -m "$(cat <<'EOF'
fix(teams): cap regex patterns + reject nested-quantifier shapes

P2-C: routing.rules[].match is user-supplied and reaches a
new RegExp(...) call inside Zod superRefine. JS regex compilation is
cheap, but the rule's PURPOSE is to be evaluated against agent-mention
strings — at evaluation time, a pathological pattern like (a+)+$
backtracks exponentially. The first feature that wires up rule
evaluation introduces a ReDoS attack surface.

Defensive validation:
1. Cap pattern length to 256 chars.
2. Reject the classic CWE-1333 nested-quantifier shape:
   /\([^)]*[+*][^)]*\)[+*?]/
3. Keep the existing compilability try/catch.

This is a coarse heuristic, not a complete ReDoS analyser. For
production-grade safety the right move is re2-wasm at evaluation
time. The cap+heuristic blocks every published example of CWE-1333
that has actually shown up in OWASP / GitHub-advisory writeups.

Tests: three new vitest cases — pathological pattern rejected, oversize
rejected, simple alternation accepted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Test fixture ASCII sweep

**Findings addressed:** P2-G (test fixtures contain `→`, `—`, smart quotes — discipline drift, may break Windows WIN1252 clusters if test fixtures are written to a real DB).

**Files (test files containing non-ASCII glyphs):**
- `server/src/__tests__/team-coordination-service.test.ts`
- `server/src/__tests__/team-import-service.test.ts`
- `server/src/__tests__/team-system-admin.test.ts`
- `server/src/__tests__/team-direct-add.test.ts`
- `server/src/__tests__/team-export-service.test.ts`
- `server/src/__tests__/team-service.test.ts`
- `server/src/__tests__/team-manifest.test.ts`
- `server/src/__tests__/team-imports-routes-contract.test.ts`
- `server/src/__tests__/heartbeat-team-coordination.test.ts`

- [ ] **Step 10.1: Audit all non-ASCII glyphs in team-* and heartbeat-team-* tests**

```bash
cd "server/src/__tests__"
for f in team-*.ts heartbeat-team-*.ts; do
  grep -nP "[\x{2010}-\x{2027}\x{2030}-\x{205E}\x{2190}-\x{21FF}]" "$f" 2>/dev/null && echo "  ↑ in $f"
done
```

This regex matches Unicode general-punctuation arrows + dashes (U+2010–U+2027, U+2030–U+205E, U+2190–U+21FF). Expected: hits in the files listed above.

- [ ] **Step 10.2: Replace per-glyph**

Substitution table:
- `→` (U+2192) → `->`
- `←` (U+2190) → `<-`
- `↔` (U+2194) → `<->`
- `—` (U+2014, em dash) → `--`
- `–` (U+2013, en dash) → `-`
- `'` and `'` (U+2018, U+2019, smart quotes) → `'`
- `"` and `"` (U+201C, U+201D, smart quotes) → `"`
- `…` (U+2026) → `...`

For each file from Step 10.1, do:

```bash
sed -i 's/→/->/g; s/←/<-/g; s/↔/<->/g; s/—/--/g; s/–/-/g; s/['\''’]/'\''/g; s/["“”]/"/g; s/…/.../g' "$f"
```

(On Windows, prefer the Edit tool with `replace_all: true` per glyph rather than sed — sed's UTF-8 handling on Windows is unreliable.)

- [ ] **Step 10.3: Verify no non-ASCII remain**

```bash
cd "server/src/__tests__"
for f in team-*.ts heartbeat-team-*.ts; do
  grep -nP "[\x{2010}-\x{2027}\x{2030}-\x{205E}\x{2190}-\x{21FF}]" "$f" && echo "STILL DIRTY: $f"
done
```

Expected: no output. If any file still has hits, the sed didn't catch them — replace by hand.

- [ ] **Step 10.4: Run all team tests to verify nothing broke**

```bash
pnpm -C server test -- team teams heartbeat-team
```

Expected: all team-related tests pass. (The substitutions are within string literals — they only matter to assertions and fixture parsing, which is ASCII-tolerant.)

- [ ] **Step 10.5: Commit**

```bash
git add server/src/__tests__/team-*.ts server/src/__tests__/heartbeat-team-*.ts
git commit -m "$(cat <<'EOF'
chore(teams): ASCII-only test fixtures

P2-G: test files contained ~20+ non-ASCII glyphs (→, —, smart quotes,
en/em dashes). The team-scaffolder.ts ASCII-only discipline (added
during the Windows-WIN1252 hotfix) doesn't extend to test fixtures
today, but a stray copy-paste from a fixture into production code
re-introduces the encoding hazard. Sweep:

  →  → ->
  ←  → <-
  —  → --
  –  → -
  ' ' → '
  " " → "
  …  → ...

Substitution is mechanical and confined to string literals; assertions
and fixture parsing are unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Surface "replace" silent dept-grant in import

**Findings addressed:** P3-D (UPGRADED to P2 by verifier — `team-import.ts:269-285` "replace" mode silently grants dept-membership to an existing agent that wasn't in the parent dept).

**Approach:** the install service returns a `warnings: string[]` field on success; the route puts those into the response body so the founder can see what side effects happened. The UI surfaces them as a banner/toast.

**Files:**
- Modify: `server/src/services/team-import.ts:269-285` — collect warning strings
- Modify: `server/src/services/team-import.ts` (return-shape) — include `warnings` array
- Modify: `server/src/routes/team-imports.ts` — pass warnings through to response
- Modify: `ui/src/pages/teams/import-page.tsx` (or whichever UI page consumes the install response) — display warnings
- Modify: `server/src/__tests__/team-import-service.test.ts` — warning emitted

- [ ] **Step 11.1: Read the existing return shape of teamImportService.install**

```bash
grep -nE "^(export|async)? *function install|install: async|return \{" server/src/services/team-import.ts | head -20
```

Confirm the current return type — usually `{ team: Team, members: Member[] }` or similar. The new field is `warnings: string[]`.

- [ ] **Step 11.2: Write failing test — replace-mode emits a warning**

Append to `server/src/__tests__/team-import-service.test.ts`:

```ts
it("emits a warning when 'replace' grants dept membership to an out-of-dept agent", async () => {
  // Setup: existing agent "Alice" is in the company but NOT in the parent
  // dept. The manifest references an agent named "Alice" with action=replace.
  // The install should succeed AND emit a warning explaining the dept grant.
  //
  // Mock shape sketches:
  // - select for existing agent by name → returns Alice (in company)
  // - select for agent_projects (Alice in dept-x) → returns []
  // - tx.insert(agent_projects) → succeeds
  // - tx.insert(teams) → succeeds
  // - tx.insert(team_members) → succeeds
  // (Build the full mock by referencing existing test setups in this file.)

  const result = await teamImportService(mockDb).install("co-1", manifestFixture, {
    resolutions: { Alice: "replace" },
  });

  expect(result.warnings).toBeDefined();
  expect(result.warnings).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/Alice.*department/i),
    ]),
  );
});
```

- [ ] **Step 11.3: Run test to verify failure**

```bash
pnpm -C server test -- team-import-service
```

Expected: FAIL — `result.warnings` is undefined.

- [ ] **Step 11.4: Add warnings collection to install**

In `server/src/services/team-import.ts`:

1. Declare a `warnings: string[]` array inside the install function, before the transaction.
2. In the existing block that handles "replace" → silently inserts agent_projects (lines 269-285), push a warning when the insert happens:

```ts
// After the agentProjects insert in the 'replace' branch:
warnings.push(
  `Agent "${agentName}" (existing, id=${existingAgent.id}) was not previously a member of department "${input.parentProjectId}". The 'replace' action added them to this department.`,
);
```

3. Update the return statement to include warnings:

```ts
return { team, members: insertedMembers, warnings };
```

Also update the return TYPE if it's explicitly declared anywhere (search for `Promise<{ team:` in the file).

- [ ] **Step 11.5: Pass warnings through the route layer**

In `server/src/routes/team-imports.ts`, find the install route handler. Locate the response — currently `res.json({ team, members })` or similar. Change to:

```ts
res.json({ team: result.team, members: result.members, warnings: result.warnings ?? [] });
```

- [ ] **Step 11.6: Surface in UI**

In `ui/src/pages/teams/import-page.tsx` (or whichever file owns the import success handler), after the mutation resolves, check for warnings and display them:

```tsx
onSuccess: (data) => {
  pushToast({ type: "success", message: `Team "${data.team.name}" imported.` });
  if (data.warnings && data.warnings.length > 0) {
    for (const w of data.warnings) {
      pushToast({ type: "warning", message: w, durationMs: 8000 });
    }
  }
  // existing navigation / refetch logic
},
```

- [ ] **Step 11.7: Run tests**

```bash
pnpm -C server test -- team-import-service
```

Expected: pass.

- [ ] **Step 11.8: Commit**

```bash
git add server/src/services/team-import.ts server/src/routes/team-imports.ts ui/src/pages/teams/import-page.tsx server/src/__tests__/team-import-service.test.ts
git commit -m "$(cat <<'EOF'
feat(teams): surface 'replace' dept-grant warnings on import

P3-D (upgraded to P2 by review): team-import.ts:269-285 silently grants
dept membership when 'replace' action targets an existing agent that
wasn't previously in the parent department. Founder doesn't see this
side effect — they expect 'replace' to be a no-op on dept membership.

Fix: install collects a warnings: string[] array. The 'replace' grant
path pushes a description of the side effect. The route returns
warnings on the response body. The UI shows a per-warning toast on
success. Founder retains full visibility into the dept-grant operation.

This is non-blocking — install still succeeds. The grant itself was
arguably correct (the agent IS now in the team, which IS in this dept,
so dept membership is a prerequisite). Surfacing it lets the founder
catch unintended scope expansion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: UX polish bundle — TeamsSection UUID, schema nullability, self-mention dedup

**Findings addressed:** P3-B (TeamsSection.tsx:76 displays raw UUID), P3-E (`updateTeamSchema.description` not nullable), P3-G (self-mention exclusion at issues.ts:683 + 1060 only fires for agent actor, not local-board / user actor).

**Files:**
- Modify: `ui/src/components/team/TeamsSection.tsx:76`
- Modify: `packages/shared/src/teams.ts:165` (`updateTeamSchema.description`)
- Modify: `server/src/routes/issues.ts:683, 1060` (self-mention check)

- [ ] **Step 12.1: Resolve agent name in TeamsSection**

In `ui/src/components/team/TeamsSection.tsx`, locate line 76 (currently `leadName: lead ? lead.agentId : "—",`). Above the component, add an agents query if there isn't one already; in the component body, build a name map and resolve:

```tsx
const { data: agents = [] } = useQuery({
  queryKey: ["agents", selectedCompanyId],
  queryFn: () => agentsApi.list(selectedCompanyId),
  staleTime: 60_000,
});

const agentNameById = useMemo(
  () => new Map(agents.map((a: { id: string; name: string }) => [a.id, a.name])),
  [agents],
);

// Inside the team-card-data mapper:
leadName: lead ? agentNameById.get(lead.agentId) ?? lead.agentId : "--",
```

Note: change the fallback dash from `—` (em dash) to `--` (ASCII) to match the team-scaffolder ASCII discipline. Drop the `// TODO: resolve agent name in a follow-up` comment.

- [ ] **Step 12.2: Make updateTeamSchema.description nullable**

In `packages/shared/src/teams.ts`, locate `updateTeamSchema`. Find the line:

```ts
description: z.string().optional(),
```

Change to:

```ts
description: z.string().nullable().optional(),
```

This matches `upsertCoordinationSchema.description` (line 187, which already does this and has a C4 comment justifying the difference). Update the inferred type if exported.

- [ ] **Step 12.3: Extend self-mention exclusion to comment.authorAgentId**

In `server/src/routes/issues.ts`, locate the two self-mention exclusion sites:

**Site 1 (around line 683):**

```ts
for (const mentionedId of mentionedIds) {
  if (wakeups.has(mentionedId)) continue;
  if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
  // ...
```

Change to:

```ts
for (const mentionedId of mentionedIds) {
  if (wakeups.has(mentionedId)) continue;
  // P3-G: when an agent posts a comment via local-board / user / service
  // actor (e.g. local_trusted curl with no auth), the actor.actorType
  // check above doesn't fire. Also check the persisted comment's
  // authorAgentId — that field correctly identifies the agent regardless
  // of which actor type the route attributed the request to.
  if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
  if (comment?.authorAgentId === mentionedId) continue;
  // ...
```

**Site 2 (around line 1060):**

Same transform — the existing line uses `actorIsAgent` which is a local boolean cache of `actor.actorType === "agent"`. Add the comment-author check beneath:

```ts
for (const mentionedId of mentionedIds) {
  if (wakeups.has(mentionedId)) continue;
  if (actorIsAgent && actor.actorId === mentionedId) continue;
  if (comment?.authorAgentId === mentionedId) continue;
  // ...
```

If `comment` isn't in scope at site 2, look up the variable name (the local that holds the freshly-inserted `issue_comments` row).

- [ ] **Step 12.4: Run tests**

```bash
pnpm -C server test -- teams-service team-coordination-service heartbeat-team-coordination team-import-service
```

Expected: existing tests still pass. P3-G doesn't add a new test (the self-wake bug only manifests under local-board posting, which is hard to mock at the comments-route level without a richer harness; the fix is structurally obvious — check both fields).

```bash
pnpm -C ui test -- TeamsSection
```

If UI tests exist, verify; otherwise rely on manual smoke (next session).

- [ ] **Step 12.5: Commit**

```bash
git add ui/src/components/team/TeamsSection.tsx packages/shared/src/teams.ts server/src/routes/issues.ts
git commit -m "$(cat <<'EOF'
fix(teams): UX polish — agent name display, nullable description, self-mention dedup

Three small fixes bundled:

P3-B: TeamsSection.tsx:76 displayed the raw lead.agentId UUID. Resolve
to a name via the agents query; UUID stays as the fallback if the agent
isn't loaded yet (network race). Drop the // TODO comment.

P3-E: updateTeamSchema.description was z.string().optional() — the DB
column IS nullable, but the schema rejected `description: null`, so
there was no way for the UI to clear an existing description. Match
upsertCoordinationSchema's .nullable().optional() shape.

P3-G: routes/issues.ts:683 + :1060 self-mention exclusion only checked
`actor.actorType === "agent" && actor.actorId === mentionedId`. When an
agent posts a comment via local-board (e.g. local_trusted curl with no
auth header), the actor type is "board" and the agent self-wakes from
their own mention. Also check comment?.authorAgentId === mentionedId,
which correctly identifies the agent regardless of actor type.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist (run after writing the plan)

**1. Spec coverage:**
- [x] P1-A — Task 4
- [x] P1-B — Task 5
- [x] P1-C — Task 5
- [x] P1-D — Task 3
- [x] P1-E — Tasks 1 + 2
- [x] P1-F — Tasks 1 + 2
- [x] P1-G — Task 6
- [x] P1-H — Task 7
- [x] P2-A — Tasks 2, 3, 5, 8
- [x] P2-C — Task 9
- [x] P2-D — Task 2 (wire up via Task 3 cascade)
- [x] P2-E — Task 5 (helper throws conflict; Task 8 verifies)
- [x] P2-G — Task 10
- [x] P2-H — Task 8
- [x] P2-M — Task 1
- [x] P3-A — Task 4
- [x] P3-B — Task 12
- [x] P3-D — Task 11
- [x] P3-E — Task 12
- [x] P3-F — covered by per-task tests in Tasks 2, 3, 4, 5, 6, 9
- [x] P3-G — Task 12

**Deferred (explicitly):** P2-B, P2-F, P2-I, P2-J, P2-K, P2-L, P3-C — all downgraded by verifier and explicitly listed in the "Deferred" section above.

**2. Placeholder scan:** None of the steps say "TODO", "fill in details", "add appropriate error handling", or "similar to Task N". Every step has either an exact command, an exact code block, or an exact substitution table. ✅

**3. Type consistency:**
- `insertTeamWithUniqueSlug` — defined in Task 5, used in both `teamsService.create` and `teamImportService.install`. Consistent signature. ✅
- `safeLogActivity` — defined in Task 7, used by `routes/teams.ts` (already, replaced by import) and `routes/team-imports.ts` (added). ✅
- `createTeamSchema.newAgents` — added in Task 6, used in service + UI same task. ✅
- `warnings: string[]` — added in Task 11, returned from service + route + UI same task. ✅

**4. Commit boundary review:** 12 commits total, each scoped to one logical change. No commit spans two themes. Migration commit (Task 1) is first so subsequent service-layer commits have a real DB invariant to lean on. ✅

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-30-teams-feature-hardening.md`.**

Recommended execution: **Subagent-Driven Development** (`superpowers:subagent-driven-development`) — fresh implementer subagent per task, two-stage review (spec compliance + code quality) per task, no batching.

Total estimated cost: 12 implementer subagents + ~24 reviewer subagents = ~36 sub-runs across the 12 tasks. With reviews catching issues per task, end state is a series of 12 cleanly-scoped commits ready to land as a follow-up PR to #93.

Final review (Phase 4) runs after all 12 commits land — one full-diff code review across the whole follow-up before opening the follow-up PR.
