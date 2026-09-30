# v1-Combined Readiness Review — Plan

**Date:** 2026-06-20
**Author:** Founder + Claude (Opus 4.8)
**Status:** Approved plan — ready to execute Phase 0
**Review target branch:** `feat/v1-combined` (via worktree `AoA-prb`)
**Gate:** Certify `feat/v1-combined` as ready to become **v1** (the v1 upgrade).

---

## 1. Objective

Run a thorough, multi-agent, **adversarially-verified** review of the *entire* codebase on
`feat/v1-combined` so we can make a confident **go / no-go** decision on promoting it to v1.

"Properly and carefully" means: every finding is verified before it counts, the review is
gated phase-by-phase (we read results before spending on the next phase), and the output is a
single blocker checklist that gates the upgrade.

## 2. Scope & method (locked decisions)

| Decision | Choice |
|---|---|
| **Scope** | **Entire codebase** on `feat/v1-combined` (not just the diff vs `main`) |
| **Lenses** | All four: **Correctness & bugs**, **Security (CSO/STRIDE/OWASP)**, **Tests & CI health**, **Design & DX** |
| **Method** | **Multi-agent workflow (ultracode)** — parallel subsystem reviewers + adversarial verification |
| **Structure** | **Phased sequential** — 4 workflows, a gated report between each, founder approves before next |
| **Reporting** | **Inline in chat** per phase. This doc is the only committed artifact; findings are delivered conversationally. |

## 3. Status snapshot (local vs remote, captured 2026-06-20)

- `main` ↔ `origin/main`: **in sync** (0/0).
- `feat/v1-combined` ↔ `origin/feat/v1-combined`: **in sync** (0/0). **1341 commits ahead of `main`**, 1 behind (a merge commit on main). HEAD `04bd64c23` (PR-A2 #206).
- `feat/v1-upgrade` (the dirty local worktree we're sitting in): **fully contained inside** `feat/v1-combined`, **494 commits behind** its head; **not pushed** (no upstream). Dirty tree: 2 modified test files + untracked screenshots/plan docs. **This is NOT the thing being shipped.**
- `qa/discussions-verify`: stale (ahead 2 / behind 275 vs combined).
- Recently landed on combined per project memory: **PR-B** (thread-scoped atomic claim, squash `d25a9278e`, merged 2026-06-20). Known open structural follow-ups: **#205** (single-consumer collapse / invariant consolidation), **#204** (idle-lease + GC collapse), **#201** (content-edit governance, deferred).

### Codebase size (feat/v1-combined tree) — 3,850 tracked files

| Module | Files | Module | Files |
|---|---|---|---|
| server/services | 374 | ui/components | 598 |
| server/routes | 79 | ui/pages | 69 |
| server/mcp | 9 | packages/db/schema | 118 |
| server/adapters | 16 | packages/shared | 124 |
| server/__tests__ | 708 | packages/adapters | 229 |
| ui/__tests__ | 169 | docs | 289 |

Version `0.1.0` (Changesets; no VERSION file). CI = 7 workflows; `pr.yml` is the required gate.

## 4. Preconditions

1. **Review reads from the `AoA-prb` worktree** (`C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-prb`), which is already checked out on `feat/v1-combined`. We do **not** disturb the dirty `feat/v1-upgrade` worktree.
2. **Phase 0 baseline is a hard gate.** If combined does not build / typecheck, or the test suite is red, we triage that before any code review — reviewing non-building code wastes the fleet.
3. Each phase's findings are reviewed and approved by the founder before the next phase launches.

## 5. Phase structure

### Phase 0 — Baseline (mostly inline, fast)
Ground truth before opinions:
- `pnpm install` / build / `tsc` typecheck status on combined.
- Test suite: pass/fail counts, **skipped tests** (esp. the Windows e2e skips — Issues #113/#114/#127), LLM-eval suites (skip when `OPENAI_API_KEY` absent).
- CI gate status of `pr.yml` on the latest combined commit.
- Output: a short "is combined healthy enough to review?" verdict. **Gate:** red baseline → fix/triage first.

### Phase 1 — Correctness & bugs (Workflow A)
- One reviewer per subsystem (§6), structured-output findings (`file:line`, reasoning, repro, fix sketch).
- **Adversarial verify**, pipelined: ≥2 independent skeptics try to *refute* each finding; survives only if it can't be refuted. Default-to-refuted on uncertainty.
- Gate output: severity-ranked confirmed bugs (Blocker / High / Medium / Nit).

### Phase 2 — Security (Workflow B)
- **STRIDE across trust boundaries**: MCP actor model (`mcp` vs `board` vs anonymous → 401), RBAC via `buildActor`, tenant isolation (cross-company leakage), secrets handling (`company_secrets.github_pat`, encryption, rotation), injection (SQL via Drizzle raw, command injection in adapter/CLI spawn, path traversal in workspace/file ops), SSRF (marketplace CDN fetch, http adapter, webhooks).
- Per-subsystem OWASP Top 10 pass on security-weighted units.
- Adversarial verify (exploitability-focused): a finding counts only if a plausible attack path is shown.
- Gate output: severity-ranked confirmed vulns + the trust-boundary matrix.

### Phase 3 — Tests/CI + Design/DX (Workflow C)
- **Tests/CI:** coverage gaps on critical paths, skipped/`xfail`/flaky tests, whether the suite actually protects the invariants reviewed in P1/P2, CI matrix soundness (Linux gate vs macOS/Windows advisory).
- **Design/DX:** design-system consistency across UI surfaces (per `docs/architecture/design-system.md`), DX/onboarding friction. UI-weighted units only.
- Gate output: test-coverage blockers + design/DX punch list (mostly non-blocking).

### Phase 4 — Synthesis & gate (Workflow D)
- Dedup + cross-reference all confirmed findings.
- **Conformance check** against `docs/architecture/decisions.md` (90+ locked decisions) and the **Paperclip Divergence Points** (D5 concurrency clamp, D6 hire-approval default, D8 planning-mode dispatch gate) — flag any regression that silently reverts a locked decision.
- Cross-check against known open items (#204, #205, #201).
- Output: **the single v1 go/no-go report** — blocker checklist with owners, plus a prioritized non-blocker backlog.

## 6. Subsystem map + dimension matrix

`C` = Correctness, `S` = Security, `T` = Tests/CI, `D` = Design/DX. Heavier weight in **bold**.

| # | Subsystem | Key paths | Lenses |
|---|---|---|---|
| 1 | Auth & RBAC | `server/routes/auth*`, `user_roles`, `instance_user_roles`, `principal_permission_grants`, `buildActor` | C **S** T |
| 2 | MCP (inbound + outbound) | `server/src/mcp/**` (actor model, 34 outbound tools, 4 resources) | C **S** T |
| 3 | Heartbeat & concurrency | `heartbeat.wakeup`, atomic checkout (`FOR UPDATE NO WAIT`), watchdog, D5 clamp | **C** S T |
| 4 | Memory (4-layer gates) | `memory_items`, approval gates, versioning, feedback patterns | **C** S T |
| 5 | Discussions pipeline | extraction, scope fallback (#61), annotations, thread atomic-claim (PR-B) | **C** S T |
| 6 | Artifacts / documents / task_outputs | immutable versions, branching, artifact-as-input | **C** T |
| 7 | Tasks + dependencies + planning-gate | `issues`, `task_dependencies`, D8 dispatch suppression | **C** T |
| 8 | Workspaces / git isolation | worktree lifecycle, PR creation, `github_pat`, TTL sweeper | C **S** T |
| 9 | Commander / internal agent | CLI-mode exec, SSE, 31 tools, proactive checks | **C** S T |
| 10 | Marketplace + plugins | catalog cache, `derivePackages`, plugin RBAC, `plugin_jobs`, webhooks | C **S** T |
| 11 | Finance / budget / cost | `cost_events`, `budget_policies`, quota windows | **C** T |
| 12 | Company portability | export/import bundles (schemaVersion 2) | C **S** T |
| 13 | Adapters / wire protocol | registry, CLI adapters, Hermes `PAPERCLIP_*` contract | **C** S T |
| 14 | Suggestions / trust / feedback | suggestion engine, trust score formula, feedback votes + redaction | **C** T |
| 15 | DB schema integrity | `packages/db/src/schema/**` (118 files): FK, indexes, migrations, Drizzle-only | **C** S **T** |
| 16 | Shared types / validators | `packages/shared/**` | C **T** |
| 17 | UI surfaces | `ui/src/{pages,components}/**` (workspace, commander, marketplace, discussions, tasks, memory) | C T **D** |

Security weight concentrates on **1, 2, 8, 10, 12, 15**; design/DX on **17**; correctness everywhere.

## 7. Workflow internals (each phase)

Pattern per phase (pipeline, not barrier — verification starts as each review lands):

```
find   → one reviewer per in-scope subsystem; StructuredOutput findings
verify → adversarial skeptics per finding (≥2, default-to-refuted on doubt), pipelined
gate   → severity rank; attach file:line, reasoning, repro, fix sketch
```

Phase 4 adds a dedup + decisions-conformance + completeness-critic pass before emitting the gate report.

## 8. Severity rubric & go/no-go criteria

| Severity | Definition | Effect on v1 gate |
|---|---|---|
| **Blocker** | Data loss/corruption, auth bypass, cross-tenant leakage, silent reversal of a locked decision, build/suite red | **NO-GO** until fixed |
| **High** | Exploitable-but-bounded vuln, correctness bug on a core path, missing test on a critical invariant | Fix before v1, or explicit founder waiver |
| **Medium** | Bug on a non-core path, moderate coverage gap, notable design inconsistency | Track; not a gate |
| **Nit** | Style, minor DX, cosmetic | Backlog |

**GO** = zero Blockers, all Highs fixed-or-waived, with the full trust-boundary matrix green.

## 9. Risks & mitigations

- **Token cost:** large fleet × 4 phases. Mitigated by phased gating (stop anytime), per-subsystem lens scoping, and pipelined verification.
- **False positives:** mitigated by mandatory adversarial verification (default-to-refuted).
- **Stale worktree confusion:** all agents pinned to the `AoA-prb` path; `feat/v1-upgrade` explicitly out of scope.
- **Locked-decision regressions:** explicit conformance pass in Phase 4 against `decisions.md` + Divergence Points.

## 10. Execution order

1. **Phase 0** — baseline (run now, inline).
2. On green/triaged baseline → **Workflow A** (correctness) → report inline → founder approves.
3. → **Workflow B** (security) → report → approve.
4. → **Workflow C** (tests/CI + design/DX) → report → approve.
5. → **Workflow D** (synthesis) → **the v1 go/no-go report**.

Each `→` is a checkpoint: nothing proceeds without founder sign-off.
