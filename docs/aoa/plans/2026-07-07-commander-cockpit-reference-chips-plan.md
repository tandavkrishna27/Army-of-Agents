# Commander Cockpit Reference Chips V1

## Product Decision

Commander Cockpit stays as the daily triage surface. It does not replace Inbox, Tasks, Discussions, Approvals, or the Viewer. Cockpit cards continue to show compact work slices grouped by product intent:

- Needs me: inbox, review, approvals, proactive findings
- My work: tasks, today, sticky notes
- Active with me: discussions
- Company pulse: running work, goals, budget, completed work, teammate activity
- Context: pinned items, memory, conversation refs

The next interaction layer is identity-preserving references. When a user brings a Cockpit item into chat, Commander should see a structured pointer, not just copied prose.

## V1 Scope

1. Add a small typed `CommanderInputRef` model for user-selected chat references.
2. Render selected refs as removable chips above the Commander composer.
3. Let Cockpit cards add refs to the composer while preserving the existing "ask Commander" flow.
4. Serialize selected refs into the submitted user message as a short `Referenced context` block so the existing chat API, persistence, and agent loop remain stable.
5. Support click-to-add first. Keep drag/drop as the next UX increment unless it fits cleanly without changing the composer architecture.

## V1 Entity Coverage

- Task refs from review, my tasks, today due tasks, and running items with a task id.
- Inbox refs from the Inbox card.
- Discussion refs from the Discussions card.
- Approval refs from the Approvals card.
- Note refs from Sticky notes.

Artifacts already have output refs in the Viewer path and remain separate until the input-ref model is extended.

## Non-Goals

- No dashboard builder.
- No custom card layout engine.
- No server/database contract change for chat message refs in this slice.
- No permission expansion; refs are pointers for context, not capability grants.

## Implementation Steps

1. Create shared input-ref types and formatting helpers.
2. Add selected-ref state and chip rendering in `AgentPanelContent`.
3. Add `onReference` cockpit callback and wire card ask buttons to add the item ref plus a suggested prompt.
4. Add focused unit tests for serialization, chip removal, and cockpit-to-composer behavior.
5. Run UI/shared typechecks and a browser smoke check on `/AOA/commander`.
