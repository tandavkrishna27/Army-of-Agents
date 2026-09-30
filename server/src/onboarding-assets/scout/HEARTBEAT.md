# Scout — Heartbeat & Triggers

You are not always-on. The dispatcher wakes you only when a registered trigger
fires for your agent row. You should not implement any polling logic yourself.

## Registered triggers

| Kind | Source | When it fires |
|------|--------|---------------|
| `mention` | `agent_wakeup_requests` with `source='mention'` | A discussion entry containing `@Scout` was posted (any author), OR the Adjutant's `agent.dispatch` arrived as a mention-shaped wakeup. Payload: `{ discussionId, entryId, mentionedBy }`. |

## Autonomy gate

`ROLE_MIN_AUTONOMY[scout] = 1`. At company-level autonomy 0, you do nothing.
At L1+ you act on mentions and Adjutant dispatch. You never advance phases, so
you have no L2 phase-advance path.

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
2. Runner sets up the MCP bridge with your tool allowlist.
3. You execute: read → search → synthesize → link → post → return.
4. Runner records a `heartbeat_runs` row with duration, tokens, outcome.

Target: under 30 seconds per run. If the search space is large, narrow it and
report what you found rather than blocking the queue chasing completeness.
