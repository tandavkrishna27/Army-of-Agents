/**
 * cli-mode-done-invariant.test.ts
 *
 * Plan Task 4: exactly-ONE-done invariant across the three turn shapes that the
 * cliModeService SAWRealDone guard covers.
 *
 *   (a) claude result-event turn   — StreamJsonParser emits a real done from
 *       the stream-json `result` event with real usage.
 *   (b) claude plain-text MCP-tool turn — NO result event; the `sawRealDone`
 *       fallback in cli-mode yields exactly one done with zeroed usage.
 *   (c) codex turn                 — runCodexTurn emits a real done from
 *       turn.completed with usage from parseCodexJsonl.
 *
 * Reuses the spawn-mock harness from cli-mode.test.ts (vi.mock child_process +
 * adapter-codex-local stubs).  Does NOT spawn a real process.
 *
 * Plan-review fix #6: also asserts that when codex stdout contains turn.failed
 * AND exit code is 1, chat yields an {type:"error"} chunk whose message is the
 * parsed errorMessage (not a generic "exited with code N" string).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ── child_process mock ───────────────────────────────────────────────────────
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// ── fs mocks (config writes) ─────────────────────────────────────────────────
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn() };
});

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}));

// ── Adapter codex mock (stubs the disk/auth helpers; real parsers pass through) ──
vi.mock("@armyofagents/adapter-codex-local/server", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@armyofagents/adapter-codex-local/server")
  >();
  return {
    ...actual,
    writeCodexMcpConfigToml: vi.fn(async () => {}),
    ensureCodexAuthInHome: vi.fn(async () => true),
    readSharedCodexModel: vi.fn(async () => null),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A one-shot process that emits preset stdout then exits. */
function makeOneShotProcess(opts: {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}) {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { writable: true, write: vi.fn(), end: vi.fn(), on: vi.fn() };
  proc.kill = vi.fn();
  let driven = false;
  const drive = () => {
    if (driven) return;
    driven = true;
    setImmediate(() => {
      if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr));
      proc.emit("exit", opts.exitCode ?? 0, null);
      proc.emit("close", opts.exitCode ?? 0, null);
    });
  };
  proc.stdout.on("newListener", drive);
  proc.on("newListener", (ev: string) => { if (ev === "exit") drive(); });
  return proc;
}

/** A claude process (one-shot per turn under the W1 stdin fix). */
function makePersistentProcess() {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  // W1 stdin fix: claude writes the prompt to stdin then closes it.
  proc.stdin = { writable: true, write: vi.fn(), end: vi.fn(), on: vi.fn() };
  proc.kill = vi.fn();
  proc.feed = (text: string) => {
    setImmediate(() => proc.stdout.emit("data", Buffer.from(text)));
  };
  proc.exit = (code = 0) => {
    setImmediate(() => {
      proc.emit("exit", code, null);
      proc.emit("close", code, null);
    });
  };
  return proc;
}

async function drainChat(
  service: any,
  cliTool: string,
  content = "test message",
  configOverride: Record<string, unknown> = {},
): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of service.chat(
    {
      companyId: "cmp1",
      userId: "usr1",
      userRole: "founder",
      content,
      enabledCapabilities: [],
      conversationId: "conversation-done-invariant",
    } as any,
    { cliTool, executionMode: "cli", ...configOverride } as any,
  )) {
    chunks.push(chunk);
  }
  return chunks;
}

// ── Stream-json line builders (mirrors cli-mode.test.ts) ─────────────────────

function streamJsonLine(obj: Record<string, unknown>): string {
  return JSON.stringify({ type: "stream_event", event: obj }) + "\n";
}

// ── CODEX JSONL ──────────────────────────────────────────────────────────────

const CODEX_SUCCESS_JSONL = [
  JSON.stringify({ type: "thread.started", thread_id: "sess-done-abc" }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "The answer." } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 42, output_tokens: 17 } }),
].join("\n");

const CODEX_FAIL_JSONL = [
  JSON.stringify({ type: "thread.started", thread_id: "sess-fail-xyz" }),
  JSON.stringify({
    type: "turn.failed",
    error: { message: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account." },
  }),
].join("\n");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("cli-mode done-invariant — exactly ONE done chunk per turn", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const cp = await import("node:child_process");
    vi.mocked(cp.spawn).mockReset();
    vi.mocked(cp.execSync).mockReset();
  });

  // ── (a) claude result-event turn ─────────────────────────────────────────

  it("(a) claude result-event turn: exactly one done with real usage from result event", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/claude\n" as any);

    const proc = makePersistentProcess();
    vi.mocked(cp.spawn).mockReturnValue(proc as any);

    const { cliModeService } = await import("../services/internal-agent/cli-mode.js");
    const service = cliModeService({} as any);

    // stream_event text_delta → then top-level result event (real usage).
    // StreamJsonParser handles lines with type="stream_event" and type="result" directly.
    const textLine = streamJsonLine({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "result turn text" },
    });
    // The result event is a TOP-LEVEL JSON line (not nested in stream_event).
    // parseLine dispatches on event.type="result" → handleResultEvent.
    const resultLine = JSON.stringify({
      type: "result",
      total_cost_usd: 0.0,            // subscription: 0 cost reported
      duration_ms: 1200,
      usage: {
        input_tokens: 200,
        output_tokens: 80,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }) + "\n";

    let attached = false;
    proc.stdout.on("newListener", () => {
      if (attached) return;
      attached = true;
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from(textLine + resultLine));
        proc.emit("exit", 0, null);
        proc.emit("close", 0, null);
      });
    });

    const chunks = await drainChat(service, "claude_cli", "hi claude");

    const doneChunks = chunks.filter((c) => c.type === "done");
    expect(doneChunks).toHaveLength(1);

    // The result event carries real usage — tokenUsage should be non-zero.
    const done = doneChunks[0];
    expect(done.summary.tokenUsage.inputTokens).toBe(200);
    expect(done.summary.tokenUsage.outputTokens).toBe(80);
    // durationMs from result event
    expect(done.summary.durationMs).toBe(1200);
  });

  // ── (b) claude plain-text MCP-tool turn (no result event) ────────────────

  it("(b) claude plain-text MCP-tool turn (no result event): exactly one fallback done with zeroed usage", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/claude\n" as any);

    const proc = makePersistentProcess();
    vi.mocked(cp.spawn).mockReturnValue(proc as any);

    const { cliModeService } = await import("../services/internal-agent/cli-mode.js");
    const service = cliModeService({} as any);

    // Only a tool-use line + exit, no result event.
    const toolLine = streamJsonLine({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Using a tool" },
    });

    let attached = false;
    proc.stdout.on("newListener", () => {
      if (attached) return;
      attached = true;
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from(toolLine));
        proc.emit("exit", 0, null);
        proc.emit("close", 0, null);
      });
    });

    const chunks = await drainChat(service, "claude_cli", "use a tool");

    const doneChunks = chunks.filter((c) => c.type === "done");
    expect(doneChunks).toHaveLength(1);

    // Fallback done: zeroed usage.
    const done = doneChunks[0];
    expect(done.summary.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  // ── (c) codex turn ───────────────────────────────────────────────────────

  it("(c) codex turn: exactly one done with usage from turn.completed", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc = makeOneShotProcess({ stdout: CODEX_SUCCESS_JSONL });
    vi.mocked(cp.spawn).mockReturnValue(proc as any);

    const { cliModeService } = await import("../services/internal-agent/cli-mode.js");
    const service = cliModeService({} as any);

    const chunks = await drainChat(service, "codex", "hi codex");

    const doneChunks = chunks.filter((c) => c.type === "done");
    expect(doneChunks).toHaveLength(1);

    // Usage from CODEX_SUCCESS_JSONL: input_tokens=42, output_tokens=17
    const done = doneChunks[0];
    expect(done.summary.tokenUsage.inputTokens).toBe(42);
    expect(done.summary.tokenUsage.outputTokens).toBe(17);
  });

  // ── (d) plan-review fix #6: turn.failed errorMessage wins over exit code ─
  //
  // When runCodexTurn yields {type:"error"} and returns (without a done), the
  // outer chat() loop sees sawRealDone=false and emits a single fallback done.
  // The KEY assertion is that the error message is the PARSED turn.failed text,
  // not a generic "exited with code N" string.

  it("(d) turn.failed: parsed errorMessage surfaces (not generic exit-code string); exactly one fallback done", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc = makeOneShotProcess({ stdout: CODEX_FAIL_JSONL, exitCode: 1 });
    vi.mocked(cp.spawn).mockReturnValue(proc as any);

    const { cliModeService } = await import("../services/internal-agent/cli-mode.js");
    const service = cliModeService({} as any);

    const chunks = await drainChat(service, "codex", "fail please");

    const errChunk = chunks.find((c) => c.type === "error");
    expect(errChunk).toBeDefined();
    // The parsed message from turn.failed should win over generic exit text.
    expect(errChunk!.message).toContain("gpt-5.3-codex");
    expect(errChunk!.message).toContain("not supported");
    // Must NOT be the generic exit-code fallback.
    expect(errChunk!.message).not.toContain("exited with code");

    // The outer chat() loop emits a single fallback done because runCodexTurn
    // returned without a done (error path → early return). sawRealDone stays false.
    // This is the correct invariant: the route always sees exactly ONE done.
    const doneChunks = chunks.filter((c) => c.type === "done");
    expect(doneChunks).toHaveLength(1);
    // Fallback done has zeroed usage (error path — no turn.completed was parsed).
    expect(doneChunks[0].summary.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  // ── (e) Multiple turns in same service: each turn gets exactly one done ──

  it("(e) two consecutive codex turns each get exactly one done", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);

    const CODEX_TURN2 = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-done-def" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Turn two." } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join("\n");

    const proc1 = makeOneShotProcess({ stdout: CODEX_SUCCESS_JSONL });
    const proc2 = makeOneShotProcess({ stdout: CODEX_TURN2 });
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(proc1 as any)
      .mockReturnValueOnce(proc2 as any);

    const { cliModeService } = await import("../services/internal-agent/cli-mode.js");
    const service = cliModeService({} as any);

    const t1 = await drainChat(service, "codex", "turn one");
    const t2 = await drainChat(service, "codex", "turn two");

    expect(t1.filter((c) => c.type === "done")).toHaveLength(1);
    expect(t2.filter((c) => c.type === "done")).toHaveLength(1);
  });
});
