# DAT-009 slice 3 — Design: the worker-side consumer (digest → grant → export → commit)

**Epic:** E5 · **Status:** DESIGN + **slices a and b BUILT in the same PR** (§4; c–f named and
unbuilt). **Start SHA:** the commit that adds this file.
**Line references are to `docs/replatform-program` at `6c2fe6482`** unless stated otherwise.
**Depends on:** DAT-009 slice 1 (the port capability, LANDED) · DAT-009 slice 2 (the fence window,
LANDED) · DAT-002 + DAT-002-live-minio (the grant/commit halves, LANDED and live-proven).
**Decision of record:** [`DECISION-byte-egress-and-provider-topology.md`](../../../DECISION-byte-egress-and-provider-topology.md)
(Option D, REVISION 2) — item **4** of its ordered list.
**Terrain:** [`DAT-009-terrain.md`](./DAT-009-terrain.md) §1, §4, §9 · **Map:**
[`CLI-008-unit-f-design.md`](../../E7-coding-e2b/tickets/CLI-008-unit-f-design.md) §1.5–§1.8.
**AMENDED 2026-09-06 (W6U1).** The two implementer-level decisions slice c reserved are now
RULED and recorded in §4 beside their reservations — **RULING A** (a failed export is BEST-EFFORT)
and **RULING B** (only the normal terminal at `supervisor.ts:795` exports). Both are implementer
defaults with their rationale and their cost, not founder calls; both are overturnable by
measurement. No code changed.

> **This ticket had no design file.** It is cited as chartered in three places — the decision
> record's ordered list (`:78`), [`DAT-009-slice-1-design.md`](./DAT-009-slice-1-design.md):6
> (*"Unblocks: DAT-009 slice 3"*), and `CLI-008-unit-f-design.md` §1.6 link 3 — and existed
> nowhere on disk. It is also GO-BOOK §1.9 Track B's "free parallel" row (`GO-BOOK.md:413`).

---

## ★ 0. THE HONEST ANSWER TO THE CAPABILITY QUESTION, STATED FIRST

**This ticket does not flip `capabilityProven`, and it cannot, and no amount of building it well
would change that.** Stating it at the top rather than in a closing caveat, because the programme's
worst outcome is a capability claim discovered to be hollow after it was scheduled against.

The gate is `countProducedOutputs`, an OR over two counters
(`server/src/services/e7-distributed-run-verifier.ts:506`). Measured at `6c2fe6482`:

| arm | predicate | what slice 3 does to it |
|---|---|---|
| `workspacePatchArtifacts` | `job_artifacts` WHERE `jobId = run.distributedJobId` **AND `kind = 'workspace_patch'` AND `status = 'committed'`** (`e7-distributed-run-verifier-store.ts:198-209`) | **nothing, by itself.** Slice 3 is a *sequencer*: it exports whatever file its caller names, under whatever `kind` its caller declares. It creates no file and chooses no kind |
| `taskOutputs` | `task_outputs` WHERE `createdByRunId = run.id` | **nothing.** No `task_outputs` writer is in scope; that is §1.6 link 5, and the general clause is `E3-17-output`, `unwired` |

★★ **The arm filters on `kind = 'workspace_patch'` specifically.** So even a fully-working slice 3
committing a `log` or an `other` artifact moves the counter by zero. That is measured, not assumed:
the `eq(jobArtifacts.kind, "workspace_patch")` is on line 207.

**What slice 3 actually is:** link **3** of the five that `CLI-008-unit-f-design.md` §1.6 enumerates.
The counter needs links 1, 2 and 3 together, plus the caller choosing `workspace_patch`:

| §1.6 link | state at `6c2fe6482` | owner |
|---|---|---|
| 1 — **no file to export** | Unit D runs `claude --print -` with stdout going nowhere; no agreed in-sandbox path holds anything | CLI-008 Unit F |
| 2 — **no real `exportArtifact`/`digestArtifact`** | `E2bSandboxProvider.artifactExportMode = "none"` (`e2b-provider.ts:178`), `provider-wire/src/driver.ts:83` likewise, `noop-provider.ts:72` likewise. **Zero providers can export.** `#transport.readFile` (`real-transport.ts:196`) sits uncalled one line away | DAT-009 slice 3e (§4) |
| 3 — **no worker-side consumer** | **THIS TICKET** | DAT-009 slice 3 |
| 4 — no `artifactPrepared` announcement | blocks task *projection*, **not the counter** (§1.8: the arm joins no events) | CLI-008 Unit F |
| 5 — no `task_outputs` projector | the other arm | `E3-17-output` |

**So the correct claim for this ticket is: it advances the return path and flips no gate.** It is
worth building anyway for the reason the terrain gives — *"a complete, tested server half says
nothing about the caller half existing"* — and because links 1 and 2 are each independently useless
without it.

---

## 1. What slices 1 and 2 ACTUALLY built (not what the terrain planned)

The terrain proposed a three-slice split; the shipped slices moved. Building on the plan rather than
the code is how a design acquires a phantom dependency, so this section is measured from source.

| Piece | Where it actually landed | State |
|---|---|---|
| `digestArtifact(sandboxId, path, ctx) → {sha256, sizeBytes}` | `packages/worker-daemon/src/supervisor/provider.ts:414` | built |
| `exportArtifact(sandboxId, path, grant, ctx) → {objectKey}` | `provider.ts:425` | built |
| `artifactExportMode: "none" \| "grant_upload"` | `provider.ts:433` | built |
| **NOT** in `packages/sandbox-provider-contract` | — | slice 1 §1: that driver is keyed to the FROZEN `ProviderOperation` union. Untouched, deliberately |
| A working `grant_upload` **double** | `worker-daemon/src/__tests__/support/fake-provider.ts:208,311,323` | built — **this is slice 3's test substrate** |
| Grant TTL clamped to 300 s | `services/artifact-grant-ttl.ts` via `artifact-transfer-grant.ts:60` | built |
| Grant **intent** recorded at mint, fence-guarded, inside the mint transaction | `artifact-transfer-grant.ts:168-175` | built |
| Orphan sweep (`isSweepEligible` + runner + DAT-011 trigger) | `artifact-commit.ts:130,219,230` | built **and live-proven** (`tests/d1/e6f-14-orphan-sweep.test.mjs`) |

★ **Consequence for this design.** Slice 2 shipped the safety net *before* the thing that creates
orphans. So slice 3 does not have to design orphan handling — it inherits it — and it must not
re-open it. What slice 3 owes slice 2 is **not creating orphans it could have avoided**, which is
§3.3.

★ **And one thing slice 1 did NOT ship, which slice 3 needs:** `EffectAuthority`
(`supervisor/effect-authority.ts`) exposes `create`/`execute`/`stageFiles`/`resume`/`checkpoint`/
`health`/`destroy` and **has no `digestArtifact` or `exportArtifact`**. The port grew; the authority
wrapper did not. Slice 1's methods are therefore reachable only by bypassing the fence gate, which
is exactly what must not happen (§3.4).

---

## 2. The shape, and why the frozen schemas leave no choice

```
                     ┌─ 1. digestArtifact(path)  ──► {sha256, sizeBytes}     (provider; metadata only)
  worker (daemon)  ──┤  2. artifact_transfer_grant{operation:"upload", …}    (control plane; grant out)
                     │  3. exportArtifact(path, grant)  ──► {objectKey}      (provider; bytes → S3)
                     └─ 4. artifact_commit{manifest}    ──► committed        (control plane)
```

Step 1 must precede step 2 because `artifactTransferGrantRequestV1Schema`
(`packages/worker-protocol/src/artifacts.ts:365-393`, `.strict()`, **FROZEN**) requires **both**
`expectedSha256` and `maxBytes` as non-optional. That is the terrain's §1 finding and it holds.

### 2.1 Every field the four calls need, and where it comes from — MEASURED

The one thing that could have blocked this ticket outright is the commit manifest: it requires
`organizationId` **and** `companyId` (`artifacts.ts:298-299`), and a worker that could not know them
would need a frozen change. **It can.** `jobEnvelopeBaseSchema` carries both
(`packages/worker-protocol/src/job.ts:331-332`), and the daemon holds the whole envelope as
`handoff.offer.job` (`poll/poll-loop.ts:400-405`).

| field | source | note |
|---|---|---|
| `workerId` / `jobId` / `attempt` / `leaseId` / `fenceToken` | `handoff.offer` + `handoff.leaseId` / `.fenceToken` | the `RunFenceContext` shape `staged-input.ts:229-235` already builds |
| `organizationId` / `companyId` | `handoff.offer.job.organizationId` / `.companyId` | **the enabling measurement** |
| `expectedObjectKey` | `expectedAttemptObjectPrefix({organizationId, jobId, attempt}) + suffix` — the exported helper at `artifacts.ts:76` | the frozen request refines that the key binds job+attempt (`:381-391`); the server *additionally* refines the **org** segment (`artifact-transfer-grant.ts:104-111`), so the worker must use its own org or be rejected `malformed` |
| `artifactId` | worker-minted UUID, **deterministic** (§3.2) | `artifactIdSchema` is `uuidSchema.brand` (`ids.ts:43`) |
| `expectedSha256` / `sizeBytes` | step 1's result | hex, `/^[a-f0-9]{64}$/` (`ids.ts:57-60`) |
| `maxBytes` | `= sizeBytes` | **not a ceiling here.** The size is always known by step 1, so passing anything larger only widens the orphan bound the server refuses on (`artifact-transfer-grant.ts:124`) |
| `kind` / `contentType` / `retention` | **the caller's**, passed in | see §3.5 — `retention` is control-plane-owned and the declaration is ignored (`artifact-commit.ts:166-182`, DAT-010) |
| `createdAt` | `now()` | `timestampV1Schema` |
| `idempotencyKey` | deterministic uuid from the retry identity | `staged-input.ts:137-143`'s helper, reused verbatim |

---

## ★★★ 3. The five constraints that determine the design

Each is measured. Each is a way this ticket fails silently if it is not honoured.

### ★★★ 3.1 The lifecycle window is BOUNDED ON BOTH SIDES, and the late edge is a RACE, not a rule

An upload grant requires a **live fence**: `artifact-transfer-grant.ts:99` runs
`repos.jobControl.lockActiveFence`, and `classifyFence`
(`packages/db/src/repositories/tenant/job-fence.ts:482-488`) returns **`attempt_terminal`** the
moment the attempt's status is terminal. The commit half resolves the same fence
(`artifact-commit.ts:122-127`).

So the sequence must run:

* **after** `execute` returns — there is no file before the tenant command produced one;
* **before** the terminal event reaches the control plane — after it, the grant *and* the commit are
  both refused `attempt_terminal`.

In `supervisor.ts` that is exactly one place: **between step 3b (`observeRun`, `:774-791`) and step
4 (`events.terminal`, `:795`).** ★ **AMENDED (W6U1): that sentence answers *where in the
happy path*, and leaves open *which of the terminals*. There are FOURTEEN `events.terminal(` call
sites, all in `supervisor.ts`; RULING B in §4 slice c settles that only `:795` exports, counts them,
and records what the other thirteen lose.** It is also before step 5 `destroy` (`:808`), which it must be —
`exportArtifact` reads from a live sandbox.

★★ **The late edge is not the local `emit()`.** `DurableWorkerEventSink.emit` fsyncs the event to a
**local encrypted outbox** and returns (`events/durable-event-sink.ts:1-24`); `createEventOutboxDrain`
uploads it later. So "after `events.terminal()`" is not a moment at which the fence is reliably
dead — it is a moment at which the export **races the drain**, with the outcome decided by drain
timing. A design that placed the export after terminal would pass every unit test with an in-process
double and fail non-deterministically in production. **Place it before terminal; do not rely on
drain lag in either direction.**

★ **And there is no fallback if it lands late.** The frozen quarantine vocabulary has a
`late_output` reason (`artifacts.ts:488-496`) and the daemon has `runOrphanQuarantine` — whose only
production caller is `supervisor/startup-reconcile.ts:480`, and `createStartupReconciler` is
`gate-clause-wiring.json`'s `E4-3-survives-restart`, **`unwired`**. The late-output path is
unreachable today. Recorded so nobody designs against it.

### ★★★ 3.2 The checksum-header contract exists ONLY in a test harness

`s3-provider.ts`'s `presign()` binds `ChecksumAlgorithm: "SHA256"` into the signed `PutObjectCommand`
and returns **`headers: {}`** (`server/src/storage/s3-provider.ts:114-142`, the return at `:142`).
`artifact-transfer-grant.ts:153` copies `signed.headers` straight onto the frozen grant. **So the
grant tells the exporter nothing about the headers its own signed URL demands.**

The signed query demands them. The only code in the repository that has ever redeemed one of these
URLs is the D1 harness step-script (`tests/d1/lib/e6f-harness.mjs:1503-1521`), which sends:

```
x-amz-checksum-sha256:        <BASE64 of the sha256 of the exact bytes>
x-amz-sdk-checksum-algorithm: SHA256
```

★ **The digest is HEX on the grant and BASE64 on the wire.** `expectedSha256` is
`/^[a-f0-9]{64}$/`; the header is base64 of the 32 raw bytes. An exporter that forwards the hex
string gets a rejected PUT. That conversion is one line and is the single most likely thing to get
wrong, because nothing in the type system distinguishes the two encodings.

★★ **And the store still does not verify the digest is the RIGHT one.** Terrain §9 stands: the
algorithm is bound, the *value* is not, so the store checks the header against the bytes it received
and never against `expectedSha256`. An exporter that computed the header from what it actually
uploaded would produce a PUT the store accepts and a commit the control plane refuses `hash_mismatch`
(`artifact-commit.ts:141-145` + `commitArtifactVersion`'s declared-vs-actual comparison at
`:203-206`). **That is the correct, fail-closed behaviour** — it is why the two-step shape is safe —
but it means the store is not the guard, and any test that only asserts "the PUT succeeded" proves
nothing.

★★★ **Where this knowledge must live.** It must NOT be re-derived inside each provider. Two
providers writing "hex→base64, plus these two header names" independently is how the second one gets
it wrong silently. §4 slice **a** puts it in one exported helper (`grantPutHeaders`) on the daemon
side, beside the grant it derives from — and it is exported from the package barrel so the provider
that will actually call it (slice **e**) inherits it rather than re-deriving it.

### 3.3 A grant minted and not redeemed is a durable row, not nothing

Since slice 2, minting writes a `granted` `job_artifacts` row inside the mint transaction
(`artifact-transfer-grant.ts:168-175`). **So every abandoned grant is a row that lives until its
`expiresAt` passes and the sweeper collects it.** Cheap, bounded, and self-healing — but it means the
sequencer must not mint speculatively. Concretely: **digest first, and if the file is absent or the
provider declines, return before minting anything.** Ordering the other way would leave a `granted`
row for every run that had nothing to export.

### 3.4 `EffectAuthority` must grow the two methods, and `emitOp` must be told about them

Two mechanical gates, both of which have already bitten this programme once:

1. **Fence gating.** `stageFiles` is on `EffectAuthority` and its comment says why
   (`effect-authority.ts:95-101`): *"a run whose lease was replaced must not still be putting files
   into the sandbox its successor is about to use."* Export reads from that same sandbox under a
   bearer grant. Calling `provider.exportArtifact` directly would be a second, quieter door onto a
   gated action — the shape slice 2's result §4 names.
2. ★★★ **The metric label allow-list.** `CLOSED_LABEL_VALUES.operation`
   (`metrics/metrics.ts:80-103`) mirrors the **frozen** `PROVIDER_OPERATIONS` vocabulary plus one
   deliberate entry, `stage_files`, added with a nine-line comment explaining that **without it every
   `emitOp` THROWS — on the success path as readily as the failure path — and the throw lands in
   `accept()`'s last-resort catch, which emits NO TERMINAL.** That is **E7-F010**, found *after*
   Unit B shipped. `digest_artifact` and `export_artifact` are in exactly the same position: methods
   on the non-frozen port, absent from the frozen vocabulary, and therefore absent from that set.
   **They are registered in slice b — the slice that adds the METHODS — rather than in slice c, the
   one that first calls `emitOp`.** Two lines whose absence is a no-terminal run are not worth
   sequencing, and the omission is invisible by the time it bites: the throw happens inside the
   fail-closed arms, so the failure arm re-throws from its own emit and the escape lands in
   `accept()`'s last-resort catch, which emits nothing at all. Registering early costs an unused
   allow-list entry, which is why slice b pins it with a test (§5) instead of leaving it unmeasured.

### 3.5 Retention and kind are the caller's declaration, and one of them is ignored

`resolveStoredRetention` (`artifact-commit.ts:166-169`, DAT-010) derives retention from the frozen
`kind` and **ignores the worker's declaration**, logging the disagreement. So the sequencer should
send a declaration that matches what the control plane will decide, not because it is enforced but
because a permanent `retention declaration ignored` warning on every export is noise that trains
operators to ignore the log line. `kind` itself **is** honoured and is what the E7 counter filters
on (§0) — so it is a caller parameter, never a default this module picks.

---

## ★ 4. The slice plan

Lettered, and sized so each stands alone. **a** and **b** are one PR; the rest are named with what
each needs.

### Slice a — `createArtifactExportSequencer` (the pure consumer). **This PR.**

New module `packages/worker-daemon/src/lease/artifact-export.ts`, the **upload mirror of
`lease/staged-input.ts`**, which is the exemplar in shape, header style and failure discipline.

```ts
export interface ArtifactExportRequest {
  readonly path: string;        // absolute, in-sandbox
  readonly kind: string;        // the CALLER's; §3.5
  readonly contentType: string;
  readonly retention: string;
}
export interface SandboxArtifactExporter {   // satisfied by EffectAuthority in slice c
  digest(path: string): Promise<{ sha256: string; sizeBytes: number }>;
  export(path: string, grant: ArtifactUploadGrantV1): Promise<{ objectKey: string }>;
}
export function exportArtifactId(i: { jobId: string; attempt: number; path: string }): string;
export function grantPutHeaders(grant: ArtifactUploadGrantV1): Record<string, string>;
export function createArtifactExportSequencer(deps: {
  client: Pick<ControlPlaneClient,
    "artifactTransferGrant" | "artifactTransferGrantPath" | "artifactCommit" | "artifactCommitPath">;
  key: DeviceKey;
  session: () => Promise<WorkerSession>;
  now?: () => number; newCorrelationId?: () => string; newProofId?: () => string;
}): (input: {
  handoff: LeaseHandoff;
  exporter: SandboxArtifactExporter;
  requests: readonly ArtifactExportRequest[];
}) => Promise<readonly ExportedArtifactRef[]>;
```

★ **The object key is DERIVED, not a caller field.** An earlier draft of this section gave the
request an `objectKeySuffix`; it was dropped during the build. The control plane's own convention
for an attempt-scoped object is `${expectedAttemptObjectPrefix(...)}${artifactId}`
(`server/src/services/job-input-staging.ts:350`), and matching it exactly removes a validation
burden (the frozen request refines the whole key), removes a collision surface, and removes a way
for two callers to disagree. The `artifactId` is itself derived from (jobId, attempt, path) so a
retry of the same file is a replay rather than a second artifact.

★ **Why the provider arrives as an injected `exporter` rather than a `SandboxProvider`.** It keeps
this module pure and provable with no sandbox, exactly as `createStagedInputResolver` is; and it puts
the fence gate at the boundary (slice c passes `run.effect`), so this module cannot accidentally
become the second door §3.4 warns about. `path` and `grant` are the only things it hands across.

Also in slice a: the **`grantPutHeaders(grant)` helper** of §3.2 — hex→base64 plus the two header
names — exported beside the sequencer with the `e6f-harness.mjs:1503-1521` citation in its header,
so the second provider inherits it instead of re-deriving it. ★ **Placement checked, not assumed:**
`scripts/check-sandbox-e2b-provider-boundary.mjs` lists `worker-daemon` among the exactly-five
runtime dependencies `@armyofagents/sandbox-e2b-provider` may declare, so slice e can import this
helper. If it could not, the helper would have to live in `worker-protocol` beside the grant, and
that would be a frozen-package change for a non-frozen concern.

**Standalone?** Yes, and honestly dormant: zero production callers until slice c. It is enrolled in
`scripts/gate-clause-wiring.json` as `unwired` in the same commit, following the
`E7-1-staged-input-grant` precedent — so the moment slice c composes it the checker fires
`unwired_but_now_has_caller` and forces the promotion.

### Slice b — `EffectAuthority.digestArtifact` / `.exportArtifact` + the two metric labels

Small, mechanical, §3.4. Ships with **a** because a sequencer whose gated caller does not exist is a
design that has not answered where the fence goes. ★ Both refuse **synchronously**, like every other
gated method on that class (`stageFiles` included) — the guard runs before the provider call is
made. For `exportArtifact` that is the property worth having, not an accident of style: a withdrawn
authority never hands the bearer grant to an implementation at all, and a redeemed grant cannot be
recalled, because no revocation concept exists and the TTL is the only one there is. The labels ship here with their `E7-F010` citation
even though the first `emitOp` is slice c's — the two entries are two lines and their absence is a
no-terminal defect, which is not a thing to leave for a later PR.

### Slice c — the supervisor hook, placed in the §3.1 window

`SupervisorDeps.resolveExportArtifacts?: (input:{handoff, exec}) => Promise<readonly
ArtifactExportRequest[]>`, mirroring `resolveStagedFiles?` (`supervisor.ts:190`). Absent ⇒ the
lifecycle is byte-identical to today. Present ⇒ between `observeRun` and `events.terminal`, raced
under a deadline (`withDeadline`, the §3.1/`stageInputDeadlineMs` pattern), with `emitOp` on both
outcomes.

★ **This is the one design decision slice c must make and slice a must not pre-empt: is a failed
export a failed ATTEMPT?** Staging fails **closed** (`supervisor.ts:686-690`) because an agent
running without its input produces a clean terminal for mutilated work. Export is on the other side:
the work is already done, and failing the attempt would discard a successful run because its
*evidence* could not be filed. The likely answer is **best-effort like `observeRun`** — log, emit
`failed`, continue to a truthful terminal — but it is a real decision with a real cost (evidence
silently missing), it needs its own mutant, and it belongs with the code that implements it.
---

#### ★★★ RULING A (slice c's reserved decision, now taken) — **a failed export is BEST-EFFORT, not a failed attempt**

**Who ruled, and at what authority.** Recorded by the W6U1 output-ruling unit, 2026-09-06, measured at
`31d33a3b0`. This is an **IMPLEMENTER-level** decision — the one the paragraph above explicitly
reserves for "the code that implements it" — **not a founder call and not an architectural decision**.
It settles what slice c does by default; a slice-c author with a measurement that contradicts the
evidence below should overturn it and say so here, and nothing in this ruling binds anyone who has
new evidence.

**The ruling.** When the export sequence refuses or throws, slice c **logs, emits
`emitOp("export_artifact", "failed")`, and continues to the truthful terminal**. It does **not** fail
the attempt. This is `observeRun`'s posture (`supervisor.ts:774-786`), not `stageFiles`'s
(`:686-690`).

**Rationale, measured.**

1. ★★★ **Failing closed would override a verdict the tenant command already earned.** The export sits
   between `emitOp("execute", "success")` (`supervisor.ts:760`) and `events.terminal(...)` (`:795`),
   and the status carried by that terminal is computed at `:792` from the tenant command's own result:
   `const status = exec.exitCode === 0 && !exec.timedOut ? "succeeded" : "failed"`. A fail-closed
   export would report the **agent** as FAILED on a run whose `exec.exitCode === 0`, because object
   storage was unreachable. That is the inverse of the staging case: staging fails closed because an
   agent that ran **without its input** produced a clean terminal for mutilated work, i.e. the
   terminal would be a LIE. Here the terminal is TRUE and the export failure would make it a lie.
2. **The likeliest refusals are lifecycle-window mistakes, not work failures.** The refusal reasons
   the export path already surfaces by name are `attempt_terminal` / `stale_fence` /
   `target_revoked` (`packages/worker-daemon/src/lease/artifact-export.ts:344-347`, and the
   `rejected`-first branch at `:348-350` that carries them). All three mean *"this ran outside the
   lifecycle window"* — a **placement** bug in slice c's own hook, not a statement about the agent's
   work. Failing the attempt on those would convert every §3.1 timing error into a false red run.
3. **A store outage would already fail every run, so fail-closed buys nothing at the margin.** An
   S3-compatible store is a **hard precondition** for the whole export arm: `artifact-commit.ts:141-145`
   fails closed when the store cannot supply a checksum (`if (typeof head.contentLength !== "number"
   || !head.checksumSha256) return rejected("event_hash_mismatch")`, with its own comment *"integrity
   unverifiable → fail closed"*), and `checksumSha256` is supplied only by `storage/s3-provider.ts`.
   So the systemic-outage scenario a fail-closed export is imagined to protect against is one in
   which **every** distributed run fails anyway; what fail-closed actually buys is turning
   *individual, transient, mostly-our-fault* refusals into red runs.

★★ **THE COST OF THIS RULING, RECORDED RATHER THAN GLOSSED — and it is real: evidence can be silently
lost.** A best-effort export that refuses leaves a run that terminalized `succeeded` with no artifact
and, unless something says otherwise, no trace of the attempt. Three obligations follow, and slice c
is not done without them:

- **It must emit.** `emitOp("export_artifact", "failed")` is mandatory on every refusal branch, not
  best-effort about being best-effort. The metric labels already exist —
  `packages/worker-daemon/src/metrics/metrics.ts:120-121` registers `digest_artifact` and
  `export_artifact` — so this costs nothing and its absence is E7-F010's exact failure class (an
  unregistered label throwing on the happy path).
- **The reason must survive.** The export direction already reports the server's refusal reason by
  name (`artifact-export.ts:341-350`); the download mirror does not, and reports every refusal as
  *"malformed grant"* (**E7-F017**). A best-effort ruling is only safe while the log line names
  `attempt_terminal` rather than a protocol-bug lookalike, so **E7-F017's asymmetry must not be
  "fixed" by making the export side match the download side.**
- **It needs its own mutant.** The reserved paragraph says so and it is right: a positive control in
  which the export refuses and the run still reaches `succeeded` with a `failed` op — and its
  converse, a run whose terminal is unchanged by the refusal.

**The road not taken, and what it would have cost.** Fail-closed would have bought exactly one thing:
"if the evidence is missing, the run is red, so nobody quotes a green run with no artifact." That is
a genuine property and it is the property `capabilityProven` is *supposed* to provide — but at the
price of (a) reporting a successful agent as failed on an infrastructure fault, (b) making every
lifecycle-window placement error in slice c look like an agent failure, and (c) coupling the run's
verdict to object storage on a path where storage is already a global precondition. The verdict a
missing artifact should move is **clause 6**, which is a judge, not the attempt's terminal status,
which is a fact about the tenant command.

#### ★★★ RULING B (the placement question §3.1 leaves half-answered) — **only the NORMAL terminal (`:795`) exports**

**Who ruled, and at what authority.** Same unit, same date, same standing as Ruling A: an
implementer-level default for slice c, overturnable by measurement. §3.1 above already says the
export goes *"between step 3b (`observeRun`, `:774-791`) and step 4 (`events.terminal`, `:795`)"*;
what it does **not** say is what happens at the **other thirteen** terminal call sites. This ruling
says: nothing. They do not export.

**COUNTED, because the record disagreed with itself.** The tasking brief said 14 call sites; another
reader said 15. **Measured at `31d33a3b0`: exactly 14**, and all 14 are in
`packages/worker-daemon/src/supervisor/supervisor.ts` —
`grep -c "events.terminal(" packages/worker-daemon/src/supervisor/supervisor.ts` → `14`, at lines
**510, 519, 545, 574, 584, 594, 623, 643, 675, 697, 733, 751, 765, 795**. Nowhere else in
`worker-daemon/src` calls it: `supervisor/events.ts` holds the method *definition*, and
`lease/artifact-export.ts:249` mentions `events.terminal()` only in prose.

**Of those 14, exactly TWO are downstream of `emitOp("execute", "success")` at `:760`** — the earliest
point at which any file the agent wrote could exist — namely **`:765`** (cancelled while executing)
and **`:795`** (the normal terminal). The other **twelve** precede `:760` and are therefore not
candidates: they terminalize before the tenant command has returned at all.

★★★ **THE LOAD-BEARING NUANCE: "only the normal terminal" is NOT "only successful runs."** `:795`
carries **both** `succeeded` and `failed`, because `:792` computes
`exec.exitCode === 0 && !exec.timedOut ? "succeeded" : "failed"` from a result the provider now
**returns**. That is E7-F014's resolution (`packages/sandbox-e2b-provider/src/real-transport.ts:157-164`,
PR #351): a `CommandExitError` with a numeric `exitCode` is narrowed and
`return { exitCode, signal: null, timedOut: false, crashed: exitCode !== 0 }` — a non-zero exit
**arrives as a result rather than a throw**. Before that fix, every failing run left through the
`catch` at `:741` and this ruling would have excluded all of them, which is precisely why E7-F014 was
recorded as a **prerequisite** for any return path rather than an objection to one
(`CLI-008-unit-f-design.md` §3.7, §5, §11). ★ The narrowing fails closed: a `CommandExitError` whose
`exitCode` is not a number, and any other error class, still throws (`real-transport.ts:161-168`), so
a genuine sandbox/transport fault is still case (b) and still leaves via `:751`.

★★ **WHAT THIS RULING LOSES — and the brief's grouping of it is CORRECTED.** The brief named three
lost teardown paths as if they were equivalent. Measured, they are not, and the difference matters:

| path | line | relative to `:760` | could a file exist? |
|---|---|---|---|
| cancelled while executing | `:765` | **DOWNSTREAM** | ★ **Yes, demonstrably** — `exec` already returned; the sandbox is still alive (`escalateCleanup` runs after `:765`) |
| the `withDeadline` `execute_timeout` race | `:733` (block `:729-740`) | upstream | Possibly — the command ran and may have written before the deadline fired, but no exit status exists to attribute it to |
| a genuine provider fault, and the common cancel/lease-loss rejection | `:751` (block `:741-758`) | upstream | Possibly, same caveat; the comment at `:745-748` records that the cancel/lease-loss teardown is what makes the in-flight `execute` reject here |

So there is **one** loss with a provably-possible file (`:765`) and **two** where a partial file may
exist with no verdict to attach it to.

**Why `:765` is nevertheless excluded, stated as a judgement rather than a fact.** A cancelled run is
the case where the fence is *most likely already gone*: an upload grant requires a live fence
(`artifact-transfer-grant.ts:99` → `lockActiveFence`; `classifyFence` returns `attempt_terminal` the
moment the attempt is terminal, `job-fence.ts:482-488`), and cancel/lease-loss is exactly the
lifecycle edge §3.1 warns about. So exporting there would most often hit `stale_fence` /
`target_revoked` / `attempt_terminal` — i.e. the refusals Ruling A has just declared best-effort —
while adding a second, differently-shaped call site to a sequence whose whole difficulty is *where*
it sits. **One placement, argued once, is worth more than two placements each argued half.** If a
later measurement shows the fence is reliably live at `:765`, adding it is a small, separable change
and this table is the argument to revisit.

**What is NOT ruled here.** Nothing about the twelve upstream sites changes, no new terminal is added,
and no cleanup path is touched. In particular this ruling does **not** endorse the frozen
`late_output` quarantine reason as a fallback: §3.1 already records that `runOrphanQuarantine`'s only
production caller is behind `E4-3-survives-restart`, which is `unwired`, so the late-output path is
unreachable and must not be designed against.


### Slice d — composition in `dispatch-runtime.ts` + promote the gate clause

The `createStagedInputResolver` shape at `dispatch-runtime.ts:172-178`, plus flipping the register
entry to `wired` with evidence. **Nothing produces `ArtifactExportRequest[]` yet**, so d is
gated on a producer and must not invent one.

### Slice e — a REAL `E2bSandboxProvider.exportArtifact` (§1.6 link 2)

`artifactExportMode: "grant_upload"`, `#transport.readFile` (`real-transport.ts:196`) for the digest,
`fetch` + `grantPutHeaders` for the PUT. **Provider-specific and separately schedulable**; it is what
makes the port's declaration true for one provider. Needs a live-lane proof, not a unit test — the
recipe is `DAT-002-live-minio-result.md`.

### Slice f — NOT DAT-009's. The producer, the kind, and the counter.

Whoever decides *which* file is exported and under which `kind` owns §0's gate question. That is
CLI-008 Unit F (§1.6 links 1, 4, 5). **DAT-009 must not absorb it**, and this design deliberately
does not size it.

---

## 5. Tests

Substrate, **as built**: a local control-plane double that answers both ops and records every parsed
request body — the shape `staged-input-resolver.test.ts` uses, chosen over
`support/fake-control-plane.ts` for the same reason it was there, namely that the load-bearing cases
are SCRIPTED REFUSALS and a faithful double cannot be made to emit them on demand. The provider half
is a recording `SandboxArtifactExporter`, plus `fake-provider.ts`'s already-built `grant_upload`
double for the `EffectAuthority` rows. No sandbox, no store, no server.

| # | Area | Test |
|---|---|---|
| 1 | Happy path | four calls, in order, and the returned ref names the committed object key |
| ★ 2 | **Order** | the grant request carries the digest step's `sha256`/`sizeBytes`, so a mint before a digest is structurally impossible |
| ★ 3 | **§3.3 — no speculative mint** | a `digest` that throws (absent path) produces **zero** `artifactTransferGrant` calls |
| ★ 4 | **§3.2 — the header helper** | `grantPutHeaders` returns base64, not the grant's hex, and both header names. A hex-forwarding mutant dies |
| ★ 5 | **The rejection reason SURVIVES** | a server `rejected{reason:"stale_fence"}` produces an error naming `stale_fence` — the §6 defect, not re-committed |
| 6 | `upload` pairing | a cross-paired `download_granted` is refused (`isTransferGrantResponsePairedV1`, used correctly — §6) |
| 7 | Commit refusal | `rejected{event_hash_mismatch}` surfaces as a distinguishable failure, never a fabricated ref |
| ★ 8 | **The grant never leaks** | no thrown message, no returned value and no logged field contains `grant.url`. The port already classifies this value as sensitive (slice 1 §4) |
| 9 | Key binding | `expectedObjectKey` starts with `expectedAttemptObjectPrefix` for the envelope's OWN org — a foreign org is refused server-side, and the worker must never build one |
| 10 | Idempotency | a retried export presents the SAME `idempotencyKey` and the SAME `artifactId` (§4 slice a's derived id), not a fresh pair — and the grant's key is NOT the commit's |
| ★ 11 | Anti-vacuity | `requests: []` returns `[]`, makes **no** HTTP call **and does not even fetch the session** — and the test asserts every count, so a sequencer that silently did nothing on a non-empty list cannot pass |
| ★ 12 | A `committed` with no `versionNumber` | refused, rather than returning a reference whose `number` field is `undefined` |
| ★ 13 | **§3.4.1 — slice b's fence gate** | a WITHDRAWN `EffectAuthority` refuses both methods, **synchronously**, before the bearer grant reaches any implementation |
| ★ 14 | **§3.4.2 — slice b's labels (E7-F010)** | `digest_artifact` and `export_artifact` pass the closed allow-list, with an unregistered neighbour asserted to still THROW as the positive control — so the row measures the allow-list and not a metrics object that accepts anything |

**As built: 16 tests, 12 mutants, 12 killed, every mutation restored and the restore re-verified.**

★ **Two of these rows exist BECAUSE of the mutation pass, and both are the same lesson.** Row 11's
session-count assertion was added when M2 (delete the early return) stayed **green**: the loop body
does not run for an empty list either way, so the early return had no pinned property until the test
named the one it actually buys — *a run with nothing to export cannot fail on the export path, even
when the session is unrenewable.* Row 12 was added when M12 (delete the version check) stayed
**green**, because the double always answers with a version. **A surviving mutant is a question, and
in both cases the answer was a missing test rather than a guard worth deleting.**

The two that matter most are 3 (an orphan per empty run) and 4 (a PUT that cannot succeed, in a way
no unit test with a double would ever notice, because the double is not S3).

---

## ★ 6. A defect in the exemplar, found while reading it to mirror it — filed as E7-F017

`isTransferGrantResponsePairedV1` **returns `true` for `"rejected"`**
(`packages/worker-protocol/src/transport.ts:350-358`, line 354: `if (responseOutcome === "rejected")
return true;`). So in `staged-input.ts:252-255` the guarded branch —

```ts
if (!isTransferGrantResponsePairedV1("download", body.outcome)) {
  // A `rejected` lands here, and so would a cross-paired `upload_granted`.
```

— **is unreachable for a `rejected`**, contradicting its own comment. A rejected response falls
through to `artifactDownloadGrantV1Schema.safeParse(body.grant)` with `body.grant` undefined, fails,
and is reported as `"malformed grant"`. The server's actual reason — `stale_fence`,
`attempt_terminal`, `target_revoked`, `malformed` — is **discarded**, and the operator is told the
control plane sent a malformed grant when it sent a correct refusal.

It **fails closed** (the throw still happens), so it is LOW. It is recorded here because slice 3
mirrors this module, and mirroring it faithfully would reproduce the defect on the upload side —
where the refusals are *more* informative, since `attempt_terminal` is precisely the §3.1 window
being missed. Test 5 pins the correct behaviour for the new module.

★ Same family as terrain §9's *"a value computed, handed to the thing that could act on it, and
dropped"* — here the value is the refusal reason and the actor is the operator.

---

## 7. Out of scope, and why

- **A producer of `ArtifactExportRequest[]`** (§4 slice f). This ticket sequences; it does not decide
  what to export.
- **`artifactPrepared` emission** — §1.6 link 4. Frozen and available (`events.ts:358`, payload
  `:92-94`, already in the `job_events` CHECK), but it is announcement, not return, and it flips no
  counter.
- **`task_outputs` projection** — `E3-17-output`, a different epic's clause.
- **The orphan sweeper** — slice 2 + DAT-011, done and live-proven. Not re-opened.
- **`maxBytes` enforced at write** via a signed content-length-range condition — terrain §9 /
  slice 2 §8.3, still open, still its own ticket.
- **A frozen TTL ceiling for ordinary grants** — slice 2 §8.1, an E4-D02 STOP.
- **`local_disk` deployments.** `presignPut` is optional (`storage/types.ts:65`) and both grant
  services throw without it, and the local-disk provider supplies no `checksumSha256` so commit
  fails closed anyway (`artifact-commit.ts:141-145`). **An S3-compatible store is a hard
  precondition** for every slice here. Terrain §5's missing runbook is still missing.

---

## 8. Traps

- **Do not mint before you digest.** §3.3 — since slice 2 a mint is a durable row.
- **Do not run the export after the terminal event.** §3.1 — and do not "fix" it by reading the
  drain; the drain is not a fence.
- **Do not let a provider re-derive the PUT headers.** §3.2 — hex is not base64, and the store will
  not tell you which one it wanted.
- **Do not add `digest_artifact`/`export_artifact` to `emitOp` later.** §3.4 — a missing label is a
  no-terminal run on the HAPPY path (E7-F010).
- **Do not claim this moves `capabilityProven`.** §0 — the arm filters `kind = 'workspace_patch'`
  and links 1 and 2 are unbuilt.
- **Do not mirror `staged-input.ts`'s rejected branch.** §6.
- **`grep` lies in this tree.** Terrain's warning stands: many tracked files carry NUL bytes, so use
  `grep -a`.
