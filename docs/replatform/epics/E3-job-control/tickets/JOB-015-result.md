# JOB-015 — General control-command delivery to a running worker — RESULT

**Epic:** E3 · **Lane:** A
**Design Start SHA:** `203853b3a` (`JOB-015-design.md`) · **Build Start SHA:** `410da858d`
**Status:** slices **(a)–(f)** built — the **general delivery channel**, from a queued
`job_control_commands` row to an applier on a running worker, plus the ACK that clears it.

**★★★ WHAT IS AND IS NOT DELIVERED, IN THE HEADER, BECAUSE A RESULT DOC FREEZES.**
No control command travels this channel end to end from a PRODUCTION-queued row today.

- **`drain` — applier composed, NO PRODUCER.** Nothing in the server queues a `drain`.
  The two production insert sites into `job_control_commands` are `requestCancellation`
  (which hardcodes `commandKind: "cancel"` in both the wire body and the insert values)
  and `queueGovernedControlCommand` (typed to the two result kinds). The delivery half —
  projection, worker read, classifier, `pollLoop.stopLeasing()`, ACK — is real, wired,
  and tested; every `drain` any test exercises is a row the test inserted itself.
- **`product_approval_result` / `runtime_decision_result` — PRODUCER, no applier.** They
  are queued by JOB-011 for real, reach the worker, and find no handler.

So the channel is proven in both directions and matched at neither end by the same kind.
An earlier revision of this document said "`drain` is DELIVERED end to end" in this header
and in §2(f). **That was false**, and it was false in the one place a false claim survives
longest. Both halves of the gap now live in §5 with the other honest ones.

---

## 0. What was true before, in one paragraph

There was exactly **one** delivery path from a queued `job_control_commands` row to a
running worker, it carried a **boolean**, and it did not generalise. `renewLease`
(`packages/db/src/repositories/tenant/job-control.ts`) ran an inline
`SELECT reason … WHERE command_kind IN ('cancel','graceful_stop') AND ack_status IS NULL
… LIMIT 1`, collapsed it to `cancelRequested: Boolean(pendingCancel)`, and — on the very
next line — hardcoded `extensions: []`. Of the five kinds the schema CHECK admits, three
had live producers and no reader anywhere: `drain`, `product_approval_result`,
`runtime_decision_result`. The complete read that would have fixed it already existed as
`listPendingControlCommands`, with **zero production callers** and a docstring asserting
that "the poll/renew path surfaces" it (**E3-F035**).

---

## 1. Measured, at the build Start SHA — not carried over from the design

| Claim | Measured |
|---|---|
| non-definition references to `listPendingControlCommands` | **1** — the NAME, as a string, in `job-fence-surface.contract.test.ts`'s inventory list |
| production callers of `decideControlReceiverV1` | **0** |
| `commandKind` in `packages/worker-daemon/src` | **0** |
| a worker→server control-ACK client method | **absent.** `ControlPlaneClient` had no `controlAck`; the server route `/api/worker-control/control-acks` existed with no caller on the worker — the mirror image of the read with no caller on the server |
| `ackControlCommand`'s WHERE clause | `(organizationId, leaseId, commandId)` **only**. The frozen `commandSeq` the worker echoes was accepted, returned in the response, and discarded |
| production writers of a `drain` command | **0.** Exhaustive: two insert sites into `job_control_commands`, both in `job-control.ts` — `requestCancellation` (hardcodes `"cancel"`) and `queueGovernedControlCommand` (typed to the two result kinds). The literal `"drain"` appears three times in non-test `server/src` + `packages/db/src` TypeScript: a type-union member (`job-control.ts:680`), a metric label (`job-leasing.ts:736`), and a comment saying no worker-fleet drain seam exists (`job-operations.ts:292`) |
| is `command_seq` contiguous per lease? (design open question 1) | **YES.** Both writers allocate `COALESCE(MAX(command_seq),0)+1` under the lease lock (`requestCancellation`, `queueGovernedControlCommand`). Pinned at embedded Postgres by a test that calls **both real writers** on one lease and asserts each writer's OWN returned `commandSeq` (`1`, then `2`) plus the stored `[[1,"runtime_decision_result"],[2,"cancel"]]`. Mutating either allocation to `MAX+2` reds it. This matters: a non-contiguous sequence would make every worker-side classification a `gap` — a fail-closed dead lever |

---

## 2. What shipped, by slice

### (a) The pin — a test that was RED against the defect

- `server/src/__tests__/job-015-control-delivery-pin.test.ts` — three source-text
  assertions (a method with no callers cannot be pinned behaviourally; a mock-based test
  would have to construct the caller in order to observe it, which is circular).
- `server/src/__tests__/job-control-commands.integration.test.ts` → *"JOB-015
  control-command delivery on the lease-renew response"* — six tests at embedded Postgres.

**Verified RED, then restored.** Reverting the two production files to the pre-JOB-015
text failed 3/8 of the pin file; reverting `extensions: input.projectControlExtensions(…)`
to `extensions: []` failed 5/12 of the integration file, including *"★ THE PIN"*.

### (b) The server-side projection — `server/src/services/control-command-projection.ts`

Pure, and it lives on the **server** because `packages/db` deliberately has no
`@armyofagents/worker-protocol` dependency (`schema/services.ts:37-39`). `renewLease`
takes the projector as a **required** injected callback — the same topology
`commitArtifactVersion` already uses for the frozen prefix helper. Required rather than
optional is the fail-closed choice: a future caller cannot silently reintroduce
`extensions: []`, because the type checker asks for the projector.

- Namespace `dev.aoa.job/control-v1`, `schemaVersion: 1`, **`critical: false`**.
- **Never omitted.** An omitted extension is byte-identical to `extensions: []`, so
  omission cannot be distinguished from "nothing queued" — this ticket's own defect, one
  layer up. Anything pending ⇒ an extension is emitted.
- Over budget ⇒ as many commands as fit **plus `truncated: true` and the total
  `pendingCount`**. Over the count cap (16) ⇒ likewise.
- **Oversized LEADING command ⇒ `oversizedLeading: {commandId, commandSeq}`**, which the
  worker ACKs `rejected` / `oversized_for_renew_channel` (a frozen `CONTROL_ACK_STATUSES`
  value — no wire change). Without this the projection returns the same marker forever:
  nothing to apply, nothing to ACK, no terminal (the E7-F010 shape).
- Marker itself does not fit ⇒ **throws**, so the renew fails loudly rather than returning
  a 200 whose body reads as "no commands pending".
- **Not sibling-blind.** `pointerFitsExtension` measures ONE value and is correct only
  because the job envelope carries a single extension. This projector is handed the
  extensions already on the envelope and probes the **union**, so the combined
  ≤65,536-byte budget and the ≤16-extension count bind the moment a second lease-envelope
  extension lands.
- **Admissibility is the real refiner, not a byte estimate.** The fit test runs the frozen
  `addWireExtensionArrayIssues`, so "fits" means "the frozen envelope will accept it" —
  catching the structural bounds a byte count cannot see (≤8 container levels, ≤128 items,
  ≤64 keys). The stored `command` jsonb is unbounded in DEPTH as well as bytes; a
  depth-overflowing command now takes the same terminal as a byte-overflowing one instead
  of throwing out of `leaseRenewOperationResponseV1Schema.parse` after the transaction.

`renewLease` now sources **both** halves from `repository.listPendingControlCommands(...)`
— the boolean (identical value; the first un-ACKed `cancel`/`graceful_stop` in sequence
order is exactly what the narrower query returned) and the extension. The inline duplicate
query is gone.

### (c) The worker-side consumer

- `packages/worker-daemon/src/lease/control-commands.ts` — reader + classifier.
  `decideControlReceiverV1` gets its **first production caller**.
- `packages/worker-daemon/src/lease/control-ack.ts` + `controlAck` on
  `ControlPlaneClient` — the ACK upload the daemon never had.
- `lease-renewal.ts` — `RenewAttempt.renewed` carries the parsed delivery; the driver
  applies, then ACKs exactly what it applied.
- **The D4 correction, server-side:** `ackControlCommand` now matches on the echoed
  `commandSeq`. A mismatch matches zero rows, `applied` is false, `ack_status` stays NULL,
  and the command is redelivered.

**`acceptedThroughSeq` is seeded, and the reason is load-bearing.** The frozen classifier
specifies a PUSH receiver where `gap` means loss in transit. This is a PULL channel: every
renewal returns the complete un-ACKed set in sequence order, so a sequence *below* the
lowest delivered one is not lost, it is ACKed. The receiver seeds from
`firstDelivered − 1` on the first payload for a lease; without that, a worker joining
mid-lease would classify its first real command `gap` and refuse it forever. The arm still
means something afterwards — it fires on a sequence the worker never observed that is not
the next one, i.e. a genuine hole in the per-lease allocation (§1 measures that there is
none today, so it is a guard against a future writer, and it is mutation-tested, not
assumed). The local counter tracks **observed**-through, not applied-through, so a command
the worker could not apply does not make every later command look like a gap.

### (c2) ★★★ The ACK pass runs AFTER the next renewal is armed — a slow control plane is not a lease loss

Found by review, and it was a real defect, not a style point. `applyControlDelivery` was
awaited **before** `reschedule(state)`. Each applied or oversized command performs a
*sequential awaited* `sendControlAck`; the frozen `control_command` operation descriptor
sets `timeoutMs: 15_000`, and `CONTROL_EXTENSION_MAX_COMMANDS = 16` ride one delivery. That
is **240 s** of worst-case blocking before the next renewal could even be scheduled, against
a 300 s default lease renewing at `leadFraction 0.5` — roughly **150 s** of headroom. About
eleven *slow* (not failed) ACKs would push the reschedule past expiry and lose a **healthy**
lease.

It also contradicted the code's own stated contract. `sendControlAck`'s docstring said a
failed ACK "is a DELAY, never a lost command — which is why it may be, and is, treated as
best-effort by the renewal driver instead of being allowed to kill a healthy run." That was
true for a *failed* ACK and false for a *slow* one, and the difference lived entirely in
where the driver called it.

Fixed by arming first: `reschedule(state)` now runs before the apply pass. The timer fires
off `expiresAtMs`, not off "now", so arming it earlier schedules the identical instant and
costs nothing. `control-ack.ts`'s docstring now names the placement it depends on, so
inverting the order makes the comment visibly false.

**The cost, taken deliberately:** the renewal timer can now fire mid-pass. Two concurrent
passes share `state.controlMemory`, and the second would see the first's commands still
un-marked and apply them twice — so a pass in flight makes the next one skip
(`state.controlApplying`). Skipping ACKs nothing, so the rows stay pending and the pass
after it redelivers them: the same fail-safe direction as every other refusal here.

**Why no test caught it, and what does now.** The fake control plane answered every ACK
synchronously, so latency was unrepresentable and the ordering was invisible to all ten
existing driver tests — they pass with the call on either side. The fake gained a
`setControlAckGate` knob plus `controlAckAttempts()` (counted *before* the gate, so an
in-flight ACK is observable). The test holds one ACK open and asserts the next renewal is
already armed while it hangs, with a `★ POSITIVE CONTROL` that the ACK still lands once
released — otherwise "the timer exists" would pass with the ACK dropped entirely.

### (d) The fail-closed cases

Every clause has its **allow-side twin in the same `describe`** — a denial suite with no
accept case cannot distinguish "refused" from "nothing was delivered", which is exactly the
bug this ticket closes.

| Clause | Positive control |
|---|---|
| over budget → extension emitted WITH a marker | an under-budget list carries no marker; and the three states (`[]`, complete, truncated) are asserted to be **three distinct byte strings** |
| marker cannot fit → throws | a fitting marker returns normally |
| oversized leading → `oversizedLeading` + a `rejected` ACK | ★ **the command BEHIND it is delivered on the next renewal** — a test asserting only the marker would pass against the stalling design |
| malformed extension → counted `control_command{outcome="malformed"}`, nothing applied, nothing ACKed — never "no commands" | a well-formed extension on the same path renews and applies |
| sequence gap → not applied | the next contiguous sequence is accepted |
| stale fence → not applied | the same command on the live fence is applied |
| duplicate `commandId` → replay, applied once | a distinct id alongside a known one is accepted separately |
| changed body under a known id → conflict, never applied | same |
| mismatched-`commandSeq` ACK → rejected, command stays pending | ★ the matching-sequence ACK succeeds **in the same test** — otherwise a predicate that rejected everything would look like working validation |
| unknown namespace → ignored, run completes | a worker that understands it applies the command |
| nothing pending → `extensions: []` | with one pending, the extension appears |

### (e) E3-F035 — closed by the method acquiring a caller

Not by editing prose. `findings.md` flipped to `resolved`; the manifest entry deleted in
the same commit; the docstring rewritten to describe what the renew path now actually does
(and to say that the POLL path still deliberately does not — poll reaches *idle* workers,
a control command is addressed to a worker already holding the lease).

`renewLease` calls the **public interface method** rather than a shared private helper.
That is deliberate: a private helper would have removed the query duplication and left the
finding open.

**No repository-layer zero-caller guard exists**, at the repository layer or anywhere else.
The design's slice (e) asked for one *or* for this sentence. This is the sentence: nothing
in `scripts/` walks `packages/db/src/repositories/**` for exported methods with no
non-test reference, and building one is not this ticket's blast radius (it would red on
every deliberately-ahead-of-its-consumer repository method across E2–E11). The nearest
existing guard, `check-gate-clause-wiring.mjs`, tracks named symbols from
`gate-clause-wiring.json`; `listPendingControlCommands` was not among them and still is
not, because it is no longer unwired.

### (f) `drain` — the APPLIER, composed and reached (there is no producer; see §5)

**Scope, precisely:** this slice makes a delivered `drain` do something. It does not make
anything queue one. A `drain` row inserted by hand — or by a future producer — is
projected, read, classified, applied and ACKed; nothing in the server writes that row.

`dispatch-runtime.ts` composes `drain: () => pollLoop.stopLeasing()`. The handler port is
a **thunk**, and it has to be: `pollLoop` is constructed *after* the driver (the driver IS
its supervisor seam), so a handler passed by value would capture `undefined` and every
delivered drain would be a silent no-op — a composition-root port that is a no-op for
everything built earlier. `stopLeasing()` is the existing drain semantic, not a second copy
of it: the loop stops taking offers and `drainInFlight()` finishes the attempt already
running, exactly as an operator drain and a rolling shutdown do.

**The composed line is now covered by a CALL, not by the type checker.** Every behavioural
test in `lease-renewal-control-commands.test.ts` injects its own fake `controlHandlers`, so
`controlHandlers` had exactly three references — the declaration (`lease-renewal.ts:391`),
the read (`:600`) and this composition (`dispatch-runtime.ts:241`) — and not one of them
ran the composed thunk. `dispatch-runtime.test.ts` now records `stopLeasing` on the poll
sentinel, invokes the captured thunk, and asserts the call arrives. **Mutation-verified:
deleting `pollLoop.stopLeasing()` from the handler body and leaving the log line
type-checks CLEAN (`tsc --noEmit` exits 0) and reds only the new test** — which is the
whole point, because "verified by the type checker only" is the composition-root-no-op
class this thunk exists to avoid. Two siblings pin what the thunk depends on: `makeDriver`
runs before `makePollLoop` (the late binding is load-bearing), and `result` is asserted
ABSENT, so composing an applier for the governance kinds reds this file and forces its
author to re-decide whether §5 is still true.

---

## 3. Mutation results — 15 mutants, 15 killed, every restore verified

| # | Mutation | Result |
|---|---|---|
| M1 | delete the ACK after a successful apply | 3/9 driver tests RED |
| M2 | apply `drain` even with no handler composed | 1/9 RED (the `unhandled` control) |
| M3 | malformed extension → `renewed` with `control: null` and no fault flag | 1/9 RED |
| M4 | drop the `oversizedLeading` terminal | 1/9 RED |
| P1 | OMIT the extension when the queue overflows | 3/22 RED |
| P2 | drop the sibling union from the fit probe (make it sibling-blind) | 1/22 RED |
| P3 | never set `truncated` | 4/22 RED |
| P4 | marker-cannot-fit returns `[]` instead of throwing | 1/22 RED |
| I1 | restore `extensions: []` in the renew mutator | 5/12 integration RED |
| I2 | drop `eq(commandSeq)` from the ACK WHERE clause | 1/12 integration RED |
| I3 | drop the frozen `nonce` from `requestCancellation`'s inline body (producer drift) | 1/12 integration RED |
| M3b | fold the malformed-delivery fault into silence (`controlFault = false`) | 1/9 driver RED |
| **V2** | `requestCancellation` allocates `MAX(command_seq)+2` (a hole) | 5/12 integration RED, **including the contiguity test on the second writer's OWN returned sequence** (`expected 3 to be 2`) |
| **V3** | delete `pollLoop.stopLeasing()` from the composed `drain` handler, keep the log | 1/26 `dispatch-runtime` RED. **`tsc --noEmit -p packages/worker-daemon` exits 0** — the type checker does not see it, which is exactly why the assertion had to be a call |
| **V4** | move `reschedule(state)` back BEHIND the apply/ACK pass | 1/11 driver RED (the gated-ACK test), **and its `★ POSITIVE CONTROL` sibling stays green** — proving the gate, not the ordering, is what makes the discriminating test discriminating |

Restore verified green after every one (V2 re-run at embedded Postgres: 12/12; V3 26/26;
V4 11/11).

**I3 closes a gap the design did not name.** The worker re-validates every delivered
command against the frozen `controlCommandV1Schema` — the extension container bounds size
and structure, not fields (`value` is `z.unknown()` on the frozen envelope), so an
unvalidated body would be a control-plane-shaped object trusted on the strength of its
namespace. But `requestCancellation` builds its `command` jsonb **inline and never
`.parse`s it**. A drift there would make every real cancel arrive as a delivery FAULT, and
nothing else in the tree would notice: the boolean floor would keep cancelling while the
extension quietly failed to read. The integration test now parses the delivered body
against the frozen schema, and dropping one required field from the producer reds it.

---

## 4. Guards and gates

- `check:frozen-worker-protocol-v1` — **zero** `packages/worker-protocol` edits.
  `git diff --stat HEAD -- packages/worker-protocol` is empty. The whole design turns on
  the frozen container already being adequate, and it was.
- `job-fence-surface.contract.test.ts` — **its parser needed widening and that is worth
  flagging.** `createJobControlRepository` now binds its literal to `const repository` so
  `renewLease` can call the public method; the parser accepted only `return { … }` and
  threw *"no returned object literal"*, failing the whole suite to collect. Widened
  narrowly (a `const` in the same body, initializer an object literal, resolved by name);
  an indirection it cannot follow still throws, which is the fail-closed direction — a
  surface the parser cannot see must never read as an empty one.
- `check-finding-ownership.mjs` — OK, 32 open findings; E3-F035's entry deleted in this
  commit. The `--write` rewrite reorders keys; verified that the ONLY semantic change is
  that deletion (no other key added, removed, or value-changed).
- `check-test-inventory.mjs` — `packages/worker-daemon` is **pinned**, bumped 157→159.
  The floors `--write` also wanted to raise (adapter-manager, browser-runtime, db, server)
  were left alone: they lag the tree for reasons that are not this PR's, and raising a
  floor changes what a future deletion is allowed to do.
- `check-guard-inventory.mjs` — no new script guard, nothing to register.
- `gate-clause-wiring.json` — measured: it names none of `listPendingControlCommands`,
  `renewLease`, or `ackControlCommand`, so composing a caller cannot trip
  `unwired_but_now_has_caller`.
- **Metrics (E7-F010).** `control_command{outcome}` is a new counter and `outcome` is a
  CLOSED allow-list that THROWS on an unregistered value — on the happy path as readily as
  on a failure. The seven new values are registered in the same commit. The derived
  structures were enumerated first: `CLOSED_LABEL_VALUES` in
  `packages/worker-daemon/src/metrics/metrics.ts` and its re-export from that package's
  `index.ts` are the only two in the repo; no docs table or JSON manifest mirrors it.
- Migration: **none.** No schema change; the `checkpoint` CHECK gap remains SVC-004's.

---

## 5. What is NOT delivered, stated plainly

### ★★★ `drain` has NO PRODUCER — nothing in the server queues one

This is the fact that decides the headline, so it goes first. The applier is composed
(§2(f)) and the delivery path is real and tested, but **no production code path creates a
`drain` control command**, and therefore no `drain` has ever travelled this channel outside
a test that inserted the row itself.

Measured, not inferred. There are exactly **two** `insert(jobControlCommands)` sites in the
tree, both in `packages/db/src/repositories/tenant/job-control.ts`:

| Site | Kind it can write |
|---|---|
| `requestCancellation` (`:3477`) | `"cancel"` — hardcoded in BOTH the wire body and the insert values |
| `queueGovernedControlCommand` (`:3897`) | `commandKind` typed `"product_approval_result" \| "runtime_decision_result"` |

The literal `"drain"` occurs three times in non-test `server/src` + `packages/db/src`
TypeScript, and none is a writer: a member of `JobControlCommandKind`
(`job-control.ts:680`), a metric label (`job-leasing.ts:736`, `outcome:"drain"`), and a
comment recording that no worker-fleet drain seam exists (`job-operations.ts:292`). The
integration suite says so at its own fixture (`job-control-commands.integration.test.ts`,
the `queueRaw` docstring): every `drain` it exercises is a raw INSERT the test wrote.

What that does and does not mean:

- It does **not** weaken the delivery work. `drain` was chosen precisely because it is the
  one admitted kind the pre-JOB-015 boolean channel could never carry, so it is the
  sharpest available probe of the general channel — and it is the kind whose applier
  already existed (`stopLeasing`), so the probe needed no new semantics invented for it.
- It does mean **"delivered end to end" is not available to this ticket for any kind.**
  The two kinds with real producers have no applier; the kind with an applier has no
  producer. The channel is proven in both directions; no single command completes the
  round trip in production yet.
- The producer, when someone wants operator-initiated fleet drain, is a **new server seam**
  (`job-operations.ts:292` is where its absence is already recorded). It is not in this
  ticket's blast radius and no ticket currently owns it. Anyone adding it inherits a
  delivery path that is already tested.

### The two governance result kinds reach the worker and are not applied

**`product_approval_result` and `runtime_decision_result` reach the worker and are not
applied.** They are read, validated against the frozen schema, classified, and then find
no handler: the daemon composes `drain` only. They are counted
`control_command{outcome="unhandled"}` and — deliberately — **not ACKed**, so the server
keeps `ack_status IS NULL` and redelivers them on the next renewal. ACKing an unapplied
command would clear the row forever and reproduce this ticket's own finding (persisted,
surfaced, never acted on) with a green test to hide it.

The applier is not this ticket's: **E8/BRW-004** owns the browser-side approval applier
(its slices (c)–(e) were gated on JOB-015 and can now proceed), and **E9/SVC-001** the
service-side one. `ControlCommandHandlers.result` is the port they compose against; the
seam and its tests exist, the composition does not.

`cancel` / `graceful_stop` are delivered on **both** channels (D2: the boolean stays
forever — it is the only signal a worker predating the extension understands). The
extension arm does not act on them: the boolean short-circuits first and ends the run. The
worker still cannot *distinguish* the two (design open question 3), which is a product
question, not a delivery one — the distinction is now available on the wire for the first
time.

### A deliberate deviation from D3, recorded rather than quietly taken

The design's D3 says an unreadable extension is "a delivery fault" and the worker "keeps
the run's existing posture". An earlier build of this made it a **lease loss**. That was
wrong and was changed before merge: the extension is `critical:false`, and the frozen
container's whole contract is that failing to understand a non-critical extension must not
break the run. A fatal reading would make it effectively critical — one bad server
projection would tear down every lease in the fleet — and it would contradict the
`critical:false` positive control two tests over. The shipped behaviour is D3 as written:
the renewal succeeds, nothing is applied, nothing is ACKed, and the fault gets its own
counter (`control_command{outcome="malformed"}`) plus a warn log. Loud, and distinguishable
from an empty queue, which is the property this ticket exists to create. Mutation-tested:
folding the fault into silence reds the test.

`checkpoint` remains unpersistable (the schema CHECK omits it). **SVC-004's**, unchanged.

---

## 6. Consumers to notify

- **E8/BRW-004** — unblocked for the delivery hop; still needs to compose
  `ControlCommandHandlers.result` to satisfy "denial/timeout fails closed" end to end.
- **E9/SVC-001** — its TTL→cancellation workaround (schema prose at
  `service_generations.ts:61-67`) is no longer forced; the schema comment there still says
  "a worker has no channel on which to receive a time bound at all", which is now stale.
  Left for SVC-001/SVC-004 to correct rather than edited from another epic's ticket.
- **SVC-004** — gains a delivery path for `checkpoint` once the CHECK admits it.
- **UNOWNED — a `drain` producer.** The applier is composed and the delivery path is
  tested, and nothing queues a `drain` (§5). Whoever wants operator-initiated fleet drain
  adds one server-side writer; `job-operations.ts:292` already records where its absence
  sits. No ticket owns this today, and this document is not filing one.
