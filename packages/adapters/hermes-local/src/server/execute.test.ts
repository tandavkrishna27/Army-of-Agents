import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AdapterExecutionContext } from "@armyofagents/adapter-utils";

const runChildProcess = vi.hoisted(() => vi.fn());
vi.mock("@armyofagents/adapter-utils/server-utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("@armyofagents/adapter-utils/server-utils")>();
  return { ...original, runChildProcess };
});
const { execute, parseHermesOutput } = await import("./execute.js");

function context(config: Record<string, unknown> = {}, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1", agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: config },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { taskId: "task-1", taskTitle: "Fix", taskBody: "Do work", workspaceDir: process.cwd() },
    context: {}, onLog: async () => {}, ...overrides,
  };
}

describe("Hermes local execution", () => {
  beforeEach(() => {
    runChildProcess.mockReset();
    runChildProcess.mockResolvedValue({ stdout: "Done\nsession_id: sess-123", stderr: "", exitCode: 0, signal: null, timedOut: false });
  });

  it("uses argv and AoA credentials without shell concatenation", async () => {
    const result = await execute(context({ hermesCommand: "C:\\Program Files\\Hermes\\hermes.exe", env: { AOA_API_KEY: "explicit" }, extraArgs: ["--flag", "with space"] }, { authToken: "jwt" }));
    const [runId, command, args, options] = runChildProcess.mock.calls[0];
    expect(runId).toBe("run-1");
    expect(command).toBe("C:\\Program Files\\Hermes\\hermes.exe");
    expect(args.slice(0, 3)).toEqual(["chat", "-q", expect.any(String)]);
    expect(args).toContain("with space");
    expect(args[2]).toContain('Authorization: Bearer $AOA_API_KEY');
    expect(options.env).toMatchObject({ AOA_API_KEY: "explicit", AOA_RUN_ID: "run-1", AOA_TASK_ID: "task-1" });
    expect(result.sessionParams).toEqual({ sessionId: "sess-123" });
    expect(result.summary).toBe("Done");
  });

  it("uses JWT and resumes the saved session", async () => {
    await execute(context({}, { authToken: "jwt", runtime: { sessionId: "old", sessionParams: { sessionId: "old" }, sessionDisplayId: "old", taskKey: null } }));
    expect(runChildProcess.mock.calls[0][2]).toEqual(expect.arrayContaining(["--resume", "old"]));
    expect(runChildProcess.mock.calls[0][3].env.AOA_API_KEY).toBe("jwt");
  });

  it("avoids unauthenticated mutation instructions when no key exists", async () => {
    await execute(context());
    expect(runChildProcess.mock.calls[0][2][2]).toContain("Do not call or mutate the AoA API");
    expect(runChildProcess.mock.calls[0][2][2]).not.toContain("curl -s -X PATCH");
  });

  it("reports timeout and malformed failure output honestly", async () => {
    runChildProcess.mockResolvedValue({ stdout: "unexpected", stderr: "", exitCode: null, signal: "SIGTERM", timedOut: true });
    const result = await execute(context());
    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toMatch(/timed out/i);
  });

  it("keeps recoverable stderr diagnostics from failing a successful run", async () => {
    runChildProcess.mockResolvedValue({ stdout: "Task completed", stderr: "Error: first tool call failed, recovered on retry", exitCode: 0, signal: null, timedOut: false });
    const result = await execute(context());
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Task completed");
    expect(result.errorMessage).toBeUndefined();
  });

  it("parses usage and error details", () => {
    expect(parseHermesOutput("Done\nsession_id: abc\ntokens: 12 input 34 output\ncost: $0.25", "Error: failed")).toMatchObject({
      sessionId: "abc", usage: { inputTokens: 12, outputTokens: 34 }, costUsd: 0.25, errorMessage: "Error: failed",
    });
  });
});
