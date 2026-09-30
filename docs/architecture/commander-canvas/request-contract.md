> Current scope authority: [master scope](master-scope.md). Source revisions, tests and unresolved integration dependencies: [code evidence](code-evidence.md). This companion describes planned behavior unless explicitly evidenced.

# Canvas request and result contract — proposal

Scope: logical contract extending existing Commander submission deduplication and replatform execution. This is not a new API implementation or replacement worker protocol. Exact schema names must be reconciled with those packages before coding.

## Request identity

Every user action has a stable client request identity, company, conversation, initiating principal, action type, typed target references and validated arguments. The server authenticates the principal and authorizes resolved targets; client-supplied identity is not authority. Capture selected targets at submission so layout movement cannot retarget an action.

The durable acceptance record maps the request to existing Commander turn, task/routine and execution identifiers where applicable. Reuse that mapping rather than introduce independent deduplication per UI. Repeating the same identity and arguments returns the existing outcome. Reusing an identity with different arguments is a conflict. Retention and replay windows must be defined before implementation.

## Lifecycle

| State | Meaning shown to the user |
|---|---|
| Proposed | A draft exists; nothing has been submitted for execution |
| Awaiting decision | Required permission/approval is missing; execution is blocked |
| Accepted | Server durably accepted the request; not a claim work started |
| Queued | Awaiting execution capacity or another dependency |
| Running | Execution has started |
| Pausing / cancelling | A control request was sent; completion is not yet acknowledged |
| Paused | Executor acknowledged a supported pause; do not advertise for backends without pause |
| Succeeded | Canonical result is available; a preview may still be processing |
| Failed | Execution failed; show known partial effects and recoverable stages |
| Cancelled | Execution termination is acknowledged; prior external effects may remain |

Disconnected/uncertain is an observation state, not evidence that the canonical job stopped. Requests without jobs may move directly from accepted to succeeded. Approval timing must follow the underlying domain policy; these states are not a mandatory linear sequence.

## New instructions while work runs

- Correction: bind to the target request/task and record a new instruction identity. Acknowledgement means received; application must be separately confirmed. If live revision is unsupported, queue a follow-up or propose replacement without silently cancelling the original.
- Separate request: has its own identity and may run concurrently under existing limits.
- Stop speaking: clear/invalidate audio output; do not cancel domain work.
- Cancel work: send the existing governed cancellation request and wait for executor acknowledgement.
- Browser takeover: request pause through the browser adapter, await control grant, then allow input. Resume re-observes current browser state. No automatic rollback of an external action already committed.

## Result envelope

Expose request identity, conversation, monotonically increasing request-state revision, canonical status, typed output references, safe progress summary and any required decision. Preserve initiator and executing actor attribution. Reject stale revisions in the view. Attach late results to their original conversation; attention may surface them elsewhere without rewriting ownership.

The request-state revision is separate from the transport cursor. A reconnect obtains authorized canonical state before deciding whether retry is necessary. Replaying an event never executes the action again.

## Failure and retry rules

Lost acceptance acknowledgement: query by request identity; retry with that same identity only through the deduplicating endpoint. Do not generate a new identity just because the network timed out. A retry must not bypass changed permissions.

External side-effect timeout: mark outcome uncertain and reconcile with the provider when possible. If no reliable reconciliation or idempotency exists, require resolution before repeating the effect. Internal deduplication cannot promise exactly-once external actions.

Artifact preview failure: retain the successful canonical file and retry preview separately. Partial multi-step results remain visible; a succeeded substep does not imply the whole request succeeded.

## Acceptance cases

1. Lost acknowledgement and repeated submission produce one canonical request and no duplicate execution.
2. Same request identity with altered arguments is rejected.
3. Duplicate/out-of-order events do not regress state or repeat actions.
4. User switches conversation while work completes; result remains correctly attributed.
5. User interrupts audio while a job runs; job continues and old audio cannot restart.
6. Correction races with task completion; show whether applied or created as follow-up.
7. Browser pause and an in-flight action race; grant control only when safe and report completed effects.
8. Access is revoked before retry; deny the action despite cached references or credentials.
9. Provider outcome is unknown; no blind retry of a potentially completed external write.

See the companion state contract for drafts and restoration, and code-evidence.md for current-source tests. This proposed request lifecycle has not yet been implemented or integration-tested.
