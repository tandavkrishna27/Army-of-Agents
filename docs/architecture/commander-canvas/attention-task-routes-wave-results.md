# B10 — attention and real task routes results

**Implemented:** 2026-09-20
**Packages:** E7.3/2, E2.4/2, E8.1/2.b, E1.0/2

## Delivered

- Added a right-side attention rail for Needs you, Ready and Coming up. Empty groups are omitted, visible items are bounded, and the full list remains available without crowding the canvas.
- Added a movable bottom-right attention question for work questions, runtime decisions, approvals and tasks. It opens the canonical work surface instead of creating an attention-only copy.
- Added one canonical task-reference adapter for Needs you, Work, artifact-source links, Open panels and direct task URLs. Repeated references restore and focus the existing panel identity rather than opening duplicates.
- Added direct `task` URL handling on the dedicated Universe route with company authorization preserved before any task is shown.
- Added an explicit, revisioned Finish-review checkpoint. Closing, hiding or moving an attention surface never acknowledges work. The server signs the projected snapshot, compare-and-swap checks its revision and owner, and records the explicit acknowledgement as a company-scoped activity.
- Added one notification-delivery evaluator that keeps in-product attention, toast, sound and spoken delivery distinct. Personal settings may reduce shared policy but cannot expand it; sound and spoken delivery default off.
- Added personal sound, spoken-attention and attention-presentation controls to the existing notification and Universe settings surfaces.

## Boundaries retained

- Attention is a projection over canonical work records. It does not own task, approval, question or runtime-decision state.
- A task panel has one stable identity regardless of entry route. Opening a reference never clones the underlying task.
- Finish review acknowledges only the signed snapshot the user actually reviewed. Newer work remains pending.
- B10 does not claim unsolicited notification delivery, proactive attention generation or live spoken delivery. Those remain in their later execution batches.
- Artifact-source links use the canonical adapter established here; full artifact publication and source-surface behavior remain in their scheduled batches.

## Verification

- Focused unit and component checks: 24 tests passed across attention rendering, canonical task references, notification delivery and client checkpoint behavior.
- Actual-host Playwright journey passed against the dedicated Universe route. It covered real company/task creation, absence of the primary app sidebar, opening from Work, drag, keyboard resize, pin, maximize/restore, minimize/restore through Open panels, close, direct-reference reopen and explicit checkpoint revision advancement.
- Recursive workspace typecheck passed.
- Production build passed with the repository's existing Vite static/dynamic-import and large-chunk warnings.
- Full repository suite: 18,151 passed, 98 skipped and 176 failed. The failed-test count is unchanged from B08 and B09 and remains attributable to the known Windows Node 24/Drizzle ESM collection cycle plus unfinished worker-placement/session suites.
