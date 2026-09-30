import { describe, it, expect, vi } from "vitest";
import { runCommanderAdapterTurn } from "../services/internal-agent/commander-sandbox.js";
import type { McpConfigParams } from "../services/internal-agent/cli-mode.js";

function fakeAdapter(frames: string[]) {
  const execute = vi.fn(async (ctx: any) => {
    for (const f of frames) await ctx.onLog("stdout", f);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "hi",
      usage: { inputTokens: 1, outputTokens: 1 },
      sessionId: "sess-1",
    };
  });
  return { execute };
}

const mcpParams: McpConfigParams = {
  companyId: "c1",
  userId: "u1",
  userRole: "founder",
  enabledCapabilities: [],
  bridgeEntrypoint: "/bridge.js",
  actorType: "commander",
  runId: "run1",
  brokered: true,
  apiBaseUrl: "http://api",
};

describe("runCommanderAdapterTurn", () => {
  it("streams claude stream-json frames incrementally, passes the commander JWT as authToken, and returns the buffered result", async () => {
    const frames = [
      // Text streams via stream_event/content_block_delta (assistant frames carry
      // only tool_use; text blocks are skipped by StreamJsonParser).
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      }) + "\n",
      JSON.stringify({ type: "result", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }) + "\n",
    ];
    const adapter = fakeAdapter(frames);
    const chunks: any[] = [];
    let result: any;
    const gen = runCommanderAdapterTurn(adapter as any, {
      adapterType: "claude_local",
      executionTarget: {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "e2b-1",
        remoteCwd: "/workspace",
        runner: { execute: vi.fn() },
      } as any,
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      conversationId: "conv1",
      turnId: "run1",
      authToken: "commander-jwt",
      apiBaseUrl: "http://api",
      content: "hello",
      systemContext: "SYSTEM CONTEXT",
      model: null,
      mcpParams,
      connectorSpecs: {},
      connectorEnv: {},
      useStreamJson: true,
    });
    for await (const c of gen) {
      if (c.kind === "chunk") chunks.push(c.chunk);
      else result = c.result;
    }
    expect(chunks.some((c) => c.type === "text" && c.delta === "hi")).toBe(true);
    // F4 guard: the adapter received a provider-sandbox target and owns the
    // sandboxProvider ("anthropic") — cli-mode NEVER passes the infra id "e2b".
    const passedCtx = (adapter.execute as any).mock.calls[0][0];
    expect(passedCtx.executionTarget.type).toBe("provider-sandbox");
    expect(passedCtx.authToken).toBe("commander-jwt"); // → AOA_API_KEY in the VM
    // claude delivers the brokered aoa MCP via a staged --mcp-config file (crew
    // pattern), NOT bespoke inline staging.
    expect(passedCtx.config.extraArgs).toContain("--mcp-config");
    expect(passedCtx.config.extraArgs).toContain("--strict-mcp-config");
    expect(result.summary).toBe("hi");
  });

  it("codex: buffers JSONL, parses on completion (host runCodexTurn parity), and passes mcpBridge (no --mcp-config in extraArgs)", async () => {
    const frames = [
      JSON.stringify({ type: "item.completed", item: { type: "assistant_message", text: "codex reply" } }) + "\n",
    ];
    const adapter = fakeAdapter(frames);
    const chunks: any[] = [];
    for await (const ev of runCommanderAdapterTurn(adapter as any, {
      adapterType: "codex_local",
      executionTarget: {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "e2b-1",
        remoteCwd: "/workspace",
        runner: { execute: vi.fn() },
      } as any,
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      conversationId: "conv1",
      turnId: "run1",
      authToken: "commander-jwt",
      apiBaseUrl: "http://api",
      content: "hello",
      systemContext: null,
      model: null,
      mcpParams: { ...mcpParams },
      connectorSpecs: {},
      connectorEnv: {},
      useStreamJson: false,
    })) {
      if (ev.kind === "chunk") chunks.push(ev.chunk);
    }
    const passedCtx = (adapter.execute as any).mock.calls[0][0];
    // codex → the brokered aoa spec rides ctx.mcpBridge (config.toml), NOT extraArgs.
    expect(passedCtx.mcpBridge).toBeDefined();
    const extraArgs = (passedCtx.config.extraArgs as string[] | undefined) ?? [];
    expect(extraArgs).not.toContain("--mcp-config");
    // A terminal done chunk is emitted from the parsed codex buffer.
    expect(chunks.some((c) => c.type === "done")).toBe(true);
  });
});
