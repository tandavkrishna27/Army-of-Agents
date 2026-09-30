# Re-platform Program — Hardening Verification (Round 2)

**Date:** 2026-08-08
**Reviewer:** grounded validation (Claude), at the founder's request
**Branch:** `docs/replatform-program` @ `a2043f623` — rebased onto `main` (includes PR #320), then hardened by the program owner (+2,617 lines, 2 commits).
**Baseline verified against:** `origin/main` (includes #320 at `861134f6e`; 0188-marker flow at `003492988`).
**Method:** two independent read-only agents — (1) per-finding addressal check, (2) code-claim accuracy + new-problem hunt.

---

## 1. Context (the arc so far)

1. An external strategy conversation proposed a selective cloud re-platform (worker protocol + desktop).
2. PR **#320 (Cloud Execution Isolation, E2B)** was merged to main — the execution boundary is now live code.
3. This program (`docs/replatform/`) was groomed but against a **pre-#320 baseline**, so a Round-1 review raised **10 findings (G1–G10)**.
4. The program owner ran a **hardening pass** in direct response: 4 new files (`current-main-crosswalk.md`, `accepted-caveats.md`, `agent-execution-guide.md`, `test-gates.md`), major rewrites of `program-design.md` + the E0/E1 plans, and **19 new tickets** (JOB-009–014, MIG-001–008, FND-006/008, PRT-007, DEP-008/009). Backlog is now **94 tickets**.
5. This document verifies whether the 10 findings are addressed and whether the hardening is code-accurate and introduced any new problems.

**Overall:** a strong, well-grounded response. **6 of 10 findings fully addressed, 3 partial, 1 not addressed.** Every spot-checked code claim is accurate. Internal consistency is excellent (all 32 referenced ticket IDs resolve; 19 new tickets fully defined; backlog count matches). Two new process issues (sizing, pin-SHA). The plan is nearly ready to execute E0.

---

## 2. Finding-by-finding scorecard

| # | Finding | Sev | Verdict | Where / why |
|---|---|---|---|---|
| G1 | ~6 tickets rebuild #320 code → relocate | High | ✅ Addressed | Baseline now names #320; crosswalk CM-009/010/011 assign relocate-behind-worker owners; DAT-004 reworded "extend the existing broker" |
| G2 | Legacy 129-table RLS stays app-layer-only | High | ❌ **Not addressed** | Still scoped "new-path tables only"; residual risk never stated/deferred/owned |
| G3 | Keyless-CLI creds + egress + extraction sinks | High | ✅ Addressed | CM-005/006/007 (one-shot sinks), CM-013 (model-provider cred), DAT-004/005 (fence-aware egress) |
| G4 | Commander migration (Decision #120) | High | ✅ Addressed | New **MIG-005** cutover + CM-004; `commander_turn` first-class source |
| G5 | Browser/service-on-E2B feasibility | Med | 🟡 Partial | Gated by mandatory D3/D4 real-provider lanes + CAV-001; no cheap upfront spike |
| G6 | Ask-human lifecycle | High | ✅ Addressed | New **PRT-007** `permission \| work_question` union (`park_run`/`escalate`/`continue_with_default`) |
| G7 | Brokered MCP tool surface over network | High | 🟡 Partial | `ask_human` + static memory context covered; live per-actor tool surface (tasks/goals/use_skill) still vague |
| G8 | Cost/artifact/workspace models reconciled | Med | ✅ Addressed | JOB-012/013/014 "no second engine"; CM-008 names workspace targets |
| G9 | Multi-adapter matrix | Med | 🟡 Partial | Readiness-probe matrix explicit (CM-007); coding-adapter scope (CLI-002) still implicit |
| G10 | DAG mismatch + E0/E1 state machines | Low | ✅ Addressed | E0 now locks all four lifecycles; DAG rewritten with named partial gates |

**Score: 6 fully addressed · 3 partial · 1 not addressed.**

---

## 3. Still-open items (what to fix)

### G2 (High) — the one real miss — **fix first**
The residual risk that the **existing** product (129 tenant tables carrying `companyId`, 557 `assertCompanyAccess` sites, the owner DB connection at `packages/db/src/client.ts:46-57`, the inert single-table RLS canary) stays **convention-only-isolated** is never stated. TEN-001/002 still scope RLS to "new-path tables"; the E0 "Residual risks and release exclusions" list omits it. The pervasive "new-path" wording reads as if E2 solves tenancy — the exact misread Round 1 warned about.
**Fix (cheap):** state it as an accepted caveat or a dated deferral, or add a legacy-retrofit epic. One paragraph.

### G7 (High, softer than it looks) — partial
#320's broker is already an HTTP control-plane endpoint the sandbox calls with a run-JWT, so the tool surface does **not** need a new subsystem. What's missing is an **explicit ticket confirming the live per-actor RBAC tool serving (Decisions #118/#119) holds when the caller is a remote-worker sandbox** — the plan currently says only "receive authorized context inputs *or* call a tenant-scoped control-plane API." Documentation + confirmation gap, not a rebuild.
**Fix:** add/scope a ticket for the brokered internal-tool surface (memory/tasks/goals/use_skill) over the worker path, preserving the RBAC gate.

### G9 (Med) — thin
The readiness-probe adapter matrix is explicit (CM-007: claude_local/codex_local supported, rest fail-closed), but the **coding** workload (CLI-002 "run one existing CLI adapter") never states v1 sandboxed-coding scope (claude+codex) or a tracked follow-up for cursor/gemini/opencode/grok/pi.
**Fix:** mirror CM-007's explicit matrix in CLI-002.

### G5 (Med) — partial, defensible
Reframed via mandatory D3/D4 real-provider nightly lanes + CAV-001 (which bars "claiming support for a workload that cannot complete or checkpoint within verified limits") rather than an upfront spike. Trade-off: the ~13 E8/E9 tickets can be built before D3/D4 surfaces an E2B limitation. Also note an over-correction — browser/service are now **unconditional mandatory** release joins, not feasibility-gated.
**Optional:** add a cheap browser-in-E2B / long-service-in-E2B spike before committing E8/E9.

---

## 4. New issues introduced by the hardening

| # | Problem | Severity | Detail |
|---|---|---|---|
| B1 | **Backlog sizing vs own DoR** | Medium | Now **94 tickets, all sized M (≤3 agent-days)**, but the cutover/parity tickets (MIG-002/004/005/008, JOB-010–014) span whole subsystems with ~10-clause test matrices and exceed 3 days — violating the program's own "otherwise split it" DoR. Mitigating: they're wiring/parity over existing engines ("no second engine"), so *code* scope is bounded; risk is the test matrices. **Fix:** split or explicitly exempt cutover tickets. |
| B2 | **Pin the exact revision** | Medium | Crosswalk is written against `origin/main` (has #320), but a local `main` checkout can lag (observed local `06320643a` was missing #320). Gate-runners must fetch + pin the exact origin SHA or they verify a tree where the described code is absent. **Fix:** pin the SHA in the crosswalk; `git pull` local main. |
| B3 | Baseline staleness | Low | origin/main is +4 commits past the pinned `003492988` (RBAC repair, cleanup) — non-material to execution paths, but the "observed baseline" is no longer HEAD. |
| B4 | Crew ephemeral characterization | Low | CM-003 asserts crew "cloud runs are ephemeral" without a cited column/flag; warm-lease schema keys on `agentId`/`commanderConversationId` only. Tighten the citation. |

---

## 5. Bonus — the plan caught a real defect in merged #320

The crosswalk's **CP-001…005** rows surfaced a genuine latent issue: **#320's shipped `cloud-plugin-execution.ts` allowlists plugin workers (`worker-fork`/`worker-manager`/`lifecycle`/`loader`) on `cloud_auth`**, contradicting **Decision #103**'s cloud-plugin block (whose message is now past-tense "was blocked… until a host-resident worker was available"). The plan correctly escalates this to an **E0-blocking** pair (**FND-006/008**) that must be fixed before the program starts. This is exactly what good grooming should do — the review process found a real contract/security gap in merged code. Confirmed accurate against `origin/main`.

---

## 6. Code-accuracy confirmation

All spot-checked crosswalk claims verified **CONFIRMED** against `origin/main`:

| Claim | Evidence |
|---|---|
| CM-004 warm per-conversation lease | `environment_leases.ts:26` `commanderConversationId` → `internalAgentConversations`; warm-resume L68 |
| CM-005 host-PATH CLI probe + sandbox one-shot + batch reuse | `extraction-cli.ts` imports `runOneShotCliInSandbox`; `probeExtractionCli` in `extraction-engine.ts` |
| CM-009 run-JWT + broker staging | `commander-run-jwt` / `crew-run-jwt` / `broker-internal-registry` tests present |
| CM-010 provider lifecycle | `sandbox-provider-runtime.ts` execute/writeFiles/getHost/kill/pause |
| CM-013 provider-scoped cred allowlist | `packages/adapter-utils/src/sandbox-env-allowlist.ts` positive allowlist |
| CP-001 plugin sink allowlist + `AOA_PLUGIN_WORKER_PROCESS` bypass | `cloud-plugin-execution.ts` — `CLOUD_SAFE_CONTROL_PLANE_SINKS`, ui-static blocked, 6-sink union |

Internal consistency: all **32** referenced ticket IDs resolve to defined tickets; all **19** new tickets fully defined; backlog count (94) matches prose; dependency edges resolve; **no contradiction with locked decisions** in the new content.

---

## 7. Bottom line + recommended next steps

The hardening made the plan **more correct and far more auditable.** Code-grounding is solid, 6 findings cleanly closed, and it caught a real #320 defect. What remains is small and bounded.

**To close before executing E0:**
1. **G2** — state the legacy-tenancy residual risk (caveat or dated deferral). *One paragraph.*
2. **G7** — add a ticket for the brokered internal-tool surface over the worker path (confirm #118/#119 RBAC).
3. **G9** — state v1 coding-adapter scope (claude+codex) + follow-up in CLI-002.
4. **B1** — split or exempt the subsystem-spanning MIG/JOB parity tickets from the ≤3-day DoR.
5. **B2** — pin the exact origin SHA in the crosswalk; pull local main.

**Optional:** G5 upfront E2B feasibility spike; B3/B4 cleanups.

E0 is otherwise executable. This is a plan that's nearly ready to start.

---

*Verification provenance: two independent read-only agents over `docs/replatform/` @ `a2043f623` and code at `origin/main` (incl. #320 @ `861134f6e`). Round-1 findings: `2026-08-07-320-reconciliation-review.md`.*
