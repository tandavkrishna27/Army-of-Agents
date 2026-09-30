# HANDOFF — post-E7-1 (2026-09-18): the sink-cutover wave

> **This supersedes `HANDOFF-wave-4.md`, `HANDOFF-next-wave.md`, and `HANDOFF-wave-3-4.md` as the current
> forward-work authority.** It is written to be read cold by a new session with zero prior context. Ground
> truth for status is this file + `GO-BOOK.md §1` + each epic's `findings.md`; the epic `README.md` status
> cells lag on purpose (only the Integration Gate Owner flips them).

---

## 1. Where we are (one paragraph)

The distributed-execution re-platform's **entire mechanism is built and merged** (E0–E7 coding path), and
on **2026-09-18 the E7-1 real-E2B distributed coding run was PROVEN end-to-end** on the Hetzner staging
fleet — the single "owed live-infra run" the program was gated on. What remains is **breadth** (cut the
legacy execution sinks over to the distributed substrate — Sprint 6), the **E7 capability half** (proving
the agent's *output* reaches AoA, not just that the journey runs), the **Lane-B** browser/service agents
(E8/E9), and **hardening/release** (E11). No hard structural blocker remains on the critical path.

## 2. What "E7-1 proven" means — precisely (do NOT overclaim)

Run `8dc34e90` on staging: `verify-e7-1-distributed-run 8dc34e90 --org 0febb760-...` →
`RESULT: PASS (mechanism) — distributed journey corroborated`, `ok=true`, `failures=[]`, **EXIT 0**. The
full chain ran live:

```
dispatch → execution_owner=distributed → lease → secret redemption (DE-29 clean)
  → artifact-transfer-grant 200 → stage_files OVER THE WIRE (E7-F011)
  → E2B sandbox create → execute → terminal event
  → durable terminal projection WITH finished_at (E7-F036) → verifier ok=true
```

Three things a green E7-1 **does NOT** establish — carry these forward verbatim:
1. **It does not flip the `E7-1-coding-journey` gate clause** in `scripts/gate-clause-wiring.json`. That
   clause measures a **shipped CI boot** (a production caller reachable from a boot root) and names a
   **DEP-011 daemon-consumer precondition**. The proof was a *manual staging* run; the register is unchanged
   and stays `unwired` until the operator builds/deploys the adapter-manager image in a shipped boot AND
   DEP-011 wires the daemon consumer. Flipping it is a deliberate separate operator/prose step
   (`RUNBOOK-e7-1-keyed-run.md`), not something a code PR does.
2. **`capabilityProven` is FALSE, by design** (founder ruling E7-D-CAPABILITY-DISCLOSURE, 2026-09-09). A
   green E7-1 proves the MECHANISM, not that the agent can work. It gates nothing; `--require-capability` is
   off by default. Closing it is the E7 capability half (§6, and E7-F018).
3. **It is one canary org on staging**, not production traffic across all sinks.

## 3. Environment & operating runbook (a new session needs this)

- **Box:** Hetzner staging `204.168.148.126`, compose project `aoa-staging`, dir `/opt/aoa`. Containers:
  `aoa-staging-control-plane-1`, `aoa-staging-adapter-manager-1`, `aoa-staging-worker-1`,
  `aoa-campaign-postgres-1` (DB `aoa`; psql user `aoa` is superuser → bypasses FORCE RLS).
- **SSH:** key `~/.aoa_hetzner_key` (chmod 600), passphrase via `~/.aoa-askpass.sh` with
  `SSH_ASKPASS_REQUIRE=force DISPLAY=:0`. The box authorizes ONE key.
- **Canary identity:** org `0febb760-5562-4289-a76a-f2f63139ee2d`, company `df827ba2-...` "E7-1 Canary Co",
  org agent `492e43fa-...`, execution target `aoa-canary-e2b` `a4dd8d20-...`.
- **DB roles** (env var → role): `DATABASE_URL`→`aoa` (superuser, bypasses RLS — use for the verifier and
  cross-tenant reads), `AOA_APP_DATABASE_URL`→`aoa_app` (RLS-bound app role, zero grants on the credential
  model — by design), `AOA_OPERATOR_DATABASE_URL`→`aoa_operator` (operator; **no grants on
  `heartbeat_runs`** — the verifier fails on it, use the plain `DATABASE_URL`).
- **Prove-a-run runbook (each deploy recreates the worker → its session goes terminal → must re-enroll):**
  1. Re-enroll worker: `bash /tmp/reenroll-s3-v2.sh` (dynamic worker-id; mints a fresh single-use
     enrollment code locally on the box with `openssl` — **never enter any key yourself**; deletes stale
     worker, realigns target to gen 1, restarts). Verify: fresh worker row `enrolled`, `last_seen_at` set,
     log `dispatch COMPOSED; heartbeat seeded; leasing through the poll loop`.
  2. Reconcile: `docker exec aoa-staging-control-plane-1 sh -c 'DATABASE_URL="$AOA_OPERATOR_DATABASE_URL" node /cp-app/dist/cli/reconcile-legacy-resources.js --organization 0febb760-...'` (< 1 hr TTL).
  3. Reset the org agent to idle: `UPDATE agents SET status='idle' WHERE id='492e43fa-...';`
  4. Dispatch: `bash /tmp/dispatch-canary.sh` (board-token `POST /issues`, in-server).
  5. After ~70s, get the run id: `SELECT id, status, finished_at, distributed_job_id, distributed_attempt_id FROM heartbeat_runs ORDER BY created_at DESC LIMIT 1;`
  6. Verify: `docker exec aoa-staging-control-plane-1 sh -c 'DATABASE_URL="$DATABASE_URL" node /cp-app/dist/cli/verify-e7-1-distributed-run.js <runId> --org 0febb760-...'` → expect `ok=true` EXIT 0.
- **Deploy (GitHub Actions, `deploy-replatform-campaign.yml`, `workflow_dispatch`):**
  `gh workflow run deploy-replatform-campaign.yml -R MeteoriteLabs/AoA --ref docs/replatform-program -f deploy_sha=<merge-sha> -f cleanup_builder_cache=true`.
  - ★ **`cleanup_builder_cache=true` is usually required** — the box's build guard needs ≥15 G free and the
    box hovers ~11 G with ~6 G reclaimable build cache. It prunes build cache only, NEVER volumes.
  - ★ The dispatch runs the **`docs/replatform-program` copy** of the workflow (its `if:` gate requires
    `github.ref == refs/heads/docs/replatform-program`, which the `--ref docs/replatform-program` above
    supplies) and builds the `deploy_sha` you pass. The default-branch copy only governs whether
    `workflow_dispatch` is *available*, not which copy runs.
  - The control-plane holds the E7-F036 fix (the terminal projection is a CP-side after-commit hook).

## 4. What was just merged (don't redo)

All on `docs/replatform-program` (the WIP integration branch; PR #323 is the do-not-merge umbrella):
`#468` fast-xml-parser 5.7.2 + master-key compose durability · `#469` worker-control observability
(`internalErrorLogFields`) · `#470` blank-S3-endpoint → AWS default · `#471` **E7-F011** networked
`stage_files` wire · `#472` **E7-F036** projector `finished_at` (merge `cbb496fe7`). This file's own
reconciliation PR marks E7-F011/E7-F036 resolved and updates GO-BOOK §1 + E10-F001.

## 5. NEXT WAVE (recommended) — Sprint 6: cut the sinks over

Turn the one proven run into a pipeline real traffic flows through. This is what unblocks E8/E9/MIG/E11.
Build each as a scoped unit following the binding process in §8.

**5.0 — Cheap closeout (hours):** author the `E7-1-coding-journey` gate-flip note (operator/prose,
`RUNBOOK-e7-1-keyed-run.md`) IF the operator has done the shipped-CI-boot + DEP-011 precondition (else leave
it honestly `unwired`). Record hygiene beyond this PR: none outstanding for E7-F011/F036/GO-BOOK/E10-F001.

**5.1 — GATING PREREQUISITE: wire the dormant parity bridges (E3 Sprint-6).** Before the rollout dial can
be armed beyond a keyed test, distributed spend/audit/output must be visible:
- **`jobBudgetCostBridge`** — the **HIGH E3-F037**: a handed-off distributed attempt currently writes
  NO `cost_events` row (`priceAcceptedUsage` has 0 production callers; the CLI-006 suppression `return` at
  `heartbeat.ts` bypasses the only cost writer). Arming `AOA_DISTRIBUTED_EXECUTION_ROLLOUT=canary` today
  would produce spend no budget/cap/hard-stop can see. **⚠ NOT a clean "do this one first" — corrected
  2026-09-18 (post-E7-1).** The bridge (consumer) is built and correct, but its accepted-usage seam is
  EMPTY on the deployed path: the distributed worker composes its supervisor WITHOUT `observeRun`
  (`packages/worker-daemon/src/lifecycle/dispatch-runtime.ts:187` — comment "observeRun stays absent";
  emit gated at `supervisor.ts:873`), so a real distributed attempt — the proven E7-1 run included —
  emits no `usage` event and there is nothing to price. Wiring it alone yields no `cost_events` row (or a
  hollow ~$0 one). E3-F037 therefore closes only with a usage-evidence PRODUCER first (compose
  `observeRun` — **CLI-008 Unit F**, §6 — the same structural-reachability root **E7-F018** measures for
  the output arm) AND the wiring. See the E3-F037 amendment (2026-09-18) and its E3-15-budget register
  reason. Choose the actual next unit accordingly (a genuinely reachable seam, or attack Unit F).
- **`jobAuditBridge`** + census (closes E3-F038) and **`jobOutputBridge`** (E3-17; also the crew sink's
  result path). Both are zero-caller today.

**5.2 — Build the E10-F001 prerequisites** (`epics/E10-desktop-migration-realtime/findings.md` E10-F001,
HIGH) — **two shared across all sinks, plus one extraction-only** (crew is NOT gated on #3):
1. [shared] a **distributed routing seam for non-`task_run` sources** (convert/placement/ownership + legacy
   suppression live only in `heartbeat.ts` / `run-execution-owner.ts`, which are `task_run`-shaped);
2. [shared] **mint-runner generalization** to mint a Company key for an agentless/non-coding run (guard 3
   `adapter_not_v1_scope` currently refuses `commander_turn`/`one_shot`/`service`/etc.);
3. [extraction-only] a **synchronous result-return path** (jobOutputBridge is async fire-and-forget).

**5.3 — Cut sinks over, one at a time, each with its own soak:**
- **CREW first (MIG-006)** — the cleanest: crew already rides the mint iff the company provider is a v1
  coding adapter (`anthropic→claude_local` / `openai→codex_local`; `google`/`opencode` refuse). Its only
  blockers are the 5.2 routing seam + the 5.1 projection bridges — **the E7-1 blocker is now removed**
  (E10-F001 crew bullet updated 2026-09-18). MIG-006 is **not yet authored**.
- **Extraction (MIG-007)** — deferred: thin-to-negative value (already runs isolated E2B with the Company
  key) and it needs the sync→async result path or it drops every extracted item.
- **Commander (MIG-005)** — largest: needs a net-new per-user `provider_connection` credential class
  (Decision #117 / MIG-001, **unbuilt, no ticket file**).

## 6. ALTERNATIVE wave — the E7 capability half (pick this instead if the priority is "prove the agent produces output")

A green E7-1 proves the mechanism, not capability. To make `capabilityProven` reachable and arm
`--require-capability`:
- **CLI-008 Unit C** (tools, L–XL): brokered `aoa` MCP config + run-identity credential so `mcp__aoa__*` is
  callable in-sandbox.
- **CLI-008 Unit E** (workspace, XL): a real repository in the sandbox (`buildWorkspaceManifest` currently
  walks a local FS, can't target E2B; `manifestArtifactId` has 0 producers).
- **CLI-008 Unit F** (output capture / the return path): **UNBUILT, UNSIZED, no buildable plan** after 3
  refutations + a 26-agent decision wave (measure-first). Gated on characterizing **E7-F027** (codex's own
  trusted-directory gate refuses distributed codex before any model call) so Unit F can be adapter-agnostic
  or explicitly `claude_local`-only. Closing Unit F is the precondition to closing **HIGH E7-F018** (both
  `capabilityProven` arms structurally unreachable in every checked-in config).

## 7. PARALLEL lanes (no shared dependency with §5)

- **Lane B — S7 browser (E8):** owner-assign + close the **5 HIGH unowned findings** (E8-F003/F007/F008
  sandbox egress default-deny is enforced at NO layer — `169.254.169.254` answers from inside the guest and
  the provider `denyOut` is measured INERT; E8-F011 cookie/trace leak, no purge-on-completion), then the
  entry-point tickets BRW-005→006→007→008. Needs owners named first.
- **Lane B — S8 service (E9):** **HIGH E9-F002** — its T0 half is ALREADY green (mechanical
  placement-reachability), so a live run does not "close T0". The finding closes on a **ruling on SVC-008
  §9.1** — one of {re-mint the effect authority on the supervise tick · re-mint on `/leases/:leaseId/renew` ·
  accept the 240 s ceiling and amend E9's acceptance language} — because a "service" is currently capped at
  **240 s** (the effect authority is never re-minted). If the ruling is a re-mint, **implement it** (a server
  change on the renew route / tick — the finding notes this "is not SVC-008's to make"); only THEN is a
  **live service run >240 s** possible (mirroring the E7-1 proof; if the ruling is "accept the ceiling", a
  >240 s run is impossible by design). Also create the missing **SVC-003 ticket file** so E9-F002/F003 can
  get an owner (E9-F004's *writer* half is SVC-005's — SVC-003 is only its first consumer). SVC-004
  (checkpoint) and SVC-006 (telemetry + the 72-hr D4 canary) are unstarted.
- **Operator/DR:** DBR-001 `aoa db:restore` entrypoint (session-buildable) → REL-003 live DR rehearsal
  (measured RPO/RTO) on the now-live fleet.

## 8. Process & guardrails (binding — this program's scar tissue)

- **Per-ticket process:** terrain re-verify at HEAD → design-commit → plan review → **fail-first TDD, every
  guard positive-controlled** (a check that can't fail is worse than no check) → adversarial review →
  mutation-test every guard → result doc → watch `ci-required` green. (`HANDOFF-wave-3-4.md §1`.)
- **Records-vs-code is the #1 failure class.** CITE BY SYMBOL (line pins rot); re-measure at HEAD; a false
  claim of enforcement is worse than a missing check. Reconcile findings/README/GO-BOOK when code lands.
- **Merge model:** everything lands on `docs/replatform-program` (NOT `main`; `packages/worker-daemon` etc.
  don't exist on main). Required check is `ci-required`. Merges serialize; parallel feature PRs are free.
- **CI gotchas:** `policy` STOPS at the first failing step (enumerate all ~95 checks locally before
  pushing); `check-frozen-worker-protocol-consumer.mjs` needs `--source-sha`; the citation-integrity guard
  catches wrong-LINE not wrong-SYMBOL; `verify` is sharded 4-way; local monorepo build is broken
  (deep-OneDrive `ENAMETOOLONG`) so pure-node guards + single vitest files run locally, CI + the box are the
  real gates; a `gh pr checks --watch` can exit 0 on a network drop — always confirm via `ccd_pr get_status`.
- **Codex review quota is exhausted account-wide** → founder-authorized precedent for this wave: merge on
  thorough **adversarial self-review + CI-green**.
- **SECURITY (non-negotiable):** never enter API keys / credentials / private keys / passphrases — the
  founder does that themselves. The old `DEPLOY_SSH_KEY` is for a different server — use
  `DEPLOY_SSH_KEY1`/`DEPLOY_PASSPHRASE1` (already wired). When probing secrets on the box, compare SHA-256
  prefixes / lengths / key-name presence only — never print secret values.
- **Accepted caveats (respect all five):** CAV-001 E2B provider limits; CAV-002 no self-hosted Firecracker;
  CAV-003 handoff is fenced-restart not live migration; CAV-004 offline output is quarantine-only until
  reconciled; CAV-005 legacy ~129 tenant tables stay application-layer isolated (no RLS retrofit this
  program). (`accepted-caveats.md`.)

## 9. Key references

- Status map ground truth: `GO-BOOK.md §1`, each `epics/*/findings.md`, `scripts/gate-clause-wiring.json`.
- E7-1 proof + runbook: `RUNBOOK-e7-1-keyed-run.md`; verifier `server/src/cli/verify-e7-1-distributed-run.ts`.
- The two fixes just landed: `epics/E7-coding-e2b/tickets/E7-F011-networked-staging-route-design.md`,
  `epics/E7-coding-e2b/tickets/E7-F036-projector-finished-at-design.md`.
- Sink-cutover authority: `epics/E10-desktop-migration-realtime/findings.md` (E10-F001).
- Memory tracker (Claude): `e7-1-live-canary-deploy-ops.md` (the full blocker-by-blocker history).
