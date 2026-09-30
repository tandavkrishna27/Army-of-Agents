# REL-003 — DR + migration rehearsal runbook (the operator-owed leg)

**This is the OWED leg.** The session built and proved the verification core (the Lane
A–E suites, mutation-tested; see `REL-003-result.md`) and prepared this runbook. **Only
an operator** reaches the D5 staging substrate, authorizes any spend, and runs this
rehearsal. **REL-003 promotes to done ONLY on a cited run of this runbook** (date +
evidence dir + the two DE-20/DE-23 crossings' verification) that measured RPO/RTO within
D5-DR02/DR03 and passed DR01/DR04–DR07 on the live substrate. Absent that, the honest
end-state is *"verifiers + runbook shipped; live staging rehearsal owed"* — a legitimate,
respected outcome (GO-BOOK §9 "Sprint 5b"), never promoted on an embedded-PG or fixture
substitute.

**Secrets are operator-held.** Object-store keys, database URLs, and the provider key are
entered and handled only by the operator, never by any session (Decision #104; never
serialize a key/secret into any prompt, event, protocol message, or log).

---

## Boundary (state it and hold it)

| Who | Does |
|---|---|
| **Session** (done) | Builds/repairs the verification core + the E11-F002 restore invocation; runs every unit + embedded-PG lane green; prepares this runbook. Never reaches live staging; never authorizes spend. |
| **Operator** (owed) | Brings up the D5 topology, authorizes spend, runs the steps below on live external PostgreSQL + object store, captures evidence, and measures RPO/RTO. |

If a session cannot reach live staging, it STOPS at "runbook prepared" and hands over.

---

## E11-F002 — the restore invocation (there is no `aoa db:restore`)

`runDatabaseBackup` ships behind `aoa db:backup` (`cli/src/commands/db-backup.ts`).
`runDatabaseRestore` (`packages/db/src/backup-lib.ts`) is exported from that module but has
**zero production/CLI callers** and is **not** re-exported from the `@armyofagents/db`
barrel — there is **no `aoa db:restore` command** (finding **E11-F002**). So the restore
step here names the exact invocation explicitly, one of:

- **`pg_restore`** for a custom-format dump: `pg_restore --clean --if-exists --no-owner
  --dbname "$TARGET_DATABASE_URL" "$BACKUP_FILE"` (the operator supplies
  `$TARGET_DATABASE_URL` and the backup file path; the backup's format is what
  `runDatabaseBackup` produced).
- **or a thin harness that calls `runDatabaseRestore({ connectionString, backupFile })`
  directly** (the same signature its unit test drives —
  `packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts`), run via `tsx` from
  the operator host.

E11-F002 resolves when a real operator restore entrypoint (an `aoa db:restore` command or
an exercised harness wrapper) lands **and** this rehearsal exercises it; until then it is
`open`, owned by REL-003, and this runbook is its interim resolution.

---

## Preconditions

- D5 topology up (`program-design.md` §"D5: Staging"): 2 control-plane replicas, ≥4
  workers over 2 failure domains, external PostgreSQL + object store, managed secret
  store, canary rollout enabled.
- **Mobility is DISABLED in the initial coding release** (the gate's D6-05
  disabled-mobility path), so the acceptance's MIG-004 (`fenced_restart`) prerequisite is
  **inapplicable** — do NOT add MIG-004 evidence to the promotion set unless a staging row
  actually advertises `fenced_restart` (C2).
- Candidate image SHA recorded (`AOA_0188_CANDIDATE_SHA`).
- Evidence directory created: `docs/replatform/qa/<date>-REL-003-rehearsal/`, retained
  ≥180 days per `test-gates.md` RET-01.

---

## Steps (capture evidence at each)

1. **Baseline.** Record candidate SHA; the worker fleet (IDs, generations, failure
   domains); the `job_artifacts status='committed'` manifest snapshot (row count + total
   bytes).
2. **Pre-0188 snapshot (CM-015).** Run the operator-gated preflight
   (`server/src/services/cutover-0188-preflight.ts` `main()` via the migrate entrypoint,
   `AOA_0188_CUTOVER_OPT_IN=1`) → capture `snapshot_ref` + `snapshot_checksum` from the
   `distributed_cutover_markers` row.
3. **Backup.** `aoa db:backup --json` (record `backupFile`, `sizeBytes`, connection
   source) **and** the object-store snapshot (bucket versioning / copy) at a recorded
   fault instant `T_fault`.
4. **Prior-release restore.** Restore the pre-0188 snapshot into the prior-release
   database via the **E11-F002 restore invocation above** (`runDatabaseRestore` or
   `pg_restore`). Record restore start `T_restore_start`.
5. **Forward recovery to candidate.** Re-run migrations forward to the candidate; bring
   control-plane + workers up migration-first. Record `T_full_service` (first successful
   lease on the recovered fleet).
6. **Manifest reconciliation (the wired verifier over REAL objects).** Run the Lane-A
   verifier over the recovered `status='committed'` manifest × live `headObject` probes —
   wire `runManifestReconciliation`
   (`server/src/services/disaster-recovery/manifest-reconciliation.ts`): `rows` = the
   committed `job_artifacts` set, `headObject` = the live `StorageProvider.headObject`.
   Assert verdict `recovered`, **zero** unresolved missing/mismatched. Record the
   reconciliation RTO (`T_recon_done − T_restore_start`).
7. **Injected fault (DR04).** Delete ≥1 authoritative object and corrupt ≥1 (flip a byte)
   in the recovered store; re-run reconciliation → verdict `failed`, the two objects in
   `quarantined` (`wrong_prefix`/`hash_mismatch`) or `missing`, **none in `promoted`**.
8. **Restore rollout (DR07).** Rolling-deploy the candidate across the ≥4 workers
   (parallelism 1, per the Lane-D-verified `docker-compose.staging.yml`) — verify N-1
   workers keep serving; re-enroll one worker (`advanceTargetGeneration`) and revoke one
   (`revokeExecutionTarget`, which writes the durable `execution_target_revocations`
   cutoff — B1) → the revoked worker's next governed request is refused within the D5/DSK
   timing. **Tick the revocation fanout explicitly** — the
   `execution_target_revocations` fanout worker
   (`createExecutionTargetRevocationFanout`) has no production scheduler today (test-only
   caller), so drive it by hand; do NOT assume live convergence (B3).
9. **Rollback exercise (timed).** Flip the MIG-002 dial back to legacy (no restart) and,
   for the schema, restore the pre-0188 snapshot (or single-org `revert0188`). **Assert
   deleting the marker row alone is NOT the rollback** (the tenant tables persist — the
   Lane-C invariant). Record rollback recovery time.

**Measurement vs D5 (record pass/fail):** DB RPO = `T_fault − newest recoverable DB
commit` ≤15 min; DB full-service RTO = `T_full_service − T_restore_start` ≤4 h (DR02).
Object-store RPO ≤15 min; reconciliation RTO ≤4 h (DR03).

---

## Promotion rule

REL-003 promotes to done **only** on a cited rehearsal run (date + evidence dir + the two
DE-20/DE-23 crossings' verification) that measured RPO/RTO within D5-DR02/DR03 and passed
DR01/DR04–DR07 on the live substrate. Mobility being disabled, MIG-004 is not in the
promotion set (C2). Never promote on an embedded-PG or fixture substitute.
