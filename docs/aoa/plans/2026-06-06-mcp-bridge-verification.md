# MCP Bridge Fix — Enterprise-Grade Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Workstream A (review) and B3 (live walkthrough) are controller-run; B1/B2 are implementer-subagent tasks.

**Goal:** Prove with fresh independent + cross-model review and a real end-to-end run that both Transport-closed root causes are fixed and the loud-failure net works, leaving a permanent E2E regression test + a live demonstration.

**Architecture:** Two workstreams. A) review the full `origin/feat/v1-combined..HEAD` diff (fresh opus reviewer + codex cross-model) → triage → fix. B) E2E: real codex crew posts through the fixed bridge via `runAoaAgent` (happy path), an induced `AOA_LOG_STDOUT=1` break proves loud-failure marks the run failed, and a `/browse` UI walkthrough shows it live.

**Tech Stack:** vitest, Drizzle ORM (`@armyofagents/db`), real `codex` CLI, `runAoaAgent`/`buildAoaRunResultFromAdapter`, gstack `/browse`, Postgres at `127.0.0.1:54440`.

**Env constants:** DB `postgres://paperclip:paperclip@127.0.0.1:54440/paperclip`; company `8d7569f2-43e9-4b57-8709-2a4687364e44`; thread `376592a2-91e6-4327-81fb-8fb7e498b6c4`; worktree `C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-mcp-fix`; branch `fix/codex-mcp-bridge`.

**Constraints:** Drizzle ORM only (no raw SQL); NEVER `git add -A` (stage only listed files); commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; do NOT commit to `feat/v1-combined`; gstack `/browse` for all browsing.

---

## Task A1: Fresh independent review (controller dispatches a reviewer subagent)

**Files:** none (review only). Output: capture the reviewer's report.

- [ ] **Step 1: Dispatch a fresh opus reviewer** (no prior session context) over the full branch diff.
  - Scope: `git -C "<worktree>" diff origin/feat/v1-combined..HEAD` (+ read the final state of the core files).
  - Prompt focus (adversarial, line-by-line): (a) the watchdog-only lifecycle invariant (no `process.exit` on stdin EOF; watchdog never fires while `inFlight>0`); (b) the three stdout-discipline mechanisms cohere with no gap/conflict (console guard + pino→stderr + `transport.onerror`); (c) `detectTransportFailure` regex precision + false-positive surface + the gemini gap; (d) `buildAoaRunResultFromAdapter` precedence + the optional `opts`; (e) `logger.ts` blast radius (default path byte-identical); (f) concurrency/large-payload/EPIPE on the SDK transport; (g) anything that could still write non-JSON to bridge stdout.
  - Require: Critical/Important/Minor with exact `file:line` and a concrete repro/reason for each.
- [ ] **Step 2: Save the report** to `C:\Users\TK\AppData\Local\Temp\mcp-review-fresh.md` (controller writes the returned text).

## Task A2: codex cross-model review (controller runs codex directly)

**Files:** prompt + output temp files.

- [ ] **Step 1: Write the review prompt** to `C:\Users\TK\AppData\Local\Temp\mcp-codex-review-prompt.txt`:
  > You are doing an independent, critical engineering review. REVIEW ONLY — do not modify files. Read these files in the current repo and critique for correctness, edge cases, and any way the MCP stdio bridge could still corrupt its stdout or drop a tool-call response: `server/src/services/internal-agent/mcp-bridge.ts`, `server/src/services/internal-agent/bridge-lifecycle.ts`, `server/src/middleware/logger.ts`, `server/src/services/internal-agent/aoa-agents/aoa-run-result.ts`, `server/src/services/internal-agent/transport-failure.ts`, `server/src/services/internal-agent/cli-mode.ts`. Context: the bridge is a JSON-RPC-over-stdio MCP server for codex/opencode/gemini (claude uses native --mcp-config). It was fixed for TWO Transport-closed causes: (1) it used to process.exit(0) on stdin EOF, killing in-flight responses — now watchdog-only lifecycle + @modelcontextprotocol/sdk transport; (2) pino logged to stdout at boot, corrupting the initialize frame — now routed to stderr via AOA_LOG_STDOUT=0. Plus loud-failure detection (transport marker in adapter output → run marked failed). For each issue say sound/risky/wrong and why, prioritized.
- [ ] **Step 2: Run codex** from the worktree, capture output:
  - Run: `cd "<worktree>" && codex exec --json "$(cat C:\Users\TK\AppData\Local\Temp\mcp-codex-review-prompt.txt)" > C:\Users\TK\AppData\Local\Temp\mcp-codex-review.out 2>&1` (if `--json` is unavailable, drop it). Expected: codex emits a review; capture stdout.
  - If codex cannot run (auth/model), record the failure reason and proceed — A1 is the required gate; A2 is the outside-voice bonus.
- [ ] **Step 3: Read** `mcp-codex-review.out` and extract concrete findings.

## Task A3: Triage + fix (controller)

**Files:** depends on findings; stage only files changed per fix.

- [ ] **Step 1: Merge A1+A2 findings** into one ledger (Critical / Important / Minor), de-duplicated.
- [ ] **Step 2: For each Critical/Important** — dispatch a focused fix subagent (TDD: failing test → fix → green), one commit each with the trailer. Re-review the fix.
- [ ] **Step 3: For each Minor** — document + defer with a one-line rationale (or fix if trivial).
- [ ] **Step 4: Re-run the gate** after any fix: `AOA_TEST_DATABASE_URL='postgres://paperclip:paperclip@127.0.0.1:54440/paperclip' pnpm -C "<worktree>/server" exec vitest run --exclude '**/*.live.test.ts'` → green; `pnpm -C "<worktree>" -r typecheck` → clean.
- [ ] **Acceptance:** zero unresolved Critical/Important.

---

## Task B1: Programmatic happy-path E2E — real codex posts via `runAoaAgent`

**Files:** Modify `server/src/services/internal-agent/__tests__/crew-post-e2e.live.test.ts` (add one gated `it`). Test: same file.

- [ ] **Step 1: Read the wiring** to build a correct call:
  - `server/src/services/internal-agent/aoa-agents/runner.ts` — `runAoaAgent(db, agentId, payload)` signature + `AoaTriggerPayload` shape (what makes an agent act on a thread and call `post_entry`).
  - The participation trigger (`requestParticipation` or the thread-mention path) — to copy the minimal payload that drives a post to thread `376592a2…`.
  - `packages/db/src/schema/discussions.ts` — `discussion_entries` columns (the author/agent field + `discussionId`) for the assertion.
- [ ] **Step 2: Write the gated test** (probe codex availability + DB; skip loudly if absent). Pseudostructure:
  ```ts
  it("codex crew agent posts an entry end-to-end via runAoaAgent (real bridge)", async () => {
    if (!cliAvailable("codex")) { console.warn("[e2e] SKIP codex_local: CLI not installed"); return; }
    if (!(await probeDb(DB_URL))) { console.warn("[e2e] SKIP: no DB"); return; }
    const db = createDb(DB_URL);
    const agentId = await ensureCodexCrewAgent(db, COMPANY); // find-or-inline-seed a codex_local agent
    const before = await countAgentEntries(db, THREAD, agentId);
    await runAoaAgent(db, agentId, buildPostTriggerPayload(THREAD)); // full path → bridge → post_entry
    const after = await countAgentEntries(db, THREAD, agentId);
    expect(after).toBeGreaterThan(before);                 // a new agent-authored entry landed
    const lastRun = await latestRunFor(db, agentId);
    expect(lastRun.status).not.toBe("failed");             // run succeeded (loud-failure did NOT fire on a clean run)
  }, 180_000);
  ```
  - Implement helpers with Drizzle (`createDb`, `eq`, `and`, `desc`) querying `agents`, `discussion_entries`, `internal_agent_runs`. Reuse the inline-seed helper already in this file if present.
  - **Fallback (only if `runAoaAgent`'s trigger is too coupled to drive):** invoke the codex adapter directly with the bridge spec from `buildMcpBridgeSpec(...)` and an instruction to call `post_entry` for the thread; assert the `discussion_entries` row appears AND `buildAoaRunResultFromAdapter(result, {mcpAttempted:true, markerSupported:true}).status !== "failed"`. Either path proves: real codex → fixed bridge → entry posted.
- [ ] **Step 3: Run** with DB env → PASS (codex posts; run not failed). Paste the codex/DB evidence.
- [ ] **Step 4: Commit** `crew-post-e2e.live.test.ts`.

## Task B2: Induced-failure E2E — loud-failure marks the run failed

**Files:** Modify the same `crew-post-e2e.live.test.ts` (add one gated `it`).

- [ ] **Step 1: Write the induced-failure test** — drive real codex through the bridge with the leak RE-ENABLED, then assert the detector catches it:
  ```ts
  it("induced transport failure (AOA_LOG_STDOUT=1) → run marked failed, not silently succeeded", async () => {
    if (!cliAvailable("codex")) { console.warn("[e2e] SKIP codex_local: CLI not installed"); return; }
    if (!(await probeDb(DB_URL))) { console.warn("[e2e] SKIP: no DB"); return; }
    // Construct the codex bridge spec but OVERRIDE the fix: AOA_LOG_STDOUT="1" re-enables the
    // pino "OPENAI_API_KEY is not set" WARN onto stdout → corrupts the initialize frame →
    // codex's MCP client dies with "Transport closed" (the exact original bug mechanism).
    const result = await runRealCodexWithBridgeEnv({ AOA_LOG_STDOUT: "1" }, "thread.listEntries", THREAD);
    // The detector must classify this as a transport failure.
    const run = buildAoaRunResultFromAdapter(result, { mcpAttempted: true, markerSupported: true });
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toMatch(/transport failed/i);
  }, 180_000);
  ```
  - `runRealCodexWithBridgeEnv` reuses the existing direct-adapter codex invocation in this file (the one that already drives `thread.listEntries`), but merges `{ AOA_LOG_STDOUT: "1" }` into the bridge spec env and **does not** inject a dummy `OPENAI_API_KEY` (the absent key is what fires the WARN). It returns the `AdapterExecutionResult` (with `resultJson.stdout/stderr`).
  - If, on a given codex version, the corruption does not surface as a transport marker in codex's captured output (e.g. codex swallows it), skip LOUDLY with the captured stdout/stderr quoted — do NOT weaken the assertion or fake a pass.
- [ ] **Step 2: Run** → PASS (run marked failed). Paste evidence (the marker found + status failed).
- [ ] **Step 3: Commit** `crew-post-e2e.live.test.ts`.

---

## Task B3: Live UI walkthrough (controller, gstack `/browse`)

**Files:** none (live). Output: screenshots + `docs/aoa/plans/2026-06-06-mcp-bridge-verification-walkthrough.md` (notes).

- [ ] **Step 1: Boot the server from the fix worktree** against the QA DB. Use the QA instance config (AOA_INSTANCE_ID=qa-disc / the existing config.json pinning embeddedPostgresPort=54440; server :3300, vite :5373). Start Postgres (already up), the server, and vite from `<worktree>`. Health-check `/api/health` (or equivalent) on :3300.
- [ ] **Step 2: Ensure a working codex crew agent** for company `8d7569f2…` exists and is assigned so it can participate in the thread. Seed/repair via the UI or a Drizzle insert if the only codex agent is the broken `Director` (set adapterType `codex_local`, a valid model e.g. `gpt-5.5`, status active/idle).
- [ ] **Step 3: `/browse` the discussions UI** — open the app, select the company, open thread `376592a2…`.
- [ ] **Step 4: @mention the codex agent** in a new entry that asks it to respond/post. Submit.
- [ ] **Step 5: Watch the entry appear** — confirm a codex-authored entry shows up live in the thread (this is the user-facing proof both root causes are fixed). Screenshot it.
- [ ] **Step 6 (optional): observe loud-failure** — if quick, induce a break (or point at a bad config) and confirm the run surfaces as failed in the UI/activity rather than silently succeeding.
- [ ] **Step 7: Write the walkthrough notes** (what was observed + screenshot paths) and commit the notes doc.
- [ ] **Escalation:** if booting the full server from the fix worktree hits a real blocker (config/port/build), pause and report — B1/B2 already prove the flow programmatically; B3 is the visual confirmation.

---

## Task C: Final gate + wrap

**Files:** none (verification) + optional ledger update.

- [ ] **Step 1: Full server suite** — `AOA_TEST_DATABASE_URL='postgres://paperclip:paperclip@127.0.0.1:54440/paperclip' pnpm -C "<worktree>/server" exec vitest run --exclude '**/*.live.test.ts'` → green.
- [ ] **Step 2: Live E2E** — `AOA_TEST_DATABASE_URL='...' pnpm -C "<worktree>/server" exec vitest run src/services/internal-agent/__tests__/crew-post-e2e.live.test.ts` → codex cases PASS; opencode/gemini loud-skip.
- [ ] **Step 3: Typecheck** — `pnpm -C "<worktree>" -r typecheck` → clean.
- [ ] **Step 4: Update the known-gaps ledger** in the verification design doc (record review findings dispositions + the live-walkthrough result), commit.
- [ ] **Acceptance:** all gates green; review clean; codex proven posting live (B1 + B3); loud-failure proven on a real induced break (B2).

---

## Self-Review (checklist)

- **Spec coverage:** A1 fresh review ✓; A2 codex ✓; A3 triage+fix ✓; B1 happy-path via runAoaAgent ✓; B2 induced-failure ✓; B3 live UI ✓; final gate ✓ — all design sections mapped.
- **Placeholders:** none — exact commands, env constants, and concrete assertions throughout; B1/B2 give a real test skeleton + fallback; B3 gives the boot/seed/observe sequence.
- **Type consistency:** `buildAoaRunResultFromAdapter(result, {mcpAttempted, markerSupported})` matches its signature; `runAoaAgent(db, agentId, payload)` matches the runner; Drizzle helpers (`createDb`, `eq`) match `@armyofagents/db`.
