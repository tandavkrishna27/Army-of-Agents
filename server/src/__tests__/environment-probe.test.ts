import { describe, expect, it, vi } from "vitest";
import { probeEnvironmentConfig } from "../services/environment-probe.js";

describe("probeEnvironmentConfig", () => {
  it("resolves E2B provider credentials before validation and probe", async () => {
    const runtimeProviderKeys = {
      resolveCredential: vi.fn(async () => "sk-e2b"),
    };
    const providerRuntime = {
      validateConfig: vi.fn(async (_provider: string, config: Record<string, unknown>) => ({
        ok: config.resolvedApiKey === "sk-e2b",
        provider: "e2b",
        sanitizedConfig: {
          provider: "e2b",
          hasApiKey: Boolean(config.resolvedApiKey),
        },
      })),
      probe: vi.fn(async (_provider: string, input: { config: Record<string, unknown> }) => ({
        ok: true,
        provider: "e2b",
        summary: "E2B sandbox created and workspace directory prepared.",
        metadata: { hasApiKey: Boolean(input.config.resolvedApiKey) },
      })),
    };

    const result = await probeEnvironmentConfig({
      companyId: "company-1",
      driver: "sandbox",
      config: {
        provider: "e2b",
        credentialRef: "default",
        template: "base",
      },
      providerRuntime: providerRuntime as never,
      runtimeProviderKeys: runtimeProviderKeys as never,
    });

    expect(result.ok).toBe(true);
    expect(runtimeProviderKeys.resolveCredential).toHaveBeenCalledWith(
      "company-1",
      "e2b",
      expect.objectContaining({ credentialRef: "default" }),
      expect.objectContaining({
        consumerType: "system",
        consumerId: "runtime-provider-key:e2b",
        actorType: "system",
        configPath: "runtimeProviderKeys.e2b.default",
      }),
    );
    expect(providerRuntime.validateConfig).toHaveBeenCalledWith(
      "e2b",
      expect.objectContaining({ resolvedApiKey: "sk-e2b" }),
    );
    expect(providerRuntime.probe).toHaveBeenCalledWith(
      "e2b",
      expect.objectContaining({
        config: expect.objectContaining({ resolvedApiKey: "sk-e2b" }),
      }),
    );
  });

  it("returns a failed probe instead of throwing when provider validation throws", async () => {
    const providerRuntime = {
      validateConfig: vi.fn(async () => {
        throw new Error("Invalid API key format");
      }),
      probe: vi.fn(),
    };

    const result = await probeEnvironmentConfig({
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "e2b", apiKey: "bad-key" },
      providerRuntime: providerRuntime as never,
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("e2b sandbox configuration is invalid.");
    expect(result.checks?.[0]).toMatchObject({
      name: "config",
      status: "failed",
      message: "Invalid API key format",
    });
    expect(providerRuntime.probe).not.toHaveBeenCalled();
  });
});
