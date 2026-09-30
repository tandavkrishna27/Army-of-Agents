# CLI-002 Result — Full workspace staging and adapter execution

**Status:** `complete (no-key core) + CI-GREEN + keyed-lane authored` — the no-key core is green in the PR gate suite at landed SHA `cb1a6c972` (verify runs the server units; policy runs the disposition checker). The real-E2B fake-CLI-file-mutation + W8 live-validation ride the operator-dispatched `keyed-e2b-conformance.yml`. (A one-off `verify` flake in the unrelated DEP-009 `job-retry-capacity-transfer.integration.test.ts` under CI-DB contention — the same flake as CLI-001's landing — passed on re-run; a hardening task is filed.)
**Disposition:** `pass` (scope-honest: in-process + static evidence for the no-key core; the real-E2B rerun runs on operator key). **Second ticket of E7.**
**Date opened (UTC):** `2026-08-17`
**Epic:** `E7 — Coding/CLI workload on E2B`. **Plan task:** `CLI-002 (program-design.md:762-767)`.
**Implementer:** `Claude subagent (general-purpose) — worktree C:\e3`. **Reviewer:** `Claude adversarial-review Workflow (5 dimensions → refute-by-default verify, 26 agents) + controller re-verification + fix round`.
**Start SHA:** `2bc406d8a` (design-doc commit).

## Acceptance model + framing

CLI-002 is a new host+orchestration layer ABOVE the CLI-001 provider — no edit to the frozen worker-protocol or worker-daemon `SandboxProvider` port. Delivered:

- **`writeFiles`/`readFile`/`listDir` staging primitive on the `E2bTransport` seam** (`sandbox-e2b-provider`) — real via the `e2b` SDK filesystem API (keyed-lane), and a deterministic in-memory filesystem in `MockE2bTransport` so staging + a fake CLI's file mutation are testable WITHOUT a key.
- **`stageCodingRun` orchestrator** (`sandbox-coding-staging.ts`) — disposition gate → actor-gated memory bundle → approved-inputs gate (reject unsupported BEFORE exec, `skipped[]`-with-reason) → U5 env filter (secrets + host paths absent) → `writeFiles` → version record.
- **Per-adapter-TYPE disposition gate** (`sandbox-coding-disposition.ts`) — fail-closed BEFORE exec with an attributable reason; admits only v1 `claude_local`/`codex_local`; records Follow-up; rejects out-of-scope (`acpx_local`/`openclaw`/`cursor_cloud`/`openclaw_gateway`/`hermes_local`); a 14/14-coverage static lint (+ the always-on `policy` checker).
- **Actor-gated PRE-STAGED memory bundle** (`sandbox-coding-memory-bundle.ts`) — the `buildCrewContextBundle` lineage (`actorForAgentRun → memoryAccessConditions → canActorSee`), fail-closed to zero memory; live DAT-007 brokered pull deferred (DAT-007 core is deferred).
- **CI wiring** — pr.yml provider glob + policy disposition checker; the keyed real-E2B fake-CLI-file-mutation case SKIP-guarded in `keyed-e2b-conformance.yml`. CM-007/CM-013 crosswalk dispositions (scope-honest — no live DAT-007/DAT-005, no Follow-up admitted).

## Findings (adversarial review — 26 agents, 20 raw → 7 confirmed after refute-by-default; all fixed)

The disposition gate came back **clean** (fail-closed default, admits only v1, 14/14 coverage, non-vacuous lint). All seven defects clustered in the D2 memory bundle + its env staging, where the fetch was hand-re-implemented and **drifted from the crew lineage it claimed parity with**:

- **HIGH (RBAC/governance gate-bypass) — the bundle dropped the crew path's mandatory `status='approved'` predicate.** `memory_items.status` defaults to `'pending'`, so agent-suggested-but-unapproved AND founder-rejected memory that cleared the RBAC tier gate would be rendered as authoritative `## Context` into the E2B coding sandbox — circumventing the founder approval gate (Critical Rule #6 / Decision #15) on the highest-capability surface. **Fixed:** added `eq(status,'approved')` to the gated fetch (crew parity, `memory.ts:625`). **Proven RED→GREEN:** removing the predicate turns the new SQL-gate test RED.
- **MEDIUM — expired `active_context` was served** (the A-M5 `or(isNull(expiresAt), gt(expiresAt, now()))` guard was missing). **Fixed:** added the expiry guard on the DB clock.
- **MEDIUM — the guarding test was vacuous** on status/expiry + the SQL-gate wiring (fixtures omitted status/expiresAt; `memoryAccessConditions` was mocked to `[]`). **Fixed:** the test now captures the query and asserts the WHERE carries `status='approved'` + the expiry guard + the (sentinel) RBAC conditions + company + scope predicates — so the fixes are regression-protected.
- **LOW — the department/project/goal scope filter was a silent no-op** (dead `args.filters`). **Fixed:** `= scope OR IS NULL` narrowing per provided filter (crew parity) + a scope test.
- **LOW — `LIMIT` without `ORDER BY`** made the served subset non-deterministic. **Fixed:** `orderBy(desc(priority), desc(updatedAt))` before the limit (crew parity + reproducible D5 digest).
- **LOW — host workspace paths survived into the staged env** — U5 admits `AOA_WORKSPACE_CWD`/`WORKTREE_PATH`/`SOURCE`/`WORKSPACES_JSON`/`AGENT_HOME` (justified only because U5's usual caller then runs `shapeAoaWorkspaceEnvForExecution`), but `stageCodingRun` had no rewrite step → a host worktree path would leak into the sandbox env, violating "host paths absent." **Fixed:** `stripHostWorkspacePaths` removes the path-bearing host-workspace keys after the allowlist; the staging test's `SECRET_OVERLAY` now carries a host worktree path and asserts it is absent.
- **LOW — a stale `builtin-adapter-types.ts` header comment** contradicted the actual set (claimed no `openclaw_gateway`/`pi_local`). **Fixed.**

**Refuted / accepted-by-design:** the fs-mock's fake-CLI mutation rides a reserved directive the mock applies + the keyed lane runs a REAL shell command asserted through `readFile` (not a mock shortcut); the disposition gate is the sole staging entry (no bypass path).

## Commands (verbatim, re-run by the controller after the fixes)

| Command | Result |
|---|---|
| `…vitest run sandbox-coding-{memory-bundle,staging,disposition}.test.ts` | **19 pass** (memory-bundle 5, staging 6, disposition 8) |
| MEDIUM/HIGH non-vacuity: remove `status='approved'` predicate | SQL-gate test **RED**; restored → GREEN (founder-approval gate is driver-owned + regression-guarded) |
| `pnpm --filter @armyofagents/sandbox-e2b-provider test:run` | **25 pass + 10 keyed-skip** (incl. the D1 staging-fs proof) |
| `node scripts/check-sandbox-coding-disposition.mjs` + `.test.mjs` | **OK + 7 pass** (14/14 coverage) |
| `node scripts/check-sandbox-e2b-provider-boundary.mjs` | **OK + 33/33** (credential still confined) |
| `pnpm --filter @armyofagents/server typecheck` | clean |
| `node --check` keyed real-E2B file-mutation case + workflow YAML | parse OK (SKIP off `E2B_API_KEY`; `e2b` dynamically imported) |
| `git status` | new server services + scripts + tests; NO `worker-protocol` / worker-daemon-port / `DE-*` edits |

## Residual risk / scope-honesty

1. **Real-E2B validation is keyed-lane-only** — the fake CLI modifying a KNOWN file inside REAL E2B + W8 `claude_local`/`codex_local` live-validation run on operator `E2B_API_KEY` dispatch; the no-key core proves staging/gate/memory against the fs-modeling double + mocked DB.
2. **Memory context is PRE-STAGED, not live-brokered** — DAT-007's brokered run-JWT in-VM surface has its core deferred; CLI-002 stages the actor-gated bundle on the host and the live pull defers to DAT-007.
3. **Follow-up adapters not admitted** (`gemini_local`/`opencode_local`/`cursor`/`grok_local`/`pi_local`) — recorded, admitted once in-VM MCP staging + model→provider mapping are proven.
4. **No live DAT-005 egress channel** (inert seam, E4-D12); **no `codex_local` sandbox-docker MCP staging** (MX3 follow-up).

## Operator action to run the real-E2B lane

Same as CLI-001: add `E2B_API_KEY` to repo GitHub Actions secrets + a template id, dispatch `keyed-e2b-conformance.yml` — it now also runs the fake-CLI-modifies-a-known-file-inside-real-E2B case + the W8 live-validation of the admitted adapters.

## Gate recommendation

`ready for independent review` — the no-key core is green (19 server units + package + checkers), the HIGH founder-approval-gate fix re-proven RED→GREEN, and the real-E2B rerun is runnable on operator key.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | Claude adversarial-review Workflow (26 agents) + controller | implementer working tree | `approved after fixes` | 20 raw → 7 confirmed: HIGH founder-approval-gate bypass (dropped `status='approved'`) + expiry MEDIUM + vacuous-test MEDIUM + 4 LOW (scope no-op, non-deterministic limit, host-path leak, stale comment); all fixed + re-verified; HIGH re-proven RED→GREEN; disposition gate clean; 19 units + package + checkers green |
