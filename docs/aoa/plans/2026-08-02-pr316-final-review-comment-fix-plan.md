# PR #316 final review-comment fix plan

**Branch:** `claude/multitenant-cloud`
**Reviewed remote HEAD:** `21d5d7ab821d7aa43116a371def6d18b2d7ac6eb`
**Base:** `main`
**Purpose:** close the current production-safety findings before landing PR #316. Real gVisor execution remains a separate follow-up PR.

## Review-thread triage

The initial thread-aware GitHub audit found 58 unresolved Codex threads. Subsequent exact-head Codex passes brought the reviewed set to 66 threads:

- 53 are resolved after verification, including findings that became outdated when their fixes landed.
- 11 remain intentionally open for documented, unshipped follow-up capabilities; the latest is the already-specified third `org_default` caller.
- The two exact-head findings at `21d5d7ab` are fixed locally and will be replied to and resolved only after this patch is pushed.

Independent code review also found that the earlier provider dead-key repair catches every materialization error, including database and vault failures. A related deferred WebSocket cleanup is small and security-relevant enough to close while the same revalidation loop is being changed.

The Codex pass at `a4ca6577` added two further P1 findings. Three independent audits confirmed both as reachable violations of the declared cloud fail-closed boundary, so they remain in this PR rather than moving to the gVisor follow-up.

The exact-head Codex pass at `21d5d7ab` added two final findings: global agent maintenance endpoints were reachable by ordinary cloud board users, and the 0188 migration snapshot gate converted every database error into an empty-database result. Independent security and scope reviews confirmed both as production blockers. The local patch below closes them before any merge decision.

## In-scope fixes

### 1. Authenticate the cloud test-session mint

- Require a dedicated, per-run `AOA_E2E_TEST_SUPPORT_TOKEN` whenever `AOA_E2E_TEST_SUPPORT=1`.
- Refuse startup when the token is missing or shorter than 32 bytes.
- Require `Authorization: Bearer <token>` before parsing the mint request or touching the database.
- Compare fixed-length SHA-256 digests with `timingSafeEqual`.
- Preserve the existing board-authenticated `local_trusted` developer path without a token.
- Pass the token from the Playwright identity helper and extend the deploy-leak policy test.

Regression coverage: missing/wrong token denies with zero writes; correct token mints; weak/missing boot token fails; legacy local path is unchanged.

### 2. Enforce execution-target tenant ownership at persistence time

- During environment create/update, load and lock the company and selected execution target inside the route's existing transaction.
- Permit only system targets (`organization_id IS NULL`) or targets owned by the company's organization.
- Reject missing and cross-organization targets with the same non-enumerating 422 response.
- Keep `null` as the explicit pin-clear operation and leave omitted updates unchanged.

Regression coverage: cross-org create/update fail without persisting; same-org and system targets pass; null clears; omitted update preserves.

### 3. Claim organization capacity in true global FIFO order

- Replace agent-by-agent batch claiming with one organization-scoped transaction under the existing advisory lock.
- Read queued runs across every organization company ordered by `(created_at, id)`.
- Apply the organization cap and each queued agent's normalized runtime cap while walking that single ordered queue.
- Skip capped agents without head-of-line blocking and retain the `status='queued'` compare-and-set update.
- Return and launch claims in global selection order.

Regression coverage: `A:t1, B:t2, A:t3` with two slots claims `t1,t2`; capped oldest agent is skipped; concurrent claimers neither oversubscribe nor reorder.

### 4. Fail closed during LiveEvents WebSocket revalidation

- Extract a directly testable revalidation helper used by the 30-second sweep.
- In `cloud_auth`, re-run the board organization-and-company membership predicate.
- Close unauthorized sockets with policy code 1008.
- Close sockets on database/revalidation errors with code 1011 instead of logging and continuing.
- Preserve the no-op for non-cloud board sockets.

Regression coverage: active board remains; revoked board closes; DB error closes; non-cloud board does not query cloud membership.

### 5. Revalidate the exact agent key and agent status

- Carry the authenticated `agent_api_keys.id` in the socket upgrade context.
- On every authorization sweep, require that exact key to remain unrevoked and bound to the same agent/company.
- Require the agent to remain in the same company and outside `terminated`/`pending_approval`.
- Do not let another active key keep a socket opened with a revoked key alive.

Regression coverage: exact active key passes; revoked/missing/mismatched key closes; alternate key does not rescue; terminated/pending agent closes; query error closes.

### 6. Distinguish candidate-local provider failures from infrastructure failures

- Continue past personal-subscription materialization only for `ProviderCredentialBindingError`; rethrow database/filesystem/system failures.
- Introduce a typed secret-candidate-unavailable error for missing/deleted/inactive/unbound/missing-version/disabled-config cases.
- Continue to lower candidates or legacy credentials only for that typed error.
- Preserve AWS `ResourceNotFoundException` as candidate-local while propagating throttling, authentication, network, KMS, database, and audit failures.

Regression coverage: typed candidate failure falls through; generic secret/subscription failures propagate and do not invoke lower candidates or legacy; AWS not-found is typed while other AWS failures remain systemic.

### 7. Refuse every workspace-local Git subprocess in cloud mode

- Apply the existing local-command guard before resolving a workspace or project Git root so status, log, close-readiness/TTL inspection, filesystem repository probes, output detection, graph, enrichment, commit, and push cannot invoke repository-configured helpers, filters, hooks, credential helpers, or transports on the shared API host.
- Guard workspace-runtime's shared Git process chokepoint as defense in depth so eager creation, reattachment, recorded worktree operations, cleanup, and background sweeps cannot bypass route-level checks.
- Keep the database-only mutation-safety endpoint available.
- Apply the same boundary to GitHub PR branch detection and auto-push while preserving API-only PR creation when the head branch is already known.
- Preserve self-hosted behavior and the explicit process-wide unsafe override.

Regression coverage: cloud refusal reaches no Git mock for workspace status/log/commit/push, project graph/enrichment, filesystem probes, output detection, close-readiness, or workspace-runtime spawning; GitHub PR creation skips local Git but still calls the remote API; existing self-hosted flows remain green.

### 8. Revalidate preview WebSocket authorization after upgrade

- Share the exact cloud organization-and-company membership and agent-key predicates with the LiveEvents socket path.
- Retain board/agent upgrade context and sweep open preview tunnels every 30 seconds without overlapping checks.
- Destroy the raw proxied socket on revocation, agent ineligibility, or any revalidation query error.
- Do not register already-destroyed sockets; clear and unref per-socket timers on close, end, and error; leave non-cloud board behavior unchanged.

Regression coverage: active cloud board remains; org/company revocation closes; database errors close; non-cloud board does not query; exact agent key and status are revalidated; timers stop after socket closure.

### 9. Keep prefix-backed company routes globally unambiguous

- Restore global `companies.issue_prefix` uniqueness while the board route contract remains `/:companyPrefix/*`.
- Keep the company allocator's 23505 retry keyed to the global index so same-name companies in different Organizations receive distinct route prefixes without leaking tenant details.
- Retain company-qualified `/companies/:companyId/...` routes as the permanent follow-up; that namespace can safely relax prefix uniqueness back to per-Organization.

Regression coverage: the full migration chain rejects the same company prefix both within and across Organizations, and the allocator retries the global constraint with the next deterministic prefix.

### 10. Restrict global agent maintenance to the operator plane

- Replace board-only authorization on both global backfill routes with the shared instance-settings operator decision.
- Permit only an authenticated operator or the synthetic `local_implicit` board in self-hosted mode.
- Reject ordinary cloud board users and data-plane `isInstanceAdmin` users before any global database read or service mutation.
- Preserve the existing multi-company iteration and aggregate result for authorized operators.

Regression coverage: ordinary cloud board and non-operator instance-admin actors receive 403 with zero reads/writes; operator and local-implicit callers can run the parent backfill; the human-at-top route enumerates companies and sums repairs.

### 11. Make the 0188 snapshot gate fail closed on database errors

- Extract the company-count read into a directly testable helper.
- Treat only PostgreSQL SQLSTATE `42P01` (`undefined_table`) as a genuinely fresh schema with zero companies.
- Walk wrapped `.cause` chains with cycle protection because Drizzle/adapters can wrap the PostgreSQL error.
- Propagate permission, connection, cancellation, and unclassified database failures instead of bypassing the snapshot requirement.
- Reject malformed, null, blank, boolean, negative, non-integer, and unsafe count results rather than coercing them to zero.

Regression coverage: direct/wrapped/nested `42P01` returns zero; `42501`, `08006`, and `57014` rethrow unchanged; cyclic causes terminate; direct and driver-wrapped counts pass; malformed result shapes fail closed.

## Live platform QA

An isolated Windows instance was launched from the patched source with its own `AOA_HOME`, embedded PostgreSQL port, application port, and workspace root. The default developer instance and data were not touched.

- Completed founder onboarding through profile, Organization, company, workspace root, and provider selection.
- Reached the lobby and company Home after first-run completion.
- Loaded company-qualified Providers and Environments settings; provider checks returned HTTP 200.
- Verified bare task URLs redirect through the selected company prefix and an unknown prefix renders the access-required surface.
- Verified both patched global backfills still work for `local_implicit` self-hosted mode.
- Verified organization-name validation rejects U+2028, U+2029, U+2061, and joiner-only input using explicit UTF-8 request bytes.
- Captured screenshots and logs under the gitignored `.gstack/qa-reports/` directory, then stopped only the isolated listener.

The QA pass also reproduced three pre-existing, non-blocking issues outside this PR: a Windows CRLF-only CSP hash mismatch from #157 (Linux production builds are unaffected), malformed non-UUID task URLs that can produce some 500 responses, and a missing-task slide-over that fans out 404 requests before settling. These should be filed as focused follow-ups rather than expanding this already-large multi-tenant PR.

## Small contract and documentation cleanup

- Remove the unused public `slug`/`plan` inputs from the shared self-serve organization-create validator so it matches the server's safe `{name}` contract.
- Trim, NFC-normalize, and bound self-serve organization names; reject Unicode control/format characters, hard line separators, and joiner-only names while preserving ZWNJ/ZWJ within visible names before slug derivation.
- Correct the provider resolver's stale auth-method count and make execution-target credential hints fail closed for any future unhandled method.
- Lock provider-connection revoke behavior: filesystem cleanup failures surface only after the transactional logical revoke and assignment disablement.
- Correct the PR description's stale instruction to enable unsandboxed multi-tenant execution. Hosted execution remains fail-closed until the gVisor worker plane ships.
- Reply to and resolve only the review threads proven fixed by this patch; leave intentional follow-up threads open with their existing scope notes.

## Explicitly deferred to later PRs

- Real gVisor worker execution and Gate-B hardware validation.
- Agent-to-organization runtime threading.
- Provider connection create/assignment API and UI, including connection concurrency leases.
- Worker freshness/sweeping.
- Multi-organization picker and URL namespace work.
- Dropping the company sentinel default, governed break-glass endpoints, and other handoff initiatives.

## Verification gate

1. Focused unit and integration tests for all nine fixes.
2. `pnpm -r typecheck`.
3. `pnpm test:run` on a clean full rerun.
4. `pnpm build`.
5. `pnpm db:generate` with no drift.
6. `git diff --check` and forbidden-token/deploy-leak checks.
7. Independent whole-patch review against `origin/main`.
8. Commit and push to PR #316, trigger fresh Codex review, and require complete Linux CI before merge.

Local verification completed on the exact local patch: focused plugin, lifecycle, shutdown, webhook, UI, cloud, tenant, and security suites passed; `pnpm -r typecheck`, server lint, the forbidden-token scan, `pnpm build`, and `pnpm db:generate` passed. The authoritative full workspace suite passed with `--maxWorkers=25%`; two unrelated Windows OpenCode adapter timeout flakes from higher-contention runs were reproduced as passing in isolation before the clean bounded run. Schema generation and the build-time marketplace snapshot fetch produced no drift; `git diff --check` is clean apart from Windows line-ending notices. Independent security and correctness delta reviews found no remaining P0/P1/P2 issue in the patch. Fresh Linux CI and an exact-head Codex review remain mandatory after push.

## Exact-head plugin isolation review at `50801657`

Codex's whole-PR review found a further merge-blocking P1: the legacy global plugin list and config endpoints accepted any board actor and queried company-owned plugin rows without a company predicate. Two independent audits confirmed the reported enumeration/config chain and found the same missing boundary on sibling plugin reads and bridge calls.

### Architecture decision

Reuse the existing company ownership model and authorization primitives; do not create a parallel plugin tenancy layer.

```text
request
  |
  +-- collection/runtime UI -- explicit companyId --> assertCompanyAccess
  |                                                --> company-filtered query
  |
  +-- bare plugin reference --> accessibleCompanyIdsForActor
  |                           --> scoped UUID/key resolve
  |                           --> 404 when inaccessible / 409 when ambiguous
  |
  +-- instance diagnostic --> assertCanManageInstanceSettings
                              --> existing global diagnostic path
```

Production failure covered: a cloud board member guesses or enumerates a foreign plugin ID, then reads config/logs/job history, loads foreign UI, or invokes its bridge worker. Every path must reject before tenant data or worker execution is reached.

### Implementation tasks

- [x] Add company-aware plugin registry collection methods with the same `undefined = all`, `[] = none`, `[ids] = scoped` semantics already used by bare task resolution.
- [x] Add a reject-ambiguous actor-scoped plugin resolver for board-readable per-plugin routes.
- [x] Scope `GET /api/plugins` to the actor's accessible companies.
- [x] Require an explicit company for UI contributions, scope ready plugins to it, and key frontend caches by company.
- [x] Require bridge/data/action/SSE calls to resolve a plugin owned by the requested company before worker access.
- [x] Verify tool execution's registered plugin belongs to `runContext.companyId`; operator-gate global tool discovery.
- [x] Apply the scoped resolver or operator gate to detail, health, logs, config, jobs, dashboard, and version-history reads.
- [x] Add the missing company predicate to both plugin-company-settings list and mutation plugin lookup.
- [x] Remove `plugins.ts` from the `assertBoard` pairing allowlist once every handler is paired or explicitly justified.
- [x] Add two-company regression tests and frontend company-cache tests.

### Test coverage diagram

```text
CODE PATHS                                      USER FLOWS
GET /plugins                                    Marketplace installed badges
  +-- local/self-host all access                  +-- member sees only accessible installs
  +-- member scoped list                          +-- tenant switch cannot reuse prior cache
  +-- zero companies -> []

GET /ui-contributions?companyId=...             Company plugin UI
  +-- missing company -> 400                      +-- own company loads slots/launchers
  +-- inaccessible company -> 403                 +-- foreign company is rejected
  +-- own company -> ready rows only               +-- disabled/foreign plugins do not load

GET /:pluginId/config and sibling reads          Instance diagnostics
  +-- own UUID/key -> scoped result                +-- operator/local self-host still works
  +-- foreign UUID/key -> 404, no data read        +-- ordinary tenant cannot inspect foreign IDs
  +-- duplicate accessible key -> 409

bridge/tool execution                            Runtime invocation
  +-- plugin company == request company -> call    +-- own plugin action succeeds
  +-- mismatch/missing scope -> reject first       +-- foreign worker is never invoked
```

### Verification gate for this finding family

1. Focused route/service/UI tests covering both companies, empty membership, duplicate keys, operator, and `local_implicit`.
2. The existing high-risk cloud/tenant/security matrix.
3. Typecheck, lint, forbidden-token scan, build, database drift, and `git diff --check`.
4. Clean full test suite with bounded Windows worker concurrency.
5. Independent final diff review, push, thread reply/resolution, another exact-head whole-PR Codex review, and fresh Linux CI.

## NOT in scope

- Real gVisor execution and the other initiatives in the follow-up handoff remain a separate PR.
- A plugin subsystem rewrite is unnecessary; the existing company ownership, company routes, and auth helpers are reused.
- Marketplace product redesign is not needed; only tenant-correct installed-state/cache behavior may change.
- Public webhook authentication remains the plugin contract and is not altered by this board-route isolation fix.

## What already exists

- `assertCompanyAccess` is the fail-closed company boundary and preserves `local_implicit` behavior.
- `accessibleCompanyIdsForActor` already defines safe bare-route scoping semantics.
- `/api/companies/:companyId/plugins` and its config route already provide member-readable company-scoped data.
- `SlotFilters` and launcher filters already carry `companyId`; the current UI simply fails to use it in the contribution query/cache key.
- `plugin.companyId` and `(company_id, plugin_key)` uniqueness already model ownership; no migration is needed.

## Final implementation and verification outcome

The exact-head plugin isolation finding is closed locally, including the sibling runtime surfaces found during implementation review:

- Global diagnostics and raw package installation are operator-only; company plugin reads/config/settings use explicit company authorization and ownership predicates.
- Bridge data/actions/SSE, agent tools, events, streams, static UI assets, worker host calls, and loader artifacts are bound to the plugin row's database ID and owning company.
- Company enable/disable overlays are enforced before lifecycle activation and at runtime; global lifecycle transitions keep the company overlay synchronized.
- Managed npm artifacts use per-company roots and persisted authoritative paths; legacy shared artifacts fail closed when two tenants would collide.
- UI contributions, slots, launchers, Marketplace installed state, settings reads, and React Query caches are company-scoped.
- Public webhook URLs now require the tenant-specific `plugins.id` UUID; manifest-key URLs are rejected as ambiguous. The SDK host context exposes `pluginInstallationId`, the kitchen-sink example uses it, and API/SDK/schema compatibility guidance records the migration.
- Plugin HostServices disposers are retained and invoked on replacement, activation failure, worker crash/stop, unload, uninstall/disable, and shutdown so stale live-event subscriptions cannot survive a runtime generation.
- The common server shutdown path now tears down plugin workers and HostServices in both external-Postgres and process-owned embedded-Postgres modes, deduplicates concurrent termination signals, and exits only after cleanup.
- Public plugin webhooks are limited to 300 requests per minute per source IP before UUID lookup, database writes, or worker RPC. Plugin-specific signature verification remains in the worker and failed-delivery audit records remain intact.

Final local evidence on the complete uncommitted patch:

- Focused final plugin suites: 57/57 passed; final webhook suite: 35/35 passed; independent whole-plugin matrix: 23 files / 194 tests passed.
- `pnpm -r typecheck` passed across all 23 workspace projects, including the SDK and kitchen-sink example.
- Higher-contention `pnpm test:run` attempts hit only two known Windows OpenCode adapter timeout flakes; both passed immediately in isolation (5/5). The authoritative exact-tree bounded rerun, `pnpm test:run --maxWorkers=25%`, passed with exit 0.
- `pnpm build`, server lint, `pnpm check:tokens`, and `pnpm db:generate` passed; Drizzle reported no schema drift.
- `git diff --check` is clean apart from Windows LF/CRLF notices.
- An isolated instance booted with its own AoA home, app port, and embedded-Postgres port. Health, UI serving, company creation, company plugin list, company-qualified contributions/tools, missing-company rejection, and UUID-only webhook rejection behaved as designed. A real Playwright browser render of `/{companyPrefix}/settings?tab=plugins` loaded the empty Plugins state and all background API calls returned 200. Both isolated listeners were stopped afterward.
- Independent full-PR correctness, security-delta, and final post-fix reviews found no remaining P0/P1/P2 blocker. Fresh Linux CI and a whole-PR Codex review on the pushed head remain required before merge.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not required | Security bug fix; no product-direction change |
| Codex Review | `/codex review` | Independent second opinion | 1 | fixed locally | P1 global plugin disclosure plus sibling runtime surfaces |
| Eng Review | `/plan-eng-review` | Architecture & tests | 2 | implemented and verified | Tenant scoping, lifecycle cleanup, webhook contract/abuse controls; 0 unresolved design decisions |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not required | Cache-key/API wiring only |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not required | No new developer workflow |

**CODEX:** Confirmed global plugin reads crossed company boundaries; the exact reported chain and sibling paths are fixed locally.
**CROSS-MODEL:** Independent correctness, security, and plugin-runtime audits agree on the tenant boundary and added the webhook compatibility, lifecycle cleanup, and abuse-limit fixes captured above.
**VERDICT:** Local implementation and verification are complete. Commit/push, exact-head Codex review, and fresh required Linux CI remain mandatory; gVisor stays in the next PR.

NO UNRESOLVED DECISIONS
