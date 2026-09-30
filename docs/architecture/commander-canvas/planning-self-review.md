# Universe — full implementation-plan self-review

**Latest readiness (September 13):** [Base integration and adoption](base-integration-results.md) are complete with full local qualification, required PR CI and exact source comparison. The existing Universe branch now contains the verified replatform landing. TK's requested discussion and explicit batch approval remain before feature implementation. Earlier dated preparation results below are historical.

**Historical local qualification (September 13):** The [F5 repair and full baseline verification](f5-repair-results.md) passed at local source `fcab5a112`: repository typecheck, all four test shards (24,276 passed, 76 unchanged ordinary skips) and build. An interrupted shard-3 attempt is preserved separately and excluded from totals. No source drift or new skipped cases. Correction publication/landing, exact Universe base adoption and feature implementation remain unapproved. The remote replatform delta requires its own integration checks; no general epic replanning. Older dated records below are historical.

September 12, 2026. **Result: complete planning packet prepared for TK's independent Claude review; not approved for coding.** Scope is all nine epics, 31 slices and 69 numbered increments, including conditional qualification plans for unavailable upstream contracts. V1 remains 30 slices; E3.4 is V2. Source pin: `183e46a9c65fc3105c7e3d125629276814df7dbb`. Source reads and document validation are the evidence in this pass; no runtime tests, provider sessions, installation or implementation occurred.

## Subsequent independent review correction

The original self-review below is historical. Claude found that two claimed shared corrections had not reached the owning E1.2 plan. That is confirmed: the original record overstated propagation. The [finding-by-finding response](independent-review-response.md) and owning plans now reconcile producers, paths, dependencies and formal UAT. No original local check is relabeled as runtime success, and no author correction is presented as Claude's re-review.

## Method and authority

Applied writing-plans and plan-eng-review to the existing accepted scope, with bounded parallel planning permitted by the dispatching-parallel-agents skill. The author reviewed the combined contracts after each writer reviewed its own addenda. These are author/team self-reviews, **not** independent Claude review. TK explicitly chose to receive the complete packet first and obtain Claude's review personally, so the skill's interactive per-finding questions and automatic outside-model review were replaced by this recorded review and later user-managed review. No cross-project telemetry/config changes or reviewer CLI login was needed.

Step 0 scope challenge: the feature is large, but its breadth was explicitly retained in the accepted V1 allocation. A smaller foundation-only release would not satisfy that decision. Reuse existing TaskDetail/CommanderInput/viewers, conversation/summary/retrieval, assets/artifacts, routine authority, Inbox policy, Secrets, budgets and replatform jobs. Build new presentation state, bounded adapters and missing recovery contracts; do not add second task, memory, approval, scheduling or execution systems. Detailed qualification gates are preferable to invented vendor methods. No scope reduction was applied.

## 1. Architecture review

| Finding | Evidence / confidence | Resolution in the plan |
|---|---|---|
| P1: company UI state was being conflated with distributed tenant tables | 9/10, `server/src/db/rls-tenant.ts:89` describes eight new-path tables and says legacy company tables are intentionally excluded; `tenant-context.ts` defines the distributed non-owner transaction. | [Shared bindings](implementation-bindings.md) distinguish owner/company layout, drafts, preferences and checkpoints from proposed organization-ledger extensions. E4/E5 ledger topology requires explicit security/generator qualification; no silent frozen-table expansion or legacy RLS retrofit. |
| P1: security migration policy was quoted from an older instruction baseline | 9/10, pinned Decision #122 at `docs/architecture/decisions.md:1971` permits idempotent security DDL in delta-free custom migrations; pinned AGENTS and CLAUDE carry that exception, unlike the older supplied session text. | Final publication review corrected E4/E5 and shared bindings: generated tables remain mandatory; exact security migration steps follow the locked decision once applicable instructions are reconciled. Do not claim the generator can emit FORCE/GRANT or that no sanctioned exception exists. No migration is authored now. |
| P1: observation could re-execute an unfinished turn | 9/10, `agent-loop.ts` first calls `getMessageByClientSubmissionId`, then reuses unfinished user messages before claim; route creates run prior to chat. Existing replay is not a harmless status check. | E2.2 supplies owner-authorized GET, no execution mutation, payload identity preflight and conservative unknown state. Every voice/tool/browser recovery path consumes observation rather than auto-POST. Required access audits remain intact. |
| P1: shared checkpoint and answer-draft producers were unspecified | 9/10, E5 originally consumed checkpoint CAS while E1.2's operation union held only geometry and E1.3 declared Commander/task destinations. | Explicit checkpoint table/service/route, separate revision, payload bound and source-version authorization now in shared bindings/E1.2. E1.3 adds source-specific answer drafts and pending action correlation; canonical answer authority unchanged. |
| P1: output identity could be confused with submission identity | 9/10, `internal_agent.ts` has separate runId, clientSubmissionId and outputRefs; output-refs may lack exact version. | E4/E5 use exact persisted linked output reference or qualified commit identity. Existing artifact versions are reused, not republished; absent version stays blocked instead of substituting latest/run/array index. |
| P1: schedule can advance before dispatch becomes durable | 9/10, `routines.ts:1538–1603` updates nextRunAt before dispatch and has no stable scheduled occurrence key. | E7.1 adds occurrence/receipt and crash-recovery work inside canonical routine authority. E7.2 separately qualifies all terminal producers; best-effort live log cannot establish durable follow-up eligibility. |
| P1: host/media qualification needs deployment evidence | 8/10, current browser driver is headless and has no interactive stream; current markup viewer does not establish CPU/egress containment. | E6.0 qualifies local/cloud independently; E5.2 requires real origins, headers, resource termination and network probes. Worker/host artifact build and distribution are part of qualification below. No enabled fallback bypasses guards. |

Failure coverage includes wrong owner/company, revoked source, missing/late output, duplicate admission, failed storage publication, stale control epoch and dead renderer. Personal UI storage can be available while distributed operations remain gated; complete V1 still waits for those operations. One controller/state owner per view and one canonical execution authority avoid the repeated mock failure of duplicate controls operating on different instances.

## 2. Code quality and contract review

| Finding | Evidence / confidence | Resolution |
|---|---|---|
| P2: overview insertion order and focus z-order had different semantics | 9/10, E1.4 requires stable tiles while E1 controller focus reorders its panel list. | Persist independent openedOrdinal; focus changes only z-order. Test focus/minimize/restore does not reorder overview. |
| P2: reference aliases and preference enums could drift | 9/10, controller Ref.version differs from E2 UniverseReference.versionId and E5 artifact_version shape. | Explicit adapters and authoritative E8.1 exports/defaults listed in shared bindings. No unsafe casts or duplicate defaults. |
| P2: context builder remained an unnamed future binding | 9/10, agent-loop imports `contextAssemblyService` from context-assembly; its `assembleContext(companyId,options)` is the real seam. | E2.1 modifies that exact service with a bounded optional resolved context; no second prompt/memory pipeline. Test actual new builder, immutable selected version and deduplication. |
| P2: transaction audit publication was vague | 9/10, activity-log exports `insertActivityLog(db,input)` and separate `publishActivityLogged(persisted)`. | E1/E8 use insert inside transaction and publish after commit. Audit/notification failure does not make accepted operation safe to replay. |
| P2: repeated outline checklists overstated coding detail | 9/10, original 31 outlines repeated the same five generic steps. | Every outline now links its concrete addendum and each numbered increment remains mapped. The old E1.1 reference remains illustrative, unapproved and subordinate to corrected shared contracts. |

Module ownership is explicit: panel chrome never lives inside thumbnail/content clones; task content uses canonical clients; provider adapters normalize presentation only; command permission stays server/worker owned. Exceptions preserve drafts/originals and show unavailable/unknown instead of silently swallowing failures. Existing diagrams and chronological records are retained as history; current indices point to the reviewed packet and identify superseded authority statements.

## 3. Test and experience review

Frameworks verified from repository sources: Vitest, Testing Library, Playwright and real embedded/external PostgreSQL fixtures. Windows skip conditions are documented; Linux full-suite evidence is required at implementation handoff. Proposed test imports and routes are labelled as proposed, while reused fixture files are source-checked. No copied mock test or fixture-only pass is credited as a real integration.

```text
Input / request / event
  |-- missing, malformed, over-limit --> validator refusal [UNIT + ROUTE]
  |-- wrong user/company/source -----> no data/effect [AUTH + REAL DB]
  |-- valid presentation intent
  |      |-- current generation ----> reducer + frame --> drag/resize/focus [UNIT + HOST E2E]
  |      |-- stale generation ------> ignore; preserve current panel [HOST E2E]
  |      +-- save CAS
  |             |-- matching receipt ------> original ack, no repeat [DB CONCURRENCY]
  |             |-- changed body/revision -> conflict + retained draft [DB + TWO-TAB E2E]
  |             +-- lost ack --------------> GET + reconcile [CRASH/RELOAD E2E]
  |-- explicit canonical action
  |      |-- denied/budget/approval -------> governed refusal/wait [AUTH + REAL WORKER]
  |      |-- admitted --------------------> canonical job/turn --> fenced result
  |      |                                   |-- linked output --> exact version [DB + E2E]
  |      |                                   +-- unknown ------> observe, no replay [FAULT TEST]
  |      +-- restored view ----------------> no additional action [HOST + DB COUNTS]
  |-- provider/stream message
  |      |-- wrong generation/epoch/frame -> reject [UNIT + REAL TRANSPORT]
  |      |-- revoked/lost -----------------> stop media/input; keep work [REAL TRANSPORT]
  |      +-- valid final utterance --------> one canonical action [REAL PROVIDER + EVAL]
  +-- source terminal event
         |-- committed durable marker ---> eligible bounded follow-up [DB CRASH/RESTART]
         |-- rollback/duplicate ----------> zero/one occurrence [DB CONCURRENCY]
         +-- notification delivery -------> shared quiet policy; never source truth [E2E]
```

The leaf addenda specify branch fixtures and expected results for each increment. E8.2 joins all 30 V1 rows. Critical end-to-end journeys include all five real Task entry paths, every panel edge/corner at multiple zoom levels, maximize→compact→restore, hidden rails and tray recovery, voice permission/start/end/interruption, two-device browser takeover, upload finalization crashes, generated output publication loss and silent yet durable attention.

Test correction P2, confidence 9/10: the E8 specimen clicked primary Commander and then expected a menu checkbox. Accepted behavior makes that primary control toggle chat. It now clicks `Commander options`; E1.4 records the two accessible names. This prevents a plausible-looking test from specifying the wrong UI.

Remaining visual evidence: extra loading/error/denied/reconnect/conflict/narrow states must be checked against the accepted mock; only material experience changes return to TK. The intermittent mock Task panel bug and settings lost during rebuild remain explicit actual-host regression cases, not closed by prior claimed tests. Selection stays quiet header tint; Commander glow remains a separate temporary attention action. Requested highlighting may bring the panel into view; background completion must not hijack the viewport.

## 4. Performance and operational review

Proposed limits are explicit and unmeasured: layout/operation sizes, checkpoint caps, visible-reference/token bounds, transfer concurrency, converter decompression/resource limits, voice interruption latency, stream quality, preview pagination and bounded follow-up drains. Tests cover limits and limit±1, large collections, narrow screens and prolonged open/close cycles. Numeric proposals do not reduce required format/provider coverage; unsupported capability must be honest until qualified.

Avoid per-frame server calls and per-preview source queries: capture context on submit, coalesce invalidations, batch authorized reference reads, virtualize large viewers, suspend expensive off-screen rendering and release media subscriptions without cancelling work. Direct dragging follows the pointer; animations never delay mute/end/control denial. Reduced motion uses immediate equivalent transitions. Performance failure changes implementation strategy or prompts a reviewed limit decision, never silently discards work.

Distribution requirement added to E4/E5/E6 qualification: each new converter image, worker/capture adapter, isolated tool bundle or later local speech binary needs an immutable version/digest, license record, build owner, actual CI build/publish job and registry/origin, integrity verification, supported OS/browser matrix, rollout compatibility and rollback/revocation path. Existing `.github/workflows/pr.yml` is the application CI reference, not proof that a new image/origin pipeline exists. Before enabling a capability, the platform owner records exact deployment files and artifact provenance and tests old/new worker protocol mismatch. No paid/provider qualification is added to ordinary PR runs. These operational bindings remain blocked until the relevant producer qualification; inventing a pipeline path would give false readiness.

## Remaining prerequisites and decisions

| Gate | Concrete remaining input | Affected work |
|---|---|---|
| Implementation approval | TK's explicit instruction after complete plan review, returned Claude findings and verified dispositions | All production coding |
| BASE refresh | Revalidate pinned replatform/current main and changed producer contracts; assign actual reviewers; retain the accepted untouched/excluded premature draft; review any later deletion or reuse separately | All affected increments, not unrelated plan work |
| Tenant ledger extension | Approved data class, generated policy/grant mechanism and real non-owner transaction composition for proposed E4/E5 ledgers | E4 intake/derivatives and E5 capability-ledger bindings |
| CMD | Actual non-task Commander routing, per-user credentials, canonical cancellation and original-conversation result delivery | Distributed Commander, voice/tool dispatch and generated outputs |
| VOICE | Speech-purpose credential policy, exact current provider messages/models, scoped session issuance and real tests for all three | E3.1–E3.3 |
| BROWSER / APPROVAL / CLOUD | Compatible contained driver, headed local/cloud transport, acknowledged ownership and stranded-answer recovery | E6.0–E6.3; applicable E6.4 |
| PROFILE | Real sensitive profile path, account rights, deployed encryption/TTL/purge and audit semantics | E6.4 saved login; required for V1 |
| HOST / format / distribution | Actual sandbox/origins/egress/CPU termination, processor builds/fonts/codecs/native fidelity, artifact build/update ownership | E4.2/E4.3/E5.2 and relevant browser adapters |
| Terminal-owner map | Every canonical terminal/reopen writer and transaction-compatible marker before follow-up drain | E7.2; scheduler occurrence repair is separately E7.1 |
| Real UI/release evidence | Additional state visual checks, all actual routes, Linux full suite, supported Windows path, migrations/rollback, live integrations | E1.0 and final E8.2 |

Existing sensitive retention-disagreement and transfer-grant issuance audits are present at the source pin. E8-F011's older blanket audit-absence wording is stale. E6.4 corrects that claim without treating grant issuance as actual download proof or assuming deployed purge/encryption has been exercised. Upstream finding IDs are traceability, not assigned owners or promised delivery dates.

No new product question is required to publish this review packet. Locked-policy changes, exact commercial cloud ownership/billing, material experience/limit changes and the premature-draft disposition return for their own decisions before affected implementation. The user-managed Claude review is the next independent check.

## GSTACK REVIEW REPORT

| Area | Result |
|---|---|
| Review target / scope | Full nine-epic packet; accepted breadth retained |
| Step 0 / reuse | Evaluated; use existing canonical authorities and viewers |
| Architecture | Reviewed; contract omissions corrected; unavailable producers explicitly gated |
| Code quality | Reviewed; shared aliases, storage ownership, order and audit seams corrected |
| Tests / experience | Reviewed with branch/journey diagram; actual-host and real-provider evidence still unrun |
| Performance / distribution | Reviewed; bounded proposals and required measured/build/rollback evidence recorded |
| Coverage | 31 addenda map 69 original increments; 30 V1 + 1 V2 |
| Independent review | Not performed; TK will supply Claude's findings |
| Runtime confidence | Not certified; no implementation/runtime test execution in this pass |
| Recommendation | Publish documentation for independent review; do not begin coding |

## D3 correction self-review

Accepted the two medium and one low findings after checking pinned secrets.ts, budgets.ts and budget-hooks.ts. Tightened the target-presence suggestion to durable restricted-secret classification with explicit shared-key compatibility and deletion behavior. Made shared Budget capacity a scheduled E8.1/1 producer and specified real database session uniqueness. Reconciled old E3.1 per-device ownership, post-issuance persistence, void end outcome and live-qualification dependency cycle in the owning coding/slice plans. The correction contract still marks complete writer inventories, exact tenant/API bindings and runtime proof open; no plan text certifies those gates. Privacy decisions and V1/V2 scope stay accepted.

## Preparation checkpoint self-review

Closed the unchanged voice/media correction review with residual qualifications retained. Traced separate heartbeat, one-shot, crew, distributed and import paths rather than treating one cost writer as universal. Classified version-only reads separately from decryption and DB backups separately from application resolver protection. Recorded current replatform drift without merging it, and corrected the historical first-batch page's stale base/disposition framing. Accepted responsibilities do not imply runtime approval. Prepared exact credential-free baseline commands and explicit exclusions for DB, browser and provider proof; Linux environment/digest must be established before any future run.

## Bounded preparation evidence review

TK authorized the published BASE/DESIGN preparation batch after 3431c66f2e. The [attributed BASE report](baseline-preparation-results.md) records frozen installation and five prebuild successes on both exact revisions, followed by the same environment failure: nested package scripts could not find direct pnpm. Four test shards and build were not run. Tracked bytes and symlink targets remained unchanged; no source regression or candidate qualification is inferred. The stopped isolated container and logs are retained. The report proposes a bounded offline Corepack shim correction and single retry for scope approval.

The [DESIGN matrix](design-state-coverage.md) records accepted intent, historical mock checks, missing renderings and actual-host proof. The intermittent Task-controls defect remains open. Existing source pin, nine epics, 31 slices, 69 increments, V1/V2 allocation and accepted responsibility/privacy decisions are unchanged. No merge/rebase, production implementation, provider sessions, credentials or premature-draft use occurred. This execution evidence supersedes earlier statements that runtime preparation had not yet been authorized; it does not supersede the implementation approval gate.

## Offline retry evidence review

TK approved the exact container correction and one repeated offline sequence. The [retry results](baseline-retry-results.md) supersede the first attempt for current execution status: both revisions pass typecheck; the pin reports 24,229 passed / 3 failed / 76 skipped tests, and the candidate 24,238 passed / 3 failed / 76 skipped. Each also reports one unhandled opener error. All eight shards ran; build did not run because tests failed. Source integrity remained unchanged and the container is stopped.

[Attribution](baseline-retry-findings.md) identifies public-DNS and Git-metadata test requirements and an inherited unhandled child-launch error in the filesystem reveal route. Candidate-only failures were not observed, but neither baseline is green. The next step is a bounded corrective plan and review, not source-base adoption or E1.1 implementation. Existing product decisions, responsibility allocation and separate DESIGN/provider/host gates are unchanged. Documentation/evidence changes only; no source fixes or additional retry are authorized by this record.

## Corrective plan author review

[Baseline correction plan](baseline-correction-plan.md) was checked against the actual DNS lookup signature, opener route, route tests, Git-caller assertions and preserved failure evidence. Review tightened initial-commit bootstrapping, cumulative patch transfer, fresh final checkout identity and permission/path regression assertions. F1 remains a test correction; F2 keeps actual production-caller assertions unchanged; F3 is a narrow source error-handling correction. No dependencies or domain contracts change.

The snippets are source-checked proposals, not compiled or executed code. The plan separates Codex self-review, TK-managed Claude review, explicit corrective execution approval, later base adoption and eventual Universe implementation. Documentation validation covers links and mapping consistency; it is not a new runtime baseline result.

## Baseline correction review disposition

[Claude’s plan review](baseline-correction-review-report.md) is received and author-verified: no blocking plan finding. [The plan](baseline-correction-plan.md) now clarifies existing Codex/TK/Claude responsibilities, the later replatform landing owner/path gate, and initial launch versus subsequent child-process errors. The reviewed code proposal and test scope are unchanged. No further unchanged Claude round is requested.

Current next step is explicit approval of isolated correction authoring and offline qualification. Neither baseline is green; runtime fixes/tests, correction branch creation, base adoption and Universe implementation remain unperformed. This documentation update is not execution approval.

## Approved correction execution outcome

TK explicitly approved the isolated correction batch after the reviewed plan. [Results](baseline-correction-results.md) record local correction commit `b5cc42643223c433a8263564c7142761472a13d9`, passing typecheck and all 247 targeted cases, plus all four full shards. F1/F2/F3 are corrected in that isolated tree; full qualification remains failed due to a confirmed blocked-task fixture port collision and a separate backup setup timeout. Totals: 24,242 passed, 4 failed, 78 skipped; two failed suites, no unhandled-error summary. Build was blocked. No additional fixes/retries followed.

The runtime is stopped. Correction commits are local only; Universe remains on its original replatform pin. Prior “execution approval pending” statements describe the pre-approval stage and are superseded for this bounded batch only. New fixture corrections, source publication, base integration and Universe implementation remain separate decisions. See the report’s next-decision section.

## F4/F5 fixture planning checkpoint

TK authorized preparing and reviewing the [fixture investigation and repair plan](fixture-repair-plan.md). Read-only inspection of the installed dependency from the stopped qualified container explains F4's lost setup failure and stale exit-listener cleanup path; [static evidence](fixture-static-evidence.json) records identities. F5's failing stage is not yet known. The proposed next executable scope is Stage A: one instrumented backup fixture, one isolated run and one existing shard-4 diagnostic run, followed by a stop and repair review. No timeout increase, source repair, full qualification, source publication, base adoption or Universe implementation is authorized by this planning checkpoint. No new runtime execution occurred. [Claude prompt](claude-review-handoff.md#focused-review-of-f4f5-fixture-plan).

## Stage-A diagnostic execution outcome

TK approved Stage A after [Claude's plan review](fixture-plan-review-report.md) and Codex verification. [Results](fixture-diagnostic-results.md) record two completed diagnostic invocations on exact correction source plus the single-file timing patch. Backup passed twice; setup was 2.299 s isolated and 5.971 s in shard 4. The latter failed seven suites at collection because the five-prebuild proposal omitted the plugin SDK normally generated during full typecheck. This is an acknowledged setup-plan omission and limits workload equivalence. No timeout/repair conclusion follows from non-reproduction.

Runtime stopped; host source branches unchanged. The report proposes a separately approved SDK build/export check and one corrected shard-4 diagnostic. No extra build or retry occurred. Stage B repair, Stage C full qualification, remote source publication, base adoption and Universe implementation remain separate gates. Prior Stage-A approval-pending statements are historical and superseded only for the two recorded invocations.

## SDK follow-up disposition

TK approved the bounded SDK build/export-check/shard proposal. [Results and execution deviation](fixture-sdk-followup-results.md): SDK build passed; plain-Node import failed resolving a workspace TypeScript export. Codex then incorrectly launched the dependent shard before inspecting that failure and stopped the container on discovery. Its partial output is invalid; no final shard result or post-abort source manifest is claimed. No additional execution followed. The report proposes a TypeScript-aware loader plus a machine-enforced prerequisite gate, requiring a new bounded approval. F4/F5 repair, full qualification, source publication and base adoption remain open.

## Gated loader-aware diagnostic outcome

TK approved the corrected export check and one success-gated shard invocation. [Results](fixture-loader-check-results.md): both commands passed; shard 4 ran 6,031 passing tests with 3 existing skips, including all seven previously uncollected suites and both backup cases. Source/patch identity and all 7,664 tracked entries matched before/after; runtime stopped. The prior aborted run remains invalid historical evidence. SDK preparation/loading is now resolved for this environment; F5 did not reproduce (setup 6.233 seconds) and is not declared repaired. No additional backup-only rerun or speculative timeout change is recommended. Next is reviewing the exact F4 fixture repair and fault regressions, then separately approved source authoring/full qualification. No base adoption or Universe implementation.

## Consolidated closeout review

The [current whole-packet review](consolidated-plan-readiness.md) accounts for every slice and distinguishes complete-for-review planning from conditional runtime bindings and unapproved execution. The [F4 proposal](f4-fixture-repair-plan.md) includes exact test-only code, deterministic startup/cleanup faults and bounded verification. Self-review caught and corrected the fault-case count, added explicit test-file typechecking and SDK preparation, and clarified existing-branch reuse. No production source, fixture, container or provider execution occurred. Independent review of this new material remains pending; previous unchanged review findings are not reopened.

## Author review accepted as this round's review route

TK chose Codex review and proceeding with bounded F4 work. [Results](f4-repair-results.md) record unchanged original task assertions, two effective negative controls, 12 unit passes, a disclosed temporary-config failure followed by strict corrected typecheck success, and 11 real-DB passes. Source diff is test-only and local. The full baseline remains unqualified; no new Claude handoff is required for unchanged material.
