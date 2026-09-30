# DE-AUDIT — the experiments that need live access

**What this is.** All thirty trust crossings in
[`docs/architecture/distributed-execution-threat-controls.json`](../architecture/distributed-execution-threat-controls.json)
have now been audited — twelve by W20, sixteen (DE-15…DE-30) by W20B, and DE-02/DE-08 earlier —
with every verdict recorded against source, at file:line, in each row's `deliveryEvidence`.
★ **That is not good news.** One crossing of thirty came back whole; twenty-five are `partial`
and four are `not-delivered`. A zero in the "unaudited" column means nothing is unmeasured,
not that anything holds.
Some questions could not be settled from a repository checkout. This document turns each of
those into a **work item somebody can actually run**: the access required, the exact steps,
and — stated in advance, so the result cannot be reinterpreted afterwards — what outcome
would mean *delivered* and what would mean *not delivered*.

**Read the scope honestly before using it.** A precise "cannot be settled here, here is the
experiment" is a valuable answer. It is not a delivery claim, and nothing in this document
upgrades any register row. Rows move only on a recorded measurement.

**The one rule these experiments are written to satisfy.** A control is `delivered` only if
you can exhibit it **denying** something. A configuration field is not enforcement. A type is
not enforcement. A doc saying it is enforced is not enforcement. **A read-back that returns
your own declared value is not enforcement** — it verifies what was *declared*, never what is
*enforced*. That is not a theoretical caution: DE-08's egress `denyOut` was accepted by the
API, validated server-side, stored, and echoed back byte-exactly by `getInfo()` — and traffic
flowed anyway. Every experiment below therefore ends in an **independent** observation, never
in the system's own echo of the thing you asked for.

---

## Index

| Crossing | Question live access would settle | Can the answer change the verdict? |
|---|---|---|
| [DE-01](#de-01) | Does the live serving credential resolve to the non-owner `aoa_app` role in a real container? Is the audit gap total end-to-end? | Cannot raise it. B could lower it. |
| [DE-03](#de-03) | Does a captured worker request replay 401 in a real deployment? Is the denial logged? | Cannot raise it. B could correct the audit sub-verdict. |
| [DE-04](#de-04) | Does a released lease still yield a download grant over HTTP? | No — it confirms a scope limit already recorded. |
| [DE-05](#de-05) | Does any shipped path ever write a quarantined artifact row? | Yes — a non-zero count would refute the caller census. |
| [DE-06](#de-06) | Is the deployed S3 credential bucket-wide? Does the cross-tenant key rejection hold on the live MinIO lane? | (a) no; (b) yes — confirms the "scoped service identity" clause is false in deployment. |
| [DE-07](#de-07) | Does the resolve path deny four ways live? Is there any surface that can revoke a handle? | Yes — an operator-facing revoke would refute the dead-lever finding. |
| [DE-09](#de-09) | **Is a capability restriction expressible on e2b create at all?** Which template does a live create receive? What can a tenant reach from inside the guest? | Yes, in both directions — and it may show the clause is unbuildable as written. |
| [DE-10](#de-10) | With the reaper armed, is an orphan sandbox actually destroyed — as seen by the provider, not by our own code? | Yes — this is the only route to `delivered` for the destroy half. |
| [DE-11](#de-11) | Does the artifact bucket carry default encryption or a lifecycle rule out of band? | Yes — for `confidentiality` (both halves) and the **TTL-expiry half** of `revocation`, now recorded `UNKNOWN`. Purge-on-job-completion and `audit` stay measured absences. |
| [DE-12](#de-12) | **Nothing.** | No — see the entry for why this is a finding, not a gap in this document. |
| [DE-13](#de-13) | Does one noisy Organization starve another? | Yes — this is REL-002's acceptance and it has never been run. |
| [DE-14](#de-14) | **Nothing.** Settled by executing the assertion. | No. |
| [DE-15](#de-15) | Does `check-d1-compose` pass a mutable, unsigned, non-allowlisted worker tag? Does the kill-switch drain hold on real PostgreSQL? | Yes — a green exit 0 in step 4 lowers three clauses from `partial` toward `not-delivered`. |
| [DE-16](#de-16) | Do stale `ready` plugin rows actually reconcile to blocked metadata-only on a cloud_auth boot? | Yes, for the `revocation` clause, which is currently **unmeasured** rather than absent. |
| [DE-17](#de-17) | Does a fence-lost-but-unexpired capability still execute? Is a fence-lost orphan ever reclaimed? | Yes, in both directions — experiment 1 could refute the escalation finding. |
| [DE-18](#de-18) | Does a governed op replay as `target_revoked` over real HTTP after a generation bump? Does anything ever converge the revocation? | Confirms the deny; the convergence leg confirms the dead-fanout finding. |
| [DE-19](#de-19) | Does a sandbox token still read company memory after its run has ended? | Yes — a 200 would confirm the revocation clause is absent in deployment, not just in source. |
| [DE-20](#de-20) | Does flipping the rollout dial off cancel an in-flight distributed run? | Yes — the wall-clock gap **is** the RTO the "atomically" clause denies exists. |
| [DE-21](#de-21) | Does a company-A key open a company-B event socket on the second replica? | Confirms the primary deny arm, which no test currently exercises over real HTTP. |
| [DE-22](#de-22) | Can `aoa_app` UPDATE and DELETE `job_events` rows directly? | Yes — a successful UPDATE confirms append-only is code discipline, not a grant. |
| [DE-23](#de-23) | **Nothing can raise it.** The chartered DR rehearsal is nonetheless owed. | No — a fully green rehearsal leaves DE-23 at `partial` **at best**. |
| [DE-24](#de-24) | Does a host refuse a replayed, revoked or unhealthy update and leave the pointer unmoved? | Yes — but it is blocked on code, not on access. |
| [DE-25](#de-25) | **Nothing.** Caller counts are static facts. | No — a live run would only re-demonstrate that the resolver is never entered. |
| [DE-26](#de-26) | Does the real E2B provider leak cross-tenant on `list`? What does the certified suite score against the real transport? | Yes — B turns `not-delivered` into a measured `partial` with a named residue. |
| [DE-27](#de-27) | Does replica B fail closed when partitioned from PostgreSQL — not from its clients? | Yes — it turns "fail-closed by construction" into a measurement. |
| [DE-28](#de-28) | Is a quarantined object actually unreachable at the **store**, or only at the key? | Yes, downward: a successful anonymous GET drops the confidentiality clause. |
| [DE-29](#de-29) | Is the legitimate owner of a minted handle refused? Does any sink record a wrong-owner denial? | Yes — a successful resolve would refute the owner-principal finding. |
| [DE-30](#de-30) | Is a worker never offered a lease for a capability its ratified ceiling omits? | Confirms the mechanism end-to-end; blocked on REL-001. |

---

## DE-01 — Control-plane PostgreSQL ↔ tenant query path (Critical)

The DB-layer controls were **settled by measurement** (4,460 adversarial operations against
real embedded PostgreSQL, deny lines observed in the server log). Neither experiment can
raise the verdict; only B can lower it.

### Experiment A — the live serving credential really is the non-owner role

**Access:** a Linux host able to run `docker compose -f docker-compose.d1.yml up` with the
DEP-001 admitted image digests from `docker/d1/.env.example`.

1. Bring the stack up with `AOA_DISTRIBUTED_EXECUTION_ENABLED=true`.
2. Look for the control-plane log line *"Verified aoa_app and aoa_operator bounded database
   pools"* (`server/src/index.ts:614`). **Its absence is itself the fail-closed result** — the
   app-authority phase threw and the process refused to serve.
3. From inside the postgres container:
   `psql "$AOA_APP_DATABASE_URL" -c "select session_user, current_user, rolsuper, rolbypassrls from pg_roles where rolname=current_user"`
   → **require** `aoa_app | aoa_app | f | f`.
4. Same session, **no GUC set**: `select count(*) from jobs;` → **must be 0** even with rows
   present. Then `select set_config('aoa.organization_id','<ORG_B_UUID>',true); select count(*) from jobs where organization_id='<ORG_A_UUID>';` → **must be 0**.
5. Under the ORG_B GUC: `insert into jobs (organization_id, company_id) values ('<ORG_A>','<COMPANY_A>');`
   → **must fail with 42501, "new row violates row-level security policy"**.

**PASS** = the live serving credential is the same non-owner role the tests proved.
**FAIL** (any of 3–5) = the deployed path is not the one that was measured; DE-01 drops.

### Experiment B — is the audit gap total in a real deployment?

Same stack. Provoke the step-5 denial through a **real HTTP request** (a worker session
bearing ORG_B's claim submitting against an ORG_A job id), then search for a record:

- `docker compose logs postgres | grep "row-level security"` → expect a hit (ephemeral
  container stderr only, not a control-plane audit record).
- `psql "$DATABASE_URL" -c "select count(*) from activity_log where created_at > now() - interval '5 minutes'"`,
  and the same on `hub_audit` and `job_projection_receipts` → **expect ZERO rows attributable
  to the denial.**

**Expected (confirms `E0-F010`)** = zero durable rows. **If a durable row DOES appear**, the
audit sub-verdict is wrong and must be corrected in the register.

---

## DE-03 — Enrolled worker ↔ control-plane job/lease APIs (High)

### Experiment A — the replay denial in a real deployment

**Access:** a deployed control plane with `AOA_DISTRIBUTED_EXECUTION_ENABLED=1`, one enrolled
worker with a live device key, org-admin credentials for step 5, and read access to the
control-plane Postgres for step 3.

1. Capture one complete successful `POST /api/worker-control/poll`: the `Authorization: Bearer`
   header, all five `aoa-device-proof-*` headers, the `aoa-request-id`, and the exact body bytes.
2. Re-send it verbatim. **Expect HTTP 401** with a frozen `ProtocolErrorV1` body carrying
   `code: "unauthorized"`. **A 200 with an offer would refute delivery outright.**
3. Verify no side effect: `SELECT status FROM job_attempts WHERE id = <attempt>` unchanged, and
   `SELECT count(*) FROM worker_proof_replays WHERE proof_id = <captured proofId>` = **1, not 2**.
4. Wait past the session's `exp`, mint a fresh proof id, re-send. **Expect 401** (expiry, not replay).
5. `POST /api/organizations/:orgId/execution-targets/:targetId/revoke`, then poll with the
   still-unexpired session and a fresh proof id. **Expect 409 `target_revoked`.**

### Experiment B — the cheapest experiment that could overturn the audit sub-verdict

Run step 2 above, then tail the control-plane log for that request. **Expected**: exactly one
pino-http warn line reading `POST /api/worker-control/poll 401`, with **no** `workerId`, **no**
`organizationId` and **no** `reasonCode`, and **no** line with `action: "worker.*.denied"`.
If such a line *does* appear, `E0-F010`'s DE-03 row is wrong. Needs only a log tail.

---

## DE-04 — Worker ↔ attempt/lease fence (Critical)

Confirms a **named scope limit already recorded** in the row; it cannot change the verdict.

**Access:** an instance with `AOA_DISTRIBUTED_EXECUTION_ENABLED=1` and embedded or real PG.

1. Stage an input via `stageJobInputFiles` for job J attempt 1.
2. Poll + ACK to a live lease L.
3. `UPDATE leases SET status='released' WHERE id = L` — leave `execution_targets.device_generation` untouched.
4. `POST /api/worker-control/artifacts/transfer-grant` with the same session JWT and device
   proof, `operation:"download"`, the same leaseId/jobId/attempt/fenceToken, and the staged key.

**Predicted from source** (`server/src/services/artifact-transfer-grant.ts:184-185`, whose
comment says the download branch is *fence-independent*): **HTTP 200 `download_granted`** with a
working presigned GET. The contrast that makes it a proof rather than an anecdote:

- the same request with `operation:"upload"` **must** return `rejected:"stale_fence"`;
- with `UPDATE execution_targets SET device_generation = device_generation + 1` first, it
  **must** return `target_revoked`.

That triple is the precise reachability proof that reads survive fence loss while writes do not.

---

## DE-05 — Replaced/expired attempt ↔ authoritative result state (Critical)

**This one can refute the audit.** The register records that no shipped path can write a
quarantined artifact row (`E0-F011`). A non-zero count refutes the caller census.

**Access:** a control plane with `AOA_DISTRIBUTED_EXECUTION_ENABLED=1`, verified
`aoa_app`/`aoa_operator` pools, one enrolled worker daemon, and `psql` as `aoa_operator`.

1. Submit a distributed job; once the lease is active and the run is producing output, force
   fence loss **without a clean terminal**:
   `UPDATE leases SET expires_at = clock_timestamp() - interval '1 second', ack_deadline = clock_timestamp() - interval '2 seconds' WHERE id = '<leaseId>'`.
2. Let the 15s convergence sweeper (`server/src/index.ts:1349`) reap it, and let the worker run
   to completion so it produces output **after** the fence is gone.
3. `SELECT id, status, quarantine_reason, observed_lease_id FROM job_artifacts WHERE job_id = '<jobId>' AND status = 'quarantined';`

**Predicted: ZERO rows, on every run**, because no shipped code path calls
`runOrphanQuarantine`. Also expect `job_attempts.status = 'expired'` and any late worker write
refused — the immutability half holds while the quarantine half produces nothing.
**A non-zero row count refutes this audit** and must be reported: it would mean a producer
exists that the caller census missed.

---

## DE-06 — Control plane ↔ S3-compatible object store (Critical)

### Experiment (a) — extend the existing live-MinIO lane (no new access)

The D1 lane already runs MinIO-over-TLS with toxiproxy (`docker-compose.d1.yml`,
`tests/d1/e6f-05-live-minio.test.mjs`). Add a third assertion:

- after `ack`, `POST /api/worker-control/artifact-transfer-grants` with `operation:"upload"` and
  `expectedObjectKey = organizations/<A-DIFFERENT-ORG-UUID>/jobs/<jobId>/attempts/1/evil.bin`;
  assert **HTTP 200, `outcome:"rejected"`, `reason:"malformed"`, no `grant` key**, and then
  assert with the MinIO admin client that **no object exists** under that foreign prefix;
- repeat for `artifact_commit` with a manifest whose `organizationId` is the foreign org;
  assert rejected/malformed and **zero `job_artifacts` rows**.

### Experiment (b) — is the signing credential bucket-wide?

**Access:** the deployed control plane's S3 credentials and bucket name (an operator with
production/staging secret access).

Take the credential the control plane presigns with (`server/src/storage/s3-provider.ts:86-102`
— the `AOA_STORAGE_S3_*` / AWS env chain) and issue, **directly with that credential**,
`GetObject` on `organizations/<some-other-org>/jobs/<any>/attempts/1/<any>`.

**Expected, given no STS code path exists anywhere:** it succeeds, or returns `NoSuchKey`
rather than `AccessDenied` — either of which confirms the credential is bucket-wide and the
`authentication` clause ("scoped service identity") is **false in the deployed environment**,
not merely absent from source. `AccessDenied` on a foreign prefix would mean an out-of-band
IAM policy supplies the scoping, and that should be recorded.

---

## DE-07 — Control plane ↔ secret and MCP OAuth broker (Critical)

### Experiment A — has this crossing ever denied in a real deployment?

**Access:** the D1 harness or a staging control plane (`docker-compose.d1.yml` /
`docker-compose.staging.yml`, both `AOA_DISTRIBUTED_EXECUTION_ENABLED=true`), an enrolled worker
with a live device key, an Organization set to `mode:"canary"` in
`AOA_DISTRIBUTED_EXECUTION_ROLLOUT`, and a cloud-mode Company with a provider key so the mint
fires. **Blocker first:** staging currently fails closed at boot because it mints neither
`AOA_APP_DB_PASSWORD` nor `AOA_OPERATOR_DB_PASSWORD` (recorded in `scripts/finding-ownership.json`).

Place one job so a handle is minted, then, holding the live fence, `POST
/api/worker-control/execution-secrets/resolve` four times:

1. correct fence → **200 `outcome:"resolved"`**, `envTarget ANTHROPIC_API_KEY`;
2. after `execution_targets.device_generation` is bumped → **200 `outcome:"denied"`, `reason:"target_revoked"`**;
3. with a fence token from a different lease → **denied `stale_fence`**;
4. with a `handleId` belonging to another Organization → **denied `malformed`**, and critically
   **an identical response shape and timing to (3)** — no existence oracle.

Then `SELECT last_resolved_at, resolve_count FROM job_secret_handles` and
`SELECT * FROM secret_access_events WHERE consumer_id = <handleId>` to confirm the audit rows exist.

### Experiment B — is the revocation lever really dead?

Same environment. Attempt to revoke a live handle through **every** operator-facing surface —
UI, CLI, MCP, any admin route — **without writing SQL by hand**.

**Predicted:** no such surface exists, and no code path sets `status='revoked'` or `revoked_at`
(the single write chokepoint, `job-control.ts:3139`, cannot). **If an operator finds one, the
`E0-F011` DE-07 item is wrong and must be corrected.** If they cannot, the remediation is
either to ship a revoke mutator or to delete the dead clause — *a guard that nothing can arm is
the failure class this programme has already shipped three times.*

Neither experiment needs a paid model run; both need a container boot and an enrolled worker.

---

## DE-09 — Worker host ↔ provider sandbox (Critical)

**All three need a paid `E2B_API_KEY` and the keyed `workflow_dispatch` lane.** Experiment 3 is
the one that matters most, because it may show the clause is **unbuildable as written**.

**Boot:** `packages/adapter-manager/src/bin/adapter-manager.ts` with `E2B_API_KEY` set, the
template env set to `aoa-base`, `PORT=8090`, and `CONTROL_PLANE_PUBLIC_KEY_FILE` pointing at a
real ed25519 SPKI PEM.

### 1 — does the sandbox actually contain a host command?

`POST /op/create`, then `/op/execute` a probe and record:

- `id -u` and `capsh --print` — is the tenant root, and with which capabilities;
- `ls -la /`, `cat /proc/1/root/etc/hostname`, and an attempt to read any file under the
  adapter-manager host's working directory;
- `mount`;
- an HTTP POST **from inside the sandbox** to the adapter-manager's own `:8090/op/execute`
  carrying a forged or absent `OwnedLabelsCapability`.

**PASS** = no host path is readable, and the last probe returns the uniform
`ResourceNotAvailableError` rather than executing. This is the only way to turn the
`confidentiality` and `authorization` clauses from *structurally plausible* into *measured*.

### 2 — which template is actually created from?

The library default is `"base"` (`e2b-provider.ts:266`); the matrix pins `"aoa-base"`
(`capability-matrix.ts:63`). Assert on a **live** create that `sdk.create` received `aoa-base` —
via the E2B dashboard's sandbox metadata, or a template-only marker file baked into `aoa-base`
and `stat`'d from inside. **If it receives `base`, the pin is decorative on the keyed lane too**,
not only in the fixture.

### 3 — ★ can ANY capability restriction be expressed on e2b create?

`real-transport.ts:98-103` passes only `{apiKey, timeoutMs, metadata, envs}`. **Before anyone
writes an enforcement point for DE-09's `integrity` clause**, determine from the e2b SDK pinned
in `packages/sandbox-e2b-provider/package.json` and the template definition under `e2b/` whether
a user / capability / seccomp knob exists at all.

**If it does not, DE-09's `integrity` clause is not implementable as written and the register
row must be AMENDED — not marked delivered.** That is a founder decision. Recording "we cannot
enforce this at any available layer" is a legitimate and valuable outcome; quietly leaving the
clause asserted is not.

---

## DE-10 — Crashed worker ↔ provider resources (High)

**This is the only route to `delivered` for the destroy half.** The lease-fencing half is
already measured. The worker-side WRK-007 gap is a **code** gap (E4-D12 composition-root wiring)
and **no live access can settle it** — do not expect this experiment to touch it.

**Access:** the staging stack from `docker-compose.staging.yml` (control plane + adapter manager
on `control-net`), a real **billable** `E2B_API_KEY` and template, and the matched CP/AM ed25519
keypair.

### Setup — the four settings that exist in no manifest today

```
adapter-manager: AOA_ADAPTER_MANAGER_REAPER_ENABLED=1      # exactly "1" — "true" is OFF
                 AOA_ADAPTER_MANAGER_CONTROL_PLANE_URL=http://control-plane:3100
                 AOA_ADAPTER_MANAGER_REAPER_INTERVAL_MS=30000
control-plane (BOTH replicas): AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED=1
```

`AOA_ADAPTER_MANAGER_TRUTH_SHARED_SECRET` must already match on both, and does in the manifest.

### Positive control FIRST — prove the oracle hop is live, not 404

From the AM container:

```
curl -s -o /dev/null -w '%{http_code}' -X POST \
  http://control-plane:3100/api/adapter-manager-control/lease-truth \
  -H 'content-type: application/json' \
  -H "x-aoa-adapter-manager-truth: $AOA_ADAPTER_MANAGER_TRUTH_SHARED_SECRET" \
  -d '{"orgs":[{"organizationId":"<real-org-uuid>","leases":[{"leaseId":"<real-lease-uuid>"}]}]}'
```

**Must be 200 with a `verdicts` body. A 404 means an arm is still off and every subsequent
observation is vacuous.**

### The measurement

1. Run one real distributed attempt to completion of `create`, so a real E2B sandbox exists
   carrying a parsed 7-tuple `ResourceLabels` and a non-zero generation. (A sandbox failing
   `isStructurallyInterpretable`, `reconcile-reaper.ts:119-125`, is skipped by design and proves
   nothing.)
2. `SIGKILL` the worker container mid-`execute` — do not let it tear down.
3. Back-date the lease row and fire the reap (`POST /api/worker-control/_test/reap` with
   `AOA_D1_TEST_REAP_ENABLED=1`, or wait for the live MIG-002 loop) so `leases.status` becomes
   `expired` → `classifyLeaseTruthRow` returns `terminal`.
4. Wait 2 reaper intervals. **All three must hold:**
   - (a) the AM log line `reaper: orphan reclaim` with `cleanupStatus: "success"` for that
     sandboxId, and a sweep tally with `reaped >= 1`;
   - (b) the sandbox is **GONE from E2B by an INDEPENDENT read** — `e2b sandbox list` against
     the real API, **not** the AM's own `provider.list`, and **not** its `getInfo()` echo.
     ★ This is the DE-08 lesson: a read-back that returns your own value verifies what was
     declared, never what is enforced.
   - (c) the E2B billing/usage record for that sandbox stops accruing.
5. **NEGATIVE CONTROL** (proves the oracle, not the TTL, did the killing): repeat with a sandbox
   whose lease is still `active`, and assert it is **NOT** destroyed (`skipped` bucket). Without
   this, the 60s `DEFAULT_TTL_MS` (`e2b-provider.ts:78`) could be what actually reclaimed the
   sandbox in step 4, and the reaper would be credited for the provider's own timeout.
6. Re-run convergence: fire a second sweep and assert no double-kill and a stable tally.

Only (a)+(b)+(c)+(5) **together** upgrade the second conjunct of DE-10's `revocation` clause.

---

## DE-11 — Browser-session workload ↔ sensitive artifacts (High)

Both checks are **read-only, cost nothing, and need only read access to the deployed bucket.**

★ **Corrected 2026-09-09 (W22).** This paragraph used to say *"neither can change the audit or
revocation verdicts … only (a) could change the encryption verdict"*, and it contradicted the
entry directly below it, which says in as many words that (b) would confirm *"the `revocation`
clause has no out-of-band implementation **either**"* — a check that can confirm an absence can
equally refute it.

★★ **Corrected again 2026-09-09 (W22B), on external review, and this is the more important
correction: THE UNIT IS THE CONJUNCT, NOT THE CLAUSE.** The paragraph W22 wrote here said (a)
and (b) "settle three of DE-11's four clauses" and that all three were now `UNKNOWN`. That
over-corrected. What they actually settle is **two clauses and one half**:

- **`confidentiality`** — "sensitive browser artifacts are encrypted **and** TTL-bounded".
  Both halves are bucket-settable, so **(a) and (b) settle the whole clause**; it is `UNKNOWN`.
- **`revocation`** — "**TTL expiry and job completion** purge sensitive artifacts". Only the
  first half is bucket-settable. **(b) settles the TTL-expiry half → `UNKNOWN`. The
  job-completion half is a MEASURED ABSENCE and stays one whatever (b) returns**, because an
  S3 expiration rule fires on object age plus prefix/tag and *cannot observe job completion* —
  nothing in the commit path writes a completion-derived tag, and no code calls
  `PutBucketLifecycle` to install one. The application half is structurally refused
  (`isSweepEligible` rejects `status='committed'`).
- **`audit`** — untouchable by either check; the record it names is an application artefact and
  no bucket setting supplies it. Measured absent.

So: **`audit` absent, half of `revocation` absent, and two and a half sub-properties `UNKNOWN`
pending this inspection.**

- **(a) Encryption at rest.** `aws s3api get-bucket-encryption --bucket <artifact-bucket>`.
  A `ServerSideEncryptionConfiguration` means the bytes are encrypted by bucket policy even
  though the application code never asks — the **only** way this clause could turn out
  delivered, since `PutObjectCommand` provably never sets it. `NoSuchEncryptionConfiguration`
  confirms plaintext at rest.
- **(b) Lifecycle purge.** `aws s3api get-bucket-lifecycle-configuration --bucket <artifact-bucket>`.
  A `NoSuchLifecycleConfiguration` error confirms the **TTL-expiry** half of `revocation` — and
  the TTL half of `confidentiality` — has no out-of-band implementation either. An expiration
  rule that *is* present refutes those two halves and **still leaves purge-on-job-completion
  absent**; do not read a green (b) as settling the clause.

---

## DE-12 — Service desired-state ↔ reconciled instances (Critical)

**No live access can settle anything here, and that is not a hedge.** You cannot measure a
reconciler that has no file, and `services.generation` has **no writer** to trigger a rollover
with. The five absences are settled statically. Two things a live run would add, neither
load-bearing, recorded so nobody re-derives them:

- **(a)** To confirm production-unreachability empirically rather than by grep: on a
  `distributedExecutionEnabled` instance, POST the job-control submission route with
  `source: {kind:"service_reconcile", serviceId:<any>, generation:1, reconciliationId:<uuid>}`
  as each of the four authenticable actor types (board user, agent key, MCP key, Commander run
  JWT). **Expect 403 from the requester-kind gate (`job-submission.ts:164-166`), never from the
  generation gate**, and `SELECT count(*) FROM jobs WHERE source_kind='service_reconcile'` = 0.
- **(b)** The experiment that would actually settle DE-12 **does not exist yet and cannot be run
  until SVC-002/003/005 are written**: a D4 canary that (1) runs a service at generation N,
  (2) bumps `services.generation` to N+1, and (3) shows the N-generation instance's next
  governed write is refused and its lease revoked. Today step (2) has no code path and step (3)
  has no fence to test. **That is DE-12's exit criterion, not an access request.**

---

## DE-13 — Shared scheduler ↔ per-Organization workloads (High)

The quota half is settled. Live access is needed only to close **REL-002's acceptance** — *"One
noisy Organization cannot starve another"* — which no amount of source reading can settle,
because the scheduler's ordering has no tenant dimension and the outcome depends on fleet size
versus aggregate org caps. **REL-002 has zero files on disk**; this experiment is what it would
have to contain.

**Access:** a two-replica control plane on the D1 compose topology (`tests/d1`,
`docker-compose.d1.yml`).

1. Provision N worker targets and two organizations A and B. Set
   `UPDATE organizations SET concurrency_cap = <k> WHERE id = ...` **by raw SQL** for each —
   there is no API, UI or CLI for this; `organizations.concurrency_cap` has exactly one reader
   and **no writer anywhere**. Choose k_A + k_B > N so the fleet is genuinely oversubscribed.
2. Submit a deep backlog for A first (say 5 × k_A jobs, so 4/5 are rejected 429 and k_A queue),
   let A's attempts take the head of the queue, then submit a **single** job for B.
3. Measure B's time-to-first-offer, and instrument the candidate claim
   (`packages/db/src/repositories/tenant/job-control.ts:1981`) to record the organization of each
   offered attempt.
   **Prediction:** because the ORDER BY is `availableAt, priority DESC, createdAt, id` with no
   org term, B waits behind every one of A's k_A in-flight attempts, bounded only by k_A and by
   attempt duration. **That window IS the starvation the clause asserts cannot happen.**
   **PASS criterion REL-002 needs:** a bounded B latency *independent of A's backlog depth*.
4. Separately, to test whether the shipped throttle can ever bind: set
   `AOA_WORKER_POLL_RATE_LIMIT_MAX` to a realistic value (the default 100,000/60s cannot fire)
   and confirm the `throttled` 429 (`worker-control.ts:414`) appears in A's poll stream while B
   still progresses.
5. For the audit gap **no live access is needed** — the absence is settled in source. But note
   for whoever runs this: step 2's 429s produce only `reasonCode: "job_submission_rejected"` log
   lines with no cap and no usage, and step 4's throttles produce **no log line at all**, so this
   experiment currently **cannot be reconstructed from the deployment's own records**.

---

## DE-14 — Hosted startup ↔ process-wide unsafe override (Critical)

**Nothing is owed.** The deny path was taken at tip by calling the real exported
`assertHostedExecutionStartupSafe` directly: `cloud_auth` + `"1"`, `"on"` and `"banana"` all
threw (the last on the boolean parse — it fails closed on garbage), while the positive controls
held: `cloud_auth` + `"0"`, `cloud_auth` unset, `local_trusted` + `"1"` and `authenticated` +
`"1"` all passed, the last three by design. It has exactly one production caller
(`server/src/config.ts:198`) reached at module top level of the entrypoint
(`server/src/index.ts:164`) with no `try/catch`.

The only absent clause is `audit` ("the startup safety-assertion outcome is logged"), and that
is settled in source: the module imports no logger and contains no logging call at all.

★ **AMENDED 2026-09-10 — THAT CLAUSE IS NO LONGER ABSENT, AND THIS SECTION STILL OWES NOTHING.**
`assertHostedExecutionStartupSafe` now returns an outcome on the pass and throws a typed error
carrying its branch's own machine reason on the refusal, and `loadConfigWithStartupSafetyAudit`
(`server/src/config/hosted-execution-startup-audit.ts`) — the entrypoint's single production
caller — logs both directions before rethrowing the refusal unchanged. Both config modules are
still logger-free; the sink is injected. Nothing here becomes a live experiment: the clause asks
for a **log**, the assertion fires before any database pool exists, and no live access was ever
required to settle it. **The paragraph above is kept because the correction is only legible
against it**, and the reason it says "no `try/catch`" is not the reason DE-14 stayed open — a
top-level call is not an uncatchable call. See "★ DE-14 IS CLOSED" under `E0-F010` in
`docs/replatform/epics/E0-foundation/findings.md`.

---

## DE-15 — Image registry ↔ worker runtime (Critical)

Two enforcement points exist and **neither is at this boundary**. Nothing verifies a signature
or a digest before a container runs.

### Experiment A — demonstrate the absence of runtime image admission end to end

**Access:** Docker and a local registry. No paid resource; about ten minutes.

1. `bash docker/images/build.sh` (produces `docker/images/digests.env`; note CI never proceeds
   past this step). Do **not** run `sign.sh`; confirm `docker/images/allowlist.json` still has
   `"entries": []`.
2. Set `AOA_D1_WORKER_IMAGE=aoa-worker:some-floating-tag` — a **mutable tag, not a digest** — in
   `docker/d1/.env`.
3. `node scripts/check-d1-compose.mjs`.

**Delivered** would be a non-zero exit naming the unsigned, non-allowlisted tag.
**Not delivered** is **exit 0**, which `scripts/lib/d1-compose-invariants.mjs:437-451`
guarantees, because that validator substring-matches the env-var *name* in the `image:` field
and never inspects its value. Then `docker compose -f docker-compose.d1.yml up` and confirm the
worker starts: nothing consults `evaluateAdmission`, and no process reads `allowlist.json`.
A green step 3 **lowers** the authentication/authorization/integrity clauses from `partial`.

### Experiment B — the kill-switch drain on real PostgreSQL

**Access:** a Linux box (embedded-postgres cannot start under a deep Windows path).
`pnpm -C server exec vitest run src/__tests__/execution-kill-switch-poll.integration.test.ts`.
**Delivered** for the revocation clause: with `instance_settings.kill_switches` naming the
target's provider, `poll()` returns `outcome:"drain"` with `retryAfterMs === 30000` **and the
`leases` table gains no row**, while `ack` and `renew` still succeed.

★ **Nothing can settle this row as chartered until a prior decision is taken:** "image" is not a
kill-switch dimension today, and no experiment can prove a control that has no axis.

---

## DE-16 — Hosted parent process ↔ plugin worker and runtime surfaces (Critical)

The code-execution boundary is **settled and strong** — six typed sinks, a composition-root
split, and a 14-mutant corpus in required CI. One clause is genuinely unmeasured.

**Access:** a PostgreSQL database plus a server booted with `deploymentMode=cloud_auth`.

1. Seed the `plugins` table with rows in each non-terminal status — `ready`, `installed`, and
   `error` with a **non-cloud** `statusReasonCode` — plus one `uninstalled` control row.
2. Boot with `cloud_auth`, so the cloud reconcile branch runs.
3. Assert `reconcileCloudBlockedPlugins` returns the count of non-uninstalled rows and that each
   now reads `status='error'`, `status_reason_code='PLUGIN_WORKER_BLOCKED_IN_CLOUD'`, while the
   `uninstalled` control row is **untouched**.
4. Idempotency: boot a second time and assert the return count is `0`.

**NEGATIVE CONTROL, without which this proves nothing:** boot the same seeded database with
`deploymentMode=local_trusted` and assert the function returns `0` and mutates no row.

**Delivered** for the `revocation` clause = steps 3, 4 and the negative control all hold.
**Not delivered** = any non-terminal row survives, or the `local_trusted` boot mutates anything.
This is a DB-write proof, not a code-execution proof; the execution boundary does not depend on it.
The row's `audit` clause needs **code, not access** — a durable record, since today's block is a
`logger.warn` plus process-memory counters that reset on restart.

---

## DE-17 — Provider manager ↔ expired/replaced resource (Critical)

### Experiment 1 — does a fence-lost but unexpired capability still execute?

**Access:** the `docker-compose.staging.yml` stack with a real `AOA_STAGING_E2B_API_KEY` and
template, the mounted control-plane keypair (verify first with `pnpm verify:cp-am-keypair`), and
DB access to the lease table. **Cost:** one real E2B sandbox for the run's length.

1. Start a distributed run; capture the `OwnedLabelsCapability` minted in the sandbox-local
   resolve reply and note its `expiresAt`.
2. Kill the lease server-side — mark it lost/replaced — **while `expiresAt` is still in the
   future** (the 5-minute default TTL gives ample window).
3. From outside the worker, `POST /op/execute` to the adapter-manager with that same capability.

**Not delivered** (and predicted from source): HTTP 200 with an `executed` envelope — effect
authority exercised under a dead fence, because the capability type has no operation or scope
field. **Any other result means a revocation path exists that the audit missed**, and the
sub-verdict must be re-measured. Record the exact response body either way.

### Experiment 2 — is a fence-lost orphan actually reclaimed?

Same stack, plus the E2B dashboard or `list` against the provider-control credential.

1. Start a run whose lease deadline is shorter than the run, so the supervisor records an orphan.
2. With `AOA_ADAPTER_MANAGER_REAPER_ENABLED` **unset** (the staging default), wait past
   `DEFAULT_REAPER_INTERVAL_MS` (30s) and confirm the sandbox is **still alive and still billing**.
3. Restart with `AOA_ADAPTER_MANAGER_REAPER_ENABLED=1` **and** `AOA_ADAPTER_MANAGER_CONTROL_PLANE_URL`
   set, repeat, and confirm the AM `/metrics` reaper counter increments and the sandbox is reclaimed.

**Delivered** = (2) leaks and (3) reclaims. ★ (3) would be the **first time the reaper loop has
ever run against a real control plane** — treat its first sweep as unproven and watch for
mass-kill, because the real provider's `list` ignores the ownership selector.

**Not worth an experiment:** the dead deadline and the missing denial audit are settled by caller
counts and empty greps. No live run can make a function with no callers fire.

---

## DE-18 — Placement/target registry ↔ worker admission (Critical)

**Access:** a Linux box with Docker and the `docker-compose.d1.yml` stack up, plus `AOA_D1_LIVE=1`.
Write it as a new `tests/d1/e6f-15-target-generation-replacement.test.mjs` on the existing harness.

1. Enrol worker-b, poll to an offer, ack to an **active** lease; record `{leaseId, fenceToken, jobId, attempt}`.
2. **POSITIVE CONTROL:** with that fence, POST one governed op and assert HTTP 200.
3. Out of band, `UPDATE execution_targets SET device_generation = device_generation + 1 WHERE id = <targetId>`.
4. Replay the **identical** governed op with the same fence; assert the wire error is `target_revoked`.
5. Replay the poll with the pre-bump session token; assert `target_revoked` — this exercises
   `server/src/middleware/worker-session-auth.ts:166` over real HTTP, which no current test does.
6. Assert no new `leases` row was created after step 3.

**Delivered** for the fence = step 2 is 200 **and** steps 4/5 are `target_revoked`.

### The convergence leg (now WIRED — the thing to measure)

★ **Updated:** the fanout is no longer unwired. PR #418 constructs
`createExecutionTargetRevocationFanout` (`server/src/index.ts:1352`) and ticks it on the shared
MIG-002 convergence timer (`server/src/index.ts:1424`), **inside the distributed-execution flag
block** — so a **flag-off default boot runs no convergence at all** (flag-off allocates no
`aoa_app` pool, so `runInTenant` has nothing to open), while a flag-on boot drains the same
durable `status:'pending'` `execution_target_revocations` rows the live producer writes.

So this leg is now a **live measurement, not a holding prediction**: with the flag **ON**, after
step 3 wait past one convergence interval and assert the wired fanout actually **retires** the
revocation — the stale lease moves off `offered`/`active` (its capacity released, the pinned job
cancelled) and the revocation row leaves `pending`. That end-to-end convergence is exactly what
DE-18's `deliveryStatus` awaits, and it has not yet been observed live; **do not record it as
proven from the wiring alone** — the point of the run is to see the durable rows change. With the
flag **OFF** (the default), assert the opposite: no convergence runs, so the row stays `pending`,
confirming the fanout is correctly gated. If the revocation is issued through the
`POST …/execution-targets/:id/revoke` route instead, additionally assert that **no**
`execution_target_revocations` row is created at all — the second, undocumented revoke path.

---

## DE-19 — Worker/sandbox ↔ control-plane memory/context API (Critical)

★ **Read the boundary first.** The distributed worker lane is **not instantiated**, so there is
nothing to deny there. Everything below is about the sandbox → MCP-broker lane.

### Experiment A — does the env allowlist hold in a REAL sandbox?

**Access:** a `cloud_auth` deployment with a real E2B key and a company provider key (a paid run).
Dispatch one crew task to an `aoa` agent whose environment resolves driver `sandbox`; inside the
VM run `env | sort` and `cat ~/.claude.json` (or `$CODEX_HOME/config.toml`).
**Delivered:** no `DATABASE_URL`, no `postgres://`, no `AOA_AGENT_JWT_SECRET`, no `GITHUB_PAT`,
and the `aoa` MCP entry is `type:"http"` pointing at `$AOA_API_URL/companies/<cid>/mcp`.
**Not delivered:** any of those present. This is the only way to prove
`packages/adapter-utils/src/execution-target.ts:680` is the sole env source in the **deployed
image**, rather than only in the code path CI exercises.

### Experiment B — stale-run replay (settles `revocation` by measurement, not by absence)

Same deployment, no new code. Capture the `AOA_API_KEY` the sandbox holds (from A), let the run
finish and the lease release, then **from outside the sandbox** POST to
`/companies/<cid>/mcp` with that bearer and `memory.search`.
**Not delivered** (predicted): HTTP 200 with real memory items, for up to
`AOA_AGENT_JWT_TTL_SECONDS` (default 172800s = 48h) after the run ended.
**Delivered:** 401/403 — which would mean a revocation exists that the source read missed, and
the sub-control must be re-audited.

### Experiment C — worker-write reach (settles `integrity` with a live denial)

Same token and endpoint: call `memory.write` from an org agent whose heartbeat tool allowlist
contains only `query_memory`. **Not delivered** (predicted): 200 with a created row at status
`pending`, proving the outbound fallthrough bypasses the per-agent allowlist. Then repeat with
`memory.retain` + `scopeToSelf:true, layer:"working"` and check the row's status (predicted:
`approved`). **Clean up both rows afterwards.**

---

## DE-20 — Legacy execution path ↔ distributed owner (Critical)

**Access:** the `docker-compose.staging.yml` stack (control-plane replica + migrate + one enrolled
worker), operator shell on the control-plane container, `psql` as `aoa_operator`, and a **real**
sandbox provider — ★ a fake provider cannot settle this, because a keyless lane is ungated.

### Experiment 1 — does the legacy executor actually stop?

Create one Organization and one task on a `claude_local` agent; set
`AOA_DISTRIBUTED_EXECUTION_ROLLOUT` to canary that org (no restart needed — the source re-reads
per call); enrol a worker and turn dispatch on. ★ `scripts/lib/staging-manifest-invariants.mjs:522-545`
**forbids** the worker dispatch/provider variables on any staging worker, so this needs a
deliberate, attributable compose diff. Wake the task.
**Delivered:** the log shows `[CLI-006] canary execution owner = DISTRIBUTED`,
`heartbeat_runs.execution_owner='distributed'`, `job_attempts.placement_lease_eligible=true`, the
worker leases and runs it, **and the legacy adapter never spawns** (zero adapter/stdout
`heartbeat_run_events` rows and no CLI process on the host for that run id).
**Not delivered:** both executors produce output.

### Experiment 2 — rollback (the clause rated absent)

With that run still in flight, delete the org key from the rollout dial.
**Predicted from source:** the in-flight distributed run **continues to completion and no code
path cancels it**, because `createDistributedExecutionDrain` has no invoker; only the *next* wake
resolves `rollout_not_canary`. **Measure the wall-clock gap between the dial flip and the attempt
reaching a terminal — that gap is the true RTO the row's word "atomically" denies exists.**

### Experiment 3 — audit

`SELECT event_type, payload FROM heartbeat_run_events WHERE run_id = $1`. Confirm (as source
predicts) exactly one `distributed_execution_handoff` row for the distributed run, **no durable
row at all** for a legacy-selected run, and nothing in `activity_log` for either.

⚠ **Do not run any of this against an Organization whose spend must be capped:** a handed-off run
writes no `cost_events` row, so every budget control is blind to it.

---

## DE-21 — Realtime broker ↔ tenant subscribers (High)

Both experiments run on the existing two-replica `docker-compose.d1.yml` stack. No paid resource.
Neither is needed to accept `partial`; the `audit` sub-control needs a **writer**, not an experiment.

### Experiment A — close the untested primary deny arm

Seed two companies in **different** organizations; mint an agent API key for company A. Open
`ws://<control-plane-b>/api/companies/<companyB-id>/events/ws` with company A's bearer.
**Delivered:** HTTP 403 `forbidden` on the upgrade. Then reconnect with `?sinceSeq=0` against
company A's own id while company B has appended rows, and assert every received frame carries a
company-A `companyId`. `MIG-003-result.md` already names this as the missing leg, so it belongs in
a new `tests/d1/e6f-15-*.test.mjs`.

### Experiment B — characterise the company-level predicate within one organization

Seed **two companies under the same organization**. Under `aoa_app` with `aoa.organization_id` set
to that org, `SELECT count(*) FROM live_event_log WHERE company_id = '<companyB>'` from a session
doing company-A work. **Expect the rows to be visible to the role** — that is the point: it
documents that the application `WHERE company_id = …` is the **only** company-level boundary, so
any future caller that forgets it leaks within the organization. A characterisation test, not a bug hunt.

---

## DE-22 — Execution telemetry ↔ append-only evidence store (High)

The docs-ledger half is settled (and already broken in this repository's history), and the runtime
half is settled against real embedded PostgreSQL. One residual is live-only.

**The residual:** no deny on the runtime path has ever been observed in a **deployed** system.
`POST /worker-control/events` mounts only behind the distributed-execution flag, which has zero
deployment hits. All deny evidence is CI.

**Access:** a live control plane, one enrolled worker, and a paid/managed provider run.

1. Boot with `AOA_DISTRIBUTED_EXECUTION_ENABLED=1`, distinct `aoa_app`/`aoa_operator` pools, and a
   ≥32-byte `AOA_WORKER_SESSION_SIGNING_KEY`.
2. Enrol a worker, lease one job, POST events at seq 1 and 2; confirm `status:"accepted"`,
   `acceptedThroughSeq: 2`, and two `job_events` rows.
3. **OVERWRITE ATTEMPT:** re-POST seq 1 with a fresh eventId and a self-consistent digest over a
   *different* payload. **Delivered:** ack `status:"hash_mismatch"`, `acceptedThroughSeq: 2`, and
   the seq-1 row **byte-identical** (compare `event_digest`).
4. **NEGATIVE CONTROL for `revocation`:** as `aoa_app` with the run's org GUC set, issue
   `UPDATE job_events SET event = '{}'::jsonb WHERE sequence = 1;` then
   `DELETE FROM job_events WHERE sequence = 2;`. **Both are expected to SUCCEED.** If they do, the
   append-only property is confirmed to be **code discipline only**, and the fix is a migration
   narrowing the grant to `SELECT, INSERT`.

**The docs-ledger half needs no live access at all:** wire `checkEvidenceImmutability` to a caller
(a CI step that materialises the merge-base tree via `git worktree add` / `git archive` and calls
it with `(base, HEAD)`), then re-run it over commit pair `6fc46988a` → `4379a2c53` as a **positive
control**. If that pair does not red, the wiring is wrong.

---

## DE-23 — Backup/restore pipeline ↔ tenant data (Critical)

★ **Nothing here can raise the verdict, and an operator should read that before spending on it.**
The absence of any tenant parameter, deny line or production caller is settled statically, and no
live run can make an absent control deny. **Even a fully green rehearsal leaves DE-23 at `partial`
at best** — it exercises integrity-after-restore only. The steps that would settle the other four
arms do not exist to run: there is no scoped restore identity to authenticate, no tenant-scoped
restore to reject, no per-tenant key to verify, no restore grant to expire, and no audit row
to read back. Those need **code first**.

★ **One exception, corrected 2026-09-09 (W22), and it is the DE-11 defect one row over.** The
register used to list *"no encryption at rest"* among DE-23's settled absences. Source can rule
out **per-tenant keys** — that needs a key parameter `RunDatabaseBackupOptions` does not have —
but it cannot rule out **encryption at rest**, because an encrypted volume, an encrypted
filesystem, or an object store with default SSE encrypts the dump with no application code at
all. **Only that half reads `UNKNOWN`** (corrected again by W22B — the clause is the conjunction
"encrypted at rest **with keys scoped per tenant**", and marking the whole of it unknown
discarded a control already established as missing). Settling the generic half is an inspection
of wherever the deployment writes the file, not a rehearsal step — and **it cannot satisfy the
conjunction**, because the documented invocation dumps every tenant into one file that no
per-tenant key can cover. **It changes nothing about the verdict**: the other five absences are
missing tenant *decisions*, and no storage setting supplies a decision or a key selection.

The crossing's own chartered verification is nonetheless an **owed operator leg**.

**Access:** the D5 staging topology (2 control-plane replicas, ≥4 workers across 2 failure domains,
external PostgreSQL, external object store, managed secret store), operator-held DB URL and
object-store keys, and spend authorization. Follow `REL-003-dr-rehearsal-runbook.md` exactly:

1. Baseline the `job_artifacts status='committed'` manifest.
2. Run the CM-015 pre-0188 preflight with `AOA_0188_CUTOVER_OPT_IN=1`; capture `snapshot_ref` and
   `snapshot_checksum`.
3. `aoa db:backup --json` plus an object-store snapshot at a recorded `T_fault`.
4. Restore via the E11-F002 interim invocation.
5. Migrate forward to the candidate.
6. Hand-wire `runManifestReconciliation` with `rows` = the committed `job_artifacts` set and
   `headObject` = the live `StorageProvider.headObject`; assert verdict `recovered`.
7. Inject the DR04 fault (delete one authoritative object, flip a byte in another) and assert
   verdict `failed`, with those two in `quarantined`/`missing` and **neither in `promoted`**.
8. Rolling-deploy at parallelism 1; re-enrol one worker, revoke one, and drive the revocation
   fanout. A production scheduler now exists — PR #418 ticks the fanout on the shared MIG-002
   convergence timer inside the distributed-execution flag block (`server/src/index.ts:1424`), so
   with the flag **on** the deployed boot converges it on its own; **hand-tick only if the
   rehearsal runs flag-off** (default), where no convergence timer starts.
9. Timed rollback, asserting that **marker-row deletion alone is not a rollback**.

Record RPO ≤ 15min and RTO ≤ 4h against D5-DR02/DR03.

---

## DE-24 — Desktop installer/updater ↔ enrolled desktop host (Critical)

★ **This row is blocked on code, not on access.** The residue that needs live/paid resources is
only the operator half — production code-signing certificates and Apple notarization credentials,
macOS hardware for the advertised-OS matrix, and the D6 production-beta campaign (14 consecutive
days across ≥3 external design-partner Organizations) — **and none of it can be attempted until
the code gap closes.**

**The work that actually moves DE-24, in order, all local and free:**

1. Build a link-free staging root (a bundler or a link-dereferencing copy step) so
   `node scripts/build-desktop-staging.mjs --root <root> --version 0.1.0 --platform win32` exits 0.
2. Wire a host-side updater that **calls** `evaluateUpdateAdmission` and feeds its verdict into
   `planUpdateSwap`'s `admitted`, plus a real health poller against the `GET /healthz` DSK-003
   ships, plus a real `installedVersions` enumeration of the versions directory.
3. Wire `runDrainBeforeSwap` into that updater.
4. Add the audit emission for install/update/drain/rollback, which today has **no sink at all**.
5. Put `check-release-admission.mjs` on the actual publish path in `docker.yml`, with release roots
   and a recorded allowlist.

**THE ACCEPTANCE TEST that would flip DE-24 to `delivered`** — runnable on **one Windows box with
no paid resource**, once (2) exists: install version A, present version B signed for a *different*
from-version (a replayed transition), and show the host **refuses** with `signature_invalid` and
the pointer file still names A. Repeat with B on the deny-list (expect `version_revoked`) and with
a valid B whose health check fails (expect the pointer unmoved, `health_unconfirmed`).
**Until a host binary can be handed a tampered update and observed refusing it, no amount of
unit-green changes this row.**

---

## DE-25 — Desktop worker ↔ local folder grants (High)

★ **Nothing live is needed or would help.** Caller counts are static facts, and the absence of a
`revoked_at` writer, an expiry column, an offline-policy consumer and any audit emission are all
whole-repo scans. No control plane, sandbox or paid run changes any of it; a live run would merely
re-demonstrate that the folder-grant resolver is never entered.

**If an operator nonetheless wants a positive control before this row is ever moved toward
`delivered`, the minimum is:**

1. Wire a production caller of `createFolderGrantService().admitCapture` into whatever staging
   path is built.
2. Add an anti-orphan directory-walk test in the style of `scripts/check-guard-inventory.mjs`
   asserting that `createFolderGrantService`, `bindGrantToDevice` and `admitCapturedPaths` each
   have ≥ 1 **non-test** caller — **this is the check that would have caught it.**
3. Run a desktop worker enrolled as target A, present a grant issued to target B, and assert the
   capture is refused with `wrong_target` **and that the refusal is persisted somewhere
   queryable** — which requires building the audit sink that does not exist.
4. Revoke the grant through a revoke path that must first be written, and re-run to assert
   `grant_absent`.

---

## DE-26 — Managed provider sandbox ↔ tenant workload, real provider (Critical)

★ **Both experiments are settleable this week from a GitHub runner** — no staging fleet, no
deployed control plane, no local key.

**Access:** the existing repo secret `E2B_API_KEY`, and
`gh workflow run keyed-e2b-conformance.yml --ref <branch>`.

### Experiment A — is `ownershipSelector` inert on real E2B?

Add a keyed case to `packages/sandbox-e2b-provider/src/__tests__/keyed-real-e2b.test.ts` that
(1) creates sandbox X with `resourceLabels.organizationId = "org-A"` and sandbox Y with `"org-B"`
(distinct `leaseId`/`jobId` too); (2) calls `provider.list({ownershipSelector: {organizationId:"org-A", …}, pageSize: 100}, ctx)`;
(3) asserts **Y is absent**.
**Predicted: the assertion FAILS and Y is present**, because `e2b-provider.ts:414` drops the
selector. **A failing run is the measurement**, and it converts the `reconcile-reaper.ts:104-106`
comment from an assertion into evidence. On the same page, assert X's parsed
`resourceLabels.leaseId` round-trips non-empty — if it comes back `{}`, the reaper's structural
pre-filter skips every real sandbox and Option-A reclamation is dead on arrival.

### Experiment B — the actual DE-26 control

Add a keyed case that runs the **certified suite against the real transport**:
`runSandboxIsolationConformance` over `perOpToInvokeDriver(new E2bSandboxProvider({transport: new RealE2bTransport(), templateId: TEMPLATE}), …)`,
then `assertIsolationReport(report)`, and **record which of the 8 checks pass, fail, or are
unsupported**. Expect the transport-fault-dependent checks (destroy-failure ceiling, egress
classification, crash/outage) to fail or be unsupported, because they ride synthetic fault
directives the real transport ignores. **That per-check breakdown IS the missing artifact**, and
it is what turns DE-26 from `not-delivered` into a measured `partial` with a named residue.

⚠ **REQUIRED IN BOTH CASES:** add the skip-detection step to `keyed-e2b-conformance.yml` (copy the
pattern from `keyed-e2b-w7u1-output-probe.yml:223-230`) **before trusting any green from that
lane**, and record the run URL.

**Not settleable this way** (genuinely needs the fleet and real spend): the D2 gate itself — three
consecutive passing runs on one release candidate, ≥120 jobs across six classes, the
cancellation/cleanup percentiles, and the verified E2B limit matrix.

---

## DE-27 — Control-plane replica ↔ shared admission state (High)

### Experiment A — the only one that turns "fail-closed by construction" into a measurement

★ The existing E6F-11 gate cuts the **worker → control-plane-b** link, i.e. the *client* side. It
never cuts **replica-B → PostgreSQL**, which is the partition the `revocation` clause is about.

**Access:** the existing `docker-compose.d1.yml` stack. No new infrastructure, no paid resource —
it already routes through toxiproxy. Add a `control-plane-b-to-postgres` proxy mirroring the
existing `worker-to-control-plane-b` one, then, in a new gate in `tests/d1/e6f-11-two-replica.test.mjs`:

1. Seed one org and one job, enrol a worker, prove **poll@B offers** (baseline reachability).
2. `setProxyEnabled({proxy:"control-plane-b-to-postgres", enabled:false})`.
3. `POST /api/worker-control/poll` at replica B. **Delivered:** 429 `throttled` or 503
   `internal_unavailable` — and specifically **not** a 200 `offer`.
4. Assert via the owner-DB probe that **no** new lease row was created while B was partitioned.
5. Submit a job through replica B and assert it does not commit, proving the capacity claim could
   not be smuggled.
6. Restore the proxy in a `finally` and assert B recovers.

### Experiment B — runtime cross-tenant denial for the admission table (cheap, local, unwritten)

Extend `server/src/__tests__/worker-admission-rate-limit.integration.test.ts`: admit under ORG_A,
then open `runInTenant(appDb, ORG_B, …)` and assert (i) a SELECT over
`worker_admission_rate_limits` returns **zero** rows for ORG_A's window, and (ii) an INSERT
carrying ORG_A's `organization_id` under ORG_B's GUC is rejected by the `WITH CHECK`. Today only
the catalog **shape** is verified at boot; the policy's runtime refusal on this table is unexhibited.

### Experiment C — verificationLane D5 as written

Needs real staging: ≥2 replicas behind a production load balancer, ≥4 workers across two failure
domains, external managed PostgreSQL and object store, shared broker and admission store, managed
secret store, production-equivalent TLS/telemetry/backup/image policy. The DE-27 assertions are
**D5-HA01** (kill one replica mid-flight under sustained submit+poll load: zero accepted-write
loss, zero double execution — for every `jobId`, exactly one lease row and exactly one terminal
event), **D5-HA02** (failover RTO ≤ 60s, accepted-mutation RPO = 0) and **D5-L06**. This cannot be
simulated on D1 and is blocked on REL-002, which has zero files.

---

## DE-28 — Quarantined late output ↔ authoritative result/checkpoint (Critical)

### Experiment A — settle confidentiality at the STORE rather than at the key

**Access:** a flag-on stack against a real object store (MinIO for D1, or the deployed bucket), the
stack's `AOA_WORKER_SESSION_SIGNING_KEY`, an enrolled device key, and network reach to the bucket.

Mint a quarantine PUT grant via `POST /api/worker-control/quarantine/grant` with a valid device
proof, then attempt (i) an **anonymous GET** of the resulting
`quarantine/organizations/<org>/jobs/<job>/attempts/<n>/<name>` key with no presign, and (ii) an
ordinary `artifact_transfer` **download** grant naming that same key.
**Delivered:** (i) 403 from the store, (ii) `rejected{malformed}` from the transfer-grant path.
**If (i) succeeds, the "isolated under the quarantine prefix" clause is prefix-naming only and
DE-28 drops further.**

### Experiment B — can late output ever be routed? (not a live experiment)

★ This **cannot be tested live today, because no shipped code produces it.** The experiment is a
code change, not an access request: inject `quarantineCandidates` from a durable enumeration and
construct a reconciler in `bin/worker-daemon.ts`. **Until then, any live D1 run will show zero
quarantine traffic, and an operator must not read that silence as the control working.**

---

## DE-29 — Secret/OAuth broker ↔ tenant owner credentials (Critical)

### Experiment 1 — the dead lever against a running system

**Access:** a dev/staging control plane. **No paid resource.** Boot with
`AOA_DISTRIBUTED_EXECUTION_ENABLED=1`, the `aoa_app`/`aoa_operator` pools and
`AOA_WORKER_SESSION_SIGNING_KEY` (the app hard-fails without them). Submit one real cloud-mode
agent-backed job so a handle is minted, then:

`SELECT handle, ref_kind, owner_principal_kind, owner_principal_id, status FROM job_secret_handles WHERE job_id = $JOB;`
— the prediction is `owner_principal_kind IN ('worker','sandbox')`. Then have the daemon redeem it
via `POST /api/worker-control/execution-secrets/resolve` with a live fence and device proof.
**Predicted:** `{"outcome":"denied","reason":"malformed"}` with `resolve_count` still 0 and
`last_resolved_at` still NULL — i.e. **the legitimate owner is refused.**
**If instead it resolves, the dead-lever finding is wrong**, and the next question is which
membership row exists: `SELECT principal_type, count(*) FROM company_memberships GROUP BY 1;`.

### Experiment 2 — settle the audit gap

On the same instance, issue a deliberately misrouted resolve (a handle minted under job A,
redeemed under job B's live fence). Then check **every** candidate sink for anything naming the
wrong owner: the `job_secret_handles` row (predicted: unchanged — the transaction rolled back),
the activity log, and `secret_access_events` (predicted: no row; the broker is never reached).
**The only artefact should be one anonymous `secretRead{outcome:"denied"}` counter tick**, which
confirms that a wrong-owner denial is forensically indistinguishable from a stale fence.

---

## DE-30 — Requester/worker capability claim ↔ admission (Critical)

### (a) Close the unmeasured requester-side revocation clause — no live access, ~30 min

In `server/src/__tests__/job-submission.integration.test.ts`, after a successful `asUser()`
submission, run
`UPDATE organization_memberships SET status='suspended' WHERE organization_id=$ORG_A AND user_id=$USER_A`
and assert the next `POST …/jobs` returns 403 with `{jobs:0, attempts:0, outbox:0}`; repeat with
`company_memberships.status`. **Then anti-regress it:** delete
`eq(organizationMemberships.status, "active")` from
`packages/db/src/repositories/tenant/job-control.ts:1453` and confirm the new test goes **red**.
Today nothing on the submission lane does.

### (b) Decide the commander branch — a founder decision, not an experiment

Either re-derive the commander requester through `admittedUserRequester` (making revocation
immediate and dropping the `principalRole` token claim from the trust decision), **or** amend
DE-30's `revocation` clause to read *"immediately for user/mcp/worker principals; bounded by the
commander run-JWT TTL (default 600s, `AOA_COMMANDER_JWT_TTL_SECONDS`) for the commander
principal."* ★ **Do not leave the field asserting "immediately" while the code does not.**

### (c) The end-to-end claim rather than the mechanism claim

**Access:** a live control plane with `AOA_DISTRIBUTED_EXECUTION_ENABLED=1`, at least one really
enrolled worker device holding an Ed25519 key, and two tenant organizations. Enrol worker W into
org A; ratify a placement profile whose `capabilityCeiling` omits `browser.chromium`; submit a
`browser_request` job in org A; assert **W is never offered the lease** and that a
`worker_lease_rejections` row with `reasonCode='static_requirements_mismatch'` is written. Then,
from W's live session, `POST /api/execution-targets/self/hello` with `reportedCapabilities`
containing `browser.chromium` and assert `unauthorized` with
`worker_hello_refresh_capability_not_granted` in the operator log.
This is DE-30's `releaseTest` REL-001, currently deferred on unshipped BRW-006/SVC-007, so it
cannot be scheduled as written today.

---

## What this document does NOT cover

**It establishes nothing.** Every entry above is a *plan for a measurement*, not a measurement.
Nothing here reads a test, runs a control, or makes any register row move: rows move only on a
recorded result, written back into `deliveryEvidence` with the same provenance discipline the
existing rows carry.

**And the register is now fully audited, which is the worse-looking half of the news.** All thirty
crossings carry a recorded verdict; twenty-nine of them say some control they charter is not there.
The audit-debt pin in
[`distributed-execution-audit-debt.json`](../architecture/distributed-execution-audit-debt.json)
is therefore **zero**, and `scripts/check-threat-control-audit-debt.mjs`'s remaining live work is
its other two arms: **no crossing may return to `unaudited`**, and **DE-02 may not stop being
`delivered`**. ★ **A zero pin is not health.** It means nothing is unmeasured. It does not mean
anything holds, and it must never be cited as though it did.
