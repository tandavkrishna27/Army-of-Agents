import { describe, expect, it } from "vitest";
import { findForbiddenWireKeys } from "./wire-safety.js";
import {
  ARTIFACT_RETENTION_CLASSES,
  OFFLINE_POLICIES,
  SECRET_MATERIALIZATION_KINDS,
  SECRET_USE_POLICIES,
  artifactRetentionClassSchema,
  networkAllowRuleSchema,
  networkPolicyRefSchema,
  networkPolicyV1Schema,
  offlinePolicySchema,
  resourceLimitsSchema,
  secretHandleRefSchema,
  secretMaterializationSchema,
} from "./policy.js";

const HANDLE = "00000000-0000-4000-8000-000000000016";
const DIGEST = "c".repeat(64);

const validAllowRule = { scheme: "https", host: "api.example.com", port: 443 } as const;

const validNetworkPolicy = {
  policyId: "provider-only",
  version: 1,
  digest: DIGEST,
  defaultAction: "deny",
  allow: [validAllowRule],
  denyPrivateNetworks: true,
  denyMetadata: true,
  denyControlPlane: true,
};

const validSecretProxy = {
  handleId: HANDLE,
  materialization: { kind: "proxy" },
  usePolicy: "fence_proxy",
};

// -----------------------------------------------------------------------------
// resourceLimitsSchema — single source, byte-equal to the PRT-003 job limits.
// -----------------------------------------------------------------------------

describe("resourceLimitsSchema", () => {
  const valid = { cpuMillis: 2000, memoryMiB: 4096, pids: 512, diskMiB: 10240 };

  it("accepts the canonical in-range limits", () => {
    expect(resourceLimitsSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts the exact PRT-003 min/max ceilings", () => {
    expect(resourceLimitsSchema.safeParse({ cpuMillis: 100, memoryMiB: 128, pids: 16, diskMiB: 128 }).success).toBe(true);
    expect(
      resourceLimitsSchema.safeParse({ cpuMillis: 128_000, memoryMiB: 1_048_576, pids: 100_000, diskMiB: 10_485_760 }).success,
    ).toBe(true);
  });

  it("rejects zero, negative, and above-ceiling values on every field", () => {
    for (const field of ["cpuMillis", "memoryMiB", "pids", "diskMiB"] as const) {
      expect(resourceLimitsSchema.safeParse({ ...valid, [field]: 0 }).success).toBe(false);
      expect(resourceLimitsSchema.safeParse({ ...valid, [field]: -1 }).success).toBe(false);
    }
    expect(resourceLimitsSchema.safeParse({ ...valid, cpuMillis: 128_001 }).success).toBe(false);
    expect(resourceLimitsSchema.safeParse({ ...valid, memoryMiB: 1_048_577 }).success).toBe(false);
    expect(resourceLimitsSchema.safeParse({ ...valid, pids: 100_001 }).success).toBe(false);
    expect(resourceLimitsSchema.safeParse({ ...valid, diskMiB: 10_485_761 }).success).toBe(false);
  });

  it("rejects non-integers and unknown keys", () => {
    expect(resourceLimitsSchema.safeParse({ ...valid, cpuMillis: 2000.5 }).success).toBe(false);
    expect(resourceLimitsSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// networkAllowRuleSchema — https host/port only, lowercase DNS, no IP literals.
// -----------------------------------------------------------------------------

describe("networkAllowRuleSchema", () => {
  it("accepts an https lowercase DNS host on a valid port", () => {
    expect(networkAllowRuleSchema.safeParse(validAllowRule).success).toBe(true);
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "sub.domain.example.com", port: 8443 }).success).toBe(true);
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "a.co", port: 65535 }).success).toBe(true);
  });

  it("rejects any non-https scheme", () => {
    expect(networkAllowRuleSchema.safeParse({ scheme: "http", host: "api.example.com", port: 80 }).success).toBe(false);
    expect(networkAllowRuleSchema.safeParse({ scheme: "wss", host: "api.example.com", port: 443 }).success).toBe(false);
    expect(networkAllowRuleSchema.safeParse({ scheme: "ftp", host: "api.example.com", port: 21 }).success).toBe(false);
  });

  it("rejects IPv4 literals", () => {
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "10.0.0.1", port: 443 }).success).toBe(false);
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "192.168.1.1", port: 443 }).success).toBe(false);
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "169.254.169.254", port: 443 }).success).toBe(false);
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "127.0.0.1", port: 443 }).success).toBe(false);
  });

  it("rejects IPv6 literals and bracketed hosts", () => {
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "::1", port: 443 }).success).toBe(false);
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "[::1]", port: 443 }).success).toBe(false);
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "fe80::1", port: 443 }).success).toBe(false);
  });

  it("rejects uppercase (non-lowercase) DNS names", () => {
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "API.example.com", port: 443 }).success).toBe(false);
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "Api.Example.Com", port: 443 }).success).toBe(false);
  });

  it("rejects out-of-range and non-integer ports", () => {
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "api.example.com", port: 0 }).success).toBe(false);
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "api.example.com", port: -1 }).success).toBe(false);
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "api.example.com", port: 65536 }).success).toBe(false);
    expect(networkAllowRuleSchema.safeParse({ scheme: "https", host: "api.example.com", port: 443.5 }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(networkAllowRuleSchema.safeParse({ ...validAllowRule, path: "/x" }).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// networkPolicyV1Schema — default deny + all deny-classes true in v1.
// -----------------------------------------------------------------------------

describe("networkPolicyV1Schema", () => {
  it("accepts a default-deny policy with an https allowlist", () => {
    expect(networkPolicyV1Schema.safeParse(validNetworkPolicy).success).toBe(true);
    expect(networkPolicyV1Schema.safeParse({ ...validNetworkPolicy, allow: [] }).success).toBe(true);
  });

  it("requires defaultAction === 'deny'", () => {
    expect(networkPolicyV1Schema.safeParse({ ...validNetworkPolicy, defaultAction: "allow" }).success).toBe(false);
    expect(networkPolicyV1Schema.safeParse({ ...validNetworkPolicy, defaultAction: "deny" }).success).toBe(true);
  });

  it("requires denyPrivateNetworks, denyMetadata, and denyControlPlane all true in v1", () => {
    expect(networkPolicyV1Schema.safeParse({ ...validNetworkPolicy, denyPrivateNetworks: false }).success).toBe(false);
    expect(networkPolicyV1Schema.safeParse({ ...validNetworkPolicy, denyMetadata: false }).success).toBe(false);
    expect(networkPolicyV1Schema.safeParse({ ...validNetworkPolicy, denyControlPlane: false }).success).toBe(false);
  });

  it("rejects an allow rule that is not https-host-only", () => {
    expect(
      networkPolicyV1Schema.safeParse({ ...validNetworkPolicy, allow: [{ scheme: "http", host: "api.example.com", port: 80 }] }).success,
    ).toBe(false);
    expect(
      networkPolicyV1Schema.safeParse({ ...validNetworkPolicy, allow: [{ scheme: "https", host: "10.0.0.1", port: 443 }] }).success,
    ).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(networkPolicyV1Schema.safeParse({ ...validNetworkPolicy, defaultActionOverride: true }).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// networkPolicyRefSchema — { policyId, version, digest }.
// -----------------------------------------------------------------------------

describe("networkPolicyRefSchema", () => {
  const ref = { policyId: "provider-only", version: 1, digest: DIGEST };

  it("accepts a well-formed reference", () => {
    expect(networkPolicyRefSchema.safeParse(ref).success).toBe(true);
  });

  it("rejects a non-sha256 digest, non-positive version, and unknown keys", () => {
    expect(networkPolicyRefSchema.safeParse({ ...ref, digest: "not-a-digest" }).success).toBe(false);
    expect(networkPolicyRefSchema.safeParse({ ...ref, version: 0 }).success).toBe(false);
    expect(networkPolicyRefSchema.safeParse({ ...ref, extra: 1 }).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// secretMaterializationSchema — proxy | env | file discriminated union.
// -----------------------------------------------------------------------------

describe("secretMaterializationSchema", () => {
  it("accepts proxy with no target", () => {
    expect(secretMaterializationSchema.safeParse({ kind: "proxy" }).success).toBe(true);
  });

  it("rejects proxy carrying an env/file target (proxy has no target)", () => {
    expect(secretMaterializationSchema.safeParse({ kind: "proxy", target: "FOO" }).success).toBe(false);
  });

  it("accepts an env target matching ^[A-Z_][A-Z0-9_]*$", () => {
    expect(secretMaterializationSchema.safeParse({ kind: "env", target: "AOA_SECRET_HANDLE" }).success).toBe(true);
    expect(secretMaterializationSchema.safeParse({ kind: "env", target: "_X1" }).success).toBe(true);
  });

  it("rejects env targets that violate the shell-variable grammar", () => {
    expect(secretMaterializationSchema.safeParse({ kind: "env", target: "lowercase" }).success).toBe(false);
    expect(secretMaterializationSchema.safeParse({ kind: "env", target: "1LEADING_DIGIT" }).success).toBe(false);
    expect(secretMaterializationSchema.safeParse({ kind: "env", target: "HAS-DASH" }).success).toBe(false);
    expect(secretMaterializationSchema.safeParse({ kind: "env", target: "HAS SPACE" }).success).toBe(false);
    expect(secretMaterializationSchema.safeParse({ kind: "env", target: "" }).success).toBe(false);
  });

  it("accepts a file target that is an absolute sandbox path under /run/aoa-secrets/", () => {
    expect(secretMaterializationSchema.safeParse({ kind: "file", target: "/run/aoa-secrets/handle-1" }).success).toBe(true);
    expect(secretMaterializationSchema.safeParse({ kind: "file", target: "/run/aoa-secrets/nested/cap.txt" }).success).toBe(true);
  });

  it("rejects file targets outside /run/aoa-secrets/, or containing .. or backslash", () => {
    expect(secretMaterializationSchema.safeParse({ kind: "file", target: "/etc/passwd" }).success).toBe(false);
    expect(secretMaterializationSchema.safeParse({ kind: "file", target: "/run/aoa-secrets/../etc/passwd" }).success).toBe(false);
    expect(secretMaterializationSchema.safeParse({ kind: "file", target: "run/aoa-secrets/x" }).success).toBe(false); // not absolute
    expect(secretMaterializationSchema.safeParse({ kind: "file", target: "/run/aoa-secrets/" }).success).toBe(false); // no filename
    expect(secretMaterializationSchema.safeParse({ kind: "file", target: "\\run\\aoa-secrets\\x" }).success).toBe(false);
    expect(secretMaterializationSchema.safeParse({ kind: "file", target: "/run/aoa-secrets-evil/x" }).success).toBe(false);
  });

  it("rejects unknown materialization kinds", () => {
    expect(secretMaterializationSchema.safeParse({ kind: "direct" }).success).toBe(false);
    expect(secretMaterializationSchema.safeParse({ kind: "inline", value: "sk-live-123" }).success).toBe(false);
  });

  it("locks the materialization-kind vocabulary", () => {
    expect(SECRET_MATERIALIZATION_KINDS).toEqual(["proxy", "env", "file"]);
  });
});

// -----------------------------------------------------------------------------
// secretHandleRefSchema — opaque handle + materialization + use policy.
// -----------------------------------------------------------------------------

describe("secretHandleRefSchema", () => {
  it("accepts an opaque handle with proxy materialization under fence_proxy", () => {
    expect(secretHandleRefSchema.safeParse(validSecretProxy).success).toBe(true);
  });

  it("accepts env/file capability materialization under remote/local policies", () => {
    expect(
      secretHandleRefSchema.safeParse({ handleId: HANDLE, materialization: { kind: "env", target: "AOA_SECRET_HANDLE" }, usePolicy: "remote_server_fenced" }).success,
    ).toBe(true);
    expect(
      secretHandleRefSchema.safeParse({ handleId: HANDLE, materialization: { kind: "file", target: "/run/aoa-secrets/h1" }, usePolicy: "sandbox_local_only" }).success,
    ).toBe(true);
  });

  it("requires a UUID handle ID (never a plaintext secret string)", () => {
    expect(secretHandleRefSchema.safeParse({ ...validSecretProxy, handleId: "sk-live-abc123" }).success).toBe(false);
    expect(secretHandleRefSchema.safeParse({ ...validSecretProxy, handleId: "not-a-uuid" }).success).toBe(false);
  });

  it("restricts remote governed use to fence_proxy / remote_server_fenced", () => {
    expect(SECRET_USE_POLICIES).toEqual(["fence_proxy", "remote_server_fenced", "sandbox_local_only"]);
    // proxy materialization is the per-request fence proxy: only fence_proxy.
    expect(
      secretHandleRefSchema.safeParse({ handleId: HANDLE, materialization: { kind: "proxy" }, usePolicy: "remote_server_fenced" }).success,
    ).toBe(false);
    // sandbox_local_only cannot authorize a network destination: it cannot use the proxy (network) mechanism.
    expect(
      secretHandleRefSchema.safeParse({ handleId: HANDLE, materialization: { kind: "proxy" }, usePolicy: "sandbox_local_only" }).success,
    ).toBe(false);
    // env/file (sandbox-delivered) cannot claim the per-request fence proxy policy.
    expect(
      secretHandleRefSchema.safeParse({ handleId: HANDLE, materialization: { kind: "env", target: "AOA_SECRET_HANDLE" }, usePolicy: "fence_proxy" }).success,
    ).toBe(false);
  });

  it("rejects an unknown use policy (raw direct-provider use is unrepresentable)", () => {
    expect(secretHandleRefSchema.safeParse({ ...validSecretProxy, usePolicy: "direct_provider" }).success).toBe(false);
    expect(secretHandleRefSchema.safeParse({ ...validSecretProxy, usePolicy: "raw" }).success).toBe(false);
  });

  it("rejects connector OAuth access/refresh tokens and broker bundles recursively (wire-safety)", () => {
    // Injected top-level OAuth token key.
    expect(
      secretHandleRefSchema.safeParse({ ...validSecretProxy, accessToken: "ya29.a0AfB_secret" }).success,
    ).toBe(false);
    expect(
      secretHandleRefSchema.safeParse({ ...validSecretProxy, refreshToken: "1//refresh_secret" }).success,
    ).toBe(false);
    // A nested broker token bundle is located by the recursive forbidden-key scan.
    const brokerBundle = {
      ...validSecretProxy,
      broker: { oauth: { accessToken: "ya29.secret", refreshToken: "1//secret" } },
    };
    expect(secretHandleRefSchema.safeParse(brokerBundle).success).toBe(false);
    expect(findForbiddenWireKeys(brokerBundle)).toEqual(["broker.oauth.accessToken", "broker.oauth.refreshToken"]);
  });

  it("rejects a raw secret-value field (no wire field exposes secret bytes)", () => {
    expect(secretHandleRefSchema.safeParse({ ...validSecretProxy, secretValue: "top-secret" }).success).toBe(false);
    expect(secretHandleRefSchema.safeParse({ ...validSecretProxy, materialization: { kind: "env", target: "X", value: "raw" } }).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Locked enums: retention + offline policy.
// -----------------------------------------------------------------------------

describe("artifactRetentionClassSchema", () => {
  it("locks the retention vocabulary", () => {
    expect(ARTIFACT_RETENTION_CLASSES).toEqual(["ephemeral", "run", "audit", "checkpoint"]);
    for (const value of ARTIFACT_RETENTION_CLASSES) {
      expect(artifactRetentionClassSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rejects any other retention value", () => {
    expect(artifactRetentionClassSchema.safeParse("permanent").success).toBe(false);
    expect(artifactRetentionClassSchema.safeParse("none").success).toBe(false);
  });
});

describe("offlinePolicySchema", () => {
  it("locks the offline-policy vocabulary", () => {
    expect(OFFLINE_POLICIES).toEqual(["cancel", "finish_without_remote_effects", "continue_until_lease_expiry"]);
    for (const value of OFFLINE_POLICIES) {
      expect(offlinePolicySchema.safeParse(value).success).toBe(true);
    }
  });

  it("rejects any other offline-policy value", () => {
    expect(offlinePolicySchema.safeParse("continue_with_remote_effects").success).toBe(false);
    expect(offlinePolicySchema.safeParse("finish").success).toBe(false);
  });
});
