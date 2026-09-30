# DEP-010 — result: the provider seam, wired and provably inert

**Epic:** E6 · **Sprint:** 2 (go-book) · **Branch:** `docs/replatform-program` · **Worktree:** `C:\e3`
**Design:** [`DEP-010-design.md`](./DEP-010-design.md) · **Status:** SHIPPED
**Start SHA:** `a5146dc57` (the design was already committed at tip) · **Landed:** Steps 1–11, commits `176eb5f8e … 43df22e92`

---

## What shipped

A production process can now construct a real sandbox provider and inject it into the worker daemon
— on the **desktop/self-hosted lane only** — while the shipped default stays **provably inert**. The
seam is one authoritative port (worker-daemon's per-op `SandboxProvider`), one confined construction
file, and a composition root that resolves-or-refuses.

| Step | Commit | What landed |
|---|---|---|
| 1 | `176eb5f8e` | Findings register: E6-F008 + E6-F004 → `resolved` (keys deleted); E6-F003 stays open, narrowed |
| 2 | `0776d0a2f` | `decideDispatchComposition` + `DISPATCH_REFUSAL_MESSAGES` on the worker-daemon barrel; pin 131→132 |
| 3 | `7fd65d715` | `desktop-host.ts` `provider?` pass-through; pin 18→19 |
| 4 | `6a2225c65` | Shipped-default lock (no provider forwarded; real boot reports `no_provider`) |
| 5 | `9e96ec0e9` | Keystore boundary widened by one dep, confined to one path, credential banned; lockfile + pr.yml |
| 6 | `c73e996ce` | `sandbox-provider.ts` — the one file that may construct a provider; E7-1 re-declared; pin 19→20 |
| 7 | `59e998ce0` | `desktop-host.ts` resolves + injects a provider, after control/reset |
| 8 | `f2f36b142` | The §4.1 structural-lock proof (provider arrives; nothing composes a loop) |
| 9 | (no commit) | Positive controls — the daemon still cannot import a provider (evidence only) |
| 10 | `0e9b42430` | Static staging invariant: dispatch stays off — no worker carries the switches |
| 11 | `43df22e92` | Headers de-contradicted; docs; E4-F011 closed; E6-F003 repointed to DEP-011 |

## The go-book §8 D-3 conditions — all three verified in what shipped

The keystore dependency-boundary widening was already approved on three named conditions
(`GO-BOOK.md` §8, D-3). I did not re-ask; I verified each holds:

- **(a) `PROVIDER_HOST_PATH` confinement — exactly one file may name the provider.** Landed in
  `scripts/lib/worker-keystore-boundary.mjs` (`PROVIDER_HOST_PATH = "src/bin/sandbox-provider.ts"`),
  keyed on the FULL package-relative path (a `bin/nested/sandbox-provider.ts` copy is rejected — the
  basename hole `SUBPROCESS_HOST_PATH` history taught). Proven by Step 5 mutation (a) + a self-test case.
- **(b) the checker is TIGHTENED, not merely widened, and its own test proves a second naming file
  fails.** Two NEW rules (path + a zero-file credential ban), six self-test cases, five keystore
  mutations. The credential ban has NO host-file exception (unlike the e2b leaf's one-file rule): the
  credential's name may appear in ZERO worker-keystore runtime files, scanned over raw source.
- **(c) the shipped desktop default stays provider-less AND a guard asserts it.** Step 4 lock, Step 6
  loader-never-called, Step 8 structural lock, Step 10 static deployment invariant. The default
  resolver returns `{kind:"none"}` **before** calling the loader, so the `e2b` SDK never enters the
  default boot's process image — "no provider at all", not merely "flag off".

## What this ticket did NOT do

It does **not** turn dispatch on. `AOA_WORKER_SANDBOX_PROVIDER` and `AOA_WORKER_DISPATCH_ENABLED`
both default off, the shipped default constructs no provider, and even a provider-bearing daemon
composes no supervisor and no poll loop — `bin/worker-daemon.ts` has no `else` on `dispatch.compose`
(the §4.1 structural lock). **This primary proof EXPIRES at Sprint 3** when WRK-008 slice 2b writes
that `else` (design §4.2); after that the desktop's inertness rests on the remaining gates (unset env
switches + runtime conditions), and the desktop lane has no deployment-surface guard for those
switches (§4.2 item 2) — handed forward, not this ticket's to fix.

## Mutation ledger — every guard deleted, run, reverted

| Guard / lock | Mutation | Result |
|---|---|---|
| finding-ownership | re-add E6-F008 key (resolved) | `stale_declaration` ✓ |
| " | flip E6-F004 back to `open` (key deleted) | `undeclared_finding` ✓ |
| " | resolve E4-F011 while its key survives | `stale_declaration` ✓ (atomic pair) |
| gate-clause-wiring | land `sandbox-provider.ts` without re-declaring E7-1 | `unwired_but_now_has_caller` ✓ |
| " | lower `expectedReferences` 2→1 | `unwired_but_now_has_caller` ✓ (number load-bearing) |
| check-test-inventory | omit a pin bump | `pinned_mismatch — bump the pin` ✓ (all three) |
| worker-keystore-boundary | drop `PROVIDER_HOST_PATH` check | rejected-path cases fail ✓ |
| " | drop the specifier from `ALLOWED_BARE` | allow-at-path case fails ✓ |
| " | tokenize the credential scan (drop raw-source) | ONLY the comment case fails ✓ (raw-source load-bearing) |
| " | delete the whole credential block | BOTH credential cases fail ✓ (positive control) |
| " | revert ONLY the `manifest()` fixture bump | 14 synthetic fail; REAL package passes ✓ (asymmetry) |
| desktop-host resolve position | move resolve ABOVE the control branch | both "must NOT construct" cases fail ✓ |
| " | neutralise the resolve block | resolves/refuses cases fail ✓ (positive control) |
| desktop-host provider forward | `deps.provider ?? ({} as SandboxProvider)` | shipped-default lock fails ✓ |
| `compose-dispatch.ts` `if(!input.provider)` | → `if(false)` (rebuilt dist) | `no_provider` case fails (becomes `dispatch_disabled`) ✓ |
| sandbox-provider resolver | unrecognised → `{kind:"none"}` | refused case fails ✓ |
| " | missing template → `?? "base"` | no-template case fails ✓ |
| " | `catch` → `{kind:"none"}` | transport-throws case fails ✓ |
| " | default loader → a local stub | non-vacuity case fails ✓ |
| `bin/worker-daemon.ts:344` | `hasSelfModelReader false→true` (rebuilt dist) | supporting `no_self_model_reader` case fails ✓ |
| `bin/worker-daemon.ts:344+345` | +valid `selfModel`, NO else (rebuilt dist) | compose:true REACHED, structural lock still HOLDS ✓ (non-vacuity) |
| `bin/worker-daemon.ts:349` | add `else` assigning `deps.leasing`, with 344+345 (rebuilt dist) | structural lock fails — shutdown steps move off `["health-server"]` ✓ (the load-bearing mutation) |
| staging-manifest `checkDispatchDefaultOff` | `WORKER_SERVICES → []` | all 4 new cases fail ✓ (anti-vacuity) |
| " | drop the command/entrypoint arm | ONLY the 2 inline cases fail ✓ |
| " | (control) pre-existing `E2B_API_KEY`-on-a-worker | still fires ✓ (DEP-006 unweakened) |

## Step 9 positive controls — the daemon still cannot import a provider (evidence only, byte-unchanged guards)

`git diff a5146dc57 -- scripts/lib/worker-daemon-boundary.mjs scripts/lib/sandbox-fake-provider-boundary.mjs`
is **empty** (byte-unchanged). Each control was applied, run, reverted:

| # | Mutation | Guard fired |
|---|---|---|
| 1 | provider import in `supervisor/provider.ts` | `forbidden runtime import "@armyofagents/sandbox-e2b-provider"` (proves the checker walks `supervisor/`) |
| 2 | provider dep in `worker-daemon/package.json` | `runtime dependencies must equal ["@armyofagents/worker-protocol","pino"], got [...]` |
| 3 | non-literal dynamic import in a daemon file | `non-literal dynamic import is forbidden in runtime source` |
| 4a | worker-daemon dep in the FAKE's `package.json` | `runtime dependencies must equal ["@armyofagents/worker-protocol","zod"], got [...]` |
| 4b | `import type` from worker-daemon in `fake-driver.ts` | `forbidden runtime import "@armyofagents/worker-daemon"` (lexical catch) |
| 5 | `E2B_API_KEY` in `per-op-adapter.ts` | `the provider-control credential "E2B_API_KEY" may appear ONLY in real-transport.ts` |
| 6 | `E2B_API_KEY` in `worker-keystore/src/bin/sandbox-provider.ts` | `... must not appear in ANY worker-keystore runtime source (ZERO files, not one) ...` |

## E4-F011 closed; E6-F003 repointed to DEP-011

- **E4-F011 (HIGH)** → `resolved` in `epics/E4-worker-daemon/findings.md` (its manifest key deleted in
  the SAME commit — the atomic pair). The resolution records §4.3 (which root gets a provider, what the
  flag defaults to) and §4.2's expiry, and states the INVARIANT — deliberately NO bare gate count
  (E4-F015's rule).
- **E6-F003 (HIGH, still open)** — DEP-010 DEFERS it, so its manifest `ticket` was REPOINTED from
  DEP-010 to **DEP-011** (a filed scoping stub: ticket file + `#### DEP-011` program node, no result
  doc). Leaving it owned by shipped DEP-010 would read as owned by nobody and fail nothing (E4-F013).

## The measured cost of the widening (DSK-003 handoff)

The provider dep pulls `e2b@2.30.5` into the key-holding process. The plan measured the closure at
**36 packages, ~1,752 files, ~15.2 MiB unpruned** (`pnpm why e2b` + lockfile closure). I confirmed the
direct dep is `e2b@2.30.5`; the *shipped, pruned* figure is uncomputable today because
`scripts/build-desktop-staging.mjs` refuses to run (its input is an unsolved packaging step). **The
handoff to DSK-003 is the embedded-secret SCAN, not the size**: 36 new packages of unscanned
third-party bytes enter a scan that has already been widened once (pino's README, `@pinojs/redact`'s
benchmarks). The correct response to a hit is another prune rule, never a weaker scan.

## What I got wrong / could not prove / chose deliberately

- **§2.2b branch:** I took "supersede in writing" (not "earn it"/the totality test), because a
  `for (const op of PROVIDER_OPERATIONS)` loop over the `perOpToInvokeDriver` dispatch risks a vacuous
  or wrong-failure test (two nested switches + an advertisement gate + resourceId-dependent args), and
  D1/D2 make the supersession honest: the driver port is demoted to a harness surface already covered
  case-by-case. Both branches are plan-admissible; the resolution paragraph states which was taken.
- **D12 explicit-env:** I passed MINIMAL explicit envs to `resolveSandboxProvider` in the resolver
  tests rather than the plan's `{...process.env}`-minus-credential spread. The resolver reads only the
  PASSED env, so the spread bought nothing and the credential path is the sixth case (a throwing
  transport). This satisfies D12's deeper intent (no misleading filter) with less coupling.
- **Step 5 mutation (d) count:** the plan predicted "14 synthetic fail"; I measured **17** — because
  Step 5 ADDS 3 more fixture-dependent cases. The load-bearing property (REAL package passes while
  synthetic fail) holds exactly; only the count differs, and it is explained.
- **Cross-package mutations** (compose-dispatch.ts:62, bin/worker-daemon.ts:344/345/349) required a
  worker-daemon **dist rebuild** to be observed in the worker-keystore tests, because worker-keystore
  resolves worker-daemon via `./dist`. Each was rebuilt, observed, reverted, and rebuilt back.
- **CI `verify` is RED for reasons that predate this sprint** (`GO-BOOK.md` §2.0 — five 60-minute
  cap-outs on SHAs before any Sprint-0 commit). DEP-010 does not touch it and does not raise its
  timeout. Sprint 2 lands with the required check inheriting that red, exactly as Sprint 1 did.

## What Sprint 3 (WRK-008 slice 2b) inherits — see design §10

- The four §10.1 assertions DEP-010 invalidates (Step 8b's `"provider" in call`, Step 9b's guard
  property, §2's desktop gate-1 cell, Step 9a's env-var name) — reformulate before Sprint 3, per §10.1.
- `AOA_WORKER_SANDBOX_PROVIDER` is the authoritative provider switch; `AOA_WORKER_PROVIDER_URL` is dead
  env (the resolver adds no reader) — §10.2.
- `public-surface-dispatch.test.ts` and Step 8's supporting `no_self_model_reader` case are the two
  artifacts Sprint 3 must edit when it narrows the public surface — §10.3.
- The structural-lock proof expires when 2b writes the `else` (§4.2); Sprint 3 must REPLACE it, not
  inherit it.

## Verification

All 12 register/policy/boundary guards GREEN. Affected packages build + typecheck + test green:
worker-daemon 713, worker-keystore 256, sandbox-e2b-provider 39 (+18 keyed-lane skips),
sandbox-provider-contract 22, sandbox-fake-provider 15. Adversarial review: see below.

## Adversarial review

Five INDEPENDENT reviewers, one per changed dimension, each verifying claims by opening source.
**Zero HIGH/BLOCKING findings across all five** — so no skeptic/refute pass was required (the refute
step applies only to HIGH/BLOCKING). What surfaced was two LOW comment gaps and one stale citation,
all fixed; the rest are documented pre-existing residuals.

| Reviewer | Dimension | Result |
|---|---|---|
| R1 | boundary + staging guards | no HIGH/MED; 1 LOW (below), fixed=N/A |
| R2 | resolver + root wiring | ZERO findings (all six safety claims traced to source) |
| R3 | inertness / structural lock | no HIGH/MED; 2 LOW, both FIXED |
| R4 | registers + ownership | no blocking; 3 INFO (below) |
| R5 | CI-green + commit hygiene | ZERO findings (verified per-commit across all 11 commits) |

**Fixed (both LOW, comment/doc only — no logic change, mutation proofs unaffected):**
- **R3 LOW-1+LOW-2** — the structural-lock test comment said "composes nothing" and omitted the §4.2
  expiry. The two observables (zero `startup:` lines, shutdown steps `["health-server"]`) prove *no
  lifecycle-**registered** loop* — a fire-and-forget local composition would evade them (a case §4.1
  explicitly names; slice 2b's real change registers steps and IS caught). Comment now states this
  precisely AND records the expiry inline so a Sprint-3 operator sees "rewrite this test when you add
  the `else`" (`desktop-host-provider.test.ts`).
- **R4 INFO-2** — design §10.1 row 1 cited `desktop-host.ts:254-260` and `provider: deps.provider`;
  Step 7 moved the bootstrap call (resolve-then-inject) so both were stale. §10.1 now describes the
  shipped resolve-then-pass form structurally, keeping §10 accurate for Sprint 3.

**Documented residuals (pre-existing or acknowledged; no action):**
- **R1 LOW** — the `E2B_API_KEY` ban is a raw-substring scan, so a deliberately string-split token
  (`"E2B_" + "API_KEY"`) evades it. This is IDENTICAL in the sibling `sandbox-e2b-provider-boundary.mjs`
  (the pattern DEP-010 was told to mirror), pre-existing, and out of the guard's threat model (it
  catches accidental naming, not obfuscation). Hardening it would diverge from the mirrored e2b
  pattern; out of DEP-010's scope.
- **R4 INFO-3** — E6-F008's "supersede in writing" skips a `PROVIDER_OPERATIONS` totality loop, so a
  future-added provider op is not auto-forced into adapter coverage. The E6-F008 resolution already
  acknowledges this; the real provider runs green through the adapter + both conformance suites.
- **R5 observation** — `packages/worker-daemon/src/supervisor/provider.ts` is tracked by git as a
  binary file (it was before DEP-010 too — not introduced here). No CI consequence: the header edit
  landed (verified), the build/typecheck pass, and the gate-clause checker reads it via
  `readFileSync(utf8)` and counts correctly. Out of scope; noted for a future glance.

R4 INFO-1 ("no result doc at the reviewed tip") is resolved by this document existing.
