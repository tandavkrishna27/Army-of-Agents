# Commander Cockpit V2 Plan

## Decision

Commander Cockpit remains the daily triage and command surface. It does not replace Inbox, Tasks, Discussions, Approvals, Memory, or the Viewer. Cards stay as the display unit, but the section taxonomy moves from ambiguous single-axis labels to operating modes:

- Triage: Inbox, Review, Approvals.
- My Work: My tasks, Today, Sticky notes.
- Conversations: Discussions.
- Watch: Running now, Goals at risk, Budget pulse, Done today, Proactive findings, Teammates' activity.
- Memory & Context: Pinned, Memory.

States such as "needs me", "blocked", "due today", "watching", and "owned by me" belong as item badges, filters, or sort signals inside cards rather than as top-level card buckets.

## Interaction Scope

V2 makes Cockpit items feel operable, not just visible:

- Repeatedly selecting the same entity dedupes the chip instead of creating duplicate chips or duplicate prompt text.
- Clicking a chip opens the real referenced entity, using the right-side Viewer for task/artifact refs and route fallback for other entity types.
- Referenceable Cockpit rows can be dragged into the Commander composer to create the same typed chip as click-to-add.
- The chat API remains unchanged in this slice; refs still serialize into the outgoing `Referenced context` block. Durable server-side `inputRefs` is a later backend slice.

## Verification Plan

Focused tests cover shared ref helper behavior, chip dedupe/open helpers, composer drop parsing, section grouping, card placement, and reference drag payloads. Browser smoke checks the live Commander page, the new config-menu section taxonomy, and draggable rows.
