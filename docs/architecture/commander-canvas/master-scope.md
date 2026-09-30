# Universe — master scope

**Review clarification:** the main mock and accepted experience decisions remain the design baseline. Additional loading/error/reconnect/narrow-screen states receive consistency review; only material experience or scope changes return to TK. React Flow and real interaction qualification are implementation engineering checks. See the [recorded review boundary](ui-state-review.md#review-boundary-clarified-with-tk); no repeat approval of the main design is required.

**First implementation batch:** [verified planning base and preparation result](first-batch-readiness.md), [remaining state designs](ui-state-review.md), [concrete panel-controller plan](coding-plans/e1-1-canvas-controller.md). The release grouping and slice-branch methodology are accepted; runtime implementation has not begun. The remaining UI states are specified in writing, with visual and actual-host acceptance still pending.

**Accepted release allocation:** [V1/V2 plan](release-plans/README.md) assigns all 31 existing slices exactly once (30 V1; E3.4 only V2); [individual plans](slice-plans/README.md) define their 69 delivery increments. The user has agreed that all V1 must be complete and verified before V2 implementation starts. This supersedes earlier statements that release allocation has not yet been drafted; all unresolved qualification and coding gates remain open.

Latest dependency and task-planning pass: [readiness review](readiness-review.md) and [per-epic preparation plans](implementation-plans/README.md). This supersedes earlier baseline/readiness summaries where newer evidence is explicitly identified; locked product decisions remain unchanged.

Current planning checkpoint: [consolidated technical plan and delivery grouping](technical-plan-summary.md). The core UI direction is now documented in [consolidated experience decisions](ui-review-decisions.md) and [motion/interaction acceptance](motion-and-interaction.md), mapped into [epics and slices](epics-and-slices.md#ui-decision-traceability). Remaining design states, detailed coding plans and verified integration gates remain prerequisites to implementation and release; the mock is not a completed runtime.

See the [integration decision review](integration-decision-review.md) for the verified branch baseline, provisional dependencies and pre-grooming process. The subsequent [publication record](planning-publication.md) records codex/universe-interface from the pinned replatform base; the release allocation is accepted, while runtime implementation remains unauthorized.

The [epic and slice grooming draft](epics-and-slices.md) maps this scope to outcomes, dependencies and acceptance checks. The [coding plans](coding-plans/README.md) and accepted release allocation now supersede that earlier grooming stage.

The [integration contracts](integration-contracts.md) define voice submission, read-only request recovery, browser control ownership and reconnect ordering. Live transport compatibility and replatform cutover remain explicit engineering gates. Complete technical planning first, then review UI designs before UI implementation.

## September 11 naming and canvas decision

**Notification refinement:** upgrade the existing shared hub/delivery foundation and add Universe presentation channels. Separate creating durable attention items from interrupting the user; do not copy the existing Commander silent switch unchanged. Preserve prior user intent through explicit migration. Direct replies are distinct from unsolicited announcements. See [notification code review and acceptance cases](notification-review.md), which supersedes the provisional settings-precedence recommendation.

**Settings direction:** Universe preferences belong in application Settings with a canvas shortcut; shared voice-behavior defaults belong on Commander's agent page. Extend existing Providers with voice capabilities rather than duplicating a catalog. Preserve company credential scope and separate instance operator policy from user preferences. CLI login is not proof of voice API access. See [settings contract](settings-contract.md) for fields, precedence and acceptance cases.

**Browser integration and remote access agreed:** Browser Use is the first browser automation integration direction. Universe must provide live viewing and authorized human input for sessions running on local, company-managed or cloud workers, including accessing an online local worker's browser from another device through hosted Universe. This requires a separate authenticated viewing/input transport; Browser Use alone does not establish the path. No publicly exposed browser debugging endpoint is implied. Replatform retains execution, permissions and artifact authority.

Support multiple independent browser sessions, one per task by default, with multiple tabs where useful. Display task, account, execution location and current controller. Pausing one session affects only that session; hiding its panel does not end execution. Saved profile reuse does not imply a shared live session or simultaneous controllers. On worker disconnect, show unavailable/stale state, reject input until ownership and session state are revalidated, and do not silently create a replacement session or replay pending input. Local access requires the machine and worker to remain online. Transport selection and measurable latency/recovery limits remain engineering work; this capability is planned, not implemented.

**Voice scope clarification:** implement OpenAI Realtime first using a direct provider connection behind the voice adapter. Gemini Live and ElevenLabs realtime conversation integration are also in the intended scope, not merely optional research alternatives. Separate speech-recognition/synthesis pipelines and local speech remain later planned approaches. All share the Commander conversation and governed request contract. The accepted [release allocation](release-plans/README.md) places OpenAI/Gemini/ElevenLabs realtime in V1 and E3.4 split/local speech in V2; implementation order does not change that allocation. Supporting a provider does not imply every model or feature combination is validated.

**Voice lifecycle direction:** microphone mute stops outgoing audio; silencing replies stops audio playback while text/work continue; ending voice closes the audio connection without cancelling authorized jobs. Reconnect checks original requests before retry. Conversation switching stops old audio and establishes the new destination before resuming; late results stay attached to their originating conversation. Muting alone must not be represented as disconnecting or guaranteeing zero provider usage.

**Panel hosting agreed:** first-party AoA components and validated compositions of reviewed blocks use registered renderers. Custom generated executable tools use an isolated iframe runtime and a narrow host capability bridge. Controlled browser sessions retain their separate execution adapter. See [panel contract](panel-contract.md) for implementation defaults and acceptance cases.

Army of Agents remains the product. Universe is the feature name; its navigation entry uses an icon and the label **Universe**, with the same tooltip when collapsed. Commander remains the assistant within the workspace.

**Agreed direction:** React Flow is the canvas foundation. This supersedes the comparison's earlier preference for a custom panel workspace. It is a selected implementation direction, not an installed or validated integration. Task chats, documents and browser surfaces render as custom panels; graph edges and connection handles are absent from the default experience. See the [canvas interaction contract](canvas-interaction-contract.md).

Updated September 11, 2026 following the scope review, repository investigation and TK's follow-up decisions.

This is the canonical scope for subsequent planning. It replaces conflicting recommendations in the chronological experience and technical discussion records. It defines the intended product, not shipped functionality or a claim that all integrations work. Repository-wide locked decisions remain controlling; implementation must reconcile the applicable replatform amendments rather than copying outdated main-branch wording.

The full intended experience remains in scope. The accepted [release allocation](release-plans/README.md) is controlling: all 30 V1 slices must complete before E3.4 V2 implementation; dates depend on qualification.

## 1. Decisions and status

| Status | Meaning |
|---|---|
| Agreed direction | Accepted in the product discussion; carry into implementation planning |
| Recommended design | Engineering or visual recommendation to refine through implementation evidence |
| Existing code | Source exists at a named revision; only explicitly listed tests have been run |
| Separate workstream | Preserve the vision and extension points without making it a prerequisite for personal canvas |
| Open engineering detail | Resolve with code, schemas, measurements and integration ownership; no repeated product approval needed |

**Settled:** realtime voice first with all three voice approaches eventually supported; one Commander conversation and work authority; manual browser pause/take-control/resume is sufficient; interactive tools using existing AoA capabilities; full generated backend applications deferred; immutable originals and versions; autosave; clear request attribution; independent panels and execution; routines within granted authority.

**Confirmed in this update:** retain the conversation transcript by default. AoA raw-audio recording is explicit opt-in. Provider-side retention is a separate disclosed property and must be verified before enabling a provider. Transcript retention still obeys the company's eventual retention/deletion policy; this is not an indefinite-retention decision.

**Multilingual scope:** do not restrict voice to English or Hindi. Expose provider-supported languages through declared capabilities. English and Hindi-English code-switching are recommended initial acceptance fixtures, not a product language restriction or an assertion that all languages/providers behave equally. Extend fixtures to every language for which quality is advertised.

## 2. Product and conversation ownership

Canvas is an optional view of a Commander conversation. Chat and canvas share messages and canonical work references; switching views does not create a new conversation or stop work. Each conversation restores its own personal canvas. No separate canvas naming or creation workflow is required. Home remains a separate product destination.

Switch conversations from within the canvas. The precise title/tray affordance is a visual decision, not a second collection of artifacts. Voice follows the explicitly selected conversation, stops old playback and clearly indicates the new destination. A mid-utterance switch must not silently split, duplicate or send speech into the wrong conversation. Commander may suggest a new conversation or fork; automatic switching/forking is not approved. Fork inheritance of drafts, sources and running-work references remains a bounded design question.

AoA owns canonical tasks, approvals, artifacts, memory, permissions and execution. The canvas presents and requests changes through those systems. The same task opened twice remains one task. A saved panel reference grants no additional access. Company scope and actor visibility apply to every resolution, search result, subscription and action.

Commander coordinates its session helpers, crew, organizational agents and their supporting agents while preserving actual task ownership. Present task, responsible agent and progress first; expand the worker hierarchy when useful. No limit inferred from this design session becomes an AoA concurrency limit.

## 3. Layout, navigation and attention

Agreed visual direction: a cinematic spatial workspace with readable floating work, purposeful Commander presence and direct manipulation. **Universe** is settled as the name; earlier Cockpit/Bridge/Helm labels are historical.

The [consolidated UI decisions](ui-review-decisions.md) are the detailed acceptance specification. They supersede earlier conflicting presentation suggestions in this scope and its history:

- Default expanded top-centered tray, stationary AoA mark toggling balanced wings; no duplicate corner logo, collapse arrow or status sentence. One menu at a time. Auto-hide is optional; other docking edges deferred.
- Unified Commander blob icon, Work, Artifacts & Sources, Inbox, Browser, Settings and one Open panels control. Search and other existing functions remain reachable through menus. No zero badge.
- Open panels is a complete current-conversation registry including focused/minimized views, presented as readable preview tiles with responsive paging, not individual overflowing icons or a horizontal strip. Minimize retains; close removes only the view.
- Optional left shortcuts represent minimized/off-screen open views; right shortcuts show Needs you, Ready and Coming up. Each supports Auto/Always show/Hidden and thumbnail hover/focus/tap access. Hidden rails preserve tray/Inbox access.
- Default centered blob and compact bottom chat are both visible; captions default above compact input. Chat, blob, captions and voice connection are independent. No arrival slogan. Return restores preferences and work without automatically starting audio.
- Every work panel supports header drag, eight-edge resize, pin/unpin, minimize, maximize/restore and close through a common controller. Task panels use scrollable conversation content and a fixed reply row. Type/viewport-aware sizes avoid oversized task panels.
- Pin preserves placement against Commander automatic arrangement; deliberate human movement remains possible. Clear preserves pins and puts other panels aside, with undo; clearing/closing is not deletion or cancellation. Fit, compare and maximize are distinct operations.
- Selection uses subtle header tint and brighter title/actions, not a line/outline/glow. Requested Commander highlighting automatically brings the target into readable view and blooms a temporary accent glow. Routine updates do not steal focus or rearrange work.
- Commander receives bounded usable viewport/zoom/panel visibility and source/version context; layout is not authority. Respect pins/manual arrangement, preserve prior geometry and avoid camera movement during active input.
- Routine results remain quiet; actionable questions appear compact bottom-right and are movable. Inbox and attention share canonical state. Seen/dismissed/snoozed/resolved differ; opening/closing is not approval.
- Existing approvals, reviews, questions, notifications, Mine/Managed work, running/completed activity, reminders, notes, goals, bookmarks and memory inspection remain in scope, reachable through appropriate menus. Physical pins differ from bookmarks; discussions differ from Commander conversation switching.
- Actual AoA brand/red default with theme, blob style/color, motion, grid/intensity/snap and visibility preferences. Respect global appearance inheritance; dark is a review representation, not the only supported theme. See [settings contract](settings-contract.md).

Keyboard/touch, focus return, contrast, reduced motion, viewport recovery and animation cancellation are acceptance requirements. The [motion matrix](motion-and-interaction.md) contains recommended timing ranges, not measured guarantees. Remaining mock defects and omitted settings are explicit gaps, not scope deletions.

## 4. Conversation, references and agent handoff

Voice addresses Commander even while a task or discussion panel is focused. Direct text replies in a task/discussion composer have an explicit destination. On request, Commander relays a message as **Commander on behalf of the user**, the agent responds as itself, and Commander can summarize the reply in the main conversation. Direct agent voice remains a future explicit mode.

Selection/active editing is the strongest reference cue; pointing and visible position help with “the two images on the left.” Highlight interpreted targets and clarify ambiguous references. Capture target identities/revisions when submitting so subsequent layout changes cannot retarget work. The Commander pointer does not move the user's cursor or imply an action completed merely because it was indicated.

Dropping a file onto empty space adds material to discuss, without authorizing a work job. Dropping into a reply composer or using Attach adds it to that draft. Highlight and label the destination. Fetching a reference does not by itself authorize forwarding it. Preserve source provenance and authorize attachment access again at send time.

Opening task output brings the same artifact forward with its task link. Inspect, revise, compare versions and export through the artifact panel. Native download, external sharing and publication are separate capabilities/actions. A preview is not proof of a successful native export.

Stop speaking, correct current work, submit another request, cancel work and pause a browser are distinct. An ambiguous “stop” silences speech immediately and clarifies work intent. Work acknowledgement means received, not completed; a correction is separately acknowledged as applied or queued as a follow-up. Late results retain their original conversation and task ownership.

## 5. A working day and proactive Commander

Arrival means opening the canvas, not detecting team attendance. Commander may show a short relevant briefing, preparation already completed under agreed routines, outstanding decisions and future connected meetings. Suggest a first action with a reason; the user can start elsewhere. Do not force a morning ceremony or infer a new routine from opening the page.

During work, Commander coordinates authorized tasks, preserves the current workspace as results arrive, and makes done/working/suggested/needs-decision distinct. A compact plan is useful for a multi-step request, not mandatory for every action. Urgent changes offer Show me/Later and preserve the previous draft and layout.

Finish is an explicit user instruction/control. Closing the canvas is not Finish and does not terminate work. Show completed, waiting and continuing work; let the user adjust it. Return catches up on changes since an authorized user checkpoint; “Next morning” is only an old mock label. A break can stop listening and quiet notifications while authorized work continues. Muting is not proof that a provider connection stopped billing.

Reuse AoA's routine scheduler/run records. A routine identifies trigger/timezone, output, responsible agent, action scope, overlap policy and pause state. Commander must reach the actual routine API through a governed registered tool. Prefer bounded event rules/durable reconciliation over an unconstrained background loop. Learned preferences may improve suggestions, never silently grant standing authority.

Partial routine results remain partial, retry only safe temporary failures, and surface decisions requiring a person. A calendar-relative routine depends on the separate calendar connector. Existing recent-activity digests are not yet the proposed personalized, visibility-filtered since-last-visit briefing.

## 6. Technical responsibilities

| Layer | Responsibility | Must not become |
|---|---|---|
| Commander | Durable conversation, task coordination, governed actions and verified result claims | A second independent scheduler or a voice-only history |
| Voice adapter | Audio, turn handling, interruption, transcript reconciliation, provider lifecycle and usage | Independent authority to execute company work |
| Canvas state | Personal layout, panel instances, pins, focus, preferences and private drafts | Copied canonical company records or execution ownership |
| Panel registry | Validated reviewed blocks, isolated custom UI, bounded context and named action requests | Arbitrary privileged model-generated code |
| Domain APIs | Tasks, artifacts, approvals, routines, account access and audit | A canvas-specific duplicate write path |
| Replatform | Admitted/fenced worker execution, command delivery, artifacts and migration boundaries | A second control plane on a laptop |
| Realtime | Authorized hints, replay/cursor and snapshot repair | Proof that every business transition was durably emitted |

Logical boundaries do not require separate microservices. Follow the existing modular control plane and versioned worker protocols. Existing self-hosted/local behavior and the hosted distributed target are distinct; a desktop worker is not an offline replica of the hosted database.

## 7. Request, state and panel contracts

The [request contract](request-contract.md) separates proposed, awaiting decision, accepted, queued, running, pausing/cancelling and terminal outcomes. Disconnection/uncertainty is an observation, not proof a job ended. Stable request identity plus argument validation prevents duplicate submissions. Request revision and event cursor are distinct. External timeout needs outcome reconciliation; internal deduplication is not exactly-once external execution.

The [state contract](state-contract.md) saves company/user/conversation-scoped layout independently from drafts. Use bounded revisioned operations, recover conflicts and preserve text typed after a submitted snapshot. Never overwrite a whole document from a stale tab. A browser-close callback cannot be the sole save mechanism. Offline journals are bounded and policy-controlled; server revocation cannot recall every previously cached offline byte. Restore schema versions, viewport intent and unavailable references honestly.

The [panel contract](panel-contract.md) separates local gestures/calculations, bounded context supplied to Commander and explicit governed actions. Reviewed blocks declare input/state/action schemas and lifecycle. Snapshot scenarios stay stable; live dashboards refresh without overwriting inputs. Custom code uses isolated origins/channels, no inherited credentials, no arbitrary SQL or unrestricted server execution, validated messages and resource limits. Opening/restoring a panel never automatically performs a write.

Trusted blocks include tables, charts, forms, calculators, task cards and document/media viewers. Extend existing implementations first. Full applications requiring their own provisioned databases/backends remain outside this implementation scope.

## 8. Files and artifact lifecycle

Use the [format matrix](format-matrix.md) and [artifact contract](artifact-contract.md). Admission, semantic understanding, preview, editing and generation/export are independent capabilities. “All types” means a deliberate disposition for each family, including an honest unsupported/download fallback, not universal faithful editing.

Cover text/code/structured data, PDFs/scans, office documents, spreadsheets, slides, raster/vector images, diagrams/charts, audio/video/captions, archives, email/calendar files, books and specialist formats. Preserve editable sources where available; handle locked/damaged files explicitly. Media codecs, fonts, formulas, macros and native-layout fidelity need separate fixtures.

Uploads, connector retrieval and generated files converge on validation, immutable canonical publication and independent extraction/preview/indexing stages. Keep originals intact when a derivative fails. A preview retry must not regenerate a successful image or deck. Stage-specific cancellation preserves already published artifacts. Resolve uncertain billable provider generation before retrying blindly.

Existing asset upload/preview routes are reusable; they do not yet establish the complete proposed resumable/job-based pipeline. Map temporary uploads, assets and artifact versions to existing schemas rather than treating every uploaded asset as an already-created canonical artifact version. Preserve approved Discussion/artifact intake and memory-review rules; private canvas context must not silently become company memory or bypass normal promotion/extraction.

Use bounded isolated converters, no macro execution, archive/path/expansion limits, source-version and processor provenance, and authorized derivative access. Storage and database publication need reconciliation, not a fictitious cross-system transaction. Deletion/retention includes derivatives, staging and indexes; closing a panel is not deletion. Dedicated native-file creation can use deterministic libraries; generative media providers are a distinct governed capability.

## 9. Voice and browser decisions

**Voice:** implement OpenAI Realtime first through a direct connection behind the provider adapter. Gemini and ElevenLabs realtime integrations remain intended scope; speech pipelines and local speech follow later. Version allocation is accepted: realtime providers in V1, E3.4 speech pipelines/local speech in V2; see [release plan](release-plans/README.md). Use capability declarations and tested combinations. LiveKit and Pipecat are alternatives if transport requirements justify them, not selected mandatory dependencies. See [provider research](voice-provider-research.md); the accepted scope here supersedes earlier shortlist language.

Voice receives recent conversation, authorized selected context and confirmed work state; deeper retrieval remains with Commander. Reconcile what was actually heard on interruption, invalidate late audio, rotate/expire provider sessions without losing conversation identity, and retain typing after failure. Provider fallback must not send data to an unapproved service. Measure end-to-end latency, turn accuracy, interruption, language behavior, reconnect and cost during implementation; a separate prototype is not a prerequisite for continuing planning.

TK has already accepted optional external speech providers. Record the narrow speech/media integration policy during implementation design without reopening that choice. The replatform Decision 104 amendment already qualifies older hosted-key wording for cloud CLI execution; it does not authorize a direct-API extraction fallback. Keep speech/media credentials, model-execution credentials and browser-account credentials distinct. Do not silently change the locked decision log through this scope update.

**Browser:** Browser Use is the first automation integration direction, not a deployed integration. Retain the existing Playwright sandbox foundation where compatible. Evaluate the open-source automation library separately from its hosted browser service; a cloud CDP endpoint is not a drop-in replacement for the existing pipe-only driver. Any new backend must preserve isolation, egress, account access and artifact policies through an explicit adapter.

Provide live view, Pause and take control, clear acknowledged ownership, and Resume Commander after observing the user's changes. Stop task remains separate. Do not hand control back merely because the user is inactive, a panel hides or the network reconnects. Reject stale queued actions and report effects already completed. Automatic click takeover is an optional enhancement, not a blocker.

Replatform command transport is partial consumer infrastructure: verify the production producer, handler, acknowledgement and browser resolver together. Saved sessions/cookies are restricted account state, not credentials placed in canvas documents. Display account identity. Losing access blocks subsequent affected work even if a browser remains logged in; external logout/revocation capabilities must be described honestly.

## 10. Separate extensions

### Multi-screen Universe — deferred after desktop app

Recorded September 11, 2026 at the user's request. Allow a user with multiple monitors to extend the Universe workspace across screens, considering both local desktop and cloud-hosted use. Preserve this as a future feature; revisit after the desktop app is built. Version two is a tentative candidate, not a committed release assignment or a prerequisite for the current canvas.

The discussed direction is multiple views of the same conversation/workspace. A second browser window for cloud-hosted use and additional desktop windows for local use are proposals, not selected implementations. Later design must settle per-screen viewport context for Commander, moving/restoring panels between screens, state synchronization, one active voice owner, and recovery when a window closes or monitor disconnects. Whether the canvas is continuous across displays or uses linked independent viewports remains open. This sequencing is a product choice, not a claim that browser multi-window support technically requires the desktop app. No implementation or mock changes are requested now.

| Workstream | Preserved intent and boundary |
|---|---|
| Human/agent Accounts and Access | Build on Secrets, OAuth and permissions; individual/agent/company accounts; use versus reveal; request/grant once/task/ongoing; expiry/revoke and audit. Canvas presents requests. Full IAM is not already shipped merely because Secrets exists. |
| Discussions/communication | Evolve toward channels, DMs/groups and live threads with people and invited agents, retaining tasks/goals/decisions/artifacts. UI naming remains open; no database/API rename. |
| Collaboration | Discussion canvases and invited collaborators; shared objects/layout, individual pan/zoom and follow/spotlight. Private prior conversation is not automatically disclosed. Personal canvas does not wait for this foundation. |
| Meetings | Join/preparation, participants, permitted transcript/notes and follow-up associated with work; Meet/Teams/Zoom embedding remains unverified. Private Commander assistance differs from messages to everyone. |
| Email/calendar | Per-user connections, relevant Inbox items and full mailbox/calendar access; personal connection is not company-wide disclosure. Team schedule is a separate sharing design. |
| Full generated applications | New database/backend provisioning, deployment and lifecycle require a separate platform capability. Current interactive tools stay within existing AoA actions/data. |

## 11. Production and acceptance requirements

Preserve single task ownership, atomic checkout, company/organization isolation, approvals, budget hard stops, credential boundaries and mutation audit. Access must be rechecked at use, retry and reconnect. Record actor, requested action and outcome without secrets or unnecessary raw audio/content.

Long sessions require visibility-aware rendering, state outside renderer lifetime, virtualized large histories/tables, media limits and bounded subscriptions. Suspending a renderer does not stop its canonical job. Make failure, stale data, save conflicts and unsupported formats recoverable.

Each implementation contract must name numerical limits and measurement environment: payload/expansion caps, concurrent streams/tools, queue/backpressure, retention/dedup windows, timing/recovery targets, and tenant quotas. Existing Office preview defaults are evidence, not the universal canvas limit. Do not invent performance guarantees before measurement or leave these as unowned “later” work.

Required connected tests: voice→Commander→job→artifact; lost acknowledgement without duplicate execution; two-tab/post-submit draft recovery; failed preview with downloadable original; isolated tool write authorization; browser pause/change/resume; routine duplicate/missed-event repair; revocation in flight; and sustained crowded-canvas resource/accessibility checks. Unit checks alone cannot certify these journeys.

## 12. Code evidence, branching and next plan

Read the [code and dependency map](code-evidence.md) before assigning implementation. It records exact inspected revisions, fresh targeted test results and residual gaps. Replatform findings are dependencies, not permission to duplicate its systems inside canvas.

Remote main was verified as an ancestor of the inspected remote replatform program branch after deepening the Git history. The local main checkout has two local documentation commits and lacks eleven remote-main commits; do not reset or repurpose it. For replatform-dependent implementation, use an isolated codex-prefixed worktree based on the then-current accepted replatform integration revision. Independent UI/state work can use that same integration base with fixtures; deployment acceptance waits only for its actual dependencies. If replatform merges to main first, use that accepted main revision instead. No branch or merge was performed for this document update.

Next deliverable: contract-by-contract implementation plans with exact shared schema/API/event bindings, owning replatform dependencies, migration/rollback, fixture coverage and integration acceptance. Group into epics and versions only after that map is reviewed. Do not wait for the entire replatform program to design the canvas, and do not call Commander distributed cutover complete while its recorded routing/credential/result dependencies remain open.

No blocking product question remains for this scope consolidation. Provider selection, concrete limits and contract designs are engineering/procurement work; bring a specific recommendation if a business tradeoff emerges. Transcript/audio policy is confirmed, and multilingual capability remains in scope without a two-language restriction.

## Document set and history

- [Architecture map](architecture-map.md)
- [Code evidence and dependency plan](code-evidence.md)
- [Request](request-contract.md), [state/drafts](state-contract.md), [panel bridge](panel-contract.md), [formats](format-matrix.md), [artifact pipeline](artifact-contract.md)
- [Voice provider research](voice-provider-research.md)
- [Historical experience record](history/experience-discussion.md) and [historical technical record](history/technical-discussion.md) preserve earlier reasoning and rejected proposals; neither overrides this scope.

The old ignored `docs/plans` entry points redirect here. This document set is eligible for version control but remains uncommitted until explicitly handed off through Git. No application implementation was changed by this update.
