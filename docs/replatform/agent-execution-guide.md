# Re-platform Agent Execution Guide

**Status:** Normative execution process
**Applies to:** Planning, implementation, review, and integration-gate work under `docs/replatform/`

## Required reading order

Before acting on a re-platform ticket, read:

1. `AGENTS.md`, `CLAUDE.md`, `docs/architecture/decisions.md`, and `docs/roadmap.md`.
2. [`program-design.md`](program-design.md).
3. [`current-main-crosswalk.md`](current-main-crosswalk.md), when the ticket touches execution, migration, providers, plugins, connectors, workspaces, or current run behavior.
4. [`accepted-caveats.md`](accepted-caveats.md) and [`test-gates.md`](test-gates.md).
5. [`artifact-policy.md`](artifact-policy.md).
6. The target epic README and implementation plan.
7. Completion and named partial-gate handoffs, decisions, findings, and QA evidence from every dependency.
8. The assigned ticket and its owned interfaces.

Locked decisions and the program design define architecture. Caveats narrow supported behavior without weakening invariants. The approved implementation plan defines executable scope. Chat context or agent assumptions do not override these artifacts.

## Assignment preconditions

A ticket may be assigned only when:

- every dependency gate required for that ticket is green on main;
- the plan names exact files, interfaces, acceptance behavior, red/green commands, evidence, and commit boundaries;
- the ticket is no larger than three agent-days;
- placement, credential, workspace, provider, migration, and compatibility impacts are explicit;
- failure behavior and rollback/disablement are explicit;
- a focused test can demonstrate the missing behavior before implementation;
- shared protocol or migration ownership is assigned to the custodian.
- every consumed named partial gate has an immutable passing handoff on the exact main revision required by the plan; a ticket result alone is not a dependency gate.

If a condition is absent, stop implementation and record a finding or request a plan amendment.

## Cross-cutting requirements

### Control-plane authority

- Workers append authenticated events and request fenced operations; they do not directly mutate domain tables.
- No worker-local database is a peer source of truth.
- Large bytes use scoped object-store transfer; authoritative promotion occurs through the control plane.
- Legacy and distributed execution never own the same run simultaneously.

### Target placement and trust

Every job has an immutable placement decision or policy reference resolving allowed target classes, required isolation/trust, provider constraints, owner/Organization binding, credential ceiling, data-locality/workspace-transfer permission, capabilities/capacity, fallback, retry, and handoff behavior.

Separate server-assigned durable facts—target class, owner, Organization scope, trust ceiling, credential ceiling, provider allowlist, revocation generation, locality ceiling—from worker-reported dynamic facts—version, platform, capacity, installed runtimes, health, and current capabilities. The scheduler uses their intersection. An unavailable preferred target does not imply fallback; the default is to queue or fail closed with an attributable reason.

### Device lifecycle

Enrollment plans define platform-managed, Organization-managed, and owner-desktop flows; one-use bootstrap; durable device/target identity; key rotation; credential generation; reinstall, replacement, transfer, loss, revocation, deletion; owner membership suspension/removal; session invalidation; active-lease cancellation; audit; and multi-Organization behavior if supported. Presence may be ephemeral. Ownership, trust, drain, revocation, and replacement are durable.

### Secrets and owner-bound credentials

- Platform-managed credentials and OAuth authority are represented only by opaque handles; they are never serialized into jobs. Because arbitrary user workload strings can contain secret-looking values, producers scan every command, argument, URL, header, and extension string against registered secret canaries before persistence/dispatch and never claim structural prevention for unknown user-provided values.
- During beta, platform-managed provider-control credentials remain exclusively inside the worker/provider-management boundary. They are never exposed or materialized in tenant sandboxes, commands, environment variables, files, protocol objects, artifacts, or evidence.
- Secret release revalidates Organization, Company, actor/owner, job, attempt, lease, fence, target identity/generation, trust, materialization mode, and policy version.
- An `owner_bound` handle or device-local personal credential is usable only on its explicitly authorized, enrolled `owner_desktop` target. V1 never treats an Organization-dedicated target as a personal device; that class uses `organization_brokered` authority instead.
- A device-local personal credential on an `owner_desktop` remains in OS-protected storage and is never uploaded to the control plane or execution artifacts. A local credential broker binds its AoA use to Organization, owner, job, attempt, lease, fence, target generation, and policy. Per-job activation or unavoidable CLI materialization expires no later than the current lease/session authorization, is sandbox-local, and has no egress path that bypasses live fence validation.
- Rotation, revocation, membership removal, target replacement, and lease loss take effect without rebuilding the envelope.
- No fallback may broaden eligible targets.

### Local workspace staging

- A folder grant is explicit, revocable, and path bounded.
- Default execution stages an immutable snapshot into an isolated working directory or sandbox; direct writes to the granted live folder are not assumed.
- The snapshot records Git/content bases, dirty/untracked state, ignore policy, case/path behavior, special files, executable bits, sizes, and hashes.
- Content leaving the device is attributable; likely credential files and unsupported special files fail closed or require explicit policy.
- Results are patches, commits, or artifacts tied to the declared base. Applying output revalidates the current base; drift or conflict requires review.
- Cache, incomplete upload, restricted artifact, and orphan-output retention are explicit.

### Offline, reconnect, and handoff

- A worker takes no new lease while offline and never extends a server lease.
- Sleep/resume and clock behavior are tested without relying only on mutable wall-clock time.
- Every governed external effect passes through a control-plane operation or enforced egress/provider gate that revalidates the live lease, fence, target generation, owner, and policy immediately before forwarding; the sandbox has no alternate governed-egress route.
- Renewal failure, lease expiry or replacement, target/session revocation, generation replacement, or owner-membership loss unconditionally disables secret material and all governed egress, destroys ephemeral credential material, and terminates or isolates the consuming process before another governed effect. No workload or offline policy may override this rule.
- Do not confuse lost effect authority with lost cleanup authority. Provider cleanup uses a separate resource/ownership/generation/deadline-bound capability that permits only matching-resource list/inspect and cancel/kill/destroy/idempotent reconciliation after fence loss; it cannot start, resume, checkpoint, publish, reveal foreign resources, or open egress.
- If live validation is unavailable, governed effects fail closed. Offline policy may permit bounded local computation and encrypted buffering only; a disconnected worker cannot refresh credential authority or perform governed remote effects.
- Reconnect revalidates target generation, owner status, session, lease, fence, policy, and workspace base.
- Stale output uses the quarantine operation in [`accepted-caveats.md`](accepted-caveats.md), never ordinary artifact commit.
- Handoff creates a new attempt or service instance and a new fence. Placement, credentials, locality, provider limits, and snapshot/checkpoint availability are re-evaluated. Source and destination attempts for one job, or source and destination instances for one service generation, never perform governed effects concurrently.

### Desktop distribution and updates

Desktop plans include framework/process topology, background service/autostart, keychain integration, folder repair UX, signed Windows and macOS installers, notarization, local status/logs/drain/revoke/repair/uninstall, signed update metadata/packages, staged rollout, protocol compatibility, drain-before-update, forced-update fencing, interrupted/offline recovery, and rollback to an allowed N-1 version. Updates must not modify source workspaces or silently abandon active output.

### Managed-provider isolation

A fake provider proves lifecycle behavior, not a hostile isolation boundary. Before canary, real-provider evidence must prove job-to-job filesystem/process/network/credential isolation; metadata/private/control-plane/worker-host denial; unavailable provider control credentials; pinned images/templates; TTL; cancel/kill/destroy/timeout/crash/outage cleanup; leak reconciliation; and secret/object-grant expiry. E2B limits are accepted as documented. Firecracker implementation is out of scope; provider-neutral contracts remain mandatory.

### Realtime and UI

Durable state remains correct without realtime delivery. Realtime is authorized invalidation and catch-up over durable state with stable cursor/sequence, duplicate/gap handling, replay/snapshot fallback, backpressure, broker-outage behavior, ephemeral presence, durable control ACKs, and redaction. No UI or golden-journey ticket may claim reconnect-safe evidence until the immutable `E10-REALTIME-FOUNDATION` QA record and handoff pass on main; MIG-003 ticket completion alone is insufficient.

### D0 and repository builds

Per-ticket D0 evidence is the focused RED/GREEN suite plus affected-package typecheck/build and changed boundary/contract checks once. The Integration Gate Owner runs the immutable D0 rollup, including repository typecheck/tests, three consecutive critical-suite executions, `pnpm -r build` for direct same-revision package evidence, and authoritative root `pnpm build`. FND-005 must make root build pinned/network-free and update scripts, AGENTS, and required CI together; no epic plan may silently replace the repository command. Record both commands and require a clean worktree.

### Evidence integrity

Ticket results append review attempts until approved complete and then freeze. QA and handoff records are immutable from their first commit. A rerun, correction, changed revision, or changed decision creates a higher attempt with `Supersedes`; never edit, delete, or rename the earlier record. Gate handoffs pin ticket-result blob SHAs and reviewed implementation SHAs and record every REQUIRED/HARD/INITIAL/OBSERVED value.

### Private-beta workload scope

Coding, browser, and service are mandatory for program completion and REL-005. E7/D2, E8/D3, and E9/D4 all block the beta, and D6 exercises all three in every participating Organization. Their flags are exposure, incident-disable, and rollback controls—not a coding-only completion path. Desktop and cross-target mobility remain optional only under their explicit disabled-surface evidence rules.

## Role workflow

1. Planner writes or amends the implementation plan and records unresolved cross-epic decisions.
2. Custodian approves shared protocol or migration changes.
3. One implementer executes one ticket with focused red/green evidence.
4. A separate reviewer evaluates contract, security, failure, and scope compliance, records the reviewed revision and disposition in the ticket result, and alone may move that result from `gate_review` to `complete` in a separate documentation commit.
5. The implementer addresses accepted findings without broadening the ticket.
6. The Integration Gate Owner runs the gate on one exact revision and records pass/fail.
7. Epic status changes only from committed evidence and a passing handoff.

## Copy-ready planner prompt

> Act as implementation planner for `<EPIC>`. Do not implement code. Read the repository instructions, locked decisions, `docs/replatform/program-design.md`, `current-main-crosswalk.md`, `accepted-caveats.md`, `test-gates.md`, `artifact-policy.md`, this epic's README, and every dependency handoff/decision/finding/QA record. Produce or amend `implementation-plan.md` with tickets no larger than three agent-days. Each ticket must name dependencies, exact files/modules, interfaces, failure behavior, migration/compatibility impact, observability, rollback/disablement, focused RED/GREEN commands including affected-package typecheck/build, evidence records, and commit boundary. Explicitly map the plan and gate to every applicable REQUIRED/HARD/INITIAL/OBSERVED value and frozen support-matrix row. Coding, browser, and service closure is mandatory for REL-005; only desktop and mobility may use disabled-surface closure. Resolve target class/trust/owner/locality/fallback, server-assigned versus reported capabilities, device lifecycle, owner-bound credentials, local staging, stale-output quarantine, handoff, desktop lifecycle where applicable, verified E2B limits, real-provider isolation, and the provider-neutral seam. Personal/device-local credentials are `owner_desktop` only; Organization-dedicated targets use `organization_brokered`. Do not add a Firecracker implementation. If a cross-epic rule is not locked, record a finding and propose a decision before making tickets assignable.

## Copy-ready implementer prompt

> Implement only `<TICKET-ID>` from `<EPIC>` on the assigned branch/worktree. Read the repository instructions, locked decisions, program/current-main/caveat/gate/artifact docs, epic plan, dependency and named partial-gate handoffs, and complete ticket. Confirm dependencies are green and planned files/interfaces match main. Write or run the focused failing test first, make the smallest scoped change, and run every required focused command plus affected-package typecheck/build once. Preserve control-plane authority, outbound-only workers, server-assigned target ceilings, owner-bound credential restrictions, locality/fallback rules, lease fencing, isolated staging, and provider-neutral contracts. Personal/device-local credentials are `owner_desktop` only; an Organization-dedicated worker uses `organization_brokered` and never receives a personal credential. Keep post-fence cleanup on its distinct monotonic cleanup authority and send stale output only through quarantine, never ordinary commit. Do not invent Firecracker work or E2B-specific common wire fields. Do not weaken tests or redesign a shared contract without custodian approval. If the plan is stale or contradictory, stop, record a stable finding, and request an amendment. Finish with the required append-only ticket-result ledger containing exact revision, commands, exit codes, deviations, cleanup, and follow-ups.

## Copy-ready reviewer prompt

> Review `<TICKET-ID>` for `<EPIC>` against locked decisions, the program/current-main/caveat/gate docs, the approved plan, and ticket acceptance contract. Begin read-only. Report actionable findings by severity with exact file/line evidence. Check the applicable stable crosswalk rows and legacy-parity dimensions; tenant scope; execution-source provenance; control-plane authority; placement/owner/trust/locality/fallback enforcement; capability escalation; owner-bound secret release; lease/fence races; offline/reconnect; workspace/symlink boundaries; quarantine; provider credential exposure; isolation/cleanup; compatibility; single-writer migration; observability; and rollback. Verify that personal/device-local credentials exist only on `owner_desktop` and Organization-dedicated targets use `organization_brokered`. Distinguish accepted E2B limits from correctness or isolation defects. Reject Firecracker scope creep and provider leakage into common contracts. Verify focused evidence rather than accepting claims. Then update the ticket result's Independent review section and, when findings exist, the epic findings ledger; do not modify implementation code. Record your identity, the exact reviewed SHA, commands/evidence, and `approved` or `changes_requested`. Only `approved` may change top-level status from `gate_review` to `complete`, in a separate documentation commit; otherwise link stable findings and leave it non-complete. If there are no findings, still list residual risks or unrun gates.

## Copy-ready Integration Gate Owner prompt

> Act as Integration Gate Owner for `<EPIC>` at exact revision `<REVISION>`. Do not rely on implementation-agent self-certification. Read the plan, the current-main crosswalk, and every ticket result, decision, finding, review, dependency and named partial-gate handoff, and QA record. Verify required tickets, resolved review findings, applicable stable crosswalk-row closure, and legacy-parity dimensions. Run the documented focused, integration, compatibility, migration, failure-injection, and repository gates on the same revision, including both required build commands and three consecutive critical-suite runs at D0 rollup scope. Exercise target/owner/credential/locality/fallback denial, revoke/replace, disconnect/reconnect/stale fence, workspace conflict/quarantine, realtime catch-up where applicable, real-provider isolation, cleanup, and rollout/rollback. Verify coding, browser, and service closure and every frozen support-matrix row, including disabled desktop/mobility negative evidence and per-row D6 SLI. Create new immutable QA/handoff attempts, pin ticket-result blobs/reviewed revisions, and record topology, provider/template/policy versions, commands, exit codes, REQUIRED/HARD/INITIAL/OBSERVED values, artifact links, and cleanup. E2B limits may be accepted only as documented; isolation or fencing failures may not. `blocked_external` is allowed only when an external dependency prevents the lane/schedule from starting; after a campaign starts, scheduled external failures count and a missed threshold is `fail`. Firecracker is not a gate requirement, but provider-seam conformance is. Set `pass` only when every blocking requirement is green; otherwise record `fail` or `blocked_external`, create stable findings, and leave the epic in `gate_review`.

## E6-D1-FOUNDATION named partial gate

E3/E4 may depend only on this explicit partial gate, not the vague phrase "E6 test foundation." Planning for its interfaces/fake controls may begin early, but the gate passes only after JOB-003, WRK-004, DEP-000 through DEP-004, and their dependency closure prove the networked D1 topology. The completion handoff is named `e6-d1-foundation` and lists the exact interfaces safe for JOB-004/WRK-005 and later work to consume. It is not full E6 completion.

## E10-REALTIME-FOUNDATION named partial gate

CLI-006, BRW-006, and SVC-007 may depend only on this explicit partial gate, not MIG-003's ticket result or the vague statement that realtime “landed.” The gate passes only after JOB-005, DEP-009, MIG-003, and their closure prove authorized two-replica durable sequence/cursor delivery, reconnect gap recovery, duplicate suppression, broker outage/catch-up, redaction, backpressure/snapshot fallback, durable control ACKs, and ephemeral presence. The immutable QA record and `e10-realtime-foundation` handoff name the exact revision/interfaces safe to consume. It is not E10, desktop, cutover, mobility, D3, or D4 completion.
