# CLI-008 Unit F — TERRAIN + FINDINGS. **The supply mechanism is NOT YET DESIGNED.**

**Epic:** E7 · **Plan node:** `docs/replatform/program-design.md`, `#### CLI-008`
**Status:** `terrain` — measured ground and two filed findings. **There is no buildable plan in this
document, and none should be inferred from it.** · **Size: UNSIZED** (see §2 — the XL estimate is
refuted, and the L that replaced it is **withdrawn**, because L was the size of a plan that no longer
stands) · Measured in `C:/uf` at `611a78bfb` (base `c48259358`), 2026-09-04, **fourth pass**.

★★★ **READ THIS BOX BEFORE ANYTHING ELSE.**

> This ticket has now proposed a supply mechanism **three times** and been refuted three times: on
> argv **shape** (round 1), on argv **size** (round 2), and finally on **the predicate itself**
> (round 3). §4 states all three with citations.
>
> The third refutation is the one that changes the document's *kind* rather than its details. Round
> 3's plan removed clause 6's forgeable `task_outputs` arm and **widened** the artifact arm off its
> `kind = 'workspace_patch'` filter. Measured (§4.3): the widened arm is satisfied on **every**
> converted distributed run by the run's **own staged input bundle** — the prompt the control plane
> writes *into* the sandbox before the attempt is even leasable. That is the same class as this
> document's own **E7-F015**: drop one forgeable arm, widen the other into a differently-forgeable
> one. **The core move is itself the defect**, which makes it a scope conclusion rather than a
> detail to patch.
>
> So the previous revision's lettered slice plan (A–G), its positive-control table and its acceptance
> criteria **have been deleted, not demoted**. A refuted plan left standing in a design document gets
> built. What survives is terrain, two findings, the three refutations, and a named blocking
> dependency (§5). **Do not read §3 or §6 as a fourth mechanism** — §3 is measured ground, §6 is a
> list of tests any future candidate must survive, and neither is a proposal.
>
> ★★★ **AMENDED 2026-09-06 (W6U1) — THE RULING IS NOW RECORDED: §12, DEFERRED PENDING
> MEASUREMENT.** A 26-agent decision wave put this document's question to four candidate answers over
> sixteen adversarial passes and returned **two** `sound` verdicts and **46** unrebutted fatal
> problems; its recommendation was to build **no mechanism** and **measure first**. §12 records that
> as the ticket's position and names the **three probes** that would decide it — (a) can a real
> claude/codex under the EXACT production argv, with no permission flag, write a file in the
> `aoa-base` template at all (**the decisive one**); (b) is the configured template already satisfying
> a location-based convention; (c) does the stream handler deliver from real E2B. ~~**A fourth
> mechanism proposed before probe (a) returns will be refuted for the same reason as the first
> three.**~~ §13 records a fifth option — *"do not build it"* — that was LOST to a serialization
> failure and therefore **never adversarially attacked**; it is recorded, NOT adopted, and §13.3 says
> what must not be done with it. Six new findings were filed with this amendment: **E7-F021** (HIGH),
> **E7-F022**, **E7-F023**, **E7-F024**, **E7-F025** (MEDIUM) and **E7-F026** (LOW).
>
> ★★★ **AMENDED AGAIN 2026-09-07 (W12) — ALL THREE PROBES HAVE RETURNED; THE DEFERRAL IS LIFTED AND
> ITS STOP CONDITION IS REPLACED, NOT DELETED (§12.0, §12.3).** Run
> [`34087197668`](https://github.com/MeteoriteLabs/AoA/actions/runs/34087197668) (record:
> [`W7U1-output-probe-result.md`](./W7U1-output-probe-result.md)) measured: **(a)** a sandboxed
> `claude` under the exact production argv exits **0 and writes nothing**, and **writes when the
> permission posture is added** — a single-variable differential, so **E7-F021 is now a measured
> product defect** rather than a missing measurement; **(b)** the template pre-fills **nothing**;
> **(c)** both streams deliver. §12.0.1 records which of the four candidate answers this **revives**
> (three, *conditionally*, and for `claude_local` only) and which it does not. The new stop condition
> is **two clauses**: no mechanism before the posture is **in the product** (a reviewed, merged diff —
> the literals are unchanged at this tip), and no **adapter-agnostic** mechanism before codex's own
> blockers are characterised. Three further findings were filed: **E7-F027** (MEDIUM — codex is
> refused by its own trusted-directory gate before any model call, so a posture-only fix would leave
> it broken while looking like a fix), **E7-F028** (MEDIUM — the probe's codex verdict states a cause
> its own stderr contradicts) and **E7-F029** (LOW — the pack's self-test emits a second, synthetic
> report). ★ **This amendment ships NO product change**, and it is not permission to make one.
>
> ★★★ **AMENDED AGAIN 2026-09-18 (post-E7-1) — STOP-CONDITION CLAUSE 1 IS NOW DISCHARGED FOR
> `claude_local`; THE "LITERALS ARE UNCHANGED AT THIS TIP" PHRASING IS STALE.** The two-clause stop
> condition above (repeated at `:1100-1101` and `:1201`) was written 2026-09-04, before the posture
> landed. **E7-F021 is RESOLVED (2026-09-11, founder-authorized):** the posture PR added
> `--dangerously-skip-permissions` to BOTH claude literals in
> `server/src/services/task-run-sandbox-invocation.ts` (guarded RED-when-removed by
> `server/src/__tests__/task-run-batch-workload.test.ts`). So **clause 1 — "no mechanism before the
> posture is in the product (a reviewed, merged diff)" — is DISCHARGED for `claude_local`**: a
> sandboxed claude now writes. **Clause 2 STILL STANDS:** codex is unchanged (**E7-F027 open** —
> refused by its own trusted-directory gate), so any near-term mechanism must be **`claude_local`-only**,
> not adapter-agnostic. ★ **This does NOT reopen the measure-first ruling or license a mechanism.** The
> supply mechanism remains the 3×-refuted terrain of §4 and the measure-first position of §12/§13;
> clause 1 clearing means only that its *precondition* is met, not that a fourth mechanism is approved.
> **NO product change ships with this amendment.**

**Governing decision:** [`DECISION-byte-egress-and-provider-topology.md`](../../../DECISION-byte-egress-and-provider-topology.md)
— Option D, "the provider reads the file from inside its sandbox and PUTs it directly to object
storage under a worker-minted grant; the port carries a grant inbound and a reference outbound, and
**never bytes**." Nothing here re-opens that decision; it constrains every candidate mechanism
equally (§3.8, §6).

---

## 0. What this document is

Unit F was chartered to answer *"what supplies the output"* — the thing that makes
`capabilityProven` mean something. Three passes tried to answer it and three failed. This pass
**stops proposing** and publishes what the three passes actually established, which is a great deal:

- **Terrain (§1, §3).** The bar's exact predicate, a complete write census of both its arms, the
  byte pipeline that is already live-proven, the pin surface enumerated by search, and the one
  measurement that constrains *every* candidate mechanism equally (E7-F014, §3.7).
- **Findings (§1.3, §1.4, §8).** **E7-F015** — the capability bar is forgeable by one board POST —
  survived all three rounds of attack and is the most valuable thing here. **E7-F016** — clause 6's
  operator-facing text misdescribes its own subject — survived too.
- **The refutations (§4).** Three mechanisms, one seam, then the predicate. Written down because the
  next author will reach for each of them in the same order.
- **The blocker (§5).** E7-F014 is a **prerequisite** for any return path, not an objection to one
  mechanism, and it is being fixed elsewhere.

★ **A bounded, cited "not yet, and here is exactly what blocks it" is the outcome.** What this
document must not do is produce a fourth mechanism under time pressure; the first three all looked
right when written.

★★★ **The one thing every pass agreed on, and it is worth stating alone because it survived every
attack.** `capabilityProven` is computed from two SQL counts over control-plane rows. A count over
rows can assert **provenance** — *these bytes reached durable AoA storage through an attested path* —
and it can never assert **productivity** — *these bytes are the work the task asked for*, because the
verifier reads tables and never an artifact's bytes. The two arms of clause 6 fail on **different
axes**:

| arm | provenance | productivity |
|---|---|---|
| `task_outputs` where `created_by_run_id = run.id` | **none** — any company-scoped actor can POST it (§1.3, E7-F015), **and the platform writes one by itself on the default configuration** (§1.2a, E7-F020) | none |
| a `committed` `job_artifacts` row | **full** — live fence, verified device proof, attempt-scoped object prefix, control-plane `headObject` re-verifying the declared SHA-256 | **none** |

Collapsing that into one word ("non-probative") is what let round 1 argue both sides of a single
principle. Naming the axis is what round 3 got right — and §4.3 is the measurement showing that
getting the axis right did **not** make the predicate change safe.

---

## 1. Terrain — measured in this worktree

Everything in §1 was opened and read in `C:/uf`. Where a line number differs from an earlier record,
§10 says so.

### 1.1 The bar, exactly

`E7ProducedOutputCounts` is two numbers and nothing else
(`server/src/services/e7-distributed-run-verifier.ts:126-129`):

```ts
export interface E7ProducedOutputCounts {
  readonly workspacePatchArtifacts: number;
  readonly taskOutputs: number;
}
```

Clause 6 is the module's **only** `capabilityFailures.push`, guarded by an AND of two misses
(`:506`), and `capabilityProven` is `capabilityFailures.length === 0` (`:522`). `ok` is computed
from a disjoint array, so neither verdict can suppress the other — Unit A's shape, unchanged.
`e7VerifyExitCode` short-circuits `return 1` on `!ok` before reading capability (`:549`), so
`--require-capability` partitions the already-green population into exit 0 and exit 3.

The two counters come from `countProducedOutputs`
(`server/src/services/e7-distributed-run-verifier-store.ts:198-218`):

| arm | predicate | who can write it |
|---|---|---|
| `workspacePatchArtifacts` | `job_artifacts` where `job_id = run.distributedJobId` **AND `kind = 'workspace_patch'` AND `status = 'committed'`** (`:201-211`) | ONLY `commitArtifactVersion`, behind a live fence, a device proof, and a control-plane `headObject` that independently verifies the object's `ChecksumSHA256` — **and, since Unit B, also `stageJobInputFiles`, which is where round 3 died (§4.3)** |
| `taskOutputs` | `task_outputs` where `created_by_run_id = run.id` (`:213-216`) — **no type, provider, agent or provenance filter** | anything that can write the table |

★ **The table's right-hand column is the whole subject.** The two arms are not "one strong, one weak"
on a single scale — they differ on **who can cause the row to exist**, and on nothing else. Neither
arm reads a byte of the artifact, so neither can say anything about *what* was produced.

★ **Two different citations for the same predicate.** `store:165` is the byte-identical
`eq(taskOutputs.createdByRunId, run.id)` inside `listRunSecretScanSurfaces` — the **clause-4 leak
scan**, not the counter. Earlier records that cite `:166` for the capability bar are pointing at the
`for (const o of outputs)` loop header of the wrong function. The conclusion (one predicate, run
linkage only, nothing workspace-related) holds at both sites.

### 1.2 The write census for each arm

**`workspacePatchArtifacts` — zero producers, and the missing producer is not merely uncomposed.**
`createResultCommitter` (`packages/worker-daemon/src/patch/result-commit.ts:66`) needs an injected
`commitVia` and a `BuildWorkspacePatchInput` carrying **base and result `WorkspaceManifestV1`s**.
The only manifest producer, `buildWorkspaceManifest`
(`packages/worker-daemon/src/snapshot/build-manifest.ts:308`), imports
`lstatSync/readFileSync/readdirSync` from `node:fs` (`:24`) and walks the **daemon's own**
filesystem. On the E2B lane the agent's files are inside a remote sandbox the daemon cannot `lstat`.
So this arm is blocked on two things at once: a repository to diff (**Unit E**) and an in-sandbox
manifest capture that **does not exist anywhere in the tree**.

**`taskOutputs` — a census closed on the sole INSERT site, not on a grep.**

★★★ **RE-DERIVED 2026-09-06 (W4U3-R4).** Two earlier headings are kept visible because this census is
where E7-F018's fact (4) came from, and a fail-open enumeration propagates: R2 read *"six writers,
NONE of which can fire on a distributed run, and one that can be `curl`ed"* and dismissed the
runtime-service writer on a false reason; R3 corrected the verdicts but left the denominator
("six writers") arbitrary — it listed six of the ten callers, omitting four while including two that
cannot carry a run id at all.

★★★ **THE WARRANT.** There is exactly ONE insert into `task_outputs` in **production source** —
`.insert(taskOutputs)` at **`server/src/services/task-outputs.ts:181`**, inside
`upsertTaskOutputForIssue` (`:135`); the only others in the tree are three raw-SQL admin fixtures
under `server/src/__tests__`. So a row cannot be **CREATED** without calling that function, and
enumerating **its callers** closes the census of writers able to MINT a `created_by_run_id` — which
grepping for `createdByRunId` cannot do, because
`routes/task-outputs.ts:54` forwards `req.body` and never names the field. Re-close it with
`grep -rn "insert(taskOutputs" server packages --include=*.ts` (exactly one hit) plus
`grep -rn "upsertTaskOutputForIssue\|upsertForIssue" server packages ui --include=*.ts --include=*.tsx | grep -v __tests__`
(17 lines, of which ELEVEN are call sites — the rest are one import, two declarations and three prose
comments). **Limits of that method, named:** it sees a literal `.insert(taskOutputs)` and a literal
`INSERT INTO` / `COPY` on the table; it would miss a runtime-assembled table name or a DB-side
trigger. Both were checked at this tip and are absent — the only `sql.raw` INSERT in the tree targets
`memory_items` (`memory-projection.ts:151`), and the six migrations naming `task_outputs` carry DDL,
one column `UPDATE`, and `GRANT`/RLS only. ★ A repo-wide raw-SQL sweep must exclude `docs/` and
`scripts/`, or this paragraph and E7-F018's register entry match it back at you.

★★★ **CREATION vs the COLUMN, and the seam.** The warrant above closes row CREATION. It closes the
**column** for a SECOND and independent reason, because **three UPDATE sites do NOT pass through the
chokepoint**: `updateMutable` (`task-outputs.ts:237`), `clearSiblingPrimaries` (`:71`, reached from
`updateMutable:231` as well as from inside the chokepoint at `:147`) and `workspace-runtime.ts:2890`.
(The fourth `.update(taskOutputs)`, `task-outputs.ts:167`, IS inside the chokepoint.) None of the
three can set `created_by_run_id`: the latter two set only `is_primary`/`updated_at` and
`status`/`health_status`/`url`/`updated_at`, and `updateMutable` spreads a body validated by
**`mutableTaskOutputSchema`, which is `.strict()` and omits `createdByRunId`**
(`packages/shared/src/validators/task-output.ts:55-63`) — `validate()`'s `schema.parse`
(`middleware/validate.ts:6`) throws on a request carrying it. ★★★ **THE SEAM:** the column half of
this warrant rests entirely on that `.strict()` omission. **If `createdByRunId` were ever added to
`mutableTaskOutputSchema`, `PATCH /api/task-outputs/:id` (`routes/task-outputs.ts:87-97`) would
become a writer this warrant is structurally unable to see** — it never calls
`upsertTaskOutputForIssue`, so no enumeration of the chokepoint's callers would list it. A future
round must re-check the schema, not only the caller list.

**Eleven production call sites reach that insert; TEN are legacy and the eleventh is the distributed
producer, kept out of the table below. FOUR of the ten can carry a `heartbeat_runs` id; TWO of those
can fire on a distributed run.**

| # | caller of the chokepoint | `createdByRunId` | reachable on a distributed run? |
|---|---|---|---|
| 1 | `task-output-emitters.ts:150` (`emitSandboxPreviewTaskOutput`), sole caller `heartbeat.ts:5557` | `run.id` (`:5574`) | **No.** `return; // CLI-006-SUPPRESSION-RETURN` at `heartbeat.ts:5451` fires whenever `shouldSuppressLegacyExecution(owner)` — i.e. `owner?.owner === "distributed"` — and sits above `adapter.execute` (`:5453`) and above this emitter, all inside `executeRun` (`3061`–`6119`) |
| 2 | `routes/output-detection.ts:181` — `POST /heartbeat-runs/:runId/detected-outputs/:index/confirm` (founder confirm) | `runId`, a **path param** (`:201`) | **No.** Its only feed is `heartbeat_runs.detected_outputs`, whose sole creating writer is `heartbeat.ts:5907` — also past the suppression return, and additionally reading `adapterResult`, which only `adapter.execute` assigns. ★ **This is not the route E7-F015 is about** — see §1.3 |
| 3 | **`task-output-emitters.ts:113`** (runtime service) | `row.startedByRunId` | **YES — and the old "needs a `workspace_runtime_services` row" is not a blocker, because THE SAME RUN MINTS ONE.** `ensureRuntimeServicesForRun` (`heartbeat.ts:4524`) → `startLocalRuntimeService` (`workspace-runtime.ts:2649`, `startedByRunId: input.runId`) → `persistRuntimeServiceRecord` (`:2383`, status `"starting"`, before `waitForReadiness`) upserts the row AND emits (`:1821`), so `created_by_run_id = run.id`. `:4524` precedes the canary block (`:5258-5274`), the handoff (`:5422`) and the suppression return (`:5451`), all in the same `executeRun` (`:3061`). ★ It is ALSO reached from `task-output-backfill.ts:91`, which runs from **GET** `/api/issues/:issueId/outputs` (`routes/task-outputs.ts:40`) when the issue has no outputs yet. See **§1.3a / E7-F020** |
| 4 | **`routes/task-outputs.ts:54`** — `POST /api/issues/:issueId/outputs`, mounted `app.ts:566` | **whatever the request body says** | **YES — see §1.3.** This is E7-F015's actual subject, and R2/R3 omitted it from the census while attributing E7-F015 to row 2 |
| 5-10 | `crew-output-capture.ts:129` (hard-coded `null` — a crew run id lives in `internal_agent_runs` while the column FKs `heartbeat_runs`); `attach-task-artifact-tool.ts:164` (sets only `createdByAgentId`, `:162`); `task-output-backfill.ts:50`; `emitPullRequestTaskOutput` (`:71`); `emitBranchTaskOutput` (`:162`); `task-outputs.ts:213` (the service wrapper delegating into the chokepoint, not an independent writer) | never set | Structurally incapable |

★ **A fifth capable caller is deliberately outside this table:** `job-output-bridge.ts:303`
(`input.output.createdByRunId ?? null`). That is the DISTRIBUTED producer, closed by E7-F018's facts
(1)-(3) — zero production callers, a fail-closed second flag, and a caller-supplied run id. Listing it
among the *legacy* writers would double-count those facts.

★ **Closure property.** Row 3 is E7-F020, row 4 is E7-F015: there is no live writer without a finding
and no finding without a live writer. A future round that finds an eleventh caller able to carry a run
id breaks that property, and should say so rather than widening the table quietly.

### 1.2a ★ FINDING E7-F020 — and one of them needs no `curl` either

The runtime-service row above is the second reachable writer, and it is the more dangerous of the two
because **no actor is involved**. Full statement, fail-open configuration and the both-directions
severity argument: **E7-F020** in
[`../findings.md`](../findings.md). The short form for this document: on the DEFAULT isolated-workspace
configuration, a canary run that declares one `workspaceRuntime.services[]` entry writes a
`task_outputs` row under its own run id before it is handed off — so arm 2 reads non-zero, and
`capabilityProven` reads TRUE, for a run whose agent produced nothing.

★ **Why it is filed apart from E7-F015 rather than folded into it.** The natural fix for E7-F015 is an
authorization one — refuse a caller-supplied `createdByRunId`, tighten the schema, guard the route.
That fix is correct, it closes E7-F015, and **it does not touch E7-F020 at all**. Any replacement
predicate for arm 2 must distinguish *produced by the agent* from *emitted by the platform on the
agent's behalf*; excluding untrusted callers is not sufficient. Read both before designing §4.3's
replacement.

### 1.3 ★ FINDING E7-F015 — the capability bar is forgeable by a board POST

**This survived all four rounds and is the most valuable thing in this document.**

★ **The route is `server/src/routes/task-outputs.ts:45-53` (§1.2 row 4), and nothing else. Stated
2026-09-06 (W4U3-R4) because the confusion actually happened:** E7-F018's fact (4) carried this
finding's label against `routes/output-detection.ts:201` for two rounds. That is §1.2 row 2 — a
different route, `POST /heartbeat-runs/:runId/detected-outputs/:index/confirm`, whose run id is a
**path param** rather than a body field, and which **cannot** fire on a distributed run. Row 2 stays
in the census with that verdict; E7-F015 is about row 4.

`upsertTaskOutputSchema` (`packages/shared/src/validators/task-output.ts:50`) admits
`createdByRunId: z.string().uuid().nullable().optional()`; the route hands `req.body` straight to
`svc.upsertForIssue` (`routes/task-outputs.ts:53`); and the only guard on that field is
`assertCompanyOwnedRef(db, heartbeatRuns, input.createdByRunId, companyId, "Heartbeat run")`
(`services/task-outputs.ts:123`) — the run must merely belong to the issue's company. Only `type` and
`title` are required.

So **one authenticated POST of `{type:"external_link", title:"x", createdByRunId:"<the canary run>"}`
flips `capabilityProven` to true**, with no agent, no worker, no sandbox and no output. That is the
gate the whole programme is pointed at. Filed as **E7-F015**, MEDIUM (the present reach is bounded:
`--require-capability` is off by default, no workflow runs the verifier, and GO-BOOK §9 tells the
operator not to pass it — but Unit F exists precisely to make an operator start passing it).

★★★ **The finding stands; the fix it originally recommended does NOT.** Its register entry proposed
removing this arm and widening the artifact arm. §4.3 measures why that fails, and the register entry
has been corrected in the same commit as this document. **A finding can be right while its
recommended fix is wrong** — that is the transferable half of this whole pass.

### 1.4 ★ FINDING E7-F016 — clause 6's own failure text names four links, three of which cannot flip either counter

The reason string printed to the operator on every verify run
(`e7-distributed-run-verifier.ts:509-515`) says output capture is unbuilt because:

| the text's link | measured |
|---|---|
| "the E2B driver passes no stream handlers" | TRUE at `e2b-provider.ts:261-297`, but **the transport already implements them**: `RealE2bTransport.runCommand(req, handlers?)` binds `onStdout`/`onStderr` to the E2B SDK (`real-transport.ts:107-120`). And wiring them **flips neither counter**: `log` events are not `job_artifacts` and not `task_outputs` |
| "`stdoutRef`/`stderrRef` are fabricated literals" | TRUE (`e2b-provider.ts:276,293`). Making them real *means* exporting bytes to object storage — i.e. it is not a separate link, it is the same work as the artifact path, named twice |
| "`observeRun` is uncomposed" | TRUE (`lifecycle/dispatch-runtime.ts:178-181`, with the absence stated in the comment). `RunObservation` is `{logs?, progress?, usage?}` (`supervisor/supervisor.ts:73-77`) — **flips neither counter** |
| "`buildWorkspacePatch`/`createResultCommitter` have zero production callers" | TRUE, and the only one of the four that touches a counter — but it is blocked behind Unit E **and** behind the missing in-sandbox capture of §1.2, neither of which the text names |

And it omits the links that are actually decisive: `artifactExportMode: "none"` on **both** shipped
providers (`sandbox-e2b-provider/src/e2b-provider.ts:178`,
`provider-wire/src/driver.ts:83`) — ★ **half of this citation went stale 2026-09-04 (PR #353): the
E2B provider now declares `"grant_upload"`. E7-F016 is UNAFFECTED — its subject is that clause 6's
reason string omits the decisive links, and an omitted link being built later does not make the text
name it** — the absence of any `artifactPrepared` emitter on `EventSequencer`
(seven emitters at `supervisor/events.ts:147,155,162,170,178,206,220`; `artifact_prepared` is in the
frozen vocabulary at `worker-protocol/src/events.ts:358` with payload `{artifactId, kind}` at
`:92-94`), the absence of any **upload-direction** grant consumer in the daemon (the only
`artifactTransferGrant` caller is `lease/staged-input.ts:242`, download-only, which explicitly
rejects a cross-paired `upload_granted`), and the absence of any control-plane projector from durable
evidence onto `task_outputs`.

Filed as **E7-F016**, LOW — it fails no gate, but it is the programme's stated answer to "what does
Unit F have to build", it is printed as evidence, and it produced the XL estimate §2 corrects.

★ **The second half of the finding — the verdict's NAME outruns its predicate** — is stated in §0 and
is unaffected by round 3's refutation. `capabilityProven` promises a capability judgement that two
SQL counts structurally cannot make.

### 1.5 The byte pipeline is not greenfield — it is built and **live-proven**

This is the terrain most likely to be missed, because it lives in an E5 result doc rather than an E7
one, and it is what made the XL estimate wrong.

[`DAT-002-live-minio-result.md`](../../E5-workspaces-secrets/tickets/DAT-002-live-minio-result.md)
records `d1-merge-train` run `31885553697` **13/13 green on `b27817824`**, proving on the Linux D1
lane, against **real MinIO over TLS**:

> grant(upload) → **real presigned PUT** → commit `committed` + persisted `job_artifacts` row;
> grant(download) → real GET byte-identical.

and, as a second assertion, that a toxiproxy `limit_data` truncation of the PUT makes the fenced
commit **reject fail-closed** and persist **no row**. Its own §3 names the one thing left: *"the
worker-daemon S3 client consumer is deferred (the tier drives `/api/worker-control/*` from the
test-runner directly)."*

The recipe is therefore known, not researched — including the sharp edge: *"the server binds
`ChecksumAlgorithm:SHA256` but returns `headers:{}`, so the raw-bytes PUT step-script computes and
sends `x-amz-checksum-sha256`; the fenced commit re-verifies it via `headObject`."* An exporter that
omits that header will be rejected by `artifact-commit.ts:141-145`, which fails closed when the store
cannot supply a checksum. (`checksumSha256` is supplied only by `storage/s3-provider.ts:212`; the
local-disk provider supplies none, so **an S3-compatible store is a hard precondition** for any
export arm. Staging sets `AOA_STORAGE_PROVIDER: "s3"` — `docker-compose.staging.yml:81,132`.)

Everything above the worker is likewise live: `POST /worker-control/artifact-transfer-grants`
(`routes/worker-control.ts:605`) and `POST /worker-control/artifact-commits` (`:654`) are mounted
whenever distributed execution is on, backed by `createArtifactCommitService` and
`createArtifactTransferGrantService`, and the port surface a worker would need already exists:
`digestArtifact` / `exportArtifact` / `artifactExportMode` on the **non-frozen**
`SandboxProvider` port (`worker-daemon/src/supervisor/provider.ts:414,430,433`), with a conformance
suite and a working `grant_upload` double
(`worker-daemon/src/__tests__/artifact-export-capability.test.ts`,
`support/fake-provider.ts`).

★ **What this measurement does and does not license.** It licenses "the grant→PUT→commit half is not
research". It does **not** license a size for Unit F, because the missing half is the producer and
the judge, and §4 is three failed attempts at exactly those.

### 1.6 So the genuinely missing links are these, and only these

1. **No file to export.** Unit D's script runs `claude --print -` and lets stdout go nowhere in
   particular. There is no agreed absolute path inside the sandbox holding anything this run emitted.
2. ~~**No real `exportArtifact`/`digestArtifact`.** `E2bSandboxProvider` declares
   `artifactExportMode = "none"` and declines both (`e2b-provider.ts:178,391-402`) — honestly, and
   with `#transport.readFile` (`real-transport.ts:196`) sitting one line away, uncalled.~~
   ✅ **BUILT 2026-09-04 (PR #353, Track B).** The mode is `"grant_upload"` and both methods are
   real: `digestArtifact` reads and returns `{sha256, sizeBytes}` (metadata only), `exportArtifact`
   reads → size-checks → **re-hashes against the grant** → PUTs → returns `{objectKey}`. The
   re-hash is the non-obvious part: the grant is minted from a *prior* digest call, so a file the
   agent is still writing must be refused **at the cause** rather than at the fenced commit's
   `headObject` check in another process. Proven against a **real E2B sandbox** on a file the
   sandbox itself produced (`keyed-e2b-dat-009-export.yml`, 4/4, run `33856478690`), including the
   TOCTOU refusal, and given a positive control on a reverted branch.
   ★ **It flips NO counter, and §1.6's arithmetic is unchanged by it.** Link 3 is still unbuilt, so
   nothing calls it; and the artifact arm still filters `kind = 'workspace_patch'`, so even a
   committed export of another kind would not count. This closed a *prerequisite*, not the gate.
3. **No worker-side consumer.** Nothing sequences digest → mint upload grant → export → commit. This
   is DAT-009 slice 3, chartered on Track B (GO-BOOK §1.9.3) and unbuilt.
4. **No announcement.** `EventSequencer` has no `artifactPrepared` method, so a committed artifact is
   invisible to the control plane's evidence stream. ★ **This blocks any projection onto the task —
   it does NOT block the counter.** `countProducedOutputs` reads `job_artifacts` directly and joins
   no events (§1.8). Confusing the two is the sweep's error this document corrects.
5. **No projector.** `foldAttemptEvidence` hard-codes `detectedFiles: []`
   (`canary-terminal-projection.ts:251`) and `createCanaryRunProjector.projectTerminal`
   (`canary-run-projector.ts:149`) has exactly four steps — events (`:163`), terminal (`:188`),
   `finalizeRun` (`:211`), run-summary comment (`:228`) — **none of which writes `task_outputs`**.
6. **A judge that counts the wrong things** (§1.3, §1.4) — **and whose obvious repair is refuted
   (§4.3)**.

### 1.7 What owns *"a distributed run can produce a `task_output`"*

Recorded because every proposal so far has wanted to take that question out of clause 6, and a
question removed from a predicate must be shown to still live somewhere.

1. **`gate-clause-wiring.json`'s `E3-17-output`** —
   `{"epic":"E3","status":"unwired","symbol":"jobOutputBridge","reason":"JOB-014 output projection
   has zero callers; task_outputs is still written by the legacy path. Wire at sink cutover
   (Sprint 6)."}` (`scripts/gate-clause-wiring.json:21-26`). That clause owns the **general**
   distributed-job → `task_outputs` projection and is checked by the **required `policy` job**.
2. Nothing else. Clause 6's task-output arm is the only *verify-time* enforcement, and it is the
   forgeable one (§1.3).

★ **The cost of removing it, stated because it is real.** Today the question is enforced by a clause
**a verify run reads and prints**. Any proposal that drops the arm moves enforcement to unit tests
and an acceptance criterion — weaker in a specific way: a unit test reds in CI, but no
`verify:e7-1-distributed-run` invocation would ever report "the artifact committed and the founder
still cannot see it on the task". That trade was acceptable in round 3's framing; it is recorded here
so a fourth pass prices it rather than rediscovering it.

### 1.8 The artifact arm has **zero producers today**

Measured, and it constrains any future plan: the daemon's HTTP client declares `artifactCommit`
(`worker-daemon/src/transport/client.ts:266,567`) and **no production code calls it** —
`patch/result-commit.ts:25` names it only in a comment.

★ **Corrected 2026-09-04 (PR #353).** This paragraph used to add "and both shipped providers declare
`artifactExportMode: "none"`". That half is **no longer true**: `E2bSandboxProvider` now declares
`"grant_upload"` and implements both methods for real (§1.6 link 2). `provider-wire/src/driver.ts:83`
still declares `"none"`, honestly. **The section's conclusion is unaffected and the correction must
not be read as softening it** — the arm's producers are counted by who *calls* the export and the
commit, not by who *can* serve them, and that count is still **zero**. A capable provider with no
caller produces exactly as many `job_artifacts` rows as an incapable one.

★ **A sweep angle claimed this made the arm structurally unreachable, because `EventSequencer` has no
`artifactPrepared` emitter. The premise is TRUE and the inference is FALSE.** Verified: `events.ts`
declares exactly seven emitters — `attemptStarted` (`:147`), `networkDenied` (`:155`), `log` (`:162`),
`progress` (`:170`), `usage` (`:178`), `browserObservation` (`:206`), `terminal` (`:220`) — and a
repo-wide grep for `artifact_prepared`/`artifactPrepared` outside tests returns seven hits, **every
one a declaration and not an emission**. But the artifact arm does not read events:
`countProducedOutputs` queries `job_artifacts` directly and the module contains no `job_events` join
anywhere. **A committed artifact counts whether or not anything announced it.** Adding the emitter is
not blocked either — the event type is frozen (`worker-protocol/src/events.ts:358`), the payload is
frozen (`:92-94`), it is already in the `job_events` CHECK (`schema/job_events.ts:75`), and
`EventSequencer` is daemon code outside the `worker-protocol-contract-bytes` freeze.

**Consequence for any plan.** The arm's zero-producer state is why round 3's "remove the forgeable
arm" step could not ship alone: it would have converted a forgeable gate into an unpassable one. That
pressure is exactly what pushed round 3 into widening the other arm, and the widening is what §4.3
refutes. **The pressure is real and remains unrelieved.**

---

## 2. Sizing — the XL correction stands; the L that replaced it is WITHDRAWN

**What survives.** The XL estimate sized the `workspace_patch` route, and E7-F016 shows how it got
there: three of the four links the verifier's own text blames flip neither counter. That route really
is XL and really is blocked on Unit E **plus** an in-sandbox manifest capture that does not exist.
**That correction is a measurement and it stands.**

**What is withdrawn.** The replacement — *"L, and Unit E is not required"* — was the size of slices
A–E **together**, and slice A is refuted (§4.3). A size derived from a refuted plan is not a size.

| route | what it needs | status |
|---|---|---|
| **workspace_patch** | Unit E (a repository) **+** an in-sandbox `WorkspaceManifestV1` capture that does not exist **+** base/result snapshotting **+** `createResultCommitter` composition | XL, Unit-E-blocked. **Measured, unchanged.** |
| **stdout as `log` events** | `observeRun` composition + provider stream capture | **flips no counter** — evidence, not capability. Measured, unchanged. |
| **a named file → export → commit → project, counted by a widened arm** | §1.6's six links | ★★★ **REFUTED at the judge (§4.3).** The widened arm counts the run's own input. |

**Unit F is UNSIZED**, and it will stay unsized until a candidate mechanism exists that survives §6.
★ Recording "unsized" is deliberate: a scheduler who sees `L` will schedule it, and there is nothing
to schedule.

---

## 3. Supply terrain — measured ground, **not a proposal**

Everything in §3 was measured across the three passes and survives them. It is the ground any fourth
attempt starts from. **None of it is adopted here**, because §4.3 removed the destination all of it
was pointed at.

### 3.1 Reading out of a sandbox is SOLVED; **writing** is the unsolved half

`E2bTransport` declares `readFile(sandboxId, path): Promise<Uint8Array>` and **both** drivers
implement it — `real-transport.ts:196` (`sandbox.files.read`, with not-found classification) and
`mock-transport.ts:200`. `e2b-provider.ts:172` says so in its own words: *"The transport already has
`readFile`, so a real implementation is a small, provider-specific piece"*. And it is no longer
unexercised against a real sandbox: `keyed-cli-008-unit-d-invocation.test.ts` reads three files back
with it inside a live E2B sandbox (`readText` at `:125-127`, used at `:171`, `:184`, `:188-189`), on
the lane that merged green at `c48259358`.

**Reading a convention path out of a sandbox needs no new mechanism at all.**

**Nothing creates the file.** `sandbox.commands.run` returns and streams stdout **to the caller**,
and the caller sits on the far side of the byte-egress boundary (Option D: *"the port carries a grant
inbound and a reference outbound, and never bytes"*). So the file has exactly two possible authors —
the script, or the provider wrapping the command — and §3.2–§3.4 are the measured costs of each.

★ **This is the sharpest single sentence of terrain in the document: the return path's unsolved half
is WRITING, not reading.** Every pass that started from "how do we get bytes out" spent its effort on
the half that was already done.

### 3.2 The pin census — enumerated **BY SEARCH**, 16 pins, 2 move

★★★ **An earlier revision claimed "no test needs editing". THAT CLAIM WAS FALSE, AND HOW IT BECAME
FALSE MATTERS MORE THAN THE FACT.** It was reached by walking the pins in
`task-run-batch-workload.test.ts` — one file, the file the change obviously touches — and then
generalised to the repository. A second file pins the workload by a property that file never asserts:
its **serialized size**. The census below is built by SEARCH over `buildTaskRunBatchWorkload`,
`SUBMISSION_MAX_INPUT_BYTES`, `submissionHeadroom`, `utf8Bytes`, `stagedFiles`, `readableGuard`,
`JSON.stringify(workload)` and `buildSandboxInvocation`, across `server/src/__tests__` and
`packages/**`. Every pin it found is listed, including the ones that hold.

**Measured**, by building the real workload with the real builder and appending a 35-ASCII-byte
redirect (` > /home/user/.aoa-run-output.jsonl`, no JSON escapes):

```
workloadBytes BEFORE: 295   headroom BEFORE: 65,241
workloadBytes AFTER : 330   headroom AFTER : 65,206
```

| # | pin | file:line | what it derives | moves? |
|---|---|---|---|---|
| 1 | `expect(workloadBytes).toBe(295)` | `cli-008-unit-b-byte-source.integration.test.ts:279` | `utf8Bytes(JSON.stringify(realisticWorkload()))` — the **serialized size** of the real builder's output | ★ **YES → 330** |
| 2 | `expect(MEASURED.submissionHeadroomBytes).toBe(65_241)` | same file `:280` | `SUBMISSION_MAX_INPUT_BYTES - workloadBytes` | ★ **YES → 65_206** |
| 3 | `emits the claude shape` `toEqual([...])` | `task-run-batch-workload.test.ts:208-212` | argv **shape**; the script is matched by `expect.stringContaining('… < "$1"')` | no — appending after the matched substring leaves it intact |
| 4 | `emits the codex shape` `toEqual([...])` | `:220-226` | same, `stringContaining('exec "$0" exec --json - < "$1"')` | no |
| 5 | `every absolute path in the %s argv is staged` | `:229-253` | **set equality** `stagedPaths` ≡ `args.filter(a => a.startsWith("/"))` | no — `args[1]` begins `for f in`, so the script is not an argv path, and `args` is unchanged |
| 6 | `--append-system-prompt-file "$2"` present | `:275-278` | claude has-bundle script prefix | no |
| 7 | codex bundle pipeline prefix | `:287` | `{ cat "$2"; echo; cat "$1"; } \| "$0" exec --json -` | no — a trailing redirect attaches after it and does not touch E7-F013's separator |
| 8 | `stagedFiles` is exactly `[STAGED_PROMPT_PATH]` | `:377-381` | the no-bundle staged set | no — `staged`/`paths` untouched |
| 9 | `guards every staged path … with an attributable exit code` | `:388-406` | `readableGuard` **arity**, asserted in both directions | no — arity derives from `paths.length`, unchanged |
| 10 | `stdinFromScript` anti-vacuity helper | `:307-312`, used at `:357`,`:367` | matches three known script shapes by `includes(...)`, **throws** on an unknown one | no — a trailing redirect disturbs none of the three matches |
| 11 | `E7-F008 has regressed: a large prompt cannot dispatch` | `:435-440` | a 100× prompt still builds and still parses against the frozen schema | no — the prompt rides staging, not the argv |
| 12 | `the frozen arg ceiling structurally guarantees the 64 KiB submission bound` | `:487-509` | `encoded <= SUBMISSION_MAX_INPUT_BYTES` — an **inequality**, ~49 KiB against 65,536 | no |
| 13 | `Object.keys(workload)` order / sorted key set | `:641-647`, `:673` | the workload's **key set** | no — no new key |
| 14 | `pointerFitsExtension` union projection | `cli-008-unit-d-fit-union.test.ts:83-105` | staged-input extension value bytes vs `valueMaxCanonicalBytes` | no — see §3.6 |
| 15 | keyed live-sandbox argv + stdin | `keyed-cli-008-unit-d-invocation.test.ts:171-189`, `:248-256` | the probe's recorded argv/stdin, read back with `transport.readFile` | no — the argv is unchanged; ★ and this is the lane on which any redirect would get **proved** rather than argued |
| 16 | `stdoutRef` fabricated literal | `adapter-manager/…/component.test.ts:107,138`, `gate.test.ts:137`, `provider-contract.test.ts:31` | `ref:stdout:<id>` / `sandbox://<id>/stdout` | no — no candidate here makes `stdoutRef` real (§7) |

★★ **Sixteen pins found, two move, and those two are one measurement stated twice.** An independent
pin-lens review re-enumerated this surface by search and confirmed it. ★ **The census is the durable
artefact here** — it is valid for *any* future change to this seam, not only for the redirect that
motivated it.

### 3.3 Why that one pin edit would be legitimate — and why "zero test edits" was never the goal

Pins 1 and 2 are a **measurement**. The rule this programme uses for measurement pins is: one may be
updated when the thing it measures legitimately changes, **provided the change is stated**.

The comment immediately above those two lines says what the number IS:

> ★ 790 UNTIL UNIT D, 295 AFTER IT — and the drop IS the change. The workload used to carry the
> whole assembled prompt as an argv positional; it now carries a fixed `sh -c` script plus the binary
> and two constant paths, and the prompt rides Unit B's staging channel as bytes. **That is E7-F008
> closed, visible as a number: the submission payload no longer grows with the task.**

The invariant that sentence asserts is **"no longer grows with the task"** — that the submission
payload is O(1) in the size of the work. It does not assert that the constant equals 295. A fixed
35-byte addition to a fixed script literal leaves the payload 330 for a one-line task and 330 for a
100× prompt, exactly as it is 295 for both today. **E7-F008 stays closed, and the number evidencing
it stays a constant** — and pin 11 (`:435-440`, the 100× prompt) IS the assertion that the payload is
O(1), which is what makes the edit checkable rather than asserted.

★ **Recorded, not adopted.** An independent review judged this edit legitimate rather than
goalpost-moving. It is written down because a fourth pass will face the same pin and should not
re-derive the argument — **not** because a mechanism requiring it has been chosen.

### 3.4 The provider-wrap alternative — measured, and costed

The obvious response to a moved pin is *"then do not put it in the workload"*. That was measured.

| author of the file | what it costs, measured |
|---|---|
| **the script** | one module constant + one appended token inside an existing fixed literal. **Pins 1 + 2 move.** |
| **the provider**, wrapping the command | `E2bSandboxProvider.execute` would re-emit `{command, args}` as a nested `sh -c` with a redirect appended to `shellJoin(command, args)`. Touches **no** workload pin — and costs: a new optional field on `ExecuteInput` (`worker-daemon/src/supervisor/provider.ts:246-251`) threaded through `effect-authority` → `provider-wire/driver` → `adapter-manager/server` → `e2b-provider` → `per-op-adapter`; a matching change in `mock-transport`, or a mock that models the **opposite** contract (E7-F014's founding lesson, one layer down); and a **nested** `sh -c` wrapped around an already-collapsed argv — re-entering verbatim the hazard `shellJoin` exists to close after it caused **8 of 18** failures on the first keyed run (`real-transport-helpers.ts:18-28`) |

★★ **And the provider route does not even avoid the declaration work.** It must still be *told* which
runs to capture: `E2bSandboxProvider` serves every workload, and §3.5 measures that `workloadType`
does not discriminate. So it needs a pointer channel **plus** the port field **plus** the nested
shell — strictly the larger change, whose extra surface is a port, which is the E7-F010 shape exactly
(grow one side of a seam and the structures derived from the other side do not follow you).

**Verdict recorded by the third pass: declined, for mechanical reasons rather than aesthetic ones.**
★ That verdict is preserved as a costing. It is not a selection, because the mechanism it was chosen
*over* is itself no longer standing.

### 3.5 `workloadType` DOES NOT DISCRIMINATE

Any mechanism that must announce "this run has an output" to the worker needs a predicate. The
obvious one is refuted by measurement, and the counter-example is already in the repository:

- `HEARTBEAT_TASK_RUN_WORKLOAD_TYPE = "batch"` (`heartbeat-distributed-rollout.ts:29`) — a coding
  task run is `batch`.
- `cli-008-unit-b-staging-channel.integration.test.ts:299-300` seeds a **non-coding** job —
  `source_kind 'one_shot'`, `source_intent {kind:"one_shot", operationKind:"extraction"}` — whose
  `workload_type` is **also** `'batch'`.

One value, two workload classes. A pointer emitted on `workloadType === "batch"` would be attached to
extraction one-shots, whose script contains no capture, so the worker would go looking for a file
nothing ever created — on every extraction run.

★ **The transferable shape**: the honest discriminator is not a classification of the job but a
**read of the artefact whose existence the pointer announces** — derived from the thing it describes,
so it cannot drift and cannot over-claim. That property is what any fourth candidate needs; **it is
not a design here**, because there is no adopted mechanism for it to describe.

### 3.6 Extension-container arithmetic

`buildJobEnvelope` emits at most one extension today
(`job-leasing.ts:399`, `extensions: input.stagedInput.length > 0 ? [stagedInputExtension(...)] : []`).
Measured against the frozen container's own limits, restated by
`cli-008-unit-b-byte-source.integration.test.ts:253-255`: `valueMaxCanonicalBytes` 16,384,
`combinedMaxCanonicalBytes` 65,536, `maxCount` 16. A second, small extension consumes 1 of 16 and a
few hundred of 65,536 — no ceiling is approached.

★ **But `pointerFitsExtension` (`job-input-staging.ts:220-243`) checks the PER-VALUE cap only**
(`bytes <= WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes`) and knows nothing about siblings. Correct
today, correct at two, **a latent E7-F010 shape at three**. Any pass that adds a second extension must
record that at the call site — a projection that measures the wrong set unnoticed is precisely what
E7-F009 was.

★ **And the attach point is not the obvious one.** `job-leasing.ts:399` derives `input.stagedInput`
at lease time from durable `job_artifacts` rows (`:628`, `:638`). A declared **output** has no such
row — nothing has been produced yet — so it cannot ride that derivation. Measured, and recorded so a
fourth pass does not lose a day to it.

### 3.7 ★★★ E7-F014 kills **every** post-execute capture equally — this is a PREREQUISITE, not an objection

**This is the highest-value measurement in §3, and it is the one that must not be lost.**

E7-F014 (merged `c48259358`, OBSERVED in a real E2B sandbox — run `33789547290`, confirmed by the
deliberate mutant run `33790235730`) measures that against real E2B a **non-zero exit is THROWN**:
`CommandExitError` from `e2b@2.30.5` `commandHandle.ts:176`, surfacing through
`RealE2bTransport.runCommand` (`real-transport.ts:116`), which maps only timeout-named errors and
rethrows (`:123-131`); `E2bSandboxProvider.execute` then classifies only egress-denied and not-found
and rethrows (`:297-303`).

★★★ **Traced one layer further than the finding does — and this layer is what constrains Unit F.**
`supervisor.ts:743-757` catches it and then:

```
emitOp("execute", "failed");
await events.terminal({ status: "failed", exitCode: null, errorCode: "execute_failed", … });
await escalateCleanup(run, "execute_error");   //  <- DESTROYS THE SANDBOX
return;                                        //  <- EARLY RETURN
```

The supervisor **tears the sandbox down and returns before anything after `execute` runs**. Stated
plainly, because it must be:

> **Any capture that reads bytes after `execute` — a redirected file, a provider-side wrap, a
> post-run `readFile`, anything read from the command result — is SKIPPED on every failing run,
> because the sandbox is destroyed and the lifecycle returns two statements later. Every failing
> distributed run is therefore exactly the run an operator most wants output from, and exactly the
> run that would produce none.**

★★★ **This kills redirect, provider-wrap and result-read EQUALLY**, which is what makes it a
**prerequisite for Unit F** rather than an objection to any one mechanism. It cannot be used to
choose between candidates, and it must be satisfied before any of them can work.

**The remedy is E7-F014's own**, and it is being built on a parallel branch — see §5. With it, a
non-zero exit **returns** instead of throwing, the catch is not entered, and a post-execute step sits
on the normal path for succeeded and failed runs alike.

**The residual, stated rather than designed around.** Even after that fix, three exits still destroy
the sandbox before any capture: a genuine provider fault (egress denied, sandbox not found), the
supervisor's `withDeadline` race (`execute_timeout`), and a cancel/lease-loss teardown. Output is
genuinely lost on those; `capabilityProven` stays `false`, which is the correct verdict — nothing
reached AoA. The fix converts only the **agent-exited-non-zero** case, which E7-F014 measures as the
common one.

### 3.8 What a captured transcript would be — and what it could never prove

Recorded because round 1 called these bytes *"the thing the agent produced, byte for byte"*, and any
fourth pass will be tempted to again.

`claude --print - --output-format stream-json --verbose` emits **JSONL protocol frames**: a
`system`/`init` frame, an `assistant` frame per model turn, `user` frames carrying tool results, and
a terminal `result` frame. The shapes are not guesswork — they are parsed in-repo today at
`packages/adapters/claude-local/src/server/parse.ts:19-45`, and codex's `exec --json` shape at
`packages/adapters/codex-local/src/server/parse.ts:136-238`. So, precisely:

- Such a transcript **would be** attributable to this run's sandbox process, reaching AoA through the
  attested path (grant → PUT → fenced commit → `headObject` checksum re-verification). **That is a
  provenance claim, and it would be true.**
- It is **not** a deliverable, and **a run in which the model never spoke still emits frames** — a
  CLI that fails to authenticate emits `system` + `result` and nothing else. Its mere existence is
  **not** a productivity claim.

★★★ **A productivity floor would have to live in the PRODUCER, and only half of it is buildable
within the existing port.** The zero-length half is free: `ArtifactDigestResult` is
`{sha256, sizeBytes}` (`supervisor/provider.ts:77-80`), so a supervisor can refuse on
`sizeBytes === 0` before minting any grant. The model-turn half is **measured as not buildable at the
worker**: `digestArtifact` is documented **"Metadata only; never returns content"**
(`supervisor/provider.ts:412`), `ArtifactExportResult` is `{objectKey}` — *"A REFERENCE to what was
exported — never the bytes"* (`:82-85`) — and the governing byte-egress decision is Option D. Three
candidate homes exist (a post-`exec` check, which forfeits `exec`'s exit-code preservation since
`exec` replaces the shell; a provider-side check, which puts adapter semantics inside a shared
provider; or a `markers`/`matchedMarkers` widening of the **non-frozen** port), **and choosing among
them is an open question (§9.4), not a decision this document makes.**

★★ **Do NOT import the adapter packages wherever such a check might land** — `worker-daemon` depends
on `@armyofagents/worker-protocol` and `pino` and nothing else (measured,
`packages/worker-daemon/package.json`); frame shapes would have to be re-derived.

### 3.9 The consumer side: `jobOutputBridge` cannot be the caller, and the terminal projector can

Measured, and it survives independent of any supply mechanism.

`jobOutputBridge.projectAcceptedOutput` is the written-but-uncalled producer built for this shape
(`services/job-output-bridge.ts:250`, passing `createdByRunId` at `:291` and an optional
`executionWorkspaceId` at `:297` into `upsertTaskOutputForIssue` at `:303`; measured **0 production
callers** by `node scripts/check-gate-clause-wiring.mjs --counts`). **It is the wrong caller, for a
mechanical reason.**

Its first act inside the tenant transaction is `await repos.jobControl.lockActiveFence(input.fence)`
(`:263`) — the attempt must still be **RUNNING**. But `acceptEvent` applies the `attempt_terminal`
projection **inside the same batch loop that appends the events**
(`packages/db/src/repositories/tenant/job-control.ts:2605-2621`), and `guardActiveFence` refuses a
terminal attempt with the closed code `attempt_terminal`. A supervisor emitting `artifact_prepared`
and `terminal` back to back rides one durable-outbox upload in the common case, so the attempt is
terminal at commit and any after-commit fence-requiring projection finds a dead fence. **An
"`onAcceptedOutput` hook beside `onAttemptTerminal`" fails on the happy path** — the E7-F010 shape
again.

**`createAttemptTerminalProjectionHandler` does not have this problem, because it is fence-independent
by construction.** It fires only when `run.executionOwner === "distributed"`
(`canary-terminal-projection.ts:306`); it holds `run.id` — a company-owned `heartbeat_runs` id,
exactly the ref `assertTaskOutputRefs` validates for `createdByRunId` (`services/task-outputs.ts:123`)
— and `target.issueId` (`:331`, resolved by `heartbeat.ts:7076` from `issues.executionRunId = run.id`
**before** `finalizeRun` releases that lock); it **already reads the attempt's durable `job_events`**
(`:310-315`) and folds them, discarding `artifact_prepared` today; and it is composed and live
(`index.ts` → `app.ts` → `worker-control.ts` → `job-events.ts:330` → `heartbeat.ts:7092` →
`canary-run-projector.ts:149`).

★ **And any projected row would need `externalId`**: `upsertTaskOutputForIssue` is idempotent **only**
through the `(provider, externalId)` branch (`services/task-outputs.ts:150`); without it, `:180` is an
unconditional `insert` and a redelivered terminal duplicates the row.

★ **Consequence for the register, whatever gets built:** clause `E3-17-output` stays honestly
`unwired` as long as nothing calls `jobOutputBridge`, so no `unwired_but_now_has_caller` fires in the
required `policy` job and the sink-cutover owner's decision stays where it belongs.

---

## 4. ★★★ THE THREE REFUTATIONS — why the supply mechanism is NOT YET DESIGNED

Three passes, three refutations. Rounds 1 and 2 were refuted **on the same seam**; round 3 moved off
that seam and was refuted **at the judge**.

### 4.1 Round 1 — refuted on argv **SHAPE**

The first draft put the output path in the argv as a positional and wrote the redirect as `> "$3"`.
Wrong three independent ways, each caught by a test that is already shipped:

| what `> "$3"` assumed | measured |
|---|---|
| **`$3` is a stable index** | It is not. `args: ["-c", script, input.binary, ...paths]` (`task-run-sandbox-invocation.ts:212`) makes `$0` the binary and `$1…$n` the staged paths — and the **instructions path is conditional** (`:165-173`), so the no-bundle shape has exactly ONE path. Pinned twice (`task-run-batch-workload.test.ts:215-226`, `:371-381`). In that shape a literal `$3` expands to the empty string, and `> ""` is an `sh` redirection failure |
| **the path can ride the `paths` array** | Then it fails on the **happy path**: `readableGuard(paths.length)` (`:176`, defined `:118-124`) emits one `[ -r "$i" ] \|\| exit 78` per element, and the output file does not exist before `exec` — so the guard would 78-refuse every run. Arity is asserted in **both** directions (`:388-406`) |
| **the path can ride the argv but skip `paths`** | Then it fails the structural invariant: `every absolute path in the %s argv is staged` (`:229-252`) ends in `expect([...stagedPaths].sort()).toEqual([...argvPaths].sort())` — **set equality, not containment**. A fourth argv element nothing stages reds it on all four (adapter × bundle) rows |

### 4.2 Round 2 — refuted on argv **SIZE**

Round 2 fixed the shape (a constant inside the script literal, no argv change) and then claimed
*"measured against each pin, **no test needs editing**"*. **False.**
`cli-008-unit-b-byte-source.integration.test.ts:279-280` pins the workload's **serialized size**
(`295`) and the derived submission headroom (`65_241`); a 35-byte redirect takes them to `330` /
`65_206`. No `skipIf`, no DB gate — it runs in the required Linux `verify`.

★ **How the claim became false is the point.** It was reached by walking one file's pins and
generalising to the repository; the second file asserts a property the first never mentions. §3.2 is
the census by search that should have preceded it.

### 4.3 ★★★ Round 3 — refuted at **THE PREDICATE ITSELF**, and this one is a SCOPE conclusion

Round 3's plan opened with a judge change: **remove** clause 6's forgeable `task_outputs` arm and
**widen** the artifact arm off its `kind = 'workspace_patch'` filter, leaving *"any committed
`job_artifacts` row for this run's job"*. Its argument was that every committed row carries identical
provenance — a leased worker, a live fence, a device proof, an attempt-scoped prefix, and a
control-plane `headObject`.

**That argument is false, and the counter-example is a producer this same ticket shipped.**

Measured at `611a78bfb`, link by link:

1. **The prompt is staged on EVERY task run, unconditionally.** `buildSandboxInvocation` builds
   `staged` with the prompt as a non-optional first element
   (`server/src/services/task-run-sandbox-invocation.ts:163-164`); only the instructions entry is
   conditional (`:165-173`). So `stagedFiles.length >= 1` for every coding run.
2. **Staging runs between convert and placement**, before the attempt is leasable:
   `if (stageJobInput && stagedFiles && stagedFiles.length > 0) { await stageJobInput({ …, jobId, …,
   files: stagedFiles }) }` (`server/src/services/run-execution-owner.ts:361-368`), with `jobId` from
   `convert.convertRunToJob` (`:340`).
3. **It commits `job_artifacts` rows directly** — `repos.jobArtifacts.insert({ … jobId: input.jobId
   (:374), … kind: STAGED_INPUT_ARTIFACT_KIND (:381), status: "committed" (:382), leaseId: null
   (:383), fenceToken: null (:384), committedAt: now() (:385) })`
   (`server/src/services/job-input-staging.ts:372-386`; the constant is `"staged_input"` at `:64`).
   ★ Its own comment says why: *"NO LEASE, NO FENCE — `leaseId` and `fenceToken` are null and no fence
   has ever existed for this attempt. That is the property that makes an inbound write possible at
   all"* (`:366-369`).
4. **The job id is the same one the verifier reads.** `buildHandoffRunPatch` sets
   `distributedJobId: owner.jobId` (`run-execution-owner.ts:237`) from that same convert, and
   `countProducedOutputs` binds `eq(jobArtifacts.jobId, run.distributedJobId)`
   (`e7-distributed-run-verifier-store.ts:206`, run column at `:62`).
5. **The widened arm's remaining two conjuncts are exactly what step 3 writes.** Dropping
   `eq(jobArtifacts.kind, "workspace_patch")` (`:207`) leaves `jobId` (`:206`) and
   `status = 'committed'` (`:208`) — both satisfied.

**Therefore: the widened arm would be satisfied on every converted distributed run, by the run's OWN
INPUT — the prompt and instructions bundle the control plane writes INTO the sandbox — with no
export, no worker producer, no agent output, and no supply path built at all.**

★★★ **It is strictly worse than the arm it replaces.** E7-F015's forgery needs a deliberate
authenticated POST. This needs **nothing**: `capabilityProven` would be `true` **by construction** on
every run, before the agent starts, and the gate would be green on a system in which Unit F had never
been built.

★★★ **And that is the SAME CLASS as E7-F015 itself, which is why this is a scope conclusion rather
than a detail to patch.** The move — *drop one forgeable arm, widen the other* — produced a
differently-forgeable arm on the first attempt, and it did so because the widening was justified by a
provenance argument about a **class of writers** (`commitArtifactVersion` behind a fence) while the
predicate binds a **class of rows** (`kind`, `status`, `job_id`). The census of who writes rows of
that shape was never taken. **The defect is in the move, not in the filter that was dropped** — so
narrowing the widening, or adding a conjunct, is not a fix; it is the fourth attempt, and it needs its
own census before it is proposed.

★ **What survives from round 3.** The provenance/productivity axis (§0) is right and is what makes
E7-F015 correctly stated. The measurement that the surviving arm has zero producers (§1.8) is right.
The pin census (§3.2), the provider-wrap costing (§3.4), the `workloadType` counter-example (§3.5) and
the E7-F014 trace (§3.7) are all right. **What does not survive is the predicate change, and with it
the slice plan and the size.**

### 4.4 The pattern across all three — worth more than any single row

**Three revisions, three mechanisms, ONE seam — and then the predicate.**

Rounds 1 and 2 both landed on `task-run-sandbox-invocation.ts` / `task-run-batch-workload.ts`, and
both were refuted because Unit D had *just* stabilised that seam and pinned its numbers as E7-F008
evidence: **it is the most heavily pinned surface in the repository precisely because it was the most
recently moved.** The corrective for that class was §3.2 (a census by search) and §3.4 (a costed
comparison against the alternative that avoids the seam entirely) — and both worked: round 3's
mechanism was not refuted on the seam.

Round 3 was refuted **one layer up**, at the thing the mechanism was for. The corrective for *that*
class is a census of **who can write a row the predicate admits** — the same discipline as §3.2,
applied to the judge instead of the tests. **That census has not been taken, and taking it is the
first work of any fourth pass.**

★★★ **The transferable lesson:** *a reviewer finding can be right while its recommended fix is wrong.*
E7-F015 is correct and survived three rounds of attack. Its own suggested remedy was refuted on the
first attempt to build it. A register that carries a finding must not silently carry its remedy at the
same confidence — which is why E7-F015's register entry is corrected in the same commit as this
document.

---

## 5. Blocking dependency — **Slice Ø / E7-F014**, being fixed on a parallel branch

**Any** return path is dead until this lands, for the reason measured in §3.7: `supervisor.ts:743-758`
catches the SDK's throw, emits the terminal, **destroys the sandbox** and **returns**, so every
post-execute capture is skipped on every failing run.

- **The remedy** is E7-F014's own: catch `CommandExitError` in `RealE2bTransport.runCommand` and
  return `{ exitCode, signal: null, timedOut: false, crashed: true }` — the shape `MockE2bTransport`
  already returns (`mock-transport.ts:130-137`) and the provider already expects. Timeout
  classification stays **ahead** of it, and `isE2bNotFound`'s deliberate exclusion
  (`real-transport-helpers.ts:44-46`) must survive untouched.
- **It is being built on `claude/e7-f014-throw-carrier`.** This document **cross-references it and
  does not build it.** Do not implement it here, and do not treat this section as its design.
- ★ **It is worth landing on its own regardless of Unit F's fate.** It depends on nothing in this
  document, it makes an already-shipped keyed assertion true end to end
  (`keyed-cli-008-unit-d-invocation.test.ts:323-325` asserts `exitCode === STAGED_INPUT_MISSING_EXIT_CODE`
  in a real sandbox), and it takes a branch that is measured **dead** today —
  `crashed: exitCode !== 0` at `real-transport.ts:122`.

**Unit F's dependency statement is therefore:** blocked on `E7-F014` **and** on a supply mechanism
that survives §6. The second does not exist.

> ★ **AMENDED 2026-09-19 (records-lag reconciliation).** `E7-F014` **has landed.** `findings.md:838-840` records it **resolved** by the carrier fix (PR #351, 2026-09-04), and `packages/sandbox-e2b-provider/src/real-transport.ts:183-210` now catches the SDK throw and returns the `crashed` shape `MockE2bTransport` already returns (the `crashed: exitCode !== 0` branch this section called *measured dead today* is live). So Unit F is **no longer blocked on `E7-F014`**; its dependency reduces to *a supply mechanism that survives §6* — still open (§9.1, §13). This note corrects a status; it builds nothing and takes no §13 decision.

---

## 6. Constraints any future supply mechanism must satisfy

Each row is a **measured refutation of a specific attempt**, restated as a test. This is a list of
ways to fail, not a design; a candidate that passes all six is not thereby correct.

| # | constraint | the attempt it comes from |
|---|---|---|
| 6.1 | **No argv positional.** The output path may not be an argv element: `$n` is shape-dependent, `readableGuard` derives its arity from `paths.length`, and the argv↔staged relation is asserted as **set equality** (`task-run-batch-workload.test.ts:229-253`) | §4.1 |
| 6.2 | **Any change to the workload's serialized bytes moves pins 1+2**, and must state the delta in the same edit and preserve E7-F008's actual invariant (O(1) in the task, pinned at `:435-440`) | §4.2 |
| 6.3 | ★★★ **Any predicate change must be justified by a CENSUS OF WHO CAN WRITE AN ADMITTED ROW, not by an argument about a class of writers.** `stageJobInputFiles` commits fenceless `job_artifacts` rows bound to the run's own job (`job-input-staging.ts:372-386`) | §4.3 |
| 6.4 | **A candidate must produce a signal the run's own INPUT cannot produce.** Anything the control plane writes into the sandbox before the attempt is leasable is not evidence that the sandbox produced anything | §4.3 |
| 6.5 | **It must survive E7-F014's early return**, or state its dependency on the fix. Redirect, provider-wrap and result-read all die equally without it | §3.7 |
| 6.6 | **Its emit predicate may not be `workloadType`** (`"batch"` for a coding run and an extraction one-shot alike), and any second envelope extension must record the sibling arithmetic `pointerFitsExtension` does not check | §3.5, §3.6 |

★ **And one constraint on the release shape, from §1.8:** the artifact arm has zero producers, so any
change that removes the `task_outputs` arm without shipping a producer converts a forgeable gate into
an unpassable one — CLI-008 Unit A's precedent inverted. That pressure is what drove round 3 into the
widening; a fourth pass must relieve it some other way or accept it explicitly.

---

## 7. Scope — what Unit F is not, and what must not be built from this document

- ★★★ **No mechanism is proposed here.** §3 is terrain and §6 is a refutation checklist. A reader who
  extracts a plan from either has re-run round 3.
- **It does not build the `workspace_patch` arm.** `buildWorkspacePatch` and `createResultCommitter`
  keep their zero production callers, and their gate clauses stay honestly unwired. That arm needs
  Unit E *and* an in-sandbox manifest capture that does not exist.
- **It does not compose `observeRun` and does not make `stdoutRef`/`stderrRef` real.** Both flip no
  counter (§1.4). Composing them would be a second byte channel argued for by a reason string that is
  itself E7-F016.
- **It does not wire `jobOutputBridge`** (§3.9) — `E3-17-output` stays `unwired` with its reason
  intact.
- **It does not change clause 6's predicate.** §4.3 is why.
- ★★★ **Nothing in the terrain proves the agent did the work, and nothing here claims to.** Upgrading
  the bar from provenance to productivity means either (a) instructing the agent to write a
  **deliverable** to a declared path and counting only that — which makes the gate depend on model
  compliance and needs Unit C's tools and Unit E's repository to be meaningful; or (b) having the
  control plane read the artifact's bytes, which crosses the byte-egress decision's "a reference,
  never bytes" line at the control plane. Both are named successors with no owner (§9.5).
- **It does not enforce retention.** `log` maps to the `run` class
  (`services/browser-artifact-retention.ts`), and `artifact-retention-authority.ts` states that
  *"nothing reads the stored column to act"*. A future hazard, belonging with DAT-010.

---

## 8. Findings filed with this design

All three are entered in `scripts/finding-ownership.json` with their register blocks.

| id | severity | what | round-4 status |
|---|---|---|---|
| **E7-F015** | MEDIUM | The capability bar is forgeable: `POST /api/issues/:issueId/outputs` (`routes/task-outputs.ts:45-53`, §1.2 row 4) accepts `createdByRunId` from the request body with only a company-ownership check, and `countProducedOutputs` applies no provenance filter — so one authenticated POST flips `capabilityProven` | ★★★ **SURVIVED all four rounds.** Its originally recommended fix is **REFUTED** (§4.3) and struck from its register entry; the finding stands **unfixed and unowned by a mechanism**. Round 4 corrected its ATTRIBUTION — E7-F018's census had cited `routes/output-detection.ts:201` (§1.2 row 2, a different route that cannot fire) under this finding's label |
| **E7-F020** | HIGH | The same arm, no actor at all: `emitRuntimeServiceTaskOutput` (§1.2 row 3) writes `created_by_run_id = run.id` from `heartbeat.ts:4524`, before the handoff, on the DEFAULT isolated-workspace configuration — so arm 2 reads non-zero for a run with zero agent output | Filed round 3 (§1.2a); **re-examined round 4 against the corrected census and NOT merged into E7-F015** — an authorization-shaped fix closes E7-F015 and leaves this untouched |
| **E7-F016** | LOW | Clause 6's operator-facing text misdescribes its own subject: (a) the failure reason names four unbuilt links, three of which cannot flip either counter, and omits the decisive ones; (b) the verdict is named `capabilityProven` while both arms are row counts that can only assert provenance | ★ **SURVIVED.** Part (a)'s repair — rewriting the reason string — is independent of any predicate change and remains available; part (b) is recorded rather than fixed (a rename touches 15 files across five epics) |

★ **SIX MORE WERE FILED 2026-09-06 (W6U1)**, all in
`docs/replatform/epics/E7-coding-e2b/findings.md` with `scripts/finding-ownership.json` entries:
**E7-F021** (HIGH, CLI-008) the distributed sandbox invocation carries no permission posture — the
load-bearing premise under three of the four candidate answers; **E7-F022** (MEDIUM, unowned) the E2B
template is an unpinned operator input under three uncoordinated variable names, invisible to every
protocol surface; **E7-F023** (MEDIUM, CLI-008) clause 4 DOES scan `job_events`, so a hard-fail gate
clause reads model-influenced content; **E7-F024** (MEDIUM, CLI-008) the frozen `log` payload
truncates SILENTLY and caps at 480 events, so a reconstructed transcript is corrupt rather than
absent; **E7-F025** (MEDIUM, unowned) no document records a green real-E2B stream-capture run and two
re-fires have no recorded outcome; **E7-F026** (LOW, CLI-008) the *agent declares* option's
completeness claim is false against three staged-prompt pins.

**Observed, not filed** (each a candidate for a successor rather than a defect this unit carries):

- `AOA_WORKER_S3_ENDPOINT` is documented (`docs/deploy/environment-variables.md:203`), injected by
  both the D1 and staging composes, and **asserted by `scripts/lib/d1-compose-invariants.mjs:80`** —
  with **zero TypeScript readers anywhere in the repo**. A guard asserting a variable nothing consumes
  is this programme's own failure class; it should be either read or retired.
- `packages/worker-daemon/src/supervisor/events.ts:190-192` states *"`createSupervisor` has zero
  production callers"*. `node scripts/check-gate-clause-wiring.mjs --counts` reports **4**, and
  `lifecycle/dispatch-runtime.ts:4` declares itself the first. (The clause's own conclusion survives
  on `browserObservation`'s separate zero.)
- `canary-terminal-projection.ts:251` cites `worker-protocol/src/events.ts:294` for the
  `artifact_prepared` payload; that line is `serviceInstanceStoppedPayloadV1Schema`. The payload is at
  `:92-94`.

---

## 9. Open questions — the first is now the whole ticket

1. ★★★ **What supplies an output that clause 6 can honestly count?** **UNANSWERED.** Three attempts,
   three refutations (§4). The next attempt's first work is the census §4.4 names: for any candidate
   predicate, enumerate **every writer that can produce a row it admits** — the discipline §3.2
   applied to tests, applied to the judge. ★ Do not propose a mechanism before that census exists;
   round 3 did, and the census is what refuted it.
2. **Does the E2B SDK's `files.read` return bytes for a file written by a redirected `exec`?**
   `#transport.readFile` is exercised against a real sandbox for files written by `writeFiles` and by
   a probe script (`keyed-cli-008-unit-d-invocation.test.ts:125-127,171,184,188-189`), **not** by a
   redirected `exec`. One added case on that same keyed lane answers it. ★★ Two sub-cases belong in
   the same run: (a) a **non-zero-exiting** command's redirect still leaves a readable file; (b) an
   **unwritable** redirect target fails at the redirection with the agent never starting. Both remain
   unmeasured. This is a cheap, standalone measurement and is worth taking **whether or not a fourth
   mechanism is ever proposed**, because it bounds the whole option space.
3. **One output path or a list?** Unmeasured. A list multiplies grant round-trips, needs a per-file
   failure policy, and cannot be a script constant — which re-opens §4.1's three measurements in full.
4. ★★★ **Where could a model-turn floor live — or does it not get built?** §3.8 tables three candidate
   homes with their costs and picks none. Sub-question, also unsettled: the **codex** marker — its
   stream distinguishes `thread.started` / `response_item` / `event_msg` / `item.completed` /
   `turn.completed` / `turn.failed` (`codex-local/src/server/parse.ts:136-238`), and which is the
   minimal "the model spoke" marker **was not established**. Do not guess: a wrong predicate silently
   suppresses real runs.
5. ★★ **Does the deliverable-directive route belong to Unit C or Unit E?** §7 names it as the successor
   that would upgrade the bar from provenance to productivity. It needs an owner before someone
   assumes Unit F left it done.
6. **Size ceiling for any exported artifact.** `DEFAULT_MAX_ARTIFACT_BYTES` bounds the commit
   server-side and a grant carries `maxBytes`; whether a worker refuses before the PUT, and what the
   operator sees, is undecided.

---

## 10. Corrections to earlier records

★★★ **Including this document's own three earlier drafts, corrected in place rather than quietly
swapped.** Every error below was the *obvious* shape, which is why it is recorded instead of erased.

**Round 3's error (`2bc203b92`…`611a78bfb`), corrected in this pass:**

| round 3 said | measured, and where the correction lives |
|---|---|
| ★★★ *"Slice A: drop `eq(jobArtifacts.kind, 'workspace_patch')`… every committed `job_artifacts` row requires a leased worker, a live fence, a verified device proof… the per-row provenance strength is **identical**; only the `kind` differs"* | **False.** `stageJobInputFiles` commits `job_artifacts` rows with `leaseId: null` and `fenceToken: null` by design (`job-input-staging.ts:372-386`, comment at `:366-369`), bound to the run's own `jobId` (`:374`), for the prompt bundle staged on **every** task run (`task-run-sandbox-invocation.ts:163-164`). The widened arm is satisfied by the run's **own input**, before the agent starts. **§4.3** has the five-link chain |
| the lettered slice plan A–G, its 20-row positive-control table, and its 10-point acceptance section | **Deleted, not demoted.** They were the plan built on slice A. A refuted plan left in a design document gets built |
| *"Size: L, corrected DOWN from XL"*, and *"L is the size of A–E TOGETHER"* | **Withdrawn.** The XL *correction* stands (§2, E7-F016). The L *replacement* was the size of A–E, and A is refuted, so Unit F is **UNSIZED** |
| E7-F015's register entry: *"Unit F slice A therefore takes the task-output count OUT of the clause-6 predicate… and widens the artifact arm off its `kind = 'workspace_patch'` filter"* | The **finding** stands; the **fix** does not. Corrected in `findings.md` and `scripts/finding-ownership.json` in the same commit as this document |

**Round 2's errors (`2bc203b92`…`d3fd1b52c`):**

| round 2 said | measured |
|---|---|
| ★★★ *"Measured against each pin, **no test needs editing**"* | **False.** `cli-008-unit-b-byte-source.integration.test.ts:279-280` pins the workload's serialized size (`295`) and the derived headroom (`65_241`). §4.2; census at §3.2 |
| *"emit the pointer whenever the workload is the coding one, derived from `input.job.workloadType`"* | **It does not discriminate** — `"batch"` for a coding run and an extraction one-shot alike. §3.5 |
| the design was written against the clean-exit path only | **E7-F014**: a non-zero exit THROWS, and `supervisor.ts:743-758` destroys the sandbox and returns. §3.7, §5 |

**Round 1's errors (`419a94afd`…`c28631e33`):**

| the first draft said | measured |
|---|---|
| the redirect is `> "$3"`, with the output path appended to the argv | Wrong three ways, each caught by a shipped test. §4.1 |
| the captured bytes are "the thing the agent produced, byte for byte" | They are JSONL **protocol frames**, non-empty even when the model never spoke. §3.8 |

**Line numbers in circulation elsewhere:**

- ★ **`heartbeat.ts` line numbers in circulation are wrong at this tip.** The suppression guard is at
  **5399**, its `return; // CLI-006-SUPPRESSION-RETURN` at **5451**, `adapter.execute` at **5453**,
  the `emitSandboxPreviewTaskOutput` call at **5557**, and the `detected_outputs` write at **5907**;
  `executeRun` spans **3061–6119**. The widely-quoted 5409 / 5411 / 5515 / 5865 are from
  `203853b3a`. The structural conclusion is unchanged: the return precedes both sinks, inside one
  function.
- **`e7-distributed-run-verifier-store.ts:166` is not the capability predicate.** `:165` is the
  clause-4 leak scan and `:216` is `countProducedOutputs`; `:166` is a loop header.
- **`routes/task-outputs.ts`**: the `svc.upsertForIssue(..., req.body)` call is at **:53**, in the
  handler registered at **:45**.
- **"the crew path is the template"** — it is a template for the *shape* of a workspace-free
  `task_output` and nothing else. Crew's run id is minted into `internal_agent_runs`
  (`aoa-agents/runner.ts:231`) while `task_outputs.created_by_run_id` FKs `heartbeat_runs`
  (`packages/db/src/schema/task_outputs.ts:46`), which is why `crew-output-capture.ts:129` writes
  `null` deliberately. No crew row can ever satisfy the counter.

---

## 11. Depends on

**Blocked on**, and neither is satisfied:

1. **E7-F014** — the exit code must survive the SDK, or every post-execute capture is skipped on
   every failing run (§3.7). Being fixed on `claude/e7-f014-throw-carrier` (§5).
2. **A supply mechanism that survives §6.** None exists (§4).

**Terrain it builds on** (all shipped): `CLI-008` Units B and D (the staging channel and the sandbox
command line), `CLI-006` (the canary seam and the terminal projector), `DAT-002` + slice 7 (the
grant/commit pipeline and its live-MinIO proof), `DAT-009` slice 1 (the export port), and the frozen
contracts in `packages/worker-protocol`.

---

## ★★★ 12. THE RULING: ~~DEFERRED PENDING MEASUREMENT~~ → **THE MEASUREMENT IS IN (§12.0). The deferral is LIFTED and REPLACED: the gate is now the PRODUCT FIX, not a probe.**

**Recorded by the W6U1 output-ruling unit, 2026-09-06, measured at `31d33a3b0`.** This section exists
because a 26-agent decision wave asked this document's question — *"what is an agent output?"* — and
produced **four** candidate answers, **sixteen** adversarial passes, **two** `sound` verdicts out of
sixteen, and **46 unrebutted fatal problems**. Its recommendation was to build **no mechanism** and
**measure first**. That is now the ticket's position, on the record, so that the next session does not
invent a fifth answer to an unmeasured question.

### ★★★ 12.0 AMENDED 2026-09-07 (W12) — PROBE (a) HAS RETURNED. All three probes have.

**Run [`34087197668`](https://github.com/MeteoriteLabs/AoA/actions/runs/34087197668)**, 2026-09-07,
commit `1c447fa8a`, template `aoa-base`, artefact `w7u1-output-probe-record`, run nonce
`W7U1-MTQT1763-OJ2WYK7K`, disposition **`measured`**, exit 0. The full record — every arm, every
exit code, and the four things the run does **not** establish — is
[`W7U1-output-probe-result.md`](./W7U1-output-probe-result.md). Read that before acting on anything
below; this section is the consequence, not the evidence.

| probe | §12.2 asked | it answered |
|---|---|---|
| **(a)** decisive | can a real claude/codex, under the EXACT production argv with no permission flag, write a file in `aoa-base` at all? | **claude: NO — and the missing posture is the cause.** A1 (the exact `:184` literal) exited **0** and wrote nothing; A2 (same prompt template, `--dangerously-skip-permissions` added *inside the probe*) **wrote**. A0 held, A3 held. ★ The CLI self-reported the variable: `"permissionMode":"default"` on A1, `"bypassPermissions"` on A2. **codex: unmeasured** — both arms were refused upstream of the question (E7-F027), and the pack's own "the posture is not the cause" verdict is unsupported (E7-F028). |
| **(b)** positive control | is the configured template already satisfying a location convention? | **NO — `template-prefills-nothing`.** None of the 7 candidate paths exists in a fresh `aoa-base` sandbox; neither `aoa-workspace` nor `~/.aoa` is there at all. |
| **(c)** streams | does the stream handler deliver from real E2B? | **YES — `both-streams-delivered`.** `onStdout` and `onStderr` each received their marker, exit 0. A confirmation, as §12.2 already said it would be. |

**This is the second of the three outcomes §12.2's own table predicted for (a)** — *"the run exits 0
and the file does not exist"* — and that row's reading was: *"the 'silently no-op' shape reproduced
in the distributed argv. **Every file-writing option is dead until the argv changes**, and the next
unit is a permission-posture decision, not an output mechanism."* ★ **That reading holds, with one
correction it did not anticipate: the differential also names the FIX, so the options are not dead
— they are GATED.** Which is why the stop condition is replaced rather than deleted (§12.3).

#### 12.0.1 What it revives, what it does not, and what it leaves untouched

Stated per option, because "the premise holds" and "this option is now available" are different
sentences and collapsing them is how a fourth round starts.

| the four candidate answers | before probe (a) | after |
|---|---|---|
| **1. the agent DECLARES its output** (append a directive to the prompt, parse the announcement) | dead on an unmeasured premise | **REVIVED, CONDITIONALLY** — the capability exists *with the posture present*. Its own separate refutation is UNCHANGED: **E7-F026** measured that its "no test edits" completeness claim is false against three staged-prompt pins (five assertions across three tests). Reviving the premise does not revive the sizing claim. |
| **2. a CONVENTIONAL path** (the output is whatever is at path P) | dead on an unmeasured premise, **and** exposed to "the image wrote it" | **REVIVED, CONDITIONALLY, and one objection is RETIRED** — probe (b) says the template pre-fills nothing, so a convention anchored at a candidate path would not be silently satisfied by the Dockerfile. ★ That retires **one** instance of E7-F020's class; it does not retire the class, because the template is still an operator input no protocol surface can see (**E7-F022**) and a different template would have to be re-measured. |
| **3. a WORKSPACE PATCH** | dead on an unmeasured premise | **REVIVED, CONDITIONALLY.** ★ It carries an additional, independent blocker this probe does not touch: **E7-F019** — labelling exported bytes `kind='workspace_patch'` moves arm 1's counter without redefining its predicate. |
| **4. the captured TRANSCRIPT** | never depended on the agent writing a file | **UNCHANGED — neither revived nor refuted by this run.** §3.8's refutation stands on its own terms and is not a premise question: a transcript is a **provenance** claim and never a **productivity** one, and *"a run in which the model never spoke still emits frames"*. ★ This run is a live demonstration of exactly that: codex's A2 emitted `thread.started` and `turn.started` frames while failing every model call with `401`. Probe (c)'s `YES` improves the **delivery** story for it and changes nothing about the predicate. |

**What is revived for `claude_local` only.** Every "REVIVED" above is measured on the claude arm. For
`codex_local` the premise is **still unmeasured** (E7-F027), so any mechanism written as
adapter-agnostic is making a claim about codex that no run supports.

**And what NOTHING here revives: the lettered slice plan.** §4.3 refuted round 3 **at the predicate
itself**, which is a scope conclusion and not a premise question. Probe (a) does not touch it, and
the deleted A–G plan, its positive-control table and its acceptance criteria stay deleted.

#### 12.0.2 ★ AMENDED 2026-09-19 — the two owed preconditions have BOTH landed (records-lag reconciliation)

This section, and the stop condition at §12.3, turn in places on *"the literals are unchanged at this tip"* and *"until that diff lands"*. **Both premises are stale at HEAD** and are corrected here rather than rewritten in place, per §10's discipline (the original reasoning is kept, not erased):

- **The permission-posture diff MERGED, founder-authorized 2026-09-11.** `task-run-sandbox-invocation.ts` now emits `--dangerously-skip-permissions` on the claude arm (`:186-187`, E7-F021) and `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` on the codex arm (`:211-212`, E7-F027). The A2 rewrite the probe performed *inside itself* is now the **shipped literal**. Per §12.3 clause **(i)** — *"a mechanism proposed before the permission posture is IN THE PRODUCT … will be refuted"* — the *"merged posture diff quoted by commit"* third input named there now exists, so **clause (i) is SATISFIED for `claude_local`**.
- **`E7-F014` resolved** (PR #351, 2026-09-04 — see the §5 note).

★ **What this does NOT do, stated because a lifted precondition reads as permission (§12.3, §13.3):** it does **not** satisfy clause **(ii)** — `codex_local`'s write capability remains **unmeasured** (probe (a)'s codex arms were refused upstream — E7-F027/E7-F028 — and no run since has measured a codex write), so an *adapter-agnostic* mechanism is still refutable; it does **not** discharge §9.1's census (owed for any candidate predicate) or §9.2's unrun `files.read`-after-redirect probe; and it does **not** touch §13 — deleting or retiring clause-6 arm 2 remains **the founder's call**, deliberately open. The only thing that changed: the measure-first stop condition's **first clause is now met**, so the decision this section defers is **ripe**, not made. No mechanism is proposed here, the A–G plan stays deleted, and the bar is untouched.

### 12.1 The status, stated so it cannot be misread in either direction

**~~The output ruling is DEFERRED PENDING MEASUREMENT.~~ ★ AMENDED 2026-09-07 (W12): the output
ruling is DEFERRED PENDING A PRODUCT FIX.** The four bullets below were written when a measurement
was owed. Three are unchanged; the third is the one that moved, and it moved from *a measurement
nobody had taken* to *a diff nobody has approved* — which is a different kind of "not yet" and
licenses different next steps.

- **NOT abandoned.** The question is still the epic's last open one (§9.1) and Unit F still owns it.
- **NOT unowned by accident.** CLI-008 remains the owner of every finding in this family
  (E7-F003, E7-F011, E7-F015, E7-F016, E7-F017, E7-F020, E7-F021, E7-F023, E7-F024, E7-F026, and now
  **E7-F027**).
- ~~**NOT "blocked on a decision."** Nobody owes an opinion. What is owed is a **measurement**, and
  §12.2 names three, all cheap, all standalone, none requiring a design.~~
  **★ REPLACED: all three measurements are taken (§12.0), and what is owed now IS a decision — a
  founder-reviewed change to a SHIPPED security posture.** `task-run-sandbox-invocation.ts`'s four
  script literals are unchanged at this tip; A2 rewrote the emitted string *inside the probe*. Until
  that diff lands, the capability a mechanism would be built on **is not in the product**, and a
  mechanism built above it is above the same floor as before — just a measured one instead of an
  unmeasured one. See E7-F021's *"WHAT THE DIFFERENTIAL DOES NOT ESTABLISH"*.
- **NOT a licence to build the cheapest option once someone is impatient.** §12.3.

### 12.2 The three probes, in decision order

★ **All three are worth taking whether or not any mechanism is ever proposed**, because they bound the
option space rather than serve one option — which is exactly the property §9.2 already argued for the
`files.read`-after-redirect question, and the reason that question stayed open through three rounds
without ever being answered.

**(a) THE DECISIVE PROBE — can a real `claude`/`codex`, under the EXACT production argv with no
permission flag, write a file in the `aoa-base` template at all?**

This is the load-bearing premise under **three of the four** candidate answers, and it has never been
measured on any lane. `buildSandboxInvocation` emits four script literals
(`server/src/services/task-run-sandbox-invocation.ts:183`, `:184`, `:203`, `:204`) and **none carries
a permission posture** — no `--dangerously-skip-permissions`, `--settings` or `--allowedTools` on the
claude branches, no `--dangerously-bypass-approvals-and-sandbox` on the codex ones — while the shipped
adapters treat one of those as required for an unattended run
(`claude-local/src/server/execute.ts:735-748`, `internal-agent/cli-mode.ts:598/:601`) and a
UAT-measured production defect is recorded for the flag's absence
(`resolve-crew-adapter.ts:145-153`). Filed as **E7-F021 (HIGH)**.

*The probe.* On the keyed lane (`keyed-e2b-unit-d.yml` already runs the real invocation against a real
sandbox), execute the **exact** `:184` literal — not a paraphrase, not a simplified `sh -c` — with a
prompt whose only instruction is to write a known string to a known path, then read the path back with
`#transport.readFile`. Three outcomes and what each means:

| outcome | reading |
|---|---|
| the file exists with the expected bytes | the premise HOLDS; the option space is genuinely four-wide and the argument moves to which convention |
| the run exits 0 and the file does not exist | ★★★ the "silently no-op" shape (`resolve-crew-adapter.ts:150-151`) reproduced in the distributed argv. **Every file-writing option is dead until the argv changes**, and the next unit is a permission-posture decision, not an output mechanism |
| the run exits non-zero / hangs to the deadline | a third state nobody has predicted; record the stderr verbatim before theorising |

★ Run it **on both branches** (with and without a staged instructions bundle) and **on both adapters**.
The codex branch pipes through `cat` (`:203`), so its exit status is the pipeline's last command's —
a different failure surface from claude's `exec`.

**(b) IS THE CONFIGURED TEMPLATE ALREADY SATISFYING A LOCATION-BASED CONVENTION? — a positive control
nobody has proposed.**

Every location-based candidate ("the agent writes to `<path>` and we count what is there") assumes the
path is empty before the agent runs. **Nothing checks that**, and the template is an operator-authored
filesystem that no protocol surface can see: `templateId` reaches **zero** files under
`packages/worker-daemon/src` and **zero** under `packages/worker-protocol/src`, deliberately
(`capabilities.ts:36`, `:44-46`, `:104-105`), and it is named by **three uncoordinated environment
variables** with opposite defaults. Filed as **E7-F022 (MEDIUM)**.

*The probe.* Create a sandbox from the configured template and **read the candidate path BEFORE
`exec`**. It is two SDK calls and no design. A non-empty read means the convention would have been
satisfied by the image — E7-F020's class, evidence produced by something other than the agent — and
would have been satisfied *silently*, on the very first green run someone quoted.

★★ This is the shape of control this programme keeps discovering it needed afterwards. It costs
minutes now and it is the difference between a counter that proves something and a counter that
proves the Dockerfile.

**(c) DOES THE STREAM HANDLER ACTUALLY DELIVER FROM REAL E2B?**

The only real-E2B execution of that case **failed**: `CLI-realE2B-hardening-result.md:3` records the
first keyed run as 18 cases → 10 pass / 8 fail, and its divergence row 3 is
*"CLI-003 streaming | stdout `''` (expected `out-line`)"*. The fix was to a **different** component
(argv collapse, repaired by `shellJoin`) and is pinned only by a **no-key** unit test. Two later
re-fires were pushed (`.github/keyed-e2b-trigger` entries #3 and #4) and **neither outcome is
recorded anywhere in `docs/replatform`**. Filed as **E7-F025 (MEDIUM)**.

*The probe.* Dispatch `keyed-e2b-conformance.yml` with `e2b_template: aoa-base` — **named, not the
default**, because a push trigger resolves the template to the bare `base` image that has no CLIs
(`keyed-e2b-conformance.yml:24`, `e2b/e2b.Dockerfile:1-7`) — and then **write the run id and the
pass/fail split into `CLI-realE2B-hardening-result.md`.** The measurement is not done until it is in
the record; that is the whole content of E7-F025.

★ Whatever (c) returns, the transcript family is already bounded independently by **E7-F024**: the
frozen `log` payload is truncated **silently** at 65,536 UTF-16 code units
(`worker-daemon/src/supervisor/events.ts:159-165`, `:82-87` — no marker, no flag) and capped at
`MAX_LOG_EVENTS = 480` (`supervisor.ts:82`, `:777`). And by **E7-F023**: clause 4 **does** scan
`job_events` (`e7-distributed-run-verifier.ts:463-467`), so routing model output into events makes a
**hard-fail** gate clause read model-influenced content — one matcher fires on the bare literal
`E2B_API_KEY=` (`:258`).

### 12.3 ★★★ STATED PLAINLY, BECAUSE IT IS THE POINT OF THIS SECTION

**The stop condition as originally written (W6U1, 2026-09-06), kept because a lifted deferral must
show what it replaced:**

> ~~**A fourth mechanism proposed before probe (a) returns will be refuted for the same reason as the
> first three: it will be an invented answer to an unmeasured premise.**~~
> **★ DISCHARGED 2026-09-07 (W12): probe (a) has returned (§12.0). This condition is SATISFIED, not
> deleted, and it is REPLACED by the two below — because the option space is now gated on a PRODUCT
> FIX rather than on a measurement, and a deferral lifted into an open field is how the fourth
> attempt happens.**

★★★ **THE REPLACEMENT STOP CONDITION. Both clauses, not either.**

> **(i) A mechanism proposed before the permission posture is IN THE PRODUCT — a reviewed, merged
> change to `task-run-sandbox-invocation.ts`'s script literals, not a probe-local rewrite — will be
> refuted for the same reason as the first three: it will be an invented answer to a capability the
> shipped code does not have.** The differential was run by rewriting the emitted string inside the
> probe. The literals are unchanged at this tip. A mechanism that assumes a sandboxed agent writes
> files is, today, assuming behaviour that exists only in a probe.
>
> **(ii) A mechanism proposed as ADAPTER-AGNOSTIC before E7-F027's two codex blockers are
> characterised will be refuted a second way, on a premise that is still unmeasured.** Probe (a)
> answered for `claude_local`. For `codex_local` both arms were refused upstream of the question —
> the production argv by codex's own trusted-directory gate, the posture arm by a `401` — so nothing
> is known about whether codex can write. ★ A posture-only fix would close the claude half and leave
> codex broken **while looking like a fix**, which is precisely what (ii) exists to stop.

**Why the old reasoning still applies, unchanged, to the new condition.** Round 1 was refuted on argv
shape, round 2 on argv size, round 3 on the predicate itself (§4). §4.4 names the pattern — *each
round reasoned confidently about a surface it had not enumerated*. A fourth round that assumes the
product does something only a probe has done is that pattern again with a new noun, and the 26-agent
wave remains the strongest available evidence for taking it seriously: sixteen adversarial passes
over four options returned **two** `sound` verdicts and **46** unrebutted fatal problems. That is not
a signal that the wrong option was picked; it is a signal that the question was being answered above
a floor nobody had checked.

**So: no mechanism section will be added to this document until BOTH clauses are met.** If a future
author believes they have one anyway, the minimum bar is unchanged and now cheaper to meet, because
two of its three inputs exist: §9.1's census — *for the candidate predicate, enumerate every writer
that can produce a row it admits* — **plus** probe (a)'s result quoted by run id
(`34087197668`, `W7U1-output-probe-result.md`) **plus** the merged posture diff quoted by commit.
Anything less has already been tried three times.

★ **What this section does NOT license, said explicitly because "the deferral is lifted" reads as
permission:** it does not license shipping the posture change (that is a founder-reviewed security
diff, E7-F021), it does not license choosing among the three revived options (§12.0.1 revives
premises, not designs), and it does not revive the deleted A–G slice plan (§4.3 refuted round 3 at
the predicate, which no probe touches).

---

## 13. THE FIFTH OPTION, RECOVERED — *"do not build it"* — **and it was NEVER ADVERSARIALLY ATTACKED**

★★★ **READ THE WARNING BEFORE THE ARGUMENT.** A fifth option was generated during the 26-agent wave —
*"DO NOT BUILD IT: retire the capability bar, delete the arm that lies about it, and spend the next
unit on CLI-008 Unit C"* — and was **LOST to a serialization failure** before it reached the brief. It
therefore went through **zero** of the sixteen adversarial passes the other four survived. It is
recorded here so it does not vanish a second time, and it is recorded **with that asymmetry stated in
its own heading**, because:

> **An unattacked option must never be presented at the same confidence as options that were
> attacked.** The other four have documented fatal problems *because someone looked for them*. This
> one has none *because nobody looked*. Those are not the same state, and a comparison table that
> puts them in adjacent rows is lying by layout.

The argument below is **re-derived from the terrain in this worktree by W6U1**, not transcribed from
the lost text — so it is at least honestly sourced, but it is one author's reconstruction of a
position, not a surviving artefact.

### 13.1 Its strongest case, re-derived and measured

1. ★★★ **`capabilityProven` gates NOTHING, and the measurement is repo-wide.**
   `--require-capability` defaults to **false** (`server/src/cli/verify-e7-1-distributed-run.ts:64-66`,
   `requireCapability: false`). Measured at this tip for `capabilityProven` /
   `--require-capability` / `requireCapability`:
   - **`.github/` — ZERO files.** No workflow reads it, passes the flag, or asserts on it.
   - **`scripts/` — THREE files, all PROSE, zero executable use:** `finding-ownership.json` and
     `gate-clause-wiring.json` (register `reason` strings) and `scripts/lib/register-id-uniqueness.mjs:39`
     (a comment citing it as a *precedent*). No `.mjs` guard evaluates it.
   - **Production TypeScript — THREE files, all inside the verifier's own lane:**
     `cli/verify-e7-1-distributed-run.ts`, `services/e7-distributed-run-verifier.ts`, and
     `services/run-execution-owner.ts:265` (a prose comment).

   So the bar is a string printed beside a verdict. Nothing anywhere fails because of it.
2. **Arm 2 reads `PROVEN` with no agent output and no actor** — **E7-F020 (HIGH)**: an ordinary
   `heartbeat.ts:4524` runtime-service emission writes `created_by_run_id = run.id` on the DEFAULT
   isolated-workspace configuration, before the handoff. The bar does not merely fail to prove
   capability; on the configuration the campaign will try first, it **asserts** capability falsely.
3. **Nothing in the distributed path runs at all** — **E7-F018 (HIGH)**: both arms are structurally
   unreachable in every checked-in configuration, and what is owed is two operator artefacts that sit
   outside a code PR's blast radius.
4. **The unit that would make the bar meaningful has been refuted three times** (§4), and the thing
   the bar is supposed to certify — *the agent can do work* — is closer to being demonstrated by
   **Unit C** (the MCP tool surface: `mcp__aoa__*` reaching a sandboxed agent) than by any counter
   over control-plane rows, because §0 establishes that a row count can assert **provenance** and can
   never assert **productivity**.

**Put together, its claim is:** the cheapest honest move is to stop maintaining a verdict that gates
nothing, currently lies on the default configuration, and cannot be made truthful without a mechanism
that has failed three design rounds — and to spend the unit on capability the agent would actually
use.

### 13.2 What it would have had to survive, and did not

Recorded so that whoever picks this up attacks it properly rather than adopting it because it is the
only option in this document without a refutation attached. At minimum:

- **Does deleting the bar delete the QUESTION?** E7-F015 and E7-F020 are defects in a judge; if the
  judge goes, do the findings resolve, or do they become "there is no judge at all", which is worse?
- **What replaces "did the distributed journey do anything?"** Clauses 1–5 corroborate the *journey*;
  clause 6 is the only thing that gestures at *work*. Removing it makes a green E7-1 provably a
  mechanism proof and nothing more — which E7-F003 already says it is, but saying it and *encoding*
  it are different.
- **Is Unit C actually unblocked?** This option asserts it as the better spend and offers no
  measurement that Unit C's tools reach a sandboxed agent — which, per probe (a), is the same
  unmeasured floor.
- ★ **It is a SCOPE conclusion, which is exactly the kind round 3 also reached** (§4.3), and round 3's
  scope conclusion was correct while its mechanism was not. Being right about scope does not transfer.

### 13.3 ★★★ WHAT MUST NOT BE DONE WITH THIS SECTION

- **Do NOT implement any part of it.** Recording an option is not adopting it.
- ★★★ **Do NOT delete arm 2 of clause 6.** That is a **founder call**, it is **deliberately still
  open**, and it is not this unit's to take — nor the next unit's, on the strength of an option that
  no adversary has read. E7-F015's and E7-F020's register entries both state that no replacement
  predicate is designed and that the two obvious candidates are unmeasured guesses; deleting the arm
  is a third guess wearing a different hat.
- **Do NOT cite this section as "the wave recommended retiring the bar."** The wave recommended
  **measuring first** (§12). This option was lost before the wave could judge it.
