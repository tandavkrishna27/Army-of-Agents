# W1b: Autonomy-Gated Auto-Accept of Controller Scope Drafts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** After the controller `create_scope_draft` action produces a draft (W1a: with crew-assigned `task_proposal` items), auto-accept + apply it **gated by effective autonomy** — Manual: draft only; Assist: auto-create + assign the tasks (Crew Board populates), NO dispatch; Drive: auto-create + assign + dispatch. **Memory candidates are never auto-accepted** (founder-gated, D12).

**Architecture:** In the `create_scope_draft` commit handler (`thread-agent-actions.ts`), right after `createDraftFromThread` returns, resolve `effectiveAutonomy = thread.autonomyLevel ?? internal_agent_config.autonomyLevel`, run a new pure 3-way gate, and for Assist/Drive: fetch the draft's **`task_proposal`** item ids and apply them **one-by-one via `createOutputItem`** (the per-item, **version-preserving** primitive — it materializes a single item's output and leaves the version `draft`), passing a new `dispatchMode` (`"standard"` at Drive → dispatchable `workMode`, else `"planning"`); collect the returned `createdTask`s; at Drive call the existing `dispatchCreatedCrewTasks`. **Why not `applyAcceptedDraft`:** it marks the whole version `accepted` (`thread-scope-versions.ts:1294-1308`), which would **strand the un-accepted `memory_candidate` items** — the founder could never approve them (`createOutputItem` requires `status='draft'`). `createOutputItem` avoids this: memory candidates stay `draft` for founder approval (D12). Each `createOutputItem` opens its own tx; the handler opens none, so it's safe.

**Tech Stack:** TypeScript (ESM), Drizzle ORM, Vitest, Playwright.

**Depends on:** W1a (merged/branch `feat/w1a-crew-board-assignment`). Build W1b on top of it.

---

## Design decisions (locked)

| # | Decision |
|---|----------|
| B1 | New pure `resolveScopeAutoAcceptGate(autonomy)` → `"draft_only" \| "accept_apply" \| "accept_apply_dispatch"` (0→draft_only, 1→accept_apply, ≥2→accept_apply_dispatch; null/undefined→draft_only, fail-closed). **Do not touch** `resolveCreationGate` (Path A). |
| B2 | Effective autonomy fetched in the handler: `thread.autonomyLevel ?? internalAgentConfig.autonomyLevel` (mirror `controller-adjutant-runner.ts:96-107`). |
| B3 | `createOutputItem` gains a `dispatchMode?: "standard" \| "planning"` field on its existing `options: CreateScopeOutputOptions` param (default `"planning"`, byte-unchanged for existing callers); it sets the created issue's `workMode`. (The auto-accept path uses `createOutputItem`, NOT `applyAcceptedDraft` — see B7.) |
| B4 | **Auto-accept applies ONLY `task_proposal` items** (crew work), via `createOutputItem` per item. `memory_candidate`/`decision`/other kinds are left untouched (`draft`) for the founder (memory human-gated at every level, D12). |
| B5 | Drive dispatch reuses `dispatchCreatedCrewTasks(db, companyId, createdTasks)` — it skips null-assignee + planning-mode. Assist creates `planning` tasks → not dispatched (board shows them, un-dispatched). |
| B7 | **Use per-item `createOutputItem`, NOT `applyAcceptedDraft`** (eng-review W1b-1). `applyAcceptedDraft` closes the version (`:1294-1308`) and would strand un-accepted memory items. `createOutputItem` applies one draft item and leaves the version `draft`. No separate `acceptDraft` step is needed — `createOutputItem` applies a `draft` item directly (it checks not-already-applied/rejected, `:1382-1387`). |
| B6 | The auto-accept is best-effort within the commit tick: if it throws, log + still commit the draft (the founder can accept manually). Never let auto-accept failure poison the outbox action. |

---

## File structure

- **Modify** `server/src/services/crew-task-service.ts` — add `resolveScopeAutoAcceptGate` (pure, exported).
- **Modify** `server/src/services/thread-scope-versions.ts` — `applyAcceptedDraft` + `createOutputItem` + `acceptDraft` accept + thread `dispatchMode` → `workMode`.
- **Modify** `server/src/services/thread-agent-actions.ts` — the `create_scope_draft` handler: fetch autonomy, gate, auto-accept task items, dispatch at Drive.
- **Test** (new): `server/src/__tests__/scope-auto-accept-gate.test.ts` (pure gate), `server/src/__tests__/w1b-auto-accept.test.ts` (handler unit), `server/src/__tests__/w1b-auto-accept.integration.test.ts` (real-DB per-autonomy), `server/src/__tests__/w1b-dispatch-mode-contract.test.ts` (workMode contract).
- **Modify** `server/src/__tests__/thread-scope-accept.test.ts` — regression for `dispatchMode` default (absent → `planning`).

---

## Task 1: Pure 3-way auto-accept gate

**Files:** Modify `server/src/services/crew-task-service.ts`; Create `server/src/__tests__/scope-auto-accept-gate.test.ts`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveScopeAutoAcceptGate } from "../services/crew-task-service.js";

describe("resolveScopeAutoAcceptGate", () => {
  it("maps autonomy to the 3-way gate", () => {
    expect(resolveScopeAutoAcceptGate(0)).toBe("draft_only");
    expect(resolveScopeAutoAcceptGate(1)).toBe("accept_apply");
    expect(resolveScopeAutoAcceptGate(2)).toBe("accept_apply_dispatch");
    expect(resolveScopeAutoAcceptGate(3)).toBe("accept_apply_dispatch"); // clamp-up
  });
  it("fails closed for null/undefined/negative", () => {
    expect(resolveScopeAutoAcceptGate(null)).toBe("draft_only");
    expect(resolveScopeAutoAcceptGate(undefined)).toBe("draft_only");
    expect(resolveScopeAutoAcceptGate(-1)).toBe("draft_only");
  });
});
```

- [ ] **Step 2: Run → FAIL:** `cd server && npx vitest run src/__tests__/scope-auto-accept-gate.test.ts`

- [ ] **Step 3: Implement** (add next to `resolveCreationGate` in `crew-task-service.ts`):

```ts
/**
 * 3-way autonomy gate for controller scope-draft auto-accept (W1b).
 * - >= 2 (Drive)  → "accept_apply_dispatch": create+assign tasks AND dispatch
 * - == 1 (Assist) → "accept_apply": create+assign tasks (board populates), NO dispatch
 * - else (Manual/null) → "draft_only": leave the draft for the founder
 * Pure — no I/O. Separate from resolveCreationGate so Path A's binary contract is untouched.
 */
export function resolveScopeAutoAcceptGate(
  autonomy: number | null | undefined,
): "draft_only" | "accept_apply" | "accept_apply_dispatch" {
  if (typeof autonomy !== "number") return "draft_only";
  if (autonomy >= 2) return "accept_apply_dispatch";
  if (autonomy === 1) return "accept_apply";
  return "draft_only";
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit:** `git commit -m "feat(scope): add resolveScopeAutoAcceptGate 3-way autonomy gate"`

---

## Task 2: `dispatchMode` option on `createOutputItem` sets task workMode

**Files:** Modify `server/src/services/thread-scope-versions.ts`; Modify the test file that covers `createOutputItem` (find it — likely `thread-scope-item-review.test.ts` or `thread-scope-accept.test.ts`; grep `createOutputItem` in `server/src/__tests__/`).

**Context:** `createOutputItem`'s `task_proposal` branch (`thread-scope-versions.ts:1435`) hardcodes `workMode: "planning"`. It already takes an `options: CreateScopeOutputOptions = {}` param (threaded to `resolveMemoryStatus` at `:1449`). Add `dispatchMode` to that options type, default `"planning"` (existing callers unchanged); map it to the created issue's `workMode`. Do NOT touch `applyAcceptedDraft` (the founder bulk path stays `planning` — out of scope).

- [ ] **Step 1: Failing test** — in the createOutputItem test file (reuse its `issueService.create` capture + a `draft` task_proposal item):

```ts
it("createOutputItem with dispatchMode='standard' creates a standard (dispatchable) task; default stays planning", async () => {
  // call createOutputItem(companyId, threadId, versionId, taskItemId, actor, { dispatchMode: "standard" })
  expect(issueCreate).toHaveBeenCalledWith(expect.objectContaining({ workMode: "standard" }));
});
```
Plus a regression assertion: omitting the option → `workMode: "planning"`.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:**
  - Add `dispatchMode?: "standard" | "planning";` to the `CreateScopeOutputOptions` type (grep for it in `thread-scope-versions.ts`).
  - In `createOutputItem`'s `task_proposal` branch (~`:1435`), replace `workMode: "planning"` with `workMode: options.dispatchMode ?? "planning"`.
  - Leave `applyAcceptedDraft`'s `workMode: "planning"` unchanged.

- [ ] **Step 4: Run → PASS** + regression: `cd server && npx vitest run` on the createOutputItem test file + `src/__tests__/thread-scope-accept.test.ts` (defaults unchanged).
- [ ] **Step 5: Commit:** `git commit -m "feat(scope): dispatchMode option on createOutputItem sets task workMode"`

---

## Task 3: Handler auto-accepts task items, gated by autonomy

**Files:** Modify `server/src/services/thread-agent-actions.ts`; Create `server/src/__tests__/w1b-auto-accept.test.ts`.

**Context:** Insert after `createDraftFromThread` returns (`thread-agent-actions.ts` ~line 742), before `batchProducedScopeVersionId` is set. Fetch autonomy, run the gate, and for accept_apply / accept_apply_dispatch: fetch the draft's `task_proposal` item ids, call `acceptDraft(ids, {dispatchMode})`, and at Drive call `dispatchCreatedCrewTasks`.

- [ ] **Step 1: Failing test** (`w1b-auto-accept.test.ts`) — using the `thread-agent-actions.test.ts` mock style + `vi.mock` of `crew-task-service.js` (`resolveScopeAutoAcceptGate`, `dispatchCreatedCrewTasks`) and the scope committer (mock `createOutputItem` returning `{ ok: true, createdTask: {...} }`). The committed action's thread has one `task_proposal` draft item and one `memory_candidate` draft item. Three cases:
  1. **Manual (autonomy 0):** committing a `create_scope_draft` action → draft created, `createOutputItem` NOT called, `dispatchCreatedCrewTasks` NOT called.
  2. **Assist (1):** `createOutputItem` called ONCE with the task-item id + `{ dispatchMode: "planning" }`; NOT called for the memory item; `dispatchCreatedCrewTasks` NOT called.
  3. **Drive (2):** `createOutputItem` called with `{ dispatchMode: "standard" }`; `dispatchCreatedCrewTasks` called with the collected `createdTask`s.
  Assert autonomy is read from `thread.autonomyLevel ?? internalAgentConfig.autonomyLevel` (mock both; test thread=1 overrides company=0, etc.).
  Assert **`createOutputItem` is only ever called with the `task_proposal` item id** (never the `memory_candidate` id) — the item query filters `kind='task_proposal'`.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** in the `create_scope_draft` handler. Add imports:
```ts
import { resolveScopeAutoAcceptGate, dispatchCreatedCrewTasks } from "./crew-task-service.js";
import { internalAgentConfig } from "@armyofagents/db";
```
After the `createDraftFromThread` call (before `if (draft.version?.id) batchProducedScopeVersionId = ...`):
```ts
// W1b: autonomy-gated auto-accept of the freshly-created draft.
if (draft.status === "created" && draft.version?.id) {
  try {
    // effectiveAutonomy = thread.autonomyLevel ?? company.autonomyLevel (mirror controller-adjutant-runner)
    const [threadRow] = await actionDb.select({ autonomyLevel: discussions.autonomyLevel })
      .from(discussions).where(eq(discussions.id, input.threadId)).limit(1);
    const [cfg] = await actionDb.select({ autonomyLevel: internalAgentConfig.autonomyLevel })
      .from(internalAgentConfig).where(eq(internalAgentConfig.companyId, input.companyId)).limit(1);
    const effectiveAutonomy = threadRow?.autonomyLevel != null ? threadRow.autonomyLevel : (cfg?.autonomyLevel ?? 0);
    const gate = resolveScopeAutoAcceptGate(effectiveAutonomy);

    if (gate !== "draft_only") {
      const dispatchMode = gate === "accept_apply_dispatch" ? "standard" : "planning";
      // Apply ONLY task_proposal items, one-by-one via createOutputItem (version-preserving).
      // memory_candidate/decision items stay draft → founder-gated (D12). NOT applyAcceptedDraft (it closes
      // the version and would strand un-accepted memory items).
      const taskItems = await actionDb.select({ id: threadScopeItems.id })
        .from(threadScopeItems)
        .where(and(
          eq(threadScopeItems.scopeVersionId, draft.version.id),
          eq(threadScopeItems.kind, "task_proposal"),
          eq(threadScopeItems.status, "draft"),
        ));
      const createdTasks: Array<{ id: string; assigneeAgentId: string | null; workMode: string | null }> = [];
      for (const { id: itemId } of taskItems) {
        const res = await scopeVersionCommitter.createOutputItem(
          input.companyId, input.threadId, draft.version.id, itemId,
          { agentId: action.agentId ?? undefined, isHuman: false },
          { dispatchMode },
        );
        if (res?.ok && res.createdTask) createdTasks.push(res.createdTask);
      }
      if (gate === "accept_apply_dispatch" && createdTasks.length > 0) {
        await dispatchCreatedCrewTasks(actionDb, input.companyId, createdTasks);
      }
    }
  } catch (err) {
    log.warn({ err, threadId: input.threadId, versionId: draft.version?.id },
      "W1b auto-accept failed — draft left for manual accept");
  }
}
```
> Implementer: verify the local `ScopeVersionCommitService` type includes `createOutputItem` (add its signature if missing, like W1a did for `createDraftFromThread` — see `thread-scope-versions.ts` `createOutputItem` for the real signature + the `CreateScopeOutputItemResult` shape: `{ ok: true, item, createdTask?, ... } | { ok: false, reason, message }`). Ensure `threadScopeItems`/`discussions`/`internalAgentConfig` are imported. `draft.status === "created"` guards against the `existing_draft`/`no_entries` returns. `createOutputItem` applies a `draft` item directly (no separate `acceptDraft`). It leaves the version `draft`, so memory items remain founder-acceptable.

- [ ] **Step 4: Run → PASS** + full regression: `cd server && npx vitest run src/__tests__/thread-agent-actions.test.ts` and `npx tsc --noEmit`.
- [ ] **Step 5: Commit:** `git commit -m "feat(scope): autonomy-gated auto-accept of controller scope drafts (W1b)"`

---

## Task 4: Real-DB integration test — per-autonomy behavior

**Files:** Create `server/src/__tests__/w1b-auto-accept.integration.test.ts` (model on `w1a-crew-assignment.integration.test.ts`; `describe.skipIf(win32)`).

- [ ] **Step 1:** Three real-DB cases (seed company + Engineer + thread + a `ready` `create_scope_draft` action with `proposedTasks:[{title,assigneeRole:"engineer"}]`; set autonomy per case; run `commitThreadAgentActions`):
  - **Manual** (thread autonomy 0): after commit, the scope version is `draft`; **zero `issues`** for the thread.
  - **Assist** (1): the task became an `issues` row, `assignee_agent_id = Engineer`, `work_mode = "planning"`, and **no `agent_wakeup_requests`** row was enqueued for it.
  - **Drive** (2): `issues` row assigned + `work_mode = "standard"` + an `agent_wakeup_requests` row exists for (agent=Engineer, issue).
  - **No-strand invariant (Assist + Drive):** seed the thread so extraction produced BOTH a task and a memory item. After auto-accept, assert (a) the `task_proposal` item is `status='applied'` with a `result_issue_id`, (b) the `memory_candidate` item is still `status='draft'` with null `result_memory_id`, AND (c) the scope **version** status is still `'draft'` (NOT `'accepted'`) — proving `createOutputItem` left the version open so the founder can still approve the memory. This is the regression test for finding W1b-1.
- [ ] **Step 2:** Run (Linux) / skip (Windows) — same as the W1a integration test.
- [ ] **Step 3: Commit:** `git commit -m "test(scope): integration — W1b per-autonomy auto-accept + dispatch"`

---

## Task 5: Contract test — dispatchMode → workMode + memory stays gated

**Files:** Create `server/src/__tests__/w1b-dispatch-mode-contract.test.ts`.

- [ ] Lock two contracts (unit-level, runs locally): (a) `applyAcceptedDraft` with `dispatchMode:"standard"` yields `workMode:"standard"` on `issueService.create`, default → `"planning"`; (b) the gate mapping is stable (`resolveScopeAutoAcceptGate` 0/1/2 → draft_only/accept_apply/accept_apply_dispatch). Commit: `test(scope): contract — dispatchMode workMode + auto-accept gate`.

---

## Test Coverage (D15)

```
[+] resolveScopeAutoAcceptGate()            [★★★ UNIT]  scope-auto-accept-gate.test.ts (0/1/2/3/null/neg)
[+] dispatchMode → workMode (apply/createOutputItem) [★★ UNIT] thread-scope-accept.test.ts + contract
[+] handler auto-accept per autonomy         [★★★ UNIT]  w1b-auto-accept.test.ts (Manual/Assist/Drive + memory-excluded)
[+] effectiveAutonomy = thread ?? company    [★★  UNIT]  w1b-auto-accept.test.ts (override cases)
[+] Manual→draft / Assist→assigned-no-dispatch / Drive→assigned+dispatched  [→INTEGRATION] w1b-auto-accept.integration.test.ts
[+] memory_candidate stays draft (D12)       [★★ UNIT + →INTEGRATION]
[+] dispatchCreatedCrewTasks reused at Drive [★★ UNIT] (mocked) + INTEGRATION (real wakeup row)
USER FLOW
[+] Drive: controller scope → tasks auto-appear ASSIGNED on Crew Board → reuse W1a E2E (team-aoa-crew-assignment.spec.ts)
    + extend: at Drive the task is dispatchable (not planning). [→E2E optional; integration covers the wakeup]
COVERAGE: unit (gate, workMode, handler) + integration (per-autonomy, real wakeup) + contract. UI rendering covered by W1a E2E.
```

---

## NOT in scope

- **Assist dispatch-approval in the Inbox** — W1c. In W1b, Assist creates assigned `planning` tasks (board populates) that a human dispatches; the one-click Inbox approval is W1c.
- **Memory auto-accept at any level** — excluded by D12 (founder-gated). W1b applies only `task_proposal` items.
- **Company-default dial = Assist** (design D3) — a Settings/company-create change (W6); W1b honors whatever `internal_agent_config.autonomyLevel` is set to.

## What already exists (reused)

- `applyAcceptedDraft`/`acceptDraft`/`createOutputItem` (apply engine), `dispatchCreatedCrewTasks` (per-task wakeup), `shouldDispatchIssueWakeup` (planning gate), the `effectiveAutonomy` formula (`controller-adjutant-runner.ts`). W1b only adds a pure gate + a `dispatchMode` param + ~30 lines of handler orchestration.

## Failure modes

| Failure | Handling | Test |
|---|---|---|
| Auto-accept throws mid-commit | try/catch → log, draft left for manual accept, outbox action still commits (B6) | handler unit (throw case) |
| **Memory candidates stranded (W1b-1)** | `createOutputItem` (per-item) keeps the version `draft`; NEVER `applyAcceptedDraft` (which closes it) — B7 | integration no-strand invariant |
| Memory auto-created at Drive | impossible — handler queries `kind='task_proposal'` only; `createOutputItem` never called for memory items | unit + integration |
| Drive task not dispatchable | `dispatchMode:"standard"` → `workMode:"standard"` → passes `shouldDispatchIssueWakeup` | integration (wakeup row) |
| Assist task wrongly dispatched | Assist → `planning` → `dispatchCreatedCrewTasks` skips it | integration (no wakeup) |

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found → fixed | 1 critical design flaw (W1b-1: `applyAcceptedDraft` strands memory candidates) → switched to per-item `createOutputItem`; test pyramid complete (unit gate/workMode/handler + real-DB per-autonomy incl. no-strand invariant + contract) |

- **UNRESOLVED:** none.
- **CRITICAL GAPS:** 0 (W1b-1 memory-strand fixed + covered by the integration no-strand invariant).
- **VERDICT:** ENG CLEARED — auto-accept uses version-preserving `createOutputItem` (task items only; memory stays founder-gated, D12), autonomy-gated (Manual/Assist/Drive), `dispatchMode` makes Drive tasks dispatchable, best-effort (failure leaves draft for manual accept). Ready to implement W1b.
