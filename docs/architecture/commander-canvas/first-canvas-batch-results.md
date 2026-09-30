# First Canvas implementation batch

**Status: source implementation complete and fully qualified; awaiting TK demonstration review.** TK approved starting this bounded batch with “lets start” after reviewing the base, execution sequence and isolated worktree. This record supersedes the earlier “feature coding unstarted” status for these packages only.

## Scope and source

- Branch: `codex/universe-interface`, isolated `.worktrees/universe-interface` checkout.
- Final source/tests revision under qualification: `6659dede9af18e462cabca7df0a4686da8982dd2`.
- Starting planning revision: `53e1ece01dd5b4be6c987af5950f1ea50fa4e4a7`.
- Adopted replatform revision: `b48132dac0f3435e017915e1e21ef1d66a39d0cd`. Remote replatform still matched at batch preflight; no new merge or rebase was required.
- Approved work: `E8.1/1.a` pure preference contracts and `E1.1/1–3` shared registry, geometry history, controlled React Flow frame and internal browser harness.
- `E1.3/1.a` destination snapshot types are an independent producer in B02 and remain for the next work packet. This batch does not close the entire scheduling slot.

The internal harness demonstrates generic task-like, artifact and iframe content. Public Universe navigation, persistent layout/drafts, actual task entry routes, Commander presentation, live voice/browser sessions and provider APIs remain their separately sequenced consumers. The unapproved earlier implementation is excluded and untouched.

## Progress and evidence

| Producer or gate | Current evidence |
|---|---|
| Shared preferences | `7fc25f919`: strict schemas/defaults/reset sections; focused 7 tests, shared 590 tests, shared typecheck/build; independent task review approved |
| React Flow dependency | `cf0d609f3`: exact `@xyflow/react@12.11.6`, manifest plus generated lockfile; frozen install and actual runtime exports checked |
| Pure controller/history | `fe3b356ca` plus `03d3244a8`: 43 focused tests and targeted strict TypeScript; independent review caught receipt-wide ordinal consistency, corrected and re-reviewed |
| Controlled frame | `e40313915` through `cf947c356`: 68 focused tests and UI typecheck; independent reviews corrected resize targets, bounded opening, cancellation fencing, child-ready focus and delayed camera completion |
| Actual browser journey | 47 actual Chromium cases passed on `6659dede9`, zero retries, skips, flaky cases or unexpected errors; 61.147 seconds |
| Final correction wave | `6659dede9`: 75 focused UI tests and UI/browser typechecks pass; I1–I3 and M1–M7 corrected; scoped re-review APPROVED with zero residuals |
| Full modified-source qualification | PASSED on `6659dede9`: 16 exact-source Linux gates green — install, 6 package builds, exports, citation checks, typecheck, 4 Vitest shards (24,377 passed / 76 skipped) and final build (`qualification-6659dede9a.json`) |
| User experience acceptance | Pending demonstration and TK review |

The existing Linux baseline certificate is preserved. A fresh qualification checkout at `/workspace/universe-canvas-20260913` uses the established non-root test container. Its initial online dependency installation failed with DNS `EAI_AGAIN`; transferring the four already integrity-addressed host-cache packages allowed a frozen offline install without manifest or lockfile changes. This environment preparation is not a source qualification result.

## Implementation bindings clarified

1. `OpeningAck` and `PendingOpen` both carry `scope: Scope`. An acknowledgement cannot change ordering without matching its company/user/conversation and recorded incarnation. All receipt mappings must preserve one ordinal per incarnation and cannot reuse an ordinal across incarnations, even ones already closed.
2. Geometry actions accept optional `expectedRect`. Undo/redo proposals include it, and the reducer checks it again at application time so an intervening edit cannot be overwritten. History returns a candidate action/history; the caller installs it only after acceptance. E1.2 must retain that guard in its persistence adapter.
3. `State.layoutRevision` is an optional bounded reconciliation watermark, not a persistence authority. Older acknowledgements or canonical/optimistic ordinal collisions require E1.2 reconciliation. Hydration is an authorized initial load or explicit clean replacement; routine dirty refresh cannot call it to overwrite edits.

4. `UniverseWorkspace` exposes a typed `WorkspaceHandle` through `forwardRef`, with scoped dispatch, camera commands, defensive diagnostic snapshots and accepted undo/redo proposals. Retained mutation handles from an old scope are inert. Later tray and Commander consumers must use this seam instead of DOM handlers.
5. `WorkspaceHandle.open(entry, policy?)` uses measured usable bounds and the current camera for a new panel. Repeated opens retain normal geometry. Unmeasured workspaces wait rather than create corrupt geometry.
6. Cancellation aborts a gesture: restore the before-rectangle only if the same scoped incarnation still has that gesture's last accepted rectangle. It creates no history entry and cannot overwrite a reentrant observer edit. This commits to abort semantics; changing to partial-motion retention would require revised undo/interaction tests.

These refinements make existing identity and compare-before-write requirements explicit. Their integration cost is aligning the later E1.2 adapter with these signatures and recovery paths; they do not add a second layout writer or domain execution authority.

## Interaction failures caught and corrected

Actual pointer tests exposed incorrect resize hit stacking, lost focus on initial open/restore, and camera rollback at nondefault zoom. Cancel tests also exposed late gesture callbacks and a reentrant observer edit being overwritten. Each fix has a regression and scoped review. The camera defect came from delayed React Flow internal sync completions and earlier native drag completions replaying stale coordinates; only a native completion matching the current camera can commit. These generic-frame corrections do not certify the old mock or real task-entry routes.

## Final correction coverage

The whole-batch review identified three local correctness gaps: a contradictory-company content mapping could invoke its renderer, a completed human gesture could incorrectly claim an external edit in undo history, and a sibling lifecycle interruption could publish an older state after rollback. Five regressions reproduced those failures before correction. Final completion keeps only a gesture-owned accepted rectangle, checks content identity before rendering, and publishes the final accepted state after lifecycle cancellation.

The same bounded pass corrected background-resize focus, inactive header brightness, scope camera diagnostics, incarnation attributes, resize callback metadata, the recovery focus target and internal toolbar organization. A new browser regression caught an introduced 12 px recovery-row shift; matching its existing height corrected it without changing assertions. These details and their failed/passing runs will be preserved with the final evidence.

## Demonstration and reproduction

Use the internal Vite entry `/universe-harness.html`. The coordinator preview is at `http://127.0.0.1:5184/universe-harness.html` while the local server is running. It is a generic engineering fixture, not the finished Universe visual design or a public application route.

1. Open Task, Artifact and Iframe fixtures. Drag their headers and resize any edge/corner at Zoom 0.5, 1 and 2.
2. Click an exposed panel or resize its exposed edge to bring it forward. Select and scroll body content without moving the canvas.
3. Enter a draft, minimize and restore; maximize, resize the browser and restore. Content stays mounted and normal geometry is retained.
4. Pin a panel: human movement remains available, while Commander arrangement refuses it. Undo/redo changes geometry only.
5. Close one panel and verify its sibling remains; reopen gets a fresh incarnation. Missing/throwing fixtures retain operable frame controls.

Reproduce the permanent browser gate with `pnpm exec playwright test --config tests/universe-canvas/playwright.config.ts`. It starts its own Vite-only server on 127.0.0.1:5183 with one Chromium worker and zero retries. Narrow/coarse targets are browser emulation, not touch-hardware qualification. The 1/10/50-panel timings include test-runner overhead and are samples, not performance guarantees.

## Post-demonstration correction (2026-09-17)

During TK's live review, a control click (close/maximize/etc.) on an *unfocused* panel required two clicks — the first only foregrounded it — and the effect was more noticeable with many panels open. Cause: the panel dispatches `focus` on pointer-down (`PanelFrame`), and foregrounding reorders `state.order`, which drove **both** the rendered node order and `zIndex` in `UniverseWorkspace`; React re-inserted the node in the DOM mid-gesture, so the browser dropped the control's `click`. Fix: render nodes in a stable (selection-independent) order and drive stacking with `zIndex` alone — React Flow stacks absolutely-positioned nodes by z-index regardless of sibling order, so foregrounding is now a style change that cannot detach the click target. A new browser regression that single-clicks Pin then Close on a background panel reproduced the defect (red) and passes after the fix; the full 48-case browser suite, 75 focused UI tests, UI typecheck (`tsc -b`) and UI build are green.

Two related observations from the same review were confirmed as **out of this batch**: motion/hover/animation polish is assigned to E1.0/E1.6 and consuming epics (see `motion-and-interaction.md`), and multi-panel auto-arrange/tiling is a dedicated later task (the current open placement is intentional bounded-cascade).

## Completion boundary

Generic frame completion requires observed pointer/keyboard/resize/overlap behavior at zoom 0.5, 1 and 2, content lifetime and scope cancellation, narrow/reduced-motion checks, full modified-source tests/build and final review. Unit tests or fixture content cannot certify authenticated task routes, provider sessions, persistence or completed V1. The next batch remains subject to the user's review of this demonstration.
