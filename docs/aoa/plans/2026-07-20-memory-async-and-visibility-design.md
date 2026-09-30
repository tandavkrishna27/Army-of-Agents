# Memory experience — async dispatch + visibility design

**Date:** 2026-07-20
**Branch:** `claude/signup-onboarding-ui-animations-0724cb`
**Status:** approved in conversation, pending written review

---

## Problem

Three defects, all reported from live use and confirmed in code.

**1. The founder waits for a full agent run inside one HTTP request.**
`braindumpService.submit` calls `await claimAndDispatch`, which `await`s
`runAoaAgent` — the whole Librarian CLI run. So `POST /braindumps` blocks until
the agent finishes. During onboarding the founder stares at a spinner; the
request can take the better part of a minute.

**2. Nothing tells the founder there is memory to review.**
Pending items surface ONLY in Memory → "Pending Review", a virtual folder in
`MemoryFolderRail` that — adding to the confusion — uses an inbox icon. The real
Inbox hub shows nothing, and no notification is created anywhere. The founder
naturally checks the Inbox (that is what an inbox is for) and finds nothing, so
the work is invisible.

**3. A pending item's destination folder is invisible until approval.**
The Librarian files each item into a real seeded folder (`memory_items.folderPath`),
but the founder cannot see where a pending item will land — only that it exists.
"I can see the file, I don't know which folder" is exactly this.

## Confirmed working — do NOT change

The Librarian's filing mechanism is sound and is out of scope:

- `loadAllowedFolders` queries `memory_folders` for the capture's scope and the
  trigger prompt renders them as *"Folders you may file into: …"*.
- `write_memory` validates `folderPath` against that exact set and rejects
  anything else, then persists it on `memory_items.folderPath`.

So the Librarian already knows each department's standard seeded structure and
can only file into real folders. This design changes WHEN dispatch runs and HOW
the result is surfaced — never how the Librarian decides placement.

---

## Scope

Four pieces, one coherent loop: braindump → keep going → Inbox says "memory to
review" → approve → it lands in its department folder.

- **M1 — async dispatch** (server)
- **M2 — onboarding moves on** (ui)
- **M3 — Inbox signposting** (server + ui)
- **M4 — folder visibility** (ui)

Out of scope: the Librarian's placement logic; repo reading; the three screen
mockups (Map / Agent / Task / Braindump), which follow this as their own track.

---

## M1 — Async dispatch

**Approach: fire-and-forget in-process, guarded by the lease that already exists.**

`submit` creates/claims the capture and schedules `claimAndDispatch` WITHOUT
awaiting it, then returns the row in its non-terminal state (`pending`/`running`).
The dispatch runs on the same process, after the response is sent.

Crash recovery is already built. Item 5 added a stale-`running` reclaim: the
atomic claim predicate re-accepts a `running` row whose `dispatchStartedAt` is
older than `RUNNING_LEASE_MINUTES` (30). So a process that dies mid-run leaves a
row that `retry` (or a re-submit) can reclaim — no new durable-queue machinery.

Why not a durable job queue: AoA already dispatches crew runs fire-and-forget
elsewhere, the LibrarianStep already polls, and the lease already covers the
crash case. A queue would be new infrastructure for a problem two existing
mechanisms already solve. YAGNI.

**The unhandled-rejection trap.** A fire-and-forget promise that rejects with no
`.catch` is an unhandled rejection, and this server has no `uncaughtException`
handler (same class as the A-H11 incident the login work hit). `claimAndDispatch`
is already internally wrapped in try/catch and writes terminal status on every
path, but the scheduling call MUST still attach a `.catch` that logs and never
rethrows, so a bug in the enqueue seam itself cannot take the process down.

**Contract change.** `submit` previously returned the FINAL status
(`proposed`/`failed`). It now returns the non-terminal row. The client already
polls (`GET /braindumps`, LibrarianStep, the future Inbox item), so no caller
depends on the terminal status arriving in the submit response. The retry route
keeps its current shape.

---

## M2 — Onboarding moves on

Decision: **move on, review later in Memory.**

`BraindumpStep` currently blocks Continue on submit and hands off to a
`LibrarianStep` that polls until every capture is terminal. With async dispatch
that wait is unnecessary and unwanted.

- `BraindumpStep.submitAll` fires the submits and calls `onDone` as soon as they
  are ACCEPTED (each returns pending/running), not when the Librarian finishes.
  The founder continues immediately.
- The `LibrarianStep`'s blocking "Organizing…" poll is replaced by a light,
  non-blocking note: *"We're sorting this into your memory in the background —
  review it in Memory whenever you're ready."* It no longer gates the flow.
  Its existing inline-approval affordance is retained but optional; the founder
  can approve there if proposals happen to be ready, or move on.

This keeps the moment of "it's working" without forcing a wait, and it is the
"let them come back" behaviour the founder asked for.

---

## M3 — Inbox signposting

**Approach: a new hub semantic type `memory_review` in the `waiting_on_you`
lane, mirroring the existing `discussion_pending`.**

The hub is a first-class subsystem (`packages/shared/src/hub.ts`,
`server/src/services/hub-items.ts`, `hub-source-producers.ts`) with a fixed set
of semantic types mapped to lanes. `discussion_pending` is the exact precedent:
a discussion's pending extracted items already surface in the `waiting_on_you`
lane. Pending memory is the same shape and belongs beside it.

The codebase explicitly warns: *"Do NOT re-add [a type] without a real
producer."* We have one — a memory item landing as `pending`.

- **Type:** add `memory_review` to `HUB_SEMANTIC_TYPES` and map it to
  `waiting_on_you` in `HUB_SEMANTIC_TO_LANE`.
- **Producer placement — decided:** emit at the shared `writeMemoryAndIndex`
  chokepoint (`server/src/services/memory-write.ts`), NOT scoped to braindump.
  That chokepoint is the single path all agent/MCP/braindump pending writes
  route through (per CLAUDE.md Decision #104), so a founder gets one consistent
  signpost whether the pending item came from a braindump, the crew `write_memory`
  tool, or an MCP `memory.write` — all of which produce founder-gated pending
  memory that today is equally invisible. Guard it to `status === "pending"` and
  `source === "agent"` (or the MCP/braindump equivalents) so a founder's own
  auto-approved write never signposts itself.
- Follow the `buildApprovalHubEmit` pattern in `hub-source-producers.ts` —
  `sourceType: "memory"`, and a stable sourceId (the companyId) so ALL
  pending items collapse to ONE hub row per company rather than spamming, with a summary like
  *"4 memory items ready to review"*. Best-effort and non-fatal: a hub failure
  must never fail the memory write (same try/catch discipline as the embedding
  enqueue that already lives at this chokepoint).
- **Resolution:** the hub item resolves when the scope has no pending memory
  left (all approved or archived). Deep-links to Memory → Pending Review.
- **Grouping (decided with the user):** ONE open row per COMPANY, count-
  updated — "Review N memory items" total, never one per item and never one per
  department. The per-scope breakdown lives in Memory → Pending Review (M4).

This is the heaviest piece and the one most worth reviewing carefully, because
it touches locked hub decisions.

---

## M4 — Folder visibility

Two changes in the Memory UI, both read-only over data that already exists
(`memory_items.folderPath`):

1. **Destination label.** Each pending item in Pending Review shows *"→ engineering/Decisions"*
   (or *"→ Company/Mission & Vision"*). An unfiled item (empty `folderPath`)
   shows *"→ unfiled"*. This answers "where will it go" before approval.
2. **Ghost in the tree.** A pending item also renders — greyed / dashed — inside
   its target folder in the tree, with a "pending" affordance. So the folder
   structure visibly fills in as knowledge arrives, and approving simply
   solidifies the ghost. The tree already renders items by `folderPath`; this
   adds the pending items to that render with a distinct style, rather than
   hiding them until approved.

Approval itself is unchanged (`memoryApi.approve` → the existing approve route);
this only makes the destination and the pending item visible in-place.

---

## Data flow (end to end)

```
BraindumpStep.submitAll
  → POST /braindumps                          (M1: returns pending/running, does NOT wait)
  → onDone fires immediately                  (M2: founder continues)
        ⋮  (background, same process)
  claimAndDispatch → runAoaAgent → Librarian
    → write_memory(folderPath) × N            (unchanged: real seeded folders)
        → status "pending" on each row
        → hub producer emits/refreshes one    (M3: memory_review, waiting_on_you)
             memory_review row for the scope
  ⋮
Founder later: Inbox shows "N memory to review" (M3)
  → clicks → Memory → Pending Review
  → sees each item's "→ folder" + ghosts in tree (M4)
  → approve → item solidifies in its folder; hub row resolves when scope is clear
```

---

## Error handling

- **Fire-and-forget rejection:** `.catch` on the schedule seam logs and swallows;
  `claimAndDispatch`'s internal try/catch still writes terminal status.
- **Server dies mid-run:** the row is left `running`; the `RUNNING_LEASE_MINUTES`
  reclaim makes it retryable. No orphan.
- **Hub emit fails:** caught and logged; the memory write still succeeds. The
  founder can still find items in Memory → Pending Review even if the Inbox
  signpost failed.
- **Librarian run fails:** capture goes `failed` (existing path); the founder
  notification for that is unchanged.
- **No pending items produced (empty braindump):** no hub row emitted; nothing
  to review, correctly.

---

## Testing (all types required)

- **Unit / service (server):** `submit` returns without awaiting the run (assert
  the run is scheduled, not awaited); the schedule seam's rejection is caught and
  does not throw; the hub producer emits one `memory_review` per scope, groups N
  items to one row, resolves when the scope clears, and never fails the memory
  write when the hub errors.
- **Contract (shared):** `memory_review` is in `HUB_SEMANTIC_TYPES` and maps to
  `waiting_on_you`; `laneForSemanticType("memory_review")` returns the lane.
- **Route (server):** `POST /braindumps` responds promptly with a non-terminal
  status; the hub list includes the memory_review row after a pending write.
- **Component (ui):** `BraindumpStep` fires `onDone` on acceptance, not
  completion; `LibrarianStep` shows the background note and does not block;
  Pending Review renders the destination label and the unfiled case; the tree
  renders a pending item ghosted in its folder; the Inbox renders the
  memory_review item and its deep link.
- **Live (memstep :3120, working Librarian):** submit a real braindump, confirm
  the request returns immediately and onboarding advances; confirm the Librarian
  runs in the background and items land `pending` in real folders; confirm the
  Inbox shows the review signpost; approve and confirm the item solidifies in its
  department folder and the hub row clears. This is the acceptance test.

---

## Success criteria

1. `POST /braindumps` returns without waiting for the Librarian; onboarding never
   blocks on an agent run.
2. A pending memory item produces a `waiting_on_you` Inbox signpost that the
   founder can find without opening Memory first.
3. Each pending item's destination folder is visible before approval, in the
   Pending Review list and ghosted in the tree.
4. Crash mid-run leaves a reclaimable row, not an orphan.
5. The Librarian's placement behaviour is unchanged.
