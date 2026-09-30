# Universe — execution dependency gates

September 13, 2026. [Sequence](execution-sequence.md) and [package mapping](execution-increment-map.md) identify exactly which work consumes each gate. These are role assignments, not invented named maintainer commitments. Codex coordinates the binding record; before dependent execution, record the accountable person, source revision, evidence link and reviewer disposition. A missing assignment blocks the affected binding, not unrelated approved V1 work.

**Entry evidence and completion evidence are different.** Documentary/discovery packages may produce the reviewed binding. Actual consumer source work starts only after that binding and applicable upstream authority/environment are available. Runtime tests needing the consumer follow implementation and remain mandatory for its acceptance. A real upstream producer's qualification cannot be replaced with a proposed interface or a passing Universe mock.

All statuses below describe remaining binding/qualification work; the accepted human-intake direction and provider privacy choice are not reopened. Replatform BASE alone is closed by [base integration evidence](base-integration-results.md). Provider/worker/profile/host capability is never inferred from BASE passing.

## PERSONAL_IDENTITY

**Status:** open. **Responsible roles:** E0/E8 identity and DB reviewer; Codex prepares evidence.

**Used by:** E8.1/1.b, E1.2/1, E1.3/1.b.

**Entry requirement:** Review stable local_trusted/authenticated identity, company/user ownership and exact schema/route role binding before implementing the store; concurrency tests are outputs.

**Completion evidence:** Stable authenticated/local_trusted user identity, company+user predicates, same-role generated schema and absent-row concurrency tests

**Contract/qualification owner:** [detailed plan](coding-plans/e8-1.md).

## D3_DESIGN

**Status:** design_reviewed_binding_open. **Responsible roles:** Codex security/Budget author plus assigned technical reviewer.

**Used by:** E3.1/1.a, E8.1/1.c, E8.1/1.d.

**Entry requirement:** Apply the accepted D3 policy and obtain source-bound credential/session/Budget design review before dependent runtime code; initial documentary mapping can establish that binding without paid calls.

**Completion evidence:** Bind accepted credential/session/Budget design to actual source/roles/migrations and reconcile active instruction baseline; provider terms decision stays accepted

**Contract/qualification owner:** [detailed plan](voice-media-review-corrections.md).

## PROVIDER_ACCESS

**Status:** open_per_provider. **Responsible roles:** Deployment/company provider administrator; Codex qualification author.

**Used by:** E3.1/2, E3.3/1, E3.3/2, E3.1/1.b, E3.4/1.

**Entry requirement:** Before an authorized live probe: permitted provider account, approved purpose/region/retention, credentials, supported device, explicit cost ceiling and cleanup owner. Documentary work does not require credentials.

**Completion evidence:** Explicitly available permitted credentials, device and test budget; official current provider contract plus admin accepted region/retention under company policy. No paid call from settings read

**Contract/qualification owner:** [detailed plan](voice-media-policy.md).

## HOST_OWNER

**Status:** open. **Responsible roles:** Deployment operator and isolated-host security reviewer; individual assignment required.

**Used by:** E5.2/1.a, E5.2/1.b.

**Entry requirement:** For discovery, assign the deployment owner and provide source/config access. Before host implementation, accept exact deployment/containment design. Runtime malicious-fixture proof is produced in the qualification package.

**Completion evidence:** Exact deployment files/revision, origin/headers/CSP/egress and resource containment facility; /1.a discovers, /1.b proves runtime

**Contract/qualification owner:** [detailed plan](coding-plans/e5-2.md).

## BROWSER_OWNER

**Status:** open. **Responsible roles:** Replatform browser/worker owner; individual assignment required.

**Used by:** E6.0/1.a.

**Entry requirement:** Assign the upstream browser/worker owner and provide guarded attachment source plus protocol decision access for feasibility; qualification is the output.

**Completion evidence:** Exact Browser Use/worker attachment seam and common identity/transport decision; no debugger port or sandbox bypass

**Contract/qualification owner:** [detailed plan](coding-plans/e6-0.md).

## HUMAN_INTAKE

**Status:** selected_A_binding_open. **Responsible roles:** Codex intake author and asset/auth/storage reviewer.

**Used by:** E4.1/1.

**Entry requirement:** Selected A is settled. Review actual actor/company/destination and same-role storage/transaction bindings before source edits; crash and revocation tests follow those edits.

**Completion evidence:** Selected A actor/company/destination authorization, same-role atomic publication, storage crash/revocation tests and generated schema order

**Contract/qualification owner:** [detailed plan](coding-plans/e4-1.md).

## PROCESSORS

**Status:** open_per_format. **Responsible roles:** Processor/deployment operator; Codex materials author.

**Used by:** E4.2/1, E4.2/2.

**Entry requirement:** Provide pinned available converter/distribution candidates, license/deployment permission and disposable fixture environment. Format support and measured limits are qualification outputs.

**Completion evidence:** Pinned converter/image distribution, licensing/deployment availability, resource limits and damaged/encrypted/oversized fixture matrix

**Contract/qualification owner:** [detailed plan](coding-plans/e4-2.md).

## INDEX

**Status:** open. **Responsible roles:** Index/storage and authorization owner; Codex consumer author.

**Used by:** E4.2/2.

**Entry requirement:** Review destination-scoped index writer/retrieval and revocation contracts with their source owner before binding; implementation tests prove the contract afterward.

**Completion evidence:** Qualified writer/retrieval boundary with destination lineage, revocation, private-source and no implicit Memory publication evidence

**Contract/qualification owner:** [detailed plan](coding-plans/e4-2.md).

## ACTUAL_UI_HOST

**Status:** open. **Responsible roles:** Target-host operator and Codex UI test author; TK acceptance.

**Used by:** E1.0/2.

**Entry requirement:** Provide the actual supported application host, browser and input modes. The package executes and records the route regression; a prior passing run is not an entry requirement.

**Completion evidence:** Access to actual supported host/browser and input modes. Component/standalone mock is insufficient for the reported route defect

**Contract/qualification owner:** [detailed plan](coding-plans/e1-0.md).

## SECURITY_OWNER

**Status:** open. **Responsible roles:** Credential/Budget service owners and assigned independent technical reviewer.

**Used by:** E8.1/1.c, E8.1/1.d.

**Entry requirement:** Assign credential and Budget writer reviewers and approve exact source/roles/transaction design before code; enumerate all affected writers. Concurrency, cap and stop tests are completion evidence.

**Completion evidence:** All resolver/export/mutation and spend writers, concurrency/cap enforcement, stop delivery and conservative unknown-exposure evidence; not preference-policy ownership

**Contract/qualification owner:** [detailed plan](voice-media-qualification-inventory.md).

## CMD

**Status:** open_upstream. **Responsible roles:** Replatform Commander owner; Codex consumer; accountable upstream individual not yet recorded.

**Used by:** E2.2/2.a.

**Entry requirement:** Upstream must supply the actual qualified distributed routing, per-user credential, cancellation and originating-result authority revision. Universe cannot implement a substitute authority to clear this gate.

**Completion evidence:** Actual E10-F001 routing, per-user credential, cancellation and originating result authority at a qualified revision; source existence alone does not close

**Contract/qualification owner:** [detailed plan](worker-publication-qualification.md).

## WORKER_PUBLICATION

**Status:** open. **Responsible roles:** Codex output-binding/materials author and auth/worker/security reviewers.

**Used by:** E2.2/2.a, E4.2/2.

**Entry requirement:** Review accepted-output slot/cancel/permission-writer contracts and assign their owners. E2.2 produces accepted output binding; E4 later proves canonical publication and reply repair. Do not require E4 publication before E2.2 producer code.

**Completion evidence:** Accepted-output owner/slot/cancel transaction, permission-writer lock coverage, receipt/revocation/competing-attempt tests and processor default-deny tuples

**Contract/qualification owner:** [detailed plan](worker-publication-qualification.md).

## BROWSER_APPROVAL

**Status:** open_upstream. **Responsible roles:** Replatform browser/approval owners; Codex browser consumer.

**Used by:** E6.0/1.b, E6.1/1, E6.1/2.a, E6.1/2.b.

**Entry requirement:** Receive qualified upstream approval delivery/recovery and admitted worker attachment contracts before consumer code; streaming and takeover acceptance remain downstream.

**Completion evidence:** Actual E8-F001/F004 approval delivery and stranded-answer recovery plus guarded admitted worker attachment; no replacement authority

**Contract/qualification owner:** [detailed plan](coding-plans/e6-0.md).

## CLOUD_ENV

**Status:** open_upstream. **Responsible roles:** Cloud/worker operator and security reviewer.

**Used by:** E6.0/2, E6.2/1.b.

**Entry requirement:** Receive the upstream credential/metadata boundary, authorized image/tier and actual cloud test environment with spend permission. Streaming/controller proof is produced by qualification.

**Completion evidence:** E8-F012 accepted credential/metadata boundary, authorized tier/image, headed stream/controller evidence and qualification spend authorization

**Contract/qualification owner:** [detailed plan](coding-plans/e6-0.md).

## LOCAL_WORKER

**Status:** open_upstream. **Responsible roles:** Local worker/device operator and replatform authentication owner.

**Used by:** E6.0/3, E6.3/1.

**Entry requirement:** Receive the authenticated outbound worker contract and an authorized supported device. Actual capture/offline/stale-input behavior is then qualified independently of cloud.

**Completion evidence:** Authenticated outbound worker on actual supported OS/devices, selected-browser capture and stale/offline input rejection

**Contract/qualification owner:** [detailed plan](coding-plans/e6-3.md).

## TOOL_SECURITY

**Status:** open. **Responsible roles:** Codex tool author and capability/auth reviewer.

**Used by:** E5.2/2.

**Entry requirement:** Review exact grant/action-link roles, migration and capability boundary before implementation; the real host and DB denial suite closes the consumer afterward.

**Completion evidence:** Application-owned grant/action links, exact roles/migrations, generation/channel/revocation and real DB denial coverage; no frozen kernel privilege expansion

**Contract/qualification owner:** [detailed plan](coding-plans/e5-2.md).

## TERMINAL_WRITERS

**Status:** open. **Responsible roles:** Canonical source/scheduler writer owners; Codex follow-up consumer.

**Used by:** E7.2/1.

**Entry requirement:** Enumerate and source-bind every enabled terminal/reopen writer and approve its same-owner intent/outbox design before adding follow-ups; crash coverage is generated afterward.

**Completion evidence:** Enumerated terminal/reopen writers, reviewed same-owner intent/outbox architecture and crash/duplicate/revocation tests for every enabled source

**Contract/qualification owner:** [detailed plan](coding-plans/e7-2.md).

## MEDIA_PROVIDER

**Status:** open_per_adapter. **Responsible roles:** Provider/deployment administrator, Codex media author and security/Budget reviewer.

**Used by:** E4.3/2.

**Entry requirement:** Provide each retained generation adapter contract and permitted account/environment/cost ceiling, with accepted credential and shared Budget producer bindings. Paid conformance follows implementation.

**Completion evidence:** Actual generation adapter/API availability, accepted credential policy, budget/fencing/output publication and paid conformance for each retained provider

**Contract/qualification owner:** [detailed plan](coding-plans/e4-3.md).

## PROFILE

**Status:** open_upstream. **Responsible roles:** Accounts and Access/profile worker owner; security reviewer.

**Used by:** E6.4/3.

**Entry requirement:** Receive the qualified upstream saved-account/profile authority, encryption/retention and purge contract plus test environment; both-placement Universe use/purge tests follow.

**Completion evidence:** E8-F011/profile access, encryption/retention, revocation, measured teardown/purge and both-placement tests; signed-out success insufficient

**Contract/qualification owner:** [detailed plan](coding-plans/e6-4.md).

## V1_ACCEPTANCE

**Status:** not_run. **Responsible roles:** TK acceptance; Codex evidence; technical reviewer assigned per batch.

**Used by:** E8.2/2.

**Entry requirement:** Completion-only decision: TK or recorded delegate accepts the combined V1 and rollback evidence after E8.2/2 runs. Never a prerequisite for running the acceptance rehearsal.

**Completion evidence:** Every retained V1 slice and integrated UAT/recovery/rollout accepted. Any required blocked mode keeps V1 open

**Contract/qualification owner:** [detailed plan](user-acceptance-plan.md).

## V2_APPROVAL

**Status:** not_authorized. **Responsible roles:** TK.

**Used by:** E3.4/1, E3.4/2.

**Entry requirement:** Require completed and accepted E8.2/2 and explicit V2 implementation approval. V1 waits never authorize V2.

**Completion evidence:** V1 accepted complete and explicit separate V2 implementation scope approval; multi-screen is outside the 31-slice packet

**Contract/qualification owner:** [detailed plan](release-plans/v2.md).

## LOCAL_SPEECH

**Status:** open. **Responsible roles:** Supported-device/model operator; Codex speech author.

**Used by:** E3.4/2.

**Entry requirement:** Provide authorized supported OS/hardware, permitted model/distribution and measurable resource constraints; actual installation/disconnect performance is qualification output.

**Completion evidence:** Actual OS/hardware/model installation/update/resource and disconnect qualification

**Contract/qualification owner:** [detailed plan](coding-plans/e3-4.md).
