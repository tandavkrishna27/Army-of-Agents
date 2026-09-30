import { describe, expect, it } from "vitest";
import {
  PLACEMENT_MATRIX,
  isTargetPlacementAllowed,
  jobEnvelopeV1Schema,
  leaseAckV1Schema,
  leaseOfferV1Schema,
  leaseRenewRequestV1Schema,
  leaseRenewResponseV1Schema,
} from "./job.js";

// Deep clone so per-test mutation never leaks between cases.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// The plan's verbatim valid batch fixture.
const batchJob = {
  protocolVersion: 1,
  jobId: "00000000-0000-4000-8000-000000000010",
  attempt: 1,
  organizationId: "00000000-0000-4000-8000-000000000011",
  companyId: "00000000-0000-4000-8000-000000000012",
  source: {
    kind: "task_run",
    runId: "00000000-0000-4000-8000-000000000013",
    issueId: "00000000-0000-4000-8000-000000000014",
    requestedBy: { principalType: "user", principalId: "better-auth-user-17" },
    executionPrincipal: { principalType: "agent", principalId: "00000000-0000-4000-8000-000000000017" },
    assigneeAgentId: "00000000-0000-4000-8000-000000000017",
  },
  createdAt: "2026-08-07T00:00:00.000Z",
  notBefore: null,
  deadline: "2026-08-07T01:00:00.000Z",
  inputHash: "a".repeat(64),
  policyHash: "b".repeat(64),
  placement: {
    policyId: "owner-or-managed",
    version: 1,
    digest: "d".repeat(64),
    targetRequirements: {
      allowedTargetClasses: ["owner_desktop", "managed_cloud"],
      allowedTrustClasses: ["owner_local_trusted", "shared_isolated"],
      requiredOwnerPrincipalId: null,
      credentialKind: "platform_brokered",
      dataLocality: "transfer_allowed",
      fallback: { mode: "ordered_explicit", orderedTargetClasses: ["owner_desktop", "managed_cloud"] },
      providerConstraints: { profileId: "standard", version: 1, digest: "e".repeat(64) },
    },
  },
  adapter: { type: "codex_local", version: "0.2.7", configArtifactId: null },
  requiredCapabilities: [
    "workload.batch",
    "provider.lifecycle_v1",
    "sandbox.filesystem_isolated",
    "sandbox.filtered_egress",
  ],
  workspace: {
    manifestArtifactId: "00000000-0000-4000-8000-000000000015",
    base: { kind: "git_commit", algorithm: "git_sha1", revision: "0123456789abcdef0123456789abcdef01234567" },
    manifestHash: "f".repeat(64),
    mode: "read_write",
  },
  secretHandles: [
    {
      handleId: "00000000-0000-4000-8000-000000000016",
      materialization: { kind: "proxy" },
      usePolicy: "fence_proxy",
    },
  ],
  resourceLimits: { cpuMillis: 2000, memoryMiB: 4096, pids: 512, diskMiB: 10240 },
  networkPolicy: { policyId: "provider-only", version: 1, digest: "c".repeat(64) },
  offlinePolicy: "cancel",
  extensions: [],
  workloadType: "batch",
  workload: { command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds: 3600 },
};

const browserWorkload = {
  engine: "chromium",
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
  timezone: "UTC",
  recordTrace: false,
  recordVideo: false,
  maxSessionSeconds: 1800,
};

const serviceWorkload = {
  serviceId: "00000000-0000-4000-8000-000000000040",
  serviceInstanceId: "00000000-0000-4000-8000-000000000041",
  generation: 1,
  command: "serve",
  args: ["--port", "8080"],
  checkpointArtifactId: null,
  gracefulStopSeconds: 30,
};

const browserJob = { ...clone(batchJob), workloadType: "browser_session", workload: clone(browserWorkload) };
const serviceJob = { ...clone(batchJob), workloadType: "service", workload: clone(serviceWorkload) };

// A single valid, well-formed extension (safe, non-critical).
const okExtension = {
  namespace: "com.armyofagents.hint",
  schemaVersion: 1,
  critical: false,
  value: { note: "safe additive data", tags: ["a", "b"] },
};

// Reusable single-target placements for isolated matrix assertions.
const managedPlacement = {
  policyId: "managed-only",
  version: 1,
  digest: "d".repeat(64),
  targetRequirements: {
    allowedTargetClasses: ["managed_cloud"],
    allowedTrustClasses: ["shared_isolated"],
    requiredOwnerPrincipalId: null,
    credentialKind: "platform_brokered",
    dataLocality: "transfer_allowed",
    fallback: { mode: "forbidden", orderedTargetClasses: [] },
    providerConstraints: { profileId: "standard", version: 1, digest: "e".repeat(64) },
  },
};

const ownerBoundPlacement = {
  policyId: "owner-only",
  version: 1,
  digest: "d".repeat(64),
  targetRequirements: {
    allowedTargetClasses: ["owner_desktop"],
    allowedTrustClasses: ["owner_local_trusted"],
    requiredOwnerPrincipalId: "owner-principal-123",
    credentialKind: "owner_bound",
    dataLocality: "owner_device_only",
    fallback: { mode: "forbidden", orderedTargetClasses: [] },
    providerConstraints: { profileId: "standard", version: 1, digest: "e".repeat(64) },
  },
};

const orgBrokeredPlacement = {
  policyId: "org-only",
  version: 1,
  digest: "d".repeat(64),
  targetRequirements: {
    allowedTargetClasses: ["organization_dedicated"],
    allowedTrustClasses: ["organization_isolated"],
    requiredOwnerPrincipalId: null,
    credentialKind: "organization_brokered",
    dataLocality: "organization_target_only",
    fallback: { mode: "forbidden", orderedTargetClasses: [] },
    providerConstraints: { profileId: "standard", version: 1, digest: "e".repeat(64) },
  },
};

const withPlacement = (placement: unknown) => ({ ...clone(batchJob), placement: clone(placement) });

describe("job envelope — workload discrimination", () => {
  it("parses the valid batch envelope", () => {
    expect(jobEnvelopeV1Schema.safeParse(clone(batchJob)).success).toBe(true);
  });

  it("parses the valid browser and service envelopes", () => {
    expect(jobEnvelopeV1Schema.safeParse(clone(browserJob)).success).toBe(true);
    expect(jobEnvelopeV1Schema.safeParse(clone(serviceJob)).success).toBe(true);
  });

  it("rejects a batch envelope carrying a browser payload", () => {
    const bad = { ...clone(batchJob), workload: clone(browserWorkload) };
    expect(jobEnvelopeV1Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects attempt 0 and unknown top-level keys (strict)", () => {
    expect(jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), attempt: 0 }).success).toBe(false);
    expect(jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), surprise: 1 }).success).toBe(false);
  });
});

describe("job envelope — timestamps and dedupe", () => {
  it("rejects deadline <= createdAt", () => {
    expect(
      jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), deadline: "2026-08-06T00:00:00.000Z" }).success,
    ).toBe(false);
    expect(
      jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), deadline: batchJob.createdAt }).success,
    ).toBe(false);
  });

  it("rejects notBefore > deadline but accepts notBefore between createdAt and deadline", () => {
    expect(
      jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), notBefore: "2026-08-07T02:00:00.000Z" }).success,
    ).toBe(false);
    expect(
      jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), notBefore: "2026-08-07T00:30:00.000Z" }).success,
    ).toBe(true);
  });

  it("rejects duplicate requiredCapabilities or secretHandles", () => {
    expect(
      jobEnvelopeV1Schema.safeParse({
        ...clone(batchJob),
        requiredCapabilities: ["workload.batch", "workload.batch"],
      }).success,
    ).toBe(false);
    expect(
      jobEnvelopeV1Schema.safeParse({
        ...clone(batchJob),
        secretHandles: [
          { handleId: "00000000-0000-4000-8000-000000000016", materialization: { kind: "proxy" }, usePolicy: "fence_proxy" },
          { handleId: "00000000-0000-4000-8000-000000000016", materialization: { kind: "proxy" }, usePolicy: "fence_proxy" },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps secretHandles opaque — only UUID handle IDs, never plaintext", () => {
    expect(
      jobEnvelopeV1Schema.safeParse({
        ...clone(batchJob),
        secretHandles: [{ handleId: "not-a-handle", materialization: { kind: "proxy" }, usePolicy: "fence_proxy" }],
      }).success,
    ).toBe(false);
  });
});

describe("job envelope — provider-constraint reference", () => {
  it("requires providerConstraints inside targetRequirements", () => {
    const job = clone(batchJob);
    delete (job.placement.targetRequirements as Record<string, unknown>).providerConstraints;
    expect(jobEnvelopeV1Schema.safeParse(job).success).toBe(false);
  });
});

describe("job envelope — recursive forbidden-key containment", () => {
  for (const key of ["apiKey", "env", "cookie", "accessToken", "refreshToken"]) {
    it(`rejects a nested ${key} hidden inside an extension value`, () => {
      const job = {
        ...clone(batchJob),
        extensions: [{ namespace: "com.x.y", schemaVersion: 1, critical: false, value: { [key]: "leak" } }],
      };
      expect(jobEnvelopeV1Schema.safeParse(job).success).toBe(false);
    });
  }
});

describe("job envelope — bounded namespaced extensions", () => {
  it("accepts and preserves a safe non-critical extension", () => {
    const job = { ...clone(batchJob), extensions: [clone(okExtension)] };
    const result = jobEnvelopeV1Schema.safeParse(job);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.extensions[0]?.value).toEqual(okExtension.value);
    }
  });

  it("rejects an unknown critical extension (fails closed)", () => {
    const job = { ...clone(batchJob), extensions: [{ ...clone(okExtension), critical: true }] };
    expect(jobEnvelopeV1Schema.safeParse(job).success).toBe(false);
  });

  it("enforces the ≤16 extension count boundary", () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...clone(okExtension), namespace: `com.x.n${i}` }));
    expect(jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), extensions: make(16) }).success).toBe(true);
    expect(jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), extensions: make(17) }).success).toBe(false);
  });

  it("rejects duplicate extension namespaces", () => {
    const dup = [clone(okExtension), clone(okExtension)];
    expect(jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), extensions: dup }).success).toBe(false);
  });

  it("enforces the namespace shape and 100-byte boundary", () => {
    const ns = (namespace: string) => ({ ...clone(batchJob), extensions: [{ ...clone(okExtension), namespace }] });
    expect(jobEnvelopeV1Schema.safeParse(ns(`com.${"a".repeat(96)}`)).success).toBe(true); // 100 bytes
    expect(jobEnvelopeV1Schema.safeParse(ns(`com.${"a".repeat(97)}`)).success).toBe(false); // 101 bytes
    expect(jobEnvelopeV1Schema.safeParse(ns("NotReverseDNS")).success).toBe(false);
    expect(jobEnvelopeV1Schema.safeParse(ns("UPPER.CASE")).success).toBe(false);
  });

  it("enforces the schemaVersion 1..1,000,000 boundary", () => {
    const sv = (schemaVersion: number) => ({ ...clone(batchJob), extensions: [{ ...clone(okExtension), schemaVersion }] });
    expect(jobEnvelopeV1Schema.safeParse(sv(1)).success).toBe(true);
    expect(jobEnvelopeV1Schema.safeParse(sv(1_000_000)).success).toBe(true);
    expect(jobEnvelopeV1Schema.safeParse(sv(0)).success).toBe(false);
    expect(jobEnvelopeV1Schema.safeParse(sv(1_000_001)).success).toBe(false);
  });

  it("enforces the canonical value byte budget (16,384 bytes) after UTF-8 encoding", () => {
    const val = (chars: number) => ({
      ...clone(batchJob),
      extensions: [{ ...clone(okExtension), value: "x".repeat(chars) }],
    });
    // Canonical of a bare string is `"` + content + `"` => content + 2 bytes.
    expect(jobEnvelopeV1Schema.safeParse(val(16_382)).success).toBe(true); // 16,384 bytes
    expect(jobEnvelopeV1Schema.safeParse(val(16_383)).success).toBe(false); // 16,385 bytes
  });

  it("enforces the combined ≤65,536-byte extension budget", () => {
    const spread = (chars: number) =>
      Array.from({ length: 5 }, (_, i) => ({
        ...clone(okExtension),
        namespace: `com.x.b${i}`,
        value: "y".repeat(chars),
      }));
    // 5 × (13,000 + 2) = 65,010 bytes ≤ budget; each value ≤ 16,384.
    expect(jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), extensions: spread(13_000) }).success).toBe(true);
    // 5 × (13,200 + 2) = 66,010 bytes > 65,536; each value still ≤ 16,384.
    expect(jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), extensions: spread(13_200) }).success).toBe(false);
  });

  it("enforces the value container depth boundary (≤8 levels)", () => {
    const nest = (depth: number): unknown => (depth <= 0 ? 1 : { k: nest(depth - 1) });
    const depthJob = (depth: number) => ({ ...clone(batchJob), extensions: [{ ...clone(okExtension), value: nest(depth) }] });
    expect(jobEnvelopeV1Schema.safeParse(depthJob(8)).success).toBe(true);
    expect(jobEnvelopeV1Schema.safeParse(depthJob(9)).success).toBe(false);
  });

  it("enforces the value array-item boundary (≤128 items)", () => {
    const arr = (n: number) => ({ ...clone(batchJob), extensions: [{ ...clone(okExtension), value: { list: Array.from({ length: n }, () => 1) } }] });
    expect(jobEnvelopeV1Schema.safeParse(arr(128)).success).toBe(true);
    expect(jobEnvelopeV1Schema.safeParse(arr(129)).success).toBe(false);
  });

  it("enforces the value object-key boundary (≤64 keys)", () => {
    const obj = (n: number) => {
      const value: Record<string, number> = {};
      for (let i = 0; i < n; i += 1) value[`k${i}`] = i;
      return { ...clone(batchJob), extensions: [{ ...clone(okExtension), value }] };
    };
    expect(jobEnvelopeV1Schema.safeParse(obj(64)).success).toBe(true);
    expect(jobEnvelopeV1Schema.safeParse(obj(65)).success).toBe(false);
  });

  it("enforces the value key-byte boundary (≤100 UTF-8 bytes per key)", () => {
    const keyed = (len: number) => ({ ...clone(batchJob), extensions: [{ ...clone(okExtension), value: { ["a".repeat(len)]: 1 } }] });
    expect(jobEnvelopeV1Schema.safeParse(keyed(100)).success).toBe(true);
    expect(jobEnvelopeV1Schema.safeParse(keyed(101)).success).toBe(false);
  });
});

describe("extension values fail closed on out-of-subset canonical values (E1-F004)", () => {
  // Values the frozen E0/RFC-8785 subset REJECTS: floats, unsafe integers, and
  // lone/broken UTF-16 surrogates. A fail-open sizer would let them bypass the
  // byte budget at a strict security-critical envelope (and miscount unsafe ints).
  const outOfSubset: Array<readonly [string, unknown]> = [
    ["float 1.5", 1.5],
    ["unsafe integer 2^53", 9007199254740992],
    ["lone high surrogate", "\uD800"],
    ["broken low surrogate", "\uDC00"],
    ["nested float", { rate: 0.25 }],
    ["array with an unsafe integer", [9007199254740992]],
  ];

  const jobWithValue = (value: unknown) => ({
    ...clone(batchJob),
    extensions: [{ ...clone(okExtension), value }],
  });
  const offerWithValue = (value: unknown) => ({ ...clone(leaseOffer), job: jobWithValue(value) });

  for (const [label, value] of outOfSubset) {
    it(`rejects ${label} in a job extension value`, () => {
      const result = jobEnvelopeV1Schema.safeParse(jobWithValue(value));
      expect(result.success).toBe(false);
      if (!result.success) {
        // The failing issue points at the offending extension value.
        expect(
          result.error.issues.some((issue) => issue.path.join(".").startsWith("extensions.0.value")),
        ).toBe(true);
      }
    });

    it(`rejects ${label} in a lease-offer nested job extension value`, () => {
      expect(leaseOfferV1Schema.safeParse(offerWithValue(value)).success).toBe(false);
    });
  }

  it("still accepts a valid in-subset extension value (regression)", () => {
    const inSubset = { n: 42, s: "ok", b: true, list: [1, 2, 3], nested: { deep: -0 } };
    expect(jobEnvelopeV1Schema.safeParse(jobWithValue(inSubset)).success).toBe(true);
    expect(leaseOfferV1Schema.safeParse(offerWithValue({ n: 42 })).success).toBe(true);
  });
});

describe("placement compatibility is an explicit matrix (never ordinal)", () => {
  it("exposes the exact closed matrix", () => {
    expect(Object.keys(PLACEMENT_MATRIX).sort()).toEqual(
      ["managed_cloud", "organization_dedicated", "owner_desktop"].sort(),
    );
    expect(PLACEMENT_MATRIX.managed_cloud.targetScope).toBe("platform");
    expect(PLACEMENT_MATRIX.managed_cloud.trustClass).toBe("shared_isolated");
    expect([...PLACEMENT_MATRIX.owner_desktop.credentials].sort()).toEqual(
      ["none", "owner_bound", "platform_brokered"].sort(),
    );
  });

  it("isTargetPlacementAllowed encodes the table row-by-row", () => {
    // Managed cloud: only shared_isolated + {none,platform_brokered} + transfer_allowed.
    expect(isTargetPlacementAllowed("managed_cloud", "shared_isolated", "platform_brokered", "transfer_allowed")).toBe(true);
    expect(isTargetPlacementAllowed("managed_cloud", "owner_local_trusted", "platform_brokered", "transfer_allowed")).toBe(false);
    expect(isTargetPlacementAllowed("managed_cloud", "shared_isolated", "owner_bound", "transfer_allowed")).toBe(false);
    expect(isTargetPlacementAllowed("managed_cloud", "shared_isolated", "platform_brokered", "owner_device_only")).toBe(false);
    // Owner desktop: owner_local_trusted + owner_bound + owner_device_only allowed.
    expect(isTargetPlacementAllowed("owner_desktop", "owner_local_trusted", "owner_bound", "owner_device_only")).toBe(true);
    // Organization dedicated: organization_isolated + organization_brokered + organization_target_only.
    expect(isTargetPlacementAllowed("organization_dedicated", "organization_isolated", "organization_brokered", "organization_target_only")).toBe(true);
  });

  it("accepts the coherent single-target placements", () => {
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(managedPlacement)).success).toBe(true);
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(ownerBoundPlacement)).success).toBe(true);
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(orgBrokeredPlacement)).success).toBe(true);
  });

  it("rejects an invalid class/trust combination (managed_cloud + owner_local_trusted)", () => {
    const p = clone(managedPlacement);
    p.targetRequirements.allowedTrustClasses = ["owner_local_trusted"];
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(p)).success).toBe(false);
  });

  it("rejects owner_bound credentials without an owner_desktop requirement", () => {
    const p = clone(managedPlacement);
    p.targetRequirements.credentialKind = "owner_bound";
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(p)).success).toBe(false);
  });

  it("rejects owner_device_only / owner_bound without a non-null owner", () => {
    const p = clone(ownerBoundPlacement);
    p.targetRequirements.requiredOwnerPrincipalId = null;
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(p)).success).toBe(false);
  });

  it("rejects organization_brokered targeting anything but organization_dedicated", () => {
    const p = clone(orgBrokeredPlacement);
    p.targetRequirements.allowedTargetClasses = ["managed_cloud"];
    p.targetRequirements.allowedTrustClasses = ["shared_isolated"];
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(p)).success).toBe(false);
  });

  it("rejects unknown placement enum values", () => {
    const p = clone(managedPlacement);
    (p.targetRequirements as Record<string, unknown>).credentialKind = "mystery_cred";
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(p)).success).toBe(false);
  });

  it("rejects duplicate target/trust classes", () => {
    const p = clone(managedPlacement);
    p.targetRequirements.allowedTargetClasses = ["managed_cloud", "managed_cloud"];
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(p)).success).toBe(false);
  });
});

describe("placement fallback rules", () => {
  it("rejects forbidden fallback with a non-empty order", () => {
    const p = clone(managedPlacement);
    p.targetRequirements.fallback = { mode: "forbidden", orderedTargetClasses: ["managed_cloud"] };
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(p)).success).toBe(false);
  });

  it("rejects ordered fallback classes outside the allowed set", () => {
    const p = clone(batchJob).placement;
    p.targetRequirements.fallback = { mode: "ordered_explicit", orderedTargetClasses: ["organization_dedicated"] };
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(p)).success).toBe(false);
  });

  it("rejects ordered_explicit with a non-transfer credential/locality", () => {
    const p = clone(ownerBoundPlacement);
    // owner_bound + owner_device_only cannot use ordered_explicit multi-target fallback.
    p.targetRequirements.fallback = { mode: "ordered_explicit", orderedTargetClasses: ["owner_desktop"] };
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(p)).success).toBe(false);
  });

  it("rejects duplicate ordered fallback classes", () => {
    const p = clone(batchJob).placement;
    p.targetRequirements.fallback = {
      mode: "ordered_explicit",
      orderedTargetClasses: ["owner_desktop", "owner_desktop"],
    };
    expect(jobEnvelopeV1Schema.safeParse(withPlacement(p)).success).toBe(false);
  });
});

describe("workspace base revision format", () => {
  it("rejects a git_sha1 revision that is not 40 lowercase hex", () => {
    const job = clone(batchJob);
    job.workspace!.base.revision = "z".repeat(40);
    expect(jobEnvelopeV1Schema.safeParse(job).success).toBe(false);
  });

  it("accepts a null workspace", () => {
    expect(jobEnvelopeV1Schema.safeParse({ ...clone(batchJob), workspace: null }).success).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Lease messages (strict domain payloads; PRT-007 nests them in operation envelopes).
// -----------------------------------------------------------------------------

const leaseIdentity = {
  protocolVersion: 1,
  workerId: "00000000-0000-4000-8000-000000000050",
  jobId: batchJob.jobId,
  attempt: 1,
  leaseId: "00000000-0000-4000-8000-000000000051",
  fenceToken: "g".repeat(43),
};

const leaseOffer = {
  protocolVersion: 1,
  workerId: leaseIdentity.workerId,
  leaseId: leaseIdentity.leaseId,
  fenceToken: leaseIdentity.fenceToken,
  ackDeadline: "2026-08-07T00:05:00.000Z",
  expiresAt: "2026-08-07T00:10:00.000Z",
  job: clone(batchJob),
  extensions: [],
};

const leaseAck = { ...leaseIdentity, ackedAt: "2026-08-07T00:04:00.000Z", extensions: [] };
const leaseRenewRequest = { ...leaseIdentity, observedAt: "2026-08-07T00:08:00.000Z", extensions: [] };
const leaseRenewResponse = {
  ...leaseIdentity,
  expiresAt: "2026-08-07T00:20:00.000Z",
  cancelRequested: false,
  cancelReason: null,
  extensions: [],
};

describe("lease messages", () => {
  it("parses a valid lease offer with a nested job", () => {
    expect(leaseOfferV1Schema.safeParse(clone(leaseOffer)).success).toBe(true);
  });

  it("rejects a lease offer whose ackDeadline >= expiresAt", () => {
    expect(
      leaseOfferV1Schema.safeParse({ ...clone(leaseOffer), ackDeadline: leaseOffer.expiresAt }).success,
    ).toBe(false);
    expect(
      leaseOfferV1Schema.safeParse({ ...clone(leaseOffer), ackDeadline: "2026-08-07T00:11:00.000Z" }).success,
    ).toBe(false);
  });

  it("parses valid ack / renew-request / renew-response with the same identity shape", () => {
    expect(leaseAckV1Schema.safeParse(clone(leaseAck)).success).toBe(true);
    expect(leaseRenewRequestV1Schema.safeParse(clone(leaseRenewRequest)).success).toBe(true);
    expect(leaseRenewResponseV1Schema.safeParse(clone(leaseRenewResponse)).success).toBe(true);
  });

  it("carries a server-selected expiresAt and durable cancellation state in the renew response", () => {
    const cancelled = { ...clone(leaseRenewResponse), cancelRequested: true, cancelReason: "budget_exhausted" };
    expect(leaseRenewResponseV1Schema.safeParse(cancelled).success).toBe(true);
  });

  it("rejects forbidden credential keys in lease messages", () => {
    expect(leaseAckV1Schema.safeParse({ ...clone(leaseAck), authorization: "Bearer x" }).success).toBe(false);
    expect(
      leaseRenewRequestV1Schema.safeParse({ ...clone(leaseRenewRequest), accessToken: "x" }).success,
    ).toBe(false);
  });

  it("rejects a malformed identity (bad fence token) across lease messages", () => {
    expect(leaseAckV1Schema.safeParse({ ...clone(leaseAck), fenceToken: "short" }).success).toBe(false);
    expect(leaseRenewRequestV1Schema.safeParse({ ...clone(leaseRenewRequest), attempt: 0 }).success).toBe(false);
  });
});
