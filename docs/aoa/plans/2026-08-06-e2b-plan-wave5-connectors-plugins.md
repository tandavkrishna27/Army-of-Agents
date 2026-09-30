# E2B Cloud Execution Isolation — Implementation Plan (Wave 5: wave5-connectors-plugins)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to execute this wave task-by-task. Steps use `- [ ]` checkboxes.
>
> **Spec (authoritative):** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`. **Execute waves in order 0→7; U8 / guard-flip is LAST.** Each wave is an independently testable PR-cut candidate.

---

## Wave 5 — Connectors + plugins

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to execute this wave task-by-task. Steps use `- [ ]` checkboxes.
>
> **Spec (authoritative):** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`. **Execute waves in order 0→7; U8 / guard-flip is LAST.** Each wave is an independently testable PR-cut candidate.

---

## Wave 5 — Connectors + plugins

**Goal:** Give cloud tenants full connector + plugin parity now that a per-run E2B sandbox exists. Admit **stdio MCP connectors** inside the VM (the sandbox is the containment that makes `npx` safe on shared infra) and **re-enable plugins on cloud** by routing the sandboxed agent's `executeTool` calls through the networked broker to a **host-resident** plugin worker that never enters the VM. Covers **U11** (stdio connectors in-VM) and **U10** (plugins in cloud).

**Depends on:** the core sandbox units **U1–U9 + U12/U13** (U1 platform-default environment resolution + U2 broker, U3 crew JWT, U4 lease wiring that threads an `EnvironmentAcquisitionResult` — whose driver lives at `acquisition.environment.driver` (S5), **not** a top-level `EnvironmentAcquisitionResult.driver` — and U8 D1-guard flip). This wave is the recommended **PR-cut carve-out** (§11/§12/§15): it sits on top of the working sandbox and does not block it.

**Grounding notes (verified in `C:/Users/TK/.aoa/wt/e2b-exec`):**
- The transport gate `isTransportAllowed(transport, deploymentMode, source, trustTier)` (`server/src/services/mcp-connector-transport-gate.ts:44`) refuses `stdio` unless `deploymentMode === "local_trusted"` or a `verified` catalog entry. It is called at create-time (`routes/mcp-connectors.ts:727/742/894/988`, `services/mcp-connector-create.ts`) and at delivery-time inside `selectConnectorRowsForAgent` (`services/mcp-connectors.ts:234`, `isTransportAllowed` at `:248`).
- The single delivery seam is `resolveAgentConnectors` (`services/mcp-connectors-loader.ts:479`), called by heartbeat (`services/heartbeat.ts:4600`), crew (`services/internal-agent/aoa-agents/runner.ts:425`), and Commander (`services/internal-agent/cli-mode.ts:878`/`:1039`). `loadEnabledConnectorRows` (`:114`) and `isConnectorToolAutoAllowed` (`:406`) both pass `deploymentMode` into the selector.
- Command-pinning `isStdioCommandSafe`/`assertStdioCommandSafe` (`services/mcp-connector-command-safety.ts`) is **mode-independent** and re-checked at delivery (`mcp-connectors.ts:271`) — it must stay untouched.
- The plugin cloud block is `isCloudPluginExecutionBlocked()` → `tenantIsolationEnforced()` (`services/cloud-plugin-execution.ts:71`), enforced via `assertCloudPluginExecutionAllowed` at worker-fork (`plugin-worker-manager.ts:620/1255`), lifecycle (`plugin-lifecycle.ts:434`), loader (`plugin-loader.ts:1280/1679/1764`), install (`marketplace-install/plugin-installer.ts:105`), and the board tool-execute route (`routes/plugins.ts:752`, `rejectBlockedCloudExecution`).
- The broker is `POST /companies/:companyId/mcp` (`server/src/mcp/server.ts:395`): `tools/list` returns the static `TOOL_DEFINITIONS` (`:562`), `tools/call` resolves `toolHandlers[params.name]` and returns `-32601 Tool not found` for anything unmapped (`:572-576`). Plugin tools are **not** exposed here today.
- Plugin descriptors + execution already exist host-side: `pluginToolDispatcher.listToolsForAgent(filter?)` and `.executeTool(name, params, runContext)` (`services/plugin-tool-dispatcher.ts:120/141`), reached via the global handle `(globalThis as any).__paperclipPluginToolDispatcher` (used at `heartbeat.ts:4405`).
- **Host-side plugin authz (corrected):** there is **no importable** `resolvePluginInCompany(db, …)` — the function at `routes/plugins.ts:422` is a **non-exported nested `async function(pluginId, companyId)`** that closes over route-scoped `registry`/`db` (wrong arity, uncallable from the broker). Ownership is instead asserted from registry data: a `RegisteredTool` carries its owning `companyId` (`plugin-tool-registry.ts:65`) and `pluginDbId` (`:63`), and `pluginToolDispatcher.getTool(namespacedName, companyId)` (`plugin-tool-dispatcher.ts:453` → registry `getTool` at `plugin-tool-registry.ts:381`) is **already company-scoped**. So the broker asserts `registered.companyId === companyId` (belt-and-suspenders on top of the scoped lookup) — never body-supplied, no cross-module import.

---

### Task: U11 — Thread a `sandboxTarget` signal into the transport gate

Relax **only** the stdio admissibility axis when the run executes inside a sandbox; keep the command-pinning check and every other predicate intact.

**Files:**
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/mcp-connector-transport-gate.ts`
- Test (modify/extend): `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/mcp-connectors-routes.test.ts` — or add a focused `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/__tests__/mcp-connector-transport-gate.test.ts` (no dedicated file exists yet; create one following the `services/__tests__` pattern).

1. **Write the failing test.** In the new `mcp-connector-transport-gate.test.ts`, encode the exact truth-table delta:
   ```ts
   import { describe, it, expect } from "vitest";
   import { isTransportAllowed } from "../mcp-connector-transport-gate.js";

   describe("isTransportAllowed — sandbox axis (U11)", () => {
     it("admits stdio on cloud_auth ONLY when the run targets a sandbox", () => {
       // baseline (unchanged): stdio refused on a shared host without a sandbox
       expect(isTransportAllowed("stdio", "cloud_auth", "byo", undefined, false)).toBe(false);
       // U11: same connector, but this run executes inside a per-run sandbox
       expect(isTransportAllowed("stdio", "cloud_auth", "byo", undefined, true)).toBe(true);
     });
     it("does NOT weaken http (always allowed) or local_trusted (already allowed)", () => {
       expect(isTransportAllowed("http", "cloud_auth", "byo", undefined, false)).toBe(true);
       expect(isTransportAllowed("stdio", "local_trusted", "byo", undefined, false)).toBe(true);
     });
     it("sandboxTarget is additive, never a denylist — verified catalog still passes without it", () => {
       expect(isTransportAllowed("stdio", "cloud_auth", "catalog", "verified", false)).toBe(true);
     });
   });
   ```
2. **Run it — expect FAIL** (`isTransportAllowed` has arity 4; the new 5th arg is ignored, so the cloud+sandbox case returns `false`).
3. **Implement.** Add a trailing optional `sandboxTarget = false` parameter and one early-return branch, keeping the existing order:
   ```ts
   export function isTransportAllowed(
     transport: string,
     deploymentMode: string,
     source: string,
     trustTier?: string,
     sandboxTarget = false,
   ): boolean {
     if (transport !== "stdio") return true;          // http is always fine
     if (deploymentMode === "local_trusted") return true;
     if (source === "catalog" && trustTier === "verified") return true;
     // U11: a per-run E2B sandbox IS the containment that makes an npx/uvx stdio
     // server safe on shared infra. Admissible ONLY when this run resolved a
     // sandbox execution target — never for an unsandboxed shared-host run.
     if (sandboxTarget) return true;
     return false;
   }
   ```
   Update `assertTransportAllowed` to forward the new arg (default `false`) so existing create-time callers (which do not sandbox at persist time) are unchanged.
4. **Run — expect PASS.**
5. **Commit:** `feat(connectors): admit stdio transport when the run targets a sandbox (U11)`

---

### Task: U11 — Plumb the sandbox signal through the delivery selector

Carry `sandboxTarget` from the run's resolved execution driver down to `selectConnectorRowsForAgent` so a stdio connector is delivered in-VM but still dropped on an unsandboxed host.

**Files:**
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/mcp-connectors.ts` (`ConnectorSelectionInput`, `selectConnectorRowsForAgent`)
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/mcp-connectors-loader.ts` (`LoadEnabledConnectorRowsOptions`, `loadEnabledConnectorRows`, `ResolveAgentConnectorsInput`, `resolveAgentConnectors`, `ConnectorToolAutoAllowInput`, `isConnectorToolAutoAllowed`)
- Test (modify): `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/__tests__/mcp-connectors.test.ts` and `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/mcp-connectors-loader.test.ts`

1. **Write the failing test** in `mcp-connectors.test.ts`:
   ```ts
   it("selectConnectorRowsForAgent: stdio kept on cloud when sandboxTarget, dropped otherwise", () => {
     const rows = [{ id: "c1", status: "active", transport: "stdio",
       source: "byo", command: "npx", args: ["@notionhq/notion-mcp-server@1.2.3"] }];
     const base = { connectors: rows, enabledConnectorIds: new Set(["c1"]),
       isCommander: false, deploymentMode: "cloud_auth" as const };
     expect(selectConnectorRowsForAgent({ ...base, sandboxTarget: false })).toHaveLength(0);
     expect(selectConnectorRowsForAgent({ ...base, sandboxTarget: true })).toHaveLength(1);
   });
   it("sandboxTarget does NOT bypass command pinning (unsafe_command still drops)", () => {
     const rows = [{ id: "c1", status: "active", transport: "stdio",
       source: "byo", command: "npx", args: ["evil@latest"] }]; // unpinned → unsafe
     const skips: string[] = [];
     const kept = selectConnectorRowsForAgent({ connectors: rows,
       enabledConnectorIds: new Set(["c1"]), isCommander: false,
       deploymentMode: "cloud_auth", sandboxTarget: true,
       onSkip: (_c, r) => skips.push(r) });
     expect(kept).toHaveLength(0);
     expect(skips).toContain("unsafe_command");
   });
   ```
2. **Run it — expect FAIL** (no `sandboxTarget` field; the D7 branch drops the stdio row even when sandboxed).
3. **Implement.**
   - Add `sandboxTarget?: boolean` to `ConnectorSelectionInput` and pass it as the 5th arg of `isTransportAllowed` inside `selectConnectorRowsForAgent` (`mcp-connectors.ts:248`). Leave the `isStdioCommandSafe` block at `:268` exactly as-is (the second test proves it still fires).
   - Add `sandboxTarget?: boolean` to `LoadEnabledConnectorRowsOptions`; forward it into the `selectConnectorRowsForAgent` call in `loadEnabledConnectorRows` (`mcp-connectors-loader.ts:151`).
   - Add `sandboxTarget?: boolean` to `ResolveAgentConnectorsInput`; forward through the `loadEnabledConnectorRows` call (`:483`).
   - Add `sandboxTarget?: boolean` to `ConnectorToolAutoAllowInput`; forward into the `selectConnectorRowsForAgent` call in `isConnectorToolAutoAllowed` (`:437`) so the PreToolUse auto-allow gate agrees with delivery (a stdio connector tool is only auto-allowed when the run is sandboxed).
   - Default everywhere is `false` → desktop/`local_trusted` and unsandboxed cloud paths are byte-identical.
4. **Run — expect PASS.**
5. **Commit:** `feat(connectors): thread sandboxTarget through the connector delivery selector (U11)`

---

### Task: U11 — Source `sandboxTarget` from the resolved run driver at the three call sites

Set the flag from the run's actual execution target — `acquisition.environment.driver === "sandbox"` (S5: the driver lives on the acquisition result's `environment`, **not** a top-level `acquisition.driver`, which is `undefined`) — so it is true exactly when the CLI runs inside E2B.

**Files:**
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/heartbeat.ts` (the `resolveAgentConnectors` call at `:4600`)
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/internal-agent/aoa-agents/runner.ts` (`:425`)
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/internal-agent/cli-mode.ts` (`:878` and `:1039`)
- Test (modify): `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/heartbeat-mcp.test.ts`

1. **Write the failing test** in `heartbeat-mcp.test.ts`: mock the environment acquisition to return `{ environment: { driver: "sandbox" } }` (S5 shape) and assert `resolveAgentConnectors` is invoked with `sandboxTarget: true`; with `{ environment: { driver: "local" } }` assert `sandboxTarget: false`.
2. **Run it — expect FAIL** (call site passes no `sandboxTarget`).
3. **Implement.** At each call site, derive the flag from the already-resolved acquisition result that U4 threads onto the run (the `EnvironmentAcquisitionResult` returned by `environmentRunOrchestrator.acquireForRun`). That interface `extends EnvironmentRuntimeLeaseRecord` (`environment-run-orchestrator.ts:44`), whose `environment: Environment` field (`environment-runtime.ts:64`) carries `driver` (`Environment.driver`) — there is **no** top-level `driver` on the result. In heartbeat the result feeds `resolvedConfigWithEnvironmentAcquisition`; carry `const runTargetsSandbox = acquisition?.environment?.driver === "sandbox"` alongside it and pass `sandboxTarget: runTargetsSandbox` into `resolveAgentConnectors`. Do the same in the crew runner (from the U4 acquire-execution-context handle) and both Commander spawns in `cli-mode.ts`. Commander has no `functionType`, but on cloud it still resolves a sandbox target, so its connectors get the same admissibility.
4. **Run — expect PASS.**
5. **Commit:** `feat(connectors): set sandboxTarget from the resolved run driver (U11)`

---

### Task: U11 — Extend the VM egress allowlist with connector hosts + npm

Let the sandbox reach the npm registry (for `npx`/`uvx` stdio servers) and each delivered connector's host by unioning them into the `egressAllowlist?: string[]` param U6 introduced on the sandbox provider's create/resume path (S4) — lease metadata; best-effort on managed E2B. Do **not** assume U6 built an allowlist of some other shape; the seam is that single `egressAllowlist` string array.

**Files:**
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/mcp-connectors-env.ts` (add a pure `buildConnectorEgressHosts` helper next to `buildConnectorProcessEnv` at `:35`)
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/mcp-connectors-loader.ts` (return the hosts from `resolveAgentConnectors`)
- Modify: the sandbox stage-in that assembles the `egressAllowlist` (the `egressAllowlist?: string[]` param U6 added to `SandboxProviderAcquireInput` / the resume path in `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/sandbox-provider-runtime.ts`) — union the connector hosts into it
- Test: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/__tests__/mcp-connectors-env.test.ts`

1. **Write the failing test** in `mcp-connectors-env.test.ts`:
   ```ts
   it("buildConnectorEgressHosts: npm + http connector host, no host for stdio-only", () => {
     const hosts = buildConnectorEgressHosts([
       { transport: "http", url: "https://mcp.notion.com/mcp", serverName: "notion" } as any,
       { transport: "stdio", command: "npx", serverName: "local" } as any,
     ]);
     expect(hosts).toContain("mcp.notion.com");        // http connector host
     expect(hosts).toContain("registry.npmjs.org");    // stdio launcher needs npm
     // never a bare scheme/path, never a wildcard
     expect(hosts.every((h) => !h.includes("/") && h !== "*")).toBe(true);
   });
   ```
2. **Run it — expect FAIL** (helper does not exist).
3. **Implement.** `buildConnectorEgressHosts(rows)` returns a de-duplicated host list: for each `http` row, `new URL(row.url).host`; if any `stdio` row is present, add the npm/npx package hosts (`registry.npmjs.org`; add PyPI `pypi.org`/`files.pythonhosted.org` when the launcher is `uvx`). Have `resolveAgentConnectors` also return `egressHosts` (additive field; existing callers ignore it). In the U6 sandbox stage-in, union `egressHosts` into the `egressAllowlist` string array passed to the provider's create/resume before acquisition. Document (per §12 open risk) that on **managed** E2B this allowlist is advisory/best-effort — the blast-radius reframe (§9) is what makes stdio-in-VM acceptable.
4. **Run — expect PASS.**
5. **Commit:** `feat(connectors): allowlist npm + connector-host egress for sandboxed stdio connectors (U11)`

---

### Task: U11 — Assert OAuth/#317 connectors are unchanged (regression fence)

The OAuth broker (#317) connectors are **HTTP transport** with a host-minted access token — U11 must not touch their resolution/refresh, and they must stay admissible without the sandbox axis.

**Files:**
- Test (modify): `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/mcp-connectors-e2e-delivery.integration.test.ts`

1. **Write the test:** an active `notion-hosted` OAuth connector (HTTP) is delivered on `cloud_auth` with `sandboxTarget: false` (proves it never needed the stdio relaxation), and the resolved bearer lands in `connectorEnv` while the signed bundle / refresh token do **not** appear in `egressHosts` or `connectorEnv` (resolution/refresh stay host-side per §9/§14).
2. **Run — expect PASS** (no code change; this fences the U11 surface against OAuth regressions).
3. **Commit:** `test(connectors): fence OAuth HTTP connectors against the U11 stdio relaxation`

---

### Task: U10 — Lift the plugin cloud block for the host-resident-worker model

The worker is a **host** child-process whose powers are the tenant DB (`buildHostServices`); it never enters the VM. With the broker→host-worker path in place, the blanket cloud block is no longer the right policy — plugins run host-side and the sandboxed agent reaches them only via the broker.

**Files:**
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/cloud-plugin-execution.ts` (`isCloudPluginExecutionBlocked`)
- Test (modify): `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/cloud-plugin-execution.test.ts` and `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/plugin-worker-manager.test.ts`

1. **Write the failing test** in `cloud-plugin-execution.test.ts`:
   ```ts
   it("does NOT block plugin worker execution on cloud_auth (host-resident worker, U10)", () => {
     setDeploymentMode("cloud_auth");
     expect(isCloudPluginExecutionBlocked()).toBe(false);
   });
   it("assertCloudPluginExecutionAllowed no longer throws on cloud for a host worker fork", () => {
     setDeploymentMode("cloud_auth");
     expect(() => assertCloudPluginExecutionAllowed({
       pluginId: "p1", sink: "worker-fork", source: "direct" })).not.toThrow();
   });
   ```
2. **Run it — expect FAIL** (`isCloudPluginExecutionBlocked` returns `tenantIsolationEnforced()` → `true`).
3. **Implement.** Change `isCloudPluginExecutionBlocked()` to return `false` — the worker's host-side isolation (minimal env, host-side company-ownership checks, no VM entry) is now the enforced posture. Keep the whole `projectCloudPluginPolicyState` / `recordCloudPluginBlock` / boot-reconciliation machinery in place (it becomes inert on cloud but preserves the self-hosted→cloud downgrade projection and metrics). Update the stale `CLOUD_PLUGIN_BLOCK_MESSAGE` copy to reflect that plugins now run via a host-resident worker (the message is still referenced by `projectCloudPluginPolicyState` for historical rows). Do **not** remove `assertCloudPluginExecutionAllowed` — it remains a no-op-safe backstop.
4. **Run — expect PASS** (worker-manager/lifecycle/loader/installer gates all consult this predicate, so plugins now install, load, enable, and fork host-side on cloud). Re-run `plugin-worker-manager.test.ts` and `plugin-tenant-routes.test.ts` and fix any assertions that hard-coded the cloud block.
5. **Commit:** `feat(plugins): run the plugin worker host-side on cloud; drop the blanket block (U10)`

---

### Task: U10 — Expose plugin tool descriptors over the broker (`tools/list`)

A sandboxed agent must see its company's plugin tools in the broker's tool list, scoped to the run's `companyId`.

**Files:**
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/mcp/server.ts` (the `tools/list` branch at `:562`)
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/mcp/tools/index.ts` (add a helper to convert `AgentToolDescriptor` → MCP tool definition; keep the plugin actor gate)
- Test (modify): `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/mcp-server.test.ts`

1. **Write the failing test** in `mcp-server.test.ts`: with a stubbed `__paperclipPluginToolDispatcher.listToolsForAgent({ companyId })` returning one descriptor `{ name: "acme.linear:search-issues", displayName, description, parametersSchema, pluginId }` for company `c1`, an **agent**-actor `tools/list` on `/companies/c1/mcp` includes a tool named `acme.linear:search-issues` alongside the static `TOOL_DEFINITIONS`; a `tools/list` for a **different** company `c2` (dispatcher returns `[]`) does **not** include it (per-company scoping).
2. **Run it — expect FAIL** (`tools/list` returns only the static array).
3. **Implement.** In the `tools/list` branch, after the static array, append plugin descriptors:
   ```ts
   const pluginTools = readPluginToolDefinitions(companyId); // reads the global dispatcher, maps to MCP shape
   res.json(jsonRpcResult(requestBody.id ?? null, {
     tools: [...TOOL_DEFINITIONS, ...pluginTools],
   }));
   ```
   Add `readPluginToolDefinitions(companyId)` in `tools/index.ts` (or a small `plugin-broker-tools.ts` sibling): read `(globalThis as any).__paperclipPluginToolDispatcher?.listToolsForAgent({ companyId })`, map each `AgentToolDescriptor` to `{ name, description, inputSchema: parametersSchema }`. Best-effort: a dispatcher error logs and yields `[]` (mirrors the `heartbeat.ts:4417` try/catch — plugin unavailability degrades the tool list, never breaks the broker).
4. **Run — expect PASS.**
5. **Commit:** `feat(plugins): expose per-company plugin tool descriptors over the broker tools/list (U10)`

---

### Task: U10 — Route plugin `executeTool` through the broker to the host worker

A `tools/call` for a plugin tool must dispatch to the host-resident worker with the run's verified identity, preserving host-side authz, and must never fall through to the `-32601 Tool not found` path.

**Files:**
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/mcp/server.ts` (the `tools/call` branch at `:569`, before the `!handler` return at `:572`)
- Modify: `C:/Users/TK/.aoa/wt/e2b-exec/server/src/mcp/tools/index.ts` (add `isPluginToolName` + a plugin-dispatch helper, and add plugin tools to the `agent`-only actor gate)
- Test (modify): `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/mcp-server.test.ts` + `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/mcp-agent-actor.test.ts`

1. **Write the failing tests** in `mcp-server.test.ts`:
   ```ts
   it("routes a plugin tool call to the host dispatcher with the run's verified identity", async () => {
     const executeTool = vi.fn().mockResolvedValue({ pluginId: "p1", result: { content: "ok" } });
     (globalThis as any).__paperclipPluginToolDispatcher = {
       listToolsForAgent: () => [{ name: "acme.linear:search", displayName: "s", description: "d", parametersSchema: {}, pluginId: "p1" }],
       // getTool is company-scoped; RegisteredTool carries its owning companyId + pluginDbId.
       getTool: (name: string, cid: string) =>
         cid === "c1" ? { pluginDbId: "p1", companyId: "c1" } : null,
       executeTool,
     };
     const res = await agentActorCall("c1", "acme.linear:search", { query: "auth" }); // agent run-JWT for c1/agent-a/run-r
     expect(res.status).toBe(200);
     // companyId + agentId + runId come from the VERIFIED JWT context, never the request body
     expect(executeTool).toHaveBeenCalledWith("acme.linear:search",
       { query: "auth" },
       expect.objectContaining({ companyId: "c1", agentId: "agent-a", runId: "run-r" }));
   });

   it("an UNPORTED/unknown tool over the broker is an explicit MCP error, never a silent no-op", async () => {
     const res = await agentActorCall("c1", "nonexistent.tool:foo", {});
     expect(res.body.error.code).toBe(-32601); // §5 anti-drift invariant
   });

   it("a plugin tool is agent-only over the broker (board/mcp/commander get 403)", async () => {
     const res = await mcpActorCall("c1", "acme.linear:search", {});
     expect(res.status).toBe(403);
   });

   it("cross-company plugin tool call 404s (getTool is company-scoped → null / companyId mismatch for c1)", async () => {
     // dispatcher.getTool("acme.other:tool", "c1") returns null (not owned by c1)
     const res = await agentActorCall("c1", "acme.other:tool", {});
     expect(res.status).toBe(404);
   });
   ```
2. **Run them — expect FAIL** (plugin names hit the `!handler` branch → 400/`-32601` even for a valid plugin tool; no dispatch happens).
3. **Implement.** In the `tools/call` branch, before `const handler = toolHandlers[params.name]`:
   ```ts
   if (isPluginToolName(params.name)) {
     // Plugin tools are agent-facing only. board/mcp/commander over the broker cannot call them.
     if (protocolActor.source !== "agent") {
       res.status(403).json(jsonRpcError(id, -32003, `Tool ${params.name} is not available for ${protocolActor.source} actors`));
       return;
     }
     const dispatcher = (globalThis as any).__paperclipPluginToolDispatcher as PluginToolDispatcher | undefined;
     // getTool(name, companyId) is ALREADY company-scoped (plugin-tool-dispatcher.ts:453 →
     // registry getTool at plugin-tool-registry.ts:381). Belt-and-suspenders: the returned
     // RegisteredTool.companyId (plugin-tool-registry.ts:65) must equal the JWT company.
     // NOTE: do NOT import routes/plugins.ts `resolvePluginInCompany` — it is a non-exported
     // nested async fn (arity 2, closure-scoped registry) and is not callable here.
     const registered = dispatcher?.getTool(params.name, companyId);
     if (!registered || registered.companyId !== companyId) {
       res.status(404).json(jsonRpcError(id, -32004, `Tool ${params.name} not found`));
       return;
     }
     const runContext = { agentId: protocolActor.agentId, runId: protocolActor.runId,
       companyId, projectId: /* from the run record via services */ };
     const result = await dispatcher!.executeTool(params.name, args, runContext);
     res.json(jsonRpcResult(id, asToolContent(result.result)));
     return;
   }
   ```
   - `isPluginToolName(name)` = name matches the plugin namespaced shape (`<pluginKey>:<tool>`, i.e. contains the `TOOL_NAMESPACE_SEPARATOR` `:` and is not one of the reserved dotted internal names) — put it in `tools/index.ts` so the broker and the anti-drift test share one predicate.
   - **Ownership is registry-data, not a cross-module call:** the scoped `getTool(name, companyId)` returns `null` for a tool not owned by `companyId`; the explicit `registered.companyId !== companyId` guard is the belt-and-suspenders assertion. No `db`/route helper is imported.
   - The **worker never enters the VM**: `dispatcher.executeTool` runs the host-resident worker; only the JSON result crosses back to the sandbox over the broker HTTP response.
   - `runContext.projectId`: resolve from the run/agent record host-side (the agent's default project) — the sandbox never supplies it.
   - Leave the existing `!handler` → `-32601` fallthrough intact for genuinely unknown names (the anti-drift invariant). Do **not** route plugin tools through the board-authed `POST /api/plugins/tools/execute` route — that path stays board-only and cloud-guarded; the broker path is the agent path.
4. **Run — expect PASS.**
5. **Commit:** `feat(plugins): dispatch broker plugin tool calls to the host worker with run-JWT authz (U10)`

---

### Task: U10 — Cloud integration proof (real embedded-PG)

Prove end-to-end on cloud that a plugin tool call from an agent-JWT reaches the host worker and returns, with cross-company isolation held.

**Files:**
- Test (create): `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/plugin-broker-cloud.integration.test.ts` (follow the embedded-PG pattern of `mcp-connectors-e2e-delivery.integration.test.ts` and `mcp-memory-read-rbac.integration.test.ts`)

1. **Write the test:** `setDeploymentMode("cloud_auth")`; seed a company `c1` with a ready plugin exposing one tool; mint an agent run-JWT for `c1`; `tools/list` includes the plugin tool; `tools/call` returns the worker's result; the same call presented with a **`c2`** JWT 404s (the company-scoped `getTool` yields no tool owned by `c2`); assert `isCloudPluginExecutionBlocked() === false` so the host worker actually ran.
2. **Run — expect PASS** (gated `AOA_E2E_FAKE_EMBEDDER=1` per the CI-reality note in §10; no live E2B needed — the broker + host worker are exercised without a VM).
3. **Commit:** `test(plugins): cloud broker→host-worker plugin dispatch integration proof (U10)`

---

**Wave 5 exit criteria:**
- A stdio connector (e.g. `npx @notionhq/notion-mcp-server@<pinned>`) is **delivered and admissible** to a sandboxed run on `cloud_auth`, and **dropped** on any unsandboxed cloud run — with `isStdioCommandSafe` pinning still enforced (an unpinned/`@latest`/shell-metachar command is dropped with `unsafe_command`).
- `sandboxTarget` is sourced correctly from `acquisition.environment.driver === "sandbox"` (S5) at all three call sites — never a top-level `acquisition.driver`.
- OAuth (#317) and static-secret HTTP connectors are unchanged: delivered with `sandboxTarget: false`, refresh/resolution stay host-side, and the signed bundle / refresh token never appear in VM env or the egress host list.
- The sandbox `egressAllowlist` (the U6 param) includes `registry.npmjs.org` (+ PyPI hosts for `uvx`) and each delivered HTTP connector's host; nothing wildcards.
- On `cloud_auth`, plugins **install, load, enable, and fork host-side**; `isCloudPluginExecutionBlocked()` is `false`; the worker process never enters the VM.
- A sandboxed **agent** actor sees its company's plugin tools in the broker `tools/list` and can `tools/call` them; **board/mcp/commander** actors get 403 for plugin tools over the broker; an unported/unknown tool returns an explicit `-32601`, never a silent no-op; a cross-company plugin tool call 404s (via the company-scoped `getTool` + `registered.companyId === companyId` assertion — no import of the non-exported `routes/plugins.ts` helper).
- All new/changed unit + integration suites green under `AOA_E2E_FAKE_EMBEDDER=1`; desktop/`local_trusted` paths are byte-identical (every new flag defaults to `false`/inert).

**PR-cut note:** This wave **is** the recommended carve-out (§11/§12/§15). Land the core sandbox units **U1–U9, U12, U13** as the first PR; ship **U11 + U10** as this second, self-contained fast-follow PR — both sit entirely on top of the working sandbox and broker and block nothing in the core.
