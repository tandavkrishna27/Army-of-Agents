# W7U1 — the output probe pack: operator runbook

**Status:** built, CI-green, **never fired**. Firing it is an operator action.
**Written:** 2026-09-06, against `31d33a3b0`.
**Read this instead of the source.** Everything you need to run the pack and read its answer is here.

---

## 1. What this measures, in one paragraph

A 26-agent decision wave concluded: **build no output mechanism, measure first.** The unresolved
question underneath every proposed mechanism is whether a real coding agent, invoked the way AoA's
distributed path actually invokes it, can write a file inside the sandbox **at all**. This pack
answers that with one keyed E2B run, plus two cheaper questions worth answering in the same run. It
**builds nothing**, **changes no gate, counter or register**, and touches no database. It creates
short-TTL sandboxes, writes and reads files inside them, records a verdict **durably** (§5), and
tears them down.

---

## 2. The trigger command

```bash
gh workflow run keyed-e2b-w7u1-output-probe.yml --ref docs/replatform-program
```

If that answers `HTTP 404: workflow ... not found on the default branch` — which happens to a lane
GitHub has not yet indexed, measured on `keyed-e2b-egress-constraint-probe.yml` on 2026-09-04 — use
the push route instead. It always works:

```bash
git switch docs/replatform-program && git pull
echo "W7U1 probe pack run #1 (2026-09-XX): why you are firing it" >> .github/keyed-e2b-w7u1-output-probe-trigger
git add .github/keyed-e2b-w7u1-output-probe-trigger
git commit -m "chore(w7u1): fire the output probe pack"
git push
```

`.github/keyed-e2b-w7u1-output-probe-trigger` is the **only** path in the workflow's `push` filter,
and the pack's PR deliberately does **not** create it. So merging the pack fires nothing, and editing
the pack's own source later fires nothing either.

> ★ **Why this lane does not re-fire on a source change, when its siblings do.**
> `keyed-e2b-unit-d.yml` lists the module under test in `paths` on purpose, so an edit to the emitted
> shape cannot quietly return it to argued-not-observed. That is right for a lane that costs only
> sandbox seconds. This one spends **model tokens against an authorisation a person gave**, so an
> automatic re-fire would consume an authorisation nobody granted.

### 2a. WHICH TEMPLATE TO PASS — and what happens if you do not

**Pass `aoa-base`.** That is the alias `e2b/e2b.Dockerfile` builds, and its final layer is
`RUN command -v claude && command -v codex && claude --version && codex --version`, so an image that
built at all has both agent CLIs on PATH. It was measured `buildStatus: ready` on the operator's E2B
account on 2026-08-31 (templateID `7vg8mu6gaoz2inw62lv8`,
`docs/replatform/qa/2026-08-31-campaign-blockers-and-fleet-terrain.md` §9d).

```bash
gh workflow run keyed-e2b-w7u1-output-probe.yml --ref docs/replatform-program -f e2b_template=aoa-base
```

**If you pass nothing, the pack resolves to `aoa-base` anyway — it does NOT fall back to bare
`base`.** This lane deliberately diverges from every sibling keyed lane here. E7-F022 measured that
they all pipe `inputs.e2b_template` straight into `E2B_TEMPLATE`, so an omitted input silently
selects the bare `base` template, which has **no agent CLIs** ("coreutils only",
`.github/keyed-e2b-trigger` entry #4). For a lane whose subject is the invocation *shape* that costs
nothing; for this pack it would spend your one authorised, token-spending run on an image that
cannot host the thing being measured. `resolveTemplate`
(`scripts/lib/w7u1-agent-output-probe.mjs`) therefore corrects **omission** — and only omission.

* **The push route is safe too.** A `push` event carries no inputs, so `E2B_TEMPLATE` arrives empty
  and the same resolution applies. There is no way to fire a bare-`base` run by omission from
  either route.
* **An explicitly supplied alias is honoured verbatim, including `base`.** If you deliberately want
  the no-CLI measurement, type it; the report and the durable record will both say
  `TEMPLATE: base (explicit)` and flag that it carries no CLIs.
* **The resolved id is printed at the top of the report and stored in the durable record**, so a
  reader six months from now can always tell which image answered.

> ★ **What a bare-`base` run actually does, traced rather than assumed.** It cannot produce a false
> NO. Probe A's first in-sandbox command is `command -v node || echo NO_NODE; command -v npm || echo
> NO_NPM`, and a hit on either returns `inconclusive-because-template-has-no-node-runtime` before the
> CLI install is attempted; a fault in that probe falls through to `cli-install-failed` or
> `cli-binary-not-on-path`, both also inconclusive. Every bare-`base` path reds the lane as
> "run me again", never as "the agent cannot write". The default is a **waste** guard, not a
> correctness guard — but the waste is the founder's single authorised run.

> ★★★ **AND SINCE 2026-09-07 THE IMAGE IS CHECKED, NOT JUST THE NAME (probe T, §5).** `aoa-base` on
> `base` is a *name*; `resolveTemplate` corrects the name and nothing looked at the filesystem. Probe
> T now creates one cheap sandbox from the **resolved** template, runs the same
> `command -v claude` / `command -v codex` assertion `e2b/e2b.Dockerfile`'s final layer makes, and
> **records the answer beside probe A's** — so the durable record names the template and any missing
> binary, and probe A's verdict carries a `CAVEAT:` when the image was not certified.
> This is the "lane-time assertion" E7-F022's own owner paragraph asked for. ★ It is a **caveat, not a
> gate**: probe A installs its own CLI and does not depend on the image carrying one, so blocking on
> probe T could only turn an unknown into a guaranteed zero-information run — the argument is in §5's
> probe T box. It does not close that finding: the sibling keyed lanes still default to bare `base`,
> and the three template variable names still disagree.

**Other optional inputs.** None. `e2b_template` is the only one.

---

## 3. The secrets it needs

| Secret | Status today | What it gates |
|---|---|---|
| `E2B_API_KEY` | **exists** as a repo secret | everything. Without it the whole pack **skips** and the workflow's positive-control step fails the job with a message saying so. |
| `OPENAI_API_KEY` | **exists** as a repo secret | probe A's **codex** arm. Runs with no operator action. |
| `ANTHROPIC_API_KEY` | ~~does NOT exist (`gh secret list`, 2026-09-06)~~ → **★ EXISTS as of run `34087197668` (2026-09-07)**: the claude arm authenticated, reached a model on all three agent arms, and returned a decisive verdict. An operator added it between the pack landing and the run. | probe A's **claude** arm. Without it that arm reports `inconclusive-because-no-model-provider-key` and, because an inconclusive probe reds the lane, **the job will fail** — see §5. |

**Decide before you fire:** if you want the claude arm (and you probably do — `claude_local` is the
adapter the distributed path is being built for), add `ANTHROPIC_API_KEY` as a repository secret
first. Otherwise expect a red job whose summary reads `A/claude_local: INCONCLUSIVE —
no-model-provider-key`, which is an honest report of a question not reached, not a bug.
★ **This paragraph is retained rather than deleted**: a secret can be rotated or removed, and the
row above records when it was observed present, not that it is permanent. The workflow file's own
header still says the key does not exist — it is dated `2026-09-06` and self-limiting, and it is
**not** edited here because this unit changes no CI configuration.

No key is written into the repository, printed, or embedded in a fixture. The keys reach the sandbox
as **per-command environment variables** (never as argv elements, never staged into a file), and
every string the pack prints is passed through its own redactor first
(`redactSecrets`, unit-tested in the required `policy` job).

---

## 4. What it costs

| | |
|---|---|
| Sandboxes created | **4** — one for probe B, one for probe C, one per probe-A adapter arm |
| Sandbox TTL (hard ceiling per sandbox) | 300 s for probes B and C; **1,800 s** for each probe-A sandbox. Sized per sandbox on purpose: probe A must outlive `install (420 s) + 3 agent arms (180 s each)` = 960 s of in-sandbox work, and a shared 900 s TTL would have expired the sandbox mid-run and reported the expiry as the agent's answer. |
| Expected sandbox wall time | **~7–23 minutes total** (~400–1,400 sandbox-seconds). Most of it is `npm install -g` of the agent CLI, twice. |
| Absolute worst case if everything stalls | 2 × 300 s + 2 × 1,800 s = 4,200 sandbox-seconds, and only if every teardown also fails — every sandbox is torn down in a `finally`. |
| Model tokens | **6 agent invocations** (3 arms × 2 adapters), each a ~60-word prompt asking for a one-line file. Well under a dollar. |
| Job timeout | 60 minutes (the in-test budget is 50, so a kill names this job rather than an innocent step) |
| Per-agent-arm timeout | **180 s.** A permission-gate stall must time out and be *recorded as a stall*, not run to the job cap. |

---

## 5. How to read the result

The verdict is written to **three** places, on a red run as well as a green one:

| Where | What is there | Why |
|---|---|---|
| **Job summary** (the run page, nothing to download) | the whole human report, as a fenced block | the fastest read |
| **`w7u1-output-probe-record` artefact** (Artifacts section of the run, 90-day retention) | `w7u1-output-probe-record.json` — schema `aoa.w7u1.output-probe-record/2`: the disposition, **every probe's state AND reason**, the **resolved template id and how it was resolved**, the commit sha, the run url, the run nonce, and — new in `/2` — **`armEvidence`: the exact stdout each probe-A arm's verdict was computed from** | the record that outlives the log, and the only place a verdict can be re-derived |
| **Step log** | the same report plus every per-arm line | the detail |

> ★★★ **Why the pack is not allowed to answer only into a log.** E7-F025 measured this repo's own
> instance of the failure: the sibling keyed lane `keyed-e2b-conformance.yml` **already fired twice**
> — re-fires #3 (2026-08-19) and #4 (2026-08-26) per `.github/keyed-e2b-trigger` — and **no document
> in the repo records either outcome**, so the honest state of that measurement is *fired and
> unrecorded* and the next session re-asks the question. Both the fallback writer and the artefact
> upload are `if: always()` for the same reason: the **inconclusive** run is exactly the run whose
> detail somebody needs, and exactly the run a success-gated step throws away.
> `evaluateDurableRecord` (`scripts/lib/w7u1-agent-output-probe.mjs`) asserts both guards against the
> real YAML in the required `policy` job, so removing either one reds CI.

> ★★★ **THE RECORD IS THE AUDITABLE ARTEFACT. THE CONSOLE IS NOT. Do not settle an argument out of
> the job log.** Measured, on run
> [`34087197668`](https://github.com/MeteoriteLabs/AoA/actions/runs/34087197668): the pack logged
> `safe(exec.stdout, 900)` per arm to the console and handed `safe(exec.stdout, 8000)` to the
> classifier, and the record carried **no stdout at all**. The consequence is checkable in that run's
> log today — it contains **zero** instances of `assistant`, `output_tokens`, `agent_message` or
> `turn.completed`, none of the four shapes the model-contact predicate looks for, **including for
> the claude arms that demonstrably did reach a model**. So every verdict that run produced is
> unauditable against what it shipped, and six sentences in this repo went on to assert more about
> codex A2 than its 900 preserved characters could support. Schema `/2` closes it: the classifier
> slice and the record slice are now **the same string**, taken once, bounded by the single exported
> constant `CLASSIFIER_STDOUT_LIMIT` (8000). The console line stays at 900 **on purpose** — a
> 900-character console line is a reasonable console line, and the fix was never to enlarge the log.
> ★ `armEvidence[].stdoutTruncated` travels with the bytes, because *"no model-contact evidence in
> the whole of stdout"* and *"none in the prefix the classifier could see"* are different claims.

**After the run: copy the record into a `-result.md` next to this file, naming the run id.** The
artefact is retained for 90 days; the ticket record is not.
★ **DONE for run 1 — [`W7U1-output-probe-result.md`](./W7U1-output-probe-result.md).**

> ### ⚠ READ THE ARTEFACT, NOT THE LAST REPORT BLOCK IN THE LOG
>
> **A successful run still emits TWO blocks headed `W7U1 OUTPUT PROBE PACK — RESULT` in the STEP
> LOG.** The pack's no-key self-test calls the real `emitDurableRecord` with fixture verdicts
> (details literally `d1` and `d2`), so a **synthetic** report — same banner, same `TEMPLATE:` line,
> same commit sha, same **real run nonce**, same arm legend, ending `DISPOSITION: inconclusive` — is
> rendered milliseconds after the real one and *below* it. Observed in run `34087197668`. Filed as
> **E7-F029**.
>
> ★ **HALF FIXED, 2026-09-07 (W16B).** The self-test now points `GITHUB_STEP_SUMMARY` at a temp file
> for the duration of the call, exactly as it already did for `W7U1_RECORD_PATH`, and asserts the
> rendered block landed there. **The RUN PAGE — the surface a human reads first — no longer carries
> the synthetic block**, and the summary channel now has a wiring assertion it never had. The
> **step-log** duplicate remains, deliberately: silencing `console.log` would kill the only assertion
> that `emitDurableRecord` emits at all, and the structural fix (a fixture banner rendered by
> `report()` itself) is a larger change. So: the uploaded artefact is correct, the run page is
> correct, **and the raw step log still shows two blocks.**

Every probe reports one of three states. **`no` is a result and the lane stays GREEN for it.**
`inconclusive` is the only state that reds, because it is the only one that means *run me again*.

> ★★★ **Why that asymmetry is the point of the unit.** If the only green outcome were "the agent
> wrote a file", then "the agent cannot write" would arrive as a red build — indistinguishable from a
> bad key, a template change or an outage — and the one authorised run would have bought an ambiguity
> instead of an answer. A probe that can only pass is worthless.

> ### ✅ REAL SUMMARY — run [`34087197668`](https://github.com/MeteoriteLabs/AoA/actions/runs/34087197668), 2026-09-07
>
> The pack has been fired **once**. The block below is that run's real report, abridged only by
> truncating the long `detail` lines — nothing is invented. Commit `1c447fa8a`, template `aoa-base`,
> conclusion `success`. Full record, including the per-arm exit codes and the four things the run
> does **not** establish: [`W7U1-output-probe-result.md`](./W7U1-output-probe-result.md).
> (This block replaced an `<placeholder>` illustration; an earlier draft than that one printed
> *invented* specific values, including a decisive `NO` for probe A, which an operator could have
> mistaken for a result.)

```
================ W7U1 OUTPUT PROBE PACK — RESULT ================
TEMPLATE: aoa-base   (default-cli-bearing)
  no template was supplied, so the pack resolved to "aoa-base" — the alias e2b/e2b.Dockerfile
  builds with claude+codex asserted on PATH. It does NOT fall back to "base" …
commit: 1c447fa8abe774b95fe1f7c24a95c66c460e66a7   run nonce: W7U1-MTQT1763-OJ2WYK7K

Probe A arms:
  A0  HARNESS CONTROL — plain shell writes the file; we read it back
  A1  THE QUESTION — the exact production argv, no permission posture
  A2  THE DIFFERENTIAL — permission posture ADDED inside the probe. The same prompt TEMPLATE as
      A1, differing only in the two lines naming this arm's own target path and nonce
  A3  NEGATIVE CONTROL — a prompt that forbids writing; a file here kills attribution

PROBE B: NO — template-prefills-nothing
    none of the 7 candidate output paths exist in a fresh sandbox. Directory listing (5 entries):
    /home/user/.bash_logout /home/user/.bashrc /home/user/.profile … (aoa-workspace and .aoa absent)
PROBE C: YES — both-streams-delivered
    onStdout and onStderr each received their marker from a real E2B sandbox, and the command exited 0.
PROBE A/claude_local: NO — a1-did-not-write-and-the-posture-is-the-cause
    A1 (production argv) did not write (exited-0); A2 … with the permission posture added … DID.
    The absent permission flag is the cause. That is a PRODUCT finding about
    task-run-sandbox-invocation.ts's four script literals …
PROBE A/codex_local: NO — a1-did-not-write-and-the-posture-is-not-the-cause
    Neither A1 (exited-1) nor A2 (exited-1) produced the file. …

DISPOSITION: measured — B=no C=yes A/claude_local=no A/codex_local=no
```

> ★★★ **The `codex_local` REASON STRING ABOVE IS WRONG, and the run's own stderr says so.** A1 was
> refused by codex's trusted-directory gate (*"Not inside a trusted directory and
> `--skip-git-repo-check` was not specified."*) and **A2, with the posture, got PAST that refusal**
> before failing on FOUR `401 Unauthorized` reconnect attempts (`Reconnecting… 2/5` through `5/5`).
> So the posture removed A1's actual blocker,
> and **neither arm was shown to reach the capability question** (A1 demonstrably did not; A2's
> preserved stdout is too short to say). The verdict `no` stands; the stated **cause**
> does not. See **E7-F027** (the codex blockers) and **E7-F028** (why the classifier said this).

### Probe A — can it write? (the decisive one)

| Verdict | What it means | What to do |
|---|---|---|
| `YES — a1-wrote-under-production-argv` | The **exact production argv, with no permission flag**, produced the requested file. Reading a convention path out of a sandbox is already solved (`transport.readFile`), so an output mechanism anchored on the agent writing a known path is **feasible today**. | Hand this to whoever owns the output question. |
| `NO — ...-and-the-posture-is-the-cause` | A1 (production argv) did not write; A2 (**the same prompt template**, permission flag added) did. A1's and A2's prompts are **not byte-identical**: each names its own target path and its own nonce, on two lines, for the same reason A0 needs its own path — a file one arm left behind must never read back as another arm's success. That separation is the arms' identity, not a second experimental variable, and the permission flag remains the only difference in **how the agent is invoked**. **This is a product finding**, not merely an input to a later ticket: the four script literals at `task-run-sandbox-invocation.ts:181-206` carry no permission posture, and the shipped product's own code says one is required for an unattended run. | File it against the invocation module. An output mechanism is feasible *once the posture is fixed*. |
| `NO — ...-and-the-posture-is-not-the-cause` | Neither A1 nor A2 wrote, **and A2 — the only arm carrying the posture — demonstrably REACHED A MODEL**. The detail line names the evidence and its strength: `billed-usage` (a `result`/`turn.completed` reporting output tokens — a round trip that cannot be produced locally) or `model-authored-content` (an `assistant` / `agent_message` / `reasoning` event — text the CLI *attributes* to the model). Adding the posture does not make the agent able to write here. ★ **THIS VERDICT'S GUARD HAS BEEN WRONG THREE TIMES; READ THE RESIDUAL ROW BELOW BEFORE ACTING ON IT.** v1 emitted it from any two non-zero exits (E7-F028: codex in run `34087197668`, where A1 was refused at startup and A2 with the posture got *past* that refusal — the posture removed A1's blocker, the opposite of exoneration). v2 required "at least one arm started" — the wrong arm. v3 required A2 to have started — but *started* is a head event, and codex A2 in that same run emitted `thread.started` and then FOUR 401 reconnect lines (2/5–5/5), with no model-contact evidence in the EXACTLY 900 characters of stdout the run preserved — a statement about the RECORD, which ends mid-token at `{"type":"i"`, not about the agent. v4 (this) requires model **output** on A2's stdout. | Trust it with the detail line's named evidence in front of you, and only for the claim it makes: **adding the posture is not sufficient**. |
| ★ **THE RESIDUAL — what that `NO` does *not* establish** | The predicate is a **proxy**, and this row is the bound, stated where the verdict is read rather than in a PR body. (1) **Reached ≠ tried.** Model output does NOT establish that the model was given the intended prompt, that it understood the task, or that it ever ATTEMPTED a write; an agent that answered and then declined for its own reasons is indistinguishable here from one that tried and was denied. (2) **It says nothing about A1**, which this branch does not gate — the accompanying "A1 did not write" may itself rest on an arm that died early. (3) **The capture bounds it**: the evidence must fall within the **first 8000 characters** of stdout the pack records (`safe(exec.stdout, 8000)`), so a CLI that emitted more than that before its first model output reads as "did not reach a model" — fail-closed, a false *inconclusive*, never a false exoneration. (4) **`model-authored-content` is CLI-attributed**: a future CLI that synthesised an assistant/agent message locally on a transport failure would satisfy it. Only **`billed-usage`** is a round trip that cannot be faked in-guest. | If your decision turns on any of (1)–(4), this run does not support it. The same sentences are emitted verbatim into the verdict's `detail`, so they are in the durable record too (`EXONERATION_RESIDUAL`). |
| `INCONCLUSIVE — posture-exoneration-unsupported-a2-did-not-reach-a-model` | Neither A1 nor A2 wrote **and A2 cannot be shown to have received output from a model**. Two sub-cases, and the detail line distinguishes them: A2 never started at all (no `{"type":"system","subtype":"init"}` from claude, no `{"type":"thread.started"}` from codex), or A2 **started and then produced no model output the record can show** — the codex-A2 shape from run `34087197668`: `thread.started`, `turn.started`, then `{"type":"error","message":"Reconnecting… 401 Unauthorized"}`. Either way the posture was never exercised, so it may not be exonerated. | Read both arms' `stderr` in the job log, remove the blocker it names, re-run. Do **not** schedule work off a posture conclusion this run did not support. |
| `INCONCLUSIVE — a1-cli-refused-at-startup` | A1 exited **non-zero having written nothing at all to stdout** — the CLI refused before it got as far as doing or declining the work. That is an apparatus-level miss, not a capability answer. ★ This is the state codex A1 should have been given in run `34087197668`, where its stderr read *"Not inside a trusted directory and `--skip-git-repo-check` was not specified."* | Read the arm's `stderr`, remove the refusal (see **E7-F027**), re-run. Nothing about codex's ability to write has been measured. |
| `NO — ...-cause-unattributed` | A1 did not write and A2 could not be read. The NO is sound; the **cause is not established**. | Fix whatever made A2 unreadable (see its `cause`) and re-run. |
| `INCONCLUSIVE — harness-control-failed` | **A0 failed**: plain shell wrote a file and we could not read it back. The write/read path itself is broken, so A1's empty result attributes to nothing. | The probe is broken, not the product. Nothing may be concluded. |
| `INCONCLUSIVE — negative-control-violated` | **A3 was violated**: we told the agent *not* to write, named the path, and a file carrying A3's nonce appeared anyway. Something other than the agent is writing at the watched path. | Nothing in probe A may be attributed to the agent. This is E7-F020's class one layer down and is itself worth filing. |
| `INCONCLUSIVE — a1-read-faulted` | **The readback itself failed**, for a reason that was *not* a genuine "no such file". The transport raises `E2bTransportNotFoundError` for a missing sandbox-or-path and rethrows everything else, so the probe can tell the two apart — and a fault establishes nothing about whether the agent wrote. A0 does **not** cover this: A0's success is *earlier* than A1's readback, not concurrent with it. | Re-run. Nothing about A1 may be concluded, and in particular the posture is neither convicted nor exonerated. |
| `INCONCLUSIVE — a1-binary-not-runnable` / `cli-install-failed` / `cli-binary-not-on-path` / `template-has-no-node-runtime` | The agent CLI never ran. The experiment **did not happen**. | See §6. |
| `INCONCLUSIVE — no-model-provider-key` | The adapter's key is not a repo secret. | Add it (§3) and re-run. |

★ **`no file`, `hung`, and `exited 127` are three different answers and the pack keeps them apart.**
The `cause` field on each arm says which: `stalled` (no terminal inside 180 s — the shape a
permission gate takes in `--print` mode), `exited-<n>` (a clean terminal and still no file), or
`binary-not-runnable` (the experiment never happened). **And the READ is a fourth channel:**
`read-faulted` means the target path could not be read at all, which is not the same as reading it and
finding nothing — collapsing those two is how an apparatus failure gets printed as a capability
answer. Exit code, stdout, stderr and the read's `errorKind` for every arm are in the step log,
redacted.

> ★ **A3 runs with the permission posture, mirroring A2 rather than A1.** Under A1's conditions a
> stalled agent writes nothing whatever it was asked, so "A3 wrote nothing" would be satisfied by the
> stall and would prove nothing about attribution. Run under the arm most able to write, "asked not
> to, and did not" is a real statement.

### Probe T — does the resolved image actually carry the agent CLIs?

Added 2026-09-07 (W16B), against **E7-F022**. It runs **FIRST**, in its own cheap sandbox, spending no
model tokens, and it **records a caveat on probe A**. It does **not** gate probe A — see the box below
for why that gate was removed the same day it was proposed.

| Verdict | What it means | What to do |
|---|---|---|
| `YES — template-carries-the-agent-clis` | `command -v claude` and `command -v codex` both resolved inside a fresh sandbox of the **resolved** template — the same assertion `e2b/e2b.Dockerfile`'s final layer makes at build time, re-made against the image that actually answered. | Nothing. Probe A carries no caveat. |
| `INCONCLUSIVE — template-does-not-carry-the-agent-clis` | The image is missing at least one CLI. **Probe A still ran** (it installs its own), and its verdict carries a `CAVEAT:` naming this. The lane is red on probe T's own account. | Read probe A's answer — it stands. Then re-dispatch with `e2b_template: aoa-base`, or rebuild that template on the account (`e2b/README.md` §2-3). |
| `INCONCLUSIVE — template-preflight-unreadable` | The check returned but said nothing about a binary. ★ **Silence is not presence** — the pack refuses rather than inferring the CLIs are there because no `MISSING` line appeared. **Probe A still ran**, caveated. | Read the step log for what the sandbox actually printed. |
| `INCONCLUSIVE — template-preflight-did-not-run` | The check never reached a terminal (timed out, threw, no binary). Nothing is established about the image. **Probe A still ran**, caveated. | Re-run probe T. Probe A's answer from this run is still usable. |

> ★★★ **Why a NAME was not enough, and why a GATE was too much.** `resolveTemplate` already corrects an
> *omitted* dispatch input to `aoa-base` rather than bare `base`. But an operator may name any alias
> explicitly (and that is honoured verbatim, deliberately), and an account may hold a stale or
> half-built `aoa-base` — so the image that answered is worth **recording**. E7-F022's own owner
> paragraph names the missing piece: *"a boot-time or lane-time assertion that the registered template
> contains what the Dockerfile promises."* This is that assertion, for this lane. It does **not** close
> E7-F022 — the sibling lanes still default to bare `base`, and the three template variable names still
> disagree.
>
> ★★ **It was briefly a hard gate, and that was wrong.** Three reasons, recorded because they are the
> general shape of a bad gate. (1) **Probe A does not depend on what probe T checks**: probe A
> `npm install -g`s its own agent CLI unconditionally, with a `sudo` fallback, and already has its own
> preconditions for every way that can fail (`template-has-no-node-runtime`, `cli-install-failed`,
> `cli-binary-not-on-path`) — run `34087197668` shows both lanes taking exactly that path
> (`install: "INSTALL_PLAIN"`, `binary = /usr/local/bin/claude`). So the false green E7-F022 feared,
> *"reported green while the CLIs were never present"*, is not reachable through probe A, which cannot
> answer at all without a CLI it put there itself. (2) **The gate had never passed anywhere**: it did
> not exist when the pack last fired, so its first execution would have been on the founder's next
> authorised, token-spending run — an unverified hard gate in front of the only run that answers the
> question converts an unknown into a *guaranteed* zero-information outcome, which is the cost it was
> written to avoid, inverted. (3) **Fail-closed is for wrong answers, not missing ones**: refusing to
> answer is right when answering would assert something unsupported (that is why the exoneration branch
> refuses); here the answer is supported either way and only the note beside it changes.
>
> ★ **What was kept.** Probe T's three-state verdict still goes into the durable record, so the record
> still says which image answered and whether it carried the CLIs, and an `inconclusive` probe T still
> **reds the lane** exactly as any unreadable probe does. The difference is that probe A's answer now
> survives that red instead of being replaced by it.

### Probe B — is the template already satisfying the convention?

| Verdict | What it means |
|---|---|
| `YES — template-prefills-a-candidate-output-path` | A candidate output path **already exists in a fresh sandbox, before any exec**. Any location-based output convention anchored there is satisfiable **by the template alone, with no agent and no output** — E7-F020's class, with an input no protocol surface can see. The detail line names the paths and their sizes. |
| `NO — template-prefills-nothing` | None of the candidate paths exist. The detail line still carries the **full directory listing**, because "what IS there" is the useful answer, not "is X there". |
| `INCONCLUSIVE — candidate-read-faulted` | At least one candidate path's **read failed** for a reason other than "no such file". Its absence is therefore not established, so `template-prefills-nothing` may not be claimed. Note this gates the **NO only**: a candidate that was read and *found to exist* is an observed positive that an unread neighbour cannot unmake. |
| `INCONCLUSIVE — enumeration-failed` | The directories could not be listed — including a listing command that **timed out**, which produces no directory contents and is not an empty directory. |

The candidate reads use the E2B **files API and no exec at all**, so "before any exec" is literal.
The directory listing that follows is the sandbox's first command and is reported as context.

### Probe C — does the stream handler deliver from real E2B?

`YES` = both markers arrived through `onStdout`/`onStderr` and the command exited 0.

> ★ **A correction the pack carries, because the brief that commissioned it was out of date.** The
> premise handed to this unit was that the only real-E2B run of this case FAILED (stdout empty) and a
> re-fire was queued. **The re-fire happened — three times.** `keyed-e2b-conformance.yml` runs
> `32211821459` (2026-08-19), `32995765059` (2026-08-26) and `33788025048` (2026-09-03) all completed
> `success`, and the last one's log names the case: *"CLI-003/D4 … success: a real command streams
> stdout/stderr chunks and exits 0 … 495ms"*, inside `Tests 19 passed (19)`. The stale line is the
> **status field of `CLI-realE2B-hardening-result.md`**, which still reads *"keyed re-fire queued"*.
> Probe C is kept — one authorised run should answer all three questions and a re-measurement that
> agrees is cheap — but it is a **confirmation**, not an open question.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Job fails at "Fail if the pack SKIPPED" | `E2B_API_KEY` was empty; the whole pack skipped and measured nothing. | Restore the secret. A skip is never a pass. |
| `A/claude_local: INCONCLUSIVE — no-model-provider-key` | `ANTHROPIC_API_KEY` is not a repo secret. | §3. |
| `INCONCLUSIVE — template-has-no-node-runtime` | The template that ran has no `node`/`npm`, so the agent CLI cannot be installed. Read the report's `TEMPLATE:` line first — if it says `base (explicit)`, someone typed it; **omission can no longer produce this** (§2a). | Re-dispatch with `-f e2b_template=aoa-base`, or if `aoa-base` is not registered on the account behind `E2B_API_KEY`, build it: `cd e2b && e2b template create aoa-base -d e2b.Dockerfile` (the `e2b template build` form in older docs is a gutted no-op). |
| The run failed and there is **no** `w7u1-output-probe-record` artefact | Should be impossible: both the fallback writer and the upload are `if: always()`. If it happens, the guard in `scripts/lib/__tests__/w7u1-agent-output-probe.test.mjs` has been weakened or the job died before its first step. | Treat the run as **unmeasured**, not as a result, and say so wherever you report it — that is the E7-F025 failure returning. |
| `INCONCLUSIVE — cli-install-failed` | `npm install -g` failed (plain **and** under `sudo`; the log carries the last 20 lines). Usually network or a package-name change. | Read the log, then re-run. |
| `INCONCLUSIVE — probe-threw` | The probe itself raised. The redacted error is in the detail line. | This is an apparatus failure; nothing may be concluded from that probe. |
| An arm's cause is `read-faulted` | The **readback** of the arm's target path faulted (a throw that was not `E2bTransportNotFoundError`). Deliberately **not** read as "the file is absent". | Re-run. |
| A probe-B reason is `candidate-read-faulted` | Same fault, on one of probe B's pre-exec candidate reads. | Re-run. |
| An arm's cause is `arm-faulted` | The sandbox or transport faulted mid-arm (a throw that is not a timeout). Deliberately **not** read as "the agent did not write" — that would manufacture a capability answer out of an infrastructure failure. | Re-run. |
| `gh workflow run` answers 404 | The lane has never run, so GitHub has not indexed it for dispatch. | Use the push route in §2. |

---

## 7. What this pack is NOT

- It **does not build an output mechanism.** It measures whether one is possible.
- It **does not modify the production argv.** Probe A2 varies the argv **inside the probe**, by
  rewriting the emitted script string; `task-run-sandbox-invocation.ts` is untouched.
- It **does not flip `capabilityProven`**, arm any rollout dial, write to any register, or change any
  count. Its only writes are files inside sandboxes it creates and destroys.
- It **does not claim anything about the networked/container lane.** Like every other keyed lane here,
  it is E2B/desktop only (E7-F011).

---

## 8. Where the pieces live

| File | Role |
|---|---|
| `packages/sandbox-e2b-provider/src/__tests__/keyed-w7u1-agent-output-probe.test.ts` | the pack: sandboxes, arms, the report. Skips cleanly without `E2B_API_KEY`. |
| `scripts/lib/w7u1-agent-output-probe.mjs` | the pure core: template resolution, the A2 transform, arm classification, all three verdicts, the redactor, the durable-record builder, and `evaluateDurableRecord` (which asserts the lane's own `always()` guards). Zero imports; no network, no filesystem. |
| `scripts/lib/__tests__/w7u1-agent-output-probe.test.mjs` | proves every one of those decisions **without a key**, on every PR, in the required `policy` job — and pins W7U1's premise (no permission posture in any of the four production script literals). |
| `.github/workflows/keyed-e2b-w7u1-output-probe.yml` | the lane: the pack step, the `always()` fallback record writer, the `always()` artefact upload, and the positive-control step that refuses to let a skip read as success. |
| `.github/keyed-e2b-w7u1-output-probe-trigger` | **not created by the pack's PR.** Creating/appending it on `docs/replatform-program` is the push route to fire the lane. |
