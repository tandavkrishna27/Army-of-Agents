import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertProviderLoginUrl,
  providerSubscriptionCapability,
  resolveCliAuthTopology,
  resolveScopedCliAuthHome,
  detectProviderCli,
} from "../services/cli-auth-topology.js";

describe("CLI authentication topology", () => {
  it("fails closed to hosted multi-tenant for authenticated deployments without an operator profile", () => {
    const topology = resolveCliAuthTopology({
      env: {},
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      platform: "linux",
    });
    expect(topology.installProfile).toBe("hosted_multi_tenant");
    expect(providerSubscriptionCapability("openai", topology, {}).enabled).toBe(false);
  });

  it("enables remote-safe flows only when their dedicated-target flags are set", () => {
    const env = {
      AOA_INSTALL_PROFILE: "remote_single_tenant",
      AOA_CODEX_DEVICE_AUTH: "1",
      AOA_CLAUDE_PASTE_AUTH: "true",
    };
    const topology = resolveCliAuthTopology({
      env,
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      platform: "linux",
    });
    expect(providerSubscriptionCapability("openai", topology, env)).toMatchObject({
      enabled: true,
      mode: "device_code",
    });
    expect(providerSubscriptionCapability("anthropic", topology, env)).toMatchObject({
      enabled: true,
      mode: "paste_code",
    });
  });

  it("rejects conflicting explicit axes", () => {
    expect(() =>
      resolveCliAuthTopology({
        env: { AOA_INSTALL_PROFILE: "remote_single_tenant", AOA_TRUST_BOUNDARY: "multi_tenant" },
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      }),
    ).toThrow(/conflicts/);
  });

  it("derives opaque, provider-specific homes without user-controlled path fragments", () => {
    const root = path.resolve("C:/aoa-test");
    const home = resolveScopedCliAuthHome({
      env: { AOA_HOME: root },
      executionTargetId: "../../target",
      companyId: "../company",
      userId: "../user",
      provider: "openai",
    });
    expect(home.startsWith(root)).toBe(true);
    expect(home).not.toContain("..");
    expect(path.basename(home)).toBe("openai");
  });

  it.each(["linux", "darwin", "win32"] as const)(
    "reports %s topology while keeping credential homes opaque",
    (platform) => {
      const topology = resolveCliAuthTopology({
        env: { AOA_INSTALL_PROFILE: "local_single_user" },
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        platform,
      });
      const home = resolveScopedCliAuthHome({
        env: { AOA_HOME: path.resolve("aoa-cross-platform") },
        executionTargetId: "target/with/separators",
        companyId: "company/with/separators",
        userId: "user/with/separators",
        provider: "anthropic",
      });

      expect(topology.platform).toBe(platform);
      expect(home).not.toContain("target/with/separators");
      expect(home).not.toContain("company/with/separators");
      expect(home).not.toContain("user/with/separators");
      expect(path.basename(home)).toBe("anthropic");
    },
  );

  it("accepts only HTTPS provider-owned login URLs", () => {
    expect(assertProviderLoginUrl("openai", "https://auth.openai.com/codex/device")).toContain(
      "auth.openai.com",
    );
    expect(
      assertProviderLoginUrl("anthropic", "https://claude.com/cai/oauth/authorize?code=abc"),
    ).toContain("claude.com");
    expect(
      assertProviderLoginUrl("anthropic", "https://platform.claude.com/oauth/callback"),
    ).toContain("platform.claude.com");
    expect(() => assertProviderLoginUrl("openai", "http://localhost:1455/callback")).toThrow();
    expect(() => assertProviderLoginUrl("anthropic", "https://claude.ai.evil.example/login")).toThrow();
    expect(() => assertProviderLoginUrl("anthropic", "https://claude.com.evil.example/login")).toThrow();
    expect(() => assertProviderLoginUrl("anthropic", "https://evilclaude.com/login")).toThrow();
    expect(() => assertProviderLoginUrl("anthropic", "http://claude.com/login")).toThrow();
    expect(() => assertProviderLoginUrl("anthropic", "https://user:pass@claude.com/login")).toThrow();
  });

  it("detects pinned CLI compatibility without trusting unknown versions", async () => {
    await expect(
      detectProviderCli("openai", async () => ({ stdout: "codex-cli 0.145.3" })),
    ).resolves.toMatchObject({ cliInstalled: true, cliVersionSupported: true });
    await expect(
      detectProviderCli("openai", async () => ({ stdout: "codex-cli 0.999.0" })),
    ).resolves.toMatchObject({ cliInstalled: true, cliVersionSupported: false });
    await expect(
      detectProviderCli("anthropic", async () => {
        throw new Error("ENOENT");
      }),
    ).resolves.toEqual({ cliInstalled: false, cliVersion: null, cliVersionSupported: false });
  });
});
