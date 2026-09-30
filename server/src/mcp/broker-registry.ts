// server/src/mcp/broker-registry.ts
//
// U2c — standalone module holding the HTTP broker's dispatched tool registry.
//
// WHY THIS IS ITS OWN FILE (not inlined in server.ts): server.ts transitively
// imports `../services/index.js`, which re-exports `createPluginWorkerManager`
// from `plugin-worker-manager.ts`, which imports `@armyofagents/plugin-sdk`.
// In this worktree that package's `dist/` output has not been built
// (`packages/plugins/sdk/dist` does not exist on disk — a pnpm workspace
// build-artifact gap, not a code defect; this is the same pre-existing
// condition behind the ~65 `@armyofagents/plugin-sdk` typecheck errors this
// project already tolerates). Vite/Vitest's module resolver throws hard on
// that unresolved import the instant ANYTHING imports `../mcp/server.js`
// unmocked — which is exactly what U2c's parity test needs to do (importing a
// *mocked* server.js would make "is this the same dispatched array" a
// tautology). Verified: `createToolRegistry()` itself has no such dependency —
// `tool-registry.test.ts` imports and calls it completely unmocked today and
// passes. Isolating construction here lets the parity test (and anything else
// that only needs the registry) import the real, live dispatched array without
// dragging in the unrelated, unbuilt plugin-sdk chain. `server.ts` re-exports
// this const unchanged, so it remains the SAME array object `tools/list` /
// `tools/call` dispatch against at runtime for `agent`-source actors — this
// split is import-graph isolation for testability, not a behavior change.
import { createToolRegistry } from "../services/internal-agent/tool-registry.js";
import type { AgentTool } from "../services/internal-agent/types.js";

// Built once at module load — same established pattern as
// aoa-agents/runner.ts's `TOOL_REGISTRY_FOR_CAPABILITY_DERIVATION =
// createToolRegistry()` and broker-tool-context.ts's
// `TOOL_REGISTRY_FOR_CAPABILITY_DERIVATION` (U2b): createToolRegistry() only
// builds AgentTool objects (name/description/parameters/category + an
// `execute` closure) — it performs no DB/network I/O at construction time.
export const brokerRegistry: AgentTool[] = createToolRegistry();
