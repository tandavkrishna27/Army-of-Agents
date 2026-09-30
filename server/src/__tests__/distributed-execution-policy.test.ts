import { describe, expect, it } from "vitest";
import {
  assertHostedExecutionStartupSafe,
  DISTRIBUTED_CLOUD_PLUGIN_EXECUTION_ENV,
  DISTRIBUTED_EXECUTION_ENABLED_ENV,
  DISTRIBUTED_PUBLIC_SERVICE_INGRESS_ENV,
  readDistributedExecutionDeploymentFlag,
  resolveDistributedExecutionRollout,
  UNSANDBOXED_MULTITENANT_OPT_IN_ENV,
} from "../config/distributed-execution.js";

describe("distributed execution rollout policy", () => {
  it("defaults the deployment flag off", () => {
    expect(readDistributedExecutionDeploymentFlag({})).toBe(false);
  });

  it.each(["1", "true", "yes", "on", " TRUE "])("accepts enabled value %s", (value) => {
    expect(readDistributedExecutionDeploymentFlag({ [DISTRIBUTED_EXECUTION_ENABLED_ENV]: value })).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("accepts disabled value %s", (value) => {
    expect(readDistributedExecutionDeploymentFlag({ [DISTRIBUTED_EXECUTION_ENABLED_ENV]: value })).toBe(false);
  });

  it("rejects an ambiguous deployment flag", () => {
    expect(() => readDistributedExecutionDeploymentFlag({
      [DISTRIBUTED_EXECUTION_ENABLED_ENV]: "sometimes",
    })).toThrow(DISTRIBUTED_EXECUTION_ENABLED_ENV);
  });

  it("requires both deployment and Organization enablement", () => {
    expect(resolveDistributedExecutionRollout({
      deploymentMode: "cloud_auth",
      deploymentEnabled: true,
      organizationEnabled: true,
      workloadEnabled: true,
    })).toEqual({ enabled: true, reason: "enabled" });
    expect(resolveDistributedExecutionRollout({
      deploymentMode: "cloud_auth",
      deploymentEnabled: false,
      organizationEnabled: true,
      workloadEnabled: true,
    })).toEqual({ enabled: false, reason: "deployment_disabled" });
    expect(resolveDistributedExecutionRollout({
      deploymentMode: "cloud_auth",
      deploymentEnabled: true,
      organizationEnabled: false,
      workloadEnabled: true,
    })).toEqual({ enabled: false, reason: "organization_disabled" });
    expect(resolveDistributedExecutionRollout({
      deploymentMode: "cloud_auth",
      deploymentEnabled: true,
      organizationEnabled: true,
      workloadEnabled: false,
    })).toEqual({ enabled: false, reason: "workload_disabled" });
  });

  it("forbids the process-wide unsafe override in cloud_auth", () => {
    expect(() => assertHostedExecutionStartupSafe({
      deploymentMode: "cloud_auth",
      env: { [UNSANDBOXED_MULTITENANT_OPT_IN_ENV]: "1" },
    })).toThrow(/forbidden.*cloud_auth/i);
  });

  it.each([
    DISTRIBUTED_PUBLIC_SERVICE_INGRESS_ENV,
    DISTRIBUTED_CLOUD_PLUGIN_EXECUTION_ENV,
  ])("hard-rejects excluded surface %s", (name) => {
    expect(() => assertHostedExecutionStartupSafe({
      deploymentMode: "local_trusted",
      env: { [name]: "true" },
    })).toThrow(new RegExp(`${name}.*excluded`, "i"));
    expect(() => assertHostedExecutionStartupSafe({
      deploymentMode: "cloud_auth",
      env: { [name]: "1" },
    })).toThrow(new RegExp(`${name}.*excluded`, "i"));
  });

  it("does not change self-hosted startup", () => {
    expect(() => assertHostedExecutionStartupSafe({
      deploymentMode: "local_trusted",
      env: { [UNSANDBOXED_MULTITENANT_OPT_IN_ENV]: "1" },
    })).not.toThrow();
  });
});
