# Universe — consolidated planning readiness and final review packet

**Sequencing update (September 13):** The [complete execution sequence](execution-sequence.md), [all-increment register](execution-increment-map.md) and [dependency gates](execution-dependency-gates.md) now join every original increment into one checked schedule. [Author review](execution-sequence-review.md) records the corrected producer/consumer ordering and its validation. This closes the sequencing gap raised in the implementation discussion; it does not close later runtime gates or authorize feature coding.


**Latest readiness (September 13):** [Replatform integration and base adoption](base-integration-results.md) are complete. The exact repaired candidate passed typecheck, 24,295 tests (76 unchanged skips), build and the required PR checks. Its verified landing is adopted into the existing Universe branch. No Universe feature implementation has begun; TK's requested discussion and explicit batch approval are next.

The planning packet is ready for the requested implementation discussion. BASE integration/adoption and represented first-batch design consistency checks are complete; the user has retained explicit batch approval after that conversation. Later integration prerequisites remain named below. No new general epic review is required.

The product scope and per-slice plan packet are assembled. No new general product-design round is recommended. The remaining work is a finite set of execution prerequisites and integration bindings, identified below. They must not be called completed merely because their qualification procedure is written. Conversely, runtime tests that can only exist after implementation are not requirements to rewrite the entire plan before starting any slice.

This is the current navigation and status record. Older dated review/proposal sections remain historical evidence. For current disposition, use this record and the linked latest results; it does not override locked product decisions or waive any owning slice's gate.

## Three separate verdicts

| Question | Verdict | Reason |
|---|---|---|
| Is the Universe planning packet assembled and author-reviewed? | **Yes; TK chose Codex review for this round** | Nine epics, 31 slices, 69 increments, version allocation, UI/settings/motion, contracts, failure/recovery and UAT are mapped. The F4 repair now has exact code and fault tests. |
| Can every V1 slice be coded immediately from a fully qualified binding? | **No** | Distributed Commander, voice/media authority, browser transport/profile, isolated host, storage/index and terminal-writer bindings retain explicit qualifications. Their plans provide the procedure to obtain the missing evidence, not fictional APIs. |
| May Universe coding start now? | **No** | BASE qualification/adoption and represented first-batch visual consistency checks are complete. TK's pre-implementation discussion and explicit batch approval remain open; no Universe feature code was added. |

This avoids equating “all plans exist” with “all implementation prerequisites passed.” The first verdict is about a reviewable plan; the second and third describe execution readiness.

## Scope and responsibility retained

- **V1:** 30 slices, including all three realtime voice providers, human assets and media generation, local/cloud browsers and saved profiles. Internal sequencing groups are not reduced releases.
- **V2:** E3.4 later speech modes, three increments. Complete and verify all V1 before V2 implementation. Multi-screen remains deferred until after the desktop app, outside these 31 slices.
- **Codex:** implementation and evidence author after approved scope. **TK:** acceptance owner. **TK-managed Claude:** independent technical reviewer. Upstream changes still need their actual owner and evidence; this model assigns no unnamed maintainer.
- Accepted UI includes centered expanded AoA tray, unified Commander access, independent chat/blob/captions/voice, compact and expanded chat, shared movable/resizable panels, distinct pin/minimize/close/maximize, contextual previews and attention, restrained selection and temporary Commander glow, themes and reduced motion. [UI decisions](ui-review-decisions.md), [settings](settings-contract.md), [motion](motion-and-interaction.md) are the specification.
- Human intake A and admin acceptance of disclosed provider terms remain settled product choices. They do not activate a vendor account, authorize spend, waive stricter company policy or prove the proposed credential enforcement.

## Whole-packet review and per-slice disposition

Reviewed the slice/coding indexes, start conditions, shared producer order, latest review dispositions, BASE evidence, DESIGN matrix and acceptance register. The table below names the completion boundary for every slice; linked coding plans retain exact files, steps and tests. Structural coverage validation checks all 69 increment identities in both plan sets, release/UAT coverage, local document links and pinned source/output anchors. That validation is not a semantic proof that code snippets compile or that every integration is available.

“Foundation” below means eligible to propose after BASE/design/approval and its listed producers; it never means authorized today. “Qualified integration” means the owning binding/evidence must close before the dependent runtime wiring. Every slice still requires implementation tests and its mapped human acceptance.

| Slice | Release | Planning disposition / first dependency and completion boundary |
|---|---|---|
| [E0.1](coding-plans/e0-1.md) | V1 | Base integration and exact adoption completed with qualification and source comparison. Later sync/producer checks remain required; existing Universe branch is retained. |
| [E1.0](coding-plans/e1-0.md) | V1 | Accepted intent and missing-state inventory documented. Complete affected-state visual consistency before affected UI coding; actual-host regression after implementation. |
| [E1.1](coding-plans/e1-1.md) | V1 | First UI foundation after BASE/DESIGN disposition: single registry/frame, pointer/resize/maximize/history. Qualify React Flow version and actual host; fixture content does not close task/browser routes. |
| [E1.2](coding-plans/e1-2.md) | V1 | E1.1 producer; revisioned layout/receipts/checkpoints. Exact schema-role binding and multi-tab recovery tests required. |
| [E1.3](coding-plans/e1-3.md) | V1 | Draft snapshot contract can precede E2.1; submission recovery waits for E2.2 read-only outcome. Five destinations retain their own authorization/answer schema. |
| [E1.4](coding-plans/e1-4.md) | V1 | Registry/preferences consumers; single popup owner and authorized overview. Navigation cannot copy live panel controls into previews. |
| [E1.5](coding-plans/e1-5.md) | V1 | Shared draft/registry/preferences; presentation can precede live voice. Complete chat restore/resize and independent visibility without capture side effects. |
| [E1.6](coding-plans/e1-6.md) | V1 | E1.1 viewport and E2.1 projection plus surfaces; measured motion/accessibility. Does not precede its own context producer. |
| [E2.1](coding-plans/e2-1.md) | V1 | Context types/resolver, then registry + draft capture. Source-authorized exact references; immutable request context and bounded viewport. |
| [E2.2](coding-plans/e2-2.md) | V1 | Read-only outcome can be planned against canonical records; distributed execution waits for CMD routing, credential and result ownership. No retry-as-status-check. |
| [E2.3](coding-plans/e2-3.md) | V1 | Layout/outcome and E7.3 authorized projection; canonical snapshot/replay reconciliation. Does not become the attention producer. |
| [E2.4](coding-plans/e2-4.md) | V1 | Shared frame/drafts and canonical task API; manual replies independent of distributed cutover. All five reported entry routes must pass actual-host lifecycle. |
| [E3.1](coding-plans/e3-1.md) | V1 | Qualified integration: OpenAI protocol/credential, shared Budget capacity, session ownership, canonical request path. Model/transport evidence required before activation. |
| [E3.2](coding-plans/e3-2.md) | V1 | E3.1 and canonical outcome producers; transcript generation fencing, interruption/reconnect, independent controls. Visibility is not session lifetime. |
| [E3.3](coding-plans/e3-3.md) | V1 | Gemini and ElevenLabs each qualify against the common contract; neither inherits OpenAI's evidence. |
| [E3.4](coding-plans/e3-4.md) | V2 | Planned only; all V1 acceptance precedes split/local speech execution. |
| [E4.1](coding-plans/e4-1.md) | V1 | Human original intake independent of CMD; canonical company/actor/destination authority, transaction/storage recovery and quota qualification. Index acceptance follows E4.2. |
| [E4.2](coding-plans/e4-2.md) | V1 | Original contract first; format/converter/distribution and private index qualification. Worker publication additionally needs output-binding and revocation/authority evidence. |
| [E4.3](coding-plans/e4-3.md) | V1 | Publication/version producers plus qualified generation/provider path; original and accepted revision survive failure. Media remains V1. |
| [E5.1](coding-plans/e5-1.md) | V1 | Registry/reference contracts first; durable state and contextual actions follow layout/draft/outcome producers. Local renderer success alone cannot close slice. |
| [E5.2](coding-plans/e5-2.md) | V1 | Qualified integration: isolated host origin/capability/storage/network/worker containment; no in-app unrestricted execution fallback. |
| [E6.0](coding-plans/e6-0.md) | V1 | Compatibility qualification before transport-specific implementation; local/cloud prove separately and retain launch guards. |
| [E6.1](coding-plans/e6-1.md) | V1 | E6.0 + canonical worker authority; controller epochs, approvals and stale input rejection. |
| [E6.2](coding-plans/e6-2.md) | V1 | Qualified cloud stream/input/identity/containment from E6.0–1. A visible stream is not accepted takeover. |
| [E6.3](coding-plans/e6-3.md) | V1 | Qualified local worker/media relay/permission, independent of cloud pass. Preserve browser chrome/dialog capability limits. |
| [E6.4](coding-plans/e6-4.md) | V1 | Session lifecycle, authorized file transfer and PROFILE qualification; signed-out success cannot stand in for saved-profile reuse. |
| [E7.1](coding-plans/e7-1.md) | V1 | Existing routine authority + canonical mutation path; durable scheduled occurrence and crash recovery. No second scheduler. |
| [E7.2](coding-plans/e7-2.md) | V1 | Routine admission and qualified terminal/reopen writers; marker/outbox decision and exhaustive writer evidence precede issue-source follow-ups. |
| [E7.3](coding-plans/e7-3.md) | V1 | Preferences producer first; shared authorized attention GET/delivery owner precedes catch-up consumer. Speech channel additionally waits for E3. |
| [E8.1](coding-plans/e8-1.md) | V1 | Personal preference contract first, consumer UI alongside each slice. Added voice credential/Budget work is a distinct producer obligation, not a prerequisite for unrelated theme/layout defaults. |
| [E8.2](coding-plans/e8-2.md) | V1 | Aggregates complete V1, all real qualifications, migration/rollback and per-slice + integrated UAT. No pass inferred from mock or skipped tests. |

## Remaining gates: who closes what, and when

| Gate | Current fact | Exact next deliverable | Blocks |
|---|---|---|---|
| BASE/F4 | Targeted and complete-suite checks passed at the [repaired candidate](f5-repair-results.md) | Preserve evidence during integration | No remaining F4 test failure on this candidate |
| BASE/F5 | Three-file fixture repair, 16 lifecycle tests and both real backup cases passed, including the integrated full-suite run | Evidence preserved in [base results](base-integration-results.md) | No remaining F5 failure on the adopted candidate |
| BASE/integration | [Qualified landing adopted](base-integration-results.md): source and tooling exactly match the local/CI-tested candidate; plans preserved | Maintain the fixed base and recheck affected contracts at future sync boundaries | Complete for the first-batch discussion; feature approval remains separate |
| DESIGN | [Eight first-batch states rendered and author-reviewed](pre-implementation-discussion.md), 32 combinations; no material departure found | Keep remaining slice states, actual host/gesture/accessibility, settings and Task regression acceptance open | Represented first-batch pre-coding consistency is complete; this does not certify runtime or all DESIGN |
| CMD | Existing/shadow paths do not certify distributed Commander | Production routing, user credential, admission/cancellation/result-return identities and actual upstream evidence | Distributed E2.2, dependent voice/actions/publication/browser/follow-ups; not manual task replies or original uploads |
| Voice/media authority | Product privacy choice settled; design corrections reviewed | Exact credential resolver/mutation/export coverage, shared Budget reservation writers, session lock/unique constraints, provider evidence and accepted applicable policy amendment | Enabled E3 and media generation; not visual blob/chat or personal appearance settings |
| Assets/publication | Human A and publication consistency review complete | Actual tenant-role/storage/converter distribution, output-slot binding, live revocation barrier and contention evidence | Durable intake/derivatives/generation enablement at the named increment |
| Browser/PROFILE/HOST | Conditional protocols specified | E6.0 local/cloud compatibility, controller fencing, saved-profile authority and E5.2 containment evidence | Respective integrations and complete V1 |
| Terminal writers | Follow-up mechanism specified conditionally | Exhaustive terminal/reopen mutation map, selected durable marker/outbox integration, crash/duplicate/revocation tests | E7.2 issue-source follow-ups |
| Release | No Universe implementation/UAT delivered | All 30 V1 acceptance records and E8.2 integrated qualification/rollback | V1 release and starting V2 |

Codex prepares the concrete evidence and delta; TK accepts scope and material experience/policy decisions; Claude reviews material technical changes. Actual upstream evidence cannot be replaced by either reviewer. Qualified numeric limits remain measured outputs, not promised performance. Source/schema rules in the active repository instructions govern execution: any mismatch with pinned historical migration-policy wording must be resolved before that migration, not treated as permission to hand-author DDL.

## Finite route from here

1. **Completed:** TK chose author review instead of Claude for this round. Codex reviewed the packet, completed bounded F4 repair/checks, and ran the subsequently approved full baseline. F4 passed; F5 setup timed out; build was blocked. Results are linked above.
2. **Completed:** the approved [F5 source correction and qualification](f5-repair-results.md) passed. No further baseline retry or general plan review is proposed. The interrupted shard-3 attempt remains recorded separately; resumed verification kept the original budget.
3. **Completed readiness; ready for discussion:** [Base integration and adoption](base-integration-results.md) passed local qualification and required CI and are complete on the existing Universe branch. The represented first-batch visual consistency checks are complete. TK requested a conversation before features: discuss the bounded E1.1 scope and review workflow, then obtain explicit batch approval. Actual React Flow/host tests remain implementation acceptance; later V1 integrations retain their gates.
4. **During approved V1 delivery:** close each qualified binding before its consumer, implement/test/review slices, update only material affected plan sections as upstream changes. Progress other V1 work when an integration waits. Do not switch to V2.

Stop adding general planning rounds after the final packet review. Reopen a plan only for a reproducible contradiction, missing accepted requirement, newly changed source/provider contract, failed qualification that changes the solution, or TK's scope decision. Review findings should cite a file/section, impact and minimal correction; preferences without such impact are not blockers. This is a review discipline, not a promise that no new defects will be found.

## Self-review corrections in this pass

- Replaced ambiguous “plan ready” language with the three verdicts above and mapped all 31 slices explicitly.
- Separated personal preference foundation from later security/Budget qualification; preserved attention-before-catch-up and index-producer-before-intake-index-acceptance ordering.
- Superseded the one-file F4 sketch with an explicit three-test-file proposal, real fault assertions, ownership-aware disposal, negative controls and exact combined selection. Corrected planned fault count to 12, competitor count to five, and retained both DB backup cases without a server-only filter.
- Included SDK as the sixth prebuild and the TypeScript-aware export prerequisite. Added an explicit test-file typecheck because the server tsconfig excludes tests. Earlier environment mistakes remain documented; no new run was made to hide them.
- Distinguished original F5 non-reproduction from repair and excluded speculative timeout changes.
- Reconciled the historical E0.1 branch-creation instruction: branch already exists; no recreation, reset or automatic moving-base adoption.
- Preserved open DESIGN provenance/host evidence and policy/role qualification. This review neither invents visual acceptance nor uses the excluded prototype as production evidence.

**Historical planning-pass verification boundary (superseded by the dated runtime results above):** document coverage, local links/anchors, code-path existence at the source pin and diff integrity only. Proposed F4 TypeScript has been read for lifecycle/type consistency but not compiled or run. No new repository tests/build, external documentation freshness check, provider call, container execution, source fix or source-base change is claimed. The remaining external/runtime checks are the named gates above, not completed work.

## Historical validation result for the original packet

The document checker completed successfully: 151 Markdown records, 31 slice plans and 31 coding plans, 69 increment identities in each set, 20 UAT scripts covering 31 slices, and 82 source anchors (70 at the pinned source plus 12 bundled planning inputs); 99 principal proposed outputs were checked for base collisions. No link, anchor, coverage or source/output errors were reported. Every slice addendum has steps and verification/recovery text; this presence check supplements, rather than replaces, the dependency review above. The proposed F4 test block contains 11 declarations expanding to 12 cases. Placeholder and whitespace checks passed.

Application-path diff against the Universe pin is empty. The separate correction checkout remains clean at b5cc42643223c433a8263564c7142761472a13d9. Only planning documents changed. Full repository typecheck/tests/build were not run because this turn is documentation-only; their prior failures and later required qualification remain explicitly recorded.
