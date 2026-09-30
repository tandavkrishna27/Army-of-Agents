# BRW-002 — Sandbox-local Playwright runtime — RESULT

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Status:** **COMPLETE — CI GREEN** at `e974364d2`
(all 13 jobs, run conclusion `success`), with declared deferrals (§6)
**Start SHA:** `d4a2c33f4` (design v2). Design v1 `3f96ffcb3` failed plan review and was
rewritten — see §5.
**Terrain:** [`BRW-002-terrain.md`](./BRW-002-terrain.md) · **Design:** [`BRW-002-design.md`](./BRW-002-design.md)

**Acceptance.** (a) browser process shares only the job sandbox; (b) downloads stay job
scoped; (c) browser and child processes die on cancellation.
**Test.** Deterministic local site navigation, download, popup, and kill.

---

## 1. What shipped

`packages/browser-runtime` — a new leaf package, registered in the root vitest project list
(an unregistered package is a suite that never runs).

| File | Role |
|---|---|
| `launch-guard.ts` | The `public_cdp_endpoint` enforcer. Normalises switches the way Chromium parses them, then applies an **allow-list**. |
| `listening-ports.ts` | Containment **measurement**: parses `/proc/net/tcp` **and** `tcp6`, compares a delta across the launch. |
| `path-adapter.ts` | Confines a download to the per-job root by asking the **filesystem** (`realpath`), not by string logic. |
| `run-session.ts` | Orchestration, with the persist-before-close ordering as a testable invariant. |
| `playwright-driver.ts` | Real Playwright behind the injected seam; `launchPersistentContext`, graceful-signal teardown. |
| `fixture-site.ts` | The deterministic local site (navigation, download, hostile filenames, popup, slow page). |
| `runner.ts` | **The boot root** — the in-guest entrypoint the sandbox executes. |
| `.github/workflows/pr.yml` → `browser` job | The Linux lane that makes the clauses falsifiable, wired into `ci-required`. |

## 2. Acceptance clause → named executable artifact

| # | Clause | Artifact | State |
|---|---|---|---|
| a | no remote-control surface requested | `launch-guard.test.ts` — 27 tests: `cdpPort` (incl. `0`), every debugging-switch spelling asserted **by reason**, reroute env vars, allow-list | ✅ |
| a | Chromium's OS sandbox ON | `launch-guard.test.ts` + `browser-containment.browser.test.ts` "launches with Chromium's OS sandbox ENABLED" — against a real browser | ✅ |
| a | **measured**: the browser adds no listening socket | `browser-containment.browser.test.ts` "opens no TCP port that was not already there" **+ a negative control** proving the measurement can fail | ✅ Linux lane |
| a | `/proc` parsing correctness | `listening-ports.test.ts` — 16 tests: IPv4+IPv6 fixtures, hex ports, LISTEN-only, malformed rows, both-tables merge, **throws when neither table is readable** | ✅ |
| a | real-provider evidence that a bound port WOULD be public | `packages/sandbox-e2b-provider/scripts/probe-e2b-port-exposure.mjs` + `keyed-e2b-cdp-probe.yml`, run `32630219279`: port 9222 served our marker to an unauthenticated GitHub runner | ✅ measured |
| b | download lands under the per-job root and **survives context close** | `browser-containment.browser.test.ts` "persists a download under the root and it SURVIVES context close" | ✅ |
| b | the staging area really is destroyed on close | same file, "leaves nothing behind in the staging directory after close" — documents why `saveAs` is mandatory | ✅ |
| b | traversal cannot escape | same file, "a traversal filename cannot escape the root" | ✅ |
| b | path confinement incl. symlink escape | `path-adapter.test.ts` — 20 tests: `..`, absolute reassignment, NUL, sibling-prefix confusion, **symlink escape on a real filesystem** | ✅ (symlink cases Linux) |
| c | graceful cancellation reaps the browser | `browser-teardown.browser.test.ts` "closes the browser when the runner receives SIGTERM" | ✅ Linux lane |
| c | **on LINUX (the target), SIGKILL REAPS the browser** | `browser-teardown.browser.test.ts` "leaves no Chromium alive after an uncatchable kill" | ✅ Linux lane — see §4 |
| c | on Windows (dev only) it ORPHANS — pinned so the platform difference is tested, not folklore | same file, "MEASURES that Chromium outlives the runner" | ✅ |
| c | the runner reports failure rather than exiting silently | same file, two tests: typed event **and** non-zero exit | ✅ |
| c | the guard fires through the REAL entrypoint | same file, "refuses an unsafe launch through the REAL entrypoint, not just the library" | ✅ boot-root proof |
| Test | navigation / download / popup | `browser-containment.browser.test.ts` "navigates, downloads, and handles a popup" | ✅ |
| Test | kill | `browser-teardown.browser.test.ts` (both halves) | ✅ |
| Test | the fixture itself serves what the cases need | `fixture-site.test.ts` — 8 tests | ✅ |

**Commands.** `pnpm --filter @armyofagents/browser-runtime exec vitest run` → **77 passed**
(browser suites skip without a browser). With `AOA_RUN_BROWSER_TESTS=1` → **88 passed, 6
skipped** (the skips are Linux-only `/proc` and symlink cases, which run in the lane).

## 3. Mutation testing — 40 mutants, 39 killed, 0 suspect

Every guard mutated: both `cdpPort` forms, the `chromiumSandbox` predicate, **five separate
normaliser defects**, all three decision sets, the env check, the `/proc` state/hex/radix
parsing, both delta directions, the tcp6 read, the absent-measurement throw, every
path-adapter branch, the orchestrator's ordering and refusal handling, and both runner exit
codes.

**The one survivor is A04** (dropping `realpath` on the ancestor). It survives **on Windows
only**, because its killing test is the symlink case and symlink creation is EPERM there —
exactly the false-survivor trap the lane brief warns about. Rather than argue it, I ran the
compiled module in a Linux container: unmutated the symlink escape is refused, mutated it is
**accepted with a path that looks inside the root**. The line is load-bearing and the kill is
verified.

**Two harness defects found and fixed, both of which had manufactured false survivors:**
CRLF line endings made five multi-line anchors silently fail to match (reported as
ANCHOR NOT FOUND — mutants that never ran), and the runner mutants edited `src/` while the
tests spawn `dist/runner.js`, so they never reached the code under test. With a rebuild, both
runner mutants die.

**What mutation caught in the tests themselves** — the recurring lesson, twice more:
- Five normaliser mutants survived because the tests asserted only `ok === false`, never
  *why*. The allow-list backstop refuses everything the normaliser fails to recognise, so the
  normaliser could have been **entirely broken** and the suite would have stayed green. The
  debugging-switch and sandbox-defeat tests now assert the **reason**.
- The first-vs-last `=` split was unobservable until a case whose *value* contains `=`.

## 4. Adversarial review — two BLOCKERs, both reproduced, both mine

### A one-character bypass opened a live DevTools endpoint

`-remote-debugging-port=9333` — **single dash** — was ACCEPTED. Chromium's `base::CommandLine`
honours `-flag`, `--flag` and `/flag`; Playwright rejects only args not starting with `-`
(`chromium.js:283`). Reproduced end to end: guard returns ok, Playwright launches, and
`GET http://127.0.0.1:9333/json/version` returns **HTTP 200 with a live target list**, while
Playwright keeps driving over its pipe so the session looks healthy. On E2B that port is
publicly reachable (§2, measured). That is `public_cdp_endpoint` — the exact forbidden effect
this module exists to prevent — produced by one character. `-no-sandbox` used the same hole.

**Fixed by inverting the model.** A deny-list cannot be repaired here: Chromium takes ~1500
switches and gains more each release. Arguments are now normalised to the switch *name* and
checked against an allow-list, so the worst case is refusing something benign — a loud typed
refusal — instead of silently publishing a control endpoint. Verified closed against all
eight bypass spellings.

### Nothing called any of it

`index.ts` exported only the three pure guards, so `runBrowserSession` and
`createPlaywrightDriver` were unreachable, and **no package imported `browser-runtime` at
all**. The design claimed "BRW-002 builds an enforcer"; it had built a function. That is this
programme's signature defect reproduced inside the module written to prevent it. Fixed by
adding `runner.ts` (a real boot root), exporting the full surface, and adding a test that
drives the guard **through the entrypoint** rather than the library.

### Clause (c) had no test, and the truth was the opposite of what I expected

The clause was untested while the browser file's header **claimed to cover it** — a false
claim, now removed. I then wrote "killing the runner reaps the browser" on the strength of a
review note asserting Chromium died in 0.1–0.2 s via pipe EOF. **The test failed.** Measured
directly: runner confirmed dead, Chromium still alive 15 seconds later.

So I rewrote the clause as a universal limitation: an uncatchable kill orphans the browser.

**Then the Linux lane refuted THAT on its first green run** — *"Chromium was reaped by
SIGKILL"*. I had measured one platform and generalised from it. The original review note was
right, for Linux.

**Platform is the variable, and the target platform is the favourable one:**
- **Linux** — what an E2B sandbox actually is — reaps Chromium and its children even on an
  uncatchable kill, through the CDP pipe on fds 3/4 reaching EOF. **Clause (c) IS satisfied at
  the runtime layer**, with sandbox `destroy` as the outer backstop rather than the only
  mechanism.
- **Windows** — developer machines only — orphans it, because Node maps every `child.kill()`
  to `TerminateProcess` and the grandchild survives.

Both are now asserted per platform. A test that asserts the wrong platform's behaviour is
worse than no test: it teaches a false invariant. And the failure message I wrote for the
orphan assertion — *"the ground moved, revisit clause (c)"* — is precisely what fired, in the
useful direction.

## 5. What design v1 got wrong (superseded at `d4a2c33f4`)

v1 failed plan review with **10 BLOCKERs and 22 HIGHs**. Its thesis — CDP over a pipe —
survived and is verified three ways. Everything built on top of it was asserted rather than
checked: `downloadsPath` on the context (launch-only, silently discarded), `--user-data-dir`
in args (throws), a profile preference as a third layer (overridden by CDP at every context
init), a socket set that is false at t=0 (envd holds 49983), `/proc/net/tcp` singular (blind
to `::`), `ss` (absent from the base image), an args-only debug guard (`cdpPort` never appears
in args), `assertUnderRoot` as string logic (cannot see symlinks), hostile filenames as proof
of confinement (Chromium pre-sanitises; `saveAs` is the escapable surface), "stream everything
during the run" (video requires `close()`), and `--disable-dev-shm-usage` (already a Playwright
default). And the deepest: v1 had the host driving Playwright over injected primitives, which
the pipe transport makes impossible — CDP rides fds 3/4 of the spawned child.

## 6. Deferrals — stated honestly, including what is built but not wired

- **The runtime has a boot root but no PRODUCTION caller.** `runner.ts` is the process a
  sandbox would execute, and it is exercised by real spawned-process tests — but nothing in
  the control plane stages or starts it yet. Staging the bundle into a sandbox is the
  BRW-003+ integration; **clause (a) is not enforced on a production browser job today**,
  because no production browser job exists.
- **Per-workload template selection is untouched** (terrain §4.2 — "the actual first
  problem"). `job-placement.ts` maps `browser.chromium` to a capability, never to a template
  or image, so even a browser-capable template would not cause a `browser_session` job to land
  on it. Real-provider placement, BRW-005/D3.
- **No worker advertises browser capacity** — `desktop-hello.ts` sets `browserSessionSlots: 0`.
  Same owner.
- **The browser Dockerfile is NOT authored.** Design §8 listed it in scope; it is not in this
  ticket. Building and registering an `aoa-browser` template remains an operator action, and
  headless uses `chromium-headless-shell`, a different binary from `chromium`.
- **The seven frozen browser config fields still never reach the sandbox** —
  `createSpecFor` degrades a browser workload to `args: []` (terrain §4.4). The runner reads
  its config from a staged file instead, which is why this does not block the runtime, but the
  envelope→sandbox mapping is unfixed.
- **Egress policy is BRW-004's**, and terrain §6 records a design-blocking model mismatch
  there (the DAT-005 proxy is per-request and handle-bound; a browser emits raw DNS/TCP to
  runtime-discovered hosts). BRW-002 makes no egress claim.
- **Evidence streaming is BRW-003's.** BRW-002 proves a browser runs and is contained; it does
  not stream observations, and the frozen `deadlineMs: 20000` is honoured by nothing here.
- **`/dev/shm` sizing** needed no action — `--disable-dev-shm-usage` is already a Playwright
  default (`chromiumSwitches.js:68`), contrary to design v1.
- **TOCTOU on the socket delta.** The measurement is taken once before and once after launch.
  A port opened *later* — by a page, a worker, or a Chromium subprocess — is not caught.
  Continuous monitoring belongs with BRW-003's observation stream.

## 7. Cross-cutting findings raised outside this ticket

- **E2B serves arbitrary in-sandbox ports to the public internet, unauthenticated** (measured,
  run `32630219279`). Reported to the programme owner. Consequences beyond E8:
  `heartbeat.ts:5397-5412` scrapes ports from agent stdout and publishes them as `preview_url`
  with no debug-port filter, and `preview-proxy.ts` authorises its own path while the
  underlying `*.e2b.app` URL bypasses it.
- **A raw NUL byte in `packages/worker-daemon/src/supervisor/provider.ts`** makes grep treat
  that source as binary and silently suppress it, invalidating negative greps over
  `worker-daemon/src`. Three other tracked files share it. I committed the same defect in my
  own test file and fixed it.
- **The PR gate could not complete** under two-lane operation (`cancel-in-progress: true`,
  seven consecutive cancellations). Fixed by scoping the concurrency setting to this branch;
  in-progress runs now reach a verdict.
- **★ A browser job's `maxSessionSeconds` is never read for the envelope deadline — this
  ticket's own miss.** `buildJobEnvelope` (`server/src/services/job-leasing.ts:344-348`)
  derives the deadline from `job.input.maxRuntimeSeconds ?? 600`, and `maxRuntimeSeconds` is a
  field of **`batchWorkloadV1Schema` only**. `browserWorkloadV1Schema` carries
  `maxSessionSeconds` instead, so **every browser envelope gets `now + 600 s`** regardless of
  the ceiling BRW-001 validated, defaulted and mutation-tested. Because `job.input` IS the
  workload and the schema is `.strict()`, the field cannot simply be added — that produces
  `unrecognized_keys`, a null envelope, and exactly the silent-never-leases defect BRW-001
  exists to prevent. **Latent, not live:** the envelope `deadline` is set and schema-validated
  but read by nothing in production, so nothing is truncated today; it bites the moment a
  worker honours it. Found by the SVC-001 terrain map, not by this ticket's own review — the
  same line breaks service jobs harder (a 10-minute deadline on a 72-hour workload class), and
  the three-way fork is stated in
  [`SVC-001-terrain.md`](../../E9-service-agents/tickets/SVC-001-terrain.md) §2 for a decision
  on the record. BRW-003 must not assume the ceiling is enforced anywhere.

## 8. CI status — the honest position

The definition of done requires **"CI is watched to green"**, and at the time of writing it is
**not**. This section exists because marking the ticket COMPLETE without it would be exactly
the overclaim this programme keeps finding in other people's work.

**What IS proven:**
- `pnpm test:run` at the repo root: **2252 test files passed, 165 skipped, 0 failed**, with
  the new package included. The two `*.browser.test.ts` files correctly SKIP without
  `AOA_RUN_BROWSER_TESTS`, and zero Chromium launches occur — so `verify` is unaffected.
- The package's own suite: **88 passed with a real browser, 77 without.**
- `node scripts/check-test-inventory.mjs` → OK (2588 files across 18 trees).

**What is NOT yet proven:** the `browser` lane has never completed green on CI. Its first run
failed for three reasons, all since fixed (§4 of the commit history): Chromium's OS sandbox
cannot start on a GitHub runner without unprivileged user namespaces, the lane did not build
the package the teardown tests spawn, and the test-inventory manifest lacked the new tree.
Whether the AppArmor sysctl actually grants the sandbox on a runner is **unverified** — it
cannot be reproduced locally, and the lane logs the before/after value and the kernel/distro
precisely so the next run answers it from the log alone.

**A risk I introduced deliberately and am naming rather than hiding:** `browser` was added to
`ci-required` **before it had ever passed**. If it stays red, the aggregator is red for Lane
A's pushes too. That is tolerable only because PR #323 is "[WIP integration, do not merge]",
so a red aggregator on this branch is a signal and not a merge blocker. The alternative —
making it advisory — would have created a check that can fail silently, which is worse. If it
cannot be made green promptly it should be raised, not left sitting red.

**One unexplained observation, recorded rather than dismissed:** an earlier root-suite run
reported `ELIFECYCLE exit 1` while a re-run was clean. The first run's output was truncated by
my own command and the evidence is gone. One failure against one pass is not enough to call it
a flake or a real defect, so it is logged here as unexplained. If it recurs, it is
deterministic and must be root-caused rather than re-run.
