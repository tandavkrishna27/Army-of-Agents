import { describe, it, expect } from "vitest";
import {
  createEnvironmentSchema,
  e2bEnvironmentConfigSchema,
  probeEnvironmentSchema,
  updateEnvironmentSchema,
  environmentLeaseStatusSchema,
} from "../validators/environment.js";
import type { Environment, EnvironmentLease } from "../types/environment.js";

describe("createEnvironmentSchema", () => {
  it("accepts valid payload", () => {
    const result = createEnvironmentSchema.safeParse({
      name: "production",
      envVars: { API_KEY: "abc123" },
    });
    expect(result.success).toBe(true);
  });

  it("keeps envVars permissive so route normalization can return useful errors", () => {
    const result = createEnvironmentSchema.safeParse({
      name: "needs-normalization",
      envVars: { API_URL: { type: "secret_ref", secretId: "not-a-uuid" } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing name", () => {
    const result = createEnvironmentSchema.safeParse({ envVars: {} });
    expect(result.success).toBe(false);
  });

  it("defaults envVars to empty object when omitted", () => {
    const result = createEnvironmentSchema.safeParse({ name: "staging" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.envVars).toEqual({});
  });

  it("accepts connectionTarget", () => {
    const result = createEnvironmentSchema.safeParse({
      name: "staging",
      envVars: {},
      connectionTarget: { host: "localhost" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts execution target", () => {
    const result = createEnvironmentSchema.safeParse({
      name: "docker",
      envVars: {},
      target: { type: "sandbox-docker", image: "node:22-bookworm" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid execution target", () => {
    const result = createEnvironmentSchema.safeParse({
      name: "bad-target",
      target: { type: "sandbox-docker" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts Paperclip-style runtime driver fields while preserving AoA envVars", () => {
    const result = createEnvironmentSchema.safeParse({
      name: "cloud sandbox",
      description: "Ephemeral provider-backed runtime",
      envVars: { AOA_ENV: "test" },
      driver: "sandbox",
      status: "active",
      config: { provider: "fake", image: "node:22-bookworm", reuseLease: false },
      metadata: { region: "us-east-1" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.driver).toBe("sandbox");
      expect(result.data.envVars).toEqual({ AOA_ENV: "test" });
    }
  });

  it("rejects unknown runtime drivers", () => {
    const result = createEnvironmentSchema.safeParse({
      name: "bad",
      driver: "browser-farm",
    });
    expect(result.success).toBe(false);
  });

  it("accepts E2B sandbox config with credentialRef default", () => {
    const parsed = createEnvironmentSchema.parse({
      name: "E2B Cloud",
      driver: "sandbox",
      config: {
        provider: "e2b",
        credentialRef: "default",
        template: "base",
        timeoutMs: 60000,
        reuseLease: false,
      },
      target: null,
    });

    expect(parsed.config).toMatchObject({
      provider: "e2b",
      credentialRef: "default",
      template: "base",
      timeoutMs: 60000,
    });
  });

  it("accepts E2B sandbox config with credentialSecretId", () => {
    const parsed = probeEnvironmentSchema.parse({
      driver: "sandbox",
      config: {
        provider: "e2b",
        credentialSecretId: "00000000-0000-4000-8000-000000000001",
        template: "base",
      },
    });

    expect(parsed.config.credentialSecretId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("documents E2B sandbox config without accepting raw API keys", () => {
    expect(e2bEnvironmentConfigSchema.parse({
      provider: "e2b",
      credentialRef: "default",
    })).toEqual({
      provider: "e2b",
      credentialRef: "default",
      template: "base",
    });

    expect(() =>
      e2bEnvironmentConfigSchema.parse({
        provider: "e2b",
        apiKey: "sk-raw",
      }),
    ).toThrow();
  });

  it("rejects raw E2B apiKey fields in create and probe payloads", () => {
    expect(createEnvironmentSchema.safeParse({
      name: "E2B raw key",
      driver: "sandbox",
      config: {
        provider: "e2b",
        apiKey: "sk-raw",
      },
    }).success).toBe(false);

    expect(probeEnvironmentSchema.safeParse({
      driver: "sandbox",
      config: {
        provider: "e2b",
        apiKey: "sk-raw",
      },
    }).success).toBe(false);
  });
});

describe("updateEnvironmentSchema", () => {
  it("accepts partial update", () => {
    const result = updateEnvironmentSchema.safeParse({ name: "renamed" });
    expect(result.success).toBe(true);
  });

  it("keeps update envVars permissive so route normalization can return useful errors", () => {
    const result = updateEnvironmentSchema.safeParse({
      envVars: { API_URL: { type: "secret_ref", secretId: "not-a-uuid" } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty object", () => {
    const result = updateEnvironmentSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts archiving an environment", () => {
    const result = updateEnvironmentSchema.safeParse({ status: "archived" });
    expect(result.success).toBe(true);
  });

  it("rejects raw E2B apiKey fields in update payloads", () => {
    const result = updateEnvironmentSchema.safeParse({
      driver: "sandbox",
      config: {
        provider: "e2b",
        apiKey: "sk-raw",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("environment lease validators", () => {
  it("accepts runtime lease lifecycle statuses", () => {
    expect(environmentLeaseStatusSchema.safeParse("active").success).toBe(true);
    expect(environmentLeaseStatusSchema.safeParse("released").success).toBe(true);
    expect(environmentLeaseStatusSchema.safeParse("failed").success).toBe(true);
    expect(environmentLeaseStatusSchema.safeParse("retained").success).toBe(true);
    expect(environmentLeaseStatusSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("Environment type", () => {
  it("shape check", () => {
    const env: Environment = {
      id: "00000000-0000-0000-0000-000000000001",
      companyId: "00000000-0000-0000-0000-000000000002",
      name: "production",
      description: null,
      driver: "local",
      status: "active",
      config: {},
      metadata: null,
      envVars: { KEY: "val" },
      connectionTarget: null,
      target: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(env.name).toBe("production");
  });

  it("lease shape check", () => {
    const lease: EnvironmentLease = {
      id: "00000000-0000-0000-0000-000000000011",
      companyId: "00000000-0000-0000-0000-000000000002",
      environmentId: "00000000-0000-0000-0000-000000000001",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "00000000-0000-0000-0000-000000000021",
      agentId: null,
      status: "active",
      leasePolicy: "ephemeral",
      provider: "local",
      providerLeaseId: null,
      acquiredAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      expiresAt: null,
      releasedAt: null,
      pausedAt: null,
      failureReason: null,
      cleanupStatus: null,
      metadata: { driver: "local" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(lease.status).toBe("active");
  });
});
