import { describe, it, expect, vi } from "vitest";
import { createE2bSandboxRuntimeProvider } from "../services/sandbox-provider-runtime.js";

function makeProvider(runImpl: (cmd: string, opts: any) => Promise<any>) {
  const connect = vi.fn(async () => ({
    sandboxId: "e2b-1",
    commands: { run: vi.fn(runImpl) },
    setTimeout: vi.fn(async () => undefined),
    files: { write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
  }));
  return {
    provider: createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }),
      env: { E2B_API_KEY: "k" },
    }),
    connect,
  };
}

describe("E2B execute streaming callbacks (SC4)", () => {
  it("forwards onStdout/onStderr to commands.run AND still returns the buffered result", async () => {
    const streamed: string[] = [];
    const { provider } = makeProvider(async (_cmd, opts) => {
      // Simulate E2B delivering incremental chunks then a buffered result.
      opts.onStdout?.("frame-1\n");
      opts.onStdout?.("frame-2\n");
      opts.onStderr?.("warn-1\n");
      return { exitCode: 0, stdout: "frame-1\nframe-2\n", stderr: "warn-1\n" };
    });

    const result = await provider.execute({
      providerLeaseId: "e2b-1",
      leaseMetadata: { remoteCwd: "/home/user" },
      config: null,
      command: "claude",
      args: ["--print"],
      onStdout: (c) => streamed.push(`out:${c}`),
      onStderr: (c) => streamed.push(`err:${c}`),
    });

    expect(streamed).toEqual(["out:frame-1\n", "out:frame-2\n", "err:warn-1\n"]);
    expect(result.stdout).toBe("frame-1\nframe-2\n"); // buffered result intact for cost accounting
    expect(result.stderr).toBe("warn-1\n");
    expect(result.exitCode).toBe(0);
  });

  it("is byte-identical when callbacks are omitted (commands.run gets no callback keys set)", async () => {
    let seenOpts: any = null;
    const { provider } = makeProvider(async (_cmd, opts) => {
      seenOpts = opts;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });
    const result = await provider.execute({
      providerLeaseId: "e2b-1",
      leaseMetadata: { remoteCwd: "/home/user" },
      config: null,
      command: "echo",
      args: ["ok"],
    });
    expect(result.stdout).toBe("ok");
    expect(seenOpts.onStdout).toBeUndefined();
    expect(seenOpts.onStderr).toBeUndefined();
    expect("onStdout" in seenOpts).toBe(false);
    expect("onStderr" in seenOpts).toBe(false);
  });
});
