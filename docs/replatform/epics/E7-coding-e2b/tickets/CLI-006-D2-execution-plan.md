# CLI-006 / D2 — Sprint 5 execution plan: run the real-E2B coding journey

**Status:** `execution-plan` (Sprint 5, Step 1). This sprint **RUNS CLI-006's D2 lane** — it does
not re-invent CLI-006, whose code is landed and D1-green (`CLI-006-result.md`, `fb963d71c`).
**Epic:** E7 (exit gate). **Maps to the existing `CLI-006` graph node** — no new ticket node.
**Pre-sprint tip:** `cdfa6ef92`. **Start SHA:** the commit that lands this file.
**Frozen, untouched:** `packages/worker-protocol`, the worker-daemon `SandboxProvider` port,
`docs/architecture/distributed-execution-threat-*`. No new hosted-API call (Rule #11).

> **Read this first — the one-sentence honest state.** The keyed real-E2B lane
> (`keyed-e2b-conformance.yml`) proves the **provider/adapter primitives** on real E2B; the **full
> distributed coding journey** (create→schedule→lease→…→audit through the control plane) is proven
> only on the **D1 lane against the fixture-driven FAKE provider**. **No single dispatched run today
> ties the distributed journey to real E2B.** Therefore **E7-1 stays `unwired`**, and the sprint's
> honest end-state is "harness extended, distributed journey on real E2B still unproven."

---

## 1. The boundary — what THIS SESSION does vs what only the OPERATOR can do

Stated up front and held to (go-book §4 Sprint 5, keyed-lane header):

**The session may:** build/repair each hop's wiring; run everything that runs **without** a live E2B
key (unit, embedded-PG, contract, `node --check` on keyed cases); prepare the dispatch (the sentinel
bump + the exact `gh workflow run` command); and, **once a dispatched run exists**, read its
logs/artifacts as evidence.

**Only the operator may:** supply `E2B_API_KEY` (a provider secret — never handed to the session)
and **trigger** the dispatched run. If the key/run is not available in-session, the session **STOPS
at the dispatch boundary**, hands over the exact command + what to capture, and says plainly: *the
real-E2B leg is unproven until a dispatched run is cited.* The session never fabricates, assumes, or
mock-substitutes a real-E2B pass.

---

## 2. The journey, hop by hop — evidence and where it actually reaches

The milestone journey is **create → schedule → lease → stage → execute → stream → produce → review
→ cancel → audit**, for one org's coding task, on **real E2B**. Below, each hop names its evidence
and whether that evidence chain **reaches real E2B** or stops at a mock.

| # | Hop | Wiring (landed) | Evidence today | Reaches real E2B? |
|---|---|---|---|---|
| 1 | **create** (task→job convert) | CLI-006 `resolveRunExecutionOwner` → convert seam | PR `verify` (owner-decision matrix) + D1 `fake-provider-job.test.mjs` | **No** — PR mock / D1 **fake** provider |
| 2 | **schedule** (placement + secret-handle mint) | `placeJobAttemptTransaction` (live canary caller, CLI-006) mints the handle at `:363-379` on `selected/active/lease-eligible` | PR placement tests + D1 | **No** — D1 **fake** |
| 3 | **lease** (worker leases the canary attempt) | `offerLease`; envelope carries `secretHandles: toSecretHandleRefs(storedHandles)` (`job-leasing.ts:601-613`) | D1 (real worker, **fake** provider) | **No** — D1 **fake** |
| 4 | **stage** (materialise workspace/files in sandbox) | CLI-002 staging; worker `CreateSandboxSpec` | keyed CLI-002 (`writeFiles`/`readFile` on **real E2B**); distributed staging on D1-fake | **Provider leg only** (keyed) |
| 5 | **execute** (run the coding CLI, with the redeemed credential) | DAT-008/5 worker redemption → `CreateSandboxSpec.env` **exists**, but the **canary mints no handle** (E7-F001: the canary binding's null `credentialKind` trips the mint's owner-authority gate → `owner_authority_disagreement`), so the canary sandbox gets **no credential** | keyed CLI-001/003 run a **real command** (`true`/`sh`) — **NOT a coding CLI**; distributed execute on D1-fake | **Provider leg only; the canary credential hop is INERT (E7-F001)** |
| 6 | **stream** (stdout/stderr → durable sink → projector) | CLI-003 producers → JOB-005 ingest → MIG-003 realtime | keyed CLI-003 streams **real** stdout/stderr; distributed stream via control plane on D1-fake | **Provider leg only** (keyed) |
| 7 | **produce** (patch / artifact commit) | worker artifact commit; server `patch-apply.ts`/`artifact-commit.ts` (base→result hash, **never auto-apply on base mismatch**) | server integration tests (no real E2B) + D1; keyed real-E2B **artifact-commit case built §4** (`88c6a8b66`) | **Provider leg only** (keyed, once dispatched) — the server apply guard + distributed remain not-real-E2B |
| 8 | **review** (projector surfaces review state) | CLI-006 `canary-run-projector` from JOB-005 after-commit ingest | PR + D1 | **No** — D1 **fake** |
| 9 | **cancel** (fence-revoking → terminal ≤30s) | CLI-006 cancel routing across five writers → `requestCancellation` | keyed CLI-003 `terminate` on **real E2B**; distributed cancel on D1-fake; **D2-04 latency = campaign** | **Provider leg only** (keyed) |
| 10 | **audit** (tenant-scoped, redacted inspection) | JOB-008 surface; canary redaction canaries (Sprint 4/DAT-008/5, both streams) | PR (JOB-008 assertions) + keyed inspect **redacted/zero-leak** on real E2B | **Provider leg only** (keyed) |

**Completeness-critic verdict (the question the go-book forces):** *which hop is proven only by a
mock, and does the evidence chain reach real E2B?* — **Hops 1, 2, 3, 8 (create/schedule/lease/review)
are proven ONLY by the fake provider (a mock).** Hops 4, 5, 6, 7, 9, 10 reach real E2B **only at the
provider/adapter layer** via the keyed lane (hop 7's provider leg is the artifact-commit case §4 adds,
which reaches real E2B only once dispatched), never through the distributed control plane. The keyed
lane cannot stand up a control plane, worker daemon, or tenant DB, so it can never prove hops 1/2/3/8;
the D1 lane runs those but on the **fake** provider, which the go-book explicitly rules out as
evidence.

> **★ A sharper bound on hop 5, found this sprint — E7-F001 (HIGH, filed).** Even a dispatched
> real-E2B canary run could not exercise "execute a credentialed coding task", because **the canary
> mints no execution-secret handle at all.** The canary credential binding returns `credentialKind:
> null` by design (`canary-credential-binding.ts:59-64`), which trips DAT-008's mint owner-authority
> gate (`execution-secret-handle-mint.ts:122-127,149-151`) → `owner_authority_disagreement` → no
> handle → `secretHandles: []` in the canary envelope → the worker redeems nothing → no credential in
> the sandbox. This is the same bound `CLI-006-result.md` deferral 2 records, with a **corrected
> mechanism** (that deferral's "no production writer / `secretHandles: []` hardcoded" is stale —
> DAT-008 now writes and advertises handles for non-canary agent runs; the canary specifically
> refuses at the owner-authority gate). It fails closed and blocks nothing shipped, but it is a real
> blocker to E7-1's credential hop and is owned by no ticket (`epics/E7-coding-e2b/findings.md`
> E7-F001, `unowned`).

---

## 3. The single dispatched run that would tie the journey together — and why it does not exist

A run that proves the **full distributed journey on real E2B** must drive the distributed control
plane (control plane + real worker + tenant DB) against a **real** E2B sandbox, dispatched with an
operator `E2B_API_KEY`. **No CI lane does that today.** What exists, and where each stops:

- **`keyed-e2b-conformance.yml`** → `keyed-real-e2b.test.ts` — in-process **provider-driver**
  conformance on real E2B (CLI-001/002/003/004 primitives; the §4 artifact-commit case joins them).
  Dispatched once (run `32210852793`, 2026-08-19; `CLI-realE2B-hardening-result.md`). Never touches
  the distributed path. (A second keyed lane, `keyed-e2b-cdp-probe.yml`, is a BRW-002 CDP port probe
  — also provider-primitive, not the journey.)
- **`d1-merge-train.yml`** → `docker-compose.d1.yml` — the **full distributed journey**, but against
  the fixture **fake** provider (`AOA_WORKER_PROVIDER_URL: http://fake-provider:8080`,
  `fake-provider-job.test.mjs`). It does not even use the `AOA_WORKER_SANDBOX_PROVIDER=e2b` seam.
- **`docker-compose.staging.yml`** (DEP-006) — **already encodes a real-E2B distributed topology**:
  two control planes + four workers + a brokered `adapter-manager` that holds the provider-control
  `E2B_API_KEY` (`:23-26`, `:322`), with the key **absent** from every control-plane/worker surface
  (the production end-state). But it is a **DORMANT deployment-intent template** — never brought up by
  any CI lane; only its static contract + `docker compose config` render are checked
  (`check-staging-manifest.mjs`, `tests/d1/e6f-12-staging-render.test.mjs`). Dormant ⇒ **not
  evidence**, but **not greenfield** either.
- **`deploy-testing.yml`** → `testing.armyofagents.org` (cloud_auth) deploys real code with a real
  `E2B_API_KEY` (`:116`) and a template "pre-loaded with the claude/codex CLIs" (`:34`). A
  deploy+healthcheck, **not** a journey assertion — but it is the **live substrate a canary campaign
  would run on**.

**So the owed work is not a greenfield lane — it is activating substrate that already exists, and
the E7 exit gate names which one:** *"one internal/staging canary Organization completes the full
coding journey and the real-E2B D2 lane passes cancellation, artifact, and cleanup cases"*
(`E7/README.md:6`). The full-journey proof is therefore a **staging/testing-instance canary
campaign** — set one Organization `mode:"canary"` on the real-E2B distributed substrate (the staging
topology, or the deployed testing instance), run the coding journey, and capture the D2 evidence —
**not** a bespoke D1-with-real-provider CI lane. Two legitimate real-E2B distributed shapes exist and
should not be conflated: the **DAT-008 worker-side-provider** shape (the redeemed handle synthesised
into `CreateSandboxSpec.env` — what the shipped canary code does, a valid *rehearsal* form) versus the
**brokered `adapter-manager`** boundary the staging manifest encodes (the production end-state where
the key never reaches a worker). Either way the run needs the operator's key and **cannot be validated
in-session**; per the go-book discipline — *no vacuous green, a fake provider is not evidence* — the
session does not stand one up speculatively. It is named as the owed work (§5) and the honest blocker
on E7-1 (§7).

---

## 4. What the session builds this sprint — the one buildable, session-verifiable hop

**Hop 7 (produce/artifact-commit) is the D2 class the keyed lane is missing and the E7 exit gate
names as required** ("the real-E2B D2 lane passes cancellation, artifact, and cleanup cases",
`E7/README.md`). D2-02's six classes are success, cancellation, timeout, lost-ACK, **artifact
commit**, and leaked-resource reconciliation; `keyed-real-e2b.test.ts` covers five — **artifact
commit is absent.**

**Build (fail-first, established keyed-case pattern):** add a keyed real-E2B case to
`keyed-real-e2b.test.ts` that, in a real E2B sandbox, stages a base file, runs a real edit (POSIX
coreutils — `sed`/`sha256sum`; **no git**) that produces a genuine patch and a unified diff (`diff
-u`, self-guarded on `command -v diff`), reads it back, and asserts **patch integrity**: the produced
patch is deterministic and reproduces its declared result digest, and a foreign base is
hash-distinguishable from the declared base (the precondition the server's never-auto-apply guard
relies on). Plus a **no-key pure-logic regression** (`evaluatePatchIntegrity` in `patch-integrity.ts`,
pinned by `patch-integrity.test.ts` with negative controls), so the integrity logic is mutation-proven
without the key (the `real-transport-helpers.test.ts` precedent). Coreutils-only ⇒ the bare `base`
template suffices.

**Scope honesty — what this case does and does NOT prove:**
- It proves **real E2B can run a coding-shaped command and produce a real, deterministic patch
  artifact** — the provider/adapter leg of hop 7, and it completes the keyed lane's sixth D2-02 class.
- It does **NOT** exercise the server-side apply guard `patch-apply.ts` (base-mismatch →
  `conflict_quarantined`, never auto-apply) — that needs the tenant DB + fence + storage and is
  covered by `patch-apply.integration.test.ts` on the distributed (non-real-E2B) substrate. Named, not
  hidden.
- Without a key it **SKIPs** (`describeKeyed`); a local skip is **not** evidence. Its real-E2B value
  is realised only when the operator dispatches the lane (§6).

**Constraints honoured:** no static `e2b` import and no `E2B_API_KEY` literal (dynamic
`import("../real-transport.js")` inside the case — `check-sandbox-e2b-provider-boundary.mjs` stays
green); the case lives in the existing `*.test.ts` (no new `*.test.mjs` → no census change); no new
`AOA_*` switch; no production reference to `E2bSandboxProvider` (E7-1's caller count is untouched).

---

## 5. What the session does NOT build — named, owed work

1. **The staging/testing-instance canary campaign that proves the full distributed journey** (§3).
   The one thing that could promote E7-1. The substrate already exists but is dormant/deploy-only —
   `docker-compose.staging.yml` (a real-E2B distributed topology, render-checked only) and the
   `testing.armyofagents.org` cloud_auth instance (`deploy-testing.yml`, real key + CLI-loaded
   template). Activating it and running one canary Organization's journey is an **operator campaign
   with real spend**, unverifiable in-session. Owner: a Sprint 5-continuation ticket that wires the
   journey assertion onto that substrate + the operator campaign. (If a hermetic CI form is wanted
   instead, it is a D1-topology-with-real-provider lane — the same key/cost/dispatch constraints
   apply; it is an alternative to, not a prerequisite for, the staging-canary the exit gate names.)
2. **The D2 volume campaign** (test-gates.md §113-122): ≥120 real-E2B jobs, ≥20 each across six
   classes, **three consecutive** passing runs, p95 cancel ≤30s, cleanup p95 ≤2min. An operator
   campaign with real spend — never dischargeable by unit evidence (CLI-006 deferral 1).
3. A **real coding CLI** (e.g. `claude`/`codex`) inside the sandbox for hop 5. The keyed case uses a
   deterministic coreutils edit rather than a network-dependent agent CLI, to keep it hermetic and
   cost-bounded; a real-agent variant runs on the staging/testing substrate (its templates are
   CLI-loaded, `deploy-testing.yml:34`) as part of the volume campaign.

---

## 6. The dispatch — prepared, then STOP at the boundary

The real-E2B leg is triggered by the operator. **`workflow_dispatch` is NOT available on this
branch** — `keyed-e2b-conformance.yml` lives only on `docs/replatform-program`, not on the default
branch (`main`), and GitHub exposes `workflow_dispatch` only from the default branch (verified:
`git ls-tree origin/main` has no keyed workflow). So `gh workflow run` will not fire it here. **The
sentinel-file push is the only trigger:**

- Append a line to **`.github/keyed-e2b-trigger`** and push to `docs/replatform-program`. The
  workflow's `push` `paths:` filter fires the lane. A push run carries no `inputs`, so
  `E2B_TEMPLATE` resolves to `""` → the bare **`base`** template; `secrets.E2B_API_KEY` is a repo
  secret available on any branch.

**What the operator must have in place:** `E2B_API_KEY` in repo secrets (a provider secret — the
session never handles it). No special template is needed: the artifact-commit case relies only on
coreutils (`printf`/`sed`/`sha256sum`/`cut`), with the unified-diff assertion self-guarded on
`command -v diff`, so the bare `base` image suffices (it needs **no** `git`).

**What to capture from the dispatched run:** the run id/URL; the keyed suite result (pass/skip counts;
the artifact-commit case must PASS, not skip); and confirmation the redaction assertions
(`tenant-probe-fails`, zero-leak projection) held — no `E2B_API_KEY` or redeemed value in any log.

**Until a dispatched run is cited, the real-E2B leg is UNPROVEN.** The session stops here.

---

## 7. E7-1 disposition — the vacuous-green line the sprint must hold

`E7-1-coding-journey` (`gate-clause-wiring.json`, symbol `E2bSandboxProvider`, `expectedReferences:
2`) **stays `unwired`.** It is promoted to `wired` **only** on a **cited dispatched real-E2B run that
completed the DISTRIBUTED journey** — never on:
- a composed loop or the D1 **fake** provider,
- the keyed **provider-primitive** lane (it never runs schedule/lease/review),
- the keyed **artifact-commit** case built in §4 (it proves hop 7's provider leg, not the journey),
- a skipped/green-by-skip lane.

Because the joined lane in §3 does not exist, **no dispatched run can currently promote E7-1**, and
the sprint records that honestly. This is the programme's central vacuous-green trap; the sprint's job
is to NOT spring it.

---

## 8. Registers + CI honesty

- **Sprint 4 green preserved.** The five registers are green on `cdfa6ef92`
  (`gate-clause-wiring`, `finding-ownership`, `ticket-graph-coverage`, `guard-inventory`,
  `execution-census`), with E7-1 confirmed dormant. Nothing here promotes a clause or changes a
  finding's ownership.
- **`verify` inherits the §2.0 red** (the pre-Sprint-0 CI timeout regression). Not raised, not
  masked. Every other required job stays green-capable.
- **Adversarial review before done:** independent reviewers per changed dimension; a skeptic to
  refute each HIGH (refuted-by-default if not reproducible from source); and a completeness critic
  asked exactly "what hop is proven only by a mock, and does the evidence chain reach real E2B?"

## 9. Definition of done for THIS session

1. This plan committed (Start SHA). ✅ on commit.
2. The keyed artifact-commit case built fail-first (§4), no-key suite green, boundary checker green,
   `node --check` clean on the keyed case.
3. The dispatch prepared (§6); session STOPS at the boundary.
4. `CLI-006-D2-result.md` written: hops proven on real E2B (with the dispatched run id, if any),
   hops proven only locally/on-fake, E7-1 left unwired with the reason, and the exact operator step
   still owed.
5. GO-BOOK §3.1 + §4 Sprint 5 updated to the true state ("harness extended; full distributed journey
   on real E2B pending an operator-dispatched D1-with-real-provider run").
6. Registers green; commit, push, CI reported honestly (verify inherits §2.0 red).
