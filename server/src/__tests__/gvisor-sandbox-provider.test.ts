// server/src/__tests__/gvisor-sandbox-provider.test.ts
import { describe, expect, it, vi } from "vitest";
import { createGvisorSandboxRuntimeProvider } from "../services/gvisor-sandbox-provider.js";

describe("gvisor sandbox runtime provider", () => {
  it("validateConfig requires an image and a pool endpoint for remote transport", async () => {
    const p = createGvisorSandboxRuntimeProvider();
    const bad = await p.validateConfig!({ provider: "gvisor", transport: "pool" });
    expect(bad.ok).toBe(false);
    const ok = await p.validateConfig!({ provider: "gvisor", transport: "pool", image: "aoa/agent-base:latest", poolEndpoint: "https://pool.internal" });
    expect(ok.ok).toBe(true);
  });

  it("delegates execute to the injected pool client", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "hi", stderr: "" });
    const p = createGvisorSandboxRuntimeProvider({ poolClient: { acquire: vi.fn().mockResolvedValue({ providerLeaseId: "lease-1", metadata: {} }), release: vi.fn().mockResolvedValue({ cleanupStatus: "success" }), run } });
    const res = await p.execute({ providerLeaseId: "lease-1", leaseMetadata: {}, command: "claude", args: ["-p", "hi"] });
    expect(run).toHaveBeenCalled();
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hi");
  });
});
