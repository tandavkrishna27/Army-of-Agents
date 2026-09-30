# Universe — user acceptance test plan

September 12, 2026. **Planning only; every run is `not_run`; no product acceptance or certification is recorded.** This formalizes review finding M13 against packet `f63b84461341fc93f65417103fc8e57357a93939` and source base `183e46a9c65fc3105c7e3d125629276814df7dbb`. It adds acceptance records to existing work, not slices or increments: 31 slices, 30 V1, E3.4 alone V2, 69 increments unchanged.

Authority: [accepted UI decisions U01–U10](ui-review-decisions.md), [master §11](master-scope.md#11-production-and-acceptance-requirements), [motion](motion-and-interaction.md), [UI states](ui-state-review.md), [settings](settings-contract.md), [formats](format-matrix.md), existing slice/coding plans and locked repository decisions. This document specifies future checks; current runtime behavior remains governed by `CLAUDE.md` and actual source.

## Acceptance roles, entry conditions and evidence

The **product acceptor is TK or an explicitly delegated product representative**. No delegation or named tester assignment is implied here. A representative operator executes the user scripts; an authorized company administrator executes restricted configuration/revocation steps; an engineering qualification operator prepares disposable fixtures, controlled failures and canonical evidence. The engineering reviewer verifies technical results. Record actual identities and delegation when assigned. Developer-run Playwright, visual inspection by an agent, and provider qualification do not substitute for the product acceptor's decision.

Run mapped scripts during each slice's acceptance, then rerun connected journeys on the integrated candidate in E8.2. E8.2 aggregates prior slice records and checks integration; it is not the first opportunity for product review. A backend-only producer is accepted through documentary/technical evidence and its consuming user journey, not an invented producer screen. Partial producer evidence may be recorded before its consumer exists; acceptance stays blocked until the required consumer demonstration exists.

Before a run, record the candidate SHA, source/replatform ancestry, host build, OS/browser, viewport/text scale/input method, deployment mode, worker build, provider/model/capability versions, gate evidence and date. Record the accepted mock revision/file/hash and product review record. The local `universe-clean-panels.html` mentioned in U10 is a reference, **not a signed-off production baseline**. Resolve and preserve the actual reviewed asset and earlier omitted-state evidence; if unavailable, mark design comparison blocked. U01–U10 remain the intent even where the rebuild lost settings, previews or motion.

Engineering prepares disposable companies A/B, two authorized user roles plus a denied caller, representative Tasks with conversations/materials, an immutable artifact with two versions, a needs-you question linked to a Task, routine/result items, long content and unsent drafts. Record IDs and permissions; do not use the user's main company. For repeated five-route checks, restore the same fixture before each route so a resolved question does not remove its entry. Fixtures and failure controls must be documented on the candidate, not assumed to exist. Label simulated states and real execution separately. No paid sessions, external submissions or production changes are authorized by this plan; live qualification follows the separately authorized bounded fixture and spend cap.

For every numbered step, retain expected versus actual observations and relevant stable evidence: screen/video for interaction; canonical Task/request/version/answer IDs and redacted traces for effects; exact technical logs for isolation or resource claims. Never include credentials or unnecessary private content/audio. Missing prerequisites mean `blocked`; an unattempted run is `not_run`; neither is a pass. A missing promised control or wrong result on a ready candidate is `fail`, not an unsupported escape hatch.

## Numbered user scripts

Each script below has a defined role, setup, actions and pass criteria. Run variants get separate record IDs (for example `UAT-04/Work/zoomed/reopen`); do not collapse a failed variant into a passing overall label. All scripts start `not_run` in this planning packet.

### UAT-01 — Documentary base acceptance

**Role:** engineering reviewer with product acceptor. **Setup:** refreshed E0.1 binding manifest and gate register.

1. Read the proposed source/replatform/main pins and verify every required producer, consumer, permission owner, collision disposition and gate evidence reference against that tree.
2. Check all 31 slice IDs, 69 increments, migration/rollback responsibilities and unresolved owners. Confirm premature implementation remains excluded unless separately dispositioned.
3. Record the accepted baseline or exact unresolved dependency, with reviewer and product acceptor decisions.

**Pass:** manifest is reviewable, accurately scoped and explicitly accepted; no unassigned or unevidenced gate is represented as closed. This is E0.1 documentary acceptance and requires no runtime screen. It does not close later runtime gates.

### UAT-02 — Accepted design and omitted-state reconciliation

**Role:** representative operator and product acceptor. **Setup:** versioned review mock, U01–U10, earlier mock inventory and integrated-host candidate when available.

1. Walk arrival, tray, panels, chat/blob/captions, materials, browser, attention and Settings against the accepted decisions. Record each difference and its owning existing slice.
2. Review empty/loading/waiting/stale/error/offline/revoked/conflict states and narrow-screen/keyboard equivalents using identified fixtures. Distinguish illustrative mock state from actual host behavior.
3. Compare the rebuild with earlier settings, previews and motion evidence; use the complete settings field table, not just controls visible in the clean mock. Record restored requirements or open defects.
4. Review UAT-04's actual-host route results. Keep the intermittent task-controls defect open until all variants pass and product review accepts the reproduction/fix evidence.

**Pass:** product acceptor records the design baseline and all required states; omitted requirements have been restored in the candidate. Mock acceptance and actual-host acceptance are separate records. A standalone screenshot or prior passing sequence cannot close the intermittent defect.

### UAT-03 — Arrival, tray, search and recovery

**Role:** representative operator. **Setup:** fresh and returning conversations; open, minimized and off-screen panels; nonzero and zero attention counts.

1. Open Universe. Check actual AoA brand/red dot, expanded top-centered tray, blob and compact input together, without a mandatory slogan/briefing. Return with saved preferences and verify voice remains disconnected.
2. Collapse/expand using the stationary logo; enable Auto-hide, manually collapse while pointer remains still, then re-enter/focus/tap. Open one menu then another and dismiss by selection/Escape/outside click; verify focus return.
3. Use Commander primary control to restore hidden chat, bring covered chat forward, then tuck frontmost chat. Use its adjacent menu for Chat/Blob/Captions and conversation history independently.
4. Open the complete Open panels overview, find a focused/open/minimized item, page/search as supported, select and close it. Verify stable order and reuse. Find existing goals, discussions, notes, reminders, references, memory and activity through their relevant menus.
5. Set each rail to Auto/Always show/Hidden; preview by pointer/keyboard/tap, then open work. With rails hidden, recover through tray/Inbox. Check empty counts and absence of fake items or duplicate live preview controls.

**Pass:** controls stay reachable and predictable, menus do not compete, previews do not flicker or approve work, and no visual action starts microphone capture or execution.

### UAT-04 — Task panel from every entry route

**Role:** representative operator; engineering operator captures reproduction. **Setup:** one Task reachable from **Work, Inbox, Needs you attention, artifact source-task link, and Open panels overview** in the actual embedded host.

1. For each of the five routes, open that same Task; verify title/status/responsible agent, scrollable messages, fixed Add/message/Send row and collapsed supporting details. Observe one stable panel identity when entering again.
2. Type/select text, use buttons, and scroll long messages. Drag only the header, then resize using each of eight edges/corners. Verify content interactions never drag the panel/canvas and the reply destination explicitly names the Task.
3. Select, pin/unpin, move manually, maximize/restore, minimize/restore through overview, close and reopen. Verify saved draft/geometry, expected registry membership and distinct accessible control names; closing does not cancel Task work.
4. Repeat steps 1–3 for every route after reopen, deliberate pan/zoom and overlap with another panel; include pointer cancellation/blur and keyboard/touch alternatives. Preserve video of any intermittent failure and the precise route/state chain.

**Pass:** every route/state variant has working controls, no duplicate Task view, readable bounded size/internal scrolling, exact recoverable geometry and no lost draft. The original intermittent defect closes only with reproducible actual-host evidence and explicit product acceptance; a subset of routes passing is insufficient.

### UAT-05 — Saved layouts, drafts and uncertain sends

**Role:** representative operator with engineering failure support. **Setup:** same conversation in two tabs; documented ack-drop and offline fixtures.

1. Move/minimize a panel, pan/zoom to a nondefault camera, focus then maximize another panel, and type an unsent draft with attachment references. Save/reload, restore the maximized panel and reopen at a smaller viewport. Verify acknowledged camera, selection, stacking, maximized state, normal geometry and draft; safe clamping must not destroy preferred dimensions/camera or trigger a save merely from hydration.
2. Edit the same layout/preferences in both tabs; make the second write stale. Observe conflict and recover both edits without silently overwriting the newer server state.
3. Send Task/Commander text; have engineering drop the acknowledgement after commit. Immediately type new text. Reconnect and check canonical outcome before any retry; verify one message/action and retained newer typing.
4. Repeat with failed save/send, destination switch and company switch. Recover edits in their original authorized destination; no cross-company draft/attachment leakage.

**Pass:** saved means acknowledged, failures/conflicts remain visible, retries do not duplicate admitted work, and renderer/reload lifetimes cannot erase recoverable state.

### UAT-06 — Exact context, Commander action and return

**Role:** representative operator; authorized administrator for revocation. **Setup:** two Tasks/artifact versions, pinned/manual panels and a controlled delayed result.

1. Select version A, ask Commander to change/explain this, then immediately select version B. Inspect the visible response and canonical request/result references: submitted target remains A.
2. Ask Commander to reveal/highlight an off-screen item, then to fit/arrange. Test while typing/dragging and with pinned/manually placed panels. Undo a layout action.
3. Leave and return during work; engineering drops/duplicates/reorders events. Compare catch-up with canonical state, including a late result from the prior conversation.
4. Revoke access while a context reference is selected, then submit/retry. Verify refusal/redaction rather than stale private content or unauthorized execution.

**Pass:** authorization is rechecked, explicit targets auto-reveal readably with distinct fading reference glow, routine updates do not steal viewport, and catch-up neither reexecutes work nor claims completion without canonical evidence.

### UAT-07 — Chat, blob and captions

**Role:** representative operator. **Setup:** long history, draft, captions fixture and separately qualified active voice for live variants.

1. Chain Compact → Expanded → Maximize → Restore → Compact → Tuck → tray restore. Move/resize expanded chat; verify history scroll, fixed composer, draft/cursor and bottom placement on Compact.
2. Toggle Chat/Blob/Captions independently; move/resize blob and reset position where relevant. Traverse hover/focus/tap controls continuously without losing the hit area; verify no permanent resize glyph or rectangular hover background.
3. Select/copy captions; switch location/size and hide blob. Check bottom fallback and that expanded history incorporates live text without duplicate external transcript.
4. Repeat visibility changes with a qualified voice connection. Observe that hiding does not end voice/work; showing a surface while disconnected never connects it.

**Pass:** presentations are independently recoverable and transcript/history remain one conversation. Live-state claims require UAT-08 evidence; a caption fixture proves presentation only.

### UAT-08 — Real voice conversation and work

**Role:** representative operator with qualified voice operator. **Setup:** VOICE/CMD and relevant credential/approval gates, explicit session authorization and spend limit. Run OpenAI, Gemini and ElevenLabs as separately identified provider variants.

1. Start voice explicitly on the current conversation; observe connecting/listening/thinking/speaking and actual mic/playback. Speak an authorized request yielding a Task and artifact, and verify confirmed outcome speech against Task/result/version IDs.
2. Interrupt speech, mute input, silence output and End voice in separate trials. Verify each actual effect; work continues unless separately cancelled, and mute does not promise zero usage.
3. Reconnect to the same conversation after failure/expiry and dropped acknowledgement; inspect outcome first. Switch conversation/provider with a pending result and confirm old audio stops and late result retains origin.
4. Revoke the connection or reach the approved budget stop; observe actionable failure and text fallback without credential leakage or an unapproved provider fallback. Inspect transcript retention/audio opt-in disclosure.

**Pass:** each provider's claimed capabilities, voices/languages and recovery work on actual qualified versions; unsupported capabilities are disclosed. Three independent records are required for V1. CLI readiness, fake transcripts, mocks and one provider passing cannot certify the others.

### UAT-09 — Provider readiness and scope

**Role:** authorized company administrator plus representative restricted user. **Setup:** CLI-ready/voice-unconfigured vendor, enabled and revoked connections, companies A/B.

1. Open Settings > Providers without running a test. Check separate capability readiness/owner/scope, last check, supported versus validated model/voice/language, retention/region and usage links; verify no automatic mic/billable probe.
2. Under separate live authorization, run an explicit capability test and inspect truthful success/failure. Open Budget & caps through its link and verify spending edits remain there.
3. Switch company and role; attempt an unauthorized shared/default/provider edit. Revoke a disposable provider connection and observe active/new session enforcement while personal preferences and authorized work survive.

**Pass:** readiness is capability-specific and company-scoped, restricted edits are denied, Secrets stay hidden, and provider/commercial availability is not inferred from a CLI login.

### UAT-10 — Material intake and failed previews

**Role:** representative operator with converter failure support. **Setup:** accepted format matrix fixtures, including damaged/locked/oversized/unsupported files.

1. Drop a file on canvas, then attach one to a composer. Check displayed destination: material intake versus draft context; neither alone starts a job.
2. Upload/retry/cancel the documented fixture stages and reopen the published item. Check durable original identity, source provenance and cancellation behavior.
3. For every accepted format-matrix row, record parse/preview/edit/export independently. Fail preview/extraction separately; download the original and verify its hash, then retry only the failed stage.
4. Try a revoked/other-company reference. Check original, preview, extraction/search and thumbnail access remain denied without stale content.

**Pass:** original survives derivative failure, publication retries do not duplicate it, and each format claim has evidence or its contract-defined limitation. An unavailable promised format is a failure/blocker, not a universal editing claim.

### UAT-11 — Versions, comparison and generated outputs

**Role:** representative operator with authorized generation fixture. **Setup:** two immutable versions and separately approved supported generation route.

1. Open exact version/source Task, compare versions, create a revision and reopen the original. Choose the winning branch explicitly; verify no automatic merge or mutation of the prior version.
2. Export through authorized controls and inspect source/version provenance.
3. Lose the result acknowledgement during permitted generation; read canonical outcome before retry. Verify one paid/admitted result where the contract can prove it and honest uncertainty otherwise.

4. With the separately authorized failure fixture from [worker publication](worker-publication-plan.md), interrupt publication after durable copy and after canonical commit. Restore the view: one result is recovered without new generation; a delayed reply repairs to the same version.
5. Cancel before publication, then after publication. The first prevents a new result; the second preserves the saved result. Expire the temporary worker source after successful publication and confirm the canonical download still works. Revoke source access during processing and verify no late private preview/index disclosure. Record simulated versus real evidence distinctly.

**Pass:** immutable identity and source links survive comparison/export/recovery. Execute only generation supported by locked Decision #104 and E4.3's approved scope; blocked upstream generation cannot be certified through a fake preview or broadened extraction path.

### UAT-12 — Reviewed blocks and isolated tools

**Role:** representative operator with authorized restricted-tool fixture. **Setup:** each reviewed block schema, isolated-host qualification and capability/approval test accounts.

1. Enter local values into charts/calculators/forms, refresh their sources, suspend/reopen their renderer and ask Commander about current state. Check retained inputs/checkpoints and captured source/version.
2. Perform a local calculation, then request a governed write through button and conversation. Verify local state alone cannot mutate records, while authorized writes share approval and canonical result behavior.
3. With engineering's bounded denied-origin/stale/revoked capability fixtures, attempt the same write. Fail/restart the renderer and reach the qualified resource bound.

**Pass:** host remains usable, state is recoverable, denied actions have no effect and granted actions are auditable. Actual origin/CSP/authority evidence is attached from engineering qualification; operator-visible success alone does not certify isolation.

### UAT-13 — Local/cloud browser pause, change and resume

**Role:** representative operator with qualified browser operator. **Setup:** BROWSER/APPROVAL plus applicable CLOUD gates; actual Browser Use, local worker and cloud worker; authorized harmless test page.

1. In separate local and cloud variants, start the admitted browser task and open its real stream. Verify task/session identity and observe the agent's page changes.
2. Pause/take control; wait for worker acknowledgement, make a permitted page change, then resume. Verify the agent reobserves the changed page and only the acknowledged controller acts.
3. Disconnect stream, delay old-controller input, revoke access and reconnect in separate trials. Observe disabled stale input and fresh ownership check; stream loss does not report Task completion/termination.
4. For local remote access, use a second authorized device and verify only the authorized tab is exposed. Attach engineering proof of outbound transport/launch containment and stale-command rejection.

**Pass:** both locations perform actual attach/view/handoff/recovery without public debugger or desktop leakage. E6.0 compatibility evidence is a prerequisite and is witnessed through this consumer journey; screenshots/video playback cannot qualify live control.

### UAT-14 — Browser sessions, files and saved profiles

**Role:** representative operator and authorized profile administrator. **Setup:** qualified local/cloud sessions, distinct tasks and approved saved-profile fixture; no real external form submission unless expressly authorized.

1. Open multiple authorized sessions; verify task/account separation. Close/minimize/reopen a panel and distinguish view lifetime from session/Task lifetime; exercise documented idle teardown.
2. Upload/download a test file through the browser and reopen the resulting artifact with provenance. Reconcile a controlled uncertain form action before any retry.
3. Save/reuse a permitted profile, expire/revoke/purge it and attempt reuse from an unauthorized role/company. Check disclosed lifetime and actual policy evidence.

**Pass:** each supported location preserves file/session authority, saved-profile behavior matches encryption/retention/purge/audit evidence and revocation blocks reuse. Signed-out browsing is not a substitute for PROFILE qualification.

### UAT-15 — Routines and durable follow-up

**Role:** representative operator with scheduler qualification operator. **Setup:** authorized standing routine, test clock/timezone cases and each terminal-source fixture from E7.2's producer inventory.

1. Ask Commander to create/edit/pause a routine; verify schedule, timezone, owner, output and authority before execution. Repeat the same request and inspect one canonical routine/run.
2. Exercise due-time/DST/overlap cases through the qualified clock fixture. Restart after claim, then observe repair without a lost occurrence or repeated completed effect.
3. Finish each eligible terminal-source variant while all UI events are dropped, restart the durable drain and return. Verify one authorized follow-up and current outcome in the UI.
4. Revoke authority or hit a budget stop before queued follow-up; verify no unauthorized dispatch. Returning, closing or seeing a result never grants new routine authority.

**Pass:** operator-visible routine/follow-up outcome agrees with durable occurrence/terminal-marker evidence for every inventoried source, including restart and missed-event repair. A toast or developer DB check alone does not close product acceptance.

### UAT-16 — Needs you, Ready, Coming up and quiet delivery

**Role:** representative operator on two authorized devices. **Setup:** canonical attention/question fixtures, shared quiet policy and explicit sound/speech consent variants.

1. Preview Needs you/Ready/Coming up, open details and move the compact question. Verify no forced central modal/input obstruction; seeing/opening/closing does not resolve or approve.
2. Enter an answer; exercise acknowledged success, failed save, stale two-tab answer and lost acknowledgement. Confirm the same canonical Inbox question updates once, with recoverable newer draft and no premature resolution.
3. Separately dismiss, snooze, mark seen and resolve appropriate fixture types. Verify their different canonical effects.
4. Enable silent/digest/quiet hours/DND variants and trigger routine/proactive events on two devices. Inspect durable Inbox items, direct replies and optional announcements; confirm at most one eligible unsolicited attempt and no consent gained by migration/catch-up.

**Pass:** attention is useful without false completion or duplicate interruption; sound/speech follows shared delivery authority. Backend durable answer/delivery evidence is accepted through these visible actions.

### UAT-17 — Complete settings, saving and reset

**Role:** representative operator; administrator for shared fields. **Setup:** complete [settings field specification](settings-contract.md#field-specification--recommended-defaults), earlier-mock omission inventory, second user/company/device and save-failure fixture.

1. Create a field-by-field run row for every retained setting, including theme/density/motion, dock, placement, chat/blob/captions, workspace/rails, accent/blob style/color, grid/intensity/snap/arrangement, voice/provider/language/style, sound/announcements, browser quality and device audio. Compare with the old mock/rebuild gap inventory; omitted controls remain failures.
2. Change one field at a time, observe its owning surface and documented effective timing, save, reload and verify. Check light/dark/system inheritance and OS reduced-motion precedence. Top remains the only initial dock placement.
3. Verify personal/company/device and Commander shared scopes with the second user/company/device. Unknown device IDs fall back visibly. Shared defaults use the authorized owner and audited version; Providers/Budget editors remain separate.
4. Fail a save, create a concurrent revision conflict, and reset each named section. Verify unsaved state/recoverable edits, retained unrelated choices and no deletion of work/drafts/layout/credentials. Reload and confirm no microphone auto-start.

**Pass:** every retained field has tested consumption/scope/default/reset/effective-time evidence. Merely storing a field or showing the reduced rebuilt mock does not pass; exact numeric tuning uses qualified limits, not invented values.

### UAT-18 — Accessibility, crowded canvas and recovery

**Role:** representative operator using keyboard/pointer/touch with engineering measurement support. **Setup:** E8.2/2 workload and qualified device/resource limits.

1. At 1440×900, 1024×768 and 390×844 CSS pixels, repeat core tray, Task, chat and attention paths using keyboard/touch, 200% text scale and OS reduced motion. Check focus visibility/return, contrast, readable titles, eight resize alternatives and reachable controls.
2. Cancel a drag with lost capture/blur; resize viewport and restore panels. Verify no stuck shield/overlay, inaccessible geometry or loss of draft. Native zoom and embedded browser input remain functional.
3. Execute E8.2/2's 60-minute/100-registry-panel workload with its cycle counts and bounded live sessions; record actual counts and measurement environment. Observe fatigue/readability and responsiveness while engineering records heap/listeners/frame/session/queue measurements.

**Pass:** essential tasks remain usable and recoverable, reduced-motion parity is preserved, and measured resource behavior meets reviewed candidate limits. Static screenshots or 100 registered references cannot imply 100 live streams or unmeasured performance guarantees.

### UAT-19 — Integrated candidate, isolation and rollback acceptance

**Role:** representative operator, engineering release reviewer and product acceptor. **Setup:** same immutable candidate manifest, per-slice records and authorized disposable recovery environment.

1. Run the nine master §11 journeys below as connected sequences on this candidate, linking existing script run IDs and recording any new integration failure. Match all 30 V1 slice increments to their evidence and acceptance records.
2. During active work, switch/revoke identities and replay denied references under the authorized fixture. Observe UI/cache/stream/input enforcement; engineering attaches canonical denial and no-leak evidence.
3. Rehearse fresh migration, upgrade, feature-disable, compatible rollback and re-enable under E8.2/2. Verify canonical jobs, drafts, layouts, immutable artifacts, routine receipts and silent intent survive as specified. Do not execute a destructive down migration or production rollback.
4. Review technical checks, every real-provider and both local/cloud browser/profile/host gate, open defects, supported limits and per-slice product records. Record explicit complete/incomplete V1 product decision; retain any failed/blocked/not_run obligations.

**Pass:** same-candidate connected acceptance and all required evidence classes close, with actual TK/delegate approval. This does not authorize publishing/deployment. Any unresolved required V1 obligation blocks complete V1 acceptance and E3.4 start; unrelated V1 work may continue.

### UAT-20 — Later speech modes (V2 only)

**Role:** representative operator with qualified speech operator. **Setup:** explicit accepted complete V1 record, subsequent V2 approval and qualified separate recognition/synthesis or local speech combinations.

1. Select each approved later speech combination and verify actual install/readiness requirements, displayed capability limits and explicit capture consent.
2. Repeat UAT-08's voice→Commander→Task→artifact, interruption, reconnect and revocation steps for each supported combination; verify shared context/request identity.
3. Disconnect the network for the approved local-speech case and verify truthful limits: local speech does not claim offline control-plane execution.

**Pass:** separately recorded V2 capability evidence and product acceptance for the approved combinations. Status remains `not_run` until authorized; this script neither adds E3.4 to V1 nor starts V2.

## Traceability — product decisions and master journeys

These IDs label acceptance runs, not new implementation increments.

| Accepted decision | Required scripts |
|---|---|
| U01 Identity/composition/arrival | UAT-02, UAT-03, UAT-06, UAT-17 |
| U02 Tray/recoverability | UAT-03, UAT-07, UAT-17 |
| U03 Open panels/side previews | UAT-03, UAT-04, UAT-16 |
| U04 Shared panel lifecycle | UAT-04, UAT-05, UAT-18 |
| U05 Canvas/Commander viewport | UAT-04, UAT-06, UAT-18 |
| U06 Task conversations/materials | UAT-04, UAT-10, UAT-11, UAT-12 |
| U07 Chat/blob/captions | UAT-05, UAT-07, UAT-08, UAT-17 |
| U08 Voice/attention | UAT-08, UAT-09, UAT-13, UAT-14, UAT-16; UAT-20 in V2 |
| U09 Preferences/persistence | UAT-02, UAT-05, UAT-09, UAT-17 |
| U10 Accessibility/motion/gaps | UAT-02, UAT-04, UAT-18, UAT-19 |

| Master §11 connected journey | Required connected run |
|---|---|
| J01 Voice → Commander → job → artifact | UAT-08 → UAT-10/UAT-11, observed together in UAT-19 |
| J02 Lost acknowledgement without duplicate execution | UAT-05 → UAT-06/UAT-08/UAT-11, joined in UAT-19 |
| J03 Two-tab/post-submit draft recovery | UAT-05 and UAT-16, joined in UAT-19 |
| J04 Failed preview with downloadable original | UAT-10, repeated in UAT-19 |
| J05 Isolated tool write authorization | UAT-12, repeated in UAT-19 |
| J06 Browser pause/change/resume | UAT-13 and UAT-14, local and cloud, joined in UAT-19 |
| J07 Routine duplicate/missed-event repair | UAT-15 → UAT-16, joined in UAT-19 |
| J08 Revocation in flight | UAT-06/UAT-08/UAT-09/UAT-10/UAT-12/UAT-13/UAT-15, joined in UAT-19 |
| J09 Sustained crowded-canvas resources/accessibility | UAT-18, evidence reviewed in UAT-19 |

## Per-slice acceptance register

Every row inherits the roles, expected results and evidence requirements in its mapped scripts; assign actual people only in the execution record. Engineering reviewer owns technical substantiation; TK/product delegate owns product acceptance. Record every existing increment under its slice; a shared run may support several slices but cannot hide an omitted increment. Current acceptance status for **every row is `not_run`**. Gates and missing prerequisites are recorded when a run is attempted.

| Slice | Release | Required user acceptance / producer evidence | Script mapping |
|---|---|---|---|
| E0.1 | V1 | Reviewed revision/contract/owner manifest; documentary acceptance | UAT-01 |
| E1.0 | V1 | Accepted mock/state baseline, omitted controls reconciliation and actual-host review | UAT-02, UAT-04, UAT-18 |
| E1.1 | V1 | Same shared panel lifecycle across routes, zoom/input/cancel | UAT-03, UAT-04, UAT-18 |
| E1.2 | V1 | Acknowledged geometry/conflict and checkpoint persistence through consumers | UAT-05, UAT-12 |
| E1.3 | V1 | Per-destination drafts and uncertain-send/answer recovery | UAT-05, UAT-16 |
| E1.4 | V1 | Registry/order/search/rail recovery and repeat-entry identity | UAT-03, UAT-04 |
| E1.5 | V1 | Independent chat/blob/captions with retained history/drafts | UAT-07 |
| E1.6 | V1 | Requested viewport actions, manual/pin respect and motion parity | UAT-04, UAT-06, UAT-18 |
| E2.1 | V1 | Exact authorized captured context through Task/version outcomes | UAT-06, UAT-12 |
| E2.2 | V1 | Canonical request/result and real CMD routing, no duplicate admission | UAT-05, UAT-06, UAT-08, UAT-11 |
| E2.3 | V1 | Safe return/snapshot repair without action replay | UAT-06, UAT-16 |
| E2.4 | V1 | Fixed Task composer and all five entry routes after state changes | UAT-04, UAT-05 |
| E3.1 | V1 | Real OpenAI consent, conversation/work handoff and capability readiness | UAT-08/OpenAI, UAT-09 |
| E3.2 | V1 | Actual mute/silence/end/interrupt/reconnect semantics | UAT-07, UAT-08 |
| E3.3 | V1 | Independent real Gemini and ElevenLabs capability acceptance | UAT-08/Gemini, UAT-08/ElevenLabs, UAT-09 |
| E3.4 | V2 | Later qualified speech combinations after complete accepted V1 | UAT-20 |
| E4.1 | V1 | Original publication/retry/cancel/auth through material journey | UAT-10 |
| E4.2 | V1 | Independent format/derivative claims and original recovery | UAT-10 |
| E4.3 | V1 | Immutable revision, comparison/provenance and governed generation recovery | UAT-11 |
| E5.1 | V1 | Reviewed schemas, captured input/checkpoint and governed actions | UAT-12 |
| E5.2 | V1 | Actual host isolation plus user action/failure/revocation journey | UAT-12 |
| E6.0 | V1 | Compatibility/containment evidence consumed by actual local/cloud control | UAT-13 |
| E6.1 | V1 | Browser automation authority and acknowledged resume | UAT-13, UAT-14 |
| E6.2 | V1 | Actual cloud stream/handoff/recovery | UAT-13/cloud |
| E6.3 | V1 | Actual local outbound remote view, no desktop exposure | UAT-13/local |
| E6.4 | V1 | Session/files/authorized saved-profile lifetime qualification | UAT-14 |
| E7.1 | V1 | Schedule/occurrence durability through conversational routine | UAT-15 |
| E7.2 | V1 | Every terminal-source marker through visible follow-up with lost events | UAT-15, UAT-16 |
| E7.3 | V1 | Canonical questions/answers and shared delivery policy | UAT-16, UAT-17 |
| E8.1 | V1 | All retained fields consumed, truthful readiness and scope/reset/migration | UAT-09, UAT-17 |
| E8.2 | V1 | Aggregated per-slice acceptance plus same-candidate journeys/recovery | UAT-18, UAT-19 |

## Run and approval record templates

Copy these templates into the future versioned release evidence, not into a claim that this plan ran. Use `pass`, `fail`, `blocked`, `not_run` consistently. `pass` means all required observations for that record succeeded; `fail` means an attempted requirement differed; `blocked` identifies a missing prerequisite; `not_run` means no attempt. A pending product decision remains `not_run` even if engineering checks passed.

```text
Run ID / script / variant:
Slice IDs and existing increment IDs:
U01–U10 decisions / J01–J09 journeys:
Candidate SHA / source ancestry / migration checksums:
Accepted mock file + revision/hash + actual acceptance reference:
Host/build / OS/browser / viewport/text scale/input method:
Deployment mode / worker build / provider-model-capability versions:
Gate evidence / fixture IDs / failure setup / scope and spend authorization:
Tester role + actual identity / execution timestamp:
Steps: number | expected | actual | evidence reference | status
Overall run status: not_run
Defect/blocker / existing owning slice / exact reproduction / residual limit:
Technical evidence: fixture | integration | real-provider/worker | automated e2e
Engineering reviewer + disposition/date:
Affected evidence invalidated / rerun IDs after changes:
```

```text
Per-slice product acceptance record
Slice / release / all existing increments covered:
Candidate SHA / required script-variant run IDs / technical gate evidence:
Actual operator tester(s) / engineering reviewer:
Open defect or unmet criterion / disposition and owner:
Product acceptor: TK or explicitly delegated product representative
Actual acceptor identity / delegation reference if applicable:
Product status: not_run
Decision: accepted | rejected | blocked | pending
Reason / residual limits explicitly reviewed / evidence reference / date:
```

```text
Integrated E8.2 product approval record
Candidate SHA / release evidence manifest checksum:
30 V1 per-slice acceptance records / J01–J09 connected runs:
U01–U10 actual-host acceptance / intermittent Task-controls closure record:
Full technical checks / real OpenAI, Gemini, ElevenLabs / local + cloud browser:
BASE/DESIGN/CMD/BROWSER/CLOUD/PROFILE/APPROVAL/VOICE/HOST evidence:
Migration/rollback rehearsal / supported formats/workload / unresolved findings:
Engineering qualification status: not_run
Product acceptance status: not_run
Actual TK/delegate identity / delegation reference / decision/date:
Complete V1 accepted: no (pending actual evidence and decision)
Deployment/publishing authorization: separate, not granted by this record
```

Material source/host/provider/mock/contract changes invalidate affected runs; retain prior records and link fresh evidence instead of overwriting history. A waived required V1 obligation cannot be relabeled complete by a tester: record the unresolved requirement and seek an explicit scope decision through the existing product process. This plan itself changes no release allocation.
