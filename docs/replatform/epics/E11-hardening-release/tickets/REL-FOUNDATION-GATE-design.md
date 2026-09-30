# REL-FOUNDATION-GATE — Design: the E0 release-test gate stops accepting a bare string

**Ticket node:** none required, and none enforced — *(corrected in review round 2; the original
draft's coverage-coupling claim here was false, caught independently by all three reviewers).* This
is a **new** Sprint-9 first unit. Its id `REL-FOUNDATION-GATE` has **no 3-digit segment**, so it is
invisible to `check-ticket-graph-coverage.mjs` (`scripts/lib/ticket-graph-coverage.mjs`) on BOTH
axes: `expandTicketIdsFromFilename` (`/^([A-Z]{2,5})-(\d{3})/`) yields no id from the filename, and
`parseAuthorityNodes` (`/^####\s+([A-Z]{2,5}-\d{3})\s/`) does not parse a `#### REL-FOUNDATION-GATE`
heading as a node. So the design doc reds coverage **whether or not** a node exists — proven by its
sibling `GATE-clause-3-rollback-design.md`, which sits in this dir today with no node and CI green.
The EXECUTION step MAY add a `#### REL-FOUNDATION-GATE` heading for human traceability, but it is
**inert** (also ignored by the foundation checker's own `parseProgramTicketIds`), NOT a
coverage-forced file/node pairing. Committing this design makes REL-FOUNDATION-GATE a **FIFTH**
member of the GO-BOOK §5 "invisible to the coverage checker" family — bump that row's count. The
unit's real enforcement is the CLI checker at rest in the `policy` job; see §0(h) for the
regression-coverage residual that creates.
**Epic:** E11 (hardening + release), touching the E0 foundation checker it re-opens.
**Depends on:** nothing shipped. It depends on the four REL tickets NOT existing yet — that is the
state it makes honest. It is a prerequisite of, not blocked by, REL-001/002/003/005.
**Size:** S — one checker function, one small manifest, one fixture-harness extension, a handful of
node:test cases. **Ships GREEN** (this is the whole point of choosing it as the first unit; §5).
**Sprint:** 9, **unit 1**. GO-BOOK §4 *"Sprint 9 — hardening and release"* + §3 sequence row S9.
**This is a DESIGN doc.** No production code, no checker edit, no manifest file, no graph node, no
threat-controls edit. §7 is the execution recipe; a later commit runs it.

---

## ★★ Review round 2 (orchestrator) — corrections to fold in at execution

A three-way adversarial review (independent reviewer on the checker/CI coupling, a skeptic told to
REFUTE "ships green at rest," a completeness critic on the sequencing) ran against this design. The
**core verdict is unanimous and independently reproduced: the design is sound, option (c) is the
right first unit, it ships 0-error at rest, and hard-strict (option b) genuinely breaks a required
check.** No reviewer could construct a ships-red scenario. Apply these corrections at the cited
steps — they are recipe fixes and one new residual, none of which change the conclusion, but several
of which would cost the execution author a red run or a silent vacuity:

- **C1 (header rationale — FIXED inline above; caught by all 3 reviewers).** The "a file without a
  node reds coverage, so node+file land together" claim was false: `REL-FOUNDATION-GATE` has no
  3-digit id and is invisible to `check-ticket-graph-coverage`. See the corrected header + §0(h).
  This is the programme's own "false claim of enforcement" anti-pattern — do not reintroduce it.
- **C2 (§7 Step 2 crossing count — FIXED inline in §7).** REL-001 is named by **14** crossings, not
  "10". Verified per-ticket counts at tip: REL-001×14, REL-004×6, REL-002×4, REL-005×4, REL-003×2
  (= 30; the §8 M2 total "24 unwritten-but-declared" = 14+4+2+4 is correct). Do not hard-code a
  fragile exact-count assertion; assert on the error substring, and if a count is asserted use 14.
- **C3 (the finding⇄manifest FORMAT contract — add to §7 Step 7 / §10 / §12).** `parseFindings`
  (`finding-ownership.mjs`) treats a finding as open only when its heading matches
  `^## ([A-Z0-9]+-F\d+)\s*[—-]\s*` AND a `**Status:** open` line is present, and the
  `scripts/finding-ownership.json` key must be **byte-equal** to the parsed id. So: heading
  `## E11-F001 — <title>` (em-dash or hyphen, **never a colon**), `**Status:** open`, manifest key
  exactly `E11-F001`, entry `{ "status": "unowned", "reason": "…" }`. Use `unowned` — it is
  **forced**: `findTicketIds` (`^[A-Z]+-\d+`) cannot recognise the non-numeric id
  `REL-FOUNDATION-GATE`, so `owned` would red `owner_ticket_missing`. A colon, a key typo, or `owned`
  reds `policy`.
- **C4 (root-relative reads — reinforce §3.2 / §4).** Resolve BOTH new inputs against `root`:
  `readdir(path.join(root, REL_TICKETS_DIR))` and `readFile(path.join(root, RELEASE_TESTS_JSON))`,
  never cwd-relative. A cwd-relative `readdir` silently reads the REAL tickets dir under `node --test`
  (root = temp dir, cwd = repo root), defeating fixture isolation — and the Step-1 positive control
  (which mutates the manifest, not the tickets dir) does NOT catch it. Add an M8-style fixture that
  writes a `REL-00X-design.md` INTO the fixture root and asserts it is seen there (not via the real
  tree).
- **C5 (`code=true` caveat — note in §5).** This PR touches `scripts/*.mjs` + `scripts/finding-ownership.json`
  (non-`docs/`, non-root-`.md`), so the `changes` detector emits `code=true` and `ci-required`
  additionally requires the full heavy suite (`verify`/`lint`/`e2e`/`e2e-pgvector`/`migrations`/`browser`).
  The change is dependency-free so it should pass, but "ships green" is contingent on the whole
  `code=true` gate, not just `policy` — budget for this branch class's known `verify`/`e2e` flakiness.
- **C6 (framing — Sprint 9 does NOT complete in one pass).** Lead with this, don't bury it: only
  unit 1 (this gate) and unit 2 (REL-003, dependency-ready) are buildable today; REL-001/002 hard-block
  on Sprints 7/8 and REL-005 on all of them. A green gate is NOT license to attempt REL-001/002 next
  — that is the §2.4 STOP trap against absent workloads.
- **C7 (demote the "automatic coupling" argument).** §0(e)/§5 present "the gate makes the rest of the
  sprint's coupling automatic" as a *sequencing necessity*. It is a **bonus**, not decisive: it only
  machine-enforces one later ticket's deferral-retirement (REL-003's). The load-bearing reasons the
  gate goes first are (a) it is the ONLY Sprint-9 unit that ships green with no unshipped dependency,
  and (b) it closes a LIVE honesty defect on tip immediately. The decision survives on those alone;
  do not lean on the coupling argument.
- **C8 (REL-003 deferral is transitional).** Its manifest entry is added in unit 1 and removed one
  unit later (unit 2). Note that in the manifest reason so a reader does not read the quick
  add-then-remove as instability.

### 0(h) — NEW residual (the review's highest-value finding): the gate is enforced AT REST but not AGAINST REGRESSION

> **★ RESOLVED 2026-08-27 — foundation-suite-unrun (S9 hardening unit).** This residual is closed. The
> suite now runs in the `policy` job (`pr.yml`, existing step **"Distributed execution foundation
> contracts"**, paired with the CLI like every sibling checker) and its census entry is flipped
> `unrun`→`runs`, so `ci-required` now carries a **required** regression signal for the checker's own
> guards. Positive control confirmed before wiring: deleting the heading / authority-row /
> additionalProperties guard reds its now-running test. **Root-cause correction (the census + this
> paragraph both misdiagnosed it):** the suite was NOT red because of a "helper no-op." The `makeFixture`
> mutate helpers are correct. The failures were **CRLF working-tree bytes vs LF find-strings** on a
> Windows checkout (`core.autocrlf=true`): the fixtures/architecture docs are LF-in-git but materialize
> as CRLF locally, so the LF `String.replace(…"\n"…)` finds were no-ops and the `assert.notEqual(mutated,
> original)` self-checks fired *before the checker ran*. There were **3** such cases (not one), all one
> class; the checker itself is CRLF-tolerant, so **179/182 passed on Windows and the suite is 182/182
> green under LF** — the form Linux CI checks out, which is why it was green on CI and red only on
> Windows-local. Fixed by a scoped `.gitattributes eol=lf` pin of the distributed-execution fixtures +
> architecture-doc family (zero committed content delta — the index was already LF) plus the CI wiring
> above; no test-logic change. See `foundation-suite-unrun-{design,result}.md`. The paragraph below is
> kept verbatim as the record of the misdiagnosis it corrects.

The foundation checker's own test suite `scripts/check-distributed-execution-foundation.test.mjs` is
`status:"unrun"` in `scripts/test-execution-census.json` and is **wired into no CI job** (only the
CLI `node scripts/check-…mjs` runs, at `pr.yml:161`). It is RED at tip for a **pre-existing, unrelated**
reason — one schema-mutation case ("mutation did not remove additionalProperties:false") whose helper
is a no-op; the rm/write/JSON-roundtrip mutate mechanism itself WORKS (60+ passing cases), and
`valid: the real repository passes` **passes at tip** (confirmed by the orchestrator:
`node --test --test-name-pattern="valid: the real repository passes …"` → 1 pass). Two consequences:

1. **Execution methodology:** run the relevant cases INDIVIDUALLY (`--test-name-pattern`), not the
   whole suite — the suite is red at tip for a reason this ticket does not own. `valid: the real
   repository passes` is the truest green signal and can be run in isolation.
2. **The residual, stated honestly:** the CLI passes at rest under BOTH the vacuous bare-string form
   AND option (c)'s strict form (rest-state = 0 errors either way — strict is merely more
   restrictive). So a future regression that reverts `checkCrossingReleaseTest` toward vacuity is
   caught by **no CI signal** — only by the new M0–M8 test cases, which live in the **unwired** suite.
   The gate therefore ships enforced-at-rest but **not enforced-against-regression.** The natural
   completion is the census's own "single highest-value item": fix the additionalProperties no-op and
   move the suite into the `policy` job. **Non-goal for THIS unit** (keep unit 1 small + green), but
   name it as a candidate Sprint-9 hardening unit (owner: a follow-up ticket, ideally before REL-005)
   in the result doc and GO-BOOK §5. Do NOT silently assume the suite is green or CI-enforced.

---

## ★ 0. Verified state at tip, and the three answers the sprint turns on

Everything in this section was read at worktree `C:\e3`, branch `docs/replatform-program`. **Every
source claim carries `path:line`; living docs (go-book, terrain audit, program-design) are cited by
section / node id per the programme's rule.** Line numbers in `.mjs`/`.yml`/`.json` rot — **re-read
each cited span at execution start and correct this section in place before writing a test.** The
programme has shipped four confident-wrong verdicts from a stale line anchor; §0(a) below is one it
already caught in a sibling ticket.

### 0(a) — The crux, re-verified

`crossingHasReleaseTest` (`scripts/check-distributed-execution-foundation.mjs:745-751`) returns
true when **either** `ownerTickets` contains a `REL-\d+`-shaped token (`REL_OWNER_RE`,
`:184`) **or** `c.releaseTest` is any non-empty string (`:749`). **It never checks that the named
ticket exists on disk.** It is called once, from the Critical/High branch of
`validateThreatCrossings` (`:815-817`), which pushes an error only when `crossingHasReleaseTest`
is false. So a crossing satisfies E0's release-test contract by *naming* a test, written or not.

`docs/architecture/distributed-execution-threat-controls.json` (`version: 1`, 30 crossings) — parsed
at tip: **all 30 crossings are Critical (22) or High (8); every one already passes** (14 via a
`REL-*` owner, 16 via a `releaseTest` field, **0 with neither**). The distinct REL tickets named
across the register are REL-001, REL-002, REL-003, REL-004, REL-005.

`docs/replatform/epics/E11-hardening-release/tickets/` — **only REL-004 has files** (`REL-004-design.md`,
`REL-004-result.md`, plus lane-C/D). **REL-001/002/003/005 have no files**; they are `#### REL-00X`
nodes in `program-design.md` only (`#### REL-001`, `#### REL-002`, `#### REL-003`, `#### REL-005`).

**Consequence, computed not asserted:** under a strict "the named REL ticket must exist on disk"
check, **6 of the 30 crossings would still pass** (they name the written REL-004) and **24 would go
red** (they name only unwritten tickets). See §0(f) for why "24, not 30" matters.

### 0(b) — ANSWER 1 (the decisive fact): YES, the foundation checker is in `ci-required`.

Traced through `.github/workflows/pr.yml`:

* The checker runs as a step of the **`policy`** job — *"Distributed execution foundation
  contracts"*, `run: node scripts/check-distributed-execution-foundation.mjs`
  (`pr.yml:160-161`). The `policy` job spans `:124-490` (next top-level job `brand-check` at
  `:491`), so `:160` is inside it.
* `policy`'s `if` is **draft-only** — `${{ github.event_name != 'pull_request' ||
  !github.event.pull_request.draft }}` (`:126`). It has **no** `changes.outputs.code` gate, so it
  runs on **every** non-draft PR, **including docs-only ones** — which this branch's PRs are.
* `ci-required` (the sole branch-protection check) lists `policy` in its `needs` (`:1346-1347`)
  and treats it as an **always-on cheap gate that must be `success`**: the aggregator loops
  `"policy=$R_POLICY" …` and sets `fail=1` on anything but success (`:1383-1386`),
  **unconditionally** — before and independent of the `code=true` heavy-job gate (`:1395-1400`).
* `main()` exits 1 when `errors.length > 0` (`scripts/check-distributed-execution-foundation.mjs:2749-2751`).
* The checker ALSO runs in `distributed-contract` (`pr.yml:1227-1228`), itself in `ci-required`'s
  needs (`:1347`) — but that job is path-gated (`:1189`) and can skip; `policy` is the always-on one.

**So a single pushed error from this checker turns `policy` red → `ci-required` red → the branch-
protection gate red, on every PR.** A hard-strict flip does **not** merely "re-open E0"; it blocks
merges programme-wide until the four REL tickets exist. (`check-finding-ownership.mjs` shares this
exact `policy`-job pathway — WRK-010-design §0(e) traces the same `:160`-neighbourhood step for
its sibling guard.)

### 0(c) — ANSWER 2 (the honest first unit): option (c), the trackable-strict gate.

**(a) "write the four REL tickets first, then flip strict"** is not a *first unit* — it is most of
the sprint, and it is **dependency-blocked**: REL-001 depends on BRW-006 (Sprint 7) + SVC-007
(Sprint 8), REL-002 on SVC-006 (Sprint 8), REL-005 on REL-001/002/003/004 (`program-design.md`
`#### REL-001`/`#### REL-002`/`#### REL-005`). Sprints 7 and 8 have **not shipped** those capabilities
(GO-BOOK §3.1 shows S6-unit MIG-009 as the latest ship; S7/S8 are unwritten). You cannot honestly
write a cross-tenant adversarial suite over browser/service workloads that do not yet exist (§0e).
So (a) cannot be the thing that goes first.

**(b) "flip hard-strict NOW and accept honestly-red"** is **refused by Answer 1**. It reds a
REQUIRED check on every PR until E11 lands. GO-BOOK §4 Sprint 9's own words — *"flips E0 from
falsely-green to honestly-red until E11 lands"* — and the terrain audit's *"two-line non-existence
check away from honest"* (`qa/2026-08-27-breadth-terrain-audit.md`, Sprint 9 section) **predate CI
going green** and are now wrong as written; see §0(f).

**(c) the trackable-strict gate — TAKEN.** Flip the checker strict, but scope its strictness the way
the programme scopes every other declaration guard: a Critical/High crossing's named REL ticket is
**admissible** when its design doc **exists on disk OR it is declared in a deferral manifest with a
reason**. Missing-and-undeclared is the only red. This ships **green today** (the manifest declares
the four unwritten tickets), makes the debt **visible and tracked** instead of vacuously green, and
— when each REL ticket eventually lands and its deferral is removed — **collapses into exactly the
pure existence check the go-book asked for, with nothing deferred.** It is the same shape as
`finding-ownership`'s `unowned`-with-reason (`scripts/lib/finding-ownership.mjs:1-27, 30-33`) and
`gate-clause-wiring`'s `unwired`-with-reason. **Recommended, with the CI consequence in §5.**

### 0(d) — ANSWER 3 (what a "release test" REL ticket is): REAL implementation, not a doc stub.

The model is REL-004 (`REL-004-design.md`): four lanes of real verifiers, deny-lists, a release
manifest gate and a reconcile, every guard mutation-tested (I1-I11). The others, from their
`program-design.md` nodes:

* **REL-001** (`#### REL-001`): a *"weekly adversarial suite and release gate"* running hostile
  tenant identifiers/artifacts/events across coding+browser+service. Real test harness. Deps
  BRW-006, SVC-007, TEN-005, DEP-008 (two unshipped).
* **REL-002** (`#### REL-002`): a *"multi-tenant load model with worker churn and object-store
  latency"* establishing queue/lease/SLO limits. Real load harness. Deps JOB-007, JOB-009, DEP-009,
  SVC-006 (SVC-006 unshipped).
* **REL-003** (`#### REL-003`): a *"staging database plus object-store backup/restore"* DR +
  migration rehearsal with stale-fence rejection and a measured RPO/RTO. Real rehearsal. GO-BOOK §4
  Sprint 9 calls it *"(dependency-ready)"* — its deps DEP-006, MIG-002, E10-REALTIME-FOUNDATION are
  landed.
* **REL-005** (`#### REL-005`): the private-beta campaign + evidence pack, and it carries the
  **kill-switch write path** (GO-BOOK §5 debt row *"Kill switch has no write path"* — `evaluateKillSwitches`
  is wired but throwing it means hand-executed SQL). Depends on REL-001/002/003/004. Last.

**None is a WRK-012/013-style on-disk scoping stub.** Writing one is a multi-session real
implementation, dependency-gated. That is the third reason the checker gate — not a REL ticket — is
the honest first unit: it is the one Sprint-9 unit that is small, ships green, and depends on
nothing unshipped.

### 0(e) — Why the coupling forces this order (the crux the task asked to resolve)

GO-BOOK §4 Sprint 9 couples job (a) [write the REL tickets] to job (b) [flip the checker strict].
The naive reading — do (b), accept red, then do (a) to restore green — is refused by Answer 1 (the
red is a *required-check* red now) AND by Answer 3 (job (a) is dependency-blocked on Sprints 7/8).
The trackable-strict gate (c) **decouples them honestly**: it converts the coupling into a machine-
checked invariant. After unit 1, every named release test is either **written** (on disk) or
**declared deferred** (with a reason a reader can argue with); there is no third, silent state. Each
later REL ticket, when it lands, MUST remove its deferral entry or the stale-deferral guard (§4, M4)
reds — so the checker enforces the very coupling the go-book states in prose. The gate goes first
precisely because it makes the rest of the sprint's coupling automatic instead of manual.

### 0(f) — TWO THINGS WRONG against the code (surface, don't absorb)

1. **GO-BOOK §4 Sprint 9 contradicts §2.0, and the terrain audit repeats the stale framing.** §4
   says the strict flip *"flips E0 from falsely-green to honestly-red until E11 lands"* and the
   audit calls it *"a two-line non-existence check away from honest."* Both were written when
   `ci-required` was **already red** (the §2.0 60-min `verify` timeout), so a foundation-red was
   *free* — it changed a gate that was red anyway. **§2.0 RESOLVED 2026-08-27 (PR #327): `ci-required`
   is green, and "a red required check now BREAKS the gate."** The foundation checker is in the
   always-on `policy` job (Answer 1), so the "honest two-line change" would now **red a required
   check on every PR** — it is NOT free. The two-line framing is incomplete against the current tree.
   This design records the discrepancy; the EXECUTION step should file it as a finding (E11 has **no
   `findings.md`** at tip — one must be created, with a `finding-ownership.json` declaration in the
   same commit, or the finding is born `undeclared_finding` and reds `policy`; §10).
2. **The audit's "30/30 name REL-001/002/003/005" is imprecise.** Parsed at tip, **6 of the 30
   crossings name the WRITTEN REL-004** (and would pass a strict existence check); only **24** name
   *only* unwritten tickets. A strict flip reds 24, not 30. Minor, but it changes the mutation
   arithmetic in §8 (M1 is killed by those 6; M2 by the other 24).

### 0(g) — Facts the design leans on, each read at tip

| Fact | Evidence |
|---|---|
| The vacuous check | `crossingHasReleaseTest` `:745-751`; called at `:815-817` |
| `REL_OWNER_RE = /^REL-\d+$/` | `:184` |
| Backlog-id allow-list is derived from `#### <ID>` headings | `parseProgramTicketIds` `:730-743` (used for `ownerTickets` cross-ref at `:806-812`) — the `releaseTest` FIELD is **not** cross-referenced today (latent hole §4) |
| Exit behaviour: any error → exit 1 | `runCheck` returns `{errors}` (`:2593-2736`); `main` exits 1 on `errors.length>0` (`:2749-2751`) |
| Test harness copies a FIXED file set, NOT the E11 tickets dir | `makeFixture` (`check-distributed-execution-foundation.test.mjs:64-143`) copies `REL.threatControls`/`REL.programDesign`/… but no `epics/**` and no scripts manifest; `runCheck(root)` at `:159/165/…` |
| Declaration-guard house shape to mirror | `evaluateFindingOwnership` (`scripts/lib/finding-ownership.mjs:67-139`): default-deny undeclared (`:88-90`), reason required (`:92-95`), owner must exist (`:102-105`), naming a shipped owner needs `ownerStillOpen` (`:118-120`), stale entry reds (`:132-136`) |
| Coverage checker is asymmetric — a node without a file is fine | `check-ticket-graph-coverage.mjs:5-9`, `:48-64`; so REL-001/002/003/005 nodes are legitimately `authorityOnly` |
| No REL keys in the ownership manifest today | `scripts/finding-ownership.json` has no `REL-` key |

---

## 1. The fact this ticket exists to change

| Fact | Evidence |
|---|---|
| E0's release-test contract is satisfied by a *string* | `crossingHasReleaseTest:749` accepts any non-empty `releaseTest`; `:747-748` accepts a `REL-\d+`-shaped owner token |
| Nothing links the named test to a written ticket | the function reads only the crossing object; it never touches the filesystem or `parseProgramTicketIds` output |
| 24 of 30 Critical/High crossings name a test that does not exist | §0(a) parse; only REL-004 of {001,002,003,004,005} has files |
| The green is therefore vacuous | E0 reports PASS while 24 named release gates are unwritten |

**Net:** E0's most load-bearing release claim — *every Critical/High trust crossing has a release
test* — is true of the register's prose and false of the tree. This is the exact failure class the
programme's registers exist to catch (GO-BOOK §6), one level up from `check-gate-clause-wiring`:
*a clause satisfied by something nobody wrote.*

---

## 2. The fix, in one sentence

**A Critical/High crossing's named release test must resolve to a REL ticket that either exists on
disk or is declared, with a reason, in a release-test deferral manifest — and a manifest entry for a
ticket that now exists is itself an error, so the debt is self-cleaning.**

That is the `finding-ownership` move applied to release tests: the machine verifies the cheap
direction (does the named ticket exist, or is its absence acknowledged in writing?), and a human
writes the hard direction (why it is not written yet, and what it is waiting on). The bare-string
loophole closes; the gate stays green; each future REL ticket's landing is forced to retire its own
deferral.

---

## 3. Architecture — the checker change and the manifest, mirrored on the house guard

### 3.1 What the EXECUTION step touches (design-time list; this doc writes none of it)

| Action | Path | What |
|---|---|---|
| create | `docs/architecture/distributed-execution-release-tests.json` | the deferral manifest (§3.3), beside its sibling authority `distributed-execution-threat-controls.json` |
| modify | `scripts/check-distributed-execution-foundation.mjs` | replace `crossingHasReleaseTest` with the admissibility gate (§4); load the two new inputs; add the manifest-hygiene guards |
| modify | `scripts/check-distributed-execution-foundation.test.mjs` | extend `makeFixture` to copy the E11 tickets dir + the manifest (§3.4); add the RED cases (§7) |
| create | `docs/replatform/epics/E11-hardening-release/tickets/REL-FOUNDATION-GATE-result.md` | result doc |
| create | `docs/replatform/epics/E11-hardening-release/findings.md` **+** a `scripts/finding-ownership.json` key | the §0(f) go-book/§2.0 discrepancy finding, filed WITH its declaration in the same commit (§10) |
| modify | `program-design.md`, `GO-BOOK.md` §3.1/§4/§5 | the node, the S9 row, retire the "two-line" framing (§0f) |

**No migration, no schema, no `packages/worker-protocol` change (FROZEN), no new `AOA_*`.** The
manifest is a docs artifact; the checker is dependency-free node (`readFile`/`readdir` already
imported, `:65`).

### 3.2 What "a REL ticket exists on disk" means — pinned, so the checker and the harness agree

Existence = a file `docs/replatform/epics/E11-hardening-release/tickets/<REL-ID>-design.md` is
present. The **design** doc, not the result doc, because the programme's own convention is that the
design commit is the ticket's Start SHA (GO-BOOK §2.2 step 2) — a ticket "exists" the moment its
design lands, before its result. REL-004 satisfies this (`REL-004-design.md`). The checker derives
`writtenRelTickets` by `readdir`-ing that directory and matching `^(REL-\d+)-design\.md$`, capturing
group 1. (Lane files like `REL-004-lane-C-design.md` do not match the anchored pattern — deliberate;
a lane is not a top-level ticket.)

### 3.3 The deferral manifest — shape and the guards that keep it honest

```jsonc
// docs/architecture/distributed-execution-release-tests.json
{
  "version": 1,
  // Every REL ticket NAMED by a Critical/High crossing that is NOT yet written on disk
  // MUST appear here with a reason. When the ticket's design doc lands, its entry MUST be
  // removed in the same commit (the stale-deferral guard reds otherwise).
  "deferred": {
    "REL-001": { "reason": "cross-tenant/secret-exposure adversarial gate; deps BRW-006 (S7) + SVC-007 (S8) unshipped — cannot author the browser/service adversarial suite before those workloads exist" },
    "REL-002": { "reason": "load/fairness/SLO gate; dep SVC-006 (S8) unshipped — no service-reconciliation limit to model yet" },
    "REL-003": { "reason": "DR + migration rehearsal; deps landed (DEP-006/MIG-002/E10-REALTIME-FOUNDATION) — scheduled as the next Sprint-9 unit, written but not yet on disk" },
    "REL-005": { "reason": "private-beta campaign + evidence pack + kill-switch write path; depends on REL-001/002/003/004 — the last Sprint-9 unit" }
  }
}
```

Manifest-hygiene guards, each mirroring a named `finding-ownership` guard:

| Guard | Mirrors | Reds when |
|---|---|---|
| **malformed** | `malformed_declaration` (`finding-ownership.mjs:92-95`) | a `deferred[id]` has no non-empty `reason` (or `version` is non-numeric / `deferred` is not an object) |
| **stale** | `stale_declaration` + `owner_ticket_already_complete` (`:118-120,132-136`) | a `deferred[id]` whose `<id>-design.md` EXISTS — the ticket shipped; remove the deferral |
| **unreferenced** | `stale_declaration`'s "list nobody trusts" rationale | a `deferred[id]` that no Critical/High crossing names (the manifest may not carry ghosts) |

### 3.4 The fixture-harness consequence — do NOT skip this, it is where a naive strict flip breaks

`makeFixture` (`check-distributed-execution-foundation.test.mjs:64-143`) copies a hard-coded file
list into an isolated `--root` and runs `runCheck(root)`. It copies **neither** the E11 tickets
directory **nor** any scripts-level manifest. So the moment the checker reads
`epics/E11-hardening-release/tickets/` and `distributed-execution-release-tests.json`, the
**`valid: an unmutated fixture copy passes` test (`:163-167`) breaks** — in the fixture root both
inputs are absent, so every crossing's named ticket is missing-and-undeclared → 24+ errors.

The fix is part of THIS unit, not a follow-up: extend `makeFixture` to
`fs.cpSync` the real `docs/replatform/epics/E11-hardening-release/tickets/` into the fixture root and
`fs.copyFileSync` the real manifest, and add both to the `files` handle so mutation callbacks can
edit them (a written-ticket fixture, a manifest edit). The `valid: the real repository passes`
test (`:158-161`) exercises the real tree directly and needs no harness change — it is the truest
green signal and is why the resting repo state must be self-consistent (all four unwritten declared;
REL-004 written and NOT declared).

**A missing-input policy decision the checker must state explicitly:** if the manifest file is
absent, that is a **fail** (`… : missing`, via `readOrError` `:247-259`), not an empty-deferral pass
— an absent policy is a refusal, the DSK-004/REL-004 D2 rule (`REL-004-design.md:65-67`). Fail-open
on a missing manifest would reopen the vacuous-green from a different door.

---

## 4. The decision function — the exact checker change

Replace `crossingHasReleaseTest(c)` with an admissibility gate that takes the crossing **plus** the
two new inputs. Signature and body (abridged to the load-bearing lines; the execution step writes it
against the tip):

```js
// A crossing's release test is ADMISSIBLE iff it NAMES at least one REL ticket and EVERY
// named REL ticket is admissible: its <id>-design.md exists on disk, OR it is declared in the
// deferral manifest with a reason. This replaces the bare-string acceptance at :745-751.
//
// ★ READ BEFORE WEAKENING. Returning true when a named ticket is neither written nor declared
// is the vacuous green this function was rewritten to remove (design §1). An ABSENT manifest is
// a refusal, not an empty allow-list (design §3.4).
const REL_TOKEN_RE = /REL-\d+/g;

function namedReleaseTickets(c) {
  const owners = Array.isArray(c.ownerTickets)
    ? c.ownerTickets.filter((t) => typeof t === "string" && REL_OWNER_RE.test(t))
    : [];
  const field = typeof c.releaseTest === "string" ? (c.releaseTest.match(REL_TOKEN_RE) || []) : [];
  return new Set([...owners, ...field]);
}

// Pushes an error per unsatisfied crossing; NO error when every named ticket is admissible.
function checkCrossingReleaseTest(c, label, written, deferred, errors) {
  const named = namedReleaseTickets(c);
  if (named.size === 0) {
    errors.push(`${THREAT_CONTROLS_JSON}: crossing ${label} is ${c.severity} but names no REL release-test ticket`);
    return;
  }
  for (const id of named) {
    const onDisk = written.has(id);
    const isDeferred = Object.prototype.hasOwnProperty.call(deferred, id)
      && typeof deferred[id]?.reason === "string" && deferred[id].reason.trim() !== "";
    if (!onDisk && !isDeferred) {
      errors.push(`${THREAT_CONTROLS_JSON}: crossing ${label} names release-test ticket ${id} which neither exists on disk (${REL_TICKETS_DIR}/${id}-design.md) nor is declared deferred in ${RELEASE_TESTS_JSON}`);
    }
  }
}
```

Wired into `validateThreatCrossings` (`:815-817`), replacing the single `!crossingHasReleaseTest(c)`
push. The manifest + `writtenRelTickets` are loaded once in `validateThreatModel` (`:911-961`,
alongside `parseProgramTicketIds`) and threaded down; the hygiene guards (§3.3) run once there.

**Two deliberate strengthenings over the go-book's literal "must exist":**
* the release test must **name a REL ticket** (`named.size === 0` reds) — closing the audit's
  "arbitrary non-empty string" loophole, which no crossing exploits today but the type permits;
* **every** named ticket must be admissible (not just one) — so a crossing cannot smuggle a bogus
  `REL-999` alongside a real one. (The `ownerTickets` arm is already backlog-cross-referenced at
  `:806-812`; this extends the same discipline to the `releaseTest` field, which is unchecked today.)

Neither strengthening reds the resting tree (§0a: all 30 name real REL tickets; all four unwritten
are declared).

---

## 5. Why NOT hard-red now — the `ci-required` interaction, spelled out

This is the paragraph the design exists to get right. The pure "must exist on disk" check (option b)
would, at rest, push **24 errors** (§0a) → `policy` exits 1 (`:2749-2751`) → `ci-required`'s
always-on gate sets `fail=1` (`pr.yml:1383-1386`) → the branch-protection check is red **on every
PR, docs-only included, until all four REL tickets exist.** Given REL-001/002 are blocked on Sprints
7/8 and REL-005 on all of them (§0d), "until they exist" is *the rest of the programme*. That is not
"honestly-red"; it is a self-inflicted merge freeze — the precise outcome GO-BOOK §2.0 now forbids
(*"a red required check now BREAKS the gate"*).

The trackable-strict gate (c) pushes **zero** errors at rest: 6 crossings pass on disk-existence
(REL-004), 24 on manifest-deferral. `policy` stays green, `ci-required` stays green. E0 is
nonetheless **honest** — the 24 unwritten tests are now machine-visible as declared debt with
reasons, exactly as `check-finding-ownership.mjs` prints its one deliberate `unowned` finding on
every green run (GO-BOOK §6). When REL-003 lands, its deferral is removed and its 2 crossings pass on
disk; when the last of the four lands and the manifest empties, the checker is the pure existence
check the go-book asked for, with nothing deferred — **and at that point, and only then, a red is a
real "someone deleted a written test" red, not a "nobody wrote it yet" red.**

**Sequence for the whole of Sprint 9 (recommendation):**

1. **Unit 1 — REL-FOUNDATION-GATE (this ticket).** Trackable-strict gate + manifest. Ships green.
2. **Unit 2 — REL-003** (dependency-ready). Real DR/migration rehearsal. On landing, delete
   `deferred["REL-003"]` in the same commit (else stale-deferral reds).
3. **Units 3-4 — REL-001, REL-002** — **gated on Sprints 7/8**. If BRW-006/SVC-006/007 have not
   shipped, STOP and say so (GO-BOOK §2.4); do not author an adversarial/load suite against absent
   workloads. Each landing removes its deferral.
4. **Unit 5 — REL-005** (last). Private-beta + kill-switch write path. Removes its deferral; the
   manifest is now empty and the gate is fully strict.

Only unit 1 ships green with no unshipped dependency. That is why it is first.

---

## 6. Non-checker decisions inside the change

* **The manifest is `version`-stamped and object-shaped**, mirroring `threat-controls.json`
  (`version:1` + a named object), so a future schema bump is detectable and a malformed manifest
  fails structurally rather than silently.
* **Existence is keyed on the design doc**, §3.2 — a decision, recorded so a later reader does not
  "fix" it to the result doc and thereby let a ticket count as written only after it ships.
* **The manifest lives in `docs/architecture/`**, beside the register it qualifies, not in
  `scripts/` — the checker's other inputs are all `docs/…`, keeping its file-reading uniform and
  keeping the harness copy-list coherent.

---

## 7. Implementation — bite-sized RED/GREEN steps

Every step: write the failing test → **run it and watch it fail for the stated reason** → minimal
implementation → run it and watch it pass → commit. *A RED that does not fail for the reason written
down proved nothing; stop and find out why.* The checker has its own `node:test` suite; run it
directly:

```bash
node --test scripts/check-distributed-execution-foundation.test.mjs
node scripts/check-distributed-execution-foundation.mjs   # the real-tree run: must PASS at rest
node scripts/check-guard-inventory.mjs && node scripts/check-finding-ownership.mjs
```

`scripts/test-execution-census.json` / `check-execution-census.mjs` cover `*.test.mjs`; this unit
adds no NEW test file (it extends the existing one), so no census bump — **verify that at tip**
(GO-BOOK §5 warns this guard reds a sprint that adds a script test; it does not fire on edits to an
existing one).

### ★ Step 1 — RED: the POSITIVE CONTROL, first

Before any strict logic exists, prove the harness can SEE a missing-and-undeclared release test.
Write, and watch fail:

* `valid: the real repository passes` (`:158-161`) — must stay green after every step (the truest
  signal). Run it FIRST as the control that the resting tree is self-consistent.
* a new case: a fixture where one Critical crossing names **only** an unwritten, **undeclared**
  ticket (delete that ticket's manifest entry) → expect an error containing *"neither exists on disk
  nor is declared deferred"*. On the UNMODIFIED checker this case is **green** (bare string accepted)
  — that is the RED-that-proves-the-gap: the assertion `hasError(errors, "neither exists")` fails
  because the strict logic is not written yet.

**GREEN:** implement §4's `checkCrossingReleaseTest` + load the two inputs; both cases pass.
**Commit:** `REL-FOUNDATION-GATE: strict release-test gate with a positive control`.

### Step 2 — the deferral arm is load-bearing (the anti-hard-red guard)

Case: the unmodified real manifest declares REL-001/002/003/005; assert the real-tree run is green
(24 crossings admitted via deferral). Then a fixture that **deletes** `deferred["REL-001"]` → the
**14** crossings naming REL-001 (C2: verified count at tip — not 10) red with *"neither exists … nor
is declared"*. Assert on the error substring, not a fragile exact count. This is the case that proves
option (c) actually admits declared debt (and demonstrates, in a test, the hard-red state option (b)
would ship).

### Step 3 — "names no REL ticket" and "every named ticket admissible"

* fixture: set a Critical crossing's `releaseTest` to a non-REL string (`"manual smoke"`) and strip
  its `REL-*` owners → error *"names no REL release-test ticket"*. (Closes the arbitrary-string
  loophole.)
* fixture: append `"REL-999 …"` to a crossing's `releaseTest` (a token no node/file/manifest backs)
  → error naming REL-999. (Proves *every* named ticket is checked, not just one.)

### Step 4 — manifest hygiene (§3.3)

* **stale:** add `deferred["REL-004"]` (REL-004 exists on disk) → error *"declared deferred but its
  design doc exists"*. This is the self-cleaning guard; it is what forces a landing REL ticket to
  retire its own entry.
* **malformed:** set `deferred["REL-001"] = {}` (no reason) → malformed error.
* **unreferenced:** add `deferred["REL-777"]` named by no crossing → unreferenced error.
* **absent manifest:** `fs.rmSync` the manifest → *"… : missing"* (fail-closed, §3.4), NOT a pass.

### Step 5 — the fixture-harness extension itself

Extend `makeFixture` (§3.4) to copy the E11 tickets dir + the manifest and expose them on `files`.
The RED that proves this is necessary: run Step 1's positive control **before** extending the
harness and watch `valid: an unmutated fixture copy passes` (`:163-167`) fail with 24+
missing-and-undeclared errors (the fixture root has neither input); extend the harness; watch it go
green. This is the step most likely to be skipped and the one §3.4 calls the trap.

### Step 6 — the mutation sweep

Per §8. DELETE each guard, run the named test, watch it die, restore. **Positive control (M0)
first.**

### Step 7 — docs + the discrepancy finding

* `REL-FOUNDATION-GATE-result.md`: what shipped, the mutation line, and — as a headline, not a
  footnote — *this unit makes E0 honest WITHOUT re-reddening `ci-required`; the four release tests
  are now tracked debt, not vacuous green.*
* **Create `epics/E11-hardening-release/findings.md`** (none exists at tip) with the §0(f)
  discrepancy as a finding, **and** a `scripts/finding-ownership.json` key for it in the SAME commit
  — a new open finding is born `undeclared_finding` and reds `policy` otherwise
  (`finding-ownership.mjs:88-90`). `unowned` with a reason is legitimate: it blocks nothing; it
  records that GO-BOOK §4/§5 and the terrain audit carry the pre-CI-green "honestly-red" framing that
  this unit's §5 corrects. Update GO-BOOK §3.1 (add the S9 unit-1 row), §4 Sprint 9 (retire *"two
  lines from honest"*; state the trackable-strict resolution), and §5 if the vacuous-green is now
  retired debt.

---

## 8. Mutation table — DELETE each guard, positive control FIRST

The existence check is load-bearing, so M0 breaks the whole gate before any single arm is tested.

| # | Mutant (DELETE / neuter) | Killed by | Load-bearing? |
|---|---|---|---|
| **M0** | **positive control** — make `checkCrossingReleaseTest` a no-op (`return` immediately, admit everything) | Step 1's "names only an undeclared, nonexistent ticket → error" case (no error ⇒ the suite never exercises the gate) | the gate itself |
| M1 | delete the **disk-existence** arm (`written.has(id)`) | `valid: the real repository passes` (`:158-161`) — the **6** REL-004 crossings red, because REL-004 exists on disk but is (correctly) NOT in the manifest | yes |
| M2 | delete the **manifest-deferral** arm (`isDeferred`) | `valid: the real repository passes` — the **24** unwritten-but-declared crossings red (this mutant *is* option (b)'s hard-red state) | yes |
| M3 | delete the **"names a REL ticket"** guard (skip the `named.size === 0` push) | Step 3's non-REL-string case | yes |
| M4 | delete the **stale-deferral** guard | Step 4's `deferred["REL-004"]` case | yes — this is what forces landing tickets to retire their deferral |
| M5 | delete the **malformed-deferral** guard (accept empty `reason`) | Step 4's `{}` case | yes |
| M6 | delete the **unreferenced-deferral** guard | Step 4's `REL-777` case | yes |
| M7 | make an **absent manifest** fail-open (skip the `readOrError` missing push, default to `{}`) | Step 4's `fs.rmSync` case | yes — fail-open reopens the vacuous green |
| M8 | change existence match to the **result** doc (`-result.md`) instead of `-design.md` | a fixture with a `REL-00X-design.md` but no result doc must still admit — RED if the checker demands the result doc (§3.2) | yes |

Report as: *N mutants, N killed, 0 survivors, 0 documented equivalents, 0 false kills* (the WRK-008
convention, GO-BOOK §2.2 step 5). **Print whether the anchor matched** on every DELETE — a CRLF /
indentation miss has produced three wrong verdicts in this repo (GO-BOOK §2.2 step 5).

---

## 9. Acceptance mapping — every clause to a test that can turn RED

| Acceptance clause | Test | Turns RED when |
|---|---|---|
| a crossing naming an undeclared, nonexistent REL ticket is refused | Step 1 positive-control case | the gate admits it (M0) |
| the resting real tree passes (green ships) | `valid: the real repository passes` (`:158-161`) | either admissibility arm is dropped (M1/M2) or a resting crossing/manifest is inconsistent |
| a written ticket admits on disk without a manifest entry | the REL-004 crossings inside the real-tree pass | M1 |
| a declared-deferred, unwritten ticket admits | the REL-001/002/003/005 crossings inside the real-tree pass | M2 |
| a release test that names no REL ticket is refused | Step 3 non-REL-string case | M3 |
| every named ticket is checked, not just one | Step 3 `REL-999` case | the "every" quantifier weakens to "some" |
| a deferral for a now-written ticket is refused (self-cleaning) | Step 4 stale case | M4 |
| a deferral without a reason is refused | Step 4 malformed case | M5 |
| a deferral named by no crossing is refused | Step 4 unreferenced case | M6 |
| an absent manifest fails closed | Step 4 rmSync case | M7 |
| existence is keyed on the design doc | Step 4 / M8 fixture | the checker demands the result doc |
| the fixture harness sees both new inputs | `valid: an unmutated fixture copy passes` (`:163-167`) | `makeFixture` is not extended (§3.4, Step 5) |
| `ci-required` stays green | `node scripts/check-distributed-execution-foundation.mjs` exits 0 at rest; `policy` green in CI | any of the above reds the real-tree run |

---

## 10. Non-goals, named with owners

| Not delivered | Owner | Why |
|---|---|---|
| Writing any REL test (REL-001/002/003/005) | **Sprint 9 units 2-5** (§5 sequence) | Real, multi-session, dependency-gated implementation (§0d); not a first unit |
| Turning the gate into a pure "must exist, no deferrals" check | **the end of Sprint 9** — collapses automatically when the manifest empties (§5) | Doing it now reds `ci-required` (Answer 1) |
| Filing the go-book/§2.0 discrepancy as a finding | **this ticket's EXECUTION step** (§7 Step 7), not this design | Design docs do not edit registers; a finding needs `findings.md` + `finding-ownership.json` together (E11 has no `findings.md` at tip) |
| Cross-referencing the `releaseTest` FIELD's REL token against the program backlog | folded into §4's "every named ticket admissible" | The `ownerTickets` arm is already cross-referenced (`:806-812`); the field arm inherits the same discipline here |
| Any change to the 30 crossings, the threat model, or `program-design.md` REL node text | — | Out of scope; the register is the input, not the edit |
| `packages/worker-protocol` | — | FROZEN |

---

## 11. Risks

**R1 — the fixture-harness trap (§3.4) is the likeliest way to ship this red.** A strict flip that
reads the E11 tickets dir/manifest without extending `makeFixture` fails
`valid: an unmutated fixture copy passes` — and a hurried author may "fix" it by making the missing
inputs pass (fail-open), silently reintroducing the vacuous green. Mitigation: Step 5 writes the
harness extension as its own RED/GREEN step, and M7 mutation-proves the fail-closed policy.

**R2 — the `ci-required` interaction is the whole reason for the design, and it is easy to get
subtly wrong.** Any code path that pushes an error at rest reds a required check on every PR (Answer
1). The resting-green invariant is guarded by `valid: the real repository passes` — run it after
every step, not just at the end. If a future crossing is added naming a fifth unwritten ticket, its
deferral must be added in the same commit or this guard reds — which is the intended behaviour, not a
regression.

**R3 — the manifest can rot into a list nobody trusts** (the exact failure `finding-ownership`'s
stale guard exists for). Mitigated by the stale (M4) and unreferenced (M6) guards: a ticket that
lands without removing its deferral reds; a deferral for a ghost ticket reds.

**R4 — the go-book still tells the next reader to "flip strict, two lines from honest."** Until §7
Step 7 retires that framing in GO-BOOK §4 Sprint 9 and files the finding, a later session could
re-attempt option (b) and red the gate. The doc edits are part of this unit, not optional cleanup.

**R5 — "existence = design doc" is a convention a later reader may not share.** If someone counts a
ticket as written only once it has a result doc, M8's assertion protects the design-doc keying; the
decision is recorded in §3.2 and the checker's own comment must state it.

---

## 12. Rollback

Delete the manifest, revert `crossingHasReleaseTest` to `:745-751`'s bare-string form, revert the
`makeFixture` extension and the new test cases. There is no migration, no table, no data. Because the
manifest and the finding declaration move as pairs (a finding without a declaration is
`undeclared_finding`; a declaration without a finding is `stale_declaration` —
`finding-ownership.mjs:88-90,132-136`), the docs revert must remove the §0(f) finding **with** its
`finding-ownership.json` key in the same commit. Nothing else in any register moves. The revert
returns E0 to falsely-green — which is a regression of honesty, not of behaviour, and is exactly the
state this unit exists to leave.
