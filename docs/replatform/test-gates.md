# Distributed Execution Test and Release Gates

**Status:** Normative release contract

**Applies to:** D0 through D6 and private-beta promotion

## Threshold classes

- **HARD:** A security or correctness invariant with zero tolerance. It cannot receive a conditional pass or waiver.
- **INITIAL:** The first private-beta floor. It may change only prospectively through a dated decision approved by the Integration Gate Owner and Security Gate Owner. It cannot be lowered after a release-candidate run starts or in response to that run failing.
- **OBSERVED:** Record the value; it does not independently pass or fail the gate.

An unlabelled gate bullet is **REQUIRED**: it must pass, but it is not an adjustable numeric floor. A gate passes only when every applicable REQUIRED bullet plus every HARD and INITIAL condition passes. OBSERVED is the only non-blocking class.

**EVID-01 — Record identity:** Every QA record, whether pass, fail, or blocked, identifies its immutable record path, attempt, superseded attempt if any, exact 40-character Git revision, image digests, protocol contract hash, topology, provider/template versions, feature flags, and configuration hashes. Every handoff identifies the exact reviewed revision and named human/agent gate-owner identity. Product, harness, provider, and environment failures remain separately classified. `blocked_external` applies only when an external provider/environment prevents a required lane or measurement schedule from starting; it never promotes the epic and the complete gate must be rerun. Once a gate campaign or schedule starts, provider/environment-caused cases remain in the required sample set and any threshold violation is `fail`, not `blocked_external`.

**EVID-02 — Immutability and mapping:** QA and handoff records are write-once from their first commit. A correction, rerun, changed decision, or later revision creates a higher attempt with a `Supersedes` link; the earlier record remains unchanged. Passing evidence maps every stable requirement ID to its required value, OBSERVED value, result, and retained evidence. Handoffs pin the Git blob of each ticket-result ledger and the reviewed implementation SHA so later ledger history cannot rewrite the basis of a decision.

**EVID-03 — Stable identifiers:** Every normative condition below carries a bold stable requirement ID. IDs are permanent: never renumber or reuse one, and append a new ID when adding a condition. Introductory prose defines scope; when it establishes a measurable condition, the first tagged requirement in that section incorporates it. QA and handoff requirement tables use these IDs verbatim.

## Hard invariants

Every D1–D6 gate requires all of these:

1. **H-01 — Tenant isolation:** zero cross-Organization or unauthorized cross-Company reads, writes, deletes, existence disclosures, subscriptions, object-key accesses, secret resolutions, or provider-resource accesses.
2. **H-02 — Lease authority:** zero accepted mutation, event, artifact commit, secret read, checkpoint selection, completion, or external effect from a stale or replaced fence.
3. **H-03 — Single executor:** zero overlapping authoritative leases or simultaneously effectful service generations unless a later approved decision explicitly permits overlap.
4. **H-04 — Secret containment:** zero known secret-canary values in envelopes, argv, URLs, events, logs, metrics, traces, browser artifacts, object metadata, SQLite outboxes, or QA artifacts.
5. **H-05 — Sandbox boundary:** zero tenant commands executed by the worker host; workers have no database credential; control-plane replicas have no Docker or provider-control socket.
6. **H-06 — Network boundary:** metadata, private, worker-control, and control-plane destinations remain denied, including direct-IP, redirect, and DNS-rebinding variants.
7. **H-07 — Hosted exclusions:** public service ingress, cloud-plugin execution, and the unsafe process-wide multi-tenant override remain impossible while disabled.
8. **H-08 — Supply chain:** only approved digests with a verified project signature or provider provenance attestation run; the verification policy and roots are recorded in evidence.
9. **H-09 — Cleanup:** zero provider resources remain after the lane cleanup deadline and final reconciliation.
10. **H-10 — Evidence integrity:** no failing run is overwritten, hidden, or converted to pass without a new immutable QA record.

## Evidence names and retention

**EVID-04 — Record path:** Use `docs/replatform/epics/<epic>/qa/<YYYY-MM-DD>-<lane>-<scope>-<sha12>-a<attempt>.md`. Example: `2026-08-07-d4-service-72h-9b74b888d78b-a1.md`.

**RET-01 — Evidence retention (INITIAL):** Git retains structured QA summaries permanently; controlled raw logs, traces, load results, manifests, and restore evidence are retained for at least 180 days. The record must remain meaningful after linked CI artifacts expire.

## Availability SLI contract

**SLI-00 — Frozen schedule and dimensions:** The D4 and D6 availability SLIs use schedules frozen before the gate starts. The QA record stores the campaign start/end, timezone, schedule-manifest hash, expected sample count, observed sample count, missing sample count, numerator, denominator, and exclusion count/reasons. Raw samples retain their scheduled timestamp, observed timestamp, Organization, workload, target/provider, release revision, and success or failure reason. Every D6 sample additionally carries the immutable matrix-row ID, OS/version or `not_applicable`, credential-binding mode, locality mode, fallback mode, mobility mode, and handoff direction or `not_applicable`.

- **SLI-01 — D4 service availability:** sample once per UTC-aligned minute. The denominator is every scheduled minute outside the permitted injected-fault exclusions below. A minute enters the numerator only when the authoritative desired generation has exactly one valid fenced instance, its health is current, and a synthetic operation submitted in that minute reaches its durable, readable success signal within 60 seconds.
- **SLI-02 — D6 end-to-end availability:** schedule at least one golden-journey probe every five minutes for each mandatory workload—coding, browser, and service—increasing frequency as needed so every advertised matrix row receives at least 200 normal scheduled probes during the campaign. The denominator is every scheduled probe. A probe enters the numerator only when submission, placement, lease, execution, durable result or artifact commit, and authorized readback all complete within that workload's declared SLO. Report the aggregate, each of the three mandatory workloads, and each advertised matrix row separately; all three levels must meet the D6 threshold.
- **SLI-03 — Exclusions:** D4 may exclude only the scheduled 15-minute worker/control-plane partition and the scheduled 15-minute provider pause or forced-outage window, each from the recorded instant the fault becomes effective through the recorded instant it is removed. Recovery after removal, control-plane or worker restarts, drain, generation update, checkpoint restore, and budget/TTL stop remain in the denominator. D6 has no maintenance, provider, environment, beta-customer, or fault-drill exclusion; a synthetically valid request is never excluded because the platform or a dependency was unavailable.
- **SLI-04 — Missing samples:** Missing expected samples, gaps in the source telemetry, absent SLI dimensions, or an inability to reconstruct numerator and denominator from retained evidence fail the gate. They are not removed from the denominator or classified as `blocked_external`.

## D0 — Hermetic component gate

D0 has two cadences. They are complementary and must not be conflated.

Per-ticket focused acceptance requires:

- **D0-T01 — Focused acceptance:** the ticket's focused tests, affected-package typecheck and build (when the package has those scripts), boundary checks, and changed contract-manifest checks pass once with zero failures.
- **D0-T02 — Lifecycle ownership:** a ticket that owns lifecycle functions tests the complete legal/illegal transition matrix.
- **D0-T03 — Validator ownership:** a ticket that owns secret or path validators passes at least 10,000 deterministic generated vectors for the owned validator, including applicable secret values in argv, URLs, headers, nested arrays, and additive extensions.
- **D0-T04 — Protocol ownership:** a ticket that changes protocol schemas covers every affected valid and invalid conformance vector.
- **D0-T05 — Hermetic inputs:** no network provider, customer data, or live credential is used.

The immutable epic/merge-train/release-candidate D0 rollup requires:

- **D0-R01 — Repository verification:** `pnpm -r typecheck`, `pnpm test:run`, and `pnpm -r build` run on the exact recorded revision; the recursive build is the package-byte/same-revision evidence. Workspace packages are built before the suite so workspace-package resolution (e.g. `@armyofagents/plugin-sdk`) does not fail as a setup artifact. `pnpm -r typecheck`/`pnpm test:run` failures are evaluated against the committed pre-existing-failure baseline per DEC-03: waivable only when in-baseline and not epic-touched; any new or epic-touched failure is a `fail`.
- **D0-R02 — Authoritative root build:** root `pnpm build` also passes because AGENTS and required CI make it the repository build authority. Until FND-005 lands, record the catalog/connector input locations and hashes and fail if the command changes tracked bytes or cannot reproduce them. FND-005 must pin those inputs or split refresh from build and update the root scripts, AGENTS, and every required CI caller in the same revision; a lower-level plan may not silently substitute another command.
- **D0-R03 — Critical-suite stability:** every designated critical suite passes three consecutive executions on that revision with zero flaky or retried tests.
- **D0-R04 — Clean retained evidence:** the worktree is byte-clean after the gate, and every command, exit code, duration, count, and OBSERVED value is retained.

## `E6-D1-FOUNDATION` — partial preflight, not D1 promotion

**E6F-00 — Scope and dependencies:** This named preflight exists only to unblock JOB-004 through JOB-008, JOB-011 through JOB-014, and WRK-005 onward. It does not pass D1, E6, or a release lane, and the D1–D6 hard-invariant preamble does not imply behavior whose owning tickets have not landed. It requires JOB-003, WRK-004, DEP-000 through DEP-004, and their dependency closure on one revision.

Its immutable QA record must prove:

- **E6F-01 — Lease races:** 100 submit→placement→lease→ACK races across at least two registered target profiles, with exactly one winner each.
- **E6F-02 — Fake-provider faults:** 25 fake-provider create→execute→kill/destroy fault cases, deterministic reset between cases, and zero provider resources after final reconciliation.
- **E6F-03 — Networked smoke:** one networked end-to-end smoke through PostgreSQL, MinIO, control plane, worker, fake provider, and runner.
- **E6F-04 — Available-path tenancy:** zero cross-Organization reads/existence disclosures in the available submit/enroll/placement/lease paths.
- **E6F-05 — Topology boundaries:** no shared writable volume, no worker database reachability/credential, no control-plane or worker-host tenant-command execution, and only declared provider-control access.
- **E6F-06 — Image policy:** pinned images built from the recorded source revision, non-root/read-only-root policy, test-root signature/provenance verification, and rejection of one tampered digest.
- **E6F-07 — Failure evidence:** migration/readiness behavior and retained evidence from one deliberate failing fixture.

**E6F-08 — Explicit non-certification:** The record lists renewal/fence loss, event ingestion/outbox, cancellation/retry, artifact/secret/quarantine paths, full D1 fault volume, real-provider isolation, two-replica HA, and release signing policy as not certified. Those are proved by their owning tickets and the full D1/D2 gates.

## D1 — Distributed local gate

**D1-00 — Topology:** PostgreSQL, MinIO, one control-plane replica, at least two workers, fake provider, Toxiproxy, and an isolated test runner. A separate D1-HA lane adds the second control-plane replica once DEP-009 lands.

- **D1-01 — Tenant property suite (INITIAL):** 20 seeds × 10,000 operations across at least 10 Organizations.
- **D1-02 — Lease suite:** at least 1,000 concurrent claim/ACK/renew/replacement races; exactly one authoritative winner in every race.
- **D1-03 — Event suite:** at least 100,000 events, including at least 10,000 cases **in each** event-fault class: duplicate, gap, out-of-order, lost ACK, restart/replay, and hash mismatch.
- **D1-04 — Sandbox suite:** at least 100 lifecycle faults spanning create, execute, cancel, kill, destroy, worker crash, and control-plane restart.
- **D1-05 — Cancellation and cleanup (INITIAL):** cancellation reaches worker-visible terminal or force-kill state within 30 seconds; cleanup completes within 5 minutes.
- **D1-06 — Artifact integrity:** artifact round trips reproduce expected bytes, hash, size, prefix, tenant, attempt, and fence in 100% of cases.
- **D1-07 — Final reconciliation:** zero orphan sandboxes, uploads, active leases, or unacknowledged terminal events.

## `E10-REALTIME-FOUNDATION` — partial realtime preflight, not E10 promotion

**RTF-00 — Scope and dependencies:** This named partial gate exists only to unblock reconnect-safe claims in CLI-006, BRW-006, and SVC-007. It requires JOB-005, DEP-009, MIG-003, and their complete dependency closure on one exact revision. It does not pass E10, D3, D4, D5, D6, desktop, cutover, or mobility.

Its immutable QA record and handoff must prove:

- **RTF-01 — Replica authorization:** two interchangeable control-plane replicas authorize subscriptions by Organization and Company and never disclose foreign event existence.
- **RTF-02 — Durable order and duplicates:** at least 10,000 durable events across at least two Organizations retain one monotonic source sequence/cursor, with 100 disconnect/reconnect gaps recovered in exact order and 100 duplicate fan-out injections suppressed without losing an event.
- **RTF-03 — Broker outage:** a scheduled 15-minute broker outage delays delivery but not accepted-write correctness; recovery catches up from the durable cursor within five minutes.
- **RTF-04 — Backpressure:** bounded backpressure either retains an authorized replay window or returns an explicit snapshot-required response whose snapshot and resume cursor are consistent.
- **RTF-05 — Control versus presence:** control ACKs are durable and idempotent, while presence remains explicitly ephemeral and cannot be used as execution authority.
- **RTF-06 — Redaction and consistency:** payload and metadata redaction pass the secret-canary corpus, and zero unauthorized subscription, gap concealment, duplicate projection, or cross-replica disagreement occurs.

**RTF-07 — Handoff boundary:** The handoff is named `e10-realtime-foundation`, identifies the exact interfaces and revision safe for consumers, and explicitly lists desktop distribution, legacy cutover, mobility, browser D3, and service D4 as not certified.

## D2 — Real E2B coding gate

- **D2-01 — Consecutive runs:** three consecutive passing runs on the same release candidate.
- **D2-02 — Job volume (INITIAL):** at least 120 jobs total, covering at least 20 each for success, cancellation, timeout, lost ACK, artifact commit, and leaked-resource reconciliation.
- **D2-03 — Product and invariant failures:** zero product failures and zero hard-invariant violations.
- **D2-04 — Cancellation latency (INITIAL):** p95 ≤30 seconds and maximum ≤60 seconds.
- **D2-05 — Cleanup latency (INITIAL):** sandbox cleanup p95 ≤2 minutes and maximum ≤5 minutes.
- **D2-06 — Patch integrity:** patches reproduce the declared base/result hashes and never auto-apply on base mismatch.
- **D2-07 — Provider outage:** outage/backoff produces an alert and no leaked or unattributable sandbox.
- **D2-08 — Provider limits:** the QA record includes the verified E2B limit matrix required by [`accepted-caveats.md`](accepted-caveats.md).

## D3 — Browser gate

- **D3-01 — Journey volume (INITIAL):** at least 100 journeys over three consecutive passing runs.
- **D3-02 — Coverage:** approval allow/deny/timeout, reconnect catch-up, download, upload policy, cancellation, trace/video retrieval, credential rotation/revocation, private/metadata denial, and stale fence.
- **D3-03 — Control endpoints:** zero public or cross-tenant CDP/control endpoints.
- **D3-04 — Secret containment:** zero cookie, access-token, refresh-token, authorization-header, or storage-state value in events/logs.
- **D3-05 — Cancellation and cleanup (INITIAL):** cancellation maximum ≤60 seconds and session cleanup maximum ≤5 minutes.
- **D3-06 — Artifact order and digest:** every screenshot, trace, video, and download is ordered by event sequence and matches its digest.

## D4 — Long-running service gate

**D4-01 — Campaign duration:** Run on the same release candidate for at least **72 consecutive wall-clock hours**. This is a continuity/reconciliation test, not a claim that one E2B process runs uninterrupted for 72 hours.

**D4-02 — Fault schedule:** Inject at minimum two control-plane restarts, two worker restarts, one 15-minute worker/control-plane partition, one worker drain, one generation update, one checkpoint restore, and one budget/TTL stop. If the recorded provider capability matrix supports pause/resume, also pause the provider for 15 minutes and resume it. Otherwise force a 15-minute provider outage, permanently fence the affected instance, and recover through a replacement instance using the approved checkpoint or replayable input; evidence must show the old instance cannot resume governed effects.

- **D4-03 — Single authority:** zero overlapping active fences or effectful generations.
- **D4-04 — Post-fence denial:** zero post-fence secret/context/connector/artifact operations.
- **D4-05 — Health authority:** health events never extend lease ownership.
- **D4-06 — Availability (INITIAL):** healthy availability ≥99.5% under the availability SLI contract above.
- **D4-07 — Convergence (INITIAL):** after control-plane restart ≤2 minutes and after worker/provider resume or fenced replacement ≤10 minutes.
- **D4-08 — Ambiguous effects:** any duplicate external effect is bounded to at most one per ambiguous-ACK point, carries the same idempotency identity, and is fully attributable.
- **D4-09 — Checkpoint identity:** checkpoint hash, service ID, and generation match before restore.
- **D4-10 — Budget authority:** budget/TTL stop cannot be overridden by the worker.
- **D4-11 — Final cleanup:** zero service instances or provider resources.

## D5 — Staging HA, load, and disaster recovery gate

**D5-00 — Topology:** at least two control-plane replicas behind the production load balancer, at least four workers across two failure domains, external PostgreSQL/object storage, shared realtime broker and shared rate/admission store, managed secret store, and production-equivalent TLS, telemetry, backup, and image policy.

HA requirements:

- **D5-HA01 — Replica loss:** zero accepted-write loss and zero double execution.
- **D5-HA02 — Failover (INITIAL):** application failover RTO ≤60 seconds; accepted-mutation RPO = 0.
- **D5-HA03 — Deployment and compatibility:** rolling deployment, worker drain, broker outage/catch-up, and migration-first startup pass. The initial distributed release uses the independent frozen-v1 baseline on both sides; the first and every later protocol-changing release must additionally pass non-identical N/N-1 producer/consumer tests.
- **D5-HA04 — Realtime recovery (INITIAL):** catch-up completes within 5 minutes after broker recovery.

Load/fairness model:

- **D5-L01 — Load floor (INITIAL):** at least 20 Organizations, 2,000 queued jobs, 100 active leases, and 10,000 events/minute for 60 minutes plus 15 minutes of worker churn.
- **D5-L02 — Noisy tenant:** one noisy Organization submits at least 10× the quiet-tenant rate.
- **D5-L03 — Fairness:** quiet-tenant throughput remains ≥90% of its isolated baseline and p95 queue delay remains ≤2× its isolated baseline.
- **D5-L04 — Error rate:** API 5xx rate ≤0.1%.
- **D5-L05 — Latency (INITIAL):** submit p95 ≤750 ms, lease poll p95 ≤1 second, and event ACK p95 ≤500 ms.
- **D5-L06 — Quota accounting:** quota/spend exhaustion never exceeds configured concurrency and never releases capacity twice.

Disaster-recovery requirements:

- **D5-DR01 — Same-candidate restore:** database backup/restore and object-manifest reconciliation run on the same release candidate.
- **D5-DR02 — Database objectives (INITIAL):** RPO ≤15 minutes and full-service RTO ≤4 hours.
- **D5-DR03 — Object-store objectives (INITIAL):** RPO ≤15 minutes, measured as the age at the declared fault time of the newest committed authoritative manifest whose matching bytes are recoverable. Object-store reconciliation RTO is ≤4 hours from restore start until every object referenced by the recovered authoritative manifest set is either verified readable or the restore is declared failed.
- **D5-DR04 — Object integrity:** every object in the recovered authoritative manifest set matches its recorded SHA-256 digest, byte size, tenant/Organization scope, object prefix, and artifact/checkpoint identity. Inject at least one missing object and one corrupt object; neither may be promoted or served, and a successful gate has zero unresolved missing or mismatched authoritative objects.
- **D5-DR05 — Quarantine:** missing or mismatched objects are quarantined, never silently promoted.
- **D5-DR06 — Restored fences:** restored state rejects every pre-restore stale fence.
- **D5-DR07 — Restore rollout:** worker re-enrollment/revocation and the applicable frozen-baseline or non-identical N/N-1 protocol rollout succeed after restore.

## D6 — Private-beta canary gate

**D6-01 — Entry closure:** All D0–D5 records, including D2 coding, D3 browser, and D4 service, must be current for the same release candidate. A coding-only candidate cannot enter or pass D6.

**D6-02 — Campaign floor (INITIAL):** at least three external beta Organizations each participate throughout the same 14 consecutive calendar days; at least 1,000 attempts complete; end-to-end availability is ≥99.5% under the availability SLI contract above; zero Severity 0/1 incidents and zero open Critical/High security findings occur; every Medium finding has an owner, mitigation, and due date.

**D6-03 — Mandatory workload floors:** at least 100 completed coding jobs, at least 50 completed browser journeys, and at least 72 accumulated healthy service-hours, conjunctively rather than interchangeably. Every participating beta Organization advertises and exercises at least one coding, one browser, and one service row. Separate workload flags are per-Organization exposure, incident-disable, and rollback controls only; a disabled coding, browser, or service flag blocks or resets the campaign rather than waiving that workload's floor. Desktop and cross-target mobility remain optional under their separate closure rules.

**D6-04 — Frozen support matrix (INITIAL availability):** Before the canary starts, commit the advertised support matrix. It contains all required coding, browser, and service rows for every participating Organization. Each immutable row has a stable row ID and names Organization, workload, target class, provider, OS/version or `not_applicable`, credential-binding mode, locality mode, allowed fallback, and mobility mode. Mobility is `disabled` or `fenced_restart`; an enabled row lists exact directed source-row→destination-row handoffs, never an implicit all-target claim. Every advertised row requires at least 200 normal scheduled probes, availability ≥99.5% under the D6 SLI contract, and at least three deliberate fail-closed samples covering applicable owner/credential mismatch, target/locality mismatch, forbidden fallback or capability escalation. Deliberate denial probes are evaluated separately and do not enter the normal availability numerator or denominator. An inapplicable denial class requires an approved rationale; aggregation across rows cannot hide an untested or unreliable combination.

**D6-05 — Mobility closure:** When mobility is `disabled`, deployment, API, UI, and workload handoff flags remain hard off; a handoff request is rejected; loss of a selected target queues or fails according to immutable fallback policy and never creates a cross-target attempt; and same-candidate negative evidence proves no route can advertise or invoke mobility. When `fenced_restart` is advertised, MIG-004 and its conditional desktop closure apply, and every declared direction has at least 10 successful handoffs plus three partition/destination-failure cases proving permanent source fencing, zero concurrent governed effects, and no source-authority revival.

**D6-06 — Partner approval:** Each external design partner has a completed, access-controlled legal and data-handling checklist before its first real workload. At minimum it records:

- **D6-06A — Partner identity:** the legal entity, authorized beta sponsor, and named technical, security, privacy, incident, and offboarding contacts.
- **D6-06B — Partner terms:** executed beta/confidentiality and applicable data-processing terms approved through the project's legal process.
- **D6-06C — Data scope:** allowed and prohibited data classifications, approved use cases, data subjects, and any regulated-data exclusion.
- **D6-06D — Processing scope:** approved processing regions, residency constraints, subprocessors/providers, cross-border handling, and locality/fallback policy.
- **D6-06E — Credential and lifecycle scope:** credential/connector ownership, least-privilege access, revocation, audit access, retention/deletion periods, export, and verified offboarding deletion.
- **D6-06F — Incident scope:** incident-notification route and timing, support boundaries, rollback/disable authority, and consent for the telemetry and evidence retained by these gates.

**D6-07 — Commercial exclusion:** Billing, pricing, invoicing, payment collection, and commercial metering are explicitly outside this gate.

During the canary:

- **D6-08 — On-call observation:** dashboards and alerts are observed by the named on-call owner.
- **D6-09 — Kill rehearsal:** one scheduling-disable/provider-kill rehearsal completes.
- **D6-10 — Disable timing (INITIAL):** new scheduling stops within 60 seconds, and active work is drained, canceled, or explicitly quarantined within 60 minutes.
- **D6-11 — Cutover rollback:** one tenant cutover and rollback occurs with active work.
- **D6-12 — Support exercise:** support intake, incident severity, customer communication, and rollback ownership are exercised.
- **D6-13 — Organization controls:** every Organization has workload flags, quotas, spend/runtime caps, known limitations, and a named rollback path.

**D6-14 — Campaign reset:** A canary resets after any hard-invariant failure, Severity 0/1 incident, incompatible schema/protocol change, or release-candidate image change.

## Desktop beta gate

**DSK-00 — Optional-surface closure:** Desktop remains optional. If desktop execution is disabled, deployment, Organization, and workload flags remain off; release documentation says it is unavailable; and the same-candidate negative evidence proves that API/UI configuration cannot advertise or select a desktop target, enrollment cannot create an enabled desktop target, a desktop-required request queues or fails closed, and no fallback silently routes work to desktop. If desktop execution is enabled for any beta Organization or workload, every advertised OS/version must pass this gate on the same release candidate.

For every advertised OS/version:

- **DSK-01 — Signature:** signed/notarized installer and binary verification pass.
- **DSK-02 — Lifecycle:** clean install, uninstall, N-1→N update, rollback to an allowed N-1 version, and explicit downgrade refusal when compatibility policy forbids rollback pass.
- **DSK-03 — Keychain and enrollment:** OS-keychain storage, enrollment, device loss, rotation, and revocation pass.
- **DSK-04 — Device-local credential contract:** every advertised device-local credential mode passes its per-OS broker contract: the value remains in OS-protected storage; only redacted handle metadata leaves the device; wrong OS user/owner/Organization/target is denied; a control-plane partition with public Internet still reachable, lease/fence replacement, owner-membership removal, target generation replacement, and explicit handle revocation each block the next governed request and destroy per-job activation; the underlying personal login may remain stored but carries no AoA job authority; direct broker/egress bypass and secret-canary leakage are zero.
- **DSK-05 — Folder confinement:** at least 10,000 traversal/symlink/case-collision property cases produce zero folder escape.
- **DSK-06 — Offline fencing:** a 24-hour offline run buffers encrypted events, loses its lease, and cannot auto-commit.
- **DSK-07 — Orphan output:** orphan patches require explicit review.
- **DSK-08 — Revocation timing:** online revocation blocks refresh/new lease within 60 seconds and active work reaches cancel/kill within 5 minutes.
- **DSK-09 — Installed-host journeys:** at least one complete online end-to-end journey of each type passes through the installed desktop host: successful enroll→place→lease→stage→execute→commit→authorized-readback; cancellation with worker-visible stop and permanent fence; disconnect/reconnect with cumulative ACK, duplicate suppression, and durable catch-up; stale-fence output accepted only by the quarantine operation and never ordinary commit; and uninstall/revoke cleanup with zero running worker/sandbox process, active lease, temporary grant, or unreviewed promoted output.
- **DSK-10 — Diagnostic redaction:** diagnostics and support bundles contain no secret or customer-source bytes.

## Gate decision rule

**DEC-01 — Gate decision:** The Integration Gate Owner records `pass`, `fail`, or `blocked_external` on one exact revision. A hard-invariant failure is always `fail` and is never waivable. A REQUIRED repository-suite failure is `fail` unless it is covered by the committed pre-existing-failure baseline (see DEC-03); a failure that is new since the baseline SHA, or that touches a file the epic changed, is a regression and is always `fail`. `blocked_external` is reserved for an unavailable provider or environment that prevents the required lane/schedule from starting after the same revision has passed every locally runnable REQUIRED/HARD/INITIAL condition, and it never promotes the epic. After a campaign starts, scheduled provider/environment failures count and a missed threshold is `fail`. A focused lane alone cannot convert a required repository failure to `pass`, and an unattributed assertion that a failure predates the diff cannot either — only an explicit baseline row can.

**DEC-03 — Pre-existing-failure baseline:** The REQUIRED repository suite (`pnpm test:run`, `pnpm -r typecheck`) may already fail on `main` for reasons unrelated to the epic under gate. A blanket "every required failure is `fail`" rule is unsatisfiable whenever `main` is not perfectly green, so each epic that runs the full suite commits an immutable, attributed baseline (e.g. `docs/replatform/epics/<epic>/qa/pre-existing-failure-baseline.md`) captured at its frozen Start SHA. Rules: (1) the baseline is authoritative only when captured in the **same environment the gate runs in** — the Linux CI lanes (`pr.yml`), with workspace packages built and any required datastore provisioned; a local capture (especially Windows, which skips integration/e2e/migration lanes per Issue #114 and depends on a prior `pnpm -r build` for workspace-package resolution) is an **advisory seed only**. (2) Each row records test id/file, failing lane, the exact 40-char SHA observed, a one-line cause, and an attribution (tracked issue id or `unattributed`). (3) A required failure is waivable only if its test id is in the baseline AND it touches no epic-changed file. (4) The gate `pass`es only when hard-invariants are green and the required-suite failures are a subset of the baseline with zero epic-touched-file failures. (5) A new non-epic failure is added as a superseding, attributed baseline row before the epic can pass — the baseline never silently absorbs an unexplained new failure. The baseline is immutable/append-only under the same `Supersedes` rule as QA/handoff records.
