# Commander Viewer Input References Plan

## Goal

Commander should keep users in the Commander cockpit when they inspect referenced work. Cockpit rows and composer chips should open real entity viewers in the existing Commander Viewer instead of navigating the main app away.

## Investigation Findings

- Commander Viewer currently supports artifact, reply, browser, and task tabs.
- Inbox Hub already has the embedded viewer pattern we need:
  - `ThreadDetail` supports `discussionId`, `companyId`, and `embedded`.
  - `ApprovalDetailCore` supports `approvalId`, `embedded`, and `onOpenTab`.
  - `TaskDetail` is already used by Commander Viewer.
  - Hub generic viewer bodies provide the pattern for preview-only hub rows.
- Hub item API exposes `hubItemsApi.getOne(companyId, itemId)`, which lets an Inbox ref render a real hub-item preview without inventing new server routes.

## Implementation Scope

1. Extend Commander Viewer state with input-reference entity tabs:
   - `discussion`
   - `approval`
   - `inbox`
   - `note`
2. Add `openInputRef(ref)` to `useCommanderViewer`.
3. Update chip click behavior to call `viewer.openInputRef(ref)` for all supported refs, without route fallback by default.
4. Update Cockpit row clicks for Inbox, Discussions, and Approvals to open the same Viewer tabs when Commander supplies the callback.
5. Add drag affordance styling to referenceable Cockpit rows:
   - `cursor-grab`
   - `active:cursor-grabbing`
   - subtle hover background/ring/translate treatment
6. Keep drag/drop-to-composer behavior unchanged.

## Viewer Body Mapping

- `task`: existing `TaskDetail`.
- `artifact`: existing artifact viewer.
- `discussion`: embedded `ThreadDetail`.
- `approval`: embedded `ApprovalDetailCore`.
- `inbox`: fetch `hubItemsApi.getOne` and render a compact `CommanderInboxRefBody`; later this can reuse more Hub action chrome.
- `note`: render a compact `CommanderNoteRefBody` from the ref label/detail.

## Test Matrix

Unit/model:
- `openInputRefTab` opens discussion, approval, inbox, and note tabs.
- Reopening the same ref focuses the existing tab instead of duplicating.
- Task and artifact refs continue to map to existing tab kinds.

Component/integration:
- `TabBodySwitch` renders embedded `ThreadDetail` for discussion tabs.
- `TabBodySwitch` renders embedded `ApprovalDetailCore` for approval tabs.
- `TabBodySwitch` fetches and renders an Inbox ref preview.
- `TabBodySwitch` renders a note preview from ref details.
- `openCommanderInputRef` delegates to `openInputRef` and no longer navigates for supported refs.
- Cockpit row click callbacks for Inbox/Discussions/Approvals call `onOpenReference` when present.
- Referenceable rows expose drag affordance classes.

Browser smoke:
- `/AOA/commander` loads.
- Config menu still shows the five Cockpit sections.
- Hovering a draggable row shows grab/hover affordance.
- Clicking a Cockpit discussion/inbox/approval row opens Commander Viewer instead of changing the page URL.
- Clicking a chip opens Commander Viewer instead of changing the page URL.
