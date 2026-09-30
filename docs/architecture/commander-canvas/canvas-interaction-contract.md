# Universe: React Flow interaction contract

September 11, 2026. React Flow is the agreed foundation. The following interaction defaults are recommended engineering design, subject to implementation verification, not claims of shipped behavior.

## Canvas and content

- Render task conversations, artifacts and browser surfaces as custom React nodes with stable panel identities. Default view has no graph edges or connection handles.
- Drag panels from their headers only. Inputs, text selection, sliders and content buttons must not initiate node dragging or canvas panning.
- Drag empty canvas space to pan. Provide explicit zoom controls and a return-to-work action. Wheel over panel content scrolls that content; ordinary wheel input must not unexpectedly zoom the whole workspace.
- Enable deliberate canvas zoom gestures over the canvas, separately from browser page zoom and accessibility zoom. Never globally suppress operating-system/browser accessibility shortcuts.
- At overview scale, panels may show simplified previews. Opening/focusing a panel presents readable content at normal working size; preserve the previous viewport for return. Do not force users to type into tiny scaled controls.
- Commander, conversation/captions, dock and attention controls live outside the transformed canvas viewport. Respect manual Commander placement and reserve usable content space.
- Automatic arrangements avoid covering active content. Manual overlap is allowed; selecting an obscured item through open-panel navigation brings it forward. Recompute visibility after window-size changes without silently destroying saved placement.

## State and lifecycle

The [current UI decisions](ui-review-decisions.md#u04--shared-panel-lifecycle) define shared open/move/resize/select/pin/minimize/maximize/restore/close behavior. One registry/controller must serve every entry path, including task attention and artifact source links; preview renderers must not duplicate live controls. User selection uses header tint/title brightness only. Requested Commander highlighting brings an off-screen target into view then applies a transient glow; routine background updates do not move the camera. See the [motion matrix](motion-and-interaction.md) for cancellation, pointer capture and reduced-motion acceptance.

AoA owns canonical geometry, viewport, stable content references and selection. React Flow is the presentation adapter. Persist its relevant geometry through the existing planned versioned canvas contract rather than using an unvalidated library snapshot as the database schema.

Focus/compare/overview transitions must preserve drafts, source identity and browser session identity. Reparenting or remounting is an implementation detail that must not reset live work. Expensive viewers may suspend with recoverable state; task execution continues independently.

Selection context sent to Commander includes stable authorized item references and a revision. Screen position helps resolve speech but is not item identity or permission. An item remains the target if the layout subsequently moves.

## Browser input boundary

React Flow gesture exclusions do not by themselves control cross-origin iframe input. Browser content has its own focus, scrolling and coordinate mapping. Use panel chrome for canvas operations; apply any temporary drag shield only during active panel manipulation, removing it on completion or cancellation. Test lost pointer capture and release outside the browser. Browser pause/resume authority remains server-owned and independent of panel gestures.

## Accessibility and verification

Provide keyboard actions for selecting, moving, resizing, focusing, restoring and closing panels, with appropriate focus return and announcements. React Flow's node keyboard support is a starting point, not complete nested-panel accessibility. Preserve typing and screen-reader navigation inside editors. Provide open-panel list navigation as an alternative to spatial discovery. Respect reduced motion.

Verify with real task chat, artifact and browser panels: header-only dragging; text selection; content scrolling; iframe pointer recovery; focus/restore without draft or session loss; keyboard operations; resized viewport recovery; autosave/reconnect with concurrent results. Performance budgets and the exact package version are open engineering details to establish during implementation.

References: [React Flow interaction exclusions](https://reactflow.dev/learn/customization/utility-classes), [keyboard accessibility](https://reactflow.dev/learn/advanced-use/accessibility), [node drag handles](https://reactflow.dev/api-reference/types/node).

## Next architecture decisions

1. Panel host and generated-content isolation: first-party React panels versus sandboxed generated interfaces, with a narrow validated capability bridge.
2. Realtime voice adapter and Commander turn ownership, including streamed responses and cancellation boundaries.
3. Replatform browser/session and durable event adapters, checked against their delivered contracts.
4. Storage operations, conflict resolution, retention and measurable recovery/performance acceptance limits.

These are refinements of the agreed scope; do not reopen settled product decisions or install competing execution systems as incidental UI dependencies.
