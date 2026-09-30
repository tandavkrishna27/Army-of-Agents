# foundation-suite-unrun — DESIGN

**Epic:** E11 (Hardening & Release) · **Sprint:** S9 hardening unit · **Type:** test-repair + CI-wiring
**Slug is graph-INERT** (like `REL-FOUNDATION-GATE`): `expandTicketIdsFromFilename("foundation-suite-unrun-design.md")` → `[]`
(verified live via `scripts/lib/ticket-graph-coverage.mjs:41-48` — the regex requires `^[A-Z]{2,5}-\d{3}` and this slug starts lowercase). **No `program-design.md` node is required for this filename.**

**Worktree** `C:\e3`, **branch** `docs/replatform-program`, **tip** `54a955f29` at read time. Every source claim below
carries `path:line`. **Line numbers in `.mjs`/`.yml`/`.json` rot — re-read each cited span at execution start and
correct §0 in place before touching anything.**

**One-line goal.** Make the foundation checker's own mutation suite
`scripts/check-distributed-execution-foundation.test.mjs` green on **all** platforms and run it in the CI `policy`
job, so the checker's guards are enforced **against regression** (a running test), not merely **at rest** (the CLI).
This closes the residual `REL-FOUNDATION-GATE-design.md:81-102` (§0h) named "enforced-at-rest, **not**
against-regression."

---

## ★★ Review round 2 (orchestrator) — two corrections to fold in at execution

A 2-agent review (reviewer + combined skeptic/completeness) verified the design: **0 defects, wiring
safe** (skeptic REFUTED every red-risk — the suite is hermetic, no CRLF-only find, ~10 s under the
5-min `policy` budget, zero-content renormalization) and **the regression coverage is REAL** (the 3
repaired tests assert specific checker-guard emissions; deleting any guard reds its now-running test —
positive control confirmed from source). Independently, the orchestrator proved **the full suite is
182/182 green under LF sources** (Linux-equivalent), so wiring cannot red `ci-required`. Two additions:

- **C1 (HIGH — the safeguard has a draft-PR hole).** §2's proof-gate rests on "no wiring reaches the
  shared tip until a Linux `policy` run is observed green." But `policy` is **draft-gated**
  (`pr.yml` `if: … || !github.event.pull_request.draft`), so a **draft** proving-PR renders `policy`
  **skipped** = skip-as-success (the exact trap CLAUDE.md's CI section warns of) — a phantom green that
  defeats the STOP gate. **The proving PR MUST be marked `ready_for_review` so `policy` actually runs**
  before Commit 2 merges. Add this as an explicit execution precondition alongside the §0d STOP.
- **C2 (MED — close the trackers + correct the root-cause misdiagnosis).** This unit's landing must not
  leave the "makeFixture helper is a no-op" misdiagnosis alive. In the SAME work, correct + close:
  (a) `REL-FOUNDATION-GATE-design.md` §0h — mark the residual RESOLVED, root cause = **CRLF working
  tree vs LF find-strings**, not a helper bug; (b) `GO-BOOK.md` — the BUILDABLE-NOW row (§1.5 status
  block) that still says "repair the `additionalProperties` mutate no-op", the §5 debt row
  "foundation suite unrun", and the residual narratives — mark shipped and correct the root cause. Add
  these to §6 "Files touched". (The census `reason` is dropped by the `runs` flip — no leftover key.)

Everything else in the design is verified against source at tip `54a955f29`. Advisory (non-blocking,
do NOT act): `current-main-crosswalk.md` is the sole unpinned `makeFixture` source with `\n` mutates
(all CRLF-tolerant regexes today) — a future footgun only if a plain-string `\n` find is added there.

---

## ★ 0. Verified state at tip

Everything here was read at `C:\e3` / `docs/replatform-program` / tip `54a955f29`.

### 0(a) — The suite is RED on Windows-local with **exactly 3 failures, all one class**

Live run on this Windows worktree:

```
node --test scripts/check-distributed-execution-foundation.test.mjs
→ tests 182 · pass 179 · fail 3   (exit 1)
```

The three failures, all of the identical mechanism (a mutate callback whose find-and-replace is a **no-op**, so the
`assert.notEqual(mutated, original, …)` self-check fires **before** the checker is even invoked):

| # | Test (`…foundation.test.mjs`) | Mutate find-string | File the mutate reads |
|---|---|---|---|
| 1 | `missing required Markdown heading: '## Worked journeys' removed` (`:316-325`, mutate `:319`) | `"\n## Worked journeys\n"` | `docs/architecture/distributed-execution-lifecycles.md` (`mdPath`) |
| 2 | `authority mutation: a missing authority-matrix row fails` (`:358-371`, via `patchText` `:330-335`, find `:362`) | `"| Source history | … metadata |\n"` | `docs/architecture/distributed-execution-authority.md` (`authorityPath`) |
| 3 | `schema: a non-closed object (missing additionalProperties:false) fails` (`:1208-1218`, mutate `:1212`) | `'  "additionalProperties": false,\n'` | `tests/fixtures/distributed-execution/schema-v1.json` (`schemaFile`) |

The captured `AssertionError` for #2 and #3 shows both `actual` and `expected` full of `\r\n` — hard proof the copied
fixture bytes are CRLF and the LF find-strings never match. All three find-strings are the **only** embedded-`\n`
mutate-finds in the suite (exhaustive grep: `\n"` matches → `:319`, `:362`; `\n'` matches → `:1212`; every other
`\n` hit at `:173/:778/:876/:885/:1633-1662/:1684/:1838` is a `report()`/`join()`/write helper, not a fixture-read-then-replace).

### 0(b) — Root cause: CRLF working tree vs LF find-strings (NOT a buggy helper)

`git ls-files --eol` at tip:

| Path | index / working / attr |
|---|---|
| `tests/fixtures/distributed-execution/*` (all 11) | `i/lf  w/crlf  attr/` (no eol rule) |
| `docs/architecture/distributed-execution-*` (all 8, incl. `-lifecycles.md`, `-authority.md`) | `i/lf  w/crlf  attr/` (no eol rule) |
| `tests/fixtures/distributed-execution/schema-v1.json` | `i/lf  w/crlf  attr/` |
| `scripts/check-distributed-execution-foundation.test.mjs` | `i/lf  w/lf  attr/text eol=lf` |
| `scripts/check-distributed-execution-foundation.mjs` | `i/lf  w/lf  attr/text eol=lf` |

The **test file and checker are pinned LF** by the existing `.gitattributes:71` rule `scripts/**/*.mjs text eol=lf`.
The **fixtures and the foundation architecture docs have NO eol rule**, so on a Windows checkout with
`core.autocrlf=true` they materialize as **CRLF**. `makeFixture` (`…test.mjs:68-161`) copies these files **byte-for-byte**
(`fs.copyFileSync`/`fs.cpSync`, `:113-158`) into the temp `--root`, so the temp copies are CRLF too. A mutate that does
`content.replace("…\n…", …)` against CRLF bytes finds nothing → no-op → self-check fails.

**This is not a helper bug.** The find-strings are correct for an LF tree. **Both the census reason
(`test-execution-census.json:60`) and `REL-FOUNDATION-GATE-design.md:85-87` (§0h) misdiagnosed it** as "its own
`makeFixture` mutation helper is a no-op" / "one schema-mutation case … whose helper is a no-op." The helper is fine;
the *working-tree line-endings* defeat it. §0h also under-counted (it saw only the schema case; the census reason says
"141 tests"; live is now **182 tests / 3** CRLF no-ops — the suite grew and two more embedded-`\n` mutations were added
since 2026-08-24). Correcting this misdiagnosis is what reshapes the unit from "fix a broken helper" into "pin the
fixtures' line-endings."

### 0(c) — The checker itself is CRLF-tolerant; only the TEST mutate helpers are not

The checker reads and validates EOL-tolerantly:

- Every line-scan uses `split(/\r?\n/)`: `…foundation.mjs:286, :305, :576, :598, :2765`.
- Heading guard (`:2762-2773`): splits on `/\r?\n/`, `l.trim()` (strips trailing `\r`), set-membership vs
  `REQUIRED_MD_HEADINGS` which contains `"## Worked journeys"` (`:107`). CRLF-tolerant.
- Authority matrix + `"Source history"` row (`:231`): parsed via `split(/\r?\n/)` then `split("|")`. CRLF-tolerant.
- Schema `additionalProperties:false` guard (`:1449-1450`): operates on `JSON.parse` output, EOL-irrelevant.

This is why `valid: the real repository passes with zero errors` (`:176-179`) and the other **179** cases are **green
on Windows today** — the checker doesn't care about CRLF; only the three naive `String.replace(LF, …)` mutate helpers do.

### 0(d) — Determination: the suite is (all but certainly) ALREADY GREEN on Linux — proof owed before wiring

Reasoning:
1. On Linux CI, `core.autocrlf` is off → a fresh checkout materializes the fixtures/docs as **LF** (their index form).
   The three LF find-strings then match → the mutations fire → tests #1-3 pass.
2. The other **179 cases pass on Windows already** and none depend on line-endings (checker is CRLF-tolerant, §0c).
   They contain no OS-specific logic: paths are built with `path.join`; error messages compare against the
   forward-slash `REL.*` constants the checker stores and emits verbatim (that is *why* the 179 pass on Windows —
   no `\`-vs-`/` asymmetry), so they pass identically on Linux.
3. **Local machine-proof that LF conversion fixes exactly the 3** (ran, touched no tracked file): reading each of the
   three files, stripping `\r`, and re-applying the exact find yields `mutate-fires-after-LF: true` for all three
   (as-is CRLF: `false`). So Option A is sufficient and necessary for Windows-green.

**This determination is REASONED, not yet proven on a real Linux runner.** The suite has **never run in CI** — that is
the whole gap — so no existing Linux signal exists. §2 designs the execution to *generate* that proof before the
required `policy` job depends on it. **If a real Linux run reveals any non-CRLF failure, STOP — the unit changes from
"wire it" to "fix real test bugs first," and this design's fix is insufficient.** (I judge that outcome unlikely for a
pure-`fs`/`node:test` suite, but it is not assumed.)

### 0(e) — The CI gap, precisely

`.github/workflows/pr.yml`, `policy` job (`:124`, `runs-on: ubuntu-latest` `:125`, `timeout-minutes: 5` `:127`):

```yaml
      - name: Distributed execution foundation contracts        # :160
        run: node scripts/check-distributed-execution-foundation.mjs   # :161 — CLI only
```

Every **other** checker in this job pairs its CLI with its `.test.mjs` in the same step — e.g. worker-protocol boundary
(`:163-166`), sandbox providers (`:173-183`), the DAT vector checkers (`:195-208`). The **foundation** checker is the
lone exception: `:161` runs the CLI but its mutation corpus runs nowhere. That is the mechanical meaning of
"enforced-at-rest, not against-regression": a future edit that re-vacuates a checker guard passes `policy` (the CLI
still reports 0 errors at rest), because the only thing that would catch it — the mutation suite — is unwired.

### 0(f) — The census entry (the flip is the point)

`scripts/test-execution-census.json:58-61`:

```json
"scripts/check-distributed-execution-foundation.test.mjs": {
  "status": "unrun",
  "reason": "RED as of 2026-08-24: 141 tests … its own makeFixture mutation helper is a no-op … TO WIRE: fix the mutation helper (own ticket), then move it into the policy job. This is the single highest-value item in this manifest."
}
```

Census contract (`scripts/lib/execution-census.mjs:99-113`, `:39-44`): a `runs` entry requires **both** `workflow` and
`step`; the checker resolves `"<workflow basename>::<step name>"` to that step's `run:` block
(`scripts/check-execution-census.mjs:56-95`, handles single-line **and** block form) and, **after stripping comment
lines**, requires the block to `.includes(<path>)`. So flipping to `runs` is valid **only if** the same commit makes
the step's `run:` block literally name `scripts/check-distributed-execution-foundation.test.mjs`.

### 0(g) — Registers that must NOT move (verified)

| Register | Governs | Effect of this unit |
|---|---|---|
| `check-guard-inventory.mjs` | `scripts/check-*` / `verify-*` **non-test** executables | **Untouched.** `findGuardScripts` filters `GUARD_NAME.test(name) && !IS_TEST.test(name)` (`:35-40`) — `.test.mjs` excluded. No new `check-*.mjs` is added. The foundation **CLI** is already inventoried & invoked (`:161`). |
| `check-test-inventory.mjs` | count of `*.test.mjs` **files on disk** | **Unchanged.** The `.test.mjs` already exists; the fix is `.gitattributes` (working-tree bytes) + a CI run line — no test file added/removed, and the test source is not edited. |
| `check-execution-census.mjs` | every `*.test.mjs` declared `runs`/`unrun` | **Flipped `unrun`→`runs`** — the intended move. |
| `check-ticket-graph-coverage` / `check-dependency-graph` | ticket-id → `program-design.md` node | **Untouched.** Slug is graph-inert (`[]`, §0). |
| `check-ci-lanes.mjs` (`:67`) | trigger `paths:` filters, job `needs`/`if`, `ci-required` verdict wiring | **Untouched.** Adding a run line inside an existing `policy` step changes no trigger, `needs`, `if`, or aggregator wiring (`check-ci-lanes.mjs:10-18`). |
| `.gitattributes` | line-ending pins | **Tracked by no register.** It is a bare config file; no `check-*` reads it. |

### 0(h) — `policy` is required via `ci-required`

`ci-required` (`pr.yml:1356-1357`) `needs: [changes, policy, …]` and folds `R_POLICY: ${{ needs.policy.result }}`
(`:1366`), enforced in the verdict loop (`:1383-1423`). Branch protection requires only `ci-required`
(per CLAUDE.md CI section), so a test wired into `policy` becomes a genuinely required signal.

---

## 1. The fix decision — Option A (scoped `.gitattributes eol=lf`), justified

Two candidates make the three mutations fire again:

- **Option A — pin the fixtures + foundation docs to `eol=lf` in `.gitattributes`.** The working tree becomes LF on
  all platforms, so the existing LF find-strings match everywhere. **No test-logic change.**
- **Option B — make the 3 mutate helpers EOL-robust** (match `\r?\n`), leaving the fixtures CRLF on Windows.

### Recommendation: **Option A.**

| Criterion | A (`.gitattributes`) | B (per-helper `\r?\n`) |
|---|---|---|
| Fixes root cause | **Yes** — removes the CRLF working tree, the actual defect | No — masks it per-call; fixtures stay CRLF |
| Matches programme precedent | **Yes** — `.gitattributes` is the established CRLF fix (`:7-72`); memory "windows-crlf-shebang-vitest" | No |
| Touches test logic | **No** | Yes — rewrites 3 helpers incl. `patchText` (`:330-335`) |
| Future-proof | **Yes** — any future embedded-`\n` mutation on a pinned file just works | No — every new mutation must remember `\r?\n`; this class recurs and *will* be forgotten |
| Blast radius | Working-tree bytes on Windows only; **index already LF → no committed content diff** | 3 test-file edits |
| Fragility | None | High — `:362` deletes a table row containing `|`, `/`, `.`; a literal `.replace(str,"")` can't express `\r?\n`, forcing a regex with every metachar escaped |

Option B's fatal tell: it changes the test's own asserted mutation mechanism (exactly what a mutation corpus must keep
stable) and re-opens the same footgun on the next embedded-`\n` case. Option A fixes the source once, for present and
future cases, with zero test-logic change, and reuses the repo's proven CRLF remedy.

### 1.1 — Precise scope of the `.gitattributes` pins

The three failing mutates read from **two** directories, so a `tests/fixtures/**`-only pin (the naive reading) would fix
**only test #3** and leave #1/#2 red on Windows. The correct scope covers both surfaces and the suite's natural
growth area:

```gitattributes
# The distributed-execution foundation fixtures and architecture docs are copied
# verbatim into the mutation harness's temp --root and mutated with LF-based
# find-strings (…foundation.test.mjs). A CRLF Windows checkout makes those finds
# no-ops, so three mutation self-checks fail locally while Linux CI (LF) passes.
# Pin LF so the corpus mutates identically on every platform. (foundation-suite-unrun)
tests/fixtures/distributed-execution/** text eol=lf
docs/architecture/distributed-execution-* text eol=lf
```

- `tests/fixtures/distributed-execution/**` — directory glob, matching the existing style
  (`tests/fixtures/worker-protocol-consumers/v1/**` `:47`). Covers test #3 + all 11 fixtures.
- `docs/architecture/distributed-execution-*` — the foundation-doc family this checker owns (8 files). Covers #1
  (`-lifecycles.md`) and #2 (`-authority.md`).

**Deliberately NOT pinned:** other files `makeFixture` copies — `decisions.md`, `program-design.md`,
`current-main-crosswalk.md`, `artifact-policy.md`, the templates, and the `server/src/**.ts` sources — because (a) **no
current mutation uses an embedded-`\n` find against them** (§0a is exhaustive), (b) the checker validates them
CRLF-tolerantly (§0c), and (c) pinning a high-traffic shared file like `decisions.md` has a needlessly wide blast
radius. Precedent is per-need pinning, not repo-wide normalization (`.gitattributes:1`). If a future mutation adds an
embedded-`\n` find against one of those, *that* ticket pins *that* file — the same discipline the existing file follows.

### 1.2 — Applying it (working tree + index)

The index is already LF for every pinned file (§0b), so `git add --renormalize` produces **no staged content delta** —
the committed diff is `.gitattributes` + `pr.yml` + the census JSON only. To make the *Windows working tree* LF so the
suite goes green locally, follow the memory "windows-crlf-shebang-vitest" incantation:

1. Add the two rules to `.gitattributes`.
2. `git add --renormalize -- tests/fixtures/distributed-execution docs/architecture` (no-op on index; declares intent).
3. Convert the working tree in place (e.g. `git rm --cached -r --quiet …` then `git checkout -- …`, or a scripted
   `\r\n`→`\n` rewrite of the pinned files) so the live bytes become LF.
4. **Verify** `git check-attr eol -- tests/fixtures/distributed-execution/schema-v1.json
   docs/architecture/distributed-execution-authority.md docs/architecture/distributed-execution-lifecycles.md`
   each reports `eol: lf`, and `git ls-files --eol` shows `w/lf` for all pinned files.
5. **Note (honesty):** CI green does **not** depend on this step — Linux CI already checks out LF, so on the `policy`
   runner the fix is a no-op. Its value is (i) satisfying the "green on Windows" acceptance criterion, (ii) making the
   census `runs` flip **honest cross-platform** (a future Windows contributor won't hit a spurious red and "fix" it by
   reverting the census), (iii) documenting the root cause. Do not overclaim the pin as "what makes `policy` pass."

---

## 2. Sequencing — proving green-before-wiring without reddening the shared branch

This is the riskiest part. `docs/replatform-program` is a working branch; branch protection lives on `main`, and
`pr.yml` triggers on `pull_request` + `push` to `main` — **not** on pushes to a feature branch. So a **direct push** of
the wiring to `docs/replatform-program` would run **no** `policy` check, and if the suite had a latent Linux failure it
would silently sit red at tip until the next PR. Conversely, wiring a genuinely-red suite that *does* get evaluated
would red the required `policy` job. The sequence below removes both hazards.

**Split into two commits; gate the second on an observed green Linux run.**

**Commit 1 — the fix alone (cannot red anything).**
`.gitattributes` (§1.1) + the working-tree renormalization (§1.2). This changes **no** CI wiring and **no** committed
file content (index already LF), so it is inert on every CI signal. Prove locally on Windows:
`node --test …foundation.test.mjs` → **182 pass / 0 fail**, and each of the three previously-failing self-checks now
fires (§3). Safe to push directly.

**Commit 2 — the wiring + the same-commit census flip (proof-gated).**
Add the `--test` run line to the `policy` step (§4) **and** flip the census entry to `runs` (§4) — **same commit**
(the census contract, §0f, reds if these are split). This commit must reach the shared branch **only through a PR whose
`policy` job runs green on `ubuntu-latest` first**:

- Because Commit 1's fix is a **Linux no-op** (fixtures already LF there), the Linux `policy` run of Commit 2 reflects
  the suite's *true* Linux state. If any non-CRLF Linux failure exists, it surfaces **here** — red, on a PR that
  branch protection will not let merge — and the shared branch tip is **never** reddened. This is the task's blessed
  "the wiring PR's own `policy` run is the proof, staged so a red suite can't block the branch."
- **Do NOT direct-push Commit 2 to `docs/replatform-program`.** Since the branch itself may not enforce checks, the
  safeguard is procedural: no wiring reaches the shared tip until a Linux `policy` run is observed green.

**Optional belt-and-suspenders (maximum caution):** before Commit 2, a throwaway **scratch PR** (or a temporary
`push`-triggered branch) that runs *only* `node --test …foundation.test.mjs` on Linux, read once and discarded. This
generates the Linux proof with zero coupling to the real wiring. Use it if there is any doubt about §0d; otherwise
Commit 2's own `policy` run is sufficient and is itself merge-gated.

**Why not one commit?** Commit 1 is independently useful and *provably* inert, so landing it first shrinks Commit 2 to
"two lines + a census flip" whose only risk is the Linux suite state — which Commit 2's own required run adjudicates
before merge.

---

## 3. Fail-first steps + positive control

### 3.1 — Watch each mutation go RED→GREEN and actually mutate (Windows)

Before the fix (tip): `tests 182 · pass 179 · fail 3` — the 3 rows of §0a, each failing at its
`assert.notEqual(mutated, original, …)` *before the checker runs* (the mutate never changed the fixture).

After Commit 1, run each individually and confirm it now (a) mutates and (b) reaches the checker's error assertion:

```
node --test --test-name-pattern="missing required Markdown heading: '## Worked journeys' removed"
node --test --test-name-pattern="authority mutation: a missing authority-matrix row fails"
node --test --test-name-pattern="schema: a non-closed object \(missing additionalProperties:false\) fails"
```

Each must pass, and the whole suite must be **182/182**. The self-checks at `:320`, `:333`, `:1213` now pass because the
LF working tree makes the find-strings match — i.e. the mutate **actually changes the fixture**, then the checker
**actually emits** `missing heading "## Worked journeys"` / `authority matrix is missing the required row for state
"Source history"` / `object schema at # must set additionalProperties:false`. (Local machine-proof already confirms the
mutate fires after LF conversion for all three, §0d.)

### 3.2 — Positive control: the suite now catches a real checker regression

A mutation table is thin here (this is test-repair + wiring, not a new guard). The *value* is proven by showing the
now-running suite **reds when a checker guard is deleted**. Demonstrate on a scratch copy (do not commit):

| Delete from `…foundation.mjs` | Test that must go RED | Why |
|---|---|---|
| the `for (const heading of REQUIRED_MD_HEADINGS)` loop (`:2769-2773`) | `'## Worked journeys'` (`:316`) | with the guard gone, the mutated doc yields **no** `missing heading` error → `hasError(…)` false → RED |
| the `"Source history"` authority-row check (`:231` + its emitter) | `authority-matrix row` (`:358`) | mutated doc drops the row but checker no longer complains → RED |
| the `additionalProperties:false` object-closure check (`:1449-1450`) | `non-closed object` (`:1208`) | mutated schema is non-closed but checker stays silent → RED |

Each deletion is a *re-vacuation* of a checker guard — precisely the regression class §0e says is currently
caught by nothing. Once wired, the suite catches it in `policy`. The opposite direction is guarded too:
`valid: the real repository passes` (`:176-179`) + `valid: an unmutated fixture copy passes` (`:181-185`) red if the
checker starts **over**-firing. (This positive-control deletion is a throwaway experiment; the checker source is not
modified by this unit.)

---

## 4. CI wiring + the same-commit census flip

**`pr.yml:160-161`** — convert the single-line `run:` to block form, matching every sibling checker step:

```yaml
      - name: Distributed execution foundation contracts
        run: |
          node scripts/check-distributed-execution-foundation.mjs
          node --test scripts/check-distributed-execution-foundation.test.mjs
```

The step **`name` is unchanged** ("Distributed execution foundation contracts"), so the census key stays stable.

**`test-execution-census.json:58-61`** — flip, **same commit**:

```json
"scripts/check-distributed-execution-foundation.test.mjs": {
  "status": "runs",
  "workflow": "pr.yml",
  "step": "Distributed execution foundation contracts"
}
```

Post-conditions (`scripts/check-execution-census.mjs` in the same `policy` run, `:317-324`):
`"pr.yml::Distributed execution foundation contracts"` resolves to the step above; comment-stripped, its `run:` block
`.includes("scripts/check-distributed-execution-foundation.test.mjs")` → the entry is a valid `runs`
(`execution-census.mjs:99-113`). The `$comment` header block and the step's in-line prose (`pr.yml:319-322`) are free
narrative the checker never validates — leave them; they read as historical.

**CI-time.** Pure `node:test` over `fs` copies: ~8.5 s cold on this Windows box (node startup + 182 tests), a few
seconds on the Linux runner — negligible against the `policy` job's 5-minute budget (`:127`). No new dependency, no
network, no build.

---

## 5. Acceptance table

| # | Criterion | Evidence / check |
|---|---|---|
| 1 | Suite **green on Windows** | `node --test …foundation.test.mjs` → `182 pass / 0 fail` on a Windows checkout after Commit 1 |
| 2 | Suite **green on Linux** (≤ acceptance, proven, not assumed) | Commit 2's PR `policy` run on `ubuntu-latest` is green **before merge**; if red for any non-CRLF reason → **STOP** (§0d) |
| 3 | Each of the 3 mutate self-checks **actually mutates** | `:320`, `:333`(`patchText`), `:1213` pass; per-test `--test-name-pattern` runs green (§3.1) |
| 4 | **Wired** into `policy`, required via `ci-required` | `pr.yml` step (§4) names the path; `ci-required.needs` includes `policy` (`:1357`), folds `R_POLICY` (`:1366`) |
| 5 | Census **flipped + byte-consistent**, same commit | entry = `runs`/`pr.yml`/exact step name; `check-execution-census.mjs` green (§0f/§4) |
| 6 | **No other register moves** | guard-inventory, test-inventory, ticket-graph, ci-lanes all unaffected (§0g) |
| 7 | **Regression coverage proven** | deleting any of the 3 checker guards reds its test (§3.2 positive control) |
| 8 | Committed **content diff is minimal** | only `.gitattributes` + `pr.yml` + census JSON; index-LF means renormalize stages no doc/fixture bytes (§1.2) |

---

## 6. Files touched

| Action | Path | What |
|---|---|---|
| modify | `.gitattributes` | two scoped `eol=lf` pins (§1.1) |
| (renormalize) | `tests/fixtures/distributed-execution/**`, `docs/architecture/distributed-execution-*` | working-tree → LF; **no staged content change** (index already LF) |
| modify | `.github/workflows/pr.yml` | add `node --test …foundation.test.mjs` to the existing foundation step (§4) |
| modify | `scripts/test-execution-census.json` | flip the entry `unrun`→`runs` (§4) |
| create | `docs/replatform/epics/E11-hardening-release/tickets/foundation-suite-unrun-result.md` | result doc (at execution) |

**Not modified:** `scripts/check-distributed-execution-foundation.test.mjs` (Option A needs no test-logic change) and
`scripts/check-distributed-execution-foundation.mjs` (checker untouched; §3.2 deletions are throwaway experiments).

---

## 7. Risks & rollback

**R1 — a latent non-CRLF Linux failure (the determination in §0d is wrong).** *Likelihood:* low (pure `fs`/`node:test`,
179 EOL-independent cases already green on Windows, no path-separator asymmetry). *Mitigation:* the entire §2 sequence
exists for this — Commit 2's own required `policy` run adjudicates it **before merge**; a red run blocks that PR and
never reaches the shared tip. If it fires, **STOP and report** — the unit becomes "fix real test bugs first," out of
scope for this design.

**R2 — Windows working-tree renormalization is skipped, so the pin is inert locally.** *Effect:* Windows dev still sees
3 red; CI (Linux) is unaffected and still green. *Mitigation:* §1.2 step 4's `git check-attr` + `git ls-files --eol`
verification is a hard gate on Commit 1; do not push Commit 1 until `w/lf` is confirmed for the pinned files.

**R3 — census flip split from the wiring.** *Effect:* `runs` without the run line → `check-execution-census.mjs` reds
`not_named_in_step`; run line without the flip → entry still `unrun` (valid, but the point is unmet). *Mitigation:*
§4 mandates one commit; the acceptance table item 5 checks it.

**R4 — over-broad `.gitattributes` scope.** *Effect:* pinning a high-traffic shared doc could surprise other diffs.
*Mitigation:* §1.1 deliberately scopes to the `distributed-execution-*` family + the fixtures dir only, excluding
`decisions.md`/`program-design.md`/sources.

**R5 — CI-time.** Negligible (§4). No mitigation needed.

**Rollback.** Each piece reverts independently and cleanly:
- Remove the two `.gitattributes` lines (+ re-checkout) → Windows returns to CRLF/3-red; **Linux CI unchanged**.
- Remove the `--test` run line from `pr.yml` **and** flip the census entry back to `unrun` (with the honest reason:
  "pinned LF but wiring reverted") — **as one commit** (the census contract requires the pair to move together).
- The renormalized doc/fixture bytes carry **no index delta**, so nothing to roll back there.

No migration, no schema, no runtime code — `packages/worker-protocol` is untouched (and FROZEN).
