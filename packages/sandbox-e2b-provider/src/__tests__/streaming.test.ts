import { describe, expect, it } from "vitest";

import { MockE2bTransport } from "../mock-transport.js";
import { DIRECTIVE_KEYS, METADATA_KEYS, decodeStreamChunks } from "../directives.js";

// -----------------------------------------------------------------------------
// CLI-003/D1 — the streaming exec seam on `E2bTransport.runCommand`, proven WITHOUT
// a key against the deterministic MockE2bTransport.
//
// Before CLI-003 `runCommand` returned only `{exitCode,signal,timedOut,crashed}` —
// no stdout/stderr stream — so a coding run's output was uncapturable no-key. This
// suite proves: (1) the mock replays deterministic stdout/stderr chunks (from the
// reserved `__aoa_stream_chunks` directive) to the `onStdout`/`onStderr` callbacks,
// in order; (2) the `E2bCommandResult` shape is UNCHANGED; (3) absent handlers /
// absent directive is a benign no-op.
// -----------------------------------------------------------------------------

async function createSandbox(transport: MockE2bTransport): Promise<string> {
  const { sandboxId } = await transport.create({
    templateId: "base",
    timeoutMs: 60_000,
    metadata: { [METADATA_KEYS.env]: "{}" },
    envVars: {},
  });
  return sandboxId;
}

describe("CLI-003/D1 — streaming exec seam (mock transport, no key)", () => {
  it("replays deterministic stdout/stderr chunks to the handlers, in order", async () => {
    const transport = new MockE2bTransport();
    const sandboxId = await createSandbox(transport);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const chunks = [
      { stream: "stdout", data: "building...\n" },
      { stream: "stderr", data: "warning: deprecated\n" },
      { stream: "stdout", data: "done\n" },
    ];
    const result = await transport.runCommand(
      {
        sandboxId,
        command: "codex",
        args: ["exec"],
        envVars: { [DIRECTIVE_KEYS.streamChunks]: JSON.stringify(chunks) },
        timeoutMs: 30_000,
      },
      { onStdout: (c) => stdout.push(c), onStderr: (c) => stderr.push(c) },
    );

    expect(stdout).toEqual(["building...\n", "done\n"]);
    expect(stderr).toEqual(["warning: deprecated\n"]);
    // The command result shape is unchanged (no stream fields leaked into it).
    expect(result).toEqual({ exitCode: 0, signal: null, timedOut: false, crashed: false });
  });

  it("is a benign no-op with no handlers and no directive", async () => {
    const transport = new MockE2bTransport();
    const sandboxId = await createSandbox(transport);
    const result = await transport.runCommand({
      sandboxId,
      command: "sh",
      args: ["-c", "true"],
      envVars: {},
      timeoutMs: 30_000,
    });
    expect(result).toEqual({ exitCode: 0, signal: null, timedOut: false, crashed: false });
  });

  it("does not stream on a crash/timeout run (chunks skipped like fs-writes)", async () => {
    const transport = new MockE2bTransport();
    const sandboxId = await createSandbox(transport);
    const stdout: string[] = [];
    const result = await transport.runCommand(
      {
        sandboxId,
        command: "codex",
        args: [],
        envVars: {
          [DIRECTIVE_KEYS.lifecycleFault]: "crash",
          [DIRECTIVE_KEYS.streamChunks]: JSON.stringify([{ stream: "stdout", data: "x" }]),
        },
        timeoutMs: 30_000,
      },
      { onStdout: (c) => stdout.push(c) },
    );
    expect(stdout).toEqual([]);
    expect(result.crashed).toBe(true);
  });

  it("decodeStreamChunks tolerates garbage (benign empty default)", () => {
    expect(decodeStreamChunks(undefined)).toEqual([]);
    expect(decodeStreamChunks("not-json")).toEqual([]);
    expect(decodeStreamChunks(JSON.stringify([{ stream: "bogus", data: "x" }]))).toEqual([]);
    expect(decodeStreamChunks(JSON.stringify([{ stream: "stdout", data: 5 }]))).toEqual([]);
  });
});
