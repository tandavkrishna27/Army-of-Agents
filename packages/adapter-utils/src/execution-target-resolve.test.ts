import { describe, expect, it } from "vitest";
import { resolveAdapterExecutionTarget } from "./execution-target.js";

describe("resolveAdapterExecutionTarget sandbox-docker hardening", () => {
  it("parses runtime, isolation, and allowHostGateway", () => {
    const t = resolveAdapterExecutionTarget({
      type: "sandbox-docker",
      image: "aoa/agent-base:latest",
      network: "none",
      runtime: "runsc",
      allowHostGateway: false,
      isolation: {
        user: "1000:1000",
        capDropAll: true,
        readOnlyRootfs: true,
        tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"],
        memory: "2g",
        cpus: "2",
        pidsLimit: 512,
        noNewPrivileges: true,
      },
    });
    if (t.type !== "sandbox-docker") throw new Error("expected sandbox-docker");
    expect(t.runtime).toBe("runsc");
    expect(t.allowHostGateway).toBe(false);
    expect(t.isolation?.user).toBe("1000:1000");
    expect(t.isolation?.pidsLimit).toBe(512);
  });

  it("defaults are back-compat: no runtime, no isolation, no host-gateway opt-in", () => {
    const t = resolveAdapterExecutionTarget({ type: "sandbox-docker", image: "node:22" });
    if (t.type !== "sandbox-docker") throw new Error("expected sandbox-docker");
    expect(t.runtime ?? null).toBeNull();
    expect(t.isolation ?? null).toBeNull();
    expect(t.allowHostGateway ?? false).toBe(false);
  });
});

describe("resolveAdapterExecutionTarget hardenForMultiTenant (sink-level P5 hardening)", () => {
  // A tenant-authored docker exec-target config (e.g. agents.adapterConfig.
  // executionTarget) that tries to weaken the sandbox.
  const weakened = {
    type: "sandbox-docker",
    image: "node:22",
    allowHostGateway: true,
    remove: false,
    network: "host",
    isolation: {
      capDropAll: false,
      readOnlyRootfs: false,
      noNewPrivileges: false,
      ipcPrivate: false,
      user: "0:0",
      seccompProfile: "unconfined",
      tmpfs: ["/tmp:rw,exec,suid"],
      memory: "64g",
      cpus: "32",
      pidsLimit: 100000,
      ulimitNofile: 1000000,
    },
  };

  it("hardenForMultiTenant=true neutralizes a weakened config", () => {
    const t = resolveAdapterExecutionTarget(weakened, true);
    if (t.type !== "sandbox-docker") throw new Error("expected sandbox-docker");
    expect(t.allowHostGateway).toBe(false); // SSRF host-gateway route closed
    expect(t.network).toBe("none");
    expect(t.remove).toBe(true);
    expect(t.isolation?.capDropAll).toBe(true);
    expect(t.isolation?.readOnlyRootfs).toBe(true);
    expect(t.isolation?.noNewPrivileges).toBe(true);
    expect(t.isolation?.ipcPrivate).toBe(true);
    expect(t.isolation?.user).toBe("1000:1000"); // cannot run as root
    expect(t.isolation?.seccompProfile ?? null).toBeNull(); // no seccomp=unconfined
    expect(t.isolation?.tmpfs).toEqual([
      "/tmp:rw,noexec,nosuid,size=64m",
      "/home/agent:rw,nosuid,size=256m",
    ]); // malicious tmpfs not honored
    expect(t.isolation?.memory).toBe("2g");
    expect(t.isolation?.cpus).toBe("2");
    expect(t.isolation?.pidsLimit).toBe(512);
    expect(t.isolation?.ulimitNofile).toBeNull();
  });

  it("hardenForMultiTenant=false honors the config exactly (self-hosted)", () => {
    const t = resolveAdapterExecutionTarget(weakened, false);
    if (t.type !== "sandbox-docker") throw new Error("expected sandbox-docker");
    expect(t.allowHostGateway).toBe(true);
    expect(t.remove).toBe(false);
    expect(t.network).toBe("host");
    expect(t.isolation?.capDropAll).toBe(false);
    expect(t.isolation?.readOnlyRootfs).toBe(false);
    expect(t.isolation?.noNewPrivileges).toBe(false);
    expect(t.isolation?.ipcPrivate).toBe(false);
    expect(t.isolation?.user).toBe("0:0");
    expect(t.isolation?.seccompProfile).toBe("unconfined");
  });

  it("hardenForMultiTenant=true forces bridge networking to none", () => {
    const t = resolveAdapterExecutionTarget(
      { type: "sandbox-docker", image: "node:22", network: "bridge" },
      true,
    );
    if (t.type !== "sandbox-docker") throw new Error("expected sandbox-docker");
    expect(t.network).toBe("none");
    // A bare docker target with no isolation still gets the forced hardened profile.
    expect(t.isolation?.capDropAll).toBe(true);
    expect(t.allowHostGateway).toBe(false);
  });

  it("DEFAULT-OFF (no flag) still emits legacy args for a bare sandbox-docker", () => {
    const t = resolveAdapterExecutionTarget({ type: "sandbox-docker", image: "node:22" });
    if (t.type !== "sandbox-docker") throw new Error("expected sandbox-docker");
    expect(t.runtime ?? null).toBeNull();
    expect(t.isolation ?? null).toBeNull();
    expect(t.allowHostGateway ?? false).toBe(false);
  });

  it("local and provider-sandbox targets are unaffected by the hardening flag", () => {
    expect(resolveAdapterExecutionTarget({ type: "local" }, true)).toEqual({ type: "local" });
    const ps = resolveAdapterExecutionTarget(
      {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "lease-1",
        remoteCwd: "/sandbox",
        runner: { execute: () => {} },
      },
      true,
    );
    expect(ps.type).toBe("provider-sandbox");
  });
});
