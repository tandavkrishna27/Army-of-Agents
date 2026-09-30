# JOB-005 — Ingest events and terminal results idempotently — result

**Result:** `pass`
**Revision:** authored on `docs/replatform-program` (after JOB-004 `c6ad25e47`)
**Date (UTC):** `2026-08-14`
**Acceptance:** `pnpm --filter @armyofagents/db exec vitest run src/__tests__/job-events-schema.integration.test.ts src/__tests__/migration-idempotency.test.ts` (13) + `pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-events.integration.test.ts` (**11**). Re-verified by the controller: `job-events.integration` + `job-fence-surface.contract` + `job-fencing.integration` = **26 pass**; `tsc --noEmit` green (db + server). Manifest-vs-live-catalog gate (`distributed-execution-db-startup.integration.test.ts`) applies 0234/0235 cleanly; Linux CI is the authority.

## Outcome

Valid ordered events commit ONCE inside one tenant transaction and return a stable cumulative ACK while transactionally applying the legal job/attempt transitions — behind JOB-004's already-active-fence-guarded interface.

## Deliverables

- **`packages/db/src/schema/job_events.ts`** — immutable accepted-event ledger; unique `(organization_id, event_id)` + `(organization_id, attempt_id, sequence)`; composite tenant FKs to `job_attempts`/`leases` (no single-column parent FK, E2-F013); stores the validated event + recomputed digest, no secret material.
- **`packages/db/src/schema/job_projection_receipts.ts`** — projection idempotency state machine; unique `(organization_id, company_id, projection_kind, source_identity)` + `source_digest`/`job_id`/`attempt_id`/`source_fence`/`status(pending|applied)`/`target_aggregate_id`/timestamps.
- **`server/src/services/job-events.ts`** — the ingest service (imports E1 `canonicalEventDigestInputV1`/`verifyWorkerEventDigestV1`, RFC8785 — not reimplemented).
- **`packages/db/.../tenant/job-control.ts`** — filled the JOB-004 stubs `acceptEvent`/`applyProjectionReceipt` with real storage (still gate on `guardActiveFence` FIRST; `readAcceptedThroughSeq` + `applyProjectionForFence` helpers); classified `readAcceptedThroughSeq` in the fence-surface allowlist.
- **`server/src/routes/worker-control.ts`** — `POST /api/worker-control/events` (dual-auth), errors via `sendWorkerOperationProtocolError`.
- **Migrations:** `0234_sloppy_the_watchers.sql` (tables; C14-idempotent `IF NOT EXISTS` + `DO $$ … duplicate_object` FK guards) + `0235_job_events_rls.sql` (custom Decision #122 RLS mirroring 0228/0231: REVOKE PUBLIC/operator, GRANT aoa_app DML, ENABLE+FORCE RLS, drop-before-create org-scoped `*_tenant_isolation` policy per table).
- **Manifest reconciliation:** `job-control-legacy-grants.ts` + `distributed-execution-databases.ts` register the 2 new RLS-forced tables (RLS 16→18, FORCE 15→17, policies 24→26); the independent oracle in `job-control-legacy-grants.contract.test.ts` updated to match.
- Tests: `job-events-schema.integration.test.ts` (db) + `job-events.integration.test.ts` (server).

## Semantics (verified)

- ONE `runInTenant` transaction; a partial-invalid batch commits NONE (per-event hash + gap + replay-region checks all precede the single insert).
- Fence FIRST (`acceptEvent`→`guardActiveFence`); a stale/expired/replaced fence → `stale_fence` with a cumulative ACK of what was already accepted, no partial write.
- Idempotent: same eventId+digest+sequence replays the prior cumulative ACK; a changed digest for an accepted sequence → `hash_mismatch`; gap/out-of-order rejected.
- First `attempt_started` → attempt `leased→running` + job `queued→running`; terminal → attempt `(non-terminal)→terminal` (status-conditional, terminal-wins-once); terminal does NOT finalize the job (JOB-006 boundary).

## Independent check + fix applied

Controller review + a 2-lane adversarial Workflow. **Lane (manifest-migration consistency): CLEAN** — the manifests EXACTLY match 0234/0235 + the oracle (RLS/FORCE/policy counts all correct), so the Linux startup gate passes. **Lane (event-ingest semantics): found one real defect** — a new-tail event reusing an already-accepted eventId (org-wide `(org,event_id)` unique) was silently dropped by an untargeted `ON CONFLICT DO NOTHING` while its projection + ACK still advanced, wedging the stream on a phantom sequence. **FIXED:** `acceptEvent` now pre-scans the new-tail eventIds against existing `(org,event_id)` rows under the fence lock and rejects reuse as `hash_mismatch` with NO write (plain insert, no conflict-masking). Added the regression test "rejects a new-tail event REUSING an already-accepted eventId".

Non-goals (deferred): realtime fan-out/catch-up, artifact bytes, pricing, cancellation policy (JOB-006), legacy projection.
