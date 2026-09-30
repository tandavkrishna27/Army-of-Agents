# Universe — base proposal and first-batch design disposition

**Current discussion supplement:** [The complete execution sequence](execution-sequence.md) now supplies exact delivery packages, prerequisites, external gates and the patch/review/integration method. [Author review](execution-sequence-review.md) is complete for that scheduling layer. The base-integration proposal below is historical; use the adopted-base result above and this sequence when selecting the first bounded implementation packet.

**Latest readiness (September 13):** [Replatform integration and base adoption](base-integration-results.md) are complete. The exact repaired candidate passed typecheck, 24,295 tests (76 unchanged skips), build and the required PR checks. Its verified landing is adopted into the existing Universe branch. No Universe feature implementation has begun; TK's requested discussion and explicit batch approval are next.

**Historical proposal below; current outcome is linked above.**

September 13, 2026. **Preparation complete for TK's requested discussion. No Universe implementation or source-base adoption.** TK asked to finish the next preparation and talk before implementation. This record makes the next action concrete; it does not treat that request as approval to publish/merge source corrections or begin features.

## Exact base recommendation

Use a fixed integration candidate combining replatform `06a37345229fd23837764106350318cdb61b3445` with the four reviewed local repairs ending at `fcab5a112aeac8385733f528396e65d258c02dfb`. Preserve the existing `codex/universe-interface` branch and its planning history. Do not restart from main or import the premature Universe implementation.

| Check | Observed result |
|---|---|
| Remote replatform checked in this preparation | `06a37345229fd23837764106350318cdb61b3445` |
| Common ancestor of current replatform and repaired candidate | `9200a66c42633019349de937a8b97979acac0f7a` |
| Read-only merge simulation | `git merge-tree --write-tree 06a37345229fd23837764106350318cdb61b3445 fcab5a112aeac8385733f528396e65d258c02dfb` exited zero; tree `0ad79d8bb727f30040c2649a20ee16609cf3f117`; no conflicts |
| Repair delta against current replatform | Nine files, 600 insertions / 93 deletions; same four repairs, only filesystem opener changes production behavior |
| First-batch source compatibility | No change from Universe's existing `183e46a9c65fc3105c7e3d125629276814df7dbb` pin in `ui/src/App.tsx`, `ui/package.json`, `ui/vitest.config.ts`, `ui/src/components/commander/CommanderTaskFocusPane.tsx`, or `ui/src/components/TaskDetail.tsx`; each path exists at the inspected revision |
| New Universe file collisions | No tracked `ui/src/components/universe/` or `ui/src/pages/Universe.tsx` at current replatform |
| Runtime certificate available | [Full baseline pass](f5-repair-results.md) covers `fcab5a112`, not the simulated combined tree |

`merge-tree` writes Git objects but does not move a branch, modify a checkout/index or adopt the result. The tree hash identifies a proposed composition, not a tested commit. No integration branch or commit was created in this preparation.

The four repairs, in order, are `0912b3742` outbound URL fixture, `b5cc42643` filesystem opener error handling, `4aebfa0f4` blocked-task fixture lifecycle, and `fcab5a112` backup fixture lifecycle. The existing source repair branch is `codex/universe-f5-fixture-repair`; it remains local.

Upstream added two commits after the repaired candidate's ancestor: `7b0d01c` adds citation-integrity enforcement and workflow wiring; `06a373452` adds fence-denial audit recording in worker event/control/renewal/output paths with integration tests. The second affects production services consumed by later Commander/output work. It does not alter the first Canvas batch's UI bindings or the repair files. No conclusion about its security completeness or runtime compatibility is inferred from a conflict-free merge.

### Recommended integration sequence to discuss

1. Publish the existing four-repair source branch and open a repair PR targeting `docs/replatform-program`, with the exact full baseline evidence and original failure retained. This requires TK's source-publication decision; it has not been done.
2. Qualify the fixed combined candidate, including the new citation guard, fence-audit integration tests, repository typecheck/full suite/build and any required CI policy checks. Do not transfer the old passing certificate to the new tree. Freeze the chosen input for that run rather than continually chasing upstream.
3. Let the replatform owner review and land the repair PR at its normal boundary. Record the actual landing revision and compare its tree to the qualified candidate; any additional delta receives its applicable checks. Do not merge into ongoing replatform work without that coordination.
4. With TK's explicit adoption decision, merge the accepted replatform revision into the existing Universe branch. Preserve all planning documents, verify the resulting source tree, and retain a pre-adoption revision for recovery. Do not reset/recreate the branch or force-push it. A newer unrelated replatform commit can be tracked for the next reviewed sync; it does not automatically invalidate an earlier exact certificate.

An alternative is to adopt the already-qualified `fcab5a112` source now and integrate newer replatform work at a later boundary. That avoids retesting unadopted changes today but creates an immediate upstream divergence. I recommend the fixed combined candidate because it includes the newly landed audit work and keeps the repair on the replatform track. Neither option is silently selected or executed by this document.

## First-batch visual consistency checks

Created a separate [state study](evidence/first-batch-design-2026-09-13/state-study.html), without modifying the existing interactive mock. It renders eight specified states: panel loading, renderer failure, revoked access, deleted reference, keyboard-focus appearance/selected header, narrow layout with attention, empty workspace, and initial workspace loading. Window controls are illustrative, not an implementation of their actions. Sample captions are explicitly review content, not an active voice session.

The study uses the existing available mock's theme tokens and real AoA SVG. The available file was rendered for comparison and its hash recorded, but its bytes are not retroactively asserted to be the exact revision TK reviewed. Accepted [U01–U10 intent](ui-review-decisions.md) remains the design authority. The simplified blob in this state study does not replace the accepted layered blob, its controls or animation design.

| Check | Disposition |
|---|---|
| 1440×900, 1024×768, 390×844 CSS-pixel layouts | Eight states at each viewport rendered and checked |
| 390×844 at 200% root text size, reduced motion | Eight additional states rendered; 32 total combinations |
| Loading/error shell | Title and ordered Pin/Maximize/Minimize/Close controls remain separate from body; no retry-task inference from a renderer failure |
| Selection and keyboard focus appearance | Quiet header tint; focus ring on the actual button, no selected-panel white line or outline/glow |
| Revoked/deleted content | Generic title and accessible panel name replace source title; body is replaced; no permission-bypass retry |
| Narrow text scaling | Fixed a discovered caption/attention overlap by reserving measured chrome heights; body scrolls while header/composer stay reachable |
| Logo at larger text size | Corrected inline SVG baseline alignment; mark remains centered in its button |
| Reduced motion | Computed blob animation is `none`; status remains readable |
| Final automated rendering checks | 32 combinations; no horizontal page overflow, header clipping, caption/attention overlap or page errors under the checks performed |
| Author visual inspection | Reviewed actual screenshots of desktop error, revoked, focus, narrow 200% text and available historical reference; no material product departure identified for these states |

Evidence: [render checks](evidence/first-batch-design-2026-09-13/render-checks.json), [desktop error](evidence/first-batch-design-2026-09-13/failure-1440-1x.png), [focus](evidence/first-batch-design-2026-09-13/focus-1440-1x.png), [narrow 200% text](evidence/first-batch-design-2026-09-13/attention-390-2x.png), and [manifest](evidence/first-batch-design-2026-09-13/manifest.json). The initial harness's reused-page script redeclaration errors and discovered narrow overlap are retained separately. Final runs navigated to a fresh document for each viewport and completed without those errors.

This closes the **author's pre-coding visual consistency check for the represented E1.1 states**. It does not close E1.0, E1.1 implementation acceptance, all DESIGN coverage, or TK's final acceptance. Native browser zoom, real keyboard/touch gestures, screen-reader behavior, actual host/React Flow, drag/resize/lifecycle, persistence, all five Task routes, settings consumption, and live revocation still require their existing implementation tests. The intermittent task-panel defect remains open. Later voice, storage, browser and conflict states retain their slice-specific checks.

## Our conversation before implementation

The plan is ready for this discussion; no new general epic review is proposed. We should settle the base-integration sequence above and the scope of the first actual coding batch: E1.1 shared registry/frame, geometry/history and bounded renderer shell, plus only the personal preference contract it consumes. Public navigation, durable persistence, real task adaptation and live Commander/voice/browser integrations remain in their planned later increments. Discuss where execution will run and how you want to review the first working journey; no new task is created automatically.

After that conversation, explicit approval of the selected implementation batch remains required. BASE integration qualification and adoption must precede feature coding. Passing fixture tests or authoring this study does not grant feature approval.

## Verification and preserved boundaries

Read-only Git identity, ancestry, merge-tree and path-diff/collision checks; source-bound plan review; 32 standalone browser render combinations and screenshot inspection; local document/coverage validation. No new full repository test/build run was necessary for this documentation/mock-only preparation; the prior passing baseline stays linked to its exact source. No application file, dependency, schema, source branch pointer, provider session, user data or excluded draft was changed. Documentation/evidence publication stays on the existing Universe planning branch.
