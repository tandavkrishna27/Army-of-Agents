# Accepted Re-platform Caveats

**Status:** Approved program constraint
**Applies to:** E2 through E11 (CAV-005 governs E2; CAV-001–004 apply E3 onward)
**Authority:** Subordinate to locked product decisions and [`program-design.md`](program-design.md)

## Purpose

This record distinguishes accepted product limitations from missing safety or correctness work. An accepted caveat may narrow supported behavior; it never waives tenant isolation, control-plane authority, lease fencing, owner-bound credential rules, auditability, or cleanup.

## Non-caveatable invariants

- PostgreSQL is authoritative for business, policy, scheduler, lease, cost, and audit state.
- Workers connect outbound and receive no database credentials.
- Desktop and cloud systems exchange envelopes, events, snapshots, patches, checkpoints, and artifacts, not replicated AoA database rows.
- A stale or replaced lease cannot fetch secrets, commit authoritative output, complete an attempt, or perform new governed effects.
- Worker-reported capabilities cannot elevate the server-assigned target class, trust ceiling, owner binding, credential ceiling, provider allowlist, or data-locality permission.
- Owner-bound credentials cannot fall back to another user, a shared worker, or any otherwise unauthorized target.
- Shared-cloud tenant commands execute only inside a verified sandbox boundary.
- Missing or failed isolation, cleanup, identity, placement, or target-policy checks fail closed.

## Fence-aware governed effects and credential boundaries

A governed external effect includes provider create/execute/resume/checkpoint calls, connector/API calls, browser actions, service side effects, and any other network operation that can start, continue, publish, or broaden work under an AoA job. Every such effect must pass through a control-plane operation or enforced egress gate that revalidates the live job, attempt, lease, fence, target generation, owner, and policy immediately before forwarding the effect. The sandbox has no alternate governed-egress path. If live validation is unavailable, the effect fails closed; an offline policy may permit bounded local computation, never governed remote effects.

Cleanup must remain possible after authority is lost. At sandbox creation, the provider-management boundary derives a distinct monotonic cleanup authority bound to the opaque provider resource, target/device generation, job, attempt, lease, observed fence, ownership labels, and a bounded cleanup deadline. It permits only list/inspect of matching AoA-owned resources and cancel/kill/destroy/idempotent reconcile-cleanup; it cannot create, execute, resume, checkpoint, expose job data, or open egress. Lease expiry/replacement/revocation withdraws effect authority but deliberately preserves this least-privilege cleanup authority until successful destruction or deadline. Every use is idempotent and audited, and later server reconciliation can repeat it safely.

For the initial beta, platform-managed provider-control credentials remain inside the worker/provider-management boundary. They are never materialized into tenant commands, sandbox environment variables, sandbox files, job envelopes, events, artifacts, or support evidence. Provider calls pass the provider gate before the credential is used: effectful calls require live fence authorization, while the narrow post-fence cleanup operations above require the bound monotonic cleanup authority.

A personal credential already owned by an enrolled owner-scoped desktop target remains device-local in OS-protected storage and is never uploaded to the control plane, job envelope, outbox, or artifact store. Organization-dedicated targets use the separate `organization_brokered` authority; v1 does not silently treat them as personal devices. Desktop AoA use is mediated by a local credential broker and an enforced egress path bound to Organization, owner, job, attempt, lease, fence, target generation, and policy. Any per-job activation or unavoidable CLI materialization expires no later than the current lease/session authorization, is available only inside that job sandbox, and cannot bypass the fence-aware egress gate. Renewal failure, lease expiry or replacement, target/session revocation, generation replacement, or owner-membership loss withdraws the activation, destroys ephemeral material, and terminates or isolates the consuming process before another governed effect. A disconnected device cannot refresh that authority or perform governed remote effects; reconnect revalidates all bindings before reuse. The underlying user-owned login may remain in OS storage, but it no longer carries AoA job authority.

## CAV-001 — E2B runtime and provider limits are accepted

E2B is the initial managed-cloud sandbox provider. Its verified, plan-specific limits on continuous runtime, TTL, resources, concurrency, provisioning latency, regions, templates, persistence, pause/resume, and supported operations are accepted product constraints for the initial release.

This acceptance has the following required behavior:

- The E2B adapter records the verified provider-limit matrix and the template/image and policy versions used by each attempt.
- Admission compares the requested workload against AoA policy and the configured, verified E2B limits before leasing.
- A request that cannot fit remains queued with an attributable reason or fails before sensitive job details are released.
- A provider limit never silently widens an AoA lease, deadline, resource limit, or security policy.
- A batch or browser attempt reaching a provider limit is canceled or terminalized through the ordinary fenced lifecycle.
- A service that must outlive one E2B sandbox uses a new fenced instance and an approved checkpoint or replayable input. The initial release does not promise one uninterrupted E2B process beyond the provider's verified maximum.
- Retry or fallback creates a new attempt and re-evaluates placement, credential, data-locality, and workspace availability constraints.
- No fallback occurs merely because E2B is unavailable or too limited. Fallback must be explicitly permitted by the immutable placement policy.
- Operator and user experiences expose the effective limit and the reason for queueing, termination, or replacement.
- D2 and release evidence use the real provider and record the observed limit/configuration matrix without committing provider credentials.

The following are not accepted consequences of E2B limits:

- weaker tenant isolation;
- skipped cleanup or leaked sandboxes;
- unbounded duplicate effects;
- silent routing to a laptop, shared target, or different provider;
- E2B-specific fields in the common job, lease, event, workspace, or secret protocol;
- claiming support for a workload that cannot complete or checkpoint within verified limits.

Revisit this caveat when E2B changes material limits, AoA adds another managed provider, or service workloads require a continuity guarantee that checkpoint-and-restart cannot satisfy.

## CAV-002 — A self-hosted Firecracker worker platform is out of scope

The initial program does not build or operate a self-hosted Firecracker platform. Firecracker host provisioning, jailer and kernel management, microVM image construction, snapshot distribution, tap/network management, host capacity scheduling, autoscaling, patching, and fleet operations are out of scope.

This exclusion does not permit provider coupling. The worker/provider seam must remain capable of supporting a future self-hosted Firecracker provider without redesigning control-plane authority or the worker protocol.

The provider seam must retain:

- provider-neutral create, execute, cancel, kill, destroy, list, inspect, and idempotent reconcile/cleanup operations;
- optional checkpoint/restore and health capabilities negotiated explicitly;
- opaque provider resource identifiers;
- deadlines and idempotency for every provider operation;
- lease, attempt, sandbox, and target correlation;
- no provider credentials in job envelopes, events, metadata, or artifacts;
- a shared provider-contract suite;
- independent capability, isolation, network-policy, image-provenance, cleanup, and observability conformance gates.

No Firecracker-specific field may enter a common wire contract when an opaque provider field or versioned capability can express the requirement. A future Firecracker implementation must pass the same contract, isolation, fencing, egress, cleanup, tenant, and release gates as E2B. It is not required for the initial private beta.

## CAV-003 — Cross-target handoff is fenced restart, not live migration

The initial release does not provide transparent process-level migration between a laptop and a managed-cloud target. A supported handoff is:

1. Stop new governed effects on the old attempt.
2. Request cancellation, graceful stop, patch preparation, or checkpoint as appropriate.
3. Expire or release the old lease and fence it permanently.
4. Validate the declared snapshot, patch, browser checkpoint, or service checkpoint.
5. Create a new attempt with a newly evaluated placement policy and a new fence.
6. Surface any conflict, locality failure, missing credential, or unsupported capability.

Batch handoff uses an immutable base snapshot and an optional reviewable patch. Browser handoff starts clean unless a specifically approved checkpoint is supported. Service handoff uses an approved checkpoint or replayable input. At no point may the source and destination attempts for the same job, or the source and destination instances for the same service generation, perform governed external effects concurrently.

## CAV-004 — Offline output is non-authoritative until reconciled

A desktop worker may buffer events and may finish bounded local computation according to the immutable job offline policy. It cannot make stale output authoritative.

The program selects the following mechanism for v1: a device-authenticated **quarantine upload**. It uses a separate object prefix and operation from ordinary fenced artifact commit, returns an orphan receipt, cannot mutate the old attempt/run/checkpoint selection/live workspace, and always requires explicit review. If quarantine upload is unavailable, the worker retains encrypted orphan output locally; it does not fall back to ordinary commit.

A stale fence is never accepted by the artifact-commit path. Reconnect first revalidates target status and generation, owner status, protocol compatibility, lease state, and workspace base. A folder grant is permission to read and stage declared content; it is not permission to keep writing directly to a live user folder after lease loss.

## CAV-005 — Legacy tenant tables stay application-layer isolated; no retrofit in this program

The re-platform introduces a non-owner database role and forced RLS **only on the new distributed job, worker, service, and lease tables** (E2 / TEN-001 through TEN-005). The existing product's tenant tables (~129 tables carrying `companyId`, e.g. issues, memory, discussions, agents) continue to rely on the current application-layer boundary — the ~557 `assertCompanyAccess` checks gated on `tenantIsolationEnforced()` — plus the shipped `company_secrets` RLS canary. Converting the entire legacy schema to a non-owner connection with forced RLS is **explicitly out of scope for this program.**

This is an accepted product decision, not an unaddressed gap:

- The distributed path this program builds is DB-enforced-isolated from the start.
- The legacy product keeps its existing, reviewed application-layer isolation; this program adds no new legacy exposure and moves no legacy table onto a less-safe path.
- The pervasive "new-path tenant tables" wording in E2 and the security invariants refers to exactly this boundary; E2 does not claim to make the existing product DB-enforced.
- Accepted for the invite-only / bounded-tenant beta posture. A future full-fleet RLS retrofit of the legacy schema, if pursued, is a **separate initiative** with its own non-owner-role cutover, per-table policy, and adversarial evidence — neither a dependency nor a deliverable of this program.

This caveat narrows the *scope of new DB-level enforcement*; it does not waive tenant isolation. The legacy boundary remains the reviewed `assertCompanyAccess` gate, and any change that would weaken it is a locked-decision matter, not a caveat.

## Review and change rule

A caveat change that alters authority, placement, fencing, isolation, credential scope, or workspace promotion is a cross-epic architecture decision. It must be recorded through the decision process and reflected in affected plans, conformance vectors, QA matrices, and release evidence.
