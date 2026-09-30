# TRACK-002 Result — the execution census

**Status:** LANDED. **Start SHA:** `31a195f16` ([`TRACK-002-design.md`](./TRACK-002-design.md)).

---

## 1. What landed

`scripts/check-execution-census.mjs` (+ pure logic, + 13 unit tests) in the `policy` job. Every
`*.test.mjs` on disk must be declared `runs` (naming workflow + step, verified against that step's
`run:` block with comments stripped) or `unrun` (with a reason saying what would have to change).
Every package containing a vitest spec must appear in `vitest.config.ts`'s hand-maintained
`projects[]`.

**Five previously-unrun files are now wired, contributing 109 tests that CI had never executed**
(0 skipped): `check-d1-compose`, `d1-compose-invariants`, `collect-d1-evidence`,
`check-bundled-snapshot-inputs`, `ctl-allowlist`. Four are declared `unrun` with reasons.

Manifest: **48 files — 44 running, 4 unrun.** Before this ticket, 38 ran and 9 were invoked by
nothing while `check-test-inventory.mjs` counted them toward its pins.

## 2. Acceptance

| Clause | Artifact | State |
|---|---|---|
| An undeclared test file fails | fail-first run named all nine | done, proven failing first |
| A comment naming a file does NOT satisfy `runs` | unit test | done |
| `unrun` without a reason fails | unit test | done |
| A renamed/deleted step fails | unit test (`unknown_step`) | done |
| A manifest entry for a deleted file fails | unit test (`stale`) | done |
| A vitest package missing from `projects[]` fails | unit test | done |
| Empty discovery / manifest / projects each fail | unit test + CLI clause | done |
| Windows path separators normalise | unit test | done |
| The guard is invoked | `pr.yml` policy step + `guard-inventory.json` | done |

13/13 unit tests. All eight repo guards pass: `execution-census`, `ticket-graph-coverage`,
`dependency-graph`, `guard-inventory`, `test-inventory`, `ci-lanes`, `d1-compose`,
`worker-daemon-boundary`. Test-inventory pin bumped for the two new test files.

## ★ 3. A parser bug that would have shipped FOUR FALSE EXCUSES

The first `collectStepRunText` handled only the block form (`run: |`) and not the single-line form
(`run: node --test scripts/x.test.mjs`). It therefore reported **13** unrun files instead of 9, and
the four extras — `check-browser-suite-executed`, `embedded-secret-scan`, `installer-admission`,
`update-admission` — are all genuinely wired.

Had that shipped, four real, passing, CI-executed tests would have been recorded as "not run" with a
fabricated reason. **A false excuse is the worst output this guard can produce**, because it retires
a working test and looks like diligence.

It was caught only because the number disagreed with a baseline derived independently, by a
different method, earlier in the ticket. **Two methods that must agree is what caught it — not
review, and not the tests.**

## ★ 4. The single most valuable thing the census found

`scripts/check-distributed-execution-foundation.test.mjs` — **141 tests, invoked by nothing, and
RED**:

```
AssertionError [ERR_ASSERTION]: mutation did not remove additionalProperties:false
```

Its author wrote an explicit anti-vacuity assertion: the test checks that its own mutation actually
applied before concluding anything. That assertion is **failing**, which means the guard correctly
detected it cannot evaluate what it guards — and the detection reached nobody, because no line in
any workflow named the file.

Declared `unrun` here with that reason and a named follow-up rather than wired red, which would
block a branch two lanes are pushing to. **Fixing it is the highest-value item in the manifest.**

## 5. Two self-catches, both left in place

- **TRACK-001 caught TRACK-002.** Creating this ticket's design doc made `check-ticket-graph-coverage`
  demand a `#### TRACK-002` node. Yesterday's guard, working on today's ticket.
- **The census caught its own test file.** Adding `execution-census.test.mjs` made the census fail
  until it was declared.

Neither was carved out. A guard whose author exempts himself teaches everyone that exemptions exist.

## ★ 6. What this does NOT claim

**A `runs` verdict is not proof of execution.** It means the declaration still matches the tree.
Verifying it is inference, and inference has failed six times in this programme — the sixth during
this ticket's own terrain, when a basename grep miscounted this population because
`image-startup-smoke.test.mjs` is named in a comment explaining why it is *not* wired.

Comment-stripping plus scoping to a human-declared step narrows that surface a great deal. It does
not close it: a comment *inside the declared step* naming the path would still satisfy the check.
That residual is stated in the guard's source, in the manifest header, and in the CLI's own success
line — not described as enforcement.

The sound completion is **TRACK-003**: invoke from the manifest, so `runs` is true by construction.
Deliberately not bundled — it rewrites ~30 hand-listed lines in a workflow file Lane B is actively
editing, and this ticket's value does not depend on it.

## 7. Deferred, with owners named in the manifest

| File | Why unrun |
|---|---|
| `check-distributed-execution-foundation.test.mjs` | 141 tests, RED on a no-op mutation helper (§4) |
| `image-startup-smoke.test.mjs` | its `--tmpfs /worker` lands root-owned over the Dockerfile's `chown`; a defect in the test, not the image |
| `run-e3-perf-01.test.mjs` | a benchmark, not an invariant; >2 min and hardware-sensitive |
| `verify-e3-perf-01-handoff.test.mjs` | one-off E3 handoff record; already `dormant` in `guard-inventory.json` |

Each entry says what would have to change. **A reason is not an excuse**, and the manifest is meant
to read as a debt register.
