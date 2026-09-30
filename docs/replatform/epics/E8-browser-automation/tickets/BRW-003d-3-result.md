# BRW-003d-3 — Stream metadata — RESULT

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Status:** ✅ complete
**Design:** [`BRW-003d-3-design.md`](./BRW-003d-3-design.md) · **Index:** [`BRW-003d-design.md`](./BRW-003d-design.md)
**Start SHA:** `a6d032397` (design) · **End SHA:** `e0d10d1cb`
**Discharges:** BRW-003 outcome "stream metadata".

---

## 1. The clause was not "add events" — it was a channel dead at both ends

The frozen `browserObservationPayloadV1Schema` is `.strict()` with exactly three fields:
`artifactIds`, `url`, `title`. **Console lines and network summaries have nowhere in it to go.** They
can only ride the envelope's `extensions`, and that channel was inert at both ends, measured:

- **No producer** — the single emit site hard-coded `extensions: [] as const`, and `EventSequencer`
  had no `browserObservation()` at all.
- **No reader** — `grep -c extensions` over both projection files returned **0 / 0**. `payloadOf`
  reads `row.event.payload` only.

So metadata beyond three fields could not be produced, and could not be read if it were.

## 2. ★ Both obvious anchors were already true, and are named as vacuity rather than used

The two statements a reviewer would naturally assert **pass today with zero production change**:

1. *"a `browser_observation` lands in `job_events`"* — frozen variant, live CHECK constraint, and the
   ingest stores the complete wire event verbatim;
2. *"browser metadata is ordered by sequence and reaches `CanaryAttemptEvent`"* —
   `foldAttemptEvidence` already sorts by `sequence` and emits `payload` unfiltered.

Both are recorded **in the test file** as vacuity to avoid. Writing either would have produced a
green suite that proved nothing — this programme's signature defect, and the reason the design ruled
them out before any code was written.

## 3. ★ The central decision: extensions ride INSIDE the projected payload

The frozen forbidden-key scan is **keys-only** (`wire-safety.ts`), so a credential in an extension
**value** under an innocuous key is legal on the wire. 003d-2's redactor sweeps `event.payload`.

Extensions arriving as a **sibling** field would bypass it — and closing that would mean *remembering*
a second redaction call at every egress. Remembering is exactly the binding-gap class that has bitten
this lane twice already (003d-1's `inflate`, and the array-element leak in 003d-2).

Folding them into the payload makes coverage a **structural property** rather than a promise. The
mutant that carries them as a sibling is killed by the credential test.

## 4. Floats: the frozen constraint turns telemetry into dropped evidence

`canonical-json` rejects floats outright, and `workerEventV1Schema.parse` runs **before the wire** —
so an un-quantised duration does not round, it **loses the whole observation at emit time**. A
network summary is float-native.

`quantiseExtensionNumbers` makes the constraint survivable. It **refuses** NaN/Infinity rather than
coercing them: a producer bug silently turned into `0` is buried inside otherwise-plausible
telemetry, which is worse than a loud failure.

## 5. ★ Three of my own tests passed for the wrong reason

All three were caught by mutation or by probing — **none by reading**.

1. **The float test threw on SHAPE, not the float.** The fixture omitted the extension schema's
   required `schemaVersion` and `critical`, so the emit rejected the shape and the float was never
   exercised. It now asserts the *message* (`/float is not allowed/`), so a shape error cannot
   masquerade as it again.
2. **The credential test passed while extensions were dropped entirely** — a dropped channel also
   removes the secret. A benign marker now rides alongside, so the assertion requires the channel to
   be **carried** *and* the secret **removed**.
3. **An assertion that could never fail.** `not.toContain("extensions")` against a key named
   `wireExtensions` — lowercase `"extensions"` is not a substring of it. It would have passed against
   a projection that stamped an empty artefact onto every event. Now asserted through the exported
   `PROJECTED_WIRE_EXTENSIONS_KEY` so test and code cannot drift.

## 6. Mutation testing — 7 mutants, 7 killed

| Mutant | Result |
|---|---|
| extensions not carried at all | killed — 3 tests |
| ★ extensions carried as a SIBLING field (bypassing the redactor) | killed — 4 tests |
| an existing payload key is clobbered | killed |
| **empty extensions still add the key** | **survived → my assertion was wrong → fixed → killed** |
| `#emit` ignores the extensions argument | killed — 3 tests |
| quantiser does not round | killed — 2 tests |
| quantiser coerces a non-finite number to `0` | killed |

## 7. ★ A process failure worth recording: I destroyed my own uncommitted work

Mid-mutation I ran `git checkout -- <file>` to restore a mutant. The mutation harness had **already**
restored it from its in-memory original, so the checkout reverted past that to `HEAD` — which did not
contain the implementation, because I had only committed the design doc.

The implementation was lost and had to be re-applied. On 003d-1 I committed *before* mutating and
this could not have happened.

**Rule, now explicit: commit before mutating.** A mutation harness that restores from memory and a
VCS that restores from HEAD are two different notions of "restore", and mixing them silently
discards whatever sits between them.

## 8. Live vs dormant — stated, not blurred

| Piece | Status |
|---|---|
| `foldAttemptEvidence` carries extensions | **LIVE** — runs today, and was dropping data it should carry |
| extensions redacted on egress | **LIVE** — composes with 003d-2 |
| float quantisation | **LIVE guard** — pure, and the rejection is real |
| `EventSequencer.browserObservation()` | **DORMANT** — `createSupervisor` has zero production callers |

The producer half is a **named forward guard and never the clause's proof**. It is labelled as such
in the code *and* at the top of its test file. The clause is proven server-side, in the projection.

## 9. Verification

- 6 projection tests + 9 producer tests green
- **710 worker-daemon tests green** (124 files)
- **12,870 server tests green**; the 6 reds are the known pre-existing set
- typecheck clean in both packages
