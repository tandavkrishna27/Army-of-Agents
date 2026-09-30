# W3a — Crew Result Loopback + Run Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a CREW agent (kind='aoa') finishes a task, its result posts back into the originating discussion thread (loopback) and gets a run-summary comment on the task — the treatment ORG agents already get from the heartbeat path. Today both fire ONLY from heartbeat, so crew-executed tasks complete silently. This closes the founder-visible loop for every task type (D11).

**Architecture (eng-reviewed — decisions D1-D4 locked 2026-07-04):** Two composed, best-effort side-effect functions wired into `runAoaAgent` — one per outcome — so the exact SEQUENCE the runner runs is a single tested unit (D4), not loose calls:
- **`postCrewRunSuccess(db, input)`** — `relayCrewResult(db, {issueId})` (self-guards `originKind==="crew_thread"` + `sourceDiscussionId`, so a non-discussion task is a no-op) THEN `postRunSummaryComment(...)` (outcome `succeeded`).
- **`postCrewRunFailure(db, input)`** — fetch the issue (`title`, `originKind`, `sourceDiscussionId`); if crew_thread-origin, `postCrewFailureCard(...)`; THEN `postRunSummaryComment(...)` (outcome `failed`).

Both are called from the runner as ONE best-effort call each (try/catch, `.warn`, never fail the run — mirroring heartbeat). `postRunSummaryComment` (D1) is extracted from heartbeat's private `createRunSummaryComment` into a shared module so heartbeat + crew share ONE implementation (a delegation refactor proven behavior-preserving by heartbeat's own tests). The `autoRunSummary` opt-out (D3) suppresses ONLY the summary comment — the loopback + failure card ALWAYS post (founder visibility is unconditional). No double-post guard (D2): a task has one assignee (crew runner XOR heartbeat), so the loopback fires once; the cross-kind-reassignment edge is a documented follow-up.

**Locked decisions (this eng-review):**
- **D1 = extract shared `postRunSummaryComment`** (one impl for org + crew; heartbeat delegates).
- **D2 = no dedup guard** — rely on single-assignee routing (matches heartbeat); document the reassignment edge as a follow-up.
- **D3 = opt-out is summary-comment-only** — loopback + failure card never suppressed by `autoRunSummary=false`.
- **D4 = extract composed `postCrewRunSuccess`/`postCrewRunFailure`** — the runner's side-effect sequence is a tested unit; runner wiring = one call per path; the integration test drives the composed functions.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Drizzle (`issue_comments`, `discussion_entries`, `discussions`, `issues` — no schema changes), Vitest (mock-DB unit + real embedded-postgres integration). No UI. No new env vars.

**Explicitly OUT of scope:** Workspace/worktree provisioning + `detectedFiles` (that is W3b — the crew run-summary ships with `detectedFiles: []`, which `formatRunSummary` renders cleanly as no files section). Generalizing the write-back to codex/opencode crew adapters (crew defaults to `claude_local`; noted follow-up). E2E coverage of the loopback (the fake-crew harness structurally cannot execute a task to completion — a fake turn never calls `set_task_status`, so the task never SUCCEEDS; loopback coverage is unit + real-DB integration, which is the honest level).

---

## Context for an engineer with zero AoA background (verified against current `main`)

- **Crew runner:** `runAoaAgent(db, agentId, payload)` in `server/src/services/internal-agent/aoa-agents/runner.ts`. A crew task run lands in `internal_agent_runs` (NOT `heartbeat_runs`). Key locals: `startedAt` (`Date.now()` at fn entry, line ~118), `runId`, `payload.issueId` (the task id, may be undefined), `payload.companyId`, `agent` (agents row with `runtimeConfig`), `runResult` (`{status, errorMessage}`), `adapterUsage` (`{inputTokens, outputTokens, cachedInputTokens?}`), `costCents` (integer cents, or null).
  - **Success path:** the `internal_agent_runs` completion write is at runner.ts:690-708. Insert the loopback + summary AFTER that write (after ~line 708), before the `costService.createEvent` at ~line 715, where all locals are still in scope.
  - **Failure path:** `catch (err)` at ~line 734; `errMessage` extracted; the failed `internal_agent_runs` write at ~738-742. Insert the failure-card + failure-summary after ~line 742. `agentId` (the param), `agent`, `payload.issueId`, `payload.companyId`, `startedAt`, `errMessage` are in scope.
  - VERIFY these line numbers before editing — the file moved when PR #272 merged. Anchor on the code, not the number.
- **`relayCrewResult`** — `server/src/services/crew-result-relay.ts`. `(db, {issueId}) => Promise<{posted:boolean}>`. Self-fetches the issue; returns `{posted:false}` unless `originKind==="crew_thread"` AND `sourceDiscussionId` set AND source thread same company. Posts an `agent` entry `Completed: "<title>" (task <id>)` + bumps `entrySeq`/`entryCount` + live events. Only caller today: `heartbeat.ts:~4447`.
- **`postCrewFailureCard`** — `server/src/services/crew-failure-card.ts`. `(db, {threadId, companyId, issueId, agentId, agentName, taskTitle, error}) => Promise<void>`. Posts a `system` entry `<agentName> could not complete "<title>".` + bumps seq + events. Takes `threadId` DIRECTLY (unlike relayCrewResult), so the caller must fetch `issue.sourceDiscussionId` + gate on `originKind==="crew_thread"` first. Only caller today: `heartbeat.ts:~4555`.
- **`formatRunSummary`** — `server/src/services/run-summary.ts`. PURE (no DB). Input `{agentName, outcome: "succeeded"|"failed"|"cancelled"|"timed_out", durationMs, inputTokens, outputTokens, costUsd, errorMessage, detectedFiles: Array<{path;type?}>}` → markdown string. Empty `detectedFiles` → no files section (graceful).
- **`createRunSummaryComment`** — a PRIVATE closure in `heartbeatService` (`heartbeat.ts:~2213-2258`): early-returns if no `issueId`; opt-out `if (runtimeConfig.autoRunSummary === false) return;`; computes duration from the `heartbeat_runs` row; calls `formatRunSummary`; inserts into `issue_comments` (`{companyId, issueId, authorAgentId:null, authorUserId:null, body: sanitizeForDb(body)}`) + `update(issues).set({updatedAt})`; the insert is itself try/caught. Coupled to the `heartbeat_runs` row shape (`startedAt`/`finishedAt`/`createdAt`) — the crew path has `internal_agent_runs` (`createdAt`/`completedAt`) + a live `startedAt` local, so the shared helper must take PLAIN values (durationMs, tokens, costUsd), not a run row.
- **Cost unit mismatch:** heartbeat passes `adapterResult.costUsd` (float USD). Crew has `costCents` (int). Convert: `costUsd = costCents != null ? costCents/100 : null`.
- **`originKind` / `sourceDiscussionId`** live on the `issues` table (`origin_kind`, `source_discussion_id`), stamped when a scope draft's task is created from a discussion.
- **Run this plan's server tests:** `pnpm --filter @armyofagents/server exec vitest run <files>`. Typecheck: `pnpm --filter @armyofagents/server exec tsc --noEmit`. Integration on real Postgres locally (Windows): flip the file's `describe.skipIf(process.platform === "win32")` → `describe.skipIf(false)` temporarily, run, then **ALWAYS restore before commit** (CI skips Windows e2e/integration per Issue #114; Linux CI is authoritative). Use `initdbFlags: ["--encoding=UTF8","--locale=C"]` in the embedded-postgres ctor.
- **Branch:** create `feat/w3a-crew-loopback` off latest `origin/main`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Data flow (eng-review diagram)

```
                                   runAoaAgent (crew runner)
                                            │
                    ┌───────────────────────┴───────────────────────┐
                    ▼ SUCCESS (after IAR completion write)           ▼ FAILURE (catch, after IAR failed write)
        best-effort try/catch each:                     best-effort try/catch each:
          relayCrewResult(db,{issueId})                   fetch issue {title, originKind, sourceDiscussionId}
            └─ self-guards crew_thread+srcDisc              if crew_thread && sourceDiscussionId:
            └─ posts "Completed: …" agent entry               postCrewFailureCard(db,{threadId=srcDisc,…})
                                                                └─ posts "… could not complete …" system entry
          postRunSummaryComment(db,{                       postRunSummaryComment(db,{
             agent, issueId, outcome:"succeeded",             agent, issueId, outcome:"failed",
             durationMs, inputTokens, outputTokens,           durationMs, …, errorMessage, detectedFiles:[]})
             costUsd, errorMessage:null, detectedFiles:[]})    └─ same shared helper
            └─ opt-out autoRunSummary===false → skip
            └─ formatRunSummary → issue_comments insert + issues.updatedAt

  SHARED: postRunSummaryComment (NEW, extracted from heartbeat's createRunSummaryComment)
          used by BOTH the crew runner (this plan) AND heartbeat (refactored to call it) — one impl.

  COMPOSED (D4): the runner calls ONE function per path; each is a tested unit:
    postCrewRunSuccess(db, in) = relayCrewResult(in.issueId) ; postRunSummaryComment(in→"succeeded")
    postCrewRunFailure(db, in) = fetch issue ; if crew_thread: postCrewFailureCard(...) ; postRunSummaryComment(in→"failed")
    Both best-effort INTERNALLY (each sub-step try/caught so a relay failure still lets the summary post),
    AND the runner wraps the whole call in try/catch (never fail the run). The integration test (Task 4)
    drives these two composed functions directly.
```

## D4 module spec (the composed side-effect functions)

New module `server/src/services/internal-agent/aoa-agents/crew-run-outcome.ts` — the two functions the runner calls and the integration test drives. `resolveCrewRunSummaryArgs` (the pure mapper) lives here too (or in the runner and is imported); the composed functions call `postRunSummaryComment` with its output.

```ts
export interface CrewRunSuccessInput {
  companyId: string; issueId: string;
  agentName: string; runtimeConfig: Record<string, unknown> | null | undefined;
  startedAtMs: number; nowMs: number;
  adapterUsage: { inputTokens?: number; outputTokens?: number } | undefined;
  costCents: number | null;
}
export interface CrewRunFailureInput {
  companyId: string; issueId: string; agentId: string;
  agentName: string; runtimeConfig: Record<string, unknown> | null | undefined;
  startedAtMs: number; nowMs: number; errorMessage: string;
}

/** SUCCESS: loopback (crew_thread-guarded inside relayCrewResult) THEN run-summary. Each sub-step best-effort. */
export async function postCrewRunSuccess(db, input: CrewRunSuccessInput): Promise<{ relayed: boolean; summarized: boolean }>;
/** FAILURE: fetch issue → crew_thread? failure card ; THEN failure run-summary. Each sub-step best-effort. */
export async function postCrewRunFailure(db, input: CrewRunFailureInput): Promise<{ carded: boolean; summarized: boolean }>;
```

- **Best-effort granularity:** wrap EACH sub-step (relay, card, summary) in its own try/catch inside the composed function, so a relay failure does NOT skip the summary (and vice-versa). Return which sub-steps posted (for the unit test to assert). The runner then wraps the whole call in one more try/catch as defence-in-depth.
- **Tasks 2/3 below** now build these composed functions + wire the runner to call ONE per path; **Task 4** drives the composed functions on real Postgres. `resolveCrewRunSummaryArgs` (drafted in Task 2) becomes an internal detail of `postCrewRunSuccess`/`postCrewRunFailure` — still unit-tested for the costCents→USD + failure-carry mapping.

---

### Task 1: Extract `postRunSummaryComment` — one shared run-summary writer

Heartbeat's `createRunSummaryComment` is a private closure. Extract the DB-writing behavior (opt-out check + `formatRunSummary` + `issue_comments` insert + `issues.updatedAt`) into a shared module that takes PLAIN values (not a run row), so both heartbeat and the crew runner call one implementation. This is the D11 "reuse existing machinery" intent, and — unlike the fake-crew D5 case — the shared contract (summary format + opt-out + comment write) is genuinely common to both callers.

**Files:**
- Create: `server/src/services/run-summary-comment.ts`
- Create: `server/src/__tests__/run-summary-comment.test.ts`
- Modify: `server/src/services/heartbeat.ts` (refactor `createRunSummaryComment` to delegate — proving zero behavior change)

- [ ] **Step 1: Write the failing unit test**

Create `server/src/__tests__/run-summary-comment.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertMock, updateMock } = vi.hoisted(() => ({
  insertMock: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  updateMock: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
}));

vi.mock("@armyofagents/db", () => ({
  issueComments: { _: { name: "issue_comments" } },
  issues: { _: { name: "issues" } },
}));
vi.mock("drizzle-orm", () => ({ eq: (...a: unknown[]) => ({ __eq: a }) }));

import { postRunSummaryComment } from "../services/run-summary-comment.js";

function fakeDb() {
  return { insert: insertMock, update: updateMock } as never;
}

beforeEach(() => {
  insertMock.mockClear();
  updateMock.mockClear();
});

describe("postRunSummaryComment", () => {
  const base = {
    companyId: "co-1",
    issueId: "task-1",
    agentName: "Engineer",
    runtimeConfig: {} as Record<string, unknown>,
    outcome: "succeeded" as const,
    durationMs: 135_000,
    inputTokens: 100,
    outputTokens: 200,
    costUsd: 0.12,
    errorMessage: null,
    detectedFiles: [] as Array<{ path: string; type?: string }>,
  };

  it("writes a summary comment + touches the issue when not opted out", async () => {
    const result = await postRunSummaryComment(fakeDb(), base);
    expect(result).toEqual({ posted: true });
    expect(insertMock).toHaveBeenCalledTimes(1);
    const values = (insertMock.mock.results[0].value.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(values).toMatchObject({ companyId: "co-1", issueId: "task-1", authorAgentId: null, authorUserId: null });
    expect(typeof values.body).toBe("string");
    expect(values.body).toContain("Engineer");
    expect(updateMock).toHaveBeenCalledTimes(1); // issues.updatedAt touch
  });

  it("no issueId → no-op (posted:false), no writes", async () => {
    const result = await postRunSummaryComment(fakeDb(), { ...base, issueId: null });
    expect(result).toEqual({ posted: false });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("autoRunSummary === false → opt-out (posted:false), no writes", async () => {
    const result = await postRunSummaryComment(fakeDb(), { ...base, runtimeConfig: { autoRunSummary: false } });
    expect(result).toEqual({ posted: false });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("a failed outcome still posts a summary (with the error)", async () => {
    const result = await postRunSummaryComment(fakeDb(), {
      ...base, outcome: "failed", errorMessage: "boom",
    });
    expect(result).toEqual({ posted: true });
    const values = (insertMock.mock.results[0].value.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(values.body).toContain("boom");
  });

  it("never throws — a DB insert error resolves posted:false", async () => {
    insertMock.mockReturnvalueOnce({ values: vi.fn(async () => { throw new Error("db down"); }) } as never);
    const result = await postRunSummaryComment(fakeDb(), base);
    expect(result).toEqual({ posted: false });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/run-summary-comment.test.ts`
Expected: FAIL — `Cannot find module '.../run-summary-comment.js'`.

- [ ] **Step 3: Create the shared helper**

Create `server/src/services/run-summary-comment.ts`. Read `heartbeat.ts:~2213-2258` first and preserve its EXACT semantics (opt-out check, formatRunSummary inputs, issue_comments columns, issues.updatedAt touch, self-caught insert). Read `run-summary.ts` for the `formatRunSummary` signature and `sanitizeForDb`'s import location (find where heartbeat imports it).

```ts
import type { Db } from "@armyofagents/db";
import { issueComments, issues } from "@armyofagents/db";
import { eq } from "drizzle-orm";
import { formatRunSummary } from "./run-summary.js";
import { logger } from "../middleware/logger.js"; // verify path vs heartbeat's logger import
import { sanitizeForDb } from "..."; // MATCH heartbeat.ts's import of sanitizeForDb

export interface PostRunSummaryCommentInput {
  companyId: string;
  issueId: string | null;
  agentName: string;
  /** The agent's runtimeConfig object; autoRunSummary===false opts out. */
  runtimeConfig: Record<string, unknown> | null | undefined;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  errorMessage: string | null;
  detectedFiles: Array<{ path: string; type?: string }>;
}

/**
 * Post an auto run-summary comment on a task (issue_comments) + touch issues.updatedAt.
 * Shared by the heartbeat path (ORG agents) and the crew runner (kind='aoa'), so the
 * summary format, the autoRunSummary opt-out, and the comment write live in ONE place.
 * Best-effort: returns {posted:false} on opt-out / missing issueId / any DB error — NEVER throws.
 */
export async function postRunSummaryComment(
  db: Db,
  input: PostRunSummaryCommentInput,
): Promise<{ posted: boolean }> {
  if (!input.issueId) return { posted: false };
  const rc = (input.runtimeConfig ?? {}) as { autoRunSummary?: unknown };
  if (rc.autoRunSummary === false) return { posted: false };

  const body = formatRunSummary({
    agentName: input.agentName,
    outcome: input.outcome,
    durationMs: input.durationMs,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costUsd: input.costUsd,
    errorMessage: input.errorMessage,
    detectedFiles: input.detectedFiles,
  });

  try {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorAgentId: null,
      authorUserId: null,
      body: sanitizeForDb(body),
    });
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, input.issueId));
    return { posted: true };
  } catch (err) {
    logger.warn({ err, issueId: input.issueId }, "run summary comment creation failed (non-fatal)");
    return { posted: false };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/run-summary-comment.test.ts`
Expected: PASS (5 tests). If `sanitizeForDb` import path differs, fix it; if the mock needs the exact table `_.name`, align with the existing mock helper style used elsewhere.

- [ ] **Step 5: Refactor heartbeat's `createRunSummaryComment` to delegate**

In `heartbeat.ts`, change the body of `createRunSummaryComment` to compute `durationMs`/`costUsd`/tokens from its `heartbeat_runs` row + `adapterResult` (as it does now) and then call `postRunSummaryComment(db, {...})` instead of inlining the formatRunSummary + insert. Keep its exact external behavior. This proves the extraction is behavior-preserving and removes the duplication.

- [ ] **Step 6: Prove heartbeat run-summary behavior is unchanged**

Run the heartbeat run-summary tests (find them): `pnpm --filter @armyofagents/server exec vitest run src/__tests__/run-summary.test.ts` plus any `heartbeat*` test that exercises the summary. Expected: ALL PASS. If a heartbeat test mocks the inline insert, update ONLY its mock target to the delegated helper — asserted shapes must not change.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit` → 0 errors.

```bash
git add server/src/services/run-summary-comment.ts server/src/__tests__/run-summary-comment.test.ts server/src/services/heartbeat.ts
git commit -m "refactor(runs): extract shared postRunSummaryComment (heartbeat + crew)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wire the crew runner SUCCESS path — loopback + run summary

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts` (success path, after the `internal_agent_runs` completion write)
- Create: `server/src/__tests__/aoa-runner-loopback.test.ts`

- [ ] **Step 1: Write the failing contract test**

The runner is large + hard to unit-test end-to-end; test the SUCCESS side-effect wiring via a small extracted helper. Create a pure helper `resolveCrewRunSummaryArgs` in the runner module (exported) that maps the runner locals → `postRunSummaryComment` input, and unit-test THAT + assert the best-effort call order. Create `server/src/__tests__/aoa-runner-loopback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveCrewRunSummaryArgs } from "../services/internal-agent/aoa-agents/runner.js";

describe("resolveCrewRunSummaryArgs (crew success → run-summary input)", () => {
  it("maps runner locals to the shared helper's input (costCents → costUsd)", () => {
    const args = resolveCrewRunSummaryArgs({
      companyId: "co-1",
      issueId: "task-1",
      agentName: "Engineer",
      runtimeConfig: { autoRunSummary: true },
      outcome: "succeeded",
      startedAtMs: 1_000,
      nowMs: 136_000,
      adapterUsage: { inputTokens: 100, outputTokens: 200 },
      costCents: 12,
      errorMessage: null,
    });
    expect(args).toEqual({
      companyId: "co-1",
      issueId: "task-1",
      agentName: "Engineer",
      runtimeConfig: { autoRunSummary: true },
      outcome: "succeeded",
      durationMs: 135_000,
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.12,
      errorMessage: null,
      detectedFiles: [],
    });
  });

  it("null costCents → null costUsd; missing usage → null tokens", () => {
    const args = resolveCrewRunSummaryArgs({
      companyId: "co-1", issueId: "task-1", agentName: "E", runtimeConfig: {},
      outcome: "succeeded", startedAtMs: 0, nowMs: 1_000,
      adapterUsage: undefined, costCents: null, errorMessage: null,
    });
    expect(args.costUsd).toBeNull();
    expect(args.inputTokens).toBeNull();
    expect(args.outputTokens).toBeNull();
    expect(args.detectedFiles).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/aoa-runner-loopback.test.ts`
Expected: FAIL — `resolveCrewRunSummaryArgs` not exported.

- [ ] **Step 3: Add the pure helper + wire the success path**

In `runner.ts`, add the exported pure helper (near the top-level helpers):

```ts
import type { PostRunSummaryCommentInput } from "../../run-summary-comment.js"; // verify relative depth

export function resolveCrewRunSummaryArgs(input: {
  companyId: string;
  issueId: string;
  agentName: string;
  runtimeConfig: Record<string, unknown> | null | undefined;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  startedAtMs: number;
  nowMs: number;
  adapterUsage: { inputTokens?: number; outputTokens?: number } | undefined;
  costCents: number | null;
  errorMessage: string | null;
}): PostRunSummaryCommentInput {
  return {
    companyId: input.companyId,
    issueId: input.issueId,
    agentName: input.agentName,
    runtimeConfig: input.runtimeConfig,
    outcome: input.outcome,
    durationMs: input.nowMs - input.startedAtMs,
    inputTokens: input.adapterUsage?.inputTokens ?? null,
    outputTokens: input.adapterUsage?.outputTokens ?? null,
    costUsd: input.costCents != null ? input.costCents / 100 : null,
    errorMessage: input.errorMessage,
    detectedFiles: [], // W3b will populate from a workspace diff
  };
}
```

Then, on the SUCCESS path (AFTER the `internal_agent_runs` completion write, verify the exact location — after ~line 708, before `costService.createEvent`), add the two best-effort calls. Import `relayCrewResult` from `../../crew-result-relay.js`, `postRunSummaryComment` from `../../run-summary-comment.js`, and the runtimeConfig parser the file already uses (`parseObject` or equivalent — match the file's existing pattern):

```ts
    // W3a: crew result loopback — post "Completed: …" into the originating thread.
    // relayCrewResult self-guards on originKind==="crew_thread" + sourceDiscussionId,
    // so a non-discussion task is a no-op. Best-effort: never fail a succeeded run.
    if (runResult.status === "succeeded" && payload.issueId && runId) {
      try {
        const { relayCrewResult } = await import("../../crew-result-relay.js");
        await relayCrewResult(db, { issueId: payload.issueId });
      } catch (relayErr) {
        log.warn({ err: relayErr, issueId: payload.issueId }, "W3a crew result relay failed (non-fatal)");
      }
      // W3a: run-summary comment on the task (shared with heartbeat).
      try {
        const { postRunSummaryComment } = await import("../../run-summary-comment.js");
        await postRunSummaryComment(db, resolveCrewRunSummaryArgs({
          companyId: payload.companyId,
          issueId: payload.issueId,
          agentName: agent.name,
          runtimeConfig: agent.runtimeConfig as Record<string, unknown> | null,
          outcome: "succeeded",
          startedAtMs: startedAt,
          nowMs: Date.now(),
          adapterUsage,
          costCents,
          errorMessage: null,
        }));
      } catch (summaryErr) {
        log.warn({ err: summaryErr, issueId: payload.issueId }, "W3a crew run summary failed (non-fatal)");
      }
    }
```

Match the file's import style (top-level import vs dynamic `await import` — the runner already uses dynamic imports for `thread-agent-actions.js`; follow that convention for the two new services, or top-level if the file imports services at top). VERIFY `agent.runtimeConfig` is the right field for the opt-out.

- [ ] **Step 4: Run the helper test + the runner suite**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/aoa-runner-loopback.test.ts src/__tests__/aoa-runner-task-execution.test.ts src/__tests__/fake-crew-llm.test.ts`
Expected: ALL PASS (the new wiring is best-effort + gated on issueId; existing runner tests that don't set a discussion-origin issue are unaffected).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit` → 0 errors.

```bash
git add server/src/services/internal-agent/aoa-agents/runner.ts server/src/__tests__/aoa-runner-loopback.test.ts
git commit -m "feat(crew): loopback + run summary on crew task success (W3a)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire the crew runner FAILURE path — failure card + failure summary

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts` (catch block, after the failed `internal_agent_runs` write)
- Modify: `server/src/__tests__/aoa-runner-loopback.test.ts` (add failure-mapping cases)

- [ ] **Step 1: Add the failing failure-mapping test**

Append to `aoa-runner-loopback.test.ts` a case proving `resolveCrewRunSummaryArgs` maps a failure (outcome:"failed" + errorMessage passes through):

```ts
describe("resolveCrewRunSummaryArgs — failure", () => {
  it("carries outcome:failed + errorMessage", () => {
    const args = resolveCrewRunSummaryArgs({
      companyId: "co-1", issueId: "task-1", agentName: "E", runtimeConfig: {},
      outcome: "failed", startedAtMs: 0, nowMs: 2_000,
      adapterUsage: undefined, costCents: null, errorMessage: "kaboom",
    });
    expect(args.outcome).toBe("failed");
    expect(args.errorMessage).toBe("kaboom");
  });
});
```

- [ ] **Step 2: Run to verify (helper already handles it — this pins the contract)**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/aoa-runner-loopback.test.ts`
Expected: PASS (the helper from Task 2 already maps failure; this pins it so Task 3's wiring can't silently drop it).

- [ ] **Step 3: Wire the failure path**

In the `catch (err)` block, AFTER the failed `internal_agent_runs` write (verify ~line 742), add best-effort failure-card + failure-summary. Unlike the success path, `postCrewFailureCard` needs `threadId`, so fetch the issue first and gate on `originKind`:

```ts
    // W3a: crew failure loopback — post "… could not complete …" into the thread
    // + a failure run-summary. Best-effort: never mask the original error.
    if (payload.issueId && runId) {
      try {
        const { issues } = await import("@armyofagents/db");
        const [issueRow] = await db
          .select({
            title: issues.title,
            originKind: issues.originKind,
            sourceDiscussionId: issues.sourceDiscussionId,
          })
          .from(issues)
          .where(eq(issues.id, payload.issueId))
          .limit(1);
        if (issueRow?.originKind === "crew_thread" && issueRow.sourceDiscussionId) {
          const { postCrewFailureCard } = await import("../../crew-failure-card.js");
          await postCrewFailureCard(db, {
            threadId: issueRow.sourceDiscussionId,
            companyId: payload.companyId,
            issueId: payload.issueId,
            agentId,
            agentName: agent.name,
            taskTitle: issueRow.title ?? "(untitled task)",
            error: errMessage,
          });
        }
        const { postRunSummaryComment } = await import("../../run-summary-comment.js");
        await postRunSummaryComment(db, resolveCrewRunSummaryArgs({
          companyId: payload.companyId,
          issueId: payload.issueId,
          agentName: agent.name,
          runtimeConfig: agent.runtimeConfig as Record<string, unknown> | null,
          outcome: "failed",
          startedAtMs: startedAt,
          nowMs: Date.now(),
          adapterUsage: undefined, // usage is unreliable on a thrown run
          costCents: null,
          errorMessage: errMessage,
        }));
      } catch (cardErr) {
        log.warn({ err: cardErr, issueId: payload.issueId }, "W3a crew failure loopback failed (non-fatal)");
      }
    }
```

VERIFY `eq` + `issues` are imported/available in this scope (the file already imports `eq` and drizzle tables — reuse; don't double-import). VERIFY `agent` is in scope in the catch (it is, per the map). If `agent` could be undefined in an early-throw path, guard `agent?.name ?? "Crew agent"`.

- [ ] **Step 4: Run the runner suites**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/aoa-runner-loopback.test.ts src/__tests__/aoa-runner-task-execution.test.ts src/__tests__/aoa-runner-failure-terminalize.test.ts`
Expected: ALL PASS (the failure wiring is best-effort + gated; the existing failure-terminalize test must still pass — the loopback runs alongside, not instead of, the terminalizer).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit` → 0 errors.

```bash
git add server/src/services/internal-agent/aoa-agents/runner.ts server/src/__tests__/aoa-runner-loopback.test.ts
git commit -m "feat(crew): failure card + failure summary on crew task failure (W3a)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Real-DB integration — the whole loopback on Postgres

Unit tests pin the mapping; only a real DB proves the entries + comment actually land. Model on `server/src/__tests__/w2-extract-then-scope.integration.test.ts` (embedded-postgres lifecycle, UTF-8 initdbFlags, founder seed, `describe.skipIf(process.platform === "win32")`).

**Files:**
- Create: `server/src/__tests__/w3a-crew-loopback.integration.test.ts`

- [ ] **Step 1: Write the integration test (4 cases)**

Structure (read the W2 integration test for the exact embedded-pg boilerplate + `rowsOf`/seed helpers to copy):

- **Case 1 — success loopback + summary:** seed company + crew Engineer + a discussion thread + an `issues` row with `originKind='crew_thread'`, `sourceDiscussionId=<thread>`, `assigneeAgentId=<Engineer>`. Call the extracted success side-effects directly (call `relayCrewResult(db,{issueId})` + `postRunSummaryComment(db, resolveCrewRunSummaryArgs({outcome:"succeeded",…}))` — the same calls the runner makes). Assert: (a) a new `discussion_entries` row exists with `input_type='agent'` and `raw_content` containing `Completed:` + the task title; (b) `discussions.entry_seq`/`entry_count` bumped; (c) an `issue_comments` row exists for the task whose `body` contains the agent name + "Duration".
- **Case 2 — non-discussion task is a no-op:** an `issues` row with `originKind='manual'` (or null) → `relayCrewResult` returns `{posted:false}`, ZERO new discussion entries; but `postRunSummaryComment` STILL writes the comment (the summary is not gated on origin). Assert the entry count is unchanged and the comment exists.
- **Case 3 — failure card + failure summary:** crew_thread issue → run the failure side-effects (fetch issue, `postCrewFailureCard(...)` + `postRunSummaryComment({outcome:"failed", errorMessage:"boom"})`). Assert: a `system` discussion entry containing "could not complete" + the title; an `issue_comments` row whose body contains "boom" / "Failed".
- **Case 4 — opt-out:** Engineer with `runtimeConfig.autoRunSummary=false` → `postRunSummaryComment` writes NO comment (0 `issue_comments` rows) while `relayCrewResult` STILL posts the loopback entry (opt-out is summary-only, not loopback).

Use the shared `postRunSummaryComment` + `relayCrewResult` + `postCrewFailureCard` directly (calling the runner end-to-end needs an adapter; the side-effects are what W3a adds and what must be proven).

- [ ] **Step 2: Run on real Postgres (temp-unskip)**

Flip `describe.skipIf(process.platform === "win32")` → `describe.skipIf(false)`, run:
`pnpm --filter @armyofagents/server exec vitest run src/__tests__/w3a-crew-loopback.integration.test.ts`
Expected: 4 passed. Then **restore** the skipIf to `process.platform === "win32"` before committing.

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit` → 0 errors.

```bash
git add server/src/__tests__/w3a-crew-loopback.integration.test.ts
git commit -m "test(crew): real-DB integration for the W3a loopback + summary

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Docs + verification sweep + ship

**Files:**
- Modify: `CLAUDE.md` (Heartbeat/Discussion Pipeline note: crew runner now relays + summarizes, shared `postRunSummaryComment`)
- Modify: `docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md` (W3 STATUS: W3a shipped)

- [ ] **Step 1: Update the docs** — add a sentence to the Heartbeat/Discussion Pipeline section that crew task completion now posts back to the thread (`relayCrewResult`) + a run-summary comment (shared `postRunSummaryComment`), best-effort; note `detectedFiles` awaits W3b. Mark W3a done in the design doc's W3 block + NEXT-PHASE SEQUENCE item 2.

- [ ] **Step 2: Full server unit sweep**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/run-summary-comment.test.ts src/__tests__/run-summary.test.ts src/__tests__/aoa-runner-loopback.test.ts src/__tests__/aoa-runner-task-execution.test.ts src/__tests__/aoa-runner-failure-terminalize.test.ts src/__tests__/fake-crew-llm.test.ts`
Expected: ALL PASS.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit` → 0 errors.

- [ ] **Step 4: Commit docs + push + PR + Codex loop**

```bash
git add CLAUDE.md docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md
git commit -m "docs(crew): record W3a crew loopback + run summary

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push -u origin feat/w3a-crew-loopback
gh pr create --title "feat(crew): crew result loopback + run summary (W3a)" --body "<summary: crew task completion now posts back into the originating thread + a run-summary comment, shared with heartbeat; best-effort; detectedFiles awaits W3b>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Then the standard loop: watch CI + `@codex review` rounds until clean; merge is the user's call.

---

## Verification summary (what proves what)

| Layer | Artifact | Proves |
|---|---|---|
| Unit | `run-summary-comment.test.ts` | Shared writer: opt-out, no-issue no-op, failure summary, never-throws |
| Unit | `run-summary.test.ts` (existing) | `formatRunSummary` unchanged (empty files graceful) |
| Unit | `aoa-runner-loopback.test.ts` | Runner locals → summary input mapping (costCents→USD, failure carry-through) |
| Unit | heartbeat summary tests (existing) | The extraction is behavior-preserving for the ORG path |
| Integration | `w3a-crew-loopback.integration.test.ts` | On real Postgres: success loopback entry + comment, non-discussion no-op, failure card + summary, opt-out |
| — | (no e2e) | The fake harness can't complete a task; loopback coverage is unit + integration by design |

## Eng-review resolutions (locked 2026-07-04)

1. **D1 — Extract vs inline the run-summary writer → EXTRACT** the shared `postRunSummaryComment` (Task 1). The contract is genuinely common (same comment, opt-out, table); heartbeat delegates; its own tests prove no behavior change.
2. **D2 — Double-post guard → NO GUARD.** A task has one assignee (crew runner XOR heartbeat), so the loopback fires once; matches heartbeat (which has no guard either). The cross-kind-reassignment edge (crew fails → org completes → both relay) is a **documented follow-up**, not built now.
3. **D3 — Opt-out scope → SUMMARY COMMENT ONLY.** `autoRunSummary=false` suppresses only the task-detail run-summary comment. The thread loopback + failure card ALWAYS post — the founder's completion/failure visibility is unconditional.
4. **D4 — Wiring test gap → EXTRACT COMPOSED FUNCTIONS.** `postCrewRunSuccess` / `postCrewRunFailure` compose the side-effect sequence; the runner calls one per path; the integration test drives the composed functions so the sequence (not just the pieces) is a tested unit — no silent-drop regression.
5. **detectedFiles=[] until W3b** — the summary omits the files section for crew runs until workspaces land (formatRunSummary renders empty cleanly). Acceptable interim.

## Outside-voice corrections (folded — MUST DO, verified against the code)

An independent challenge (Claude subagent; Codex rate-limited) found two build-blockers the section review missed and several parity nits. All confirmed against the repo — apply these exactly:

- **[P1 BLOCKER] `sanitizeForDb` is a PRIVATE non-exported function** (`heartbeat.ts:85-87`, `text.replace(/[^\x00-\xFF]/g, "")`). It CANNOT be imported as the draft claims ("match heartbeat's import" — there is none). **Fix:** as Task 1 Step 0, MOVE `sanitizeForDb` into the shared util that already holds `parseObject` (`server/src/adapters/utils.js` — verify path), export it, update `heartbeat.ts` to import it from there, and import it into `run-summary-comment.ts` from there. Note: it strips non-Latin1 (the emoji `formatRunSummary` emits at `run-summary.ts:40` — 🤖✅❌⏱️⛔); heartbeat ALREADY strips these today, so preserving the call is behavior-parity, NOT a regression. Do not "fix" the emoji-strip in this PR (that would change heartbeat's existing output).
- **[P1 BLOCKER] `agent` is NOT in `catch` scope.** `const agent` is declared INSIDE the `try` (`runner.ts:~138`), so Task 3's failure wiring reading `agent.name`/`agent.runtimeConfig` in `catch (err)` is a `TS2304` compile error (NOT a runtime nil risk). **Fix:** right after `const agent = ...` loads in the try, assign two function-scope `let` locals (declared above the try, e.g. `let outcomeAgentName: string | undefined; let outcomeAgentRuntimeConfig: unknown;`) and have the failure wiring use those (guard `outcomeAgentName ?? "Crew agent"`). Do NOT widen the `agent` const itself. The success wiring stays inside the try and uses `agent` directly.
- **[P2] Heartbeat delegation companyId (Task 1 Step 5):** the heartbeat `createRunSummaryComment` delegation MUST pass `agent.companyId` as the helper's `companyId` (heartbeat's original insert uses `agent.companyId`). Spell this out in the delegation call — a careless pass would write the wrong company.
- **[P3] Opt-out parity — use `parseObject`, not an inline cast.** Heartbeat reads the opt-out via `parseObject(agent.runtimeConfig)` (`heartbeat.ts:2225`, from `adapters/utils.js`), which also handles string-encoded jsonb (legacy rows). The shared `postRunSummaryComment` must use `parseObject` on `runtimeConfig` for the `autoRunSummary` check (not `(rc ?? {}) as {...}`) so both callers opt out identically.
- **[P2 doc] Success-guard rationale:** the loopback is safe not because of `runResult.status === "succeeded"` alone but because of its PLACEMENT after the run-row write — the benign early `return { status: "succeeded", runId }` paths (`runner.ts:~192, ~218`: entry-not-claimable / checkout-conflict) never reach the insertion point and correctly never relay. Fix the plan comment to say placement-gated, not guard-gated.
- **[P3] D2 assumption to VERIFY before shipping "no guard":** the no-double-post claim rests on crew_thread tasks always dispatching via the crew runner (kind='aoa' assignee), never heartbeat. Add a verification step: confirm a crew_thread task's assignee is `kind='aoa'` (so heartbeat's unconditional `relayCrewResult` at `heartbeat.ts:4447` never fires for it). Founder-reassignment to an org agent remains the documented edge. If crew_thread tasks CAN route to heartbeat, revisit D2.
- **[verified OK] Origin guard fires:** scope-draft/deliverable tasks ARE stamped `originKind='crew_thread'` (`thread-deliverables.ts:116`, `thread-scope-versions.ts`, + `index.ts:752` backfill). The feature is NOT inert.
- **[verified OK] No circular import:** `run-summary-comment.ts` imports only leaves (`run-summary.js`, `adapters/utils.js`, logger); the runner dynamic-imports it. Acyclic.

## What already exists (reused, not rebuilt)

| Capability | Where | This plan's use |
|---|---|---|
| Thread loopback on success | `relayCrewResult` (`crew-result-relay.ts`) — complete, self-guards crew_thread+srcDisc | New caller in the crew runner (was heartbeat-only) |
| Failure card | `postCrewFailureCard` (`crew-failure-card.ts`) — complete | New caller in the crew runner (was heartbeat-only) |
| Summary formatting | `formatRunSummary` (`run-summary.ts`) — pure, empty-files-graceful | Reused verbatim inside the shared writer |
| Summary comment write | `createRunSummaryComment` (heartbeat private closure) | Extracted into shared `postRunSummaryComment`; heartbeat delegates |
| runtimeConfig parse + sanitize | `parseObject` + `sanitizeForDb` (`adapters/utils.js` after the P1 move) | Shared by heartbeat + the new writer |

Nothing is a parallel rebuild — W3a is composition of existing, tested machinery plus one extraction. The one net-new module is `crew-run-outcome.ts` (two composed side-effect functions) + the extracted `postRunSummaryComment`.

## Failure modes (per new codepath)

| Codepath | Realistic failure | Test? | Handled? | Founder sees |
|---|---|---|---|---|
| `postRunSummaryComment` insert | issue_comments write fails | ✅ never-throws unit | try/catch → {posted:false} | nothing (best-effort) |
| `postCrewRunSuccess` relay | relayCrewResult throws | ✅ integration | per-substep try/catch → summary still posts | nothing (loopback skipped, summary lands) |
| `postCrewRunFailure` issue fetch | the SELECT fails | ✅ integration | outer try/catch → run still completes | original error still terminalized |
| Runner success wiring | the whole call throws | ✅ (best-effort) | runner try/catch → succeeded run NOT flipped failed | nothing |
| Runner failure wiring | `agent` undefined (early throw) | — (P1 fix) | captured locals + `?? "Crew agent"` guard | failure card with fallback name |

**No critical gaps** (silent AND untested AND unhandled): every side-effect is best-effort per-substep + integration-covered; the two P1 compile-blockers are fixed pre-build.

## Parallelization

Sequential — Task 1 (extract `postRunSummaryComment` + move `sanitizeForDb`) is a hard prerequisite for Tasks 2/3 (which call it); Task 2/3 share `runner.ts` + `crew-run-outcome.ts`; Task 4 (integration) drives the composed functions; Task 5 is docs/sweep. One lane, in order. No worktree parallelization.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (backend composition, no product-scope change beyond locked D11) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 4 decisions locked (D1-D4), 0 critical gaps |
| Outside Voice | Codex→Claude subagent | Independent 2nd opinion | 1 | issues_found | 2 P1 build-blockers + 4 parity nits, all folded; existential origin-guard risk verified OK |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (no UI) |

- **OUTSIDE VOICE:** Codex rate-limited (resets ~Jul 7) → independent Claude subagent. Found 2 build-blockers the section review missed (`sanitizeForDb` is a private non-exported symbol; `agent` out of `catch` scope → TS2304) + parity nits (parseObject opt-out, companyId in delegation, placement-not-guard rationale). All folded into the "Outside-voice corrections (MUST DO)" block. Verified the feature is NOT inert (crew_thread origin IS stamped).
- **CROSS-MODEL:** no tension — the outside voice endorsed D1-D4; its findings were factual code-corrections, not decisions, so folded directly (no AUQ needed).
- **UNRESOLVED:** none.
- **VERDICT:** ENG CLEARED — plan ready to implement. D1-D4 locked, 2 P1 build-blockers + 5 nits corrected pre-build, 0 critical gaps. Build via subagent-driven development; each subagent must read the "Outside-voice corrections" block.
