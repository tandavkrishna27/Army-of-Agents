# TRACK-002 — Design: an execution census (existence is credited, execution is never asked)

**Status:** DESIGN. **Start SHA:** the commit that adds this file.
**Motivated by:** an audit of every defence this repo has against vacuous checks. Measured coverage
of ten known instances of the class: **one** is caught today (I8, by TRACK-001). Six are caught by
nothing.

---

## 1. The measured defect

**Nine test files, carrying 222 tests, are invoked by nothing.** Verified by comparing every
`*.test.mjs` under `scripts/` and `docker/` against every non-comment reference in
`.github/workflows/**` and `package.json`:

| File | tests | state when run by hand |
|---|---|---|
| `scripts/check-distributed-execution-foundation.test.mjs` | 141 | ★ **FAILS** |
| `scripts/check-d1-compose.test.mjs` | 38 | passes |
| `scripts/run-e3-perf-01.test.mjs` | 17 | long-running (>2 min) |
| `scripts/check-bundled-snapshot-inputs.test.mjs` | 12 | passes |
| `docker/d1/__tests__/ctl-allowlist.test.mjs` | 6 | passes |
| `docker/images/__tests__/image-startup-smoke.test.mjs` | 2 | skips (no Docker) |
| `scripts/lib/__tests__/collect-d1-evidence.test.mjs` | 2 | passes |
| `scripts/lib/__tests__/d1-compose-invariants.test.mjs` | 1 | passes |
| `scripts/verify-e3-perf-01-handoff.test.mjs` | 3 | one-off, declared dormant |

`check-test-inventory.mjs` counts all nine toward its pins. **Existence is credited; execution is
never asked.**

## ★ 2. What the red one contains, because it justifies the whole ticket

`check-distributed-execution-foundation.test.mjs:1009` fails with:

```
AssertionError [ERR_ASSERTION]: mutation did not remove additionalProperties:false
```

That is a **mutation test whose mutation is a no-op**. Its author explicitly guarded against
vacuity — the test asserts that its own mutation actually applied — and that guard is now firing.
It has been firing into the void, because nothing runs the file.

So the population is not dormant bookkeeping. It contains a check that has correctly detected it
cannot evaluate what it guards, and the detection reached nobody. That is the same finding Lane B
recorded in SVC-001 the same week.

## ★ 3. Why this design does NOT observe execution

The obvious design is a census that collects what each runner actually executed and diffs it
against disk. **Rejected, on three measured constraints:**

1. **Jobs are separate runners.** Aggregating would need artifact upload/download plus a consumer
   job — and `d1-merge-train.yml` is a **different workflow entirely**, so a census in `pr.yml`
   could never see what D1 ran.
2. **The heavy jobs skip on docs-only PRs** (the `changes` job gates them). A census consuming
   their artifacts would see nothing and would have to either fail every docs PR or pass vacuously
   — and "passes because it collected nothing" is the precise failure this ticket exists to stop.
3. `policy` has **no `changes` gate** (`pr.yml:124-127`): it runs on every non-draft PR. A static
   census there always runs, needs no artifacts, and has no cross-workflow blind spot.

**So: declaration + disk, evaluated in `policy`.** Same inversion that makes
`check-guard-inventory.mjs` work — verify the cheap direction against a human declaration rather
than infer the hard one.

## ★ 4. The limit of the `runs` direction, stated rather than claimed

An entry declared `runs` names the workflow and step. The check verifies that step exists and that
its `run:` block names the file **with comment lines stripped**.

**This is inference, and inference has failed six times in this programme.** The sixth was today:
I grepped for basenames to count this very population and got 8 instead of 9, because
`image-startup-smoke.test.mjs` is named in a *comment I wrote* explaining why it is not wired.

Stripping comments and scoping the match to a declared step narrows the surface enormously, but it
does not eliminate it: a comment *inside the declared step* mentioning the path would still fool
it. **That residual is named here, in the guard's source, and in the result doc. It is not
described as enforcement.**

The sound completion is TRACK-003: make CI **invoke from the manifest**, so `runs` is true by
construction. Deliberately not bundled here — it rewrites ~30 hand-listed `node --test` lines in a
file Lane B is actively editing, and this ticket's value does not depend on it.

## 5. Scope — two populations

- **`*.test.mjs`** (the `node --test` population, where all nine live): every file on disk must
  carry a manifest entry, `runs` (+ workflow/step) or `unrun` (+ reason).
- **vitest specs** (`*.test.ts(x)`): these run via `vitest.config.ts`'s `projects` array, which is a
  **hand-maintained list of 24**, not a glob. Measured today: 24 packages contain specs and all 24
  are listed — clean, but **undefended**. A new package with tests would silently run nothing. The
  census asserts every package containing a spec appears in `projects`.

## 6. Anti-vacuity

Zero discovered `*.test.mjs`, zero manifest entries, or zero vitest projects each **fail**. A census
that found nothing to census is a broken checker, not a clean tree — the house style already
established by twelve hand-written instances of this clause in `scripts/`.

## 7. Initial dispositions, with evidence

| File | Disposition |
|---|---|
| `check-d1-compose.test.mjs`, `check-bundled-snapshot-inputs.test.mjs`, `collect-d1-evidence.test.mjs`, `d1-compose-invariants.test.mjs`, `ctl-allowlist.test.mjs` | **wire** — all pass today, all are self-tests for guards already in `policy`/D1 |
| `image-startup-smoke.test.mjs` | **`unrun`** — its `--tmpfs /worker` lands root-owned over the Dockerfile's `chown node:node`; a defect in the test, not the image. Own ticket |
| `check-distributed-execution-foundation.test.mjs` | **`unrun` + a named follow-up** — 141 tests, currently RED on a no-op mutation helper. Wiring it red would block the shared branch; fixing it is its own ticket, not a rider on this one |
| `run-e3-perf-01.test.mjs`, `verify-e3-perf-01-handoff.test.mjs` | **`unrun`** — one-off E3 PERF-01 handoff record; already declared `dormant` in `guard-inventory.json` for the same reason |

**A reason is not an excuse.** Every `unrun` entry states what would have to change, so the manifest
reads as a debt register rather than a permanent waiver.

## 8. Tests

| Area | Test |
|---|---|
| Fail-first | run before the manifest exists → must name all nine |
| Undeclared file fails | fixture with a test file absent from the manifest |
| `unrun` without a reason fails | an empty reason is not a declaration |
| A declared-`runs` file whose step does not exist fails | catches a renamed/deleted step |
| Comment-only mention does NOT satisfy `runs` | ★ pins the exact defect that fooled me |
| vitest package missing from `projects` fails | the undefended second population |
| Anti-vacuity | empty tree / empty manifest / empty projects each fail |

## 9. Out of scope

- **TRACK-003** (invoke from the manifest) — §4.
- **Fixing the red 141-test file** — its own ticket; this one records it honestly.
- **The `tests/` and `ui/` vitest populations' internal include globs** — the census asserts project
  membership, not each project's own include pattern.
