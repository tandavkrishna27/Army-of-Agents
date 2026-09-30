# Universe — epic and slice grooming draft

September 11, 2026. Authority: [master scope](master-scope.md). Evidence baseline and branch recommendation: [integration decision review](integration-decision-review.md). This is the implementation breakdown for grooming, not an executable coding plan or release commitment. Each subsystem receives a detailed implementation plan after its contracts are bound to the accepted code revision.

## Delivery rules

Every slice below has a task work package in the [per-epic preparation plans](implementation-plans/README.md). Consult the [fresh readiness/dependency review](readiness-review.md) for current gates, proposed sequencing and qualifications required before executable coding plans. All 31 slice IDs remain stable; no tickets were created.

- Each slice delivers an observable outcome across the necessary database/shared/server/UI layers; scaffolding, migrations, docs and tests belong to that slice.
- Keep company boundaries, single-assignee ownership, approvals, budget hard stops, atomic checkout and mutation auditing. Follow repository service/route patterns and generated Drizzle migrations.
- A fixture validates a consumer contract; it does not demonstrate a working upstream integration. Record upstream evidence separately.
- Preserve existing data and preferences with explicit migration and rollback. Disabling Universe must not cancel canonical jobs or delete conversation, drafts or artifacts.
- Provider support is capability-specific. A configured CLI provider is not automatically a configured speech provider.
- No implementation branch or ticket has been created. IDs below are document-local planning references.

## Epics and independently reviewable slices

See the [detailed grooming review](grooming-review.md) for corrected dependencies, readiness gates, proposed engineering limits and the UI design deliverable. The UI design slice below precedes UI implementation; earlier walkthroughs are not approved production designs.

| Epic / slice | Delivered user outcome | Dependencies | Acceptance and recovery |
|---|---|---|---|
| E0.1 Contract/base binding | An implementation baseline with exact schema, API, event and worker bindings | Replatform revision acceptance | Record source revision, producer/consumer, permissions and tests per contract; mark Commander cutover dependency explicitly. |
| E1.0 UI design and interactive mock | A reviewable Universe interface and connected walkthrough, with per-epic screen/state ownership | Master scope and existing AoA design system; independent of runtime cutover | Review layout, navigation, panels, voice, browser, attention and settings; include empty/loading/error/offline/conflict/narrow-screen states and keyboard flow. User review precedes UI implementation. |
| E1.1 Canvas shell | Universe icon opens a React Flow workspace with real task/document panels and compact Commander | E0.1; E1.0 design review; existing UI components | Typing/selecting/scrolling inside panels does not drag the canvas; header drag and deliberate zoom work with keyboard alternatives. |
| E1.2 Saved workspace | Layout survives reload and device viewport changes | E1.1; state contract | Concurrent tabs cannot overwrite a stale whole document; retried operation applies once; saved status requires acknowledgement. |
| E1.3 Recoverable drafts | Unsent text and attachment references survive recoverable disconnects | State contract; request outcome lookup; independent of geometry persistence | Lost submission acknowledgement does not duplicate a message; text typed after send is not cleared by the earlier acknowledgement. |
| E1.4 Navigation and focus | Work cards, open-panel previews, search and Artifacts & Sources find existing items | E1.1–3; authorized source APIs | Reopening focuses an existing panel; unavailable references do not expose stale private content; focus/restore preserves manual layout. |
| E1.5 Commander presentation | Compact, expanded, maximized and tucked chat; independently visible blob/captions and recoverable unified tray control | E1.1; E1.3 for durable drafts; E8.1 preferences; independent of live voice adapter | Aligned composer, internal history scroll, drag/resize, distinct Tuck/Maximize/Compact controls; max-to-compact restores bottom; hiding never ends voice/work; no lost restore control. |
| E1.6 Motion and viewport interaction | Coherent panel/tray/preview transitions and viewport-aware Commander layout operations | E1.1, E1.4–5; E2.1 for authorized target projection | Apply motion matrix; actual visibility matches animation; all entry routes share lifecycle; reduced-motion/keyboard/touch parity; camera does not fight active input. |
| E2.1 Context bridge | “Change this” reaches the exact selected item/version | BASE shared type/resolver; E1.1 measured viewport + E1.3/1 snapshot for client capture; no E1.6 start gate | Capture target at submission; later selection changes do not retarget it; summaries preserve corrected decisions and source references. |
| E2.2 Request/result integration | Commander delegates and reports accepted, running and completed work accurately | E2.1; accepted execution route; RP-CMD for distributed acceptance | Lost acknowledgement, duplicate request and late result tests; cancellation and correction remain separate; distributed claims wait for cutover evidence. |
| E2.3 Catch-up | Returning shows current work without replaying actions | E1.2, E2.2/1; E7.3/1 attention projection for integrated completion; canonical event recovery | Missed/duplicate/out-of-order delivery converges to canonical state; context restoration cannot initiate a second task. |
| E2.4 Task conversation panel | Every task entry opens the same usable conversation window with agent messages, fixed reply row and collapsed supporting details | E1.1, E1.3–4; existing authorized task APIs; E2.2 only for new delegated execution | Work/Inbox/attention/source link/overview share identity; drag, eight resize edges, pin, maximize/restore, minimize/restore and close work through every route; task reply destination explicit. |
| E3.1 Voice connection | OpenAI realtime works with the same Commander conversation | E2.1–2; company provider/Secrets setup; RP-CMD only for distributed execution | Test scoped credential issuance, failed connection, expiry, confirmed result speech and text fallback. No long-lived secret in client state. |
| E3.2 Voice continuity | Interrupt, mute, silence, end and reconnect behave distinctly | E3.1 | Interrupt audio without cancelling work; suppress old-conversation audio; reconcile requests before retry; save transcript, audio only opt-in. |
| E3.3 Additional realtime providers | Gemini and ElevenLabs can use the same governed interface | E3.1–2 | Provider-specific capability/interrupt/reconnect tests; unsupported features visible; no automatic routing to unapproved providers. |
| E3.4 Later speech modes | Separate recognition/synthesis and local speech use the same context/action contracts | E3.1–2; provider adapters | Validate actual supported combinations and local requirements; local speech does not imply offline control-plane execution. |
| E4.1 Canonical artifact intake | Upload or generation produces a durable original and status | Assets/artifact schemas; E2.2 only for generated job results | Reconcile storage versus database publication; duplicate completion cannot publish twice; cancellation preserves published outputs. |
| E4.2 Format derivatives | Supported files display previews and extraction independently | E4.1; format matrix | Failed preview leaves original downloadable; retry only failed stage; fixtures cover damaged, locked, oversized and unsupported files. |
| E4.3 Revisions and generation | User compares/reuses versions and generated outputs | E4.1–2; governed generation adapters | Preserve source/version provenance; uncertain billable generation checked before retry; format coverage has explicit disposition, not universal editing. |
| E5.1 Reviewed interactive blocks | Charts/calculators/forms send relevant state to Commander | E1.1, E1.2 checkpoints, E1.3/1, E2.1, E4 source references; E2.2 + E1.3/2 for action recovery | Local calculations do not mutate records; live refresh preserves local inputs; button and conversational writes share authorization. |
| E5.2 Isolated custom tools | Custom executable content runs in a restricted panel | E5.1; isolated runtime boundary | Deny unauthorized origin/messages/actions; reject stale/revoked capability; bound resources; renderer failure preserves state and host operation. |
| E6.0 Browser compatibility qualification | A proven Browser Use attachment and live-control path within worker containment | E0.1; engineering-gates.md | Demonstrate local and cloud attach/view/pause/resume, reject stale commands and unauthorized access, preserve debugger launch guards; record unsupported capabilities before E6.1–4 implementation. |
| E6.1 Browser automation | Browser Use controls the assigned task browser through governed execution | E0.1; E6.0; worker/browser contract | Preserve launch guards, egress and account scope; separate tasks cannot accidentally control the same live session. |
| E6.2 Cloud live view/control | User watches, pauses, controls and resumes the cloud browser | E6.1; headed stream transport | Worker acknowledges ownership; stale commands rejected; resume observes changes; stream loss does not imply task termination. |
| E6.3 Local remote view/control | Another authorized device accesses an online local worker browser | E6.1; outbound authenticated transport | No public debugger port; disconnect pauses human input; reconnect verifies identity and ownership; only authorized browser content is exposed. |
| E6.4 Browser lifecycle/files | Multiple sessions, files, idle teardown and saved authorized profiles work coherently | E6.2–3; E4; existing access controls | Closing panel hides session; revocation blocks further actions; downloads become artifacts; uncertain form submissions are reconciled. |
| E7.1 Conversational routines | Commander creates/edits/pauses an authorized routine | E2.2; existing scheduler API | Record schedule, timezone, owner, output and authority; duplicate start creates one run; failure/retry cannot duplicate completed effects. |
| E7.2 Proactive follow-up | Completed work can trigger authorized next steps | E7.1; durable trigger intent | Repair missed events, coalesce duplicates, bound retries; do not rely solely on best-effort UI events. |
| E7.3 Unified attention | Needs-you, ready and summaries follow consistent delivery preferences | E8.1/1 preferences contract; E1.3 structured answers; shared hub upgrade; E3 only for speech | Migrate old silent intent explicitly; durable item creation differs from interruption; direct answers remain available; avoid repeated cross-device announcements. |
| E8.1 Settings and provider readiness | Universe/Commander/Providers/Budget controls have correct ownership | settings contract; affected slices | Defaults, reset, scope and effective timing tested; provider test explicit; budget controls stay in Budget & caps. |
| E8.2 Operational release gate | Long work sessions remain usable and recoverable | All release-included slices | Connected user journeys, company isolation, resource budgets, observability, compatibility migrations and rollback verified on the combined base. |

## UI decision traceability

The [consolidated experience decisions](ui-review-decisions.md) and [motion matrix](motion-and-interaction.md) are acceptance inputs, not a claim that E1.0 is closed. These document-local additions create no issue tickets or implementation branch. No V1/V2 assignment changes.

| Decision | Owning slices | Additional acceptance / dependency |
|---|---|---|
| U01 Brand, arrival, return | E1.0–1, E2.3, E8.1 | Actual AoA logo/red theme; no default slogan; blob + compact chat + expanded tray; restore preferences without starting mic. |
| U02 Centered tray and unified Commander | E1.4–6, E8.1 | Stationary logo through collapse; one menu; nonzero badges; predictable chat toggle; histories and independent visibility controls. |
| U03 Overview and optional rails | E1.4, E1.6, E7.3, E8.1 | Single registry/count; readable paged tiles; no horizontal strip; minimized recovery and hidden-rail alternatives; previews contain no live controls. |
| U04 Shared panel lifecycle and sizes | E1.1–2, E1.6, E2.4 | One controller across all routes/types; pin/minimize/close distinct; all resize edges; exact maximize restore; no oversized task panel. |
| U05 Viewport context and highlighting | E1.6, E2.1 | Usable screen/zoom/visible bounds; captured authorized identity/version; requested target auto-reveal then glow; header-only selection; background events do not steal view. |
| U06 Task chat and material destinations | E2.4, E4.1–3, E5.1–2 | Fixed reply composer and internal scroll; task/Commander/artifact destinations clear; immutable version and generated-content authority unchanged. |
| U07 Chat/blob/captions | E1.3, E1.5–6, E3.2, E8.1 | Independent visibility; caption placement and no duplicate transcript; continuous hover control path; movable/resizable blob/chat; no rectangular orb hover. |
| U08 Voice lifecycle and attention | E3.1–4, E6.2–4, E7.3 | Actual adapter states; end vs mute/silence; same-conversation reconnect; movable bottom-right questions; canonical Inbox acknowledgement. |
| U09 Themes/settings/persistence | E1.2, E8.1 | All retained settings despite mock regressions; correct owners/defaults/resets, top-only initial dock, no preference-driven mic start. |
| U10 Accessibility, motion and gaps | E1.0, E1.6, E8.2 | Embedded-host entry-route reproduction, responsive/accessibility/reduced-motion tests and measured bounds; mocks do not close runtime gates. |

E1.0 now has a reviewed core design direction and a consolidated specification. It still owes complete loading/error/offline/revoked/conflict/narrow-screen/keyboard state review and reconciliation of settings/previews omitted by the clean rebuild. Track intermittent task controls as an open defect; standalone passing checks are insufficient closure evidence.

E1.5 and E2.4 may build on existing typed conversation/task APIs; they must not be unnecessarily blocked on distributed Commander cutover. Actual distributed execution in E2.2 and browser compatibility E6.0 retain their gates. Settings and accessibility travel with their consuming slices, not a later cosmetic epic.

## Source entry points for detailed plans

Existing paths are investigation anchors, not instructions to force unrelated behavior into those files.

- Canvas patterns: `ui/src/components/hub/HubShell.tsx`, `ui/src/hooks/useHomeBoardLayout.ts`, `ui/src/pages/SettingsPage.tsx`; create a dedicated Universe component/state module rather than duplicating Home state.
- Context/execution: `server/src/services/internal-agent/` and current replatform routing/result contracts. Final shared request bindings must be recorded before E2 implementation.
- Artifacts: `packages/db/src/schema/assets.ts`, `packages/db/src/schema/artifacts.ts`, `ui/src/api/assets.ts`, `ui/src/api/artifacts.ts`; distinguish asset publication from artifact versioning.
- Routines: `packages/db/src/schema/routines.ts`, `ui/src/api/routines.ts`, existing scheduler/service routes.
- Notifications: `ui/src/lib/hub-toast-bridge.ts` and source/delivery files identified in [notification review](notification-review.md).
- Browser: replatform `packages/browser-runtime/`; cloud and local live-view adapters are new integration work, not proof supplied by recorded video.
- Realtime: `server/src/services/live-events.ts`, `server/src/realtime/live-events-ws.ts`; critical command state remains independently durable.

## Proposed internal sequence

Release assignments are now drafted in the [V1/V2 recommendation](release-plans/README.md); every existing slice has an [individual plan](slice-plans/README.md). Allocation still requires product review. The sequence below is subordinate to the agreed rule: complete and verify all V1 before beginning V2 implementation.

1. Complete technical contract planning and E0.1 dependency binding. Then complete E1.0 UI design/review before UI implementation. Produce detailed plans for E1/E2 and the E6.0 qualification; build the typed conversation → task → artifact → reconnect journey after the applicable design gate.
2. Add E3 OpenAI voice and E4 artifact processing to that journey. E8 settings and telemetry accompany their consuming slices.
3. Develop E5, E6 and E7 against their explicit dependencies; do not wait for an unrelated subsystem. Integrate regularly on the verified Universe base.
4. Add the other realtime providers and later speech modes according to grooming allocation. Their inclusion is preserved even if they land in different versions.
5. Apply E8.2 to every release candidate. Full IAM, shared communications, meetings/calendar/email and backend app provisioning stay separate workstreams with explicit interfaces.

## Readiness checklist for each coding plan

- [ ] Exact baseline and existing behavior established; unresolved upstream dependency identified by owning workstream.
- [ ] New/modified files, schemas, API/event bindings and authority rules specified together.
- [ ] Tests demonstrate expected user behavior, failure recovery and forbidden cross-company access.
- [ ] Numerical payload, concurrency, timing and retention bounds recorded with measurement environment. A slice cannot pass this gate with unspecified limits.
- [ ] Migration, rollback and rollout flag described; preserved data remains readable after disabling the feature.
- [ ] Focused tests plus repository typecheck, test suite and build run on integrated code; missing verification reported.

## Questions and decisions

Deferred feature register: [multi-screen Universe](master-scope.md#multi-screen-universe--deferred-after-desktop-app) is recorded for reconsideration after the desktop app, with version two only tentative. Local and cloud window behavior, linked viewports, panel transfer, voice ownership and display-disconnect recovery require later design. Do not add this to current E1 acceptance, create an implementation slice, or increase the current 31-slice count until separately groomed.

No blocking question is needed to draft these epics. Before assigning release scope, confirm whether the first release must include both local and cloud interactive browsing and all three realtime providers. Recommendation: retain all in the master scope and decide their release grouping during grooming from dependency evidence; do not silently reduce scope now.

Cloud commercial ownership/pricing remains deferred. Engineering should bring a concrete tradeoff if local streaming cannot match an agreed interaction, if credential routing conflicts with policy, or if cost changes rollout feasibility. Do not ask the user to select internal libraries again.

## Review status

Coverage checked against the master scope, companion contracts and decision review. This is a documentation-only grooming draft. No application code, tickets or branches were created; runtime typecheck/tests/build were not run for this draft. Individual slice work increments and a release allocation recommendation are now linked above. Exact executable code/test bindings remain subject to the coding-readiness gate.
