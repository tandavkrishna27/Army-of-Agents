# Re-platform Program — #320 Reconciliation Review

**Date:** 2026-08-07
**Reviewer:** grounded validation (Claude), at the founder's request
**Branch state:** `docs/replatform-program` **rebased onto `main` @ `861134f6e` — now includes PR #320.** Program docs still describe a pre-#320 baseline; that content gap is what this review records.
**Status:** REVIEW DRAFT for founder check. Not yet distributed into per-epic `decisions.md`/`findings.md`. No backlog tickets edited.

---

## 0. Purpose

The program was groomed against `main` at #316/#317/#318. **PR #320 (Cloud Execution Isolation, E2B) is now merged** (squash `861134f6e`, 2026-08-07 16:22). #320 ships, in-process, much of what several epics plan to build from scratch. This document records every reconciliation gap so the program can be corrected before E1/E4/E5/E7 execute.

**Verdict:** the architecture is correct and forward-compatible with #320 — no rewrite, no change of direction. It needs a focused revision pass covering the 10 findings below. E0 is executable now and is unaffected.

---

## 1. Baseline correction (the root cause)

The program-design "Current-main integration baseline" (§ lines 26–34) lists heartbeat/Commander/crew/workspace/provider-resolution/connector as migration sources but **omits #320 entirely.** After the rebase, that section is factually stale. #320 delivered, and the program must treat as **existing migration sources to relocate (not rebuild):**

| #320 artifact | File (on main) | Program ticket that assumes it doesn't exist |
|---|---|---|
| Provider-neutral sandbox interface | `sandbox-provider-runtime.ts:143-170` (`SandboxRuntimeProvider`: acquire/execute/release/resume/writeFiles/readFiles/resolveHost) | WRK-004 ("define" provider-neutral supervision) |
| E2B provider implementation | `createE2bSandboxRuntimeProvider` (registered `:1034-1038`) | CLI-001 ("E2B provider implementation") |
| In-process MCP broker + run-JWT | `mcp/broker-tool-context.ts`, `agent-auth-jwt.ts` | DAT-004 (secret broker); the tool surface is un-ticketed (G7) |
| Lease lifecycle (acquire/release/pause/resume/reaper) | `environment_leases` + `environment-runtime.ts` + `warm-sandbox-reaper.ts` | E1 lease vocab (PRT-002/003); JOB-003/004 |
| Env allowlist (no secrets in VM) | `packages/adapter-utils/src/sandbox-env-allowlist.ts` (`buildSandboxEnvAllowlist`) | DAT-005 (egress/redaction) |
| Commander-in-sandbox (Decision #120) | warm per-conversation lease | no ticket (G4) |
| D1 refuse→sandbox guard + reserved remote-runner driver | `unsandboxed-multitenant-guard.ts`, `cloud-environment-policy.ts` (`RESERVED_TENANT_RUNNER_DRIVER`) | confirms the worker daemon is an *allowed-by-construction* evolution |

**Recommended action:** rewrite the baseline section to name #320; add a program decision record `#320 reconciliation`.

---

## 2. Findings

Severity: **High** = must resolve before executing the affected epic · **Med** = resolve during epic planning · **Low** = grooming hygiene.

### G1 — ~6 tickets rebuild code #320 already shipped — **High** — epics E1, E4, E7
- **Evidence:** CLI-001 says "E2B provider **implementation**" but `createE2bSandboxRuntimeProvider` exists. WRK-004 "**define** provider-neutral create/execute/cancel/kill/destroy" but `SandboxRuntimeProvider` exists. DAT-004 "lease-scoped secret broker" but the MCP broker + run-JWT + `buildSandboxEnvAllowlist` already is one. E1 PRT-002/003 mint fresh lease vocab (`leaseOffer/Ack/Renew`) disjoint from the shipped `acquireLease/releaseLease/resumeLease`.
- **Impact:** executing as written forks a **second, divergent provider/lease abstraction** → painful reconciliation later.
- **Fix:** reframe CLI-001/WRK-004/DAT-004 as **adopt + relocate** the in-process seam onto the worker/network path; add an explicit mapping from E1's wire vocab to the existing lease methods.

### G2 — E2 leaves the existing product on convention-only isolation — **High** — epic E2
- **Evidence:** TEN-002 forces RLS on "**new-path** tenant tables" only. No ticket retrofits the **129 existing tenant tables**, the **557 `assertCompanyAccess`** call sites, the owner DB connection (`packages/db/src/client.ts:46-57`), or the inert single-table canary (`db/rls-bootstrap.ts`).
- **Impact:** after the whole program, DB-enforced isolation protects only new job/worker/service rows; **your actual product data (issues, memory, discussions, agents…) stays app-layer-only indefinitely.** The plan reads as if E2 "solves tenancy" — it does not.
- **Fix:** state this as an explicit residual risk in E2; either add a legacy-retrofit epic or record a conscious decision to defer it (and by when).

### G3 — Decision #104 keyless-CLI credential + model-provider egress unaddressed — **High** — epics E5, E7
- **Evidence:** worker runs default-deny egress (DAT-005) with no secrets in the VM, but a coding/CLI job must reach the model-provider API and materialize the company BYO key. #320 already discovered the shared pool is **API-key-only** (subscription ToS). CLI-002/DAT-004 cover connector/context materialization but never the **model-provider credential** or the **extraction CLI sinks** (`extraction-cli.ts`, the Commander summarizer, readiness probes) that #320's Wave 3 had to sandbox.
- **Fix:** add a requirement in E5/E7 for model-provider credential materialization + an egress allowance for the provider API; enumerate the extraction/compaction/readiness CLI sinks as jobs or explicit non-goals.

### G4 — Commander has no place in the taxonomy and no migration ticket — **High** — program / E9
- **Evidence:** workloads are batch/browser/service; Commander is a persistent multi-turn conversational agent that maps to none. #320 locked **Decision #120 (Commander-in-sandbox, warm per-conversation).**
- **Fix:** decide whether Commander migrates to the worker model (which workload class, or a new one) or stays on #320's in-process warm-sandbox path; add the ticket.

### G5 — Browser/service-on-E2B feasibility assumed, not spiked — **Med** — epics E8, E9
- **Evidence:** E8 (Playwright-in-sandbox) + E9 (30-min+ services) are ~13 tickets and assume the provider supports long-running + browser workloads under the egress/artifact model. #320 only proved short coding/CLI + Commander turns. The D3/D4 lanes test this *after* the tickets are built.
- **Fix:** add an early feasibility spike (browser-in-E2B, multi-day-service-in-E2B) as a gate before committing E8/E9.

### G6 — Ask-human / `work_questions` (Decision #109) is absent from the lifecycle model — **High** — epic E1 / program
- **Evidence:** a batch job that blocks on `ask_human` for hours/days fits neither "batch = minutes-hours, terminal result" nor "service = desired-state." `work_questions` is the durable Ask-Human source of truth with continuation state, and it's a first-class AoA pattern with **no representation in the job/attempt/lease state machines.**
- **Fix:** add a suspended/awaiting-human state (or an explicit continuation model) to the E1 lifecycle, or a decision that ask-human runs stay on the legacy path in v1.

### G7 — The brokered MCP tool surface over the network isn't ticketed — **High** — epic E5 / program
- **Evidence:** #320's **core** is the broker serving memory/tasks/goals/artifacts/use_skill/ask_human tools to the sandbox in-process (RBAC-scoped per actor, Decisions #118/#119). The worker model needs that same tool surface reachable from a remote sandbox, but the backlog tickets only DAT-004 (secrets) + vague "call a tenant-scoped control-plane API." The full brokered tool-serving path is missing.
- **Fix:** add tickets for exposing the brokered MCP tool surface to the worker/sandbox over the network (relocating #320's in-process broker), preserving the per-actor RBAC gate.

### G8 — Existing cost / artifact / workspace models not reconciled — **Med** — epic E5
- **Evidence:** JOB-007 builds new quota/spend, DAT-003 builds patch/artifact, DAT-001 builds workspace snapshot — without saying integrate-or-fork vs `cost_events`/`budget_policies`/`finance_events`, `artifacts`/`artifact_versions` (immutable, Decision #67), `execution_workspaces`/`workspace-runtime.ts`. #320 already wired sandbox output → `task_outputs`/artifacts/`cost_events`.
- **Fix:** name the existing models as the integration targets in DAT-001/003 and JOB-007; avoid parallel concepts.

### G9 — Multi-adapter coverage inherited silently — **Med** — epic E7
- **Evidence:** #320 sandboxes only `claude` + `codex`; cursor/gemini/opencode/grok/pi fail-closed in a sandbox. CLI-002 "run one existing CLI adapter" doesn't address the ~9-adapter matrix.
- **Fix:** state v1 sandboxed-adapter scope (claude+codex) explicitly; make the rest a tracked follow-up.

### G10 — Grooming hygiene — **Low** — epics E1, E6 / program-design
- **Evidence:** (a) dependency-graph edges (E6→E3, E4→E6) disagree with the epic-README gate deps — resolves only at ticket granularity. (b) E1 authors exhaustive browser/service state machines E0 never locked (E0 tabulates only `batch`); this violates E1's own "no new states without a decision" rule and the E1 decision ledger is empty.
- **Fix:** reconcile the DAG with the READMEs; complete E0's browser/service transition tables (or record an E1 decision) before E1 executes.

---

## 3. Priority summary

| Must fix before executing | Epic | Fix before planning | Epic |
|---|---|---|---|
| G1 rebuild→relocate | E1/E4/E7 | G5 browser/service spike | E8/E9 |
| G2 two tenancy models | E2 | G8 cost/artifact/workspace | E5 |
| G3 keyless-CLI creds + egress | E5/E7 | G9 adapter coverage | E7 |
| G4 Commander migration | program | G10 grooming hygiene | E1/E6 |
| G6 ask-human lifecycle | E1 | | |
| G7 MCP tool surface | E5 | | |

E0 is unaffected and executable now.

---

## 4. Recommended next steps

1. **[DONE] Rebase** `docs/replatform-program` onto main (includes #320). ✓ `e16340928`.
2. **Founder checks this document.** ← you are here.
3. On approval, distribute into the program's own structure: one `#320 reconciliation` decision record (via `templates/decision-template.md`) + findings entries under E1/E2/E5/E7/E8/E9 using the `E*-F00n` convention.
4. **(Program owner's call)** amend `program-design.md` baseline + affected ticket framings (G1/G7/G6 add/modify tickets). This edits the backlog — left to your friend as the program owner unless you want me to draft it.

No per-epic records written and no backlog tickets edited yet — this stays a review draft until you say go.
