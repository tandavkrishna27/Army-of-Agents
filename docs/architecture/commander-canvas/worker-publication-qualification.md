# Worker publication — qualification record

**Status: planning record, not execution approval.** Reviewed source is 183e46a9c65fc3105c7e3d125629276814df7dbb; reviewed plan is a033e17c0a19d5f44de2be3837fd81b3ca16398c. [Claude's reconciliation review](worker-publication-reconciliation-review-report.md) supports contract consistency. This record tracks the remaining evidence for the [identity/revocation contract](worker-publication-identity-revocation.md). No runtime checks have run.

## Review closure

M1 and M3 are resolved as proposed contracts, with their qualification gates open. M2's default-deny contract is resolved; processor-specific validation is still unqualified. LOW-1 is withdrawn by its author after verifying the composite cascading job FK. LOW-2 remains an implementation verification obligation. Add a one-way dependency check: E4 processing may call E2's output-binding service; the service must not import E4 publication, artifact UI or a composition root that imports them back.

The report's phrase “deadlock-safe” is not accepted as proven. A consistent declared order is necessary; all actual SQL paths, implicit foreign-key locks, triggers, cascades and lock upgrades must be reviewed and tested. Company shared locks permit concurrent publishers; they do not serialize every publication. Exclusive permission changes conflict with those shared locks, and unrelated company-row updates may also contend. Measure the real pattern rather than assume either zero contention or complete serialization.

## M1 — exact source-to-producer map

| Obligation | Pinned source / proposed owner | Qualification still required |
|---|---|---|
| User request and canonical message | server/src/routes/internal-agent.ts uses agentLoopService; server/src/services/internal-agent/agent-loop.ts appends the user message and calls claimTurn | E2.2 submission replay must resolve the same persisted userMessageId before creating slots; no second admission authority |
| Current claim | server/src/services/internal-agent/conversation.ts claimTurn, heartbeatTurn and finishTurn | finishTurn updates status under token predicate only. E2.2's proposed transaction-aware acceptance must check the authoritative claim/cancel state and persist accepted output identity in that transaction |
| Worker output observation | Exact committed job/attempt/identifier through the tenant repository, as specified in worker-publication-plan.md | This establishes committed bytes, not a winning Commander result |
| Accepted slot / attempt | Proposed E2.2 output-binding service and schema | Bind the true result-owner export, job association and cancellation writer; do not treat the latest attempt or a callback as canonical acceptance |
| Distributed routing and user credentials | docs/replatform/epics/E10-desktop-migration-realtime/findings.md, E10-F001 at the pinned source | Upstream routing, per-user credentials and interactive result delivery remain unbound here. No replacement export is invented |
| User artifact and reply | E4.2 common publication and E4.3 canonical artifact/version writer, followed by E2 reply projection | Acceptance of worker identity precedes E4 publication; reply repair consumes saved result, never reruns execution or creates a completion dependency cycle |

Before enabling the generated path, the accepted binding record must give actual file/export and source SHA for admission, claim, accepted result, cancellation and original-conversation delivery; transaction/connection ownership; supported credential modes; and replay/stale-claim/competing-attempt/cancel race results. A source export that does not yet exist stays missing. A newer replatform revision must be assessed explicitly before replacing this pin.

## M3 — expanded source coverage matrix

This is an expanded static discovery record, not a certification of exhaustive coverage. Paths below are relative to the repository. Existing paths are evidence anchors; the proposed barrier is not implemented. Every authority-changing writer in a supported mode must follow the contract's credential/principal → company → action/binding/publication → destination/artifact order. The rows identify migration scope; actual function-by-function lock traces remain acceptance evidence.

| Authority / discovered paths | Required treatment and evidence | Proposed accountable area |
|---|---|---|
| Company roles: server/src/services/permissions.ts; team.ts | Role insert/update/delete and demotion join company barrier; prove grant-first/revoke-first and founder-policy preservation | E4 security + actual permission-service owner |
| Memberships/grants: server/src/services/access.ts; team.ts; org-hierarchy.ts; companies.ts | Include replace/bulk/remove, grant deletion, linked MCP revocation and company teardown; credential locks must precede company locks even when current source writes membership first | E4 security + access/team owners |
| Global admin/bootstrap: server/src/board-claim.ts; index.ts; services/first-user-bootstrap.ts; services/founder-grants-backfill.ts; auth/better-auth.ts creation hooks | Include admin insert/delete, first-user hooks, startup membership and founder grant backfill. Establish stable principal locking even when a role row is absent. Startup is not an automatic exemption | Auth/security owner |
| Organization authority: server/src/services/organizations.ts; organization-access.ts; operator-break-glass.ts | Trace whether each mutation can affect the supported publication credential/destination. Preserve deployment-specific behavior; inert modes get an evidence-backed exclusion, not new access semantics | Organization/auth owner |
| Board keys: server/src/services/board-auth.ts revokeCurrentBoardApiKey and approveCliAuthChallenge; routes/cli-auth.ts | Bind the actual key/principal row, expiry and issuance/revocation ordering; multi-company effects must use stable ordering | Auth owner |
| MCP keys: server/src/services/mcp.ts; access.ts; team.ts; companies.ts | Revoke/create/delete and membership-linked revocation participate; preserve bearer owner scope and current cloud membership checks | Auth/access owners |
| Agent credentials/status: server/src/services/agents.ts; companies.ts; middleware/auth.ts | Key revoke/delete plus agent termination/status authorities must be included, not key validity alone | Agent/auth owners |
| Conversation destination: server/src/routes/internal-agent.ts; services/internal-agent/conversation.ts; routes/conversation-authz.ts | Hard delete/ownership and actual permission changes join barrier. Rename, pin and archive are not automatically access revocation; classify each field under canonical policy | E2.2 + conversation owner |
| Discussion destination: server/src/services/threads.ts participant writers; routes/discussions.ts shareToken creation/revocation | Include participant add/update/remove and share grant/revoke; preserve audience and private-source lineage | Discussion/security owner |
| Source/destination content: canonical asset/artifact/task/discussion writers, cascades and imports | Further enumerate authorization-relevant audience, source deletion and reassignment paths from each E4 destination/lineage. Company membership coverage alone is insufficient | E4.1–3 + canonical resource owners |
| Session provider: server/src/auth/better-auth.ts and its configured adapter/library | Enumerate session create/delete/revoke, user/account deletion and provider-managed writers that rg cannot see. Existing create hooks do not prove logout/deletion coordination | Auth/security owner |
| Telemetry candidates: middleware/auth.ts; realtime/live-events-ws.ts; services/upgrade-auth.ts; board-auth.ts touchBoardApiKey | Observed lastUsedAt writes are telemetry, not revocation. Review contention/lock upgrade and ensure adding barriers does not create opposite lock order; do not classify them as permission changes without field evidence | Auth/realtime owner |
| Test/dev/maintenance: routes/test-support.ts; dev/seed-commander-review.ts; migrations, scripts, raw SQL and external administrative writers | Keep test-only paths distinct, verify production exclusion, enumerate reachable maintenance/import paths. A regex over Drizzle calls cannot certify completeness | BASE/security reviewer |

Discovery included insert/update/delete calls for role, company membership/grant, organization membership, conversation, participant, board/agent/MCP key and auth tables under server/src; auth middleware branches; session hooks and existing replatform findings. Broaden before acceptance to aliases, raw SQL, repository delegates, library writers, cascades, background jobs and authorized administrative SQL. Record for each actual function: fields changed, authority rows, deployment/credential modes, lock trace, caller, owner, test or justified exclusion. Require a reviewed disposition for every search hit and the non-text-search sources. Any uncovered active path blocks its affected mode; do not call this matrix complete merely because its rows are filled.

### Credential-mode checklist

| Mode found in middleware/auth.ts | Required binding; current status |
|---|---|
| local_implicit | Deployment authority plus canonical local identity must be explicit; no invented bearer credential row. Qualify configuration transitions/process restart semantics before background publication |
| session | Current persisted session/user authority and provider adapter writers; global admin versus cloud membership semantics. Provider-managed revocation coverage open |
| board_key | boardApiKeys row, principal/admin and company/destination policy. Writer matrix above still requires accepted lock traces |
| mcp_key | mcpApiKeys plus current delegated-user/company authority; founder-created key does not acquire interactive-board reach |
| agent key | agentApiKeys plus agent status and company/source policy; actual canonical destination permissions still apply |
| commander_jwt | Signed turn claims alone are insufficient for fresh publication authority. Bind live canonical claim/user/conversation and revocation mechanism; unsupported until qualified |
| agent_jwt | Signed claims plus live agent state still need a qualified revocation/claim binding; no nonexistent key row or expiry-only guarantee |
| worker transport | A verified worker session authenticates transport, not application publication permission. No new direct worker writer authority |

No mode is marked qualified by this table. Local and cloud stay in V1 scope; missing qualifications block those increments rather than silently dropping them.

## Contention and concurrency acceptance

After explicit execution approval, test with real PostgreSQL transactions and production-equivalent roles. Use deterministic barriers, not timing sleeps, for correctness races.

- Same-company concurrent publishers, one publisher versus each revoke path, unrelated companies, global admin/key changes across companies, company teardown and concurrent ordinary company updates.
- Inspect locks implicitly acquired by foreign keys, cascades, audit writes and library hooks. Exercise claim heartbeat/cancel/accept paths against publication. No lock upgrade or reverse acquisition may be assumed safe.
- Record lock wait p50/p95/p99, maximum wait, throughput, lock timeout/deadlock count, rollback integrity and connection-pool occupancy. Include contention with lastUsedAt telemetry where it locks the same credential rows.
- Before the run, BASE/security owners agree workload, concurrency and latency/timeout budgets from the target environment; values are not fabricated in this planning record. Compare against baseline. Unexplained deadlocks or starvation fail qualification.
- A lock timeout/deadlock must roll back with no published receipt/index or partial canonical result. Only replay a safely retryable transaction under the same action/slot and freshly checked authority; never regenerate the worker action.
- Keep storage/network work outside final database locks and verify cancellation/cleanup cannot leave a published missing object.

## What is done and what remains

**Done:** independent consistency review of a033e17c0, author verification, and this review's documentation reconciliation. No unchanged contract needs another automatic Claude loop.

**Before affected implementation approval:** actual CMD export binding or explicit upstream blocker; reviewed authority-writer/credential traces; accountable reviewer/integrator acceptance; exact environment and qualification command proposal. Static discovery can continue in planning, but no missing producer or runtime proof is invented.

**After separately authorized implementation/qualification:** real concurrency, role, retention, processor, host and end-to-end evidence. Review acceptance is not runtime evidence.

Other planning remains in [final decisions](final-planning-decisions.md): D3 speech/media policy, responsibility identities and bounded BASE/DESIGN preparation. These gate their own scope; this worker-publication review does not block unrelated canvas design. No implementation, provider session, migration or dependency change is authorized.
