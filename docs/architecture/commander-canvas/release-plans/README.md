# Universe — agreed release allocation

**Execution supplement (September 13):** [The complete sequence](../execution-sequence.md) orders all 69 increments, including dependency-driven splits and separate V1/V2 closure. [The increment register](../execution-increment-map.md) is the exhaustive allocation; scheduling slots do not change the accepted release scope.

September 11, 2026. **Release grouping accepted in the subsequent voice review.** After reviewing V1 as the complete everyday experience with all three realtime voice providers and local/cloud browsers, and later speech modes in V2, TK agreed to the grouping and asked to discuss the next topic. This accepts scope allocation, not production implementation, unresolved technical bindings or release readiness. Finish and verify all V1 before V2 implementation.

## Agreed scope

**V1: 30 of the existing 31 slices**, retaining the complete reviewed core experience, local and cloud browsers, saved-profile reuse subject to its prerequisites, OpenAI/Gemini/ElevenLabs realtime voice, artifacts, reviewed and isolated tools, routines, attention and settings.

**V2: E3.4**, separate speech recognition/synthesis pipelines and local speech. These were already described as later approaches. Multi-screen stays a candidate to reconsider after the desktop app, not a silently added committed V2 slice.

This allocation preserves requested breadth: no provider or local-browser capability is removed merely because it has an unresolved dependency. The tradeoff is a larger V1 whose release waits for every included capability. The agreed methodology uses the same Universe branch from verified replatform, with reviewed slice integration after explicit coding approval. See [detailed coding plans](../coding-plans/README.md).

| Epic | V1 slices | V2 slices |
|---|---|---|
| E0 — Baseline and contract binding | E0.1 | — |
| E1 — Canvas, persistence and presentation | E1.0, E1.1, E1.2, E1.3, E1.4, E1.5, E1.6 | — |
| E2 — Commander context, outcomes and task chat | E2.1, E2.2, E2.3, E2.4 | — |
| E3 — Voice capability qualification and sessions | E3.1, E3.2, E3.3 | E3.4 |
| E4 — Artifacts, formats and generation | E4.1, E4.2, E4.3 | — |
| E5 — Reviewed blocks and isolated custom tools | E5.1, E5.2 | — |
| E6 — Browser qualification and local/cloud integration | E6.0, E6.1, E6.2, E6.3, E6.4 | — |
| E7 — Routines, catch-up and shared attention | E7.1, E7.2, E7.3 | — |
| E8 — Settings, rollout and release acceptance | E8.1, E8.2 | — |

- [V1 scope, milestones and release gate](v1.md)
- [V2 scope and deferred feature boundary](v2.md)
- [All 31 individual slice plans](../slice-plans/README.md)
- [Coding readiness and shared sequencing](../slice-plans/coding-readiness.md)

## Execution rule agreed with the user

Complete and verify every agreed V1 slice before starting any V2 implementation. Record V2 plans now and preserve compatible interfaces, but do not build V2 features to fill a V1 dependency wait. Advance other unblocked V1 work. A disabled, simulated or blocked required capability does not count as a completed V1 slice. Any later release-scope amendment must be explicitly reviewed and recorded; it is never an automatic fallback.

A slice has exactly one proposed version. An epic may span versions. Shared infrastructure from V1 is reused by V2; follow-on work belongs to the consuming V2 slice rather than duplicating V1 assignments. Internal milestones are progress checkpoints, not alternate public versions.

## Remaining product review

The September 12 correction makes branch choice and implementation methodology proposals for review, not accepted execution authority. [First-batch preparation](../first-batch-readiness.md) records historical source checks, UI-state specification and an unapproved panel-controller coding draft. The [planning reset](../planning-reset.md) governs current status and the untouched premature implementation. Exact runtime evidence and later commercial decisions remain open.

The next review covers the planning base and branching proposal, followed by detailed increment plans and independent review before explicit implementation approval. Cloud commercial ownership/pricing remains separately unresolved and cannot be inferred from the technical provider choice. Multi-screen timing and design remain deferred. This document authorizes no branch creation, provider spend, deployment or production release.

## Planning verification

Checked 42 new or updated documents for local links, heading anchors and whitespace: no errors. All 31 epic-register slice IDs have exactly one individual plan and one proposed release assignment (30 V1, one V2), containing 69 unchecked work increments. Shared settings/context sequencing is recorded in the coding-readiness contract; V1 has no prerequisite on the later E3.4 feature. Multi-screen remains outside the slice count.

This pass changed documentation only. No runtime tests, typecheck or build were run, and no proposed Universe test files were created. Earlier existing-component test results in the readiness review do not verify these future implementations. Exact code/test/provider bindings remain required before gated runtime work. The subsequent user acceptance above closes release allocation review only; older documents describing the allocation as proposed are superseded by this acceptance record.
