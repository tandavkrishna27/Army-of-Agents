# Porting1.1 → v1.0.0 Audit Design

**Session:** Porting1.1 code review audit
**Date:** 2026-04-24
**Status:** Draft — awaiting user review
**Scope:** All 141 commits on `Porting1.1` diverging from `main`, tagged as `v1.0.0`

## Overview

Conduct a comprehensive code review audit of the `Porting1.1` branch covering five dimensions simultaneously: pre-merge regression gate (A), post-release runtime readiness (B), port completeness vs upstream `paperclip-master` (C), security and hardening (D), and combined quality (E). Audit is read-only (F1 policy) — findings only, no fixes. Depth is L4 (static + test execution + runtime smoke + cross-platform).

The audit produces **one master findings document** that maps every finding back to dimensions A–E, plus a `.changeset` mirror matching existing convention.

## Why

`v1.0.0` has been tagged from `Porting1.1` with 929 files changed and +158,638 / −8,143 LOC. Sprints 1–4 closed 23 findings (A–X, alphabetically). This audit is the final independent pass before merging `Porting1.1` → `main` and validates that:

1. Nothing quietly regressed during the polish-and-release sprints
2. The port is actually complete vs upstream (or intentionally deferred items are documented)
3. Windows-specific and pgvector-free install paths behave correctly
4. Security posture is acceptable for a shipped v1.0

## 1. Agent Dispatch Map

Eight parallel Phase 1 agents plus two serial runtime phases.

### Phase 1 — Static sweep (6 parallel agents)

| Agent | Scope | Files | Commits | Dimensions | Model | Letter range |
|---|---|---:|---:|---|---|---|
| **S1 Server** | `server/` | 357 | 79 | A, B, C, D, E | opus | AD-A … AD-Z |
| **S2 UI** | `ui/` | 237 | 58 | A, C, D, E | opus | AD-AA … AD-AZ |
| **S3 CLI + Commander** | `cli/` + cross-repo Windows-shell fix (`93281d5`) | 56+ | 10 | A, D, E | sonnet | AD-BA … AD-BZ |
| **S4 DB + Adapters** | `packages/db` + `packages/adapters` | 83 | 14 | A, C, D, E | sonnet | AD-CA … AD-CZ |
| **S5 Plugins + Shared + AdapterUtils** | `packages/{plugins,shared,adapter-utils}` | 72 | 51 | A, C, D, E | sonnet | AD-DA … AD-DZ |
| **S6 Infra surface** | `tests/`, `evals/`, `scripts/`, `docker/`, `.github/`, `docs/` | ~60 | 30 | A, B, D | sonnet | AD-EA … AD-EZ |

### Phase 1b — Cross-cutting (2 parallel agents)

| Agent | Scope | Dimensions | Model | Letter range |
|---|---|---|---|---|
| **X1 Rebrand/Identity** | Whole branch. Grep for `paperclip`, `Paperclip`, `PCP_`, `pcp_*`, `paperclip-*`; validate `aoa_*` / `aoa.*` replacements; verify `legacy-key alias` path. | C, D | sonnet | AD-FA … AD-FZ |
| **X2 Port parity** | Diff `AoA-2.5/` ↔ `paperclip-master/` to catalog dropped/stubbed features. Cross-check against memory's "deferred to 1.1" list. | C | opus | AD-GA … AD-GZ |

### Dispatch mechanics

- All 8 agents launched in a single message, `subagent_type: superpowers:code-reviewer`
- `isolation: "worktree"` for each — agents are read-only so worktrees auto-clean
- Foreground (need reports before consolidation); wall-clock bounded by slowest agent
- Truncation: S3, S4, S5, S6, X1, X2 cap at 20 findings; S1 and S2 soft-cap at 40. Cap-hit reports include a "TRUNCATED — N more findings seen" note.

## 2. Findings Taxonomy & Format

### Severity (4 levels)

| Level | Meaning | Action expected |
|---|---|---|
| 🔴 Critical | Data loss, security breach, or core flow broken on a realistic install | Hotfix, cut `v1.0.1` |
| 🟠 High | Regression or incorrect behavior under normal use, workaround exists | Fix before next feature release |
| 🟡 Medium | Quality/UX/maintainability issue; path works | 1.1 backlog |
| 🟢 Low | Nit, dead code, doc drift, stylistic | Batch cleanup commit |

### Finding schema (per entry in master doc)

```markdown
### AD-<ID> — <title>

- **Severity:** 🔴 | 🟠 | 🟡 | 🟢
- **Dimension:** A | B | C | D | E (or combinations)
- **Area:** <file or subsystem>
- **Phase found:** Phase 1/<agent> | Phase 2/<step> | Phase 3<a|b|c>
- **Evidence:** <file:line references — required>
- **Repro:** <command or click path — runtime only>
- **Impact:** <what could go wrong>
- **Suggested fix:** <concrete, actionable>
- **Confidence:** High | Medium | Low
- **Traces to:** <commit hash if known, else "unknown">
```

### Naming

- Namespace: `AD-A`, `AD-B`, … `AD-Z`, `AD-AA`, `AD-AB` …
- Per-agent letter ranges (Section 1 table) keep raw reports independent
- Consolidation step renumbers sequentially from AD-A in the master doc

### File locations

- **Master doc**: `docs/superpowers/specs/2026-04-24-v1.0.0-audit-findings.md` — full detail
- **Changeset mirror**: `.changeset/v1-0-0-audit-findings.md` — summary + severity rollup, `"aoa": none` (no version bump)
- **Raw per-agent reports**: `docs/superpowers/specs/audit-raw/{S1,S2,S3,S4,S5,S6,X1,X2}.md` — retained for traceability
- **Runtime logs**: `docs/superpowers/specs/audit-raw/logs/<step>.log` + `_summary.tsv`

### "What looks good" section

Master doc ends with positive observations merged from each agent's report.

## 3. Runtime Verification Runbook

### Failure policy

**Log-and-continue.** Every command runs regardless of prior failures. Each non-green outcome becomes a finding; consolidation assigns severity. The only hard-halt is `pnpm install` — nothing downstream is meaningful without it.

All stdout+stderr stream to `audit-raw/logs/<step>.log`. Exit codes captured in `audit-raw/logs/_summary.tsv`.

### Phase 2 — Single-host runbook

| # | Command | Expected green | On fail |
|--:|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | exit 0; lockfile unchanged | **HARD HALT** — abort, file Critical |
| 2 | `pnpm typecheck` | exit 0, no `error TS` | Capture errors; continue |
| 3 | `pnpm build` | exit 0, all packages emit | File finding; continue |
| 4 | `pnpm test:run` | vitest: 0 failed, skipped ≤ known baselines | Record failing specs, note delta |
| 5 | `pnpm test:e2e` | playwright: 0 failed | Save **failed-only** traces |
| 6 | `pnpm test:release-smoke` | 0 failed | Finding in dimension B |
| 7 | `pnpm evals:smoke` | promptfoo: no regression vs last tagged baseline | Finding if score drops |
| 8 | `pnpm check:tokens` | exit 0, no forbidden tokens | Finding in dimension C/Q regression |
| 9 | `pnpm docker:smoke` | container healthy, onboard flow completes | Finding in dimension B + D |
| 10 | `pnpm smoke:openclaw-join` | exit 0 | File finding |
| 11 | `pnpm smoke:openclaw-docker-ui` | exit 0 | File finding |
| 12 | `pnpm smoke:openclaw-sse-standalone` | exit 0 | File finding |

### Phase 2b — UI golden path

After step 3 succeeds, boot `pnpm dev` via `preview_start`; exercise eight flows with `preview_snapshot` + `preview_console_logs` + `preview_network` captured per flow:

1. **Auth** — sign in with CLI token; verify session
2. **Chat** — send message in default company; agent responds via Commander CLI path (not API adapter)
3. **Workspace spawn** — create execution workspace, verify heartbeat filter, close, verify `cleanup_failed` retry (Finding H behavior)
4. **Plugin system** — list plugins, verify namespace `aoa.*|aoa-*`, install one, run its command
5. **Settings** — every tab loads; Backups hidden (Finding X); Budget Create button present (Finding L)
6. **Budget** — create policy, verify hard-stop + warn-threshold persist, delete policy (Finding M)
7. **Memory** — save a memory → complete a goal → verify archive hook does not 500 (Finding S/J guard)
8. **Routing 404** — hit an unknown route, verify proper 404 (Finding B)

### Phase 3 — Cross-platform

- **P3a Linux/Docker** — covered by step 9 (`docker:smoke`) + step 11 (`openclaw-docker-ui`); no separate run
- **P3b Windows-native** — on this host: run `pnpm aoa` directly, spawn a session, exercise `93281d5` shell-escape against payloads with `$`, backtick, newline, `"`; repro Finding H race in a fresh run
- **P3c pgvector-free** — stand up throwaway Postgres *without* pgvector, point AoA via `DATABASE_URL`, run Phase 2b flows 2 + 7. Only way to actually prove Finding J v2 fix

### Excluded

- `scripts/release.sh` — already ran for `v1.0.0`, re-running churns registry
- `build:npm` — separate concern from branch health
- `docs:dev` — static site; drift caught by S6 and Phase 2b flow 5

## 4. Agent Briefing Template

Every Phase 1 / 1b agent receives a prompt from this skeleton. Per-agent scope block and letter range inserted as indicated.

### Shared preamble

```
You are auditing branch `Porting1.1` of the AoA repo at
C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-2.5.
Base branch is `main`. 141 commits diverge.

CONTEXT:
- This is a port of the upstream `paperclip-master` project. Reference copy is at
  C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\paperclip-master\.
- `v1.0.0` was tagged from this branch. Sprints 1–4 closed 23 findings (A–X, some
  letters skipped). See `.changeset/v1-0-0-*.md` — do not re-file them unless you
  see a regression.
- Conventions: read `AoA-2.5/CLAUDE.md` and `AoA-2.5/AGENTS.md` first.

YOUR SCOPE: <INSERTED PER AGENT>

DIMENSIONS TO APPLY: <FROM SECTION 1 TABLE>
- A Pre-merge gate
- B Post-release runtime
- C Port completeness
- D Security & hardening
- E Combined quality

Only report dimensions listed in YOUR SCOPE; findings outside your scope go in
a brief "Out of scope, noted" section at the end.

YOU MUST NOT:
- Edit any file. Read-only audit (F1 policy).
- Run tests, builds, or dev servers. Phase 2 handles execution.
- Spawn sub-agents.
- Re-file closed findings unless you see a regression; flag as "REGRESSION of
  Finding <X>" if you do.

DELIVERABLE:
Write your report to `docs/superpowers/specs/audit-raw/<AGENT-ID>.md`:

  # Audit Report — <AGENT-ID> <Agent Name>

  ## Summary
  <3–5 sentences: what you reviewed, overall health, headline concerns>

  ## Findings
  ### AD-<LETTER> — <one-line title>
  - **Severity:** 🔴 | 🟠 | 🟡 | 🟢
  - **Dimension:** A | B | C | D | E (or combinations)
  - **Area:** <file or subsystem>
  - **Evidence:** <file:line references — required>
  - **Impact:** <what could go wrong>
  - **Suggested fix:** <concrete, actionable>
  - **Confidence:** High | Medium | Low
  - **Traces to:** <commit hash if known, else "unknown">

  ## What looks good
  <required bullet list>

  ## Out of scope, noted
  <title + file:line only, no full schema>

NAMESPACE: reserve letters from <AGENT RANGE>. Exceed → suffix -2 (AD-A-2).

TRUNCATION: if >20 findings (S3/S4/S5/S6/X1/X2) or >40 (S1/S2), stop and return
"TRUNCATED — N more findings seen".

When finished, respond with ONLY the path to your report file.
```

### Per-agent scope blocks

| Agent | Scope block text |
|---|---|
| **S1** | `server/` — routes, services, middleware, DB queries, auth, tenant scoping, error handling, SSE, routing 404 (Finding B context) |
| **S2** | `ui/` — components, routes, state, forms, a11y (Findings E/F/I/O/P/R/T polish), XSS-relevant rendering, auth-routing |
| **S3** | `cli/` + any file touching CLI spawn or Commander in `server/`. Focus: `93281d5` Windows-shell escape, command-injection surface |
| **S4** | `packages/db` + `packages/adapters`. Schema, migrations, pgvector guards, adapter parity vs upstream, credential handling |
| **S5** | `packages/{plugins,shared,adapter-utils}`. Plugin namespace `aoa.*|aoa-*` + legacy-alias, sandboxing, shared rebrand churn |
| **S6** | `tests/`, `evals/`, `scripts/`, `docker/`, `.github/`, top-level `docs/`. CI gates, release-smoke wiring, Dockerfile hardening, eval baseline drift |
| **X1** | Whole branch. Grep `paperclip`, `Paperclip`, `PCP_`, `pcp_*`, `paperclip-*`; validate `aoa_*` / `aoa.*`; verify legacy-key alias by reading code |
| **X2** | Compare `AoA-2.5/` ↔ `paperclip-master/`. Catalog features upstream but missing/stubbed. Cross-check against memory's "deferred to 1.1" list |

## 5. Consolidation & Traceability

Performed by main session (me) after all 8 agents return and runtime phases complete.

### Inputs

- `audit-raw/{S1,S2,S3,S4,S5,S6,X1,X2}.md` — 8 raw reports
- `audit-raw/logs/_summary.tsv` — Phase 2 exit codes
- `audit-raw/logs/<step>.log` — Phase 2 command outputs
- Phase 2b flow snapshots + console logs + network traces
- Phase 3b Windows escape-test output
- Phase 3c pgvector-free session transcript

### Consolidation steps

1. **Parse** all raw reports into a single findings list in memory
2. **Dedup**: findings from different agents that reference the same `file:line ± 10` and same dimension collapse to one, merging Evidence/Impact/Suggested-fix fields; both agent IDs recorded under `Traces to`
3. **Add runtime findings**: each Phase 2 step that failed, each Phase 2b flow that hit unexpected state, each Phase 3 deviation gets a finding appended
4. **Renumber** sequentially from `AD-A` in final doc (per-agent ranges are only to prevent raw-report collision)
5. **Severity rollup**: table at top of master doc — counts of 🔴/🟠/🟡/🟢 × A/B/C/D/E
6. **Write** master doc `2026-04-24-v1.0.0-audit-findings.md`
7. **Write** changeset mirror `.changeset/v1-0-0-audit-findings.md` — matches existing style (prose, not full schema), names the `🔴` / `🟠` findings inline, links master doc
8. **Commit** both docs in a single commit: `audit: v1.0.0 comprehensive review — N findings (X critical, Y high)`

### Master doc structure

```
# v1.0.0 Audit Findings — Porting1.1

## Summary
<overall verdict: Approve / Merge-with-fixes / Block>

## Severity × Dimension rollup
<4x5 table>

## Critical findings
<full schema, severity ordered>

## High findings
## Medium findings
## Low findings

## Runtime results
<Phase 2 / 2b / 3 summary table — pass/fail per step>

## What looks good
<merged positives from all 8 agents>

## Traceability appendix
<AD-<ID> → originating agent(s) → commit hash(es) → dimension(s)>
```

### Dedup heuristic

Two findings merge if all three hold:
- Same file OR (same subsystem AND same symbol name)
- Line numbers within ±10
- Same primary dimension

Partial matches flagged as "Related: AD-X" cross-ref rather than merged.

## 6. Risks, Exit Criteria, and Abort Policy

### Risks to the audit itself

| Risk | Mitigation |
|---|---|
| Agents hallucinate file paths or line numbers | Each finding requires `file:line` evidence; consolidation spot-checks Critical/High against actual files |
| Parallel worktree collisions or disk exhaustion | `isolation: "worktree"` gives each agent its own copy; user informed if disk runs low |
| Token cost for 8-agent fan-out (S1/S2 are big) | Truncation caps + one-shot prompts; no multi-turn iteration |
| Duplicate findings inflating count | Dedup heuristic in consolidation step |
| Runtime commands hang (dev servers, docker) | All long-runs via `run_in_background` with 10-min timeout; killed if no progress |
| Phase 2 step masking a real issue by log-and-continue policy | Every non-green exit captured as a finding; consolidation reviews all |
| Interrupted audit loses work | Raw reports + logs land on disk before consolidation; session-resumable |

### Exit criteria (all must hold)

1. All 8 Phase 1 agents returned with report files present
2. `audit-raw/logs/_summary.tsv` has a row per Phase 2 step
3. Phase 2b flow snapshots written for all 8 flows (or their failures logged)
4. Phase 3b Windows escape-test has a log
5. Phase 3c pgvector-free transcript has a log
6. Master doc written and committed
7. Changeset mirror written and committed

### Abort policy

Hard-halt only on:
- `pnpm install` fails → audit cannot proceed; file Critical, exit
- All 8 Phase 1 agents return empty/errored → environmental problem, exit
- User interrupt at any point → save what's done to disk, stop

### Rollback

Raw reports and logs are the source of truth. If consolidation goes wrong or master doc is rejected, raw artifacts remain in `audit-raw/` and can be reconsolidated without re-running any agent or command.

## 7. Deliverables

On successful completion:

1. `docs/superpowers/specs/2026-04-24-v1.0.0-audit-findings.md` — master findings doc
2. `.changeset/v1-0-0-audit-findings.md` — changeset mirror summary
3. `docs/superpowers/specs/audit-raw/*.md` — 8 raw agent reports (retained)
4. `docs/superpowers/specs/audit-raw/logs/*.log` — Phase 2/2b/3 logs
5. One git commit on `Porting1.1` (audit docs only, no code changes per F1)

## 8. Out of scope

- Fixing anything found (F1 policy — report only)
- Re-running upstream Paperclip's tests against `paperclip-master` for comparison
- Deep performance profiling or load testing
- Third-party dependency CVE audit (npm audit is separate)
- Publishing findings externally (internal doc only)
