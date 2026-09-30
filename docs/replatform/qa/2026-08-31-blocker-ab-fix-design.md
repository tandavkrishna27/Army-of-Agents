# Unit 1 — "the mechanism": Blocker A + B (+H1, +H3) — design v2 (post-review)

**Status:** design **v2**, rewritten after a 3-agent adversarial review that invalidated v1's core premises.
**Branch:** `docs/replatform-program` · **Source tip reviewed:** `322e5486a`
**Purpose:** make a real distributed run POSSIBLE, and be honest about what it proves.

> **★ v1 WAS WRONG IN FOUR LOAD-BEARING WAYS.** All four are recorded in §9 with their verification, because each is
> a false-green path that would have shipped: (1) there is **no rendered prompt** at the chosen seam; (2) the timeout
> formula yields **1 second**; (3) the real execution ceiling is **60 s**, not 600, and v1 never inspected it; (4) the
> Dockerfile two-stage install **silently installs nothing**. v2 supersedes v1 entirely.

**Unit 1 of 2.** Unit 1 = the MECHANISM (lease → sandbox → execute → terminal → projection). **Unit 2 = CAPABILITY**
(MCP tool surface, instructions/skills bundle, workspace, prompt delivery beyond argv, output capture). Unit 1 does
not pretend to be Unit 2; §8 states exactly what a green run does and does not prove.

---

## 1. The constraint that shapes everything: argv is the only channel

`createSpecFor` (`packages/worker-daemon/src/supervisor/supervisor.ts:275-281`) reads **only** `workload.command` and
`workload.args`. `ExecuteInput` (`supervisor/provider.ts:200-205`) has **no stdin**. `stdinArtifactId` has **zero
consumers** — every non-test occurrence is literally `: null`. `workspace` is hard-coded `null`
(`server/src/services/job-leasing.ts:371`). `env` is **only** the redeemed secret-handle map.

The legacy `claude_local` adapter delivers the prompt on **stdin** (`--print -` + `stdin: prompt`,
`packages/adapters/claude-local/src/server/execute.ts:736,879`) and passes `--mcp-config`,
`--append-system-prompt-file`, `--add-dir` — **host paths that do not exist inside E2B**.

## 2. What is NOT reusable (checked, rejected)

**The shadow comparator** (`server/src/services/job-shadow-comparator.ts:320-325`) *validates* a caller-supplied
workload; it does not build one. The task-run call site hand-writes `command: agent.adapterType` = `"claude_local"`
— **a registry key, not a binary**. Its own comment concedes the values are placeholders. Mirror its SHAPE, never
its VALUES.

★ **There is no rendered prompt at the seam** (v1's central error). `renderTemplate(...)` runs **inside**
`adapter.execute` (`claude-local/src/server/execute.ts:719-726`), and the canary `return`s at
`heartbeat.ts:5306` (`CLI-006-SUPPRESSION-RETURN`) — two lines *before* `adapter.execute` at `:5308`.
`runScopedConfig.promptTemplate` is an **unrendered template** with `{{…}}` tokens, and for agents migrated to the
instructions bundle the field is **deleted outright** (`server/src/routes/agents.ts`, the adapter→
`instructionsFilePath` map at `:117-123`). Reimplementing `renderTemplate` + its data bag + the two-part
`currentTaskMarkdown` fallback is **Unit 2**, not Unit 1.

## 3. Blocker A — v2

**Seam:** the canary call site in `heartbeat.ts` (~`:5234`). The optional `input` is ALREADY plumbed end-to-end
(`heartbeat-distributed-rollout.ts:83,148` → `run-execution-owner.ts:188,253` → `job-convert-orchestrator.ts:58` →
`job-admission-bridge.ts:262`); nothing pushes into it. No signature churn. (Alternatives rejected: the rollout hook
has no agent context; `run-execution-owner` lacks adapter/config; `job-admission-bridge` would apply to every source
kind and drag the registry across the JOB-010 parity boundary.)

**A new PURE helper** `server/src/services/task-run-batch-workload.ts` returning
`{ok: true, workload} | {ok: false, reason}`, self-validated against `batchWorkloadV1Schema`.
★ **Mirror the existing precedent** `server/src/services/browser-job-config.ts:31` (which already imports a workload
schema and validates in-builder) rather than inventing a shape.

| Field | v2 value | Rule |
|---|---|---|
| `command` | the adapter's real binary | `runtimeCommandSpec.command` (in scope, `heartbeat.ts:5047`), honoring `adapterConfig.command`. ★ **`runtimeCommandSpec` is `null` for 5 of 14 adapters** (`heartbeat.ts:437`) — a null is a REFUSAL, never a fallback. |
| `args` | **per-adapter**, two explicit shapes | claude: `["--print", <prompt>, "--output-format","stream-json","--verbose"]`. codex: `["exec","--json", …]` (`codex-local/src/server/execute.ts:553-566`) — the claude flags are meaningless to it. |
| prompt | **`context.currentTaskMarkdown`** | ★ v2's answer to §2: REAL task content, assembled at `heartbeat.ts:4224-4227` (`buildCurrentTaskMarkdown`), in scope at the seam. No template engine needed. |
| `stdinArtifactId` | `null` | Zero consumers; a value would be inert. |
| `maxRuntimeSeconds` | `timeoutConfigured ? min(600, floor(clamp(sec,1,86400))) : 600` | ★ **`defaultTimeoutSecForAdapter` is literally `return 0;` for EVERY adapter** (`heartbeat-stop-metadata.ts:38-40`), so v1's bare clamp yielded **1**. Also `effectiveTimeoutSec` can be **fractional** (`:61`, `timeoutMs/1000`) and the schema is `.int()`. |

### 3.1 ★ Gate on the disposition matrix — REFUSE, never guess

**There is NO adapter gate at the canary fork** (`heartbeat.ts:5217-5233` — seven conjuncts, none adapter-related;
`resolveRunRolloutState` takes no adapter input). So **any** of 14 adapters can reach this seam. v1 would have
emitted claude-shaped argv for `http`/`process`/`hermes_local`, whose real binaries live in `adapterConfig` — and
`command: "http"` **passes** `z.string().min(1).max(256)`, so the supervisor would run a nonexistent binary while
the real webhook is suppressed.

**Gate on `sandbox-coding-disposition.ts` (v1 scope = `claude_local`, `codex_local`) and refuse everything else.**
This is also required for correctness downstream: the secret-handle mint is gated on the same matrix
(`execution-secret-handle-mint.ts:167-169`), so a non-v1 adapter cannot get a credential handle **or a capability**
(§H2) and could never create a sandbox anyway.

### 3.2 Prompt size: REFUSE, never truncate

`args` elements cap at 8192 chars (`packages/worker-protocol/src/job.ts:290`, also ≤256 elements, `command` ≤256);
`jobs.input` caps at 64 KiB. If the task markdown does not fit ⇒ `{ok:false}`. **Silent truncation is forbidden** —
it yields a sandbox running a mutilated prompt that still terminalizes and (§8) still satisfies the verifier's
clause 5. Corroboration that real prompts exceed this: the repo's own audit cap is
`MAX_PROMPT_SNAPSHOT_CHARS = 16_000` (`server/src/services/prompt-snapshot.ts:28`), 2× the argv limit.

### 3.3 Fail-closed + ★ log EVERY legacy outcome

Add `workload_unavailable` to the union (`run-execution-owner.ts:113-123`). Adding a 6th member is safe — verified:
no exhaustive switch, no zod enum, no DB constraint, no metric label set; the only enumeration is a value-level
`as const` array in a test.

★ **A new reason alone is INVISIBLE.** All nine `canaryExecutionOwner` sites in `heartbeat.ts` read only
`owner`/`jobId`/`attemptId`; `reason`/`detail` is never logged or persisted. **So log `reason` on EVERY legacy
outcome**, not just the new one — logging only the new one leaves it indistinguishable from `rollout_not_canary` in
aggregate, which is the same blindness this is meant to fix. (v1 mis-cited the CLI-005 log as `heartbeat.ts:5275`;
it is **`:3275-3278`**, and it logs a *different* type — `JobConvertReason`, not `LegacyOwnerReason`.)

### 3.4 Do NOT promote the `batch` validator slot here
`workload-input-validators.ts:59-65`. Promotion would break the CLI-005 active convert (`heartbeat.ts:3260-3264`,
which deliberately passes no input to mint a durable non-leasable job) and newly 400 ~18 integration calls.

## 4. Blocker B — v2 (v1's Dockerfile did not work; this was MEASURED)

`networked-host.ts` gives BOTH halves: it wraps `runContainerHost` (⇒ `FileRecordStore` custody ⇒ enrolment at
`worker-daemon.ts:327-331`) **and** injects `makeNetworkedRunProvider` (⇒ gate 1). Only new env:
`AOA_WORKER_PROVIDER_URL`; unset ⇒ byte-identical inert boot.

### 4.1 ★ The keystone holds; v1's USE of it did not

**Keystone CONFIRMED (measured):** `computeRuntimeClosure` walks `.dependencies` only
(`scripts/lib/image-deps-stage.mjs:170`); `--filter-prod` selects **7** (== the guard), plain `--filter` selects
**8** (adds `sandbox-fake-provider` via `sandbox-provider-contract`'s devDep). pnpm 9.15.4 supports it.
★ *Latent:* the equivalence is coincidental on one axis — `--filter-prod` still traverses `optionalDependencies`,
which `indexPackages` ignores. Zero workspace manifests declare one today; add a sentence to the guard's invariant
comment so the first one doesn't silently re-open Blocker D.

★ **v1's `--prod` in the deps stage is FATAL.** Measured: a `--prod` install writes
`included:{devDependencies:false}` to `.modules.yaml`; the build stage's non-prod install then hits
`INCLUDED_DEPS_CONFLICT`, falls through to the purge prompt, and with Docker's closed stdin **exits 0 having
installed nothing** (`.pnpm` count unchanged at 52, `typescript` absent) — the next `pnpm … build` then dies on a
missing `tsc`. **v2: drop `--prod`; use `--filter-prod` for SELECTION only.** Measured green: deps `Scope: 7 of 8`,
build-stage 8-manifest re-install in 790 ms with **no purge**, `pnpm --filter "…worker-networked-host..." build`
exit 0, all 8 compiled. `pnpm deploy --prod` still prunes at the end. This also matches what control-plane and the
AM already do.

★ **The BUILD line must stay plain `--filter`.** Measured: `--filter-prod` on the build line **breaks** it —
`provider-capability`'s only edge to `worker-daemon` is a **devDependency**, so under the prod graph it is a leaf and
compiles before `worker-daemon/dist/index.d.ts` exists → `TS2307`. The devDep edge is what produces the correct
topological order. **Do not "make the selectors consistent."**

### 4.2 ★ v1's §4.3 was FACTUALLY WRONG about the adapter-manager

v1 claimed the AM deps stage selects 8 → `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`, fixable by one word. **Measured: it
selects 7 and exits 0** — pnpm's `...` walks the **discovered** workspace, and `sandbox-fake-provider` has no
manifest on disk at that point, so it cannot be selected. **The proposed one-word fix is a literal no-op.**
The AM image *is* unbuildable, but at **`docker/adapter-manager/Dockerfile:77`**: `COPY . .` (`:76`) makes
fake-provider discoverable, the build filter then selects 8, and that package has no `node_modules` →
`TS2307 Cannot find module 'node:crypto'`. **The real fix is a re-install after `COPY . .`** (or the 8th manifest in
deps + re-install) — *not* a selector swap. (And per §4.1, `--filter-prod` on that build line would make it worse.)

### 4.3 The edit
- **deps:** COPY the 7 closure manifests; `pnpm install --frozen-lockfile --filter-prod "…worker-daemon..."
  --filter-prod "…worker-networked-host..."` — **no `--prod`**.
- **build:** additionally COPY `sandbox-fake-provider`'s manifest + the package trees; re-install (non-prod, plain
  `--filter`); `pnpm --filter "@armyofagents/worker-networked-host..." build`; then two `pnpm deploy --prod` trees.
- ★ **`apply-workspace-publish-config.mjs` is NEWLY REQUIRED** — verified empirically: without it
  `node /worker-net-app/dist/bin/networked-host.js` dies `ERR_MODULE_NOT_FOUND … provider-wire/src/index.ts`; with
  it, it boots and correctly refuses on `AOA_WORKER_CONTROL_PLANE_URL is required`. **The failure appears at
  container START, not at build.** (Only `provider-wire` + `provider-capability` are promoted; the third is the
  deploy root.)
- **Two deploy trees:** `/worker-app` untouched (assertions depend on it), new bin at `/worker-net-app`.
- ★ **CMD unchanged.** `runContainerHost` constructs stores unconditionally and `resolveCustody` REFUSES
  `mounted_secret` with stores, exiting before the health socket binds. Every deployed worker is `mounted_secret`,
  so a global repoint would **crash-loop the fleet**. Opt-in via a per-service `command:` (`entrypoint.sh:16` is
  `exec "$@"`).

### 4.4 Guard lockstep (corrected + widened)

| File | Change |
|---|---|
| `scripts/check-image-deps-stages.mjs:41-44` | `entryPackages: [worker-daemon, worker-networked-host]` |
| `scripts/check-image-deps-stages.test.mjs` | ★ **THREE** `deepEqual(errors, [])` tests red, not one — `:185`, `:249`, `:296`. Add `worker-networked-host` to `WORKSPACE`; extend `WORKER_DEPS` 2 → 7 |
| `docker/images/__tests__/image-contents.test.mjs` | ★ **MISSED IN v1:** the anti-fake-provider `find` (`:105-109`) and the emitted-test check (`:121-125`) are **`/worker-app`-scoped**; a second tree puts that route outside the root. **Widen both to `/worker-app /worker-net-app`.** (Empirically `deploy --prod` prunes fake-provider, but a compiled **test file does ship** — `sandbox-provider-contract`'s tsconfig `files` is not subject to `exclude`, so `port-conformance.test.js` is emitted and shipped; inert, but it is why the 8th manifest is needed.) |
| `scripts/boot-roots-expectation.json:24-29` | prose only (`evaluateBootRoots` never reads `reason`); update for honesty. Keep `return { kind: "none" };` literal. |
| DEP-001 prose | ★ `e2b@2.30.5` IS now in the worker closure (`provider-wire` **value**-imports `sandbox-e2b-provider/errors.js`). Structurally safe (no key, never imported) but the "EXACTLY worker-daemon + worker-protocol" claim is false in `docker/worker/Dockerfile:6,23,67`, `DEP-001-result.md:31`, `image-deps-stage.mjs:13`, `DEP-010-design.md:704`. |

★ **`scripts` and `docker` are `pinned` in `test-inventory.json` (50 / 4), not floor** — adding any `*.test.mjs`
there needs a count bump **and** a `test-execution-census.json` entry.

### 4.5 ★ Staging is inert — but D1 is NOT, and that is new

Staging: confirmed inert (`AOA_WORKER_PROVIDER_URL` is not in `DISPATCH_SWITCH_ENVS`, no staging worker sets it or
overrides `command:`). **But `docker-compose.d1.yml:304,343` ALREADY set `AOA_WORKER_PROVIDER_URL` on both workers,
with a real `fake-provider` service on the net.** Today that is dead config because the image cannot act on it.
After Blocker B the image *contains the bin that reads it* — D1 moves from "structurally cannot construct a
provider" to "one `command:` line from a fabricating provider," and **no guard covers the transition**. The non-ban
was safe only because of the premise this change removes. **Add `AOA_WORKER_PROVIDER_URL` to `DISPATCH_SWITCH_ENVS`
(+ a D1 clause) in the same pass.**

### 4.6 ★ A broken worker image would ship `ci-required`-GREEN
`pr.yml` runs **no Docker build**; the worker image is built only by `docker/images/build.sh` from
`d1-merge-train.yml` — *after* the PR gate. So §4.1/§4.2-class failures red the merge train post-green.
`check-image-deps-stages` validates COPY **sets**; **nothing validates that the install/build actually runs.**
Build both images locally before pushing.

## 5. ★ H1 (NEW, code) — the real ceiling is 60 s, and it is also the sandbox TTL

`supervisor.ts:234` — `const opDeadlineMs = deps.opDeadlineMs ?? 60_000;`. The production compose
(`lifecycle/dispatch-runtime.ts:175-184`) passes provider/identity/eventSink/materializeRunSecrets/canaryCoordinator/
logger/metrics and **NOT `opDeadlineMs`**, so the 60 s default stands. That same `ctx.deadlineMs` becomes the E2B
**sandbox TTL** (`e2b-provider.ts:183,212,218`) *and* the command timeout (`:249`). **`maxRuntimeSeconds` never
reaches the supervisor.** §7's probe returned in ~1 s and never exercised it.

⇒ **Thread `opDeadlineMs` from the workload's `maxRuntimeSeconds` at `dispatch-runtime.ts`.** Without this, every
task that needs >60 s is killed and terminalizes `failed` — the single largest gap between what Unit 1 claims and
what it would deliver. ★ Note the coupling: raising it past ~5 min interacts with capability expiry
(`min(authorityNow+300_000, leaseDeadline)`, never re-minted on renewal) and would leak billable sandboxes via
`recordOrphan("cap_expired_before_happy_destroy")` — so raise the deadline **and** keep it under the cap, or fix
re-mint-on-renewal (already a filed deferral).

## 6. ★ H3 (NEW, code) — an UNSET control-plane key is a silent total outage

`server/src/config/control-plane-signing-key.ts:39-40` — `if (!keyPath) return undefined;` **before** any
`distributedExecutionEnabled` check. The loud-fatal arm fires only for *set-but-unparseable*. Meanwhile the AM
**refuses to boot ungated**, so its gate is always on. ⇒ forgetting the env var = the key resolves "fine", no
capability is ever minted, **no sandbox is ever created**, and the only signal anywhere is one worker-side `warn`.
**Make unset + `distributedExecutionEnabled` a loud refusal (or at minimum an error-level log).** This is a gap in
my own Mint-2 scoping: I made present-but-bad loud and left absent silent.

## 7. Preconditions Unit 1 does NOT deliver — document as hard runbook steps

1. ★ **A `company_secrets` row named exactly `provider:anthropic`.** The owned-labels capability rides **only** on a
   redeemed credential handle (`secret-redemption.ts:149-164`); no handle ⇒ `capability === undefined` ⇒
   `supervisor.ts:494` terminal **`no_run_capability`** ⇒ **no sandbox at all** (not "no auth"). `runtime_provider_keys`
   is `["e2b"]`-only and does NOT satisfy this — a **second, previously undocumented credential**.
2. ★ **An `execution_targets` row of kind `pooled_gvisor`**, ratified, org-scoped, heartbeating. The canary's
   credential binding is four nulls → the resolver picks `kind === "pooled_gvisor"` only. **Un-ratified is worse than
   "no placement": `admitSelfModelRead` refuses → `no_self_model` → the worker never polls.**
3. `organizations.concurrency_cap` **NULL or ≥ 2** (`1` makes the canary deny itself — it is already `running` and
   counts against itself). ★ The terrain doc named the **wrong dial**: the per-agent `maxConcurrentRuns` is not
   consulted here.
4. The agent's `adapter_type` must be `claude_local` (or `codex_local`) — §3.1.

## 8. ★ Acceptance — corrected, and less generous than v1

★ **v1 was wrong in the campaign's favour.** Clause 5 requires ≥1 `attempt_started`, emitted **only after create
succeeds** (`supervisor.ts:544`). So every pre-create failure — `secret_redemption_failed`, `no_run_capability`,
`create_failed`, `create_timeout` — **FAILS** the verifier. The verifier *does* distinguish "no sandbox" from
"sandbox ran"; it only fails to distinguish "ran well" from "ran and died" (clause 3 is terminal-agnostic).

★ **Nothing the agent produces reaches AoA.** `observeRun` is not composed (`dispatch-runtime.ts:175-184`); the E5
boundary returns opaque `stdoutRef` only (`e2b-provider.ts:256-257`); `buildWorkspacePatch` is never called; and the
canary's early return skips all post-run capture. **So "real stdout" is verifiable ONLY by hand at the E2B console.**

**Unit 1 acceptance:** (1) a real lease offered+acked+fenced; (2) a real `aoa-base` sandbox created via the gated AM
`create`; (3) `claude` executes with a non-127 exit **within 60 s or the threaded deadline**; (4) terminal + an
`applied` `attempt_terminal` receipt; (5) **the E2B console inspected by hand** for real output. Report anything
less as such.

## 9. What v1 got wrong (kept deliberately — each was a false-green)

| v1 claim | Reality | Verified |
|---|---|---|
| "the rendered prompt is in scope at the seam" | rendering is inside `adapter.execute`, after the canary returns; the field is deleted for migrated agents | orchestrator, `execute.ts:719` vs `heartbeat.ts:5306/5308` |
| `clamp(sec,1,86400)`, "default 600" | `defaultTimeoutSecForAdapter` returns **0** always ⇒ **1 second** | orchestrator, `heartbeat-stop-metadata.ts:38-40` |
| "600 is the effective ceiling" | the ceiling is **60 s** (`opDeadlineMs` default, never threaded) and is also the sandbox TTL | orchestrator, `supervisor.ts:234` + `dispatch-runtime.ts:175-184` |
| deps `--prod` + build non-prod | `INCLUDED_DEPS_CONFLICT` → purge prompt → **exit 0, nothing installed** | review, measured |
| AM fix = one word (`--filter-prod`) | a **no-op**; the real failure is at `:77` after `COPY . .`, and `--filter-prod` there would break the build order | review, measured |
| "one claude-shaped argv" | no adapter gate exists; 5/14 adapters have a `null` command spec | review |
| §7.5 "ANTHROPIC_API_KEY alone authenticates" (generalized) | true only for claude_local + cloud-sandbox mode + a minted handle | review |

## 10. Sub-slicing

1. **A1** — the pure builder + unit tests (disposition gate, per-adapter argv, the >8 KiB refusal, the timeout
   expression incl. the `0`-default and fractional cases, determinism).
2. **A2** — the seam: pass `input`; add `workload_unavailable`; **log `reason` on every legacy outcome**.
3. **H1** — thread `opDeadlineMs` (+ a test that the workload value reaches `ctx.deadlineMs`).
4. **H3** — loud unset CP key when distributed execution is on.
5. **B1** — the worker Dockerfile (v2 selectors), the AM re-install fix, the guard lockstep incl. the widened
   `image-contents` roots, `DISPATCH_SWITCH_ENVS` + D1 clause, prose corrections. ★ **Build both images locally** —
   CI will not.
6. **F** — file Blocker A in `finding-ownership.json` with an owning ticket; correct the runbook's `aoa_tkt_` ticket
   format and add §7's preconditions.

---

## 11. BUILD RESULT (2026-09-01)

Branch `claude/blocker-ab-agent-mechanism-999514`, off `156e2b25e`. Six commits, each independently
green, in the design's §10 order.

| Slice | SHA | What landed |
|---|---|---|
| A1 | `3f6009b28` | `server/src/services/task-run-batch-workload.ts` — the pure builder + 52 tests |
| A2 | `73ef21b2c` | the seam pushes `input`; `workload_unavailable`; `reason` logged on EVERY outcome |
| H1 | `47289a567` | `opDeadlineMs` accepts a per-run resolver; `dispatch-runtime` derives it from the workload |
| H3 | `9776cbda9` | an UNSET control-plane mint key is reported, not silent |
| B1 | `b155034f1` | the worker image ships the networked-host bin; AM build fixed; guards in lockstep |
| F | `a59c91e3f` | E7-F002/E7-F003 filed; runbook ticket format + preconditions; `e2b/README.md` corrected |

**Verification.** `pnpm -r typecheck` green (all 35 projects, `ui` included). Full root
`pnpm exec vitest run`: **2336 test files passed, 0 failed; 21,864 tests passed, 1300 skipped.**
All 20 policy guards + 13 guard self-tests green;
`brand-check`'s forbidden-token scan clean and no new `AOA_*` env read. **Both images built and
smoke-run locally**, which CI does not do: `docker build --target production` for
`docker/worker/Dockerfile` and `docker/adapter-manager/Dockerfile`, then
`node /worker-net-app/dist/bin/networked-host.js` → refuses on `AOA_WORKER_CONTROL_PLANE_URL` (the
predicted refusal), the unchanged daemon CMD → same refusal from `/worker-app`, and the AM →
refuses ungated. `image-contents.test.mjs` was run for real against the built worker image with
`AOA_DEP001_IMAGE_TEST=1`.

### 11.1 The design held. Every measured claim reproduced.

The adapter-manager diagnosis in §4.2 reproduced **exactly**: `docker build --target build` fails at
`Dockerfile:77` with `sandbox-fake-provider ... TS2307: Cannot find module 'node:crypto'`, after
`COPY . .` at `:76` makes it discoverable. The re-install fix works. §4.3's claim that
`apply-workspace-publish-config.mjs` is newly required, and that its absence fails at container
START rather than at build, also held. The three predicted red tests in
`check-image-deps-stages.test.mjs` were red, at the predicted lines.

### 11.2 Deviations, and why

**1. H3 is an ERROR-LEVEL REPORT, not a refusal (§6 asked for a "loud refusal").** A refusal would
be wrong, not merely inconvenient: `docker-compose.d1.yml` runs BOTH control planes with
`AOA_DISTRIBUTED_EXECUTION_ENABLED: "true"` and NO signing key, and that is a legitimate shape —
D1's workers are `mounted_secret` with no provider, so they never create a sandbox and never need a
minted capability. Throwing would crash-loop them and red the merge train over a correct config.
Present-but-BAD stays a hard refusal; that one is always an operator error. (§6's own parenthetical
allowed "at minimum an error-level log".)

**2. H1 threads the deadline THROUGH the supervisor, not at the composition root alone.** §5 says
"thread `opDeadlineMs` at `dispatch-runtime.ts`", but `makeSupervisor` is called ONCE and has no
handoff at construction, so a plain number there cannot carry a per-run value.
`SupervisorDeps.opDeadlineMs` now accepts `number | ((handoff) => number)`; the composition root
passes the resolver, so the POLICY still lives at `dispatch-runtime.ts` as the design intends.

**3. The H1 ceiling is 240 s, DERIVED.** §5 said "keep it under the cap". The constant is now
`OWNED_LABELS_CAPABILITY_TTL_MS - RUN_TEARDOWN_HEADROOM_MS`, so it cannot drift away from its
reason, and the relationship is asserted in a test. Scope is narrower than "everywhere": `create`
(whose ctx IS the sandbox TTL) and `execute` use the run budget; the create RACE keeps
`createDeadlineMs`, and cleanup/teardown keep the base — a long run budget is not a reason to let a
destroy hang.

**4. The argv shapes are minimal on BOTH sides.** §3 specifies the claude shape exactly and leaves
codex as `["exec","--json", …]`. Emitted: `["exec","--json",<prompt>]`. Deliberately no `--model`,
no `--search`, no bypass flag, no `--skip-git-repo-check`, even though the legacy adapter derives
all of them from config. Model pinning and permission posture are Unit 2 fidelity, and adding them
here would have been exactly the smuggling §Fences forbids. ★ Note `codex exec` normally reads the
prompt from stdin (`… -`); with no stdin channel the `-` is replaced by the prompt as a positional,
a supported form. **Not live-validated** — Unit 1's acceptance is a claude run.

**5. F filed TWO findings, not one.** E7-F002 records Blocker A (resolved). E7-F003 records the
residual — Unit 1's workload is argv-only — as OPEN and `unowned`. That second one matters: the
verifier's clause 5 keys on `attempt_started`, so a run with a context-free prompt still creates a
sandbox, still terminalizes, and still PASSES. The bound had to become machine-visible before the
campaign reads a green run, and Unit 2 has no ticket on disk to point at honestly.

**6. B1 added guards the design did not list.** Three cases in
`check-image-deps-stages.test.mjs` (missing networked-host; missing provider-wire — which is
reachable ONLY through the new entry package, so it pins that package specifically; and
fake-provider in the deps stage), two in `check-staging-manifest.test.mjs`, and — the substantive
one — `checkWorkersEnterTheDaemonBin` in `scripts/lib/d1-compose-invariants.mjs` with three tests.
§4.5 said to add the env to `DISPATCH_SWITCH_ENVS` "+ a D1 clause"; the env ban alone is NOT enough
for D1, because the D1 dispatch-declaration checker parses `environment` only and would stay green
through a `command:` override — which is the actual remaining step to a fabricating provider there.

**7. `e2b/README.md` was corrected too**, not just the runbook. The README is the SOURCE of the
no-op `e2b template build`; the terrain doc also still repeated that command at its line 97, four
pages before measuring it as broken.

### 11.3 Three things mutation testing changed

Every slice was mutation-tested. Three survivors were real defects in the tests, not noise:

1. **The disposition gate was behaviourally equivalent to the argv switch** — deleting it left all
   twelve refusal cases green, because `buildArgsFor` already returns `null` for anything else with
   the same reason. No example-based test can separate them. The cases are now DERIVED from
   `CODING_ADAPTER_DISPOSITIONS`, which catches the thing that actually matters: the day the matrix
   admits a third `v1` adapter, the switch would silently refuse it.
2. **The `Math.floor` test was vacuous.** `resolveHeartbeatRunTimeoutPolicy` already floors on its
   non-`http` branch, so a `{timeoutSec: 45.9}` case against `claude_local` tests nothing. The only
   fractional producer is the `http` branch, which the gate excludes — so the floor is now exercised
   at the exported resolver against that producer, with a comment saying why the obvious form is
   vacuous.
3. **H1's execute RACE was unobserved.** Reverting only the race to the base 60 s left every
   `ctx.deadlineMs` assertion green, because the fake provider returns instantly. That revert is the
   same bug relocated — a 90 s command inside a 180 s ctx budget killed at 60 s and reported
   `execute_timeout`. The armed timer is now observed directly through the injected scheduler.

A fourth survivor was accepted as equivalent-by-design and documented rather than "fixed".

### 11.4 What is Unit 2, not smuggled in here

MCP tool surface (`--mcp-config`), the instructions bundle
(`--append-system-prompt-file`), the workspace (`--add-dir`; `workspace` is hard-coded `null`),
`renderTemplate` + its data bag, model/permission-flag fidelity, and output capture (`observeRun` is
not composed; the E5 boundary returns an opaque `stdoutRef`). All six are enumerated in E7-F003 with
their per-item consequence inside the sandbox.

### 11.5 Still owed, and unchanged by this Unit

§7's preconditions are runbook steps, not code, and remain the operator's: the `provider:anthropic`
company secret, a ratified `pooled_gvisor` target, `organizations.concurrency_cap` NULL or >= 2, the
E2B template, and the CP/AM keypair. §8's acceptance is unchanged — clause 5 still needs the E2B
console inspected BY HAND, because nothing the agent produces reaches AoA.

### 11.6 The two "environmental" failures had ONE cause, and it was the install flag

Worth writing down because the first reading was plausible and wrong, and a plausible-and-wrong
"it's environmental" is how a real failure gets waved through.

Two things failed on this host: `ui` typecheck (`Property 'toBeInTheDocument' does not exist`, across
files dating to 2026-07-14) and, on the first full root `vitest run`, **550 `ui` test FILES**. Neither
could be caused by this change — it touches zero `ui` files and `ui/tsconfig.json` has no project
references — but "cannot be mine" is not the same as "explained".

The single root cause: this worktree sits deep under OneDrive, so `pnpm install` needs
`--virtual-store-dir=C:/pn/<short>` to avoid `ENAMETOOLONG`. That puts the virtual store OUTSIDE the
workspace root — and `@testing-library/jest-dom/dist/vitest.mjs` does a bare `import ... from
"vitest"`. Node's upward `node_modules` walk from `C:\pn\blockab\@testing-library+jest-dom@6.9.1\`
never reaches the repo's hoisted `vitest`, so the import fails. Every one of the 550 failures was a
COLLECTION error with that identical message; zero were assertion failures. The typecheck failure is
the same package failing to contribute its `Assertion` augmentation, for the same reason.

Verified rather than assumed: junctioning `vitest` into that store directory makes the previously
failing `ui` specs pass and `pnpm --filter @armyofagents/ui typecheck` go green, with no source
change. CI is unaffected (Linux, default virtual store inside the workspace).

★ For the next session in a deep-OneDrive worktree: `--virtual-store-dir` outside the workspace root
breaks any dependency that resolves a PEER by bare specifier. It is not only a path-length
workaround; it changes resolution.
