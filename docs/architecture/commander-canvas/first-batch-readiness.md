# Universe — first implementation batch preparation

**Latest readiness (September 13):** [Replatform integration and base adoption](base-integration-results.md) are complete. The exact repaired candidate passed typecheck, 24,295 tests (76 unchanged skips), build and the required PR checks. Its verified landing is adopted into the existing Universe branch. No Universe feature implementation has begun; TK's requested discussion and explicit batch approval are next.

**Historical pre-adoption preparation (September 13):** [Exact base proposal and first-batch visual checks](pre-implementation-discussion.md) are complete for TK's requested pre-implementation conversation. The merge simulation is conflict-free; the combined source is not yet runtime-qualified or adopted. Eight first-batch states have 32 rendered checks. No Universe coding starts before that conversation and explicit batch approval.

**Historical preparation record; superseded for current execution scope by the [bounded engineering preparation proposal](bounded-engineering-preparation.md).** Earlier implementation was premature and remains paused. The Universe planning branch and source pin are now established; TK accepted keeping the earlier draft untouched/excluded. No runtime results below certify the new candidate or authorize coding.

September 11, 2026. **Preparation completed to the boundaries below; runtime implementation has not started.** The user accepted the V1/V2 grouping and the methodology of one Universe integration branch, reviewed slice branches, integrated journey checks, and separate handling of replatform prerequisites.

## Fresh baseline

A successful `git fetch origin` returned the same replatform head as the preceding review:

| Reference | Verified revision |
|---|---|
| Local working checkout | `06320643a72d8ef31904322a862abf09e3dc2168` |
| Fetched main | `e097d2f9332a2715bdbaf2058a4b751481107713` |
| Fetched replatform program | `f09230f3e331c5156eacfe8396755e2911e2152b` |
| Main/replatform merge base | `e097d2f9332a2715bdbaf2058a4b751481107713` |

Use the verified replatform revision as the first batch's **planning base**. Recheck it immediately before creating the implementation worktree; no checkout, branch, merge or upstream acceptance was performed in this pass. These hashes establish source identity, not that replatform has passed all release gates.

## Concrete source bindings for this batch

| Responsibility | Verified source / planned binding |
|---|---|
| Board route convention | `ui/src/App.tsx`, `boardRoutes()`; existing home/commander sibling routes and unprefixed redirect pattern. Public Universe navigation belongs to E1.4, after internal shell acceptance. |
| Shared task content | `CommanderTaskFocusPane` passes issueId, anchorId and onClose into `TaskDetail`; existing workspace chrome still contains close/width actions. E2.4 must adapt/extract content to avoid nesting window controls. E1.1 tests fixtures first and does not call that task adaptation complete. |
| UI dependency | Replatform `ui/package.json` uses React 19 and has no React Flow dependency. Registry lookup returned `@xyflow/react 12.11.6` with React peers >=17. Candidate exact pin for qualification; peer compatibility is not actual integration proof. |
| New code collision | Replatform tree has no `ui/src/components/universe/` or `ui/src/pages/Universe.tsx`. This is checked now, not a reservation against future upstream work. |
| Unit/component tests | `ui/vitest.config.ts` uses jsdom and the shared setup; `ui/src/__tests__/test-utils.tsx` supplies `renderWithProviders`. Task-focus tests already demonstrate delegated close through a content stub. |
| Browser test caveat | `tests/e2e/playwright.config.ts` selects only a skip test on Windows without external DB or `AOA_E2E_FORCE_WINDOWS=1`. A skipped suite cannot verify Universe. Use its isolated test instance, never the user's working database. |
| Distributed Commander | Replatform E10-F001 remains open. It does not block a pure UI registry or panel frame. Real request/result integration stays in E2.2 with its upstream gate. |
| Persistence/authority | E1.1 has no new server route/schema, storage write, provider session or execution API. E1.2–3 own durable state/drafts; fixture geometry is not persistent product delivery. |

## Deliverables and status

- [UI state designs](ui-state-review.md): written behavior, copy, focus/recovery, responsive rules and slice ownership for previously missing states. **Specified, visual review/test evidence pending.** Existing user-reviewed core remains controlling.
- [Canvas/controller coding plan](coding-plans/e1-1-canvas-controller.md): scoped files, state/interface code, regression cases, React Flow adapter mapping, lifecycle sequencing and verification protocol. **Core reference contract checked separately; React Flow/host UI qualification pending.**
- [Individual first slice](slice-plans/e1-1.md) remains unchecked until actual implementation passes.

## Start and completion gates

1. At coding start, verify the accepted replatform tree and create an isolated integration worktree using the agreed workflow. Never base production changes on the older local checkout just because it is open.
2. Check the additional written states in their intended UI against the already-reviewed main mock and accepted decisions. Do not restart the main design review. Bring the user only material experience/scope changes with concrete recommendations; routine consistency and runtime checks remain engineering work. See the [review boundary](ui-state-review.md#review-boundary-clarified-with-tk). This preparation pass did not update the mock or complete those additional visual checks.
3. Build E1.1's pure controller and qualified React Flow frame behind internal test access. Apply its real pointer/keyboard/host checks before exposing normal navigation.
4. Add E1.2/3 persistence and drafts, E1.4 tray and E1.5 Commander in their planned order, with context and motion contracts alongside. E2.4 supplies real task content; E3/E6 supply actual transports.
5. No pass of the reference reducer closes embedded-host glitches, saved-state behavior, provider integration or the whole E1.0/E1.1 slice. Keep those evidence boundaries in release tracking.

## Proposed implementation methodology — requires review

One Universe integration branch based on the verified replatform revision; small reviewed branches for each slice/increment. Finalize the coding plan, implement, verify its full connected journey, then integrate. Independent V1 work can progress together; blocked V1 increments retain their upstream owners. User review is for changed experience or scope, with engineering checks beforehand. V2 implementation waits for all V1 closure.

No new product decision is required to prepare this batch. Remaining exact UI rendering and runtime compatibility results must be observed, not assumed.

## Verification in this preparation pass

The reference controller embedded in the coding plan passed strict TypeScript checking and 12 standalone contract checks, including scope/version identity, duplicate opening, pin behavior, maximize/minimize/restore, stacking, invalid geometry, rapid transitions and stale callbacks after close/reopen. These checks executed extracted reference code in a temporary location, not production modules. No React Flow package was installed into the repository, and no runtime UI or mock was changed.

React Flow peer declarations and official resize/gesture documentation were inspected. The actual frame/workspace package build, pointer/keyboard/iframe checks and embedded-host reproduction remain implementation qualification. Full repository tests, typecheck and build were not run for this documentation-only change. Earlier component results are not substitutes for those missing checks.
