# Commander Canvas design record

**Latest readiness (September 13):** [Replatform integration and base adoption](base-integration-results.md) are complete. The exact repaired candidate passed typecheck, 24,295 tests (76 unchanged skips), build and the required PR checks. Its verified landing is adopted into the existing Universe branch. No Universe feature implementation has begun; TK's requested discussion and explicit batch approval are next.

**Historical pre-adoption preparation (September 13):** [Exact base proposal and first-batch visual checks](pre-implementation-discussion.md) are complete for TK's requested pre-implementation conversation. The merge simulation is conflict-free; the combined source is not yet runtime-qualified or adopted. Eight first-batch states have 32 rendered checks. No Universe coding starts before that conversation and explicit batch approval.

**Historical local qualification (September 13):** The [F5 repair and full baseline verification](f5-repair-results.md) passed at local source `fcab5a112`: repository typecheck, all four test shards (24,276 passed, 76 unchanged ordinary skips) and build. An interrupted shard-3 attempt is preserved separately and excluded from totals. No source drift or new skipped cases. Correction publication/landing, exact Universe base adoption and feature implementation remain unapproved. The remote replatform delta requires its own integration checks; no general epic replanning. Older dated records below are historical.

**Current status — production implementation paused:** TK clarified that implementation was not authorized. The [planning reset and review checkpoint](planning-reset.md) controls current work. The isolated draft is excluded from accepted delivery; TK accepted preserving it untouched/excluded for now; later deletion or reuse needs its own decision. Detailed plans, independent review and explicit user approval must precede coding.

**Historical execution status:** The approved [TypeScript-aware export check and gated shard 4](fixture-loader-check-results.md) passed: 6,031 tests passed / 3 skipped; all seven previously uncollected suites ran and both backup tests passed. Setup took 6.233 seconds. The runtime is stopped. The preparation/loader issue is closed for this environment; F5 remains non-reproduced rather than repaired, and F4 still needs its narrow fixture correction. Next is the exact F4 repair/regression plan, then separately approved full qualification. No Universe implementation or base adoption.

**Reviewed plan (before the approved execution above):** The [bounded F1/F2/F3 plan](baseline-correction-plan.md) now specifies the exact proposed replatform correction base, three source/test files, offline Git checkout, regression cases and final qualification. [Claude’s review is received and author-verified](baseline-correction-review-report.md), with ownership and child-process event wording clarified. That approval was subsequently granted for the batch reported above. Universe source stays at its existing replatform pin. [Focused Claude handoff](claude-review-handoff.md#focused-review-of-the-baseline-correction-plan).

**Latest preparation evidence:** The approved [offline retry](baseline-retry-results.md) completed: both revisions pass typecheck, and all eight test shards ran. Each revision has the same three failed tests, 76 skips and one unhandled opener error; build remains unrun. [Failure attribution](baseline-retry-findings.md) separates DNS/Git environment requirements from an inherited route error-handling gap. No source-base adoption is recommended yet. [DESIGN coverage](design-state-coverage.md) remains a separate inventory of accepted intent and missing visual/actual-host evidence. Production implementation is paused.

Current first-batch scope is in the [bounded preparation proposal](bounded-engineering-preparation.md); [earlier baseline and readiness](first-batch-readiness.md) is historical. Design inputs remain in [remaining UI state designs](ui-state-review.md) and the [canvas/controller coding plan](coding-plans/e1-1-canvas-controller.md). Written states and reference-controller checks are complete; visual review and real React Flow/host qualification remain distinct gates.

**Latest decision:** The [V1/V2 grouping](release-plans/README.md) remains accepted. The same Universe branch codex/universe-interface now exists from the verified replatform revision, carrying planning documents; implementation approval remains open. Earlier statements that first-slice execution was accepted were incorrect and are superseded by the user's explicit planning-only correction.

Latest release planning: [V1/V2 allocation recommendation](release-plans/README.md) and [31 individual slice plans](slice-plans/README.md). The accepted allocation retains 30 slices in V1 and places E3.4 later speech modes in V2. The agreed execution rule is to finish and verify all V1 before starting V2 implementation. Individual plans define delivery increments; exact coding bindings remain gated as described in [coding readiness](slice-plans/coding-readiness.md).

**Latest planning packet:** [31 detailed coding plans](coding-plans/README.md), [source/interface bindings](implementation-bindings.md), [whole-packet self-review](planning-self-review.md), [publication and Claude handoff](claude-review-handoff.md). All 69 increments have concrete steps or conditional qualification protocols. [Claude's independent review](independent-review-report.md) is now received. The [author reconciliation](independent-review-response.md) addresses it; the [focused re-review](focused-review-report.md) confirms the two residual contract corrections. Runtime qualification remains open. The [final planning decision packet](final-planning-decisions.md) presents remaining choices and recommendations before any implementation approval. [Formal UAT](user-acceptance-plan.md) maps every slice to future product acceptance; no runs are claimed.

**Latest accepted direction:** human uploads use selected A, canonical company-scoped assets with actor/destination access. Independent processing preserves originals and private source boundaries. See [updated decisions](final-planning-decisions.md) and [E4.1](coding-plans/e4-1.md); [Claude's focused review of abbfc3c7e](human-intake-review-report.md) is received and author-verified: no material findings for selected A. This closes that focused planning round, not engineering qualification.

**Next technical proposal:** [Worker publication](worker-publication-plan.md) records the recommended application/worker boundary, durable output copy, receipt identity, cancellation and private indexing. Owning E4/E5 plans are reconciled. [Claude's review](worker-publication-review-report.md) is received; the [identity/revocation follow-up](worker-publication-identity-revocation.md) and promotion tightening address the valid recommendations. Material follow-up review, security acceptance and source qualifications remain open. This is not a new implementation authorization.

Start with the [master scope](master-scope.md), then the [code evidence and dependency map](code-evidence.md).

Latest planning pass: [implementation readiness review](readiness-review.md) and [nine per-epic preparation plans](implementation-plans/README.md), covering all 31 slices with a freshly checked replatform baseline. These distinguish planned work from executable coding readiness and do not close the upstream gates.

The master scope is the current product baseline; companion contracts specify planned integration behavior. The history directory preserves discussion records, including superseded proposals, and is not an implementation specification. No document here alone certifies runtime delivery.

- [Architecture map](architecture-map.md)
- [Integration decision review and provisional dependencies](integration-decision-review.md)
- [Epics and slices — grooming draft](epics-and-slices.md)
- [Consolidated technical planning checkpoint](technical-plan-summary.md)
- [Detailed grooming review and UI design gate](grooming-review.md)
- [Voice, browser and reconnect integration contracts](integration-contracts.md)
- [Engineering gate findings and ownership](engineering-gates.md)
- [Universe settings and voice configuration](settings-contract.md)
- [Consolidated Universe UI decisions](ui-review-decisions.md) — current tray, panel lifecycle, task chat, Commander/captions, themes, attention and known gaps; supersedes chronological mock notes.
- [Motion and interaction acceptance](motion-and-interaction.md) — transition matrix, reduced-motion alternatives and connected verification checklist.
- [Notification behavior review](notification-review.md)
- [Commander context review](context-review.md)
- [React Flow interaction contract](canvas-interaction-contract.md)
- [Canvas library comparison and decision](canvas-library-comparison.md)
- [Request and result contract](request-contract.md)
- [Canvas state and draft contract](state-contract.md)
- [Panel and capability bridge](panel-contract.md)
- [Format coverage](format-matrix.md)
- [Artifact processing](artifact-contract.md)
- [Voice provider research](voice-provider-research.md)
- [Universe landscape research](universe-landscape-research.md) — comparable products, GitHub references, and design implications.

## Latest review outcome

[Worker-publication reconciliation review](worker-publication-reconciliation-review-report.md) is author-checked and closed at the consistency level. [Remaining qualification record](worker-publication-qualification.md) lists actual CMD seams, expanded authority/credential coverage and contention evidence. Planning approval, runtime qualification and implementation authorization remain distinct.

## Voice/media review packet

[Concrete D3 proposal](voice-media-policy.md) and [September 12 official evidence](voice-media-provider-evidence.md) are ready for review. The packet preserves scope and records TK-accepted privacy settings separately from pending amendment/relay acceptance and engineering qualification. It does not start implementation.

## D3 review corrections prepared

The [Claude review](voice-media-review-report.md) was checked against pinned source. Its two medium and one low findings are addressed at the planning level in the [credential, budget and session corrections](voice-media-review-corrections.md), propagated to E3/E4/E8 and shared bindings. Persistent secret restriction must survive unbinding; shared Budget capacity is an explicit E8.1/1 prerequisite; E3.1/2 gets database-enforced cross-tab ownership and honest unknown outcomes. These are new proposals needing focused review, not implemented guarantees. Privacy acceptance is unchanged. Next: review these corrections, resolve technical acceptance and responsibility gaps, then present bounded BASE/DESIGN qualification for explicit authorization. Implementation remains paused.

## Current preparation checkpoint

The [voice/media correction review](voice-media-corrections-review-report.md) is closed at design level. The [static inventory](voice-media-qualification-inventory.md) traces budget admission/cost/policy and secret resolution/mutation/export paths; runtime completeness remains a qualification gate. TK accepted Codex as implementation/evidence author, TK as acceptance owner, and TK-managed Claude as independent technical review. Upstream evidence remains separate.

The [bounded BASE/DESIGN preparation proposal](bounded-engineering-preparation.md) specifies the source pin, newly observed replatform candidate, isolated Linux environment, commands, limits and result attribution. Replatform advanced to 9200a66c42633019349de937a8b97979acac0f7a; it was fetched/read, not merged. The existing Universe source pin remains 183e46a9c65fc3105c7e3d125629276814df7dbb. Next is scope approval of this preparation batch; implementation still requires a later explicit approval. No provider sessions, credentials, runtime tests or new implementation ran.
