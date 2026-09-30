# PR #316 Final Pre-Landing Audit Plan

**Branch:** `claude/multitenant-cloud`
**Baseline:** `origin/main...1eb61ec7`
**Purpose:** Establish whether PR #316 safely delivers its locked multi-tenant-cloud scope, fix any newly verified defects, and produce an evidence-backed merge recommendation before starting the deferred gVisor follow-up.

## Outcome

PR #316 is ready to merge only when its implemented scope is internally consistent, company/organization boundaries fail closed, shared/db/server/UI contracts agree, required local verification passes, and required Linux CI is green. Deferred runtime activation work must remain explicitly inert and documented rather than partially activated.

## Locked Scope Boundary

### In scope for this audit

- Verify P1-P5 schema, authorization, journey, provider-resolution scaffolding, execution-target scaffolding, UI access states, migrations, tests, and documentation against the locked plans and Decision #117.
- Audit plan-versus-delivery and current PR comments/reviews.
- Reproduce every candidate finding against current source and tests.
- Fix verified defects whose correction is necessary for #316's stated behavior or fail-closed invariants.
- Add or strengthen regression tests for every behavior-changing fix.
- Run the repository's full handoff verification gate and inspect current GitHub CI.

### Not in scope for PR #316

- Real multi-worker `GvisorPoolClient`, worker fleet transport, or production pool rollout.
- Hardware checkpoints A-D from `gvisor-worker-image.md`.
- Activating `org_default` provider runtime before the provider create/assign surface and all credential callers are organization-aware.
- Company-qualified issue URL namespace, sentinel-default removal, governed break-glass endpoints, or other explicitly deferred initiatives unless the audit proves an existing #316 path is unsafe without the change.
- Merging, pushing, or opening a new PR without explicit founder direction.

## Audit Workstreams

1. **Plan and scope completion**
   - Map the master scope, phase plans, Decision #117, PR body, commits, and handoff to delivered code.
   - Classify each requirement as delivered, changed-equivalent, partial, deferred-by-design, or missing.
   - Treat the current PR body as stale where later commits/docs supersede it; verify code rather than trusting prose.

2. **Tenant security and data safety**
   - Trace board, agent, MCP, WebSocket, onboarding, import, provider, and execution-target authorization boundaries.
   - Check company/organization scoping at read and mutation sites, transaction atomicity, uniqueness/backfill behavior, migration ordering, and fail-closed deployment-mode behavior.
   - Validate deliberate inertness: no empty `org_default` or gVisor seam may silently become reachable.

3. **Contracts, UX, and DX**
   - Verify DB/shared/server/UI contract synchronization and enum/value completeness.
   - Inspect onboarding, company selection, access-required, provider guidance, execution-target settings, and error states.
   - Confirm docs and rollout guidance match actual behavior and do not overclaim gVisor protection.

4. **Testing, operations, and performance**
   - Map security-critical branches to unit, route, integration, and e2e coverage.
   - Inspect CI, migration/no-drift checks, Windows/Linux split, advisory LLM evals, and known flakes.
   - Review hot-path scans, concurrency clamps, worker heartbeat, startup reconcilers, and resource cleanup.

5. **Independent adversarial passes**
   - Run independent plan/scope, security/data, and delivery-quality reviewers.
   - Run the pre-landing checklist, relevant specialists, and a final cross-cutting red-team pass.
   - Deduplicate findings by root cause and require exact source evidence before action.

## Fix Protocol

For each candidate issue:

1. Quote the motivating code and the paired safety/consumer code.
2. Reproduce with an existing test or add the smallest failing regression test.
3. Confirm it is not already fixed or intentionally deferred by a locked decision.
4. Apply the smallest complete fix across all affected contracts.
5. Run targeted tests and inspect sibling callers/values.
6. Record the finding, fix, and verification in the final review report.

## Verification Gate

Run from `C:/Users/TK/.aoa/wt/mt-cloud`:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
node scripts/check-forbidden-tokens.mjs
pnpm db:generate
git status --short
```

Additionally:

- Run targeted suites for every modified subsystem.
- Re-run suspected Windows flakes in isolation before classification.
- Treat Linux `verify`, `e2e`, `migrations`, `policy`, `lint`, `brand-check`, and the `ci-required` aggregator as authoritative.
- Record the advisory LLM-eval result separately from required CI.
- Keep the live two-account `cloud_auth` staging journey and gVisor hardware checkpoints as explicit external gates.

## Branch Recommendation Gate

Default recommendation: land #316 first, then create a fresh `codex/` follow-up branch from updated `main` in a short-path detached worktree. Only keep gVisor work on this branch if a verified #316 defect cannot be corrected without implementing the deferred runtime, which would require revisiting the locked scope and PR risk before coding.

## Completion Criteria

- Plan completion matrix has no unexplained missing requirement.
- No unresolved verified P0/P1/P2 correctness or isolation defect remains.
- Fixes, if any, have regression tests and synchronized contracts/docs.
- Required verification and Linux CI are green, or every non-run gate is explicitly reported with cause.
- Final output states: merge now, fix then merge, or do not merge, with evidence.

## Autoplan Review Synthesis

### Premises

- The objective is to make #316 truthful and safe at its existing control-plane boundary, not to turn it into the real gVisor worker-plane PR.
- Locked decisions remain authoritative, but implementation claims must be corrected when the code is inert or racy.
- Generated Drizzle snapshots are verified through schema/migration/no-drift gates; review effort concentrates on handwritten migrations, schemas, services, routes, UI, and tests.
- The founder has already authorized a full investigation and scoped pre-merge fixes; no merge, commit, or push is implied.

### Approach decision

| Approach | Effort | Risk | Decision |
|---|---:|---:|---|
| Merge current head and defer every discrepancy | S | High | Rejected: leaves advertised concurrency inert and verified reachable defects open. |
| Fix verified #316 defects, re-run gates, then merge | M | Low/Medium | Selected: preserves the reviewed boundary while making the PR honest. |
| Add real gVisor/provider runtime before merge | XL | Very high | Rejected for #316: requires hardware Gate B, worker transport, firewall, and a new failure domain. |

### Review mode

**HOLD SCOPE.** No new product initiative is added. Complete only the behavior already claimed by #316 or required to keep its fail-closed/test contracts safe.

### Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | Keep real gVisor on a fresh post-merge branch | Mechanical | Reversibility | Gate-B hardware checks are unrun and the pool client is explicitly deferred. | Expanding #316 into worker-plane deployment. |
| 2 | Eng | Repair per-org concurrency instead of downgrading the claim | Scope integrity | Completeness | Decision #117 states the clamp is live; current code is both inert and check-then-act racy. | Documentation-only downgrade. |
| 3 | Security | Preserve existing organization authority when company invites are accepted | Mechanical | Fail closed | A company invite must not demote an existing org admin/billing member. | Owner-only special case. |
| 4 | Security | Make provider verification a guarded state transition | Mechanical | Explicit state machine | Revoked connections must be terminal and verify/revoke must not race into contradictory state. | Unconditional `state=verified`. |
| 5 | Test/Deploy | Complete or remove the strict cloud-auth test-support seam; prefer completing it with a boot safety guard | Scope integrity | Complete the dependency | The Google-less boot relaxation explicitly depends on the hard-gated mint seam and public-deploy refusal. | Keeping a half-seam. |
| 6 | UI | Add the missing unprefixed Settings redirect | Mechanical | User journey completeness | Both provider recovery CTAs currently navigate into the company-prefix matcher and fail. | Changing each CTA to bespoke prefix logic. |
| 7 | DX | Synchronize public API docs and add route-level negative/success coverage | Mechanical | Contract synchronization | New REST domains and payload fields are absent from `docs/api`, and provider routes have almost no behavioral tests. | Silent documentation deferral. |
| 8 | Security | Treat cloud execution-target rows and tenant-authored runsc strings as registry data, not isolation provenance | Scope integrity | Fail closed | No validated worker transport exists; the control plane is not a tenant worker. | Trusting `runtime: runsc` supplied in configuration. |
| 9 | Eng | Promote queued work across the Organization after capacity frees | Scope integrity | Liveness + fairness | Per-org capacity shared across agents cannot be released by waking only the completing agent. | Per-agent-only promotion. |
| 10 | Security | Guard every workspace command sink, not only the final adapter process | Scope integrity | Complete the boundary | Provision, cleanup, runtime-service, and job commands are independently tenant-authored host execution. | Deferring them to the worker PR while leaving them reachable. |
| 11 | Security | Reserve project-workspace `metadata.runtimeConfig` for governed runtime APIs | Mechanical | Least authority | Generic metadata writes could stage executable auto-start configuration. | Founder-only generic metadata handling. |
| 12 | Security / Ops | Reap persisted local runtime PIDs identity-safely before startup continues | Scope integrity | Safe cutover | Pre-upgrade detached tenant processes can outlive the new start guards; PID reuse forbids blind termination. | Marking rows stopped without killing, or unconditional PID kill. |
| 13 | API | Normalize malformed UUIDs and postgres-js unique errors at the route boundary | Mechanical | Stable contracts | Invalid paths and duplicate slugs must be 400/409 rather than database 500s. | Driver-shape-specific error checks. |
| 14 | Security / Ops | Complete persisted-runtime reconciliation before any durable worker or heartbeat dispatch | Mechanical | Fail closed before work | A startup continuation could otherwise launch tenant work before the legacy-process cutover gate completed. | Running reconciliation concurrently with background dispatch. |
| 15 | Security / Ops | Never persist a local-process stop until the owned process is confirmed gone or safely identified as a reused PID | Mechanical | State must match reality | A failed health probe or delivered SIGTERM does not prove process exit; hiding a live process behind a stopped row defeats the cloud cutover invariant. | Marking the row stopped after probes or signal delivery alone. |
| 16 | Security / Ops | Preserve process identity when readiness fails and cleanup cannot be confirmed | Mechanical | Never lose the handle | Throwing a startup error must not discard the only PID/process-group identity for tenant code that may still be live. | Treating a readiness error as proof cleanup succeeded. |
| 17 | Security / Ops | Bind persisted local PIDs and loopback previews to one runtime-process owner | Scope integrity | PIDs are namespace-local | Shared-database replicas must never probe, signal, stop, or proxy a foreign host's numeric PID/loopback URL. | Treating PID + wall-clock start time as globally unique. |

## What Already Exists

- `tenantIsolationEnforced()` is the static cloud enforcement source.
- `assertCompanyAccess` already resolves company tenancy and enforces active org plus company membership.
- `createSelfServeOrganization` and `createWithOperator` provide the transaction pattern for multi-step ownership writes.
- PostgreSQL transaction-scoped advisory locks already protect first-user bootstrap, provider binding, and other cross-replica critical sections.
- `UnprefixedBoardRedirect` already preserves path, query, and hash for company-qualified routing.
- `testSupportRoutes` already mints real better-auth session rows; only the strict-mode mount/safety contract is incomplete.

## Not in Scope

- Real `GvisorPoolClient`, worker image rollout, and checkpoints A-D.
- Provider create/assignment API plus three-caller organization threading.
- URL namespace migration, sentinel-default removal, and governed break-glass endpoints.
- Live Google OAuth two-account staging validation; it remains an external release gate.

## Implementation Tasks

- [x] **T1 (P1)** — Make org concurrency reservation transactionally atomic and organization-aware without changing self-hosted behavior.
- [x] **T2 (P1)** — Prevent org-role downgrades during invite admission and clear stale break-glass provenance when real access supersedes it.
- [x] **T3 (P1)** — Guard provider verify/revoke transitions and audit them atomically.
- [x] **T4 (P1)** — Complete the hard-gated `cloud_auth` e2e mint seam and public/prod boot refusal, or remove the relaxation if the safe seam cannot be completed.
- [x] **T5 (P2)** — Add the unprefixed Settings redirect and navigation regression test; remove the stale onboarding durability comment.
- [x] **T6 (P2)** — Add organization/provider/execution-target/environment API documentation and route-level provider coverage.
- [x] **T7 (P1)** — Run targeted tests, full recursive typecheck, full tests, build, forbidden-token, no-drift, and diff-hygiene checks locally.
- [x] **T8 (P1)** — Order startup reconciliation before background dispatch and make health-driven local-process stops identity-safe, retryable, and covered by lifecycle regression tests.
- [x] **T9 (P1)** — Revalidate the owning user's live organization and company memberships for every cloud MCP company-access decision so org suspension immediately makes delegated keys dormant.
- [x] **T10 (P2)** — Move cloud MCP live-membership validation before bare-identifier scope derivation, cache the one-request company snapshot, and make existing/missing identifiers indistinguishable to suspended keys.
- [x] **T11 (P2)** — Authorize every company-qualified issue parameter before identifier resolution, eliminating existing-versus-absent tenant oracles and unauthorized attachment lookups.
- [x] **T12 (P1)** — Reconcile persisted POSIX runtime process groups rather than only their leaders, failing cloud startup closed when an unverifiable descendant group survives.
- [ ] **T13 (P1 external gate)** — Commit/push the reviewed tree and require fresh Linux CI, including real PostgreSQL claim races and the real detached-process cutover tests, before merge.
- [x] **T14 (P1)** — Persist runtime process-owner provenance; owner-gate startup/health/stop/preview paths; fail cloud startup on legacy ownerless PIDs; and cover two-replica/PID-collision regressions.
- [x] **T15 (P1)** — Re-audit internal-agent tools and human-governance mutations, close cross-company lookup/mutation paths, and replace mixed actor role gates with explicit board-human gates.
- [x] **T16 (P1)** — Make cloud environment and onboarding surfaces truthful: allow only unpinned E2B environments, keep local/Docker/gVisor/worker execution unavailable, and prevent cloud onboarding from activating unsupported agents.

## Implemented Audit Fixes

1. Organization concurrency now resolves Company → Organization in `cloud_auth`, serializes cross-agent/cross-replica claims with a transaction-scoped advisory lock, and claims within both caps atomically. Self-hosted behavior remains per-agent-only.
2. Post-commit claim mirrors are failure-isolated, so event/wakeup/logging failures cannot strand committed runs before launch.
3. Organization admission uses one non-downgrading upsert that atomically converts break-glass provenance to genuine membership and is safe against concurrent cleanup.
4. Provider verify/revoke transitions are conditional and transactional; revocation always repairs dependent assignments while auditing only the winning transition.
5. The Google-less `cloud_auth` test seam now mounts only under its dedicated flag and startup rejects the flag on public, production, non-loopback, or non-loopback-base-URL deployments. A deployment-surface leak test covers workflows, deploy docs/scripts, Docker assets, releases, and root compose/Dockerfile/env inputs.
6. `/settings?tab=providers` now redirects through the selected company; reload-recovery documentation is corrected.
7. Organizations, organization spend, provider connections, execution targets, environment pins, and gVisor scaffold limitations are documented; route contracts cover success, denial, and company scoping.
8. Cloud pooled/dedicated targets are registry-only; every local Docker-family target is refused absent the explicit unsafe override. Defense-in-depth hardening forces no network, container removal, and fixed resource ceilings.
9. Organization scheduling claims capacity under a transaction advisory lock and promotes oldest queued work across agents, continuing past an agent already at its own cap.
10. Execution-target registration uses standard validation and postgres-js-aware duplicate handling; worker heartbeats are strict; malformed UUID route parameters return `400`; onboarding legacy writes persist only `COMPANY_CREATED`.
11. Workspace provision/teardown/cleanup, local runtime services, and one-shot jobs all gate before local shell execution. New cloud command configuration fails closed while self-hosted behavior is unchanged.
12. Generic project-workspace APIs reject the server-reserved `metadata.runtimeConfig`, including nested project creation, preventing low-authority callers from staging auto-start commands.
13. Startup identity-verifies and terminates persisted local runtime process groups before any durable worker, heartbeat dispatch, or desired-service restart, independently of the heartbeat flag. An unverifiable live PID blocks cloud boot and keeps its row for remediation.
14. Local-process stops now wait after `SIGTERM`, escalate tracked POSIX groups to `SIGKILL`, confirm exit, or identity-check and terminate persisted PIDs before recording `stopped`; unconfirmed processes remain active, unhealthy, and visible to retry/startup reconciliation. Explicit stops coordinate with child-exit events, natural POSIX leader exit checks group liveness, and Windows tree-kill completion is verified.
15. Detached local runtime identity is registered and persisted as `starting` before readiness waits, closing the hard-crash discovery window. Confirmed failure persists `failed`; unconfirmed cleanup retains `starting`/`unhealthy` plus both indexes; and an already-exited readiness child is never signalled through a stale/reused PID.
16. Routine and teams route-import contracts retain the meaningful `3s` Linux CI performance guard. Windows drops the nondeterministic wall-clock assertion while still requiring import completion and factory-contract assertions under the test timeout: fresh isolated teams imports ranged from `1.882s` to `8.501s`, and routines reached `6.926s`, disproving both the original `3s` and interim `5s` Windows budgets as stable cycle detectors.
17. Cloud MCP access now requires the owning user's active organization and company memberships. Same-company keys become dormant after either membership is suspended, while cross-company rejection and self-hosted behavior remain unchanged.
18. Cloud MCP authentication now performs that live check before any route parameter hook derives lookup scope. Suspended keys remain unauthenticated/unscoped; active keys carry a per-request authorized-company snapshot consumed by bare resolution and the central guard, avoiding both the identifier oracle and duplicate membership queries while preserving self-hosted and `lastUsedAt` semantics.
19. Company-qualified issue parameter hooks now call the central company-access guard before resolving identifiers or accepting UUID fast paths. Dependency GET/POST/DELETE and attachment upload therefore reject anonymous and cross-tenant actors before tenant lookup, with handler guards retained as defense-in-depth.
20. Persisted POSIX runtime reconciliation now probes the detached process group as well as its leader. A dead leader with surviving descendants remains unresolved and blocks cloud startup without unsafe signalling; after an identity-matched kill, success requires the entire group to disappear. Windows retains its verified `taskkill /T /F` path.
21. Every persisted local-process identity now carries a stable runtime owner. Startup, health checks, explicit stops, cleanup, API projections, and HTTP/WebSocket preview proxying operate only on rows owned by the current runtime host; foreign-host rows remain visible but non-actionable, and cloud boot fails closed on legacy ownerless PID rows.
22. Internal-agent thread, entry, artifact, memory, project, and workspace operations now scope both lookup endpoints to the caller company before reads or mutations. Link creation validates both endpoints, artifact attachment rejects foreign entries, and `thread.setIntent` uses a scoped conditional update.
23. Governance-only mutations now use `assertHumanRole`, which rejects agent actors instead of inheriting the historical mixed board/agent bypass in `assertRole`. Marketplace configuration and skill-update mutations separately retain an explicit board plus founder gate.
24. Cloud environment creation, update, and run orchestration accept only unpinned E2B sandbox environments. The UI hides local, Docker, gVisor, and execution-target controls in cloud mode, marks migrated unsupported rows unavailable, and onboarding explicitly defers Commander/gVisor while creating agents paused with heartbeat disabled.
25. Execution-workspace lifecycle state and runtime metadata are server-owned. Public PATCH can archive or update non-runtime config only; runtime start/stop/archive/cleanup paths reauthorize under control locks, use version fences, stop only locally tracked services, and preserve cleanup failures for retry.
26. Migration `0200` adds runtime-process ownership and retires unsafe legacy adapter rows; `0201` adds runtime identity versioning. The handwritten index is idempotent, generated snapshots and journal are synchronized, and `pnpm db:generate` reports no drift.

## Verification Record

- `pnpm -r typecheck` — pass on the final local candidate (23 of 24 workspace projects; 82.4s).
- Exact `pnpm test:run` on Linux — pass on the final local candidate (215.7s). Windows aggregate runs encountered the established OpenCode child-process contention class; the exact affected suites pass in isolated fresh processes, and the authoritative Linux full run is green.
- Focused runtime lifecycle suite (`workspace-runtime`, runtime-service control/cutover, terminate-process) — pass after each remediation round. Linux-only real-process regressions cover SIGTERM-resistant leaders/descendants, forced readiness-cleanup failure with tracked recovery, and stale-PID no-signal behavior.
- `pnpm build` — pass (59.5s); bundled marketplace/connectors refresh produced no worktree drift.
- `node scripts/check-forbidden-tokens.mjs` — pass.
- `pnpm db:generate` — pass, no schema changes or migration drift after migrations 0200/0201.
- `git diff --check` — pass apart from PowerShell LF-to-CRLF notices.
- `pnpm --filter @armyofagents/server lint` — pass (18.6s). The repository has no root `pnpm lint` script; baseline GitHub lint is green.
- Generated tools manifest, tools documentation, and AoA native skills seeder freshness checks — pass (skills checked against `C:/Users/TK/.aoa/wt/aoa-skills`).
- MCP live-membership focused suites (`tenant-isolation-matrix`, `mcp-cross-tenant`, `upgrade-auth`, and `mcp-server`) — 72 tests pass; server typecheck and lint pass. The regression exercises the protocol route and proves suspended-org denial happens before company lookup, MCP client touch, or tool dispatch.
- MCP pre-authorization focused suites (`mcp-auth-membership`, `accessible-company-ids-for-actor`, `tenant-isolation-matrix`, `mcp-cross-tenant`, and the real issues router) — 58 tests pass. They execute the real live-membership predicate, prove suspended/inactive owners remain unscoped before routing, and assert existing/absent bare identifiers both return `404`.
- Company-qualified parameter authorization suites (`dependencies-identifier-company-scope`, `issues-comments-attachments`, `issue-param-normalizer`, `assert-company-access-tenant`, and `mcp-auth-membership`) — 63 tests pass. Anonymous and cross-tenant board/agent/MCP actors receive the same authorization result for existing identifiers, absent identifiers, and raw UUIDs, with zero tenant resolver calls; active cloud MCP and authorized local-board paths remain successful. Three independent reviewers reported no P0-P3 findings; a separate focused run passed 74 tests plus server typecheck and diff hygiene.
- Runtime reconciliation focused suites — 62 tests pass with two POSIX cases skipped on Windows. The exact Linux integration suite passed ten consecutive container runs (4/4 each), and a separate 20-iteration stress probe reproduced and safely cleaned the dead-leader/live-group topology every time. Three independent runtime reviews reported no P0-P3 findings; server typecheck and diff hygiene pass.
- Runtime-owner, execution-workspace control/archive, cloud environment, onboarding, human-governance, and internal-agent tenant-isolation focused suites all pass. The final RBAC/mock repair batch passes 85/85, the affected server batch passes 60/60, onboarding passes 5/5, and the exact OpenCode timeout suites pass 7/7 in isolation.
- Generated tool manifest, generated tool docs, native skills seeder, forbidden-token, and diff-hygiene checks pass. The final changed-file scan found no unresolved production TODO/FIXME or unguarded process/tenant boundary introduced by this fix set.
- Baseline remote head `b63e58eb` is open and mergeable. Its latest workflow was stopped at the initial `changes`/`policy` jobs by the external GitHub Actions account/billing condition, so dependent required jobs were skipped; the advisory LLM evaluation also failed independently. Earlier reviewed heads passed the Linux required matrix, but this uncommitted final candidate has no remote CI evidence until it is pushed.

## External Gates and Deferred Work

- Fresh Linux CI is required after the fixes are pushed, including the Linux-only real-PostgreSQL claim-race test.
- Real two-account Google OAuth `cloud_auth` QA remains a manual release gate.
- Real gVisor pool transport and worker-image checkpoints A-D remain a fresh post-merge branch, alongside provider create/assignment + org-aware runtime threading, URL namespace, sentinel removal, governed break-glass, and the other handoff initiatives.

## GSTACK REVIEW REPORT

| Phase | Verdict | Material outcome |
|---|---|---|
| CEO / scope | PASS — hold scope | #316 is stabilized at its claimed control-plane boundary; real gVisor remains separate. |
| Design / UX | PASS | Broken provider-settings navigation and stale reload guidance corrected. |
| Engineering | PASS locally | Atomic org claims, cross-agent promotion, guarded provider/membership state, registry-only cloud targets, complete workspace command sinks, and PID-safe cutover. |
| DX / operations | PASS locally | Full typecheck/tests/build/forbidden/no-drift/diff gates pass; API references and upgrade behavior are documented. |
| Independent red-team | PASS locally after remediation | Final security, API, architecture, and lifecycle passes report no remaining P1/P2 after closing the runsc-provenance, workspace-command, reserved-metadata, startup-ordering, readiness-cleanup, health-stop/PID/process-group-cutover, UUID, and duplicate-error findings. |

**Recommendation:** fix set is ready to commit and push to #316, then require fresh Linux CI before merge. Do not add gVisor worker-plane scope to this branch.

**Unresolved external gates:** fresh Linux CI on the new commit and the live two-account Google OAuth `cloud_auth` QA journey.
