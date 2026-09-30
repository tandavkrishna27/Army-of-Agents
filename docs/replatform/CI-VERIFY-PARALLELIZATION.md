# CI hardening — parallelize `verify` into a shard matrix (retire the §2.0 timeout)

**Not a re-platform ticket — a CI-platform task.** Lives here (not under `epics/*/tickets/`) so the
ticket-graph coverage checker does not require a `#### ID` node for it. This is the **full plan**
(the earlier scoping note is superseded by this file); the diagnostic and the design below are what
the session executed.

> **Provenance of every number here.** Timings are read from the REAL CI, not estimated:
> `gh run` job/step timings and the raw `verify` job log for run **32823687389** (SHA around
> `2026-08-25`, the last `verify` that ran to *completion* rather than being cancelled at the cap).
> Test-file counts are from `git ls-files` and the `check-test-inventory` / `check-execution-census`
> guards on tip. The one un-measurable locally is the sharded per-shard wall-clock (embedded-PG will
> not boot on this deep OneDrive worktree — `pnpm install` itself dies `ENAMETOOLONG`); that number
> is filled from the PR's own CI run in the Evidence appendix, which is the acceptance gate.

---

## 0. Outcome in one paragraph

> **OUTCOME (2026-08-27): `ci-required` is GREEN** — PR #327, run `33037143412`, all four `verify`
> shards pass in 12.8–16.2 min. Getting there took more than sharding: STEP 0's "volume, not a hang"
> call was **partly wrong** (see §2 + §8). Executing the matrix completed the suite for the first time
> in weeks and exposed two pre-existing, timeout-masked defects — a real **hang** in `job-submission`
> (fixed) and a real **failure** in the sentinel fixture (fixed). Sharding + those two fixes = green.

`verify` is a single Ubuntu job whose `Run tests` step (`vitest run` over all 25 `projects[]`) is
~56 min of wall-clock at `maxForks = availableParallelism/2 = 2` — right at the `timeout-minutes: 60`
cap, which is why it has capped out on 5+ consecutive runs (GO-BOOK §2.0). The slowness is **mostly
volume** (156+ embedded-PG integration files, one lane) but ALSO contained a non-deterministic hang
(§2/§8 correction). The fix (Part 3) turns `verify` into a **`fail-fast: false` shard matrix** of 4
legs, each running `pnpm exec vitest run --shard=i/4` on its own runner, so the ~56 min test load
splits ~4 ways and every shard finishes far under an **un-raised** 60-min cap. The security-critical
`ci-required` wiring is **untouched** and already correct for a matrix (Part 4): `needs.verify.result`
is `success` only if **every** leg succeeds, and the same in-repo pattern
(`worker-protocol-contract-bytes`) is already a required matrix check. Proven, not assumed — a shard
failure turned `ci-required` red organically (a real failure, no forced-fail run needed; §8).

---

## 1. Verified CI state (read from tip, by job + step name)

`.github/workflows/pr.yml`, job `verify` (currently a single job):

```yaml
  verify:
    runs-on: ubuntu-latest
    needs: changes
    if: ${{ needs.changes.outputs.code == 'true' && (github.event_name != 'pull_request' || !github.event.pull_request.draft) }}
    timeout-minutes: 60
    steps:
      - Checkout repository
      - Setup pnpm            (9.15.4)
      - Setup Node.js         (24, cache: pnpm)
      - Install dependencies  (pnpm install --frozen-lockfile)
      - Build dist-only leaves (required by typecheck + tests)   # worker-protocol, sandbox-fake-provider,
                                                                 # worker-daemon, sandbox-provider-contract, sandbox-e2b-provider
      - Typecheck             (pnpm -r typecheck)
      - Run tests             (pnpm test:run)          # ← the ~56-min pole
      - Build                 (pnpm build)
      - Worker protocol package import smoke
      - Tool contract freshness (pnpm gen:tools:check; pnpm gen:tools:md:check)
```

The always-on aggregator `ci-required` (the ONLY branch-protection required check):

- `ci-required.needs` lists `verify` **by name** (alongside `changes, policy, brand-check,
  worker-protocol-contract-bytes, lint, e2e, e2e-pgvector, migrations, distributed-contract,
  browser`).
- Its verdict step captures `R_VERIFY: ${{ needs.verify.result }}` and, **only when
  `changes.outputs.code == 'true'`**, requires `R_VERIFY == "success"` (else `fail=1; exit 1`). A
  `skipped` verify on a code PR therefore already fails `ci-required` — there is no pass-by-skip to
  begin with.
- `vitest.config.ts`: one `test.projects: [...25 projects...]`, `pool: "forks"`,
  `maxForks = max(2, floor(availableParallelism/2))`. On a GitHub Ubuntu runner that resolves to
  **2 forks**.
- `test:run` = `vitest run`. **Pitfall (found on run 33012727670):** `pnpm test:run -- --shard=i/N`
  does NOT work under pnpm 9.15.4 — pnpm forwards the `--` literally, producing
  `vitest run -- --shard=i/N`, and vitest's cac parser treats everything after the bare `--` as
  non-option passthrough, so the shard flag is **silently ignored** and every shard runs the whole
  suite (all 4 shards ran ~52 min, no split). The fix is to invoke vitest directly, the same form the
  `browser` lane already uses: **`pnpm exec vitest run --shard=i/N`** (clean argv, no stray `--`).

**In-repo precedent — matrix `.result` already gates `ci-required`.** Job
`worker-protocol-contract-bytes` is ALREADY a `strategy: { fail-fast: false, matrix: { os: [...] } }`
matrix, is in `ci-required.needs`, and its `R_WP_BYTES: ${{ needs['worker-protocol-contract-bytes'].result }}`
is tested in the always-on gate loop. Matrix-to-`ci-required` aggregation is not new here; it is
load-bearing for a required check today. The `verify` matrix mirrors this exact shape.

---

## 2. STEP 0 diagnostic — the slowness is VOLUME, not a hang

The premise to falsify (GO-BOOK §2.0): `verify` went from ~40 min green (`b296d9ee9`,
2026-08-24 11:45 UTC) to a deterministic ~65-min cap-out; the §2.0 author could not tell, from
truncated cancelled-job logs, whether it was a single hang or volume. Resolved here:

**(a) The suite RUNS TO COMPLETION → not an infinite hang.** Run 32823687389's `verify` concluded
`failure` (not `cancelled`) at 59 min, with vitest's own summary:

```
Test Files  1 failed | 2434 passed | 7 skipped (2442)
Start at 07:55:13   Duration 1661.93s (… collect 1117.43s, tests 1296.33s …)
```

An infinite hang cannot print a final tally of 2442 files. The `1 failed` was the pre-E4-F017
`issue_comments` FK error (`insert … violates foreign key constraint issue_comments_issue_id_issues_id_fk`),
since fixed — so after E4-F017 this run is all-green and the ONLY red reason is the wall-clock, a
volume problem, exactly as the scoping premise held.

**(b) Load is spread across 156+ embedded-PG files, no single dominator.** Parsing the completed
log's `stdout | <file>` markers: 156 distinct `*.integration.test.ts` files emit output; the loudest
(`tenant-adversarial.property` 600 lines, `distributed-execution-db-startup` 537,
`job-legacy-after-commit` 375, `job-submission` 310) is ~2% of the 29 589 integration output lines.
The heaviest tests are **legitimate finite** ones — `job-submission.integration.test.ts` sends
`"x".repeat(200_000)` (200 KB) and `"x".repeat(4_000_000)` (4 MB) payloads to exercise the
`payload_too_large` size-ceiling guards (hence a single 694 KB `"p":"xxx…"` line in the log when the
app logs a rejected body). A 4 MB gzip+POST is seconds, not minutes.

**(c) The multi-minute log gaps are output throttling, not a stall.** The completed log shows an
8.4-min gap between two consecutive lines, but the job still finished — with `maxForks = 2`, both
forks grinding embedded-PG integration files that only emit on state transitions produces long silent
stretches, and GitHub's ingestion of the giant `xxxx` payload lines lags the emitter. The
authoritative wall-clock (job/step `started_at`→`completed_at`) is what sizing uses, not log-line
spacing.

**Cause of the +16 min regression: cumulative volume.** Between `b296d9ee9` and tip, **0** test files
were deleted and **36** were added (only **6** integration). The suite has simply crept from ~40 min
over the ~56-min mark; a ~56-min suite against a 60-min cap tips over whenever a runner is a few
percent slow — which is exactly the deterministic ~65-min cap-out §2.0 recorded. **No hang, no
pathological single test → sharding is a clean fix, not a mask.** (Had the diagnostic found a real
hang, this doc would instead file it as a finding and NOT shard around it — it did not.)

Step timings (run 32989635543, a representative cap-out) confirm where the time is:

| Step | Duration |
|---|---|
| Set up + Checkout + pnpm + Node + Install | ~0.5 min |
| Build dist-only leaves | 0.2 min |
| Typecheck | 2.9 min |
| **Run tests** | **~56 min → cut off at the 60-min cap** (Build/smoke/tool-contract never reached) |

---

## 3. The fix — a 4-way shard matrix on `verify` (timeout NOT raised)

Convert `verify` to a shard matrix. Only the `verify` job changes; no other lane is touched, and no
`paths:`/`paths-ignore:` trigger filter is added (conditional execution stays routed through
`changes` + `ci-required`, per the DEP-004 invariant that `scripts/check-ci-lanes.mjs` enforces).

```yaml
  verify:
    runs-on: ubuntu-latest
    needs: changes
    if: ${{ needs.changes.outputs.code == 'true' && (github.event_name != 'pull_request' || !github.event.pull_request.draft) }}
    strategy:
      fail-fast: false            # a red shard must NOT cancel its siblings — we want the full picture
      matrix:
        shard: [1, 2, 3, 4]
    timeout-minutes: 60           # UNCHANGED — a PER-SHARD cap now; each shard lands far under it
    steps:
      # … identical setup + Build dist-only leaves + Typecheck …
      - name: Run tests
        run: pnpm exec vitest run --shard=${{ matrix.shard }}/4   # denominator MUST equal the matrix length
      # … identical Build + Worker protocol package import smoke + Tool contract freshness …
```

**Why N = 4.** Per-shard wall-clock ≈ fixed-overhead + tests/N, where fixed overhead (setup ~0.5 +
build-leaves 0.2 + typecheck 2.9 + post-test Build ~8 + smokes ~2 ≈ **13.6 min**) runs on every
shard and tests ≈ **56 min** at maxForks=2:

| N | tests/shard | + overhead | per-shard total | margin under 60 |
|---|---|---|---|---|
| 3 | ~18.7 min | 13.6 | ~32 min | ~47% |
| **4** | **~14 min** | **13.6** | **~28 min** | **~53%** |
| 6 | ~9.3 min | 13.6 | ~23 min | ~62% |

N = 4 is the sweet spot: the fixed overhead dominates past N = 4 (diminishing returns), it keeps the
runner count and the redundant-Build cost modest, and ~28 min nominal (~34 min even if one shard
draws 1.5× the heavy files) is comfortably under an un-raised 60. The real per-shard wall-clocks are
recorded in the Evidence appendix; if any shard lands above ~40 min, N is raised — **the cap never
is.**

**How `vitest --shard` partitions (vitest 3.2.6).** It hashes each spec's project-relative path
(SHA1), sorts by hash, and slices `[ceil(total/N)·(i−1), ceil(total/N)·i)`. That is a **deterministic
disjoint partition**: every spec lands in exactly one shard (union = full set, no spec in two shards,
none in zero), guaranteed by construction — and the hash scatters the 156 heavy integration files
pseudo-uniformly, so count-balance also gives rough time-balance. `--shard` operates on the whole
`projects[]` file set, so all 25 projects' specs distribute together.

**Symmetric shards (deliberate).** Every shard runs the identical step sequence; only
`--shard=i/4` differs. The whole-repo steps (Typecheck, Build, Worker-protocol smoke, Tool-contract
freshness) therefore run in every shard rather than once. That redundancy is the explicit, accepted
price of a rule this programme holds above compute cost: **"a check that nothing runs is not a
check"** (GO-BOOK §2.3; MEMORY `checks-that-nothing-runs`). Hoisting those steps behind an
`if: matrix.shard == '1'` would save compute but introduce a conditional that could silently disable a
whole-repo verification on a later matrix edit — the exact failure class the programme guards. Each
shard still lands ~28 min, so the redundancy costs nothing against the acceptance bar.

---

## 4. `ci-required` wiring analysis — no pass-by-skip on a matrix

The verdict is unchanged; the only question is what `needs.verify.result` evaluates to once `verify`
is a matrix. GitHub Actions semantics:

- A job that `needs` a matrixed job waits for **all** legs. `needs.<job>.result` is **`success` iff
  every matrix combination succeeded**; if any leg concludes `failure`, the aggregate is `failure`;
  if any is `cancelled`, `cancelled`; if the whole job's `if:` is false, `skipped`.
- With `fail-fast: false`, a failing leg does **not** cancel siblings — they all finish and report,
  and the aggregate is `failure` because one leg failed. (With the default `fail-fast: true` a fail
  would cancel siblings → aggregate `cancelled`; either way `!= success`.)
- The verdict requires `R_VERIFY == "success"` when `code == 'true'`. Any leg failing → aggregate
  `failure` → `!= success` → `fail=1; exit 1` → **`ci-required` RED**. A leg `cancelled` (e.g. the
  60-min per-shard cap) → aggregate `!= success` → RED. Verify `skipped` on a code PR → RED.
- The **only** way a leg's failure could be hidden is `continue-on-error: true` on the job/step (which
  makes a failed leg report `success`). The `verify` job has **no** `continue-on-error` today and the
  matrix does not add one. `fail-fast: false` is orthogonal — it governs sibling *cancellation*, not
  whether a leg's failure counts.

This is not a novel claim about GitHub: `worker-protocol-contract-bytes` is already a required
matrix check gated exactly this way. **Proven empirically in Part 6.**

---

## 5. Registers + guards stay green (no test silently dropped)

- **`check-test-inventory`** (`policy` step "Test-suite inventory (may not silently shrink)") is a
  pure on-disk scan pinned in `scripts/test-inventory.json` (2649 files / 18 trees on tip). Sharding
  deletes no file → unchanged → green. This is the disk-level "no file dropped" guarantee.
- **`check-execution-census`** ("Execution census") scans `*.test.mjs` and keys workflow steps by
  `<workflow>::<step name>`; **no** census entry references any `verify` step (all reference `policy`
  guard steps). Adding `strategy:`/`matrix:` adds no `- name:` step and renames none; changing the
  `Run tests` `run:` text touches no census key. Unchanged → green.
- **`check-ci-lanes`** ("CI lane routing invariants (DEP-004)") asserts: no trigger `paths:` filter
  (none added), `policy` not code-gated (untouched), `ci-required` exists (untouched), and every
  protocol/schema/provider class maps to the `distributed-contract` consumer (untouched). It says
  nothing about `verify`'s internals; its job-header scanner keys on `^  verify:` (empty after the
  colon — still true) and reads `needs:`/`if:` at indent-4 (unchanged). Green.
- **The five registers** (`check-gate-clause-wiring`, `check-finding-ownership`,
  `check-ticket-graph-coverage`, `check-guard-inventory`, `check-execution-census`) are all green at
  baseline and untouched by a workflow-only edit. Re-run after the edit; all must stay green.
- **Union-of-shards = full set** is guaranteed by the vitest partition (Part 3) and **verified
  empirically** on the PR: Σ(per-shard "Test Files" counts) must equal the single-lane count, and
  `check-test-inventory` must not drop. Recorded in Evidence.

No new script or test file is added, so nothing needs registering in `scripts/guard-inventory.json`
or `scripts/test-execution-census.json`.

---

## 6. Proof plan — force one shard red, watch `ci-required` go red

The security-critical claim ("a shard failure reaches `ci-required`") is proven, not assumed:

1. On the PR, push a throwaway change that forces exactly **one** shard to fail
   (`if [ "${{ matrix.shard }}" = "1" ]; then exit 1; fi` before `Run tests`), keeping the others
   real.
2. Observe: shard 1 → RED, shards 2–4 → GREEN (fail-fast:false let them finish — itself partial proof
   the sharding runs green), `needs.verify.result` → `failure`, **`ci-required` → RED**.
3. Remove the throwaway (reset the branch to the real commit, force-push) and observe the real run:
   all 4 shards GREEN, `ci-required` PASS.

"Do not land the proof, land the evidence" — the forced-fail commit never remains on the branch; the
run IDs and outcomes are recorded in the Evidence appendix.

---

## 7. Acceptance

| # | Criterion | How proven | Result |
|---|---|---|---|
| A1 | `verify` runs as a `fail-fast:false` matrix; every shard well under an **un-raised** 60-min cap | run `33037143412`: shards 12.8 / 13.7 / 13.8 / 16.2 min (max 16.2 ≈ 73% under 60) | ✅ |
| A2 | A single-shard failure turns `ci-required` RED — no pass-by-skip | run `33019158926`: shard 1 failed (real) + shard 2 cancelled → `verify` aggregate `failure` → `ci-required` RED. Proven **organically** by a genuine failure, no forced-fail run needed | ✅ |
| A3 | `fail-fast: false` set → a red shard does not cancel siblings | pr.yml diff; run `33019158926`: shards 3/4 finished green while shard 1 failed and shard 2 hung | ✅ |
| A4 | Total test COUNT unchanged; union of shards = full set | run `33037143412`: Σ `Test Files` = 618+618+618+616 = **2470** (exact disjoint partition); `check-test-inventory` unchanged | ✅ |
| A5 | `timeout-minutes` NOT raised | diff: `timeout-minutes: 60` unchanged | ✅ |
| A6 | No `paths:` filter; `e2e`/`e2e-pgvector`/keyed lanes untouched | diff scope + `check-ci-lanes` green | ✅ |
| A7 | Five registers + `check-ci-lanes` + `check-test-inventory` green | run pre+post edit; CI `policy` job | ✅ |
| A8 | `ci-required` GREEN (the goal) | run `33037143412`: all 4 shards + `ci-required` PASS | ✅ |

**Scope note (revised).** The original scope said "only `verify` changes / file, don't fix." Executing
the matrix revealed two pre-existing, timeout-masked defects (a hang + a real failure) that block green
regardless of sharding; on the board operator's decision ("fix both, drive to green") this PR ALSO
carries their fixes — `job-control-module-load-sentinel.mjs` (restore the deleted line) and
`redact-sensitive.ts` + its unit test (cap logged strings at 8192). Non-goals still honoured: cap NOT
raised, no trigger `paths:` filter, no second required job, `e2e`/`e2e-pgvector`/keyed lanes untouched.

---

## 8. Evidence appendix (from the PR's own CI, PR #327)

Diagnostic source runs: **32823687389** (single-lane, completed `failure`, 59 min, full log),
**32989635543** (representative cap-out, step timings).

CI history on PR #327 (each cancelled the previous via concurrency):

| Run | What it proved |
|---|---|
| `33012727670` | **Found the pnpm `--` bug.** Every shard ran `vitest run "--" "--shard=…"` (shard flag ignored) → all 4 ran the full suite ~52 min. Fixed to `pnpm exec vitest run --shard=…`. |
| `33017378238` | Probe (`vitest list --filesOnly --shard`) — list does NOT apply `--shard` (all shards reported 2470); the run path does. Invalid probe, discarded. |
| `33019158926` | **Real 4-shard run — the partition is exact and sharding parallelizes cleanly** (shards 1/3/4 = 618/618/616 files, ~13.4–13.9 min), AND it revealed the two timeout-masked defects: shard 1 = 5 real failures (`normalized` ReferenceError), shard 2 = **HUNG** on `job-submission` (9/618 files, 42 min silence → 60-min cap). `ci-required` correctly RED off the real failure — **the aggregation-reaches-ci-required proof happened organically, with a genuine failure (no forced-fail run needed).** |
| **`33037143412`** | **GREEN.** With both defects fixed: `verify (1)` 16.2 m, `verify (2)` 13.8 m, `verify (3)` 12.8 m, `verify (4)` 13.7 m — all **success**; `ci-required` **PASS** (first time in the programme). |

**Union / no-drop:** per-shard `Test Files` = 618 + 618 + 618 + 616 = **2470**, an exact disjoint
partition (matches the single-lane count); `check-test-inventory` unchanged. **Slowest shard 16.2 min
= ~73% under the un-raised 60-min cap.**

### Revised diagnostic (honest correction)

STEP 0 concluded "volume, not a hang" from the one complete run (32823687389). That was **wrong**:
the slowness was PART volume (sharded away cleanly) and PART a real, non-deterministic **hang** in
`job-submission.integration.test.ts` — its 4 MB-payload size-ceiling tests logged the full rejected
body, and serializing that multi-MB log line through the vitest fork IPC stalled a worker past the
patched 600 s birpc timeout. The single-lane run had 8-min gaps there and got lucky (recovered);
sharding's reordering pushed it into a 42-min hang → cap. Plus a real failure (the sentinel
ReferenceError). **Both were invisible because the timeout meant verify never completed.** Fixes
(same PR): restore the deleted `const normalized` line; cap logged strings at 8192 chars in
`redact-sensitive.ts` (a real log-hygiene / DoS-surface fix, not a test workaround). Filed findings
also cover a shard-denominator static guard the review flagged.
