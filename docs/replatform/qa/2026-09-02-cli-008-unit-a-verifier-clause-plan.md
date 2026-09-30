# CLI-008 Unit A — make the capability gap machine-visible

> **For agentic workers:** implement task-by-task, in order. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop a green E7-1 from reading as evidence the agent can work. Today the acceptance
verifier **already computes** the signal that would show it and only prints it. Promote that to a
verdict the machine enforces — and fix the judge **before** building any capability, because every
later CLI-008 unit is judged by it.

**Owner:** CLI-008 (`epics/E7-coding-e2b/tickets/CLI-008-design.md`) — the first unit of E7-F003.

---

## Verified terrain

| Fact | Where |
|---|---|
| The verdict is `ok: failures.length === 0`; the CLI exits `result.ok ? 0 : 1` | `e7-distributed-run-verifier.ts:456`, `cli/verify-e7-1-distributed-run.ts:76` |
| Clauses are flat: `failures.push({ clause: N, reason })`. Highest today is **5** | `:323-432` (14 pushes) |
| Clause 3 is labelled **"Terminal-AGNOSTIC"** in its own comment — `failed` and `timed_out` are accepted | `:341-348` |
| **No clause reads `workload`, `args`, `exitCode`, stdout, or any produced artifact** | measured: 14 `failures.push`, none references them |
| `countProducedOutputs` counts committed `workspace_patch` job artifacts + `task_outputs` by run | `e7-distributed-run-verifier-store.ts:198-218` |
| It rides on `observed.producedArtifacts` and is **only printed** — four occurrences: type, zero-init, assignment, print | `:167`, `:199`, `:453`, `:478` |

**So a `claude` that exits 127, with no tools and a context-free prompt, satisfies every clause.**
That is the defect.

★ **Both counts are structurally 0 today**, and will stay 0 until Unit F: the E2B driver never passes
stream handlers, `stdoutRef`/`stderrRef` are fabricated literals rather than references to stored
bytes, `observeRun` is uncomposed (its absence is *pinned by a test*), and `buildWorkspacePatch` /
`createResultCommitter` have zero production callers. **Read that sentence again before Task 2** — it
is what makes the naive fix wrong.

---

## The design decision, and why the obvious fix is wrong

The obvious move is a **clause 6** that fails when nothing was produced. Do not do that.

`producedArtifacts` is structurally 0 and stays 0 until Unit F ships output capture. A clause 6
folded into `ok` therefore makes **E7-1 permanently red** — a gate nobody can pass. This repository
already knows what happens next: `scripts/lib/gate-clause-wiring.mjs` says it in its own header —
*"a guard that forbids honest debt gets deleted."* A permanently-red gate gets bypassed, argued
around, or `--force`d, and then it protects nothing.

It would also **retroactively invalidate** the D1 40/40 evidence the campaign already cites, which is
honest evidence *of the mechanism* and remains true.

**So: two independent verdict dimensions, not one clause.**

- **`ok`** stays exactly what it is — *the distributed journey is corroborated*. True today, and the
  thing D1 proved.
- **`capabilityProven`** is new, computed from `producedArtifacts`, and always reported.
- The CLI gains `--require-capability`, which makes an unproven capability exit non-zero. **Default
  off**, so nothing that passes today starts failing — and when Unit F lands, that flag becomes the
  campaign's real gate.

★ The point is not the flag. The point is that **the go-book has been asserting "a green E7-1 proves
the MECHANISM, not capability" in prose for weeks, and nothing computed it.** A claim with no
mechanism is the failure class this programme keeps paying for. This unit turns that sentence into
code.

---

## Task 1: Pin the blind spot BEFORE closing it

**Files:** Modify `server/src/__tests__/e7-distributed-run-verifier.test.ts`

- [ ] **Step 1: A fixture that is a context-free run, and passes**

Seed a run that satisfies every existing clause — leased, `attempt_started`, terminal, projection
receipt applied — with **zero** produced artifacts and **zero** task outputs. Assert
`result.ok === true`.

★ **This test asserts today's broken behaviour on purpose**, exactly as the Unit 2.2 repro did. Name
it so nobody "fixes" it later: it is the record of what the verifier could not see.

- [ ] **Step 2: Assert the counts are visible but inert.** `observed.producedArtifacts` is
  `{ workspacePatchArtifacts: 0, taskOutputs: 0 }` *and* `result.failures` is empty — the signal
  exists and changes nothing. That pairing is the finding, in one assertion.

- [ ] **Step 3:** Run, commit — `test(cli-008): pin the verifier blind spot before closing it`.

---

## Task 2 ★: The capability dimension

**Files:** `server/src/services/e7-distributed-run-verifier.ts`

- [ ] **Step 1: The result type gains two fields**

```ts
  /**
   * Did the agent DO anything that reached AoA? Independent of `ok`, deliberately.
   * `ok` answers "was the distributed journey corroborated" — the MECHANISM. This answers
   * "could the agent work" — the CAPABILITY. They are different questions and E7-F003 exists
   * because one was being read as the other.
   */
  readonly capabilityProven: boolean;
  readonly capabilityFailures: readonly E7VerifyFailure[];
```

- [ ] **Step 2: Compute it beside the verdict, from the counts already gathered**

Unproven when both `workspacePatchArtifacts` and `taskOutputs` are 0. Give the failure a reason that
names what is missing rather than restating the count — an operator reading it should learn that
output capture is unbuilt, not that a number was zero.

★ **Do not touch `failures` or `ok`.** A mutation test in Task 4 will prove you didn't.

- [ ] **Step 3:** Commit.

---

## Task 3 ★★: Make it impossible to read PASS as capability

**Files:** `e7-distributed-run-verifier.ts` (`formatVerifyResult`), `cli/verify-e7-1-distributed-run.ts`

- [ ] **Step 1: The RESULT line stops being unqualified**

Today it reads `PASS — distributed journey corroborated`. That is accurate and still gets read as
"the canary works". Qualify it so the two dimensions appear together and neither can be quoted
alone — a reader who sees only the first line must not come away believing capability was proven.

- [ ] **Step 2: A CAPABILITY line, always printed**, on pass and fail alike, carrying both counts and
  the verdict. Never suppress it when capability is unproven: that is precisely when it matters.

- [ ] **Step 3: `--require-capability`**

Off by default. When set, `capabilityProven === false` exits non-zero. Document in the CLI header
that this is the flag the campaign flips once Unit F lands, and **why it is not the default today**
— structurally-zero counts would make it a gate nobody can pass.

- [ ] **Step 4:** Commit.

---

## Task 4: Prove all three properties by mutation

**Files:** the verifier test file

- [ ] **Step 1:** Delete the capability computation → Task 1's pin still passes (it asserts `ok`), but
  the new capability assertion reds. **If nothing reds, the dimension is decorative.**

- [ ] **Step 2 ★:** Make the capability failure push into `failures` instead of `capabilityFailures`
  → Task 1's `result.ok === true` pin **must red**. That is the guard against the exact regression
  this design rejects, and it is why Task 1 was written first.

- [ ] **Step 3:** Set one count non-zero in the fixture → `capabilityProven` flips true. A dimension
  that can never be true is not a check.

- [ ] **Step 4:** Report all three results, then commit.

---

## Task 5: Say it where it is currently only prose

- [ ] **Step 1:** `docs/replatform/epics/E7-coding-e2b/findings.md` — E7-F003 gains a line: the blind
  spot is now computed, `--require-capability` is the flag, and it is off until Unit F.
- [ ] **Step 2:** `CLI-008-design.md` §2 — mark Unit A done and record what it did **not** do.
- [ ] **Step 3:** The go-book's E7-1 row — the "a green E7-1 proves the MECHANISM only" caveat now
  cites a computed field rather than asserting itself.

★ **Do not write anything that reads as an unblock.** Capability is still unproven; this unit makes
that legible, which is the opposite of progress toward a green campaign and should be said plainly.

---

## Task 6: Verification

- [ ] **Step 1:** `node scripts/ci-local.mjs` — the fast gate (~3.5 min). It covers policy, lint,
  brand-check and contract-bytes and **nothing else**; it caught neither of Unit 2.5's two real CI
  failures, so it is a first filter, not a verdict.
- [ ] **Step 2:** `AOA_RUN_WIN_INTEGRATION=1 npx vitest run server/src/__tests__/e7-distributed-run-verifier*.test.ts`
- [ ] **Step 3:** The sharded suite; reproduce any failure in isolation before attributing it.
- [ ] **Step 4:** Report back — do not push. Include all three Task 4 mutation results.

---

## Self-review

**Coverage.** The blind spot → Task 1. The signal → Task 2. Its legibility → Task 3. That all three
are real → Task 4. The prose that currently carries the claim → Task 5.

**Deliberately NOT done.** No output capture is built, so `capabilityProven` will be **false on every
real run** after this lands. That is the correct and intended outcome: the verifier starts telling
the truth it already had the data for.

**Placeholders.** None. Task 2 Step 2 and Task 3 Step 1 state the required property rather than the
exact wording, because the wording is the deliverable there and prescribing it would beg the question.
