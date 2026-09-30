# HANDOFF — Next Wave: "Make the proven engine USEFUL"

**Written 2026-09-18, measured at HEAD `9ec70ba9a` (on `docs/replatform-program`).**
Grounded in a 5-agent truth-code audit of every epic (each claim verified against code, not the
records — the records LAG the code badly; §7 lists the stale claims). Supersedes the GO-BOOK's
§1.9 status (dated 2026-09-03, pre-E7-1). A fresh session can pick up any track below with no prior
context beyond this file.

---

## 0. THE ONE-LINE STATE

**E7-1 is PROVEN (2026-09-18): a real distributed E2B coding run runs end-to-end** (verifier
`ok=true`, `capabilityProven=false` by design). But the engine is **built and INERT**:

- it runs only **org/heartbeat** agents — not crew, not service;
- the agent inside the sandbox **cannot use `mcp__aoa__*` tools** (CLI-008 Unit C is unbuilt);
- **no sink can be ARMED** to bill usage or return output (CLI-008 Unit F is measure-first-FROZEN).

So the wave's theme: **make the proven engine useful** — extend it to more agent types, unblock
tools, and close the operational gaps. Everything below ships **inert-until-armed** where arming
depends on Unit F (which stays frozen); nothing here relitigates the Unit-F freeze.

---

## 1. HOW TO RUN A TRACK (read once — the mechanics this repo actually needs)

- **Parallelism is FREE; only MERGES serialize.** Each track runs on its own `claude/*` branch with
  its own PR. Feature-branch PRs do NOT contend (GO-BOOK §1.9.1, re-verified). The orchestrator
  serializes **merges into `docs/replatform-program` ~20 min apart**, and after each merge confirms a
  CI run exists for that sha (a pushed sha cannot be assumed to have a verdict — the per-PR
  concurrency group drops the older *pending* run).
- **No local `node_modules`** (deep-OneDrive `ENAMETOOLONG`). So **TDD-via-CI**: push the RED test,
  watch `verify` go red for the RIGHT reason, then push GREEN. Watch with
  `gh run watch <id> --exit-status` (background it). `verify` is 4-way sharded; integration tests run
  on the required Linux `verify` (embedded-PG). Windows CI skips them.
- **Pure-node guards run LOCALLY** (no `node_modules`) — a fast pre-push loop:
  `node scripts/check-register-citation-integrity.mjs`, `check-test-inventory.mjs`,
  `check-finding-ownership.mjs`, `check-distributed-execution-foundation.mjs`,
  `check-gate-clause-wiring.mjs`. Run them before pushing to avoid a wasted `policy` cycle.
- **LF discipline** (Windows). `git config core.autocrlf false`; strip CR with `tr -d '\r'` before
  committing an edited file; **`git ls-files --eol` is authoritative** (`git show | grep $'\r'` lies
  via display-smudge). Tell-tale of a CRLF smudge: a diffstat showing the WHOLE file changed.
- **Citation rot.** Adding code to a register-cited file (`job-leasing.ts`, `job-control-ack.ts`, …)
  shifts lines the threat register cites by symbol → `check-register-citation-integrity.mjs` reds in
  `policy`. Fix by re-pointing each citation to its anchor's CURRENT line (grep the symbol); census
  is unchanged by re-pointing. Run the guard locally to find them all in one sweep.
- **Frozen contracts** (do not fight; navigate): `job-leasing-contract.test.ts` (the ack/poll
  gate-flow shapes — e.g. a helper called exactly once, single comma-throw rejects, inline status
  predicate not `ACTIVE_WORKER_STATUSES.has`), and the `worker-protocol-contract-bytes` freeze on
  `packages/worker-protocol`.
- **Merge policy WHILE Codex is quota-walled account-wide:** founder-authorized to merge on
  **CI-green + rigorous self-review** (Codex's `@codex review` bot auto-refuses on usage limit). Keep
  self-review adversarial: mirror-check any classifier against its gate, confirm production
  reachability (grep for a real route/caller — zero-caller code is DORMANT, the trap this program
  keeps hitting), and re-measure the record at HEAD before asserting.
- **Per-ticket process:** RED-first test → GREEN → run local guards → push → watch CI →
  self-review the FINAL diff → merge. Every ticket writes/updates its `-result.md` and, where it
  delivers a register clause, the DE-crossing delivery-evidence (cite by symbol; no cohort/count
  change unless the ruling says so).

---

## 2. THE TRACK MAP (what runs in parallel, what is serial)

```
NOW — all parallel (independent files/areas, no merge conflicts), merges serialized ~20 min apart:

  Track 1  MIG-006 crew seam ................. BUILD   (ships inert behind off-by-default flag)
  Track 2  Unit C tool-surface design paper .. DESIGN  → founder ruling
  Track 3  Ops hardening (2 units) ........... BUILD
            3a kill-switch WRITE path
            3b DR restore entrypoint
  Track 4  Founder-facing prep (2 units) ..... PREP    → founder ruling / dispatch
            4a E9-F002 240s decision paper
            4b §9.2 Unit-F measurement probe

SERIAL chains (each waits on a founder decision or the Unit-F freeze):

  Track 2 (design) ──▶ [founder rules Unit C topology] ──▶ Unit C BUILD (L–XL, future wave)
  Track 4a (paper) ──▶ [founder rules E9-F002 window] ──▶ E9 service activation + staging run
  Track 1 (crew seam, inert) ──▶ [Unit F unfreezes] ─────▶ ARM crew billing + output loopback
  Track 4b (probe, needs founder's E2B key to run) ─────▶ bounds the Unit-F option space
```

**Rule of thumb:** anything that *arms* a sink (billing, output-return, `capabilityProven`) is
downstream of **Unit F** and must not be built now. Everything in §2's "NOW" block is upstream of
that and ships safely.

---

## 3. PER-TRACK DETAIL

### Track 1 — MIG-006 crew seam (BUILD, start first) — size S/M
**Goal:** extend distributed execution from heartbeat/org agents to **crew agents** (`kind='aoa'`) on
the proven E7-1 substrate. **Two audits independently named this the cleanest next unit.**

**Truth:** the gate, flag, and generic workload builder all landed (#476/#477/#478) but have **ZERO
production callers** — the seam that calls them is not at HEAD:
- gate: `resolveCrewDistributedGate` (`server/src/services/internal-agent/aoa-agents/crew-distributed-gate.ts:54`)
- flag: `readDistributedCrewRolloutFlag` (`server/src/config/distributed-execution.ts`, `AOA_DISTRIBUTED_CREW_ROLLOUT_ENABLED`, default false)
- generic builder: `buildTaskRunBatchWorkload(agent.adapterType)` — already source-agnostic (per #478)
- runner today: `runAoaAgent` only does `recordDistributedShadow` + `adapter.execute` (`runner.ts:843,1165`)

**Entry unit / slices (serial within the track):**
1. In `runAoaAgent`, call `resolveCrewDistributedGate(...)`. On `attempt:true`: build the batch
   workload via `buildTaskRunBatchWorkload(agent.adapterType)`, hand off to the convert/placement/
   substrate path (reuse the ownership resolver — `run-execution-owner.ts` is already source-agnostic),
   and **suppress the legacy `adapter.execute`** (the crew analogue of heartbeat's
   `CLI-006-SUPPRESSION-RETURN`). RED-first: a test proving a crew dispatch with the flag ON takes the
   distributed path and does NOT run the local adapter.
2. Terminal projection: reuse the CLI-006 canary projector (`onAttemptTerminal` →
   `canary-terminal-projection.ts`) so a distributed crew run terminal-projects onto the task exactly
   as a heartbeat run does.
3. Result-doc + gate-clause + register delivery-evidence.

**★ HONEST DORMANCY CAVEAT (bake into the PR body):** a distributed crew run is **mechanism-only** —
tool-less until Unit C, **unbilled** (E3-F037), and its **output/artifacts do not return** (Unit F).
Ship it INERT behind the off-by-default crew flag; **do NOT arm it** until Unit F. Low dormant-risk:
the gate is real (crew flag + canary state) and dispatches+executes real work; only the loopback is
deferred. Positive-control the flag-off path (a crew run with the flag OFF still runs `adapter.execute`).

**Done:** flag-on crew dispatch runs distributed + terminal-projects; flag-off unchanged; CI green.

---

### Track 2 — Unit C tool-surface topology (DESIGN → founder ruling) — the strategic unlock
**Goal:** settle HOW a sandboxed agent reaches `mcp__aoa__*` tools, so agents can actually DO work
(vs run a tool-less mechanism). This is the highest-leverage item in the program.

**The blocker is a DESIGN question, not code:** the sandbox egress classifies the control plane as a
**deny class** (`server/src/services/.../egress-policy.ts:118` → `control_plane`; the allowlist is
"enforced by nothing", E8-F003), so the brokered-MCP endpoint/egress topology must be decided first.
Crew has a **working brokered reference** — `brokered = driver==="sandbox"`
(`server/src/services/internal-agent/aoa-agents/runner.ts:736`) — but on a **different substrate**;
the E2B distributed sandbox has no `--mcp-config`/`--allowedTools` on its invocation
(`buildSandboxInvocation`, `task-run-sandbox-invocation.ts`).

**Deliverable (agent-doable):** a design paper + DECISION-REQUEST under `docs/replatform/` that:
measures the current egress topology and the crew brokered reference; enumerates candidate mechanisms
(broker endpoint reachable from the sandbox vs egress allowlist for the control plane vs a
sandbox-side MCP shim); prices each against the frozen wire and the E2B egress model; and asks the
founder to rule. **No product code** until the ruling. Size L for the paper's rigor; the Unit-C BUILD
(L–XL) is a *future* wave gated on the ruling.

---

### Track 3 — Operational hardening (BUILD, parallel)

**3a — Kill-switch WRITE path** — size M. Enforcement is LIVE (`evaluateKillSwitches`,
`job-leasing.ts:927`, emits `outcome:"drain"` `:943`) but `instance_settings.kill_switches` has
**ZERO production writers** — an operator cannot throw a switch without hand-SQL. Build a writer
service + CLI/route on the existing `instance_settings.general` storage (REL-004 §4). RED-first:
throwing a switch via the new path makes a subsequent lease drain. Real gap, not dormant.

**3b — DR restore entrypoint** — size S. `runDatabaseRestore` (`packages/db/.../backup-lib.ts:1056`)
has ZERO callers and is not barrel-exported (`packages/db/src/index.ts` exports backup, not restore),
so the DR rehearsal's restore leg is uninvocable (E11-F002). Add the barrel export + an
`aoa db:restore` CLI (`cli/src/commands/db-restore.ts`, mirror `db-backup.ts`) + an exercised harness.

---

### Track 4 — Founder-facing prep (PREP → your ruling / dispatch)

**4a — E9-F002 decision paper** — the E9 service-agent control plane is substantially wired (schema,
reconciler in the composition root `index.ts:1470-1500`, routes `job-control.ts:511,631`, health
projection, daemon service supervisor) but **no service has been leased end-to-end**, and the
effect-authority is **never re-minted on lease renew**, so a "service" is capped at **240s** — the
72h D4 canary is unrunnable. Write the options paper (re-mint on renew vs accept the ceiling; SVC-008
§9.1) → founder ruling. Then E9 activation = author the missing SVC-003 ticket + drive a real service
job through the daemon on the E7-1 E2B staging (mirrors the E7-1 canary), largely agent-doable.

**4b — §9.2 Unit-F measurement probe** — write the keyed-lane test for the doc's open §9.2 question:
does E2B `files.read` return bytes for a file written by a **redirected `exec`** (+ the non-zero-exit
and unwritable-target sub-cases). This BOUNDS the whole Unit-F option space (the design doc explicitly
asks for it, measure-first). You dispatch the keyed run (needs the E2B key). Does NOT propose a
mechanism — pure measurement.

---

## 4. GATES & FOUNDER DECISIONS (what is blocked on YOU)

| Decision | What it unblocks | Owner artifact |
|---|---|---|
| **Unit C topology ruling** | agents using `mcp__aoa__*` tools (the whole "agents do work" story) | Track 2 paper |
| **E9-F002 240s window** (re-mint vs ceiling) | E9 service agents / the 72h canary | Track 4a paper |
| **Unit F: measure-first → mechanism** | arming billing (E3-F037) + output-return + `capabilityProven` | frozen; §4b probe informs it |
| **npm publish / release enablement** | shipping packages (34 changesets queued; needs `NPM_TOKEN` + merging the "Version Packages" PR) | REL / distribution |
| **E8 egress-enforcement owner** | E8 browser agents (self-hosted/tenant boundary; E8-F003) | needs a chartered ticket |
| **Production signing roots + live DR rehearsal** | REL-005 / production release | deploy/ops |

---

## 5. WHAT IS FROZEN / NOT AGENT-DOABLE NOW (do not build)
- **Unit F** (output capture / `capabilityProven`) — measure-first-FROZEN; supply mechanism refuted
  3× (shape/size/predicate). Root blocker for arming any sink.
- **Unit E** (workspace `--add-dir`) — XL, blocked (no in-sandbox manifest capture; `buildWorkspaceManifest` walks the daemon FS).
- **The 3 producer-blocked parity bridges** — `jobBudgetCostBridge`/`jobAuditBridge`/`jobOutputBridge`
  are built + integration-tested but have ZERO production callers, AND the worker composes the
  supervisor **without `observeRun`** (`dispatch-runtime.ts:180-193`), so there is no accepted worker
  evidence to bill/audit/return. **Wiring them now ships a hollow row and would false-close a HIGH
  finding.** They de-block only when Unit F composes the producer.
- **E8 browser executor** — no in-sandbox browser runtime exists at all (grep finds only a
  `playwright_trace` artifact type). Greenfield + a founder-chartered egress owner.
- **Commander/extraction sinks (MIG-005/007)** — need an unbuilt per-user `provider_connection`
  class (Decision #117); decision-gated.

---

## 6. THE DELIVERED BASELINE (so a fresh agent does not rebuild it)
Verified production-wired at HEAD:
- **Critical path E0→E7-1:** foundation/protocol/tenant-kernel complete; distributed E2B coding run
  proven end-to-end (mechanism).
- **Run experience:** CLI-006 canary terminal projection (`index.ts:927-1005`,
  `canary-terminal-projection.ts`); `jobAdmissionBridge` (the ONE wired parity bridge, `index.ts:1229`).
- **Realtime (MIG-003):** live-event broker/store/WS/LISTEN-drainer all started (`index.ts:1052-1058`),
  many real `publishLiveEvent` callers. **Convergence (MIG-002):** reaper→run-terminal reuse.
- **Desktop (DSK-001–004):** device listing (flag-gated), folder grants, host + control plane +
  effect layer, update/drain/rollback — all built + mutation-tested, behind the distributed flag /
  needing signing certs + real devices.
- **Release (E11):** REL-FOUNDATION-GATE, foundation-suite-in-CI (S9-3), REL-004 Lanes A–D
  (kill-switch READ+enforce, reclaim-on-kill both wired — records said "NOT WIRED", stale), REL-003 DR
  buildable core; device-fleet M1/M2 (#435).
- **E9 control plane** (flag-gated): schema, reconciler, routes, health projection, daemon service
  supervisor. **E8 control-plane plumbing** (flag-gated): browser job normalizer, session/request
  plumbing, approval binding, host-spawn guard — but **no browser executor**.
- **Security audit wave:** deny-path audit largely delivered (~10 crossings partial; residuals
  founder-gated or dead-lever). Latest: ack-path worker-authority-currency arm (**PR #480**, merged).

---

## 7. RECORDS-LAG TO FIX (the dominant failure class — every audit caught some)
Optional cleanup track; low-value but keeps the record honest:
- `docs/replatform/epics/E7-coding-e2b/findings.md:2034-2045` — "none of the four literals carries a
  permission posture" is **STALE**; the posture shipped **PR #424 (2026-09-11)**.
- `docs/replatform/epics/E7-coding-e2b/tickets/CLI-008-unit-f-design.md` §12 amendment (dated
  **2026-09-18**) still calls the **codex** posture (E7-F027) "open/unchanged" — **STALE**; the codex
  bypass flags (`--dangerously-bypass-approvals-and-sandbox`) shipped in the same PR #424.
- `docs/deploy/distribution.md` (2026-07-20) says the release workflow is "disabled" — **STALE** vs
  the workflow at HEAD.
- The register said REL-004 kill-switch/reclaim "NOT WIRED / Not built" — **STALE** (Lanes C/D wired).
- GO-BOOK §1.9.2 "Lane B dormant / 275 behind" — **STALE**: the `lane-b` branch is 484-behind/0-ahead
  (nothing unique); E8/E9's control-plane halves were built inline on the main line.

---

## 8. RECOMMENDED SEQUENCING (my read)
1. **Start Track 1 (crew seam) immediately** — highest-confidence unblocked build; both audits
   converged on it; the natural continuation of E7-1; ships safely inert.
2. **Run Track 2 (Unit C design paper) in parallel** — it's the strategic unlock and it needs a
   founder ruling, so start the paper now to shorten the critical path to "agents do real work."
3. **Fill spare lanes with Track 3 (ops hardening)** — small, independent, real gaps.
4. **Tee up Track 4** (E9-F002 paper + §9.2 probe) so the founder can rule/dispatch; these convert
   the two biggest founder-gated items into ready decisions.
5. Keep merges serialized ~20 min apart; verify each merged sha has a CI run.

**The critical path to a genuinely useful engine runs through Unit C (Track 2 → ruling → build).**
Track 1 widens what the engine runs; Track 2 makes what it runs actually capable. Do both.
