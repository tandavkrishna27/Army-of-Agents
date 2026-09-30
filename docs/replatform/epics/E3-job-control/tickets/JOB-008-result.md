# JOB-008 — Operator job and worker controls — result

**Result:** `pass`
**Revision:** authored on `docs/replatform-program` (after JOB-007)
**Date (UTC):** `2026-08-14`
**Acceptance:** `pnpm -r build` green (all packages incl. server `tsc` + ui `tsc -b && vite build`) · `pnpm vitest run server/src/__tests__/job-operations-routes.test.ts` = **16** green · `pnpm vitest run ui/src/__tests__/OperationsSection.test.tsx` = **13** green (incl. 2 post-review regression tests) · `pnpm vitest run ui/src/__tests__/SettingsPage-redesign.test.tsx` = **23** green (count 16→**17** + "Job control" nav assertion) · `pnpm --filter @armyofagents/server typecheck` green · `pnpm --filter @armyofagents/ui typecheck` green · `pnpm --filter @armyofagents/ui build` green (via `-r build`). Frozen `job-control-legacy-grants.contract.test.ts` = **7** green (untouched).

## Outcome

A tenant-authorized operator (board actor holding the org `execution_target:manage` cap) can inspect **redacted** durable job / attempt / lease / event / worker status and invoke **cancel / drain / revoke** with an explicit manual **Refresh** (no realtime — that is E10). The read envelopes are redacted BY CONSTRUCTION (projected `tx.select({safeCols})`), so no cross-tenant id, capability token, or intent/policy/payload column can reach the wire. Mutations delegate to the existing JOB-006/007 authorities — no new writer is introduced. Flag-off ⇒ the routes are absent (they only mount inside the `distributedExecutionEnabled` block).

## Deliverables

- **`server/src/services/job-operations.ts`** (new) — `createJobOperationsService({ appDb, operatorDb })`. Reads are projected selects inside `runInTenant` (NOT the full-row tenant-repo methods, which `SELECT *`): `listJobs`, `getJobDetail` (job + attempts + leases + events composed in ONE tenant callback), `listWorkers`. Mutations delegate: `drainJob` → JOB-006 `requestCancellation({ graceful: true })`; `revokeWorker` → resolves `worker.executionTargetId` server-side inside `runInTenant`, then JOB-007 `revokeExecutionTarget`. Five projected column maps carry the redaction contract inline.
- **`server/src/routes/job-control.ts`** (extended) — factory widened `(appDb)` → `({ db, appDb, operatorDb })`. Adds a local `assertOrgAdmin` closure (replicated verbatim from `execution-targets.ts`; `assertBoard` + `orgAccess.canOrg(orgId, userId, "execution_target:manage")`) run FIRST on every route. New routes: `GET …/jobs`, `GET …/jobs/:jobId`, `GET …/workers`, `POST …/jobs/:jobId/drain`, `POST …/workers/:workerId/revoke`. Structured `logger.info` audit on every mutation success; no audit on 403/404. Existing submission `POST …/jobs` preserved.
- **`server/src/app.ts`** (mount edit — **outside the ticket file list**, unavoidable because the factory widened) — `api.use(jobControlRoutes({ db, appDb: opts.tenantAppDb, operatorDb: opts.operatorDb }))`. All three handles are already in scope + guaranteed non-null inside the `distributedExecutionEnabled` block.
- **`packages/shared/src/types/job-control.ts`** (extended) — redacted DTOs shared by server + UI: `JobSummary`, `AttemptSummary`, `LeaseSummary`, `EventSummary`, `WorkerSummary`, `JobDetail`, `JobDrainResult`, `WorkerRevokeResult`. Auto-exported from `@armyofagents/shared` via the existing `export * from "./types/job-control.js"`.
- **`ui/src/api/job-control.ts`** (new) + barrel export in `ui/src/api/index.ts` — `jobControlApi` over `api` from `./client` (`ApiError` is thrown, not swallowed). `cancelJob` posts `graceful:false` to the reused worker-control cancel path; `drainJob` posts to the graceful `…/drain` route.
- **`ui/src/lib/queryKeys.ts`** (extended) — `queryKeys.jobControl` namespace (`jobs`/`job`/`workers`), distinct `"job-control"` prefix for targeted invalidation.
- **`ui/src/components/settings/sections/OperationsSection.tsx`** (new) — HealthSection skeleton (manual Refresh + visible loading/error) + MCPApiKeysSection mutation pattern (inline `text-destructive` mutation error, no toast). Status pills for queued/leased/canceling/failed/revoked/stale across job/attempt/lease/worker kinds; expandable per-job detail (attempts/leases/events); no-company/org guard; manual Refresh via `invalidateQueries` (prefix-matches the open detail query too) with no `refetchInterval`; each action resets the sibling mutations' errors so the banner never shows a stale message.
- **`ui/src/components/settings/SettingsLayout.tsx`** + **`ui/src/pages/SettingsPage.tsx`** (registration) — `"operations"` added to the section union / `VALID_SECTIONS` / `renderActiveSection`; nav item `{ id: "operations", label: "Job control", icon: ListChecks }` (`ListChecks` added to the `lucide-react` import).
- **Tests** — `server/src/__tests__/job-operations-routes.test.ts` (new, 16) + `ui/src/__tests__/OperationsSection.test.tsx` (new, 11); `ui/src/__tests__/SettingsPage-redesign.test.tsx` count bumped 16→17 + "Job control" nav assertion.

## R3 — cancel-route collision decision: **REUSE**

An operator cancel route ALREADY EXISTS at `worker-control.ts:409` — `POST /organizations/:orgId/companies/:companyId/jobs/:jobId/cancel`, board-authenticated + `execution_target:manage` scoped, delegating to `reconciliation.requestCancellation`, audited via `logger.info`, returning `202 { status, command }`. That IS the exact operator cancel JOB-008 needs, so it is **reused** — `job-control.ts` adds ONLY list/detail/workers/**drain**/**revoke**. Registering the same path in a second router mounted under `/api` would double-register the pattern (Express runs the first match — a latent bug). There is therefore **exactly one** cancel route. The UI `cancelJob` posts `{ reason, graceful: false }` to that path (hard cancel); `drainJob` posts to the distinct `…/drain` route (graceful). The `requestCancellation` delegation/idempotency/`not_found`→404 behaviour is exercised in this ticket's server test via the DRAIN route (same delegate); the cancel route itself remains covered by JOB-006's worker-control tests.

## R1 — drain semantics: **job-level graceful cancellation**

Drain = `requestCancellation({ graceful: true })`. There is no worker-fleet "drain" service and no writer for `workers.status='draining'` (the enum value exists but nothing mutates it) — inventing one is out-of-scope JOB-006 work. The only ticket-compliant reading of "mutations call JOB-006/007 services" is the job-level graceful stop, audited as `job.drain.requested`.

## R2 — revoke keying: **worker-scoped route**

`POST /organizations/:orgId/workers/:workerId/revoke`. The service resolves `worker.executionTargetId` server-side inside `runInTenant` (org-predicated, so a worker owned by another org resolves to nothing), then calls JOB-007 `revokeExecutionTarget({ appDb, operatorDb, targetId, organizationId, reason })`. The cross-tenant target id is NEVER sent to or received from the client. This also sidesteps the older `execution-targets.ts:218` `/execution-targets/:targetId/revoke` (worker-token semantics, wrong callee).

## Redaction proof (R4 — the core deliverable)

Reads are **projected** `tx.select({ …safeColumns })` — a column not in the map cannot leak. The three cross-tenant id sinks (`job_attempts.placement_target_id`, `leases.target_id`, `workers.execution_target_id`) and the token/payload sinks (`leases.fence`, `job_events.fence_token`, `job_events.event`, `workers.*` device keys/`profile_snapshot`) are absent from every map. The server test asserts the ABSENCE of each per envelope through a projection-respecting fake `tx` (fixtures carry the secret columns; the projection drops them — the assertion passes only because the map excludes them): `input/policySnapshot/commandDigest/sourceIdentity/…` (job), `placementTargetId/*Hash/*Digest` (attempt), `fence/targetId/targetAuthorityKey/workerId` (lease), `event/fenceToken/leaseId` (event), `devicePublicKey/executionTargetId/targetAuthorityKey/organizationId` (worker). The audit-payload test asserts no `fence`/`fenceToken`/`workerTokenHash`/payload keys are ever logged.

## R5 — null-Org exclusion

Worker reads keep the `eq(workers.organizationId, orgId)` predicate (matching `listExecutionTargets`), so platform (`organization_id IS NULL`) workers are never enumerated to a tenant; FORCE RLS via the `runInTenant` GUC is the second gate. The server test injects a null-org platform worker into the fixture set and asserts it is excluded from the list.

## Failure / auth behavior

- `assertOrgAdmin` runs FIRST on every route: `none` actor → **401**; non-board → **403**; board without the cap → **403** with **no audit line**.
- Absent OR cross-tenant job/worker → **uniform 404** (indistinguishable from a present-but-cross-tenant resource; no existence oracle), **no audit**, and (revoke) **no delegate call**.
- Errors are visible (React Query surfaces the thrown `ApiError`; read errors render "Failed to load…", mutation errors render an inline `text-destructive` banner) — never a silent toast-only failure.
- Repeat cancel/drain/revoke is idempotent: drain repeat → `already_requested` (stable 202); revoke repeat → `already_disabled` (200, no throw).
- Audit is a structured `logger.info` (activity_log is company-scoped with no org column), never a DB row, never logging fence/token/payload.

## Independent check + two fixes applied

A 2-lane adversarial Workflow (server redaction/auth completeness + test-fidelity/UI). **The redaction/auth lane found NOTHING** — the security core is clean: every safe-column projection map was diffed against the real schemas (no missed sink), `assertOrgAdmin` gates every route before any read/mutation, the uniform 404 is a genuine no-existence-oracle, and the org+company predicates exclude null-Org platform rows. The redaction test's fake `tx` was confirmed to genuinely model Drizzle projection (returns only mapped columns), so the absence assertions actually prove redaction rather than restating it.

**Two confirmed defects (both LOW, both UI polish) — FIXED:** (1) manual Refresh refetched only the two list queries and missed an open `JobDetailPanel`, leaving its attempts/leases/events stale → FIXED to `invalidateQueries` on the jobs prefix (prefix-matches the open detail query). (2) the single error banner chained `cancel.error ?? drain.error ?? revoke.error`, so a failed action's error persisted after a different action succeeded (React Query does not reset sibling mutation errors) → FIXED: each action resets the other two mutations before firing. Both fixes have regression tests (13 UI tests now; the Refresh test proven fail-first: `getJob` called once, not twice, on the pre-fix code).

## Non-goals (unchanged from the ticket)

Durable realtime / live catch-up (E10), live log streaming, displaying secret/event payloads, cross-tenant platform inventory, execution cutover, and any new DB schema/migration (this ticket is read + delegate-mutation only).
