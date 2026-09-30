// server/src/services/distributed-rollout-port.ts
//
// Unit 1.5 — the process-wide port that carries the CLI-006 rollout hook to EVERY
// `heartbeatService` instance, not just the scheduler's.
//
// ★ WHY THIS EXISTS — MEASURED, not theorised.
//
// `heartbeatService(db, options?)` reads the hook from `options?.distributedRollout`
// (`heartbeat.ts`), and exactly ONE construction site supplies it:
//
//   index.ts   heartbeatService(db, { distributedRollout: distributedRolloutHook })   // scheduler only,
//                                                                                     // and itself behind
//                                                                                     // `if (config.heartbeatSchedulerEnabled)`
//
// Every other construction is bare, and they split into two kinds — a distinction that
// turns out to be load-bearing:
//
//   EAGER, at factory scope, built by `createApp` (index.ts:931) BEFORE this port is
//   registered (index.ts:1397). A hook captured in a `const` at factory scope is
//   permanently `undefined` for these:
//     routes/issues.ts:99     const heartbeat = heartbeatService(db)
//     routes/agents.ts        const heartbeat = heartbeatService(db)
//     routes/approvals.ts     const heartbeat = heartbeatService(db)
//
//   PER-CALL, constructed at wake time, i.e. always after boot:
//     services/issue-assignee-wakeup.ts        await heartbeatService(db).wakeup(...)
//     services/comment-wakeup-outbox.ts        heartbeatService(db).wakeup(...)
//     services/work-question-continuations.ts
//
// The first draft of this port captured the hook at factory scope and was therefore a
// NO-OP for the three eager sites — the fix would have looked wired, typechecked, passed
// its tests, and never fired on `routes/issues.ts`. It was caught only because the
// per-call sites masked it: the probe's own `issue_assigned` path runs through
// issue-assignee-wakeup, so the canary would have started working while three adjacent
// paths silently stayed legacy. Hence the lazy read (see `getDistributedRolloutPort`).
//
// And `enqueueWakeup` does not merely queue — it EXECUTES on its own instance
// (`dispatchQueuedRunsAfterAgentSignal` -> `startQueuedRunsForSingleAgent` ->
// `claimQueuedRun` -> `void executeRun(...)`). So `executeRun` closes over THAT
// instance's `distributedRolloutHook === undefined`, `distributedRolloutState` stays
// `"off"`, and the canary conjunct fails.
//
// The observable consequence, reproduced on a live single-box fleet before this port
// existed: an HTTP-created task assigned to an eligible `org`/`claude_local` agent, with
// the rollout dial correctly set to `mode:"canary"`, produced
//
//     heartbeat_runs = 1, execution_owner = NULL, and NO `[CLI-006]` log line at all
//
// i.e. byte-for-byte indistinguishable from "the canary evaluated this run and chose
// legacy". A silent, unfalsifiable no-op — the failure class this programme treats as
// worse than a crash.
//
// ★ BE PRECISE ABOUT WHAT THAT PROBE PROVED. The `[CLI-006]` decision block is guarded by
// SEVEN conjuncts, so its silence alone does not isolate any one of them:
//
//   distributedRolloutHook && distributedRolloutState === "canary" && shouldAutoCheckoutForWake
//     && distributedRolloutOrganizationId && issueId && issueContext
//     && issueContext.assigneeAgentId === agent.id
//
// The probe establishes the SYMPTOM; the source establishes the CAUSE. Four of those
// conjuncts were independently satisfied by that probe — `shouldAutoCheckoutForWake` folds
// in issueId/issueContext/assignee and admits `issue_assigned` (it excludes only
// `issue_comment_mentioned` and `execution_*` wakes) — and `distributedRolloutState` and
// `distributedRolloutOrganizationId` are both PRODUCED by the hook, so a missing hook is
// sufficient to force all three of its conjuncts false at once. Combined with the fact that
// the executing instance is demonstrably constructed bare, the hook is the cause. A future
// reader debugging a different silent canary should re-check all seven rather than assume
// this one.
//
// ★ THIS IS THE IDIOM THE REPO ALREADY ARGUED FOR. `distributed-cancellation-port.ts`
// documents the identical hazard for `cancelRun`, names the same bare call sites, and
// says: "Only the scheduler instance receives `distributedRollout`. A port added to
// `heartbeatService`'s options would therefore be `undefined` at every real cancel: the
// code would look wired, typecheck, and never fire." It then solves that for
// cancellation — while the rollout hook it cites as the example stayed injection-only.
// This module closes that gap with the same instance-independent registration.

import type { HeartbeatDistributedRolloutHook } from "./heartbeat-distributed-rollout.js";

let registeredHook: HeartbeatDistributedRolloutHook | undefined;

/**
 * Register (or clear, with `undefined`) the process-wide rollout hook. Called once from
 * the `index.ts` distributed block — deliberately OUTSIDE `if (config.heartbeatSchedulerEnabled)`,
 * because the route-constructed instances that actually execute task runs exist whether or
 * not the scheduler does.
 *
 * Clearing exists so a test — or a config reload — cannot leak one deployment's hook into
 * another, mirroring `setDistributedCancellationPort`.
 */
export function setDistributedRolloutPort(hook: HeartbeatDistributedRolloutHook | undefined): void {
  registeredHook = hook;
}

/**
 * The hook for a `heartbeatService` built without one.
 *
 * ★ Precedence: an EXPLICIT `options.distributedRollout` always wins over this port, so the
 * scheduler's existing wiring is byte-identical. Note precisely what that does and does not
 * mean: under `??`, `{ distributedRollout: undefined }` is indistinguishable from `{}`, so a
 * caller passing an explicit `undefined` DOES inherit the port. No caller in the tree does
 * that deliberately; a real opt-out is expressed by not registering a port at all.
 *
 * ★ Read LAZILY, per run — never captured at construction. `createApp` eagerly builds the
 * route factories, three of which hold a factory-scope `heartbeatService(db)`, ~466 lines
 * before `index.ts` registers this port. A value captured in the factory would therefore be
 * permanently `undefined` on exactly those sites. `heartbeat.ts` resolves through a closure
 * inside `executeRun` instead, which makes boot ORDER irrelevant rather than merely correct
 * today. Do not "optimise" that back into a factory-scope `const`.
 *
 * ★ Inert when distributed execution is off: `index.ts` only builds and registers the hook
 * inside the distributed block, so on a flag-off deployment this returns `undefined` and
 * every instance behaves exactly as before.
 */
export function getDistributedRolloutPort(): HeartbeatDistributedRolloutHook | undefined {
  return registeredHook;
}
