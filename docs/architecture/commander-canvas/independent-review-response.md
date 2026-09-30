# Universe — independent review response and reconciliation

September 12, 2026. **Documentation corrections only; not coding-ready and no implementation approval.**

TK supplied [Claude's review report](independent-review-report.md) of `f63b84461341fc93f65417103fc8e57357a93939`, pinned to source `183e46a9c65fc3105c7e3d125629276814df7dbb`. The author checked the findings against that checkout and accepted product decisions, then reconciled the owning plans and consumers. This record is an author response, not Claude's re-review or TK's acceptance of architectural options.

## Verdict

The two HIGH producer-completeness defects are confirmed. Recording a missing producer centrally was insufficient: an implementer following E1.2 would omit it. The owning E1.1/E1.2 outlines, detailed contracts, receipt/hydration behavior and regression plans now include opening order and checkpoints.

Most MEDIUM findings describe valid cross-document drift or underspecified verification. The proposed scope reductions in M7/M12 are **not adopted**. All nine epics, 31 slices and 69 original increments remain; 30 slices remain V1, E3.4 alone V2, and multi-screen remains outside the count. Neither a useful independent portion nor local tests can close a gated whole slice.

## Finding dispositions

“Corrected” below means corrected in the planning text and proposed checks, not implemented or runtime-verified.

| ID | Disposition and evidence | Correction / remaining gate |
|---|---|---|
| H1 | Confirmed: reviewed E1.2 had no checkpoint producer despite the shared binding/E5 consumption | E1.2/1 now includes table/exports/generated migration, authenticated GET/PATCH, absent-row CAS, limits/audit and real-DB regression plan; outline and E5 verb/producer references aligned |
| H2 | Confirmed: overview required openedOrdinal without E1.1/E1.2 producer | E1.1 declares separate ordinal/counter; E1.2 allocates under row lock and returns mapping/counter in stored acknowledgements. Focus is independent; optimistic reconcile, close/reopen, concurrent opens, receipt and reload tests specified |
| M1 | Confirmed filename drift | Canonical overview/rail, viewport/motion, draft and Commander test names aligned. E2.1 has both a shared types file and strict validator file, with server resolver under internal-agent. E5 registry remains .tsx because its implementation contains JSX; all inventories use that extension |
| M2 | Confirmed apparent E2.1/E1.6 cycle | E1.1 owns measured viewport; E1.3/1 owns draft snapshot contract; E2.1/1 captures/resolves without E1.6; E1.6 consumes that projection. Distinguish early contract publication from full integration acceptance |
| M3 | Confirmed start-condition drift | E2.1/E5.1/E7.3 outlines, addenda and epic register now name actual producers/phase gates. E8.1/1 publishes before consumers; E8.1/2 UI closes with consumers. Voice dependency lines also clarified |
| M4 | Confirmed text-only illustration did not design all five draft kinds | E1.3 now specifies bounded DraftPayload/PendingAttempt per source, source versions and acknowledgement hashes. Question uses actual answerWorkQuestionSchema; runtime decision uses expectedSourceRevision and rehydrates nonce only on explicit submit; approval does not invent CAS/idempotency APIs. All kinds stay V1 |
| M5 | Confirmed obsolete allocation wording, including master scope's initial “proposed” paragraph | Current authority paragraphs now point to accepted 30-slice V1 / E3.4 V2; historical evidence is explicitly dated. Branch creation and later methodology are distinguished from pending runtime approval |
| M6 | Confirmed cross-role transaction overclaim: aoa_app assets/artifacts grants are SELECT only; assetService.create inserts | Removed assumed atomic cross-connection publication. E4 lists unselected A same-role company-scoped ledger, B reviewed non-owner grants, C durable cross-role intent/receipt alternatives. Recommend A for human intake only, subject to security review; no grants/fallback/data class silently adopted |
| M7 | Partly valid policy qualification concern; blanket “only embeddings runtime key” premise is superseded for cloud_auth by #104's August 8 amendment | New media APIs still require a deployment-specific permitted path/amendment and qualification. Do not remove agreed image/audio/video generation from V1. Provider availability remains unproven |
| M8 | Confirmed undeclared E7.3 attention dependency | E2.3 core may be built after layout/outcome contracts, but full snapshot completion waits for E7.3/1 authorized projection. That producer uses existing canonical reads/replay, not E2.3 aggregate snapshot; no reverse cycle and no optional V1 omission |
| M9 | Existing reduce-only prose was present; executable contract/test ownership needed strengthening | E7.3 shared policy owns monotonic eligibility tests and claim/attempt rechecks; E8.1 stores personal inputs only. Tests cover every boolean/inherit/quieter combination, reset, saved stricter choice and stale tabs |
| M10 | Confirmed architectural gate is broader than slice wording; an exact “18” writer count was not independently established | Explicit exhaustive terminal/reopen writer map and per-writer marker vs canonical outbox/chokepoint decision in E7.2/readiness. Routine-run work can qualify first; both source kinds still required for V1 |
| M11 | Accepted as risk visibility, not a new code defect | Readiness now distinguishes independently buildable portions from complete slices. E5.1/manual E4.1 are not categorically ship-ready: their own state/action/security gates apply. Owners remain unassigned until people accept them; no scope cut or invented readiness |
| M12 | Confirmed missing indexing retrieval boundary despite raw-asset authorization | Keep indexing; E4.2/2 specifies destination-scoped index and sole authorized search/context reader, private canary/revocation/cache/stale-worker tests; no implicit Memory ingestion. E4.1/2 consumes index receipt. Storage/vector/embedding qualification remains open |
| M13 | Confirmed formal human acceptance layer missing, despite broad automated and connected acceptance coverage | Added 20 numbered UAT scripts, U01–U10/nine master-journey mapping, all 31 slice records, real tester/product approval templates and known task-route/settings omissions. E8.2 aggregates; all runs not_run |
| L1 | Historical source revisions are valid dated evidence, not necessarily stale | Marked ancestor-dated investigation records and pointed to current pin/BASE refresh; did not fabricate new runs or rewrite historical results as current |
| L2 | Partly accepted: nearby line numbers benefit from symbol anchors, not every cited number was wrong | Current RLS/launch/save anchors target declarations; retain historical references with date. CommanderTaskFocusPane really is declared at line 19. Browser run-session prose is not relied on to deny existing commandKind handling; rebind by symbol at runtime BASE |
| L3 | Confirmed 1e7 reducer vs 1e6 persistence mismatch | Reference reducer, slice and controller contract now share ±1,000,000; planned boundary rejection tests cover both |
| L4 | Mount/export distinction and broader publication seams needed precision | app.ts owns API mounting; route/service barrels export. Existing docker.yml/release.yml are named alongside pr.yml for artifact-specific binding; no new asset pipeline is claimed implemented |
| L5 | Valid request for explicit output consumption; some E4.3 read-path prose already existed | E2.2 now spells out linked reply → output_refs → exact authorized artifact/version, nullable-version blocking and regression plan. pageContext explicitly ambient/excluded from fingerprint; frozen domain intent remains included |
| L6 | Helper export/overlap concern confirmed; fixed 750ms routine cadence incorrect | Private helper at routines.ts:122 needs explicit export. index.ts:1699–1719 uses config.heartbeatSchedulerIntervalMs. Plan now guards a bounded cycle and preserves configured interval/caught failures plus DB replica safety |
| L7 | Confirmed history semantics lacked sufficiently complete contract | E1.1/reference/panel contract now specify one gesture=one entry, 50 bound, generation/current-rect fences, redo invalidation and CAS/lost-ack behavior. No close resurrection, ordinal rewind or content undo |

## Concrete source checks behind qualified findings

At the unchanged source pin:
- `server/src/db/job-control-legacy-grants.ts:43–45`: SELECT-only on assets/artifacts/versions; `tenant-context.ts` gives a non-owner transaction; `assets.ts` create inserts. A transaction object does not cross connection/role authority.
- `docs/architecture/decisions.md:939–990` and `server/src/services/one-shot-sandbox-cli.ts`: #104 cloud_auth amendment and company credential materialization for sandbox-local CLI; not general direct-media permission.
- `packages/shared/src/work-questions.ts:202`: answerWorkQuestionSchema includes answer, expectedVersion and idempotencyKey (the report's shortened shape omits answer). `validators/hub.ts:119+`: runtime source revision/nonce/optional key. `validators/approval.ts`: resolveApprovalSchema does not supply a generic version/idempotency envelope.
- `server/src/index.ts:1699–1719`: configured routine tick cadence; the report's 750ms location is a different timer.
- `server/src/db/rls-tenant.ts:89`: frozen table declaration; CAV-005 exclusion remains binding. `CommanderTaskFocusPane.tsx:19` is its function declaration, so this specific line is not erroneous.
- `server/src/app.ts` directly mounts per-company routes; `.github/workflows/docker.yml` and `release.yml` exist but do not establish proposed converter/host distribution.

## Decisions still open

1. E4 intake/derivative/index and E5 grant-ledger authority and publication composition: named security owner, permitted same-role path or explicitly reviewed cross-role protocol; no migration/privilege change authorized here.
2. Each new media/speech/provider path: applicable policy, credential class, execution location, isolation, limits and qualification evidence. Preserve V1 while unresolved; bring material cost/policy choices to TK with source-backed recommendations.
3. Named accountable owners/reviewers and actual closure evidence for BASE execution refresh, CMD/BROWSER/CLOUD/PROFILE/APPROVAL/VOICE/HOST, converter/index distribution and terminal-writer gates.
4. Premature-draft delete/preserve/reuse disposition. It remains untouched and excluded.
5. User-managed Claude re-review of the changed plan; explicit later implementation approval remains required.

These corrections need no new product toggle or reduced release. The report's “TK per-finding acceptance before any edits” sentence is a reviewer interpretation, not the [agreed handoff](claude-review-handoff.md#returning-findings). That handoff authorizes checking findings and updating valid planning corrections, while reserving material decisions and all implementation approval.

A final read-only cross-review caught two further propagation errors: the old initialPanels prop discarded persisted ordinals, and one E1.3 checklist still generalized message idempotency to approvals. The correction now supplies AuthorizedLayoutSnapshot/hydrateLayout/reconcileOpeningAck with operation-index/incarnation matching, and source-specific submission steps. The old global coordinate-bound prose was aligned too. These are further author corrections, not external acceptance.

## Verification and next review

This is a documentation-only reconciliation at the same replatform pin. Coverage/link/anchor/whitespace/source-inventory validation results are recorded in the publication follow-up. No runtime code, dependencies, migrations, tests, provider sessions, draft implementation changes or live user-acceptance runs were performed.

Next Claude review should compare this branch's new head with f63b844, revisit H1/H2/M1–M13/L1–L7 and check both producer and consumers, UAT coverage, no accidental dependency cycles and unchanged scope. Ask for unresolved findings and source evidence, not implementation. Product/policy options remain proposals until accepted; a passing re-review still does not authorize coding.

## Re-review follow-up: two residual planning gaps

TK supplied Claude's re-review of 11ab248b618dae228f2ac6efca8e02f4b4e4d132. Its structural and substantive confirmations are supported, but the blanket conclusion that all actionable gaps were resolved was too broad. A read-only author check found two residual inconsistencies; TK then authorized correcting the plans. This follow-up does not convert external review into runtime approval.

1. **Attention producer ownership (M8 propagation):** E2.3/shared bindings named E7.3/1, while the detailed service/GET/client/tests were still assigned to E7.3/2. They now explicitly belong to E7.3/1; E7.3/2 consumes the published contract for surfaces and answer forms. The producer has no dependency on E2.3's aggregate, E2.4's UI or the delivery ledger. The outline and epic start conditions now agree.
2. **Layout round trip:** AuthorizedLayoutSnapshot omitted viewport and the write union omitted selected/maximized state. The snapshot now includes viewport; explicit presentation operations persist selected/maximized together with order and camera through the existing revision/receipt transaction. Registry and camera hydrate from one revision without generating saves. Candidate-state semantics, conflict grouping and save/reload/restore tests cover all fields, including smaller displays and lost acknowledgements. UAT-05 includes these observations.

These are documentation corrections with planned regressions, not runtime fixes or executed UAT. Existing security/data-class, permitted-provider-path, qualification/owner, BASE refresh and premature-draft disposition gates remain open. Terminal-writer coverage is a required future inventory, not an inventory certified complete by either review. The source pin, accepted release scope and 69 original increments are unchanged.

## Subsequent accepted human-asset direction

After receiving the final decision packet and explanation, TK requested the recommended direction be adopted in the plan and carefully reviewed. E4.1 now selects A for human original intake, rather than keeping B/C implementation branches in the same slice. Company/actor/destination checks, original preservation and distinct output versions remain required; company scope never implies all-company visibility. Organization IDs in the intake schema are routing/integrity metadata only. E4.2/E4.3 and E5 distributed data/publication protocols are not selected by this human-intake decision.

The author checked the resulting intake service/schema/finalize/audit/recovery steps and consumers, removed the proposed human-intake tenant-repository extension, and retained denied-access/crash/duplicate tests as planned evidence. Existing assetService.create accepts a supplied Db handle; getById alone is not authorization, so the planned destination-access service remains mandatory at read routes. This self-review does not close security/runtime qualification or replace independent review of the new material planning change. Preservation of the excluded draft is accepted; its code was not reused. Concrete provider policy, reviewer identities and explicit implementation approval remain open.

## Verified focused review of selected A

TK supplied [Claude's human-intake report](human-intake-review-report.md), reviewing abbfc3c7eea05932fb53d9c07b93b5ba1c2941d8 against 51e5b36d and source 183e46a9c. The author verified the exact commit/diff, unchanged source ancestry, intake authority/service/schema/finalize/audit/recovery text, private-serving requirements and separate distributed gates. The focused PASS is supported; no material correction is required.

The proposed-output summary is explicitly representative, with additional files in the coding addendum; omission of the access guard from that summary is not a missing implementation obligation. The organization_id note reinforces existing routing-only semantics and required authenticated denial tests. Those are planned tests, not executed proof. Preserve both observations as review guidance; no new architecture decision or runtime gate closure follows.

Structural verification reports 124 packet documents before adding this preserved report, 31 slices/coding plans, 69 increments in each set and 20 UAT scripts, with no audit errors. The report's zero-new-files statement applies to the reviewed one-commit delta, not all documentation added since replatform. Publication of this closure adds only the received report and documentation status/next steps. Implementation remains unapproved.

## Worker-publication review disposition

Received [Claude's report](worker-publication-review-report.md) on 0d8876cdf333ba433c792127e8b4b264fb3a5d22 against 8b1dab340 and pinned 183e46a9c. Author source verification supports the overall coherent-proposal verdict, with these dispositions:

| Finding | Disposition |
|---|---|
| M1 accepted output identity | Valid existing gate. Follow-up now specifies exact canonical action tuple, persisted slot UUID, accepted binding/CAS and producer ownership. Actual CMD/result adapter remains gated. |
| M2 other-kind promotion | Accept tightening. Strict default-deny processor/build/slot/type/validator/hash-policy/promotion-policy tuples, forbidden-lineage checks and disguised other-kind negative fixtures added. Hash alone is not a secret/content detector. |
| M3 revocation ordering | Valid highest-priority confidentiality gate. Follow-up proposes company and actual credential authority barriers, initial writer inventory, global lock order and deterministic race tests. Exhaustive writer/credential coverage and runtime proof remain open. |
| LOW-1 cascade wording | Reject with pinned source evidence: packages/db/src/schema/job_artifacts.ts defines composite job_artifacts_org_job_fk on organizationId/jobId and calls .onDelete("cascade"). The separate organizations FK restricts; it does not override the job FK. Receipt lifetime still remains independent. |
| LOW-2 static callback | Accept verification obligation already in design; add explicit source-registration and forged-selector checks. |

The original report is preserved separately; no reviewer text is silently corrected. New M1/M3 mechanisms are proposals needing independent/security review, not proof of completed qualification. No implementation or human-intake decision is reopened.

## Reconciliation review of a033e17c0

[Claude's follow-up report](worker-publication-reconciliation-review-report.md) confirms M1/M2/M3 contract consistency and withdraws LOW-1. Author verification supports that verdict. MEDIUM-A (real CMD acceptance binding) and MEDIUM-B (complete permission-writer/credential coverage) remain existing qualification gates, not newly undisclosed defects. M2 is closed as a design contract; per-processor validation remains unqualified. LOW dependency-direction verification is accepted.

Qualify two phrases in the report: documented lock ordering does not prove deadlock freedom; company shared locks allow concurrent publishers, while exclusive permission changes and some ordinary company writes can contend. The [qualification record](worker-publication-qualification.md) expands source discovery, maps existing Commander seams and absent producer obligations, separates credential modes and adds real contention/implicit-lock acceptance checks. The static inventory is explicitly not exhaustive certification. The focused consistency round is closed; security/runtime acceptance and implementation approval remain open. No unchanged review needs automatic repetition.

## Voice/media review disposition

The [received review](voice-media-review-report.md) of 9da889601d3a5799daad4fcc328b58b1296cd37d has two medium and one low supported planning findings. [Corrections](voice-media-review-corrections.md) specify durable restricted-secret classification at the common resolver, a separately scheduled canonical Budget prerequisite inside E8.1/1, and database-enforced session ownership in E3.1/2. The proposed binding-presence fix alone is insufficient after unbinding and needs shared-key compatibility treatment. Vendor limitations are review coverage limits; the author rechecked four cited official claims without provider sessions. No runtime/security acceptance is inferred. This new mechanism warrants a focused review; existing privacy and release decisions remain settled.

## Voice/media correction review disposition

The [received correction review](voice-media-corrections-review-report.md) of 47b50fd942bc7272fe9bc758fc4419196fe54e49 is source-supported. Original M1/M2/L1 design findings are resolved. Residual medium Budget coverage/ownership and low alternate-secret/schema items are qualifications already named by the plan. Subsequent [static inventory](voice-media-qualification-inventory.md) enumerates the source paths and separates metadata readers, privileged backup and derived-cost readers from actual resolution/admission/writers. Accepted responsibility model is recorded in the [preparation proposal](bounded-engineering-preparation.md). Runtime/tenant/provider proof remains open; no need to repeat the unchanged Claude review.
