# BRW-003 — Browser observation artifact pipeline — TERRAIN

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Mapped at:** `e7ba73a59`
**Status:** terrain complete. **§1 is ESCALATED** as a programme decision
([`DECISION-REQUEST-byte-egress.md`](../DECISION-REQUEST-byte-egress.md)) and BRW-003 is not
designed until it returns. **§2 is SETTLED** — see the decision recorded there.

**Spec.** Outcome: stream metadata and store screenshots, DOM snapshots where allowed, trace,
video and downloads as sensitive artifacts. Acceptance: event payloads remain bounded;
retention/redaction policy is explicit; artifact order is tied to event sequence.
Test: screenshot/trace hash, large download, retention, and stale-fence cases.

> **Method.** Four independent lenses mapped the tree, then a critic re-verified every
> load-bearing claim and flagged four conclusions as unsafe to build on. All negatives use
> `grep -a` (raw NUL bytes in tracked files silently suppress plain grep — see
> `BRW-002-terrain.md` §7).

---

## 1. ★ THE BLOCKER: there is no way for a byte to leave the sandbox

**This is not a wiring gap. The port forbids it on both sides, and nobody costed opening it.**

- **The port has no file method.** `SandboxProvider` — the only thing the supervisor holds
  (`supervisor.ts:88`) — has eleven methods (create/execute/cancel/kill/destroy/list/inspect/
  reconcileCleanup + checkpoint/restore/health) and **not one moves a file**. `ExecuteResult`
  excludes it explicitly (`provider.ts:165-168`): *"`stdoutRef`/`stderrRef` are OPAQUE
  references — never inline customer bytes … No stdout/stderr content crosses this boundary."*
- **BRW-002's runner is therefore not merely unwired — it is excluded by contract.** Its only
  output channel is `process.stdout.write(JSON.stringify(event))` (`runner.ts:40`).
- **A seam exists one layer below and is unreachable through the port.**
  `E2bTransport.writeFiles` / `readFile` / `listDir` (`sandbox-e2b-provider/transport.ts:151-157`)
  are real and bound to the SDK (`real-transport.ts:192,199`), but
  `E2bSandboxProvider implements SandboxProvider` surfaces **none** of them. Using them means
  extending the port — a change to every implementer plus the cleanup authority's redaction
  proof — or bypassing it and abandoning the transport-agnostic design (`provider.ts:288`).
- **The guest cannot upload for itself.** `networkPolicyV1Schema` pins
  `denyControlPlane: z.literal(true)` (`policy.ts:90`) — a **frozen literal, unsettable** —
  restated as H-06 in `test-gates.md:25`. And `packages/browser-runtime` has no HTTP client;
  its only `node:http` import is the test fixture server.
- **Even once opened, "large download" has no bounded-memory path.**
  `readFile(sandboxId, path): Promise<Uint8Array>` is fully buffered — no range, no stream —
  against a 5 GiB commit ceiling (`artifact-commit.ts:71`).

**Consequence for scoping.** BRW-003 cannot be planned as an artifact-pipeline ticket. Its
first and largest deliverable is a **byte-egress seam**, which BRW-002's own result doc handed
forward in one clause (`BRW-002-result.md:139-141`, "Staging the bundle into a sandbox is the
BRW-003+ integration") without costing it.

## 2. ★ THE PROTOCOL CUSTODIAN STOP: "DOM snapshots *where allowed*"

The allow/deny decision **has no home on the wire**, and the extension escape hatch does not
work here.

`browserWorkloadV1Schema` (`job.ts:299-309`) is `.strict()` with exactly seven fields —
engine, viewport, locale, timezone, recordTrace, recordVideo, maxSessionSeconds. No capture
policy, no screenshot policy, no download/upload policy.

The bounded extension container lives on the **job envelope** (`job.ts:347`) and the **event
base** (`events.ts:347`), *not* inside the workload object. And
`KNOWN_CRITICAL_EXTENSION_NAMESPACES` is empty by construction (`extensions.ts:30-32`), so:
a capture policy shipped **non-critical is silently ignorable — fail-OPEN on a security
control**; shipped **critical is rejected by every worker**, including the current one.

**DECISION (programme owner, 2026-08-23): option (i) — the allow decision NEVER crosses the
wire.** The guest always attempts capture; the control plane decides which artifact *kinds* it
accepts at commit. No frozen change, no Custodian STOP, and the decision sits where the
authority already is — the server is already digest-authoritative at commit
(`artifact-commit.ts` heads the object and trusts the store, not the manifest).

**The caveat, recorded rather than glossed:** the capture briefly exists inside the sandbox
before being discarded at the door. Since the sandbox is destroyed at terminal state that
satisfies a retention requirement, but it does NOT satisfy a literal "this data is never
captured" requirement. If such a requirement ever appears, it needs option (ii) and its
Custodian process — so "where allowed" means **where retained**, and BRW-006's UI copy must
not imply otherwise.

## 3. Two unconnected pipelines, and BRW-003 sits on the seam

**(A) The DAT-002 pipeline (grant → presigned PUT → commit) — server LIVE, worker DORMANT.**
The server end has a real boot root: `app.ts:451` mounts `workerControlRoutes` under
`AOA_DISTRIBUTED_EXECUTION_ENABLED`, which `docker-compose.d1.yml:143` and
`docker-compose.staging.yml:68` set true. The daemon has transport (`client.artifactCommit`,
`client.artifactTransferGrant`) — **called only by their own unit test**. `createResultCommitter`
has zero non-test callers. **Nothing in the tree has ever committed a job artifact.**

**(B) The pipeline that actually runs today is a different one, and is NOT a design input.**
`heartbeat.ts` / `crew-output-capture.ts` → `collectSandboxDiff` (git-diff enumeration inside
`remoteCwd`) → host `readFiles` → `storage.putFile` → `assets` + `task_outputs`. Host-mediated,
company/date key shape, no retention/sensitivity/kind, unfenced, and it only sees files inside
the repo working tree. **The critic flags reasoning from it as unsafe**: it is the legacy
control-plane E2B route (`current-main-crosswalk.md:26`, CM-010), not the worker path BRW-003
sits on.

## 4. Per-clause readiness

### (a) "Event payloads remain bounded" — sufficient to design against, ONE unknown

Structural enforcement is real: `workerEventV1Schema` is a discriminated union of `.strict()`
variants, batch 1..500, and `browserObservationPayloadV1Schema` is fixed at
`{artifactIds ≤128, url ≤4096, title ≤1000}` (`events.ts:97-103`) — which is what enforces the
frozen forbidden effect `cookie_in_event_payload`.

**Unknown: nobody defined what "bounded" is bounded *by*.** No per-attempt or per-session event
ceiling, no rate limiter on the events route (`pollRateLimiter.admit` is called once, inside
the poll handler only), no event counter in `JobControlMetrics`, and no measured emission rate
for a browser session. "Bounded" is otherwise a self-satisfying acceptance word.

**Related defect found:** the events route inherits Express's **100 KB** default
(`app.ts:340`, no `limit`; the 20 MB parser at `:294-296` is scoped to the import routes), so
the route's own `payload_too_large` branch (`worker-control.ts:409-413`) is **unreachable**
between 100 KB and 4 MiB.

### (b) "Retention/redaction policy is explicit" — NOT sufficient

- `browserArtifactRetention` (BRW-001) has **zero production callers**.
- **The commit path takes retention FROM THE WORKER**: `artifact-commit.ts:145`
  (`retention: manifest.retention`) → `job-control.ts:2580` writes it unvalidated. The
  control-plane policy is bypassed **by construction**, and a worker could label a
  `browser_cookie_state` artifact `audit`.
- `quarantine-finalize.ts:90-91` copies sensitivity and kind and has **no retention line**.
- `job_artifacts.expires_at` has **zero writers**. Nothing sweeps.

**Unknown, and it is binary: does BRW-003 build the sweeper, or only make the class
authoritative and populate `expires_at` for someone else's?** `program-design.md:799-840`
gives deletion to nobody; BRW-006 owns showing "retention status". The two designs differ by a
scheduler.

**★ CI trap for whoever implements this:** the frozen accept corpus contains a
`workspace_snapshot` manifest declaring `checkpoint` where the policy map says `run`. Making
the control plane authoritative must **OVERWRITE, never REJECT**, or the frozen corpus fails.

### (c) "Artifact order is tied to event sequence" — buildable, but WHICH order is unanswered

`job_artifacts` has **no** sequence or event-id column; its ordering fields are
`versionNumber`, `attempt`, `committedAt`, and `versionNumber` is self-documented as a
best-effort ordinal that can collide across concurrent attempts
(`job-control.ts:2557`). But `job-events.ts:75` already persists the whole event beside
`job_events.sequence`, so the tie is **a column plus a join — a DB migration, not a wire
change**.

**Unknown: production order, commit order and observation order are three different orders**,
forced apart by BRW-002's own constraint (downloads must be `saveAs`'d *before* context close;
video only materialises *at* close). `test-gates.md:131` (D3-06) demands "ordered by event
sequence" without saying which. That is the design's first fork.

## 5. What the mapping initially missed — the graded requirements

**`docs/replatform/test-gates.md:124-131` is the D3 Browser gate and it grades this work.** It
restates BRW-003's clauses in stronger form and adds one nobody had mentioned:

- **D3-02 coverage includes "upload policy"** — **uploads were not mentioned once.** A
  file-chooser / `setInputFiles` upload is an exfiltration path *out of* the job workspace into
  a remote site: the mirror image of the download case, and unbudgeted.
- **D3-04** bans any cookie/token/authorization-header/storage-state **VALUE** in events or
  logs — strictly stronger than the `.strict()` field-name guard.
- **D3-06** — every screenshot, trace, video and download ordered by event sequence **and
  matching its digest**.
- **D3-05** — session cleanup ≤5 minutes.
- **H-04** names "browser artifacts" and "traces" as canary-containment surfaces.

Also missed: `artifact-policy.md` settles the private-URL redaction question as **policy, not
hypothesis**; `packages/sandbox-fake-provider/src/fake-driver.ts` emits **no events and no
artifacts**, so BRW-005's D1 golden-journey vehicle cannot currently carry these cases; and
BRW-002's result doc hands BRW-003 three unbudgeted items by name — the staging integration,
the socket-delta TOCTOU gap, and the frozen `deadlineMs: 20000` cleanup deadline that video
flush plus download persistence must fit inside.

## 6. Producer gaps — BRW-002 captures nothing

`packages/browser-runtime/src` has eight source files and `grep -a` finds **no `tracing`, no
`page.screenshot`, no DOM capture** in any of them. So of the four Test-clause cases:

| Case | Mechanism today |
|---|---|
| screenshot / trace **hash** | ✅ store-authoritative (`artifact-commit.ts:114`) — see §7 |
| screenshot / trace **capture** | ❌ does not exist |
| large download | ❌ ceiling exists, transport does not (§1.5) |
| retention | ❌ **nothing anywhere** — the only case with no mechanism at all |
| stale fence | ❌ **TRIPLY DORMANT** — see the correction below |

## 7. The one thing that is genuinely solid

**Digest verification is server-authoritative and fails closed.** `artifact-commit.ts` heads
the object, requires both `contentLength` and a store-computed `checksumSha256`, rejects with
`event_hash_mismatch` when the store cannot supply one, compares inside the fence-guarded
mutator, and persists the **observed** values rather than the declared ones. It never trusts a
self-asserted manifest.

Two nuances to design around: the presigned PUT binds the checksum **algorithm** but not the
**value** (`PresignInput.checksumSha256` and `maxBytes` are passed and never read in
`presign()`), so a live grant is a write-anything-to-this-key capability for its TTL and the
"large download" case must be tested **at commit**, not at grant. And it is an untested
hypothesis whether MinIO returns `x-amz-checksum-sha256` on HeadObject in the D1 topology — if
it does not, every D1 commit fails closed.

## 8. Assignments the mapping got wrong (do not build these)

- The **control-plane read surface** is not BRW-003's: `program-design.md:837` gives the
  tenant-scoped session view to **BRW-006** and `:831` gives "all durable evidence viewable
  from the control plane" to **BRW-005**.
- `artifactPreparedPayloadV1Schema.kind` is a free string (`events.ts:92-94`), not the
  artifact-kind enum. Do **not** tighten it — it is frozen. Treat the event's kind as
  untrusted and the manifest's as authoritative.
- `CONTROL_COMMAND_KINDS` has no `browser_approval_result`, but the frozen fixture's governance
  block (`browser-approval-download.json:205-207`) says a browser approval rides the **product
  approval** authority, which already has a command and a bridge. That is BRW-004's, and
  recording it here saves BRW-004 a needless Custodian ticket.
- A live **ungoverned** browser runs today on the control-plane host — Commander's
  `browser_use` spawns `@playwright/mcp` via `npx --headless` (`cli-mode.ts:349-354`). It
  produces exactly the bytes BRW-003 governs, with no sandbox, tenant boundary, artifact
  record, retention or redaction — and unlike everything above, **it has a live boot root**.
  BRW-008 retires it.

---

## ★ CORRECTIONS (post-decision re-verification) — three claims above are WRONG

This terrain was written before the byte-egress decision. Adversarial re-verification found three
load-bearing claims in it that do not hold. They are corrected here rather than silently edited,
because other lanes read this file and a false terrain propagates.

### 1. "quarantine built and constructed" is WRONG on both counts — the path is TRIPLY DORMANT

The stale-fence row above said the quarantine path was built and constructed with only a missing
candidate writer. Three independent gaps, each verified:

1. **No uploader between grant and finalize.** `packages/worker-daemon/src/lease/quarantine.ts`
   mints the grant and goes straight to finalize — `grantParsed.data.grant.url` is **never read**.
   So `server/src/services/quarantine-finalize.ts:72-77` HEADs an object that was never PUT and
   returns `rejected("malformed")` **100% of the time** against the real server.
2. **No wired reconciler.** `packages/worker-daemon/src/bin/worker-daemon.ts:313` —
   `deps.reconciler ? createStartupSteps(deps.reconciler) : []`, with the comment at `:311` saying
   "no reconciler wired (the current default)". `createStartupReconciler(` has **zero production
   call sites**.
3. **No candidate writer** (the one gap the original row did name). `quarantineCandidates` is
   supplied only by `__tests__/startup-quarantine-sweep.component.test.ts`.

**Consequence for design:** writing a candidate list WITHOUT also inserting the PUT ships a feeder
into a path that always rejects — a check that cannot succeed wearing the costume of one that can.
Fix all three or ship none of them, and say which in the result doc.

### 2. The MinIO `x-amz-checksum-sha256` question is ANSWERED — DAT-002 slice 7 is COMPLETE

§7 above calls it "an untested hypothesis whether MinIO returns `x-amz-checksum-sha256` on
HeadObject in the D1 topology". It is tested and it passes.

`DAT-002-live-minio-result.md:3` — **"COMPLETE + Linux-CI-green"**, `d1-merge-train` run
`31885553697` = success, **13/13**. `tests/d1/e6f-05-live-minio.test.mjs` (tracked, 22 KB) proves a
real https presigned PUT/GET round-trip against MinIO-over-TLS plus a toxiproxy truncated-upload
fail-closed case, and `d1-merge-train.yml:192` runs it.

The stale "deferred" wording survives in `DAT-002-result.md:3`, which was never amended — that is
the propagation path that put the wrong claim into this terrain AND into the programme decision
doc. **This lane got it wrong three times in a row** (a grep against a non-existent epic path
reported as an absence, then the right path but the wrong one of two result docs).

**Consequence for design:** BRW-003 has a LIVE lane to prove a real round-trip. And the exporter
must send the checksum headers ITSELF — the server sets `ChecksumAlgorithm: "SHA256"` and returns
`headers: {}` (`server/src/storage/s3-provider.ts:120-142`). That knowledge exists in exactly one
place today (`tests/d1/lib/e6f-harness.mjs` `putPresignedBytes`); a second implementation inside
the exporter is a divergence waiting to happen and must be ONE shared helper with one test.

### 3. ★ THE STDOUT CHANNEL DOES NOT EXIST — and BRW-002 shipped a header saying it does

The Outcome's FIRST clause is "stream metadata", and this terrain never established how metadata
reaches the host. It cannot reach it the way BRW-002 assumed.

- The worker-daemon `SandboxProvider` port is **FROZEN** — handoff §7 lists it beside
  `packages/worker-protocol/`, "never edit".
- Its stated invariant (`packages/worker-daemon/src/supervisor/provider.ts:169`): **"No
  stdout/stderr content crosses this boundary."** The provider returning placeholder
  `ref:stdout:<id>` values and discarding stdout is the invariant WORKING, not a defect.
- But `packages/browser-runtime/src/runner.ts:18-21` says "host: reads the NDJSON on stdout" and
  "the host's only channel back is the command's stdout stream". **That contract is false.** The
  runner writes events nothing can ever read.

**Consequence for design:** stream metadata rides the FROZEN `event_upload` transport op
(`packages/worker-protocol/src/transport.ts:762`), not the provider. The worker already has that
whole path — `EventSequencer`, the WRK-006 durable outbox, and per-run redaction
(`packages/worker-daemon/src/supervisor/redaction.ts`). A stdout pipe would have bypassed
sequencing, durability AND secret redaction, so it was not merely blocked — it was worse than the
path that already exists. BRW-003 emits worker events; BRW-002's runner header is corrected
separately.
