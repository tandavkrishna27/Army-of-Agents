# Marketplace P1 Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two P1 bugs found in Codex review of PR #94 — skills silently stopping updates after first apply/dismiss, and team install crashing when required skills are already installed.

**Architecture:** Both fixes are targeted surgical changes inside existing functions — no new files, no schema changes, no migrations. Task 1 adds a post-conflict SELECT to `upsertPendingUpdate` so it can re-open `applied`/`dismissed` rows for new catalog versions. Task 2 adds `.onConflictDoNothing()` to the Phase 3 skill insert in `installTeam` and handles the empty-returning case so the overall transaction succeeds.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest, Express — all pre-existing.

---

## File Map

| File | Change |
|------|--------|
| `server/src/services/marketplace-update-checker.ts` | Replace `upsertPendingUpdate` body (lines 148–194) |
| `server/src/__tests__/marketplace-update-checker.test.ts` | Add `buildUpsertDb` helper; replace old conflict test; add 3 new conflict-resolution tests |
| `server/src/services/marketplace-install/team-installer.ts` | Replace Phase 3 skill insert loop (lines 157–188) |
| `server/src/__tests__/marketplace-install-team-cascade.test.ts` | Update `mockDb` tx chains; add 1 new "skill already installed" test |

---

## Task 1: Fix `upsertPendingUpdate` — re-open dismissed/applied rows for new catalog versions

**The bug:** `marketplace_pending_updates` has a unique constraint on `(companyId, catalogItemId)` with no status filter. Once a row reaches `applied` or `dismissed`, every future catalog version hits the conflict and the fallback `UPDATE WHERE status='pending'` never matches — so the company silently stops receiving updates for that skill forever.

**The fix:** After the `INSERT ... ON CONFLICT DO NOTHING` returns empty, read the existing row's status. If it's `applied` or `dismissed`, reset it to `pending` with the new version and return `{ inserted: true }` so the caller fires a notification/auto-apply. If it's still `pending`, just bump `latestVersion` and return `{ inserted: false }` as before.

**Files:**
- Modify: `server/src/services/marketplace-update-checker.ts:148-194`
- Modify: `server/src/__tests__/marketplace-update-checker.test.ts`

---

- [ ] **Step 1: Add `buildUpsertDb` helper to the test file**

Open `server/src/__tests__/marketplace-update-checker.test.ts`. After the existing `buildMockDb` function (after line 94, before the `// ─── compareVersions` comment), add:

```ts
/** Minimal mock DB for testing upsertPendingUpdate directly. */
function buildUpsertDb({
  insertReturning = [] as Array<{ id: string }>,
  existingRow = null as { status: string; latestVersion: string } | null,
} = {}) {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(insertReturning),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(existingRow ? [existingRow] : []),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
}
```

---

- [ ] **Step 2: Replace the old conflict test + add 3 new conflict-resolution tests**

Find and **replace** this existing test (lines 138–148):

```ts
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
```

Replace it with the following block (4 tests that cover all conflict cases):

```ts
  it("returns { inserted: false } on conflict when existing row is still pending", async () => {
    const db = buildUpsertDb({ existingRow: { status: "pending", latestVersion: "1.1.0" } });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
    });
    expect(result).toEqual({ inserted: false });
  });

  it("returns { inserted: true } when existing row is applied — re-opens for new catalog version", async () => {
    // Bug scenario: v1.1 was auto-applied. v1.2 arrives. Must re-open.
    const db = buildUpsertDb({ existingRow: { status: "applied", latestVersion: "1.1.0" } });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
    });
    expect(result).toEqual({ inserted: true });
  });

  it("returns { inserted: true } when existing row is dismissed — re-opens for new catalog version", async () => {
    // Dismiss was for v1.1; v1.2 is a different release and should re-notify.
    const db = buildUpsertDb({ existingRow: { status: "dismissed", latestVersion: "1.1.0" } });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
    });
    expect(result).toEqual({ inserted: true });
  });

  it("returns { inserted: false } when row disappears after conflict (race condition)", async () => {
    // existingRow: null means the SELECT returns [] — very rare race.
    const db = buildUpsertDb({ existingRow: null });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
    });
    expect(result).toEqual({ inserted: false });
  });
```

---

- [ ] **Step 3: Run the tests to confirm 3 new ones fail**

```bash
cd server && pnpm vitest run src/__tests__/marketplace-update-checker.test.ts 2>&1 | tail -30
```

Expected: the 3 new "re-opens applied/dismissed/race" tests **FAIL** (current implementation never does the re-open SELECT). The version-equal test and the "pending still pending" test may fail too since the old mock didn't have `.limit()`. That's expected. Note the exact failure messages.

---

- [ ] **Step 4: Replace the `upsertPendingUpdate` implementation**

In `server/src/services/marketplace-update-checker.ts`, find and replace the entire `upsertPendingUpdate` function (lines 148–194). The old code is:

```ts
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

Replace it with:

```ts
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
    // Fresh row — caller decides whether to notify or auto-apply
    return { inserted: true };
  }

  // Conflict: a row already exists for this (companyId, catalogItemId).
  // Read its current status to decide what to do.
  const [existing] = await db
    .select({
      status: marketplacePendingUpdates.status,
      latestVersion: marketplacePendingUpdates.latestVersion,
    })
    .from(marketplacePendingUpdates)
    .where(
      and(
        eq(marketplacePendingUpdates.companyId, companyId),
        eq(marketplacePendingUpdates.catalogItemId, data.catalogItemId),
      ),
    )
    .limit(1);

  if (!existing) return { inserted: false }; // race: row disappeared between conflict and read

  if (existing.status === "pending") {
    // Still pending — bump latestVersion if the catalog has advanced further
    if (compareVersions(data.latestVersion, existing.latestVersion) > 0) {
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
    }
    return { inserted: false };
  }

  // Row is "applied" or "dismissed" — re-open it for the incoming catalog version.
  // The prior dismiss/apply was for an older version; this is a genuinely new release.
  await db
    .update(marketplacePendingUpdates)
    .set({
      status: "pending",
      currentVersion: data.currentVersion,
      latestVersion: data.latestVersion,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(marketplacePendingUpdates.companyId, companyId),
        eq(marketplacePendingUpdates.catalogItemId, data.catalogItemId),
      ),
    );

  return { inserted: true }; // treat re-opened row as new → caller notifies / auto-applies
}
```

---

- [ ] **Step 5: Run the full marketplace-update-checker test suite**

```bash
cd server && pnpm vitest run src/__tests__/marketplace-update-checker.test.ts 2>&1 | tail -30
```

Expected output: all tests pass. The count should be **17** (14 existing + 3 new re-open tests, minus the 1 old conflict test that was replaced = net +3).

If any test fails, read the failure message — the most likely cause is the `buildMockDb` SELECT chain not having `.limit()` on a `runUpdateCheck` test. In that case, check which `runUpdateCheck` test hit the conflict path (it shouldn't — `buildMockDb` defaults `insertReturning` to `[{ id: "upd-1" }]` which is non-empty, meaning no conflict, meaning the new SELECT is never reached). If it does fail, verify `insertReturning` is `[{ id: "upd-1" }]` in that test's `buildMockDb` call.

---

- [ ] **Step 6: Commit**

```bash
cd .. && git add server/src/services/marketplace-update-checker.ts server/src/__tests__/marketplace-update-checker.test.ts
git commit -m "fix(marketplace): re-open applied/dismissed pending updates for new catalog versions

upsertPendingUpdate previously returned { inserted: false } on any conflict,
even when the row was already applied or dismissed. A newer catalog version
for the same skill would silently do nothing — no notification, no auto-apply.

Fix: after the INSERT conflict, read the existing row status. If applied or
dismissed, reset it to pending with the new version and return { inserted: true }
so the caller fires a notification or auto-applies. If still pending, bump
latestVersion and return { inserted: false } as before.

Closes the P1 bug flagged in Codex review of PR #94."
```

---

## Task 2: Fix team installer Phase 3 — idempotent required-skill insert

**The bug:** In Phase 3 of `installTeam`, required skills are inserted with a plain `.values().returning()` — no conflict handling. `company_skills` has `UNIQUE (companyId, key)`. If any required skill is already installed (e.g., founder installed it individually, or this team was installed before), the insert throws a unique-constraint violation and rolls back the entire Phase 3 transaction — team, agents, team members all fail.

**The fix:** Add `.onConflictDoNothing()` to the skill insert. Handle the empty `returning` array (the existing-skill case) by doing a secondary SELECT to fetch the existing skill's id for the cascade result, and recording status `"skipped"` instead of `"success"`.

**Files:**
- Modify: `server/src/__tests__/marketplace-install-team-cascade.test.ts`
- Modify: `server/src/services/marketplace-install/team-installer.ts:157-188`

---

- [ ] **Step 7: Update the `mockDb` transaction mock to support the new call chains**

The current `mockDb.transaction.tx.insert().values()` returns `{ returning: () => ... }`. After the fix, skill inserts go through `.onConflictDoNothing().returning()`. The current `tx.select().from().where()` also needs `.limit()` for the fallback existing-skill lookup.

Find the `mockDb` constant in `server/src/__tests__/marketplace-install-team-cascade.test.ts` (line 82) and replace the entire `mockDb` object:

```ts
  const mockDb = {
    transaction: async (cb: (tx: any) => Promise<any>) => {
      const tx = {
        insert: (_table: any) => ({
          values: (row: any) => {
            if (row.markdown !== undefined) {
              skillInserts.push(row);
            } else if (row.adapterType !== undefined || row.skillKeys !== undefined) {
              agentInserts.push(row);
            } else if (row.parentProjectId !== undefined || row.manifest !== undefined) {
              teamInserts.push(row);
            } else if (row.teamId !== undefined && row.agentId !== undefined && row.role !== undefined) {
              teamMemberInserts.push(row);
            }
            const insertId = `${skillInserts.length + agentInserts.length + teamInserts.length + teamMemberInserts.length}-uuid`;
            return {
              // Skills now go through onConflictDoNothing().returning()
              onConflictDoNothing: () => ({
                returning: (_cols?: any) => Promise.resolve([{ id: insertId }]),
              }),
              // Other inserts still use .returning() directly
              returning: () => Promise.resolve([{ ...row, id: insertId }]),
            };
          },
        }),
        // tx.select() used by conflict-resolver (returns [] = no conflict found)
        // and by the new skill-exists lookup (needs .limit())
        select: () => ({
          from: () => ({
            where: () => {
              // Make the result both awaitable (for conflict-resolver) and have .limit() (for skill lookup)
              const rows: any[] = [];
              return Object.assign(Promise.resolve(rows), {
                limit: (_n: number) => Promise.resolve(rows),
              });
            },
          }),
        }),
      };
      return cb(tx);
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: "dept-uuid-1", type: "department", companyId: "c1" }]),
        }),
      }),
    }),
  };
```

---

- [ ] **Step 8: Run existing team cascade tests to verify they still pass**

```bash
cd server && pnpm vitest run src/__tests__/marketplace-install-team-cascade.test.ts 2>&1 | tail -20
```

Expected: all 4 existing tests pass. If any fail, the mock change broke something — check the failure and fix the mock before continuing.

---

- [ ] **Step 9: Add the "skill already installed" failing test**

Add this test inside the `describe("installTeam — Saga cascade", () => {` block, after the "if phase 3 fails, plugin from phase 2 remains" test:

```ts
  it("phase 3: skips skill install if skill already exists, completes rest of install", async () => {
    // Simulate a company that already has the required skill installed.
    // The skill insert should silently skip; team + agents should still be created.
    let skillOnConflictCalled = false;

    const mockDbSkillExists = {
      ...mockDb,
      transaction: async (cb: (tx: any) => Promise<any>) => {
        const localSkillInserts: any[] = [];
        const localAgentInserts: any[] = [];
        const localTeamInserts: any[] = [];
        const localTeamMemberInserts: any[] = [];

        const tx = {
          insert: (_table: any) => ({
            values: (row: any) => {
              const isSkill = row.markdown !== undefined;
              if (!isSkill) {
                if (row.adapterType !== undefined || row.skillKeys !== undefined) localAgentInserts.push(row);
                else if (row.parentProjectId !== undefined || row.manifest !== undefined) localTeamInserts.push(row);
                else if (row.teamId !== undefined && row.agentId !== undefined) localTeamMemberInserts.push(row);
                const id = `${localAgentInserts.length + localTeamInserts.length + localTeamMemberInserts.length}-uuid`;
                return {
                  onConflictDoNothing: () => ({ returning: (_cols?: any) => Promise.resolve([{ id }]) }),
                  returning: () => Promise.resolve([{ ...row, id }]),
                };
              }
              // Skill — simulate unique conflict (already installed)
              skillOnConflictCalled = true;
              localSkillInserts.push(row);
              return {
                onConflictDoNothing: () => ({
                  returning: (_cols?: any) => Promise.resolve([]), // empty = conflict
                }),
              };
            },
          }),
          select: () => ({
            from: () => ({
              where: () =>
                Object.assign(Promise.resolve([]), {
                  // Fallback lookup: returns the existing skill's id
                  limit: (_n: number) => Promise.resolve([{ id: "existing-skill-uuid" }]),
                }),
            }),
          }),
        };
        return cb(tx);
      },
    };

    const result = await installTeam({
      catalogItem: TEAM,
      catalog: CATALOG,
      companyId: "c1",
      targetDepartmentId: "dept-uuid-1",
      db: mockDbSkillExists as any,
      installPlugin: mockPluginInstaller,
    });

    // onConflictDoNothing was called for the skill
    expect(skillOnConflictCalled).toBe(true);

    // Cascade result for the skill must be "skipped", not "success"
    const skillResult = result.cascadeResults.find((r) => r.step === "skill-install");
    expect(skillResult).toBeDefined();
    expect(skillResult?.status).toBe("skipped");
    expect(skillResult?.resultEntityId).toBe("existing-skill-uuid");

    // Team was still created despite the skipped skill
    expect(result.teamId).toBeDefined();
  });
```

---

- [ ] **Step 10: Run tests to confirm the new test fails**

```bash
cd server && pnpm vitest run src/__tests__/marketplace-install-team-cascade.test.ts 2>&1 | tail -20
```

Expected: the 4 existing tests pass, the new "skips skill install" test **FAILS** — because the current implementation calls `.values().returning()` (which returns a row, never going through `.onConflictDoNothing()`), so `status` is `"success"` rather than `"skipped"`.

---

- [ ] **Step 11: Replace the Phase 3 skill insert loop in `team-installer.ts`**

In `server/src/services/marketplace-install/team-installer.ts`, find and replace the Phase 3 skill insert loop (lines 157–188). The old code is:

```ts
    // Insert skills (M.2.C corrected fields: sourceType="catalog", trustLevel="markdown_only")
    for (const skillItem of requiredSkillItems) {
      const slug = skillItem.id.split("/").pop() ?? skillItem.id;
      const inserted = await tx
        .insert(companySkills)
        .values({
          companyId,
          key: skillItem.id,
          slug,
          name: skillItem.name,
          description: skillItem.description,
          markdown: skillContents.get(skillItem.id)!,
          sourceType: "catalog",
          sourceLocator: skillItem.id,
          sourceRef: skillItem.version,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: {
            catalogCategory: skillItem.category,
            catalogTags: skillItem.tags,
            catalogTrustTier: skillItem.trust.tier,
            installedAt,
          },
        })
        .returning();
      cascadeResults.push({
        step: "skill-install",
        itemId: skillItem.id,
        status: "success",
        resultEntityId: inserted[0].id,
        durationMs: 0,
      });
    }
```

Replace it with:

```ts
    // Insert skills — idempotent: skip if the skill is already installed
    for (const skillItem of requiredSkillItems) {
      const slug = skillItem.id.split("/").pop() ?? skillItem.id;
      const insertedRows = await tx
        .insert(companySkills)
        .values({
          companyId,
          key: skillItem.id,
          slug,
          name: skillItem.name,
          description: skillItem.description,
          markdown: skillContents.get(skillItem.id)!,
          sourceType: "catalog",
          sourceLocator: skillItem.id,
          sourceRef: skillItem.version,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: {
            catalogCategory: skillItem.category,
            catalogTags: skillItem.tags,
            catalogTrustTier: skillItem.trust.tier,
            installedAt,
          },
        })
        .onConflictDoNothing()
        .returning({ id: companySkills.id });

      if (insertedRows.length === 0) {
        // Skill already installed — look up its id for the cascade record
        const [existing] = await tx
          .select({ id: companySkills.id })
          .from(companySkills)
          .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, skillItem.id)))
          .limit(1);
        cascadeResults.push({
          step: "skill-install",
          itemId: skillItem.id,
          status: "skipped",
          resultEntityId: existing?.id,
          durationMs: 0,
        });
      } else {
        cascadeResults.push({
          step: "skill-install",
          itemId: skillItem.id,
          status: "success",
          resultEntityId: insertedRows[0].id,
          durationMs: 0,
        });
      }
    }
```

---

- [ ] **Step 12: Run all team cascade tests**

```bash
cd server && pnpm vitest run src/__tests__/marketplace-install-team-cascade.test.ts 2>&1 | tail -20
```

Expected: all **5** tests pass (4 existing + 1 new).

---

- [ ] **Step 13: Run the full server test suite to catch any regressions**

```bash
cd server && pnpm vitest run 2>&1 | tail -30
```

Expected: all tests pass. If `marketplace-update-checker.test.ts` or `marketplace-install-team-cascade.test.ts` show failures, fix them before committing. No other test files should be affected.

---

- [ ] **Step 14: Commit**

```bash
cd .. && git add server/src/services/marketplace-install/team-installer.ts server/src/__tests__/marketplace-install-team-cascade.test.ts
git commit -m "fix(marketplace): idempotent skill insert in team installer Phase 3

installTeam Phase 3 inserted required skills with a plain INSERT, which
threw a unique-constraint violation on (companyId, key) if any skill was
already installed — aborting the entire team installation transaction.

Fix: use .onConflictDoNothing() so the insert silently skips existing
skills. When the returning array is empty (conflict), do a secondary
SELECT to fetch the existing skill id and record status='skipped' in the
cascade results. Team, agents, and team_members are all still created.

Closes the P1 bug flagged in Codex review of PR #94."
```

---

## Verification

After both commits, push to the PR branch and verify:

```bash
git push origin feat/marketplace-v1
```

The two `TODO(hardening)` comments added earlier remain in place — they are separate follow-up items unrelated to these P1 fixes.
