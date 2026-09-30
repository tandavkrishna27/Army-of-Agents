// server/src/__tests__/gvisor-sandbox-config.test.ts
import { describe, expect, it } from "vitest";
import { buildDockerRunArgs } from "@armyofagents/adapter-utils";
import { resolveDockerSandboxConfig, resolveGvisorSandboxTarget } from "../services/environment-runtime.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";

describe("resolveGvisorSandboxTarget", () => {
  it("maps a gvisor environment config to a hardened sandbox-docker target", () => {
    const target = resolveGvisorSandboxTarget({
      provider: "gvisor",
      image: "aoa/agent-base:latest",
      isolation: { user: "1000:1000", capDropAll: true, readOnlyRootfs: true, memory: "2g", cpus: "2", pidsLimit: 512 },
    });
    expect(target.type).toBe("sandbox-docker");
    expect(target.runtime).toBe("runsc");
    expect(target.network).toBe("none");            // egress default
    expect(target.allowHostGateway).toBe(false);
    expect(target.isolation?.user).toBe("1000:1000");
    expect(target.isolation?.noNewPrivileges).toBe(true); // default-on for gvisor
    expect(target.isolation?.tmpfs?.length).toBeGreaterThan(0);
  });
  it("throws when a gvisor config has no image", () => {
    expect(() => resolveGvisorSandboxTarget({ provider: "gvisor" })).toThrow(/image/);
  });
});

describe("resolveGvisorSandboxTarget deployment-mode-aware hardening (P5 SSRF residual)", () => {
  // A tenant-authored gVisor ENVIRONMENT config that tries to weaken the sandbox.
  const weakened = {
    provider: "gvisor",
    image: "aoa/agent-base:latest",
    network: "bridge",
    allowHostGateway: true,
    isolation: { user: "0:0", capDropAll: false, readOnlyRootfs: false, noNewPrivileges: false, ipcPrivate: false, tmpfs: ["/tmp:rw,exec,suid"] },
  };

  it("MULTI_TENANT: forces the hardened profile, ignoring the weakened tenant config", () => {
    const target = resolveGvisorSandboxTarget(weakened, { multiTenant: true });
    expect(target.allowHostGateway).toBe(false); // SSRF host-gateway route stays closed
    expect(target.network).toBe("none"); // no tenant-chosen bridge/host egress on shared infra
    const iso = target.isolation as Record<string, unknown>;
    expect(iso.user).toBe("1000:1000"); // cannot run as root
    expect(iso.capDropAll).toBe(true);
    expect(iso.readOnlyRootfs).toBe(true);
    expect(iso.noNewPrivileges).toBe(true);
    expect(iso.ipcPrivate).toBe(true);
    expect(iso.seccompProfile).toBeNull();
    expect(iso.tmpfs).toEqual(["/tmp:rw,noexec,nosuid,size=64m", "/home/agent:rw,nosuid,size=256m"]);
  });

  it("SELF-HOSTED: honors the trusted config exactly (network bridge, host-gateway, weaker isolation)", () => {
    const target = resolveGvisorSandboxTarget(weakened, { multiTenant: false });
    expect(target.allowHostGateway).toBe(true); // founder owns the box: local MCP bridge honored
    expect(target.network).toBe("bridge"); // custom egress honored (no regression)
    const iso = target.isolation as Record<string, unknown>;
    expect(iso.user).toBe("0:0"); // config honored exactly on self-hosted
    expect(iso.capDropAll).toBe(false);
    expect(iso.readOnlyRootfs).toBe(false);
    expect(iso.noNewPrivileges).toBe(false);
    expect(iso.ipcPrivate).toBe(false);
  });

  it("defaults to hardened (fail-closed) when no deployment mode is threaded", () => {
    const target = resolveGvisorSandboxTarget(weakened);
    expect(target.allowHostGateway).toBe(false);
    expect(target.network).toBe("none");
    expect((target.isolation as Record<string, unknown>).capDropAll).toBe(true);
  });
});

describe("resolveEnvironmentExecutionTarget deployment-mode-aware residual (environments.config -> buildDockerRunArgs)", () => {
  const weakenedEnv = {
    driver: "sandbox" as const,
    target: null,
    config: {
      provider: "gvisor",
      image: "aoa/agent-base:latest",
      network: "host",
      allowHostGateway: true,
      isolation: { capDropAll: false, readOnlyRootfs: false, noNewPrivileges: false },
    },
  };

  it("MULTI_TENANT: a weakened tenant gVisor environment still emits hardened docker args (--network none, --cap-drop ALL, no --add-host)", () => {
    const target = resolveEnvironmentExecutionTarget({ environment: weakenedEnv, adapterType: "claude_local", multiTenant: true });
    if (!target || target.type !== "sandbox-docker") throw new Error("expected sandbox-docker target");
    expect(target.network).toBe("none");
    expect(target.allowHostGateway).toBe(false);
    const args = buildDockerRunArgs({ target, localCwd: "/repo", command: "claude", args: ["-p", "hi"], env: {} });
    const joined = args.join(" ");
    expect(joined).toContain("--network none");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--read-only");
    expect(args).not.toContain("--add-host"); // host-gateway route stays closed on shared infra
  });

  it("SELF-HOSTED: the same config is honored (network host, host-gateway route allowed)", () => {
    const target = resolveEnvironmentExecutionTarget({ environment: weakenedEnv, adapterType: "claude_local", multiTenant: false });
    if (!target || target.type !== "sandbox-docker") throw new Error("expected sandbox-docker target");
    expect(target.network).toBe("host");
    expect(target.allowHostGateway).toBe(true);
    expect(target.isolation?.capDropAll).toBe(false);
  });
});

describe("gvisor end-to-end config resolution", () => {
  it("resolveDockerSandboxConfig no longer throws for gvisor and carries the hardened profile", () => {
    const resolved = resolveDockerSandboxConfig({
      config: { provider: "gvisor", image: "aoa/agent-base:latest" },
    });
    expect(resolved.provider).toBe("sandbox-docker"); // routes down the docker acquire path
    expect(resolved.type).toBe("sandbox-docker");
    expect(resolved.runtime).toBe("runsc");
    expect(resolved.network).toBe("none");
    expect(resolved.allowHostGateway).toBe(false);
    expect((resolved.isolation as Record<string, unknown>).noNewPrivileges).toBe(true);
  });

  it("a gvisor environment resolves end-to-end to a hardened docker target whose args carry --runtime runsc and omit --add-host by default", () => {
    const target = resolveEnvironmentExecutionTarget({
      environment: {
        driver: "sandbox",
        target: null,
        config: {
          provider: "gvisor",
          image: "aoa/agent-base:latest",
          isolation: { user: "1000:1000", capDropAll: true, readOnlyRootfs: true, memory: "2g", cpus: "2", pidsLimit: 512 },
        },
      },
      adapterType: "claude_local",
    });
    expect(target).not.toBeNull();
    if (!target || target.type !== "sandbox-docker") throw new Error("expected sandbox-docker target");
    expect(target.runtime).toBe("runsc");
    expect(target.network).toBe("none");
    expect(target.isolation?.noNewPrivileges).toBe(true);
    expect(target.isolation?.user).toBe("1000:1000");

    const args = buildDockerRunArgs({
      target,
      localCwd: "/repo",
      command: "claude",
      args: ["-p", "hi"],
      env: {},
    });
    const joined = args.join(" ");
    expect(joined).toContain("--runtime runsc");
    expect(joined).toContain("--network none");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--read-only");
    expect(joined).toContain("--pids-limit 512");
    // Default-OFF SSRF guard: no callback bridge active here -> no host-gateway route.
    expect(args).not.toContain("--add-host");
  });

  it("default-off (self-hosted): a plain sandbox-docker environment emits NO runtime/isolation flags (byte-identical legacy args)", () => {
    const target = resolveEnvironmentExecutionTarget({
      environment: { driver: "sandbox", target: null, config: { provider: "sandbox-docker", image: "node:22" } },
      adapterType: "claude_local",
      multiTenant: false, // self-hosted single-tenant: legacy args preserved
    });
    if (!target || target.type !== "sandbox-docker") throw new Error("expected sandbox-docker target");
    expect(target.runtime ?? null).toBeNull();
    expect(target.isolation ?? null).toBeNull();
    const args = buildDockerRunArgs({ target, localCwd: "/repo", command: "node", args: [], env: {} });
    const joined = args.join(" ");
    expect(joined).not.toContain("--runtime");
    expect(joined).not.toContain("--cap-drop");
    expect(joined).not.toContain("--read-only");
    expect(args).not.toContain("--add-host");
  });

  it("MULTI_TENANT: a plain non-gvisor sandbox-docker environment IS sink-hardened (residual closed)", () => {
    const target = resolveEnvironmentExecutionTarget({
      environment: { driver: "sandbox", target: null, config: { provider: "sandbox-docker", image: "node:22" } },
      adapterType: "claude_local",
      multiTenant: true, // shared infra: an unhardened docker target is a sandbox escape
    });
    if (!target || target.type !== "sandbox-docker") throw new Error("expected sandbox-docker target");
    expect(target.allowHostGateway).toBe(false);
    const args = buildDockerRunArgs({ target, localCwd: "/repo", command: "node", args: [], env: {} });
    const joined = args.join(" ");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--read-only");
    expect(joined).toContain("no-new-privileges");
    expect(joined).toContain("--user 1000:1000");
    expect(args).not.toContain("--add-host");
  });
});
