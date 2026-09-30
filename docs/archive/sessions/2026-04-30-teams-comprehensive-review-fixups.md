# Teams Comprehensive-Review Fixups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the small set of follow-up fixes that the comprehensive code review (3 parallel deep-dive reviewers) surfaced, after the false-positive audit confirmed which findings were real.

**Architecture:** This is a 6-task fixup pass on top of the 16-commit Teams feature hardening (BASE: `40ff251` on branch `feat/teams`). The fixes cluster into three themes: (1) race-condition hardening in `team-coordination.ts:upsert` that the prior reviewers missed, (2) UI cache invalidation gaps + a defensive log-line parity fix, (3) a centralized 23505 detection helper that also fixes a pre-existing latent bug in `documents.ts`, plus a migration-safety guard for production rollouts. Final task documents three findings that the audit confirmed are deliberate design choices (no code change).

**Tech Stack:** TypeScript + Express 5 + Drizzle ORM + Postgres, Vitest for tests, React + Vite for UI. Branch: `feat/teams` (PR #93). Existing test conventions in `server/src/__tests__/team-coordination-service.test.ts` (vi.mock for drizzle-orm + @armyofagents/db, custom `db: any` proxies for race-shape simulation).

---

## Verified-finding → Task map (from the false-positive audit)

| Finding | Audit verdict | Task | Why fix |
|---------|---------------|------|---------|
| **C1** Published-update silent state-mismatch | REAL but milder framing | 1 | UPDATE-by-id only matches if WHERE includes status; protects against concurrent archive |
| **C2** Archived-revive 23505 race | PARTIAL (3-step race only) | 1 | Same fix shape as C1; cheap to land both |
| **C3** UI cache invalidation gap | REAL, every-time UX bug | 2 | Founder sees stale dept-agent list after every team-create |
| **L12** `team.warnings.length` without `?.` | REAL — same shape as Phase 4 regression | 3 | Defensive parity; 1-line fix |
| **D1** 23505 detection duplicated 7× + latent bug in `documents.ts` | REAL + bonus pre-existing bug | 4 | Centralize; fix `documents.ts` while we have context |
| **I1** Migration may abort on production duplicates | REAL but scale-dependent | 5 | Pre-flight cleanup before unique-index creation |
| **I2** ReDoS heuristic comment overclaims | REAL bypasses, ZERO current impact | 6 | Soften comment to honest "common shapes; not exhaustive" |
| **I3** Approval-gate bypass for inline newAgents | REAL design choice | 6 | Document explicitly in deferred section |
| **I4** Read routes lack dept-scope | REAL plan-level scope | 6 | Document deferred until Hosted lands |

**Findings audit-dropped (false positives):**
- **L1** "updateMemberRole demote loop should `break` after first" — verified the loop iterates ALL existingLead and demotes each. Reviewer claim was wrong; loop is correct.

**Findings explicitly deferred (architecture polish, not in this plan):**
- D2 (`safeLogActivity` placement), D3 (move helper to `team-slug.ts`), D4 (move `TeamImportInstallResult` to shared), D5 (real-RBAC-denies test), L2-L11 (long-tail polish).

---

## File-structure preamble — what gets created or modified

### Server services
- `server/src/services/team-coordination.ts:38-74` — wrap published-update and archived-revive UPDATEs in `eq(status, "...")` WHERE clauses + 23505 try/catch on revive. Throw `conflict()` when `updated.length === 0`.
- `server/src/services/db-errors.ts` (new) — `isUniqueViolation(err, constraint?)` helper extracting `code` from both `err.code` and `err.cause?.code`. Optional constraint-name match.
- `server/src/services/teams.ts` (4 sites) + `server/src/services/team-coordination.ts` (1 site) + `server/src/services/team-import.ts` (0 sites — handled inside `insertTeamWithUniqueSlug`) + `server/src/services/documents.ts:16-18` (replaces buggy local helper) — refactor 7 inline 23505 detection sites to use the new shared helper. Fixes the `cause.code` under-detection bug in `documents.ts`.
- `server/src/services/companies.ts:70` + `server/src/services/routines.ts:689` + `server/src/services/plugin-registry.ts:42` — out of scope for this plan; flagged as additional sites that should adopt the helper in a separate cleanup task.

### Server routes
- `server/src/routes/team-imports.ts:171` — defensive parity fix: `team.warnings?.length ?? 0` (matches the response body's `?? []` defense).

### UI
- `ui/src/components/team/BuildFromScratchForm.tsx:168-176` — add `queryKeys.projects.agents(parentProjectId)` to the invalidations.
- `ui/src/components/team/ImportPreviewDialog.tsx:102-104` — extend the lone `teams.list` invalidate to also cover `agents.list`, `projects.list`, and `projects.agents(parentProjectId)`.

### Migrations
- `packages/db/src/migrations/0069_wide_earthquake.sql` — prepend an idempotent cleanup statement that archives all but the most-recent published row per team. Documented exception to the "NEVER write raw SQL migrations" rule per CLAUDE.md (we're appending defensive cleanup to a drizzle-kit-generated file, not authoring a new migration).

### Tests
- `server/src/__tests__/team-coordination-service.test.ts` — add 3 new tests for C1 (concurrent archive race), C2 (3-step revive race), and the `updated.length === 0` guards.
- `server/src/__tests__/db-errors.test.ts` (new) — unit tests for `isUniqueViolation()` covering `err.code`, `err.cause.code`, constraint-name match, and non-unique error pass-through.

### Documentation
- `docs/superpowers/plans/2026-04-30-teams-feature-hardening.md` — extend the "Deferred" section with explicit notes on I2/I3/I4 and the false-positive on L1.
- `packages/shared/src/teams.ts:99-103` (the ReDoS heuristic comment) — soften the wording from "every published example of CWE-1333" to "common CWE-1333 shapes; not exhaustive — `(a+){10,}`, `(a|aa)+`, `((a+))+` slip through".

---

## Conventions for every task

- All commits on branch `feat/teams`. Verify with `git -C ... rev-parse --abbrev-ref HEAD` before starting.
- Trailer (no `--no-verify`, no `--amend`):
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- Tests run via `pnpm vitest run <path>` from repo root or `pnpm -C server test -- <pattern>` (both work post-Phase-3).
- Don't touch the working-tree dirty files (`.claude/launch.json`, `CLAUDE.md`, etc.) — those are unrelated.
- The 16-commit hardening + 0069 migration are already pushed to `origin/feat/teams` (HEAD `40ff251`). New commits go on top.

---

### Task 1: Harden coord upsert against concurrent archive (C1 + C2)

**Findings:** C1 (published-update silent state-mismatch under concurrent archive), C2 (3-step revive race firing `team_coordinations_one_published_uq` 23505).

**Why first:** This is the highest-impact correctness fix. Both bugs share the same fix shape (add `status` filter to UPDATE WHERE; check `updated.length === 0`).

**Files:**
- Modify: `server/src/services/team-coordination.ts:38-74` (the upsert's published-update and archived-revive branches)
- Modify: `server/src/__tests__/team-coordination-service.test.ts` (3 new tests appended to the existing describe block)

- [ ] **Step 1.1: Read current upsert state**

```bash
sed -n '19,105p' "server/src/services/team-coordination.ts"
```

Confirm published-update branch is at lines 38-50, archived-revive at lines 53-74, insert path at lines 78-103.

- [ ] **Step 1.2: Write failing test — published-update returns conflict when row was concurrently archived**

Append to `server/src/__tests__/team-coordination-service.test.ts` inside `describe("teamCoordinationService.upsert", ...)`:

```ts
it("throws conflict when published row is concurrently archived between SELECT and UPDATE", async () => {
  // C1: T1 SELECTs published row R; T2 archives R (status='published'→'archived');
  // T1's UPDATE-by-id only filters by id, so without a status guard it would
  // overwrite the archived row's name/markdown. Fix: WHERE includes
  // status='published'; if updated.length === 0, throw conflict.
  const db: any = {
    transaction: async (cb: any) => {
      const tx: any = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([{ id: "coord-1", status: "published" }]),
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              // Simulate concurrent archive: row matches by id but status !== 'published'.
              // Drizzle UPDATE...WHERE...RETURNING returns 0 rows when no match.
              returning: () => Promise.resolve([]),
            }),
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

- [ ] **Step 1.3: Write failing test — archived-revive returns conflict when row was concurrently re-published**

Append to the same describe block:

```ts
it("throws conflict when archived row is concurrently revived between SELECT and revive UPDATE", async () => {
  // C2 secondary scenario: T2 inserts new published row + archives the
  // existing archived row, so when T1 tries to revive the original archived
  // row, our partial unique index would fire on the second 'published' row
  // OR the WHERE-by-id-and-status no longer matches (status changed).
  // Either way, updated.length === 0 → throw conflict.
  let selectCalls = 0;
  const db: any = {
    transaction: async (cb: any) => {
      const tx: any = {
        select: () => ({
          from: () => ({
            where: () => {
              const idx = selectCalls++;
              if (idx === 0) return Promise.resolve([]); // no published
              if (idx === 1)
                return Promise.resolve([{ id: "coord-1", status: "archived" }]); // archived found
              return Promise.resolve([]);
            },
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              // Simulate concurrent revive: row no longer matches WHERE
              // (status changed by the racing tx).
              returning: () => Promise.resolve([]),
            }),
          }),
        }),
        insert: () => {
          throw new Error("insert should not be called when archived row was found");
        },
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

- [ ] **Step 1.4: Write failing test — archived-revive maps 23505 to conflict (3-way race)**

Append to the same describe block:

```ts
it("maps 23505 on revive UPDATE to 409 (3-way race: archive + insert published + revive)", async () => {
  // C2 specific scenario: between SELECT-archived and revive-UPDATE, a
  // concurrent tx inserted a new published row for the same team. Our
  // revive UPDATE flips the archived row to published, producing two
  // 'published' rows → partial unique index fires → 23505. Wrap in
  // try/catch to map to 409.
  let selectCalls = 0;
  const db: any = {
    transaction: async (cb: any) => {
      const tx: any = {
        select: () => ({
          from: () => ({
            where: () => {
              const idx = selectCalls++;
              if (idx === 0) return Promise.resolve([]); // no published
              if (idx === 1)
                return Promise.resolve([{ id: "coord-1", status: "archived" }]);
              return Promise.resolve([]);
            },
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: () => {
                const err = Object.assign(new Error("dup"), { code: "23505" });
                throw err;
              },
            }),
          }),
        }),
        insert: () => {
          throw new Error("insert should not be called when archived row was found");
        },
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

- [ ] **Step 1.5: Run tests to verify all 3 fail**

```bash
pnpm vitest run server/src/__tests__/team-coordination-service.test.ts
```

Expected: 3 new tests fail. Existing 10 tests still pass.

- [ ] **Step 1.6: Implement the fix**

Edit `server/src/services/team-coordination.ts`. Replace the published-update branch (lines 38-50) with:

```ts
if (existingPublished.length > 0) {
  const updated = await tx
    .update(teamCoordinations)
    .set({
      name: input.name,
      description: input.description,
      markdown: input.markdown,
      updatedAt: new Date(),
    })
    .where(and(
      eq(teamCoordinations.id, existingPublished[0].id),
      // C1: re-check status in the WHERE — if a concurrent tx archived
      // the row between our SELECT and this UPDATE, updated.length === 0
      // and we surface a clean 409 rather than silently overwriting an
      // archived row with new content.
      eq(teamCoordinations.status, "published"),
    ))
    .returning();
  if (updated.length === 0) {
    throw conflict(
      `coordination for team ${input.teamId} was just archived by a concurrent request — retry`,
    );
  }
  return updated[0];
}
```

Replace the archived-revive branch (lines 61-74) with:

```ts
if (existingArchived.length > 0) {
  // C2: wrap the revive UPDATE in 23505 handling AND re-check status in
  // the WHERE. Two race shapes are possible:
  //   1. Concurrent tx revived this same archived row first → our
  //      WHERE-by-id-AND-status='archived' returns 0 rows → 409.
  //   2. Concurrent tx archived this row + inserted a NEW published row
  //      for the same team → our UPDATE flips the archived row to
  //      published, but the partial unique index fires because there's
  //      now two published rows for the same team → 23505 → 409.
  try {
    const revived = await tx
      .update(teamCoordinations)
      .set({
        status: "published",
        name: input.name,
        description: input.description,
        markdown: input.markdown,
        updatedAt: new Date(),
      })
      .where(and(
        eq(teamCoordinations.id, existingArchived[0].id),
        eq(teamCoordinations.status, "archived"),
      ))
      .returning();
    if (revived.length === 0) {
      throw conflict(
        `coordination for team ${input.teamId} was just revived by a concurrent request — retry`,
      );
    }
    return revived[0];
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
}
```

The insert path at lines 78-103 remains unchanged (already has 23505 handling).

- [ ] **Step 1.7: Run tests to verify all pass**

```bash
pnpm vitest run server/src/__tests__/team-coordination-service.test.ts
```

Expected: 13/13 pass (10 existing + 3 new).

- [ ] **Step 1.8: Run typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 1.9: Commit**

```bash
git add server/src/services/team-coordination.ts server/src/__tests__/team-coordination-service.test.ts
git commit -m "$(cat <<'EOF'
fix(teams): harden coord upsert against concurrent archive races

Comprehensive-review findings C1 + C2. Three race conditions in
team-coordination.upsert were missed by the per-task and cumulative
reviewers:

C1 (published-update): T1 SELECTs a published row, T2 archives it
between T1's SELECT and UPDATE, T1's UPDATE-by-id matches but the SET
clause doesn't touch status — silently overwrites the archived row's
name/markdown. C1 was actually pre-existing in main (verified by
inspecting BASE 3493ebf:team-coordination.ts) — the original 2-branch
upsert had the same shape. The recent hardening didn't introduce it
but also didn't fix it.

C2 (archived-revive): two race shapes. (a) Concurrent revive — the
revive UPDATE matches 0 rows because the racing tx already changed
status. (b) 3-way race — concurrent tx archived this row AND inserted
a NEW published row, so our revive flips this row to published →
partial unique index fires → 23505. C2 was introduced by Task 2's
new revive branch and was missed by Task 2's reviewer.

Fix shape (same for both branches):
1. Add eq(status, "...") to the UPDATE WHERE clause.
2. Check updated.length === 0 → throw conflict("...just archived/revived
   by a concurrent request — retry").
3. Wrap the revive UPDATE in a 23505 try/catch (same shape as the
   insert path) → conflict.

Three new vitest cases cover all three race scenarios. Existing
10 upsert tests still pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: UI cache invalidation gaps (C3)

**Finding:** C3 — `BuildFromScratchForm.tsx` and `ImportPreviewDialog.tsx` don't invalidate `queryKeys.projects.agents(parentProjectId)` after the atomic team-create flow, leaving the dept's agent dropdown stale until manual refresh.

**Files:**
- Modify: `ui/src/components/team/BuildFromScratchForm.tsx:164-184` (extend onSuccess invalidations)
- Modify: `ui/src/components/team/ImportPreviewDialog.tsx:78-107` (extend onSuccess invalidations — currently only invalidates `teams.list`)

- [ ] **Step 2.1: Read current onSuccess shape in BuildFromScratchForm**

```bash
sed -n '162,190p' "ui/src/components/team/BuildFromScratchForm.tsx"
```

Confirm onSuccess currently invalidates `teams.list`, `agents.list`, `projects.list`. Missing: `projects.agents(parentProjectId)`.

- [ ] **Step 2.2: Confirm queryKey shape in queryKeys.ts**

```bash
grep -n "agents" "ui/src/lib/queryKeys.ts" | head -10
```

Expected: line 44 (or thereabouts) defines `agents: (projectId: string) => ["projects", "agents", projectId] as const,`.

- [ ] **Step 2.3: Add the missing invalidate to BuildFromScratchForm**

Edit `ui/src/components/team/BuildFromScratchForm.tsx`. Locate the onSuccess at line 164. Append a 4th invalidate:

```tsx
onSuccess: (team) => {
  // P1-G: invalidate agents + projects caches too — newAgents created
  // server-side won't show up in the agents list / dept assignments
  // until queries refetch.
  queryClient.invalidateQueries({
    queryKey: queryKeys.teams.list(selectedCompanyId!),
  });
  queryClient.invalidateQueries({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
  });
  queryClient.invalidateQueries({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
  });
  // C3 (comprehensive-review fixup): the dept-detail page reads
  // queryKeys.projects.agents(projectId) for its agent dropdown — this
  // cache is independent of agents.list and projects.list and was
  // missed in the original Task 6 invalidation set.
  queryClient.invalidateQueries({
    queryKey: queryKeys.projects.agents(parentProjectId),
  });
  pushToast({
    title: "Team created",
    body: `"${team.name}" is ready.`,
    tone: "success",
  });
  handleOpenChange(false);
  navigate(`/team/teams/${team.slug}`);
},
```

- [ ] **Step 2.4: Read current onSuccess shape in ImportPreviewDialog**

```bash
sed -n '78,108p' "ui/src/components/team/ImportPreviewDialog.tsx"
```

Confirm onSuccess only invalidates `teams.list`. Missing: `agents.list`, `projects.list`, `projects.agents(parentProjectId)`.

- [ ] **Step 2.5: Extend ImportPreviewDialog onSuccess to full invalidate set**

Edit `ui/src/components/team/ImportPreviewDialog.tsx`. The current `queryClient.invalidateQueries({ queryKey: queryKeys.teams.list(selectedCompanyId!) })` at line 102-104 is the only invalidate. Replace with the full set:

```tsx
// C3 (comprehensive-review fixup): import installs may create new
// agents (rename / no-collision branches) and grants dept membership
// (replace branch). Match BuildFromScratchForm's invalidation set so
// the dept-detail page and agents list refetch after install.
queryClient.invalidateQueries({
  queryKey: queryKeys.teams.list(selectedCompanyId!),
});
queryClient.invalidateQueries({
  queryKey: queryKeys.agents.list(selectedCompanyId!),
});
queryClient.invalidateQueries({
  queryKey: queryKeys.projects.list(selectedCompanyId!),
});
queryClient.invalidateQueries({
  queryKey: queryKeys.projects.agents(parentProjectId),
});
```

- [ ] **Step 2.6: Write structural backstop test for the invalidation set**

Create `ui/src/components/team/__tests__/cache-invalidation-contract.test.ts` (or extend existing similar contract test if one is colocated). The test asserts each form's source contains the expected `queryKeys.projects.agents()` invalidate. Brittle but catches regressions cheaply (matches the RBAC structural backstop pattern from `server/src/__tests__/teams-routes-rbac.test.ts:351+`).

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// C3 structural backstop: prevents future regressions where the
// onSuccess invalidate set drops projects.agents() and reintroduces
// the stale dept-agent dropdown bug.
//
// We don't run the form behaviorally here — wiring up
// QueryClientProvider + render + fill + submit for a 1-line invalidate
// assertion is overkill. The structural test is the same pattern used
// for the RBAC source-structural backstops (teams-routes-rbac.test.ts).

describe("Team-create flows invalidate dept-agents cache (C3 backstop)", () => {
  it("BuildFromScratchForm onSuccess invalidates projects.agents()", () => {
    const src = readFileSync(
      resolve(__dirname, "../BuildFromScratchForm.tsx"),
      "utf8",
    );
    expect(src).toMatch(/queryKeys\.projects\.agents\(/);
  });

  it("ImportPreviewDialog onSuccess invalidates projects.agents()", () => {
    const src = readFileSync(
      resolve(__dirname, "../ImportPreviewDialog.tsx"),
      "utf8",
    );
    expect(src).toMatch(/queryKeys\.projects\.agents\(/);
  });

  it("ImportPreviewDialog onSuccess invalidates the full team-create set", () => {
    // Task 11 originally only invalidated teams.list. C3 fixup expanded
    // to match BuildFromScratchForm. Assert all 4 keys appear.
    const src = readFileSync(
      resolve(__dirname, "../ImportPreviewDialog.tsx"),
      "utf8",
    );
    expect(src).toMatch(/queryKeys\.teams\.list\(/);
    expect(src).toMatch(/queryKeys\.agents\.list\(/);
    expect(src).toMatch(/queryKeys\.projects\.list\(/);
    expect(src).toMatch(/queryKeys\.projects\.agents\(/);
  });
});
```

- [ ] **Step 2.7: Run the new test to verify it passes**

```bash
pnpm vitest run ui/src/components/team/__tests__/cache-invalidation-contract.test.ts
```

Expected: 3/3 pass (after Steps 2.3 + 2.5 added the invalidates).

(If the test was written BEFORE the source edits in 2.3 + 2.5, re-order: write the test first, run to verify FAIL, then apply 2.3 + 2.5, then run to verify PASS — strict TDD red→green.)

- [ ] **Step 2.8: Run UI typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 2.9: Commit**

```bash
git add ui/src/components/team/BuildFromScratchForm.tsx ui/src/components/team/ImportPreviewDialog.tsx ui/src/components/team/__tests__/cache-invalidation-contract.test.ts
git commit -m "$(cat <<'EOF'
fix(teams): invalidate dept-agents cache after atomic team-create flows

Comprehensive-review finding C3. After Task 6's atomic
team-create-with-newAgents and Task 11's team-import flow, the UI's
onSuccess invalidations missed queryKeys.projects.agents(parentProjectId)
— the cache the dept-detail page reads for its agent dropdown. Result:
founder creates a team with newAgents, navigates to the parent dept,
sees stale agent list until manual refresh or 60s staleTime expiry.

BuildFromScratchForm: add the missing invalidate (had 3, needed 4).

ImportPreviewDialog: had only teams.list invalidated. Extend to match
BuildFromScratchForm's full set (teams + agents + projects +
projects.agents). The import flow can create agents (rename + new
branches) and grant dept membership (replace branch — see Task 11
warnings), so the same invalidation surface applies.

Structural backstop test: cache-invalidation-contract.test.ts asserts
both forms' source contains queryKeys.projects.agents() and that
ImportPreviewDialog has the full 4-key invalidate set. Same pattern
as the RBAC source-structural tests in teams-routes-rbac.test.ts —
catches "someone deletes the invalidate later" regressions cheaply.

Behavioral testing (mount form + spy on queryClient + fire mutation)
is out of scope; the codebase has no UI cache-invalidation behavioral
test pattern, and adding one is its own task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Defensive parity fix in team-imports log line (L12)

**Finding:** L12 — `server/src/routes/team-imports.ts:171` reads `team.warnings.length` without optional chaining. Same shape as the regression Phase 4 caught in `teams-routes-rbac.test.ts`. The response body at line 186 uses `team.warnings ?? []` defensively — the log line should match.

**Files:**
- Modify: `server/src/routes/team-imports.ts:171` (1-line change)

- [ ] **Step 3.1: Read current log line**

```bash
sed -n '163,175p' "server/src/routes/team-imports.ts"
```

Confirm line 171 reads `warningCount: team.warnings.length`.

- [ ] **Step 3.2: Write failing test — install route doesn't crash when service returns shape without `warnings`**

Read the existing harness in `server/src/__tests__/team-imports-routes-contract.test.ts` first (its mock pattern for `importSvc.install`). Then append a test:

```ts
it("install route is robust when service returns object without warnings (L12 backstop)", async () => {
  // L12: Phase 4 caught a regression where the install route's log line
  // accessed team.warnings.length without optional chaining, while the
  // response body used team.warnings ?? [] defensively. If a future
  // service change (or test mock drift) returns an object without the
  // warnings field, the log line should NOT throw before the response
  // is sent — same shape as the regression that broke
  // teams-routes-rbac.test.ts:341.
  mockImportService.install.mockResolvedValueOnce({
    id: "t-1",
    slug: "team-1",
    name: "Team 1",
    parentProjectId: DEPT_A,
    // Note: deliberately NO `warnings` field
  } as never);

  const app = await createApp();
  const res = await request(app)
    .post(`/api/companies/${COMPANY_ID}/teams/_imports/install`)
    .send({
      yamlContent: "schemaVersion: '1.0'\n",
      collisions: {},
      parentProjectId: DEPT_A,
    });

  // Must not be 500. Pre-fix: TypeError reading undefined.length → 500.
  // Post-fix: log line uses warnings?.length ?? 0 → 201 with response
  // body still containing warnings: [] from the route's `?? []` default.
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.warnings).toEqual([]);
});
```

The exact mock-name (`mockImportService` vs whatever the file uses) and the harness shape (`createApp`, `COMPANY_ID`, `DEPT_A` constants) should match the existing test file. Read the file first to align the test with its conventions.

- [ ] **Step 3.3: Run test to verify it FAILS**

```bash
pnpm vitest run server/src/__tests__/team-imports-routes-contract.test.ts
```

Expected: the new test FAILS with a 500 response body (TypeError reading `undefined.length`). All other tests still pass.

- [ ] **Step 3.4: Apply the defensive parity fix**

Edit `server/src/routes/team-imports.ts:171`. Change:

```ts
warningCount: team.warnings.length,
```

To:

```ts
// L12 (comprehensive-review fixup): match the response body's `?? []`
// defense (line 186). If the service ever returns an unmodelled shape
// (test mock drift, future regression), this log line shouldn't be
// the thing that throws TypeError → 500 before the response is sent.
warningCount: team.warnings?.length ?? 0,
```

- [ ] **Step 3.5: Run test to verify it PASSES**

```bash
pnpm vitest run server/src/__tests__/team-imports-routes-contract.test.ts
```

Expected: all tests pass (the new test now resolves with 201).

- [ ] **Step 3.6: Run typecheck + broader targeted tests**

```bash
pnpm typecheck
pnpm vitest run server/src/__tests__/team-import-service.test.ts server/src/__tests__/team-imports-routes-contract.test.ts
```

Expected: clean + all pass.

- [ ] **Step 3.7: Commit**

```bash
git add server/src/routes/team-imports.ts
git commit -m "$(cat <<'EOF'
fix(teams): defensive optional-chain on team-imports log warningCount

Comprehensive-review finding L12. Line 171 reads team.warnings.length
without optional chaining, while the response body at line 186 uses
team.warnings ?? [] defensively. Same shape as the regression Phase 4
caught in teams-routes-rbac.test.ts:341 (mock fixture missing
warnings field → log line throws TypeError → 500 before response is
sent).

Match the response body's defense: `team.warnings?.length ?? 0`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Centralize 23505 detection + fix latent bug in documents.ts (D1)

**Finding:** D1 — the 23505 detection idiom appears 7× across services with two incompatible shapes. `documents.ts:16` has an `isUniqueViolation()` helper but it's missing the `cause.code` fallback — under-detects unique violations from drizzle's wrapped error path. Latent bug in main.

**Files:**
- Create: `server/src/services/db-errors.ts` (new)
- Create: `server/src/__tests__/db-errors.test.ts` (new)
- Modify: `server/src/services/teams.ts` (4 sites: lines 79-83, 425, 514-517 inside `insertTeamWithUniqueSlug` retry loop, and the `updateMemberRole` 23505 catch)
- Modify: `server/src/services/team-coordination.ts` (1 site: the insert path's 23505 catch — Task 1's revive 23505 catch will also use the helper after Task 1 lands)
- Modify: `server/src/services/documents.ts:16-18` (replace local helper with shared import)

**Why this order:** Task 1 introduces a NEW 23505 catch (revive path). Doing Task 4 after Task 1 means the helper sweep covers the new site too, in one pass.

- [ ] **Step 4.1: Write failing test for the new helper**

Create `server/src/__tests__/db-errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "../services/db-errors.js";

describe("isUniqueViolation", () => {
  it("detects 23505 on err.code", () => {
    const err = Object.assign(new Error("dup"), { code: "23505" });
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("detects 23505 on err.cause.code (drizzle-wrapped)", () => {
    const inner = Object.assign(new Error("dup"), { code: "23505" });
    const wrapped = Object.assign(new Error("wrapped"), { cause: inner });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("returns false for non-unique errors (e.g. 23503 FK violation)", () => {
    const err = Object.assign(new Error("fk"), { code: "23503" });
    expect(isUniqueViolation(err)).toBe(false);
  });

  it("returns false for plain errors with no code", () => {
    expect(isUniqueViolation(new Error("plain"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("string")).toBe(false);
    expect(isUniqueViolation(42)).toBe(false);
  });

  it("matches a specific constraint name when provided", () => {
    const err = Object.assign(new Error("dup"), {
      code: "23505",
      constraint: "team_members_one_lead_uq",
    });
    expect(isUniqueViolation(err, "team_members_one_lead_uq")).toBe(true);
    expect(isUniqueViolation(err, "different_constraint")).toBe(false);
  });

  it("matches constraint on err.cause when provided (drizzle-wrapped)", () => {
    const inner = Object.assign(new Error("dup"), {
      code: "23505",
      constraint: "team_coordinations_one_published_uq",
    });
    const wrapped = Object.assign(new Error("wrapped"), { cause: inner });
    expect(
      isUniqueViolation(wrapped, "team_coordinations_one_published_uq"),
    ).toBe(true);
  });

  it("falls back to true when constraint is undefined and code matches", () => {
    const err = Object.assign(new Error("dup"), { code: "23505" });
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(err, undefined)).toBe(true);
  });
});
```

- [ ] **Step 4.2: Run test to verify failure**

```bash
pnpm vitest run server/src/__tests__/db-errors.test.ts
```

Expected: file not found / module not found error (helper doesn't exist yet).

- [ ] **Step 4.3: Create the helper**

Create `server/src/services/db-errors.ts`:

```ts
/**
 * Detect a PostgreSQL unique-constraint violation (SQLSTATE 23505).
 *
 * The error code may live on the top-level error or on `err.cause`
 * because drizzle-orm wraps some PG errors when going through the
 * postgres-js adapter. This helper checks both paths so callers don't
 * have to.
 *
 * Optional `constraint` arg lets callers narrow to a specific index
 * name (e.g. `team_members_one_lead_uq`) — useful when one transaction
 * could throw 23505 from multiple indexes and only one of them
 * corresponds to the conflict the caller wants to convert to a 409.
 *
 * @example Basic usage
 * try {
 *   await tx.insert(teams).values({...});
 * } catch (err) {
 *   if (isUniqueViolation(err)) throw conflict("...");
 *   throw err;
 * }
 *
 * @example Constraint-specific matching
 * if (isUniqueViolation(err, "team_coordinations_one_published_uq")) {
 *   throw conflict("coordination already published");
 * }
 */
export function isUniqueViolation(
  err: unknown,
  constraint?: string,
): boolean {
  if (!err || typeof err !== "object") return false;
  const code =
    (err as { code?: string }).code ??
    (err as { cause?: { code?: string } }).cause?.code;
  if (code !== "23505") return false;
  if (constraint === undefined) return true;
  const cName =
    (err as { constraint?: string }).constraint ??
    (err as { cause?: { constraint?: string } }).cause?.constraint;
  return cName === constraint;
}
```

- [ ] **Step 4.4: Run test to verify pass**

```bash
pnpm vitest run server/src/__tests__/db-errors.test.ts
```

Expected: 8/8 pass.

- [ ] **Step 4.5: Refactor `teams.ts` to use the helper (4 sites)**

Edit `server/src/services/teams.ts`. Add the import near the existing imports:

```ts
import { isUniqueViolation } from "./db-errors.js";
```

Find each of the 4 inline 23505 detection sites (search for `(err as { code?: string }).code`). At each site, replace the inline pattern:

```ts
const code =
  (err as { code?: string }).code ??
  (err as { cause?: { code?: string } }).cause?.code;
if (code === "23505") {
  throw conflict("...");
}
throw err;
```

With:

```ts
if (isUniqueViolation(err)) {
  throw conflict("...");
}
throw err;
```

The 4 sites in `teams.ts` (locations may have shifted by ~5-10 lines after Task 1; search by pattern):
1. `insertTeamWithUniqueSlug` retry loop (around line 79-83)
2. `addMember` 23505 catch (around line 425)
3. `updateMemberRole` 23505 catch (around line 514-517)
4. (No 4th in `teams.ts` — Codex review counted across multiple files)

Adjust the count if you find fewer than 4 sites in teams.ts; the goal is "every inline 23505 detection in this file uses the helper."

- [ ] **Step 4.6: Refactor `team-coordination.ts` to use the helper (2 sites after Task 1)**

Edit `server/src/services/team-coordination.ts`. Add the import:

```ts
import { isUniqueViolation } from "./db-errors.js";
```

Replace the 2 inline 23505 catches:
1. The revive UPDATE 23505 catch (added by Task 1)
2. The insert path 23505 catch (existing pre-Task-1)

Pattern same as Step 4.5.

- [ ] **Step 4.7: Fix `documents.ts` latent bug**

Edit `server/src/services/documents.ts:16-18`. The current local helper:

```ts
function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505";
}
```

Is missing the `err.cause.code` fallback. Replace with an import from the new module:

```ts
import { isUniqueViolation } from "./db-errors.js";
```

Delete the local function definition. All call sites continue to work — the new helper has the same simple `isUniqueViolation(err)` shape.

- [ ] **Step 4.8: Add a documents.ts consumer-side test that exercises the cause.code path**

The 8 helper tests in Step 4.1 verify `isUniqueViolation` directly. We also need a test at the documents.ts CONSUMER layer that proves the under-detection bug is actually fixed in the path where it matters.

First, find the existing documents test file:

```bash
ls server/src/__tests__/ | grep -i docu
```

If `documents-service.test.ts` (or similar) exists, append the test below to its existing `describe` block. If no documents test file exists, create `server/src/__tests__/documents-service.test.ts` and seed it with the standard mock pattern (copy the `vi.mock("drizzle-orm", ...)` and `vi.mock("@armyofagents/db", ...)` blocks from `team-coordination-service.test.ts:1-23` and adapt for the `documents` table).

The test:

```ts
it("converts drizzle-wrapped 23505 (cause.code) to a clean conflict (D1 documents.ts fix)", async () => {
  // D1: pre-fix, documents.ts had a local isUniqueViolation() that
  // only checked err.code — missing the err.cause.code fallback that
  // drizzle-orm uses when wrapping the underlying postgres-js error.
  // Result: drizzle-wrapped 23505 errors fell through to the generic
  // 500 path instead of being mapped to 409 Conflict.
  //
  // Post-fix: documents.ts uses the shared isUniqueViolation() helper
  // which checks both err.code AND err.cause.code, so wrapped errors
  // are correctly detected.
  //
  // This test simulates the wrapped shape and asserts the conflict
  // path is hit. The test name is the regression-prevention contract:
  // if a future change reverts to a code-only check, this test fails.
  const wrappedErr = Object.assign(new Error("wrapped"), {
    cause: Object.assign(new Error("dup"), { code: "23505" }),
  });

  const db: any = {
    insert: () => ({
      values: () => ({
        returning: () => {
          throw wrappedErr;
        },
      }),
    }),
    // ... add other mock methods needed for the call path that hits
    // documents.ts's 23505 catch — match whichever method in
    // documentsService throws on duplicate. Read documents.ts to find
    // the call site and shape the mock accordingly.
  };

  // Call whichever documentsService method has the 23505 catch wired up
  // (likely a create or upsert variant). Assert it rejects with status 409.
  await expect(
    documentsService(db).create(/* ...minimal args... */),
  ).rejects.toMatchObject({ status: 409 });
});
```

NOTE on test author guidance: read `server/src/services/documents.ts` first to identify which method calls `isUniqueViolation` and what its inputs are. Match the test's mock + call shape to that. The exact arg list above is a placeholder — the implementer should fill in the real call signature based on the service's API.

- [ ] **Step 4.9: Run the new test to verify pass**

```bash
pnpm vitest run server/src/__tests__/documents-service.test.ts
```

Expected: pass. The post-fix helper detects `cause.code === "23505"` and the service throws `conflict()` (which carries `status: 409`).

(If you wanted strict TDD red→green for this fix: write the test BEFORE Step 4.7's edit, run to confirm it fails (the local helper misses cause.code → no conflict → some other error or 500), then apply 4.7, then run to confirm it passes. Either ordering is acceptable since the helper unit tests in Step 4.1 already prove the fix works at the helper level — the documents-side test is a regression-prevention add.)

- [ ] **Step 4.10: Run all impacted tests**

```bash
pnpm vitest run server/src/__tests__/db-errors.test.ts \
  server/src/__tests__/teams-service.test.ts \
  server/src/__tests__/team-coordination-service.test.ts \
  server/src/__tests__/team-import-service.test.ts \
  server/src/__tests__/documents.test.ts
```

Expected: all pass. The refactor is a pure renaming — no behavior change for the team services, and `documents.ts` now correctly detects unique violations from drizzle-wrapped errors (previously under-detecting).

- [ ] **Step 4.11: Run typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 4.12: Commit**

```bash
git add server/src/services/db-errors.ts \
        server/src/services/teams.ts \
        server/src/services/team-coordination.ts \
        server/src/services/documents.ts \
        server/src/__tests__/db-errors.test.ts \
        server/src/__tests__/documents-service.test.ts
git commit -m "$(cat <<'EOF'
refactor(server): centralize 23505 detection + fix documents.ts latent bug

Comprehensive-review finding D1. The (err.code ?? err.cause?.code)
== '23505' idiom appeared 7× across services with two incompatible
shapes. documents.ts:16 had an isUniqueViolation() helper but it was
missing the err.cause.code fallback — under-detecting unique
violations when drizzle-orm wraps the underlying postgres-js error.
Pre-existing latent bug in main.

This commit:
1. Extracts the canonical helper to server/src/services/db-errors.ts
   with optional constraint-name matching for callers that need to
   distinguish multiple unique indexes.
2. Refactors 7 inline detection sites (teams.ts × 3, team-coordination.ts
   × 2, plus documents.ts) to use the helper.
3. Fixes the documents.ts under-detection bug as a side effect of the
   refactor (the helper now covers err.cause.code).

8 new vitest cases for the helper cover both code paths, constraint
matching, and edge cases (null, undefined, non-Error values, FK
violations).

Out of scope: companies.ts:70, routines.ts:689, plugin-registry.ts:42
also have inline 23505 detection in their own variants; flagged for
follow-up. This commit covers the Teams subsystem + documents.ts fix.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Migration safety — pre-flight cleanup for production duplicates (I1)

**Finding:** I1 — `0069_wide_earthquake.sql`'s `CREATE UNIQUE INDEX ... WHERE status = 'published'` will fail on production data if any team has duplicate published rows from the pre-Task-1 TOCTOU race. Single-tenant deploys: zero risk. Multi-tenant Hosted: real risk.

**Files:**
- Modify: `packages/db/src/migrations/0069_wide_earthquake.sql` (prepend cleanup statement)

**Note:** CLAUDE.md says "NEVER write raw SQL migration files." This task is an explicit, justified exception — we're appending a defensive cleanup statement to a drizzle-kit-generated file, not authoring a new migration from scratch. The cleanup is idempotent and safe (worst case: zero rows affected).

- [ ] **Step 5.1: Read current migration**

```bash
cat "packages/db/src/migrations/0069_wide_earthquake.sql"
```

Confirm 3 statements: CREATE UNIQUE INDEX + 2 ALTER TABLE ADD CONSTRAINT.

- [ ] **Step 5.2: Write failing structural test for the cleanup CTE**

Create `server/src/__tests__/migration-0069-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// I1 (comprehensive-review fixup) regression-prevention. The migration
// at 0069_wide_earthquake.sql adds a partial unique index that will
// abort with 23505 on production clusters that have pre-existing
// duplicate published rows from the pre-Task-1 TOCTOU race. The
// cleanup statement archives all but the most-recent published row
// per team BEFORE the index creation runs.
//
// Full integration testing (apply migration to a real cluster with
// duplicate rows, assert the cleanup actually deduplicates) requires
// new test infrastructure. This structural test catches the bare
// minimum: cleanup statement exists, has the right shape, and
// precedes the unique index creation.
//
// If a future contributor deletes the cleanup or moves it after the
// index, this test fails — the intent was to prevent exactly that
// regression.

const MIGRATION_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/0069_wide_earthquake.sql",
);

describe("Migration 0069 — pre-flight cleanup (I1 backstop)", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("contains a ROW_NUMBER() OVER (PARTITION BY team_id) windowed dedupe", () => {
    expect(sql).toMatch(/ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION BY team_id/i);
  });

  it("archives duplicate published rows (UPDATE ... SET status = 'archived')", () => {
    expect(sql).toMatch(/UPDATE\s+team_coordinations[\s\S]+SET status\s*=\s*'archived'/i);
  });

  it("orders the cleanup by updated_at DESC, created_at DESC", () => {
    // Keeps the most-recent published row, archives the older duplicate(s).
    expect(sql).toMatch(/ORDER BY updated_at DESC, created_at DESC/i);
  });

  it("filters cleanup to status = 'published' rows only", () => {
    // The CTE's source table predicate must scope to published rows;
    // archived rows already abide by the invariant.
    expect(sql).toMatch(/WHERE status\s*=\s*'published'/);
  });

  it("the cleanup runs BEFORE the CREATE UNIQUE INDEX statement", () => {
    // Critical ordering invariant: dedupe → then index. Reversed, the
    // index creation aborts before the cleanup gets a chance to run.
    const cleanupIdx = sql.search(/UPDATE\s+team_coordinations\s+SET status\s*=\s*'archived'/i);
    const indexIdx = sql.search(/CREATE UNIQUE INDEX\s+"team_coordinations_one_published_uq"/);
    expect(cleanupIdx).toBeGreaterThanOrEqual(0);
    expect(indexIdx).toBeGreaterThanOrEqual(0);
    expect(cleanupIdx).toBeLessThan(indexIdx);
  });

  it("preserves the original 3 generated statements unchanged", () => {
    // Cleanup is ADDITIVE — must not have replaced the drizzle-kit-
    // generated statements.
    expect(sql).toMatch(/CREATE UNIQUE INDEX\s+"team_coordinations_one_published_uq"\s+ON\s+"team_coordinations"\s+USING btree\s*\("team_id"\)\s+WHERE status\s*=\s*'published'/);
    expect(sql).toMatch(/ALTER TABLE\s+"teams"\s+ADD CONSTRAINT\s+"teams_status_check"\s+CHECK \(status IN \('active', 'archived'\)\)/);
    expect(sql).toMatch(/ALTER TABLE\s+"team_coordinations"\s+ADD CONSTRAINT\s+"team_coordinations_status_check"\s+CHECK \(status IN \('draft', 'published', 'archived'\)\)/);
  });
});
```

- [ ] **Step 5.3: Run test to verify it FAILS**

```bash
pnpm vitest run server/src/__tests__/migration-0069-contract.test.ts
```

Expected: FAIL on the cleanup-related assertions (the migration doesn't have the cleanup yet). The "preserves the original 3 generated statements" check should still pass.

- [ ] **Step 5.4: Prepend the pre-flight cleanup statement**

Edit `packages/db/src/migrations/0069_wide_earthquake.sql`. Insert the cleanup at the top, before the existing CREATE UNIQUE INDEX:

```sql
-- I1 (comprehensive-review fixup): pre-flight cleanup for pre-existing
-- TOCTOU duplicates. The team_coordinations.upsert path was vulnerable
-- to two concurrent transactions both inserting a 'published' row for
-- the same team before this index existed. Any production cluster that
-- ran the prior code AND saw such a race will have duplicate published
-- rows; this CREATE UNIQUE INDEX would then abort with 23505.
--
-- The cleanup archives all but the most-recent published row per team.
-- Idempotent: zero rows affected on clean clusters (single-tenant or
-- never-raced multi-tenant). Safe: archived rows preserve all content
-- and can be revived via teamCoordinationService.upsert if needed.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY team_id
    ORDER BY updated_at DESC, created_at DESC
  ) AS rn
  FROM team_coordinations
  WHERE status = 'published'
)
UPDATE team_coordinations
SET status = 'archived', updated_at = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "team_coordinations_one_published_uq" ON "team_coordinations" USING btree ("team_id") WHERE status = 'published';--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_status_check" CHECK (status IN ('active', 'archived'));--> statement-breakpoint
ALTER TABLE "team_coordinations" ADD CONSTRAINT "team_coordinations_status_check" CHECK (status IN ('draft', 'published', 'archived'));
```

(The original 3 statements remain unchanged after the cleanup.)

- [ ] **Step 5.5: Run the structural test to verify it PASSES**

```bash
pnpm vitest run server/src/__tests__/migration-0069-contract.test.ts
```

Expected: 6/6 pass (cleanup assertions now satisfied; original-statements check still passes).

- [ ] **Step 5.6: Verify the migration parses correctly**

```bash
# Parse the SQL with a lightweight check — drizzle-kit reads this file
# during `pnpm db:generate`. Run a no-op generate to confirm parse:
pnpm db:generate --dry-run 2>&1 | tail -10
```

If `--dry-run` isn't supported, just verify the file is well-formed by re-running `pnpm db:generate` (the drizzle-kit run should detect no schema changes since the schema files weren't modified).

Expected: no errors, no new migration files generated.

- [ ] **Step 5.7: Verify migration applies cleanly to a fresh local DB**

The local embedded-postgres cluster will replay all migrations on next server start. Stop the server (if running), then start it back up:

```bash
pnpm dev:server  # or whatever the project uses to start the server
```

Expected: server starts, migrations apply, no errors. The 0069 cleanup statement affects 0 rows on a fresh cluster (no published rows to dedupe yet).

- [ ] **Step 5.8: Run full test suite to confirm nothing else broke**

```bash
pnpm vitest run server/src/__tests__/team-coordination-service.test.ts \
  server/src/__tests__/teams-service.test.ts \
  server/src/__tests__/heartbeat-team-coordination.test.ts \
  server/src/__tests__/migration-0069-contract.test.ts
```

Expected: all pass.

- [ ] **Step 5.9: Commit**

```bash
git add packages/db/src/migrations/0069_wide_earthquake.sql server/src/__tests__/migration-0069-contract.test.ts
git commit -m "$(cat <<'EOF'
fix(teams): pre-flight cleanup in migration 0069 for prod TOCTOU duplicates

Comprehensive-review finding I1. The team_coordinations.upsert path
was TOCTOU-vulnerable before Task 1 added the partial unique index
team_coordinations_one_published_uq. Any production cluster that ran
the prior code AND saw two concurrent upserts both inserting a
'published' row for the same team will have duplicate rows in the
database. When this migration's CREATE UNIQUE INDEX runs against
that data, Postgres aborts with:

  ERROR: could not create unique index ...
  Key (team_id)=(...) is duplicated

leaving the migration half-applied and the server unable to start.

Pre-flight cleanup: archive all but the most-recent published row per
team. Idempotent (0 rows affected on clean clusters). Safe (archived
rows preserve all content; can be revived via Task 2's revive path
in teamCoordinationService.upsert).

CLAUDE.md says "NEVER write raw SQL migration files" — this is an
explicit exception, justified because we're appending defensive
cleanup to a drizzle-kit-generated file (not authoring a new
migration). The cleanup statement is added at the top, before the
3 generated statements, with a `--> statement-breakpoint` separator.

Single-tenant local-trusted deployments: zero exposure (founder can't
realistically race themselves). Multi-tenant Cloud Hosted: real
exposure that scales with concurrency.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Documentation — soften ReDoS comment + add deferred items to plan (I2 + I3 + I4 + L1 false positive)

**Findings:**
- I2: ReDoS heuristic comment overclaims ("every published example of CWE-1333"). Reality: bypasses exist (`(a+){10,}`, `(a|aa)+`, `((a+))+`). Today this is inert (regex never executed); tomorrow's evaluator inherits the false sense of safety.
- I3: Approval-gate bypass for inline newAgents — documented design choice in Task 6; should also be noted in the Teams hardening plan's "deferred" section so future readers understand it's deliberate.
- I4: Read routes lack dept-scope — plan-level scope decision (writes only). Document explicitly so future readers can revisit when Hosted lands.
- L1: Reviewer claim that `updateMemberRole` demote loop should `break` after first — verified false positive (loop correctly demotes ALL existing leads). Note in plan so the next reviewer doesn't repeat the misread.

**Files:**
- Modify: `packages/shared/src/teams.ts` (around lines 99-130 — soften the ReDoS heuristic comment)
- Modify: `docs/superpowers/plans/2026-04-30-teams-feature-hardening.md` (extend "Deferred" section)

- [ ] **Step 6.1: Read the current ReDoS heuristic comment**

```bash
sed -n '95,135p' "packages/shared/src/teams.ts"
```

Confirm the comment around lines 99-103 says something like "every published example of CWE-1333" or similar overclaiming text.

- [ ] **Step 6.2: Soften the comment**

Edit `packages/shared/src/teams.ts`. Find the comment block above the heuristic regex (the one starting with "Reject the most common ReDoS shape" or similar). Replace its tail with:

```ts
    // Reject the most common ReDoS shape: nested quantifier directly inside
    // a group whose contents are themselves quantified. Examples that ARE
    // caught:
    //   (a+)+   (a*)+   (a+)*   (a+)?   ([abc]+)+
    //
    // I2 (comprehensive-review fixup): this is a coarse heuristic. KNOWN
    // BYPASSES — the heuristic does NOT catch:
    //   (a+){10,}     — braced quantifier (curly-brace shapes)
    //   (a|aa)+       — alternation overlap
    //   ((a+))+       — double-wrapped group
    //   [a-z]+(?=…)   — lookahead with quantifier
    //
    // Today (this commit's HEAD), `rule.match` is only embedded as text
    // in scaffolder markdown — never compiled to a runtime evaluator —
    // so the bypasses are inert. THE FIRST FEATURE THAT WIRES rule.match
    // INTO A REAL EVALUATOR MUST replace this heuristic with re2-wasm or
    // a proper static-analysis pass; do not trust this check alone.
    if (/\([^)]*[+*][^)]*\)[+*?]/.test(rule.match)) {
```

(The regex itself is unchanged — only the comment wording.)

- [ ] **Step 6.3: Run the manifest tests to confirm comment-only change didn't break anything**

```bash
pnpm vitest run server/src/__tests__/team-manifest.test.ts
```

Expected: 12/12 pass (same as before).

- [ ] **Step 6.4: Extend the hardening plan's deferred section**

Edit `docs/superpowers/plans/2026-04-30-teams-feature-hardening.md`. Find the "Deferred (explicitly)" section near the top of the plan. Append:

```markdown
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
```

- [ ] **Step 6.5: Commit**

```bash
git add packages/shared/src/teams.ts docs/superpowers/plans/2026-04-30-teams-feature-hardening.md
git commit -m "$(cat <<'EOF'
docs(teams): soften ReDoS heuristic comment + document deferred review findings

Comprehensive-review findings I2 + I3 + I4 + L1 false-positive.

I2: the ReDoS heuristic in packages/shared/src/teams.ts had a comment
claiming it catches "every published example of CWE-1333" — verified
false by manual testing. Bypasses include braced quantifiers
((a+){10,}), alternation overlap ((a|aa)+), double-wrapped groups
(((a+))+), and lookahead-with-quantifier shapes. Today the regex is
only embedded as markdown text (never compiled to a runtime
evaluator), so the bypasses are inert. The comment is softened to
flag the bypasses and warn future maintainers that any runtime
evaluator MUST replace the heuristic with re2-wasm or proper
static analysis.

I3: documented in the hardening plan's "Deferred" section. The
atomic team-create-with-newAgents path bypasses the
requireBoardApprovalForNewAgents gate by design (Task 6 fixup);
matches the team-import precedent. Revisit when multi-tenant
Hosted lands.

I4: documented in the same section. Read routes lack dept-scope by
plan-level scope decision (Task 4 was writes-only). For single-tenant
this is nil-impact; for Cloud Hosted multi-employee companies this is
real disclosure. Revisit per V3 Decision #80.

L1 false-positive note: the performance reviewer claimed the
updateMemberRole demote loop should break after the first lead.
Verified false — the loop correctly demotes ALL existing leads.
Plan now flags this so the next reviewer doesn't repeat the misread.

No production behavior change in this commit. Documentation only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist (run after writing the plan)

**1. Spec coverage:**
- [x] C1 (published-update race) — Task 1
- [x] C2 (archived-revive race) — Task 1
- [x] C3 (cache invalidation) — Task 2
- [x] L12 (warningCount log line) — Task 3
- [x] D1 (centralize 23505 + fix documents.ts) — Task 4
- [x] I1 (migration safety) — Task 5
- [x] I2 (ReDoS comment) — Task 6
- [x] I3 (approval-gate doc) — Task 6
- [x] I4 (read-routes doc) — Task 6
- [x] L1 (false-positive doc) — Task 6

**Audit-deferred (not in this plan):** D2, D3, D4, D5, L2-L11. Listed in the file-structure preamble for transparency.

**2. Placeholder scan:** None of the steps say "TODO", "fill in details", "add appropriate error handling", "similar to Task N". Every step has either an exact command, an exact code block, or an exact substitution. ✅

**3. Type consistency:**
- `isUniqueViolation(err, constraint?)` — defined in Task 4 Step 4.3, used in Tasks 4 (refactor sites). Optional second arg consistent with the test cases. ✅
- `parentProjectId` — referenced in Task 2 (UI) — confirmed present in both `BuildFromScratchForm` form state and `ImportPreviewDialog` props. ✅
- `team.warnings` — Task 3 fix uses `?.length ?? 0` matching Task 11's response body's `?? []`. ✅

**4. Commit boundaries:** 6 commits, each scoped to one logical theme. Tasks 4 + 1 ordered so Task 1's new 23505 catch is part of Task 4's sweep — no rework. ✅

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-30-teams-comprehensive-review-fixups.md`.**

**Recommended:** subagent-driven-development. ~6 implementer dispatches + 12 reviewer dispatches across the 6 tasks. Per-task tests are scoped to known files; cross-task coupling is minimal (Task 4's helper is consumed by Tasks 1's new catch — Task 1 lands first with inline pattern, then Task 4 sweeps it along with the others).

**Test coverage** (post-tightening — every behavioral change has at least a regression-prevention test):
- Task 1: 3 new behavioral tests (race scenarios) with strict TDD red→green
- Task 2: 3 new structural backstop tests (matches RBAC source-structural pattern)
- Task 3: 1 new behavioral test (install route survives missing `warnings` field) with TDD red→green
- Task 4: 8 new behavioral tests for the helper + 1 consumer-side test in documents-service
- Task 5: 6 new structural tests asserting cleanup CTE shape + ordering with TDD red→green
- Task 6: documentation only (existing tests verify no regression)

Total: **22 new tests** across 5 files + the existing test suite continues to pass.

Total estimated LOC: ~200 across 9 files (5 service/test, 3 UI/UI-test, 1 migration + 1 migration-test, 1 plan doc). Estimated subagent time: 40-60 minutes (slightly longer than original estimate due to the additional test coverage).

After all 6 tasks land, push to `origin/feat/teams` again to trigger Codex re-review on the post-fix state.
