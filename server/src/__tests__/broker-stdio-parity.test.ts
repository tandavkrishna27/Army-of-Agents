/**
 * U2c — parity guard between the desktop stdio bridge's tool registry and the
 * HTTP broker's dispatched tool registry.
 *
 * The broker (server/src/mcp/server.ts) dispatches `tools/call` / `tools/list`
 * for `agent`-source actors against the EXACT SAME tool implementations the
 * desktop stdio bridge (mcp-bridge.ts, via `startBridge()`'s
 * `const tools = createToolRegistry();`) uses — one registry, two transports.
 * This test does NOT compare two independently-constructed
 * `createToolRegistry()` calls (that would be a tautology: any narrowing on
 * the broker side would go undetected since both sides would just re-derive
 * the same full list). Instead it imports the SHARED, already-built array the
 * broker actually dispatches against — `brokerRegistry` — and asserts it is a
 * superset of a fresh stdio-side `createToolRegistry()`. If a future edit
 * narrows what gets assigned to `brokerRegistry` (e.g. swaps in a hand-picked
 * subset instead of the full registry), this test goes red even though
 * `createToolRegistry()` itself is untouched.
 *
 * IMPORT-SOURCE NOTE (real-shape drift from the plan, deliberate): `server.ts`
 * (`export const brokerRegistry`) transitively imports `../services/index.js`,
 * which re-exports `createPluginWorkerManager` from `plugin-worker-manager.ts`,
 * which imports `@armyofagents/plugin-sdk` — a workspace package whose `dist/`
 * output is NOT built in this worktree (confirmed: `packages/plugins/sdk/dist`
 * does not exist on disk; this is the same pre-existing gap behind the ~65
 * `@armyofagents/plugin-sdk` typecheck errors this project already tolerates).
 * Importing `../mcp/server.js` fully unmocked — required here, since mocking
 * it would make the registry comparison meaningless — throws a hard Vite
 * module-resolution error before any test body runs. `createToolRegistry()`
 * itself has NO such dependency (`tool-registry.test.ts` imports and calls it
 * completely unmocked today and passes 14/14), so `brokerRegistry`'s
 * construction lives in a standalone module, `server/src/mcp/broker-registry.ts`,
 * that imports ONLY `tool-registry.js`. `server.ts` re-exports that same const
 * unchanged (`export { brokerRegistry } from "./broker-registry.js";`), so the
 * array this test imports IS the identical object `tools/list` / `tools/call`
 * dispatch against at runtime — this is an import-path adaptation for
 * testability, not a different array.
 *
 * Pure / no DB / runs on every platform: `createToolRegistry()` only builds
 * AgentTool objects (name/description/parameters/category + an `execute`
 * closure) — no DB or network I/O at construction time. No `vi.mock` is
 * needed or used here.
 */
import { describe, expect, it } from "vitest";
import {
  createToolRegistry,
  filterAuthorizedToolsForContext,
} from "../services/internal-agent/tool-registry.js";
import { brokerRegistry } from "../mcp/broker-registry.js";
import type { ToolContext } from "../services/internal-agent/types.js";

describe("broker/stdio tool-registry parity (U2c)", () => {
  it("brokerRegistry (the array the HTTP broker actually dispatches against) is a superset of a fresh stdio createToolRegistry()", () => {
    const stdio = new Set(createToolRegistry().map((t) => t.name));
    const brokerNames = new Set(brokerRegistry.map((t) => t.name));

    expect(stdio.size).toBeGreaterThan(0);

    const missing = [...stdio].filter((name) => !brokerNames.has(name));
    expect(missing).toEqual([]);

    for (const name of stdio) {
      expect(brokerNames.has(name)).toBe(true);
    }
  });

  it("brokerRegistry has no duplicate tool names (a well-formed registry, not an accidental concat)", () => {
    const names = brokerRegistry.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // W7.5f Task 4 — commander-actor superset-parity anti-drift (spec §4 caveat c,
  // §13 anti-drift). This differs from commander-broker-parity.test.ts (which
  // filters a FRESH createToolRegistry() for the resolver-output shape): here we
  // filter the SAME `brokerRegistry` object the broker actually dispatches
  // `tools/call` / `tools/list` against, for a commander context, and assert it
  // equals the in-process commander surface. If a future edit narrows
  // `brokerRegistry` for the commander path, this goes red — not merely a
  // resolver unit test.
  it("the commander-visible broker surface == the in-process commander surface (spec §4 caveat c, §13 anti-drift)", () => {
    const commanderCtx: ToolContext = {
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      enabledCapabilities: ["system_actions", "memory_management", "discussion_processing"],
      agentKind: undefined,
      toolAllowlist: [],
      actorType: "commander",
      commanderToolPermissions: {},
      runtimeApprovalsEnabled: true,
      db: {} as never,
      services: {} as never,
    };
    const brokerNames = filterAuthorizedToolsForContext(brokerRegistry, commanderCtx)
      .map((t) => t.name)
      .sort();
    const inProcNames = filterAuthorizedToolsForContext(createToolRegistry(), commanderCtx)
      .map((t) => t.name)
      .sort();
    expect(brokerNames).toEqual(inProcNames);
    expect(brokerNames.length).toBeGreaterThan(0);
  });
});
