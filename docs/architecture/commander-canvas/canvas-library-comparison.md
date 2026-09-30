# Universe canvas foundation: library comparison

11 September 2026. Recommendation, not an adopted dependency or tested implementation.

## Decision update

The user selected React Flow on September 11 after reviewing these alternatives. Carry React Flow into implementation planning. The original recommendation below is retained as comparison history and is superseded by this decision. See [interaction contract](canvas-interaction-contract.md). No package has been installed by this decision.

## Original recommendation (superseded)

Build an AoA-owned panel workspace using existing interaction primitives where suitable. Keep React Flow as the leading alternative for a continuously pannable/zoomable spatial surface. Do not force the Home dashboard grid into the freeform role. No new dependency is approved by this document.

The decisive distinction is the workspace interaction: movable readable windows with focus/compare layouts versus navigating a large spatial board by panning and zooming. Both can look similar in a screenshot. Our agreed task-chat, artwork and browser walkthrough favors the former; any required infinite-board navigation must remain available in the requirements rather than be silently dropped for convenience.

## Existing AoA evidence

Inspected local HEAD `06320643a` and the locally available replatform tracking ref `origin/docs/replatform-program` at `72479410b`. This comparison did not fetch remote updates. Both UI manifests contain React 19, dnd-kit core/sortable/utilities, react-grid-layout 2.2.3, react-resizable 4.0.2, and react-resizable-panels 4.9.0. Matching manifests establish dependency availability, not complete runtime compatibility.

- [UI manifest](../../../ui/package.json): installed library choices.
- [HomeBoard](../../../ui/src/components/home/HomeBoard.tsx): grid, edit-mode interaction, custom keyboard move/resize, responsive projections.
- [Grid API notes](../../../ui/src/components/home/RGL_V2_API.md): native v2 API; avoid copying older v1 documentation examples.
- [HubShell](../../../ui/src/components/hub/HubShell.tsx): existing split-panel composition.
- [Commander sessions sidebar](../../../ui/src/components/commander/SessionsSidebar.tsx): existing sortable interaction.

These paths are relative to the repository root from this document directory. Home's discrete columns and compaction are appropriate to widgets; Universe needs its own layout policy and persisted model.

## Options

| Option | Strength | Work or limitation for Universe | Judgment |
|---|---|---|---|
| Existing dnd-kit + resizing primitives, AoA panel shell | Flexible DOM panels, reuse existing stack, control appearance and focus modes | Build window ordering, geometry, collision policy, keyboard resize, persistence and any viewport transform; split-panel resizers alone do not supply freeform windows | Preferred direction for window-like workspace |
| React Flow | Spatial coordinates, custom React nodes, pan/zoom, selection and keyboard support | Suppress graph gestures within content; customize chrome; keep full-size focused mode; browser/iframe behavior needs testing | Leading alternative if spatial navigation is essential |
| Dockview | Tabs, groups, split layouts, floating groups and serialization | Docking/group semantics may dominate the experience; assess mount lifetime and styling before choosing | Best if we want IDE-like docking as a primary behavior |
| react-rnd | Controlled dragging/resizing, bounds and drag handles | Does not provide full window management, accessibility or durable layout semantics | Small primitive candidate if existing resizing composition becomes complex |
| Existing react-grid-layout | Responsive dashboard arrangement, already integrated | Grid/compaction model differs from freely placed panels and purposeful overlap | Reuse for dashboard-like content, not default Universe shell |
| tldraw | Whiteboard canvas and agent starter patterns | Drawing/object model, rich panel embedding and production license requirements must be justified | Prefer for a drawing surface if needed, not default shell |

Sources: [dnd-kit keyboard guidance](https://dndkit.com/legacy/guides/accessibility/), [React Flow custom nodes](https://reactflow.dev/learn/customization/custom-nodes), [Dockview overview](https://dockview.dev/docs/overview/introduction/), [floating groups](https://dockview.dev/docs/core/groups/floatingGroups/), [react-rnd](https://github.com/bokuweb/react-rnd), [react-grid-layout](https://github.com/react-grid-layout/react-grid-layout), [tldraw agent starter](https://tldraw.dev/starter-kits/agent).

## Input and accessibility

Dragging should begin at panel chrome, not arbitrary content. Chat text selection, typing, chart sliders and document scrolling must remain normal. React Flow explicitly provides drag/pan/wheel exclusions and keyboard node navigation; those are useful controls, not proof that nested content is fully accessible. [Interaction exclusions](https://reactflow.dev/learn/customization/utility-classes), [accessibility](https://reactflow.dev/learn/advanced-use/accessibility)

For our existing dnd-kit packages use their matching legacy documentation; the newer package family is not a drop-in API replacement. Keyboard sensor support does not automatically implement freeform resize or sensible focus order. Provide keyboard actions for move, resize, focus, restore and close, with announcements and focus restoration.

Cross-origin browser panels are a separate input surface. Parent event exclusions do not establish behavior inside an iframe. Test pointer loss during drag/resize across the browser, release outside the panel, browser scrolling, keyboard focus and input-coordinate mapping. Any temporary interaction shield must end with the drag and must not become the browser authorization mechanism.

## Architecture shared by every option

AoA owns panel identity, content references, layout versions, drafts, active selection and permission checks. A library receives presentation state and reports layout changes. Its serialization may be an adapter detail, not the sole durable business format.

Closing a panel never cancels its job. Focus/compare transitions must not accidentally remount a browser, reset a draft or duplicate an artifact. Unmounting heavy viewers is allowed only with explicit recoverable viewer state. Layout updates must not subscribe every panel to every streamed agent token.

The library cannot replace replatform's execution, event recovery, access or browser-control contracts. Compatibility here means React/package fit and bounded presentation responsibilities; live browser integration is not verified by this research.

## Selection gates during implementation

Use the same three real panels, without requiring a separate product prototype before planning:

1. Type and select text in the task chat; drag only via the header. No unintended panel movement.
2. Resize artwork beside a browser; pointer release restores normal input. Browser coordinates remain correct.
3. Focus, compare and restore repeatedly; drafts, browser identity and artifact identity survive.
4. Move/resize/focus/close by keyboard and restore focus predictably; verify screen-reader announcements.
5. Resize the viewport; every panel remains recoverable through navigation even when off-screen.
6. Restore saved layout while agent results arrive; no missing or duplicated items.
7. Measure frame responsiveness and memory with representative documents and multiple streams; agree numeric budgets in acceptance criteria rather than claim unmeasured performance.

## Licensing, maintenance and dependency process

React Flow's repository license is MIT; tldraw explicitly requires a production license key. Other candidates require exact release/package license verification before selection; a failed Dockview license-page retrieval in this research is not a license finding. [React Flow license](https://github.com/xyflow/xyflow/blob/main/LICENSE), [tldraw licensing](https://tldraw.dev/community/license)

Official docs and repositories were reachable, but this was not a complete maintenance or vulnerability audit. Before adding a dependency, inspect release compatibility with React 19, unresolved input/accessibility defects, transitive dependencies, published package contents and notices. Commit manifest and regenerated lockfile together under AoA's dependency rules; no lockfile-only change. Run the required integration, typecheck, test and build checks for implementation.

No library was installed and no production behavior changed. This is a source/documentation comparison, not a benchmark. Recommendation to discuss: retain the freeform panel experience, reuse existing primitives, and select React Flow instead if our required spatial navigation would otherwise mean rebuilding a canvas engine.
