# BRW-003b — Capture and the producer half — RESULT

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Status:** ✅ producer slice complete
**Design:** [`BRW-003b-design.md`](./BRW-003b-design.md) · **Index:** [`BRW-003-design.md`](./BRW-003-design.md)
**Start SHA:** `845754f3b` (the design commit) · **End SHA:** `c176efcfa`

| Commit | What |
|---|---|
| `845754f3b` | design — the seam, and why requiring the capability breaks every browser job |
| `27e685765` | video: the wrong order hangs the session |
| `d6bb0a53a` | trace capture, and a stale comment that taught the wrong invariant |
| `c176efcfa` | the sandbox could not have started a browser, and nothing said so |

---

## ★ What this ticket actually protects against

Not a missing file. **A hung worker.** Every other artifact in this system is produced by doing work
and then collecting it. Video is the opposite: Playwright writes it only when the context *closes*,
and `Artifact.saveAs` drains only via `reportFinished()`, which for a video runs **during**
`close()`. So the natural ordering — save everything, then close — does not lose the video. It
**deadlocks**: `saveAs` waits for a drain that only `close()` can start, and `close()` never runs
because we are awaiting `saveAs`.

The trace is the exact inverse. `tracing.flush()` is `abort()` plus an fs sync with **no zip**, so a
trace not stopped *before* close is discarded silently, without an error.

Two artifacts, one lifecycle, **opposite ordering constraints**, and both failure modes invisible:
one hangs, one loses bytes quietly. `finish()` is therefore three phases, and the phase boundaries
are the deliverable:

- **PHASE 1** — trace stop, then downloads. Everything that must precede `close()`.
- **PHASE 2** — `close()`, always, even after a PHASE 1 failure. This is what flushes video.
- **PHASE 3** — `video.saveAs()`. Only resolvable *because* close already ran.

## ★ The test that had to fail by HANGING

The design pinned this: if video ships, the ordering test is this ticket's **highest-value test** and
must **fail-first against the deadlocking order**, not merely pass against the correct one. A test
that passes against correct code proves nothing about the failure it exists to prevent.

So the fake models the real drain semantics rather than the happy path: a `videoReleased` latch that
**only `close()` releases**. Against the naive ordering that test does not fail with an assertion —
it **times out**, which is the production symptom reproduced inside the suite. Against the
three-phase ordering it passes.

## ★ Three false results caught in my own work

Recorded because each was a *method* failure, and the method is what carries to 003d.

1. **A FALSE SURVIVOR.** The `stopTracing` mutation cut at the inner `try {` of the block, so the
   mutant was not the mutant I meant to test. Re-cut with brace matching, it failed the two ordering
   tests — a real kill that the sloppy cut had reported as survival.
2. **A VACUOUS ASSERTION.** `expect(findIndex(...)).toBeLessThan(closeAt)` passes when `findIndex`
   returns `-1` — it passes hardest when the thing being ordered **is not there at all**. Fixed by
   asserting `> -1` first. This is the ticket's own failure class turned inward.
3. **LOOP-GENERATED TESTS SHRINK SILENTLY.** Deleting a key from a deny-set deleted its test along
   with it, so the suite stayed green by having less to check. Fixed with an explicit core-key
   assertion outside the loop.

## ★ The deployment gap: three layers, none of them visible to CI

`playwright-driver.ts` imports `playwright` at module scope, and the runner is **staged** into a
sandbox — the host writes the runner plus `session.json`, then execs it there.

1. `playwright` was a **devDependency**. A devDependency does not travel. Every test in this repo
   runs inside the monorepo where it *is* installed, so **nothing here could have caught it.**
2. The E2B image had **no Playwright and no Chromium**. BRW-002's browser clauses are green because
   the *GitHub runner* installs Chromium — so every clause proven in CI said nothing at all about a
   real sandbox.
3. The build guard asserted `claude` and `codex` resolve, **and nothing else** — the exact shape of
   assertion that would have caught this, absent for the one thing it did not cover.

The image now proves **both** that the module resolves **and** that a browser binary exists on disk:
`require` alone passes with no browser installed; an `executablePath()` string alone passes without
the file being there. Both, or the build fails.

### The version-drift guard is the part worth keeping

Pinning Playwright in the image creates **two pins for one invariant** (image and lockfile). That
matters here more than usual, because every lifecycle fact above is version-specific. If the pins
drift, the code is built against one set of semantics and **run** against another — and the failure
is not a crash, it is a silently discarded trace or a hung session. A test compares the Dockerfile
pin against the version this repo actually resolves, and refuses a range.

## Mutation testing

| Mutant | Result |
|---|---|
| `stopTracing` call removed | killed — 2 ordering tests |
| video `saveAs` moved before `close()` | killed — the ordering test **times out** |
| PHASE 2 `close()` skipped after a PHASE 1 failure | killed |
| image pin drifts from the lockfile | killed — 1 test |
| module installed but no browser binary | killed — 1 test |
| build assertion removed | killed — 1 test |

No false kills: each was re-cut after checking that the failing set was the *signature* of the
mutation rather than collateral — the lesson from 003a, where a missing import produced three
unrelated failures and looked like a kill.

## Acceptance — what 003b discharges, and what it does NOT

Bound to the index's whole-acceptance table, so the union stays checkable.

| Clause | 003b | Note |
|---|---|---|
| Outcome: trace | ✅ | `recordTrace` was ignored by the guest **entirely** before this |
| Outcome: video | ✅ | ships; the deadlock is a guarded invariant, not a comment |
| Outcome: downloads | ✅ | BRW-002 confined them; PHASE 1 exports them |
| Outcome: screenshots / DOM snapshots | ✅ producer side | the *refuse-at-grant* half is 003d |
| Deployment prerequisite | ✅ | image + runtime dep + drift guard |
| Stream metadata, bounding, redaction, ordering | ➜ **003d** | server-side; see below |
| Retention | ➜ **003c** | blocked on Lane A's `isSweepEligible` edit |

**Stated plainly: the four pipeline clauses are NOT discharged here.** They moved to 003d when 003b
hit the same scope gate that split BRW-003 — producer risk is *lifecycle*, pipeline risk is
*vacuity*, and two risks that different in kind do not belong in one review.

## Verification

- 90 tests green in `packages/browser-runtime`, 17 skipped (all platform-gated), 7 files; build clean
- `check-test-inventory.mjs` OK — 2603 files
- Pushed `c176efcfa`

**CI caveat, stated rather than assumed:** I have not observed a completed verdict on `c176efcfa`
itself. The three preceding runs were **cancelled** by Lane A's push rate, and the most recent
*completed* success on this branch is `ec778c4df`, which predates this work. These commits are
ancestors of the tip and ride the tip's run, but until a run completes on a SHA containing them,
this slice is **implemented and locally verified, not CI-confirmed**.

## Carried to 003d

1. **Canary redaction has no INPUT.** Lane A's `4379a2c53` made `redactionCanaries` required and
   found a live site omitting it — but it still passes `[]`, because `createFenceAwareEgressProxy`
   (the only path that resolves a secret value) has zero production callers. So 003d's redaction must
   be **structural** — strip URL query and fragment before emit — not canary-based. Designing it onto
   the canary path would ride a mechanism that cannot fire.
2. **The false claim of enforcement** in `check-artifact-commit-vectors.mjs:11-13` sits directly on
   003d's "large download" case and is fixed there.
3. **`GOVERNED_EFFECT_OPS` / `CLEANUP_DENIAL_LABEL` have no parity guard** — an operation omitted
   from either is silently exempt from post-fence withdrawal and cleanup denial, suite green.
