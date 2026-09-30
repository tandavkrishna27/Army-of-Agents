# foundation-suite-unrun — RESULT

**Epic:** E11 (Hardening & Release) · **Sprint:** S9 hardening unit (S9-3) · **Type:** test-repair + CI-wiring
**Start SHA (design commit):** `13f85ec03` · **Worktree** `C:\e3`, **branch** `docs/replatform-program`
**Slug is graph-INERT** (`expandTicketIdsFromFilename("foundation-suite-unrun-…") → []`).

**One-line outcome.** The foundation checker's own 182-test mutation suite
`scripts/check-distributed-execution-foundation.test.mjs` now runs in the CI `policy` job, so the
checker's guards are enforced **against regression** (a running test), not merely **at rest** (the
CLI). This closes REL-FOUNDATION-GATE §0h ("enforced-at-rest, **not** against-regression"). The unit
is a scoped `.gitattributes eol=lf` pin + one CI run line + one census flip — **no runtime code, no
test-logic change, no migration; `packages/worker-protocol` untouched (FROZEN).**

---

## 0. STEP 0 — the premise, re-verified at tip

The design was written at tip `54a955f29`; the only commit since is the design commit itself
(`13f85ec03`), and **no target file changed** between them, so every cited span still held. Re-verified
on this Windows worktree (`core.autocrlf=true`):

- **As-is (CRLF working tree):** `node --test …foundation.test.mjs` → **tests 182 · pass 179 · fail 3**.
  The three failures are exactly the design's §0a set (`## Worked journeys` heading, `Source history`
  authority row, `additionalProperties:false` schema close), each an `assert.notEqual(mutated,
  original)` self-check that fires *before the checker runs* because the LF find-string never matches
  the CRLF fixture bytes. The captured `actual`/`expected` were full of `\r\n` — hard proof of CRLF.
- **LF proof (converted the 3 mutate sources to LF, ran, reverted with `git checkout --`):** the suite
  went **182 · pass 182 · fail 0**. **No non-CRLF failure appeared** → the §0d STOP did not trigger;
  the premise ("all 3 failures are one CRLF class; the suite is 182/182 green under LF, the form Linux
  CI checks out") holds.

`git ls-files --eol` confirmed all 8 `docs/architecture/distributed-execution-*` and all 11
`tests/fixtures/distributed-execution/*` are `i/lf w/crlf attr/` at tip (index LF, working-tree CRLF,
no eol rule) — the exact state §0b describes.

---

## 1. Root cause — CRLF working tree vs LF find-strings (correcting a live misdiagnosis)

The suite was **not** red because of a buggy helper. `makeFixture` copies the fixtures/architecture
docs byte-for-byte into a temp `--root` and the mutate callbacks do `content.replace("…\n…", …)`. On a
Windows checkout those files materialize **CRLF** (they carry no `eol` rule and `core.autocrlf=true`),
so the LF find-strings are no-ops. The checker itself is CRLF-tolerant (`split(/\r?\n/)` everywhere),
which is why **179/182 passed on Windows and 182/182 under LF** — only the three naive
`String.replace(LF, …)` mutate helpers care about line-endings.

**The misdiagnosis this unit corrects.** Both `test-execution-census.json`'s `unrun` reason and
REL-FOUNDATION-GATE §0h said the suite was red because "its own `makeFixture` mutation helper is a
no-op" / "one schema-mutation case … whose helper is a no-op." That is wrong on three counts: the
helpers are correct; it is **three** cases, not one; and the cause is the **working-tree line-endings**,
not the code. Correcting it is what reshapes the unit from "fix a broken helper" into "pin the
fixtures' line-endings + wire the suite in."

---

## 2. The three things that landed

### (a) PIN — scoped `.gitattributes eol=lf` (Option A)

Appended two scoped rules (with a comment explaining the mechanism):

```
tests/fixtures/distributed-execution/** text eol=lf
docs/architecture/distributed-execution-* text eol=lf
```

- Covers **both** surfaces the three failing mutates read from: the fixtures dir (test #3 + all 11
  fixtures) and the `distributed-execution-*` architecture-doc family (tests #1/#2 read
  `-lifecycles.md` / `-authority.md`; 8 files). A `tests/fixtures/**`-only pin would have fixed only
  test #3.
- **Deliberately NOT pinned:** `decisions.md` / `program-design.md` / `current-main-crosswalk.md` and
  the `server/src/**` sources `makeFixture` also copies — no current mutation uses an embedded-`\n`
  find against them, the checker reads them CRLF-tolerantly, and the repo's precedent is per-need
  pinning, not repo-wide normalization.
- **Zero committed content delta.** The index was already LF for all 19 files, so
  `git add --renormalize` staged **no** doc/fixture bytes — `git diff --cached --stat` shows only
  `.gitattributes` (11 insertions). The working tree was then converted to LF in place so the suite is
  green on Windows-local; `git check-attr eol` reports `lf` and `git ls-files --eol` reports `w/lf` for
  all 19. **This changes only Windows working-tree bytes — Linux CI already checks out LF, so on the
  `policy` runner the pin is a no-op.** It is not what makes `policy` pass; its value is Windows-green,
  an honest cross-platform `runs` flip, and documenting the root cause.

### (b) WIRE — the suite into the `policy` job

Converted the existing single-line foundation step in `.github/workflows/pr.yml` to block form,
matching every sibling checker (which pair CLI + `.test.mjs` in one step):

```yaml
      - name: Distributed execution foundation contracts
        run: |
          node scripts/check-distributed-execution-foundation.mjs
          node --test scripts/check-distributed-execution-foundation.test.mjs
```

The step **`name` is byte-identical** to before ("Distributed execution foundation contracts"), so the
census key stays stable. (There is a *second*, differently-named step
"Distributed-execution foundation + fixture-determinism contracts" in a heavier job that also runs the
CLI — it was **not** touched; the census keys on the exact step name, which is unique.) YAML validated;
the parsed step `run` is exactly the two node lines.

### (c) FLIP — the census entry, same commit as the wiring

`scripts/test-execution-census.json` for the suite → `{status:"runs", workflow:"pr.yml",
step:"Distributed execution foundation contracts"}`; the stale/misdiagnosed `reason` is dropped (a
`runs` entry needs none). The census contract resolves `"pr.yml::Distributed execution foundation
contracts"` to the step's `run:` block, strips comment lines, and requires it to `.includes(<path>)` —
which the new `node --test …test.mjs` line satisfies. `check-execution-census.mjs` → **OK (50 declared
running, 3 declared unrun)** — up from 49/4.

---

## 3. Sequencing (C1) — proven green-before-wiring via a `ready_for_review` proving PR

`docs/replatform-program` is the shared working branch (head of the WIP PR #323 → `main`). The wiring
makes the suite a **required** signal via `ci-required.needs: [… policy …]`, so it must not reach the
shared tip until a real Linux `policy` run is observed green. `policy` is **draft-gated**
(`if: … || !github.event.pull_request.draft`), so a draft PR would render it **skipped = phantom
green** — defeating the gate. Therefore the change landed through a **proving PR marked
`ready_for_review`** (so `policy` actually runs), never a direct push of the wiring. Two commits:

1. **Commit 1** — the `.gitattributes` pin + working-tree renormalization. Provably inert: no CI wiring,
   no committed content delta (index already LF). A Linux no-op.
2. **Commit 2** — the `pr.yml` wiring + the same-commit census flip + the C2 tracker corrections + this
   result doc. Because Commit 1's pin is a Linux no-op, Commit 2's own `policy` run reflects the suite's
   *true* Linux state; a red run blocks the PR and never reddens the shared tip.

Both commits ride the one proving PR (base `docs/replatform-program`), which is strictly safer than a
pre-proof push to the shared branch and yields the identical Linux proof (the pin is a Linux no-op
either way).

---

## 4. Fail-first + positive control

- **Fail-first RED→GREEN, all three, and they actually mutate.** Before the pin: the three self-checks
  fail *before the checker runs*. After Commit 1: each passes individually
  (`--test-name-pattern` per test) and the whole suite is **182/182** — i.e. the mutate now changes the
  fixture (the `assert.notEqual` self-check passes) **and** the checker then emits the expected error
  (`missing heading "## Worked journeys"` / `authority matrix is missing the required row for state
  "Source history"` / `object schema at # must set additionalProperties:false`).
- **Positive control — the wired suite catches a real checker-guard regression.** On a byte-exact
  throwaway copy of the checker (restored, not committed), deleting each guard's emitter reddened its
  now-running test:
  - delete the heading-loop emitter → `'## Worked journeys'` test **RED** (1 fail);
  - delete the `Source history` authority-row emitter → `authority-matrix row` test **RED**;
  - delete the `additionalProperties:false` object-closure emitter → `non-closed object` test **RED**.
  After restore, the suite is **182/182** and `git diff` on the checker is empty. This is the whole
  point: once wired, a re-vacuation of a checker guard is caught by a **required** `policy` signal.

---

## 5. Registers — only `execution-census` moved

All eight ran green (exit 0):

| Register | Result | Moved? |
|---|---|---|
| `check-gate-clause-wiring.mjs` | OK (5 wired, 9 dormant) | No — slug graph-inert, no clause |
| `check-finding-ownership.mjs` | OK (13 open; unowned E10-F001/E11-F001/E4-F013/F014/F015) | No |
| `check-ticket-graph-coverage.mjs` | OK (97 ids, all present) | No — slug graph-inert |
| `check-guard-inventory.mjs` | OK (40 guard scripts) | No — no new `check-*.mjs` |
| `check-test-inventory.mjs` | OK (2657 test files) | No — no new `*.test.mjs` |
| `check-execution-census.mjs` | OK (50 running, 3 unrun) | **Yes — the intended flip (was 49/4)** |
| `check-dependency-graph.mjs` | OK (pre-existing CM-008/009/012 declared gaps) | No |
| `check-ci-lanes.mjs` | OK (DEP-004 contract satisfied) | No |

`.gitattributes` is tracked by no register. Foundation checker CLI at rest: `distributed execution
foundation: PASS`.

---

## 6. C2 — trackers closed, root cause corrected

The "makeFixture helper is a no-op" / "`additionalProperties` mutate no-op" misdiagnosis was corrected
everywhere it lived as a **current** claim, in the same work:

- **REL-FOUNDATION-GATE §0h** — RESOLVED banner added; root cause corrected to CRLF; original
  paragraph kept as the record of the misdiagnosis it corrects.
- **GO-BOOK §1.5** — the BUILDABLE-NOW item marked ✅ shipped with the corrected root cause; the DONE
  list + sprint list gain `foundation-suite-unrun` / `S9-3`; the forward-timeline line and the
  residual-narrative item reference updated.
- **GO-BOOK §5** — the "foundation suite unrun" debt row removed from the carried-debt table and
  recorded in the Retired section (correcting its diagnosis on retirement).
- **GO-BOOK §3.1** — a `9 (unit 3)` shipped row added.
- **The other residual narratives** (C2's "residual narratives", plural) — the completeness reviewer
  caught two live-as-true survivors my first sweep missed and one frozen artifact; all three corrected:
  the §3.1 `9 (unit 1)` REL-FOUNDATION-GATE row's "Residual named, not folded in (§0h)" clause (now
  "★ now RESOLVED by S9-unit-3"), the §4 "Residual named by the review" prose (now "✅ RESOLVED (S9-3)"),
  and a **superseded** banner above the frozen §9 unit-1 copy-paste prompt (which necessarily still
  quotes the old framing verbatim).

A final adversarial grep confirms no present-tense "suite is `unrun`" or live "mutate no-op" claim
survives in the changed docs — every remaining occurrence is either my correction, a `NOT …`
clause, the kept-verbatim record, or the frozen prompt under its superseded banner. The census `reason`
was dropped by the `runs` flip (no leftover key).

---

## 7. Adversarial review (on the IMPLEMENTATION)

A **3-agent pass on the shipped implementation** (not the design — the design had its own 2-agent pass):

- **Byte-consistency / no-register-moved reviewer — CLEAN, 0 defects.** Independently enumerated every
  literal-`\n` mutate find in the whole 182-test corpus and confirmed **exactly three**, each targeting
  a pinned file; the regex-based row deletions are CRLF-tolerant, so unpinned files legitimately need no
  pin. Confirmed zero committed content delta (all 19 files `i/lf`; only `.gitattributes` carries code),
  the step name byte-identical, the second same-CLI step untouched, YAML valid, and **only
  `execution-census` moved** (guard-inventory 40, test-inventory 2657 unchanged). `.gitattributes`
  referenced by no register.
- **"Can the wired suite red `policy` on Linux" skeptic — SAFE (0 non-CRLF red paths).** Ran the suite
  under this box's *mixed-EOL* tree (pinned LF + unpinned CRLF — strictly more adversarial than Linux's
  uniform LF) → 182/182. Verified hermeticity (no network / timers / randomness / `process.platform` /
  env / case-sensitivity / readdir-order / CR-literal dependence), correct block-form exit-code
  propagation, ~10–12 s runtime (well under the 5-min `policy` budget), and a Linux-inert pin. One
  non-blocking note: this step now dominates the `policy` job's runtime, and each future FND mutation
  adds a full-fixture-copy.
- **Positive-control + trackers completeness critic — positive control GENUINE; found 1 MED (fixed).**
  Independently reproduced the positive control (byte-exact backup/restore): deleting each of the
  heading / authority-row / additionalProperties guard emitters reds its now-running test, and the reds
  are caused by the missing guard emission (self-checks confirmed present + passing), not vacuous
  mutates; checker restored byte-exact, suite 182/182. **MED finding:** my first tracker sweep left the
  misdiagnosis live-as-true in two more GO-BOOK spots (the §3.1 unit-1 row + the §4 "Residual named by
  the review" prose) plus a frozen §9 unit-1 prompt (LOW). **All three fixed** (see §6); a follow-up
  grep confirms no live survivor remains. This is exactly the class of gap C2's "residual narratives"
  (plural) pointed at, and exactly why the review step exists.

No HIGH/BLOCKING; the one MED was a doc-hygiene gap, fixed in this same work; the STEP-0 STOP condition
(a real non-CRLF Linux failure) did not arise.

---

## 8. Acceptance

| # | Criterion | Status |
|---|---|---|
| 1 | Suite green on Windows | ✅ 182/182 after the pin |
| 2 | Suite green on Linux (proven, not assumed) | ✅ the proving PR's ([#328](https://github.com/MeteoriteLabs/AoA/pull/328)) `policy` job ran the wired suite on `ubuntu-latest`: the 3 formerly-CRLF tests ✔ pass and `tests 182 · pass 182 · fail 0` (run `33093021826`, policy job `98590600858`); full `code=true` suite + `ci-required` green |
| 3 | Each of the 3 mutate self-checks actually mutates | ✅ per-test green; RED→GREEN watched |
| 4 | Wired into `policy`, required via `ci-required` | ✅ step names the path; `ci-required.needs` includes `policy` |
| 5 | Census flipped + byte-consistent, same commit | ✅ `runs`/`pr.yml`/exact step; census checker green |
| 6 | No other register moves | ✅ only execution-census |
| 7 | Regression coverage proven | ✅ positive control reds each deleted guard |
| 8 | Committed content diff minimal | ✅ only `.gitattributes` + `pr.yml` + census JSON carry code; docs are docs |

---

## 9. What I got wrong / notes

- The design's §2 recommends landing Commit 1 directly on the shared branch first. Because PR #323 is
  open and **non-draft**, a direct push to `docs/replatform-program` would run `policy` *after* the
  change is already at the shared tip — the exact hazard C1 guards against. Riding both commits on the
  one `ready_for_review` proving PR keeps the wiring off the shared tip until proven, and (since the pin
  is a Linux no-op) gives the identical Linux proof. Recorded here so the deviation is not read as an
  oversight.
- Line numbers in `.mjs`/`.yml`/`.json` were re-read at execution start; none had rotted (only the
  design commit landed since the design tip).

## 10. Landing

Two commits landed on `docs/replatform-program` via the proving PR
[#328](https://github.com/MeteoriteLabs/AoA/pull/328) (rebase-merge, so the shared-branch SHAs differ
from the branch SHAs): `630e7e9d5` (the pin) then `0a093e6ae` (the wiring + census flip + docs +
result). The PR's full `code=true` suite was green — `policy` 1m15s, all four `verify` shards, `e2e`
16m29s, `e2e-pgvector`, `migrations`, `lint`, `brand-check`, `browser`, both `worker-protocol-contract-bytes`
platforms, and `ci-required` — with `distributed-contract` class-gated to skip. No non-CRLF failure;
the STEP-0 determination is confirmed on a real Linux runner.
