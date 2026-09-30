import { describe, expect, it } from "vitest";
import {
  createRuntimeProviderKeySchema,
  createSecretBindingSchema,
  createSecretProviderConfigSchema,
  readEnvBindingValue,
  remoteSecretImportCommitSchema,
  remoteSecretImportPreviewSchema,
  secretProviderConfigPayloadSchema,
  updateRuntimeProviderKeySchema,
} from "./secret.js";

describe("readEnvBindingValue (binding-aware presence)", () => {
  it("returns a non-blank raw string", () => {
    expect(readEnvBindingValue("sk-x")).toBe("sk-x");
  });
  it("returns the value of a non-blank plain binding", () => {
    expect(readEnvBindingValue({ type: "plain", value: "sk-x" })).toBe("sk-x");
  });
  it("returns the secretId of a secret_ref binding (presence marker)", () => {
    expect(readEnvBindingValue({ type: "secret_ref", secretId: "abc", version: "latest" })).toBe("abc");
  });
  it("returns null for blank / whitespace / missing values", () => {
    expect(readEnvBindingValue("")).toBeNull();
    expect(readEnvBindingValue("   ")).toBeNull();
    expect(readEnvBindingValue({ type: "plain", value: "" })).toBeNull();
    expect(readEnvBindingValue({ type: "plain", value: "  " })).toBeNull();
    expect(readEnvBindingValue({ type: "secret_ref", secretId: "" })).toBeNull();
    expect(readEnvBindingValue(undefined)).toBeNull();
    expect(readEnvBindingValue(null)).toBeNull();
    expect(readEnvBindingValue({})).toBeNull();
  });
});

describe("secret validators", () => {
  it("accepts an AWS provider config with AoA defaults", () => {
    const parsed = createSecretProviderConfigSchema.parse({
      provider: "aws_secrets_manager",
      displayName: "Production AWS",
      config: { region: "us-east-1", secretNamePrefix: "aoa/prod" },
    });

    expect(parsed.provider).toBe("aws_secrets_manager");
  });

  it("requires valid UUIDs for remote import preview", () => {
    expect(() => remoteSecretImportPreviewSchema.parse({ providerConfigId: "nope" })).toThrow();
  });

  it("validates provider-specific config payloads", () => {
    expect(() =>
      secretProviderConfigPayloadSchema.parse({
        provider: "aws_secrets_manager",
        config: { secretNamePrefix: "aoa/prod" },
      }),
    ).toThrow();

    expect(
      secretProviderConfigPayloadSchema.parse({
        provider: "gcp_secret_manager",
        config: { projectId: "future" },
      }).provider,
    ).toBe("gcp_secret_manager");
  });

  it("accepts binding and remote import commit payloads", () => {
    const providerConfigId = "00000000-0000-4000-8000-000000000001";
    const secretId = "00000000-0000-4000-8000-000000000002";

    expect(
      createSecretBindingSchema.parse({
        secretId,
        targetType: "agent",
        targetId: "agent-1",
        configPath: "env.OPENAI_API_KEY",
      }).versionSelector,
    ).toBeUndefined();

    expect(
      remoteSecretImportCommitSchema.parse({
        providerConfigId,
        secrets: [{ externalRef: "arn:aws:secretsmanager:us-east-1:123:secret:aoa/prod/key" }],
      }).secrets,
    ).toHaveLength(1);
  });

  it("accepts an E2B runtime provider key backed by a company secret", () => {
    const parsed = createRuntimeProviderKeySchema.parse({
      provider: "e2b",
      displayName: "Default E2B",
      secretId: "00000000-0000-4000-8000-000000000001",
      isDefault: true,
    });

    expect(parsed).toEqual({
      provider: "e2b",
      displayName: "Default E2B",
      secretId: "00000000-0000-4000-8000-000000000001",
      isDefault: true,
    });
  });

  it("rejects unsupported runtime provider keys", () => {
    expect(() =>
      createRuntimeProviderKeySchema.parse({
        provider: "unknown",
        displayName: "Unknown",
        secretId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();
  });

  it("accepts runtime provider key metadata updates without secret values", () => {
    expect(updateRuntimeProviderKeySchema.parse({
      displayName: "Team E2B",
      isDefault: false,
      status: "disabled",
    })).toEqual({
      displayName: "Team E2B",
      isDefault: false,
      status: "disabled",
    });
  });
});
