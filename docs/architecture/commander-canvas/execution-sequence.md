# Universe — complete execution sequence

> **For agentic workers:** Use `superpowers:executing-plans` for an explicitly approved work packet; use `superpowers:subagent-driven-development` only when that execution assignment authorizes agent delegation. This document does not authorize feature implementation.

**Goal:** Deliver the accepted Universe V1 through a complete, reviewable sequence of all original increments, with explicit producer contracts, external prerequisites and acceptance boundaries; start V2 only after accepted complete V1.

**Architecture:** This is the scheduling layer over the existing 31 slice outlines and 31 coding addenda. Small delivery packages partition selected original increments where an early contract and later integration proof must be separated. The shared registry, canonical execution/approval authorities and one Universe integration branch remain unchanged.

**Tech stack:** Existing TypeScript/React/React Flow, Express, generated Drizzle migrations, repository test tooling and actual qualified host/provider/worker environments. This scheduling pass adds documentation and a read-only Python plan validator only.

**Spec:** [Accepted V1/V2 allocation](release-plans/README.md), [coding plans](coding-plans/README.md), [source/interface bindings](implementation-bindings.md), [UI decisions](ui-review-decisions.md), [settings](settings-contract.md), [motion](motion-and-interaction.md), [UAT](user-acceptance-plan.md).

**September 13, 2026 — author-reviewed sequencing packet.** BASE is adopted and qualified. TK subsequently approved the first Canvas batch. Its exact package scope and current qualification are recorded in [first-batch results](first-canvas-batch-results.md); this does not authorize the remaining packages. This plan review is Codex's review, not a new Claude or independent-agent review.

**September 20, 2026 — draft/context/recovery source wave.** The ready E1.3/E2.1/E2.2 source producers and Commander/Task recovery adapters are recorded in [draft/context/recovery wave results](draft-context-recovery-wave-results.md). Focused tests, recursive typecheck, build and the exact-source Linux migrated-DB qualification pass; the remaining B05 producers stay open. This is not closure of every B04/B05 package.

**September 20, 2026 — attention/original-intake source wave.** The authorized attention projection is committed, and the durable human-original boundary is recorded in [original intake wave results](original-intake-wave-results.md). Its focused tests, recursive typechecks and exact-source Linux real-PostgreSQL integration pass. E4.1/2 processing/index status, derivative lineage and supported S3/MinIO recovery qualification remain explicit later gates.

**September 20, 2026 — B06 recovery/tray/format source wave.** Structured source adapters, stable tray ownership and the truthful format capability boundary are recorded in [recovery/tray/format wave results](recovery-tray-format-wave-results.md). This closes the B06 source boundary, not the later five-destination route UAT or external converter/codec qualification.

**September 20, 2026 — B07 Commander/overview source wave.** Bounded open-panel pages, the minimized/offscreen recovery rail, persisted-camera restoration and Commander tuck/focus behavior are recorded in [Commander and overview wave results](commander-overview-wave-results.md). Saved appearance preferences, E1.6 motion, live E3 captions/voice and persisted expanded-chat geometry remain their named acceptance joins; no substitute producer is claimed.

## Global constraints

- Preserve all nine epics, 31 slices and 69 original increments: 66 V1 increments across 30 slices; three V2 increments in E3.4. No disabled or simulated required capability counts as complete V1.
- Keep company/user scoping, canonical submission/outcome/approval/Budget ownership, existing Task/API naming, generated Drizzle migrations, synchronized contracts and required activity records. No parallel execution authority or provider fallback bypass.
- Use `codex/universe-interface`, containing adopted replatform `b48132dac0f3435e017915e1e21ef1d66a39d0cd`. Planning source before this packet: `8fa8b964a7300eb7125def094df6a92fffb58bc8`. [Base evidence](base-integration-results.md) supplies the certificate and recovery point; do not recreate the branch from main.
- Preserve the unapproved early draft; exclude it from implementation credit and integration. Its eventual deletion/reuse remains a separate recorded decision.
- Same approved scope may be repaired and retested without asking again for every engineering action. Material product, policy, cost, scope or base changes return to TK. Production deployment remains separate.

## What the sequence means

There are **86 delivery packages inside the existing 69 increments**, arranged in 23 scheduling slots: B00 records completed preparation, B01–B20 order V1, and B21–B22 reserve V2. These are not 23 releases, mandatory approval meetings or revision rounds. A proposed approval batch can contain several ready slots, with its exact package IDs and demonstration agreed together.

Only explicit predecessor edges are blocking. Slot numbers establish priority, not a rule to wait for every earlier row. A later ready package can run while an unrelated earlier gate is blocked. The [full increment register](execution-increment-map.md) lists every package, predecessor, entry gate and owning coding plan; [machine-readable graph](execution-sequence.json) is checked by [the validator](check-execution-sequence.py). Keep the register and graph synchronized when scope sequencing changes.

The human sequence, increment register and graph define scheduling; owning slice/addendum and locked product contracts still define behavior. They do not waive an original test or qualification. A suffix such as `.a` or `.b` means a reviewed partial delivery, not a new increment. Predecessor edges require the named package handoff, not full closure of its original increment; the register also records deferred original acceptance joins. The original increment closes only when all its packages and its original acceptance checks pass.

## Delivery order and review demonstrations

| Slot | Outcome | Active work packages in prerequisite order | Review demonstration / completion check |
|---|---|---|---|
| B00 — Recorded starting point | Replatform adopted and represented Canvas design checked; preserve evidence, do not repeat setup | `E0.1/1`, `E0.1/2.a`, `E1.0/1.a` | Read base-integration-results.md; no new source work |
| B01 — Contracts and early risk checks | Preferences contracts, remaining state coverage, voice/browser/host feasibility | `E1.0/1.b`, `E8.1/1.a`, `E3.1/1.a`, `E5.2/1.a`, `E6.0/1.a` | Freeze producer signatures; assign real external owners without claiming their gates closed |
| B02 — First Canvas demonstration | Shared panel controller/frame, React Flow fixture host and draft snapshot types | `E1.1/1`, `E1.3/1.a`, `E1.1/2`, `E1.1/3` | Open two fixture panels; drag/resize at zoom; pin/maximize/minimize/close/undo; no live task claims |
| B03 — Persistence producers | Preference and layout/checkpoint transaction foundations | `E8.1/1.b`, `E1.2/1` | Owner isolation, concurrent initial writes, operation replay, immutable opening order |
| B04 — Drafts, reload and context capture | Durable drafts, layout recovery and immutable selected context | `E1.3/1.b`, `E1.2/2`, `E2.1/1` | Reload and two-tab conflict retain geometry and unsent content; capture cannot retarget |
| B05 — Canonical reads and original intake | Context authorization, read-only outcome, shared attention projection, manual originals | `E2.1/2`, `E7.3/1`, `E4.1/1`, `E2.2/1` | Outcome reads do not execute work; attention counts are authorized; original survives preview failure |
| B06 — Recovery and tray | Draft reconciliation, stable tray/menu state and format qualification | `E1.3/2`, `E1.4/1`, `E4.2/1` | Send A/type B/ack A preserves B; menu ownership fixed; format matrix records real limits |
| B07 — Commander and overview | Recoverable panel overview, chat/captions/blob presentation | `E1.4/2`, `E1.5/1`, `E1.5/2`, `E1.5/3` | Hide both rails and restore work; compact/maximize/tuck and hover paths stay usable |
| B08 — Manual task work and catch-up | Existing task content plus canonical snapshot/summary reconciliation | `E2.3/1`, `E2.4/1`, `E2.3/2` | Manual reply stays on its task; duplicate/missing events converge without new execution |
| B09 — Motion and personal appearance | Measured camera/bounds, transitions/highlight and appearance settings | `E1.6/1`, `E1.6/2`, `E1.6/3`, `E8.1/2.a` | Requested offscreen focus, input-safe cancellation, reduced motion and contrast/reset tests |
| B10 — Attention and real task routes | Shared questions, every task entry and actual-host defect reproduction | `E7.3/2`, `E2.4/2`, `E8.1/2.b`, `E1.0/2` | Original Needs-you failure journey passes through all five entry routes in the target host |
| B11 — Credential and shared spend foundations | Purpose-scoped Secrets and canonical shared Budget producers | `E8.1/1.c`, `E8.1/1.d` | No credential bypass; simultaneous voice/media spend cannot exceed cap; unresolved cost retained |
| B12 — Execution and browser qualification | Canonical output-binding producer; contained adapter and independent cloud/local qualifications | `E2.2/2.a`, `E6.0/1.b`, `E6.0/2`, `E6.0/3` | Exact execution owner/slots and approval authority; local success cannot certify cloud or vice versa |
| B13 — Materials and publication | Isolated processors/index, full intake status, immutable version publication | `E4.2/2`, `E4.1/2`, `E4.3/1` | Private lineage/revoke/cancel/concurrent completion tests; no duplicate version or implicit Memory write |
| B14 — Result delivery and first live sessions | Original-conversation result repair, OpenAI session, admitted browser ownership | `E2.2/2.b`, `E3.1/2`, `E6.1/1`, `E6.1/2.a`, `E6.2/1.a`, `E6.2/2.a` | One request/result despite disconnect; voice/automation use canonical authority |
| B15 — Connected features | Reviewed blocks, routines, voice recovery, local/cloud panels | `E5.1/1`, `E7.1/1`, `E3.2/1`, `E6.2/1.b`, `E6.3/1`, `E5.1/2`, `E7.1/2`, `E3.2/2`, `E6.2/2.b`, `E6.3/2` | Recover drafts/checkpoints and acknowledged work; takeover fences old input; voice never resubmits partials |
| B16 — Remaining V1 capabilities | Host/tools, follow-ups, Gemini, ElevenLabs and media generation | `E5.2/1.b`, `E7.2/1`, `E3.3/1`, `E3.3/2`, `E4.3/2`, `E3.1/1.b`, `E5.2/2`, `E7.2/2` | Independent real-provider conformance; containment/terminal-writer/paid-output failure cases |
| B17 — Browser lifetime, files and profiles | Both-placement lifecycle, asset transfer and qualified saved accounts | `E6.1/2.b`, `E6.4/1`, `E6.4/2`, `E6.4/3` | Panel close differs from session stop; transfer dedup; actual profile purge. Repeat task/artifact route suite against final materials renderer |
| B18 — Delivery and provider settings | Cross-device announcements and actual voice/browser settings consumers | `E7.3/3`, `E8.1/2.d`, `E8.1/2.c` | No duplicate speech; settings never grant delivery/authority or trigger paid probes |
| B19 — Cross-slice closure | Exhaustive settings, source bindings and evidence reconciliation | `E8.1/2.e`, `E0.1/2.b` | Recheck context/catch-up and task routes with real results/renderers; every retained field and gate has evidence |
| B20 — Complete V1 acceptance | Whole V1 evidence, rollback/recovery and user acceptance | `E8.2/1`, `E8.2/2` | No required slice, provider, placement, profile or UAT may be hidden/skipped to declare V1 complete |
| B21 — Separately approved V2 speech | Split pipeline and local speech only after completed V1 | `E3.4/1`, `E3.4/2` | Independent mode qualification; no V2 implementation during a V1 wait |
| B22 — V2 regression and rollout | Recheck shared voice/settings and V1 compatibility | `E3.4/3` | V2 acceptance and rollback; multi-screen remains separately deferred |

Within a slot, the register's explicit edges take precedence over row/list order. For example B17's common approval closure consumes both browser panels before lifecycle/profile acceptance. The integrator dispatches a topologically ready package, not the first visual item in a table.

## Producer handoffs that prevent circular waits

| Producer first | Consumer afterward | Obligation still open until later |
|---|---|---|
| E8.1/1.a preference contract, then /1.b store | E7.3/1 attention projection; E1.4/1 tray; E1.5 surfaces | Credential/Budget portions /1.c–d and all settings consumers are separate. Early preferences do not close all E8.1. |
| E1.3/1.a immutable destination snapshot types | E2.1/1 context capture | Durable drafts /1.b; uncertain-submission recovery /2 waits for E2.2/1. The layout-before-draft-store edge serializes shared files, not the draft type contract. |
| E2.1/1 captured context and viewport | E1.6 camera/motion | Actual motion and input-safe focus acceptance. Context capture does not require its own animation consumer. |
| E7.3/1 canonical authorized projection | E2.3 catch-up, then E7.3/2 question UI | Speech/terminal delivery /3 after the real voice and follow-up consumers. |
| E2.4/1 actual Task content and E4.1/1 original intake | E7.3/2 attention and E2.4/2 all entry routes | E1.0/2 actual-host reproduction; repeat route checks with final artifact renderers in B17 and full context/results in B19. |
| E4.1/1 original plus status contract | E4.2/1 format qualification, /2 processor/index | E4.1/2 final index/status acceptance. Saved originals remain usable if derivative processing is blocked. |
| E2.2/2.a accepted output-slot and cancellation binding | E4 processor/publication and immutable version work | E2.2/2.b original-conversation reply repair afterward. The E2 authority producer cannot import its later E4 consumer. |
| E3.1/1.a documentary/security operation map | E8 credential/Budget producers and E3.1/2 session wiring | E3.1/1.b full real-provider matrix after E3.2 controls/recovery. Neither mocks nor preliminary wiring close live voice. |
| E6.0/1.b contained attachment and E6.1/2.a common approval contract | E6.2/1.a common frame and /2.a input-state producers, then each independently qualified cloud/local panel | E6.1/2.b both-placement approval/uncertain-effect proof, then E6.4 common lifecycle/files/profiles. Local consumes the common E6.2 frame/input producers but need not wait for cloud runtime qualification. The owning browser addenda now state that split explicitly. |
| E5.2/1.a source-bound containment feasibility | Reviewed block/capability contracts and actual host build | E5.2/1.b malicious-fixture/resource/teardown proof before custom executable tool enablement; /2 bridge integration follows. |

For E1.2 checkpoints, freeze the reviewed **inert payload schemas and registry API** from the E5 contracts before coding the store. Do not import a future live renderer or accept arbitrary serialized code to avoid a dependency. E5 registers each actual supported kind and proves restore/revocation later. B03 can prove rejection, identity and transaction semantics with inert fixtures; B15/B16 and B20 must prove the actual registered consumers.

Qualification is not one undifferentiated gate: (1) receive/review source, owner, contract and environment inputs; (2) build or probe the authorized producer; (3) demonstrate its runtime contract before dependent activation; (4) verify the integrated consumer. [Dependency register](execution-dependency-gates.md) separates entry requirements from resulting completion evidence. Upstream runtime authority must really exist before its consumer is coded. A test that necessarily requires the new consumer is performed after it exists, not demanded as its own start condition.

## Critical paths and safe progress during waits

- **Core workspace:** contracts → shared panel controller → stores/drafts/outcome recovery → tray/Commander/task content → attention and actual task routes. Motion consumes context and the visible surfaces. The first demonstrable Canvas uses fixture content; real Task acceptance comes later.
- **Work and materials:** canonical execution/output binding → processors and publication → reply repair → blocks/routines/follow-ups and final material acceptance. Manual originals can proceed before distributed execution; full worker output publication cannot.
- **Live voice/media:** reviewed provider policy plus actual shared credential/Budget producers and CMD authority → session → controls/recovery → each provider's live qualification → consuming settings. Gemini and ElevenLabs can qualify separately against the common contract.
- **Browsers/tools:** begin owner/containment/attachment discovery early. Common guarded authority → placement-specific qualification and views → both-placement recovery/lifetimes/files/profiles. Host execution remains unavailable if its isolation cannot be proved; a plain iframe is not a substitute certificate.
- **Release:** every V1 package, real dependency certificate and per-slice UAT → combined recovery/rollback → product acceptance. This final join really does wait for all retained V1 scope. No V2 starts while a V1 branch is blocked.

Examples: unavailable cloud capacity permits the qualified local track to advance; missing paid voice credentials permits presentation and manual task work; unavailable converter preserves manual originals but does not close format/index acceptance; pending profile authority permits signed-out browser tests but not V1 completion. If all ready V1 work is exhausted, report the exact gate, responsible owner and needed evidence. Do not invent replacement authority or quietly remove scope.

## How each implementation patch will run

Codex remains coordinator and evidence author; TK accepts the experience and scope. The user may manage Claude review as previously agreed. For a future delegated batch, assign a separate technical reviewer explicitly; do not label the author's self-review independent. No agent or implementation task was started by this sequencing pass.

1. **Select a ready bounded packet for approval.** Name its packages, exact branch/base, actual user-visible result, external prerequisites, permitted qualification spend/environment, files and acceptance checks. Bundle only ready work; approval of a packet is not approval of all V1.
2. **Freeze source and contracts.** Read the relevant slice and coding addendum, binding manifest, settings/motion/UAT entries and current repository instructions. Convert proposed paths/signatures to source-bound ones; record the producer commit and exported schema/API/version. Missing external binding ends at the qualification task, not guessed consumer code.
3. **Assign ownership before parallel work.** Start the shared panel controller with one implementer. After its contract lands, use at most two implementers plus one technical reviewer while the coordinator integrates. A distinct lane in this schedule is only a candidate for parallel work.
4. **Run the specified failing regression or authorized qualification probe, then implement.** Use the owning coding plan's concrete file/test steps. Keep one bounded patch with its synchronized layers and recovery behavior. Retain failed evidence; do not disable failing checks to complete a slot.
5. **Review before integration.** The reviewer checks spec, authority, tenant boundaries, contract consumers, race/recovery cases, UI behavior, migration/rollback and tests against the actual diff. Resolve findings and rerun affected checks. Author review still occurs if independent review is temporarily unavailable, but the agreed independent gate stays open.
6. **Integrate serially on Universe.** Merge the reviewed source at a stable boundary and verify the combined revision. Generate migrations from the combined schema and regenerate a lockfile only with a real manifest change. No branch reset, force-push or premature-draft cherry-pick.
7. **Verify the complete demonstrated journey.** Focused tests are not enough for host behavior: run the actual UI/provider/worker scenarios required by the packet. Run repository typecheck, tests and build for source handoff under repository instructions. Reuse unchanged same-revision evidence; repeat when integrated code or findings invalidate it.
8. **Record acceptance and handoff.** Show the working journey, limitations, review findings, tested revision and rollback. TK accepts the agreed experience. Only accepted producer artifacts unblock dependent consumers. Then select the next ready approved work, keeping this discussion as the coordination hub.

Routine fixes and necessary tests within the approved packet proceed without another permission question. Changing accepted behavior, adding providers/cost, adopting a different upstream source, expanding scope or deploying requires the appropriate user decision. This prevents both unapproved implementation and repeated permission requests for each small patch.

### Shared-file and parallelism rules

| Shared area | One writer / integration rule |
|---|---|
| Panel registry/frame, camera and pointer controller | One owner through first Canvas proof; later consumers use exported actions, never another state controller. |
| Schema and generated migration journal; shared type/validator exports | One integrator orders migrations/exports. Preferences, layout, drafts, credentials, Budget and publication may be logically independent but cannot edit these files concurrently. |
| Canonical execution/outcome, authority routes, Secrets and shared Budget | Producer owner approves consumer bindings. Separate credential and Budget lanes serialize overlapping services/routes; no independent bypass resolver. |
| Materials storage/index/publication | One materials writer until original/receipt/version contracts are integrated; private lineage and output-slot handoff are reviewed together. |
| Browser common descriptor/approval/worker bridge | Common owner lands versioned contract first; local/cloud view work can then be isolated with disjoint files. |
| Commander/task/tray/preferences UI | Shared API/state export changes integrated first. Component-only work may overlap after the coordinator verifies actual file sets; E8 settings patches follow their real consumers. |

Workers use bounded slice branches/worktrees only after that delegation is authorized. They do not all edit the shared checkout at once. Each reports its commit, changed files, consumed producer revision, tests and unresolved findings. The coordinator checks file overlap before dispatch; merge conflicts in authority or schema code trigger semantic review, not mechanical conflict acceptance.

### Required work-packet and completion record

- [ ] Package IDs and original increment(s); approved scope/reference; exact starting and producer commits.
- [ ] Implementer, technical reviewer and acceptance owner; named upstream owner for any external gate. Current role-only entries must be assigned before dependent execution.
- [ ] Exact owned files, exported/consumed contracts, migration order and conflicting writer lock.
- [ ] Entry binding/environment evidence, permitted operations and cost ceiling where applicable.
- [ ] Concrete regression/probe commands and expected outcomes from the linked coding plan; actual-host/UAT steps; negative authorization/recovery cases.
- [ ] Diff review disposition, focused and integrated check results with logs/revision, limits, cleanup and rollback evidence.
- [ ] User-visible demonstration and acceptance disposition; next unblocked package(s); remaining original-increment obligations.

Statuses are `not_started`, `binding_ready`, `in_progress`, `review`, `accepted` or `blocked` in the eventual execution log. B00's `evidenced_portion` is deliberately not blanket completion of E0.1 or E1.0. Keep the planning graph immutable as a reference and record actual execution progress separately against its revision. A failing consumer reopens affected producer/consumer evidence; unrelated accepted work is not erased. Whole-increment and V1 acceptance cannot be derived merely by counting commits.

## Source synchronization and stopping conditions

Inspect upstream at packet selection and integration. Record divergence; do not automatically adopt each new commit. Compare changes in consumed producers, propose a bounded sync at a stable boundary and rerun affected checks. The current adopted source remains the qualified base until such a sync is accepted. Full V1 release reconciles the actual replatform/main ancestry and combined contract evidence, as required by E0.1/2.

Stop the affected lane for missing authority/environment, unresolved high-impact review findings, source drift, failed cleanup, unknown external side effects or acceptance failure. Preserve evidence and advance only independent approved V1 work. Do not use V2 or repeated speculative re-planning to fill the wait.

## Review result and next conversation

[Author review](execution-sequence-review.md) and [validation evidence](evidence/execution-sequence-2026-09-13.json) cover exact increment coverage, graph order, release joins and the corrected dependency boundaries. The validator also rejects deliberately broken schedules. This is planning evidence, not runtime acceptance.

The complete sequence is ready to discuss. The next decision is the first bounded implementation packet: early shared contracts plus the first Canvas demonstration, with only explicitly included independent qualification work. The packet must retain the existing detailed coding steps and show its acceptance journey. No feature implementation begins merely because this sequencing document is published.
