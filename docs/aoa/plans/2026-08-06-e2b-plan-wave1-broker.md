# E2B Cloud Execution Isolation — Implementation Plan (Wave 1: wave1-broker)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to execute this wave task-by-task. Steps use `- [ ]` checkboxes.
>
> **Spec:** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`. **Shared seams:** the INDEX. Execute waves 0→7; U8/guard-flip LAST.

---

## Wave 1 — Networked broker + crew JWT

**Goal:** Move all AoA-internal, DB-touching tool access off the sandbox VM and onto the control-plane HTTP MCP endpoint (`POST /companies/:companyId/mcp`, `server/src/mcp/server.ts:395`) authed by the per-run run-JWT — porting the **full** internal tool registry (`createToolRegistry()`) with per-agent-actor RBAC, hardening the three unscoped memory-search tools, and giving crew a networked identity by minting a run-JWT. This wave covers **U3 (crew run-JWT)** and **U2 (networked MCP broker)** — the core re-architecture and the top review-focus surface.

**Build order inside the wave:** U3 → U2a (memory RBAC hardening) → U2b (server-side ToolContext resolver) → U2c (broker registry dispatch + parity) → U2d (MCP-config HTTP seam) → U2e (runtime-hook re-point). U3 lands first so the broker has a crew identity to authenticate in U2c's integration test.

Two `ToolContext` types exist and must not be confused: the **outbound** one (`server/src/mcp/tools/types.ts`, used by `mcp/server.ts` `toolHandlers`) and the **internal-agent** one (`server/src/services/internal-agent/types.ts`, used by `createToolRegistry()`). U2 brokers the **internal-agent** registry; the outbound handlers stay for board/external-mcp callers.

---

### Task: U3 — Crew run-JWT

Crew's `adapter.execute` passes literal `authToken: undefined` (`runner.ts:975`), so a crew CLI has no networked identity and cannot authenticate to the broker. Mint a run-JWT exactly as org heartbeat does (`heartbeat.ts:4276-4277`).

**Files:**
- **Modify:** `server/src/services/internal-agent/aoa-agents/runner.ts` (mint at the `adapter.execute` call, replacing `authToken: undefined` at line 975; add the `createLocalAgentJwt` import)
- **Test (create):** `server/src/__tests__/crew-run-jwt.test.ts`

**Steps:**

1. **Write the failing test.** In `crew-run-jwt.test.ts`, unit-test the mint decision in isolation (no DB) by importing `createLocalAgentJwt` and `verifyLocalAgentJwt` from `server/src/agent-auth-jwt.ts` and asserting the crew claim shape:
   ```ts
   import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";
   // AOA_AGENT_JWT_SECRET must be set for jwtConfig() to return non-null
   process.env.AOA_AGENT_JWT_SECRET = "test-secret-at-least-32-chars-long-xx";
   const token = createLocalAgentJwt("agent-123", "co-abc", "claude_local", "run-xyz");
   expect(token).not.toBeNull();
   const claims = verifyLocalAgentJwt(token!);
   expect(claims).toMatchObject({ sub: "agent-123", company_id: "co-abc", run_id: "run-xyz" });
   ```
   Then add a source-structural assertion that `runner.ts` no longer hard-codes an undefined token: read the file and assert `authToken: undefined` is absent from the `adapter.execute` block and that `createLocalAgentJwt` is referenced. This encodes "crew mints a JWT" as a test that fails today.
2. **Run it — expect FAIL** (the structural assertion fails: `runner.ts` still contains `authToken: undefined`).
3. **Implement.** In `runner.ts`, immediately before the `adapter.execute({...})` call (~line 947), mint the token gated on the adapter flag (mirroring `heartbeat.ts:4276-4279`), using the already-resolved `agent` object and the `runId` minted at `runner.ts:225`:
   ```ts
   const crewAuthToken = adapter.supportsLocalAgentJwt && runId
     ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, runId)
     : null;
   if (adapter.supportsLocalAgentJwt && runId && !crewAuthToken) {
     log.warn({ companyId: agent.companyId, agentId: agent.id, runId, adapterType: agent.adapterType },
       "crew local agent jwt secret missing; running without injected AOA_API_KEY");
   }
   ```
   `adapter` is already in scope (`getServerAdapter(agent.adapterType)` at `runner.ts:373`). Replace `authToken: undefined,` at line 975 with `authToken: crewAuthToken ?? undefined,`. Add `import { createLocalAgentJwt } from "../../../agent-auth-jwt.js";` at the top.
4. **Run — expect PASS.**
5. **Commit:** `feat(crew): mint per-run run-JWT for crew adapter execution (U3)`

---

### Task: U2a — Harden the three unscoped memory-search tools for the agent actor

`query_memory`/`memory.search` already gate. But `find_similar_memory` (`memory-tools.ts:322` → `ctx.services.memory.searchSemantic`, companyId+status only), `detect_conflicts` (`memory-tools.ts:347` → `findSimilarItems`, companyId+status only), and `find_similar_memory_hnsw` (`memory-find-similar.ts`, raw pgvector, companyId+status only) return memory with **no scope/private filter** — safe when board/Commander-only, but **leaks cross-scope/private memory once a sandboxed `agent` actor can call them**. They must gain the `memoryAccessConditions` RBAC gate (Decisions #118/#119), mirroring the canonical read path `handleMemorySearch` (`server/src/mcp/tools/read-tools.ts:186-238`). This is the security invariant the spec calls out as "NOT verbatim."

**Grounded seam correction (this is the load-bearing fix):**
- `searchSemantic`'s filter type (`SemanticSearchFilters`, `memory.ts:49-53`) has **only** `layer`/`departmentId`/`limit` — **no `accessConditions`**. Only `searchMultiPath`'s filter type (`MultiPathSearchFilters`, `memory.ts:76-99`) carries `accessConditions?: SQL[]`, AND-ed into every pathway at **`memory.ts:637`** (NOT `memory.ts:264` — that line is the `list` method's own RBAC gate). Therefore `find_similar_memory` is **switched off `searchSemantic` and onto `searchMultiPath`**, exactly mirroring `handleMemorySearch` (`read-tools.ts:211`). `searchMultiPath`'s projection (`memory.ts:641-672`) already SELECTs `visibility`/`ownerType`/`ownerId`/`agentId`/`invalidatedAt`/`goalId`/`taskId`, so the post-fetch `filterMemoryForActor` safety net type-checks there.
- `detect_conflicts` (`findSimilarItems`, `memory.ts:876`) and `find_similar_memory_hnsw` (`memory-find-similar.ts`) both use **narrow SELECT projections** (`findSimilarItems` at `memory.ts:908-925` omits `visibility`/`ownerType`/`ownerId`/`agentId`/`invalidatedAt`; hnsw at `memory-find-similar.ts:118-125` selects only `id`/`title`/`content`/`layer`/`status`/`category`). Those rows do **not** satisfy `AccessibleMemoryRow` (`memory-access.ts:19-30`, whose `visibility` + `agentId` are required), so calling `filterMemoryForActor` over them is a projection-widening **compile error**. **Resolution: gate these two in-SQL only** — push the actor's `accessConditions` (which are WHERE clauses, projection-independent) into their `conditions` arrays and **drop** the redundant in-memory `filterMemoryForActor` pass. The in-SQL gate is authoritative; `memoryAccessConditions` already ANDs `isNull(invalidatedAt)` + scope/identity/company/private branches, so no post-fetch net is needed. (The alternative — widening both SELECTs to the full `AccessibleMemoryRow` shape — is deliberately **not** taken, to keep the two tools' rank-only result contracts unchanged.)

**Files:**
- **Modify:** `server/src/services/internal-agent/tools/memory-tools.ts` (`find_similar_memory` → `searchMultiPath` + gate; `detect_conflicts` → pass `accessConditions` into `findSimilarItems`)
- **Modify:** `server/src/services/internal-agent/tools/memory-find-similar.ts` (`findSimilarMemoryHnswTool` — union `accessConditions` into the local `conditions` array at `:101`/`:111`)
- **Modify:** `server/src/services/memory.ts` (add `accessConditions?: SQL[]` to `FindSimilarScope` at `:55-59` + AND it into `findSimilarItems`'s two `conditions` arrays — the semantic path at `:894-906` and the text-overlap fallback at `:949-955`)
- **Test (create):** `server/src/__tests__/memory-tools-agent-rbac.test.ts` (integration, embedded-PG)

**Steps:**

1. **Write the failing test** (embedded-PG, following the `mcp-agent-actor.test.ts` real-DB harness). Seed one company, one department D1, one crew agent assigned only to a *different* department D2 (via `agent_projects`, so `actorForAgentRun` resolves `departmentIds = [D2]`), and two approved memory items with distinct embeddings: `M-visible` (fully-unscoped / company-level) and `M-hidden` (`layer:'domain'`, `departmentId: D1`, i.e. out of the agent's D2 scope). Build the agent actor via `actorForAgentRun(db, companyId, agentId)` and assert that each tool, executed with an internal-agent `ToolContext` whose `actorType:"agent"` + `agentId` is the D2 agent, **excludes `M-hidden`** and **includes `M-visible`**:
   ```ts
   const ctx = makeAgentToolContext({ db, companyId, agentId: crewD2.id, actorType: "agent", runId });

   // find_similar_memory now dispatches searchMultiPath under the hood
   const fs = await findTool("find_similar_memory").execute({ query: "shared secret plan" }, ctx);
   expect(fs.data.map((r) => r.id)).not.toContain(hidden.id);
   expect(fs.data.map((r) => r.id)).toContain(visible.id);

   const dc = await findTool("detect_conflicts").execute(
     { proposedTitle: "x", proposedContent: "shared secret plan" }, ctx);
   expect(dc.data.conflicts.map((r) => r.id)).not.toContain(hidden.id);

   const hnsw = await findTool("find_similar_memory_hnsw").execute({ text: "shared secret plan" }, ctx);
   expect(hnsw.data.map((r) => r.id)).not.toContain(hidden.id);
   ```
   Because the embedded-PG bundle has no OpenAI key, `searchMultiPath`'s semantic pathway and `findSimilarItems`' vector branch fall back to the keyword / text-overlap paths — so seed the two items with **overlapping title/content words** ("shared secret plan") so the fallback still returns candidates and the RBAC gate is what removes `M-hidden` (not an empty result). Assert the fallback path is actually exercised (both items are keyword-reachable) before asserting the exclusion, so the test can't false-green on "returned nothing."
   Add a second case: a `board`/founder actor (`actorType:"board"`, `agentId:null`) still sees `M-hidden` — no regression, the tools stay unscoped for board/Commander callers (the pre-existing safe behavior; gating is applied only for the `agent` actor).
2. **Run it — expect FAIL** (all three currently return `M-hidden` to the D2 agent).
3. **Implement.** Gate only when `ctx.actorType === "agent"`; the board/Commander/founder path stays byte-unchanged (no `accessConditions` passed), preserving founder visibility.
   - Imports: `actorForAgentRun`, `memoryAccessConditions` from `../../memory-access-sql.js`; `filterMemoryForActor` from `../../memory-access.js`; `type SQL` from `drizzle-orm`.
   - **`find_similar_memory`** — replace the `searchSemantic` call with `searchMultiPath` (the only search method exposing `accessConditions`, `memory.ts:637`):
     ```ts
     let accessConditions: SQL[] | undefined;
     let actor: MemoryActor | undefined;
     if (ctx.actorType === "agent" && ctx.agentId) {
       actor = await actorForAgentRun(ctx.db, ctx.companyId, ctx.agentId);
       accessConditions = memoryAccessConditions(ctx.db, actor);
     }
     const items = await ctx.services.memory.searchMultiPath(ctx.companyId, query as string, {
       ...(layer ? { layer: layer as string } : {}),
       limit: (limit as number) ?? 5,
       ...(accessConditions ? { accessConditions } : {}),
     });
     const scoped = actor ? filterMemoryForActor(items, actor) : items;
     ```
     `searchMultiPath`'s wide projection makes the `filterMemoryForActor` net type-check (unlike the two below). Return `scoped`.
   - **`detect_conflicts`** — add `accessConditions?: SQL[]` to `FindSimilarScope` (`memory.ts:55-59`) and push `...scope.accessConditions` into **both** `findSimilarItems` `conditions` arrays (semantic at `memory.ts:894-906`, text-overlap fallback at `memory.ts:949-955`, each guarded by `if (scope.accessConditions?.length)`). In the tool, build `accessConditions` for the agent actor and pass it via the `scope` arg; **do not** call `filterMemoryForActor` (the narrow projection at `memory.ts:908-925` can't satisfy `AccessibleMemoryRow` — in-SQL gate is authoritative). Keep the existing `> 0.85` conflict filter over the (now already-gated) rows.
   - **`find_similar_memory_hnsw`** — build `accessConditions` for the agent actor and push `...accessConditions` into the local `conditions` array (`memory-find-similar.ts:101-114`, guarded by `if (accessConditions.length)`). **Do not** call `filterMemoryForActor` (the `id`/`title`/`content`/`layer`/`status`/`category` projection at `:118-125` can't satisfy `AccessibleMemoryRow` — in-SQL gate is authoritative).
   - Keep every existing `status='approved'` + `expiresAt`/`IS NOT NULL` guard — the `accessConditions` are **additive** (they add `isNull(invalidatedAt)` + scope/identity/company/private branches), not a replacement.
4. **Run — expect PASS** (D2 agent sees only in-scope memory across all three tools; board/founder unchanged).
5. **Commit:** `fix(memory): gate find_similar_memory (via searchMultiPath)/detect_conflicts/hnsw by memoryAccessConditions for agent actors (U2a)`

---

### Task: U2b — Server-side broker ToolContext resolver (no DATABASE_URL in the VM)

The stdio bridge builds its internal `ToolContext` from env vars (`AOA_SESSION_*`, `AOA_AGENT_KIND`, `AOA_TOOL_ALLOWLIST`, `AOA_EFFECTIVE_AUTONOMY`, `mcp-bridge.ts:300-377`) plus a `DATABASE_URL` Postgres handle. The broker must build the **same** `ToolContext` **server-side from the run-JWT actor** so nothing DB-touching crosses into the VM. This is a pure resolver — the load-bearing security property is that its inputs are the JWT (`agentId`/`companyId`/`runId`) + the control-plane `db`, never client-supplied.

**Files:**
- **Create:** `server/src/mcp/broker-tool-context.ts` (`resolveBrokerToolContext`)
- **Test (create):** `server/src/__tests__/broker-tool-context.test.ts` (integration, embedded-PG)

**Steps:**

1. **Write the failing test.** Seed a crew agent (`kind:'aoa'`) with a `runtimeConfig.aoa` role that carries a `toolAllowlist`, and an `internal_agent_config` row with `crewAutonomyLevel`. Call `resolveBrokerToolContext({ db, companyId, agentId, runId })` and assert the resolved context:
   ```ts
   const ctx = await resolveBrokerToolContext({ db, companyId, agentId: crew.id, runId });
   expect(ctx.actorType).toBe("agent");
   expect(ctx.agentKind).toBe("aoa");
   expect(ctx.agentId).toBe(crew.id);
   expect(ctx.runId).toBe(runId);
   expect(ctx.toolAllowlist).toEqual(expect.arrayContaining(["query_memory"]));
   expect(ctx.companyId).toBe(companyId);
   // effectiveAutonomy comes from crewAutonomyLevel (D18 split), not autonomyLevel
   expect(ctx.effectiveAutonomy).toBe(1);
   ```
   Assert that a `companyId` mismatch (agent belongs to another company) throws — the resolver never trusts a caller-supplied company.
2. **Run it — expect FAIL** (module does not exist).
3. **Implement.** `resolveBrokerToolContext` loads the agent row (asserting `agent.companyId === companyId`, else throw a 403-shaped error), reads `internal_agent_config` for the company, derives `agentKind` from `agent.kind`, `toolAllowlist` from the agent's resolved role allowlist (reuse the same derivation the crew path already feeds into `buildMcpBridgeSpec` — `resolve-crew-role.ts` / `derive-capabilities.ts`), `enabledCapabilities` + `effectiveAutonomy` (`config.crewAutonomyLevel` per the D18 split), and returns the internal-agent `ToolContext` shape (`internal-agent/types.ts`) with `actorType:"agent"`, `db`, and `services: createServiceContainer(db)`. It deliberately does **not** set `commanderToolPermissions`/runtime-approval fields for agent actors (those gate only `actorType:"commander"`). Reuse `createServiceContainer` from `internal-agent/service-container.ts`.
4. **Run — expect PASS.**
5. **Commit:** `feat(mcp): server-side broker ToolContext resolver from run-JWT (U2b)`

---

### Task: U2c — Broker dispatch of the internal registry over HTTP + superset-parity guard

Wire the internal registry into the HTTP endpoint's `tools/call`/`tools/list` for `agent` actors, dispatching through the **shared** `createToolCallHandler` + `filterAuthorizedToolsForContext` + `buildToolListResponse` (from `mcp-bridge.ts`) against the **shared module-level `brokerRegistry`** (a single `createToolRegistry()` array) — so desktop stdio and cloud HTTP share one tool implementation (the §13 shared-registry rule). A superset-parity test guards the broker against registry drift.

**isError / JSON-RPC mapping contract (grounded in `mcp-bridge.ts:143-250`).** `createToolCallHandler` returns `{ content, isError }` for **three** distinct cases, and they must NOT be collapsed:
- **unknown tool** — `deps.tools.find(...)` misses → `{ isError: true, content:[Unknown tool …] }` (`:150-155`).
- **policy denial** — e.g. `NOT_IN_ALLOWLIST` / `FORBIDDEN_ROLE` (`use_skill` not in `skillKeys`, etc.) → `{ isError: true }` (`:172-185`).
- **execute success or failure** — `{ isError: !result.success }` (`:133`) including the `ask_human` run-gate refusal (an in-band `isError` failure, not an unknown-tool error).

The broker must **detect the unknown-tool case explicitly** (look the name up in `brokerRegistry` **before** invoking the handler) and return `jsonRpcError(id, -32601, …)` for it — the unported-tool invariant. **All other results — success AND `isError` denials/failures — are returned via `jsonRpcResult` with the MCP `isError` content preserved**, exactly as the stdio bridge surfaces them over JSON-RPC-success (`mcp-bridge.ts:398-410`). Do **NOT** map every `isError` to `-32601`: that would translate `use_skill`'s `NOT_IN_ALLOWLIST` and `ask_human`'s run-gate refusal into a "method not found" transport error, breaking the gating-parity invariant that a denied-but-registered tool reports its *own* refusal reason identically over stdio and HTTP.

**Files:**
- **Modify:** `server/src/mcp/server.ts` (add a module-level `export const brokerRegistry = createToolRegistry();`; in the `method === "tools/call"` block at :569 and `tools/list` at :562, branch on `protocolActor.source === "agent"` into the internal registry dispatched against `brokerRegistry`)
- **Modify:** `server/src/services/internal-agent/mcp-bridge.ts` (import the already-exported `createToolCallHandler`/`buildToolListResponse`/`filterAuthorizedToolsForContext` here — no change needed to mcp-bridge; they are exported at `:13`/`:143`/`:252`) and `tool-registry.ts` (`createToolRegistry`/`executeTool` are already exported at `:101`/`:298`)
- **Test (create):** `server/src/__tests__/broker-internal-registry.test.ts` (integration, embedded-PG)
- **Test (create):** `server/src/__tests__/broker-stdio-parity.test.ts` (contract, no DB)

**Steps:**

1. **Write the failing parity test** (`broker-stdio-parity.test.ts`, pure). Import the **exact array the broker dispatches against** — the module-level `brokerRegistry` const exported from `server.ts` — and assert it is a **superset** of a fresh stdio `createToolRegistry()`. This is *not* the tautology `() => createToolRegistry()` on both sides (which is equal by construction and can never go red); binding to the shared dispatched array means that if the dispatch path is ever narrowed (e.g. `brokerRegistry` redefined as a hand-maintained subset, or a subset assigned to the const), the test goes red because names present in stdio go missing:
   ```ts
   import { createToolRegistry } from "../services/internal-agent/tool-registry.js";
   import { brokerRegistry } from "../mcp/server.js"; // the SAME array tools/call dispatches against

   const stdio = new Set(createToolRegistry().map((t) => t.name));
   const brokerNames = new Set(brokerRegistry.map((t) => t.name));
   for (const name of stdio) expect(brokerNames.has(name)).toBe(true);
   ```
   (Importing the const does not construct the router — `mcpServerRoutes` is a factory; only `brokerRegistry = createToolRegistry()` runs at module load, which just assembles the module-singleton tool objects.)
2. **Write the failing behavior test** (`broker-internal-registry.test.ts`, embedded-PG). Using the real HTTP router (`mcpServerRoutes(db)`) and a crew run-JWT (from U3) as the `Authorization: Bearer` token, assert:
   - `tools/list` returns the agent-visible internal tools (e.g. `query_memory`, `write_memory`, `create_task`, `use_skill`, `ask_human`), filtered by the agent's allowlist via `filterAuthorizedToolsForContext`.
   - `tools/call` for `query_memory` returns scoped memory (RBAC preserved through the broker) as a `jsonRpcResult` and writes a `memory_retrievals` audit row.
   - **Unknown-tool invariant:** `tools/call` for a bogus name `"__does_not_exist__"` returns a JSON-RPC **error** (`code -32601`, message names the unknown tool) — assert the top-level `error`, not a `result`. This is the *only* case mapped to a transport error.
   - **Gating parity (in-band `isError`, NOT `-32601`):** `ask_human` called with no active run context (strip `runId`) returns a `jsonRpcResult` whose payload carries `isError: true` with the **same** run-gate refusal the stdio bridge gives (the `ask-human-tool.ts` gate: `actorType:"agent"` + `agentKind ∈ {org,aoa}` + `runId`); `use_skill` for a key **not** in the agent's `skillKeys` allowlist returns a `jsonRpcResult` with `isError: true` and a `NOT_IN_ALLOWLIST` message (fail-closed). Assert these come back as `result` (with `isError:true` content), **not** as a JSON-RPC `error` — proving the broker does not collapse denials into `-32601`.
3. **Run them — expect FAIL** (the endpoint has no agent-internal branch yet; unknown tool currently hits the outbound `toolHandlers` `-32601 "Tool not found"` path at `server.ts:573-576` and registered tools misroute through the outbound handlers).
4. **Implement.** Add `export const brokerRegistry = createToolRegistry();` at module scope in `mcp/server.ts` (imported from `../services/internal-agent/tool-registry.js` alongside `executeTool`). In the request handler, when `protocolActor.source === "agent"`, build `const toolCtx = await resolveBrokerToolContext({ db, companyId, agentId: protocolActor.agentId, runId: protocolActor.runId })` (U2b) and dispatch against the shared `brokerRegistry`:
   - `tools/list` → `jsonRpcResult(id, { tools: buildToolListResponse(filterAuthorizedToolsForContext(brokerRegistry, toolCtx)) })`.
   - `tools/call` →
     ```ts
     // Explicit unknown-tool detection BEFORE dispatch → transport error.
     if (!brokerRegistry.some((t) => t.name === params.name)) {
       res.status(404).json(jsonRpcError(id, -32601, `Unknown tool: '${params.name}'`));
       return;
     }
     const handle = createToolCallHandler({ tools: brokerRegistry, executeTool, toolContext: toolCtx });
     const result = await handle(params.name, args, "broker:" + id);
     // Registered tool → JSON-RPC success; preserve MCP isError content
     // (policy denials + execute failures ride back in-band, exactly like stdio).
     res.json(jsonRpcResult(id, { content: result.content, isError: result.isError ?? false }));
     return;
     ```
     Because the unknown-tool case is intercepted above, the `handle(...)` result's `isError` is only ever a **registered-tool** denial or execute failure — surfaced in-band via `jsonRpcResult`, never re-mapped to `-32601`. Non-agent sources keep the existing outbound `toolHandlers` path (`server.ts:572-608`) unchanged.
5. **Run — expect PASS.**
6. **Commit:** `feat(mcp): broker the full internal tool registry over HTTP for agent actors (U2c)`

---

### Task: U2d — MCP-config HTTP seam: sandbox runs reach the broker, not the stdio bridge

For a sandboxed run, the CLI's `aoa` MCP server must be an **HTTP** entry pointing at the broker (`${AOA_API_URL}/companies/:cid/mcp`, `Authorization: Bearer ${AOA_API_KEY}` = the run-JWT) carrying **no `DATABASE_URL`** — replacing the stdio `buildMcpBridgeSpec` (which injects `DATABASE_URL`, `cli-mode.ts:257`). Desktop keeps the stdio bridge (§13 rule: broker is an *additional* transport, not a replacement). `mergeExternalMcpServers` already emits `type:"http"` entries (`cli-mode.ts:298-321`), so this mirrors the existing HTTP-connector shape for the reserved `aoa` entry.

> **Scope note (claude path only, this wave):** U2d re-points only claude's reserved `aoa` stdio entry inside `buildMcpConfig`. The codex/opencode `buildMcpBridgeSpec` path still leaks `DATABASE_URL` for non-claude adapters — that HTTP treatment (and the actual *setting* of `brokered` at the org/crew/Commander call sites) lands with S7 in the sandbox-wiring wave. Here, `brokered` is only **plumbed as a param, defaulted `false`** so desktop is untouched.

**Files:**
- **Modify:** `server/src/services/internal-agent/cli-mode.ts` (`buildMcpConfig` at :285 — choose HTTP vs stdio `aoa` entry based on a `brokered`/sandbox flag on `McpConfigParams`)
- **Test (create):** `server/src/__tests__/mcp-config-broker-seam.test.ts` (pure)

**Steps:**

1. **Write the failing test.** Assert the security invariant directly on the generated config:
   ```ts
   const brokered = buildMcpConfig({ ...params, brokered: true, apiBaseUrl: "https://cp.example", companyId: "co-1" });
   const aoa = brokered.mcpServers.aoa;
   expect(aoa.type).toBe("http");
   expect(aoa.url).toBe("https://cp.example/companies/co-1/mcp");
   expect(aoa.headers.Authorization).toBe("Bearer ${AOA_API_KEY}"); // placeholder, real JWT via env
   // CRITICAL: no DATABASE_URL anywhere in the brokered config
   expect(JSON.stringify(brokered)).not.toContain("DATABASE_URL");

   const local = buildMcpConfig({ ...params, brokered: false });
   expect(local.mcpServers.aoa.command).toBeDefined(); // desktop stdio bridge unchanged
   ```
2. **Run it — expect FAIL** (`buildMcpConfig` always emits the stdio bridge; `brokered` is unhandled).
3. **Implement.** Add `brokered?: boolean` + `apiBaseUrl?: string` to `McpConfigParams`. In `buildMcpConfig`, when `brokered`, set the reserved `aoa` entry to `{ type: "http", url: `${apiBaseUrl}/companies/${companyId}/mcp`, headers: { Authorization: "Bearer ${AOA_API_KEY}" } }` — matching the `${PLACEHOLDER}`-in-file / real-value-in-env convention (`AOA_API_KEY` is the run-JWT, already injected into the spawn env by the org/crew paths). When not `brokered`, keep `buildMcpBridgeSpec(params)` verbatim. Thread `brokered` = "run targets a sandbox" from the caller (set by the crew path in `runner.ts` / heartbeat once S7/U1/U4 supply the sandbox flag; for this wave, plumb the param and default it to `false` so desktop is untouched).
4. **Run — expect PASS.**
5. **Commit:** `feat(mcp): HTTP broker aoa-server config for sandboxed runs, no DATABASE_URL (U2d)`

---

### Task: U2e — Re-point the runtime-permission hook off 127.0.0.1 for sandbox targets

The claude_local PreToolUse runtime hook falls back to `http://127.0.0.1:${PORT}` (`heartbeat.ts:4842-4844` and again at `:4891-4893`) — unreachable from inside a VM. For a sandboxed run it must be a routable control-plane URL (`AOA_API_URL`); the `127.0.0.1` fallback is only valid for host-local runs.

**Files:**
- **Modify:** `server/src/services/heartbeat.ts` (the `usesHttpHookBridge` block — `selfBaseUrl` at :4842 and the inline `runtimeHookBridge.selfBaseUrl` at :4891)
- **Test (create):** `server/src/__tests__/runtime-hook-baseurl.test.ts` (pure)

**Steps:**

1. **Write the failing test.** Extract the base-URL choice into a testable helper `resolveRuntimeHookBaseUrl({ apiUrl, port, brokered })` and assert:
   ```ts
   // sandbox run: MUST NOT fall back to loopback
   expect(resolveRuntimeHookBaseUrl({ apiUrl: "https://cp.example", port: "3100", brokered: true }))
     .toBe("https://cp.example");
   expect(() => resolveRuntimeHookBaseUrl({ apiUrl: "", port: "3100", brokered: true }))
     .toThrow(/AOA_API_URL required for sandboxed runtime hook/);
   // host-local run: loopback fallback preserved (desktop unchanged)
   expect(resolveRuntimeHookBaseUrl({ apiUrl: "", port: "3100", brokered: false }))
     .toBe("http://127.0.0.1:3100");
   ```
2. **Run it — expect FAIL** (helper does not exist; current code inlines the loopback fallback unconditionally).
3. **Implement.** Add `resolveRuntimeHookBaseUrl` (co-located with the runtime-hook helpers), and replace **both** inlined `process.env.AOA_API_URL?.trim() || \`http://127.0.0.1:${...}\`` expressions (`heartbeat.ts:4842-4844`, `:4891-4893`) with a single call passing `brokered = executionTarget is a sandbox target`. When `brokered` and `AOA_API_URL` is empty, throw (fail-before-spend rather than silently minting an unreachable loopback URL). Keep the loopback fallback for non-brokered/host-local runs.
4. **Run — expect PASS.**
5. **Commit:** `fix(heartbeat): route runtime-permission hook to a routable URL for sandbox runs (U2e)`

---

**Wave 1 exit criteria:**
- A crew run mints a run-JWT (`crew-run-jwt.test.ts` green); `authToken: undefined` is gone from `runner.ts`.
- `find_similar_memory` (now dispatching `searchMultiPath`, the only search method exposing `accessConditions` at `memory.ts:637`), `detect_conflicts`, and `find_similar_memory_hnsw` exclude out-of-scope/private memory for an `agent` actor while leaving board/founder visibility unchanged (`memory-tools-agent-rbac.test.ts` green — the "NOT verbatim" security invariant). `detect_conflicts` + hnsw are gated **in-SQL only** (narrow projections can't satisfy `AccessibleMemoryRow`); `find_similar_memory` additionally runs the `filterMemoryForActor` net over `searchMultiPath`'s wide projection.
- The HTTP broker authenticates a crew and an org run-JWT and serves the **full** internal registry with per-agent-actor RBAC preserved through the wire: scoped memory reads, allowlist-gated `use_skill` (fail-closed), run-gated `ask_human`, and audit rows written (`broker-internal-registry.test.ts` green).
- An **unknown/unported** tool over the broker returns an explicit JSON-RPC `-32601` error (detected by an explicit `brokerRegistry` lookup before dispatch), never a silent no-op. A **registered-but-denied** tool (`use_skill` `NOT_IN_ALLOWLIST`, `ask_human` run-gate refusal) rides back as a `jsonRpcResult` with `isError: true` content — the exact stdio-bridge refusal, **not** re-mapped to `-32601` — so gating parity holds across transports.
- The superset-parity test binds to the shared module-level `brokerRegistry` array the dispatch path uses (not a `() => createToolRegistry()` tautology), so subsetting the dispatched tools fails the test and the broker and stdio bridge cannot drift (`broker-stdio-parity.test.ts` green).
- A brokered (sandbox) run's generated MCP config contains **no `DATABASE_URL`** and points the `aoa` server at the control-plane HTTP broker with a `Bearer ${AOA_API_KEY}` header; desktop stdio config is byte-unchanged (`mcp-config-broker-seam.test.ts` green).
- The runtime-permission hook resolves a routable URL for sandbox runs and throws rather than emitting an unreachable loopback URL; host-local runs keep the `127.0.0.1` fallback (`runtime-hook-baseurl.test.ts` green).

**PR-cut note:** This wave is **not** a standalone PR-cut point on its own — it establishes the broker seam but nothing yet *targets* a sandbox (U1 platform-default + U4 crew/Commander lease wiring + the S7 `brokered`-setting call sites + U8 D1-guard flip are still needed for a run to actually execute in a VM). Per spec §11, the natural first PR cut is after the core sandbox lands (U1–U9, U12, U13). Wave 1 is the load-bearing middle of that cut and carries the top review-focus surface (registry parity + memory RBAC), so it should be reviewed as a tight unit even though it merges as part of the larger core-sandbox PR.
