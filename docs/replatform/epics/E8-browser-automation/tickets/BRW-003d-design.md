# BRW-003d — The pipeline half — DESIGN INDEX

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Start SHA:** the commit that adds this file
**Terrain:** [`BRW-003d-terrain.md`](./BRW-003d-terrain.md) · **Index:** [`BRW-003-design.md`](./BRW-003-design.md)
**Predecessor:** [`BRW-003b-result.md`](./BRW-003b-result.md) (producer half, complete)

003d carries BRW-003's four remaining clauses — **stream metadata, payload bounding, redaction,
ordering** — plus two clauses §4 shows were handed between tickets and **landed with nobody**.

---

## §0 ★ Every proposal was refuted, including my own

Five surfaces were probed against real code, then each was handed to an adversarial reviewer
instructed to refute it. **All five came back `proposalSurvives: false`**, with confirmed HIGH
findings. That result is the most useful thing in this ticket, so it is recorded before the design
rather than after.

The refutations that changed the design:

| # | What was proposed | Why it was wrong |
|---|---|---|
| 1 | *(mine)* A red test asserting a 90 KB unauthenticated poll is refused | **Green today.** 90,000 < 102,400, so it parses; the `.strict()` schema then fails and emits a `ProtocolErrorV1` `malformed`. Before and after the fix the observable is identical. My own red state was not red. |
| 2 | *(mine)* Expect `413` + `code:"payload_too_large"` | **Unsatisfiable in both systems.** `worker-protocol-http.ts:83-91` maps `malformed`→400, `internal_unavailable`→503, `throttled`→429, `unauthorized`→401, and *everything else — including `payload_too_large` — to 409*. Today: 413 with `code:undefined`. After: **409**. |
| 3 | *(mine)* "No test builds the real app, so nothing catches a bad mount" | **False, and an inference from a filename filter.** `job-submission.integration.test.ts:331-347` boots the real `createApp` with `distributedExecutionEnabled:true` and already supertests `POST /api/worker-control/enroll`. |
| 4 | Revive all six dead ceiling guards | **Three of them can never be the deciding clause**: the request schemas are `.strict()` with no unbounded field, so a body in the 65,537–102,400 band cannot be schema-valid and `!parsed.success` always decides first. |
| 5 | Add `enrollment` to the ceiling set | **Would throw.** `enrollment.errors` (`transport.ts:803`) omits `payload_too_large`, so `sendWorkerOperationProtocolError(…,"enrollment","payload_too_large")` throws at `worker-protocol-http.ts:57-59`. |
| 6 | Order artifacts by `MIN(job_events.sequence)` | **`sequence` is PER-ATTEMPT, not per-job** (`job_events.ts:45-48`, unique on `(org, attempt, sequence)`). `MIN` over a job is not a total order. Also unindexed: `job_events` has no `job_id` index. |
| 7 | `asc(sql\`observed_sequence NULLS LAST\`)` | Emits `observed_sequence NULLS LAST asc` — a Postgres syntax error. `asc()` is literally `` sql`${column} asc` ``. |
| 8 | An unfiltered artifacts read | `job_artifacts` holds **multiple live rows per identifier by design** — granted, committed and quarantined coexist (`job_artifacts.ts:111-113`). |
| 9 | Add a URL redactor at `foldAttemptEvidence` | **A live server-side event-payload redactor already exists and nobody found it**: `redactEventPayload` (`server/src/redaction.ts:115`) with ~13 live non-test call sites. And `foldAttemptEvidence` is double-gated, both off by default. |
| 10 | Export the private `sanitizeUrl` | `sanitizeErrorText` is **already exported** (`safe-error.ts:29`) and strictly stronger — it strips a path-segment token that `sanitizeUrl` leaves intact. |
| 11 | "Don't add a token regex — a guess dressed as a control" | The repo **already ships two, both live** — `TOKEN_LIKE_PATTERN` (`safe-error.ts:4-5`) and `SECRET_VALUE_PATTERNS` (`redaction.ts:16-26`). |
| 12 | Anti-vacuity anchor: "a `browser_observation` row lands in `job_events`" | **Passes today with zero production change.** `browser_observation` is already a frozen variant (`events.ts:388`), already permitted by the live CHECK (`job_events.ts:76`), and `job-events.ts:75` stores the complete wire event verbatim. The textbook vacuous clause. |
| 13 | Unify `GOVERNED_EFFECT_OPS` by exporting from worker-protocol | **Turns the required gate red.** `worker-protocol-contract-bytes` (`pr.yml:651-672`) byte-checks the manifest and is a `needs` of `ci-required`. |

**One measurement the fan-out produced that I had not looked for, and it changes the security case:**
`express.json` defaults to `inflate:true`, and for a compressed body the Content-Length pre-check is
**skipped**, so the limit bounds *decompressed* bytes. Measured amplification: **1019.8 : 1** — a
4,113-byte gzip body yielded 4,194,274 bytes under a 4 MiB limit. The legitimate worker never
compresses (`client.ts:239-243` sets only content-type, authorization and proof headers), so
**`inflate:false` is free hardening** and is now part of the mount.

---

## §1 ★ THE REFRAME — the ordering clause is about EVENTS, and the live reader is unordered

Refutations 6, 7 and 8 all attack the same assumption: that "order tied to event sequence" means
*ordering artifacts by an event sequence*. It does not have to.

`getJobDetail` (`job-operations.ts:190-193`) **selects `sequence` and never orders by it.**
`attempts` (:183-186) and `leases` (:187-189) are unordered too. So the literal clause has a
literal, live, server-side discharge that nobody proposed:

```
.orderBy(asc(attemptNumber), asc(sequence))     // sequence is per-attempt, so BOTH keys
```

This dissolves the entire ordering HIGH set: no correlated subquery, no per-attempt collision, no
`NULLS LAST`, no unindexed join, no new column, no migration. It is red today (the reader has no
`orderBy`), it runs on the live operator route, and it cannot pass against a system that does
nothing.

The artifacts section is still worth adding — but as **discoverability**, not as the ordering
clause's proof. That reclassification is what makes the rest of 003d tractable.

---

## §2 ★ THE DISPOSITION DECISION — taken here, before any code

Every downstream fixture depends on which `job_artifacts` rows an operator sees, and the same
decision *is* the stale-fence clause and *is* the 003c collision. Deferring it guarantees one of the
three silently becomes false.

Measured status set — four mutually-exclusive partial uniques, so rows coexist rather than
collide-update (`job_artifacts.ts:88-121`): `granted` (grant intent, `:114`), `committed` (`:94`),
`quarantined` (`:103`), and `expired` (arriving in 003c).

**DECISION: the operator read returns ALL dispositions and puts `status` on the wire.**

- **Not** `WHERE status='committed'`. That would make the stale-fence clause — *"commit refuses;
  the record stays discoverable"* — **false by construction**, because the record that survives a
  refused commit **is** the `status='granted'` intent row. A committed-only read deletes the
  evidence the clause exists to preserve.
- Duplicates per identifier are **intentional and legible**, because `status` is on the wire: an
  operator reads `artifact X: granted → committed` as one lifecycle, not two artifacts. Hiding a
  disposition to avoid a duplicate is hiding the disposition.
- Ordered `(attemptNumber ASC, identifier ASC, status)` and **bounded** (§4, response bounding).
- Planner note the split's own comment already states: the partial uniques cannot serve an `IN`
  predicate, so this read uses `job_artifacts_job_idx` plus a filter. Correct at artifact
  cardinality; stated so it is a decision rather than a discovery.

---

## §3 The slices, and why the order is forced

| | Slice | Forced by |
|---|---|---|
| **003d-1** | **Bounding** — scoped mount, `inflate:false`, refusal shape | Must be **first**: it changes the refusal *code* every later server-side assertion compares against. Land it last and every other test is written twice. |
| **003d-2** | **Redaction** — value-scoped, not key-scoped | Must precede metadata. See below. |
| **003d-3** | **Metadata** — browser events into the projection | Edits the *same 15 lines* of `canary-terminal-projection.ts` as 003d-2. |
| **003d-4** | **Ordering + response bounding** — the events `orderBy`, the artifacts section, `limit` | Needs §2's disposition set. |
| **003d-5** | **Grant-time ceiling + commit-vector** | Independent of 1–4; may go any time. |

### ★ Why redaction must ship BEFORE metadata — the one hard constraint the union did not contain

The metadata slice routes console lines and network summaries into the frozen **`extensions`**
channel. Both redactors on the table cover `payload.url` and `payload.message` **only**. And the
frozen forbidden-key scan is **keys-only** (`wire-safety.ts:43-58`), so a credential sitting in an
extension *value* is legal on the wire.

Ship metadata first and you open an unredacted, wire-legal, **permanently durable** credential
channel and then try to close it. Ship redaction first — **value-scoped**, the shape
`sanitizeRecord` (`redaction.ts:62-84`) already has — and metadata lands into a covered pipe.

### ★ A frozen-contract contradiction, recorded not resolved

`workerEventBatchV1Schema` permits **1–500 events** (`events.ts:428`). One `browser_observation` may
carry 128 artifactIds + a 4,096-byte url + a 1,000-byte title, **plus 65,536 bytes of combined
extensions** (`extensions.ts:42`). A schema-legal 500-event batch therefore reaches tens of MB
against a frozen **4 MiB** request ceiling. **The two frozen bounds contradict each other.**

003d does not resolve that — both sides are frozen. After the mount lands, "payloads bounded" is
server-proven as exactly **"≤ 4 MiB per request"** and nothing more. The result doc must not imply
an end-to-end aggregate guarantee.

Also frozen and load-bearing: the extension channel **forbids floats**
(`canonical-json.ts:71-73` throws `float is not allowed in the v1 subset`). A network summary is
float-native — durations, timings, transfer rates. Metadata must quantise or stringify before emit,
and that is a design constraint, not an implementation detail.

---

## §4 The whole acceptance table — including two clauses that landed with NOBODY

The union is checkable only if orphans are named. Two were found by the completeness pass:

| Clause | Owner | Note |
|---|---|---|
| Stream metadata | 003d-3 | the "row lands in job_events" anchor is **vacuous**; the non-vacuous half is the extension value reaching `heartbeat_run_events` |
| Payloads bounded | 003d-1 | request side |
| **Response-side bounding** | **003d-4** | ⚠ **found by nobody**: the events select has **no `limit`** — every `job_events` row for a job on an authenticated operator route |
| Redaction explicit | 003d-2 | value-scoped |
| Order tied to event sequence | 003d-4 | §1 reframe: the **events** `orderBy` |
| **Refuse-at-grant** ("DOM snapshots *where allowed*") | ⚠ **DEFERRED, named** | assigned to 003b by the index, handed back to 003d by 003b's result, designed by neither. **Structurally blocked:** the frozen `artifactTransferGrantRequestV1Schema` (`artifacts.ts:364-378`) has **no `kind` field**, so the control plane cannot refuse a kind it was never told. Unblocking needs a frozen-surface change behind the byte gate (`pr.yml:651-672`). |
| **Stale-fence test** | **003d-4** | discharged by §2: the surviving `status='granted'` row **is** the discoverable record |
| Screenshot/trace **hash** | ⚠ **DEFERRED, named** | the store-observed digest is `head.checksumSha256` at commit — but `packages/browser-runtime` contains **no sha256/digest/manifest code at all**, and has **zero importers repo-wide**. The bridge does not exist. |
| Large download (commit ceiling) | 003d-5 | plus the grant-time gap below |
| Retention | 003c | blocked on Lane A's `isSweepEligible` |

### ★ The grant-time ceiling gap — found by the completeness pass, owned here

The grant's declared `maxBytes` is bounded only by `Number.MAX_SAFE_INTEGER` (`artifacts.ts:134`),
stored as `job_artifacts.size_bytes`, and **compared to no server limit**. The commit ceiling
(`maxArtifactBytes`, default **5 GiB** at `artifact-commit.ts:81`) is applied to `head.contentLength`
— i.e. it can only fire **after the bytes are already in the store**, and the orphan then survives.

**Refuse the grant when `body.maxBytes > maxArtifactBytes`**, in `artifact-transfer-grant.ts`. This
does not contradict 003b's warning that `maxBytes` is not enforced at the store — it uses the value
only as *declared intent to refuse on*, before a byte moves.

---

## §5 Named deferrals — written down, not discovered later

1. **`job_events.event` retains the unredacted payload permanently.** Every redaction site in the
   union is strictly downstream of durability: `job-events.ts:70-80` stores the complete wire event
   and `job-control.ts:2537` writes it verbatim; grep for `redact|sanitiz|scrub` across both returns
   **nothing**, and there is no TTL. Redacting at ingest would desync `event_digest`. So redaction
   here is a **projection-level mask**, and the durable raw store is an **accepted, owned residual**
   — stated in writing rather than implied away.
2. **Refuse-at-grant** — blocked on a frozen schema field (above).
3. **The trace-digest bridge** — no hashing code exists on the producer side (above).
4. **`GOVERNED_EFFECT_OPS` / `CLEANUP_DENIAL_LABEL` parity is OUT OF SCOPE.** It has no BRW-003d
   clause, it can carry no server-side assertion, and its mechanism sits inside `createSupervisor`
   (zero production callers). It belongs to E4/DEP-008. Carrying it here would be scope drift
   dressed as diligence — and its "violated invariant" framing is itself doubtful: `destroy`'s
   exemption reads as deliberate layering (`effect-authority.ts:110-113`).

---

## §6 The rule, and what is knowingly dormant

**Every clause carries at least one SERVER-SIDE assertion.** The worker half has no production boot
root — `createSupervisor` and `new DurableWorkerEventSink(` have zero production callers.

Two things in 003d are **knowingly dormant** and are labelled **forward guards, never a clause's
proof**:

- the producer-side `EventSequencer.browserObservation()` emit;
- the `url`-field strip, whose input cannot arrive today — `@armyofagents/browser-runtime` has
  **zero importers repo-wide** outside its own package.

Naming them as dormant is the difference between a forward guard and this programme's signature
defect. Both must survive verbatim into the result doc.
