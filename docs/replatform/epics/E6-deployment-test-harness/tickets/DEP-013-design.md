# DEP-013 — Design: a CONSUMER for the D1 verdict (a red check nobody reads is a check that did not run)

**Epic:** E6 · **Plan node:** `docs/replatform/program-design.md`, `#### DEP-013`
**Depends on:** DEP-004 (the merge-train lane + its evidence bundle) · **Size:** M · **Status:** `scope` (2026-09-03)
**Terrain of record:** [`GO-BOOK.md`](../../../GO-BOOK.md) §1.9.8 · [`findings.md`](../findings.md) E6-F010
**Motivated by:** WRK-017 Step 0 — a ticket chartered to be "CI-exercised" measured its own lane and found it red.

---

## 1. The measured defect — and it is NOT that the lane broke

`d1-merge-train.yml` failed on three consecutive integration-branch merges and nobody read the
verdict. Measured 2026-09-03 (`gh run list --workflow=d1-merge-train.yml`):

| date | sha | verdict | evidence artifact uploaded |
|---|---|---|---|
| 2026-08-29 | `c3d26657d` | **failure** | ✅ `d1-merge-train-evidence-33251022081` |
| 2026-08-30 | `07ed2cc42` | **failure** | ✅ `d1-merge-train-evidence-33316702359` |
| 2026-08-31 | `b6e02a478` | **failure** | ✅ `d1-merge-train-evidence-33438919657` |
| 2026-08-25 | `50380b6f7` | success (the last one before the window) | — |
| 2026-09-03 | `ee74f9c8c` | success (WRK-017's fix) | — |

**Read that third column again.** DEP-004's evidence machinery worked *perfectly*: every red run
collected per-service logs, worker events, a DB-state dump and MinIO manifests, and uploaded them
under a 14-day retention. **Three complete diagnostic bundles were produced and nobody fetched
one.** DEP-004's acceptance says *"distributed logs, events, database state, and object manifests
are **retained** on failure"* — retention was specified, built and honoured. **Consumption was
never specified at all.**

So the defect this ticket owns is not the build break (WRK-017 fixed that, and E6-F010 records it).
It is that **the verdict had no reader**, and five days of that was indistinguishable from five days
of green. This is variant 10 of *"a check that nothing runs is not a check"*, and it is the first
one in this programme where the check **did** fire, **did** produce its artifact, and was read by
nobody. Every earlier variant was a check that could not fire. This one is worse in one specific
way: it looks, from every dashboard the programme actually consults, exactly like success.

## ★★ 1.1 The same defect, twice more, on the same axis — this is a class

Three instances, all real, and two of them landed on **the same day in the same repository**. They
differ only in *where* consumption failed, which is what makes the axis visible:

| # | Instance | Where consumption failed |
|---|---|---|
| 1 | **NOT SPECIFIED** — DEP-004's acceptance requires that failure evidence is *retained*. It is. Nothing anywhere requires that it is ever **read**. Three bundles expired unopened. | in the **charter** |
| 2 | **NOT READ** — `d1-merge-train` red for five days and three merges (§1). The verdict exists, is public, is correct, and reaches nobody. | in the **process** |
| 3 | ★ **NOT WIRED** — 2026-09-03, another track: `git rerere` silently replayed a stale resolution into `scripts/finding-ownership.json` and produced structurally invalid JSON with a duplicated `reason` key. A validation ran. It **failed**. The `git add` ran anyway — because it was sequenced **beside** the validation rather than **chained** to it. | in the **wiring** |

Instance 3 is the sharpest, and it is free evidence: there the reader *existed*, was *correct*, and
*fired*, and the failure still passed through, because nothing made the next step depend on the
verdict. **A consumer that is adjacent to a check is not a consumer.** That is this ticket's thesis
one scale down, and it is why the design commits to §4.1 rather than treating "file an issue" as
self-evidently sufficient.

**The principle DEP-013 is really buying:** *a check's verdict needs a named consumer, and the
consumer's WIRING is a separate artifact from the check.* Production and consumption are two
clauses, not one, and this repository has now missed the second one in a charter, in a process, and
in a shell command — within a single day.

## ★ 2. It is not one lane. Two more, measured today.

If DEP-013 were scoped to "watch d1-merge-train", it would fix one of at least three live
instances. Measured on 2026-09-03 across every workflow in `.github/workflows/`:

| workflow | state | measured | instance? |
|---|---|---|---|
| `d1-merge-train.yml` | active | the window above; fixed, green on `ee74f9c8c` | **yes** (the chartered one) |
| `cross-platform-weekly.yml` | active | the last **three** scheduled runs — 08-16, 08-23, 08-30, all on `main` — are `cancelled`. Three consecutive weeks with **no cross-platform verdict at all**, still true today | **yes**, and purer: it produced no verdict rather than a red one |
| `release-smoke.yml` | active | last 10 recorded runs **all `failure`**; most recent 2026-04-25 — **131 days** ago. `workflow_dispatch`/`workflow_call` only, so it is the dormant callee of a disabled `release.yml` | **weakly** — the last recorded verdict is red and unread, but nothing re-triggers it |
| `llm-evals.yml`, `release.yml` | `disabled_manually` | last verdicts red, but the workflow announces it is off | **no** — a disabled workflow is a visible state, not a silent one |

**Design consequence, and it is the one that matters:** the consumer must be
**workflow-agnostic by construction**. Making it generic costs nothing over making it d1-specific
(the same API query, one manifest row instead of a hardcoded name), and a d1-specific consumer
would leave `cross-platform-weekly`'s three blank weeks exactly as invisible as they are now.

## 3. Why it was invisible — the two structural facts

1. **`d1-merge-train` runs on `push`, never on `pull_request`.** Its `on:` block is `merge_group` +
   `push` to `main`/`docs/replatform-program`. So no PR can carry its verdict, and the verdict
   arrives only after the merge that could have been reconsidered.
2. **★ The `merge_group` trigger has NEVER FIRED.** Of the last 40 runs, `event` is `push` for
   **40/40** — zero `merge_group`. The repo does not use a merge queue, so the one declared
   pre-merge path in that workflow is itself a dormant clause. Anyone reading the trigger block
   would reasonably conclude the lane gates the merge queue. It gates nothing.

And the fact that decides §4: **`docs/replatform-program` has NO branch protection at all** —
`gh api repos/MeteoriteLabs/AoA/branches/docs%2Freplatform-program/protection` → `404 Branch not
protected`. `main`'s required-context set is exactly `["ci-required"]`.

## ★★ 4. The options, weighed against those measurements

This is the section the ticket exists for. Each option is judged on the same three questions:
does it make the verdict **read**, what does it **block**, and does it generalise to §2.

### Option A — promote `d1-merge-train` to a required check

**Rejected, and the measurements kill it three separate ways:**

1. On **`docs/replatform-program` — where the five-day window actually happened — there is no
   protection to add it to** (404). The option is a literal no-op on the affected branch.
2. On `main`, the lane never runs on `pull_request`, so a required context would leave every PR
   at *"Expected — Waiting for status"* forever. `CLAUDE.md` documents this exact trap ("a skipped
   required check leaves PRs stuck"), and it is the owner's stated concern: **a required check that
   runs post-merge blocks nothing on PRs while blocking the branch.**
3. It violates the repo's own HARD RULE #2, machine-enforced in `scripts/lib/ci-lanes.mjs`: *"NEVER
   an independently-required conditional job. Only `ci-required` is a branch-protection required
   check."* Adding a second required context would have to be exempted from a guard whose whole
   purpose is to prevent that shape.

The owner's instinct is therefore confirmed by measurement rather than by taste, which is why this
got a ticket instead of a settings change.

### Option B — run `d1-merge-train` on pull requests

**Partially useful; not the answer, and not free.**

- **What it genuinely adds:** it is the only option that catches an image-build break *before*
  merge. WRK-017's own first push proves the value — a `.gitignore`d file broke the checkout in a
  way no local run could see. (Though note: `policy` caught that one, not the image build.)
- **What it costs:** a 45-minute-timeout job that builds BOTH split images from source on every
  PR touching `docker/**`, `docker-compose.d1.yml` or `tests/d1/**`. WRK-017's PR pushed three
  times; it would have paid that three times.
- **★ Why it cannot be made cheap safely:** affordability requires a `paths:` filter, and a
  `paths`-filtered trigger on a job that is then required is precisely HARD RULE #1 in
  `ci-lanes.mjs` ("GitHub treats a skipped REQUIRED check as passing"). Left non-required, we are
  back at a verdict with no consumer — just an earlier one.
- **It does not generalise.** `cross-platform-weekly` is a `schedule`; there is no PR to hang it on.

**Disposition:** kept as a NAMED, DEFERRED companion (§8), not folded in. It is a different
trade-off (cost vs. earliness) from the one this ticket settles (production vs. consumption).

### Option C — a consumed watch inside `policy` that reads the last D1 verdict

Add a step to `pr.yml`'s `policy` job — which runs on **every** non-draft PR, has **no `changes`
gate** (`pr.yml:124-127`), and already feeds `ci-required` — that queries the latest completed
`d1-merge-train` run on the PR's base branch and fails when it is not `success`.

- **Pro:** it borrows the ONE required check that exists. No new required context, no rule-2
  violation, and it works on a branch with no protection because `ci-required` is still *reported*
  and the merge protocol already says to confirm it.
- **★ Con, and it is fatal in this form:** it makes MY PR red because SOMEBODY ELSE'S merge broke
  the lane. That is "blocking the branch" again, one level down, and it is the failure mode the
  owner named. During the 08-29 → 08-31 window every unrelated PR in the repo would have been red.
- Needs `actions: read`; `pr.yml` declares only `contents: read` today.

**Rejected in this form** — but its *mechanism* (a reader inside the already-required job) is
correct and is reused in §5 for a strictly narrower question.

### Option D — a scheduled reconciliation that files/updates an issue

A small scheduled workflow enumerates a declared set of non-required workflows, compares each
one's latest verdict and its age against a committed manifest, and opens/updates ONE deterministic
tracking issue when any is red, stale, or absent.

- **Pro:** workflow-agnostic (it catches `cross-platform-weekly`'s three blank weeks too), costs
  seconds, blocks nothing, and the manifest is a human declaration — the same inversion that makes
  `guard-inventory.json` and `test-execution-census.json` work: *verify the cheap direction against
  a declaration rather than infer the hard one.*
- **★★★ Con, and the design must not hand-wave it: the reconciler is itself an unconsumed,
  non-required workflow.** If it goes red — or gets `cancelled` for three weeks, exactly like
  `cross-platform-weekly` — nobody reads it either. Option D alone is the same bug one level up.

### ★ Option E (RECOMMENDED) — D, with the recursion terminated at the one required check

Split "consume" from "block", which is the move the whole ticket turns on:

- **Consuming** is Option D: the reconciler produces the artifact a human reads (an updated issue),
  within a bounded time of a non-`success` or uncovered verdict — per `(workflow, branch)` STREAM,
  never per workflow (§5.4).
- **Blocking** is a step in `policy` (Option C's mechanism) that asserts **the reconciler itself
  ran recently** — NOT that D1 is green. So:
  - a red D1 does **not** red an unrelated PR; it updates an issue,
  - a **silent** D1 — no reconciler run within the tolerated window — **does** red `policy`, and
    therefore `ci-required`.

**The gate is on the verdict having been READ, never on the verdict itself.** The recursion stops
because the terminating reader lives inside the only check branch protection already requires, and
that check runs on every PR by construction.

This is the same shape TRACK-002 chose for the same reason and is worth naming as precedent: do not
try to observe execution across workflow boundaries; declare it, and verify the cheap direction
from inside the job that always runs.

### ★ 4.1 Chained, never adjacent — the clause §1.1 instance 3 buys

Both moving parts of Option E can fail exactly the way that `git add` did, and neither failure is
visible from its own output:

- **In the reconciler:** the issue write must be **chained** to the evaluation — one fail-closed
  sequence — never two steps that merely appear in order. A reconciler whose evaluator throws while
  its write step still runs would post an empty or stale issue and read as a healthy consumer. In a
  single process that exits non-zero on a throw, that cannot happen; as two YAML steps without an
  explicit success condition, it can.
- **In the reader:** `policy`'s freshness step must fail the JOB, not merely print. A step that
  echoes a warning and exits 0 is instance 3 verbatim — a verdict computed, and the next thing
  running anyway.

Stated as a design clause because it is automatic in neither place, and because "we will remember to
chain it" is precisely the assurance that failed on 2026-09-03. §10 carries the tests.

## ★★ 5. Acceptance, stated in terms of the CONSUMER

An acceptance clause reading *"`d1-merge-train` passes"* would re-file the bug this ticket exists to
close. The clauses are therefore about the reader:

1. **A non-`success` or uncovered verdict produces a consumed artifact within a bounded time.** For
   every `(workflow, branch)` stream declared in the manifest, a latest completed run whose
   conclusion is anything other than `success` (§5.1), or a stream that is uncovered by the test
   its declared mode names (§5.2), causes the tracking issue to name that stream, its run URL and
   its conclusion, within one reconciliation interval.
2. ★ **The absence of consumption is itself detectable, and it is the ONLY thing that blocks —
   measured on the PUBLISH, never on the run.** `policy` fails when the tracking issue has not been
   **published to** within the reconciler's tolerated silence. It does **not** read the reconciler's
   run list. A red watched workflow never fails `policy`. See §5.3 for why the obvious phrasing —
   "the reconciler has not *completed*" — is wrong and reproduces this design's own bug.
3. **The manifest is complete by construction.** Every file in `.github/workflows/` carries at least
   one entry, and every branch a `push`-triggered workflow declares gets its own — watched, or
   explicitly not-watched with a reason that says what would have to change. Zero workflows
   discovered, or zero manifest entries, **fails** (anti-vacuity, house style).
4. **The bounds are committed numbers, not habits.** Per-stream mode + tolerance, and the
   reconciler's own tolerated silence, are values in the manifest, reviewable in a diff.
5. **It has been PROVEN to fire.** See §6 — every direction, against real non-green verdicts, before
   the ticket closes.

### ★ 5.1 The evaluator is SUCCESS-ONLY, never an enumeration of bad conclusions

**Reportable := the latest run is `completed` AND its `conclusion !== "success"`.** Not a list.

An earlier draft of this design listed `failure` / `cancelled` / `timed_out`. GitHub also terminates
runs as `neutral`, `skipped`, `stale`, `startup_failure` and `action_required`, and any of those
would have been read as "not reportable" — i.e. silently green.

★ **Why that list existed is the whole lesson, and it is measurable.** Across this repository's last
300 runs the conclusions produced are exactly `success` (178), `cancelled` (90), `failure` (29) and
in-progress (3). **The draft enumerated precisely the set this repo had happened to show me** —
`cancelled` is in it only because `cross-platform-weekly`'s three blank weeks taught it. An
enumeration built from encounter covers what its author met and misses the rest, which is the same
defect as a check that only fires on the failures someone already thought of. Inverting to
success-only removes the author's experience from the predicate entirely.

The test therefore exercises the **full** vocabulary, including the five conclusions this repository
has never once produced — because those are exactly the ones no future reader will think to add.

### ★ 5.2 Two staleness MODES, because wall-clock is wrong for a path-filtered workflow

`d1-merge-train.yml` declares a `paths:` filter of 18 entries (`.github/workflows/d1-merge-train.yml:36-57`).
So "no run in N hours" does **not** mean a verdict is missing — it usually means no push touched a
configured path. Reporting that would be worse than useless: **the only way to clear it is to force
a matching push**, which is an incident nobody can legitimately close — the mirror image of a gate
nobody can pass, and a shape this programme has already filed once.

Each manifest stream therefore declares its mode:

| mode | for | the question it asks |
|---|---|---|
| `coverage` | `push`-triggered streams | **Is the newest commit on this branch that matches the workflow's own `paths:` filter covered by a run?** A commit that should have triggered a run and did not, or whose run never completed, is the incident. Silence with no matching commit is **correct** and reports nothing. |
| `cadence` | `schedule`-triggered streams | Wall-clock against the declared cron interval times a tolerance. `cross-platform-weekly.yml` is exactly this — its three `cancelled` weeks are invisible to a coverage test and obvious to a cadence one. |

Both modes are needed, and neither substitutes for the other: coverage cannot see a schedule that
stopped firing; cadence cannot distinguish a quiet path from a broken lane. The `paths:` filter and
the cron are read from the **workflow file itself**, never re-declared in the manifest — one source
of truth, so a path added to the lane cannot drift from what the consumer tests.

**★ Validated on live data before this was built — 2026-09-03.** Hours after this section was
written, `b9ab89e36` (CLI-008 Unit D) merged to `docs/replatform-program` and produced **no
`d1-merge-train` run at all**: none of its files match the lane's 18-entry `paths:` filter. That
single event separates the two designs exactly:

- under a **wall-clock** rule it is a missing verdict — a reported incident whose only possible
  repair is forcing a push that touches a `docker/**` path, i.e. an incident nobody can honestly
  close;
- under **`coverage`** it is correctly **silent** — there is no matching commit, so there is nothing
  a run was owed for.

This is the strongest evidence in the section, and it is stronger than the reasoning it supports:
the reasoning predicted the case, and the lane then produced it, on the exact workflow this ticket
is about, within hours and without anyone arranging it.

### ★★★ 5.3 The heartbeat is chained to the PUBLISH, not to the run — this design's own §4.1

The obvious acceptance is *"`policy` fails when the reconciler has not completed recently"*. **It is
wrong, and it reproduces exactly the recursion this ticket exists to close.**

A reconciler that starts and then dies — a bad token, a rate limit, a throwing evaluator, an API
outage — still records a **recent completed run**. `completed` is not a synonym for `succeeded`, and
`succeeded` is not a synonym for `consumed`. Under that acceptance, `policy` stays green while
nothing whatsoever was read. The consumer would have a heartbeat that beats when it is dead.

**So the heartbeat is the consumed artifact itself.** The reconciler's LAST action is to publish the
tracking issue — rewriting a machine-readable `last-reconciled` marker (UTC timestamp + the run URL)
alongside the current findings. `policy` reads **that marker on that issue**, and nothing else:

- reconciler dies before publishing ⇒ marker is stale ⇒ **`policy` RED**, correctly;
- reconciler publishes and then fails on a later cleanup step ⇒ the verdict WAS consumed ⇒ green,
  correctly;
- everything green ⇒ the reconciler **still publishes**, so "nothing to report" is distinguishable
  from "did not run" — a reporter that goes quiet when healthy is indistinguishable from a dead one.

★ This is §4.1 applied one level up, and it is the same sentence as §1.1 instance 3: the signal must
be **chained** to the thing it claims, never adjacent to it. A run record is adjacent. A published
artifact is chained.

### ★ 5.4 The unit is a `(workflow, branch)` STREAM, not a workflow

`d1-merge-train.yml` declares `branches: [main, docs/replatform-program]`
(`.github/workflows/d1-merge-train.yml:33-35`). Reading "the latest completed run of this workflow"
repo-wide therefore lets a green on one branch **mask a red on the other** — and the masked branch
would be `docs/replatform-program`, which is where the five-day window this whole ticket is about
actually happened. A consumer that could not have reported the incident that motivated it is not a
consumer.

★ **Honest scoping, because overstating this would be its own defect:** it is **latent today**. All
25 recent `d1-merge-train` runs are on `docs/replatform-program` and **zero** are on `main`, so
there is currently no green to do the masking. It becomes live the moment anything lands on `main`
— which is the normal end-state of this programme, so it must be designed for now rather than
discovered then.

The manifest is therefore keyed on the stream, `d1-merge-train` carries two entries, and the
completeness check (§5 clause 3) parses each `push`-triggered workflow's own `branches:` list and
requires an entry per branch. Same inversion as everywhere else here: read the declaration that
already exists rather than maintain a second one beside it.

## ★★★ 6. The positive control — because a consumer nobody has watched fail is the same defect

This is not optional and it is not a unit test. Three controls, in increasing order of realism, and
the design commits to all three:

- **PC-1 — the pure evaluator, mutated.** The verdict decision is a pure function of
  `{conclusion, completedAt, now, maxAgeHours}`. Every arm gets a killed mutant: drop the
  `cancelled` arm (→ `cross-platform-weekly`'s real three weeks stop being reported), drop the
  staleness arm, drop the `timed_out` arm, invert the comparison. **Mutate each OR-ARM, not just
  the clause** — the standing E7-1 lesson, and the one that produced a survivor in WRK-015.
- **★ PC-2 — a REPLAY against recorded reality, not a fixture.** Point the evaluator at the real
  API records for `d1-merge-train` over 2026-08-25 → 2026-09-03 and assert it would have reported on
  **2026-08-29** and stayed reporting until `ee74f9c8c`. The input is the actual recorded history
  of the incident, so the control is against reality rather than against a hand-built object. A
  fixture-shaped positive control would be the very thing this ticket is about.
- **★★ PC-3 — the live end-to-end, both directions, and the repo hands us a genuine red for free.**
  1. *The consumer fires:* add `cross-platform-weekly` to the manifest as watched. It is
     **cancelled today, for real** — so the first reconciler run must open the issue naming it,
     with no lane deliberately broken and nothing degraded to arrange it.
  2. *The reader fires on silence:* set the reconciler's tolerated silence to a value the published
     marker already violates (or skip one publish on purpose) and show `policy` — and therefore
     `ci-required` — go **RED**, then restore.
  3. ★★★ *The reader fires on a reconciler that RAN AND FAILED* — the §5.3 control, and the one that
     would have caught this design's own bug. Inject a throwing evaluator so the reconciler starts,
     records a **recent completed run**, and never publishes. `policy` must still go **RED**. If it
     stays green, the heartbeat is measuring the run instead of the publish and the whole consumer
     is decorative. **This control is not optional and it is not a unit test.**

  **A guard that has never been made to fail is not reported as passing** — the standing rule this
  programme is built on, applied to the guard this ticket is buying.

## 7. Slice plan (lettered; each independently landable)

| Slice | What | Runs where | State when it lands |
|---|---|---|---|
| **A** | `scripts/workflow-verdict-manifest.json` (keyed on `(workflow, branch)` STREAMS, §5.4, each declaring `coverage` or `cadence`, §5.2) + a pure **success-only** evaluator (§5.1, `scripts/lib/workflow-verdict.mjs`) + `scripts/check-workflow-verdict-manifest.mjs` asserting every `.github/workflows/*.yml` has an entry AND every branch a `push`-triggered workflow declares has its own (anti-drift, the `check-guard-inventory` asymmetry). PC-1's mutation sweep lands here. | `policy` | **INERT** — it reports on the manifest's completeness only; it queries no live verdict and blocks nothing new |
| **B** | `.github/workflows/verdict-reconcile.yml` — `schedule` + `workflow_dispatch`, `actions: read` + `issues: write`. Reads each declared stream, applies the Slice-A evaluator, and — as its LAST, chained action — publishes ONE deterministic issue carrying the findings and the `last-reconciled` marker (§5.3), **always, including when everything is green**. PC-2's replay lands here. | its own workflow | **CONSUMING, non-blocking** |
| **C** | The terminating reader: a step in `pr.yml`'s `policy` asserting the freshness of the **published marker on the issue** — never the reconciler's run list (§5.3). Needs `issues: read` on `pr.yml`. PC-3(2) and PC-3(3) land here. | `policy` → `ci-required` | **BLOCKING — and only on unpublished silence** |
| **D** | Dispositions for §2's measured instances: `cross-platform-weekly` **watched** (and PC-3(1) is exactly that entry's first run); `release-smoke` **not-watched, with a reason** (dormant callee of a disabled `release.yml`); the `disabled_manually` pair **not-watched, with a reason**. Every not-watched entry states what would have to change — a reason is not an excuse. | manifest | declarative |
| **E** | Docs: `GO-BOOK.md` §1.9.8 repointed from "check the lane after every merge" (a habit) to the consumer (a mechanism); `HANDOFF-orchestration.md`'s merge protocol updated to say what a builder should now expect to see. | docs | — |

★ **A and B are safe to land alone; C is the one that can block, so it lands last and only after
PC-3(2) has been demonstrated.** That ordering is deliberate: a blocking reader wired before its
own failure mode has been observed would be this ticket committing its own sin.

## 8. Out of scope, named

- **Option B (D1 on PRs)** — a real, separable trade-off (cost vs. earliness). Deferred with its
  measurements in §4 so a future sprint can decide it on evidence rather than re-derive them.
- **Fixing `cross-platform-weekly`'s cancellations or `release-smoke`'s 131-day-old red.** DEP-013
  makes them VISIBLE; making them green is each lane's own work. Conflating "report it" with "fix
  it" is how a reporting ticket becomes unlandable.
- **A merge queue.** The dormant `merge_group` trigger (§3) is a real finding about the workflow's
  self-description, not a proposal to adopt one here.
- **Any change to what `d1-merge-train` itself runs.** Untouched by this ticket.

## 9. Two residuals inherited from WRK-017, and where each belongs

### 9.1 The deps-stage closure class → **its own finding, NOT DEP-013**

E6-F010's residual: `check-image-deps-stages.mjs` compares the deps stage's COPY set against the
**production** closure (`computeRuntimeClosure` walks `.dependencies` alone, by design), while the
build stage's `pnpm --filter "pkg..."` traverses **devDependencies too**. Any future workspace
devDependency added to `server` or `ui` re-widens the build selection with nothing warning; WRK-017's
build-stage re-install absorbs it, but does not detect the divergence.

**Filed as E6-F012** (`open`, MED, `unowned` with a reason) rather than folded in, on three grounds:
it is a **different mechanism** (a static closure guard, not a verdict consumer); it is small and
self-contained; and bundling would make DEP-013 about two unrelated things — the precise scope
error the E6 register already carries findings about. Note the two relate but do not overlap:
DEP-013 makes the *next* occurrence loud within a bounded time; E6-F012's successor would stop it
being possible. Neither substitutes for the other.

### 9.2 The LOCAL pre-push filter's gaps → **standing rules, not a ticket** (three of them now)

None is a DEP-013 concern — they are the *local* filter, not a CI verdict — but all three are the
same species as §1.1 instance 3 (a signal whose result the next step does not depend on, or cannot
tell apart from silence), so they are routed here rather than dropped.

**(a) `ci-local.mjs` does not run the vitest shards.** This bit WRK-017 once (a worker-daemon test
that PARSES `docker-compose.d1.yml` went red in `verify (4)` after the local gate was green), and by
the coordinator's account it has now bitten **twice**.

**(b) ★ `git rerere` on `scripts/finding-ownership.json`.** Measured 2026-09-03 (§1.1 instance 3):
four branches touched that file in one day, so the rerere cache is trained on exactly the conflicts
the next rebase will hit, and a replayed stale resolution produced invalid JSON that a running
validation caught and an unchained `git add` ignored. The rule is not "validate after rebasing" — it
is **chain the validation to the add with `&&`, never two lines**. That one operator is the whole
difference between instance 3 and a non-event.

**(c) ★ A `CONFLICTING` PR gets NO `pr.yml` run at all — and from outside it is indistinguishable
from CI lag.** Measured on this ticket's own PR: the base moved, GitHub reported
`mergeable=CONFLICTING`, and **zero checks appeared on two consecutive pushes**. GitHub cannot
compute a merge commit for a dirty PR, so the workflow never starts — there is no queued run, no
pending check, and no error anywhere: the PR simply looks slow. The rule for a builder or an
orchestrator watching a pushed sha: **no verdict may mean CONFLICT, not lag, and the two look
identical.** `gh pr view <n> --json mergeable,mergeStateStatus` distinguishes them in one call, and
is worth reaching for before spending a watch. (It cost two watches elsewhere on 2026-09-03.)

★★ **That call has a trap of its own, and it is the same class again — measured on this ticket's own
rebase push.** GitHub computes mergeability **asynchronously**, so immediately after a push
`gh pr view` returns the **previous** tree's answer: seconds after force-pushing `c163df5b2` it still
reported `headRefOid=f5b02cd7a`, `CONFLICTING`, `DIRTY` — the verdict for the commit that had just
been replaced. Following the advice above verbatim, an orchestrator would have concluded the rebase
had not fixed anything. **Always request `headRefOid` alongside, and treat `mergeable` as meaningless
until it equals the sha you pushed:**

```
gh pr view <n> --json headRefOid,mergeable,mergeStateStatus
```

A stale verdict presented as a current one is exactly this ticket's subject, so publishing the
one-call advice without this caveat would have shipped the defect inside the fix for it.

★ **And the corollary, which says WHERE to spend the reading:** a conflict in a field a guard checks
fails **loudly**; a conflict inside **free text** fails **silently**. Both of this ticket's rebases
hit `scripts/finding-ownership.json`, and they were not the same risk:

| conflict | field | if resolved wrong |
|---|---|---|
| `E6-F012` vs `E7-F012` — two entries appended at one position | a guarded key: `findings.<id>` | **loud.** Dropping either leaves its finding `open` and undeclared, and `check-finding-ownership.mjs` fails with `undeclared_finding` |
| JOB-015's `agent_runtime_decisions.ts:21-22` → `:22-23` correction | **inside a `reason` STRING** | **silent.** No guard reads the prose. A stale rerere replay would have reverted a citation with every check green |

Chaining the validation to the `git add` stays a blanket rule — it is one operator and it costs
nothing. But knowing which hunks are structurally silent is what tells you **where to read the
resolved diff line by line rather than trust the guards to catch it**: a guarded key needs the
chain; free text needs your eyes.

**Measured mechanism, so the routing decision is on evidence:** `ci-local.mjs`'s default is
`FAST_JOBS = ["policy","brand-check","worker-protocol-contract-bytes","lint"]` — `verify` is not
*skipped*, it is **never selected**, so it never enters the `skipped` array and the summary's own
honest warning (*"★ Skipped jobs are NOT green. Linux CI remains the authority for them."*) **never
fires for it.** The tool is truthful about skips and silent about non-selection.

Three cheap homes, and this design recommends all three:

1. **The builder-facing standing rules** (`HANDOFF-orchestration.md`'s per-track prompt) — two lines:
   *"`ci-local.mjs` runs the FAST gate only. It does not run `verify`; if you touched anything a
   vitest spec reads — including non-TS files a test parses — run that package's suite."* and
   *"after any rebase or conflict resolution in `scripts/finding-ownership.json`, CHAIN the JSON
   parse to the `git add`; `git rerere` is trained on that file's conflicts."*
2. **A one-line tooling fix** (whoever next touches the file): print the unselected jobs in the
   summary beside the skipped ones, so the existing "NOT green" warning covers them. Not a ticket
   on its own; a rider on the next `scripts/` change.
3. ★ **The sound version of (b), when someone is in `scripts/` anyway:** make
   `check-finding-ownership.mjs` refuse a `finding-ownership.json` that does not parse, so the
   guard's own input cannot be committed broken. That converts a rule a human must remember into a
   chain a machine enforces — which is exactly what §1.1 instance 3 argues for. Named, not claimed:
   DEP-013 does not build it.

## 10. Tests

| Area | Test |
|---|---|
| Manifest completeness | a workflow file with no manifest entry **fails** |
| A reason is not optional | a `not-watched` entry with an empty reason **fails** |
| Anti-vacuity | zero discovered workflows, or zero manifest entries, **fails** |
| ★ Success-only vocabulary (§5.1) | EVERY completed conclusion other than `success` is reported — `failure`, `cancelled`, `timed_out`, `neutral`, `skipped`, `stale`, `startup_failure`, `action_required` — **including the five this repository has never produced**, since those are the ones no future reader will think to add. A mutant that reverts the predicate to an enumeration is killed by them |
| ★ Coverage mode (§5.2) | a branch whose newest `paths:`-matching commit has no run is reported; a branch that is merely QUIET (no matching commit) reports NOTHING — the second half is the one that stops an incident nobody can close |
| ★ Cadence mode (§5.2) | a schedule past its interval × tolerance is reported, `cross-platform-weekly`'s real `cancelled` weeks among them; a coverage-mode evaluator over the same input must NOT report them (proving the modes are not interchangeable) |
| ★ Streams, not workflows (§5.4) | a green on one branch does NOT mask a red on the other, over a two-branch fixture built from `d1-merge-train`'s own declared `branches:` |
| Manifest branch completeness | a `push`-triggered workflow with an entry for only one of its declared branches **fails** |
| Green is silent | an all-`success` sweep reports no findings — but STILL publishes the marker (§5.3), so quiet-and-healthy stays distinguishable from dead |
| Replay (PC-2) | the recorded 08-25 → 09-03 `d1-merge-train` history reports from 08-29 and stops at `ee74f9c8c` |
| Issue idempotency | two consecutive reconciliations over the same red state update ONE issue, never open a second |
| Reader (PC-3.2) | `policy` fails when the reconciler's last completion is older than its tolerated silence; passes when it is not |
| Reader is narrow | `policy` does NOT fail merely because a watched workflow is red — proven with a genuinely red watched entry present |
| ★ Chained, not adjacent (§4.1) | a reconciler whose EVALUATOR throws must write NO issue and exit non-zero — proven by injecting a throwing evaluator and asserting both. The §1.1 instance-3 shape, tested in this ticket's own code |
| ★★★ Heartbeat measures the PUBLISH (§5.3) | a reconciler that RAN, COMPLETED and never published must still fail the reader — the control that would have caught this design's own first draft. Asserted against a fixture whose run record is recent and whose marker is not |
| ★ The reader FAILS, never warns | the `policy` freshness step exits non-zero on stale — asserted on the EXIT CODE, not on its stdout |
