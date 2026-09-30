# DAT-002 Design — Direct upload/download and fenced artifact commit

**Status:** `design` (reviewable artifact; implementation follows via per-slice fail-first TDD + distinct adversarial review)
**Epic:** `E5-workspaces-secrets` (second ticket).
**Authoritative source:** `docs/replatform/program-design.md:631-636`.
**Depends on (both complete):** DAT-001 (`bc72e6eb3`, the workspace-snapshot producer) + JOB-004 (active lease fences: `guardActiveFence`/`isActiveFence`). Frozen worker-protocol v1 source SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`.
**Grounded by:** the DAT-002 terrain-map (5 readers + synthesis); every load-bearing claim below **re-verified against source in `C:\e3` by the orchestrator**.

---

## 1. Scope + framing

**Outcome (program-design.md:634):** issue **scoped object-storage grants** and **commit verified manifests** through the control plane.
**Acceptance (:635):** worker uploads **bypass the API body path**; wrong prefix/hash/size/tenant/fence **cannot be committed**; incomplete uploads **expire**.

**This is a pure server-side ticket.** The wire contract is already **frozen** in `packages/worker-protocol` — DAT-002 mints/verifies those shapes, adds presigned-URL issuance, persists the committed manifest, and wires a MinIO integration suite. It must **not** extend worker-protocol (frozen v1). Like DAT-001, it is gated behind default-off `AOA_DISTRIBUTED_EXECUTION_ENABLED` (the worker-control router only mounts when `distributedExecutionEnabled`), so the legacy asset path is untouched.

**DAT-002 owns exactly two frozen ops** (verified `transport.ts:325-391`, `865-904`):
- **`artifact_transfer_grant`** (audience `worker_run`, 64 KiB req) → `upload_granted{grant}` | `download_granted{grant}` | `rejected{reason}` (closed pairing, `isTransferGrantResponsePairedV1`).
- **`artifact_commit`** (audience `worker_run`, 256 KiB req) → `committed{artifactId, versionNumber, committedAt}` | `rejected{reason}`. Never converts to quarantine (closed pairing).

**Deferred (non-goals):** the device-authenticated `quarantine_grant`/`quarantine_finalize` server handlers → **DAT-006** (orphan output/reconcile; the worker consumer already exists from WRK-005 but talks to the fake control-plane). The worker-daemon **consumer** of the ordinary path (`artifactTransferGrant()`/`artifactCommit()` client methods) → deferred; the live MinIO suite drives `/api/worker-control/*` directly from the test-runner via the e6f harness (as e6f-03 did), so no worker-daemon client is needed to prove DAT-002.

---

## 2. Decisions

### D1 — Persistence: WIDEN `job_artifacts` in place (not a new table)
`job_artifacts`' own header (`schema/job_artifacts.ts:5-8`) reserves it for "the RICH artifact model (content, versioning, storage) **deferred to E5 (additive)**" — widening it **is** the intended E5 move. It already carries full `aoa_app` DML + FORCE RLS + one tenant-isolation policy (`job-control-legacy-grants.ts:100/286-308/356`), so **new columns inherit the whole-table grant → ZERO keystone reconciliation** (no edit to `appTablePrivileges`, `RLS_RELATIONS`, `FORCE_RLS_RELATIONS`, `POLICY_COUNTS`, `RLS_POLICY_MANIFEST`, `PLAN_DERIVED_ACL_MATRIX`, the nullness cert, or the `job-control-legacy-grants.contract.test.ts` counts). The alternative (new child table) forces the full 7-surface reconciliation + the 20/19/29→21/20/30 count bump — the highest-blast-radius change class in this repo (per the E3 keystone/manifest cascade lessons). **Widen wins decisively.**

New columns on `job_artifacts` (all **nullable additive** — the table is empty, no backfill; the commit service enforces completeness for a `committed` row; nullable keeps the existing thin `authorizeArtifactCommit` callers valid): `object_key text`, `sha256 text`, `size_bytes bigint`, `content_type text`, `kind text`, `sensitivity text`, `retention text`, `attempt integer`, `lease_id uuid`, `fence_token text`, `version_number integer`, `status text` (`'pending'|'committed'`, default null), `committed_at timestamptz`, `expires_at timestamptz`. **Idempotency:** a partial unique index on `(organization_id, job_id, attempt, identifier)` WHERE `status='committed'` (the natural commit key; `identifier` carries the `artifactId`). Migration `0248` via `pnpm db:generate` (ADD COLUMN + index) with C14 `IF NOT EXISTS` guards hand-appended + inline comment + snapshot + `_journal.json`. **No custom RLS migration** (the table's policy already covers the widened columns) → no Decision-#122 snapshot pair beyond the generated one.

### D2 — Mutator: add a sibling `commitArtifactVersion`, leave `authorizeArtifactCommit` unchanged
`authorizeArtifactCommit(input: ActiveFenceRequest & {identifier}) → JobArtifact` (`job-control.ts:2272-2280`) is a `guardActiveFence`-first mutator with **3 existing integration-test callers** (`job-fencing.integration`, `job-output-parity.integration`, `worker-revocation.integration`) that pass `{identifier}` to test **fence behavior**. Changing its signature would ripple into those (the mock-fidelity/shared-signature lesson). Instead **add a new guarded mutator** `commitArtifactVersion(input: ActiveFenceRequest & {manifestFields, actualSizeBytes, actualSha256, versionNumber, committedAt}) → JobArtifact` that runs `guardActiveFence` FIRST then the rich insert. Register it in **both** `GUARDED_JOB_MUTATORS` (`job-fence.ts`) and `GOVERNED_FENCE_SURFACE` (`server/src/services/job-fencing.ts:58-66`) and add the name to `job-fence-surface.contract.test.ts` (the coupling contract asserts the two sets match; adding ONE name to 2 arrays + the test's expected list is the entire cost — **not** a grant-manifest change). `authorizeArtifactCommit` becomes vestigial (a later cleanup may remove it; out of scope).

### D3 — Presign + the https constraint (the load-bearing integration wrinkle)
The frozen grant `url` is **`httpsUrlSchema` = strictly `^https://\S+$`** (`artifacts.ts:331`, verified). So every issued grant URL **must be https**. Today's storage layer (`StorageProvider`, `s3-provider.ts`) is buffer-in/stream-out with **no presign** (`@aws-sdk/s3-request-presigner` absent; zero `getSignedUrl` in `server/src` — verified). DAT-002:
- Adds `@aws-sdk/s3-request-presigner` and a `presignPut`/`presignGet(objectKey, {expiresInSeconds, maxBytes, checksumSha256}) → {url, headers, method}` capability (extend `StorageProvider` for the S3 provider; a `local_disk` provider cannot presign → in `local_disk` mode the grant ops fail closed with `rejected`/unsupported, and the distributed flag implies S3/MinIO in practice).
- Uses a **worker-facing https endpoint** for the presigned URL host — a NEW config `AOA_STORAGE_S3_PRESIGN_ENDPOINT` (https, worker-reachable), distinct from the control-plane's internal `AOA_STORAGE_S3_ENDPOINT` (used for `headObject`). The presign must fail closed if the presign endpoint is not https (the frozen schema rejects it anyway; we assert early with a clear error). **`AOA_STORAGE_S3_PRESIGN_ENDPOINT` must be added to the env-var docs** (`brand-check` gate enforces AOA_* doc completeness). Config var mismatch noted: the D1 compose sets `AOA_S3_ENDPOINT`/`AOA_WORKER_S3_ENDPOINT`; the D1 wiring for DAT-002 maps `AOA_WORKER_S3_ENDPOINT`→presign + `AOA_S3_ENDPOINT`→`AOA_STORAGE_S3_ENDPOINT` (a compose env reconciliation in the live slice).
- **SHA256 integrity:** upload grants require an S3 SHA256 checksum (`ChecksumAlgorithm: 'SHA256'` in the signed PUT); commit reads the object's stored `ChecksumSHA256` via `headObject` and compares to `manifest.sha256`. If the store cannot supply a checksum, commit **fails closed** (`rejected`) — an unverifiable hash must never commit. MinIO supports SHA256 checksums.

### D4 — Grant issuance flow (`artifact_transfer_grant`)
Route `POST /api/worker-control/artifact-transfer-grants` (new; on the `workerControlRoutes` router, flag-gated). 6-step worker-route template (canonical = the events route `worker-control.ts:310-354`): `safeParse artifactTransferGrantOperationRequestV1Schema` (audience literal `worker_run` is a fail-closed check; the body's superRefine already binds `expectedObjectKey` to `organizations/…/jobs/<jobId>/attempts/<attempt>/` → **wrong tenant/job/attempt rejected pre-issuance**) → Bearer + device-proof + rawBody + size-check vs `OPERATION_DESCRIPTORS.artifact_transfer_grant.maxRequestBytes` → `verifyWorkerOperationProof` → service. The service runs `runInTenant(appDb, org, …)` → `guardActiveFence` on the presented 13-field identity (**upload requires a live fence**; **download is tenant-scoped + object-existence, NOT fence-current** — a committed artifact must stay readable after lease loss) → presign scoped to `expectedObjectKey`, `expiresAt`, `maxBytes`, `expectedSha256`, credential-scrubbed headers, `redaction:'secret'` → return `artifactUploadGrantV1`/`artifactDownloadGrantV1` (self-validated with the frozen schema `.parse()` before send). This IS the direct-to-store bypass — bytes never traverse the API.

### D5 — Fenced commit flow (`artifact_commit`) — one-tx, fence-first
Mirror `createJobEventIngestService.ingest` (`job-events.ts:79-231`). Route `POST /api/worker-control/artifact-commits`. `safeParse artifactCommitOperationRequestV1Schema` (jobId/attempt↔manifest binding + manifest objectKey prefix already schema-enforced) → template → service:
1. `headObject(manifest.objectKey)` on the control-plane's internal S3 endpoint → actual `{ContentLength, ChecksumSHA256}`. Object missing/incomplete → `rejected` (`upload_incomplete`).
2. `runInTenant` ONE tx: proof-replay guard (repo; replay→`unauthorized`) → authority/generation recheck under fresh DB `clock_timestamp()` → **`commitArtifactVersion` mutator**: `guardActiveFence` FIRST (fence precedence — a **stale fence surfaces as `stale_fence` BEFORE any hash/size check**, the documented hard invariant `job-events.ts:20-26`) → verify `manifest.objectKey` prefix + tenant (org/company/job/attempt) + `manifest.sizeBytes === actual ContentLength` + `manifest.sha256 === actual ChecksumSHA256` (any mismatch → the mutator throws a typed reject) → compute `versionNumber` (`COALESCE(MAX(version_number),0)+1` for `(org, job)` under the fence lock; best-effort ordinal, no unique on version_number) → insert the `status='committed'` row idempotently (`onConflictDoNothing` on the partial-unique natural key; on conflict return the existing row = idempotent replay) → return `{artifactId, versionNumber, committedAt}`.
3. Map `JobFenceError.code` → `rejected{reason}` (`stale_fence`/`target_revoked`/`attempt_terminal`), verification failures → `rejected{reason}` (`wrong_prefix`/`hash_mismatch`/`size_mismatch`/tenant), success → `committed`.

**Rejection-reason precedence (fail-closed invariant):** fence staleness is decided BEFORE hash/size, even when both are wrong.

### D6 — Incomplete-upload expiry
Two layers, both owned here: (1) the presigned grant `expiresAt` bounds the upload window (schema-enforced `expiresAt > issuedAt`) — an expired URL is rejected by the object store; (2) commit itself is the completion event — a granted-but-never-committed upload leaves **no committed row** (grant issuance persists nothing), so there is nothing to reconcile server-side; the orphaned object is swept by an object-store lifecycle/abort rule (ops-level, documented — a server-side reaper is a DAT-006 reconciliation concern, not DAT-002). This satisfies "incomplete uploads expire" via the grant TTL without a pending-row reaper. (If review prefers an explicit `pending` row + `expires_at` sweep, the columns exist (D1) — but the default is grant-TTL-only to keep DAT-002 minimal.)

### D7 — Verification profile (server+DB+MinIO — NOT the hermetic worker-daemon profile)
Two tiers: **in-process integration** (embedded-PG, `verify` lane; win32-gated by `AOA_RUN_WIN_INTEGRATION`) proves EVERY fail-closed acceptance (prefix/hash/size/tenant/fence + idempotency) against a **stubbed object store** (a fake `headObject`), plus a pure manifest-verification **vectors gate** in the `policy` job (mirroring DAT-001's independent `.mjs` checker). **LIVE MinIO** (`tests/d1/e6f-dat002-*.test.mjs`, Linux-CI-only, `AOA_D1_LIVE`, in the `d1-merge-train` `foundation` campaign) proves the real presigned-PUT bypass + toxiproxy incomplete-upload + download round-trip — **requires MinIO-over-TLS** (the https constraint) in the D1 stack.

---

## 3. Slice plan (fail-first TDD)

1. **Presign capability (unit).** Add `@aws-sdk/s3-request-presigner`; extend the S3 `StorageProvider` with `presignPut/presignGet`. Tests: https URL scoped to key + expiry + SHA256-checksum requirement; `forcePathStyle` for MinIO; fail-closed if presign endpoint not https. Fail-first: no presign exists.
2. **Persistence migration `0248` + repo (unit + schema-sibling).** Widen `job_artifacts` (nullable additive columns + partial-unique). Run `db:generate` + C14 guards + snapshot + journal. Tests: `runInTenant` round-trips the new columns; RLS isolates cross-tenant. **Run the schema-sibling tests** (`job-events-schema`/`job-control-schema` + `artifact-lifecycle-schema-contract` + migration-journal-contiguity) — column-list drift class (JOB-011 lesson).
3. **`commitArtifactVersion` mutator + fence-surface contract (unit).** Add the mutator (guard-first + rich insert); register in `GUARDED_JOB_MUTATORS` + `GOVERNED_FENCE_SURFACE` + `job-fence-surface.contract.test.ts`. Fail-first: contract test red until all three updated.
4. **Grant-issuance service + route (server integration, embedded-PG).** `artifact_transfer_grant`. Tests: stale fence → `stale_fence`; wrong-prefix `expectedObjectKey` → rejected pre-issuance (schema); upload vs download pairing; success grant parses against the frozen schema; download survives a lost fence (tenant-scoped).
5. **Fenced commit service + route (server integration, embedded-PG, stubbed object store).** `artifact_commit` one-tx fence-first. Tests (each fail-first): stale fence → `stale_fence` BEFORE hash; wrong prefix → rejected; sha256 mismatch → rejected; size mismatch → rejected; cross-tenant manifest → rejected; missing/incomplete object → rejected; happy path → `committed{artifactId, versionNumber, committedAt}`; idempotent replay → same result; `attempt_terminal` on terminal attempt.
6. **Manifest-verification vectors gate (policy tier).** `scripts/check-artifact-commit-vectors.mjs` (+`.test.mjs`) — pure prefix/hash/size/tenant reject+accept vectors, independent re-derivation; wire into the `policy` job next to the DAT-001 line.
7. **LIVE MinIO integration (`tests/d1/e6f-dat002-*.test.mjs`, Linux-CI).** MinIO-over-TLS wiring in `docker/d1` (self-signed cert or TLS front) so the presign endpoint is https; grant → direct PUT to the presigned URL (worker→toxiproxy→minio, bypassing the API) → commit → verify row + object; toxiproxy stall → incomplete upload expires; download grant → GET round-trip. Named `e6f-*` so the `foundation` glob picks it up. **If the TLS wiring proves to be a heavy infra task, land slices 1-6 (CI-green, full fail-closed acceptance in-process) first and iterate the live round-trip on Linux CI as a focused follow-up** — the in-process tier carries the acceptance; the live tier is the DEC-03 authority proof.

---

## 4. Gate + verification profile

Local (Windows authoring): `pnpm db:generate` (0248 + snapshot + journal); `pnpm --filter @armyofagents/db typecheck`; `pnpm --filter @armyofagents/server exec vitest run <suites>` (+ `AOA_RUN_WIN_INTEGRATION=1` for the commit/grant integration on embedded-PG); the schema-sibling + migration-idempotency + artifact-lifecycle-schema-contract tests; `node scripts/check-artifact-commit-vectors.mjs` (+ `node --test`); `pnpm check:distributed-foundation` (must stay green — **no grant/RLS drift** since we widen, not add a table); `pnpm check:frozen-worker-protocol-v1` (zero worker-protocol edits); `pnpm install --frozen-lockfile` **will change** (new `@aws-sdk/s3-request-presigner` dep — commit the lockfile).

CI (all fold into `ci-required`): `verify`, `lint` (no-floating-promises), `e2e`, `e2e-pgvector`, **`migrations`** (apply-from-scratch + journal chain), **`distributed-contract`** (becomes required — DAT-002 touches `packages/db/src/schema/`), `policy` (+ new artifact-commit vectors), `brand-check` (**new `AOA_STORAGE_S3_PRESIGN_ENDPOINT` must be documented**), `worker-protocol-contract-bytes` (frozen). Plus `d1-merge-train` (Linux authority) for the live MinIO tier.

**Blast-radius budget (E3 lessons):** widening a table + adding a mutator can ripple into (a) schema-sibling column-list tests (run them), (b) the `job-fence-surface` contract (updated in slice 3), (c) mock-based unit tests of any changed signature (none — we ADD a mutator, not change one), (d) `distributed-contract` (no grant change → should stay green; verify). Budget 1-2 CI rounds for blast radius.

---

## 5. Non-goals (deferred)

- **Quarantine server handlers** (`quarantine_grant`/`quarantine_finalize`, device_session) → **DAT-006** (orphan output).
- **Worker-daemon consumer** of the ordinary path (client methods + direct-PUT) → later (the e6f harness drives the server directly).
- **Rich versioning/branching semantics** beyond a positive `versionNumber` (immutable-version branching, artifact-as-input wiring, `task_outputs` integration).
- **Server-side pending-upload reaper** (grant-TTL + object-store lifecycle suffices for DAT-002; explicit reconciliation is DAT-006).
- **Secrets/presigner-credential broker** (the S3 signing creds) → DAT-004 territory; DAT-002 uses the configured storage creds.
- Any change to the legacy asset path (`assets.ts`, `memory-assets-upload.ts`) — untouched; DAT-002 is distributed-flag-gated.

---

## 6. Residual risks

- **https/MinIO-TLS for the live tier.** The frozen `httpsUrlSchema` forces https grant URLs; the D1 MinIO must serve TLS. If the TLS wiring is heavy, the live round-trip is a follow-up while the in-process tier carries acceptance (slice 7 note).
- **SHA256 verification depends on object-store checksums.** If a provider can't supply `ChecksumSHA256`, commit fails closed (correct, but a provider gap would block commits there — documented; MinIO/S3 support it).
- **`versionNumber` is a best-effort per-(org,job) ordinal** (no unique). Concurrent commits across different attempts of one job may share a number; acceptable for the frozen positive-int contract. Rich versioning is deferred.
- **Nullable rich columns.** Committed-row completeness is an application invariant (the `status='committed'` + partial-unique), not a DB NOT NULL — chosen to avoid disturbing the thin `authorizeArtifactCommit` callers. A later tightening could add NOT NULL once the thin path is removed.

---

## 7. Decisions ledger

| ID | Decision |
|----|----------|
| DAT-002-D1 | Widen `job_artifacts` in place (nullable additive + partial-unique); no new table → zero keystone grant-manifest reconciliation. |
| DAT-002-D2 | Add sibling guarded mutator `commitArtifactVersion` (guard-first + rich insert); register in GUARDED_JOB_MUTATORS + GOVERNED_FENCE_SURFACE + contract test; leave `authorizeArtifactCommit` unchanged (no caller ripple). |
| DAT-002-D3 | Add `@aws-sdk/s3-request-presigner` + presign on the S3 provider; worker-facing https presign endpoint (new `AOA_STORAGE_S3_PRESIGN_ENDPOINT`, documented); SHA256 via S3 checksum, fail closed if unverifiable. |
| DAT-002-D4 | Grant issuance: upload requires a live fence; download is tenant-scoped + object-existence (survives lease loss). |
| DAT-002-D5 | Commit: one-tx fence-first; rejection precedence = fence staleness BEFORE hash/size; idempotent on `(org,job,attempt,identifier)`. |
| DAT-002-D6 | Incomplete-upload expiry via grant TTL + object-store lifecycle (no server reaper in DAT-002). |
| DAT-002-D7 | Two-tier verification: in-process (embedded-PG, stubbed store) carries fail-closed acceptance; live MinIO (Linux CI, TLS) proves the direct-upload bypass. |
| DAT-002-D8 | Quarantine handlers + worker consumer are non-goals (DAT-006 / later). |
