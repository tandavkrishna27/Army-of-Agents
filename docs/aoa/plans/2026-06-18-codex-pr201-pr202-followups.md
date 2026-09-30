# Codex P2 Follow-ups — PR #201 (#199) & PR #202 (#198 PR-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Resolve the two P2 Codex review comments — one per open PR — by closing the cockpit approval-mirror gap (#201) and the cross-run action re-home gap (#202).

**Architecture:** Two **independent** fixes on two **separate branches**. Each is a "the change forgot to update its sibling code path" fix — no architectural decision, no schema change. Plan A is a display-filter correctness fix in `cockpit.ts`; Plan B is a concurrency/idempotency fix in `proposeThreadAction`. They do not depend on each other and can be done in either order / in parallel worktrees.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest 3, Express. Server package = `@armyofagents/server`.

**Single-file test command (used throughout):** vitest roots at the `server/` package, so test paths are **server-relative** (`src/__tests__/...`, NOT `server/src/...`). Per repo convention:
`pnpm -C "<worktree>/server" exec vitest run src/__tests__/<file>`
(A repo-root-relative `server/src/...` path matches no files → silent no-op, defeating the RED/GREEN gate.)

---

## Plan A — PR #201: cockpit approval mirror (Codex P2)

**Branch:** `fix/scope-authz-199` (base `feat/v1-combined`)

**The bug:** PR #201 tightened `permissions.ts` so a team lead may approve **only `active_context`** memory (R5 — founder is sole gatekeeper for `domain`). But `cockpit.ts` carries a **hand-copied** approval predicate (`canApproveMem`, `layer !== "identity"`) that still treats `domain` as lead-approvable. Result: a team lead sees pending `domain` memory items in their cockpit queue → the approve call now 403s via `assertMemoryApproval` → dead button. `cockpit.ts` was not in PR #201's file set; the mirror was missed.

**Files:**
- Modify: `server/src/services/cockpit.ts` (predicate at ~583-585; doc comments at ~26-27, ~504-506, ~520-521)
- Modify (update existing expectations — NOT just append): `server/src/__tests__/cockpit-approvals.test.ts` (header ~line 6; team_lead `describe` block ~608-735)

### Task A1: Update the lead-scope test to the new rule (RED first)

The existing lead test asserts a lead **sees** `domain` memory (`m-ok`, `ver-1`, total 3). Under the new rule that is wrong. Rewrite the fixture + assertions so the test proves "lead sees only `active_context` for their dept; `domain` is now excluded." This is the failing test that drives the fix.

- [ ] **Step 1: Edit the file header comment** `server/src/__tests__/cockpit-approvals.test.ts:6`

Replace:
```
 *   - team_lead → memory/memory_version (dept-scoped, non-identity) + runtime (own). No other sources.
```
with:
```
 *   - team_lead → memory/memory_version (dept-scoped, active_context ONLY; R5: domain is founder-only) + runtime (own). No other sources.
```

- [ ] **Step 2: Replace the lead `beforeEach` memory fixture** (the `mockMemoryServiceListPending.mockResolvedValue({...})` inside the `team_lead scope` `describe`, ~line 660-705)

```ts
    mockMemoryServiceListPending.mockResolvedValue({
      items: [
        // identity layer → excluded even for dep-a lead
        { id: "m-ident", title: "I", layer: "identity", departmentId: "dep-a", category: null, status: "pending" },
        // R5: domain, dep-a → now EXCLUDED (founder-only since PR #201)
        { id: "m-domain", title: "D", layer: "domain", departmentId: "dep-a", category: "coding", status: "pending" },
        // active_context, dep-a → INCLUDED (the one layer a lead may approve)
        { id: "m-ok", title: "OK", layer: "active_context", departmentId: "dep-a", category: "coding", status: "pending" },
        // active_context, dep-b → excluded (not lead's dept)
        { id: "m-other", title: "O", layer: "active_context", departmentId: "dep-b", category: null, status: "pending" },
        // active_context, no dept → excluded (departmentId null)
        { id: "m-nodept", title: "N", layer: "active_context", departmentId: null, category: null, status: "pending" },
      ],
      versions: [
        // active_context, dep-a → INCLUDED
        {
          itemId: "v-ok",
          itemTitle: "V",
          itemLayer: "active_context",
          itemDepartmentId: "dep-a",
          itemCategory: "coding",
          itemSource: "agent",
          currentContent: "c",
          currentVersionId: "c0",
          version: { id: "ver-1", memoryItemId: "v-ok", versionNumber: 2, content: "c2", status: "pending", createdBy: "a", createdAt: new Date() },
        },
        // R5: domain, dep-a version → now EXCLUDED
        {
          itemId: "v-domain",
          itemTitle: "VD",
          itemLayer: "domain",
          itemDepartmentId: "dep-a",
          itemCategory: null,
          itemSource: "agent",
          currentContent: "c",
          currentVersionId: "c0",
          version: { id: "ver-2", memoryItemId: "v-domain", versionNumber: 2, content: "c2", status: "pending", createdBy: "a", createdAt: new Date() },
        },
      ],
      archives: [archiveFixture],
      totalCount: 7,
    });
```

- [ ] **Step 3: Rewrite the main lead test body + name** (`it("lead sees dep-a non-identity memory ...")`, ~line 702)

```ts
  it("lead sees dep-a active_context memory only; excludes domain/identity/other-dept/no-dept/archive (R5)", async () => {
    // LEAD sequence (8 selects): reminders=[], dueTasks=[], runtime=[runtimeRow],
    //   pinned=[], goalsAtRisk=[], doneToday=[], proactive=[], teammates-dept=[]
    const db = buildSequenceDb([[], [], [runtimeRow], [], [], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, LEAD_ACTOR);

    // INCLUDED: m-ok (active_context memory), ver-1 (active_context version), rt-lead (runtime)
    const ids = result.approvals.map((a) => a.id);
    expect(ids).toContain("m-ok");
    expect(result.approvals.find((a) => a.source === "memory_version")?.relatedEntityId).toBe("ver-1");
    expect(ids).toContain("rt-lead");

    // EXCLUDED: domain (R5 founder-only), identity, other dept, no dept
    expect(ids).not.toContain("m-domain");
    expect(ids).not.toContain("m-ident");
    expect(ids).not.toContain("m-other");
    expect(ids).not.toContain("m-nodept");
    // EXCLUDED: domain version (R5)
    expect(result.approvals.find((a) => a.source === "memory_version" && a.relatedEntityId === "ver-2")).toBeUndefined();
    // EXCLUDED: archive (founder-only)
    expect(result.approvals.find((a) => a.source === "memory_archive")).toBeUndefined();
    // EXCLUDED: approval/discussion_item/join_request
    expect(result.approvals.find((a) => a.source === "approval")).toBeUndefined();
    expect(result.approvals.find((a) => a.source === "discussion_item")).toBeUndefined();
    expect(result.approvals.find((a) => a.source === "join_request")).toBeUndefined();

    // memory service WAS called (leads can still see active_context memory)
    expect(mockMemoryServiceListPending).toHaveBeenCalledWith(COMPANY);

    // Exactly 3 items total
    expect(result.approvals).toHaveLength(3);
  });
```

(The second lead test — `"lead with empty leadDepartmentIds sees only own runtime"` — needs **no change**: with empty `leadDepartmentIds`, every dept-scoped item still fails the membership check, so length stays 1.)

- [ ] **Step 4: Run the test — expect FAIL (drives the fix)**

Run: `pnpm -C "<worktree>/server" exec vitest run src/__tests__/cockpit-approvals.test.ts`
Expected: FAIL — `m-domain`/`ver-2` still appear (old predicate includes domain), length is 5 not 3.

### Task A2: Fix the cockpit predicate + doc comments

- [ ] **Step 1: Change the predicate** `server/src/services/cockpit.ts:583-585`

Replace:
```ts
  const canApproveMem = (layer: string | null, departmentId: string | null) =>
    isFounder ||
    (isLead && layer !== "identity" && !!departmentId && scope.leadDepartmentIds.includes(departmentId));
```
with:
```ts
  // R5 (PR #199): the founder is sole gatekeeper for identity AND domain. A team
  // lead may approve only `active_context` for their own department. Mirrors
  // canApproveMemory in permissions.ts (185-205) — keep the two in lockstep.
  const canApproveMem = (layer: string | null, departmentId: string | null) =>
    isFounder ||
    (isLead && layer === "active_context" && !!departmentId && scope.leadDepartmentIds.includes(departmentId));
```

- [ ] **Step 2: Update the stale "non-identity" doc comments** (3 sites)

`cockpit.ts:26-27` — change `memory/memory_version → founder OR (team_lead AND layer!=="identity" AND dept ∈ leadDepartmentIds).` to `... → founder OR (team_lead AND layer==="active_context" AND dept ∈ leadDepartmentIds).`

`cockpit.ts:~505` — change `memory / memory_version → founder OR dept-lead (non-identity layer, dept ∈ leadDepartmentIds)` to `... (active_context layer only, dept ∈ leadDepartmentIds)`.

`cockpit.ts:~521` — change `memory + memory_version → founder OR (team_lead AND layer!=="identity" AND dept ∈ leadDepartmentIds).` to `... layer==="active_context" ...`.

- [ ] **Step 3: Run the test — expect PASS**

Run: `pnpm -C "<worktree>/server" exec vitest run src/__tests__/cockpit-approvals.test.ts`
Expected: PASS (all founder/member/lead cases green).

- [ ] **Step 4: Run the permissions/authz suites for no regressions**

Run: `pnpm -C "<worktree>/server" exec vitest run src/__tests__/permissions.test.ts src/__tests__/authz-assert.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/cockpit.ts src/__tests__/cockpit-approvals.test.ts
git commit -m "fix(cockpit): mirror R5 — leads approve active_context only, not domain (Codex #201 P2)"
```

---

## Plan B — PR #202: re-home colliding actions onto the current run (Codex P2)

**Branch:** `fix/thread-stable-keys-198-pra` (base `feat/v1-combined`)

**The bug:** PR #202 made idempotency keys run-**independent**. So a same-turn retry in a **new** run collides (via the `(companyId, idempotencyKey)` unique index) with a row created by an **earlier** run. `proposeThreadAction` re-selects and returns that row **carrying its original `runId`**. But `commitThreadAgentActions` only flushes rows where `runId = currentRun` (`thread-agent-actions.ts:300-302`). If the earlier run crashed/left the row uncommitted (`proposed`) or retry-eligible (`failed`), the current run's commit never sees it → **phase advance silently lost**, row stranded forever. This failure mode is **newly introduced** by this PR (the old key included `runId`, so a new run produced a new key + a fresh committable row).

**Chosen fix — option (a), re-home:** when the conflict path returns an existing row whose `runId` differs from the current run **and** it is still committable (`proposed` / `failed`), transfer it onto the current `runId` so THIS run's commit picks it up. Guarded on status so a `committed` / `committing` / terminally-suppressed row is never stolen.

**Why not option (b)** (make commit thread/key-scoped instead of run-scoped): commit is intentionally a per-run batch flush gated by per-run freshness — broadening its SELECT to all runs of the thread would drain other runs' queued actions under the wrong freshness snapshot. Option (a) is surgical and preserves the run-batch model everywhere else.

**Files:**
- Modify: `server/src/services/thread-agent-actions.ts` (`proposeThreadAction`, the conflict path ~264-277)
- Modify: `server/src/__tests__/thread-agent-actions.test.ts` (add 2 mock tests)

> Imports: `or`, `and`, `eq` and the `threadAgentActions` table are already imported in `thread-agent-actions.ts` — no import changes.

### Task B1: Add failing mock tests (RED)

- [ ] **Step 1: Add the re-home test** to `server/src/__tests__/thread-agent-actions.test.ts` (inside `describe("threadAgentActionService", ...)`, near the existing conflict test ~line 95)

```ts
  it("re-homes a still-committable colliding row onto the current run (Codex #202 P2)", async () => {
    // An earlier run (run-1) proposed this action and left it uncommitted. A
    // same-turn retry under a NEW run (run-2) hits the run-independent key. The
    // service must transfer the row onto run-2 so run-2's commit (which filters on
    // runId) actually flushes it instead of silently dropping the phase advance.
    const existing = { ...baseAction, id: "existing-action", runId: "run-1", status: "proposed" };
    const db = createSequenceDb({
      selects: [[thread], [existing]],
      inserts: [[]], // conflict suppressed
      updates: [[{ ...existing, runId: "run-2" }]], // re-home UPDATE ... RETURNING
    });

    const result = (await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-2",
      agentId: "agent-1",
      actionType: "post_reply",
      payload: { rawContent: "Hello" },
      idempotencyKey: "run-1:post_reply:1",
      freshness: { latestHumanSeq: 1 },
    })) as { id: string; runId: string };

    expect(result.id).toBe("existing-action");
    expect(result.runId).toBe("run-2");
    // The re-home UPDATE was issued and set runId to the current run.
    expect(db.__updateSets).toHaveLength(1);
    expect(db.__updateSets[0]).toMatchObject({ runId: "run-2" });
  });

  it("does NOT re-home a committed/in-flight colliding row (status guard)", async () => {
    // The earlier run already committed (or is mid-commit). Re-homing would risk a
    // double-commit, so the guard leaves it alone and returns the canonical row.
    const existing = { ...baseAction, id: "existing-action", runId: "run-1", status: "committed" };
    const db = createSequenceDb({
      selects: [[thread], [existing]],
      inserts: [[]],
      // no updates configured — none should be issued
    });

    const result = (await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-2",
      agentId: "agent-1",
      actionType: "post_reply",
      payload: { rawContent: "Hello" },
      idempotencyKey: "run-1:post_reply:1",
      freshness: { latestHumanSeq: 1 },
    })) as { id: string; runId: string };

    expect(result.id).toBe("existing-action");
    expect(result.runId).toBe("run-1"); // unchanged
    expect(db.__updateSets).toHaveLength(0); // guard prevented the UPDATE
  });
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm -C "<worktree>/server" exec vitest run src/__tests__/thread-agent-actions.test.ts`
Expected: FAIL — re-home test gets `runId: "run-1"` (no re-home yet); `__updateSets` is empty.

### Task B2: Implement the re-home in `proposeThreadAction`

- [ ] **Step 1: Edit** `server/src/services/thread-agent-actions.ts` — the conflict path. Replace:

```ts
      const [existing] = await actionDb
        .select()
        .from(threadAgentActions)
        .where(
          and(
            eq(threadAgentActions.companyId, input.companyId),
            eq(threadAgentActions.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);

      return existing;
```
with:
```ts
      const [existing] = await actionDb
        .select()
        .from(threadAgentActions)
        .where(
          and(
            eq(threadAgentActions.companyId, input.companyId),
            eq(threadAgentActions.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);

      // #198 follow-up (Codex #202 P2): with run-INDEPENDENT keys a same-turn retry
      // under a new run collides with a row created by an EARLIER run. commitThread-
      // AgentActions filters on runId, so if that earlier run left the row committable
      // (proposed, or failed under its attempt cap) the current run would never flush
      // it — the action is silently lost. Re-home the still-committable row onto THIS
      // run so this run's commit picks it up. Guarded on status so a committed /
      // mid-commit (committing) / terminally-suppressed row is never stolen. Race-safe:
      // the status predicate in the UPDATE is the compare-and-swap — a concurrent
      // committer that already moved the row out of {proposed,failed} yields 0 rows and
      // we fall through to the canonical row unchanged.
      if (
        existing &&
        input.runId != null &&
        existing.runId !== input.runId &&
        (existing.status === "proposed" || existing.status === "failed")
      ) {
        const [rehomed] = await actionDb
          .update(threadAgentActions)
          .set({ runId: input.runId, updatedAt: new Date() })
          .where(
            and(
              eq(threadAgentActions.id, existing.id),
              or(
                eq(threadAgentActions.status, "proposed"),
                eq(threadAgentActions.status, "failed"),
              ),
            ),
          )
          .returning();
        if (rehomed) return rehomed;
      }

      return existing;
```

> Note: the re-home intentionally does **not** reset `attemptCount` — a near-poison `failed` row keeps its history, and the commit's own `attemptCount < maxAttempts` predicate still bounds retries.

- [ ] **Step 2: Run — expect PASS**

Run: `pnpm -C "<worktree>/server" exec vitest run src/__tests__/thread-agent-actions.test.ts`
Expected: PASS, including the existing `"returns the existing row when a duplicate propose hits the idempotency conflict"` (same runId → guard's `existing.runId !== input.runId` is false → unchanged).

- [ ] **Step 3: Run the idempotency contract + schema suites for no regressions**

Run: `pnpm -C "<worktree>/server" exec vitest run src/__tests__/thread-action-keys.test.ts src/__tests__/thread-agent-actions-schema-contract.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/thread-agent-actions.ts src/__tests__/thread-agent-actions.test.ts
git commit -m "fix(threads): re-home colliding same-turn actions onto current run (Codex #202 P2)"
```

**Scoping note (integration test):** the real-DB suite `thread-commit-idempotency.integration.test.ts` proves the unique-index dedup that *triggers* the conflict path; the new branch logic + status guard is fully exercised by the two mock tests above. A real-DB re-home assertion would require seeding two `internal_agent_runs` rows (FK on `run_id`) and exercising the full commit machinery — deliberately **out of scope** here; the mock tests are the authoritative proof of the branch, the existing integration test proves the index. (Linux is the integration gate; this suite is skipped on Windows per Issue #114.)

---

## Cross-cutting: branch/worktree strategy & PR replies

- [ ] Use isolated worktrees so the current `feat/v1-upgrade` uncommitted changes are untouched:
  ```bash
  git worktree add ../AoA-pr201 fix/scope-authz-199
  git worktree add ../AoA-pr202 fix/thread-stable-keys-198-pra
  ```
- [ ] After each branch's tests pass + commit: `git push` (branch already tracks origin).
- [ ] Reply to each Codex inline thread (per receiving-code-review: thread reply, not top-level, no thanks):
  - #201 comment id `3433768060` → state the cockpit predicate now mirrors `active_context`-only.
  - #202 comment id `3434550188` → state the re-home + why option (a) over (b).

---

## Self-Review (writing-plans checklist)

1. **Spec coverage** — Codex #201 (cockpit mirror) → Plan A; Codex #202 (re-home) → Plan B. Both covered. ✅
2. **Placeholder scan** — every code/test step contains complete code; no TBD/"handle edge cases". ✅
3. **Type consistency** — predicate signature `(layer: string|null, departmentId: string|null)` unchanged; status literals (`proposed`/`failed`/`committed`) match the schema union; `__updateSets`/`__insertValues` match the mock harness; `or`/`and`/`eq` already imported. ✅
4. **Behavioral-regression catch** — Plan A's key risk (existing lead tests assert the *old* domain-visible behavior) is handled by **updating** those expectations in Task A1, not just appending. Plan B's existing same-runId conflict test stays green because the guard short-circuits on equal runId. ✅
