# CLI-008 — The capability half: make the sandbox agent able to work, and make that CHECKABLE

**Status:** **Units A, B and D are SHIPPED** — A merged `0e0904206` (PR #339, 2026-09-02), B merged
`393f7a251` (PR #340, 2026-09-03), D on a PR into `docs/replatform-program` (2026-09-03). Units
**C, E and F remain unbuilt**; no result doc yet, because the ticket closes on the capability, not
on the channel or on one thing riding it. Unit A changed the JUDGE, not the capability; Unit B
built the inbound CHANNEL and nothing that rides it; **Unit D is the first thing that rides it** —
the prompt and the instructions bundle — which closes §1's row 5 and the argv-shaped half of row 2.
**E7-F003 stays open**, because rows 1 (tools), 3-4 (workspace) and the return path are untouched,
so `capabilityProven` is still false on every real run.

> ★ **This line was stale until 2026-09-03 and said the opposite.** It read *"units B–F remain a
> `scoping stub` and Unit B's channel decision is **undecided**"* — while §3 of THIS SAME FILE
> already carried the banner "DECIDED 2026-09-03" and Unit B was merged. The file's last commit
> predated its own build. If you are reading a Status line here, check it against
> `git log --oneline -- <this file>` and the GO-BOOK row before trusting it.

**Open findings owned by this ticket:** E7-F003 (the capability gap itself), E7-F011 (no
`stage_files` route on the networked/container lane — MEDIUM, corrected down from HIGH; **C and D
are NOT blocked by it**, they run on the E2B/desktop lane). **E7-F008 and E7-F009 are CLOSED by
Unit D** — F008 by removing the prompt from argv rather than by the chunking it proposed, F009 by
projecting the union at the call site.
**Epic:** `E7 — Coding/CLI workload on E2B`. **Owns:** `E7-F003`.

---

## 1. The finding still stands, verified row by row

All six rows of E7-F003's table are **still true at HEAD**, checked two ways: no commit since the
finding was filed touches any cited surface, and a per-file `git log -1` on each confirms it. Nothing
has quietly closed.

- `createSpecFor` reads only `workload.command` + `workload.args` (`supervisor.ts:297-303`).
- `ExecuteInput` is exactly `{sandboxId, command, args, env}` — **no stdin** (`provider.ts:200-205`).
- `workspace: null` is hard-coded (`job-leasing.ts:371`) and the field has **zero consumers**.
- `stdinArtifactId` still has zero consumers; every non-test occurrence is a literal `: null`.
- ~~The distributed argv is two literal shapes (`task-run-batch-workload.ts:192-203`), against a
  legacy adapter that assembles `--settings`, `--allowedTools mcp__aoa`, `--model`,
  `--append-system-prompt-file`, `--add-dir` and delivers the prompt on **stdin**
  (`claude-local/src/server/execute.ts:736-772, :879`).~~ **CLOSED by Unit D**, partly: the argv is
  now `sh -c <script> <binary> <paths>`, the prompt arrives on **stdin from a staged file** and the
  instructions bundle on `--append-system-prompt-file` pointed at a staged path (codex, which has no
  such flag, gets the bundle prepended to stdin, exactly as its legacy adapter does). Still missing
  from the argv: `--mcp-config` + `--allowedTools mcp__aoa` (Unit C), `--add-dir` (Unit E) and
  `--model` (still open from Unit A's row).

---

## 2. ★★★ Start with the verifier, because today a green E7-1 proves nothing

The finding says clause 5 keys on `attempt_started`. **It is worse than that, and the fix is cheaper
than that.**

- Clause 3 is labelled *"Terminal-AGNOSTIC"* in its own comment — `failed` and `timed_out` are
  accepted (`e7-distributed-run-verifier.ts:341-348`).
- No clause anywhere reads `workload`, `args`, `exitCode`, stdout, or any produced artifact. The
  verdict is `ok: failures.length === 0` (`:456`).
- **So a `claude` that exits 127, with no tools and a context-free prompt, satisfies every clause.**

★ **And the verifier already computes the signal that would catch it.** `countProducedOutputs` counts
`job_artifacts` rows (`kind='workspace_patch'`, `status='committed'`) plus `task_outputs` by
`created_by_run_id` (`e7-distributed-run-verifier-store.ts:198-218`). The result rides on
`observed.producedArtifacts` and is **printed**. Verified independently: it appears at exactly four
lines — the type, the zero-init, the assignment, and the print — and **none of the fourteen
`failures.push` calls touches it**.

**The first unit is therefore an S**: promote that already-computed field to an asserted clause, and
ship a fixture proving the verifier currently blesses a context-free run. Everything after this is
judged by the verifier; fixing the judge first is the only ordering that makes later units provable.

### Unit A — DONE, 2026-09-02

The verifier now computes two independent dimensions.

- **`ok`** is untouched: *the distributed journey was corroborated* — the MECHANISM. Still true of
  a context-free run, and still exactly what the D1 40/40 evidence proved.
- **`capabilityProven` / `capabilityFailures`** are new: *did anything the agent produced reach
  AoA*. Unproven when both counts are 0; the clause-6 reason names the four unbuilt links in the
  return path instead of restating that a number was zero.
- The **RESULT line carries both verdicts**, so a reader who sees only it cannot come away
  believing capability was proven, and a `capability:` block with both counts prints on pass and
  fail alike — an unproven capability is exactly when it matters.
- **`--require-capability`** makes an unproven capability exit 3. **Off by default**, because the
  counts are structurally 0 until Unit F and a gate nobody can pass gets bypassed and then deleted
  (`scripts/lib/gate-clause-wiring.mjs`, header). It is the flag the campaign flips at Unit F.

Proven by mutation, not by assertion: deleting the computation reds the capability tests while the
E7-F003 pin stays green; pushing the failure into `failures` instead reds **the pin**, which is the
guard against the fix this design rejects; making the push unconditional reds both "one count
non-zero flips it true" arms.

**★ What Unit A did NOT do.** It built no capability. No MCP tool surface, no instructions bundle,
no workspace, no non-argv channel, no output capture — the gap in §1 is exactly as wide as it was,
and `capabilityProven` will be **false on every real run** until Unit F. Unit A did not touch the
`--model` argv item the §4 table pairs with it; that stays open. This unit makes the gap legible.
It is the opposite of progress toward a green campaign, and should be reported that way.

---

## 3. ★★★ The keystone decision — **DECIDED 2026-09-03, and this section was WRONG**

> **Superseded by [`qa/2026-09-03-cli-008-unit-b-channel-decision.md`](../../../qa/2026-09-03-cli-008-unit-b-channel-decision.md).**
> A 40-agent sweep measured **both** load-bearing claims below to be false:
>
> 1. *"The FROZEN `SandboxProvider` port has no file-staging operation"* — this **conflates two
>    objects**. `capabilities.ts` defines a wire/registry VOCABULARY; the port is
>    `worker-daemon/src/supervisor/provider.ts:339`, in a package that is **not frozen**, and it has
>    **already grown to thirteen methods plus a mode field** (`digestArtifact`, `exportArtifact`,
>    `artifactExportMode` — shipped as DAT-009 slice 1, `d5885053f`, with the frozen package
>    untouched).
> 2. *"argv is bounded … therefore the channel must not be argv-shaped"* — the cliff is **8,192
>    CHARACTERS PER ARGUMENT** and ~64 KiB per job, not 8 KiB per job. Chunked argv carries **65,306
>    prompt characters**, 8× today's capacity. The bound is a property of `buildArgsFor`'s
>    one-positional shape, not of the protocol.
>
> **DECISION: `stageFiles` as a non-frozen port method + a local `fileStagingMode`** — the exact
> DAT-009 shape. The text below is retained as the record of what was believed before it was measured.

### (superseded) The constraint as originally stated

**Every remaining gap is the same problem wearing six hats: there is no channel into the sandbox
except argv.**

Two facts bound the answer, and both were measured:

- **The FROZEN `SandboxProvider` port has no file-staging operation.** The eleven operations are
  create, execute, cancel, kill, destroy, list, inspect, reconcile_cleanup, checkpoint, restore,
  health (`worker-protocol/src/capabilities.ts:125-153`). The port must not grow.
- **`worker-daemon` is dependency-pinned** to `@armyofagents/worker-protocol` + `pino`, enforced by a
  policy guard, so it cannot reach the E2B transport's file primitives directly.

So a file reaches the sandbox by `sh -c` staging through argv, or it does not reach it at all —
unless a frozen contract changes, which is a separate and much larger decision.

★ **And argv is bounded.** The sweep measured that a task whose description exceeds **~7.4 KB** cannot
run distributed at all today, because the prompt is a positional argument. That is both a live defect
and the constraint that decides the channel: whatever carries the MCP config, the instructions bundle
and the prompt must not be argv-shaped.

**Nothing else in this ticket can be written until that channel is decided.** It is the fork the whole
capability half turns on.

---

## 4. The shape, once the channel is decided

Sizes are the sweep's, corrected by a verification pass. They are indicative, not committed.

| Unit | Size | What |
|---|---|---|
| **A — the judge** | **S** | ✅ **DONE 2026-09-02** (§2). `producedArtifacts` promoted to a `capabilityProven` dimension separate from `ok`, pinned fixture, `--require-capability` off by default. **`--model` in the argv was NOT done** and stays open |
| **B — the channel** | **M** (decision) | ✅ **DECIDED 2026-09-03** — `stageFiles` on the NON-FROZEN port + a local `fileStagingMode`, the DAT-009 shape; the frozen vocabulary is untouched. See `qa/2026-09-03-cli-008-unit-b-channel-decision.md`. ✅ **BUILT AND MERGED `393f7a251`** (PR #340) |
| **C — tools** | **L–XL** | A brokered HTTP `aoa` MCP config plus its env vars, and a run-identity credential as a second secret handle, so `mcp__aoa__*` is actually callable |
| **D — context** | **M** | ✅ **DONE 2026-09-03** (§4a). The instructions bundle reaches the sandbox on `--append-system-prompt-file` (claude) / prepended to stdin (codex), and the prompt stops being a positional — it is a staged file the script redirects onto stdin. **Closes E7-F008 and E7-F009.** Targets the **E2B/desktop lane** (E7-F011 leaves the networked lane refusing, not silently context-free) |
| **E — workspace** | **XL** | A repository to work in. `workspaceV1Schema` requires a `manifestArtifactId` that has **zero producers**; `buildWorkspaceManifest` walks a LOCAL filesystem and cannot be pointed at an E2B sandbox |
| **F — the return path** | ~~**XL**~~ ~~**L**~~ **UNSIZED** | ★★★ **NO BUILDABLE PLAN — see [`CLI-008-unit-f-design.md`](./CLI-008-unit-f-design.md), which is TERRAIN + FINDINGS only.** The XL estimate is wrong in a way worth keeping: **three of its four links flip NEITHER counter** (`log` events are not `job_artifacts` rows and not `task_outputs` rows), and the fourth is blocked behind Unit E *and* an in-sandbox manifest capture that does not exist — filed as **E7-F016**. But the **L** that replaced it is **withdrawn**: it was the size of a slice plan whose first step (remove the forgeable `task_outputs` arm, widen the artifact arm off `kind='workspace_patch'`) is **refuted** — the widened arm is satisfied on every run by the run's **own staged input bundle** (design §4.3). Three supply mechanisms have now been refuted (argv shape, argv size, then the predicate). **Blocked on E7-F014** (a non-zero exit throws, the supervisor destroys the sandbox and returns, so every post-execute capture is skipped on every failing run) **and on a supply mechanism that does not exist**. **E7-F015** — the bar is forgeable by one board POST — stands OPEN with no designed fix |

★ **The control-plane half of F is already shipped** — `job_artifacts` carries RLS, grants, a commit
path, an orphan sweeper and DR manifest reconciliation. What is missing is a **producer**. That is
worth knowing before anyone estimates F as greenfield.

★★★ **And the producer is still NOT named.** Three passes tried and were refuted (design §4). What
those passes did establish, and what a fourth should start from: reading a file out of a sandbox is
already solved (`E2bTransport.readFile` is implemented on **both** drivers and exercised live), so the
unsolved half is **writing**; the workload seam is the most heavily pinned surface in the repo and its
census is written down (design §3.2, 16 pins); and **E7-F014 is a prerequisite for every candidate
equally** — the supervisor destroys the sandbox and returns before any post-`execute` step on a failing
run.


---

## 4a. Unit D — what shipped, 2026-09-03

**The one-sentence shape.** `workload.command` becomes `sh`; `args` becomes a FIXED `-c <script>`
plus the adapter's real binary and one or two constant absolute paths; the prompt and the
instructions bundle ride Unit B's staging channel as bytes; the script redirects the prompt onto the
CLI's stdin and points `--append-system-prompt-file` at the staged bundle. For codex — which has no such flag — the bundle
is concatenated ahead of the prompt on stdin **with a blank line between them**, matching the legacy
adapter's own separator; the separator is inserted at the point of USE (`{ cat "$2"; echo; cat "$1"; }`)
rather than baked into the staged bytes, so the same staged object stays byte-identical to the host
file and can also serve claude's flag.

```
sh -c 'for f in "$1" "$2"; do [ -r "$f" ] || { echo "[cli-008] staged input missing: $f" >&2; exit 78; }; done;
       exec "$0" --print - --output-format stream-json --verbose --append-system-prompt-file "$2" < "$1"'
   claude  /home/user/.aoa-run-prompt.md  /home/user/.aoa-run-instructions.md
```

★ **The staged paths are FLAT siblings in `/home/user`, not a `.aoa-run/` subdirectory.** A nested
path rests on `sandbox.files.write` MKDIRing its parent — believed true of the E2B SDK, but the only
test in this repo that writes against a REAL sandbox (`keyed-real-e2b.test.ts`) writes flat paths, and
the no-key lanes use an in-memory map that accepts anything. Staging into a directory that does not
exist fails the attempt closed — the right direction, a bad trade for tidiness. Nest them when Unit E
needs a staged directory and something proves the mkdir.

**Why `sh -c`.** The sandbox's only execution channel is `createSpecFor` → `ExecuteInput{command,
args}`, and the real E2B transport `shellJoin`s the whole argv into one QUOTED command string. That
quoting is what makes argv boundaries survive the collapse — and it is also what makes a bare `<`
in the argv a literal rather than a redirection. So the redirect has to live inside a script a shell
is asked to interpret. `ExecuteInput` still has no stdin field; §1's row 2 is unchanged as a
*protocol* fact, and worked around at the shell.

**Nothing is interpolated into the script.** It is a fixed literal per (adapter, has-bundle) pair;
the binary and the paths are separate argv elements read back as `$0`/`$1`/`$2`. A founder-supplied
`adapterConfig.command` cannot close a quote and append a command — structurally, not by
sanitizing. Four mutants (one per script branch) that interpolate the binary all go red.

**Three things this unit had to get right that are not the headline.**

1. ★★★ **An uncomposed staging port stopped being a silent skip.** Unit B guarded the staging call
   with `if (stageJobInput && stagedFiles?.length)`, so a deployment without the port staged
   nothing — harmless while nothing rode the channel. With the argv now READING those paths, the
   same skip would place a leasable attempt whose sandbox reads a file nobody wrote. It is now
   `legacy("staging_unavailable")`, refused **before the convert**, so nothing is submitted and no
   capacity slot is claimed. Same shape as E7-F010 one layer up: grow one side of a seam, and the
   structures derived from the other side do not follow you.
2. **A configured-but-unreadable instructions bundle keeps the run LEGACY.** `resolveTask
   RunInstructionsBundle` returns three outcomes, not two — "no bundle", "bytes", "could not read
   it" — because folding the third into the first runs a canary agent without its identity,
   producing plausible work and a clean terminal, which is the one failure nothing downstream can
   detect. This deliberately diverges from the legacy codex adapter, which warns and continues.
3. **The in-sandbox guard.** The staged-input pointer is `critical: false` (Unit B's decision,
   unchanged), so a worker that does not understand the namespace stages nothing. The script
   therefore checks each path is readable and exits **78** (`EX_CONFIG`) with a message on stderr —
   an attributable cause instead of a bare `sh` redirection error, or, for codex's `cat |` shape,
   an apparently-successful context-free run.

**What Unit D deliberately does NOT do.**

- **It stages the bundle's ENTRY FILE only.** `--append-system-prompt-file` takes one file and the
  legacy adapter passes one path, so this is byte-parity with legacy. The bundle's siblings
  (`HEARTBEAT.md`, `SOUL.md`, `TOOLS.md`) are not staged, and the legacy path directive — "resolve
  relative references from `<host dir>`" — is deliberately NOT emitted, because that directory does
  not exist in the sandbox. A relative reference inside the entry file is therefore unresolvable
  there. That needs `--add-dir` and a directory-staging shape: **Unit E**. It is a sub-case of
  E7-F003 row 1, not a new finding.
- **It does not add `--model`.** Still open from Unit A's row.
- **It does not touch `capabilityProven`.** No output capture, so the counts are still structurally
  zero. A green E7-1 after this proves a richer MECHANISM, not capability.

**Lane.** The **E2B/desktop** lane. On the networked/container lane
`ProviderWireDriver.fileStagingMode` is `"none"` and `stageFiles` throws
`UnsupportedProviderOperation`, which the supervisor turns into a FAILED attempt (E7-F011). That is
a refusal rather than a context-free success — the right direction — but it is a refusal, and Unit D
does not fix it. It is also unreachable today: the shipped image's `CMD` enters the local daemon
bin, and `checkWorkersEnterTheDaemonBin` rejects an override.

---

## 5. Acceptance

A distributed coding run that the verifier **can distinguish** from a context-free one: the agent had
tools, had its identity and company context, had a repository, and something it produced reached AoA
— each asserted by a clause, not printed as an observation. **That is the TICKET's acceptance, and it
is not met.** Per-unit criteria below; §5 was a stub for this ticket until Unit D, and writing D's
own was part of D.

### 5a. Unit D's acceptance — met

1. The workload emits **no argv element carrying task content**. The prompt is a staged file.
   *Met, and measured:* the realistic workload's submission payload fell from **790 to 295 bytes**;
   prompts at the old 8,192-char cliff +1, at 8×, and at 100× all build.
2. Every **absolute path the argv names is a path the same build stages**, and the converse. *Met,
   asserted structurally (derived from the emitted argv, not from a fixture) across all four
   (adapter × has-bundle) shapes.*
3. The **instructions bundle entry file reaches the sandbox** by the flag the legacy adapter uses —
   `--append-system-prompt-file` for claude, a stdin prepend for codex — pointed at the STAGED path,
   never a host path. *Met.*
4. A run that **needs staged files and cannot get them never becomes leasable**: no staging port →
   `legacy("staging_unavailable")` before the convert; an unreadable configured bundle →
   `legacy("workload_unavailable")` with an `instructions_*` detail; a staging refusal →
   `legacy("transfer_error")` before placement (Unit B's property, still held). *Met.*
5. A worker that **ignores the pointer** (it is `critical: false`) produces an **attributable
   failure**, not a context-free success: exit 78 with a named cause on stderr. *Met at the script
   level; the end-to-end exercise of that path needs a real sandbox and is NOT met in CI.*
   ★ **NOT MET end to end — corrected 2026-09-03 by the live lane.** The script's half holds in a
   real sandbox (the guard fires, exit 78, the cause on stderr). The ATTRIBUTION does not survive
   the trip out: a non-zero exit is THROWN by the e2b SDK rather than returned, and the attempt
   terminalizes `failed / exitCode: null / execute_failed / errorMessage: null` — a context-free
   failure, which is the thing this criterion was written to prevent. **E7-F014**, owned by Unit F.
   ★★ **HALF MET — updated 2026-09-04, E7-F014 RESOLVED** (PR #351, live runs `33832930572` green /
   mutant `33832956461` red). The transport now narrows on the SDK's `CommandExitError` and returns
   the exit code, so the attempt terminalizes `failed / exitCode: 78` and the **78 is recorded**. The
   **named cause is still not** — `ExecuteResult` carries only opaque `stderrRef`s under E5's
   no-customer-bytes rule, so carrying the cause text remains **Unit F**'s (output capture).
6. **Nothing about `capabilityProven` changes.** *Met — and stated as a criterion so a green E7-1
   after this unit cannot be read as capability.*

## 5b. ★ What WAS established, 2026-09-03 — the shape has now run in a real E2B sandbox

> This section replaces the "What is NOT established" paragraph that shipped with Unit D. That
> paragraph is reproduced below because it named the gap correctly and the record should show it.
>
> > ★ **What is NOT established.** No run of this shape has executed in a real E2B sandbox. The
> > staging channel end to end, the `sh -c` collapse through `shellJoin`, the redirect, and the
> > CLI's acceptance of `--print -` with a redirected stdin are all argued from the legacy adapters'
> > behaviour and from transport code — not observed. That is the same gap CLI-008 Unit B shipped
> > with, and it closes on the staging fleet, not in this unit.

It did not need the staging fleet. `packages/sandbox-e2b-provider/src/__tests__/keyed-cli-008-unit-d-invocation.test.ts`
runs the shape against REAL E2B from a GitHub runner using the `E2B_API_KEY` repo secret that has
existed since 2026-08-17 (lane `keyed-e2b-unit-d.yml`; first green run `33789547290`, 3/3).

**OBSERVED in a real E2B sandbox** — the production builder's exact `command` + `args`, through the
real transport, with a staged shell probe as `$0`:

- **The `shellJoin` collapse survives.** `sh -c '<script>' '<binary>' '<prompt path>' '<bundle path>'`
  round-trips through e2b's single command-STRING API with its positional parameters intact.
- **The prompt arrives on stdin byte for byte**, including `$HOME`, backticks, quotes, `|`, `&`, `>`
  and `<` — all literal, none expanded by the sandbox's shell.
- **`--append-system-prompt-file` receives the staged bundle path as its own argv element**, and the
  bundle is readable at that path with the exact staged bytes. The FLAT `/home/user/...` staging
  paths write successfully.
- **The exit-78 guard fires** when the unit's files are deliberately not staged.

**OBSERVED locally with the real `claude` CLI (2.1.126)** — the bare `base` template has no `claude`
binary, so this half was measured separately and is NOT an E2B result:

- **`claude --print -` reads a redirected stdin and does not wait on a TTY.** Decisive: with
  `--input-format stream-json` and a malformed line redirected in, the CLI echoed **the exact bytes
  from the file** back (`Error parsing streaming input line: THIS_IS_NOT_JSON_AT_ALL`).
- **`--append-system-prompt-file` is real and validated**, not silently ignored: a nonexistent path
  gives `Error: Append system prompt file not found: …`, against a control proving the CLI does
  reject unknown flags.

**STILL NOT ESTABLISHED**, stated as plainly as the paragraph it replaces:

- The real `claude`/`codex` **binaries have not run inside E2B**. Everything between
  `buildSandboxInvocation` and the binary's own `main` is proven; nothing beyond it is claimed.
- That the prompt's **content reaches the model** — the local probe fails auth first, and an
  empty-stdin control produced byte-identical output, so auth masks it.
- **Unit B's staging channel end to end** (control plane → object storage → download grant →
  `transport.writeFiles`). The lane calls `writeFiles` directly, proving the sandbox-side half —
  the paths, the bytes, the argv — not the pointer's journey. That still needs the fleet.

**★★ The lane was made to FAIL, on purpose, before it was trusted.** A green live lane that cannot
go red proves nothing. `shellJoin` was mutated to the naive `[command, ...args].join(" ")` on a
throwaway branch and the lane was dispatched against it (`33790235730`): **3/3 red**, with
`CommandExitError: exit status 2` — `sh`'s own usage error, because `sh -c` received only the first
word of the script. That is exactly the historical bug `real-transport-helpers.ts` was written to fix
(*"`sh -c` received only `printf` and the rest became `$0`/redirections"*), so the lane reds on the
real defect in the mechanism it claims to prove, not on an incidental. The branch was deleted.

**Two findings came out of running it:** **E7-F013** (LOW — the codex separator is one newline or two
depending on the staged bundle's trailing newline, so the legacy-parity claim holds conditionally)
and **E7-F014** (MEDIUM — a non-zero exit is thrown rather than returned, so every failing
distributed run terminalizes with `exitCode: null`; it defeats criterion 5 above).
**E7-F014 is RESOLVED** as of 2026-09-04 (PR #351): the transport narrows on `CommandExitError`, a
fault keeps throwing, and the same lane now pins the carrier. **E7-F013 remains open** (unowned).

★ **No green E7-1 should be read as evidence of capability.** Since Unit A that is computed rather
than asserted: the verifier prints `CAPABILITY: NOT PROVEN` beside every PASS, and
`--require-capability` is the flag that enforces it once Unit F gives it something to find.

## 6. Depends on

`CLI-006` (the canary seam), `CLI-007` (the credential path), and the frozen contracts in
`packages/worker-protocol` — which Unit B must work **within**, not around.
