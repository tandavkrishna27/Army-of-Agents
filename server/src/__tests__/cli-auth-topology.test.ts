import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  assertProviderLoginUrl,
  providerSubscriptionCapability,
  resolveCliAuthTopology,
  resolveScopedCliAuthHome,
  detectProviderCli,
  resolveProviderCliCommand,
  dockerClaudeLoginCommand,
  dockerClaudeLoginCommands,
  inspectScopedClaudeCredential,
} from "../services/cli-auth-topology.js";

describe("CLI authentication topology", () => {
  it.each([
    ["hosted_multi_tenant", "false", false],
    ["hosted_multi_tenant", "true", false],
    ["remote_single_tenant", "false", false],
    ["remote_single_tenant", "true", true],
  ] as const)("allows Claude subscription only for dedicated opt-in (%s, %s)", (profile, flag, allowed) => {
    const env = { AOA_INSTALL_PROFILE: profile, AOA_CLAUDE_PASTE_AUTH: flag };
    const topology = resolveCliAuthTopology({ env, deploymentMode: "authenticated", deploymentExposure: "public" });
    expect(providerSubscriptionCapability("anthropic", topology, env).enabled).toBe(allowed);
  });

  it("gives Docker Compose a node-user terminal command pinned to the login/verify home", () => {
    const scope = { env: { AOA_HOME: "/aoa" }, executionTargetId: "control-plane", companyId: "company-1", userId: "founder-1", provider: "anthropic" as const };
    const home = resolveScopedCliAuthHome(scope);
    const dockerHome = home.replace(/^.*[\\/]aoa/, "/aoa").replaceAll("\\", "/");
    const command = dockerClaudeLoginCommand(scope);
    expect(command).toContain("docker compose exec --user node");
    expect(command).toContain(`CLAUDE_CONFIG_DIR='${dockerHome}'`);
    expect(command).toContain(`HOME='${path.posix.dirname(dockerHome)}'`);
    expect(command).toContain("server claude auth login");
    expect(command).not.toContain("~/.claude");
  });

  it("returns explicit commands for standard and quickstart Compose layouts", () => {
    const scope = { env: { AOA_HOME: "/aoa" }, executionTargetId: "control-plane", companyId: "company-1", userId: "founder-1", provider: "anthropic" as const };
    const commands = dockerClaudeLoginCommands(scope);
    expect(commands).toHaveLength(2);
    expect(commands?.[0]).toMatchObject({ mode: "standard" });
    expect(commands?.[0]?.command).toContain(" server claude auth login");
    expect(commands?.[0]?.command).not.toContain("docker-compose.quickstart.yml");
    expect(commands?.[1]).toMatchObject({ mode: "quickstart" });
    expect(commands?.[1]?.command).toContain("-f docker-compose.quickstart.yml");
    expect(commands?.[1]?.command).toContain(" aoa claude auth login");
    expect(commands?.[1]?.command).toContain("CLAUDE_CONFIG_DIR='");
  });

  it("reports an unreadable scoped credential with an allowlisted permission code", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-inspect-"));
    try {
      const credential = path.join(root, ".credentials.json");
      await fs.writeFile(credential, "fixture-secret");
      const originalOpen = fs.open.bind(fs);
      const opened = vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
        if (String(candidate) === credential) throw Object.assign(new Error("EACCES fixture-secret"), { code: "EACCES" });
        return originalOpen(candidate, flags, mode);
      });
      try {
        const result = await inspectScopedClaudeCredential(root);
        expect(result).toMatchObject({ code: "claude_credentials_permission_denied", recoverable: true });
        expect(JSON.stringify(result)).not.toContain("fixture-secret");
        expect(JSON.stringify(result)).not.toContain(root);
      } finally {
        opened.mockRestore();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("rejects a credential home reached through an ancestor symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-ancestor-link-"));
    try {
      const realHome = path.join(root, "real", "scope");
      const linkParent = path.join(root, "linked-parent");
      await fs.mkdir(realHome, { recursive: true });
      await fs.writeFile(path.join(realHome, ".credentials.json"), "fixture");
      await fs.symlink(path.join(root, "real"), linkParent, "dir");
      const result = await inspectScopedClaudeCredential(path.join(linkParent, "scope"));
      expect(result.code).toBe("claude_credentials_unsafe_path");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("keeps inspection pinned when the scoped home is replaced after path validation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-path-swap-"));
    const authHome = path.join(root, "scope");
    const displacedHome = path.join(root, "scope-original");
    const attackerHome = path.join(root, "attacker");
    await fs.mkdir(authHome);
    await fs.mkdir(attackerHome);
    await fs.writeFile(path.join(authHome, ".credentials.json"), "fixture");
    const originalOpen = fs.open.bind(fs);
    let swapped = false;
    const opened = vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      if (!swapped && String(candidate).endsWith("/.credentials.json")) {
        swapped = true;
        await fs.rename(authHome, displacedHome);
        await fs.symlink(attackerHome, authHome, "dir");
      }
      return originalOpen(candidate, flags, mode);
    });
    try {
      const result = await inspectScopedClaudeCredential(authHome);
      expect(swapped).toBe(true);
      expect(result.code).toBe("claude_credentials_ready");
    } finally {
      opened.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
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

  it("enables Codex device and Claude code-paste sign-in for local_single_user without remote flags", () => {
    const topology = resolveCliAuthTopology({
      env: { AOA_INSTALL_PROFILE: "local_single_user" },
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      platform: "linux",
    });

    expect(topology).toMatchObject({
      installProfile: "local_single_user",
      networkLocation: "local",
      trustBoundary: "single_user",
      executionOwnership: "user_hosted",
    });
    expect(providerSubscriptionCapability("openai", topology, {})).toMatchObject({
      enabled: true,
      mode: "device_code",
    });
    expect(providerSubscriptionCapability("anthropic", topology, {})).toMatchObject({
      enabled: true,
      mode: "paste_code",
    });
  });

  it("rejects local_single_user when an explicit topology axis conflicts", () => {
    expect(() =>
      resolveCliAuthTopology({
        env: {
          AOA_INSTALL_PROFILE: "local_single_user",
          AOA_NETWORK_LOCATION: "remote",
        },
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        platform: "linux",
      }),
    ).toThrow(/conflicts/);
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
    expect(resolveProviderCliCommand("openai", "win32")).toBe("codex.cmd");
    expect(resolveProviderCliCommand("anthropic", "win32")).toBe("claude.cmd");
    expect(resolveProviderCliCommand("anthropic", "linux")).toBe("claude");
    await expect(
      detectProviderCli("openai", async () => ({ stdout: "codex-cli 0.145.3" })),
    ).resolves.toMatchObject({ cliInstalled: true, cliVersionSupported: true });
    await expect(
      detectProviderCli("openai", async () => ({ stdout: "codex-cli 0.154.0" })),
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
