# Universe — consolidated technical planning checkpoint

September 11, 2026. This consolidates technical grooming and the subsequent core UI decision review. See [epics and slices](epics-and-slices.md), [grooming review](grooming-review.md), [integration contracts](integration-contracts.md) and [engineering findings](engineering-gates.md). There are now 31 planning slices, including UI design, Commander presentation, motion/viewport interaction, task conversation presentation and browser compatibility qualification. No implementation tickets, branches or application changes were created.

## Prerequisite register

| Reference | Owner and status | Affected acceptance | Required closure evidence |
|---|---|---|---|
| RP-CMD | Replatform workstream; individual owner remains unassigned in reviewed E10 findings | E2.2 distributed execution, E2.3 distributed recovery, and E3/E7 operations using that execution route | Admitted per-user credentials, actual routing/ownership transfer and interactive result delivery, with production callers and integration tests. Existing admitted Commander operation does not establish this. |
| E6.0 | Universe browser integration work; qualification not executed | E6.1–4 automation, live viewing, human control and lifecycle | Safe Browser Use attachment and local/cloud stream paths; acknowledged controller fencing, re-observation on resume, authentication and capability tests. Do not bypass pipe-driver guards. |
| E1.0 | Universe UI design work, reviewed with user | All affected UI implementation | Screen/state inventory and connected mock with keyboard, narrow-screen and recovery states; record design decisions. |

RP-CMD is a document-local dependency label, not a newly created upstream ticket. Its evidence is the reviewed E10 Commander finding. Recheck upstream status and actual base when implementation starts; do not assume this record tracks future changes automatically.

## Review outcome

- Technical scope and subsystem contracts are drafted, with testable outcomes and explicitly unresolved implementation gates.
- Corrected unnecessary sequencing: manual uploads do not require Commander execution; draft storage is independent of geometry; visual attention does not require speech. Settings accompany their consuming features.
- Existing typed Commander authority is the integration boundary for voice. Read-only outcome lookup is separate from POST replay/reclaim.
- Local and cloud browser experience remains intended scope, with capability gaps recorded instead of assumed parity.
- Numerical defaults in grooming are proposed qualification inputs, not benchmark results. Final coding plans must bind schema, limits, migration and executable tests at the accepted revision.
- All future extensions stay preserved. Full Accounts and Access and communication are separately planned workstreams; this checkpoint does not start them.

## Earlier internal delivery grouping

The subsequent [V1/V2 release recommendation](release-plans/README.md) is now the allocation draft for review. All 31 slices have [individual plans](slice-plans/README.md). The table below remains an internal sequencing outline; it does not override the agreed rule to complete V1 before V2 implementation.

| Milestone | Included outcome | Release meaning |
|---|---|---|
| Design | Complete technical planning checkpoint, then UI inventory and connected mock | Review before UI implementation. |
| Core | Canvas, drafts, task/context flow, manual artifacts, reviewed blocks, settings and visual attention | Internal integrated milestone; not automatically a public launch. |
| Realtime/browser | OpenAI voice, cloud and local browser viewing/control, lifecycle and routine operations | Candidate usable release only after integration gates pass. |
| Breadth | Gemini and ElevenLabs, further automation, isolated tools and generation coverage | Retained scope; may progress concurrently where dependencies allow. |
| Later speech | Separate recognition/synthesis and local speech | Later scope already agreed. |

These are implementation groupings, not approved V1/V2 cuts. Recommendation: use staged internal milestones and decide public packaging after the UI review and compatibility evidence. This avoids dropping requested providers or local/cloud support merely to label an early milestone complete. No immediate user answer is required for this checkpoint.

## Branch and verification plan

At implementation time, verify the accepted base, then create an isolated Universe integration branch with small reviewable slice branches. Prefer upstream fixes for shared replatform contracts. Integrate upstream changes regularly and run affected tests; never count fixtures as completed integrations. Reconcile actual ancestry after replatform lands, accounting for squash versus preserved history.

Each release gate includes company isolation, governed writes, duplicate prevention, lost acknowledgements, state conflicts, revocation, browser takeover, failed previews, provider expiry and sustained-session behavior. Run repository typecheck, tests and build on combined implementation. Rollback disables new surfaces while preserving canonical records and authorized task lifecycle.

## Next step

The [readiness review](readiness-review.md), [nine epic preparation plans](implementation-plans/README.md), [31 individual slice plans](slice-plans/README.md) and [V1/V2 draft](release-plans/README.md) now cover release and task preparation. Next discussion is the proposed release cut, then implementation methodology; exact BASE/provider/worker coding bindings and remaining UI states are still required before production execution.

The core mock review is consolidated in [UI decisions](ui-review-decisions.md), with [motion acceptance](motion-and-interaction.md) and [epic traceability](epics-and-slices.md#ui-decision-traceability). Continue from its explicit gaps: embedded-host task controls, omitted settings/previews, complete voice/recovery states and responsive/accessibility review. E1.0 is not fully closed by the mock. Detailed coding plans remain required before implementation; the two engineering dependencies stay visible and cannot be certified complete through design review. No further round of library-choice questions is needed now.

Documentation-only verification: check links, unique slice IDs and presence of the prerequisite references. Runtime tests/build are not run because this checkpoint changes no runtime code.
