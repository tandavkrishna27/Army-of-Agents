# BRW-002 — Sandbox-local Playwright runtime — DESIGN (v2)

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Start SHA:** this commit
**Supersedes:** design v1 (`3f96ffcb3`), which **failed plan review with 10 BLOCKERs and 22
HIGHs**. v1's thesis survived; its mechanisms did not. §10 records what was wrong and why,
because the errors are the useful part.
**Terrain:** [`BRW-002-terrain.md`](./BRW-002-terrain.md) · **Depends on:** BRW-001 ✅, WRK-004 ✅

**Acceptance.** (a) browser process shares only the job sandbox; (b) downloads stay job
scoped; (c) browser and child processes die on cancellation.
**Test.** Deterministic local site navigation, download, popup, and kill.

---

## 1. The architecture, corrected

v1 said the runtime "runs inside the sandbox" **and** is "driven through injected
`exec`/`writeFile`/`readFile` primitives". **Those cannot both describe the control channel**,
and this is the finding that reorganised the design.

`playwright-core/lib/server/browserType.js:268-269`:

```js
const stdio = launchedProcess.stdio;
transport = new PipeTransport(stdio[3], stdio[4]);
```

CDP rides **file descriptors 3 and 4 of the spawned child**, held only by the process that
spawned it. A host-side orchestrator reaching in through `exec` can never hold them. So:

```
HOST (worker / control plane)                 SANDBOX (one per job)
  │                                             │
  ├─ writeFiles: runner bundle + config ──────► /opt/aoa-browser/{runner.mjs, session.json}
  ├─ exec: node /opt/aoa-browser/runner.mjs ──►  in-guest RUNNER  ← the Playwright parent
  │                                             │    └─ launchPersistentContext()
  │                                             │         pipe on fds 3/4, parent = runner
  │◄─ stdout: NDJSON event stream ──────────────┤    └─ drives the browser
  ├─ readFile: evidence + results ─────────────►│    └─ writes under the job root
  └─ destroy (teardown) ───────────────────────►│
```

**The host never holds the CDP pipe and never drives Playwright.** It stages, starts,
observes, collects, and destroys. That is the only shape the transport permits.

Consequence for testability, stated plainly because v1 got this backwards: injecting fakes
for `exec`/`writeFile`/`readFile` exercises **the launcher**, not the browser. Browser
behaviour needs a real browser, which is why §7 builds a lane instead of asserting one exists.

## 2. Clause (a) — "shares only the job sandbox"

### 2.1 No debugging port — guard the OPTION, not just the args

Playwright uses the pipe **unless a port is requested** (`chromium.js:266-270`, verified
directly). v1 guarded `args` only. That is the wrong surface: `cdpPort` is a **launch option**
that never appears in `args`, and it alone flips the transport to a WebSocket endpoint
(`browserType.js:265-266`).

`assertNoRemoteControlRequested(launchOptions, env)` — a pure function, refusing:

| Surface | Why |
|---|---|
| `cdpPort` set | flips to WebSocketTransport; invisible in `args` |
| `--remote-debugging-port` / `--remote-debugging-address` in `args` | direct |
| `SELENIUM_REMOTE_URL`, `PW_TEST_CONNECT_WS_ENDPOINT` in env | reroute the driver to a remote endpoint |
| any use of `connectOverCDP` | requires a port by construction |

### 2.2 Chromium's OS sandbox must be turned back ON

`chromium.js:295-296`, verified directly:

```js
if (options.chromiumSandbox !== true)
  chromeArguments.push("--no-sandbox");
```

**Playwright disables Chromium's own sandbox by default.** v1 never mentioned it while every
containment argument assumed the renderer stayed contained. The runner passes
`chromiumSandbox: true` and asserts `--no-sandbox` is absent from the effective arguments.

**Open risk, tested not assumed:** Chromium's sandbox needs user namespaces, which a managed
microVM may not grant. §7's lane runs this first. If E2B refuses it, that is a **finding to
escalate**, not a flag to quietly drop — dropping it silently is how a containment claim
becomes false.

### 2.3 The guard is a DELTA, not an absolute set

v1 required the listening-socket set to "contain nothing but the test site's port". **That is
false at t=0**: every E2B sandbox runs envd on TCP **49983** (`e2b/dist/index.js:885`,
`_ConnectionConfig.envdPort = 49983`) — it is how `exec`/`writeFiles` reach the guest. A guard
that cannot pass gets relaxed into an allowlist, which is how it stops guarding.

So the measurement is the **delta introduced by launching the browser**:

```
before = listeningPorts()        // envd, and the fixture site
launch()
after  = listeningPorts()
assert setDifference(after, before) is EMPTY
```

Robust to any pre-existing infrastructure listener, and it fails if a future Playwright or
Chromium build opens a port for any reason — which an argument allowlist cannot detect.

`listeningPorts()` reads **`/proc/net/tcp` AND `/proc/net/tcp6`**. v1 named the singular file;
a listener bound to `::` appears **only** in `tcp6`, so the v1 fallback would have reported
"clean" while a port was bound. `ss` is **not** installed in `node:22`/Debian bookworm
(measured), so `/proc` parsing is the primary path, not a fallback.

### 2.4 What this does not claim

Cross-tenant isolation of the microVM is the provider's property (DEP-008 certifies it).
BRW-002 claims only: **this job's browser opens no reachable endpoint.**

## 3. Clause (b) — "downloads stay job scoped"

### 3.1 v1's three layers were one inert, one fatal, one overridden

Measured by review, then confirmed against source:

- **`downloadsPath` is a LAUNCH option, not a context option.** `newContext({downloadsPath})`
  is accepted and **silently discarded**; the download landed in
  `/tmp/playwright-artifacts-*/GUID` and the job root was never created. Clause (b) would have
  failed silently while a naive assertion passed.
- **`--user-data-dir` in `args` THROWS** (`chromium.js:278-280`) — Playwright manages the
  profile and refuses the argument.
- The `download.default_directory` **preference is overridden** at every context init by
  `Browser.setDownloadBehavior` (`crBrowser.js:305-310`).

### 3.2 One real mechanism, plus explicit persistence

```js
chromium.launchPersistentContext(userDataDir, {
  chromiumSandbox: true,
  acceptDownloads: true,
  downloadsPath: JOB_DOWNLOAD_ROOT,
})
```

`userDataDir` is a **parameter**, not an argument — which is exactly what Playwright demands.

**But `downloadsPath` is a staging area, not a sink: Playwright DELETES its contents when the
context closes.** So a download is only durable once explicitly persisted:

```
download.saveAs(assertUnderRoot(JOB_DOWNLOAD_ROOT, safeName(download.suggestedFilename())))
```

`download.saveAs()` is also **the surface that can actually escape** — it takes a
caller-supplied path — whereas `suggestedFilename` is pre-sanitised by Chromium. §6 tests the
escapable surface, not the safe one.

### 3.3 The root sits OUTSIDE the workspace, deliberately

The live capture path sweeps `remoteCwd` into the artifact store. A download root inside it
would satisfy "job scoped" while the bytes leave the sandbox entirely. The root is therefore
outside the workspace, and BRW-003 promotes evidence deliberately rather than by sweep.

### 3.4 `assertUnderRoot` must ask the filesystem

v1 described a string function. **A string function cannot see a symlink.** The check resolves
the candidate's existing parent with `fs.realpathSync`, then verifies the resolved path is
under the resolved root — the same shape as the host-side `assertCaptureRoot`, which is a
filesystem check for this reason. Rejects `..`, absolute reassignment, control bytes and NUL,
and a symlink planted earlier in the session.

## 4. Clause (c) — dies on cancellation

`signal()` ignores its `kind` and reports `{delivered:true}` unconditionally, while the
contract defines that outcome as *ends the process tree*. So teardown is built on
**`destroy`/`terminate`**, and the test says what is true: **sandbox destroyed ⇒ browser and
children gone.**

**Ordering that v1 got wrong and that is mutually constrained:**

- **Video is only written on `context.close()`** — so "stream everything during the run" is
  false for video.
- **`context.close()` deletes the `downloadsPath` staging area.**

Therefore the runner's terminal sequence is fixed and testable:

```
1. download.saveAs(...)   → persist every download under the job root
2. context.close()        → flush video
3. (host) destroy         → reclaim the sandbox
```

Getting this order wrong loses either the downloads or the video, silently. It is asserted by
a named test rather than left to a comment.

## 5. `public_cdp_endpoint` has no enforcer — BRW-002 builds one

The frozen fixture names `public_cdp_endpoint` a forbidden effect
(`browser-approval-download.json:222`), and review found **nothing anywhere enforces it** —
`forbiddenEffects` is only length-checked by `golden-journeys.test.ts`. A named forbidden
effect nobody checks is precisely this programme's signature defect.

BRW-002 makes §2.1's option guard and §2.3's socket delta the enforcers, and names them
against that token so a later reader can trace the fixture's vocabulary to running code.

## 6. Tests — with the environment that runs them

| Clause | Test | Runs in |
|---|---|---|
| (a) no remote control requested | `browser-launch-guard.test.ts` — `cdpPort`, both args, both env vars, `connectOverCDP` | unit, any OS |
| (a) OS sandbox on | `browser-launch-guard.test.ts` — `--no-sandbox` absent from effective args | unit |
| (a) socket delta empty | `browser-containment.browser.test.ts` | **browser lane (§7)** |
| (a) `/proc` parsing | `listening-ports.test.ts` — IPv4 + IPv6 fixtures, hex byte order, `::` only in tcp6 | unit |
| (b) root confinement | `sandbox-path-adapter.test.ts` — `..`, absolute, NUL, **symlink planted on a real fs** | unit (real tmpdir) |
| (b) persistence | `browser-download.browser.test.ts` — `saveAs` into the root; escape attempt refused; file survives `context.close()` | **browser lane** |
| (c) terminal ordering | `browser-teardown.browser.test.ts` — downloads persisted AND video written; order inverted ⇒ red | **browser lane** |
| Test clause | `browser-journey.browser.test.ts` — navigation, download, popup, kill against the fixture site | **browser lane** |

**Guards to mutation-test:** the option guard (each surface separately), the `chromiumSandbox`
assertion, the socket-delta comparison, the tcp6 read, `assertUnderRoot`'s realpath call, and
the terminal-ordering branch.

## 7. The browser lane — because none of the above is falsifiable without it

Review found **no environment where a browser test can run**: the vitest project list has no
browser entry, `verify` installs no browsers, and the mock transport never executes a command.

BRW-002 adds a `browser` CI job (Linux) that installs Playwright's Chromium and runs the
`*.browser.test.ts` suite against a fixture site. It is **not** the D1 topology and does not
trespass on BRW-005 — it is the minimum that makes this ticket's own clauses falsifiable.

Template notes for the authored Dockerfile, all measured:
- headless uses a **different binary** — `chromium-headless-shell`, not `chromium`
  (`chromium.js:326`). Install must cover the one that actually runs.
- `--disable-dev-shm-usage` is **already a Playwright default** (`chromiumSwitches.js:68`).
  v1 proposed adding it; that was a claim made without checking.
- browser cache path and ownership must match the sandbox user, not root.
- the provider's default template is `"base"`, not `"aoa-base"`.

## 8. Scope

**In:** the in-guest runner, the launch guards, the socket-delta measurement, the path
adapter, the download persistence + ordering, the fixture site, the browser CI lane, and the
authored Dockerfile.

**Deferred, with reasons:** per-workload template selection and worker `browserSessionSlots`
(real-provider placement, BRW-005/D3); egress policy (BRW-004 — terrain §6 records the model
mismatch); evidence streaming (BRW-003); the frozen `deadlineMs: 20000` and slot-release-on-
cancel (named as untested in terrain, carried as open risks with a named owner).

## 9. Honest risk

`chromiumSandbox: true` may not be grantable inside a managed microVM (§2.2). The lane tests
it first, and a refusal is escalated rather than silently downgraded. If it cannot be granted,
clause (a)'s strength is materially reduced and that belongs in front of the programme owner,
not in a comment.

## 10. What v1 got wrong

Recorded because the pattern matters more than the list. v1's thesis — CDP over a pipe — was
correct and is now verified three ways. Everything built **on top of** it was asserted rather
than checked:

| v1 claim | Reality |
|---|---|
| `downloadsPath` on the context | launch-only; silently discarded |
| `--user-data-dir` as a layer | Playwright throws |
| profile pref as a third layer | overridden by CDP at every context init |
| "three independent layers" | one inert, one fatal, one overridden |
| socket set contains only the test port | envd holds 49983 in every sandbox |
| `/proc/net/tcp` | IPv4 only; `::` listeners live in `tcp6` |
| `ss` with a `/proc` fallback | `ss` absent from the base image |
| guard `args` for debug ports | `cdpPort` never appears in `args` |
| `assertUnderRoot` as string logic | cannot see symlinks |
| hostile filenames prove confinement | Chromium pre-sanitises; `saveAs` is the escapable surface |
| stream all evidence during the run | video requires `context.close()` |
| add `--disable-dev-shm-usage` | already a Playwright default |
| host drives Playwright over injected primitives | the pipe is on the child's fds 3/4 |
| Chromium's OS sandbox (unmentioned) | Playwright disables it by default |

The common thread: **every one is a claim about a dependency's behaviour that I did not open
the dependency to check.** The probe in terrain §1 was right for the same reason in reverse —
it measured. This design's guards are measurements wherever a measurement is possible.
