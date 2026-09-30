# Universe — implementation-planning coverage audit

September 12, 2026. **Documentation audit, not implementation readiness.** Read with the authoritative [planning reset](planning-reset.md). No runtime work is authorized by this audit.

## Updated coverage after detailed planning

All 31 [coding addenda](coding-plans/README.md) now map the 69 original increments, with source/interface bindings and a [full-packet self-review](planning-self-review.md). The inventory below is the historical gap baseline used to drive that work; its missing-plan statements are superseded by those linked packets. Runtime bindings explicitly gated in them and independent Claude review remain open.

## Original audit coverage and its limits

The original planning checkout contains 31 individual slice outlines and 69 numbered work increments. The accepted allocation is 30 V1 slices and one V2 slice (E3.4). All slices have outcomes, proposed file ownership, dependencies and acceptance prose. Their repeated five-item increment checklists are process reminders, not concrete code/test recipes. Only E1.1 has a separate detailed coding-plan draft, and that draft is unapproved. None of this establishes full technical plan review or runtime completion.

This audit inspected the slice files, coding-plan directory, release allocation, coding-readiness contract, first-batch record and readiness register. Dependency findings below inherit the revision-bound investigation in those records; this pass did not requalify providers, fetch fresh upstream refs or certify current remote gates. Source revalidation is an explicit E0.1 deliverable.

## Per-slice completion work

Counts refer to numbered increments, not five repeated checklist lines. Every increment needs its own concrete steps and evidence in the detailed packet; grouping several increments in one file is acceptable. The table identifies the specific missing binding work in addition to the [common detailed-plan requirements](planning-reset.md#detailed-planning-deliverables).

| Slice | Version | Increments | Required planning completion |
|---|---|---:|---|
| [E0.1](slice-plans/e0-1.md) | V1 | 2 | Review candidate base/ancestry; publish all-slice source manifest, collision map, gate owners and sync/merge/rollback proposal. Do not create a branch to settle the decision. |
| [E1.0](slice-plans/e1-0.md) | V1 | 2 | Trace accepted mock decisions to empty/loading/error/reconnect/conflict/narrow states and keyboard/motion behavior; identify which extra states still need visual evidence. |
| [E1.1](slice-plans/e1-1.md) | V1 | 3 | Independently review the existing controller coding draft against requirements and actual React Flow/host boundaries; cover real task entry routes and all lifecycle transitions without assuming premature code is the answer. |
| [E1.2](slice-plans/e1-2.md) | V1 | 2 | Specify revision ownership, storage/API schema, conflict/reload behavior, tenant checks and migration/rollback tests; whole-array Home layout persistence is not sufficient. |
| [E1.3](slice-plans/e1-3.md) | V1 | 2 | Define destination/user/company draft keys, attachment references, retention and restore rules; join submitted-draft recovery to E2.2 outcome identity. |
| [E1.4](slice-plans/e1-4.md) | V1 | 2 | Define one menu/preview authority, stable centered logo, open/minimized/closed registry and focus restoration; map hidden rails to the same tray entries. |
| [E1.5](slice-plans/e1-5.md) | V1 | 3 | Define independent chat/blob/caption state transitions, compact/expanded/maximized geometry, tray toggle focus rules and settings consumption. Visibility does not start voice. |
| [E1.6](slice-plans/e1-6.md) | V1 | 3 | Specify usable viewport/context projection, pan/zoom cancellation, user versus Commander focus, hover/touch/keyboard resize and reduced-motion equivalents; set proposed versus measured timing limits. |
| [E2.1](slice-plans/e2-1.md) | V1 | 2 | Bind artifact/task revision references, selection payload limits, canonical conversation identity, corrections and retrieval against actual validators and tenant authorization. |
| [E2.2](slice-plans/e2-2.md) | V1 | 2 | Bind canonical submission/turn/run relations, read-only lookup, payload conflicts and unknown outcomes; separate admitted execution from CMD-gated distributed routing/results. |
| [E2.3](slice-plans/e2-3.md) | V1 | 2 | Define snapshot/event ordering, deduplication, stale catch-up and reconnect recovery; live events alone cannot establish durable completion. |
| [E2.4](slice-plans/e2-4.md) | V1 | 2 | Identify exact TaskDetail content extraction, fixed reply input, canonical reply route and permissions; verify Needs you, source-task and tray routes use one panel instance/controller. |
| [E3.1](slice-plans/e3-1.md) | V1 | 2 | Produce OpenAI qualification protocol and exact credential/session/tool bridge plan; resolve explicit runtime-key policy amendment before enabled provider behavior. |
| [E3.2](slice-plans/e3-2.md) | V1 | 2 | Specify connect/listen/speak/interruption/reconnect/end state machine, mic/speaker independence and durable handoff outcomes; stopping voice keeps blob/conversation. |
| [E3.3](slice-plans/e3-3.md) | V1 | 2 | Separate Gemini and ElevenLabs protocols, supported capabilities and recovery limits; bind each real provider rather than assume OpenAI parity. |
| [E3.4](slice-plans/e3-4.md) | V2 | 3 | Define later recognition/synthesis/local-runtime qualification boundaries and compatibility tests; explicit gate prevents execution before all V1 is verified. |
| [E4.1](slice-plans/e4-1.md) | V1 | 2 | Bind original upload intake, durable identity, scoped attachment access, cancellation and retry; manual intake remains independent of distributed execution. |
| [E4.2](slice-plans/e4-2.md) | V1 | 2 | Map each accepted format to parser/render route, size/resource limit, fidelity fixture and unsupported/error behavior. |
| [E4.3](slice-plans/e4-3.md) | V1 | 2 | Define immutable artifact revisions, provenance, selected-versus-current version behavior and generated-job outcome binding. |
| [E5.1](slice-plans/e5-1.md) | V1 | 2 | Define reviewed block registry input/output schemas, trusted rendering boundary, scoped references and error/fallback behavior. |
| [E5.2](slice-plans/e5-2.md) | V1 | 2 | Complete HOST qualification protocol for origin isolation, CSP, bridge allowlist, revocation and resource/teardown limits before choosing executable-host bindings. |
| [E6.0](slice-plans/e6-0.md) | V1 | 3 | Specify separate local/cloud Browser Use compatibility and containment evidence, real stream/takeover/reconnect tests, canonical approvals and closure criteria. |
| [E6.1](slice-plans/e6-1.md) | V1 | 2 | Bind governed worker admission, automation command/result authority and uncertain mutation recovery; no direct canvas bypass. |
| [E6.2](slice-plans/e6-2.md) | V1 | 2 | Define cloud live-view/control ownership, takeover fencing, reconnect and capability disclosure using CLOUD/APPROVAL evidence. |
| [E6.3](slice-plans/e6-3.md) | V1 | 2 | Specify outbound worker connection/auth, tab-only access, owner fencing and local disconnect behavior; exact transport remains conditional on E6.0. |
| [E6.4](slice-plans/e6-4.md) | V1 | 3 | Bind session lifecycle, file-transfer identity and profile reuse independently; PROFILE requires retention, encryption evidence, purge, audit and revocation tests. |
| [E7.1](slice-plans/e7-1.md) | V1 | 2 | Bind conversational intent to existing scheduler authority, timezone/cancellation and admission; retain CMD on distributed consumers. |
| [E7.2](slice-plans/e7-2.md) | V1 | 2 | Specify durable intent/event correlation, idempotency and reauthorization; best-effort notifications cannot trigger work by themselves. |
| [E7.3](slice-plans/e7-3.md) | V1 | 3 | Resolve notification creation versus delivery semantics; preserve audit/access filtering while defining silent/badge/toast/speech precedence and bottom-right response behavior. |
| [E8.1](slice-plans/e8-1.md) | V1 | 2 | Publish shared scoped/default/reset/version preference contract first; assign each field to its consumer with tests. Providers manage connection readiness; Budget & caps remains separate. |
| [E8.2](slice-plans/e8-2.md) | V1 | 2 | Specify real integrated acceptance environments, full V1 capability matrix, migration/rollback and feature-disable checks; baseline failures need evidence, not blanket waivers. |

## Completion order for planning

1. Review E0.1 planning reference and proposed branch/merge strategy. Record the untouched premature draft and its open disposition separately.
2. Complete shared contracts: E8.1 preference ownership, E1.0 UI states, E1.1 geometry/lifecycle, E2.1 identity/context and E2.2 canonical outcomes. Review producer/consumer signatures together.
3. Complete persistence, drafts, navigation and actual task-content integration. Refine E1.6 against the agreed geometry and context contracts, avoiding circular dependencies.
4. Complete qualification packets for providers, browser containment/streaming, executable hosts and formats. Map unresolved upstream evidence to affected increments; do not run qualifications during planning-only scope.
5. Complete routine/attention, consumer preference and integrated-release packets. Check every accepted UI/product decision has a named implementing increment and acceptance case.
6. Independently review completed technical packets, resolve findings, re-review material changes and present the complete plan for explicit implementation approval. A review of this audit/process alone does not satisfy this step.

These are planning groups, not new release allocations. V1 stays complete and usable as agreed. Missing runtime bindings must have executable qualification protocols and be labelled blocked; a detailed-looking guessed API is not a substitute.

## Cross-cutting gaps that must not disappear

- **Authority:** branch acceptance, reviewer approval and coding approval are separate. No previous test result authorizes work.
- **Source confidence:** last-fetched refs and historical upstream findings require revalidation at the chosen planning/implementation revisions.
- **Accountability:** unresolved upstream owners remain unassigned. A finding ID is not evidence of a delivery commitment.
- **Dependency boundaries:** CMD does not block manual task replies, uploads or panel presentation. PROFILE does block saved-login acceptance. All required V1 capabilities still gate the release.
- **UI reliability:** the intermittent task-panel defect and settings lost in the mock rebuild remain acceptance cases, not certified behavior. Selection is a quiet header tint; Commander attention is separate transient glow.
- **Default experience:** expanded top tray, centered blob and compact input; independent captions, chat, blob and voice connection. Accepted settings/motion records remain authoritative.
- **Runtime proof:** real React Flow host interactions, provider streams, failure/reconnect, auth revocation and Linux baseline checks remain future execution evidence. Existing component tests or mock animations cannot close those gates.
- **Premature draft:** delete, preserve or reuse is a later explicit decision. The planning source of truth is this original documentation checkout; the isolated implementation remains untouched.

## Audit acceptance

Coverage is complete only for the inventory above: all 31 slice outlines are represented and increment counts total 69. The original audit did not establish detailed coding readiness. Current detailed-plan coverage and corrections are in the updated coverage section; independent review, blocked producer qualification and production readiness remain incomplete. Documentation-only validation checks links, coverage and status consistency; no runtime tests are run for this audit.
