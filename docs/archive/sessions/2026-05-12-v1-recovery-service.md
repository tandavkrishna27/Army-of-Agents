# feat/v1-recovery-service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 recovery service slice: D1 recovery skeleton, D7 productivity reviews, max-turn continuation retry, successful-run handoff substrate, stale queued-run cancellation, and issue monitor liveness controls.

**Architecture:** Add a focused `server/src/services/recovery/` subsystem that owns liveness classification, continuation decisions, issue graph checks, issue monitor scheduling, and successful-run handoffs while `heartbeat.ts` remains the orchestration boundary. Keep all new data company-scoped and synchronized through Drizzle schema, shared validators/types, server services/routes, and targeted UI surfaces. Recovery actions are bounded, idempotent, budget-aware, and use D4's cheap model profile when they ask an LLM to inspect productivity.

**Tech Stack:** Drizzle ORM | Express 5 | Vitest unit tests | embedded-postgres integration tests | React + TanStack Query | AoA D4 cheap fallback | `pnpm db:generate`

**Integration branch:** `v1-upgrade`; this plan branch is `feat/v1-recovery-service`.

**Execution split:** Session 12 implements core recovery + max-turn retry. Session 13 implements productivity reviews + monitors + handoff substrate.

---

## Source Notes

- `memory/project_v1_to_v2_roadmap.md` was requested but is absent in this worktree. D1/D7 scope is recovered from `docs/archive/sessions/2026-05-11-v1-upgrade-master.md`, current AoA code, and the Paperclip commits below.
- Pre-flight result: `packages/db/src/schema/heartbeat_runs.ts` already contains `livenessState`, `livenessReason`, `continuationAttempt`, and `nextAction`. No liveness PRE-step migration renumbering is required.
- Current AoA migration state includes `0092_*` and `0093_*`; recovery's logical migration slots are `0094_*` and `0095_*` when generated from this base. If `v1-upgrade` gains another migration before execution, accept the next Drizzle-generated numbers and update this plan's filenames in the execution branch.
- Paperclip commits skimmed:
  - `15eac43b` ports max-turn exhausted retry handling, stop metadata, bounded retry scheduling, scheduled retry promotion/cancellation, and adapter parser tests.
  - `454edfe8` adds successful-run handoff system notices, structured issue comment presentation/metadata, and `server/src/services/recovery/successful-run-handoff.ts`.
  - `42a299fb` bounds productivity-review recovery loops with creation caps, refresh caps, snooze windows, and continuation holds.
  - `ad5432fe` hardens issue recovery reliability; port recovery reliability pieces but explicitly skip the `requireBoardApprovalForNewAgents` default flip.
  - `7a9b3a60` adds early recovery skeleton/origins and another hire-approval default flip; port recovery skeleton/origins only.
  - Also required by master plan: `82e257c7` stale queued/scheduled run cancellation, `57229d0f` issue monitor liveness controls, and `e400315c` assigned-backlog liveness guard.

---

## Non-Goals

- Do not port the Paperclip `requireBoardApprovalForNewAgents = false` schema/default change from `ad5432fe` or `7a9b3a60`. AoA keeps D6: `local_trusted` false at company create time, `authenticated` true.
- Do not rename DB tables or API routes from `issues` to `tasks`.
- Do not create raw SQL migrations by hand. Edit Drizzle schema, then run `pnpm db:generate`.
- Do not add broad UI redesign. Only add monitor/handoff/comment rendering needed to make the substrate visible and testable.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `packages/db/src/schema/issue_monitors.ts` | Company-scoped monitor schedule/history records |
| Modify | `packages/db/src/schema/heartbeat_runs.ts` | Add Paperclip retry durability columns missing in AoA: `retryOfRunId`, `scheduledRetryAt`, `scheduledRetryAttempt`, `scheduledRetryReason`, and issue-comment retry columns |
| Modify | `packages/db/src/schema/agent_wakeup_requests.ts` | Add partial unique idempotency index for durable recovery/retry wakes |
| Modify | `packages/db/src/schema/issue_comments.ts` | Add `authorType`, `presentation`, and `metadata` |
| Modify | `packages/db/src/schema/index.ts` | Export `issueMonitors` |
| Generate | `packages/db/src/migrations/0094_*.sql` | Drizzle-generated `issue_monitors` plus retry durability columns |
| Generate | `packages/db/src/migrations/0095_*.sql` | Drizzle-generated `issue_comments` structured-comment columns |
| Modify | `packages/shared/src/constants.ts` | Extend heartbeat statuses, issue origin kinds, liveness states, monitor statuses, handoff constants |
| Modify | `packages/shared/src/types/heartbeat.ts` | Scheduled-retry, retry/liveness run fields exposed to UI |
| Modify | `packages/shared/src/types/issue.ts` | Issue monitor and structured issue comment types |
| Modify | `packages/shared/src/validators/issue.ts` | Monitor policy/comment validator additions |
| Create | `server/src/services/recovery/index.ts` | Recovery subsystem exports |
| Create | `server/src/services/recovery/origins.ts` | Recovery `originKind` constants and fingerprints |
| Create | `server/src/services/recovery/service.ts` | Main recovery coordinator called by heartbeat and scheduled jobs |
| Create | `server/src/services/recovery/issue-graph-liveness.ts` | Dependency/backlog/blocker liveness classifier |
| Create | `server/src/services/recovery/run-liveness-continuations.ts` | Continuation classifier and bounded retry decisions |
| Create | `server/src/services/recovery/model-profile-hint.ts` | Cheap-profile hint wrapper and resolver for recovery wakes |
| Create | `server/src/services/recovery/successful-run-handoff.ts` | Missing-disposition handoff decision + system notices |
| Create | `server/src/services/productivity-review.ts` | D7 productivity review scanner/creator/hold service |
| Create | `server/src/services/issue-monitor-scheduler.ts` | Due monitor scanner and wake enqueue wrapper |
| Create | `server/src/services/issue-execution-policy.ts` | Monitor policy normalization/transition helpers |
| Create | `server/src/services/heartbeat-stop-metadata.ts` | Stop-reason normalization including max turns |
| Modify | `server/src/services/heartbeat.ts` | Call recovery service, schedule bounded retry, promote due retries, cancel stale queued work |
| Modify | `server/src/services/issues.ts` | Apply monitor policy fields, create review issues, structured comments, assigned-backlog guards |
| Modify | `server/src/routes/issues.ts` | Accept monitor policy updates, structured comments, and recovery/monitor liveness fields |
| Modify | `server/src/index.ts` | Register periodic recovery/productivity/monitor reconciliation ticks using the existing startup interval pattern |
| Modify | `ui/src/api/issues.ts` | Issue monitor and structured comment request/response types |
| Modify | `ui/src/components/IssueProperties.tsx` | Minimal monitor controls/status |
| Modify | `ui/src/components/IssueChatThread.tsx` and `ui/src/components/CommentThread.tsx` | Render system notices from comment presentation/metadata |
| Modify | `ui/src/components/IssueRunLedger.tsx` | Show retry/continuation metadata |
| Create | `server/src/__tests__/recovery-origins.test.ts`, `server/src/__tests__/recovery-schema-integration.test.ts`, `server/src/__tests__/issue-execution-policy.test.ts`, `server/src/__tests__/issue-monitor-scheduler.test.ts` | New recovery/monitor unit and embedded-pg integration coverage |
| Modify | `server/src/__tests__/heartbeat-retry-scheduling.test.ts`, `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts`, `server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts`, `server/src/__tests__/productivity-review-service.test.ts`, `server/src/__tests__/run-continuations.test.ts` | Existing heartbeat/recovery regression coverage |
| Create | `ui/src/components/SystemNotice.test.tsx`, `ui/src/components/IssueMonitorActivityCard.test.tsx`, `ui/src/lib/runRetryState.test.ts` | New UI coverage for structured comments, monitors, and retry state |
| Modify | `ui/src/components/IssueRunLedger.test.tsx`, `ui/src/components/IssueProperties.test.tsx`, `ui/src/components/IssueChatThread.test.tsx`, `ui/src/components/CommentThread.test.tsx` | Existing UI regression coverage |

---

## Session 12 Scope: Core Recovery + Max-Turn Retry

### Task 1: Migration Pre-Flight and Branch Hygiene

**Files:**
- Read: `packages/db/src/schema/heartbeat_runs.ts`
- Read: `packages/db/src/migrations/`
- Read: `docs/archive/sessions/2026-05-11-v1-upgrade-master.md`

- [ ] **Step 1: Confirm branch and dirty worktree**

Run:

```bash
git status --short --branch
```

Expected: branch is `feat/v1-recovery-service` or a branch created from `v1-upgrade`. Existing unrelated local files may be present; do not revert them.

- [ ] **Step 2: Repeat liveness pre-flight**

Run:

```bash
grep -n "livenessState\|livenessReason\|continuationAttempt\|nextAction" packages/db/src/schema/heartbeat_runs.ts
```

Expected: all four fields are present. If any are missing, add them as the first recovery migration before monitor/comment work, then accept the next Drizzle-generated numbers for the monitor and structured-comment migrations and update this document on the execution branch before continuing.

- [ ] **Step 3: Confirm retry durability gap**

Run:

```bash
grep -n "retryOfRunId\|scheduledRetryAt\|scheduledRetryAttempt\|scheduledRetryReason\|issueCommentStatus" packages/db/src/schema/heartbeat_runs.ts
```

Expected in current AoA: no hits. Keep these fields in Task 2's `0094` schema work because `15eac43b` depends on them.

---

### Task 2: Schema 0094 - Issue Monitors and Retry Durability

**Files:**
- Create: `packages/db/src/schema/issue_monitors.ts`
- Modify: `packages/db/src/schema/heartbeat_runs.ts`
- Modify: `packages/db/src/schema/agent_wakeup_requests.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generate: `packages/db/src/migrations/0094_*.sql`

- [ ] **Step 1: Create `issue_monitors` schema**

Add:

```ts
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueMonitors = pgTable(
  "issue_monitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    status: text("status").notNull().default("scheduled"),
    kind: text("kind").notNull().default("generic"),
    scheduledBy: text("scheduled_by").notNull().default("board"),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearReason: text("clear_reason"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts"),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
    notes: text("notes"),
    externalRef: text("external_ref"),
    recoveryPolicy: jsonb("recovery_policy").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueStatusIdx: index("issue_monitors_company_issue_status_idx").on(table.companyId, table.issueId, table.status),
    companyDueIdx: index("issue_monitors_company_due_idx").on(table.companyId, table.status, table.nextCheckAt),
    companyAgentStatusIdx: index("issue_monitors_company_agent_status_idx").on(table.companyId, table.agentId, table.status),
    oneActiveMonitorPerKindUq: uniqueIndex("issue_monitors_one_active_per_kind_uq")
      .on(table.companyId, table.issueId, table.kind)
      .where(sql`status in ('scheduled', 'triggered')`),
  }),
);
```

- [ ] **Step 2: Add retry durability columns to `heartbeat_runs`**

In `packages/db/src/schema/heartbeat_runs.ts`, import `type AnyPgColumn` and add:

```ts
    retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => heartbeatRuns.id, { onDelete: "set null" }),
    scheduledRetryAt: timestamp("scheduled_retry_at", { withTimezone: true }),
    scheduledRetryAttempt: integer("scheduled_retry_attempt").notNull().default(0),
    scheduledRetryReason: text("scheduled_retry_reason"),
    issueCommentStatus: text("issue_comment_status").notNull().default("not_applicable"),
    issueCommentSatisfiedByCommentId: uuid("issue_comment_satisfied_by_comment_id"),
    issueCommentRetryQueuedAt: timestamp("issue_comment_retry_queued_at", { withTimezone: true }),
```

Place them after output/process tracking and before liveness fields, matching Paperclip's data model.

- [ ] **Step 3: Add indexes**

Add indexes in the `heartbeatRuns` table callback:

```ts
    companyScheduledRetryIdx: index("heartbeat_runs_company_scheduled_retry_idx").on(
      table.companyId,
      table.status,
      table.scheduledRetryAt,
    ),
    retryOfRunIdx: index("heartbeat_runs_retry_of_run_idx").on(table.retryOfRunId),
```

- [ ] **Step 4: Add wake idempotency index**

In `packages/db/src/schema/agent_wakeup_requests.ts`, import `sql` and `uniqueIndex`, then add:

```ts
    companyIdempotencyKeyUq: uniqueIndex("agent_wakeup_requests_company_idempotency_key_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`idempotency_key is not null and reason in ('max_turn_continuation_retry', 'issue_monitor_due', 'finish_successful_run_handoff')`),
```

This makes recovery-owned scheduled retry, monitor, and handoff wake creation safe under concurrent scheduler ticks without requiring legacy non-recovery wake rows to have globally unique idempotency keys.

- [ ] **Step 5: Export the table**

In `packages/db/src/schema/index.ts` add:

```ts
export { issueMonitors } from "./issue_monitors.js";
```

- [ ] **Step 6: Generate migration**

Run:

```bash
pnpm db:generate
```

Expected: a single `packages/db/src/migrations/0094_*.sql` file that creates `issue_monitors`, adds the retry durability columns/indexes, and adds the wake idempotency partial unique index. Do not edit SQL by hand.

- [ ] **Step 7: Commit schema**

```bash
git add packages/db/src/schema/issue_monitors.ts packages/db/src/schema/heartbeat_runs.ts packages/db/src/schema/agent_wakeup_requests.ts packages/db/src/schema/index.ts packages/db/src/migrations
git commit -m "feat(recovery): add issue monitors and retry durability schema"
```

---

### Task 3: Shared Recovery Contracts

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types/heartbeat.ts`
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `packages/shared/src/validators/issue.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add constants**

Add:

```ts
export const HEARTBEAT_RUN_STATUSES = [
  "queued",
  "running",
  "scheduled_retry",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export const RUN_LIVENESS_STATES = ["unknown", "advanced", "completed", "blocked", "needs_followup", "stalled"] as const;
export const ISSUE_MONITOR_STATUSES = ["scheduled", "triggered", "cleared", "cancelled"] as const;
export const ISSUE_MONITOR_CLEAR_REASONS = [
  "manual",
  "done",
  "cancelled",
  "invalid_status",
  "invalid_assignee",
  "timeout_exceeded",
  "max_attempts_exhausted",
] as const;
export const ISSUE_ORIGIN_KINDS = [
  "routine_execution",
  "issue_productivity_review",
  "issue_continuation",
  "successful_run_handoff",
] as const;
export const RECOVERY_ORIGIN_KINDS = {
  issueProductivityReview: "issue_productivity_review",
  issueContinuation: "issue_continuation",
  successfulRunHandoff: "successful_run_handoff",
} as const satisfies Record<string, (typeof ISSUE_ORIGIN_KINDS)[number]>;
```

If `HEARTBEAT_RUN_STATUSES` or `ISSUE_ORIGIN_KINDS` already exists, extend the existing arrays in place rather than creating duplicates.

- [ ] **Step 2: Add types**

Add `RunLivenessState`, `IssueMonitor`, `IssueMonitorPolicy`, and `IssueCommentPresentation`/`IssueCommentMetadata` types. Extend `HeartbeatRun` with:

```ts
retryOfRunId: string | null;
scheduledRetryAt: string | null;
scheduledRetryAttempt: number;
scheduledRetryReason: string | null;
issueCommentStatus: string | null;
livenessState: RunLivenessState | null;
livenessReason: string | null;
continuationAttempt: number;
nextAction: string | null;
```

Use AoA package names, not `@paperclipai/*`.

- [ ] **Step 3: Add validators**

Add monitor policy validation:

```ts
export const issueMonitorPolicySchema = z.object({
  kind: z.string().min(1).default("generic"),
  nextCheckAt: z.string().datetime(),
  scheduledBy: z.enum(["board", "assignee"]).default("board"),
  notes: z.string().max(4000).optional().nullable(),
  maxAttempts: z.number().int().positive().optional().nullable(),
  timeoutAt: z.string().datetime().optional().nullable(),
  externalRef: z.string().max(1000).optional().nullable(),
  recoveryPolicy: z.record(z.unknown()).optional().nullable(),
});
```

- [ ] **Step 4: Typecheck**

Before typecheck, update every status helper that treats active runs as `queued | running` so scheduled retries are explicit:

- `server/src/services/heartbeat.ts`: active execution path constants include `scheduled_retry` only where a future retry should reserve the issue; dispatch/claim queries continue selecting `queued` only.
- `server/src/services/routines.ts`: `LIVE_HEARTBEAT_RUN_STATUSES` includes `scheduled_retry` when deciding whether a routine run already has live work.
- UI status utilities and run ledger helpers accept `scheduled_retry` and render it as a waiting retry, not a running task.

Run:

```bash
pnpm --filter @armyofagents/shared typecheck
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): add recovery monitor contracts"
```

---

### Task 4: Recovery Skeleton and Origins

**Files:**
- Create: `server/src/services/recovery/index.ts`
- Create: `server/src/services/recovery/origins.ts`
- Create: `server/src/services/recovery/model-profile-hint.ts`
- Create: `server/src/__tests__/recovery-origins.test.ts`
- Create: `server/src/__tests__/recovery-model-profile-hint.test.ts`
- Modify: `server/src/services/heartbeat.ts`

- [ ] **Step 1: Write unit tests**

Create tests asserting:

```ts
expect(RECOVERY_ORIGIN_KINDS.issueProductivityReview).toBe("issue_productivity_review");
expect(withRecoveryModelProfileHint({ issueId: "i1" })).toMatchObject({
  issueId: "i1",
  modelProfileHint: "cheap",
  recoveryModelProfile: "cheap",
});
```

Add resolver tests asserting:

```ts
expect(isCheapRecoveryWake({ modelProfileHint: "cheap" })).toBe(true);
expect(isCheapRecoveryWake({ recoveryModelProfile: "cheap" })).toBe(true);
expect(isCheapRecoveryWake({})).toBe(false);
```

- [ ] **Step 2: Implement origins and hint helper**

`origins.ts` should export AoA recovery origin constants from shared. `model-profile-hint.ts` should export:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { internalAgentConfig } from "@armyofagents/db";

export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(payload: T): T & {
  modelProfileHint: "cheap";
  recoveryModelProfile: "cheap";
} {
  return { ...payload, modelProfileHint: "cheap", recoveryModelProfile: "cheap" };
}

export function isCheapRecoveryWake(payload: Record<string, unknown> | null | undefined) {
  return payload?.modelProfileHint === "cheap" || payload?.recoveryModelProfile === "cheap";
}

export async function resolveRecoveryCheapModel(db: Db, companyId: string) {
  const row = await db
    .select({ cheapModel: internalAgentConfig.cheapModel })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.cheapModel?.trim() || null;
}
```

- [ ] **Step 3: Wire cheap-profile hint into heartbeat**

In `server/src/services/heartbeat.ts`, before the existing D4 spend-threshold `resolveCheapFallbackModel` call, inspect the run wake payload/context:

```ts
if (isCheapRecoveryWake(run.contextSnapshot as Record<string, unknown> | null)) {
  const recoveryCheapModel = await resolveRecoveryCheapModel(db, agent.companyId);
  if (recoveryCheapModel) {
    runScopedConfig = { ...runScopedConfig, model: recoveryCheapModel };
  }
} else {
  const cheapModel = await resolveCheapFallbackModel(db, agent.companyId, agent.id, budgetMonthlyCents);
  if (cheapModel) runScopedConfig = { ...runScopedConfig, model: cheapModel };
}
```

This makes recovery/productivity/monitor LLM wakes use the configured cheap model regardless of spend threshold, while normal agent runs keep D4's 80 percent budget fallback behavior.

- [ ] **Step 4: Export from `index.ts`**

```ts
export * from "./model-profile-hint.js";
export * from "./origins.js";
```

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter server test:run -- recovery-origins.test.ts recovery-model-profile-hint.test.ts cheap-fallback-heartbeat-contract.test.ts
git add server/src/services/recovery server/src/services/heartbeat.ts server/src/__tests__/recovery-origins.test.ts server/src/__tests__/recovery-model-profile-hint.test.ts
git commit -m "feat(recovery): add recovery service skeleton and cheap profile hints"
```

---

### Task 5: Heartbeat Stop Metadata

**Files:**
- Create: `server/src/services/heartbeat-stop-metadata.ts`
- Create: `server/src/services/heartbeat-stop-metadata.test.ts`
- Modify: `server/src/services/heartbeat.ts`

- [ ] **Step 1: Port tests from `15eac43b`**

Test these cases:

```ts
expect(normalizeMaxTurnStopReason("max_turns_exhausted")).toBe("max_turns_exhausted");
expect(normalizeMaxTurnStopReason("turn_limit_exhausted")).toBe("max_turns_exhausted");
expect(inferHeartbeatRunStopReason({ outcome: "succeeded" })).toBe("completed");
expect(inferHeartbeatRunStopReason({ outcome: "failed", errorCode: "adapter_failed" })).toBe("adapter_failed");
```

- [ ] **Step 2: Implement service**

Port `HeartbeatRunStopReason`, `inferHeartbeatRunStopReason`, `buildHeartbeatRunStopMetadata`, and `mergeHeartbeatRunStopMetadata` from Paperclip. In `defaultTimeoutSecForAdapter`, keep AoA's current adapter behavior by returning `0` for every adapter unless an existing AoA adapter already has a timeout default in `server/src/services/heartbeat.ts`.

- [ ] **Step 3: Wire heartbeat result persistence**

In `heartbeat.ts`, when setting final `resultJson`, merge stop metadata so max-turn errors persist as:

```ts
resultJson: {
  ...adapterResult.resultJson,
  stopReason: "max_turns_exhausted",
  timeoutFired: false,
}
```

- [ ] **Step 4: Run tests and commit**

```bash
pnpm --filter server test:run -- heartbeat-stop-metadata.test.ts
git add server/src/services/heartbeat-stop-metadata.ts server/src/services/heartbeat-stop-metadata.test.ts server/src/services/heartbeat.ts
git commit -m "feat(heartbeat): persist stop metadata for recovery"
```

---

### Task 6: Adapter Max-Turn Classification

**Files:**
- Modify: `packages/adapters/claude-local/src/server/parse.ts`
- Modify: `packages/adapters/gemini-local/src/server/parse.ts`
- Modify: matching adapter execute/test files if AoA has them
- Modify: `server/src/__tests__/claude-local-adapter.test.ts`
- Modify: `server/src/__tests__/gemini-local-adapter.test.ts`

- [ ] **Step 1: Add parser tests**

Assert Claude `error_max_turns` and Gemini turn-limit messages produce `resultJson.stopReason = "max_turns_exhausted"` or `errorCode = "max_turns_exhausted"`.

- [ ] **Step 2: Port parser changes from `15eac43b`**

Keep AoA adapter package names and existing test utilities. Do not widen unrelated parser behavior.

- [ ] **Step 3: Run adapter tests and commit**

```bash
pnpm --filter @armyofagents/adapter-claude-local test:run
pnpm --filter @armyofagents/adapter-gemini-local test:run
git add packages/adapters server/src/__tests__/*adapter*.test.ts
git commit -m "feat(adapters): classify max-turn exhaustion"
```

---

### Task 7: Bounded Retry Scheduler

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Create: `server/src/__tests__/heartbeat-retry-scheduling.test.ts`

- [ ] **Step 1: Add failing embedded-pg tests**

Cover:
- schedules max-turn continuation with `scheduledRetryReason = "max_turn_continuation"`
- coalesces duplicate schedules for the same source run and attempt
- refuses when the source issue is no longer `in_progress`
- caps after 2 max-turn continuation attempts
- refuses when budget hard-stop or task dependencies block the issue

- [ ] **Step 2: Implement exported constants**

In `heartbeat.ts`:

```ts
export const MAX_TURN_CONTINUATION_RETRY_REASON = "max_turn_continuation";
export const MAX_TURN_CONTINUATION_WAKE_REASON = "max_turn_continuation_retry";
export const MAX_TURN_CONTINUATION_MAX_ATTEMPTS = 2;
export const MAX_TURN_CONTINUATION_DELAY_MS = 1_000;
```

- [ ] **Step 3: Implement `scheduleBoundedRetry`**

Create a durable scheduled run and a non-dispatchable wake request in one transaction. Both rows use status `scheduled_retry`; only Task 8 promotion changes them to `queued`. The retry context must include:

```ts
{
  retryOfRunId: sourceRun.id,
  retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
  scheduledRetryAttempt: attempt,
  wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
  issueId,
  taskId: issueId,
  resumeIntent: true,
}
```

- [ ] **Step 4: Add transactional idempotency**

Use `agent_wakeup_requests.idempotency_key` and the Task 2 partial unique index:

```ts
[
  MAX_TURN_CONTINUATION_WAKE_REASON,
  issueId,
  sourceRun.id,
  String(attempt),
].join(":")
```

Inside the transaction:

1. Query for an existing wake with the same `companyId` and idempotency key whose status is one of `scheduled_retry`, `queued`, `deferred_issue_execution`, `claimed`, or `completed`.
2. If it exists and has `runId`, return that existing run instead of inserting.
3. If it exists without `runId`, attach the new scheduled run to that wake.
4. If insert races on the unique index, re-read the wake and return its run.

The inserted wake row must be:

```ts
{
  status: "scheduled_retry",
  reason: MAX_TURN_CONTINUATION_WAKE_REASON,
  idempotencyKey,
  payload: retryContext,
}
```

The inserted run row must be:

```ts
{
  status: "scheduled_retry",
  scheduledRetryAt: dueAt,
  scheduledRetryAttempt: attempt,
  scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
  wakeupRequestId: wakeup.id,
}
```

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter server test:run -- heartbeat-retry-scheduling.test.ts
git add server/src/services/heartbeat.ts server/src/__tests__/heartbeat-retry-scheduling.test.ts
git commit -m "feat(heartbeat): schedule bounded max-turn continuations"
```

---

### Task 8: Promote Due Scheduled Retries

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/__tests__/heartbeat-retry-scheduling.test.ts`

- [ ] **Step 1: Add tests**

Assert `promoteDueScheduledRetries(now)`:
- leaves not-yet-due retries in `scheduled_retry`
- promotes due retries to `queued`
- cancels retry and wake request when issue was reassigned
- cancels retry and clears `issues.executionRunId` when issue was cancelled

- [ ] **Step 2: Implement promotion**

Select `heartbeat_runs.status = "scheduled_retry"` where `scheduledRetryAt <= now`. Before promotion, re-read issue from `contextSnapshot.issueId` and verify:

```ts
issue.status === "in_progress" && issue.assigneeAgentId === dueRun.agentId
```

Cancel with `errorCode = "issue_cancelled"`, `"issue_reassigned"`, or `"issue_not_in_progress"` when invalid.

When valid, update both rows in one transaction:

```ts
heartbeat_runs.status = "queued";
agent_wakeup_requests.status = "queued";
```

The normal claim loop must continue selecting only `heartbeat_runs.status = "queued"`, so a scheduled retry cannot dispatch before promotion.

- [ ] **Step 3: Commit**

```bash
pnpm --filter server test:run -- heartbeat-retry-scheduling.test.ts
git add server/src/services/heartbeat.ts server/src/__tests__/heartbeat-retry-scheduling.test.ts
git commit -m "feat(heartbeat): promote and cancel scheduled retries"
```

---

### Task 9: Stale Queued-Run Cancellation

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts`

- [ ] **Step 1: Add tests from `82e257c7` heartbeat half**

Cover:
- new assignee is not deferred behind previous assignee's scheduled retry
- previous scheduled retry is cancelled on reassignment
- stale queued/scheduled run is cancelled when issue graph changes make it invalid

- [ ] **Step 2: Implement cancellation path**

Inside issue-scoped enqueue logic, when the active execution path points to a stale queued/scheduled run:

```ts
status: "cancelled",
finishedAt: now,
errorCode: "issue_reassigned" | "issue_cancelled" | "issue_not_in_progress",
```

Also cancel the linked `agent_wakeup_requests` row and clear `issues.executionRunId` only if it points at the cancelled run.

- [ ] **Step 3: Commit**

```bash
pnpm --filter server test:run -- heartbeat-stale-queue-invalidation.test.ts
git add server/src/services/heartbeat.ts server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts
git commit -m "feat(heartbeat): cancel stale queued recovery runs"
```

---

### Task 10: Issue Graph Liveness and Assigned Backlog Guard

**Files:**
- Create: `server/src/services/recovery/issue-graph-liveness.ts`
- Modify: `server/src/services/recovery/service.ts`
- Modify: `server/src/services/issues.ts`
- Create: `server/src/__tests__/issue-liveness.test.ts`
- Create: `server/src/__tests__/issue-assigned-backlog-contract-routes.test.ts`

- [ ] **Step 1: Add tests**

Cover:
- assigned `backlog` task is classified as not dispatchable
- assigned `todo` and `in_progress` tasks remain dispatch candidates when not blocked
- blocked task with unresolved dependency suppresses continuation
- terminal tasks are ignored

- [ ] **Step 2: Implement classifier**

Export:

```ts
export type IssueGraphLiveness =
  | { kind: "dispatchable" }
  | { kind: "assigned_backlog"; reason: string }
  | { kind: "dependency_blocked"; unresolvedBlockerIssueIds: string[] }
  | { kind: "terminal"; status: string }
  | { kind: "not_agent_assigned" };
```

- [ ] **Step 3: Wire guard**

Use the classifier in issue wake/assignment paths so backlog assignment does not create hidden runaway execution.

- [ ] **Step 4: Commit**

```bash
pnpm --filter server test:run -- issue-liveness.test.ts issue-assigned-backlog-contract-routes.test.ts
git add server/src/services/recovery server/src/services/issues.ts server/src/__tests__
git commit -m "feat(recovery): classify issue graph liveness"
```

---

### Task 11: Recovery Coordinator

**Files:**
- Create: `server/src/services/recovery/service.ts`
- Modify: `server/src/services/heartbeat.ts`
- Create: `server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts`

- [ ] **Step 1: Add tests**

Assert recovery coordinator:
- sees failed max-turn run and schedules bounded continuation
- records `livenessReason` on exhausted continuation attempts
- does not schedule when budget blocked
- does not schedule when dependencies block

- [ ] **Step 2: Implement `recoveryService(db, deps)`**

Expose:

```ts
export function recoveryService(db: Db, deps: { enqueueWakeup: EnqueueWakeup }) {
  return {
    handleCompletedRun,
    reconcileIssueGraphLiveness,
  };
}
```

`handleCompletedRun` checks stop metadata, issue liveness, budget block, and delegates to `heartbeat.scheduleBoundedRetry`.

- [ ] **Step 3: Wire heartbeat completion**

After a run reaches terminal status and after run-summary/comment handling, call:

```ts
await recovery.handleCompletedRun(run.id, { now: new Date() });
```

- [ ] **Step 4: Commit**

```bash
pnpm --filter server test:run -- heartbeat-issue-liveness-escalation.test.ts
git add server/src/services/recovery server/src/services/heartbeat.ts server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts
git commit -m "feat(recovery): coordinate liveness continuations"
```

---

### Task 12: Session 12 Verification

**Files:**
- No edits unless failures require fixes

- [ ] **Step 1: Run targeted tests**

```bash
pnpm --filter server test:run -- heartbeat-stop-metadata.test.ts heartbeat-retry-scheduling.test.ts heartbeat-stale-queue-invalidation.test.ts issue-liveness.test.ts heartbeat-issue-liveness-escalation.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit fixes if needed**

```bash
git add server/src/services/heartbeat.ts server/src/services/recovery server/src/__tests__
git commit -m "fix(recovery): stabilize core recovery tests"
```

---

## Session 13 Scope: Productivity Reviews + Monitors + Handoff Substrate

### Task 13: Schema 0095 - Structured Issue Comments

**Files:**
- Modify: `packages/db/src/schema/issue_comments.ts`
- Generate: `packages/db/src/migrations/0095_*.sql`

- [ ] **Step 1: Add columns**

Add `jsonb` import and fields:

```ts
    authorType: text("author_type").$type<IssueCommentAuthorType>(),
    presentation: jsonb("presentation").$type<IssueCommentPresentation | null>(),
    metadata: jsonb("metadata").$type<IssueCommentMetadata | null>(),
```

Keep `authorAgentId` and `authorUserId` for existing callers.

- [ ] **Step 2: Generate migration**

Run:

```bash
pnpm db:generate
```

Expected: `packages/db/src/migrations/0095_*.sql` adds only the three structured-comment columns.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema/issue_comments.ts packages/db/src/migrations
git commit -m "feat(comments): add structured system notice columns"
```

---

### Task 14: Structured Comment Service Contract

**Files:**
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `packages/shared/src/validators/issue.ts`
- Modify: `server/src/services/issues.ts`
- Modify: `server/src/routes/issues.ts`
- Modify: `ui/src/api/issues.ts`

- [ ] **Step 1: Add comment types**

Define:

```ts
export type IssueCommentAuthorType = "user" | "agent" | "system";
export type IssueCommentPresentation = {
  kind: "plain" | "system_notice";
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  detailsDefaultOpen?: boolean;
};
export type IssueCommentMetadata = {
  version: 1;
  sections: Array<{
    title: string;
    rows: Array<Record<string, unknown>>;
  }>;
};
```

- [ ] **Step 2: Extend `issueService.addComment`**

Change signature to:

```ts
addComment(issueId: string, body: string, actor: {
  agentId?: string;
  userId?: string;
  authorType?: IssueCommentAuthorType;
  presentation?: IssueCommentPresentation | null;
  metadata?: IssueCommentMetadata | null;
})
```

Default `authorType` to `"agent"` when `agentId`, `"user"` when `userId`, otherwise `"system"`.

- [ ] **Step 3: Preserve route behavior**

Board/user comment routes must continue calling `addComment` with no structured fields and receive plain comments.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm --filter server test:run -- issue-comment-reopen-routes.test.ts
pnpm --filter @armyofagents/shared typecheck
git add packages/shared/src server/src/services/issues.ts server/src/routes/issues.ts ui/src/api/issues.ts
git commit -m "feat(comments): support structured issue comments"
```

---

### Task 15: Successful-Run Handoff Decision

**Files:**
- Create: `server/src/services/recovery/successful-run-handoff.ts`
- Create: `server/src/services/recovery/successful-run-handoff.test.ts`

- [ ] **Step 1: Port decision tests from `454edfe8`**

Cover:
- skip when run is not `succeeded`
- skip when issue is not `in_progress`
- skip when issue is human-owned
- skip when there is an active execution path, pending interaction, explicit blocker, recovery issue, pause hold, or budget block
- enqueue when a productive successful run leaves no valid disposition
- skip issue monitor maintenance runs

- [ ] **Step 2: Implement decision functions**

Port these constants/functions with AoA wording:

```ts
export const FINISH_SUCCESSFUL_RUN_HANDOFF_REASON = "finish_successful_run_handoff";
export const SUCCESSFUL_RUN_MISSING_STATE_REASON = "successful_run_missing_state";
export const DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1;
export function decideSuccessfulRunHandoff(input: SuccessfulRunHandoffInput): SuccessfulRunHandoffDecision;
```

Use `withRecoveryModelProfileHint` in the corrective wake payload.

- [ ] **Step 3: Commit**

```bash
pnpm --filter server test:run -- successful-run-handoff.test.ts
git add server/src/services/recovery/successful-run-handoff.ts server/src/services/recovery/successful-run-handoff.test.ts
git commit -m "feat(recovery): decide successful run handoffs"
```

---

### Task 16: Successful-Run Handoff Integration

**Files:**
- Modify: `server/src/services/recovery/service.ts`
- Modify: `server/src/services/heartbeat.ts`
- Create: `server/src/__tests__/run-continuations.test.ts`

- [ ] **Step 1: Add embedded-pg test**

Seed a succeeded run with `livenessState = "advanced"` and an `in_progress` issue with no next path. Assert:
- one corrective wake is queued
- one system notice comment is written
- duplicate calls are idempotent

- [ ] **Step 2: Wire service**

`recovery.handleCompletedRun` should call `decideSuccessfulRunHandoff` after max-turn handling and before returning.

- [ ] **Step 3: Add system notices**

Use `issueService.addComment` with:

```ts
authorType: "system",
presentation: { kind: "system_notice", tone: "warning", title: "Missing issue disposition" },
metadata: { version: 1, sections: [...] },
```

- [ ] **Step 4: Commit**

```bash
pnpm --filter server test:run -- run-continuations.test.ts
git add server/src/services/recovery server/src/services/heartbeat.ts server/src/__tests__/run-continuations.test.ts
git commit -m "feat(recovery): queue successful-run handoffs"
```

---

### Task 17: Productivity Review Service

**Files:**
- Create: `server/src/services/productivity-review.ts`
- Create: `server/src/__tests__/productivity-review-service.test.ts`

- [ ] **Step 1: Port bounded tests from `42a299fb`**

Cover:
- no-comment streak creates one review issue
- long-active duration creates review issue
- high churn creates review issue
- open review is refreshed at most `maxRefreshComments`
- recent resolved review snoozes new creation
- creation window caps at `maxCreationsPerWindow`
- continuation hold activates for soft-stop triggers

- [ ] **Step 2: Implement thresholds**

Use these defaults:

```ts
noCommentStreakRuns: 10,
longActiveMs: 6 * 60 * 60 * 1000,
highChurnHourly: 10,
highChurnSixHours: 30,
resolvedSnoozeMs: 6 * 60 * 60 * 1000,
refreshIntervalMs: 60 * 60 * 1000,
maxRefreshComments: 3,
creationWindowMs: 24 * 60 * 60 * 1000,
maxCreationsPerWindow: 3,
```

- [ ] **Step 3: Create review issues**

Use `issueService.create` with:

```ts
originKind: RECOVERY_ORIGIN_KINDS.issueProductivityReview,
originId: sourceIssue.id,
requestDepth: clampIssueRequestDepth(sourceIssue.requestDepth + 1),
```

- [ ] **Step 4: Apply cost protection**

Every wake created by productivity review must wrap payload/context with `withRecoveryModelProfileHint`. This lets D4 use the cheap profile for productivity-review LLM work.

- [ ] **Step 5: Commit**

```bash
pnpm --filter server test:run -- productivity-review-service.test.ts
git add server/src/services/productivity-review.ts server/src/__tests__/productivity-review-service.test.ts
git commit -m "feat(recovery): add bounded productivity reviews"
```

---

### Task 18: Productivity Review Scheduler Hook

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/services/heartbeat.ts`
- Create: `server/src/__tests__/server-startup-feedback-export.test.ts`

- [ ] **Step 1: Find existing periodic jobs**

Inspect `server/src/index.ts` for heartbeat, feedback, cleanup, or cron startup loops. Use the existing pattern.

- [ ] **Step 2: Add reconciliation tick**

Register productivity review reconciliation on the same safe server-side interval family, defaulting to hourly. Do not run on every request.

- [ ] **Step 3: Gate continuations**

Before scheduling a max-turn continuation, ask:

```ts
await productivityReviewService(db).isProductivityReviewContinuationHoldActive({ companyId, issueId, agentId })
```

If held, record activity and skip continuation.

- [ ] **Step 4: Commit**

```bash
pnpm --filter server test:run -- productivity-review-service.test.ts
git add server/src/index.ts server/src/services/heartbeat.ts server/src/services/productivity-review.ts
git commit -m "feat(recovery): schedule productivity review reconciliation"
```

---

### Task 19: Issue Monitor Policy Helpers

**Files:**
- Create: `server/src/services/issue-execution-policy.ts`
- Create: `server/src/__tests__/issue-execution-policy.test.ts`

- [ ] **Step 1: Add tests from `57229d0f` adapted to `issue_monitors`**

Cover:
- schedule monitor only when issue is agent-assigned and `in_progress` or `in_review`
- reject exhausted `maxAttempts`
- clear monitor on `done`, `cancelled`, invalid assignee, or invalid status
- redact `externalRef` from persisted state metadata

- [ ] **Step 2: Implement helpers**

Expose:

```ts
export function normalizeIssueMonitorPolicy(input: unknown): IssueMonitorPolicy | null;
export function buildInitialIssueMonitorFields(input: ...): IssueMonitorInsert | null;
export function buildIssueMonitorTriggeredPatch(input: ...): Partial<IssueMonitor>;
export function buildIssueMonitorClearedPatch(input: ...): Partial<IssueMonitor>;
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter server test:run -- issue-execution-policy.test.ts
git add server/src/services/issue-execution-policy.ts server/src/__tests__/issue-execution-policy.test.ts
git commit -m "feat(monitors): add issue monitor policy helpers"
```

---

### Task 20: Issue Monitor Routes and Service Wiring

**Files:**
- Modify: `server/src/services/issues.ts`
- Modify: `server/src/routes/issues.ts`
- Create: `server/src/__tests__/issue-execution-policy-routes.test.ts`

- [ ] **Step 1: Add route tests**

Cover:
- `PATCH /api/issues/:id` can schedule monitor with `monitorPolicy`
- invalid monitor request returns `422`
- `PATCH` clearing monitor sets monitor row to `cleared`
- company boundary prevents cross-company monitor mutation

- [ ] **Step 2: Wire create/update with active-monitor idempotency**

On issue create/update, normalize monitor policy and use the Task 2 partial unique index to enforce one active monitor per `(companyId, issueId, kind)`.

Scheduling flow:

1. Start a transaction.
2. Try to insert a `scheduled` monitor row.
3. If the unique index conflicts, update the existing `scheduled`/`triggered` row for the same company/issue/kind back to `scheduled`, reset `nextCheckAt`, clear `clearedAt`/`clearReason`, and preserve `attemptCount`.
4. Log activity after the row is created or updated.

Clearing flow:

1. Update active rows for the same company/issue/kind to `cleared`.
2. Set `clearedAt`, `clearReason`, and `updatedAt`.
3. Cancel any linked monitor wake whose idempotency key matches `issue_monitor_due:<monitorId>:<attempt>`.

Activity actions:

```ts
action: "issue.monitor_scheduled" | "issue.monitor_cleared"
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter server test:run -- issue-execution-policy-routes.test.ts
git add server/src/services/issues.ts server/src/routes/issues.ts server/src/__tests__/issue-execution-policy-routes.test.ts
git commit -m "feat(monitors): wire issue monitor routes"
```

---

### Task 21: Issue Monitor Scheduler

**Files:**
- Create: `server/src/services/issue-monitor-scheduler.ts`
- Create: `server/src/__tests__/issue-monitor-scheduler.test.ts`
- Modify: `server/src/services/recovery/service.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Add embedded-pg tests**

Cover:
- due monitor triggers one wake
- repeated scheduler run before completion is idempotent
- monitor clears when max attempts reached
- monitor clears when timeout reached
- monitor wake uses cheap recovery profile hint

- [ ] **Step 2: Implement scheduler with claiming and state updates**

Find due rows:

```ts
status = "scheduled" AND nextCheckAt <= now
```

For each row, use a transaction to claim exactly one due monitor:

1. Re-read the monitor by `id`, `companyId`, `status = "scheduled"`, and `nextCheckAt <= now`.
2. If `timeoutAt <= now`, update to `cleared` with `clearReason = "timeout_exceeded"` and do not enqueue.
3. If `maxAttempts` is set and `attemptCount >= maxAttempts`, update to `cleared` with `clearReason = "max_attempts_exhausted"` and do not enqueue.
4. Otherwise compute `nextAttempt = attemptCount + 1`.
5. Update the monitor to `triggered`, set `attemptCount = nextAttempt`, `lastTriggeredAt = now`, `nextCheckAt = null`, and `updatedAt = now`.
6. Insert an `agent_wakeup_requests` row with idempotency key `issue_monitor_due:<monitorId>:<nextAttempt>`. If the unique key already exists, return the existing wake instead of inserting another.

The wake payload must be:

```ts
withRecoveryModelProfileHint({
  issueId,
  monitorId,
  wakeReason: "issue_monitor_due",
  monitorAttempt: attemptCount + 1,
})
```

After the wake insert/update, log `issue.monitor_triggered`. Repeated ticks before the assignee reacts must see `status = "triggered"` and enqueue nothing.

- [ ] **Step 3: Register tick**

Use the same startup interval pattern as productivity reviews.

- [ ] **Step 4: Commit**

```bash
pnpm --filter server test:run -- issue-monitor-scheduler.test.ts
git add server/src/services/issue-monitor-scheduler.ts server/src/services/recovery/service.ts server/src/index.ts server/src/__tests__/issue-monitor-scheduler.test.ts
git commit -m "feat(monitors): trigger due issue monitors"
```

---

### Task 22: UI System Notice Rendering

**Files:**
- Modify: `ui/src/components/IssueChatThread.tsx`
- Modify: `ui/src/components/CommentThread.tsx`
- Create: `ui/src/components/SystemNotice.tsx`
- Create: `ui/src/components/SystemNotice.test.tsx`
- Create: `ui/src/lib/system-notice-comment.ts`

- [ ] **Step 1: Add tests**

Assert a comment with:

```ts
presentation: { kind: "system_notice", tone: "warning", title: "Missing issue disposition" }
```

renders as a compact system notice and not as an agent/user bubble.

- [ ] **Step 2: Implement renderer**

Use existing design tokens/components. Keep the notice compact and readable; do not add marketing-style copy.

- [ ] **Step 3: Commit**

```bash
pnpm --filter ui test:run -- SystemNotice.test.tsx IssueChatThread.test.tsx CommentThread.test.tsx
git add ui/src/components ui/src/lib
git commit -m "feat(ui): render recovery system notices"
```

---

### Task 23: UI Monitor Surface

**Files:**
- Modify: `ui/src/api/issues.ts`
- Modify: `ui/src/components/IssueProperties.tsx`
- Create: `ui/src/components/IssueMonitorActivityCard.tsx`
- Create: `ui/src/components/IssueMonitorActivityCard.test.tsx`
- Modify: `ui/src/pages/IssueDetail.tsx`

- [ ] **Step 1: Add tests**

Cover rendering scheduled monitor date, triggered state, cleared reason, and max-attempts exhausted state.

- [ ] **Step 2: Add controls**

Expose a minimal monitor schedule editor in `IssueProperties`:
- datetime input for `nextCheckAt`
- notes textarea
- max attempts number input
- clear button

- [ ] **Step 3: Commit**

```bash
pnpm --filter ui test:run -- IssueMonitorActivityCard.test.tsx IssueProperties.test.tsx
git add ui/src/api/issues.ts ui/src/components ui/src/pages/IssueDetail.tsx
git commit -m "feat(ui): add issue monitor controls"
```

---

### Task 24: UI Retry Ledger Metadata

**Files:**
- Modify: `ui/src/components/IssueRunLedger.tsx`
- Modify: `ui/src/components/IssueRunLedger.test.tsx`
- Create: `ui/src/lib/runRetryState.ts`
- Create: `ui/src/lib/runRetryState.test.ts`

- [ ] **Step 1: Add tests**

Cover labels for:
- `scheduled_retry`
- `scheduledRetryReason = "max_turn_continuation"`
- exhausted max-turn continuation
- cancelled stale retry

- [ ] **Step 2: Implement display**

Show concise retry state in the run ledger, using Task language in visible UI.

- [ ] **Step 3: Commit**

```bash
pnpm --filter ui test:run -- runRetryState.test.ts IssueRunLedger.test.tsx
git add ui/src/components/IssueRunLedger.tsx ui/src/lib/runRetryState.ts ui/src/**/*RunLedger*.test.tsx ui/src/lib/runRetryState.test.ts
git commit -m "feat(ui): show recovery retry state"
```

---

### Task 25: Embedded-PG Schema Integration

**Files:**
- Create: `server/src/__tests__/recovery-schema-integration.test.ts`

- [ ] **Step 1: Add integration test**

Use the pattern from `server/src/__tests__/companies-delete-integration.test.ts`: start embedded Postgres, `applyPendingMigrations`, `createDb`.

Assert:
- `issue_monitors` can insert/select by company and issue
- `issue_comments.presentation` and `metadata` round-trip JSON
- `heartbeat_runs.scheduled_retry_*` fields round-trip

- [ ] **Step 2: Run and commit**

```bash
pnpm --filter server test:run -- recovery-schema-integration.test.ts
git add server/src/__tests__/recovery-schema-integration.test.ts
git commit -m "test(recovery): cover recovery schema with embedded postgres"
```

---

### Task 26: Company Scope and Activity Logging Audit

**Files:**
- Modify: `server/src/services/recovery/service.ts`
- Modify: `server/src/services/recovery/successful-run-handoff.ts`
- Modify: `server/src/services/productivity-review.ts`
- Modify: `server/src/services/issue-monitor-scheduler.ts`
- Modify: `server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts`
- Modify: `server/src/__tests__/productivity-review-service.test.ts`
- Modify: `server/src/__tests__/issue-monitor-scheduler.test.ts`

- [ ] **Step 1: Add/confirm company-boundary tests**

Search:

```bash
grep -R "companyId" -n server/src/services/recovery server/src/services/productivity-review.ts server/src/services/issue-monitor-scheduler.ts
```

Every query that reads/writes issue, run, wake, monitor, or comment data must constrain by `companyId`.

- [ ] **Step 2: Add activity logging assertions**

Mutating recovery actions must log:
- `issue.recovery_continuation_queued`
- `issue.recovery_continuation_exhausted`
- `issue.successful_run_handoff_queued`
- `issue.productivity_review_created`
- `issue.productivity_review_updated`
- `issue.monitor_scheduled`
- `issue.monitor_triggered`
- `issue.monitor_cleared`

- [ ] **Step 3: Commit**

```bash
pnpm --filter server test:run -- heartbeat-issue-liveness-escalation.test.ts productivity-review-service.test.ts issue-monitor-scheduler.test.ts successful-run-handoff.test.ts
git add server/src
git commit -m "fix(recovery): enforce company scope and activity logs"
```

---

### Task 27: Anti-AoA Port Guard

**Files:**
- Read: `packages/db/src/schema/companies.ts`
- Read: `server/src/routes/companies.ts`
- Read: `CLAUDE.md`

- [ ] **Step 1: Verify hire approval default remains AoA-specific**

Run:

```bash
grep -n "requireBoardApprovalForNewAgents" packages/db/src/schema/companies.ts server/src/routes/companies.ts CLAUDE.md
```

Expected:
- DB default remains `true`
- `server/src/routes/companies.ts` still sets false only for `local_trusted`
- CLAUDE D6 divergence remains intact

- [ ] **Step 2: Commit only if a guard test was needed**

If implementation touched these files, add a regression test. Otherwise no commit.

---

### Task 28: Brand and Migration Guard

**Files:**
- No edits unless guard fails

- [ ] **Step 1: Brand grep**

Run:

```bash
grep -RIn "Paperclip\|paperclip\|@paperclipai" server/src packages/shared/src packages/db/src ui/src | grep -v "paperclip-migration" || true
```

Expected: no new shipping-code hits from this branch. Recovery system notice text must say AoA or Task, not Paperclip or Issue where user-facing.

- [ ] **Step 2: Migration numbering check**

Run:

```bash
ls packages/db/src/migrations | tail -n 8
```

Expected from the current base: `0094_*` and `0095_*` exist and are the only migrations from this plan. If prerequisite branches added migrations first, the generated filenames may be higher; verify there are exactly two recovery migrations and their diffs match Tasks 2 and 13.

---

### Task 29: Full Verification

**Files:**
- No edits unless failures require fixes

- [ ] **Step 1: Targeted suite**

```bash
pnpm --filter server test:run -- heartbeat-retry-scheduling.test.ts heartbeat-stale-queue-invalidation.test.ts heartbeat-issue-liveness-escalation.test.ts run-continuations.test.ts productivity-review-service.test.ts issue-monitor-scheduler.test.ts recovery-schema-integration.test.ts
pnpm --filter ui test:run -- SystemNotice.test.tsx IssueMonitorActivityCard.test.tsx IssueRunLedger.test.tsx
```

Expected: all pass.

- [ ] **Step 2: Required handoff checks**

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all pass. If a command cannot be run, record exact reason and last successful narrower command in the final handoff.

- [ ] **Step 3: Commit verification fixes**

```bash
git add server/src ui/src packages/shared/src packages/db/src
git commit -m "fix(recovery): resolve verification findings"
```

---

### Task 30: Code Review and Fixes

**Files:**
- Modify only files needed for reviewer findings

- [ ] **Step 1: Request review**

Use `superpowers:requesting-code-review` or dispatch a reviewer subagent with this prompt:

```text
Review feat/v1-recovery-service against docs/archive/sessions/2026-05-12-v1-recovery-service.md.
Prioritize blockers: schema/contract drift, company-scope leaks, unbounded retry loops, cost-protection gaps,
missing activity logs, migration numbering mistakes, and accidental port of requireBoardApprovalForNewAgents default flips.
Return findings with file/line references and severity.
```

- [ ] **Step 2: Fix blockers**

For each P0/P1/P2 finding, add or update a failing test first, implement the fix, and rerun the relevant targeted test.

- [ ] **Step 3: Final verification**

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all pass before claiming ready for PR.

---

## Self-Review Checklist

- [x] D1 recovery skeleton is represented by Tasks 4, 10, 11, and 26.
- [x] D7 productivity reviews with bounds are represented by Tasks 17 and 18.
- [x] Max-turn continuation retry from `15eac43b` is represented by Tasks 5-9 and 24.
- [x] Successful-run handoff from `454edfe8` is represented by Tasks 13-16 and 22.
- [x] Stale queued-run cancellation from `82e257c7` is represented by Task 9.
- [x] Productivity-review bounds from `42a299fb` are represented by Task 17.
- [x] Issue monitor liveness controls from `57229d0f` are represented by Tasks 2, 19-23, and 25.
- [x] Assigned-backlog liveness from `e400315c` is represented by Task 10.
- [x] `requireBoardApprovalForNewAgents` Paperclip flip is explicitly skipped in Non-Goals and Task 27.
- [x] Cost protection is explicit: recovery/productivity/monitor LLM wakes use `withRecoveryModelProfileHint`, relying on D4 cheap fallback.
- [x] Tests include per-sub-service unit tests and embedded-postgres integration tests.
- [x] Session split is explicit: Session 12 core recovery + max-turn retry; Session 13 productivity reviews + monitors + handoff substrate.

---

## Execution Handoff

Plan is ready for Sessions 12-13. Session 12 should start at Task 1 and stop after Task 12 verification. Session 13 should resume at Task 13 and finish through Task 30 review/verification.
