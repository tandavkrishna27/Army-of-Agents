# Porting1.1 → v1.0.0 Audit Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the comprehensive audit of branch `Porting1.1` / tag `v1.0.0` per the design at `docs/superpowers/specs/2026-04-24-porting1-audit-design.md`, producing a master findings document plus changeset mirror.

**Architecture:** Orchestration plan (not TDD). Eight parallel Phase 1 review subagents produce raw reports; a runtime verification runbook runs 12 commands + 8 UI flows; cross-platform smoke runs against Windows-native and pgvector-free installs; consolidation merges everything into one master doc. F1 policy: read-only, findings only, no fixes.

**Tech Stack:** pnpm 9.15 monorepo, vitest, playwright, promptfoo, embedded-postgres + pgvector, Commander CLI, Drizzle, React/Vite UI. Review agents via `superpowers:code-reviewer` subagent type. UI verification via `preview_*` tools. Runtime commands via Bash.

**Working directory for all commands:** `C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-2.5` (referred to below as `$AOA`).

---

## File Structure

### Created during audit

| Path | Created by | Purpose |
|---|---|---|
| `docs/superpowers/specs/audit-raw/S1.md` | Phase 1 agent S1 | Server static-review report |
| `docs/superpowers/specs/audit-raw/S2.md` | Phase 1 agent S2 | UI static-review report |
| `docs/superpowers/specs/audit-raw/S3.md` | Phase 1 agent S3 | CLI+Commander report |
| `docs/superpowers/specs/audit-raw/S4.md` | Phase 1 agent S4 | DB+Adapters report |
| `docs/superpowers/specs/audit-raw/S5.md` | Phase 1 agent S5 | Plugins+Shared+AdapterUtils report |
| `docs/superpowers/specs/audit-raw/S6.md` | Phase 1 agent S6 | Infra surface report |
| `docs/superpowers/specs/audit-raw/X1.md` | Phase 1b agent X1 | Rebrand/identity sweep |
| `docs/superpowers/specs/audit-raw/X2.md` | Phase 1b agent X2 | Port-parity vs paperclip-master |
| `docs/superpowers/specs/audit-raw/logs/_summary.tsv` | Phase 2 runner | Per-step exit codes |
| `docs/superpowers/specs/audit-raw/logs/<step>.log` | Phase 2 runner | Per-command stdout+stderr |
| `docs/superpowers/specs/audit-raw/flow-<N>.md` | Phase 2b runner | One per UI golden-path flow |
| `docs/superpowers/specs/audit-raw/windows-escape.md` | Phase 3b runner | Windows CLI escape-test results |
| `docs/superpowers/specs/audit-raw/pgvector-free.md` | Phase 3c runner | pgvector-free install test results |
| `docs/superpowers/specs/2026-04-24-v1.0.0-audit-findings.md` | Consolidation (Task 7) | **Master findings doc** |
| `.changeset/v1-0-0-audit-findings.md` | Consolidation (Task 7) | Changeset mirror (no version bump) |

### Read, never modified

- `paperclip-master/` — upstream reference for port-parity (X2 agent)
- Any file under `AoA-2.5/` outside `docs/superpowers/specs/audit-raw/` — F1 policy is read-only

---

## Task 1: Pre-flight environment check

**Files:**
- Verify: `docs/superpowers/specs/audit-raw/logs/` exists (created during brainstorm)
- Create: `docs/superpowers/specs/audit-raw/logs/_summary.tsv`

- [ ] **Step 1.1: Verify branch state**

Run: `cd "$AOA" && git status --porcelain && git branch --show-current && git rev-parse HEAD`

Expected: branch is `Porting1.1`, HEAD is `f5f00cf` (`release: v1.0.0 — 23 findings closed, regression green`), working tree clean.

On fail: abort. If on wrong branch, have the user confirm before proceeding.

- [ ] **Step 1.2: Verify paperclip-master reference exists**

Run: `ls "/c/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/paperclip-master" | head`

Expected: directory exists with files. Required for X2 port-parity agent.

On fail: abort X2 agent specifically, proceed with other 7.

- [ ] **Step 1.3: Verify audit-raw tree**

Run: `ls "$AOA/docs/superpowers/specs/audit-raw/" && ls "$AOA/docs/superpowers/specs/audit-raw/logs/"`

Expected: both directories exist (created during brainstorm).

On fail: `mkdir -p "$AOA/docs/superpowers/specs/audit-raw/logs"`.

- [ ] **Step 1.4: Initialize summary TSV**

Create `docs/superpowers/specs/audit-raw/logs/_summary.tsv` with this exact content (one header line, tab-separated):

```
step	command	exit_code	started_at	finished_at	notes
```

- [ ] **Step 1.5: No commit yet**

Raw scaffold stays uncommitted. Per spec Section 7, all audit artifacts (raw reports, logs, master doc, changeset) land in a **single commit** at Task 7.8. Intermediate state persists on disk for resumability; nothing is lost if the session is interrupted.

---

## Task 2: Dispatch 8 parallel Phase 1 / 1b review agents

**Approach:** Launch all 8 agents in a **single** Agent-tool multi-call message so they run concurrently. Each uses `subagent_type: superpowers:code-reviewer`, `isolation: "worktree"`. Models per spec Section 1: S1/S2/X2 on opus; S3/S4/S5/S6/X1 on sonnet. Foreground (need results before consolidation).

- [ ] **Step 2.1: Build the shared-preamble string**

Use this exact text as the prefix of every agent's prompt (substitute `{SCOPE_BLOCK}`, `{DIMENSIONS}`, `{LETTER_RANGE}`, `{CAP}`, `{AGENT_ID}` per agent):

```
You are auditing branch `Porting1.1` of the AoA repo at
C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-2.5.
Base branch is `main`. 141 commits diverge. Tag `v1.0.0` is on HEAD (f5f00cf).

CONTEXT:
- Port of upstream paperclip; reference copy at
  C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\paperclip-master\.
- Sprints 1–4 closed 23 findings A–X (skipped letters). See
  .changeset/v1-0-0-*.md. Do NOT re-file closed findings unless you see a
  regression; if so, flag as "REGRESSION of Finding <X>".
- Conventions: read AoA-2.5/CLAUDE.md and AoA-2.5/AGENTS.md first.

YOUR SCOPE: {SCOPE_BLOCK}
DIMENSIONS TO APPLY: {DIMENSIONS}
  A Pre-merge gate; B Post-release runtime; C Port completeness;
  D Security & hardening; E Combined quality

Report only dimensions listed above. Other-dimension observations go in
"Out of scope, noted".

YOU MUST NOT:
- Edit any file. Read-only audit (F1).
- Run tests, builds, dev servers. Phase 2 handles execution separately.
- Spawn sub-agents.

DELIVERABLE:
Write report to docs/superpowers/specs/audit-raw/{AGENT_ID}.md using:

  # Audit Report — {AGENT_ID} <Agent Name>
  ## Summary
  <3–5 sentences>
  ## Findings
  ### AD-<LETTER> — <title>
  - **Severity:** 🔴 Critical | 🟠 High | 🟡 Medium | 🟢 Low
  - **Dimension:** A | B | C | D | E (or combinations)
  - **Area:** <file or subsystem>
  - **Evidence:** <file:line — required>
  - **Impact:** <what could go wrong>
  - **Suggested fix:** <concrete, actionable>
  - **Confidence:** High | Medium | Low
  - **Traces to:** <commit hash, else "unknown">
  ## What looks good
  <required bullet list>
  ## Out of scope, noted
  <title + file:line only>

NAMESPACE: use letters from {LETTER_RANGE}. Exceed → suffix -2 (AD-A-2).
TRUNCATION: if findings exceed {CAP}, stop and return
  "TRUNCATED — N more findings seen".

When finished, reply with ONLY the path to your report file.
```

- [ ] **Step 2.2: Build per-agent prompts from the template**

Eight substitutions. Record each full prompt in memory for Step 2.3:

| Agent | `{AGENT_ID}` | `{SCOPE_BLOCK}` | `{DIMENSIONS}` | `{LETTER_RANGE}` | `{CAP}` | Model |
|---|---|---|---|---|---|---|
| S1 | `S1` | `server/` — routes, services, middleware, DB queries, auth, tenant scoping, error handling, SSE, routing 404 (Finding B context) | A, B, C, D, E | AD-A..AD-Z | 40 | opus |
| S2 | `S2` | `ui/` — components, routes, state, forms, a11y (Findings E/F/I/O/P/R/T polish), XSS-relevant rendering, auth-routing | A, C, D, E | AD-AA..AD-AZ | 40 | opus |
| S3 | `S3` | `cli/` + any file touching CLI spawn or Commander in `server/`. Focus: `93281d5` Windows-shell escape, command-injection surface | A, D, E | AD-BA..AD-BZ | 20 | sonnet |
| S4 | `S4` | `packages/db` + `packages/adapters`. Schema, migrations, pgvector guards, adapter parity vs upstream, credential handling | A, C, D, E | AD-CA..AD-CZ | 20 | sonnet |
| S5 | `S5` | `packages/{plugins,shared,adapter-utils}`. Plugin namespace `aoa.*|aoa-*` + legacy-alias, sandboxing, shared rebrand churn | A, C, D, E | AD-DA..AD-DZ | 20 | sonnet |
| S6 | `S6` | `tests/`, `evals/`, `scripts/`, `docker/`, `.github/`, top-level `docs/`. CI gates, release-smoke wiring, Dockerfile hardening, eval baseline drift | A, B, D | AD-EA..AD-EZ | 20 | sonnet |
| X1 | `X1` | Whole branch. Grep `paperclip`, `Paperclip`, `PCP_`, `pcp_*`, `paperclip-*`; validate `aoa_*` / `aoa.*` replacements; verify legacy-key alias path by reading code | C, D | AD-FA..AD-FZ | 20 | sonnet |
| X2 | `X2` | Compare `AoA-2.5/` ↔ `paperclip-master/`. Catalog features upstream but missing/stubbed here. Cross-check against memory's "deferred to 1.1" list | C | AD-GA..AD-GZ | 20 | opus |

- [ ] **Step 2.3: Dispatch all 8 agents in a single message**

Single message containing 8 `Agent` tool calls, each with:
- `description`: `"Audit agent <AGENT_ID>: <scope-short>"` (e.g., `"Audit agent S1: server static review"`)
- `subagent_type`: `"superpowers:code-reviewer"`
- `model`: per table above
- `isolation`: `"worktree"`
- `run_in_background`: `false`
- `prompt`: the full per-agent prompt from Step 2.2

Expected: agents run concurrently. Wall-clock ≈ slowest agent (likely S1 server, ~10–20 min on opus).

- [ ] **Step 2.4: Collect and verify all 8 report files**

Run: `ls -la "$AOA/docs/superpowers/specs/audit-raw/"*.md 2>&1`

Expected: 8 files present — `S1.md`, `S2.md`, `S3.md`, `S4.md`, `S5.md`, `S6.md`, `X1.md`, `X2.md`. Each > 1 KB.

On fail: re-dispatch only the missing agent. If an agent returns an error instead of a report path, capture the error in `audit-raw/S<N>-error.log` and note it as environmental rather than a real finding.

- [ ] **Step 2.5: Quick sanity scan of each report**

For each of the 8 files, read first 40 lines and verify:
- Begins with `# Audit Report — <ID>`
- Contains a `## Summary` section
- Contains at least a `## What looks good` section

This is a format check only, not content review — consolidation handles content.

On fail: mark the report as malformed, record the issue, proceed. Consolidation will handle best-effort parse.

- [ ] **Step 2.6: Keep raw reports on disk, no commit yet**

Raw reports remain uncommitted until Task 7.8 (single-commit policy). They are on disk and survive session interrupts; consolidation can be re-run against them without re-dispatching agents.

---

## Task 3: Phase 2 — Runtime command runbook (12 steps)

**Failure policy:** log-and-continue. Every command runs regardless of prior failures. Only `pnpm install` failing is a hard-halt.

**Logging convention (applies to every sub-step):**

```bash
cd "$AOA"
NAME="<step-name>"
LOG="docs/superpowers/specs/audit-raw/logs/${NAME}.log"
START=$(date -Iseconds)
{ <command>; } >"$LOG" 2>&1
EXIT=$?
FINISH=$(date -Iseconds)
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$NAME" "<cmd>" "$EXIT" "$START" "$FINISH" "" \
  >> docs/superpowers/specs/audit-raw/logs/_summary.tsv
```

Each step below uses this pattern; only `<step-name>`, `<command>`, and `<cmd>` vary.

- [ ] **Step 3.1: `pnpm install --frozen-lockfile`**

`<step-name>` = `01-install`, `<command>` = `pnpm install --frozen-lockfile`

Expected exit code: 0. Lockfile unchanged afterwards.

On non-zero exit: **HARD HALT.** File a Critical finding `AD-install-fail` inline in `audit-raw/install-failure.md` with exit code + last 50 log lines, then abort remaining Phase 2 steps.

- [ ] **Step 3.2: `pnpm typecheck`**

`<step-name>` = `02-typecheck`, `<command>` = `pnpm typecheck`

Expected exit code: 0. Memory says "Typecheck 0" on `Porting1.1`. Any `error TS` line is a regression.

On non-zero exit: continue to next step. Record error lines in the log for consolidation to turn into findings.

- [ ] **Step 3.3: `pnpm build`**

`<step-name>` = `03-build`, `<command>` = `pnpm build`

Expected: exit 0, every package emits to its `dist/` (or equivalent).

On fail: continue. Build failures block subsequent steps that need built artifacts; note but press on.

- [ ] **Step 3.4: `pnpm test:run`**

`<step-name>` = `04-test-unit`, `<command>` = `pnpm test:run`

Expected: Vitest summary with 0 failed. Memory says "test failures match known baselines" — delta vs baselines is what matters.

On non-zero exit: record failing spec names + error messages from log. Each unique failing spec becomes a candidate finding (consolidation may merge).

- [ ] **Step 3.5: `pnpm test:e2e`**

`<step-name>` = `05-test-e2e`, `<command>` = `pnpm test:e2e`

Expected: playwright, 0 failed.

Traces policy: Playwright auto-saves traces. After the run, keep only traces of **failed** specs; remove the rest to save disk. Command:

```bash
# After test:e2e finishes, prune passing traces if a trace dir exists:
find test-results -type d -name "*-passed" -exec rm -rf {} + 2>/dev/null || true
```

On fail: findings per failing spec.

- [ ] **Step 3.6: `pnpm test:release-smoke`**

`<step-name>` = `06-test-release-smoke`, `<command>` = `pnpm test:release-smoke`

Expected: 0 failed.

On fail: finding(s) in dimension B.

- [ ] **Step 3.7: `pnpm evals:smoke`**

`<step-name>` = `07-evals-smoke`, `<command>` = `pnpm evals:smoke`

Expected: promptfoo smoke eval passes against existing baseline.

On fail: finding(s); include score delta.

- [ ] **Step 3.8: `pnpm check:tokens`**

`<step-name>` = `08-check-tokens`, `<command>` = `pnpm check:tokens`

Expected: exit 0; no forbidden-token matches.

On fail: each match is a finding (dimension C + Q regression). X1 agent may also have surfaced these; consolidation dedupes.

- [ ] **Step 3.9: `pnpm docker:smoke`**

`<step-name>` = `09-docker-smoke`, `<command>` = `pnpm docker:smoke`

Expected: container builds, onboard-smoke flow completes end-to-end.

This step takes 5–15 minutes. Run it with `timeout: 900000` (15 min) on the Bash tool.

On fail: findings in dimensions B + D.

- [ ] **Step 3.10: `pnpm smoke:openclaw-join`**

`<step-name>` = `10-smoke-openclaw-join`, `<command>` = `pnpm smoke:openclaw-join`

Expected: exit 0.

- [ ] **Step 3.11: `pnpm smoke:openclaw-docker-ui`**

`<step-name>` = `11-smoke-openclaw-docker-ui`, `<command>` = `pnpm smoke:openclaw-docker-ui`

Expected: exit 0. Docker-heavy; 10-min timeout.

- [ ] **Step 3.12: `pnpm smoke:openclaw-sse-standalone`**

`<step-name>` = `12-smoke-openclaw-sse-standalone`, `<command>` = `pnpm smoke:openclaw-sse-standalone`

Expected: exit 0.

- [ ] **Step 3.13: Verify `_summary.tsv` has 12 rows**

Run:
```bash
wc -l "$AOA/docs/superpowers/specs/audit-raw/logs/_summary.tsv"
```

Expected: 13 (header + 12 steps). If fewer, identify the missing step and rerun it alone.

---

## Task 4: Phase 2b — UI golden path (8 flows via `preview_*` tools)

**Pre-condition:** Task 3 step 3.3 (`build`) succeeded OR at minimum `dev` servers start. If build failed catastrophically, skip this task and record a finding.

- [ ] **Step 4.1: Start the dev server**

Use `preview_start` with the repo root. Command target: `pnpm dev`. Wait for both server and UI to report ready (check `preview_logs` until stable).

On fail: record in `audit-raw/flow-_boot.md` and skip remaining flows.

- [ ] **Step 4.2: Flow 1 — Auth**

1. `preview_snapshot` the landing / sign-in route
2. Complete sign-in using a CLI-generated token (if session-less, note and skip)
3. `preview_snapshot` the post-auth dashboard
4. `preview_console_logs` — expect no errors
5. Save combined output to `audit-raw/flow-1-auth.md`

Any unexpected error or missing element → candidate finding.

- [ ] **Step 4.3: Flow 2 — Chat**

1. Navigate to default company's chat view
2. Send a test message via `preview_fill` + submit
3. `preview_network` — verify request goes to Commander CLI route (not legacy `/api/claude` or `/api/openai`)
4. `preview_snapshot` — agent response appears
5. Save to `audit-raw/flow-2-chat.md`

- [ ] **Step 4.4: Flow 3 — Workspace spawn + cleanup_failed retry**

1. Create new execution workspace via UI
2. `preview_network` — verify heartbeats filter correctly (Finding V)
3. Close workspace
4. If cleanup fails, verify sweeper retries (Finding H — may not repro in a single UI session, note if unverifiable here)
5. Save to `audit-raw/flow-3-workspace.md`

- [ ] **Step 4.5: Flow 4 — Plugin system**

1. Navigate to plugins list
2. Verify namespace appears as `aoa.*` or `aoa-*` (not `paperclip.*`)
3. Install a test plugin
4. Invoke one of its commands
5. `preview_snapshot` of installed-plugins list
6. Save to `audit-raw/flow-4-plugins.md`

- [ ] **Step 4.6: Flow 5 — Settings**

1. Open Instance Settings
2. Iterate every tab; `preview_snapshot` each
3. Verify **Backups tab is hidden** (Finding X)
4. Verify **Budget tab** shows a Create button (Finding L)
5. Save to `audit-raw/flow-5-settings.md`

- [ ] **Step 4.7: Flow 6 — Budget policy create + delete**

1. Open `/TES/budget` or `/TES/settings?tab=budget`
2. Click Create; fill company-scope, monthly limit, warn-threshold, hard-stop toggle
3. Save — verify it persists (reload page and re-check)
4. Delete the policy (Finding M)
5. Save to `audit-raw/flow-6-budget.md`

- [ ] **Step 4.8: Flow 7 — Memory + goal archive hook**

1. Save a memory via the memory UI
2. Create a goal, mark it complete
3. `preview_console_logs` + `preview_network` — verify no 500 on the archive hook (Finding S/J guard)
4. Save to `audit-raw/flow-7-memory.md`

- [ ] **Step 4.9: Flow 8 — Routing 404**

1. Navigate to a non-existent route (e.g., `/nonexistent-xyz`)
2. `preview_snapshot` — proper 404 UI (Finding B)
3. `preview_network` — server returns 404 with a sensible body
4. Save to `audit-raw/flow-8-404.md`

- [ ] **Step 4.10: Stop dev server and record summary**

`preview_stop`. Append a row to `_summary.tsv` per flow with pass/fail.

- [ ] **Step 4.11: Verify flow artifacts are on disk, no commit yet**

Expected: `flow-1-auth.md` through `flow-8-404.md` exist under `audit-raw/`, and `_summary.tsv` has a row per flow. All artifacts wait until Task 7.8 single commit.

---

## Task 5: Phase 3b — Windows-native verification

**Host:** this Windows 11 machine (native, not WSL / not docker).

- [ ] **Step 5.1: Run `pnpm aoa` directly**

Run:
```bash
cd "$AOA"
pnpm aoa --help
```

Expected: CLI usage prints, exit 0. Verifies Commander CLI default path works on Windows.

- [ ] **Step 5.2: Escape-test payloads against `93281d5` fix**

Spawn a CLI command with user-content that contains each of these characters:

| Payload | Purpose |
|---|---|
| `test$var` | Shell variable expansion |
| ``test`whoami` `` | Backtick command substitution |
| `test"quoted"` | Embedded double-quotes |
| `line1<newline>line2` | Newline injection |
| `test && echo pwned` | Command chaining |
| `test; echo pwned` | Statement separator |

For each, verify the content is passed through **literally** to the agent (appears in the prompt as-is) and does NOT execute as a shell command. Capture output.

Save: `audit-raw/windows-escape.md` with one section per payload + pass/fail + actual observed behavior.

On any shell execution: **Critical finding** (command injection).

- [ ] **Step 5.3: Repro Finding H in a fresh run**

Create a fresh execution workspace, run a short agent task that touches files, close. Observe whether the cleanup_failed → archived sweeper path triggers within 60s (Finding H behavior). Capture in `windows-escape.md` under a "Finding H repro" section.

Note: race window may or may not repro in a single run; if not, note "unable to repro in single session; behavior verified by existing tests".

- [ ] **Step 5.4: Verify windows-escape.md on disk, no commit yet**

Expected: `audit-raw/windows-escape.md` exists with all 6 payload sections + Finding H repro section. Waits for Task 7.8 single commit.

---

## Task 6: Phase 3c — pgvector-free verification

**Goal:** prove Finding J v2 fix (`8d714b4`) — memory INSERT works on a Postgres install *without* the pgvector extension.

- [ ] **Step 6.1: Start throwaway Postgres container without pgvector**

Run:
```bash
docker run -d --name aoa-audit-pg-novec \
  -e POSTGRES_PASSWORD=audit -e POSTGRES_USER=audit -e POSTGRES_DB=audit \
  -p 55432:5432 postgres:16
```

Expected: container `aoa-audit-pg-novec` running, port 55432 accessible.

Do NOT install pgvector — that's the whole point of this step.

On fail: try a different free port; if docker is unavailable, skip and record a limitation in `pgvector-free.md`.

- [ ] **Step 6.2: Point AoA at the throwaway DB**

Set `DATABASE_URL=postgres://audit:audit@localhost:55432/audit` in the environment; start a fresh AoA instance via `pnpm dev`.

Wait for server to boot; watch `preview_logs` for any pgvector-related startup error. Any crash here is a regression of Finding J v2 → Critical finding.

- [ ] **Step 6.3: Run Flow 2 (chat) and Flow 7 (memory) against this DB**

Follow the same steps from Task 4 flows 2 and 7, but against this throwaway instance. The specific behavior to verify:

- Flow 2 chat completes with no error
- Flow 7 memory INSERT succeeds; goal completion does NOT 500 on archive hook
- `preview_console_logs` and server logs show the pgvector-free branch was taken (look for the guard code from `8d714b4`)

- [ ] **Step 6.4: Teardown**

```bash
docker stop aoa-audit-pg-novec && docker rm aoa-audit-pg-novec
```

- [ ] **Step 6.5: Save Phase 3c results**

Save: `audit-raw/pgvector-free.md` with observations + pass/fail for flows 2 and 7 + relevant log excerpts. No commit yet — Task 7.8 handles the single commit for all audit artifacts.

---

## Task 7: Consolidation — merge into master doc + changeset mirror

**Performed by main session. Reads all raw reports + logs; writes two output files.**

- [ ] **Step 7.1: Read all 8 raw agent reports**

```bash
for f in "$AOA/docs/superpowers/specs/audit-raw/"{S1,S2,S3,S4,S5,S6,X1,X2}.md; do
  echo "=== $f ==="; cat "$f"
done
```

Extract every `### AD-<LETTER>` finding block with all fields. Keep agent source as provenance.

- [ ] **Step 7.2: Read runtime results**

Inputs:
- `audit-raw/logs/_summary.tsv` — exit-code table
- `audit-raw/logs/*.log` — command outputs for failed steps
- `audit-raw/flow-*.md` — 8 UI-flow reports
- `audit-raw/windows-escape.md` — Phase 3b
- `audit-raw/pgvector-free.md` — Phase 3c

For every non-green row in `_summary.tsv` and every flow with "fail" / unexpected behavior, draft a runtime finding. Runtime findings carry `Phase found: Phase 2/<step>` or similar.

- [ ] **Step 7.3: Dedup pass**

Two findings merge if ALL hold:
- Same file OR (same subsystem AND same symbol)
- Line numbers within ±10
- Same primary dimension

Merged finding combines Evidence + Impact + Suggested-fix; lists both agent IDs under `Traces to`. Partial matches become "Related: AD-X" cross-references, not merges.

- [ ] **Step 7.4: Renumber sequentially from AD-A**

Final master doc uses a fresh contiguous sequence `AD-A`, `AD-B`, … regardless of per-agent letter ranges. Renumbering keeps the master doc readable; per-agent raw reports retain their original IDs for traceability.

- [ ] **Step 7.5: Build severity × dimension rollup**

A 4×5 matrix:

|         | A | B | C | D | E |
|---|---:|---:|---:|---:|---:|
| 🔴 Critical | .. | .. | .. | .. | .. |
| 🟠 High     | .. | .. | .. | .. | .. |
| 🟡 Medium   | .. | .. | .. | .. | .. |
| 🟢 Low      | .. | .. | .. | .. | .. |

Plus a "Runtime steps" pass/fail mini-table.

- [ ] **Step 7.6: Write the master doc**

Create `docs/superpowers/specs/2026-04-24-v1.0.0-audit-findings.md` with this structure:

```markdown
# v1.0.0 Audit Findings — Porting1.1

**Date:** 2026-04-24
**Scope:** 141 commits on Porting1.1, tag v1.0.0 (HEAD f5f00cf)
**Methodology:** 8 parallel review agents + 12-step runtime runbook + 8 UI flows + Windows-native + pgvector-free

## Summary
<overall verdict — Approve / Merge-with-fixes / Block — 2–3 sentences>

## Severity × Dimension Rollup
<the 4x5 table>

## Runtime Results
<_summary.tsv rendered as pass/fail table + Phase 2b flow results + Phase 3b + 3c>

## Critical Findings (🔴)
<full-schema entries, AD-A onward>

## High Findings (🟠)

## Medium Findings (🟡)

## Low Findings (🟢)

## What Looks Good
<merged positives from all agents + runtime observations>

## Traceability Appendix
<per-finding table: master ID → agent(s) → commit(s) → dimension(s) → original per-agent ID>
```

Fill every section. No TBD.

- [ ] **Step 7.7: Write the changeset mirror**

Create `.changeset/v1-0-0-audit-findings.md`. Match existing changeset prose style; do NOT use the full schema.

Template (fill bracketed):

```markdown
---
"aoa": none
---

v1.0.0 comprehensive audit — read-only review of 141 commits on Porting1.1 post-release.

- [N] total findings: [X] critical, [Y] high, [Z] medium, [W] low. No code changes; fix decisions deferred to follow-up branches.
- Critical/High items named inline: [comma list of titles with master IDs] — see `docs/superpowers/specs/2026-04-24-v1.0.0-audit-findings.md` for full detail, repro, and suggested fixes.
- Runtime verification: [pass-count]/[12] Phase 2 steps green; UI golden path [pass]/[8]; Windows escape test [result]; pgvector-free install [result].
- Positive observations captured in the master doc's "What looks good" section.
```

- [ ] **Step 7.8: Single commit — all audit artifacts**

Per spec Section 7 deliverable 5: one commit captures everything produced by the audit (raw reports, logs, flow reports, Windows test, pgvector-free test, master doc, changeset mirror).

```bash
cd "$AOA"
git add docs/superpowers/specs/audit-raw/ \
  docs/superpowers/specs/2026-04-24-v1.0.0-audit-findings.md \
  .changeset/v1-0-0-audit-findings.md
git commit -m "audit: v1.0.0 comprehensive review — N findings (X critical, Y high)"
```

Substitute the real N/X/Y counts in the commit title before running.

Expected: one commit on `Porting1.1` adding ~20+ new files under `docs/superpowers/specs/` and `.changeset/`. No source-file changes (verify with `git show --stat HEAD`).

---

## Task 8: Final verification + handoff

- [ ] **Step 8.1: Exit-criteria checklist**

Verify in order:

1. All 8 raw report files present at `audit-raw/*.md` and non-empty
2. `audit-raw/logs/_summary.tsv` has ≥13 rows (header + 12 Phase 2 steps)
3. `audit-raw/flow-*.md` has 8 files (or fewer if dev server boot failed — note in master doc)
4. `audit-raw/windows-escape.md` exists with all 6 escape-payload sections
5. `audit-raw/pgvector-free.md` exists (or notes why skipped)
6. `docs/superpowers/specs/2026-04-24-v1.0.0-audit-findings.md` exists and has no TBD
7. `.changeset/v1-0-0-audit-findings.md` exists with counts filled in
8. Exactly **one** commit on `Porting1.1` from this audit (Task 7.8) — adds only files under `docs/superpowers/specs/` and `.changeset/`. Verify: `git show --stat HEAD` shows zero source-code file changes.

On any missing item: rerun the failing task.

- [ ] **Step 8.2: Print a one-screen summary for the user**

To stdout, print:

```
AUDIT COMPLETE — v1.0.0 / Porting1.1

  Findings:  N total  —  🔴 X  🟠 Y  🟡 Z  🟢 W
  Runtime:   [pass]/12 commands  ·  [pass]/8 UI flows
  Windows:   escape-test [result]  ·  Finding H repro [result]
  pgvector-free:  [result]

  Master doc: docs/superpowers/specs/2026-04-24-v1.0.0-audit-findings.md
  Changeset:  .changeset/v1-0-0-audit-findings.md

  Next:  user triage critical/high findings, schedule v1.0.1 hotfixes if needed.
```

- [ ] **Step 8.3: DO NOT push**

Per system instructions: never push without explicit user approval. The audit commits live on `Porting1.1` locally until the user pushes.

---

## Notes for executor

- **Read-only audit.** The only files ever modified are under `docs/superpowers/specs/audit-raw/`, the master findings doc, and the changeset mirror. No source-code edits, period.
- **Background-friendly.** Long runtime commands (`docker:smoke`, `test:e2e`) should use `run_in_background: true` with `timeout: 900000` (15 min) and be polled via log reads, not sleep loops.
- **Resumable.** If execution is interrupted between tasks, raw reports, flow reports, and logs persist on disk (uncommitted). Consolidation can be re-run from existing artifacts without re-dispatching agents or re-running runtime commands. The single commit lands only at Task 7.8 after consolidation succeeds.
- **Token budget guard.** If total tokens consumed across the 8 Phase 1 agents exceeds expectations, pause Task 3 onwards and surface the cost to the user before proceeding.
- **Severity calibration.** When in doubt during consolidation, err on the side of lower severity. This is a post-release audit; we're looking for real risks, not a beatdown list. The "What looks good" section is mandatory, not ornamental.
