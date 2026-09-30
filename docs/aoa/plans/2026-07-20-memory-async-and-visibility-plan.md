# Memory Async Dispatch + Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop making the founder wait for the Librarian, and make pending memory findable (Inbox signpost) and its destination folder visible before approval.

**Architecture:** `submit` fires the Librarian in the background instead of awaiting it (crash-covered by the existing stale-`running` lease). Onboarding stops blocking. A new `memory_review` hub type in the `waiting_on_you` lane — mirroring `discussion_pending` — signposts pending memory in the Inbox, produced at the shared `writeMemoryAndIndex` chokepoint. The Memory UI shows each pending item's destination folder, marks pending items in-folder, and badges folders that have pending memory.

**Tech Stack:** TypeScript, vitest, pnpm workspaces. Packages: `server`, `packages/shared`, `ui`.

**Spec:** `docs/aoa/plans/2026-07-20-memory-async-and-visibility-design.md`

**DO NOT change the Librarian's placement logic.** It already receives the seeded folder list and `write_memory` validates `folderPath` against it. This plan changes WHEN dispatch runs and HOW the result is surfaced.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/services/braindump.ts` (modify) | M1: `submit` schedules dispatch, doesn't await |
| `server/src/__tests__/braindump.test.ts` (modify) | M1: assert scheduled-not-awaited |
| `ui/src/onboarding/inflight/BraindumpStep.tsx` (modify) | M2: `onDone` on acceptance |
| `ui/src/onboarding/inflight/LibrarianStep.tsx` (modify) | M2: non-blocking background note |
| `packages/shared/src/hub.ts` (modify) | M3a: `memory_review` type + lane |
| `server/src/services/hub-source-producers.ts` (modify) | M3b: `buildMemoryReviewHubEmit` |
| `server/src/services/hub-items.ts` (modify) | M3b: `reconcileMemoryReview` + registry |
| `server/src/services/memory-write.ts` (modify) | M3b: emit at the chokepoint |
| `server/src/routes/memory.ts` (modify) | M3b: reconcile on approve |
| `ui/src/components/memory/MemoryFileList.tsx`, `MemoryTree.tsx` (modify) | M4: destination label + pending marker + per-folder pending badge |

Order: T1 (async) → T2 (onboarding) → T3 (hub type) → T4 (hub producer) → T5 (folder visibility) → T6 (live).

---

## Task 1 (M1): Async dispatch

**Files:**
- Modify: `server/src/services/braindump.ts` (the `submit` method, ~line 543)
- Test: `server/src/__tests__/braindump.test.ts`

Currently `submit` does `await claimAndDispatch(...)` then re-reads and returns the
terminal row. We make dispatch fire-and-forget.

- [ ] **Step 1: Write the failing test**

Read `braindump.test.ts` first — it uses an ordered `createSequenceDb` mock and a
mocked `runAoaAgentMock`. The existing happy-path test asserts `result.status`
is `"proposed"` (the terminal status AFTER the run). With async dispatch, `submit`
returns BEFORE the run finishes, so the returned status is the claimed
`"running"`/`"pending"`, and the run resolves later.

Add a focused test that proves submit does not block on the run:

```ts
it("returns without awaiting the Librarian run (async dispatch)", async () => {
  // A run that never resolves — if submit awaited it, this test would hang.
  runAoaAgentMock.mockReturnValue(new Promise(() => {}));
  const db = createSequenceDb([
    [DEPT_ROW],                                                     // validate dept
    [{ id: CAPTURE_ID, departmentId: DEPT_ID, status: "pending" }], // insert
    [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID, content: "x", assetIds: [] }], // claim
    [{ id: LIBRARIAN_ID }],                                         // resolveLibrarian
    [DEPT_ROW],                                                     // dept name
    [{ path: "engineering/Decisions" }],                           // folders
    // no correlate/latest rows: the run never completes, so submit must have
    // returned before reaching them.
    [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }], // re-read latest
  ]);

  const result = await Promise.race([
    braindumpService(db).submit(CO_ID, { departmentId: DEPT_ID, content: "x", idempotencyKey: "k1" }),
    new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 200)),
  ]);

  expect(result).not.toBe("TIMEOUT"); // did not hang on the never-resolving run
  // Non-terminal: the run has NOT finished. Don't couple to a specific interim
  // value (pending vs running depends on commit timing of the detached claim).
  expect(["pending", "running"]).toContain((result as { status: string }).status);
});

it("a background dispatch rejection does not throw out of submit", async () => {
  runAoaAgentMock.mockRejectedValue(new Error("dispatch blew up"));
  const db = createSequenceDb([
    [DEPT_ROW],
    [{ id: CAPTURE_ID, departmentId: DEPT_ID, status: "pending" }],
    [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID, content: "x", assetIds: [] }],
    [{ id: LIBRARIAN_ID }],
    [DEPT_ROW],
    [{ path: "engineering/Decisions" }],
    [],                                                             // correlate
    [],                                                             // update -> failed (background)
    [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }], // re-read latest (still running at return time)
  ]);
  // Must resolve, not reject — the rejection happens on the detached promise.
  await expect(
    braindumpService(db).submit(CO_ID, { departmentId: DEPT_ID, content: "x", idempotencyKey: "k1" }),
  ).resolves.toBeTruthy();
});
```

**Test fallout is larger than one test — a review flagged this.** `braindump.test.ts`
uses an ORDERED `createSequenceDb`, and ~13 assertions read a TERMINAL status
(`proposed`/`failed`) off `submit`/`retry`. Making dispatch fire-and-forget makes
the DB-call interleaving nondeterministic against that shared sequence — the
detached claim's awaits race the re-read — so those tests break structurally, not
just in their expected string. And `claimAndDispatch` is MODULE-PRIVATE and
`retry` uses the SAME async path, so there is no existing deterministic seam to
assert terminal status through.

**Fix — export the dispatch worker as a test seam.** Rename/export
`claimAndDispatch` so tests can await it deterministically:

```ts
// braindump.ts — was: async function claimAndDispatch(...)
export async function claimAndDispatch(db: Db, companyId: string, id: string): Promise<boolean> { … }
```

Then re-home the terminal-status assertions: the proposed/failed CASES call
`claimAndDispatch(db, CO_ID, CAPTURE_ID)` DIRECTLY and await it (deterministic, no
race), and `submit`/`retry`'s own tests assert only that they schedule dispatch
(runAoaAgentMock called) and return promptly with a NON-TERMINAL status. Budget
this as real test rework across those ~13 assertions, not a one-line edit. Do NOT
delete coverage — move it onto the now-exported `claimAndDispatch`.

Note: at re-read time the detached claim likely hasn't committed, so `submit`
returns `pending` (the pre-claim status), not `running`. Assert `!== "proposed"`
(non-terminal) rather than a specific interim value, to avoid coupling to timing.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/__tests__/braindump.test.ts`
Expected: the new "does not hang" test fails (submit currently awaits, so
`Promise.race` returns "TIMEOUT"); the happy-path test still expects "proposed".

- [ ] **Step 3: Implement**

In `server/src/services/braindump.ts`, replace the `submit` dispatch block:

```ts
      // Fire-and-forget: dispatch the Librarian in the BACKGROUND so the founder
      // is not made to wait for a full agent run inside this request. Crash
      // recovery is the existing stale-`running` lease (RUNNING_LEASE_MINUTES) —
      // a process that dies mid-run leaves a row `retry` can reclaim.
      //
      // The .catch is mandatory: a detached promise that rejects with no handler
      // is an unhandled rejection, and this server has no uncaughtException
      // handler (A-H11 class). claimAndDispatch already writes terminal status on
      // every internal path; this guards a throw from the scheduling seam itself.
      void claimAndDispatch(db, companyId, row.id).catch((err) => {
        log.error({ err, companyId, braindumpId: row.id }, "background dispatch failed");
      });

      const [latest] = await db
        .select()
        .from(braindumpCaptures)
        .where(eq(braindumpCaptures.id, row.id))
        .limit(1);
      return withEffectiveStatus(db, latest ?? row);
```

Do the SAME for `retry` (its `await claimAndDispatch` → `void … .catch(…)`), so a
retry also returns promptly.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/__tests__/braindump.test.ts`
Expected: PASS. If a pre-existing test still asserts `"proposed"` from `submit`,
update it per Step 1 (assert `"running"` + `runAoaAgentMock` called) — do not
weaken it, re-home the terminal-status assertion onto the dispatch path.

- [ ] **Step 5: Commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json
git add server/src/services/braindump.ts server/src/__tests__/braindump.test.ts
git commit -m "feat(braindump): dispatch the Librarian in the background, don't block submit"
```

---

## Task 2 (M2): Onboarding moves on

**Files:**
- Modify: `ui/src/onboarding/inflight/BraindumpStep.tsx`
- Modify: `ui/src/onboarding/inflight/LibrarianStep.tsx`
- Test: both `__tests__` files

`submit` already returns promptly after T1. `BraindumpStep.submitAll` already
fires `onDone` once all submits resolve — and they now resolve on ACCEPTANCE, so
no code change may be needed there beyond confirming it doesn't inspect terminal
status. Verify and adjust. The real change is `LibrarianStep`: it must stop
blocking on "Organizing…".

- [ ] **Step 1: Write the failing test**

Append to `ui/src/onboarding/inflight/__tests__/LibrarianStep.test.tsx`:

```ts
it("does not block on organizing — shows a background note and lets the founder continue", async () => {
  // A capture still running (Librarian working in the background).
  listCaptures.mockResolvedValue([makeCapture({ status: "running" })]);
  memoryList.mockResolvedValue({ items: [], semanticAvailable: true });

  const onDone = vi.fn();
  render(<LibrarianStep companyId="c1" onDone={onDone} />);

  // A clear background note, not an indefinite blocking spinner.
  expect(await screen.findByText(/sorting|background|review (it )?in Memory/i)).toBeTruthy();
  // Continue is available immediately, even while the run is in flight.
  const cont = screen.getByRole("button", { name: /continue/i });
  fireEvent.click(cont);
  expect(onDone).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/onboarding/inflight/__tests__/LibrarianStep.test.tsx`
Expected: FAIL — the background-note text does not exist and/or Continue is gated
while organizing.

- [ ] **Step 3: Implement**

In `ui/src/onboarding/inflight/LibrarianStep.tsx`:

- Keep the capture poll (it still drives the proposal list when the founder
  lingers), but the "Organizing…" state must no longer BLOCK. Render a light note
  regardless of whether captures are still running:

  ```tsx
  <p className="text-center text-xs text-dim">
    We're sorting this into your company's memory in the background — you can
    review and approve it in Memory whenever you're ready.
  </p>
  ```

- The Continue button must be enabled and fire `onDone` immediately, in every
  state (organizing or done). If the current code disables/hides Continue while
  `organizing`, remove that gate.
- Keep the inline approval list for the case where proposals ARE ready when the
  founder lingers — it's a bonus, not a requirement.

Confirm `BraindumpStep.submitAll` fires `onDone` on acceptance (it awaits the
submit promises, which now resolve on acceptance). If it inspects the returned
terminal status anywhere to decide `onDone`, remove that dependency.

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/onboarding/inflight` then `cd ui && npx vitest run src/onboarding`
Expected: PASS, including pre-existing LibrarianStep/BraindumpStep tests. Any
pre-existing test that asserted a BLOCKING "Organizing…" gate should be updated to
the new non-blocking behaviour (that assertion encoded the bug) — do not weaken
unrelated assertions.

- [ ] **Step 5: Commit**

```bash
cd ui && npx tsc --noEmit -p tsconfig.json
git add ui/src/onboarding/inflight/LibrarianStep.tsx ui/src/onboarding/inflight/BraindumpStep.tsx ui/src/onboarding/inflight/__tests__/
git commit -m "feat(onboarding): don't block on the Librarian — review in Memory later"
```

---

## Task 3 (M3a): The `memory_review` hub semantic type

**Files:**
- Modify: `packages/shared/src/hub.ts`
- Test: `packages/shared/src/hub.test.ts` (or the existing hub test file — grep for it)

- [ ] **Step 1: Write the failing test**

Find the hub test file (`grep -rln "HUB_SEMANTIC_TYPES\|laneForSemanticType" packages/shared/src`) and add:

```ts
import { HUB_SEMANTIC_TYPES, laneForSemanticType } from "./hub.js";

describe("memory_review hub type", () => {
  it("is a known semantic type", () => {
    expect(HUB_SEMANTIC_TYPES).toContain("memory_review");
  });
  it("lives in the waiting_on_you lane, beside discussion_pending", () => {
    expect(laneForSemanticType("memory_review")).toBe("waiting_on_you");
    expect(laneForSemanticType("discussion_pending")).toBe("waiting_on_you");
  });
});
```

If no hub test file exists, create `packages/shared/src/hub.test.ts` with the
above plus the imports.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run` (or the specific file)
Expected: FAIL — `"memory_review"` is not in the union; TS may also error since the
`HUB_SEMANTIC_TO_LANE` record is exhaustive.

- [ ] **Step 3: Implement**

Adding a member to `HUB_SEMANTIC_TYPES` breaks THREE exhaustive
`Record<HubSemanticType, …>` maps — a review caught that a naive edit fails
`tsc`. All three must be updated:

In `packages/shared/src/hub.ts`, add `"memory_review"` to `HUB_SEMANTIC_TYPES`
under the `waiting_on_you` group (next to `discussion_pending`):

```ts
  // waiting_on_you
  "approval_request",
  "discussion_pending",
  "memory_review",        // pending memory items awaiting founder approval
  "join_request",
```

Add the lane mapping in `HUB_SEMANTIC_TO_LANE` (`hub.ts:94`):

```ts
  discussion_pending: "waiting_on_you",
  memory_review: "waiting_on_you",
```

Add the authority mapping in `HUB_AUTHORITY_BY_TYPE` (`hub.ts:124`) — the founder
is the sole approver of memory, so `"founder"`, matching `approval_request`/
`join_request`. Read the existing entries and match the exact `HubAuthority`
value they use for founder-decided items:

```ts
  discussion_pending: "founder",   // (or whatever value the existing founder-decided rows use)
  memory_review: "founder",
```

- [ ] **Step 4: Add the UI registry entry (required to render + deep-link)**

`ui/src/components/hub/hubRegistry.tsx:85` has a THIRD exhaustive map,
`HUB_REGISTRY: Record<HubSemanticType, HubRegistryEntry>`. Without an entry the
UI won't compile AND a `memory_review` row degrades to the notifications tab with
NO deep-link — the design's "click → Memory → Pending Review" would be dead.

Read a `waiting_on_you` sibling entry (e.g. `discussion_pending`) and add a
`memory_review` entry that mirrors it, with a `fullLink` to the Memory Pending
Review route. Find the Memory route + the `__pending` virtual-folder deep-link
shape by reading how the Memory page reads its folder from the URL (grep the
Memory page/route for `__pending`), and point `fullLink` there. Match the
sibling's `viewerKind`/`tabKind`/icon fields.

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/shared && npx vitest run && npx tsc --noEmit`
Then: `cd ui && npx tsc --noEmit -p tsconfig.json`
Expected: PASS — all three exhaustive maps typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/hub.ts packages/shared/src/hub.test.ts ui/src/components/hub/hubRegistry.tsx
git commit -m "feat(hub): memory_review semantic type + lane, authority, and UI registry entry"
```

---

## Task 4 (M3b): Hub producer, reconciler, and emit at the chokepoint

**Files:**
- Modify: `server/src/services/hub-source-producers.ts` (add `buildMemoryReviewHubEmit`)
- Modify: `server/src/services/hub-items.ts` (add `reconcileMemoryReview` + register)
- Modify: `server/src/services/memory-write.ts` (emit on pending write)
- Modify: `server/src/routes/memory.ts` (reconcile on approve/reject)
- Test: `server/src/__tests__/` (new file `memory-review-hub.test.ts`)

Read `buildDiscussionPendingHubEmit` and `reconcileDiscussion` first — this task
mirrors them for memory. **One hub row per COMPANY** (decided with the user):
`sourceType: "memory"`, `sourceId: companyId`, count = total founder-gated pending
memory across all scopes. So the Inbox shows ONE "Review N memory items" signpost,
not one per department. The per-scope breakdown lives in Memory → Pending Review
(M4 groups it there). `hub_items_source_unique_idx` dedupes to one row.

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-review-hub.test.ts`. Follow the mocking style
of the neighbouring hub tests (mock `@armyofagents/db` + `drizzle-orm`; the
builder is a pure function, the reconciler needs a small chainable db mock).

```ts
import { describe, it, expect } from "vitest";
import { buildMemoryReviewHubEmit } from "../services/hub-source-producers.js";

describe("buildMemoryReviewHubEmit", () => {
  it("builds one company-level memory_review emit", () => {
    const emit = buildMemoryReviewHubEmit({
      companyId: "co-1",
      count: 4,
      ownerUserId: "founder-1",
      updatedAt: new Date("2026-07-20T00:00:00Z"),
    });
    expect(emit.semanticType).toBe("memory_review");
    expect(emit.sourceType).toBe("memory");
    expect(emit.sourceId).toBe("co-1");         // one row per company
    expect(emit.companyId).toBe("co-1");
    expect(emit.ownerUserId).toBe("founder-1");
    expect(emit.title).toMatch(/4 memory items/i);
  });

  it("uses the singular noun for a single item", () => {
    const emit = buildMemoryReviewHubEmit({
      companyId: "co-1", count: 1, ownerUserId: "founder-1", updatedAt: new Date("2026-07-20T00:00:00Z"),
    });
    expect(emit.title).toMatch(/1 memory item\b/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/__tests__/memory-review-hub.test.ts`
Expected: FAIL — `buildMemoryReviewHubEmit` does not exist.

- [ ] **Step 3: Implement the producer**

In `server/src/services/hub-source-producers.ts`, add (mirroring
`buildDiscussionPendingHubEmit`):

```ts
export interface MemoryReviewLike {
  companyId: string;
  count: number;               // total founder-gated pending memory in the company
  ownerUserId: string | null;
  updatedAt: Date;
}

/** ONE hub row per company. N pending items across all scopes collapse to a
 *  single waiting_on_you signpost — the per-scope breakdown lives in Memory →
 *  Pending Review. sourceType "memory" + sourceId = companyId dedupes via
 *  hub_items_source_unique_idx. */
export function buildMemoryReviewHubEmit(m: MemoryReviewLike): EmitArgs {
  const noun = m.count === 1 ? "item" : "items";
  return {
    companyId: m.companyId,
    semanticType: "memory_review",
    sourceType: "memory",
    sourceId: m.companyId,
    title: `Review ${m.count} memory ${noun}`,
    summary: `${m.count} memory ${noun} ${m.count === 1 ? "is" : "are"} ready for your approval.`,
    ownerUserId: m.ownerUserId,
    sourcePermissionRevision: sourceRevision(m.updatedAt),
  };
}
```

- [ ] **Step 4: Add the reconciler + register it**

In `server/src/services/hub-items.ts`, add (mirroring `reconcileDiscussion`) a
`reconcileMemoryReview` that counts ALL founder-gated pending memory in the
company and reports terminal when zero. `sourceId` IS the companyId — no parsing.
Count `memoryItems` for `companyId` + `status = 'pending'`, excluding the
non-gated cases the producer also excludes (`source !== 'founder'`,
`layer !== 'working'`) so the count matches what actually needs review.

```ts
  const reconcileMemoryReview: SourceReconciler = async (companyId, sourceId) => {
    // sourceId IS the companyId (one hub row per company).
    const rows = await db
      .select({ id: memoryItems.id })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.companyId, companyId),
          eq(memoryItems.status, "pending"),
          ne(memoryItems.source, "founder"),
          // layer is NULLABLE — ne(layer,'working') alone drops NULL rows, which
          // would under-count. Include NULL-layer pending memory. (Review P2.)
          or(isNull(memoryItems.layer), ne(memoryItems.layer, "working")),
        ),
      );
    const count = rows.length;
    const founder = await orgHierarchyService(db).getFounderUserId(companyId);
    return {
      terminal: count <= 0,
      title: `Review ${count} memory ${count === 1 ? "item" : "items"}`,
      summary: `${count} memory ${count === 1 ? "item is" : "items are"} ready for your approval.`,
      ownerUserId: founder,
      permissionRevision: new Date().toISOString(),
    };
  };
```

Register it in `SOURCE_RECONCILERS`:

```ts
    discussion: reconcileDiscussion,
    memory: reconcileMemoryReview,
```

Ensure `memoryItems`, `ne`, `or`, `isNull`, and `orgHierarchyService` are
imported in `hub-items.ts` (grep; add if missing — `ne`/`or`/`isNull` from
`drizzle-orm`).

- [ ] **Step 5: Emit at the chokepoint**

In `server/src/services/memory-write.ts`, in `writeMemoryAndIndex` after the row
is created, emit a memory_review hub item when the write is a founder-gated
pending proposal. Best-effort, non-fatal — same try/catch discipline as the
existing embedding enqueue:

```ts
  // Signpost pending founder-gated memory in the Inbox (waiting_on_you), so the
  // founder finds it without opening Memory first. Best-effort: a hub failure
  // must never fail the memory write. Skip founder-created / already-approved
  // writes (they need no review) and working-layer notes (auto-managed).
  if (row && row.status === "pending" && row.source !== "founder" && row.layer !== "working") {
    try {
      const founderUserId = await orgHierarchyService(db).getFounderUserId(companyId);
      const count = await countPendingMemory(db, companyId);
      await emitHubItem(db, buildMemoryReviewHubEmit({
        companyId,
        count,
        ownerUserId: founderUserId,
        updatedAt: new Date(),
      }));
    } catch (err) {
      log.warn({ err, companyId }, "memory_review hub emit failed (non-fatal)");
    }
  }
```

Add a `countPendingMemory(db, companyId)` helper in this file that counts the
company's founder-gated pending memory — the SAME predicate the reconciler uses
(`status = 'pending'`, `source != 'founder'`, `layer != 'working'`), so the emit
count and the reconcile count never disagree:

```ts
async function countPendingMemory(db: Db, companyId: string): Promise<number> {
  const rows = await db
    .select({ id: memoryItems.id })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.companyId, companyId),
        eq(memoryItems.status, "pending"),
        ne(memoryItems.source, "founder"),
        // NULLABLE layer — see the reconciler note.
        or(isNull(memoryItems.layer), ne(memoryItems.layer, "working")),
      ),
    );
  return rows.length;
}
```

Import `emitHubItem`, `buildMemoryReviewHubEmit` (from `hub-source-producers.js`),
`orgHierarchyService`, `memoryItems`, `and`, `eq`, `ne`, `or`, `isNull`. Pass
`tx ?? db` to both `emitHubItem` and `countPendingMemory` (forward-safety: no
caller threads a tx today, but a future transactional caller would otherwise
undercount / risk a nested-tx issue — Review P3). Confirm `log` exists in
this module (add a `logger.child({ service: "memory-write" })` if not).

- [ ] **Step 6: Reconcile on approve/reject**

**A review caught that memory leaves `pending` through ~6 routes, not just
approve/reject** — `PATCH /:id` (to approved/rejected), `POST /:id/publish`,
`/:id/restore`, `/versions/:versionId/approve|reject`. Hooking only approve/reject
would leave the hub row stuck open when the founder uses any other path.

**Fix — reconcile at the SERVICE chokepoint, not per-route.** Every status
transition routes through `memoryService` (`server/src/services/memory.ts`). Add
the reconcile after the status-changing operations there (`approve`, `reject`, and
the status-changing `update`/`publish`/`restore`), so ALL paths are covered by one
hook. Best-effort, non-fatal:

```ts
  // Close the memory_review signpost once the company has no pending memory left.
  // reconcile("memory") sweeps the open row and closes it via reconcileMemoryReview.
  try {
    await hubItemsService(db).reconcile("memory");
  } catch (err) {
    log.warn({ err, companyId }, "memory_review reconcile failed (non-fatal)");
  }
```

Read `memoryService` first to find the narrowest set of methods every
status-out-of-pending transition passes through, and add the hook there. If a
single method (e.g. a shared `setStatus`) exists, hook that one. Add a test that
approving THEN a reconcile closes the row when the last pending item clears, and
that a non-approve status change (publish/restore of the last pending item) also
closes it.

- [ ] **Step 7: Tests for reconciler + emit**

Add to `memory-review-hub.test.ts`:

```ts
// reconciler: terminal when the company has no pending memory
it("reconcileMemoryReview reports terminal when the company has zero pending", async () => {
  // Build hubItemsService with a db mock whose memoryItems query returns [].
  // Assert the reconciler for sourceType "memory", sourceId "co-1" returns
  // { terminal: true }, and non-terminal (count in the title) when it returns rows.
});

// emit guard: a founder-created or working-layer write does NOT signpost
it("does not signpost a founder-created write", async () => {
  // writeMemoryAndIndex with source:"founder" -> emitHubItem NOT called.
});
it("does not signpost a working-layer write", async () => {
  // layer:"working" -> emitHubItem NOT called.
});
it("signposts an agent-sourced pending domain write", async () => {
  // source:"agent", status:"pending", layer:"domain" -> emitHubItem called once
  // with sourceType "memory".
});
```

Write these concretely against mocks matching `memory-write.ts`'s db usage — mock
`emitHubItem` and assert call/no-call. Follow the existing `memory-write-tools`
test's mock style.

- [ ] **Step 8: Run + typecheck + commit**

```bash
cd server && npx vitest run src/__tests__/memory-review-hub.test.ts src/__tests__/memory-write-tools.test.ts
cd server && npx tsc --noEmit -p tsconfig.json
git add server/src/services/hub-source-producers.ts server/src/services/hub-items.ts server/src/services/memory-write.ts server/src/routes/memory.ts server/src/__tests__/memory-review-hub.test.ts
git commit -m "feat(memory): signpost pending memory in the Inbox (memory_review hub item)"
```

---

## Task 5 (M4): Folder visibility in the Memory UI

**A review corrected the premise here — the original plan targeted behavior that
does not exist.** Verified in code:

- `MemoryFileList.tsx:244` already renders pending items in their real folder view
  (`it.layer === layer && it.status !== "archived"` includes pending). So pending
  items are NOT exclusive to `__pending`; they already appear in-folder — just not
  visibly MARKED as pending, and without their destination shown.
- `MemoryTree.tsx` renders **folders + counts only** — it never renders individual
  memory items. So "ghost an item into the tree" is impossible as written; there's
  no per-item render in the tree to add to.

**Rescoped M4 (what's actually real):**
1. **Destination-folder label** on each pending item row (in the pending list AND
   in-folder views), so the founder sees where it will live.
2. **A "Pending" marker** on the pending items `MemoryFileList` already shows
   in-folder, so they're visually distinct from approved items rather than blending
   in.
3. **A per-folder pending badge** in the tree — `MemoryTree` already computes
   per-folder counts; add a "N pending" signal to a folder that has pending items,
   so the structure visibly shows where unreviewed knowledge is accumulating. This
   is the tree-level "fills in" cue, done at the folder level (which the tree
   actually renders) rather than per-item (which it does not).

**Files:**
- Modify: `ui/src/components/memory/MemoryFileList.tsx` (destination label + pending marker on the item row)
- Modify: `ui/src/components/memory/MemoryTree.tsx` (per-folder pending badge)
- Test: `ui/src/components/memory/__tests__/` (or the co-located tests)

Read all three components first. `memory_items.folderPath` already carries the
destination; all three changes are read-only over existing data.

- [ ] **Step 1: Write the failing tests**

Add component tests (adapt selectors to the real components):

```ts
it("shows a pending item's destination folder", () => {
  // Render the pending-review list with an item whose folderPath is
  // "engineering/Decisions". Expect the destination label to appear.
  expect(screen.getByText(/engineering\/Decisions/)).toBeTruthy();
});

it("shows 'unfiled' for a pending item with no folderPath", () => {
  // item.folderPath === "" -> label reads "unfiled" (or "→ unfiled").
  expect(screen.getByText(/unfiled/i)).toBeTruthy();
});

it("marks a pending item in its in-folder view", () => {
  // MemoryFileList already renders pending items in their real folder (status
  // !== archived). Render that folder view with a pending item and confirm it
  // carries a pending marker distinguishing it from approved items.
  const el = screen.getByText(/We ship on Fridays/); // the pending item title
  expect(el.closest("[data-pending='true'], .pending, [aria-label*='pending' i]")).toBeTruthy();
});

it("badges a folder that has pending memory in the tree", () => {
  // MemoryTree renders per-folder counts. A folder with pending items shows a
  // "N pending" signal.
  expect(screen.getByText(/pending/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && npx vitest run src/components/memory`
Expected: FAIL — no destination label, no pending marker/badge.

- [ ] **Step 3: Implement**

- **Destination label** — in the item row (`MemoryFileList` / its `MemoryItemRow`),
  render the item's `folderPath` for pending items:

  ```tsx
  {item.status === "pending" && (
    <span className="text-[10px] text-very-dim">
      → {item.folderPath ? item.folderPath : "unfiled"}
    </span>
  )}
  ```

- **Pending marker** — the in-folder view already shows pending items
  (`MemoryFileList.tsx:244`), but undistinguished. Add a marker to the row:

  ```tsx
  {item.status === "pending" && (
    <span data-pending="true" className="ml-1 rounded bg-field px-1 text-[9px] text-dim">
      Pending
    </span>
  )}
  ```

- **Per-folder pending badge** — in `MemoryTree.tsx`, which already computes
  per-folder counts, add a pending count to the count map and render a "N pending"
  badge on folders that have any. Read how the existing per-folder `counts` are
  built (~`MemoryTree.tsx:160`) and extend that structure with a `pending` tally
  from the same items, rather than adding a new per-item render (the tree renders
  folders, not items).

- [ ] **Step 4: Run to verify they pass**

Run: `cd ui && npx vitest run src/components/memory` then `cd ui && npx vitest run src/onboarding`
Expected: PASS, no pre-existing regressions.

- [ ] **Step 5: Typecheck + commit**

```bash
cd ui && npx tsc --noEmit -p tsconfig.json
git add ui/src/components/memory/ ui/src/onboarding/inflight/LibrarianStep.tsx
git commit -m "feat(memory): show a pending item's destination folder + mark pending in the tree"
```

---

## Task 6: Live verification — the WHOLE experience through the UI

The founder asked to see this driven end-to-end through the actual UI, not just
curl: type a braindump, submit, come back, find the Inbox signpost, open Memory,
see the destination folders, and APPROVE an item through the UI — confirming it
lands in its folder and the signpost clears.

The isolated `CLAUDE_CONFIG_DIR` from the login work is signed OUT, so the
Librarian would fail. For THIS test the Librarian must WORK — restart WITHOUT the
isolated config dir so it uses the real, signed-in `~/.claude`.

- [ ] **Step 1: Rebuild + restart with a working Librarian**

```bash
cd /c/Users/TK/.aoa/wt/memstep
git checkout --detach <this-branch-HEAD>
pnpm install --prefer-offline
pnpm --filter @armyofagents/shared build
pnpm --filter @armyofagents/db build
# Kill whatever is on 3120 first. Restart WITHOUT CLAUDE_CONFIG_DIR (real creds):
AOA_INSTANCE_ID=memstep AOA_HOME=/c/Users/TK/.aoa/wt/memstep/.aoa PORT=3120 \
AOA_EMBEDDED_POSTGRES_PORT=54430 AOA_DEV_LOCAL_IDENTITY=1 \
node scripts/dev-runner.mjs watch > /tmp/memstep-mem.log 2>&1 &
```

Wait for `/api/health` = ok. Confirm `claude auth status` (no env override) shows
logged in, so the Librarian will actually run.

- [ ] **Step 2: Drive the braindump through the UI (M1 + M2)**

In the browser, on a FRESH company: walk onboarding to the Braindump step, TYPE a
real braindump into the company card (e.g. *"We optimize for candor over comfort.
We ship weekly. The founder approves all memory. Our standup is async in
Discussions."*), and click Continue.

Confirm (M1/M2): Continue advances **immediately** — no multi-second hang, no
blocking "Organizing…" wait. The onboarding proceeds. Capture the network timing
of `POST /braindumps` (read_network_requests) and confirm it returned promptly
with a non-terminal status.

- [ ] **Step 3: The Librarian runs in the background**

Watch `/tmp/memstep-mem.log` for the background dispatch + `write_memory` calls.
Confirm the founder was NOT waiting on this — it happened after the request
returned. When it finishes, the capture is terminal and pending memory exists.

- [ ] **Step 4: Find it from the Inbox (M3)**

Open the **Inbox** in the browser. Confirm a single "Review N memory items"
signpost appears in the "Waiting for you" lane (this is the bug being fixed — it
was empty before). Click it and confirm it deep-links to Memory → Pending Review.

- [ ] **Step 5: See where it's going (M4)**

In Memory → Pending Review, confirm each pending item shows its destination folder
(e.g. *"→ Company/Operating Principles"* or *"→ unfiled"*). In the folder tree,
confirm each pending item is marked as pending in its folder view, and that
folders with pending memory show a pending badge in the tree — the structure
visibly showing where unreviewed knowledge is accumulating.

- [ ] **Step 6: Approve through the UI (the whole loop)**

Approve a pending item using the UI approval control. Confirm: the item's
pending marker clears (now an approved item), the Pending Review count drops, and
when the LAST pending item is approved, the Inbox "Review N memory items"
signpost **clears** (the reconciler closes it). Screenshot the before/after if the
screenshot tool cooperates; otherwise capture the page text and the hub list.

- [ ] **Step 7: Cross-check server-side**

```bash
CID=<the company id>
curl -s "http://127.0.0.1:3120/api/companies/$CID/memory/items?status=pending" | python -c "
import json,sys
for it in json.load(sys.stdin).get('items', []):
    print(it.get('layer'),'|',it.get('folderPath') or '(unfiled)','|',it.get('title'))
"
```
Grep `server/src/routes` for the hub list path and confirm the `memory_review`
row's presence before approval and absence after the scope clears.

- [ ] **Step 8: Full suites + commit**

```bash
cd packages/shared && npx vitest run
cd ../../server && npx vitest run src/__tests__/braindump.test.ts src/__tests__/memory-review-hub.test.ts src/__tests__/memory-write-tools.test.ts
cd ../ui && npx vitest run
git commit --allow-empty -m "test: live-verify async memory dispatch + Inbox signpost + folder visibility"
```

---

## Out of scope

- The Librarian's placement logic (unchanged — it already files into real folders).
- Repo reading and the Librarian-as-general-capability work (own spec).
- The Map / Agent / Task / Braindump screen mockups (the next track).
- A durable job queue (the stale-`running` lease already covers crash recovery).
