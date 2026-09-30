# E7-1 campaign — BLOCKERS + campaign-minimal fleet terrain (2026-08-31)

**Status:** terrain + blocker register · **Worktree:** `C:\e3` · **Branch:** `docs/replatform-program` · **Tip:** `727d4d635`
**Purpose:** a C0 deploy was scoped against a real single-box host (Hetzner, Ubuntu 26.04, 2 vCPU / 3.7 GB / 38 GB,
Docker 29.7 + Compose v5.5). Pre-deploy research found the campaign **cannot produce a verifier-PASS run today**.
This doc records the blockers (each verified against source), the fleet terrain for when they are fixed, and the
silent-kill register. **Nothing was deployed. No spend was incurred.**

> **★ THE HEADLINE.** Two independent, source-verified defects make an E7-1 run impossible. Deploying first would
> have burned real E2B + model-provider spend on a run that was structurally incapable of passing. Both are
> session-buildable code fixes.

---

## 1. BLOCKER A (P1) — the canary submits an EMPTY batch workload, so no lease can ever be offered

**Orchestrator-verified end-to-end against source.** The chain:

1. `server/src/services/heartbeat.ts:5234` — the canary calls `resolveExecutionOwner({source, actor,
   organizationId, idempotencyKey, rolloutState})`. **There is no `input` key.**
2. `server/src/services/heartbeat-distributed-rollout.ts:148` — `jobInput: input` (undefined).
3. `server/src/services/run-execution-owner.ts:253` — `input: jobInput` (undefined).
4. `server/src/services/job-admission-bridge.ts:262` — `admitAndSubmit(source, actor, idempotencyKey, input = {})`
   → **defaults to `{}`**, which is persisted as `jobs.input`.
5. `server/src/services/job-leasing.ts:382` — `buildJobEnvelope` sets `workload: input.job.input` (= `{}`).
6. `packages/worker-protocol/src/job.ts` — `batchWorkloadV1Schema` is `.strict()` and **requires** `command`
   (min 1), `args`, `stdinArtifactId`, `maxRuntimeSeconds`. `{}` cannot pass.
7. `job-leasing.ts:384` — `jobEnvelopeV1Schema.safeParse(candidate)` → `null`.
8. `job-leasing.ts:614` — `if (!jobEnvelope) throw new JobLeasingError("internal_unavailable")` → **no lease, ever.**

**Nothing in production constructs a batch workload for a `task_run`.** Observable outcome of a campaign run:
verifier clauses 1–3 PASS (the handoff marker is written, ids set, the run terminalizes) and **clause 5 FAILS** with
*"no worker lease for the attempt (never-leased inert handoff)"* — precisely the false-PASS case clause 5 exists to
catch.

**Provenance:** filed in `docs/replatform/epics/E8-browser-automation/tickets/BRW-001-design.md` as *"F3 [P1]
(confidence 9/10) — CROSS-LANE. NOT FIXED HERE, BY DECISION"* with the identical trace; `BRW-001-result.md` records
it was *"reported directly to the programme owner; deliberately not written up on the branch at their instruction."*
★ **It is NOT in `scripts/finding-ownership.json`** — no ticket, no owner. It should be filed properly.

**Fix shape:** populate a valid `batchWorkloadV1` at the canary call site (`command`/`args` sourced from the resolved
adapter's sandbox command; `stdinArtifactId` nullable; a bounded `maxRuntimeSeconds`). Small, well-scoped, and it is
the single change that unblocks **every** variant of the campaign (including the degraded desktop-worker fallback,
which also dies here — the envelope fails before any provider is consulted).

## 2. BLOCKER B — no shipped worker image can construct a provider

**Orchestrator-verified.** `docker/worker/Dockerfile` COPYs **only** `packages/worker-protocol` and
`packages/worker-daemon` (`:31-32`, `:57-58`) — a repo-wide grep for `worker-networked-host|provider-wire` in that
Dockerfile returns **0**. Its `CMD` is `["node","dist/bin/worker-daemon.js"]` (`:112`), the bare daemon root, which
calls `bootstrapWorkerDaemon` with **no provider and no `makeRunProvider`** → `decideDispatchComposition` refuses at
gate 1 with `no_provider` (`packages/worker-daemon/src/lifecycle/compose-dispatch.ts:103`).

Corroborated in three places in-tree: `scripts/boot-roots-expectation.json` ("Ships INERT: no image runs this bin
(Slice 5)"), `packages/worker-networked-host/src/resolve-provider-url.ts:13-15`, and
`docs/deploy/environment-variables.md:196`. ⇒ **`AOA_WORKER_PROVIDER_URL` is a dead variable in the shipped worker
image** (`scripts/d1-dispatch-expectation.json`: *"PRESENT and DEAD … read by NO code"*).

★ **This is a gap in the DEP-012 Slice 4+5 design** (which shipped the *adapter-manager* image but never asked
whether the *worker* image could run the networked-host root). Slice 2b recorded "no split-worker-image home yet
(Slice 5)" and Slice 5 did not close it.

**Fix shape:** add `@armyofagents/worker-networked-host` (and its `provider-wire` closure) to
`docker/worker/Dockerfile` deps+build stages, **and update `IMAGES[worker].entryPackages` in
`scripts/check-image-deps-stages.mjs` in LOCKSTEP** (that checker runs in the always-on `policy` gate,
`.github/workflows/pr.yml:468`), then run the worker with `command: ["node","dist/bin/networked-host.js"]`.
★ That one bin gives BOTH halves: it wraps `runContainerHost` (so `file_record` custody + enrolment work) **and**
injects `makeNetworkedRunProvider(url)` (so dispatch composes).

**Do NOT repoint the image CMD** to `container-host.js`/`networked-host.js` globally — `runContainerHost` injects
stores unconditionally and `resolveCustody("mounted_secret", stores)` REFUSES, crash-looping every still-
`mounted_secret` container (`packages/worker-daemon/src/bin/container-host.ts:16-25`). Use a per-service `command:`.

## 3. BLOCKER C (config, not code) — `mounted_secret` custody cannot enrol

`AOA_WORKER_KEY_STORE_MODE` defaults to `mounted_secret`, and BOTH compose files set it. The enrolment block
(`packages/worker-daemon/src/bin/worker-daemon.ts:327-331`) runs **only** for `os_keychain` or `file_record` with
stores injected. In `mounted_secret`, `AOA_WORKER_ENROLLMENT_CODE_FILE` is validated non-empty at boot and then
**never opened** (`docs/deploy/environment-variables.md:200`: *"it holds a key, cannot enrol, and stays inert"*).
Subsumed by the Blocker-B fix **provided** the overlay sets `AOA_WORKER_KEY_STORE_MODE=file_record` +
`AOA_WORKER_STATE_DIR=/worker` on a **durable named volume**.

## 4. DOC BUG — the enrolment file is a TICKET, not a code

`CLI-006-staging-canary-runbook.md:129-131` says to write the returned `aoa_enr_…` code into
`AOA_WORKER_ENROLLMENT_CODE_FILE`. **That is wrong.** `packages/worker-daemon/src/enrollment/ticket.ts:29-51`
requires `aoa_tkt_<base64url(JSON.stringify({v:1, targetId, code}))>` with an exhaustive key check (`["code",
"targetId","v"]` sorted; any extra key rejected). A raw code fails with "missing or wrong prefix". Correct the runbook.

## 5. THE E2B TEMPLATE — a custom template is REQUIRED

A stock `base` will not work, and there is **no install-at-spawn fallback** on the distributed path: the supervisor
performs exactly ONE `execute` (`packages/worker-daemon/src/supervisor/supervisor.ts:508-590`); the monolith's
`SANDBOX_INSTALL_COMMAND` is an adapter-registry behaviour not on this path. The CLI must already be on PATH in the
template. **Good news: the template exists in-tree** — `e2b/e2b.Dockerfile` (node:22 + git/curl/ripgrep/python3 +
`npm i -g @anthropic-ai/claude-code @openai/codex` + Playwright/Chromium, with build-time `command -v` assertions).
Build on the operator's account: `e2b template create aoa-base -d e2b.Dockerfile` from `e2b/`. (CORRECTED 2026-09-01 by Unit 1 — this line originally carried the README's `e2b template build ...`, which THIS SAME DOCUMENT measures four pages later as a gutted no-op stub. A doc that records a defect and then repeats it is worse than one that never mentioned it: the reader who stops at the first occurrence is misled BY the correction's own source.)
Note `AOA_ADAPTER_MANAGER_E2B_TEMPLATE` (AM) is a DIFFERENT variable from `E2B_TEMPLATE` (monolith, defaults `base`).
★ Neither the CLI-006 runbook nor the C0 scope doc mentions "template" — a documentation gap worth closing.

---

## 6. THE VERIFIER — what it does and does NOT prove

`pnpm verify:e7-1-distributed-run <runId>` (`server/src/cli/verify-e7-1-distributed-run.ts`, logic in
`server/src/services/e7-distributed-run-verifier.ts`). Read-only SELECTs; exit 0 PASS / 1 FAIL / 2 usage.
**Five clauses, all must pass:** (1) `execution_owner === "distributed"`; (2) `distributed_job_id` +
`distributed_attempt_id` both non-null; (3) status ∈ {succeeded,failed,cancelled,timed_out} **and** `finished_at`;
(4) no leaked secret across job events / run excerpts / task outputs / artifacts (5 leak classes: `sk-`/`sk-ant-`,
`e2b_<16+>`, literal `E2B_API_KEY=`, connection-string URIs, PEM private keys); (5) journey corroboration — a
matching `job_attempts` row, **≥1 lease**, **≥1 `attempt_started`**, **≥1 `terminal`**, and an `applied`
`job_projection_receipts` row with `projection_kind='attempt_terminal'`.

★ **Two things it does NOT prove — check both by hand:**
- **Real E2B vs the fake provider.** No clause reads provider identity. A `fake-provider` run that produced a lease
  + events + receipt would pass all five. Enforcement is **operator discipline**, not machine-checked.
- **That real work happened.** Clause 3 is terminal-agnostic: `failed` and `timed_out` PASS. `producedArtifacts` is
  reported in `observed` but never fails the run. A sandbox where `claude` isn't on PATH → exit 127 → `failed` →
  **verifier PASS**. Read `produced:` in the output yourself.

**The gate flip is pure prose.** `scripts/gate-clause-wiring.json` → `E7-1-coding-journey`; the checker only asserts
the named symbol's production reference count `!== 0` for `wired` (already 4). Nothing validates the cited run id.
**The honesty of this gate is 100% human.**

## 7. CAMPAIGN-MINIMAL FLEET (for when the blockers are fixed)

A NEW overlay (e.g. `docker-compose.campaign.yml`) is read by **none** of the compose checkers
(`check-staging-manifest.mjs`, `check-d1-compose.mjs`, `check-d1-dispatch-declared.mjs` each hardcode their own
path) — safe to add. **Never edit `docker-compose.staging.yml` in place** (`checkServiceSet` requires the exact
8-service set). **Use `docker compose up --wait`, never swarm** (swarm ignores `depends_on`, breaking the
load-bearing migrate-first gate).

1. **postgres** — `pgvector/pgvector:pg18`; `POSTGRES_{USER,PASSWORD,DB}=aoa`; ★ `PGDATA=/var/lib/postgresql/data`
   (required on pg18 or it exits when a volume is mounted at the legacy path); named volume; `pg_isready` healthcheck.
2. **migrate** — CP image, `entrypoint: [/usr/local/bin/migrate-entrypoint.sh]`, `command: []` (clears the server
   CMD), `DATABASE_URL` = **owner**. Everything else gates on `service_completed_successfully`.
3. **control-plane** — the three DB URLs + `AOA_APP_DB_PASSWORD`/`AOA_OPERATOR_DB_PASSWORD` (see §8),
   `AOA_DISTRIBUTED_EXECUTION_ENABLED=true`, **`AOA_DISTRIBUTED_EXECUTION_ROLLOUT`** (see §9 — the #1 silent kill),
   `AOA_WORKER_SESSION_SIGNING_KEY` (≥32 B), `AOA_CONTROL_PLANE_SIGNING_KEY_FILE`,
   `AOA_ADAPTER_MANAGER_TRUTH_{SHARED_SECRET,ROUTE_ENABLED=1}`. Simplest mode is `authenticated` +
   `AOA_ALLOWED_HOSTNAMES` + throwaway Google/BetterAuth trio (what D1 does).
4. **adapter-manager** — build `docker/adapter-manager/Dockerfile` locally (CI never builds it). `PORT=8090`,
   `_SANDBOX_PROVIDER=e2b`, `_E2B_TEMPLATE`, `_CONTROL_PLANE_PUBLIC_KEY_FILE`, `_TRUTH_SHARED_SECRET`,
   `_CONTROL_PLANE_URL=http://control-plane:3100`, `_REAPER_ENABLED=1`, `E2B_API_KEY` (**only here**), writable
   `/am` volume.
5. **worker** — needs the Blocker-B fix. `command: ["node","dist/bin/networked-host.js"]`,
   `AOA_WORKER_KEY_STORE_MODE=file_record`, `AOA_WORKER_STATE_DIR=/worker` (**named volume** — a lost
   `identity.json` re-mints a workerId the server denies `worker_transfer_denied` PERMANENTLY, with no reset route),
   `AOA_WORKER_PROVIDER_URL=http://adapter-manager:8090`, `AOA_WORKER_DISPATCH_ENABLED=1` (**exactly `"1"`**),
   `AOA_WORKER_EVENT_OUTBOX_PATH`, `AOA_WORKER_CONTROL_PLANE_URL`, `AOA_WORKER_TARGET_SCOPE=organization`.
6. **minio — OPTIONAL.** None of the verifier's five clauses requires an artifact. Dropping it saves ~200 MB on a
   3.7 GB box. If included it must serve **TLS** (artifact grant URLs are https-only).

## 8. DB PROVISIONING — the fail-closed trap

The four DB URLs are **ONE database + four role-scoped logins**. `DATABASE_URL` must be the **owner** (not
`aoa_app` — `assertExactServingRoleAuthority` forbids `aoa_app` USAGE on the `drizzle` schema). With the
distributed flag on, a missing `AOA_APP_DATABASE_URL`/`AOA_OPERATOR_DATABASE_URL` **throws at boot**
(`server/src/config/distributed-execution.ts:46-77`).

Migrations create `aoa_app`/`aoa_operator` **NOLOGIN**. Two in-repo ways to grant LOGIN:
- **(a) D1-only:** `AOA_D1_PROVISION_SERVING_ROLES=1` on `migrate` → `provision-d1-serving-roles.mjs`.
- **(b) RECOMMENDED (works anywhere):** set `AOA_APP_DB_PASSWORD` + `AOA_OPERATOR_DB_PASSWORD` on the
  **control-plane**; `maybeProvisionDistributedExecutionRoles` (`server/src/index.ts:299-318`) runs
  `ALTER ROLE … WITH LOGIN PASSWORD …` on the owner URL immediately before `openDistributedExecutionDatabases`.
  ★ The passwords **must match** the values embedded in the two role URLs — boot provisions then immediately verifies.

## 9. SILENT-KILL REGISTER (no error, no non-zero exit, healthcheck stays green)

1. Worker image has no provider package → `no_provider` forever. **(Blocker B.)**
2. ★ **`AOA_DISTRIBUTED_EXECUTION_ROLLOUT` unset ⇒ every org OFF.** Absent from BOTH compose files. Must be
   `{"organizations":{"<ORG>":{"mode":"canary","workloads":["batch"]}}}`. **`active`/`shadow` are NOT enough** —
   `run-execution-owner.ts` returns `rollout_not_canary`. Live-editable; a malformed edit fails closed to legacy.
3. `AOA_WORKER_DISPATCH_ENABLED` unset → `dispatch_disabled` (and any value other than exactly `"1"` throws).
4. `AOA_WORKER_EVENT_OUTBOX_PATH` unset → `no_event_outbox_path`.
5. `AOA_WORKER_KEY_STORE_MODE=mounted_secret` → never enrols. **(Blocker C.)**
6. A raw `aoa_enr_…` written where an `aoa_tkt_…` ticket is required. **(§4.)**
7. No default `e2b` `runtime_provider_keys` row per Company → preflight `credential_authority_not_moved`. The
   env-default `E2B_API_KEY` does **not** satisfy it. Two POSTs: `/secrets` then `/runtime-provider-keys`.
8. Placement profile never ratified → `placement_not_leasable`.
9. CP/AM keypair **mismatch** → uniform gate error on every create, no startup signal. **Only
   `pnpm verify:cp-am-keypair` against the MOUNTED files catches it.**
10. `AOA_ADAPTER_MANAGER_REAPER_ENABLED` unset — or set to `"true"`, which is **OFF** (strict `"1"`) → orphan E2B
    sandboxes accrue and **bill forever**.
11. `AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED` unset or bearer mismatch → CP 404 → every lease `"unknown"` → the
    reaper reclaims nothing.
12. `AOA_ALLOWED_HOSTNAMES` missing the CP service name (`authenticated` + private) → `/api/health` green but
    `/api/worker-control/*` 403.
13. `AOA_DEPLOYMENT_MODE` / `AOA_STORAGE_PROVIDER` typo → **silent** fallback to `local_trusted` / `local_disk`.
14. Per-agent `heartbeat.maxConcurrentRuns` default is **1** (the tighter constraint; the org cap defaults to 8).
    Plus a documented capacity-slot leak: a declined placement leaves `capacity_claim_state='held'` permanently.
15. Canary wake-type precondition: a mention / `execution_*` / null wake **silently skips** the canary block —
    do NOT trigger the run by @-mentioning the agent in a comment.
16. Fresh org required — a legacy `environment_leases` row can never satisfy the preflight's closure clause
    (`reconcileCompanyLegacyResources` has no route/job wiring).
17. Unsetting `AOA_DISTRIBUTED_EXECUTION_ENABLED` with in-flight distributed runs **strands them forever**.

## 9b. BLOCKER D (found by BUILDING, 2026-08-31) — `docker/control-plane/Dockerfile` does not build at this tip

Discovered on the real host, not by reading: the control-plane image build fails in the `build` stage with

```
packages/sandbox-fake-provider build: src/hash.ts(16,72): error TS2580: Cannot find name 'Buffer'
packages/sandbox-fake-provider build: src/hostile-driver.ts(54,8): Cannot find module '@armyofagents/worker-protocol'
 WARN  Local package.json exists, but node_modules missing, did you mean to install?
ERROR: process "/bin/sh -c pnpm --filter \"@armyofagents/server...\" --filter \"@armyofagents/ui...\" build" … exit code: 2
```

**Not OOM** (swap untouched at 72 KiB). **The mechanism is an install/build asymmetry:**
- the `deps` stage COPYs only **17** workspace `package.json` files, then installs with
  `--filter "@armyofagents/server..." --filter "@armyofagents/ui..."`;
- the `build` stage then runs `COPY . .` (**all 35** manifests) and re-runs the *same* filter, which now resolves
  **25 of 35 projects** — pnpm's `...` selector traverses **devDependencies** too, pulling in packages that were
  never installed (`sandbox-fake-provider` is a **devDep of `sandbox-provider-contract`**; `packages/plugins/sdk`
  likewise) → no `node_modules` → TS2307/TS2580.

★ **`check-image-deps-stages` cannot catch this**: `computeRuntimeClosure` walks `.dependencies` **only**, while the
pnpm build filter walks dev+prod. The guard is green while the image is unbuildable.

**Campaign workaround (adopted):** use the **combined root `./Dockerfile`** instead — it runs
`pnpm install --frozen-lockfile` **unfiltered** (whole workspace ⇒ no asymmetry) and builds with individual
non-`...` filters (`ui`, `plugin-sdk`, `server`), and its `CMD` runs `server/dist/index.js` (i.e. it *is* the control
plane). It is also the image `docker.yml` builds on every `main` push — the best-tested image in the repo. It does
NOT ship `migrate-entrypoint.sh`, but that script is trivially replicable:
`node --input-type=module -e "import('@armyofagents/db/migrate-job').then(m => m.main())"` followed by
`node docker/control-plane/provision-d1-serving-roles.mjs` for the LOGIN grant.

**Proper fix (owed, not done here):** either COPY the full manifest set in the `deps` stage, or drop `...` from the
build filter, or teach `check-image-deps-stages` to walk devDeps so the guard matches pnpm's actual behaviour.

## 9c. PHASE A RESULT (2026-08-31) — postgres + migrate + control-plane are UP on the campaign host

**Deployed and validated on the Hetzner box** (`aoa-qa`, Ubuntu 26.04, 2 vCPU / 3.7 GB). Overlay:
`/opt/campaign/docker-compose.campaign.yml`; image `aoa-monolith:campaign` built from the combined root
`./Dockerfile` at tip `0248153ff`.

**Decisive evidence the distributed path really initialized:**
```
INFO: Verified aoa_app and aoa_operator bounded database pools      <- the 5-phase fail-closed gate PASSED
INFO: event: "job_control.outbox_tick" organizations: 0 claimed: 0  <- the distributed scheduler is running
INFO: pgvector extension detected; semantic search enabled
health: {"status":"ok","deploymentMode":"authenticated","authReady":true,"bootstrapStatus":"bootstrap_pending"}
```
202 tables created, incl. `jobs`, `job_attempts`, `leases`, `heartbeat_runs`, `execution_targets`,
`job_projection_receipts`. Roles verified `rolcanlogin=t, rolsuper=f, rolbypassrls=f` — LOGIN granted **without**
weakening FORCE RLS.

**Route mount probes (from inside the container):**
| Route | Code | Meaning |
|---|---|---|
| `/api/worker-control/poll` | 400 | mounted; rejects an empty body |
| `/api/worker-control/enroll` | 401 | mounted; demands the device proof |
| `/api/adapter-manager-control/lease-truth` | **404** | ★ **the DEP-011 B1 double-gate, verified LIVE** |

★ That 404 is the B1-F1 security fix demonstrated on a real deployment: distributed execution is **on**, yet the
lease-truth route still 404s because `AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED` is unset — "enabling distributed
execution can never BY ITSELF expose the unauthenticated cross-tenant oracle."

**Three build-time lessons (none discoverable by reading):**
1. `docker/control-plane/Dockerfile` is unbuildable at this tip — §9b (BLOCKER D).
2. **V8 heap ceiling**, not machine RAM: the server `tsc` aborts with **exit 134 (SIGABRT)** at V8's ~2 GB default.
   Swap cannot help (only 210 MiB was ever used). Fix = `ENV NODE_OPTIONS="--max-old-space-size=6144"` in the build
   stage. Campaign-local patch (`/opt/campaign/Dockerfile.campaign`); the repo tree is untouched.
3. ★ **The root `./Dockerfile` builds only `ui`, `plugin-sdk`, `server` — never server's workspace dependency
   closure.** Fine on `main`, but this branch's server imports the new packages, and unresolved workspace types
   silently degrade to `any` → `TS7006 Parameter 'op' implicitly has an 'any' type`. Fix = build with
   `--filter "@armyofagents/server..."` (safe HERE because this image installs the whole workspace unfiltered).
   **A latent defect the replatform branch exposes** — worth a repo fix.

**Operational notes for the runbook:**
- The root image ships the WHOLE workspace (`server/dist`, `packages/*/dist`, `docker/`, `node_modules`), so ONE
  image serves control-plane + migrate + **adapter-manager** (`packages/adapter-manager/dist/bin/adapter-manager.js`
  is present). `packages/worker-networked-host/dist` is **absent** (a leaf nothing depends on) — add it to the build
  filter, or run its TS source via the bundled `tsx`.
- ★ **Workspace `exports` point at TypeScript SOURCE in dev, and workspace packages link into each consuming
  package's `node_modules` (not the root).** So `migrate-job` must run **from `/app/server` with the tsx loader** —
  a bare `node -e` from `/app` fails `ERR_MODULE_NOT_FOUND`. This is what the image's own CMD does.
- `internal: true` on the compose network omits the gateway that port-publishing NAT relies on, so a published port
  is NOT reachable from the host. This is *desirable* here (the box has no firewall); use `docker exec` for admin.

## 9d. PHASE B RESULT (2026-08-31) — the adapter-manager is UP; the ENTIRE Slice 4+5 surface verified LIVE

Fleet now healthy on the campaign host: **postgres + migrate + control-plane + adapter-manager**.

**E2B:** the API key validates (HTTP 200) and the CLI accepts it (no separate access token needed). The `aoa-base`
template is **built and `buildStatus: ready`** (`templateID 7vg8mu6gaoz2inw62lv8`, 2 vCPU / 2048 MB). Because
`e2b.Dockerfile`'s final step asserts `command -v claude && claude --version`, a ready build **proves the Claude CLI
is in the sandbox** — the §5 requirement is satisfied.

★ **DOC DEFECT (new): `e2b/README.md`'s build command is a NO-OP STUB in CLI v2.18.0.** The documented
`e2b template build --name aoa-base --dockerfile e2b.Dockerfile` is deprecated *and gutted* — `--help` shows
`Arguments: template  unused` and **no options besides `-h`**. It swallows the flags, prints a deprecation banner,
and **exits without building anything** (an 814-byte log, no error, no template). An operator following the README
would believe the template was built and then hit `env: 'claude': No such file or directory` at execute time.
**Correct command:** `e2b template create aoa-base -d e2b.Dockerfile [--memory-mb 2048 --cpu-count 2]`.

**Every Slice 4+5 pillar verified on a real deployment:**
| Pillar | Live evidence |
|---|---|
| P2 mint keypair | CP boots with the key; `verify:cp-am-keypair` **PASS** on the mounted pair AND **exit 1 + loud** on a deliberately mismatched pair (negative control) |
| P2 [Mint-2] loud-fatal | ★ A `0600 root` key vs `USER node` gave `EACCES`; the CP **refused to boot with the exact cause** instead of silently falling to inert — the silent-dead-path this finding existed to prevent. Fix: `chown 1000:1000`, keep `0600`. |
| P3 bearer (B1-F1 + Img-2) | truth route: **no bearer → 404**, **wrong bearer → 404**, **correct bearer → 200 `{"verdicts":{}}`**; and 404 for everything while the route flag was unset (Phase A) |
| AM fail-closed boot (β2) | boots only with provider=`e2b` + non-empty template + a usable `E2B_API_KEY` + an ed25519 CP **public** key |
| C `/metrics` | `aoa_reaper_sandboxes_total{outcome="reaped"|"skipped"|"unknown"|...} 0` renders |

**Operational notes:**
- Mounted secrets must be readable by the container's runtime uid: `chown 1000:1000` (node) and keep `0600`. A
  root-owned `0600` mount is `EACCES` inside the container.
- The provider-control boundary is preserved in the overlay: `E2B_API_KEY` is in `am.env` (adapter-manager **only**);
  the control plane gets a separate `cp.env` with just the truth bearer.
- The AM runs from the monolith image via `cd /app/packages/adapter-manager && node --import
  /app/server/node_modules/tsx/dist/loader.mjs dist/bin/adapter-manager.js`.

### 9d.1 The two-network requirement (learned the hard way) + the reaper verified against REAL E2B

A single `internal: true` network is **not** enough. With everything on one internal net the adapter-manager could
not resolve E2B at all:
```
reaper: sweep failed (contained; loop continues)
  err: TypeError: fetch failed   [cause]: Error: getaddrinfo EAI_AGAIN api.e2b.app
```
★ **This is exactly why the staging manifest puts the adapter-manager on BOTH `control-net` (internal) and
`provider-ctl-net` (`internal: false`)** — the provider-control boundary means precisely one surface holds the E2B
key AND has the egress to use it. Adding an egress network for the AM alone fixed it:
```
reaper: sweep complete { reaped: 0, skipped: 0, unknown: 0, failed: 0 }
```
⇒ the **full DEP-011 reaper (Slices A + B + C) is verified against the real E2B API**, and the E2B credentials work
end to end.

★★★ **Two operational cautions:**
1. **A green `/healthz` does NOT mean the provider is reachable.** The AM reported `healthy` for 7 minutes while
   every sweep was failing DNS — the healthcheck does not probe E2B. Check the reaper logs/metrics, not health.
2. ★ **The B2C-F1 tick containment paid for itself here.** `reconcileReaper` leaves `provider.list` UNWRAPPED, so
   this DNS throw would have rejected the tick; with no `unhandledRejection` handler the AM — the process serving
   gated create/execute for live workers — would have **crashed on its first sweep**. The log line reads
   `sweep failed (contained; loop continues)` and the AM stayed up. The review finding was real, and the fix works.

~~**Still blocking the campaign:** Blocker A (empty batch workload — no lease can ever be offered) and a
provider-capable worker (Blocker B; `worker-networked-host/dist` is absent from the image).~~
**SUPERSEDED 2026-09-01** — A and B both fixed and MERGED in Unit 1 (`b6e02a478`, PR #331); B was verified in the
real 374MB worker artifact. The blocker that replaced them is **§9e** below, found by probing rather than reading.

## 9e. THE STEP-0 BLOCKER (found by PROBING, 2026-09-01) — the rollout hook never reached the executing instance

A GO/NO-GO probe was run against the live fleet before spending any E2B budget on arming. It returned **NO-GO**,
and the result is the reason Unit 1 alone was not enough.

**The probe.** Task `1ffe57ee-6e24-4f24-9576-d35dd2d84957` created over HTTP, assigned to the seeded
`org`/`claude_local` agent, flag on, dial set to `{"organizations":{"<ORG>":{"mode":"canary","workloads":["batch"],"sources":["task_run"]}}}`,
control-plane restarted healthy with no malformed-dial complaint. Result:

```
wakeup fired  ->  failed issue_assigned
heartbeat_runs = 1,  execution_owner = NULL,  and NO [CLI-006] line at all
```

**The cause (source, not inference).** `heartbeatService(db, options?)` read the hook only from
`options?.distributedRollout`, and exactly ONE construction site supplies it — the scheduler in `index.ts`, itself
behind `config.heartbeatSchedulerEnabled`. The wakeup path constructs a **bare** `heartbeatService(db)`, and
`enqueueWakeup` does not merely queue: it EXECUTES on its own instance
(`dispatchQueuedRunsAfterAgentSignal` → `startQueuedRunsForSingleAgent` → `claimQueuedRun` → `executeRun`). The
executing closure therefore had `distributedRolloutHook === undefined` and `distributedRolloutState` stuck at
`"off"`. Fixed by **Unit 1.5** (PR [#332](https://github.com/MeteoriteLabs/AoA/pull/332)) — a module-level port
mirroring `distributed-cancellation-port.ts`, which documents this exact hazard and names `distributedRollout`
as its example.

### 9e.0 ★ RESULT (2026-09-01) — Step-0 CLEARED, the probe is now GO

Unit 1.5 merged (`42c124258`), fleet rebuilt and recreated on the new image (verified: the *running*
container carries the `rollout resolved` marker). The same probe now emits, for the first time:

```
[CLI-006] rollout resolved
    runId:                 9ee2ec30-dce5-438d-8976-ac023673bade
    issueId:               80fd5d68-e3cb-4374-bed1-b3d49fe50e37
    rolloutHookPresent:    true          <- conjunct 1, the fix
    rolloutState:          "canary"      <- conjunct 2
    rolloutOrganizationId: "0febb760-…"  <- conjunct 4
    hasIssueContext:       true          <- conjunct 6
[heartbeat] Harness pre-checked out issue for scoped wake   <- conjuncts 3, 5, 7
```

**All seven conjuncts hold.** The canary decision block is now reachable — the Step-0 blocker is closed,
and the unconditional line did exactly the job it was added for: the previous NO-GO was silent, this one
names its own state.

**The next blocker is H2, already filed** — the run fails just before the decision block:

```
ProviderUnavailableError: No usable anthropic provider credential for this run (no_assignment)
  at resolveProviderCredential (server/src/services/provider-resolution.ts:450)
```

That is arming STEP 4a (the `provider:anthropic` company secret); the pre-flight already reported
`company secrets: NONE`. Not a new discovery — the expected next precondition.

Two smaller findings from the same run, recorded so they do not cost a cycle later:

- **`heartbeat_runs` has NO `issue_id` column.** The linkage is `context_snapshot ->> 'issueId'`, which is
  how `heartbeat.ts` itself queries it. The first probe script used `issue_id` and silently reported
  nothing for 5 seconds before the loop broke.
- **`Cannot emit a hub item: company has no human owner`** (non-fatal WARN, `hub-items.ts:344`). Harmless
  now, but Assist-mode autonomy raises an Inbox approval — so a company with no human owner may not be able
  to surface one. Worth checking before relying on an approval-gated dispatch.

**Operational trap found the hard way:** the rebuild ran ~20 minutes, reached `exporting to image`, and died
with `no space left on device` while extracting the final layer — leaving the tag pointing at a
partially-unpacked image. `docker builder prune -af` reclaimed 8.76GB (0 active). `redeploy.sh` now carries a
15GB pre-flight guard, and both scripts verify the fix is present in the checkout, in the built image, AND in
the running container — a cached layer would otherwise ship the old code under a fresh tag.

### 9e.2 ★★★ BLOCKER E (2026-09-01) — the canary preflight cannot read its own evidence

> **STATUS (Unit 1.6): E-1 is FIXED; E-2 and E-3 are OPEN and the canary is STILL GATED SHUT.**
> Read §9e.2.2 before acting on anything below it. Two corrections there: three reads were blocked,
> not four, and the post-fix refusal is `credential_authority_not_moved`, not `preflight_error`.

**The CLI-006 canary can never flip to distributed on a correctly-booted flag-on deployment, no matter
what credentials are set.** Found by an adversarial pass that REFUTED a prior agent's confident
prediction, then confirmed empirically with `psql` on the live box.

`server/src/index.ts:1214` binds the preflight store to the **non-owner `aoa_app`** pool:

```ts
preflight: createCanaryPreflight({ store: createDrizzleCanaryPreflightStore(appDb) })
```

`canary-preflight.ts` fires its evidence reads in one `Promise.all`. Measured privileges:

| Table the preflight reads | `aoa_app` | `aoa_operator` |
|---|---|---|
| `companies` | **OK** | DENIED |
| `legacy_resource_reconciliation` | **OK** | **OK** |
| `environment_leases` | DENIED | DENIED |
| `environments` | DENIED | DENIED |
| `runtime_provider_keys` | DENIED | DENIED |
| `company_secret_versions` | DENIED | DENIED |

Three reads reject with PG 42501; the catch converts that to
`reason="preflight_refused"`, `detail="preflight_error: … permission denied for table …"`, and
`run-execution-owner.ts:254-257` returns `owner="legacy"`. Every time.

**★ Why the obvious fixes do not work:**

- **A bare `GRANT` breaks BOOT.** `assertExactServingRoleAuthority`
  (`server/src/db/distributed-execution-databases.ts:190-208`) scans every table in every non-system
  schema and throws on **any** deviation from `appTablePrivileges()`. Privileges outside the manifest
  are drift, and drift is fatal. So there is **no operator-only fix** — this requires code.
- **Swapping to the operator pool does not work either.** `aoa_operator` is *more* restricted — it
  cannot read `companies`. Neither role holds the full set.

**★★ Why this is the worst kind of blocker: the verification lies.** The runbook's Step 4b
verification SQL is run by an operator as owner/superuser and will show **green** while the server
keeps refusing — a check that passes for a reason the server does not share. Nothing catches it in
CI either: `server/src/__tests__/cli-006-canary-preflight-store.test.ts:44` constructs the store with
`{} as never`, and the pure tests inject fakes. **No test exercises the store against a real
restricted role.** That is the [[checks-that-nothing-runs]] failure class, one level down.

**Security dimension (why this is not a one-line grant).** `company_secret_versions.material` holds
AES-256-GCM encrypted provider-key material. Granting the tenant-serving role table-level SELECT on
it widens exposure of exactly what Decision #104 protects and what E2 made `aoa_app` a non-owner to
contain. The fix must be designed, not patched — a design pass with security/correctness/minimal-diff
judging is in flight; candidates are column-level grants or a SECURITY DEFINER projection, pushing the
evidence into `legacy_resource_reconciliation` (which `aoa_app` **can** already read), or a reviewed
manifest widening.

#### 9e.2.1 ★★★ E IS TWO DEFECTS STACKED — and the second is worse

> **Superseded count:** E is **THREE** defects, not two. E-3 (the losing inventory race) is stated in
> §9e.2.2. The analysis in this section stands; only the count was short.

A three-design pass (security / correctness / minimal-diff judging) surfaced a load-bearing fact the
privilege story had hidden. **VERIFIED INDEPENDENTLY:**

```
$ grep -rn 'reconcileCompanyLegacyResources' server/src packages --include=*.ts | grep -v test
server/src/services/canary-preflight.ts:14:   // ... `reconcileCompanyLegacyResources` computes closure ...   <- a COMMENT
server/src/services/legacy-resource-reconciliation.ts:324:export async function reconcileCompanyLegacyResources(
```

**`reconcileCompanyLegacyResources` has ZERO non-test callers.** So:

- **E-1 (privilege)** — the preflight cannot READ 3 of its 4 evidence sources (§9e.2).
- **E-2 (unwired)** — even with perfect privileges, the one table it *can* read
  (`legacy_resource_reconciliation`) is **never populated**, because the MIG-008 reconciler that
  computes closure was built and never wired. The gate is closure-gated on evidence nothing writes.

Fixing only E-1 changes the refusal *message* without opening the gate. Two of three judges said
exactly that of the privilege-only designs: *"Designs 1 and 3 both fix the error message."*

**Design verdict — Design 2 (correct-layering) wins on security AND correctness**, with two amendments
from the correctness judge:

1. **The first slice must be READ-ONLY.** Drop `casClaimPaused` from the pass driver (or make paused
   rows produce a refusal). A paused lease must leave the gate CLOSED rather than silently expiring a
   live warm snapshot. Wire the CAS only after a dry-run pass is observed on the box.
2. **Key the attestation per company**, not per pass — otherwise the crosswalk grows ~1440
   rows/company/day inside the very relation the gate reads in full on every check.

**Rejected, with reasons worth keeping:**

- **Table-level grants are refused by all three designs** — `company_secret_versions.material` is
  `jsonb().notNull()` and a table grant is a real Decision #104 regression.
- **`environment_leases.metadata` is secret-bearing AT REST.** `sanitizeProviderMetadata`
  (`environment-runtime.ts:386-393`) strips only `apiKey|resolvedApiKey`, and only at READ time, in
  memory. So the intuition that "leases are safe to table-grant" is **wrong** — this killed the
  minimal-diff design's grant.
- **A SECURITY DEFINER function is invisible to the drift check** (it scans `pg_class` relkind
  `r/p/v/m/f`, `pg_attribute`, sequences — functions are not scanned), so that mechanism *works*; it
  just does not unblock the canary on its own, because of E-2.

**★ Two test shapes to keep regardless of mechanism:**

- The assertion that would have CAUGHT this entire class:
  `expect(result.reason).not.toBe("preflight_error")` run against a **real `aoa_app` connection** in
  the existing real-role harness (`distributed-execution-db-startup.integration.test.ts:190-205`).
  Today `cli-006-canary-preflight-store.test.ts:44` passes `{} as never`.
- A standing anti-widening pin: `SELECT material FROM company_secret_versions` must still raise 42501
  as `aoa_app`.

**Mechanics worth not rediscovering:** a COLUMN-level grant does NOT trip the table-level drift check
(`has_table_privilege` ignores column ACLs — the in-repo proof is `mcp_api_keys`), but it DOES trip the
COLUMN check, because `appColumnSelect` (`distributed-execution-databases.ts:259-273`) is hard-coded to
exactly two relations. Views and matviews ARE scanned like tables (`relkind IN ('r','p','v','m','f')`).

**Ordering consequence.** Blocker E sits BEFORE the credential work in the dependency order: setting
`provider:anthropic` (H2 / Step 4a) and the E2B pointer (Step 4b) is necessary but **not sufficient**,
and neither can be validated end-to-end until E is fixed.

#### 9e.2.2 ★★★ E-1 FIXED (Units 1.6 + 1.7) — THE CANARY IS STILL GATED SHUT

> **MERGED 2026-09-01 as `c7ead3a73` (PR #333), CI-green** — 16 checks including all four `verify`
> shards, `e2e`, `migrations`, `policy`, `brand-check`. The Decision #122 amendment rides in the same
> commit; PR #334, which carried it separately, was **closed as superseded** after its branch was
> diffed against the merged base and found to be a net regression (it would have reinstated the
> retracted claim that `0266` is the compliant exemplar) plus a stray repo-root `decisions.md`.
>
> **This section was written after Unit 1.6 and is corrected in place for Unit 1.7.** Read the ★
> paragraph below before citing the shape of what shipped: the grantee changed, and the grantee is
> the whole security argument.

**E-1 only. The canary cannot flip, and any claim that this unblocked it is false.**

What shipped: **three** owner-owned, organization-bound `SECURITY DEFINER` functions
(`packages/db/src/migrations/0267_canary_preflight_evidence_org_scope.sql`, which DROPs and supersedes
`0266`'s two) serving the company enumeration, the lease inventory, and the two evidence scalars —
with `EXECUTE` granted to **`aoa_operator` alone**. No table grant, no column grant, no ACL-manifest
edit — the four secret-bearing tables still raise 42501 for `aoa_app`, pinned as a standing
anti-widening test (`canary-preflight-real-role.integration.test.ts`). Because such a
function was **invisible** to `assertExactServingRoleAuthority` (zero `prosecdef` references existed
repo-wide), the same change ships a `prosecdef`-keyed certificate
(`server/src/db/security-definer-manifest.ts`), so the ACL model **narrowed** rather than acquiring an
undocumented hole.

**★★★ THE BINDER IS THE GRANTEE, NOT THE PARAMETER — and Unit 1.6 got that wrong.** `0266` granted
`EXECUTE` to `aoa_app` and scoped each function by a caller-supplied `p_company_id` that the body
compared only to ITSELF. That closes the cross-*argument* oracle and nothing else: passing the
victim's company id satisfies the predicate trivially, so any `aoa_app` session could name a company
it has no relationship to and receive that company's lease ids through OWNER authority — and since
`companies` carries no RLS and `aoa_app` holds `SELECT` on it, the caller did not even have to guess.
**This was REPRODUCED against real PostgreSQL before `0267` was designed**, and is now asserted as an
attack (an earlier probe passed the intruder's *own* id and so never exercised it; two probes had in
fact asserted the attack as REQUIRED behaviour). The organization predicates in `0267` are defence in
depth — `p_organization_id` is caller-supplied too — and the real boundary is the role the caller
connects as, which is the one thing a caller cannot forge.

**★ And the other half, which the first draft omitted: for `aoa_operator` this is a WIDENING.**
`canary_preflight_evidence_companies` is a brand-new capability — `aoa_operator` holds no grant on
`companies` or `organizations` at all. This moves a capability off a broad pool onto a narrow one; it
does not delete it.

**Two consumers moved, and one of them spans two authorities.** The gate reads through
`distributed-execution-databases.ts`'s new `operatorDb`; `job-distributed-drain-store.ts` needs
**both** pools — `listOrganizationCompanyIds` is a definer read on `operatorDb`, while
`listActiveAttempts` is a tenant-scoped `job_attempts` read that must stay `runInTenant(appDb, …)`.
An over-applied rename to a single pool failed three of its embedded-PG tests with 42501.

**★ A pre-merge claim audit caught a live boot regression nine review rounds had not.** Making the
definer certificate unconditional at startup turns a documented `AOA_MIGRATION_PROMPT=never`
deployment into a hard boot failure: that path logs “continuing without applying” and **boots on**,
at which point the manifested functions are legitimately absent. CI never saw it because every CI
database is freshly migrated. The certificate now skips — loudly — when
`migrationSummary === "pending migrations skipped"`, on the reasoning that when migrations are known
pending, “absent” carries no information about **drift**, which is the only thing that arm detects.
The same audit found that Decision #122's grantee condition had **no enforcing mechanism**: the
certificate derives its expected ACL *from* the manifest, so a future entry declaring
`executeGrantees: ["aoa_app"]` would have matched whatever the migration granted and passed —
re-introducing the exact defect `0267` exists to fix. That is now pinned and mutation-checked.

**The observed outcome, measured not predicted.** On a real `aoa_app` connection against a migrated
database, the gate now answers:

```
{"ok":false,"reason":"credential_authority_not_moved",
 "companyId":"…","detail":"Company … has no current provider-control key generation"}
```

That is a **policy** refusal. Before the fix the same call answered `preflight_error` with
`permission denied for table environment_leases / environments / runtime_provider_keys` in the detail
— an "I could not read" that is unfalsifiable and indistinguishable from a policy decision. **The only
thing this unit delivers is that the refusal is now honest.**

Note the reason is `credential_authority_not_moved`, **not** `reconciliation_incomplete`:
`canary-preflight.ts:150-156` checks the key generation **before** closure is ever evaluated, and
`deriveE2bKeyGeneration` returns `null` for any company without a default BYO e2b key (its own
docstring calls that "the operator env default — ungenerationed"). `reconciliation_incomplete` becomes
reachable only once a company has a BYO e2b key provisioned. Both are policy refusals.

**Correction to §9e.2 above:** three reads are blocked, not four.
`legacy_resource_reconciliation` **is** granted SELECT to `aoa_app`
(`job-control-legacy-grants.ts:316-318`), so `listRecords` was never blocked. The blocked reads are
`environment_leases`, `environments`, and the `runtime_provider_keys` → `company_secret_versions`
pointer chain.

**Still open — E-2 and E-3.** §9e.2.1 named E as two defects. It is **three**.

- **E-2 (unwired)** — `reconcileCompanyLegacyResources` (`legacy-resource-reconciliation.ts:324`) has
  **ZERO non-test callers**. Nothing in a running server writes `legacy_resource_reconciliation`, so
  `listRecords` returns `[]` forever.
- **E-3 (losing race)** — `environments.ts:142` inserts an `environment_leases` row on **every** legacy
  cloud run, while `legacy-resource-reconciliation.ts:344-350` `continue`s past a lost-CAS paused lease
  *without recording it*. The pass's inventory is a strict subset of the gate's re-derived inventory
  **by construction**, so closure is a permanently-losing race on any box with traffic.

**The E-2/E-3 design question, stated so it is not answered by reflex.**

> `legacy-resource-reconciliation.ts:344-350` `continue`s past a lost-CAS paused lease *without
> recording it*, while `environments.ts:142` inserts a lease on **every** legacy cloud run. The pass's
> inventory is a strict subset of the gate's re-derived inventory **by construction**. Re-deriving live
> inventory against a batch-written crosswalk is a permanently-losing race on any box with traffic.
>
> **The question is not "who calls the reconciler" — it is what closure should mean.** Candidates:
> (a) freeze inventory at a watermark and assert closure only below it; (b) have the gate verify an
> *attestation* the pass emits rather than re-deriving inventory itself; (c) scope closure to leases
> predating the canary decision. Each changes what the gate promises. Pick deliberately.

Wiring a caller for `reconcileCompanyLegacyResources` without answering that question produces a gate
that closes and re-opens with traffic. The §9e.2.1 amendments still hold: the first slice must be
READ-ONLY (a paused lease leaves the gate CLOSED rather than silently expiring a live warm snapshot),
and the attestation must be keyed per company, not per pass.

### 9e.1 ★ THE SEVEN-CONJUNCT PRE-FLIGHT — check ALL of these before the next dispatch

`heartbeat.ts` guards the `[CLI-006]` decision block with **seven** conjuncts. A missing `[CLI-006]` line is
consistent with **any** of them being false, so its silence never isolates a cause on its own — the probe gives
the symptom, the source gives the cause. Verify each BEFORE burning another deploy+dispatch cycle:

| # | Conjunct | How to pre-verify |
|---|---|---|
| 1 | `distributedRolloutHook` | Unit 1.5 (#332). Nothing to check once merged + redeployed. |
| 2 | `distributedRolloutState === "canary"` | Produced by the hook. Needs the dial AND conjunct 4. |
| 3 | `shouldAutoCheckoutForWake` | **Satisfied by `issue_assigned`** — the predicate excludes only `issue_comment_mentioned` and `execution_*` wakes, and requires a non-null wake reason. Do NOT probe with a mention wake. |
| 4 | `distributedRolloutOrganizationId` | `resolveCompanyOrganizationId` (`services/org-concurrency.ts`) reads **`companies.organization_id`**. Pre-flight SQL: `SELECT organization_id FROM companies WHERE id='<COMPANY>'` must equal the dialed `<ORG>`. A NULL here kills the canary silently. |
| 5 | `issueId` | Folded into conjunct 3. |
| 6 | `issueContext` | Folded into conjunct 3. |
| 7 | `issueContext.assigneeAgentId === agent.id` | Folded into conjunct 3 — the task must be **assigned** to the probing agent, not merely mentioned. |

Conjuncts 3/5/6/7 collapse into one (3 requires the other three). Conjuncts 2 and 4 are both **produced by** the
hook, so a missing hook forces three of the seven false at once — which is why a missing hook was sufficient to
explain the observed silence, and why 1.5 is the fix. Conjunct 4 is the one Unit 1.5 does **not** fix and the one
most likely to bite next: it depends on seeded data, not code.

## 10. Corrections to existing docs

- `docs/replatform/qa/2026-08-28-c0-staging-deploy-scope.md` §1/§4: *"adapter-manager is a manifest fiction, ZERO
  implementation"* and *"has no Dockerfile"* are **STALE** — DEP-012 Slice 4+5 merged (`07ed2cc42`); the AM package,
  bin, and `docker/adapter-manager/Dockerfile` all exist. Its Tier-0 framing is otherwise still correct in spirit:
  the blocker remains unbuilt code, just *different* unbuilt code (§1–§2 above).
- `CLI-006-staging-canary-runbook.md:129-131`: the enrolment ticket format (§4).
- The CLI-006 runbook + the C0 scope doc: neither mentions the required custom E2B template (§5).

## 11. Recommended order

1. **Fix Blocker A** (the batch workload) — file it as a real finding with an owner first; it has been carried
   verbal-only since BRW-001.
2. **Fix Blocker B** (the worker image + the `check-image-deps-stages` lockstep edit).
3. Build the `aoa-base` E2B template on the operator's account.
4. Build the AM + worker + CP images on the host; generate the keypair; **`pnpm verify:cp-am-keypair` on the mounted
   files**.
5. Bring up the campaign-minimal overlay; provision DB roles; enrol ONE worker (ticket format!).
6. Arm (fresh org, per-Company `e2b` key, rollout `canary`, ratified placement, agent `maxConcurrentRuns` ≥ 2).
7. Dispatch ONE task → `verify:e7-1-distributed-run` → **and read `produced:` + confirm the provider was real E2B**
   before citing the run in the gate flip.
