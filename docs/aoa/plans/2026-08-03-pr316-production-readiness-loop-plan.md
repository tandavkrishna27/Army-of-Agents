# PR #316 Production-Readiness Loop

**Branch:** `claude/multitenant-cloud`
**Starting head:** `b3deedfa63cdf7deacb9a3e9d8bd619d6e69f649`
**Base:** `origin/main`
**Scope posture:** Hold scope. Close the confirmed multi-tenant production gaps on PR #316; keep real gVisor execution and plugin-worker OS isolation in follow-up work.

## Outcome

PR #316 may merge only when every confirmed production security/correctness P1/P2 finding is fixed with regression coverage, the full local verification contract passes, fresh Linux CI is green, and a new Codex plus independent whole-PR review finds no unresolved P0/P1/P2 issue. Lower-severity follow-ups may remain only when their policy and risk are explicit.

Merge-ready and production-release-ready are separate gates. A green PR may merge after the code/CI/review gates above, but production deployment remains blocked until the live two-account Google OAuth `cloud_auth` journey is exercised on QA/staging. The staging journey must prove signup, organization/company isolation, revocation, operator-plane behavior, and the fail-closed plugin policy with production-like auth and infrastructure.

## Premises

1. `cloud_auth` is a shared multi-tenant control plane. Tenant-triggered code must not execute on the control-plane host without an explicit fail-closed trust boundary.
2. Operator-plane authority must not become ambient tenant-data access.
3. Existing cloud WebSocket transports retain their bounded membership-revalidation behavior. Plugin streams are unavailable while cloud plugin execution is blocked, so plugin-stream revalidation must land with the isolated runtime that makes those streams reachable. Better Auth session logout/revocation takes effect on reconnect; immediate closure of already-open board sockets is not a V1 policy requirement and is explicitly accepted as a lower-severity residual.
4. Self-hosted `local_trusted` and `authenticated` behavior must remain compatible.
5. Real gVisor execution remains a separate PR. This PR may add fail-closed gates for unsafe cloud paths but must not implement the worker pool.

## What Already Exists

| Problem | Existing pattern to reuse |
|---|---|
| Static cloud gate | `tenantIsolationEnforced()` |
| Operator-plane capability | `canManageInstanceSettings(req)` plus a new explicit profile capability consumed by UI/API callers; legacy `isInstanceAdmin` remains a compatibility alias only |
| Deployment mode in UI | `healthApi.get()` and `queryKeys.health` |
| Plugin worker sink | `plugin-worker-manager.startWorker()` is the mandatory final enforcement boundary; loader/lifecycle/marketplace checks may improve errors but cannot replace the sink gate |

## Root Causes

### RC1 — Plugin SSE authorizes only at handshake

`GET /api/plugins/:pluginId/bridge/stream/:channel` authorizes once in self-hosted modes. In `cloud_auth`, RC2's mandatory static runtime gate returns the canonical 503 before subscription, so no cloud plugin stream exists to retain stale authorization. A first implementation added a cloud-only revalidation lease, but post-implementation review proved that branch unreachable because the same deployment predicate both blocked the route and enabled the lease. The dead code and impossible-state test were removed. Live plugin-stream authorization is deferred to the isolated plugin runtime PR, where it can be exercised in a real deployment state alongside the shared REST/WebSocket break-glass decision.

### RC2 — Plugin workers crossed from single-tenant into cloud without a runtime boundary

Marketplace founders can activate default-`untrusted` plugins. The worker is a host `fork()` process. The Node permission model grants read access to the global plugins root and provides no network-egress boundary. Decision #103 documents that raw network bypasses capabilities. PR #316 made plugin state tenant-scoped but did not make plugin execution tenant-isolated.

### RC3 — CLI approval mixed authority concepts and authentication sources

The cloud request actor correctly clamps data-plane `isInstanceAdmin=false`, while `/auth/profile` maps operator capability back onto a UI field named `isInstanceAdmin=true`. Legacy UI surfaces and CLI challenge presentation therefore choose the wrong authority model:

- Heartbeats and Access are shown to cloud operators but intentionally denied by data-plane routes.
- CLI GET uses the clamped flag while CLI POST checks the raw role and succeeds.
- CLI GET treats only an interactive session as signed in, while CLI POST previously accepted any board actor. That let an existing `board_key` mint another board key and advertised `local_implicit` approval that the service's database-role check could still reject.

### RC4 — A literal NUL makes a security-critical file binary

`live-events-ws.ts` contains a NUL in a comment and CRLF line endings, so GitHub cannot render the auth diff normally and `git diff --check` reports whitespace noise.

## Alternatives Considered

### A. Symptom-only patch

Hide Heartbeats/Access and fix the CLI boolean. Smallest diff, but leaves unsafe cloud plugin workers. Rejected: incomplete and not production-safe.

### B. Bounded root-cause patch — selected

Add a central cloud plugin-worker fail-closed policy, deployment-aware settings navigation/direct-route guards, CLI authority parity, and text normalization. The plugin stream route is one of the independently blocked runtime surfaces. Reuses existing patterns and preserves the separate gVisor follow-up.

### C. Full isolation architecture now

Move plugin workers into per-tenant containers/network namespaces and unify every long-lived transport under a new authorization lease framework. Best long-term shape, but new infrastructure and too large for this pre-landing fix. Deferred.

## Implementation Batches

### Batch 1 — Resolve the plugin-stream finding at the reachable boundary

1. Return the canonical cloud policy 503 before plugin lookup, subscription, or worker interaction.
2. Keep self-hosted stream behavior unchanged.
3. Do not ship a cloud revalidation branch that cannot execute while the static policy is active.
4. Carry live plugin-stream membership/break-glass revalidation into the isolated plugin-runtime follow-up, together with a reachable deployment state and end-to-end staging coverage.

Regression matrix:

- cloud stream request -> canonical 503 before database/subscription/runtime work
- stale cloud `ready` row -> same canonical 503
- self-hosted stream behavior remains unchanged

### Batch 2 — Fail closed on cloud plugin-worker activation

1. Define one central activation policy: in `cloud_auth`, **all** host-process plugin workers are blocked until an OS-isolated runtime exists. There is currently no immutable first-party provenance field/allowlist, so mutable `trustTier="core"` is not an exception. A future exception requires immutable bundled provenance and a separate reviewed change.
2. Enforce a typed `PLUGIN_WORKER_BLOCKED_IN_CLOUD` rejection at the final `startWorker()` process sink before handle/map registration and again immediately before `fork()`, so boot, direct load/enable/upgrade, marketplace installs, and dependencies cannot bypass it. The sink backstop remains mandatory even with earlier checks.
3. Do not rely on UI hiding; APIs and boot must fail closed.
4. Preserve only persisted, non-executable metadata from pre-existing rows. Plugin manifests are JavaScript modules in the current package contract, so cloud install/reinstall/upgrade must reject before npm/local package I/O and before every dynamic manifest import. Independently fail closed on executable plugin UI contributions, `/_plugins/*/ui/*`, RPC bridge, and stream/runtime surfaces in `cloud_auth`; a pre-existing `ready` row must not serve same-origin plugin JavaScript during boot reconciliation.
5. Persist a blocked activation as `error` with structured reason code `PLUGIN_WORKER_BLOCKED_IN_CLOUD` plus an actionable `lastError`; never leave it `ready` or imply that it is running. Marketplace/settings UI must render that truthful state and explanation.
6. Update Decision #103/deployment documentation to state the cloud policy and that agent gVisor does not cover plugin workers.

Truthful persisted/UI state:

- Add a nullable structured plugin status-reason field and shared enum value `PLUGIN_WORKER_BLOCKED_IN_CLOUD`; do not infer policy from free-form `lastError`.
- A cloud-blocked activation persists `status="error"`, `statusReasonCode="PLUGIN_WORKER_BLOCKED_IN_CLOUD"`, plus a human diagnostic in `lastError`.
- Plugin Manager, plugin detail/health, install/enable, and marketplace result flows map that code to **Blocked on AoA Cloud**. The status uses accessible text plus an icon (not color alone), explains that there is no operator override, links to the isolation/deployment documentation, and identifies self-hosting as the current recovery path.
- Do not render Enable/Retry controls that can only repeat the policy denial. Installation must not toast unconditional success when activation is blocked.
- Other plugin errors keep their existing recovery controls and copy.

Lifecycle and migration contract:

- Add an early loader/lifecycle policy path that atomically writes `status="error"`, `statusReasonCode`, and `lastError` before publishing any `ready` event. Explicitly allow `installed`, `disabled`, `error`, and `upgrade_pending` to enter the blocked error state; the final sink remains the non-bypassable backstop.
- Generate the next Drizzle migration from current migration `0197`. Propagate the nullable reason-code union through the database schema, shared `PluginRecord`/validators, status/install DTOs, route responses, and UI API types.
- One status-transition write owns all three fields. Successful states clear `statusReasonCode` and stale errors; `disabled` preserves its operator-provided diagnostic while keeping `statusReasonCode=null`; generic errors set `statusReasonCode=null`; the cloud policy sets `PLUGIN_WORKER_BLOCKED_IN_CLOUD`.
- If policy-state persistence fails, activation still fails closed and no `ready` event or executable surface is exposed. A pre-existing cloud `ready` row is reconciled to blocked error at boot, while independent runtime/UI gates protect the interval before reconciliation.
- Migration/rollout order is migration -> code -> boot reconciliation -> QA. The nullable migration is backward-compatible, but behavioral rollback is **not** automatically safe: use forward-fix by default. If old code must be restored, first hold traffic and disable plugin activation at the deployment edge, terminate and verify zero plugin worker processes, then start old code; do not let an old cloud binary serve traffic after an operator could re-enable an `error` row.

Regression matrix:

- cloud ready plugin of every trust tier, including a forged/mutable `core`, is not started at boot
- cloud direct/marketplace/dependency install or upgrade is rejected before package I/O or manifest import, and activation is rejected again before `fork()`
- cloud executable plugin UI, bridge, and stream surfaces are denied even for a stale `ready` row
- cloud has no `core` exception until immutable bundled provenance exists
- authenticated/local trusted activation remains unchanged
- rejected activation cannot leave a misleading running/ready state
- blocked badges meet accessible text/contrast requirements; icon-only controls retain accessible names
- migration from an existing database, stale-ready boot reconciliation, status-write failure, rollback posture, and upgrade/install failures are covered

### Batch 3 — Operator/data-plane contract repair

1. Make the shared Settings navigation deployment-aware and omit `heartbeats` and `access` in `cloud_auth`, including mobile pills.
2. Guard direct `/instance/access` and `?tab=heartbeats` routes before their data queries mount and render an explicit unavailable state in cloud.
3. Add an explicit `tenantIsolationEnforced()` denial to the global heartbeat endpoint before database reads.
4. Keep `/admin/users*` fail-closed in cloud.
5. Use `canManageInstanceSettings(req)` for CLI `instance_admin_required` challenge presentation so GET and POST agree.
6. Add an explicit operator-plane capability to the auth profile contract, keep `isInstanceAdmin` only as a documented compatibility alias, migrate instance-settings UI authorization to the explicit capability, and audit every `/instance`/`/admin` surface for the intended operator-plane versus tenant-data-plane decision.
7. Define one interactive CLI approver contract for both GET and POST: only `session` and `local_implicit` board actors qualify. Reject `board_key` before the approval service so an issued key cannot mint another key, and pass the already-resolved operator capability into the transaction for the final `instance_admin_required` check.

Deterministic UX decisions:

- The capability is named `canManageInstanceSettings: boolean`. `isInstanceAdmin` remains a compatibility alias only; no new UI code may read it, and migrated instance-settings chrome must use the explicit capability.
- While deployment mode is loading, and if its request fails, render only the safe Settings navigation subset (desktop and mobile). Never flash Heartbeats or Access. Keep layout stable and show a retryable, announced deployment-status notice on a direct restricted deep link.
- In `cloud_auth`, `/instance/access` and `?tab=heartbeats` render an explicit unavailable state before any tenant-data query mounts. The state has a route-transition-focused heading, a concise cloud-isolation reason, and a primary **Back to General** action. It does not silently redirect.

Regression matrix:

- cloud navigation contains neither Heartbeats nor Access
- cloud direct links fire no heartbeat/admin-user requests
- cloud global heartbeat route is 403 with zero data reads
- cloud `/admin/users*` remains 403
- self-hosted navigation and mutations remain intact
- cloud operator CLI GET reports `canApprove=true` and POST succeeds
- ordinary cloud tenant member remains unable to approve operator CLI access
- an existing board API key is treated as signed out for the approval page and receives 401 on approval without invoking the service
- local implicit mode can view and approve instance-settings CLI access under the same route/service contract
- capability loading/failure never flashes tenant-data navigation or fires restricted queries
- unavailable heading receives programmatic focus once on route entry, with no subsequent or unexpected focus movement; self-hosted navigation and focus behavior remain unchanged

### Batch 4 — Reviewability and residual tracking

1. Replace the NUL comment with ordinary text matching the actual key separator.
2. Normalize `live-events-ws.ts` to LF.
3. Verify Git reports numeric diff stats and `git diff --check` is clean.
4. Record the decided V1 policy: existing cloud WebSocket membership sweeps remain intact; plugin streams are statically unavailable until isolated execution lands; governed break-glass plus one shared REST/WebSocket decision remains a documented follow-up. Better Auth logout/session revocation is enforced on reconnect, not by polling already-open board sockets.

### Batch 5 — Exact-head Codex findings after live QA

1. Move the irreversible-0188 snapshot gate to the shared migration boundary so server boot, `pnpm db:migrate`, and direct `applyPendingMigrations()` callers cannot diverge. Enforce it after the advisory-lock reinspection and before either migration apply path; an unspecified deployment mode fails closed only for the risky populated/0188/no-marker state.
2. Resolve `companies.organization_id` before heartbeat execution-target routing. Keep deferred `org_default` provider lookup inert, but make the already-live same-org environment pin path functional and retain foreign/inactive/personal-subscription fail-closed behavior.
3. Add org-admin execution-target credential lifecycle: rotate returns a new token once and invalidates the old token atomically; revoke clears the hash and disables the target. Both operations use an organization-and-target predicate, structured secret-free audit logs, and reject cross-org IDs.
4. Insert `company.created` through the same prefix-attempt transaction as company/founder access. Publish the activity event only after commit and treat publication failure as non-fatal.
5. Close commit-before-response-loss duplication for both Organization and Company onboarding creates with persisted client request IDs, database uniqueness, sequential/concurrent replay, payload-mismatch rejection, and attempt-vs-confirmed client recovery state. Organization audit is emitted only for the first creation.

Batch 5 acceptance tests:

- manual/shared migration entrypoints refuse the populated 0188 no-marker state and preserve empty/self-hosted/non-0188 behavior
- an org-owned explicit environment target pin resolves through heartbeat using the company tenant
- rotated/revoked worker tokens lose authorization immediately; cross-org lifecycle calls cannot address the row
- audit insert failure rolls back company and access; post-commit event failure does not change the 201 result
- same request ID returns the same Organization/Company under sequential and concurrent retries; a different payload returns 409; an unconfirmed browser attempt retries rather than auto-advancing

### Batch 6 — Exact-head Codex findings after Batch 5 verification

1. Read the irreversible-migration snapshot marker only from the canonical
   `instance_settings.singleton_key = 'default'` row. Reject impossible
   multi-row callback results instead of selecting one, and name the canonical
   row in the error and operator runbook.
2. Treat `migrationSnapshots` as private operational metadata: exclude it from
   strict public settings validation, preserve it through General settings
   updates, and keep it out of the public PATCH contract.
3. Keep durably cloud-blocked plugins visible in the legacy company plugin
   settings collection by admitting only `status=error` rows with the canonical
   `PLUGIN_WORKER_BLOCKED_IN_CLOUD` reason. Continue excluding generic errors
   and uninstalled rows, and expose the returned reason in the UI client type.
4. Exclude soft-uninstalled plugins from the primary company Plugins settings
   list at the SQL boundary so they do not reappear after reload.
5. On a cloud-to-self-hosted deployment transition, project the persisted cloud
   reconciliation reason as historical metadata rather than a live policy
   denial. Preserve the ordinary error state, clear only the canonical cloud
   reason/message in reads, and expose Retry/Enable so the documented recovery
   path is usable; successful activation clears the durable fields.
6. Make the snapshot-marker runbook work when the canonical instance-settings
   row has never been lazily created: use an idempotent
   `INSERT ... ON CONFLICT (singleton_key) DO UPDATE`, preserve existing
   markers, and verify the canonical row before applying 0188.

Batch 6 acceptance tests:

- a noncanonical settings row can neither satisfy nor defeat the migration gate
- public settings reads retain their values when the private marker exists, and public updates retain the marker
- the legacy plugin-settings predicate includes ready, disabled, and canonical cloud-blocked states only
- the primary Plugins settings predicate excludes uninstalled rows
- the actual Drizzle predicate SQL/parameters are asserted so mocks cannot create a false green
- cloud mode continues projecting every installed state as blocked, while self-hosted reads clear only the stale canonical cloud diagnostic and preserve unrelated errors
- both operator runbooks upsert an absent canonical settings row and retain the explicit canonical verification query

## Failure Modes and Rescue

| Failure | Required behavior | Rescue/diagnostic |
|---|---|---|
| Cloud plugin stream requested | Return canonical 503 before subscription or tenant/runtime reads | static deployment gate |
| Plugin activation attempted in cloud | Reject before worker spawn | stable error code/message and documentation link |
| Stale cloud `ready` plugin before boot reconciliation | Deny executable UI/bridge/stream independently of status | deployment-mode runtime gate plus reconciliation |
| Cloud direct settings deep link | No forbidden tenant-data request | explicit unavailable state with Back to General recovery |
| CLI capability/source disagreement | One shared interactive-approver and operator-plane decision | GET/POST source matrix plus service contract test |
| Windows full-suite timing flake | Isolated rerun may diagnose, but final handoff still requires a clean full run or Linux CI proof | record exact failing tests and rerun evidence |

## Verification Ladder

1. Focused unit/route/UI tests for each batch.
2. Cross-mode matrices: `local_trusted`, `authenticated`, `cloud_auth`.
3. Security suites: tenant isolation, plugin route/runtime denial, live-events, and preview upgrades.
4. `pnpm -r typecheck`.
5. `pnpm test:run` on a clean full rerun.
6. `pnpm build`.
7. `pnpm db:generate` and assert no schema drift.
8. brand/policy/forbidden-token checks.
9. `git diff --check` and numeric text diff for `live-events-ws.ts`.
10. Push to PR #316 and require fresh Linux CI.
11. Fetch every unresolved review thread, reply with evidence, and resolve only addressed threads.
12. Request `@codex review`, wait for completion, combine new Codex findings with another independent whole-PR security/correctness review, then repeat the fix/verify loop until no P0/P1/P2 remains.
13. After merge readiness, run the live two-account Google OAuth `cloud_auth` QA/staging journey. Production deployment remains blocked until it passes even if the PR has merged.

Observability and rollout acceptance:

- Emit structured log event `plugin.worker.cloud_blocked` for each denied activation with plugin id, company id, activation source, and reason code; never log config or secrets. Maintain process-local diagnostic counters by activation source and reason for tests and immediate diagnostics. Emit `plugin.worker.cloud_boot_reconciled` with process-local count/gauge values for rollout visibility; this PR does not claim a production metrics exporter.
- Rollout checks require a structured-log query showing stale-ready reconciliation, zero cloud worker starts, and expected policy denials. Alert on any cloud plugin worker start or reconciliation failure using the deployment's existing log-based monitoring.
- Verify the migration on an existing database snapshot before code rollout, then verify boot reconciliation and the independent executable-surface gates before enabling QA traffic.

Public error contract and documentation:

- The canonical documentation target is `docs/guides/cloud-plugin-execution.md`, registered in `docs/docs.json`; UI help links and API `docs` fields point to its published route.
- Install, enable, upgrade, executable plugin UI/static, bridge/RPC, and stream endpoints return HTTP `503` when the cloud worker policy blocks the requested executable surface, with JSON `{ "error": "Plugin execution is blocked on AoA Cloud until isolated workers are available", "code": "PLUGIN_WORKER_BLOCKED_IN_CLOUD", "docs": "/docs/guides/cloud-plugin-execution" }`. Non-executable manifest/status reads remain available.
- Shared API types and clients preserve the `code` and `docs` fields. Support tooling keys on `code`, never message text. Marketplace install/enable/upgrade UI maps the response to the same **Blocked on AoA Cloud** state rather than a generic failure or success toast.

Exact local verification (run from `C:\Users\TK\.aoa\wt\mt-cloud` and preserve native exit codes; do not pipe commands through `tail`):

```powershell
pnpm exec vitest run server/src/__tests__/plugin-stream-tenant-scope.test.ts
pnpm exec vitest run server/src/__tests__/plugin-worker-manager.test.ts server/src/__tests__/plugin-availability.test.ts server/src/__tests__/plugin-ui-static-tenant-scope.test.ts server/src/__tests__/plugin-lifecycle-upgrade.test.ts server/src/__tests__/marketplace-install-plugin.test.ts
pnpm exec vitest run server/src/__tests__/routes-auth-profile.test.ts server/src/__tests__/routes-instance-scheduler-heartbeats.test.ts server/src/__tests__/cli-auth-routes.test.ts server/src/__tests__/tenant-isolation-matrix.test.ts
pnpm exec vitest run ui/src/components/settings/__tests__/useSettingsSidebar.test.tsx ui/src/__tests__/InstanceAccessPage.test.tsx ui/src/__tests__/InstanceSettingsPage-403.test.tsx ui/src/components/settings/__tests__/PluginsSection.test.tsx ui/src/components/settings/__tests__/PluginDetailSlideOver.test.tsx
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm check:tokens
pnpm gen:tools:check
pnpm gen:tools:md:check
git diff --check
```

Batch 4 generated and reviewed migration `0198`. Batch 5's creation-replay schema edit must generate and be reviewed as migration `0199`; after it is staged, run `pnpm db:generate` again and require no additional diff to prove schema drift is clean. Brand and policy are authoritative CI-only jobs from `.github/workflows/pr.yml`; fresh Linux `verify`, `migrations`, `brand-check`, `policy`, lint, embedded-Postgres integration, e2e, and pgvector lanes must pass.

Implementation evidence captured 2026-08-03:

- Root-cause review closed cloud plugin/adapter host execution, truthful blocked-state projection, CLI key/audit transactionality, and live WebSocket tenant/thread authorization. The final WebSocket correction routes both agent subscription and per-event fan-out through the canonical live viewer decision with `principalType="agent"`; tests prove a same-company private nonparticipant is denied and an explicit agent participant is allowed.
- Independent auth/tenant, plugin/cloud-boundary, and whole-PR reviewers report no remaining actionable P0-P3 findings after the final fixes.
- Focused blocker matrix: 98/98 passed. Broader server security/runtime matrix: 273 passed, 2 intentionally skipped. Broader UI fail-closed matrix: 136/136 passed. Final thread/RBAC reruns: 63/63 and 42/42 passed.
- `pnpm -r typecheck`, server lint, `pnpm build`, `pnpm check:tokens`, `pnpm gen:tools:check`, `pnpm gen:tools:md:check`, and the external-repo-backed `pnpm gen:skills:check -- C:\Users\TK\.aoa\wt\aoa-skills` passed.
- The first unconstrained full suite encountered only the two documented Windows timing thresholds; both files passed unchanged in isolation. The authoritative constrained full rerun `pnpm test:run -- --maxWorkers=4` exited 0 in 537.2 seconds, and the final post-QA-fix rerun exited 0 in 522.7 seconds.
- A second `pnpm db:generate` reported `No schema changes, nothing to migrate`; the tracked/untracked `packages/db` set was byte-for-byte unchanged before and after generation.
- `git diff --check` exited 0 apart from Windows EOL notices, and `live-events-ws.ts` reports numeric text stats (`777 602`) rather than a binary diff.
- Pre-Batch-5 fresh-instance browser QA applied all 199 migrations through `0198`, completed profile/organization/company/environment setup, and exercised General, Heartbeats, Access, instance Health, and company Plugins. All affected route requests returned 2xx and the final browser console was clean. Batch 5 adds reviewed migration `0199` (two nullable creation-request columns and their composite tenant-scoped unique indexes); fresh Linux migration/integration CI must apply all 200 migrations through `0199`. The local Codex CLI capability probe returned its expected environment-specific 422 after 22.9 seconds and did not block direct platform QA.
- Browser QA also exposed a pre-existing Windows static-bundle CSP defect: the server hashed raw CRLF script bytes while the HTML parser canonicalized line endings to LF. `extractInlineScriptHashes()` now mirrors browser CRLF/bare-CR normalization; a dedicated regression test plus the 24-test CSP/Helmet matrix, server typecheck, and lint pass. The live CSP header now emits the browser-required `sha256-GMMGCcIrt9B7slaoONV5HkFvNZz1rJ6JTd19YFHvy20=` hash and reloads with no CSP error.
- Batch 5 independently reproduced and fixed all five exact-head Codex findings plus the sibling company-create response-loss window: heartbeat target routing now resolves the Company's real Organization; migration 0188's snapshot gate is enforced in the shared migration apply boundary; worker tokens have same-Organization rotate/revoke lifecycle with disabled-state rejection at both rotation and authentication; company/audit/operator creation is one transaction with non-fatal post-commit publication; and Organization/Company creation uses composite-scoped durable request IDs, advisory serialization, payload-conflict 409s, and pre-POST UI persistence.
- Replay recovery was then adversarially tightened: it resolves the original persisted founder (including local generated operators and retries by another admin), reruns only idempotent bootstrap/skill/Commander ensures, inserts a missing founder profile with composite-key `ON CONFLICT DO NOTHING`, preserves later company-profile edits, and never duplicates the durable `company.created` audit/event. Two final independent targeted reviews report no P0-P3 findings.
- Migration `0199_special_justice.sql` contains only the two nullable creation-request columns and their tenant-scoped unique indexes; both indexes use the repository-required `IF NOT EXISTS`. The migration idempotency/snapshot-gate focused matrix passed 36/36, and a second `pnpm db:generate` reported `No schema changes, nothing to migrate`.
- The final authoritative constrained suite `pnpm test:run -- --maxWorkers=4` exited 0 in 541.7 seconds. Final `pnpm -r typecheck`, full server ESLint, `pnpm build`, forbidden-token scan, tools JSON/Markdown checks, external-repo-backed skills check, and `git diff --check` all passed.
- Batch 6 independently confirmed both new exact-head Codex P2 findings and found
  two adjacent root-cause defects: public General settings updates could delete
  the private migration marker, and the primary Plugins settings list could
  return soft-uninstalled rows. The repairs select only the canonical settings
  row, preserve private metadata, keep only structured cloud-blocked errors in
  the legacy installed-settings collection, exclude soft-uninstalled rows from
  the primary list, and synchronize the UI diagnostic type and operator docs.
  The focused Batch 6 matrix passed 84/84; the broader plugin/UI matrix passed
  82/82; all workspace typechecks and full server lint passed. Three independent
  post-fix reviews reported no remaining P0-P3 in the repaired surfaces. The
  final review also found and repaired a non-blocking cloud-to-self-hosted
  recovery edge: stale cloud reconciliation metadata no longer suppresses
  self-hosted Retry/Enable controls. A subsequent consumer audit caught that
  Instance Health omitted the structured reason from its projection input; the
  query and authenticated transition regression now keep Health consistent
  with the plugin APIs. The post-repair plugin matrix passed 92/92 and the
  focused Health/projection matrix passed 52/52, with server typecheck and lint
  green. The authoritative pre-recovery-edge full suite passed in 542.3
  seconds, and the final exact-candidate rerun passed in 575.4 seconds. Final
  workspace typecheck, production build, server lint, forbidden-token scan,
  tools JSON/Markdown freshness, external native-skills freshness, schema drift
  generation (`No schema changes, nothing to migrate`), and `git diff --check`
  passed after the last code change.
- The next exact-head Codex pass found one documentation-path P2: migration 0048
  creates no canonical settings row, while the runbook used `UPDATE`, so a
  populated database that had never opened Instance Settings could not record
  the required marker. Both runbooks now use an idempotent canonical-row upsert,
  and source plus real-PostgreSQL contract tests pin the absent-row-safe SQL,
  idempotence, concurrent serialization, malformed-marker repair, preservation
  of unrelated settings, and canonical verification. The focused Windows matrix
  passed 40/40 with the three embedded-PostgreSQL cases correctly reserved for
  Linux. Three independent reviewers returned clean verdicts: two found no
  P0-P3 in the exact repair and one found no new actionable P0-P2 across the full
  merge-base diff.
- The final exact-candidate rerun passed `pnpm test:run -- --maxWorkers=4` in
  518 seconds, all 23 workspace typecheck scopes, the production build, full
  server lint, forbidden-token scan, generated tools JSON/Markdown freshness,
  external native-skills freshness, and `git diff --check`. `pnpm db:generate`
  reported `No schema changes, nothing to migrate`, and did not change the
  tracked or untracked worktree set. Fresh Linux CI remains required to execute
  the three real-PostgreSQL runbook cases and all authoritative platform lanes.
- The following exact-head Codex pass on `8286424f` found a real onboarding P2:
  journey resolution re-read active Company memberships without using the
  cloud actor's active-Organization intersection, so a suspended Organization
  member could be routed to an inaccessible first-run Company and strand on a
  403/loading state. Journey and resume candidates now intersect the raw rows
  with the canonical `accessibleCompanyIdsForActor` result. `[]` remains a
  fail-closed scoped set, while `undefined` preserves the unscoped self-hosted
  loopback/instance-admin contract. An independent reviewer caught and rejected
  an earlier `actor.companyIds ?? []` version because it collapsed that sentinel;
  the corrected route-level regression proves a local implicit admin keeps both
  real memberships and can resume unfinished onboarding in the non-first one.
- The corrected onboarding/auth matrix passed 63/63 with 11 established
  Linux-only integration cases skipped on Windows. Three post-correction
  independent reviews found no P0-P3; their sibling audit covered onboarding
  progress, first-run, environment setup, invitations, Company selection, CLI,
  and Organization listing. The final exact-candidate full suite passed in
  520.3 seconds, followed by all 23 workspace typecheck scopes, production
  build, full server lint, forbidden-token scan, tools JSON/Markdown freshness,
  external native-skills freshness, `git diff --check`, and `pnpm db:generate`
  with no schema or worktree-set change.
- Remaining merge gates are operational: commit/push this reviewed worktree to PR #316, require fresh Linux CI, fetch/reconcile all review threads, request another whole-PR `@codex review`, and repeat the loop if it returns any actionable finding. gVisor remains a fresh follow-up PR from updated `main`.

Known Windows flake protocol:

- The known OpenCode subprocess execute-MCP-gate and route-contract import-time thresholds may time out under local load. Rerun the exact failed file/test in isolation to diagnose, but merge still requires either one clean unpiped `pnpm test:run` or authoritative fresh Linux CI.
- Classify a failure as timing-only only when the isolated test passes unchanged and its failure is a timeout/import threshold. A changed mock call, argument, status, authorization decision, snapshot, or other contract assertion is a real regression and must be fixed.

Production staging runbook (release owner: on-call/release engineer; environment: QA/staging configured with production-like Google OAuth and `cloud_auth`):

1. Create/sign in two Google accounts, A and B. Give each a distinct organization and company; capture their IDs and test start time.
2. Prove A cannot list/read/mutate B's company entities and B cannot access A's, through both UI and direct API calls. Capture sanitized request/status evidence.
3. Request plugin UI, bridge, tool, webhook, and stream runtime surfaces from both accounts; capture the canonical 503 and prove no plugin lookup, subscription, worker process, or cross-tenant data is reached.
4. Verify the operator can reach allowed instance Settings and complete CLI approval, while Heartbeats/Access show the cloud-unavailable state and issue no tenant-data requests.
5. Seed a stale `ready` plugin row, restart, and capture: reconciliation to structured blocked error, no worker process, blocked UI bundle/contribution, bridge, and stream responses, and the expected boot structured-log/process-diagnostic count.
6. Confirm logout/session policy: the existing board socket may remain until disconnect, but reconnect with the revoked session fails; record this as the accepted V1 behavior.
7. Attach screenshots, sanitized HTTP traces, relevant structured-log queries, migration version, commit SHA, and timestamps to the release record. Release owner signs pass/fail. On any failure, hold production traffic/deployment and forward-fix; if rollback is unavoidable, use the worker-termination/deployment-edge procedure above.

## Not In Scope

- Real gVisor worker pool or Gate-B hardware execution.
- Plugin-worker OS isolation implementation; only the cloud fail-closed policy lands here.
- Live cloud plugin-stream revalidation and its production metrics; these land with the isolated plugin runtime that makes streams reachable.
- Governed break-glass grant/revoke endpoints.
- URL namespace redesign, sentinel organization default removal, and other already documented deferred initiatives.

## Decision Audit Trail

| # | Decision | Classification | Rationale |
|---|---|---|---|
| 1 | Hold scope on #316 and keep gVisor separate | Mechanical | User direction and bounded pre-landing risk |
| 2 | Choose bounded root-cause patch over symptom-only fixes | Mechanical | Closes the confirmed P1 blast radius without new infrastructure |
| 3 | Fail closed on all cloud plugin host-process workers | Security | Current runtime is not a tenant boundary and no immutable first-party provenance exists |
| 4 | Hide Heartbeats/Access instead of granting operator tenant access | Security | Prevents cross-tenant data exposure |
| 5 | Reuse current live-membership and timer patterns | Engineering | Explicit, tested, minimal abstraction |
| 6 | Block all cloud plugin host workers; no mutable trust-tier exception | Security | No immutable bundled provenance exists today |
| 7 | Accept Better Auth session invalidation on reconnect for V1 | Product/security | Tenant authorization is live-revalidated; immediate logout-driven socket closure is a documented lower-severity follow-up |
| 8 | Separate merge readiness from production release readiness | Operations | Google OAuth staging validation cannot be proven by local/CI tests |
| 9 | Gate executable plugin UI/runtime independently of persisted lifecycle status | Security | HTTP begins listening before boot reconciliation and stale `ready` rows otherwise serve same-origin code |
| 10 | Remove unreachable cloud plugin-SSE lease code and defer it with isolated execution | Engineering/security | The static 503 and lease used the same predicate, so the lease could not run or be staged; the reachable security boundary is the static denial |

## GSTACK REVIEW REPORT

| Runs | Status | Findings |
|---|---|---|
| CEO/scope | PASS WITH FIXES APPLIED | Separated merge/release gates; resolved session policy; strengthened final-sink plugin policy, shared live access, explicit operator capability, and no-P1/P2 gate |
| Design | PASS WITH FIXES APPLIED | Explicit unavailable deep-link states, fail-closed loading, named capability, structured blocked state, recovery copy, and accessibility criteria specified |
| Engineering/security | PASS WITH FIXES APPLIED | Typed two-layer worker policy, atomic lifecycle reason state, migration contract, stale-ready executable-surface gates, exact live authority, cleanup, observability, and rollout specified |
| DX/operator | PASS WITH FIXES APPLIED | Forward-fix rollback posture, exact commands/flakes, public 503 contract, supportable telemetry, and executable staging runbook specified |
| Post-implementation adversarial review | PASS WITH FIXES APPLIED | Removed an impossible plugin-SSE policy state, restored the documented break-glass deferral, and moved rollback denial before package/DB mutation |

**VERDICT:** APPROVED FOR IMPLEMENTATION on PR #316. Merge remains blocked until the code, verification, CI, and re-review loop completes. Production deployment additionally remains blocked until live two-account OAuth QA/staging passes.

NO UNRESOLVED DECISIONS
