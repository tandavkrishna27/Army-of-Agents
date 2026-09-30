# BRW-003d-3 — Stream metadata — DESIGN

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Start SHA:** the commit that adds this file
**Index:** [`BRW-003d-design.md`](./BRW-003d-design.md)
**Discharges:** BRW-003 outcome "stream metadata".
**Blocked by:** 003d-2 (redaction) — **landed**. See §4 for why that order was mandatory.

---

## §1 ★ Both obvious anchors are already true — neither may be used as proof

The two things a reviewer would naturally assert about this clause **pass today with zero production
change.** Writing them as tests would be textbook vacuity, so they are ruled out in the design rather
than discovered in review:

1. *"A `browser_observation` event lands in `job_events`."* Already true: it is a frozen variant
   (`events.ts:388`), already permitted by the live CHECK constraint (`job_events.ts:76`), and
   `job-events.ts` stores the **complete wire event** verbatim.
2. *"Browser metadata is ordered by sequence and reaches `CanaryAttemptEvent`."* Already true:
   `foldAttemptEvidence` sorts by `sequence` and emits `payload` with **no event-type filter**.

## §2 The real gap — the extension channel is inert END TO END

The frozen `browserObservationPayloadV1Schema` is `.strict()` with exactly three fields —
`artifactIds`, `url`, `title`. **There is nowhere in it for console lines or a network summary.**
Those can only ride the envelope's `extensions` channel (`events.ts:347`, part of `eventBaseShape`,
so every variant carries it).

And that channel is dead at both ends, measured:

- **No producer.** The single emit site hard-codes `extensions: [] as const`
  (`worker-daemon/src/supervisor/events.ts:129`), and `EventSequencer` has no `browserObservation()`
  at all — its producers are `attemptStarted`, `networkDenied`, `log`, `progress`, `usage`,
  `terminal`.
- **No reader.** `grep -c extensions` over `canary-terminal-projection.ts` and
  `canary-run-projector.ts` returns **0 / 0**. `payloadOf` reads `row.event.payload` only, and
  `CanaryAttemptEvent` has no field for extensions.

So metadata beyond three fields cannot be produced, and could not be read if it were. **That is the
clause.**

## §3 ★ Floats are REJECTED — a design constraint, not an implementation detail

`canonical-json.ts:71-72` throws `float is not allowed in the v1 subset`, and `extensions.ts` turns
that into a fail-closed validation issue. A network summary is float-native: durations, timings,
transfer rates.

**So the producer must quantise to integers before emit** — milliseconds as integers, bytes as
integers — and that must be a guarded behaviour, because the failure mode is a *rejected event*, not
a rounded number. Budgets are equally hard-edged: `maxCount: 16`, `valueMaxCanonicalBytes: 16_384`,
`combinedMaxCanonicalBytes: 65_536`, `valueMaxArrayItems: 128`, depth 8.

## §4 ★ Extensions ride INSIDE the projected payload — coverage by construction

This is the ticket's central design decision, and it exists because of the interaction the
completeness pass found: the frozen forbidden-key scan is **keys-only**
(`wire-safety.ts:43-58`), so a credential in an extension **value** is legal on the wire.

003d-2 put a value-scoped redactor on the event egress — but it sweeps `event.payload`. If extensions
arrive at `heartbeat_run_events` as a **sibling field**, they bypass it, and closing that would mean
remembering to add a second redaction call. Remembering is precisely the binding-gap class that has
already bitten this lane twice.

**So the projection folds extensions INTO the payload**, under a reserved key. They then ride the
field the redactor already sweeps, and coverage is a structural property rather than a promise. The
test that pins it asserts the critic's exact requirement: **a credential-shaped string in an
extension VALUE must not reach the wire.**

## §5 What is live, what is dormant — stated, not blurred

| Piece | Status |
|---|---|
| `foldAttemptEvidence` carries extensions | **LIVE** — a pure exported function in `server/src`, called by the projector; testable directly, and red today |
| extensions are redacted on egress | **LIVE** — composes with 003d-2 on the real route |
| float quantisation | **LIVE as a guard** — pure, and the rejection is real |
| `EventSequencer.browserObservation()` | **DORMANT** — `createSupervisor` has zero production callers |

The producer half is a **named forward guard and never a clause's proof**, per the standing rule.
The projection half is not dormant: the function runs today, and the assertion is that it drops data
it should carry.

## §6 Tests — each with its red state

| Case | Assertion | Red today |
|---|---|---|
| extensions survive the projection | a row whose stored event has extensions yields them downstream | `CanaryAttemptEvent` has no such field — **0 references** |
| ★ credential in an extension VALUE | does not reach the wire | keys-only scan permits it; no redaction reaches it |
| ordering preserved | extensions keep their event's sequence position | — |
| empty extensions | absent rather than an empty artefact | — |
| float rejected | a float-bearing extension is refused, loudly | `canonical-json` throws — assert the producer never offers one |
| quantisation | a duration becomes an integer before emit | no producer exists |
| budget | over-count / over-bytes refused before the wire | limits exist, nothing applies them here |
| **no vacuous anchor** | the two §1 statements are NOT used as proof | — |
