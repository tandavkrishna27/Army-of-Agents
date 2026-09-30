# W1c — Assist Inbox Crew-Dispatch Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At **Assist** autonomy, when a discussion's scope draft auto-creates assigned crew tasks (as `planning`), enqueue a single **crew-dispatch approval** into the Inbox; approving it flips those tasks `planning → standard` and dispatches them, gated by the same budget/pause preflight as every other dispatch.

**Architecture:** Two hook points, no new routes or hub semantic types. (1) In the `create_scope_draft` handler's Assist branch (`thread-agent-actions.ts`), after `createOutputItem` produces the planning tasks, create an `approvals` row of a new `type: "crew_dispatch"` and emit its hub item — it surfaces via the existing generic `approval_request` renderer, which deep-links to `/approvals`. (2) In `approvalService.approve()`, add a `type === "crew_dispatch"` side-effect (mirroring the existing `hire_agent` branch) that runs `preflightCrewDispatch`, flips the payload's tasks to `standard`, and calls `dispatchCreatedCrewTasks`. Reject leaves the tasks parked as `planning`.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM, Vitest (unit + real-embedded-postgres integration), Playwright (E2E). Extends the W1a/W1b crew-board-assignment stack on branch `feat/w1a-crew-board-assignment`.

---

## Context & Locked Decisions

From `docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md`:

- **D1** — Assist = *auto-create + auto-assign, human approves dispatch* (Manual = propose-only; Drive = full auto).
- **D8** — Dispatch-approval UX = **Inbox / attention hub**, one-click, consistent with existing approval flows.
- **D9** — Anyone on the board (in-thread) can approve dispatch; **budget policies still bound spend**.
- **D12** — Memory stays **fully human-gated** at every level and queues **separately** in the Inbox. → The crew-dispatch approval is **tasks-only**; it never touches memory candidates (they remain `draft` per W1b).

**W1c-specific decision (locked at plan-review 2026-07-03):**
- **Reject behavior** — on reject, the auto-created tasks are **left on the Crew Board as `planning`** (parked; the founder can flip to Standard manually or delete later). No auto-cancel/delete. This matches "planning mode = human-curated, non-dispatchable" (D8 divergence).

**Eng-review findings applied (2026-07-03):**
- **A (correctness) — no double-dispatch.** `approve()` dispatches ONLY tasks still `planning` at approve-time; a task the founder already flipped to `standard`/dispatched is skipped (no duplicate wakeup). Applied in Task 1's loop.
- **B (test gap) — budget-block at approve.** Task 5 adds an integration case: approve under a company hard-stop (or paused thread) → `approve()` throws, the approval row stays `pending`, the tasks stay `planning`, and NO wakeup is enqueued (the transaction rolls back).
- **C (DRY) — shared mock helper.** Task 1's unit test uses the codebase's established drizzle mock pattern (`server/src/__tests__/helpers/drizzle-mock.js` / sequence-based `makeDb` idiom, as in `approvals-service-companyid.test.ts`) rather than a bespoke one-off, for robustness against drizzle chain shape. The `makeDb` shown in Task 1 is illustrative — prefer the shared helper when implementing.

**Pre-state (what W1b already ships):** At Assist (`gate === "accept_apply"`), the handler already creates the assigned tasks as `planning` and does **not** dispatch. `createdTasks` (`Array<{ id, assigneeAgentId, workMode }>`) is already collected in the W1b block. W1c adds the approval-enqueue for Assist and the approve-time dispatch.

**Verified mechanism (do not re-derive):**
- `approvalService.create(companyId, data)` is a pure insert (`server/src/services/approvals.ts`). Hub emission is **not** automatic — the approvals *route* emits at create via `emitHubItem(tx, buildApprovalHubEmit(created))`. Because W1c creates the approval from the handler (not the route), it must emit the hub item itself.
- `approvalService.approve(id, companyId, decidedByUserId, decisionNote?)` first flips `status → "approved"` (guarded UPDATE), then runs a per-`type` side-effect switch (today only `hire_agent`). The route calls it **inside a `db.transaction`** — so a `throw` inside the side-effect rolls the whole approval back (status stays `pending`).
- The approve **route** (`POST /approvals/:id/approve`) is generic — no per-type code. After a successful `approve()` it runs a `heartbeat.wakeup(approval.requestedByAgentId)` **only if `requestedByAgentId` is set**, and a trust-score bump only if `requestedByAgentId && linkedIssues > 0`. → W1c sets `requestedByAgentId: null` and `requestedByUserId: null` so neither fires (dispatch is system-originated, not agent-work-review).
- The hub renders any pending approval as a generic `approval_request` item (`buildApprovalHubEmit`, title `Review <type> approval`) that deep-links to `/approvals` (`hubRegistry.tsx` `fullLink: sourceLink("/approvals")`, `viewerKind: "approval"`). On non-pending status, `reconcileApproval` closes the hub item. **No new UI semantic type or approve-button wiring is needed.**
- `dispatchCreatedCrewTasks(db, companyId, tasks[])` skips `assigneeAgentId == null` and `workMode === "planning"` (`shouldDispatchIssueWakeup`). → tasks **must** be flipped to `standard` before dispatch.

---

## File Structure

**Modified:**
- `server/src/services/approvals.ts` — add `crew_dispatch` side-effect to `approve()` (preflight → flip `planning→standard` → dispatch) and a documented no-op guard in `reject()`. New imports: `issues` (from `@armyofagents/db`), `preflightCrewDispatch`, `dispatchCreatedCrewTasks`.
- `server/src/services/thread-agent-actions.ts` — in the Assist branch (`gate === "accept_apply"`), after the apply loop, enqueue the `crew_dispatch` approval + emit its hub item. New imports: `approvalService`, `buildApprovalHubEmit`, `emitHubItem`.

**New tests:**
- `server/src/__tests__/crew-dispatch-approval.test.ts` — unit: `approve()` crew_dispatch flip+dispatch (allowed), preflight-block rollback, `reject()` no-op; other types unaffected.
- `server/src/__tests__/w1c-dispatch-approval-contract.test.ts` — contract: created-approval payload shape + `requestedBy* === null`.
- `server/src/__tests__/w1c-inbox-dispatch-approval.integration.test.ts` — real-DB (Linux CI; runnable locally on Windows by flipping `skipIf(false)`): Assist commit → planning tasks + pending crew_dispatch approval + hub item; approve → flip + wakeup; approve-under-budget-block → throws + stays pending + no dispatch; reject → parked, no wakeup.
- `tests/e2e/team-aoa-crew-dispatch-approval.spec.ts` — Playwright: Assist scope → Inbox shows the approval → approve → crew task dispatched (status observable).

**Extended tests:**
- `server/src/__tests__/w1b-auto-accept.test.ts` — add an Assist case asserting `approvalService.create` + `emitHubItem` are called with the crew_dispatch shape.

---

## Task 1: `approve()` crew_dispatch side-effect — flip + preflight + dispatch

**Files:**
- Test: `server/src/__tests__/crew-dispatch-approval.test.ts`
- Modify: `server/src/services/approvals.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/crew-dispatch-approval.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock crew-budget (preflight) + crew-task-service (dispatch) so we assert the
// approve() side-effect wiring without a DB.
const { mockPreflight, mockDispatch } = vi.hoisted(() => ({
  mockPreflight: vi.fn().mockResolvedValue({ allowed: true }),
  mockDispatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/crew-budget.js", () => ({ preflightCrewDispatch: mockPreflight }));
vi.mock("../services/crew-task-service.js", () => ({
  dispatchCreatedCrewTasks: mockDispatch,
  // approvals.ts does not import the rest, but keep exports stable for co-imports.
  resolveScopeAutoAcceptGate: vi.fn(),
  resolveCreationGate: vi.fn(),
}));
// agents service is imported by approvalService(); stub it.
vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    activatePendingApproval: vi.fn(),
    create: vi.fn(),
    terminate: vi.fn(),
  }),
}));

import { approvalService } from "../services/approvals.js";

const COMPANY = "co-w1c";
const THREAD = "thread-w1c";
const T1 = "issue-1";
const T2 = "issue-2";

/**
 * Build a mock db whose update(approvals) returns the approved crew_dispatch row,
 * whose select(issues) returns the two planning tasks, and whose update(issues)
 * records the workMode flips. drizzle chains resolve via thenables.
 */
function makeDb(opts: { approvedRow: Record<string, unknown> | undefined; taskRows: Array<{ id: string; assigneeAgentId: string | null; workMode: string | null }> }) {
  const issueUpdates: Array<{ id: string; workMode: string }> = [];
  const db: any = {
    _issueUpdates: issueUpdates,
    select: (_cols?: unknown) => ({
      from: (_t: unknown) => ({
        where: (_w: unknown) => Promise.resolve(opts.taskRows),
      }),
    }),
    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (_w: unknown) => ({
          returning: () => ({ then: (r: any) => r(opts.approvedRow ? [opts.approvedRow] : []) }),
          then: (r: any) => {
            if (typeof vals.workMode === "string") issueUpdates.push({ id: "?", workMode: vals.workMode });
            return r(undefined);
          },
        }),
      }),
    }),
  };
  // getExistingApproval() does db.select().from().where().then()
  db.select = (_cols?: unknown) => ({
    from: (_t: unknown) => ({
      where: (_w: unknown) => {
        const p: any = Promise.resolve(opts.taskRows);
        p.then = (r: any) => r(opts.taskRows.length ? opts.taskRows : [{ id: "existing", status: "pending", companyId: COMPANY, type: "crew_dispatch" }]);
        return p;
      },
    }),
  });
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPreflight.mockResolvedValue({ allowed: true });
  mockDispatch.mockResolvedValue(undefined);
});

describe("approvalService.approve — crew_dispatch side-effect", () => {
  it("allowed preflight: flips planning tasks to standard and dispatches them", async () => {
    const approvedRow = {
      id: "ap1",
      companyId: COMPANY,
      type: "crew_dispatch",
      status: "approved",
      payload: { threadId: THREAD, taskIds: [T1, T2] },
    };
    const db = makeDb({
      approvedRow,
      taskRows: [
        { id: T1, assigneeAgentId: "agent-eng", workMode: "planning" },
        { id: T2, assigneeAgentId: "agent-eng", workMode: "planning" },
      ],
    });
    const svc = approvalService(db);
    const result = await svc.approve("ap1", COMPANY, "user-founder", null);

    expect(result?.status).toBe("approved");
    // preflight consulted with the thread context
    expect(mockPreflight).toHaveBeenCalledTimes(1);
    expect(mockPreflight.mock.calls[0][1]).toMatchObject({ companyId: COMPANY, threadId: THREAD });
    // both tasks flipped to standard in the update log
    expect(db._issueUpdates.filter((u: any) => u.workMode === "standard").length).toBe(2);
    // dispatch called with the two tasks now marked standard
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatched = mockDispatch.mock.calls[0][2];
    expect(dispatched.map((t: any) => t.id).sort()).toEqual([T1, T2]);
    expect(dispatched.every((t: any) => t.workMode === "standard")).toBe(true);
  });

  it("blocked preflight: throws (rolls back) and does NOT dispatch", async () => {
    mockPreflight.mockResolvedValue({ allowed: false, reason: "Company monthly budget exhausted", reasonCode: "budget_exhausted" });
    const approvedRow = { id: "ap1", companyId: COMPANY, type: "crew_dispatch", status: "approved", payload: { threadId: THREAD, taskIds: [T1] } };
    const db = makeDb({ approvedRow, taskRows: [{ id: T1, assigneeAgentId: "agent-eng", workMode: "planning" }] });
    const svc = approvalService(db);

    await expect(svc.approve("ap1", COMPANY, "user-founder", null)).rejects.toThrow(/budget/i);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/crew-dispatch-approval.test.ts`
Expected: FAIL — `approve()` has no `crew_dispatch` branch, so preflight/dispatch/flip are never called (mock assertions fail).

- [ ] **Step 3: Add imports to `approvals.ts`**

At the top of `server/src/services/approvals.ts`, extend the imports:

```typescript
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { approvalComments, approvals, issues } from "@armyofagents/db";
import { notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { preflightCrewDispatch } from "./crew-budget.js";
import { dispatchCreatedCrewTasks } from "./crew-task-service.js";
```

- [ ] **Step 4: Add the crew_dispatch branch in `approve()`**

In `approvalService(db).approve`, immediately **after** the existing `if (updated.type === "hire_agent") { … }` block and **before** `return updated;`, insert:

```typescript
    // W1c: crew-dispatch approval. On approve, flip the payload's planning tasks to
    // 'standard' and dispatch them — gated by the SAME budget/pause preflight as the
    // Drive path. A blocked preflight throws: the route runs approve() inside a
    // transaction, so the throw rolls the status flip back (approval stays pending,
    // founder gets the reason and retries after resolving budget/unpausing).
    if (updated.type === "crew_dispatch") {
      const payload = updated.payload as Record<string, unknown>;
      const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
      const taskIds = Array.isArray(payload.taskIds)
        ? payload.taskIds.filter((x): x is string => typeof x === "string")
        : [];

      if (threadId && taskIds.length > 0) {
        const preflight = await preflightCrewDispatch(db, {
          companyId,
          agentId: "",
          threadId,
        });
        if (!preflight.allowed) {
          throw unprocessable(
            `Cannot dispatch crew work: ${preflight.reason ?? preflight.reasonCode}`,
          );
        }

        const tasks = (await db
          .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, workMode: issues.workMode })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, taskIds)))) as Array<{
          id: string;
          assigneeAgentId: string | null;
          workMode: string | null;
        }>;

        // Eng-review finding A: dispatch ONLY the tasks this approval flips
        // planning→standard. A task the founder already flipped to 'standard'
        // (and thus already dispatched) is skipped, so approving never enqueues a
        // duplicate wakeup for it. This approval owns only its own parked tasks.
        const toDispatch: Array<{ id: string; assigneeAgentId: string | null; workMode: string | null }> = [];
        for (const t of tasks) {
          if (t.workMode !== "planning") continue; // already dispatched elsewhere — leave it
          // Raw flip (no issueService.update wake side-effect) — dispatch is explicit below.
          await db
            .update(issues)
            .set({ workMode: "standard", updatedAt: new Date() })
            .where(and(eq(issues.id, t.id), eq(issues.companyId, companyId)));
          toDispatch.push({ id: t.id, assigneeAgentId: t.assigneeAgentId, workMode: "standard" });
        }

        await dispatchCreatedCrewTasks(db, companyId, toDispatch);
      }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/crew-dispatch-approval.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/approvals.ts server/src/__tests__/crew-dispatch-approval.test.ts
git commit -m "feat(scope): crew_dispatch approve side-effect — preflight + flip planning→standard + dispatch (W1c)"
```

---

## Task 2: `reject()` crew_dispatch — leave tasks parked (documented no-op)

**Files:**
- Test: `server/src/__tests__/crew-dispatch-approval.test.ts` (extend)
- Modify: `server/src/services/approvals.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/__tests__/crew-dispatch-approval.test.ts` inside the top-level file (new describe):

```typescript
describe("approvalService.reject — crew_dispatch side-effect", () => {
  it("reject: does NOT dispatch and does NOT flip workMode (tasks stay planning)", async () => {
    const rejectedRow = { id: "ap1", companyId: COMPANY, type: "crew_dispatch", status: "rejected", payload: { threadId: THREAD, taskIds: [T1] } };
    const db = makeDb({ approvedRow: rejectedRow, taskRows: [{ id: T1, assigneeAgentId: "agent-eng", workMode: "planning" }] });
    const svc = approvalService(db);

    const result = await svc.reject("ap1", COMPANY, "user-founder", "not now");
    expect(result?.status).toBe("rejected");
    expect(mockDispatch).not.toHaveBeenCalled();
    // no standard flips recorded
    expect(db._issueUpdates.filter((u: any) => u.workMode === "standard").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (no-op default already holds)**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/crew-dispatch-approval.test.ts -t "reject"`
Expected: PASS — `reject()` has no dispatch path today, so tasks stay `planning`. (If it fails because `reject()` throws on the mock row shape, adjust the `makeDb` reject path — but do NOT add a dispatch side-effect.)

- [ ] **Step 3: Add an explicit intent comment in `reject()`**

In `approvalService(db).reject`, after the status-flip `if (updated.type === "hire_agent") { … agentsSvc.terminate … }` block, add a short comment so the no-op is intentional (no code):

```typescript
    // W1c: crew_dispatch reject is intentionally a NO-OP on the tasks. Auto-created
    // tasks stay on the Crew Board as 'planning' (parked) — the founder can flip them
    // to Standard or delete them later. Rejecting only closes the dispatch approval.
```

- [ ] **Step 4: Run test again + typecheck**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/crew-dispatch-approval.test.ts`
Run: `pnpm --filter @armyofagents/server exec tsc --noEmit`
Expected: PASS + exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/approvals.ts server/src/__tests__/crew-dispatch-approval.test.ts
git commit -m "test(scope): crew_dispatch reject leaves tasks parked as planning (W1c)"
```

---

## Task 3: Assist branch enqueues the crew_dispatch approval + hub item

**Files:**
- Modify: `server/src/services/thread-agent-actions.ts`
- Test: `server/src/__tests__/w1b-auto-accept.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

In `server/src/__tests__/w1b-auto-accept.test.ts`, add mocks for `approvals` + `hub-source-producers` near the other `vi.mock` blocks at the top of the file:

```typescript
// Mock approvalService.create + hub emit so the Assist branch's approval-enqueue is observable.
const { mockApprovalCreate, mockEmitHubItem, mockBuildApprovalHubEmit } = vi.hoisted(() => ({
  mockApprovalCreate: vi.fn().mockResolvedValue({ id: "ap-w1c-1", companyId: "company-w1b", type: "crew_dispatch" }),
  mockEmitHubItem: vi.fn().mockResolvedValue(undefined),
  mockBuildApprovalHubEmit: vi.fn().mockReturnValue({ semanticType: "approval_request" }),
}));
vi.mock("../services/approvals.js", () => ({
  approvalService: () => ({ create: mockApprovalCreate }),
}));
vi.mock("../services/hub-source-producers.js", () => ({
  emitHubItem: mockEmitHubItem,
  buildApprovalHubEmit: mockBuildApprovalHubEmit,
}));
```

Add a `beforeEach` reset (inside the existing `describe`'s `beforeEach`):

```typescript
    mockApprovalCreate.mockResolvedValue({ id: "ap-w1c-1", companyId: COMPANY_ID, type: "crew_dispatch" });
    mockEmitHubItem.mockResolvedValue(undefined);
```

Add a new test after the existing Assist test:

```typescript
  it("Assist (autonomy 1): enqueues ONE crew_dispatch approval (requestedBy* null, payload.taskIds) + emits a hub item", async () => {
    mockResolveScopeAutoAcceptGate.mockReturnValue("accept_apply");

    const db = makeDb({ threadAutonomy: 1, companyAutonomy: 0, taskItems: [taskItemRow] });
    const createOutputItem = vi.fn().mockResolvedValue({
      ok: true,
      item: { id: TASK_ITEM_ID, status: "applied" },
      createdTask: { id: "issue-created-1", assigneeAgentId: "agent-eng", workMode: "planning" },
    });

    await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: {
        createDraftFromThread: vi.fn().mockResolvedValue(draftReturn),
        createOutputItem,
      },
    }).commitThreadAgentActions({ companyId: COMPANY_ID, threadId: THREAD_ID, runId: "run-w1b" });

    // Exactly one approval created, of type crew_dispatch, system-originated, carrying the created task id.
    expect(mockApprovalCreate).toHaveBeenCalledTimes(1);
    const [companyArg, dataArg] = mockApprovalCreate.mock.calls[0];
    expect(companyArg).toBe(COMPANY_ID);
    expect(dataArg).toMatchObject({
      type: "crew_dispatch",
      status: "pending",
      requestedByAgentId: null,
      requestedByUserId: null,
    });
    expect(dataArg.payload).toMatchObject({ threadId: THREAD_ID });
    expect(dataArg.payload.taskIds).toEqual(["issue-created-1"]);
    // Hub item emitted for it.
    expect(mockBuildApprovalHubEmit).toHaveBeenCalledTimes(1);
    expect(mockEmitHubItem).toHaveBeenCalledTimes(1);
    // Still no direct dispatch at Assist.
    expect(mockDispatchCreatedCrewTasks).not.toHaveBeenCalled();
  });
```

Also update the existing Assist test (`"Assist (autonomy 1): createOutputItem called ONCE …"`) — it already asserts `mockDispatchCreatedCrewTasks` not called; add one line so the new approval path is exercised without breaking it:

```typescript
    // W1c: Assist enqueues a dispatch approval instead of dispatching.
    expect(mockApprovalCreate).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/w1b-auto-accept.test.ts -t "crew_dispatch approval"`
Expected: FAIL — the handler doesn't create an approval yet (`mockApprovalCreate` never called).

- [ ] **Step 3: Add imports to `thread-agent-actions.ts`**

Add near the existing `crew-task-service` / `crew-budget` imports:

```typescript
import { approvalService } from "./approvals.js";
import { buildApprovalHubEmit, emitHubItem } from "./hub-source-producers.js";
```

- [ ] **Step 4: Enqueue the approval in the Assist branch**

In `server/src/services/thread-agent-actions.ts`, inside the `if (!driveBlocked) { … }` block, **after** the `for (const { id: itemId } of taskItems) { … }` apply loop and the existing Drive `if (gate === "accept_apply_dispatch" && createdTasks.length > 0) { await dispatchCreatedCrewTasks(...) }`, add the Assist branch:

```typescript
                    // W1c: Assist auto-creates the tasks as 'planning' but does not
                    // dispatch — instead enqueue ONE crew-dispatch approval into the
                    // Inbox. Approving it (via /approvals) flips these tasks to
                    // 'standard' and dispatches them (approvals.ts crew_dispatch branch).
                    // system-originated: requestedBy* = null so the approve route's
                    // generic requester-wakeup + trust-score bump do not fire.
                    if (gate === "accept_apply" && createdTasks.length > 0) {
                      const created = await approvalService(
                        actionDb as unknown as import("@armyofagents/db").Db,
                      ).create(input.companyId, {
                        type: "crew_dispatch",
                        status: "pending",
                        requestedByAgentId: null,
                        requestedByUserId: null,
                        payload: {
                          threadId: input.threadId,
                          scopeVersionId: draft.version.id,
                          taskIds: createdTasks.map((t) => t.id),
                          proposedByAgentId: action.agentId ?? null,
                        },
                        decisionNote: null,
                        decidedByUserId: null,
                        decidedAt: null,
                        updatedAt: new Date(),
                      });
                      if (created) {
                        await emitHubItem(
                          actionDb as unknown as import("@armyofagents/db").Db,
                          buildApprovalHubEmit(created),
                        );
                      }
                    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/w1b-auto-accept.test.ts`
Expected: PASS (all W1b cases + the new Assist crew_dispatch case).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/thread-agent-actions.ts server/src/__tests__/w1b-auto-accept.test.ts
git commit -m "feat(scope): Assist enqueues crew_dispatch Inbox approval on scope auto-accept (W1c)"
```

---

## Task 4: Contract test — created-approval payload shape

**Files:**
- Test: `server/src/__tests__/w1c-dispatch-approval-contract.test.ts`

This is a pure contract test — it pins the wire shape W1c produces so a future refactor can't silently drop `taskIds` or set a `requestedByAgentId` (which would trigger a spurious requester-wakeup).

- [ ] **Step 1: Write the test**

Create `server/src/__tests__/w1c-dispatch-approval-contract.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

/**
 * The exact object the Assist branch passes to approvalService.create(companyId, data).
 * Mirrors server/src/services/thread-agent-actions.ts. If the handler shape changes,
 * update BOTH — this is the contract crew_dispatch approve() depends on.
 */
function buildCrewDispatchApprovalData(args: {
  threadId: string;
  scopeVersionId: string;
  taskIds: string[];
  proposedByAgentId: string | null;
}) {
  return {
    type: "crew_dispatch" as const,
    status: "pending" as const,
    requestedByAgentId: null,
    requestedByUserId: null,
    payload: {
      threadId: args.threadId,
      scopeVersionId: args.scopeVersionId,
      taskIds: args.taskIds,
      proposedByAgentId: args.proposedByAgentId,
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
  };
}

describe("W1c crew_dispatch approval contract", () => {
  it("is system-originated (no requester) so the approve route skips requester-wakeup + trust-score", () => {
    const data = buildCrewDispatchApprovalData({ threadId: "t1", scopeVersionId: "sv1", taskIds: ["i1", "i2"], proposedByAgentId: "adjutant" });
    expect(data.requestedByAgentId).toBeNull();
    expect(data.requestedByUserId).toBeNull();
  });

  it("carries the thread + version + task ids the approve() side-effect needs", () => {
    const data = buildCrewDispatchApprovalData({ threadId: "t1", scopeVersionId: "sv1", taskIds: ["i1", "i2"], proposedByAgentId: null });
    expect(data.type).toBe("crew_dispatch");
    expect(data.status).toBe("pending");
    expect(data.payload.threadId).toBe("t1");
    expect(data.payload.scopeVersionId).toBe("sv1");
    expect(data.payload.taskIds).toEqual(["i1", "i2"]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/w1c-dispatch-approval-contract.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/w1c-dispatch-approval-contract.test.ts
git commit -m "test(scope): contract — crew_dispatch approval payload shape (W1c)"
```

---

## Task 5: Real-DB integration — Assist → approval → approve/reject

**Files:**
- Test: `server/src/__tests__/w1c-inbox-dispatch-approval.integration.test.ts`

Model this on `server/src/__tests__/w1b-auto-accept.integration.test.ts` (copy its embedded-postgres lifecycle — **including `initdbFlags: ["--encoding=UTF8", "--locale=C"]`** and `describe.skipIf(process.platform === "win32")` — and the `seedCompanyAndAgent` / `seedThreadWithInsight` / `seedRun` / `setThreadAutonomy` helpers **verbatim** — including the SELECT-or-INSERT Engineer reuse). Then add the W1c cases. To validate locally on Windows, temporarily flip `skipIf(false)` (the UTF-8 flags make the cluster locale-safe); flip back before committing.

- [ ] **Step 1: Scaffold the file**

Copy the full header + helpers + `beforeAll`/`afterAll` from `w1b-auto-accept.integration.test.ts`, changing the tmpdir prefix to `aoa-w1c-dispatch-approval-integ-` and the PORT constant to a unique value (e.g. `+3` from the W1b port). Import the approval service:

```typescript
import { approvalService } from "../services/approvals.js";
```

- [ ] **Step 2: Write the Assist-enqueue case**

```typescript
describe.skipIf(process.platform === "win32")("W1c integration: Assist crew-dispatch approval", () => {
  it("Assist: commit creates planning tasks + a PENDING crew_dispatch approval + a hub item", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("Assist");
    const { threadId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 1); // Assist

    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
         ${JSON.stringify({ summary: "Auth scope", proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }] })}::jsonb,
         ${`k:w1c:assist:${actionId}`}, ${JSON.stringify(snap)}::jsonb)
    `);

    const commitResult = await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId });
    expect(commitResult.committed).toBe(1);

    // Tasks exist as planning, assigned to Engineer.
    const issueRows = rowsOf(await db.execute(sql`
      SELECT id, assignee_agent_id, work_mode FROM issues WHERE source_discussion_id = ${threadId}
    `));
    expect(issueRows).toHaveLength(1);
    expect(String(issueRows[0].work_mode)).toBe("planning");
    const issueId = String(issueRows[0].id);

    // A pending crew_dispatch approval referencing that task exists.
    const apRows = rowsOf(await db.execute(sql`
      SELECT id, status, payload FROM approvals WHERE company_id = ${companyId} AND type = 'crew_dispatch'
    `));
    expect(apRows).toHaveLength(1);
    expect(String(apRows[0].status)).toBe("pending");
    expect((apRows[0].payload as any).taskIds).toContain(issueId);

    // A hub item (notifications row) surfaced it.
    const hubRows = rowsOf(await db.execute(sql`
      SELECT id FROM notifications WHERE company_id = ${companyId} AND source_type = 'approval' AND source_id = ${String(apRows[0].id)}
    `));
    expect(hubRows.length).toBeGreaterThanOrEqual(1);

    // No wakeup yet.
    const wake = rowsOf(await db.execute(sql`SELECT id FROM agent_wakeup_requests WHERE issue_id = ${issueId}`));
    expect(wake).toHaveLength(0);
  });
```

- [ ] **Step 3: Write the approve case (flip + dispatch)**

```typescript
  it("approve: flips the tasks to standard and enqueues a wakeup", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("AssistApprove");
    const { threadId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 1);
    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
        ${JSON.stringify({ summary: "Auth scope", proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }] })}::jsonb,
        ${`k:w1c:approve:${actionId}`}, ${JSON.stringify(snap)}::jsonb)
    `);
    await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId });

    const apRows = rowsOf(await db.execute(sql`SELECT id FROM approvals WHERE company_id = ${companyId} AND type = 'crew_dispatch'`));
    const approvalId = String(apRows[0].id);
    const issueRows = rowsOf(await db.execute(sql`SELECT id FROM issues WHERE source_discussion_id = ${threadId}`));
    const issueId = String(issueRows[0].id);

    // Approve within a transaction, exactly like the /approvals/:id/approve route.
    await db.transaction(async (tx) => {
      await approvalService(tx as never).approve(approvalId, companyId, "local-board", null);
    });

    const afterWorkMode = rowsOf(await db.execute(sql`SELECT work_mode FROM issues WHERE id = ${issueId}`));
    expect(String(afterWorkMode[0].work_mode)).toBe("standard");
    const wake = rowsOf(await db.execute(sql`SELECT id FROM agent_wakeup_requests WHERE issue_id = ${issueId} AND agent_id = ${agentId}`));
    expect(wake.length).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 4: Write the reject case (parked, no dispatch)**

```typescript
  it("reject: leaves the tasks as planning and enqueues NO wakeup", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("AssistReject");
    const { threadId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 1);
    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
        ${JSON.stringify({ summary: "Auth scope", proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }] })}::jsonb,
        ${`k:w1c:reject:${actionId}`}, ${JSON.stringify(snap)}::jsonb)
    `);
    await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId });

    const apRows = rowsOf(await db.execute(sql`SELECT id FROM approvals WHERE company_id = ${companyId} AND type = 'crew_dispatch'`));
    const approvalId = String(apRows[0].id);
    const issueRows = rowsOf(await db.execute(sql`SELECT id FROM issues WHERE source_discussion_id = ${threadId}`));
    const issueId = String(issueRows[0].id);

    await db.transaction(async (tx) => {
      await approvalService(tx as never).reject(approvalId, companyId, "local-board", "not now");
    });

    const afterWorkMode = rowsOf(await db.execute(sql`SELECT work_mode FROM issues WHERE id = ${issueId}`));
    expect(String(afterWorkMode[0].work_mode)).toBe("planning");
    // agent_wakeup_requests has NO issue_id column — crew wakeups store the id in payload jsonb.
    const wake = rowsOf(await db.execute(sql`SELECT id FROM agent_wakeup_requests WHERE agent_id = ${agentId} AND payload->>'issueId' = ${issueId}`));
    expect(wake).toHaveLength(0);
  });
```

- [ ] **Step 4b: Write the budget-block-at-approve case (eng-review finding B)**

```typescript
  it("approve under a budget hard-stop throws, leaves the approval pending + tasks planning, dispatches nothing", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("AssistBlocked");
    const { threadId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 1);
    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
        ${JSON.stringify({ summary: "Auth scope", proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }] })}::jsonb,
        ${`k:w1c:blocked:${actionId}`}, ${JSON.stringify(snap)}::jsonb)
    `);
    await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId });

    // Pause the thread → preflightCrewDispatch returns { allowed:false, reasonCode:'thread_paused' }.
    await db.execute(sql`UPDATE discussions SET crew_paused = true WHERE id = ${threadId}`);

    const apRows = rowsOf(await db.execute(sql`SELECT id FROM approvals WHERE company_id = ${companyId} AND type = 'crew_dispatch'`));
    const approvalId = String(apRows[0].id);
    const issueRows = rowsOf(await db.execute(sql`SELECT id FROM issues WHERE source_discussion_id = ${threadId}`));
    const issueId = String(issueRows[0].id);

    // approve() throws inside the tx → the whole approval rolls back.
    let threw = false;
    try {
      await db.transaction(async (tx) => {
        await approvalService(tx as never).approve(approvalId, companyId, "local-board", null);
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Approval stays pending, task stays planning, no wakeup.
    const [ap] = rowsOf(await db.execute(sql`SELECT status FROM approvals WHERE id = ${approvalId}`));
    expect(String(ap.status)).toBe("pending");
    const [wm] = rowsOf(await db.execute(sql`SELECT work_mode FROM issues WHERE id = ${issueId}`));
    expect(String(wm.work_mode)).toBe("planning");
    const wake = rowsOf(await db.execute(sql`SELECT id FROM agent_wakeup_requests WHERE agent_id = ${agentId} AND payload->>'issueId' = ${issueId}`));
    expect(wake).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Force-run locally (best-effort) + typecheck**

To run locally on Windows, temporarily flip this file's `describe.skipIf(process.platform === "win32")` to `describe.skipIf(false)`, then:
Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/w1c-inbox-dispatch-approval.integration.test.ts`
Expected: PASS (the `initdbFlags: ["--encoding=UTF8","--locale=C"]` in the setup make embedded-postgres locale-safe, so migration comments with `→` apply). Flip `skipIf` back to `process.platform === "win32"` before committing. Always run `pnpm --filter @armyofagents/server exec tsc --noEmit` (exit 0) before committing.

- [ ] **Step 6: Commit**

```bash
git add server/src/__tests__/w1c-inbox-dispatch-approval.integration.test.ts
git commit -m "test(scope): integration — Assist crew_dispatch approval → approve flips+dispatches, reject parks (W1c)"
```

---

## Task 6: E2E — Inbox dispatch approval round-trip

**Files:**
- Test: `tests/e2e/team-aoa-crew-dispatch-approval.spec.ts`

Model on `tests/e2e/team-aoa-crew-assignment.spec.ts` (same company/agent/thread REST seeding + `jsonOrThrow` helper). The spec drives an Assist thread to auto-create the tasks + approval via the same `create_scope_draft` REST path W1a's spec uses, asserts the approval surfaces, approves it via the approvals API, and asserts the crew task became dispatchable.

- [ ] **Step 1: Write the spec**

Create `tests/e2e/team-aoa-crew-dispatch-approval.spec.ts`. Reuse the W1a spec's setup block up to the point where the scope draft is committed, but set the thread autonomy to **Assist (1)** before committing (via `PATCH /companies/:id/discussions/:tid` or the autonomy control the W1a spec already uses). Then:

```typescript
    // ── After Assist commit: a pending crew_dispatch approval exists ──────────
    const approvals = await jsonOrThrow<Array<{ id: string; type: string; status: string; payload: { taskIds?: string[] } }>>(
      await request.get(`/api/companies/${company.id}/approvals?status=pending`),
      "list pending approvals",
    );
    const dispatchApproval = approvals.find((a) => a.type === "crew_dispatch");
    expect(dispatchApproval, "a crew_dispatch approval should be enqueued at Assist").toBeTruthy();
    expect(dispatchApproval!.payload.taskIds).toContain(created.createdTask!.id);

    // ── The task is on the Crew Board but parked (planning) ──────────────────
    const before = await jsonOrThrow<Array<{ id: string; workMode?: string | null }>>(
      await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
      "list crew issues (before)",
    );
    expect(before.find((i) => i.id === created.createdTask!.id)?.workMode).toBe("planning");

    // ── Approve the dispatch (Inbox one-click == POST /approvals/:id/approve) ──
    await jsonOrThrow(
      await request.post(`/api/approvals/${dispatchApproval!.id}/approve`, { data: { decisionNote: null } }),
      "approve crew_dispatch",
    );

    // ── The task flipped to standard (dispatchable) ──────────────────────────
    const after = await jsonOrThrow<Array<{ id: string; workMode?: string | null }>>(
      await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
      "list crew issues (after)",
    );
    expect(after.find((i) => i.id === created.createdTask!.id)?.workMode).toBe("standard");
```

If the approvals list route is company-scoped differently (verify the exact path with `grep -n "approvals" server/src/routes/approvals.ts` and `ui/src/api/approvals.ts`), adjust the URLs to match. Keep the UI assertion minimal — the value here is the API round-trip proving Assist parks + approve dispatches.

- [ ] **Step 2: Run the spec (CI is source of truth)**

The e2e suite needs the full built server + Playwright browser. On Linux CI it runs in the required `e2e` gate. Locally it may be run with `AOA_E2E_FORCE_WINDOWS=1` but is heavy; prefer CI. If run locally, first copy the marketplace fixture per the repo's e2e setup.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/team-aoa-crew-dispatch-approval.spec.ts
git commit -m "test(e2e): Assist Inbox crew_dispatch approval round-trip → task dispatched (W1c)"
```

---

## Task 7: Docs — update the CLAUDE.md discussion-pipeline + design doc status

**Files:**
- Modify: `docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md` (mark W1c done in the W1 section)
- Modify: `CLAUDE.md` (Discussion Pipeline section — one line noting Assist raises an Inbox crew_dispatch approval; Drive auto-dispatches; both gated by `preflightCrewDispatch`)

- [ ] **Step 1: Update the design doc**

In `docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md`, in the W1 workstream section, append a status line noting W1c shipped: Assist raises a `crew_dispatch` Inbox approval; approving flips `planning→standard` + dispatches (preflight-gated); reject parks the tasks.

- [ ] **Step 2: Update CLAUDE.md**

In the **Discussion Pipeline** section of `CLAUDE.md`, add one sentence after the extraction-engine paragraph:

```markdown
- **Autonomy → dispatch:** scope drafts auto-apply per thread autonomy. Manual = propose-only. **Assist = auto-create + assign as `planning`, then raise a `crew_dispatch` approval in the Inbox** (approve → flip `planning→standard` + dispatch; reject → tasks stay parked). Drive = auto-dispatch. Every dispatch (Drive auto + Assist-on-approve) runs `preflightCrewDispatch` (company budget hard-stop + thread pause/disable); blocked → left for manual accept. Memory candidates always stay founder-gated (D12).
```

- [ ] **Step 3: Commit**

```bash
git add docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md CLAUDE.md
git commit -m "docs(scope): record W1c Assist Inbox dispatch-approval + preflight gate"
```

---

## Task 8: Full verification sweep

- [ ] **Step 1: Server unit + contract tests (Windows-safe)**

Run:
```bash
pnpm --filter @armyofagents/server exec vitest run \
  src/__tests__/crew-dispatch-approval.test.ts \
  src/__tests__/w1c-dispatch-approval-contract.test.ts \
  src/__tests__/w1b-auto-accept.test.ts \
  src/__tests__/scope-auto-accept-gate.test.ts \
  src/__tests__/w1b-dispatch-mode-contract.test.ts \
  src/__tests__/approvals-service-companyid.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Typecheck the whole server + UI**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit`
Run: `pnpm --filter @armyofagents/ui exec tsc --noEmit` (KanbanBoard testid change from W1b's fix is already in; confirm no regressions)
Expected: exit 0 for both.

- [ ] **Step 3: Force-run the W1c + W1a + W1b integration tests locally (best-effort)**

To validate on Windows, temporarily flip each file's `skipIf` to `false`, then:
Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/w1c-inbox-dispatch-approval.integration.test.ts src/__tests__/w1a-crew-assignment.integration.test.ts src/__tests__/w1b-auto-accept.integration.test.ts`
Expected: all PASS (UTF-8 initdbFlags make embedded-postgres locale-safe). Flip `skipIf` back to `process.platform === "win32"` before committing.

- [ ] **Step 4: Push and confirm CI green**

```bash
git push
```
Then watch `gh pr checks 265` until `verify`, `e2e`, `migrations`, `policy`, `brand-check`, `ci-required` are all green.

---

## Self-Review

**Spec coverage (design doc):**
- D1 (Assist = auto-create+assign, approve dispatch) → Task 3 (enqueue approval) + Task 1 (approve dispatches). ✓
- D8 (Inbox one-click, existing approval flow) → generic `approval_request` hub item + `/approvals` deep-link; no new UI. Task 3 emits it; Task 6 exercises the round-trip. ✓
- D9 (anyone in-thread approves; budget bounds spend) → approve via existing `/approvals` route RBAC; `preflightCrewDispatch` enforced in Task 1. ✓
- D12 (memory stays separately gated) → crew_dispatch payload is `taskIds` only; memory candidates untouched (W1b already leaves them `draft`). ✓
- Reject default (leave parked) → Task 2 + Task 5 reject case. ✓

**Placeholder scan:** all code steps contain full code; no TBD/TODO. Integration/e2e steps reference verbatim reuse of existing helpers with exact file sources. ✓

**Type consistency:**
- `dispatchCreatedCrewTasks(db, companyId, Array<{ id; assigneeAgentId; workMode }>)` — used identically in Task 1 and matches `crew-task-service.ts`. ✓
- `preflightCrewDispatch(db, { companyId, agentId, threadId })` → `{ allowed; reason?; reasonCode? }` — Task 1 handles both branches. ✓
- `approvalService.create(companyId, data)` `data` matches `approvals.$inferInsert` minus `companyId` (type/status/requestedBy*/payload/decision*/updatedAt) — Task 3. ✓
- `buildApprovalHubEmit(approval)` + `emitHubItem(db, args)` from `./hub-source-producers.js` — Task 3 imports match the approvals-route usage. ✓
- `approve()`/`reject()` signatures `(id, companyId, decidedByUserId, decisionNote?)` — Tasks 1/2/5. ✓

**Open item for plan-review:** reject behavior default = *leave parked* (LOCKED at review — see Eng-review findings above). If you later prefer auto-cancel/archive on reject, change Task 2 to flip status → `cancelled` (or archive) and update the Task 5 reject assertion.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 3 findings, all resolved; 0 critical gaps |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — (no new UI — reuses generic approval_request hub item) |
| Outside Voice | `/codex` | Independent 2nd opinion | 0 | — (skipped — CI-remediation took priority this session) |

**Step 0 (scope):** accepted as-is — 2 source files, 0 new classes/services, heavy reuse of the existing `approvalService`/hub/`/approvals` machinery (the `hire_agent` pattern). No reduction needed.

**Findings (all resolved, folded into the plan):**
- **A (P2, correctness)** — `approve()` double-dispatch: dispatch only tasks still `planning` at approve-time. → applied in Task 1's loop (`if (t.workMode !== "planning") continue`).
- **B (P2, test gap)** — no budget-block-at-approve integration coverage. → Task 5 Step 4b added (approve under pause/hard-stop throws, approval stays pending, tasks stay planning, no wakeup).
- **C (P2, DRY)** — bespoke unit-test mock vs the codebase helper. → Task 1 notes the shared `helpers/drizzle-mock.js` idiom is preferred; illustrative `makeDb` kept for reference.

**NOT in scope:** memory-candidate approval (stays in its own founder-gated queue, D12); per-thread RBAC beyond existing `/approvals` route auth (D9 satisfied by board-access); a dedicated crew_dispatch hub viewer/UI (generic `approval_request` deep-link suffices); org-agent auto-routing (deferred follow-up).

**What already exists (reused, not rebuilt):** `approvalService.create`/`approve`/`reject` + type-switch side-effect pattern (`hire_agent`); `buildApprovalHubEmit`/`emitHubItem` (approval → Inbox); generic `approval_request` renderer + `/approvals` deep-link; `dispatchCreatedCrewTasks` + `preflightCrewDispatch`; the W1b Assist branch (already creates planning tasks — W1c only adds the approval-enqueue + approve-time dispatch).

**Failure modes covered:** budget hard-stop / paused thread at approve (throws + rollback — Task 5 4b); already-dispatched task at approve (skipped — finding A); stale/deleted task ids in payload (`inArray` returns absent rows harmlessly).

**VERDICT: ENG REVIEW CLEAR — ready to implement.** Sequencing: land after PR #265 (W1a+W1b) merges, since W1c builds on the W1b Assist branch.
