> Historical discussion record. Preserved for rationale and learnings; superseded by [master scope](../master-scope.md) and [current evidence](../code-evidence.md). Earlier recommendations and reported checks are historical, not current implementation instructions.

# Commander Canvas — Technical foundation review

## Latest discussion checkpoint: routines, recovery and long sessions

- Routine definition exposes schedule/trigger, intended output, responsible agent and granted action scope. Commander can summarize the conversational request into a reviewable definition; users can inspect, change or pause it. Existing permissions still apply at execution time.
- Partial results remain explicitly partial. Temporary failures receive bounded retries, decisions requiring a person surface in Inbox/attention, and routine concurrency policy prevents unwanted overlapping runs. Do not infer a new permission to distribute a prepared result.
- Source review confirmed `server/src/index.ts` calls `tickScheduledTriggers`; `services/routines.ts` supports schedule/manual/API/webhook dispatch and locks scoped records in a transaction. No direct conversational routine-creation registration was established. General event-driven preparation remains a separate integration requirement; a calendar-relative routine also depends on calendar integration. These are code-review findings, not newly executed tests.
- Keep long sessions responsive: expensive rendering is visibility-aware, heavy documents/media/history load incrementally, and inactive panels retain recoverable state. Hiding a panel does not stop its server job. Hidden video playback can pause while preserving position. Resource limits for live streams and isolated tools must be explicit; required subscriptions/state capture must survive renderer suspension.
- On permission revocation, deny subsequent affected actions and pause the relevant work; do not claim rollback of completed external actions. Human continuation requires their own valid permissions. Account-level revocation additionally closes managed sessions and invalidates stored session credentials where supported. Reauthorization requires state reconciliation before resume.
- Artifact lifecycle links request, job, canonical output/version and derived preview. Generation success and preview success are separate states. Retry only the failed stage where safe, without silently regenerating successful outputs.
- Voice context includes recent conversation, selected/focused references and confirmed progress. Corrections, separate requests and explicit work cancellation have distinct routing. Provider disconnection does not cancel authorized work; reconnect reconciles pending request outcomes before retry. Unacknowledged work remains uncertain until checked.

Next synthesis: produce a component/contract map and dependency ledger separating existing AoA capabilities, replatform extensions, new canvas work and deferred IAM/communications/calendar/full-app workstreams. Include security, observability, resource budgets, migration and acceptance tests before epic/version slicing. Remaining recommendations should be reviewed as a coherent architecture, rather than another sequence of small behavior questions.

## Latest browser and identity decisions

These decisions supersede earlier automatic-click takeover requirements. Browser Use is the preferred integration candidate, not a selected/deployed implementation. Its cloud documentation demonstrates human checkpoints and continuation in the same available browser session; this is not evidence of instantaneous arbitrary-action preemption. Open-source automation and hosted browser services must be assessed separately. Replatform's existing Playwright sandbox driver is retained as a foundation; remote providers require an explicitly governed adapter, not bypassing its pipe-only launch guards.

- Manual **Pause and take control**, or a conversational pause request, is acceptable. Enable human control after the pause is acknowledged. **Resume Commander** re-observes the current page and accounts for human changes before proceeding. **Stop task** remains separate. Automatic click takeover is optional refinement, not a blocker.
- In-flight external actions may already have completed; show their actual outcome and block subsequent agent actions once control transfers. Connection loss does not silently transfer control. Inactivity may prompt for resumption; it is not itself authorization.
- Keep session identity, actor access, command deduplication and control ownership in AoA. Integrations declare live view, input, pause/resume, downloads and persistence capabilities. Neither Browser Use nor Browserbase has been runtime-tested with AoA by this review.
- Browser identity/profile persistence is linked to the following access workstream; no automatic credential capture is authorized.

### Separate IAM / accounts-and-access workstream — agreed direction

Design access management for humans and agents, built on existing Secrets and permissions. Represent account/service identity, owner (personal or company), credential references and authorized use separately. Agents with existing sufficient permission proceed; otherwise an access request identifies account, requested action, purpose and scope, routed to the appropriate owner. Grants may be once, task-scoped or ongoing and revocable. Authorization to use a credential is distinct from authorization to reveal it. Prefer individual or dedicated agent accounts where available for attribution.

Credentials are supplied through a controlled runtime path rather than inserted into Commander chat. Saving authenticated browser state is distinct from saving a password. Offer explicit session saving where supported; do not capture typed passwords automatically. The canvas displays active account identity and access requests while the central permission system enforces them. This is proposed new capability, not a claim that current Secrets implements the full lifecycle.

Remaining technical work: scope and expiry of grants, revocation of active sessions, external logout/token invalidation, MFA/user-presence handoff, secret-use audit and provider-specific credential delivery. These belong to IAM contracts; canvas must not implement an independent grant system.

## Confirmed generated-tool scope

### Confirmed extensibility and format direction

Use an extensible registry of reviewed building blocks, initially considering tables, charts, forms, calculators, document viewers and existing AoA task cards. Blocks declare validated inputs, persisted state, actions and permissions. Version saved compositions and support migrations or explicit unavailable states; future compatibility is a design responsibility, not automatic. Custom interactive code uses an isolated renderer and controlled capability bridge.

Include documents, spreadsheets, diagrams, charts, presentations, images, audio and video in the format design. Maintain separate capability entries for acceptance/import, understanding/extraction, preview/playback and generation/export (editing separately where relevant). No universal file-format support is promised. Preserve original files and provenance; provide download or external-open fallback when rendering is unsupported. New readers, renderers and generators should register through versioned adapters.

Scenario inputs remain separate from canonical AoA records. Conversational instructions and UI buttons invoke the same authorized domain-action path when changing records. Snapshot-versus-live data behavior must preserve user edits and expose freshness.

Interactive calculators, dashboards, charts, visuals and interfaces over existing authorized AoA services are included in the canvas design. They may report relevant selections, inputs and results to Commander through a controlled bridge; local interactions need not invoke the agent on every change. Persisting tool state is part of the proposed canvas implementation, not an existing capability claim.

Full applications requiring newly provisioned databases, custom backend services and deployment lifecycle are deferred to a future platform workstream. Existing references to mini-apps must be read within this boundary. The next contract to specify is supplied-data snapshots versus live authorized AoA queries, including refresh, provenance and access revocation.

Status: source-grounded architecture research and options review; proposals, not implementation approval or production certification. The evidence update below supersedes earlier uncertainty about whether MIG-003 exists.

## Research update: implementation evidence and preferred options

The local replatform MIG-003 result records durable realtime implementation, not merely an intended contract. Its code in `server/src/services/live-events.ts` confirms an immediate local emitter plus best-effort asynchronous durable append. The result describes a company sequence, PostgreSQL log, notification/listener plus safety polling, authorized WebSocket replay and snapshot fallback. Its reported tests are not tests executed by this canvas review. The result explicitly leaves a literal authenticated cross-container WebSocket receive test outstanding. Therefore reuse this foundation, but do not equate its recovery log with a transactional command/event outbox: append failure can leave a committed domain change without a replay event. Authoritative refetch must repair presentation; critical routine triggers need transactional durable intent or reconciliation.

Sources: `C:/e3/docs/replatform/epics/E10-desktop-migration-realtime/tickets/MIG-003-result.md`, `C:/e3/server/src/services/live-events.ts`, `C:/e3/server/src/services/live-event-log-store.ts`, and `C:/e3/server/src/realtime/live-events-ws.ts` (latter paths located; full implementations still require contract review).

The browser host-spawn gate result explicitly says the guard does not remove the host-side browser. BRW-008 owns retirement. BRW-004 is marked gate_review and covers only specified slices. Neither is evidence that interactive streaming and takeover are delivered. Current viewer hook explicitly stores per-conversation state only for the page lifetime, losing it on hard reload. Durable canvas state is an intentional extension of that existing behavior, not a configuration toggle.

### Options and recommendation

| Decision | Viable approaches | Recommended fit and tradeoff |
|---|---|---|
| Canvas persistence | Browser-only storage; server document with optimistic revisions; CRDT shared document | Server-authoritative, versioned panel operations for the personal canvas, with a bounded draft recovery cache. Browser-only fails cross-device continuity. CRDT is a candidate for the separately planned simultaneous shared canvas, not a substitute for authorization or domain transactions. Keep a document adapter boundary so collaboration can evolve without replacing task identities. |
| Realtime | REST polling; existing WebSocket/replay; new broker or independent canvas event service | Reuse replatform WebSocket/replay plus authoritative snapshots. Use polling/refetch as degraded recovery. Do not add another broker without measured throughput or retention needs. Cursor order is notification order, not necessarily business transaction order. |
| Voice | Browser speech; local STT/TTS; hosted STT → Commander → TTS; realtime voice model delegating to Commander | Benchmark hosted speech around the same Commander first: matches existing reasoning ownership and model selection. Local speech remains a deployment option with hardware/quality costs. Browser speech is a fallback candidate, not the assumed universal baseline. A realtime frontend may improve conversational latency but adds two-model context, attribution and cancellation coordination; adopt only if measured benefit warrants it. |
| Panel rendering | Build new copies of every screen; adapt existing viewer bodies; generated UI everywhere | Reuse existing task/artifact/discussion bodies through a panel registry and explicit per-instance lifecycle. Generate UI for new interactive content, not for known approval/task contracts. Verify multiple mounts and draft ownership before reuse. |
| Generated tools | Trusted application components; same-origin arbitrary HTML; isolated generated applications | Prefer typed trusted components where possible, then separately isolated generated apps with a narrow validated capability bridge. No inherited application credentials. Generated content cannot grant itself tools or change approvals. |
| Browser | Embedded third-party iframe; local host automation; governed streamed browser | Governed replatform browser plus visual/input session. Third-party embeds cannot supply universal browsing/control. Add authoritative control ownership, fencing, stream lifecycle and takeover acknowledgement; never quietly fall back to host automation. |
| Proactivity | Browser timers; unconstrained agent loop; existing scheduler plus bounded event rules | Reuse server routines/run ledger and add explicit event policies. Keep routine authority, budget, user scope, deduplication and pause state durable. Learned behavior suggests a routine; it does not grant authority. |
| Attention | Separate queue for each UI zone; derived projections of canonical work | One canonical underlying Inbox/task/routine state, different presentations. Keep seen, dismissed, snoozed and resolved distinct. Acknowledging a preview does not approve work. |

These are engineering recommendations based on repository fit, not claims that one framework is universally best.

### External primary-source findings

- LiveKit documents both pipeline and realtime turn detection and interruption handling. This supports testing speech around Commander without replacing its reasoning model; it does not establish that a CLI-backed Commander will meet latency targets. Custom pipeline hooks provide an integration candidate. [Turn handling](https://docs.livekit.io/agents/logic/turns/), [pipeline hooks](https://docs.livekit.io/agents/logic/nodes/).
- Yjs supports browser persistence through IndexedDB. That makes CRDT/local persistence a viable future collaboration option, but does not establish AoA access control, deletion or secure offline retention. [Yjs offline support](https://docs.yjs.dev/getting-started/allowing-offline-editing).
- PostgreSQL NOTIFY is a signal to listeners; replatform's persisted log and safety poll are the meaningful recovery foundation. Critical business processing should not depend on receipt of a notification alone. [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html).
- MDN warns against combining scripts and same-origin privileges for same-origin sandbox content. Isolation needs a deliberate origin and capability design, not just an iframe element. [Iframe security](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).

### Work that can proceed while replatform continues

1. Define canvas document operations, reference identity, draft ownership, bounded restore and multi-tab conflicts. Build against fake adapters; no worker migration dependency.
2. Define panel registry, attention projection and typed action acknowledgement contract. Reuse existing attribution and submission IDs.
3. Prototype voice using the canonical turn adapter. Capture latency by stage, not just model response time; do not select providers from advertised latency alone.
4. Integrate against the inspected realtime contract when its revision is agreed. Require replay-gap, append-failure, access-revocation and authenticated two-replica socket checks before claiming seamless recovery.
5. Integrate browser only against the governed execution contract. Human takeover, an action already in flight, reconnect and expired session behavior require their own proof.

Replatform does not block all design. It blocks acceptance of specific execution and recovery promises until those contracts and tests pass. Track each dependency with source revision, owner, implemented behavior, missing evidence and consumer acceptance tests.

### Questions that need product input, after this review

These are discussion topics, not an approval questionnaire. Recommended defaults are included; already agreed interaction rules remain intact.

1. **Deployment/privacy boundary:** must enhanced voice and generated tools work entirely inside a customer's environment, or may selected external services process content? Existing BYO-key agreement permits investigating hosted speech; clarify whether an equally capable fully local mode is a requirement. Recommendation: pluggable speech, explicit hosted choice; do not promise local parity before benchmarking.
2. **Voice language quality:** which languages and mixed-language speech must work well? Recommendation: test English and Hindi-English code-switching because it occurs naturally in these design conversations; expand from actual user needs.
3. **Retention:** should raw audio ever be stored? Recommendation: transcript and authorized artifacts by default, no product-side raw recording unless explicitly enabled. Provider retention must be checked separately; not recording locally does not establish no provider retention.
4. **Unattended authority:** which actions may a standing routine perform without returning for a decision? Recommendation: express grants per routine/action and existing policy, not a blanket proactive switch. This refines the already agreed authority model; it does not require confirmation for every routine run.

Engineering should resolve database/event transport and rendering choices from evidence. The user should decide privacy, expected language experience and delegated authority.

### Required empirical work before final architecture lock

- Voice spike: long pauses, natural interruptions, false starts, code-switching, noisy microphone, slow Commander, reconnect, mute versus disconnect. Measure end-of-utterance to first useful audio, interruption-to-silence, incorrect turn submissions, task continuation correctness and actual session cost including idle time. No numerical targets or provider prices are represented as verified here.
- State spike: two tabs edit different and same panels, reload during save, offline draft, changed viewport, deleted source and revoked access. Verify deterministic restoration without duplicate domain actions.
- Browser spike: human input races with queued and executing agent actions; disconnect while control changes; revoke access; prove stale controller cannot issue another action. Fencing prevents subsequent actions, but cannot undo an already committed external action.
- Proactivity audit: transactional reminder firing and hub creation, routine-tool exposure, missed trigger reconciliation and actor-filtered briefing. Search in the current internal-agent tool area did not find routine/reminder creation registrations; this is an unresolved reachability question, not proof no other path exists.
- Production acceptance: scoped contracts, accessibility, observability with correlation across turn/task/run, quotas, retention, restore/migration, graceful provider failure and end-to-end tests. This document changes no application code; typecheck/build/runtime suites were not run for this research.

Experience authority: [living experience draft](../master-scope.md). Scope is the current Commander canvas. Communication platform, meeting and email/calendar foundations remain separate workstreams. No application code changed for this review.

## Evidence and limits

Inspected the current checkout and the local replatform program checkout at `C:/e3`, whose inspected HEAD is `088de1084`. Local branch contents are evidence of code/plans, not proof of deployment or complete program acceptance. E8/E10 overview files still say backlog and must not be used alone to infer delivery status. This review has not executed integration tests, live voice benchmarks, browser takeover or multi-replica failure injection.

| Area | Source-grounded finding | Recommendation / remaining gap |
|---|---|---|
| Commander turns | `server/src/services/internal-agent/conversation.ts` persists message output refs, client submission IDs, reply linkage and durable turn-claim lease machinery. | Reuse the conversation and submission identity. Layout save and voice interruption must not create a second task-submission path. Audit the full claim/retry lifecycle before extending it. |
| Content identity | `packages/shared/src/viewer-show-ref.ts` defines versioned, provenance-bearing presentation references; references explicitly grant no capability. Kinds include tasks, discussions, artifacts, approvals and URLs. | Reuse references; add missing kinds only through synchronized contracts. Layout stores identity, not copied task/artifact bodies. Permission-check every resolution. |
| Viewer components | Existing Commander viewer components and model are present, including task/output-ref bodies and tests. | Audit components for multi-instance mount assumptions before reuse. Extract shared bodies rather than reproduce task/discussion logic in canvas-specific copies. |
| Live updates | `server/src/services/live-events.ts` uses an in-process emitter and process-local numeric event counter. `LiveUpdatesProvider.tsx` re-subscribes and calls consumer catch-up callbacks on reconnect; updates often invalidate REST queries. | Useful invalidation mechanism, not a durable replay log. Reconnect must restore authoritative snapshots; durable attention/activity delivery needs the replatform realtime contract or an explicitly scoped durable domain outbox. |
| Replatform realtime | E10 README requires a named durable realtime preflight, replay/gap/duplicate authorization and two-replica evidence. | Align with E10; do not introduce a competing worker broker. Reconcile workload-event replay and application-domain updates explicitly: one does not automatically cover the other. |
| Actions and agents | `tools/action-tools.ts` includes founder-only confirmed agent creation. `tools/agent-dispatch.ts` queues dedup-aware wakeups, validates forwarded scope and bounds agent-to-agent hops. | Reuse governed actions. Session helpers, crew and org agents retain their actual execution ownership. A sent message is not proof of execution or completion. Verify agent creation service/route parity, confirmation and hire-approval enforcement end to end. |
| Routines | `packages/db/src/schema/routines.ts` and `services/routines.ts` implement scoped routines, timezone-bearing triggers, revisions, run idempotency and concurrency policies. Routes exist. | Reuse scheduler and run ledger. A scheduler existing does not prove Commander can configure it conversationally: explicit tool registration/reachability and authorization still need tracing. Do not build a canvas scheduler. |
| Reminders / briefing | `internal-agent/proactive.ts` fires due reminders into the hub and has a morning digest over the last twelve hours of activity, in-progress tasks and user reminders. | Existing digest is not the proposed personalized change-since-last-visit briefing. Audit actor visibility before consuming company-wide data; add a durable user checkpoint and bounded aggregation. |
| Browser | Replatform E8 scope addendum defines governed browser requests for agents and Commander; host-side browser retirement follows proving that path. | Reuse sandboxed sessions. Shared visual streaming and human takeover require their own authoritative controller/fencing protocol; do not expose CDP or infer readiness from a preview iframe. |
| Voice | Current policy keeps runtime reasoning CLI-based except embeddings; a speech provider is not implemented by this review. | User accepted investigation of optional BYO speech credentials. Document a narrow successor exception if selected; do not broaden reasoning/extraction policy. Benchmark speech-around-Commander against a separate voice model before locking provider/transport. |

## Proposed boundaries

1. Existing Commander conversation owns messages and actions. Canvas is an alternate presentation with durable user/conversation-scoped state.
2. Domain services own tasks, artifacts, approvals, reminders and routine execution. The canvas never treats a layout gesture as task cancellation or permission escalation.
3. Replatform owns governed worker execution, browser isolation and workload control. The canvas consumes authorized state and sends commands through existing gateways.
4. Voice owns capture/playback and transport state, not an independent authority to mutate work. Final utterances use the same idempotent submission mechanism as text.
5. Attention is a derived view of canonical work/inbox events plus user acknowledgement state. Opening panels, viewing results and resolving approvals are distinct operations.

## Persistence and recovery proposal

- Durable canvas document: company, user, conversation, schema version, revision, panel identities/references, position/size, stacking, focus, user placement/pin intent and last viewed checkpoints. Exact schema and routes are not yet finalized.
- Keep private drafts separate from shared domain records. A local recovery buffer can preserve unsynced input, partitioned by account/company/conversation; define logout cleanup, encryption/retention and revocation behavior before promising offline retention.
- Autosave debounced layout changes and draft checkpoints with an operation ID and expected revision. Report saving/saved/offline/conflict. Merge independent panel operations; same-field conflicts remain explicit. Never silently replace newer drafts.
- Schema migrations and bounds are necessary: panel count, payload size, history retention and restore layout at a changed screen size. Preserve logical intent, then reflow into the available viewport.
- Reconnect: subscribe with the supported cursor, fetch an authorized snapshot, reconcile events newer than its revision, dedupe and handle gaps by resnapshotting. Cursor design must follow proven E10 contracts, not the process-local event ID.
- Domain commands use their own idempotency identity and acknowledgement/result lifecycle. Snapshot recovery never resubmits commands. Use at-least-once delivery with idempotent effects; do not promise global exactly-once execution.
- Deleted or inaccessible references show an appropriate unavailable state without leaking cached content. Recheck access on restore and on revocation.

## Action, content and browser design

Outgoing delegated actions retain user initiator, Commander actor, target task/agent, request identity and governing approval. Display attribution must match the audit trail. Distinguish proposed, accepted/queued, running, succeeded, failed, cancelled and unknown-after-disconnect states. Retry only after checking the canonical outcome.

Artifacts remain immutable versions; a visual in-place edit creates a new version underneath. Compare retains explicit version references. Sources and artifacts are roles, not duplicate storage. Uploads use existing authorized storage; attaching to a draft does not send it. Generated interactive content needs isolated rendering and a narrow validated capability bridge; it cannot inherit page cookies or arbitrary domain-action access.

Browser takeover requires server-authoritative controller ownership and generation/fencing. Human input must revoke future agent control before application; in-flight effects need acknowledgement and honest state. Hiding a browser never returns control. Expired sessions must show expiration rather than silently manufacture a replacement with assumed authentication. Capture/download retention and permissions remain replatform-owned.

## Voice design and evaluation

Preferred candidate: speech recognition → same Commander turn → incremental text-to-speech. Alternative: realtime conversational frontend backed by Commander, with explicit canonical transcript, delegated-action identity and synchronization rules. Neither is selected by this document.

Separate mic muted, capture paused, disconnected, reconnecting, thinking and playback states. Interrupt speech immediately; do not infer task cancellation. Record what was actually played versus generated text where needed to avoid continuing from unheard speech. Only one selected conversation receives mic input; define multi-device ownership before implementation. Pausing UI audio is not proof that provider billing stopped.

Benchmark representative CLI models under warm/cold conditions: recognition endpoint delay, first useful spoken response, interruption stop latency, transcript correction, tool-running interruption, network drop/reconnect and cost over a long working session. Establish acceptance budgets from measured prototypes, not invented latency promises. Keep credentials outside generated content and browser-readable durable storage.

## Proactivity

Reuse routine and reminder execution. A separate bounded orchestration policy turns relevant events into preparation or suggestions within existing authority; it must not create a recursive wakeup storm. Track event identity, action lineage, budget, concurrency and causal depth. Deduplicate briefing items and follow-ups. A learned pattern proposes a routine; it does not become one automatically.

Arrival is opening canvas, not team presence. Finish is explicit. Return summarizes changes since an authorized user checkpoint, not a fixed next-morning timer. Routine timezone and user-local presentation must remain distinguishable. Ordinary completion is silent by default; interruption and sound preferences affect presentation, not whether an approval gate applies.

## Verification plan for later epics

| Contract | Required evidence |
|---|---|
| State | Reload with dirty drafts, two-tab conflicts, viewport changes, interrupted saves and schema upgrades. |
| Delivery | Duplicate/out-of-order/gapped events, restart, two replicas, expired cursor, reconnect before/after command acceptance, no repeated side effects. |
| Access | Cross-company/user ref resolution, revocation mid-stream, private drafts, generated-content capability denial and stale cached content. |
| Voice | Barge-in while speaking/tool-running, partial transcript correction, wrong-session prevention, transport failure and measured long-session cost. |
| Browser | Human/agent input races, stale controller generation, disconnect, session expiry, cancellation and no control-credential exposure. |
| Proactivity | Duplicate triggers, missed schedules/timezone changes, budget stop, repeated failures, bounded dispatch chains and pause/resume. |
| Experience | Task + artifact + question with preserved input; compact captions; arrival/return; no unwanted focus changes; keyboard and reduced-motion behavior. |

Each implementation ticket needs contract tests plus appropriate integration tests. The assembled feature needs end-to-end failure tests and rollout evidence. No runtime suite was run for this documentation-only review.

## Product questions worth asking

These are proposed choices, not blockers to further source review. Ask one at a time with a concrete example.

1. When voice is active, may Commander speak a concise summary while the full answer stays readable, or should it speak the full text? Recommend concise speech with full text; this affects the speech pipeline and interruption bookkeeping.
2. When using a second device, should it restore the same arrangement or adapt a device-specific arrangement of the same open material? Recommend shared content/session state with viewport-appropriate layout, explicit same-field conflict handling and one active mic owner.
3. Should raw voice recordings ever be saved, or only the transcript by default? Recommend transcript-only by default, with any recording retention a separately visible choice. Provider processing/retention still needs verification.

## Remaining engineering investigation

Trace tool registry exposure for reminder/routine management; inspect per-route ownership and new-agent approval parity; audit viewer single-instance assumptions; reconcile all persisted Commander session keys with canvas identity; inspect exact durable realtime acceptance evidence and event-domain coverage in replatform; verify generated-viewer isolation before reuse; run a comparative voice spike. These are engineering work, not questions to offload to TK. The review has covered all six areas at the foundation level, but does not claim every path or deployment has been validated.
