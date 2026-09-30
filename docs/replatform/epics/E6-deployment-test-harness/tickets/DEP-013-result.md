# DEP-013 — Result: the D1 verdict has a reader, and the reader has been made to fail

**Epic:** E6 · **Design:** [`DEP-013-design.md`](./DEP-013-design.md) · **Status:** `complete`
(2026-09-04) · **Residual:** [E6-F013](../findings.md#e6-f013) (`open`, MED, `unowned` with a reason)
**Depends on:** DEP-004 · **Slices landed:** A, B, C, D, E (all five)

---

## 1. What shipped

| Slice | Artifact | State |
|---|---|---|
| **A** | `scripts/lib/workflow-verdict.mjs` (the pure core), `scripts/workflow-verdict-manifest.json` (17 streams over 14 workflow files), `scripts/check-workflow-verdict-manifest.mjs` | **INERT** — wired into `policy`; queries no live verdict, blocks nothing new |
| **B** | `.github/workflows/verdict-reconcile.yml` + `scripts/reconcile-workflow-verdicts.mjs` + `scripts/lib/github-rest.mjs` | **CONSUMING, non-blocking** |
| **C** | `scripts/check-verdict-consumer-freshness.mjs`, wired as the `policy` step *"Verdict consumer is alive (DEP-013)"* with job-level `issues: read` + `actions: read` | **BLOCKING — on unpublished silence only.** See §5 for the one condition it tolerates today |
| **D** | Dispositions for every §2 instance: `cross-platform-weekly` **watched**; `release-smoke`, `llm-evals`, `release.yml`, `deploy-testing` **not-watched, each with a reason AND what would have to change** | declarative |
| **E** | `GO-BOOK.md` §1.9.8 repointed from a habit to a mechanism; `HANDOFF-orchestration.md` merge protocol updated | docs |

**The acceptance is the CONSUMER, not the check.** No clause anywhere in this ticket reads
"`d1-merge-train` passes". `policy` fails when the verdict was not READ; a red watched lane
updates the tracking issue and blocks nothing.

## 2. The controls that were executed

### PC-1 — the pure evaluator, mutated. 12 mutants, 12 killed, source restored byte-identical.

Each mutant is a single OR-ARM, not a whole clause, and the sweep re-ran all three suites
(`workflow-verdict.test.mjs`, `check-workflow-verdict-manifest.test.mjs`,
`check-verdict-consumer-freshness.test.mjs`) per mutant.

| # | Mutation | Killed by |
|---|---|---|
| M1 | success-only → the design's own rejected enumeration `[failure, cancelled, timed_out]` | the five conclusions this repo has never produced |
| M2 | drop the workflow-not-on-this-branch arm | the `185deeaba` case (§3) |
| M3 | descendant-covering → the run must be ON the matching commit | the recorded `50380b6f7` case (§3) |
| M4 | drop the cadence staleness arm | a 400h-old success against a 336h budget |
| M5 | drop the cadence not-success arm | `cross-platform-weekly`'s real `cancelled` |
| M6 | heartbeat measures the RUN — `ran_but_never_published` → pass | ★★★ the §5.3 control |
| M7 | drop the marker staleness arm | a 100h-old marker against 72h |
| M8 | drop anti-vacuity (zero watched streams) | the sweep-that-examines-nothing test |
| M9 | drop `branch_undeclared` | `d1-merge-train` with only one of its two branches declared |
| M10 | `**` stops crossing `/` in the path matcher | the real `docker/**` commits |
| M11 | `uncovered_commit` never reported | a matching commit with no run |
| M12 | a not-watched entry no longer needs a reason | the reason-is-not-an-excuse test |

Restore was verified byte-identical and the suites re-run green afterwards. **A mutation that
stays green is the only signal a fix shipped with no test at all**, so the sweep is the evidence,
not the assertion count.

### PC-2 — the REPLAY against recorded reality, not a fixture.

`scripts/workflow-verdict-replay-d1.json` is captured from the live API (5 runs + the 5 head
commits with their real file lists; every sha is a real 40-char sha and every URL a real run
URL). Replayed instant by instant, the consumer:

- is **silent** on 2026-08-25 (`50380b6f7`, green),
- **reports** from 2026-08-29 (`c3d26657d`, `failure`) and keeps reporting across 08-30, 08-31,
  09-01 and 09-02 — **all five days of the unread window**,
- **stops** at `ee74f9c8c` on 09-03.

The input is the actual recorded history of the incident. A fixture-shaped positive control
would be the very thing this ticket is about.

### PC-3(1) — the live firing, executed as far as a builder may take it.

`node scripts/reconcile-workflow-verdicts.mjs --dry-run` against the real API, all 11 watched
streams, 2026-09-04:

```
verdict-reconcile: MeteoriteLabs/AoA — 11 watched stream(s) [DRY RUN — nothing is published]
  d1-merge-train.yml@main: the workflow file is not on this branch — nothing is owed
  keyed-e2b-conformance.yml@docs/replatform-program: no paths-matching commit in the last 40 — silent
  keyed-e2b-cdp-probe.yml@docs/replatform-program: no paths-matching commit in the last 40 — silent
  FINDING cross-platform-weekly.yml@main: not_success — latest completed run concluded `cancelled`
```

**§6's free positive control fired, on live data, with nothing broken to arrange it** — and the
full issue body it would publish was printed. `d1-merge-train@docs/replatform-program` is
correctly silent (green since `ee74f9c8c`), and the two keyed lanes are correctly silent
(trigger files unchanged), which is the half a wall-clock rule would have got wrong.

**What was NOT done: the `POST`.** `MeteoriteLabs/AoA` is a **public** repository and opening the
tracking issue is publishing public content — outside an automated builder's authority.
Separately, it could not have been fired from CI here either: GitHub registers `schedule` and
`workflow_dispatch` only from the default branch, so the reconciler's first real run is the push
that merges this. Both are recorded as **E6-F013**, together with the exact steps that close it.

### PC-3(2) and PC-3(3) — the reader made to fail, on its EXIT CODE.

`scripts/check-verdict-consumer-freshness.test.mjs` spawns the real CLI once per vector and
asserts `status`, never stdout — because the clause being bought is *"it fails the job, it does
not warn"*, and that is a claim about the process, not about a pure function.

| vector | exit | what it proves |
|---|---|---|
| `fresh` | 0 | a recent published marker is a consumed verdict |
| `stale` | **1** | PC-3(2): silence past the tolerated window reds `policy`, and therefore `ci-required` |
| `ran_but_never_published` | **1** | ★★★ PC-3(3): the reconciler RAN, COMPLETED and published nothing. **A heartbeat measured on the run list is green here** |
| `marker_absent` | **1** | an issue whose body lost the marker is not a consumed verdict |
| `not_bootstrapped` | 0 | the one self-terminating tolerance (§5) |
| `fresh_with_red_findings` | 0 | ★ NARROW: a published sweep full of RED findings must NOT fail the reader |
| (no token) | **1** | a check that cannot see must not report health |

### §4.1 — CHAINED, NEVER ADJACENT, proven on the real reconciler process.

The reconciler is spawned against a manifest whose **evaluation throws**, and the test asserts
(a) exit 1, (b) the `Nothing was published` banner, and (c) that neither publish log line ever
appears. A second test asserts the workflow has **exactly one `run:` step** and no
`continue-on-error`: as two steps without an explicit success condition, a throwing evaluator
would still let the write run — which is the 2026-09-03 incident verbatim.

Three further tests assert the wiring itself: that `pr.yml` invokes both CLIs, that it passes no
`--manifest` / `--self-test-case` escape hatch and no `|| true`, and that the reader sits inside
the `policy` job specifically.

## 3. Two defects the controls found — both in this ticket's own code, both from REAL data

Neither was found by reasoning. Both were found by pointing the evaluator at the live API.

**(a) A run at a DESCENDANT covers the matching commit.** `50380b6f7` produced a green
`d1-merge-train` run while touching only `docs/replatform/GO-BOOK.md` and a result doc — neither
in the lane's 18-entry filter. GitHub matches `paths:` against **every commit in a push** and
then starts **one** run at the push TIP, so a matching commit's run is routinely recorded against
a later sha. The first implementation required a run *on* the matching commit and would have
reported that fully-covered green merge as an uncovered commit — a false incident, on the exact
lane this ticket is about, inside the exact window it is about.

**(b) A workflow that is not ON a branch owes that branch nothing.** The first live dry-run
reported `d1-merge-train.yml@main uncovered_commit 185deeaba`. Every word of it was true —
`185deeaba` touches `.dockerignore` and `docker/research/**`, both in the filter, and the lane
has **zero** runs on `main` ever — but `d1-merge-train.yml` exists only on
`docs/replatform-program`. The only possible repair would have been landing the workflow on
`main`: **an incident nobody can close**, which is precisely the shape §5.2 rejects wall-clock
staleness for, one level over. The stream declaration stays (§5.4: designed for now rather than
discovered then); it simply owes nothing until the file is there, and starts owing automatically
on the day it is.

Both now have a mutant (M3, M2) that reproduces the false incident.

## 4. Two design deviations, both deliberate, both measured

**(a) The reconciler also triggers on `push`.** §7 specifies `schedule` + `workflow_dispatch`.
GitHub registers **both of those only from the DEFAULT branch** — this is not an assumption:
`d1-merge-train.yml` says so at the line (*"workflow_dispatch is omitted deliberately: it
requires the workflow on the default branch (main)"*), `keyed-e2b-conformance.yml` says the same,
and in the API every scheduled run of `cross-platform-weekly`, `catalog-audit` and
`thread-v2-e2e` is on `main`. Without a `push` trigger the consumer would be inert on the branch
the incident actually happened on — a decorative consumer, which is the defect rather than the
fix. Three lanes in this repo already use exactly this workaround. There is deliberately **no
`paths:` filter** on it: the marker is a heartbeat, and filtering the trigger would let a quiet
path age it out and red every open PR for a reason unrelated to any of them.

**(b) `toleratedSilenceHours` is 72, not one interval.** Because of (a), the only live trigger on
this branch is `push`, so the bound must survive a quiet long weekend or it becomes a cry-wolf
gate — the shape that gets a guard switched off. The manifest states the number, the reason, and
its **successor condition**: drop to 26 once the workflow is on `main` and its 6h cron is
observed firing.

## 5. What is enforced TODAY — stated plainly, because a false claim of enforcement is worse than a missing check

The `policy` reader is wired, runs on every non-draft PR, and **fails the job** (seven spawned
vectors assert real exit codes). But no tracking issue exists yet and the reconciler has no
completed runs, so its verdict today is `not_bootstrapped`, which **passes**. **The blocking half
of DEP-013 is exercised but has not yet blocked anything.**

That tolerance is the narrowest condition available and **is not a dial**:

- it applies to **exactly one** state — the reconciler has never produced a completed run;
- it is **removed by the first completed reconciler run**, automatically, with no manifest edit
  and nobody to remember. After that, a missing issue is `ran_but_never_published` and reds
  `policy`;
- it **masks nothing else**: with the issue present, a wiped marker, an unparseable marker, a
  marker with no timestamp and a stale marker all fail regardless of it;
- the run count is consulted **only to refuse the excuse** — it can turn a pass into a fail and
  never the reverse.

The alternative considered and rejected was a `consumer.state: pending-bootstrap` flag someone
must later flip. That is a gate nobody can pass, or a dial nobody remembers — a shape this
programme has already had to delete once — and it would have made the enforcement claim false in
a way no guard could see.

**E6-F013** carries this, `open` / MED / `unowned`, with the exact closing steps.

## 6. Capability — this does NOT move `capabilityProven`

Stated because claiming otherwise is the failure this programme punishes hardest.
`countProducedOutputs` (`e7-distributed-run-verifier.ts:506`) is an OR over `workspacePatchArtifacts`
and `taskOutputs`, and the artifact arm filters `kind = "workspace_patch"`
(`e7-distributed-run-verifier-store.ts:205-209`). **DEP-013 commits no `job_artifact` of any kind,
touches no worker, no sandbox and no run.** It is CI-verdict infrastructure. It does not advance
the return path and it does not flip clause 6. What still would is unchanged and is CLI-008 Unit F
§1.6's five missing links.

## 7. Out of scope, as designed

Option B (D1 on PRs) stays deferred with its measurements in the design §4/§8. Fixing
`cross-platform-weekly`'s cancellations and `release-smoke`'s 131-day-old red is each lane's own
work — DEP-013 makes them visible, which is a different claim from making them green. E6-F012
(the deps-stage dev-closure divergence) stays separately filed: DEP-013 makes the next occurrence
loud within a bounded time; E6-F012's successor would make it impossible. Neither substitutes for
the other.
