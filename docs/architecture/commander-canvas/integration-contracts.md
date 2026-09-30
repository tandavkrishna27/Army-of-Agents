# Universe — voice, browser and recovery integration contracts

September 11, 2026. Proposed implementation contracts extending the [request contract](request-contract.md), [state contract](state-contract.md) and [grooming review](grooming-review.md). Names below are proposed shared wire fields, not existing API claims. Source baseline remains [integration review](integration-decision-review.md).

## 1. Voice to Commander

### Existing binding

`server/src/routes/internal-agent.ts` accepts chat through POST `/companies/:companyId/internal-agent/chat`. `agent-loop.ts` accepts `conversationId`, `clientSubmissionId`, `attachmentAssetIds` and context scope. It checks requested conversation ownership, replays a persisted reply explicitly linked to the original user message, and uses a durable claim for unfinished turns. Tool-only completed replies count as completed. Reuse these semantics.

### Proposed shared request envelope

| Field | Meaning / authority |
|---|---|
| conversationId | Required destination; server checks company and user ownership. |
| clientSubmissionId | Stable identity for one finalized work request, reused across transport retries. |
| content | Finalized user instruction; interim speech hypotheses do not execute actions. |
| selectedRefs | Typed references containing resource kind, resource ID and optional exact version; server resolves and authorizes. |
| contextRevision | Revision of the UI context captured for this submission; later UI movement cannot change the request. |
| attachmentAssetIds | Existing authorized attachment references. |
| source | Text or voice provenance; never changes permission. |
| voiceSessionId / voiceTurnId | Optional correlation, not execution authority or idempotency identity. |

Canonicalize and fingerprint the execution-relevant payload. A reused submission identity with different content/targets returns conflict; add explicit validation rather than assume current replay enforces payload equality. Preserve the original accepted payload. Session reconnection cannot mint a replacement submission identity merely to retry.

### Flow

1. Server authorizes a voice session for a company, user and conversation and configured provider. Provider credentials stay scoped to their intended usage; client receives only the permitted connection material.
2. Voice submits a finalized work request through the same Commander service boundary as typed requests. Voice can converse, but does not independently mutate AoA records or dispatch agents.
3. Return acceptance only after durable request ownership is established. Transport connection, initial thinking status and provider speech are not proof of durable acceptance.
4. Associate progress and result with the canonical user message/turn. The provider receives confirmed status, not inferred completion. Long-running tasks return progress without holding an unrelated human turn hostage.
5. On correction, create a new request referencing the original task; do not rewrite an already accepted payload. Explicit stop invokes canonical cancellation. Speech interruption only stops output.

### Missing service surface

Add an authorized, read-only submission outcome lookup keyed by conversation and submission identity. It returns absent, accepted/in-progress, completed or unresolved according to durable evidence, with original message/result references. Exact route placement follows existing internal-agent routing. A read must never reclaim a turn or start a CLI process. Querying another user's conversation returns the existing non-disclosing not-found behavior.

The existing POST replay path may reclaim eligible unfinished work; therefore it cannot substitute for read-only reconnect inspection. Preserve takeover/lease rules in Commander rather than implementing them in the voice adapter.

## 2. Browser live view and input

### Existing and missing boundaries

Replatform's Playwright driver launches Chromium with `headless` defaulting to true. Its navigation/download/close functionality and saved recording do not establish interactive streaming. Browser Use automation, headed display/capture, and authenticated transport are separate adapters. Cloud desktop streaming remains an integration candidate requiring a compatible guest; local browser capture remains an implementation boundary needing platform-specific qualification. Do not label either path complete.

### Proposed session descriptor

`browserSessionId`, company/task association, worker identity, placement, allowed account reference, lifecycle revision, controller epoch and capability set. Capabilities separately declare live view, pointer/keyboard input, clipboard, uploads/downloads, tabs, browser chrome/native dialogs, audio and reconnect. A local implementation cannot imply native-dialog or audio support from tab image capture alone.

### Ownership protocol

- The server authorizes a takeover request and advances the controller epoch; the worker fences future commands from the old epoch and acknowledges the new owner. Until acknowledgement, the UI says pausing and human input remains disabled.
- A command contains session identity, controller epoch, command identity and expected live session revision. Worker checks these at execution, not only enqueue. An already-running external action may finish; report its known outcome.
- Human input requires a short-lived authorized connection bound to that session and epoch. Expiry/revocation denies further input. No direct public debugger port is opened.
- Resume is explicit. Worker re-observes page and task state before new agent commands; never replay the previous click sequence blindly. Silence, hidden panel and reconnect do not transfer control.
- A stale image/frame cannot authorize a click against a different page. Input includes a frame/page revision; reject stale input and refresh the view.
- Multiple viewers may be supported, but only one input owner exists per session. Read/view permission does not grant control permission.

### Transport and lifecycle

Local worker initiates an outbound authenticated connection. AoA authorizes view/input attachment; relay credentials are session-bound and expiring. Cloud uses the same logical session/control contract even if media transport differs. Stream reconnect and browser lifetime are independent. Expired/destroyed browser state must be shown honestly; creating a replacement is not resuming the old session.

Close/hide only releases client rendering resources. Task stop and idle teardown use explicit lifecycle operations. Downloads flow through canonical asset publication; profile reuse requires current permission. No task/account credentials in saved panel geometry.

## 3. Reconnect and state reconciliation

### Existing binding

Replatform's websocket implementation contains per-company sequence cursors, authorized replay, replay buffering and snapshot fallback. The live-event publisher's durable append remains best-effort. Reuse replay for transport catch-up, but always reconcile canonical state for pending work; an event sequence cannot prove every business change was logged.

### Recovery order

1. Reauthenticate and select the correct company/conversation. Clear old transport subscriptions and stop old-conversation audio.
2. Fetch authorized canvas/draft revisions and canonical pending request outcomes. Keep local pending changes partitioned by account/company/conversation.
3. Attach event replay using the server's supported sequence/cursor mechanism. On expired history, buffer overflow or snapshot-required response, fetch snapshots rather than guessing gaps.
4. Reconcile layout operations by operation identity and revision. Preserve conflicting draft variants. Read-only outcome checks must not execute work.
5. Fetch each browser's actual lifecycle and controller state before reconnecting media/input. Reauthorize references before displaying previews.
6. Restore voice context from the current conversation, explicit selected references and confirmed progress. Do not replay already delivered speech automatically; offer catch-up text.

The UI can display restored panels while live integrations reconnect, but must distinguish cached, refreshing and current data. A failed voice connection leaves typing available. A missed notification cannot suppress the underlying task result or approval item.

## 4. Acceptance scenarios bound to slices

| Scenario | Required assertion | Slices |
|---|---|---|
| Drop chat acknowledgement after acceptance | Outcome lookup returns original turn; retry never creates a second task | E2.2, E3.2 |
| Same identity, changed selected artifact | Conflict; no second execution and no silent original-payload substitution | E2.1–2 |
| Completed tool-only reply | Replay original completion; no CLI rerun | E2.2 |
| Reconnect unfinished turn | Read-only lookup does not acquire/reclaim execution | E2.3 |
| Switch conversation during speech | Old audio stops; late result stays with original conversation | E3.2 |
| Human takeover with queued click | Worker rejects stale-epoch click; already-completed effect reported | E6.2–3 |
| Click based on old page frame | Reject and refresh; no coordinate click on new page | E6.2–3 |
| Worker disconnect/restart | Session identity checked; no false same-session recovery | E6.3–4 |
| Drop durable UI event append | Snapshot/outcome reconciliation still reveals canonical result | E2.3, E7.2 |
| Revoke access during reconnect | No stale preview/input/secret access granted | E1.4, E6.4 |
| Two tabs edit same draft | Both variants recoverable; no silent last-writer overwrite | E1.3 |

## 5. Remaining engineering gates

The [engineering gate investigation](engineering-gates.md) records the Browser Use/CDP versus pipe-driver compatibility gap, cloud stream constraints and the unassigned upstream Commander prerequisites. These are not resolved merely by selecting a provider.

- Bind new outcome lookup and payload fingerprinting to actual persistence and lease semantics; audit both fresh and replay paths.
- Replatform Commander credential/routing cutover remains an upstream dependency for distributed acceptance, not permission to introduce a second execution system.
- Qualify cloud headed capture and local transport on supported worker platforms; verify advertised input and native-UI capabilities. Provider selection alone is insufficient.
- Record schemas, limits, migrations and executable tests in each coding plan before implementation. These contracts resolve intended behavior, not unverified transport compatibility.

No new product question is required by these contracts. Release grouping remains the previously recorded grooming decision. UI design follows technical planning and precedes UI implementation, as requested.

## Verification status

Targeted source inspection verified the existing chat input/replay behavior, browser headless default and websocket recovery hooks. This document adds no runtime implementation; full test/typecheck/build was not run. Completion of the contract draft does not certify provider integration or distributed execution.
