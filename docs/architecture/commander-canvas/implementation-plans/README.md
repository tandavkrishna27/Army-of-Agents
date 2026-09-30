# Universe — per-epic implementation preparation plans

Follow-on detail: [individual slice plans](../slice-plans/README.md) now expand all 31 work packages into 69 reviewable increments. [Separate V1/V2 plans](../release-plans/README.md) record accepted release allocation. [Detailed coding addenda](../coding-plans/README.md) now cover all 69 increments; [shared bindings](../implementation-bindings.md) and [self-review](../planning-self-review.md) accompany them. These supersede the earlier next-step wording below; they do not certify executable coding readiness.

September 11, 2026. Nine plans cover all 31 planning slices. Read the [readiness review](../readiness-review.md) first for source evidence, upstream gates, proposed order and release questions.

These are concrete work-package plans with file ownership, interface responsibilities, dependencies and acceptance scenarios. They are **not all executable coding plans**: BASE schema/export bindings, actual provider contracts and worker qualification remain preconditions. No task is marked complete by drafting its plan. User review and implementation methodology follow this pass.

| Plan | Task/slice coverage |
|---|---|
| [Baseline and contract binding](e0-baseline.md) | E0.1 |
| [Canvas, persistence and presentation](e1-canvas.md) | E1.0, E1.1, E1.2, E1.3, E1.4, E1.5, E1.6 |
| [Commander context, outcomes and task chat](e2-commander.md) | E2.1, E2.2, E2.3, E2.4 |
| [Voice capability qualification and sessions](e3-voice.md) | E3.1, E3.2, E3.3, E3.4 |
| [Artifacts, formats and generation](e4-artifacts.md) | E4.1, E4.2, E4.3 |
| [Reviewed blocks and isolated custom tools](e5-tools.md) | E5.1, E5.2 |
| [Browser qualification and local/cloud integration](e6-browser.md) | E6.0, E6.1, E6.2, E6.3, E6.4 |
| [Routines, catch-up and shared attention](e7-routines-attention.md) | E7.1, E7.2, E7.3 |
| [Settings, rollout and release acceptance](e8-settings-release.md) | E8.1, E8.2 |

## Starting work and waiting

- Independent UI, state/drafts, existing task conversations, manual uploads, reviewed blocks and visual attention need the accepted BASE/DESIGN gates, not distributed Commander cutover.
- Distributed request/result acceptance waits for CMD; actual browser paths wait for BROWSER and appropriate CLOUD/APPROVAL evidence; saved profile reuse also waits for PROFILE.
- Voice qualification closes VOICE before provider implementation. Isolated executable tools close HOST before enabling custom code. Preserve separate local/cloud/provider capability results.
- E8.1 settings accompanies each consuming slice. E8.2 remains the combined release gate. Multi-screen remains deferred after the desktop app and outside this 31-slice set.

## Required coding-plan closure

Before any task becomes executable, its owner records exact function signatures/schema/API/event bindings at BASE, actual failing test code using existing test fixtures, bounded implementation steps, migration/rollback and runnable verification. For gated tasks this occurs after qualification; do not fill it with invented provider/worker APIs. The preparation plan's observable scenarios become those tests. No code or migrations are generated in this documentation pass.

The current recommendation is staged internal delivery within the proposed V1, followed by V2 only after V1 closure. Release allocation is accepted; cloud commercial ownership remains a separate decision before affected enablement.
