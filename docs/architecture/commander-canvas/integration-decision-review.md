# Universe integration decision review

For the subsequent fetched baseline and readiness disposition, see [readiness review](readiness-review.md). This document preserves the earlier inspection record; do not treat its fetched revision as current after the later pass.

September 11, 2026. This is a pre-grooming review and provisional dependency map, not an approved implementation schedule.

## Evidence baseline

- Working checkout: `06320643a72d8ef31904322a862abf09e3dc2168`.
- Fetched main: `e097d2f9332a2715bdbaf2058a4b751481107713`.
- Fetched replatform: `72479410be1e7a3ff4c55eaf5942c27f87144490`.
- Git merge-base equals fetched main. This establishes ancestry, not runtime readiness. No implementation branch, checkout, merge or rebase was performed.
- Compared the earlier reviewed replatform revision with this revision for Commander CLI routing, live-events and browser-runtime; those paths have no intervening diff. Earlier evidence still needs its stated limitations retained.
- Current replatform E10 findings still mark Commander cutover as an open dependency involving credentials and routing. CLI code includes shadow observation; this is not proof of completed distributed Commander cutover.
- Current live-events code explicitly describes durable append as best-effort. Critical routine execution must use durable intent and reconciliation rather than assuming every UI event is delivered.

## Provisional work boundaries

| Area | Reuse / change / build | Dependency and acceptance boundary |
|---|---|---|
| Canvas | Build React Flow panels around existing components; add versioned layout and draft persistence | Can proceed before Commander cutover. Verify typing, scrolling, restore, concurrent edits and preserved drafts. |
| Commander context | Extend conversation, summary and memory foundation | Add exact selected item/version and correction handling; prove provider reconnect and long-session retrieval. |
| Voice | Build direct OpenAI adapter first; include Gemini and ElevenLabs in planned scope | Use one governed Commander request path. Test interruption, acknowledgement, late results, reconnect and duplicate prevention. |
| Browser | Integrate Browser Use with existing worker isolation | Live view/input is separate work. Cloud headed streaming and local browser capture need implementation evidence; keep debugger launch guards intact. |
| Artifacts and tools | Reuse supported viewers; add processing adapters and isolated tool bridge | Preserve originals; preview failure cannot destroy an artifact. Test scoped actions and version references. |
| Proactivity and notifications | Extend scheduler and shared attention/delivery foundation | Durable run identity, recovery, notification migration and sound/voice channels; no critical dependency on UI event receipt. |
| Settings | Extend existing scoped configuration surfaces | Providers manages connections; Budget & caps manages spend; Universe manages preferences. Verify authorization and precedence. |

## Integration strategy recommendation

Create a Universe integration branch from a verified replatform revision when implementation begins, with independently reviewable slice branches merging into it. Record the exact base. Bring replatform changes into the shared integration branch regularly and rerun affected contract and integration tests; avoid rewriting history used by collaborators.

Missing foundations block their dependent slices, not all Universe work. Fixtures permit development but do not satisfy end-to-end completion. Prefer upstream ownership of replatform contract changes instead of duplicating them in Universe. When replatform lands on main, inspect the actual merge strategy and ancestry before choosing reconciliation; a squash merge may require a different approach from a preserved-history merge. Verify the combined code before proposing the Universe merge.

## Decisions versus engineering work

No immediate new product answer is required. React Flow, the voice ordering, Browser Use, retention defaults and settings ownership are already directed. Do not ask the user to pick transport internals or repeat those choices.

Still to resolve through engineering evidence: Commander cutover compatibility, local/cloud live-view transport parity, durable intent for event-driven work, measurable performance limits and the final integration base at implementation time. Bring back a product question only if those findings require a visible capability or scope tradeoff.

AoA-managed versus customer-connected cloud rollout and pricing remain deliberately open. Resolve before commercial release allocation, not as a prerequisite for drafting the technical dependencies.

## Next grooming input

For each proposed slice, attach source evidence, upstream dependency, contract changes, acceptance scenarios, failure/recovery checks and rollout constraints. Then agree epics, versions and implementation methodology. This document does not assign V1/V2 or claim that the whole system is implemented.

## Verification

This pass inspected Git ancestry and targeted source/doc evidence and reconciled stale voice selection wording. No runtime code changed. The full typecheck, test and build suite was not run for this documentation pass; prior test results are not new verification of Universe integration.
