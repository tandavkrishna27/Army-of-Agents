# BRW-003d — The pipeline half — TERRAIN

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Measured at:** `2050fcf15`
**Index:** [`BRW-003-design.md`](./BRW-003-design.md) · **Predecessor:** [`BRW-003b-result.md`](./BRW-003b-result.md)

003d carries the four clauses 003b did not: **stream metadata, payload bounding, redaction,
ordering** — plus the commit-vector ceiling fix. Everything below is measured, with the command that
measured it, because the index's summary was right about the shape and wrong about the size.

---

## ★ FINDING 1 (HIGH) — the parser cliff is 41× wider than the design assumed, and it kills four guards outright

The design said the 100 KB parser default "makes that branch unreachable" for event batches. That is
true, and it is not the whole finding. **The frozen contract and the server disagree about payload
size on five of ten operations**, and the disagreement is *provable*, not probabilistic.

- `server/src/app.ts:340` — `app.use(express.json({ verify: captureRawBody }))`. **No `limit`.**
  Express's default is **100 KB = 102,400 bytes**.
- Worker-control mounts at `app.ts:452`, inside the `api` Router — i.e. **after** that parser. It
  declares **no parser of its own** (grepped: no `express.json`, no `bodyParser`, no `raw(` in
  `worker-control.ts`).
- `packages/worker-protocol/src/transport.ts` — the **frozen** `OPERATION_DESCRIPTORS` declare
  `maxRequestBytes` per operation.

### The map

| Route | Operation | Contract max | Handler check | vs. 102,400 | Verdict |
|---|---|---|---|---|---|
| `/worker-control/enroll` :205 | `enrollment` | 256 KiB | **none at all** | 2.56× over | unguarded **and** unreachable |
| `/worker-control/poll` :260 | `poll` | 64 KiB | :266 | under | ✅ live |
| `/leases/:id/ack` :328 | `lease_ack` | 64 KiB | :336 | under | ✅ live |
| `/leases/:id/renew` :387 | `lease_renew` | 64 KiB | :395 | under | ✅ live |
| `/worker-control/events` :432 | `event_upload` | **4 MiB** | :442 | **41× over** | ☠ **DEAD** |
| `/artifact-transfer-grants` :481 | `artifact_transfer_grant` | 64 KiB | :491 | under | ✅ live |
| `/artifact-commits` :530 | `artifact_commit` | 256 KiB | :540 | 2.56× over | ☠ **DEAD** |
| `/quarantine/grant` :651 | `quarantine_grant` | 64 KiB | :661 | under | ✅ live |
| `/quarantine/finalize` :702 | `quarantine_finalize` | 256 KiB | :712 | 2.56× over | ☠ **DEAD** |
| `/control-acks` :752 | `control_command` | 256 KiB | :762 | 2.56× over | ☠ **DEAD** |

### Why "DEAD" is provable, not suspected

Each dead branch reads `rawBody && rawBody.length > OPERATION_DESCRIPTORS.<op>.maxRequestBytes`.
`rawBody` is set by `captureRawBody` **during a successful parse**, so it exists only when the body
was ≤ 102,400 bytes. Therefore `rawBody.length ≤ 102,400`, and the comparisons are:

- `102,400 > 4,194,304` — **always false**
- `102,400 > 262,144` — **always false**

There is no input that reaches these branches. They are not "unlikely"; they cannot fire. This is
the programme's **"a check that nothing runs is not a check"** class — instance five — and the first
in which the guard is *provably* rather than circumstantially inert.

### The second-order defect: the refusal is the WRONG SHAPE

This is the part that actually breaks workers. Anything over 102,400 bytes is rejected by
body-parser, and `middleware/error-handler.ts:121-135` honours it as
`res.status(413).json({ error: message })` — **a plain error object, not a worker-protocol
envelope.** The frozen contract gives `event_upload` `retry: "idempotent_retry"` and a closed error
vocabulary including `payload_too_large`. A worker that receives an unclassifiable 413 cannot route
it through that retry rule.

So a legal 4 MiB batch does not merely fail. It fails **in a shape the client contract cannot
describe**, and the correctly-written branch that would have described it is dead.

### The fix already exists in this file, applied to something else

`app.ts:293-296` mounts `express.json({ limit: "20mb" })` on exactly
`["/api/companies/import", "/api/companies/import/preview"]`, with the comment: *"The global default
(100KB) is too small for legitimate bundles."* **The same reasoning, unapplied to worker-control.**
The precedent, the mechanism, and the justification are all present; only the mount is missing.

---

## FINDING 2 (MEDIUM) — a live false claim of enforcement, on 003d's own test

`scripts/check-artifact-commit-vectors.mjs:11-13` claims two independent implementations
*"neither can silently diverge on which manifests may be committed and which must be refused."*

Measured: the reference implements `size_mismatch` (`:110`, `manifest.sizeBytes !== actualSizeBytes`)
and **no ceiling** — grep for `maxArtifactBytes|ceiling` in that file returns nothing. The server
(`artifact-commit.ts:121`) rejects `actualSizeBytes > maxArtifactBytes`.

They have **already diverged**, on precisely the axis 003d's "large download" case sits on. Per the
programme's standing rule, a false claim of enforcement is worse than a missing check — this one
reads as coverage while providing none.

---

## FINDING 3 — the ordering clause's red state is real

`getJobDetail` (`services/job-operations.ts:127,167`; consumed at `routes/job-control.ts:188`) has
**no artifacts section at all** — no `job_artifacts` select, no `orderBy`. So the ordering clause
cannot be discharged by adding a column; it needs a **reader**, or the column is exactly the vacuity
this ticket is supposed to avoid.

---

## FINDING 4 — redaction must be STRUCTURAL, because the canary path has no input

Lane A's `4379a2c53` (landed under this ticket's terrain pass) made `redactionCanaries` **required**
on `SupervisorDeps` and `FenceCloseProxyDeps`, and the change immediately exposed a live site —
`lease-renewal.ts` — constructing a proxy without it. That site now passes `[]` **explicitly**, with
the reason recorded: `createFenceAwareEgressProxy`, the only path that resolves a secret value, has
**zero production callers**.

So canary redaction has **no INPUT**, not merely no coverage. 003d's redaction clause therefore
lands as **structural stripping of URL query and fragment before emit** — independent of canaries,
and live on the server path. Threading browser URLs into the canary set would attach this ticket's
only redaction guarantee to a mechanism that cannot fire.

---

## The rule 003d inherits

**The worker half of the event path has no production boot root.** `createSupervisor` and
`new DurableWorkerEventSink(` have zero production callers; `bootstrapWorkerDaemon` passes only
`{env, proc}`. The server half is live (`app.ts:453`).

**Therefore every 003d clause carries at least one SERVER-SIDE assertion.** A clause proven only
worker-side is vacuously true today — which is this ticket's central risk, and the reason it was
split away from 003b's lifecycle risk in the first place.
