# Re-platform program — status + next-wave handoff

> **SUPERSEDED — 2026-08-22.** This handoff describes the state at 66/95 tickets and
> lists CLI-006 as unfinished; both are out of date. CLI-006, DSK-001..004 and REL-004
> (clauses 1 and 2) have since landed CI-green — **72/95, 23 remain**. The current plan
> is [`HANDOFF-wave-3-4.md`](./HANDOFF-wave-3-4.md). Kept for the per-ticket process and
> the trap list, which remain accurate and are carried forward there.



**As of:** branch `docs/replatform-program` tip `9a6910aed` (ONE PR #323, worktree `C:\e3`).
**Overall: 66 / 95 tickets landed CI-green.** Epics E0–E6 complete; E7 complete except its gate (CLI-006); E10's realtime-foundation gate closed; E8/E9/E11 not started.

> ### Wave update — 2026-08-19 (tip `b9c7b689e`)
>
> **Scope is now locked at maximum.** Desktop **and** cross-target mobility are both advertised, on **both Windows and macOS**. Nothing is deferred to post-beta. That fixes the remaining count at **29 tickets** and carries three consequences the body of this document treats as optional:
> - DSK-001..004 are **mandatory**, and their release join to E11 is unconditional.
> - MIG-004 is **mandatory including desktop directions** — so D6-05's per-direction load (≥10 successful handoffs + 3 partition/destination-failure cases each) applies across roughly four directions, and desktop directions additionally require DSK-004 closure.
> - Two advertised OS rows means two D6-04 support-matrix rows (≥200 probes + 3 fail-closed samples each), a desktop beta gate per OS, and REL-001/003/004 re-run with desktop covering both.
>
> **The D1 merge train had been red since the MIG-003 landing, and this document's "documented residual" framing was wrong.** Run `32245341173` was 37/40 with all three failures in E6F-13 — the realtime proof. The cause was a test bug, not MIG-003: `seq` is a Postgres bigint that the append/NOTIFY path reports as a JSON **string** while the `since()` read path yields numbers, and `tests/d1/e6f-13-realtime-fanout.test.mjs` imports `node:assert/strict`, so `'1' !== 1`. Fixed in `081a013cf`; **the lane is now 40/40 green**. `E10-REALTIME-FOUNDATION` therefore rests on real live two-replica evidence, including the cross-container convergence case §5 listed as unproven. *Lesson: a "documented residual" may just be an unread red lane — check the lane before trusting the prose.*
>
> **CLI-006 is in progress** (7 commits, all pushed and CI-green; PR gate 12/12). Landed: the `canary` rollout mode, the MIG-008 preflight, the single ownership decision, the transfer hook, the D3a bridge bypass, and the run-experience projector — 54 unit tests + 2 integration cases. **Remaining: the suppression seam**, then cancel/retry routing, JOB-008 inspection assertions, the journey matrix, adversarial review, and the result doc.
>
> **Design correction D3a** (`61019a8fe`) supersedes the "extend the CLI-005 seam" assumption: the frozen batch envelope carries the run's context as artifacts and is fixed at submission, so the job cannot be submitted at the CLI-005 seam — the convert must run **late**, just before `adapter.execute`. See `epics/E7-coding-e2b/tickets/CLI-006-design.md` §D3a.
>
> **Scheduling note:** DSK-001 is unblocked **today** and DSK-001→002→003→004 is a strictly serial 4-chain that never touches CLI-006. It is the longest unblocked chain in the program and should run as its own parallel track, or it becomes the end-game critical path.

---

## 1. Status by epic

| Epic | Landed / total | State |
|---|---|---|
| **E0** Foundation | 8 / 8 | ✅ complete |
| **E1** Worker protocol | 7 / 7 | ✅ complete (frozen v1) |
| **E2** Tenant kernel | 6 / 6 | ✅ complete |
| **E3** Job control | 14 / 14 | ✅ complete |
| **E4** Worker daemon | 7 / 7 | ✅ complete |
| **E5** Workspaces/secrets | 7 / 7 tickets | ⚠️ **tickets done, EXIT GATE NOT MET** — 2 of 7 gate clauses pass in D1, 4 proven weakly, 1 not proven — and ALL FIVE are build items (nothing wired), not coverage gaps. See [the E5 exit-gate audit](./epics/E5-workspaces-secrets/qa/2026-08-24-d0-e5-exit-gate-audit-a1.md). `✅ complete` was a ticket count, not the gate. |
| **E6** Deploy/test harness | 10 / 10 | ✅ complete |
| **E7** Coding/CLI on E2B | 5 / 6 | CLI-001..005 ✅ + **keyed real-E2B lane 18/18 GREEN**; only **CLI-006 (gate)** remains |
| **E8** Browser automation | 0 / 6 | blocked on CLI-006 |
| **E9** Service agents | 0 / 7 | blocked on CLI-006 |
| **E10** Desktop/migration/realtime | 2 / 11 | **MIG-008 + MIG-003 ✅ → E10-REALTIME-FOUNDATION gate CLOSED**; the rest is the live cutover + desktop + mobility |
| **E11** Hardening/release | 0 / 5 | blocked on the E8/E9/MIG-002 closure |

**Named gate status:** `E10-REALTIME-FOUNDATION` (= JOB-005 + DEP-009 + MIG-003) is **CLOSED** — it unblocks reconnect-safe realtime in CLI-006, BRW-006, SVC-007.

---

## 2. What landed in this wave (all CI-green on PR #323)

- **E6 remainder:** DEP-008 (sandbox isolation conformance), DEP-005, DEP-007, DEP-009 (two-replica capacity), DEP-006.
- **E7:** CLI-001 (E2B provider + closed E6-F008), CLI-002 (workspace staging + adapter exec), CLI-003 (logs/cancel/usage/result), CLI-004 (cleanup reconciliation), CLI-005 (org-run → distributed-job bridge: shadow + non-leasable convert + dormant drain). Plus the **keyed real-E2B lane** — after a build-fix + an 8-divergence driver-hardening pass, **18/18 real-E2B cases green** against the operator's key.
- **E10:** MIG-008 (reconcile legacy PR#320 E2B leases/resources + additive credential-authority move), MIG-003 (durable realtime fan-out + sequence catch-up; pg `live_event_log` + `LISTEN/NOTIFY`).

Each ticket ran the full cycle: terrain-map → design → fail-first implement → adversarial review → controller re-verification + fix → land CI-green. Result + design docs live under `docs/replatform/epics/<epic>/tickets/`.

---

## 3. The ready frontier (start here next wave)

Deps computed from `program-design.md` "Depends on" against the 66 landed tickets:

### 🎯 CLI-006 — First coding golden journey + tenant canary (E7 GATE) — **READY, keystone**
- **Deps:** CLI-005 ✅, JOB-008 ✅, DEP-009 ✅, MIG-008 ✅, E10-REALTIME-FOUNDATION ✅ — **all met.**
- **What it is:** the **live worker-execution cutover journey** — create → schedule → lease → stage → execute → stream → produce patch → review → retry → cancel → audit → operator inspection, for ONE org's coding task through the distributed path, with existing tenants staying on legacy. **Test D2 = a real E2B journey** (needs the operator's E2B key, like the CLI-001..004 keyed lane).
- **Why it's the keystone:** it wires together *all* the dormant infrastructure built so far (the job system, CLI-005's convert, MIG-008's reconciliation, MIG-003's realtime, the CLI-001 E2B provider) into one live end-to-end path. It **unblocks BRW-001 (E8), SVC-001 (E9), and MIG-001** — i.e. almost the entire remaining program.
- **Scoping note (do this first, like CLI-001):** split into a **no-key core** (the D1 full failure matrix, provable in-process/mocked on the PR gate) + a **keyed real-E2B journey** (D2, on the operator-dispatched `keyed-e2b-conformance.yml` lane). Acceptance also requires MIG-008's reconciliation to have run *before* the flag transfers the first live execution.

### REL-004 — Provider kill-switch — **READY, independent, small**
- **Deps:** DEP-001 ✅, DEP-008 ✅, CLI-004 ✅ — all met. Not blocked on CLI-006.
- **Why relevant now:** **MIG-008 explicitly deferred the old-key *enforcement* (live force-kill of sandboxes tagged with a superseded key generation) to REL-004.** MIG-008 shipped the AoA-side resolve/inject refusal + the secret-aware key-generation tag; REL-004 is the missing kill-switch primitive. A good small ticket to land independently of the CLI-006 critical path.

### MIG-005 / MIG-006 / MIG-007 — cut Commander / crew / one-shot execution over — **dep-ready, but canary-gated**
- **Deps:** CLI-005 ✅, JOB-010..014 ✅, MIG-008 ✅ (MIG-005 also E10-REALTIME-FOUNDATION ✅) — technically all met.
- **BUT** the program narrative (mermaid `E7 → CUT`) gates the full sink cutover behind the **CLI-006 canary** — prove one coding journey live before cutting over all execution sinks. **Recommend: do CLI-006 first**, then these.

### DSK-001 — Desktop packaging — **READY, but conditional**
- **Deps:** JOB-002 ✅, JOB-009 ✅, WRK-002 ✅, DAT-004 ✅ — all met.
- **Conditional:** the desktop track (DSK-001..004) + mobility (MIG-004) are dashed/optional in the release graph — only blocking if the beta **advertises** desktop/mobility. Skip unless the product commits to shipping desktop.

### Blocked (waiting on the above)
- **E8 BRW-001..006** — chain from CLI-006 (BRW-001 ← CLI-006 + PRT-006/007).
- **E9 SVC-001..007** — chain from CLI-006 (SVC-001 ← CLI-006 + TEN-004 + PRT-002).
- **MIG-001** ← CLI-006; **MIG-002** (tenant/domain cutover) ← CLI-006 + MIG-001/005/006/007; **MIG-004** (mobility) ← MIG-001/002.
- **E11 REL-001/002/003/005** ← BRW-006 / SVC-007 / MIG-002 closure. REL-005 is the final release join.

---

## 4. Critical path to beta

```
CLI-006 (E7 gate, live canary)  ─┬─►  E8 BRW-001..006  ──┐
                                 ├─►  E9 SVC-001..007  ──┤
                                 └─►  MIG-001 ─► MIG-002 (full tenant cutover) ─► MIG-004 (mobility, optional)
   REL-004 (independent, now)                             │
                                    BRW-006 + SVC-007 + MIG-002 ─► E11 REL-001..003 ─► REL-005 (release)
```

Unconditional release joins: **E8 (browser) and E9 (service) are mandatory** alongside coding. Desktop (DSK) + mobility (MIG-004) are conditional (only if advertised).

---

## 5. Context the next agent needs

**Process (proven on ~13 tickets this wave):** per-ticket cycle = terrain-map (parallel-reader Workflow → synth) → **re-verify load-bearing claims yourself** → design doc (commit) → fail-first implementer (subagent, no commit) → **adversarial review (Workflow, refute-by-default)** → controller re-verification + fix confirmed defects fail-first → result doc → commit-by-path → FF-push → CI-watch. The layered net (review + your re-verification + CI) caught a real, often-HIGH defect on essentially every ticket — *never trust a subagent's green, and never trust your own first read either.*

**CI facts (hard-won):**
- The **`migrations` CI job proves only the FIRST apply**; `migration-idempotency.test.ts` (text regex on CREATE TABLE/INDEX) + `migration-readiness.integration.test.ts` (live re-apply) prove REPLAY. **C14 idempotency guards must cover the drizzle-GENERATED DDL too** (`CREATE TABLE/INDEX IF NOT EXISTS` + each FK in `DO $$ … EXCEPTION WHEN duplicate_object`), not just a hand-appended RLS block. (MIG-008 failed CI on exactly this.)
- A **new distributed/RLS table = TWO grant surfaces** (`server/src/db/distributed-execution-databases.ts` `appTablePrivileges`/`operatorTablePrivileges` + the `job-control-legacy-grants.ts` manifest incl. `POLICY_COUNTS` + the contract-test count title). Update both or the boot/live-catalog assertion fails.
- **Recurring flakes** (re-run to clear, don't chase): `job-retry-capacity-transfer.integration.test.ts` (DEP-009 CI-DB contention), the `distributed-execution-db-startup` module-load-sentinel (embedded-pg ~30s), and UI remount-churn (e.g. `ProjectDetailDiscussions.test.tsx`). Windows-local skips integration/e2e/d1 — validate those on the Linux CI lane (push).
- **Keyed real-E2B lane:** `keyed-e2b-conformance.yml`. `workflow_dispatch` only registers from the default branch, so fire the feature-branch lane by bumping `.github/keyed-e2b-trigger` (path-filtered push). The operator holds `E2B_API_KEY` in repo secrets — **never handle the key in plaintext/chat.** Keyed cases `describe.skip` off the key; the `e2b` SDK is dynamically imported.

**Frozen (never edit):** `packages/worker-protocol/` (v1, SHA `b7a842870…`), the worker-daemon `SandboxProvider` port, `docs/architecture/distributed-execution-threat-*` (DE-*). Drizzle-only for schema (C14 the sole hand-edit exception). No new hosted-API call (Rule #11); the only hosted key is embeddings.

**Dormant infrastructure CLI-006 makes live:** CLI-005's org-run→job convert is inert (legacy adapter stays sole executor); MIG-008's reconciler + credential resolver have no runtime caller yet; MIG-003's durable realtime is wired but its cross-replica two-container socket e2e is a documented residual. CLI-006 + the MIG-005/006/007 cutover are where these get exercised live. `AOA_DISTRIBUTED_EXECUTION_ENABLED` is the default-off master flag; `AOA_DISTRIBUTED_EXECUTION_ROLLOUT` is the per-org/workload rollout source.

**Open honest deferrals to close in the cutover wave:**
- Old-key *kill-switch* enforcement → **REL-004** (MIG-008 shipped only the AoA-side refusal + tag).
- Live cutover-rollback (transfer ownership then roll back) → **MIG-002/005/006/007** (CLI-005 shipped the inert convert + rollback *safety*).
- MIG-003 literal cross-container WS socket-receive e2e; MIG-008 fully-idle-company retention trim on the aoa_app role.

**Where things live:** result/design docs under `docs/replatform/epics/<epic>/tickets/`; the program spec is `docs/replatform/program-design.md` (ticket deps + acceptance); the epic dependency graph is the mermaid near line 265. The agent-facing project rules are `C:\e3\CLAUDE.md` + `AGENTS.md`.

---

## 6. Recommended next-wave order

1. **CLI-006** (the E7 gate + live canary) — highest leverage; unblocks E8 + E9 + MIG-001. Scope no-key core vs keyed E2B journey first.
2. **REL-004** (provider kill-switch) — small, independent, closes MIG-008's deferral; can be done in parallel / by a second contributor.
3. After CLI-006 lands: **MIG-005/006/007** (cut the execution sinks over) + start **E8 (BRW-001)** and **E9 (SVC-001)** in parallel.
4. **MIG-001 → MIG-002** (full tenant/domain cutover), then **E11 REL-*** toward beta.
