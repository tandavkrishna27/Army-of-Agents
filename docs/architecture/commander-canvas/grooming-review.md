# Universe — detailed grooming review

Latest follow-up: [readiness review](readiness-review.md) and [per-epic task preparation plans](implementation-plans/README.md) cover the full 31-slice set and updated upstream dependencies. Earlier design-bounded dispositions below mean eligible for detailed planning, not executable production tasks.

September 11, 2026. Covers the original 26 slices plus the explicit UI design slice added during review in [epics and slices](epics-and-slices.md). This is a second-level grooming pass, not a claim that every slice is ready to code. Coding readiness requires the final signatures, migrations and executable tests listed below. No release dates or implementation methodology are imposed.

## UI design ownership and review gate

The user identified missing concrete UI/mock coverage during grooming. Add **E1.0 UI design and interactive mock** before E1.1 UI implementation. No existing mock is certified by this review as a complete or approved production design. First inventory any earlier prototypes, then retain useful work and fill the gaps.

E1 owns the overall Universe layout and design consistency. Feature epics own their surface details: E2 task/request/status and context selection; E3 voice controls/transcripts/recovery; E4 previews, versions and file failures; E5 interactive tool states; E6 live browser/control/account/location states; E7 attention and routine flows; E8 settings. This is shared design work with explicit owners, not a final cosmetic pass.

Required deliverables:

- Screen/state inventory linked to each epic and slice, with approved versus proposed status.
- Visual layouts for arrival, active task/artifact side-by-side work, multiple workers, attention, return and finish; compact Commander and Artifacts & Sources navigation.
- Connected clickable mock for the main journey including voice, browser pause/resume, uploads, settings and recovery. Simulated behaviors clearly identified.
- Empty/loading/error/offline/conflict/revoked-access states, narrow-screen layouts, focus order, keyboard controls and reduced motion.
- Design review with the user; record resulting decisions and changed acceptance criteria before implementation of the affected UI. Technical contract work can continue independently.

Subsequent review produced a core interactive mock and [consolidated UI decisions](ui-review-decisions.md). The [epic traceability matrix](epics-and-slices.md#ui-decision-traceability) adds E1.5 Commander presentation, E1.6 motion/viewport interaction and E2.4 task conversation presentation. E1.0 remains open for complete failure, narrow-screen and accessibility coverage; intermittent task controls and lost settings are not certified fixed.

## Review corrections

1. E4.1 ordinary upload is independent of E2.2 execution. Only generated-file completion requires the job/result link. Do not block manual uploads on Commander cutover.
2. E1.3 draft persistence can proceed independently of E1.2 geometry storage; share revision conventions, not a single record or forced serial delivery.
3. E8.1 is enabling work delivered with each consumer, not a final settings cleanup. Provider configuration is a prerequisite for voice; saved personal preferences accompany the canvas.
4. E7.3 visual attention can ship without E3. Speech delivery depends on voice readiness; shared durable attention does not.
5. E6.4 comprises separately testable lifecycle, artifact transfer and profile reuse concerns. Profile reuse depends on sufficient existing account authority or the separate Accounts and Access workstream. Basic signed-out browsing need not wait for full IAM.
6. Realtime providers remain separate acceptance targets. Completing OpenAI does not complete Gemini or ElevenLabs. Later pipeline and local speech are separate delivery targets too.

## Code bindings and proposed ownership

Existing bindings were inspected locally; replatform-dependent behavior retains the revision and limitations in [integration review](integration-decision-review.md). New paths below are proposed, not existing files.

| Boundary | Existing anchor | Proposed implementation ownership |
|---|---|---|
| Canvas persistence | `ui/src/hooks/useHomeBoardLayout.ts` saves complete layout; company query key | New `ui/src/components/universe/`, `ui/src/api/universe.ts`, `server/src/services/universe-state.ts`, `server/src/routes/universe.ts`, `packages/shared/src/validators/universe.ts`, `packages/db/src/schema/universe.ts`; company/user/conversation identity, revision-aware writes. |
| Commander submission | `server/src/routes/internal-agent.ts` POST `/companies/:companyId/internal-agent/chat`; `agent-loop.ts` turn replay | Extend existing validated submission and persisted turn mapping. No second independent voice execution path. Outcome lookup must reference the canonical turn. |
| Asset publication | `/companies/:companyId/assets/files`, `/assets/:assetId/content`, `/assets/:assetId/render` in assets route | Reuse authorization/storage boundaries; introduce stage ownership and reconciliation beside asset services rather than representing every upload as an artifact version. |
| Artifact versions | `server/src/routes/artifacts.ts`, existing artifacts schema | Retain immutable versions and existing task-artifact links; derivatives identify source version and processor. |
| Routines | `/companies/:companyId/routines`, `/routines/:id`, `/routines/:id/run` and trigger routes | Commander tool invokes existing governed service behavior; extend durable trigger/run handling where gaps remain. |
| Attention | Existing hub source/delivery and `ui/src/lib/hub-toast-bridge.ts` | Shared delivery evaluator plus Universe adapters; migrate legacy silent semantics explicitly. |
| Browser | Replatform `packages/browser-runtime/` and worker command path | Worker owns browser execution; AoA authorizes sessions/controllers; transport handles authenticated image/input. Do not expose CDP or derive authority from panel state. |
| Voice | Existing Providers, Secrets and Commander context | New provider-neutral voice session service and provider adapters; client owns capture/playback state, server owns credential and company authorization. |

New table/route names are implementation proposals and must be checked for collisions at the accepted base. Domain API names such as issues remain unchanged.

## Slice exit criteria and grooming disposition

“Design-bounded” means sufficiently bounded for a detailed coding plan, not approved for immediate execution. “Contract-dependent” means the named integration needs engineering resolution first.

| Slice | Disposition | Required concrete exit evidence |
|---|---|---|
| E0.1 | Contract-dependent | Exact revision, schema/producer/consumer/test map and a recorded owner for every upstream gap; no blanket replatform-ready claim. |
| E1.1 | Design-bounded | Real task and document components in React Flow; pointer, keyboard, focus, small viewport and nested scrolling tests. Include manifest and regenerated lockfile together. |
| E1.2 | Design-bounded | Unique company/user/conversation state; compare-and-swap revision; repeated operation returns same result; stale conflicting write returns conflict without data loss. |
| E1.3 | Design-bounded | Independent composer draft revision; preserve both conflict variants; delayed send acknowledgement cannot erase subsequent text; local journal cleanup on logout/company switch. |
| E1.4 | Design-bounded | Stable panel identity; one selected reference opens once; search rechecks access; removed artifact yields unavailable state without cached private preview. |
| E2.1 | Design-bounded | Structured selection captured at submit with source/version; authorize every target; retrieval and summary tests preserve explicit corrections. |
| E2.2 | Contract-dependent | Bind to real accepted Commander route and canonical turn; prove retry/replay; unresolved distributed cutover blocks distributed execution acceptance only. |
| E2.3 | Contract-dependent | Snapshot reconciliation repairs deliberately dropped UI events; duplicate/late event cannot execute work; expired replay cursor falls back to snapshot. |
| E3.1 | Contract-dependent | Speech credential policy documented from accepted user direction; scoped connection; actual provider request → canonical Commander → result journey. |
| E3.2 | Contract-dependent | Barge-in stops playback; mute preserves incoming speech; end closes transport; interrupted output history reflects what played; reconnect never repeats action. |
| E3.3 | Contract-dependent | Independent Gemini and ElevenLabs qualification reports covering interruption, turn completion, transcripts, tools/results, expiry and usage. |
| E3.4 | Contract-dependent | Pipeline and local runtime qualification separately; clear missing hardware/model capability; same authority and conversation bindings. |
| E4.1 | Design-bounded for upload | Original is recoverable after storage/DB failure injection; generated result attachment separately proves canonical job link. |
| E4.2 | Design-bounded by format | Fixture manifest assigns every matrix family supported/convert/download/reject disposition; extraction and preview failures isolated; no macro execution. |
| E4.3 | Contract-dependent for providers | Winner/version policy preserved; repeated generation completion publishes once; unknown provider outcome reconciled before additional spend. |
| E5.1 | Design-bounded | Validated block schemas, input snapshot and source provenance; local what-if changes never write company records. |
| E5.2 | Contract-dependent | Isolation origin and bridge design verified; forged messages and revoked capabilities denied; hung renderer can be terminated without losing saved inputs. |
| E6.1 | Contract-dependent | Browser Use compatibility with worker isolation demonstrated; no unsafe remote-debugging workaround; single session controller fenced. |
| E6.2 | Contract-dependent | Headed cloud viewing verified; one stream/session mapping explicit; manual takeover acknowledged before input; native UI limits documented. |
| E6.3 | Contract-dependent | Authorized outbound local connection; tab/window capture boundaries verified; second-device view, input and reconnect tested on supported worker platforms. |
| E6.4 | Split during ticketing | Separate lifecycle/transfer/profile checks; teardown preserves outputs; authenticated profile use rechecks authority; no silent session sharing. |
| E7.1 | Design-bounded | Conversational create/edit/pause follows existing routines permissions, revision and scheduling semantics; explicit timezone and run identity. |
| E7.2 | Contract-dependent | Durable trigger intent/reconciliation; scheduler downtime and duplicate event injection produce one intended follow-up; overlap behavior explicit. |
| E7.3 | Design-bounded visual; speech-dependent | Migration fixtures preserve prior intent; direct responses unaffected by silent notifications; duplicate delivery suppressed across devices. |
| E8.1 | Design-bounded | Each settings field maps to owner/default/timing/reset in settings contract; no budget settings added to Providers. |
| E8.2 | Release gate | Combined branch passes connected journeys, isolation, failure injection, sustained resource checks and rollback rehearsal. |

## Proposed initial engineering limits

These are tunable test inputs and initial defaults, not measured performance claims or commercial quotas. Keep centrally configured; reject oversized input explicitly rather than silently truncate. Stricter existing platform/provider limits win. Review measured results before enabling production defaults.

| Area | Initial value / target | Verification setup |
|---|---|---|
| Canvas | 100 saved panel references; at most 10 expensive visible renderers | 100-panel fixture with 10 rendered panels, 1,000 accumulated updates and 2-hour work session. |
| Layout writes | 500 ms debounce, final drag flush; 256 KiB maximum operation batch | Drop network during flush, retry identity, and issue conflicting writes from 2 tabs. |
| Draft | Proposed 1-second debounce and 64 KiB recoverable text storage; initial send remains at current 10,000-character message and five-attachment limit | Storage is not send capacity. Do not silently truncate; show oversized draft and preserve it. Test continued typing after send; any higher send limit needs a synchronized reviewed API change. |
| Interaction | p95 local panel interaction under 100 ms; no sustained heap growth after close cycles | Fixed recorded browser/hardware; 100 open/close cycles after warm-up; record baseline and measurement variance. |
| Voice | 1 active capture session per user/device; 250 ms p95 local playback stop after detected interrupt | Measure local stop separately from provider speech detection and total response latency; record language/network/provider. |
| Media | Start with 2 simultaneous active browser streams per client | Additional streams show paused-preview state without stopping tasks; test resuming correct session. |
| Tool bridge | 64 KiB message cap, 20 messages/second per panel, 5-second heartbeat expiry | Flood/oversize/forged messages; expiry disables actions and offers reload. This is not a guarantee iframe CPU is hard-limited. |
| Request replay | Reuse platform retention; never retry an unknown request merely because retention expired | Unknown result displays unresolved state and requires reconciliation. Do not add a conflicting independent dedup expiry. |
| Files | Keep existing upload/converter caps until per-format fixture measurements justify changes | Boundary-size, decompression, timeout, corrupt and password-protected fixtures; no universal file-size promise. |

Exact execution quotas, converter limits and provider timing remain owned qualification outputs for the contract-dependent slices, not user questions. A release cannot pass E8.2 with these outputs missing.

## Migration, security and rollback

- Additive generated database migrations first; deploy readers compatible with missing Universe rows and defaults. Seed no automatic microphone or provider connection.
- State and drafts scoped independently to company/user/conversation; content references reauthorized server-side. Schema versions rejected when unsupported; no destructive fallback reset.
- Migrate notification preferences with explicit fixtures for silent, digest, realtime and quiet hours. Preserve old intent while separating source creation from delivery.
- Provider keys stay in Secrets. Voice/session cookies and browser profiles never enter layout, transcripts or generated tool capabilities. Model execution, speech and account credentials stay distinct.
- Feature rollback disables new entry and actions, preserves records and existing task access, closes voice transports, and follows canonical browser/job lifecycle. Database rollback is not table deletion.
- Replatform changes land with the owning workstream when shared; Universe consumers track compatible contracts. Do not duplicate upstream migrations or weaken worker guards to unblock a slice.

## Release grouping recommendation for discussion

Use milestone names until version grooming is agreed:

1. **Core working journey:** E1, E2, manual artifact intake/preview, reviewed blocks and corresponding settings/attention. An internal integration milestone, not a reduction of the promised feature.
2. **Realtime and browser journey:** OpenAI voice, browser automation, both cloud and local interactive viewing, lifecycle/files and governed routine operations. Depends on proven execution and transport contracts.
3. **Provider breadth and advanced automation:** Gemini and ElevenLabs acceptance, proactive follow-ups, isolated custom tools and broader generation formats. These can advance alongside milestone 2 when dependencies permit.
4. **Later speech modes:** pipeline and local speech qualification.

All milestones retain E8.2 verification and the full master scope. No release number is assigned by this recommendation. Separate IAM/communication projects remain outside this grooming pass; their integration boundaries are recorded, not assumed delivered.

## Remaining user decision

The only release-shaping question is whether the first user-facing Universe release must contain all three realtime providers and both local/cloud interactive browsing, or whether staged releases are acceptable. Recommendation: stage delivery while retaining the full scope, and keep milestone 1 internal until the desired public launch experience is ready. This does not block detailed engineering plans.

## Review and verification record

The original draft over-constrained uploads and drafts, treated settings too late, and mixed speech with visual notifications; corrected above. Source review confirmed whole-layout Home saves, existing idempotent Commander turns, existing asset content/render endpoints, and routine mutation/run routes. No new runtime behavior is asserted. Documentation links and slice coverage are checked separately; application typecheck/tests/build are not run for this docs-only change. The next executable plans must include actual signatures, migration generation and test code; this review does not substitute for them.
