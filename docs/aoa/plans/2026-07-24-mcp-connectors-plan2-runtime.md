# MCP Connectors — Plan 2: Complete the Runtime

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend external MCP connectors from claude_local heartbeat runs (Plan 1) to **crew agents** and **Commander**, and build the **approval handler** that activates a connector after a board approves it — the sole activation path in `authenticated` mode.

**Architecture:** Plan 1 delivers connectors on the heartbeat path only. This plan (1) extracts the shared load→build→log logic into `resolveAgentConnectors`, (2) wires it into the crew runner and Commander, and (3) adds an `install_mcp_connector` side-effect to `approvalService.approve`/`reject`. No schema change; no route change; no UI change (the approval flows through the existing generic approvals route + Inbox).

**Tech Stack:** TypeScript, Express 5, Drizzle ORM, Vitest. Branch: `feat/mcp-connectors` (Plan 1, HEAD `8f7b7cc27`). **All work continues in worktree `C:\Users\TK\.aoa\wt\mcp-connectors` — the session's default cwd is a DIFFERENT worktree on the `claude/plugins-connectors-inventory-cf49a7` branch that does NOT contain Plan 1's code. Every agent MUST be pinned to `C:\Users\TK\.aoa\wt\mcp-connectors`.**

---

## Scope

This is **the "complete the runtime" plan**. The three remaining CLI adapters (gemini_local, opencode_local, codex_local) are a SEPARATE future plan and are OUT OF SCOPE here. Commander's codex path (`CODEX_HOME/config.toml`, not `--mcp-config`) is also out of scope — this plan wires Commander's **claude_cli** path only.

## What Plan 1 already built (verified on `feat/mcp-connectors` @ `8f7b7cc27`)

- `server/src/services/mcp-connectors.ts` — pure `buildConnectorSpecs(rows) => {specs, env, skipped}`, `envVarNameFor`, `selectConnectorRowsForAgent`, plus the shared `mergeExternalMcpServers`/`RESERVED_MCP_SERVER_NAMES` live in `packages/adapter-utils/src/mcp-server-spec.ts`.
- `server/src/services/mcp-connectors-loader.ts` — `loadEnabledConnectorRows(db, {companyId, agentId})`; `agentId: null` = Commander/all-active (D3); per-connector try/catch (A19).
- `server/src/services/mcp-connectors-env.ts` — `buildConnectorProcessEnv`/`mergeConnectorEnv` (scrub helpers — NOT used on the claude paths per A29; claude needs full host env).
- `buildMcpConfig(params)` accepts `params.extraMcpServers` (cli-mode.ts:217+) and splices via `mergeExternalMcpServers`.
- `prepareHeartbeatMcpDelivery` (heartbeat-mcp.ts) resolves connectors and merges into `config.env` for claude_local.
- Crew (`runner.ts:506-514`) and Commander (`cli-mode.ts:464,484`) already pass `--strict-mcp-config` (Task 9) and crew uses the adapter-preferred `argKey` (Task 12).
- Approval on create: authenticated-mode connector create raises `approvalService.create(companyId, {type:"install_mcp_connector", requestedByUserId, status:"pending", payload:{connectorId, serverName}})` — but nothing consumes it yet.

## Locked design decisions (from Plan 1, carried forward)

| # | Decision |
|---|---|
| D3 | Commander receives ALL active company connectors (`agentId: null`), exempt from per-agent opt-in. |
| D4 | Crew agents are per-agent opt-in (real `agentId`). |
| C2 | In `authenticated` mode, PATCH cannot activate a connector — activation flows ONLY through the approval handler this plan builds. |
| A19 | One dangling secret must not kill the whole connector load (per-connector try/catch — already in the loader). |
| A29 | Do NOT scrub the claude spawn env — claude needs its own host-env auth. Merge `connectorEnv` on top, don't replace. |
| A33 | Live verification must drive the REAL delivery builders, never a hand-assembled argv. |

## File Structure

**Created:**
- (none — all changes extend existing files)

**Modified:**
- `server/src/services/mcp-connectors.ts` — add `resolveAgentConnectors` (composes loader + buildConnectorSpecs + skipped-log)
- `server/src/services/heartbeat.ts` — refactor the inline connector-resolution to call `resolveAgentConnectors`
- `server/src/services/internal-agent/aoa-agents/runner.ts` — crew connector delivery
- `server/src/services/internal-agent/cli-mode.ts` — Commander connector delivery (thread `extraMcpServers` into `resolveCliInvocation`; merge `connectorEnv` into `invocation.spawnEnv`)
- `server/src/services/approvals.ts` — `install_mcp_connector` approve→activate, reject→cleanup
- Test files alongside each.

---

## Task 1: Extract `resolveAgentConnectors` (shared helper) and refactor heartbeat to it

Gives crew/Commander one call to reuse, and moves the skipped-connector log into a unit-testable seam (closes the A8/Task-10 observability gap).

**Files:**
- Modify: `server/src/services/mcp-connectors-loader.ts` (home for `resolveAgentConnectors` — see the circular-import note below)
- Modify: `server/src/services/heartbeat.ts` (the block that inlines `loadEnabledConnectorRows` + `buildConnectorSpecs` + `logger.warn` before `prepareHeartbeatMcpDelivery`)
- Test: `server/src/services/__tests__/mcp-connectors-loader.test.ts` (extend — the loader test already mocks `../secrets.js` + a sequence DB; reuse it)

> **CIRCULAR-IMPORT NOTE (do not put this in `mcp-connectors.ts`):** `resolveAgentConnectors` needs BOTH `loadEnabledConnectorRows` (in `mcp-connectors-loader.ts`) AND `buildConnectorSpecs` (in the pure `mcp-connectors.ts`). The loader ALREADY imports `selectConnectorRowsForAgent` from `mcp-connectors.ts` (one direction, A24). Placing `resolveAgentConnectors` in the pure module and importing the loader would create a `mcp-connectors.ts ⇄ mcp-connectors-loader.ts` cycle. It belongs in the **loader**, which already depends on the pure module — no new edge. Keep `mcp-connectors.ts` dependency-free.

- [ ] **Step 1: Write the failing test**

Extend `server/src/services/__tests__/mcp-connectors-loader.test.ts` (read it first — it mocks `../secrets.js` and uses `createSequenceDb`/Proxy stubs; match that pattern rather than mocking the loader module, since `resolveAgentConnectors` lives IN the loader). Add a `describe("resolveAgentConnectors")` covering:
- an http connector with a resolvable secret → `extraMcpServers.notion` is the http spec with a `${AOA_MCP_NOTION_TOKEN}` placeholder header, `connectorEnv.AOA_MCP_NOTION_TOKEN` is the real secret, and `logger.warn` is NOT called;
- a row that `buildConnectorSpecs` skips (http w/o url) → `extraMcpServers` empty AND `logger.warn` called once with `{companyId, agentId, skipped:[{serverName, reason}]}`;
- `agentId: null` (Commander) → the loader's null branch runs (no junction query) and all active connectors resolve.

Seed the connector + junction + secret rows through the same sequence-DB the existing loader tests use. Assert against the real composed output — do NOT stub `loadEnabledConnectorRows` (it's in the same module).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Users/TK/.aoa/wt/mcp-connectors && pnpm vitest run server/src/services/__tests__/mcp-connectors-loader.test.ts`
Expected: FAIL — `resolveAgentConnectors is not exported`.

- [ ] **Step 3: Implement**

In `server/src/services/mcp-connectors-loader.ts` (which already imports from `./mcp-connectors.js` and `@armyofagents/db`), add — importing `buildConnectorSpecs` from `./mcp-connectors.js` if not already imported:

```ts
// loadEnabledConnectorRows is LOCAL to this file (loader). buildConnectorSpecs
// comes from the pure module (loader already imports selectConnectorRowsForAgent
// from it, so this adds no new dependency edge).
import { buildConnectorSpecs } from "./mcp-connectors.js";
import type { Db } from "@armyofagents/db";

interface ConnectorLogger {
  warn: (meta: Record<string, unknown>, msg: string) => void;
}

export interface ResolveAgentConnectorsInput {
  companyId: string;
  /** Real agent id for per-agent opt-in (D4); null for Commander/all-active (D3). */
  agentId: string | null;
  runId?: string;
  logger?: ConnectorLogger;
}

/**
 * Single place all three delivery paths (heartbeat, crew, Commander) resolve a
 * company's enabled connectors into { extraMcpServers, connectorEnv }. Skipped
 * connectors are logged HERE (A8: a silently vanishing connector is the worst
 * failure mode) so the log has a unit-testable seam.
 */
export async function resolveAgentConnectors(
  db: Db,
  input: ResolveAgentConnectorsInput,
): Promise<{
  extraMcpServers: Record<string, import("@armyofagents/adapter-utils").McpServerSpec>;
  connectorEnv: Record<string, string>;
}> {
  const rows = await loadEnabledConnectorRows(db, {
    companyId: input.companyId,
    agentId: input.agentId,
  });
  const { specs, env, skipped } = buildConnectorSpecs(rows);
  if (skipped.length > 0 && input.logger) {
    input.logger.warn(
      { companyId: input.companyId, agentId: input.agentId, runId: input.runId, skipped },
      "mcp connectors skipped for agent run",
    );
  }
  return { extraMcpServers: specs, connectorEnv: env };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/resolve-agent-connectors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Refactor heartbeat to use it (behaviour-preserving)**

In `server/src/services/heartbeat.ts`, find the block (added in Plan 1 Task 10, gated on `agent.adapterType === "claude_local"`) that calls `loadEnabledConnectorRows` + `buildConnectorSpecs` + `logger.warn`. Replace it with:

```ts
const { extraMcpServers, connectorEnv } = await resolveAgentConnectors(db, {
  companyId: agent.companyId,
  agentId: agent.id,
  runId: run.id,
  logger,
});
```

Use the ACTUAL var names in scope (`agent`, `run`, the file's `logger`). Import `resolveAgentConnectors` from `./mcp-connectors-loader.js`. Keep passing `extraMcpServers`/`connectorEnv` into the `prepareHeartbeatMcpDelivery` call exactly as before. This is a pure refactor — the delivered config must be unchanged.

- [ ] **Step 6: Verify heartbeat behaviour unchanged**

Run: `pnpm vitest run server/src/__tests__/heartbeat-mcp.test.ts server/src/services/__tests__/mcp-connectors.test.ts` and `pnpm --filter @armyofagents/server typecheck`
Expected: all pass; the heartbeat delivery tests (byte-identity, placeholder-not-plaintext) still green — proving the refactor preserved behaviour.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/mcp-connectors.ts server/src/services/heartbeat.ts server/src/services/__tests__/resolve-agent-connectors.test.ts
git commit -m "refactor(mcp): extract resolveAgentConnectors; heartbeat uses it; skip-log gets a test seam"
```

---

## Task 2: Deliver connectors to crew agents

Crew agents (`kind='aoa'`, `runAoaAgent`) run through the claude_local adapter, whose env chokepoint is `config.env` — same as heartbeat. Per-agent opt-in applies (real `agentId`).

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts`
- Test: `server/src/__tests__/aoa-runner.test.ts` (extend)

**Verified facts (feat/mcp-connectors):** `mcpParams` built at ~`runner.ts:338`; `buildMcpConfig(mcpParams)` at ~`:365`; `resolvedBaseConfig` produced at ~`:477` (already post-secret-binding via `resolveAdapterConfigForRuntime` at ~:453 — so merging `connectorEnv` into its env does NOT get re-scrubbed); the claude config object built at ~`:512-514`; `db`, `agent.companyId`, `agent.id`/`agentId` all in scope.

- [ ] **Step 1: Write the failing test**

Extend `server/src/__tests__/aoa-runner.test.ts` with a test asserting that when the crew agent has an enabled http connector, the generated `--mcp-config` file contains it with a `${AOA_MCP_*_TOKEN}` placeholder (no plaintext secret) and the delivered `config.env` carries the real token. Follow the existing aoa-runner test harness (it already mocks the DB and captures the delivered config). Mock `resolveAgentConnectors` (or the loader) to return one http connector spec + env. Assert:
- `delivered config`'s `argKey` array contains `--mcp-config`, `--strict-mcp-config`;
- the written config file contains `notion` with `Bearer ${AOA_MCP_NOTION_TOKEN}` and NOT the plaintext secret;
- `delivered.env.AOA_MCP_NOTION_TOKEN` === the real secret;
- **regression:** a crew agent with NO connectors produces a delivered config with no connector servers and unchanged env (mirror Plan 1's byte-identity guard).

Read the existing aoa-runner tests first and match their mocking style; write the exact assertions against the real captured config.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/__tests__/aoa-runner.test.ts`
Expected: FAIL (connector not present in the delivered config).

- [ ] **Step 3: Implement**

In `runAoaAgent` (`runner.ts`), for the claude_local path only:

1. Resolve connectors once, near the `mcpParams` construction (~`:338`), before `buildMcpConfig`:
```ts
const { extraMcpServers, connectorEnv } = await resolveAgentConnectors(db, {
  companyId: agent.companyId,
  agentId, // real per-agent id (D4)
  runId, // whatever the run id var is named in scope
  logger, // the file's logger
});
```
Import `resolveAgentConnectors` from `../../mcp-connectors-loader.js` (adjust relative depth).

2. Thread `extraMcpServers` into the `buildMcpConfig` call: change `buildMcpConfig(mcpParams)` (~`:365`) to `buildMcpConfig({ ...mcpParams, extraMcpServers })`.

3. Merge `connectorEnv` into the claude config's env (~`:512-514`). The claude branch currently spreads `...resolvedBaseConfig`. Add an explicit `env` that merges connector tokens on top of the resolved env — and ONLY when there are connectors, to keep the no-connector case byte-identical:
```ts
const claudeEnvMerge =
  Object.keys(connectorEnv).length > 0
    ? { env: { ...(resolvedConfigRecord.env as Record<string, string> | undefined), ...connectorEnv } }
    : {};
const config = isClaudeFamily
  ? { ...resolvedBaseConfig, promptTemplate: triggerPrompt, ...claudeEnvMerge, [argKey]: ["--mcp-config", cfgPath, "--strict-mcp-config", ...stripUserMcpArgs(userTail)] }
  : { ...resolvedBaseConfig, promptTemplate: triggerPrompt };
```
**Do NOT scrub (A29)** — `connectorEnv` merges on top of the resolved host/adapter env; it must not replace it. **Verify** the merge lands after `resolvedBaseConfig` (post-secret-binding), never before.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/src/__tests__/aoa-runner.test.ts` then `pnpm --filter @armyofagents/server typecheck`
Expected: pass, including the no-connector byte-identity regression.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/runner.ts server/src/__tests__/aoa-runner.test.ts
git commit -m "feat(mcp): deliver company connectors to crew (aoa) claude_local runs"
```

---

## Task 3: Deliver connectors to Commander (claude_cli path)

Commander is the trickiest: it does NOT use the claude_local adapter — it spawns `claude` directly, so there is no `config.env` chokepoint. `buildMcpConfig` runs inside the module-level `resolveCliInvocation` (no `db`), and the child env is `{...process.env, ...invocation.spawnEnv}` at the spawn sites. Commander is per-user → D3 all-active (`agentId: null`).

**Files:**
- Modify: `server/src/services/internal-agent/cli-mode.ts`
- Test: an existing cli-mode/commander test file (extend)

**Verified facts (feat/mcp-connectors):** `resolveCliInvocation` at `cli-mode.ts:392` (module-level, no db); its claude_cli branch calls `buildMcpConfig(params)` at ~`:416`; it returns `spawnEnv` (~:473/:492); the caller is `cliModeService(db)` at `:556`, which invokes `resolveCliInvocation(...)` at ~`:746` (db + `params.companyId` in scope) and spawns at `:777` with `env: {...process.env, ...invocation.spawnEnv}`. There is a second spawn at `:1147` (also reads `invocation.spawnEnv`).

- [ ] **Step 1: Write the failing test**

Extend the Commander cli-mode test (find where `resolveCliInvocation` is tested — e.g. `cli-invocation-stdin.test.ts`) with: given `extraMcpServers` passed to `resolveCliInvocation` (claude_cli), the written `--mcp-config` file contains the connector alongside `aoa`, with a placeholder header and no plaintext secret. Plus a closure-level test (if reachable) that `invocation.spawnEnv` carries the `AOA_MCP_*_TOKEN` after the merge. If the closure path isn't unit-reachable, assert the merge helper directly and verify live in Task 5.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/cli-invocation-stdin.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement — thread specs in, merge env at the closure**

1. **Widen `resolveCliInvocation`** to accept optional connector specs. Its params already flow into `buildMcpConfig(params)`. Add `extraMcpServers` to the `McpConfigParams`-shaped object it builds (or add a param `extraMcpServers?: Record<string, McpServerSpec>` and pass `buildMcpConfig({ ...params, extraMcpServers })`). Do NOT change the codex branch.

2. **In `cliModeService` (has `db`), before the `resolveCliInvocation(...)` call (~`:746`)**, resolve Commander's connectors:
```ts
const { extraMcpServers, connectorEnv } = await resolveAgentConnectors(db, {
  companyId: params.companyId,
  agentId: null, // Commander = all active (D3)
  logger, // the closure's logger, if present; else omit
});
```
Pass `extraMcpServers` into `resolveCliInvocation`.

3. **Merge `connectorEnv` into `invocation.spawnEnv` immediately after the call returns**, so BOTH spawn sites (`:777`, `:1147`) inherit it:
```ts
if (invocation && Object.keys(connectorEnv).length > 0) {
  invocation.spawnEnv = { ...(invocation.spawnEnv ?? {}), ...connectorEnv };
}
```
**Verify** there is only one `resolveCliInvocation` call feeding both spawn sites; if `:1147` is fed by a separate invocation, apply the same merge there. **Do NOT scrub** — connector tokens merge on top of `{...process.env, ...spawnEnv}` (A29).

- [ ] **Step 4: Run to verify it passes + no Commander regression**

Run: `pnpm vitest run server/src/services/internal-agent server/src/__tests__/cli-mode.test.ts` and `pnpm --filter @armyofagents/server typecheck`
Expected: pass; existing Commander argv/byte-identity tests still green (no connectors → spawnEnv unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/cli-mode.ts server/src/services/internal-agent/__tests__/cli-invocation-stdin.test.ts
git commit -m "feat(mcp): deliver all active company connectors to Commander (claude_cli)"
```

---

## Task 4: Approval handler — `install_mcp_connector` activates on approve, cleans up on reject

The sole activation path in `authenticated` mode (C2 blocks PATCH→active). Purely a service-layer addition; the approvals route + Inbox are already generic over `type`.

**Files:**
- Modify: `server/src/services/approvals.ts`
- Test: `server/src/__tests__/approvals-mcp-connector.test.ts` (new) — follow the repo's approval-service test pattern (sequence/Proxy DB mocks).

**Verified facts (feat/mcp-connectors):** `approvalService(db)` at `approvals.ts:10`; `approve(id, companyId, decidedByUserId, decisionNote?)` at `:45`; the guarded status-flip UPDATE at `:115-126`, `if (!updated) return null` at `:132`; existing per-type blocks (`hire_agent` :136-183, `crew_dispatch` :192-241) run AFTER the flip; `return updated` at `:243`. `reject()` at `:246`; its `hire_agent` cleanup at `:276-282` (terminates the pending agent), `crew_dispatch` at `:284-286` (no-op). `approvals.type` is free text (no migration). Payload = `{connectorId, serverName}`. `mcpConnectorService(db)` (`mcp-connectors-crud.ts`) has `getById(id)` and `update(id, {status})` — no import cycle.

- [ ] **Step 1: Write the failing tests**

Create `server/src/__tests__/approvals-mcp-connector.test.ts` asserting:
- **approve → activate:** approving an `install_mcp_connector` approval whose payload `connectorId` points at a `pending_approval` connector calls `mcpConnectorService.update(connectorId, {status:"active"})`.
- **idempotent:** if the connector is already `active`, approve does NOT call update again (guard on `status !== "active"`).
- **connector deleted:** if `getById(connectorId)` returns null, approve does NOT throw and completes (the approval still resolves).
- **company scope:** a connector whose `companyId` differs from the approval's `companyId` is NOT flipped.
- **reject → cleanup:** rejecting the approval disables (or removes — pick per Step 3) the pending connector.

Follow an existing approvals-service test for the DB-mock shape. Mock `mcpConnectorService` at the module boundary.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/__tests__/approvals-mcp-connector.test.ts`
Expected: FAIL (no handler yet).

- [ ] **Step 3: Implement**

In `approvals.ts`, instantiate the connector service near `agentsSvc` (~`:11`): `const mcpConnectorSvc = mcpConnectorService(db);` (import from `./mcp-connectors-crud.js`).

In `approve()`, insert BEFORE `return updated;` (~`:243`), after the `crew_dispatch` block:
```ts
if (updated.type === "install_mcp_connector") {
  const payload = updated.payload as Record<string, unknown>;
  const connectorId = typeof payload.connectorId === "string" ? payload.connectorId : null;
  if (connectorId) {
    const connector = await mcpConnectorSvc.getById(connectorId);
    // null-tolerant (connector may have been deleted); company-scoped
    // (update() keys on id alone); idempotent (skip if already active).
    if (connector && connector.companyId === companyId && connector.status !== "active") {
      await mcpConnectorSvc.update(connectorId, { status: "active" });
    }
  }
}
```

In `reject()`, insert before its `return updated;` (~`:288`), mirroring `hire_agent` cleanup. **Decision: disable rather than delete** — keeps an audit trail and matches the connector's `disabled` status semantics (a rejected connector should be visibly rejected, not vanish):
```ts
if (updated.type === "install_mcp_connector") {
  const payload = updated.payload as Record<string, unknown>;
  const connectorId = typeof payload.connectorId === "string" ? payload.connectorId : null;
  if (connectorId) {
    const connector = await mcpConnectorSvc.getById(connectorId);
    if (connector && connector.companyId === companyId && connector.status === "pending_approval") {
      await mcpConnectorSvc.update(connectorId, { status: "disabled" });
    }
  }
}
```

**Critical:** the side-effect runs AFTER the guarded flip UPDATE (like `hire_agent`), so a concurrent double-approve flips zero rows on the loser and the side-effect only runs for the winner. It must never throw after the flip — the null/scope/status guards ensure a no-op rather than an exception (a throw with no wrapping txn on the MCP approval path would strand the approval).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/src/__tests__/approvals-mcp-connector.test.ts` and `pnpm --filter @armyofagents/server typecheck`
Expected: pass (all five cases).

- [ ] **Step 5: Run the existing approvals suite (no regression)**

Run: `pnpm vitest run server/src/services/__tests__ -t approval` (or the actual approvals test file)
Expected: existing `hire_agent`/`crew_dispatch` approval tests still green.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/approvals.ts server/src/__tests__/approvals-mcp-connector.test.ts
git commit -m "feat(mcp): approve install_mcp_connector activates the connector; reject disables it"
```

---

## Task 5: End-to-end verification

**Files:** an integration test + verification runs. No new production code.

- [ ] **Step 1: Full suites**

Run: `pnpm vitest run server/src` and `pnpm vitest run packages/adapter-utils`
Expected: green except the two known pre-existing flakes (`github-integration` env-host, `discussions-routes-contract` perf). Any OTHER failure is a regression.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm -r typecheck`
Expected: clean across all packages.

- [ ] **Step 3: Live end-to-end driving the REAL builders (A33)**

Extend or add an integration test (mirror Plan 1's `mcp-connectors-e2e-delivery.integration.test.ts`, `skipIf(win32)` for CI, runs locally on Windows via embedded-PG) that, against a real DB:
1. Creates a company secret + connector + a crew agent link; runs the REAL crew delivery path (drive `runAoaAgent` as far as the config build, or the smallest real seam that builds the crew config) and asserts the generated `--mcp-config` file has the placeholder (no plaintext) and `config.env` has the token.
2. Drives the REAL Commander `resolveCliInvocation` + closure merge with `agentId:null` and asserts the connector is in the config and `invocation.spawnEnv` carries the token.
3. Drives the REAL approval flow: create a `pending_approval` connector + approval, call `approvalService.approve`, assert the connector is now `active` and `loadEnabledConnectorRows` returns it.
Do NOT hand-assemble an argv — call the real builders (A33-LESSON: the Plan 1 probe that hand-built an argv missed the crew `extraArgs` bug).

- [ ] **Step 4: Brand-check / lint gates**

Run: `pnpm check:tokens` (and any brand-check). Expected: clean (Plan 1 documented the `AOA_MCP_*` family; no new env names introduced here).

- [ ] **Step 5: Commit + final note**

```bash
git add -A
git commit -m "test(mcp): end-to-end verification of crew + Commander delivery + approval activation"
```

---

## Follow-ups (not in this plan)

- **The three remaining adapters** (gemini_local, opencode_local, codex_local) — the transport-union treatment for their config writers, incl. the codex TOML stripper + `http_headers` verify-item (Plan-1 amendment A3). Separate plan.
- **Commander codex path** — connector delivery via `CODEX_HOME/config.toml` (this plan did claude_cli only).
- **Marketplace `connector` type** + curated catalog + bulk registry import (Plan 3).
- **Flagship plugins + OAuth broker** (Plan 4).
- **Hub summary polish** — optionally special-case `serverName` in `approvalSummary` so the connector approval shows the server name instead of "Approval type: install mcp connector" (cosmetic).

## Execution notes (Plan 2)

**P2N1 — Commander connector resolution is best-effort (try/catch + warn); crew/heartbeat fail-hard.** Deliberate: Commander is always-on, so a connector-load DB failure degrades to no-connectors + `logger.warn(..., "Commander MCP connector resolution failed; proceeding without connectors")` rather than failing the turn. Consistent with the loader's A8/A19 warn-and-continue. **Fold into Task 5 (cleanup):** the inline comment's secondary rationale ("tests would throw") is overstated — `cli-mode.test.ts` mocks `resolveAgentConnectors` at module level, so the guard is justified by the production-degradation reason ALONE; correct the comment to say so.

**P2N2 — Commander resolves connectors at the FIRST-message spawn of a persistent claude session; env is fixed at spawn.** A connector added/removed mid-conversation does NOT take effect until the session recycles. Inherent to the persistent-process model (out of scope to change), but a real "I added a connector and Commander still can't see it" debugging gotcha. **Fold into Task 5:** add a one-line code comment at the Commander merge site noting this, and list it under known limitations.

**P2N3 (from P2-2 review, Minor) — crew no-connector regression test asserts only `config.env` deep-equals `{}`, not a full-config snapshot.** Adequate (env is the only field the change touches), but a full captured-config `toEqual` would make byte-identity self-evident. Optional; fold into Task 5 only if cheap.

## Task 5 — end-to-end verification + cleanup (DONE)

- **P2N1 RESOLVED** — the Commander try/catch comment in `cli-mode.ts` now states the guard is justified by the production-degradation reason ALONE (Commander is always-on → a connector-load DB failure degrades to no-connectors + warn, never fails the turn), and explicitly notes the unit tests mock `resolveAgentConnectors` at module level so they never reach/depend on the guard.
- **P2N2 RESOLVED** — added a one-line `LIMITATION (P2N2)` comment at the Commander `connectorEnv` merge site: connectors are resolved at the FIRST-message spawn of a persistent claude session and the env is fixed at spawn, so a connector added/removed mid-conversation won't take effect until the session recycles.
- **P2N4 (new, regression found+fixed during Task 5 verification)** — Plan 2 Task 2 (crew delivery, `b06bf383a`) added a `resolveAgentConnectors` call to `runAoaAgent` and updated the DB mock in `aoa-runner.test.ts`, but MISSED the sibling `aoa-runner-context-bundle.test.ts` (also a `claude_local` crew runner test with a sequence-mock DB). The new connector queries consumed that mock's rows → 4 failing tests. Fixed by module-mocking `../services/mcp-connectors-loader.js` (`resolveAgentConnectors` → `{ extraMcpServers:{}, connectorEnv:{} }`) exactly as the sibling does. Test-only change; no production behavior touched.
- **Live e2e proof** — `server/src/__tests__/mcp-connectors-plan2-e2e.integration.test.ts` (embedded-PG, `skipIf(win32)` for CI, verified passing locally on Windows): (1) real `approvalService.approve` flips a pending connector → `active` + loader now returns it; real `reject` → `disabled` + loader excludes it; (2) real `resolveAgentConnectors` (per-agent opt-in) + the real runner `buildMcpConfig`+`writeFile` seam → placeholder on disk, secret only in env; (3) real Commander `resolveAgentConnectors(agentId:null)` returns all-active, excludes pending_approval.
- **Suites** — server: 8758 passed / 315 skipped / 1 acceptable fail (`github-integration`, env-host). adapter-utils: 208 passed. `pnpm -r typecheck` clean. `pnpm check:tokens` + env-doc-completeness scan clean (no new `AOA_*`).
