# JOB-015 — General control-command delivery to a running worker — TERRAIN + DESIGN

**Epic:** E3 · **Lane:** A · **Start SHA:** `203853b3a`
**Status:** filed, not built. **Sequencing is constrained — see §6.2; this must not be built
concurrently with Track A's CLI-008 work in `job-leasing.ts`.**
**Raised by:** BRW-004 terrain mapping (E8), which could not satisfy its own acceptance clause
without this hop. Escalated and chartered rather than absorbed.

> **Method note.** Every count below is a repo-wide grep at `203853b3a` with `node_modules` and
> `dist/` excluded, using `grep -a` throughout (a raw NUL byte in
> `packages/worker-daemon/src/supervisor/provider.ts` makes plain grep skip that file silently).
> Re-measured in this worktree rather than carried over from the E8 survey.

---

## 0. Why this ticket exists: nothing charters it, and two neighbours only look like they do

`docs/replatform/program-design.md` has **zero** occurrences of "control command", "command
delivery", or "pending control". The two nearest nodes both stop short, and the ticket is filed here
so the next reader does not have to re-derive that:

- **JOB-006 — "Cancellation, expiry, retry, and reconciliation"** (`:515`). Its acceptance is
  *"Cancellation is **observable to the worker**"* — and it is, via the boolean path in §1.2. JOB-006
  is **satisfied and correctly scoped**. It charters cancellation's observability, not a general
  command channel.
- **JOB-008 — "Operator job and worker controls"** (`:529`). *"Expose tenant-scoped
  job/attempt/event/worker/placement status, cancellation, drain, and revocation through
  control-plane APIs and a minimal operations UI."* That is the control-plane **write** side plus the
  operator UI. **Nothing there concerns a running worker FETCHING a queued command.**

So the write side is chartered (JOB-006, JOB-008), the wire is frozen and complete (§1.6), and the
worker's ACK route exists — but the hop between "a command is durably queued" and "the worker that
should obey it learns of it" is chartered by no ticket in the 94-ticket programme.

★ **The precise shape, and the ticket must not be read as anything looser: there is exactly ONE
delivery path, it carries a boolean, it is live and correct, and it does not generalise.** An
approval allow/deny is not a boolean cancel and cannot ride it.

---

## 1. TERRAIN

### 1.1 The WRITE side is live, multi-caller, and correct

`job_control_commands` (`packages/db/src/schema/job_control_commands.ts`) is a real, tenant-isolated,
fence-bound channel: composite tenant FKs to job/attempt/lease, `FORCE RLS` + an `aoa_app` policy,
uniqueness on `(organization, lease, command_id)` for re-issue idempotency and on
`(organization, lease, command_seq)` for a strictly monotonic per-lease sequence (`:24-38`).

Two insert sites (`packages/db/src/repositories/tenant/job-control.ts:3406`, `:3826`), reached from
production:

- `requestCancellation` — `server/src/index.ts:1390,1401` (the reconciliation composition root),
  `server/src/routes/worker-control.ts:988`, and the budget hard-stop bridge
  (`server/src/services/budgets.ts:430,477-488`).
- The JOB-011 approval bridge's control queue (`server/src/services/job-approval-bridge.ts:730-733`),
  which queues `product_approval_result` / `runtime_decision_result`.

**Nothing about the write side is broken.** That matters: the failure is asymmetric, and a reader who
sees live writers can easily conclude the channel works.

### 1.2 The READ side: exactly one path, boolean-shaped, live — and it is NOT the repository method

`packages/db/src/repositories/tenant/job-control.ts:2471-2497`, inside the lease-renew mutator:

```ts
// JOB-006 — surface a queued, un-ACKed cancel/graceful_stop control command to
// the worker through the frozen renew response. …
// Only an un-ACKed cancel/graceful_stop drives the frozen `cancelRequested` flag.
const [pendingCancel] = await tx.select({ reason: jobControlCommands.reason })
  .from(jobControlCommands).where(and(
    eq(jobControlCommands.organizationId, input.organizationId),
    eq(jobControlCommands.leaseId, input.leaseId),
    inArray(jobControlCommands.commandKind, ["cancel", "graceful_stop"]),
    isNull(jobControlCommands.ackStatus),
  )).orderBy(asc(jobControlCommands.commandSeq)).limit(1);
```

…collapsed into the frozen response as `cancelRequested: Boolean(pendingCancel)`,
`cancelReason: pendingCancel?.reason ?? null`, with **`extensions: []` hardcoded** (`:2486-2497`).

**And the worker consumes it.** This half is genuinely built and live:
`packages/worker-daemon/src/lease/lease-renewal.ts:83` types the renewed variant as
`{ kind: "renewed"; expiresAt; cancelRequested; cancelReason }` — **note it drops `extensions`
entirely** — `:203` reads the flag off the parsed body, and `:542` acts on it
(`if (attempt.cancelRequested) …`).

So the delivery mechanism is not missing. It is **one boolean, derived by an inline query, filtered
to two of the frozen six command kinds.**

### 1.3 ★★★ The orphan, and its docstring names a consumer that does not exist

`packages/db/src/repositories/tenant/job-control.ts:498-503`:

```ts
/** Un-ACKed control commands for a lease, in monotonic sequence — the "return
 * pending controls until ACK" read the poll/renew path surfaces. */
listPendingControlCommands(input: { organizationId: string; leaseId: string }): Promise<QueuedControlCommand[]>;
```

The implementation (`:3437-3444`) is complete and correct: all un-ACKed commands for the lease,
`ORDER BY command_seq ASC`, mapped through `toQueuedControlCommand`.

**Its docstring asserts that the poll/renew path surfaces this read. It does not.** Measured:

| Claim | Measured |
|---|---|
| non-definition references to `listPendingControlCommands` | **exactly 1**, and it is `server/src/__tests__/job-fence-surface.contract.test.ts:114` — a name-inventory contract test |
| the renew path calls it | **no** — §1.2 uses its own inline query with a different projection and a narrower filter |
| the poll path calls it | **no** — the poll response schema carries lease offers, no control field |
| `commandKind` anywhere in `packages/worker-daemon/src` | **0** |
| production callers of `decideControlReceiverV1` (the E1 replay/gap/conflict/stale classifier the schema header at `job_control_commands.ts:33` says the worker uses) | **0** — the only non-`worker-protocol` reference is that comment itself |

★ This is not merely an unused method. **It is a false claim of enforcement**, this programme's own
named worst failure class, written into the docstring of the very method that would implement it.
A reader auditing "do queued controls reach the worker?" finds a method whose name and comment both
say yes. **Filed as `E3-F035`**, owned by this ticket.

### 1.4 What is actually undeliverable: 3 of the 5 persistable kinds

`CONTROL_COMMAND_KINDS` (`packages/worker-protocol/src/transport.ts:601-608`) is six:
`cancel, product_approval_result, runtime_decision_result, checkpoint, graceful_stop, drain`.

`job_control_commands_kind_check` (`packages/db/src/schema/job_control_commands.ts:89-92`) admits
**five** — `checkpoint` is omitted, so a checkpoint request cannot even be persisted (already handed
to **SVC-004** by name at `service_generations.ts:69-72`; **not this ticket's**).

Of the five persistable kinds, the boolean path in §1.2 covers two:

| Kind | Persistable | Delivered | Note |
|---|---|---|---|
| `cancel` | yes | **yes** (boolean) | JOB-006, working |
| `graceful_stop` | yes | **yes** (boolean, indistinguishable from `cancel` at the worker) | the worker cannot tell which it got |
| `drain` | yes | **no** | excluded by the `inArray` filter |
| `product_approval_result` | yes | **no** | JOB-011 queues it; nothing reads it |
| `runtime_decision_result` | yes | **no** | JOB-011 queues it; nothing reads it |
| `checkpoint` | **no** (CHECK) | n/a | SVC-004 |

### 1.5 TWO epics are already blocked on this, independently

This is the strongest argument for chartering it, and neither discovery was aware of the other:

- **E8 / BRW-004.** Its acceptance clause "denial/timeout fails closed" requires an approval
  allow/deny to reach a running browser session. The decision is produced and durably recorded — the
  30 s boot-rooted sweep at `server/src/index.ts:2106-2136` flips a timed-out permission decision to
  `deny` — and the `runtime_decision_result` is queued by the bridge. **It is then never delivered.**
  BRW-004's design gates its fail-closed slices on this ticket.
- **E9 / SVC-001** reached the same wall from the other side and documented it in schema prose,
  `packages/db/src/schema/service_generations.ts:61-67`:

  > TTL is CONTROL-PLANE state … it is deliberately NOT mirrored into the job workload:
  > `serviceWorkloadV1Schema` is frozen and `.strict()`, and **a worker has no channel on which to
  > receive a time bound at all — `control_command` is ACK-only, and the lease-renew response carries
  > only `cancelRequested`.** Enforcement is the reconciler issuing
  > `requestCancellation({graceful:true})`; latency is bounded by the lease-renewal cadence.

  SVC-001 worked around it by degrading a TTL into a cancellation. That workaround is only available
  because the desired effect happened to be "stop"; an approval result has no such degradation.

### 1.6 The frozen wire is complete — no Protocol Custodian ticket is required

Confirmed, and this is what keeps the ticket small:

- `control_command` is one of the ten frozen `WORKER_PROTOCOL_OPERATIONS`
  (`transport.ts:757-768`), with a full descriptor at `:906-914`: `audience: "control_channel"`,
  idempotent, `idempotent_retry`, 256 KiB, 15 s, outcomes `accepted|completed|rejected|stale`.
- `controlCommandV1Schema` (`transport.ts:627-641`) and `controlCommandAckV1Schema` (`:649-661`)
  are frozen and complete.
- `decideControlReceiverV1` (`transport.ts`, exported at `index.ts:500`) already implements
  `accept | replay | gap | conflict | stale` against the contiguous per-lease sequence.
- **`leaseRenewResponseV1Schema.extensions`** (`packages/worker-protocol/src/job.ts:463`) is the
  bounded, namespaced, `critical:false`-ignorable additive container — ≤16 extensions, ≤16,384
  canonical bytes per value, ≤65,536 combined, and `KNOWN_CRITICAL_EXTENSION_NAMESPACES` is empty so
  every `critical:true` extension fails closed (`extensions.ts:32-44`).
- The worker's ACK route already exists: `POST /worker-control/control-acks`
  (`server/src/routes/worker-control.ts:880`).

★ **One constraint that shapes the design and is easy to miss.** The renew mutator stores the exact
response body in a `workerOperationReceipts` row (`job-control.ts:2497+`) — the comment at `:2485-2486`
says *"stored in the receipt AND returned, so a lost-response replay reproduces this exact renewal
and cannot extend twice."* So a replayed renew returns the **original** body. A command queued
between the first renew and its replay is therefore **not** in the replayed response; it arrives on
the next fresh renew. Delivery is at-least-once **per fresh renewal**, never within a replay. Any
design that assumes a replay re-reads the table is wrong, and any latency bound must be stated
against the renewal cadence, not against wall-clock.

---

## 2. Design decisions

### D1 — Deliver on the lease-renew response, as a non-critical bounded extension

Namespace `dev.aoa.job/control-v1`, `schemaVersion: 1`, `critical: false`, value = the pending
commands for the lease in `command_seq` order. Replace the hardcoded `extensions: []` at
`job-control.ts:2496` with the projection, sourced from **`listPendingControlCommands`** — the
existing method, which is exactly this read.

Why this and not the alternatives:

| Option | Verdict |
|---|---|
| **Widen `cancelRequested` into more booleans** | **Reject.** It does not generalise past a two-valued signal, and `leaseRenewResponseV1Schema` is `.strict()` and frozen — new named fields are a Custodian STOP. |
| **A dedicated `control_command` fetch operation** (frozen-legal; the op exists) | **Reject for v1.** It needs a new server route, a new worker polling loop, its own auth/anti-replay envelope and its own cadence. Strictly more surface for the same result, and the renew heartbeat already reaches exactly the population that needs commands: workers holding a live lease. Keep it as the escalation path if the extension proves too small (§7 Q2). |
| **Deliver on the poll response** | **Reject.** Poll reaches *idle* workers looking for work; a control command is addressed to a worker already holding the lease. Wrong population. |
| **Extension on renew** | **CHOSEN.** Frozen-compatible, byte-safe for existing workers (`critical:false` ⇒ ignored), reuses the live heartbeat, and reuses the orphaned method — closing `E3-F035` by construction rather than by deletion. |

★ Precedent: CLI-008 Unit B put the staged-input pointer on the job envelope's `extensions[]` for
exactly this reason. This is the same move on the lease envelope.

### D2 — `cancelRequested` stays, unchanged, forever

The boolean is not deprecated and not re-derived from the new extension. It is the **only** signal an
already-deployed worker understands, and `lease-renewal.ts:542` acts on it today. Changing or
removing it would break every worker that has not adopted the extension — the precise failure the
`critical:false` container exists to prevent.

Consequence: `cancel` and `graceful_stop` are delivered **twice** (boolean and extension) to an
adopting worker. That is intentional redundancy, and the worker-side rule is that the extension is
authoritative when understood, with the boolean as the floor. **This must be a test, not a comment.**

### D3 — Fail-closed direction: a delivery failure must never look like "no command"

An extension that fails to parse, exceeds its byte budget, or carries an unknown shape must **not**
be silently dropped into "no pending commands". The worker treats a malformed
`dev.aoa.job/control-v1` extension as a delivery fault and keeps the run's existing posture (the
boolean still governs cancel).

> ★★★ **CORRECTION (Codex review).** An earlier draft had the server-side projection fail closed by
> **omitting the extension entirely** when the pending list exceeds its byte budget. That is this
> ticket's own bug, re-committed: an omitted extension is **byte-identical to `extensions: []`**, so
> the worker cannot distinguish "nothing is pending" from "commands exist and could not be sent." A
> silent omission is exactly the class JOB-015 was filed to fix.
>
> **Revised:** an over-budget queue must be SIGNALLED, not omitted. The extension is always emitted
> when anything is pending, carrying as many commands as fit **plus an explicit overflow marker**
> (`truncated: true` with the total `pendingCount`), so the worker knows its view is partial and can
> renew again to drain the remainder. Truncation is safe **only** because it is declared; an
> undeclared truncation would be worse than omission, and an undeclared omission is worse than both.
> If even the marker cannot fit, the renew fails with a protocol error rather than returning a
> response that reads as "no commands".
>
> ★★★ **CORRECTION 2 (Codex re-review): marked truncation STALLS FOREVER on a single oversized
> command.** Commands are delivered in `command_seq` order, so if the *first* pending command does
> not itself fit, the projection emits only the overflow marker. The worker then has nothing to apply
> and nothing to ACK; ACK is what clears `ackStatus IS NULL`; so the next renewal sees the same
> leading command and returns the same marker — **a permanent stall with no terminal**, which is the
> E7-F010 shape.
>
> **It is not a corner case — it is guaranteed at the bound.** A work-question answer is bounded at
> **≤16 KiB canonical** by the protocol itself (`transport.ts:526-534`) and the per-extension-value
> cap is **exactly 16,384 bytes** (`extensions.ts:43`). So a maximal answer *plus* the result's own
> `requestId`/`nonce`/`requestDigest`/`schemaVersion`/`sourceRevision`/`expiresAt`/`decidedBy`/
> `decidedAt`/`idempotencyKey`/`timeoutPolicy`/`outcome` **necessarily** exceeds the extension cap.
> The stored `command` jsonb is unbounded besides.
>
> **Revised: an individually oversized command has a terminal rule, and it is not "renew again".**
> When the leading pending command alone exceeds the per-value budget, the projection emits the
> overflow marker carrying that command's `commandId` and `commandSeq` plus an explicit
> `oversizedLeading: true`. The worker's ACK path accepts an ACK for that command with status
> **`rejected`** and detail `oversized_for_renew_channel` — a frozen `CONTROL_ACK_STATUSES` value
> (`transport.ts:644`), so no wire change. That clears `ackStatus`, unblocks the queue, and leaves a
> durable record that the command was never applied. Escalating that one command to the dedicated
> frozen `control_command` fetch operation (D1's rejected-for-v1 option) is the follow-up, and it is
> named here so the stall has an exit rather than a hope.
>
> ★ **Positive control:** an oversized leading command must be shown to UNBLOCK the queue — the
> command behind it is delivered on the next renewal. A test that only asserts the marker appears
> would pass against the stalling design.

★ The byte budget is the real risk: 16,384 canonical bytes per extension value against an unbounded
`command` jsonb per row and an unbounded pending count. Slice (b) bounds it; slice (d) proves the
bound fails closed.

### D4 — ACK stays exactly where it is

The worker ACKs through the existing `POST /worker-control/control-acks` with the frozen
`controlCommandAckV1Schema`. `listPendingControlCommands` already filters `ackStatus IS NULL`, so ACK
is what stops redelivery. **No new ACK surface, and no change to `ackControlCommand`'s fence guard.**

> ★★ **CORRECTION (Codex review, verified in source).** "ACK stops redelivery" was stated as though
> it were a safety property. It is not, yet — and the gap is the same class as `E3-F035`.
> `controlCommandAckV1Schema` (`transport.ts:649-661`) carries `commandSeq`, and its own docstring
> says the worker *"echoes the command ID + sequence"* — but `ackControlCommand`
> (`job-control.ts:3163-3170`) matches on `(organizationId, leaseId, commandId)` and the ack-status
> transition **only**. The echoed `commandSeq` is accepted and discarded. **A frozen validation field
> the server never checks.**
>
> **Revised:** slice (c) validates the echoed `commandSeq` against the stored row before the ACK is
> allowed to suppress redelivery; a mismatch is rejected and the command stays pending. This is a
> narrow addition to the ACK's WHERE clause, not a new surface, and the fence guard is still
> untouched. ★ Its positive control is the matching-sequence ACK succeeding in the same test —
> otherwise the new predicate could reject everything and look like working validation.

---

## 3. The concrete work this ticket must land — slices (a)–(f)

### (a) — Pin the defect before fixing it. **S. No product behaviour.**

A test that measures the current state and fails once delivery exists: assert that a queued
`runtime_decision_result` is invisible to a renewing worker today. Land it **before** (b), so the
anti-regression test provably could have caught the defect.

- ★ Without this, there is no evidence the later green test is testing anything. Pin the defect
  first or the anti-regression mutation cannot exist.

### (b) — The server-side projection. **M.**

Replace `extensions: []` in the renew mutator with the `dev.aoa.job/control-v1` extension built from
`listPendingControlCommands`. Bound it: cap the command count per response and compute the canonical
byte length before emitting. **When the budget is exceeded, emit the extension anyway** — as many
commands as fit plus the explicit overflow marker (`truncated: true`, total `pendingCount`), and,
when the *leading* command alone does not fit, the marker's `oversizedLeading` form so the queue can
be unblocked by a `rejected` ACK (D3). **Never omit the extension** — an omitted extension is
byte-identical to `extensions: []` and is the exact bug this ticket exists to fix.

- **Touches `packages/db/src/repositories/tenant/job-control.ts`** (the mutator) — see §6.
- **Artifact:** repository integration tests at embedded PG (`AOA_RUN_WIN_INTEGRATION=1` on Windows,
  or the suite silently skips and a mutation harness then reports false survivors).
- ★ **Positive control:** with **no** pending command the response must carry `extensions: []`,
  byte-identical to today. That is what proves the change is inert when it should be.

### (c) — The worker-side consumer. **M.**

Widen `lease-renewal.ts`'s `renewed` variant to carry the parsed extension, and route each command
through **`decideControlReceiverV1`** — its first production caller — to classify
`accept | replay | gap | conflict | stale` against the contiguous per-lease sequence. Apply
`runtime_decision_result` and `product_approval_result`; ACK through the existing route.

Two behaviours this slice owns that the D3/D4 corrections assign to it, easy to miss because they
live in the decision blocks rather than here:

- **Validate the echoed `commandSeq` server-side before an ACK may suppress redelivery** (D4
  correction). `ackControlCommand` matches on `(organizationId, leaseId, commandId)` today and
  discards the sequence the frozen ACK schema carries. Add it to the WHERE clause; a mismatch leaves
  the command pending. ★ Positive control: the matching-sequence ACK succeeds in the same test, or a
  predicate that rejects everything would look like working validation.
- **Handle the `oversizedLeading` marker** (D3 correction 2) by ACKing that command `rejected` with
  detail `oversized_for_renew_channel`, so the queue behind it drains instead of stalling forever.

- ★ **Positive control:** a worker built **without** extension support must complete a run normally
  against a server that emits one, proving `critical:false` is honoured and existing deployments are
  unaffected.
- ★ **Second positive control:** `cancel` must still work through the boolean alone with the
  extension suppressed (D2's floor).

### (d) — The fail-closed cases. **S–M.**

Malformed extension, marked truncation, an oversized LEADING command and its `rejected`-ACK unblock,
sequence gap, mismatched-sequence ACK, stale fence, duplicate `commandId`.

- ★ Every one needs its allow-side twin in the same test: a well-formed extension applies, an
  in-sequence command is accepted, a live-fence command is applied. **A denial suite with no accept
  case cannot distinguish "refused" from "nothing was delivered"** — which is precisely the bug this
  ticket exists to fix, and it would be embarrassing to reproduce it in the tests that close it.

### (e) — Close `E3-F035` and make the docstring true. **S.**

Correct the `listPendingControlCommands` docstring to describe what the renew path actually does, and
add the method to whatever guard would have caught a zero-caller repository method. If no such guard
exists at the repository layer, say so in the result doc rather than implying one.

- ★ The finding is closed by the method **acquiring a caller**, not by editing prose. If slices
  (b)/(c) are descoped, `E3-F035` stays open and must be repointed, not quietly marked resolved.

### (f) — Deliver `drain`, or state on the record that it is not delivered. **S.**

`drain` is persistable and undelivered (§1.4).

> ★★ **CORRECTION (Codex review).** The earlier wording — "either include it in the projection or
> record that it remains operator-side only" — would let **inclusion count as delivery**. It does not.
> This ticket's whole finding is that a command can be persisted, surfaced, and still never acted on;
> an acceptance clause satisfied by putting `drain` in a JSON array would re-file the same bug one
> layer up.
>
> **Revised:** `drain` counts as delivered only when the worker-side handler exists and is tested —
> the daemon observes the command, applies drain semantics (stop accepting new leases, finish the
> current attempt), and ACKs. Either build that, or state in the result doc that `drain` remains
> **operator-side only and undelivered**. Those are the only two honest outcomes; "it is in the
> projection" is not one of them.

---

## 4. Fail-closed clauses and the control that proves each can fire

| Clause | Where it fires | ★ Positive control |
|---|---|---|
| Over-budget command list → extension emitted WITH an overflow marker, never silently omitted | (b) projection | an under-budget list is emitted with no marker, same test — and ★ the two must be distinguishable from `extensions: []` |
| Overflow marker itself cannot fit → renew fails with a protocol error | (b) | a fitting marker returns a normal renewal |
| Leading command alone exceeds the budget → marker carries `oversizedLeading` + its ids; a `rejected` ACK clears it | (b)/(c) | ★ the command BEHIND it is delivered on the next renewal — a test asserting only that the marker appears would pass against the stalling design |
| ACK echoing a mismatched `commandSeq` → rejected, command stays pending | (c) ACK predicate | a matching-sequence ACK succeeds and stops redelivery, same test |
| Malformed extension → delivery fault, not "no commands" | (c)/(d) worker | a well-formed extension applies |
| Sequence gap → `gap`, command not applied | (d) `decideControlReceiverV1` | an in-sequence command is `accept`ed |
| Stale fence → refused | (d) | a live-fence command is applied |
| Duplicate `commandId` → `replay`, applied once | (d) | a distinct command is applied separately |
| Unknown namespace → ignored, run completes | (c) `critical:false` | a worker that understands it applies the command |
| No pending commands → `extensions: []` | (b) | with one pending, the extension appears |

Every guard mutation-tested; survivors are questions, not verdicts, and the harness is checked for
having run the right thing before a kill is believed.

---

## 5. Guards and gates

- `job-fence-surface.contract.test.ts` — its name inventory at `:114` currently records
  `listPendingControlCommands`. Slices (b)/(e) change the surface around it; re-run it.
- `check:frozen-worker-protocol-v1` must stay OK with **zero** `packages/worker-protocol` edits.
  If any slice appears to need one, that is a design error — go back to D1.
- `check-finding-ownership.mjs` — `E3-F035` ships with its ownership entry in the same commit.
- `check-guard-inventory.mjs` — any new guard needs a CI invocation.
- Migration: **none expected.** No schema change is implied; the `checkpoint` CHECK gap is SVC-004's.
  If a slice does generate one, re-pin the slot at generation time (tip is `0271`, next free `0272`).

---

## 6. Deconfliction and sequencing

### 6.1 The Lane B do-not-touch clause does not apply — reasoning recorded so it is not re-litigated

BRW-004's design raised `HANDOFF-lane-b-browser-service.md:173-176` (do not touch `job-leasing.ts`,
`worker-control.ts`, `execution-secret-*.ts` "without coordinating") as a possible blocker. It is
not, for three independent reasons:

1. The clause says **"without coordinating"** — it is a coordination requirement, not a prohibition.
2. Its stated premise — *"Lane A is actively editing all of them for DAT-008 slices 5–7"* — is
   **spent**: `DAT-008-slice-5-result.md` and `DAT-008-slice-7-result.md` are both on disk.
3. The clause constrains **Lane B** from reaching into Lane A's files. **JOB-015 is homed in E3,
   which is Lane A**, so it does not cross the boundary the clause guards.

### 6.2 ★★ But there IS live contention, and it gates the BUILD, not the filing

`server/src/services/job-leasing.ts` was last touched **today** by CLI-008 Unit B (`393f7a251`), and
Track A is in that neighbourhood now building CLI-008 Unit D. Slices (b) and (c) sit in the same
lease-envelope/renew neighbourhood.

**JOB-015 must not be BUILT concurrently with Track A's CLI-008 work in those files.** Filing the
charter is free and has no contention; implementation waits until Track A lands. Confirm the state of
CLI-008 Units C/D before scheduling slice (b).

### 6.3 Consumers to notify when this lands

- **E8 / BRW-004** — its slices (c)–(e) are gated on this; its design names JOB-015 as the blocker.
- **E9 / SVC-001, SVC-004** — SVC-001's TTL workaround (§1.5) may become unnecessary; SVC-004 owns
  the `checkpoint` CHECK gap and would gain a delivery path for it.

---

## 7. Open questions — answer before slice (b)

1. **Is `command_seq` contiguous per lease in practice?** `decideControlReceiverV1` classifies `gap`
   against a contiguous `1..N`. The unique index enforces uniqueness and monotonicity; whether every
   writer allocates without holes is a separate question and slice (a) should measure it. A
   non-contiguous sequence makes every delivery a `gap` — a fail-closed dead lever, and exactly the
   defect class this ticket was raised by.
2. **Is 16,384 bytes enough?** A `runtimeDecisionResultV1` fits comfortably, but the bound is on the
   *whole* pending list. If a realistic worst case exceeds it, D1's rejected dedicated-operation
   option is the escalation path — not truncation.
3. **Should `graceful_stop` remain indistinguishable from `cancel`?** Today the worker cannot tell
   which it received (§1.4). The extension makes the distinction available for the first time;
   whether the worker should behave differently is a product question, not a delivery one.

---

## 8. Definition of done

- This design's SHA (`203853b3a`) recorded as the Start SHA in `JOB-015-result.md`.
- Every acceptance clause maps to a named executable artifact, or is explicitly deferred with its
  reason. §3 names one per slice; §4 names the control that proves each fail-closed lever can fire.
- Every guard mutation-tested; survivors fixed or documented as equivalent with the reason.
- The result doc states deferrals honestly, **including anything built but not wired** — and if
  slices (b)/(c) land without (f), it says `drain` is still undelivered.
- `E3-F035` is closed by the method acquiring a real caller, or repointed. Not silently resolved.
- CI watched to green. `ci-required` is the verdict; a pushed sha cannot be assumed to have one.
