# PR-A2 — Thread-level error banner ("lastError UI surface")

**Status:** design (approved). The #198 follow-up that surfaces a thread's coordination error to the founder.

## Problem

When a thread's orchestration hits an error, the controller records it on
`thread_orchestration_state.lastError` (`thread-orchestration.ts:214,229,556`) and clears it
on the next success (`:734`) — but **nothing shows it to the user.** The code comment says so:
*"persisted + logged; a UI/Inbox surface is tracked in #198."* So a founder has no signal that
an agent's coordination on a thread is failing (a commit keeps failing, the circuit-breaker
tripped, or the agent run threw). Per-*action* crew failures (`CrewFailureCard`) and
entry-extraction errors already surface; the **thread-level** error is the gap.

## Scope

**In:** surface the single thread-level `lastError` as a self-clearing banner in the thread
header. **Out (explicitly):** per-action `thread_agent_actions` states (blocked_policy / failed /
suppressed_stale) — those aren't exposed to the UI today and surfacing them is a separate, larger
piece. No schema change.

## Design

### Backend — expose `lastError` on the thread detail
`GET /companies/:companyId/discussions/:discussionId` → `discussionService.getById`
(`discussions.ts:450`). It does **not** currently query `thread_orchestration_state`. Add one
small read and include two fields in the returned object:

```ts
const [orch] = await db
  .select({
    lastError: threadOrchestrationState.lastError,
    consecutiveCommitFailures: threadOrchestrationState.consecutiveCommitFailures,
  })
  .from(threadOrchestrationState)
  .where(eq(threadOrchestrationState.threadId, id))
  .limit(1);
// ...in the returned object:
lastError: orch?.lastError ?? null,
consecutiveCommitFailures: orch?.consecutiveCommitFailures ?? 0,
```

No route change (the route returns `getById`'s result). No schema change. Self-clearing: the
controller already sets `lastError = null` on a successful run, so the banner vanishes on recovery.

### Frontend — `ThreadErrorBanner`
1. **Type:** add `lastError?: string | null` (and `consecutiveCommitFailures?: number`) to
   `DiscussionDetail` (`ui/src/api/discussions.ts:125-142`). `ThreadDetail` inherits it.
2. **Component:** new `ui/src/components/threads/ThreadErrorBanner.tsx`, mirroring the existing
   `TranscriptErrorBlock` style (left red border `border-l-red-500`, subtle red wash, `AlertCircle`
   icon, expandable). Props: `{ error: string | null; consecutiveFailures?: number }`. Renders
   `null` when `error` is falsy. Shows a friendly headline ("An agent action on this thread didn't
   go through"), a one-line plain explanation, and the raw `lastError` behind a "Show details"
   expander (monospace). `data-testid="thread-error-banner"`.
3. **Placement:** in `ThreadDetail.tsx`, inside the `data-testid="thread-center-header"` block,
   immediately after the title/controls row (~`:1102-1105`), before the "Scoped to" meta.

### UX notes
- Self-clearing (no manual dismiss) — keeps the banner truthful to live state.
- Friendly headline + raw error in an expander — a founder sees "something failed, it'll retry"
  without needing to parse `action_commit_failed_skipped:...`.
- Non-blocking: the banner sits above the feed; the thread remains fully usable.

## Test plan (all four types)

1. **Server unit** (`discussions` service test, mock DB): `getById` returns `lastError` +
   `consecutiveCommitFailures` from the orchestration row; returns `null`/`0` when no orchestration
   row exists.
2. **Real-DB integration** (Docker / embedded-postgres): seed a discussion + a
   `thread_orchestration_state` row with `last_error` set → `getById` returns it; set
   `last_error = NULL` → `getById` returns `null`.
3. **UI unit** (vitest + @testing-library/react): `ThreadErrorBanner` renders the headline +
   expander when `error` is set; renders nothing (`null`) when `error` is null/empty; "Show
   details" reveals the raw error.
4. **E2E** (playwright, `tests/e2e`): on a thread whose orchestration has a `lastError`, the thread
   view shows `thread-error-banner`; on a clean thread it does not. (E2E is skipped on Windows in CI
   per the project setup — written regardless; runs on Linux CI.)

## Files

- **Modify:** `server/src/services/discussions.ts` (getById: + orchestration read), the server
  `DiscussionDetail` response type if one is declared.
- **Modify:** `ui/src/api/discussions.ts` (`DiscussionDetail` += `lastError`,
  `consecutiveCommitFailures`).
- **Create:** `ui/src/components/threads/ThreadErrorBanner.tsx`.
- **Modify:** `ui/src/pages/ThreadDetail.tsx` (render the banner in the header).
- **Create:** server unit + integration test cases; `ThreadErrorBanner.test.tsx`; a playwright spec.

## Risks / edge cases
- A long/multi-line `lastError` — the expander handles overflow (mirror `TranscriptErrorBlock`'s
  max-height + scroll).
- A thread with no orchestration row (never ran the controller) — `getById` returns `lastError:
  null` → no banner. Correct.
- `lastError` is a raw internal string (e.g. `action_commit_failed_skipped:...`) — shown only in the
  expander, behind a plain-language headline, so it never confronts a non-technical founder unprompted.
- Self-clear timing: the banner reflects the *last fetched* state; it disappears on the next detail
  refetch after a successful run. Acceptable for observability (not a real-time alert).
