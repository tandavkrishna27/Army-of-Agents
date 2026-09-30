# BRW-003 — Browser observation artifact pipeline — DESIGN INDEX

**Epic:** E8 · **Lane:** B (`C:\e8`)
**Terrain:** [`BRW-003-terrain.md`](./BRW-003-terrain.md) — **read its CORRECTIONS section**, which
supersedes three claims in its body.
**Decision:** [`DECISION-byte-egress-and-provider-topology.md`](../../../DECISION-byte-egress-and-provider-topology.md)
(Option D) **plus its §8 Lane B re-verification**.
**Adjacent:** [`DAT-009-slice-2-design.md`](../../E5-workspaces-secrets/tickets/DAT-009-slice-2-design.md)
— its §8 follow-up #2 is **003c**.

> **This ticket is delivered as three, in dependency order.** The `plan-eng-review` complexity gate
> triggered at ~15 surfaces plus a cross-lane edit, against a threshold of 8. The split lines are
> forced by real dependencies, not chosen for tidiness:
>
> - **003a is a STRUCTURAL change** the other two build on. Doing a structural and a behavioural
>   change in one ticket is the thing not to do — refactor first, then implement on the clean shape.
> - **003c is already blocked** on a Lane A edit, so it cannot ship with the rest regardless.
>
> Three pushes also buy the thing this branch runs on: **a red tip must be attributable to the last
> push.** One 15-surface push carrying a cross-lane edit is exactly where that attribution collapses.

---

## The three tickets

| | Scope | Blocked by | Ships |
|---|---|---|---|
| **003a** | Split `findCommitted`; second partial unique | nothing | **first** |
| **003b** | **PRODUCER**: the three-phase capture split, trace, video, sandbox Chromium | 003a's mutation tests — **cleared** | second |
| **003d** | **PIPELINE**: events + bounding + redaction, ordering + ordered read, export seam, parser limit, commit-vector ceiling | 003b | third |
| **003c** | Retention enforcement | **Lane A's `isSweepEligible` edit** + 003a | last |

### ★ 003b was sliced again — same gate, same reason

The scope check that caught BRW-003 catches 003b too: it reached ~12 surfaces across
`browser-runtime`, `server/src`, `packages/db`, a migration, the E2B image and the commit-vector
reference. Split on the obvious line — **producer vs pipeline**:

- **003b (producer)** is `packages/browser-runtime` + the E2B template. It is testable in the
  browser lane, needs no schema, and its central risk is a LIFECYCLE one (the video deadlock).
- **003d (pipeline)** is server + db: events, bounding, redaction, ordering, the ordered read.
  Its central risk is VACUITY (columns nothing reads), which is a different kind of review.

Two risks that different in kind do not belong in one review.

### ★ Two blockers, recorded as blockers rather than notes

1. **003c MUST NOT merge before Lane A's `isSweepEligible` edit lands.** `expired` is neither
   `committed` nor `quarantined`, so an expired row falls through to `no_object_key`, and
   `sweepRefusalIsActionable("no_object_key")` returns **`true`**
   (`artifact-orphan-sweep.ts:56-57`). Shipping expiry first turns **every successful expiry into a
   permanent actionable alarm** in Lane A's sweeper — an alarm generator wearing retention's name.
   Not forked: two definitions of "sweep eligible" is the drift class.
2. **003a's mutation tests GATE 003b.** The mutant that makes the immutability query *exclude*
   `expired` must be killed before anything builds on the split, or the re-commit hole reopens
   silently underneath the capture work.

---

## ★ The acceptance table stays whole

Three result docs are fine; three disconnected acceptance stories are not. Each sub-ticket names
which of BRW-003's original clauses it discharges, so **the union is checkable and nothing falls
between them.**

| Original clause | Discharged by | Note |
|---|---|---|
| Outcome: stream metadata | **003b** | as worker events over the frozen `event_upload` op |
| Outcome: screenshots | **003b** | |
| Outcome: DOM snapshots *where allowed* | **003b** | "allowed" refuses at **grant**, not only at commit |
| Outcome: trace | **003b** | `recordTrace` is currently ignored by the guest entirely |
| Outcome: video | **003b** — **SHIPS** | the naive ordering deadlocks; guarded by a fail-first test that the wrong order makes TIME OUT |
| Outcome: downloads | **003b** | BRW-002 already confines them; 003b exports them |
| Acceptance: payloads bounded | **003b** | per-event bound is frozen; the **aggregate** bound is the 100 KB parser cliff |
| Acceptance: retention explicit | **003c** | enforcer, not a recorded column |
| Acceptance: redaction explicit | **003b** | strip URL query + fragment before emit — a **decision** |
| Acceptance: order tied to event sequence | **003b** | commit-side link **and** the ordered read |
| Test: screenshot/trace hash | 003b | |
| Test: large download | 003b | commit-time, because `maxBytes` is not enforced at write |
| Test: retention | 003c | asserts bytes **deleted**, not a column set |
| Test: stale-fence | 003b | asserts what the control plane records; does **not** fake the triply-dormant quarantine leg |

---

## The rule all three are bound by

**The worker half of the event path has no production boot root.** `createSupervisor` and
`new DurableWorkerEventSink(` have **zero production callers**; `bootstrapWorkerDaemon`
(`worker-daemon.ts:356`) passes only `{env, proc}` and the file says *"it dispatches no work in
CORE."* Redaction is worse — a **verified no-op**, every site `deps.redactionCanaries ?? []`, with
`supervisor.ts:283` stating *"E4-D12 seeds the canaries; `[]` until then."*

**So every acceptance clause carries at least one SERVER-SIDE assertion.** The server half is live
(`app.ts:453`). A clause proven only worker-side is vacuously true today.

---

## Sub-ticket designs

- [`BRW-003a-design.md`](./BRW-003a-design.md) — the structural split
- [`BRW-003b-design.md`](./BRW-003b-design.md) — capture, events, ordering, seam
- [`BRW-003c-design.md`](./BRW-003c-design.md) — retention enforcement

## Still behind the Custodian

Byte movement itself stays behind the **E4-D02 STOP** — `OPTIONAL_PROVIDER_OPERATIONS` is frozen at
three values and `supportedOperations` is doubly pinned (enum + length cap). A **second** STOP covers
the grant-in/reference-out port change: the handoff §7 freezes the worker-daemon `SandboxProvider`
port too, so the decision record's §4.1 exemption ("not `worker-protocol`, so not a STOP") does not
hold. 003b designs the **seam** as a named, checkable interface so the ruling is verified against a
written contract rather than a buried assumption.
