# Universe — implementation readiness review

September 11, 2026. Read together with the [master scope](master-scope.md), [UI specification](ui-review-decisions.md), [motion acceptance](motion-and-interaction.md) and [epic/task plans](implementation-plans/README.md). This is the completed readiness/planning pass, not permission to begin production work or a claim that gated integrations are ready. The per-epic plans name work packages, file ownership, dependencies and acceptance; provider/worker implementation details remain explicitly gated on qualification instead of invented signatures.

## Current authority after independent review

The historical September 11 evidence/results below remain dated records. Current published baseline is `183e46a9c65fc3105c7e3d125629276814df7dbb`; `codex/universe-interface` already holds the reviewed documentation commit. V1 allocation and branch/methodology are agreed; runtime approval, qualification and named reviewers are not. See [review response](independent-review-response.md), [publication](planning-publication.md) and [accepted release plan](release-plans/README.md). Historical component test passes are not newly run tests or Universe acceptance.

The [final planning decision packet](final-planning-decisions.md) records the latest remote-head check, verified focused-review closure and remaining security/provider/owner/draft decisions. Its source-identity check is complete; BASE runtime qualification and product approval remain open.

## Fresh evidence baseline (historical September 11 check)

Fetched origin during this review; no checkout/rebase/merge or implementation branch created.

| Reference | Revision |
|---|---|
| Working main | `06320643a72d8ef31904322a862abf09e3dc2168` |
| Origin main | `e097d2f9332a2715bdbaf2058a4b751481107713` |
| Origin replatform program | `f09230f3e331c5156eacfe8396755e2911e2152b` |
| Prior Universe review of replatform | `72479410be1e7a3ff4c55eaf5942c27f87144490` |

Merge-base of fetched main and replatform equals fetched main. The working checkout is not the implementation base; preserve its existing documentation and unrelated untracked work. Source reads below use the named revision and do not measure a deployed cloud environment.

## Findings that change the plan

1. **Distributed Commander remains gated.** Replatform `docs/replatform/epics/E10-desktop-migration-realtime/findings.md`, E10-F001, still records non-task routing, per-user provider credentials and interactive result delivery as open; owner remains unassigned. Shadow observations are not cutover. E2.2 distributed execution and dependent E3/E7 journeys must wait for real caller/ownership/result evidence. Existing authorized typed UI work does not need that cutover.
2. **Browser qualification remains necessary.** `packages/browser-runtime/src/launch-guard.ts` still rejects caller debugging ports/endpoints and requires Chromium sandboxing. Browser Use compatibility must preserve those rules. No bridge/stream transport was qualified in this review.
3. **Cloud policy evidence advanced.** The new September 11 DE-08 ruling in `docs/replatform/DECISION-REQUEST-de08-sandbox-egress.md` accepts a managed-shared tier exclusion with scoped disclosure and credential-boundary requirements; this is not evidence of provider egress enforcement. Do not re-ask a decision already recorded upstream. E8-F012 adds open verification of credential boundaries across stage-in paths and the reachable metadata service. Universe must inherit the final tier capability/disclosure and its gate evidence, not promise an enforced guarantee the tier does not supply.
4. **Sensitive browser profile artifacts need separate gates.** E8-F011 remains open. Its corrected finding distinguishes unverified bucket encryption/TTL from application-side purge-on-completion and audit gaps. Do not claim encryption absent from a source grep. E6.4 saved-profile enablement waits for retention/access/cleanup evidence; ordinary signed-out browsing is a separate acceptance target.
5. **Browser approval/recovery has additional upstream work.** E8-F001 and E8-F004 still record authority agreement and stranded-answer recovery gaps. E6 qualification must bind to the canonical browser decision owner and demonstrate reconnect/answer recovery, not implement a new approval authority in the canvas.
6. **Catch-up must preserve new disclosure filtering.** Replatform's `proactive.ts` now excludes security-denial audit records from tenant-facing digest input through its namespace predicate. E2.3/E7.3 must reuse the allowed projection; do not pull raw activity into model context or reconstruct sensitive records in Universe.
7. **Actual chat limits differ from earlier proposed draft limits.** At both inspected main and replatform, `chatMessageSchema` caps message at 10,000 characters, page context at 5,000, client submission ID at 200, and attachments at five. Initial sending follows these limits. Draft storage may preserve larger recoverable text, but must show that it cannot all be submitted at once. No silent truncation or proposed 20-attachment send.
8. **Reuse existing components without importing the old window shell.** `CommanderTaskFocusPane` takes `issueId`, optional `anchorId`, `onClose`; it renders TaskDetail in workspace mode. `CommanderInput` already handles rich input, references and file selection. Extract reusable content/composer boundaries while Universe owns its own window controller. Do not nest independent panel chrome or replace richer existing input with the mock's plain field.
9. **Home persistence remains whole-layout based.** `useHomeBoardLayout.ts` saves the complete array. Universe still needs actor/conversation-scoped revisions and independent drafts. React Flow is not in the inspected UI manifest; pin and verify its version during E0/E1 without changing dependencies in this planning pass.
10. **Realtime remains a hint.** Replatform `live-events.ts` appends asynchronously/best-effort. Snapshot repair supports UI convergence; authorized routine execution requires durable intent in its owning system, not receipt of a frontend event.

## Dependency register

Owners are workstreams, not invented assignments or tickets. An unassigned upstream gap remains unassigned until the owning program accepts it.

| Gate | Owner | What waits | Closure evidence / what may proceed |
|---|---|---|---|
| BASE | Universe + replatform integration | Runtime edits using new schemas/authority | Accepted exact revision and tenant repository/auth patterns, compatible migration sequence; documentation/design can proceed now. |
| DESIGN | Universe design, feature epic owner | Affected production UI | U01–U10 plus empty/loading/error/offline/revoked/conflict/narrow-screen and accessibility states reviewed; mock entry-route defect still open. |
| CMD | Replatform E10-F001, unassigned upstream | Distributed Commander E2.2; dependent voice/routines | Real per-user credentials, non-task routing, owner transfer and interactive results with lost-ack tests. Existing admitted typed UI remains usable. |
| BROWSER | Universe E6.0 + replatform browser owner | E6.1–4 integrated browser claims | Contained Browser Use attachment, authenticated cloud/local stream, control epochs, canonical approval/recovery tests. UI placeholders may be designed but cannot pass runtime gate. |
| CLOUD | Replatform E8 policy/credential controls | Managed cloud release claims | Apply September 11 tier ruling; satisfy open E8-F012 evidence and publish honest capability/disclosure. Do not silently weaken higher-tier requirements. |
| PROFILE | Replatform sensitive artifacts + Accounts and Access | Saved browser login/profile reuse in E6.4 | Actual access, retention, encryption/TTL evidence, purge/audit and revocation; exclude saved profiles until qualified, preserve them in full scope. |
| APPROVAL | Replatform E8-F001/F004, unassigned upstream | Browser approvals and reconnect recovery | One authoritative decision binding and stranded-answer reconciliation; no canvas-owned substitute. |
| VOICE | Universe voice/provider owner + architecture owner | Real provider sessions in E3 | Explicit scoped speech credential capability, accepted amendment to existing runtime-key rules, provider-specific contract tests. CLI login never proves speech capability. |
| HOST | Universe isolated-tool owner | E5.2 executable content | Real origin/CSP/bridge/revocation and resource-control validation; first-party reviewed blocks proceed separately. |

The register is not an exhaustive replatform release audit. E8.2 also consumes the owning program's current release gate result at the accepted integrated revision.

## Recommended sequence

1. **Preparation:** E0.1 binding, E1.0 remaining screen states and observed-defect capture. Establish the actual replatform/tenant API base. E6.0 qualification planning and provider capability research can run independently, without spawning jobs or spending on cloud in this pass.
2. **Core vertical journey:** E1.1 shell/window controller, E1.2 saved state, E1.3 drafts, E1.4 tray/overview, E1.5 Commander presentation, E1.6 motion/viewport, E2.1 context, E2.4 task chat and E8.1 personal settings. Existing typed service and manual E4.1 uploads underpin the first integrated journey. No dependency on distributed Commander for pure presentation or ordinary uploads.
3. **Canonical results and materials:** E2.2 admitted request/outcome path, E2.3 catch-up, E4.2 derivatives, E4.3 versions, E5.1 reviewed blocks, E7.3 shared visual attention. Keep distributed/provider subparts gated; preserve new denial-disclosure filtering.
4. **Realtime and browsers:** E3.1–2 OpenAI voice, E6.1–4 local/cloud browser paths after gates. E7.1 routine integration consumes canonical authority. E8 provider/settings/release work accompanies each consumer.
5. **Breadth:** E3.3 Gemini/ElevenLabs, E5.2 isolated tools, E7.2 proactive triggers and generation-provider expansion. Independent work need not wait for every step in the earlier wave; dependencies, not list position, decide.
6. **Later:** E3.4 pipeline/local speech; multi-screen feature reconsidered after desktop app, outside these 31 slices.

Recommendation for discussion: internal Core milestone first, then a release candidate with voice and qualified local/cloud browsing. Retain all three realtime providers and local/cloud browsers in the accepted 30-slice V1; E3.4 alone is V2. This supersedes the earlier unallocated recommendation. Browser/profile/cloud-policy gaps block specific capabilities, not the entire Universe project.

## Merge, integration and rollback

- At execution start, verify ancestry and accepted revision again. Use the existing codex/universe-interface branch created from the recorded base; any later source update requires ancestry/contract review. Runtime implementation still requires explicit approval.
- Changes to shared replatform routing/credential/approval contracts belong upstream. Universe contributes consumer tests and tracks their merge/base requirements; avoid copying upstream mechanisms into new canvas services.
- Before each task merge, integrate necessary upstream changes and run affected contract/component/integration checks. Before release run the repository typecheck, tests and build plus connected journeys on the combined tree. Do not count isolated fixture success as real integration success.
- After replatform lands, inspect actual squash/preserved ancestry before reconciling with main. Do not blindly merge duplicate histories. Data migrations are additive/generated and compatible with existing readers.
- Feature rollback hides Universe and stops new feature actions, retaining conversations, drafts, artifacts and canonical tasks. Voice closes; browsers follow their execution lifecycle. Rollback is not dropping tables or deleting saved work.

## Questions for the next discussion

Follow-on planning now supplies the accepted [V1/V2 allocation](release-plans/README.md) and [31 individual slice plans](slice-plans/README.md). Use that accepted allocation rather than re-inferring a version cut from the sequencing waves. The user has agreed to complete and verify V1 before V2 implementation; commercial ownership remains separate.

No user answer blocks this readiness package. Two later product decisions remain: public release grouping (all providers/both browser locations at first public launch versus staged releases), and managed/customer-connected cloud rollout/commercial ownership. Recommendation: staged internal milestones; defer public packaging and commercial commitment until qualification evidence. Engineering questions about final APIs, timing and screen bounds belong to the named qualification tasks; do not ask the user to select implementation internals.

## Verification limits

Fresh source/ancestry review completed. Existing Commander input and task-focus component tests: five tests passed. These establish reusable component behavior only, not Universe implementation or the inline mock defect. The initial test command also named a nonexistent toast-test path; Vitest ran only the two matching files. A corrected toast path is checked separately in the final verification record. No provider session, cloud sandbox, worker compatibility or production release test was run. Full repository typecheck/tests/build are reserved for runtime implementation; this change is documentation only.

Final targeted results: `ui/src/lib/__tests__/hub-toast-bridge.test.ts` passed five tests and `server/src/__tests__/commander-multi-chat-schema.test.ts` passed three. Together with the five component tests, **13 existing tests passed across four files**. No proposed Universe tests were run because production files and tests are not created by these preparation plans.

Documentation verification: 18 documents checked for relative links/heading anchors and whitespace; nine epic plans contain exactly the 31 unique slice work packages in the epic register. No coverage or link errors. Preparation-plan placeholder scan found no unresolved placeholder markers. This structural check does not turn qualification-dependent work packages into executable coding plans.

## Reconciled readiness boundaries

These are parts of the accepted V1, not a smaller ship-ready V1:
- Foundation/presentation work can progress after explicit approval and BASE/DESIGN/preference-contract readiness: E1 controller/layout/tray/surfaces, E2.1 context, E2.4 manual task replies and corresponding E8.1 controls.
- Manual E4.1 intake uses TK-selected A and additionally requires its exact application authorization/transaction qualification. E5.1 local rendering can progress separately, but full block persistence/actions require E1.2 checkpoints, E1.3 drafts and E2.2 outcomes. Neither whole slice is presently certified.
- E2.3 snapshot core consumes E1.2/E2.2/1; integrated attention consumes E7.3/1. E7.3/1 publishes authorized read projection using existing canonical reads/replay and E8.1/1 preference contract; it does not depend on E2.3's aggregate snapshot. E8.1/2 binds its UI after consumers.
- E4.2 converter/indexing and E4.3 media generation need named runtime/distribution/policy qualification. Indexing retains private destination authorization through search/context and is not implicit company Memory ingestion.
- E7.2 has an explicit terminal-writer inventory/transaction gate: choose complete per-writer markers or a proven canonical transactional outbox/chokepoint. Routine-run qualification may precede issue-source qualification, but both remain V1.
- CMD/BROWSER/CLOUD/PROFILE/APPROVAL/VOICE/HOST remain open for their affected increments. BASE is an accepted source pin plus still-open execution refresh/authority review, not a claim that replatform is fully stable. DESIGN/UAT remains separate from engineering gates.

Before coding a gated increment, record an accountable engineer and reviewer, source/protocol evidence, acceptance test and dependency commit in its binding record. Workstream labels are not named ownership, and this correction assigns no people. Human intake A and preserving the excluded draft are accepted planning decisions; separate distributed-ledger authority, concrete media execution/credential policy, terminal transaction design and host/converter qualification remain explicit review items. Verify selected A's exact company/actor/destination and same-role publication boundary before implementation; no non-owner grant expansion or owner fallback is adopted by this plan.

The report's fixed-750ms routine-tick claim is incorrect: pinned index.ts uses config.heartbeatSchedulerIntervalMs for the routine timer. E7.1's bounded in-flight guard/export tests follow that actual seam. #104's August 8 cloud credential amendment narrows the older keyless principle; new media API permission still requires qualification and cannot be inferred.

### Formal user acceptance

[The UAT plan](user-acceptance-plan.md) maps U01–U10, all master connected journeys and every slice to numbered human acceptance scripts and a pass/fail/blocked/not-run record. E8.2 aggregates per-slice results. Developer tests cannot substitute for TK or a designated product tester's recorded acceptance. No UAT is claimed executed here.

## Worker-publication readiness update

The [worker-publication proposal](worker-publication-plan.md) replaces generic alternatives with a concrete per-store recommendation and recovery protocol. E4.2/2 owns its common producer; E4.3/1 and E5.2 consume relevant boundaries. It does not close runtime readiness: exact processor admission under frozen source kinds, accepted output-slot mapping, permission-revocation serialization, retention/promotion policy, application security classification and HOST evidence still need qualified bindings/owners. No new slice/increment or V1 reduction is proposed.
