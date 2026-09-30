import { afterEach, describe, expect, it } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";
import {
  RUNTIME_PROCESS_OWNER_ID_ENV,
  isRuntimeProcessOwnedByCurrentReplica,
  resolveRuntimeProcessOwnerId,
} from "../services/runtime-process-owner.js";

afterEach(() => {
  setDeploymentMode("local_trusted");
});

describe("resolveRuntimeProcessOwnerId", () => {
  it("uses and validates an explicit process-namespace owner", () => {
    expect(resolveRuntimeProcessOwnerId({
      env: { [RUNTIME_PROCESS_OWNER_ID_ENV]: "pod-a:pidns-7" },
    })).toBe("pod-a:pidns-7");
    expect(() => resolveRuntimeProcessOwnerId({
      env: { [RUNTIME_PROCESS_OWNER_ID_ENV]: "bad owner" },
    })).toThrow(/Invalid AOA_RUNTIME_PROCESS_OWNER_ID/);
  });

  it("derives a deterministic local owner from hostname and AoA instance", () => {
    process.env.AOA_INSTANCE_ID = "instance-a";
    const first = resolveRuntimeProcessOwnerId({ env: {}, hostname: "host-a" });
    const second = resolveRuntimeProcessOwnerId({ env: {}, hostname: "host-a" });
    expect(first).toBe(second);
    expect(first).toMatch(/^local-[a-f0-9]{32}$/);
    delete process.env.AOA_INSTANCE_ID;
  });

  it("requires explicit ownership before cloud local-process spawning", () => {
    setDeploymentMode("cloud_auth");
    expect(resolveRuntimeProcessOwnerId({ env: {} })).toBeNull();
    expect(() => resolveRuntimeProcessOwnerId({
      env: {},
      requireExplicitInCloud: true,
    })).toThrow(/AOA_RUNTIME_PROCESS_OWNER_ID is required/);
  });

  it("does not treat adapter-managed loopback reports as replica-local in cloud", () => {
    setDeploymentMode("cloud_auth");
    expect(isRuntimeProcessOwnedByCurrentReplica({ provider: "adapter_managed" }, "replica-a")).toBe(false);
    expect(isRuntimeProcessOwnedByCurrentReplica({
      provider: "local_process",
      processOwnerId: "replica-a",
    }, "replica-a")).toBe(true);
  });
});
