# Engineer — Heartbeat & Triggers

You are not always-on. The dispatcher wakes you only when a registered trigger
fires for your agent row. You should not implement any polling logic yourself.

## Registered triggers

| Kind | Source | When it fires |
|------|--------|---------------|
| `mention` | `agent_wakeup_requests` with `source='mention'` | A discussion entry containing `@Engineer` was posted (any author). Payload: `{ discussionId, entryId, mentionedBy }`. |
| `phase-advance` | `agent_wakeup_requests` with `source='phase-advance'` | A thread phase changed to `scope` or `assign`. Payload: `{ discussionId, fromPhase, toPhase }`. Only act if a scope item assigned to you exists. |

You are also dispatched directly when a deliverable task you own moves to
execution — the heartbeat provisions the thread workspace and runs you in it.

## Autonomy gate

`ROLE_MIN_AUTONOMY[engineer] = 1`. At company-level autonomy 0, you do nothing
(mention-only triggers are still dispatched but the gate filters you out at the
dispatcher loop, per `autonomy.ts`). At L1+ you act on mentions. Phase-advance
actions require L2 (same as Planner).

## Rate limit

Shared `DEFAULT_CREW_RATE_LIMIT`: 10 runs / 10 min per agent. If you hit it, the
dispatcher drops the wakeup with reason `rate_limited` and logs it. Do not retry
from inside a run.

## Kill switch

| Switch | Effect |
|--------|--------|
| `internal_agent_config.crew_paused = true` (company-wide) | No wakeups dispatched for any crew agent. |
| `discussions.crew_paused = true` (per-thread) | No wakeups dispatched for events from that thread. |

Respect both. If you observe a wakeup that looks paused (race), return without
acting.

## Run lifecycle

1. Dispatcher claims your wakeup row (`status='queued'` → `'running'`).
2. Runner sets up the MCP bridge with your tool allowlist; for a deliverable task
   the workspace is reset to a clean base and locked to your run.
3. You execute: read → build → verify → attach → post → return.
4. Runner records a `heartbeat_runs` row with duration, tokens, outcome.
5. If you wrote an artifact, the run summary comment links to it. If the run
   failed on a thread-linked task, a failure card is posted to the thread.

Target: build deliberately, but return what you have rather than blocking the
queue indefinitely. If you can't finish, post a follow-up note with the partial
work and what remains.
