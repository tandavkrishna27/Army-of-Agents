# B08 — manual task work and catch-up results

**Implemented:** 2026-09-20
**Packages:** E2.3/1, E2.4/1, E2.3/2

## Delivered

- Preserved the existing canonical `TaskConversationPanel` and `WorkspaceTimeline` reply path. Manual replies remain comments on the selected task and do not invoke Commander or create execution work.
- Added an owner-scoped, no-store reconciliation snapshot at
  `GET /api/companies/:companyId/universe/conversations/:conversationId/snapshot`.
- Snapshot composition authorizes the conversation owner first, anchors the current durable event sequence, and then reads bounded layout references, canonical task state, task-output projections and the existing attention projection.
- Deleted or revoked task references are returned as unavailable without their former title, body, output metadata or aggregate counts.
- Added a single Universe consumer to the shared live-update connection. Durable duplicates are ignored, sequence-free local hints never advance the cursor, invalidations coalesce for 200 ms, visible workspaces receive a 30-second safety refresh, and reconnect/visibility/network return triggers canonical refresh.
- Offline and stale states remain visible while the last confirmed workspace stays on screen. Producer degradation is explicit through `partialReasons`; unavailable attention is not represented as an authoritative empty result.

## Boundaries retained

- No second socket or event bus.
- No POST, job dispatch, Commander turn or retry-of-work path in reconciliation.
- Snapshot contains presentation projections only; messages, file contents, credentials and secrets remain in their existing authorized APIs.
- The snapshot reads at most 100 layout references per request.

## Verification

- Focused reconciliation, live-update and Universe-page tests pass.
- Recursive workspace typecheck passes.
- Full repository test and build results are recorded in the wave commit handoff.
