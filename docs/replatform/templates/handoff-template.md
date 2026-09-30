# Handoff — <Merge train or epic gate>

**Date (UTC):** `<YYYY-MM-DD>`
**Epic:** `<E#-name>`
**Record path:** `<docs/replatform/epics/.../handoffs/<filename>.md>`
**Gate slug:** `<merge-train-N, e6-d1-foundation, e10-realtime-foundation, or epic-completion>`
**Reviewed revision:** `<exact 40-character git SHA>`
**Attempt:** `<positive integer>`
**Supersedes:** `<prior immutable handoff path or none>`
**Decision:** `pass`, `fail`, or `blocked_external`
**Gate owner role:** `Integration Gate Owner`
**Gate owner identity:** `<named human or agent identity>`

> This file is immutable from its first commit. A correction, rerun, changed decision, or changed revision creates a higher attempt and links this path through `Supersedes`.

## Included ticket results

| Ticket | Ticket-result path | Ticket-result Git blob SHA | Reviewed implementation SHA | Latest review disposition |
|---|---|---|---|---|
| `<ID>` | `<path>` | `<40-character blob SHA>` | `<40-character commit SHA>` | `approved` or `changes_requested` |

## QA evidence

| QA record | QA revision | Lane | Attempt | Result |
|---|---|---|---:|---|
| `<immutable path>` | `<40-character commit SHA>` | `<lane>` | `<attempt>` | `pass`, `fail`, or `blocked_external` |

## Threshold decision

| Requirement ID | Class | Required value/condition | Observed value | Evidence record | Decision |
|---|---|---|---|---|---|
| `<stable ID>` | `REQUIRED`, `HARD`, `INITIAL`, or `OBSERVED` | `<condition or threshold>` | `<actual>` | `<immutable QA path>` | `pass`, `fail`, or `recorded` |

For D6, include every frozen matrix row and SLI; mandatory coding, browser, and service closure; and enabled/disabled desktop and mobility closure. A handoff cannot pass with any required condition/command failure or HARD/INITIAL failure. `blocked_external` is available only before an external lane/schedule starts; scheduled external failures after start count toward `fail`.

## Decisions and findings

List decisions locked during the train and every unresolved finding with severity.

## Compatibility and rollout

Record protocol/schema compatibility, flags, migration state, rollback/disable path, and active-work handling.

## Next unblocked work

List exact epic/ticket IDs unblocked by this gate.
