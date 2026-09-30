import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import {
  canonicalizeJsonV1,
} from "@armyofagents/worker-protocol";

const moduleUrl = new URL("../services/job-lease-eligibility.ts", import.meta.url);
const source = existsSync(moduleUrl) ? readFileSync(moduleUrl, "utf8") : "";
const frozenV1Url = new URL(
  "../../../tests/fixtures/worker-protocol-consumers/v1/dist/index.js",
  import.meta.url,
);
const frozenConformanceUrl = new URL(
  "../../../docs/contracts/worker-protocol/v1/conformance.json",
  import.meta.url,
);

interface EligibilityModule {
  LEASE_STATIC_ELIGIBILITY_VERSION: number;
  LEASE_CANONICALIZER_VERSION: number;
  LEASE_ALGORITHM_VERSION: number;
  LEASE_MATCHER_VERSION: number;
  LEASE_PLACEMENT_NORMALIZER_VERSION: number;
  LEASE_WORKLOAD_VOCABULARY_VERSION: number;
  NEUTRAL_LEASE_MATCHER_CAPACITY: Record<string, number>;
  logicalWorkerStaticMatcherProfileHash(hello: Record<string, unknown>): string;
  buildLeaseStaticContextInput(sources: Record<string, unknown>): Record<string, unknown>;
  leaseStaticContextHash(input: Record<string, unknown>): string;
  evaluateStaticLeaseEligibility(input: {
    target: Record<string, unknown>;
    verifiedProviderConstraints: unknown;
    worker: Record<string, unknown>;
    requirements: Record<string, unknown>;
  }): { eligible: boolean; reasonCode: "static_requirements_mismatch" | null };
}

const leaseStaticContextInputKeys = [
  "organizationId",
  "logicalWorkerId",
  "logicalWorkerScope",
  "logicalWorkerOwnerUserId",
  "logicalWorkerTargetAuthorityKey",
  "logicalWorkerDeviceGeneration",
  "logicalWorkerDeviceThumbprint",
  "logicalWorkerProfileHash",
  "logicalWorkerStaticMatcherProfileHash",
  "physicalAuthorityWorkerId",
  "physicalAuthorityWorkerDeviceGeneration",
  "physicalAuthorityWorkerProfileHash",
  "targetId",
  "targetScope",
  "targetOwnerUserId",
  "targetAuthorityKey",
  "targetDeviceGeneration",
  "targetRegisteredProfileHash",
  "targetProviderConstraintHash",
] as const;

type LeaseStaticContextContractModule = "production" | "exact-mock" | "any-mock";

function compileLeaseStaticContextTypeContract(
  moduleVariant: LeaseStaticContextContractModule = "production",
): string[] {
  const virtualPath = ts.sys.resolvePath(fileURLToPath(new URL(
    "../services/job-lease-eligibility.type-contract.ts",
    import.meta.url,
  ))).replace(/\\/g, "/");
  const modulePath = ts.sys.resolvePath(fileURLToPath(new URL(
    "../services/job-lease-eligibility.ts",
    import.meta.url,
  ))).replace(/\\/g, "/");
  const canonicalHostPath = (path: string): string =>
    ts.sys.resolvePath(path).replace(/\\/g, "/").toLowerCase();
  const canonicalVirtualPath = canonicalHostPath(virtualPath);
  const canonicalModulePath = canonicalHostPath(modulePath);
  const isVirtualPath = (path: string): boolean => canonicalHostPath(path) === canonicalVirtualPath;
  const isModulePath = (path: string): boolean => canonicalHostPath(path) === canonicalModulePath;
  const virtualSource = `
    import {
      buildLeaseStaticContextInput,
      type LeaseStaticContextInput,
      type LeaseStaticContextSources,
    } from "./job-lease-eligibility.js";
    import type { WorkerHelloV1 } from "@armyofagents/worker-protocol";

    type Equal<Left, Right> =
      (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2)
        ? (<T>() => T extends Right ? 1 : 2) extends (<T>() => T extends Left ? 1 : 2)
          ? true
          : false
        : false;
    type Assert<Condition extends true> = Condition;
    type ExactInputKeys =
      | "organizationId"
      | "logicalWorkerId"
      | "logicalWorkerScope"
      | "logicalWorkerOwnerUserId"
      | "logicalWorkerTargetAuthorityKey"
      | "logicalWorkerDeviceGeneration"
      | "logicalWorkerDeviceThumbprint"
      | "logicalWorkerProfileHash"
      | "logicalWorkerStaticMatcherProfileHash"
      | "physicalAuthorityWorkerId"
      | "physicalAuthorityWorkerDeviceGeneration"
      | "physicalAuthorityWorkerProfileHash"
      | "targetId"
      | "targetScope"
      | "targetOwnerUserId"
      | "targetAuthorityKey"
      | "targetDeviceGeneration"
      | "targetRegisteredProfileHash"
      | "targetProviderConstraintHash";
    type _ExactInputKeys = Assert<Equal<keyof LeaseStaticContextInput, ExactInputKeys>>;
    type _ExactBuilderParameters = Assert<Equal<
      Parameters<typeof buildLeaseStaticContextInput>,
      [LeaseStaticContextSources]
    >>;
    type _ExactBuilderReturn = Assert<Equal<
      ReturnType<typeof buildLeaseStaticContextInput>,
      LeaseStaticContextInput
    >>;
    type IsRequiredString<Key extends keyof LeaseStaticContextInput> =
      undefined extends LeaseStaticContextInput[Key] ? false
        : null extends LeaseStaticContextInput[Key] ? false
          : LeaseStaticContextInput[Key] extends string ? true : false;
    type IsRequiredNumber<Key extends keyof LeaseStaticContextInput> =
      Equal<LeaseStaticContextInput[Key], number>;
    type IsNullableString<Key extends keyof LeaseStaticContextInput> =
      Equal<LeaseStaticContextInput[Key], string | null>;
    type IsNullableNumber<Key extends keyof LeaseStaticContextInput> =
      Equal<LeaseStaticContextInput[Key], number | null>;
    type _OrganizationId = Assert<IsRequiredString<"organizationId">>;
    type _LogicalWorkerId = Assert<IsRequiredString<"logicalWorkerId">>;
    type _LogicalWorkerScope = Assert<IsRequiredString<"logicalWorkerScope">>;
    type _LogicalWorkerOwnerUserId = Assert<IsNullableString<"logicalWorkerOwnerUserId">>;
    type _LogicalWorkerTargetAuthorityKey = Assert<IsRequiredString<"logicalWorkerTargetAuthorityKey">>;
    type _LogicalWorkerDeviceGeneration = Assert<IsRequiredNumber<"logicalWorkerDeviceGeneration">>;
    type _LogicalWorkerDeviceThumbprint = Assert<IsRequiredString<"logicalWorkerDeviceThumbprint">>;
    type _LogicalWorkerProfileHash = Assert<IsRequiredString<"logicalWorkerProfileHash">>;
    type _LogicalWorkerStaticMatcherProfileHash = Assert<IsRequiredString<"logicalWorkerStaticMatcherProfileHash">>;
    type _PhysicalAuthorityWorkerId = Assert<IsNullableString<"physicalAuthorityWorkerId">>;
    type _PhysicalAuthorityWorkerDeviceGeneration = Assert<IsNullableNumber<"physicalAuthorityWorkerDeviceGeneration">>;
    type _PhysicalAuthorityWorkerProfileHash = Assert<IsNullableString<"physicalAuthorityWorkerProfileHash">>;
    type _TargetId = Assert<IsRequiredString<"targetId">>;
    type _TargetScope = Assert<IsRequiredString<"targetScope">>;
    type _TargetOwnerUserId = Assert<IsNullableString<"targetOwnerUserId">>;
    type _TargetAuthorityKey = Assert<IsRequiredString<"targetAuthorityKey">>;
    type _TargetDeviceGeneration = Assert<IsRequiredNumber<"targetDeviceGeneration">>;
    type _TargetRegisteredProfileHash = Assert<IsRequiredString<"targetRegisteredProfileHash">>;
    type _TargetProviderConstraintHash = Assert<IsRequiredString<"targetProviderConstraintHash">>;

    const parsedWorkerHello = {} as WorkerHelloV1;
    const logicalWorker = {
      id: "logical",
      scope: "organization" as const,
      ownerUserId: null,
      targetAuthorityKey: "platform",
      deviceGeneration: 101,
      deviceThumbprint: "thumbprint",
      profileHash: "logical-profile",
    };
    const platformTarget = {
      id: "target",
      scope: "platform" as const,
      ownerUserId: null,
      targetAuthorityKey: "platform",
      deviceGeneration: 303,
      registeredProfileHash: "target-profile",
      providerConstraintHash: "provider-profile",
    };
    const physicalAuthorityWorker = {
      id: "physical",
      deviceGeneration: 202,
      profileHash: "physical-profile",
    };
    const platform: LeaseStaticContextSources = {
      organizationId: "organization",
      parsedWorkerHello,
      logicalWorker,
      currentTarget: platformTarget,
      physicalAuthorityWorker,
    };
    const projected: LeaseStaticContextInput = buildLeaseStaticContextInput(platform);

    const organization: LeaseStaticContextSources = {
      ...platform,
      currentTarget: { ...platformTarget, scope: "organization" as const },
      physicalAuthorityWorker: null,
    };
    const owner: LeaseStaticContextSources = {
      ...platform,
      currentTarget: { ...platformTarget, scope: "owner" as const },
      physicalAuthorityWorker: null,
    };
    // These direct calls prevent a permissive any-to-any implementation from
    // satisfying the named source/input aliases while accepting invalid inputs.
    // @ts-expect-error platform scope requires a physical authority snapshot
    buildLeaseStaticContextInput({ ...platform, currentTarget: platformTarget, physicalAuthorityWorker: null });
    // @ts-expect-error non-platform scopes forbid a physical authority snapshot
    buildLeaseStaticContextInput({ ...platform, currentTarget: { ...platformTarget, scope: "organization" as const }, physicalAuthorityWorker });
    // @ts-expect-error a platform physical authority snapshot is an exact triple
    buildLeaseStaticContextInput({ ...platform, currentTarget: platformTarget, physicalAuthorityWorker: { id: "physical", deviceGeneration: 202 } });
    // @ts-expect-error version constants are implementation-owned
    buildLeaseStaticContextInput({ ...platform, certificateVersion: 99 });
    // @ts-expect-error version constants are implementation-owned
    buildLeaseStaticContextInput({ ...platform, canonicalizerVersion: 99 });
    // @ts-expect-error version constants are implementation-owned
    buildLeaseStaticContextInput({ ...platform, leasingAlgorithmVersion: 99 });
    // @ts-expect-error version constants are implementation-owned
    buildLeaseStaticContextInput({ ...platform, matcherVersion: 99 });
    // @ts-expect-error version constants are implementation-owned
    buildLeaseStaticContextInput({ ...platform, placementNormalizerVersion: 99 });
    // @ts-expect-error version constants are implementation-owned
    buildLeaseStaticContextInput({ ...platform, workloadVocabularyVersion: 99 });
    void organization;
    void owner;
    void projected;

    // @ts-expect-error platform scope requires the complete physical snapshot
    const platformWithoutPhysical: LeaseStaticContextSources = { ...platform, physicalAuthorityWorker: null };
    // @ts-expect-error non-platform scopes forbid a physical snapshot
    const organizationWithPhysical: LeaseStaticContextSources = { ...platform, currentTarget: { ...platformTarget, scope: "organization" as const } };
    const partialPhysical = { id: "physical", deviceGeneration: 202 };
    // @ts-expect-error the physical triple is all-or-none
    const platformWithPartialPhysical: LeaseStaticContextSources = { ...platform, physicalAuthorityWorker: partialPhysical };
    // @ts-expect-error callers cannot inject certificateVersion into sources
    const sourceWithCertificateVersion: LeaseStaticContextSources = { ...platform, certificateVersion: 99 };
    // @ts-expect-error callers cannot inject canonicalizerVersion into sources
    const sourceWithCanonicalizerVersion: LeaseStaticContextSources = { ...platform, canonicalizerVersion: 99 };
    // @ts-expect-error callers cannot inject leasingAlgorithmVersion into sources
    const sourceWithLeasingVersion: LeaseStaticContextSources = { ...platform, leasingAlgorithmVersion: 99 };
    // @ts-expect-error callers cannot inject matcherVersion into sources
    const sourceWithMatcherVersion: LeaseStaticContextSources = { ...platform, matcherVersion: 99 };
    // @ts-expect-error callers cannot inject placementNormalizerVersion into sources
    const sourceWithPlacementVersion: LeaseStaticContextSources = { ...platform, placementNormalizerVersion: 99 };
    // @ts-expect-error callers cannot inject workloadVocabularyVersion into sources
    const sourceWithWorkloadVersion: LeaseStaticContextSources = { ...platform, workloadVocabularyVersion: 99 };
    // @ts-expect-error callers cannot inject version fields into projected input
    const inputWithVersion: LeaseStaticContextInput = { ...projected, certificateVersion: 99 };
    void platformWithoutPhysical;
    void organizationWithPhysical;
    void platformWithPartialPhysical;
    void sourceWithCertificateVersion;
    void sourceWithCanonicalizerVersion;
    void sourceWithLeasingVersion;
    void sourceWithMatcherVersion;
    void sourceWithPlacementVersion;
    void sourceWithWorkloadVersion;
    void inputWithVersion;
  `;
  const exactMockSource = `
    import type { WorkerHelloV1 } from "@armyofagents/worker-protocol";

    type LogicalWorkerSource = {
      id: string;
      scope: "organization" | "owner";
      ownerUserId: string | null;
      targetAuthorityKey: string;
      deviceGeneration: number;
      deviceThumbprint: string;
      profileHash: string;
    };
    type TargetSource = {
      id: string;
      ownerUserId: string | null;
      targetAuthorityKey: string;
      deviceGeneration: number;
      registeredProfileHash: string;
      providerConstraintHash: string;
    };
    type CommonSources = {
      organizationId: string;
      parsedWorkerHello: WorkerHelloV1;
      logicalWorker: LogicalWorkerSource;
    };
    export type LeaseStaticContextSources = CommonSources & (
      | {
          currentTarget: TargetSource & { scope: "platform" };
          physicalAuthorityWorker: { id: string; deviceGeneration: number; profileHash: string };
        }
      | {
          currentTarget: TargetSource & { scope: "organization" | "owner" };
          physicalAuthorityWorker: null;
        }
    );
    export type LeaseStaticContextInput = {
      organizationId: string;
      logicalWorkerId: string;
      logicalWorkerScope: string;
      logicalWorkerOwnerUserId: string | null;
      logicalWorkerTargetAuthorityKey: string;
      logicalWorkerDeviceGeneration: number;
      logicalWorkerDeviceThumbprint: string;
      logicalWorkerProfileHash: string;
      logicalWorkerStaticMatcherProfileHash: string;
      physicalAuthorityWorkerId: string | null;
      physicalAuthorityWorkerDeviceGeneration: number | null;
      physicalAuthorityWorkerProfileHash: string | null;
      targetId: string;
      targetScope: string;
      targetOwnerUserId: string | null;
      targetAuthorityKey: string;
      targetDeviceGeneration: number;
      targetRegisteredProfileHash: string;
      targetProviderConstraintHash: string;
    };
    export declare function buildLeaseStaticContextInput(
      sources: LeaseStaticContextSources,
    ): LeaseStaticContextInput;
  `;
  const anyMockSource = `
    export type LeaseStaticContextSources = any;
    export type LeaseStaticContextInput = any;
    export declare function buildLeaseStaticContextInput(sources: any): any;
  `;
  const mockSource = moduleVariant === "exact-mock" ? exactMockSource : anyMockSource;
  const useMockModule = moduleVariant !== "production";
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    // The compiled contract source uses NO node globals/types, so it must not pull in
    // ambient @types/node. Forcing `types: ["node"]` made the in-memory compiler host
    // resolve @types/node, which fails on a fresh Linux CI checkout ("Cannot find type
    // definition file for 'node'") — a spurious diagnostic unrelated to the type
    // contract under test. `types: []` keeps the probe self-contained on every platform.
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => isVirtualPath(path) ||
    (useMockModule && isModulePath(path)) || originalFileExists(path);
  host.readFile = (path) => isVirtualPath(path)
    ? virtualSource
    : useMockModule && isModulePath(path)
      ? mockSource
      : originalReadFile(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    isVirtualPath(path)
      ? ts.createSourceFile(path, virtualSource, languageVersion, true)
      : useMockModule && isModulePath(path)
        ? ts.createSourceFile(path, mockSource, languageVersion, true)
      : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: [virtualPath], options, host });
  if (!program.getSourceFiles().some((sourceFile) => isVirtualPath(sourceFile.fileName))) {
    return ["virtual type-contract source was not loaded"];
  }
  if (useMockModule && !program.getSourceFiles().some((sourceFile) => isModulePath(sourceFile.fileName))) {
    return [`${moduleVariant} source was not loaded`];
  }
  return ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => !diagnostic.file || isVirtualPath(diagnostic.file.fileName) ||
      (useMockModule && isModulePath(diagnostic.file.fileName)))
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (!diagnostic.file || diagnostic.start === undefined) return message;
      const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${location.line + 1}:${location.character + 1} ${message}`;
    });
}

function staticContextSources(input: {
  targetScope?: "platform" | "organization" | "owner";
  logicalGeneration?: number;
  physicalGeneration?: number;
  targetGeneration?: number;
  physicalAuthorityWorker?: Record<string, unknown> | null;
} = {}): Record<string, unknown> {
  const targetScope = input.targetScope ?? "platform";
  const physicalAuthorityWorker = input.physicalAuthorityWorker === undefined
    ? targetScope === "platform"
      ? {
          id: "e3200000-0000-4000-8000-000000000004",
          deviceGeneration: input.physicalGeneration ?? 202,
          profileHash: "5".repeat(64),
        }
      : null
    : input.physicalAuthorityWorker;
  return {
    organizationId: "e3200000-0000-4000-8000-000000000003",
    parsedWorkerHello: {
      ...hello(),
      deviceGeneration: 101,
    },
    logicalWorker: {
      id: "e3200000-0000-4000-8000-000000000001",
      scope: "organization",
      ownerUserId: null,
      targetAuthorityKey: targetScope === "platform"
        ? "platform"
        : `organization:e3200000-0000-4000-8000-000000000003`,
      deviceGeneration: input.logicalGeneration ?? 101,
      deviceThumbprint: "2".repeat(64),
      profileHash: "3".repeat(64),
    },
    currentTarget: {
      id: "e3200000-0000-4000-8000-000000000002",
      scope: targetScope,
      ownerUserId: targetScope === "owner" ? "owner-1" : null,
      targetAuthorityKey: targetScope === "platform"
        ? "platform"
        : `organization:e3200000-0000-4000-8000-000000000003`,
      deviceGeneration: input.targetGeneration ?? 303,
      registeredProfileHash: "6".repeat(64),
      providerConstraintHash: "7".repeat(64),
    },
    physicalAuthorityWorker,
  };
}

async function loadEligibility(): Promise<EligibilityModule | null> {
  expect.soft(existsSync(moduleUrl), "job-lease-eligibility.ts must exist").toBe(true);
  if (!existsSync(moduleUrl)) return null;
  const specifier = `../services/${"job-lease-eligibility"}.js`;
  return vi.importActual(specifier) as Promise<EligibilityModule>;
}

async function loadFrozenV1Matcher(): Promise<(
  target: unknown,
  verifiedProviderConstraints: unknown,
  worker: unknown,
  requirements: unknown,
) => boolean> {
  expect.soft(existsSync(frozenV1Url), "immutable E1 v1 consumer fixture must exist").toBe(true);
  const frozen = await loadFrozenV1Module();
  expect.soft(typeof frozen.workerSatisfiesRequirements).toBe("function");
  return frozen.workerSatisfiesRequirements as (
    target: unknown,
    verifiedProviderConstraints: unknown,
    worker: unknown,
    requirements: unknown,
  ) => boolean;
}

async function loadFrozenV1Module(): Promise<Record<string, any>> {
  expect.soft(existsSync(frozenV1Url), "immutable E1 v1 consumer fixture must exist").toBe(true);
  return vi.importActual<Record<string, any>>(frozenV1Url.href);
}

function hello(capacity: Record<string, number> = {
  batchSlots: 3,
  browserSessionSlots: 2,
  serviceSlots: 1,
  freeCpuMillis: 4_000,
  freeMemoryMiB: 8_192,
  freeDiskMiB: 16_384,
}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    workerId: "e3200000-0000-4000-8000-000000000001",
    targetId: "e3200000-0000-4000-8000-000000000002",
    deviceGeneration: 1,
    agentVersion: "job003-static-matcher",
    supportedProtocol: { min: 1, max: 2 },
    platform: { os: "linux", arch: "x64", runtime: "worker" },
    reportedCapabilities: ["workload.batch", "sandbox.process_isolated"],
    capacity,
    policyHash: "a".repeat(64),
  };
}

function context(): Record<string, unknown> {
  return {
    organizationId: "e3200000-0000-4000-8000-000000000003",
    logicalWorkerId: "e3200000-0000-4000-8000-000000000001",
    logicalWorkerScope: "organization",
    logicalWorkerOwnerUserId: null,
    logicalWorkerTargetAuthorityKey: "organization:e3200000-0000-4000-8000-000000000003",
    logicalWorkerDeviceGeneration: 1,
    logicalWorkerDeviceThumbprint: "b".repeat(64),
    logicalWorkerProfileHash: "c".repeat(64),
    logicalWorkerStaticMatcherProfileHash: "d".repeat(64),
    physicalAuthorityWorkerId: null,
    physicalAuthorityWorkerDeviceGeneration: null,
    physicalAuthorityWorkerProfileHash: null,
    targetId: "e3200000-0000-4000-8000-000000000002",
    targetScope: "organization",
    targetOwnerUserId: null,
    targetAuthorityKey: "organization:e3200000-0000-4000-8000-000000000003",
    targetDeviceGeneration: 1,
    targetRegisteredProfileHash: "e".repeat(64),
    targetProviderConstraintHash: "f".repeat(64),
  };
}

async function matcherPair(overrides: {
  target?: Record<string, unknown>;
  worker?: Record<string, unknown>;
  requirements?: Record<string, unknown>;
} = {}) {
  const frozen = await loadFrozenV1Module();
  const profile: Record<string, unknown> = {
    profileId: "job003-static",
    version: 1,
    digest: "0".repeat(64),
    maxContinuousRuntimeSeconds: 3600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 4000, memoryMiB: 8192, pids: 1024, diskMiB: 20480 },
    maxConcurrentOperations: 4,
    supportedOperations: ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup"],
    localityTags: ["transfer_allowed"],
    checkpointMode: "none",
    healthMode: "none",
  };
  profile.digest = createHash("sha256")
    .update(frozen.canonicalProviderConstraintProfileDigestInputV1(profile))
    .digest("hex");
  const reference = { profileId: profile.profileId, version: 1, digest: profile.digest };
  const target = {
    protocolVersion: 1,
    targetId: "e3200000-0000-4000-8000-000000000002",
    targetClass: "managed_cloud",
    scope: "platform",
    organizationId: null,
    ownerPrincipalId: null,
    trustCeiling: "shared_isolated",
    credentialCeiling: "platform_brokered",
    dataLocalityCeiling: "transfer_allowed",
    providerConstraints: reference,
    capabilityCeiling: ["workload.batch", "provider.lifecycle_v1", "sandbox.process_isolated"],
    deviceGeneration: 1,
    revokedAt: null,
    policyHash: "a".repeat(64),
    ...overrides.target,
  };
  const worker = {
    ...hello({
      batchSlots: 1,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 4000,
      freeMemoryMiB: 8192,
      freeDiskMiB: 20480,
    }),
    reportedCapabilities: ["workload.batch", "provider.lifecycle_v1", "sandbox.process_isolated"],
    policyHash: "a".repeat(64),
    ...overrides.worker,
  };
  const requirements = {
    protocol: { min: 1, max: 1 },
    capabilities: ["workload.batch", "provider.lifecycle_v1", "sandbox.process_isolated"],
    workloadType: "batch",
    targetRequirements: {
      allowedTargetClasses: ["managed_cloud"],
      allowedTrustClasses: ["shared_isolated"],
      requiredOwnerPrincipalId: null,
      credentialKind: "platform_brokered",
      dataLocality: "transfer_allowed",
      fallback: { mode: "forbidden", orderedTargetClasses: [] },
      providerConstraints: reference,
    },
    policyHash: "a".repeat(64),
    mustUnderstand: ["provider.lifecycle_v1"],
    ...overrides.requirements,
  };
  const verifiedProviderConstraints = await frozen.verifyAndBrandProviderConstraintProfileV1(
    profile,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  expect(verifiedProviderConstraints).not.toBeNull();
  return { target, worker, requirements, verifiedProviderConstraints };
}

describe("JOB-003 static-only lease eligibility", () => {
  it("self-validates the static-context type harness against exact and permissive mock modules", () => {
    expect.soft(
      compileLeaseStaticContextTypeContract("exact-mock"),
      "the intended exact source/input contract must satisfy every positive and negative compiler probe",
    ).toEqual([]);
    const permissiveDiagnostics = compileLeaseStaticContextTypeContract("any-mock");
    expect.soft(permissiveDiagnostics.length, "an any-to-any builder must fail the compiler harness")
      .toBeGreaterThan(0);
    expect.soft(permissiveDiagnostics.join("\n"))
      .toMatch(/Unused '@ts-expect-error' directive|does not satisfy the constraint 'true'/);
  });

  it("pins six explicit versions, the neutral capacity, and canonical SHA-256 hashing", async () => {
    const eligibility = await loadEligibility();
    if (!eligibility) return;
    expect.soft({
      certificate: eligibility.LEASE_STATIC_ELIGIBILITY_VERSION,
      canonicalizer: eligibility.LEASE_CANONICALIZER_VERSION,
      algorithm: eligibility.LEASE_ALGORITHM_VERSION,
      matcher: eligibility.LEASE_MATCHER_VERSION,
      placement: eligibility.LEASE_PLACEMENT_NORMALIZER_VERSION,
      vocabulary: eligibility.LEASE_WORKLOAD_VOCABULARY_VERSION,
    }).toEqual({ certificate: 1, canonicalizer: 1, algorithm: 1, matcher: 1, placement: 1, vocabulary: 1 });
    expect.soft(eligibility.NEUTRAL_LEASE_MATCHER_CAPACITY).toEqual({
      batchSlots: 1,
      browserSessionSlots: 1,
      serviceSlots: 1,
      freeCpuMillis: 0,
      freeMemoryMiB: 0,
      freeDiskMiB: 0,
    });
    expect.soft(source).toContain("canonicalizeJsonV1");
    expect.soft(source).not.toMatch(/JSON\.stringify\s*\(/);
    expect.soft(source).toContain("workerSatisfiesRequirements");
    expect.soft(source).toContain("static_requirements_mismatch");
  });

  it("projects the closed typed authority sources into exactly 19 independently proven facts", async () => {
    const eligibility = await loadEligibility();
    if (!eligibility) return;
    expect.soft(
      compileLeaseStaticContextTypeContract(),
      "the public source/input types must reject invalid scope pairs, partial physical facts, and version injection",
    ).toEqual([]);
    expect.soft(typeof eligibility.buildLeaseStaticContextInput).toBe("function");
    if (typeof eligibility.buildLeaseStaticContextInput !== "function") return;

    const sources = staticContextSources({
      logicalGeneration: 101,
      physicalGeneration: 202,
      targetGeneration: 303,
    });
    const projected = eligibility.buildLeaseStaticContextInput(sources);
    const parsedWorkerHello = sources.parsedWorkerHello as Record<string, unknown>;
    const independentlyNeutralizedHello = {
      ...parsedWorkerHello,
      capacity: {
        batchSlots: 1,
        browserSessionSlots: 1,
        serviceSlots: 1,
        freeCpuMillis: 0,
        freeMemoryMiB: 0,
        freeDiskMiB: 0,
      },
    };
    const expectedStaticMatcherHash = createHash("sha256")
      .update(canonicalizeJsonV1(independentlyNeutralizedHello))
      .digest("hex");
    const expectedInput = {
      organizationId: "e3200000-0000-4000-8000-000000000003",
      logicalWorkerId: "e3200000-0000-4000-8000-000000000001",
      logicalWorkerScope: "organization",
      logicalWorkerOwnerUserId: null,
      logicalWorkerTargetAuthorityKey: "platform",
      logicalWorkerDeviceGeneration: 101,
      logicalWorkerDeviceThumbprint: "2".repeat(64),
      logicalWorkerProfileHash: "3".repeat(64),
      logicalWorkerStaticMatcherProfileHash: expectedStaticMatcherHash,
      physicalAuthorityWorkerId: "e3200000-0000-4000-8000-000000000004",
      physicalAuthorityWorkerDeviceGeneration: 202,
      physicalAuthorityWorkerProfileHash: "5".repeat(64),
      targetId: "e3200000-0000-4000-8000-000000000002",
      targetScope: "platform",
      targetOwnerUserId: null,
      targetAuthorityKey: "platform",
      targetDeviceGeneration: 303,
      targetRegisteredProfileHash: "6".repeat(64),
      targetProviderConstraintHash: "7".repeat(64),
    };
    expect.soft(Object.keys(projected).sort()).toEqual([...leaseStaticContextInputKeys].sort());
    expect.soft(projected).toEqual(expectedInput);

    const expectedHash = createHash("sha256").update(canonicalizeJsonV1({
      certificateVersion: 1,
      canonicalizerVersion: 1,
      leasingAlgorithmVersion: 1,
      matcherVersion: 1,
      placementNormalizerVersion: 1,
      workloadVocabularyVersion: 1,
      ...expectedInput,
    })).digest("hex");
    expect.soft(eligibility.leaseStaticContextHash(projected)).toBe(expectedHash);

    const organizationInput = eligibility.buildLeaseStaticContextInput(staticContextSources({
      targetScope: "organization",
    }));
    expect.soft(organizationInput).toMatchObject({
      targetScope: "organization",
      targetOwnerUserId: null,
      physicalAuthorityWorkerId: null,
      physicalAuthorityWorkerDeviceGeneration: null,
      physicalAuthorityWorkerProfileHash: null,
    });
    const ownerInput = eligibility.buildLeaseStaticContextInput(staticContextSources({ targetScope: "owner" }));
    expect.soft(ownerInput).toMatchObject({
      targetScope: "owner",
      targetOwnerUserId: "owner-1",
      physicalAuthorityWorkerId: null,
      physicalAuthorityWorkerDeviceGeneration: null,
      physicalAuthorityWorkerProfileHash: null,
    });

    const generationCases = [
      {
        name: "logical",
        sources: staticContextSources({ logicalGeneration: 102, physicalGeneration: 202, targetGeneration: 303 }),
        changedKey: "logicalWorkerDeviceGeneration",
        expectedValue: 102,
      },
      {
        name: "physical",
        sources: staticContextSources({ logicalGeneration: 101, physicalGeneration: 203, targetGeneration: 303 }),
        changedKey: "physicalAuthorityWorkerDeviceGeneration",
        expectedValue: 203,
      },
      {
        name: "target",
        sources: staticContextSources({ logicalGeneration: 101, physicalGeneration: 202, targetGeneration: 304 }),
        changedKey: "targetDeviceGeneration",
        expectedValue: 304,
      },
    ] as const;
    for (const testCase of generationCases) {
      const changed = eligibility.buildLeaseStaticContextInput(testCase.sources);
      const changedKeys = leaseStaticContextInputKeys.filter((key) => changed[key] !== projected[key]);
      expect.soft(changedKeys, `${testCase.name}:one source maps to one fact`).toEqual([testCase.changedKey]);
      expect.soft(changed[testCase.changedKey], `${testCase.name}:distinct generation`).toBe(testCase.expectedValue);
      expect.soft(eligibility.leaseStaticContextHash(changed), `${testCase.name}:hash independence`)
        .not.toBe(expectedHash);
    }

    expect.soft(eligibility.buildLeaseStaticContextInput({
      ...sources,
      certificateVersion: 99,
      ignoredExtraSource: "must-not-project",
    })).toEqual(expectedInput);
  });

  it("fails closed at runtime for invalid scope discriminators, partial physical facts, and missing validated facts", async () => {
    const eligibility = await loadEligibility();
    if (!eligibility) return;
    expect.soft(typeof eligibility.buildLeaseStaticContextInput).toBe("function");
    if (typeof eligibility.buildLeaseStaticContextInput !== "function") return;

    const platform = staticContextSources();
    const invalid: Array<{ name: string; sources: Record<string, unknown> }> = [
      {
        name: "organization-with-physical",
        sources: {
          ...platform,
          currentTarget: {
            ...platform.currentTarget as Record<string, unknown>,
            scope: "organization",
          },
        },
      },
      {
        name: "owner-with-physical",
        sources: {
          ...platform,
          currentTarget: {
            ...platform.currentTarget as Record<string, unknown>,
            scope: "owner",
            ownerUserId: "owner-1",
          },
        },
      },
      {
        name: "owner-with-null-owner",
        sources: {
          ...staticContextSources({ targetScope: "owner" }),
          currentTarget: {
            ...(staticContextSources({ targetScope: "owner" }).currentTarget as Record<string, unknown>),
            ownerUserId: null,
          },
        },
      },
    ];
    const requiredPaths = [
      "organizationId",
      "parsedWorkerHello",
      "parsedWorkerHello.protocolVersion",
      "parsedWorkerHello.workerId",
      "parsedWorkerHello.targetId",
      "parsedWorkerHello.deviceGeneration",
      "parsedWorkerHello.agentVersion",
      "parsedWorkerHello.supportedProtocol",
      "parsedWorkerHello.supportedProtocol.min",
      "parsedWorkerHello.supportedProtocol.max",
      "parsedWorkerHello.platform",
      "parsedWorkerHello.platform.os",
      "parsedWorkerHello.platform.arch",
      "parsedWorkerHello.platform.runtime",
      "parsedWorkerHello.reportedCapabilities",
      "parsedWorkerHello.capacity",
      "parsedWorkerHello.capacity.batchSlots",
      "parsedWorkerHello.capacity.browserSessionSlots",
      "parsedWorkerHello.capacity.serviceSlots",
      "parsedWorkerHello.capacity.freeCpuMillis",
      "parsedWorkerHello.capacity.freeMemoryMiB",
      "parsedWorkerHello.capacity.freeDiskMiB",
      "parsedWorkerHello.policyHash",
      "logicalWorker",
      "logicalWorker.id",
      "logicalWorker.scope",
      "logicalWorker.ownerUserId",
      "logicalWorker.targetAuthorityKey",
      "logicalWorker.deviceGeneration",
      "logicalWorker.deviceThumbprint",
      "logicalWorker.profileHash",
      "physicalAuthorityWorker",
      "physicalAuthorityWorker.id",
      "physicalAuthorityWorker.deviceGeneration",
      "physicalAuthorityWorker.profileHash",
      "currentTarget",
      "currentTarget.id",
      "currentTarget.scope",
      "currentTarget.ownerUserId",
      "currentTarget.targetAuthorityKey",
      "currentTarget.deviceGeneration",
      "currentTarget.registeredProfileHash",
      "currentTarget.providerConstraintHash",
    ] as const;
    const nullablePaths = new Set(["logicalWorker.ownerUserId", "currentTarget.ownerUserId"]);
    const mutatePath = (path: string, mode: "missing" | "null"): Record<string, unknown> => {
      const copy = structuredClone(platform);
      const segments = path.split(".");
      let cursor: Record<string, unknown> = copy;
      for (const segment of segments.slice(0, -1)) {
        cursor = cursor[segment] as Record<string, unknown>;
      }
      const leaf = segments.at(-1)!;
      if (mode === "missing") delete cursor[leaf];
      else cursor[leaf] = null;
      return copy;
    };
    for (const path of requiredPaths) {
      invalid.push({ name: `missing-${path}`, sources: mutatePath(path, "missing") });
      if (!nullablePaths.has(path)) {
        invalid.push({ name: `null-${path}`, sources: mutatePath(path, "null") });
      }
    }
    for (const testCase of invalid) {
      let thrown: unknown;
      try {
        eligibility.buildLeaseStaticContextInput(testCase.sources);
      } catch (error) {
        thrown = error;
      }
      expect.soft(thrown, testCase.name).toMatchObject({ code: "internal_unavailable" });
    }
  });

  it("hashes every non-capacity matcher field but leaves capacity changes to dynamic gates", async () => {
    const eligibility = await loadEligibility();
    if (!eligibility) return;
    const baseline = hello();
    const baselineHash = eligibility.logicalWorkerStaticMatcherProfileHash(baseline);
    expect.soft(baselineHash).toMatch(/^[0-9a-f]{64}$/);

    const mutations: Array<[string, Record<string, unknown>]> = [
      ["protocolVersion", { ...baseline, protocolVersion: 2 }],
      ["workerId", { ...baseline, workerId: "e3200000-0000-4000-8000-000000000099" }],
      ["targetId", { ...baseline, targetId: "e3200000-0000-4000-8000-000000000098" }],
      ["deviceGeneration", { ...baseline, deviceGeneration: 2 }],
      ["agentVersion", { ...baseline, agentVersion: "changed" }],
      ["supportedProtocol.min", { ...baseline, supportedProtocol: { min: 2, max: 2 } }],
      ["supportedProtocol.max", { ...baseline, supportedProtocol: { min: 1, max: 3 } }],
      ["platform.os", { ...baseline, platform: { os: "windows", arch: "x64", runtime: "worker" } }],
      ["platform.arch", { ...baseline, platform: { os: "linux", arch: "arm64", runtime: "worker" } }],
      ["platform.runtime", { ...baseline, platform: { os: "linux", arch: "x64", runtime: "changed" } }],
      ["capabilities", { ...baseline, reportedCapabilities: ["workload.batch"] }],
      ["capability-order", { ...baseline, reportedCapabilities: [...baseline.reportedCapabilities as string[]].reverse() }],
      ["policy", { ...baseline, policyHash: "9".repeat(64) }],
    ];
    for (const [label, mutation] of mutations) {
      expect.soft(
        eligibility.logicalWorkerStaticMatcherProfileHash(mutation),
        label,
      ).not.toBe(baselineHash);
      expect.soft(
        createHash("sha256").update(JSON.stringify(mutation)).digest("hex"),
        `${label}:correctly rehashed enrollment snapshot`,
      ).not.toBe(createHash("sha256").update(JSON.stringify(baseline)).digest("hex"));
    }

    const baselineCapacity = baseline.capacity as Record<string, number>;
    for (const field of [
      "batchSlots", "browserSessionSlots", "serviceSlots",
      "freeCpuMillis", "freeMemoryMiB", "freeDiskMiB",
    ]) {
      const capacityOnly = {
        ...baseline,
        capacity: { ...baselineCapacity, [field]: baselineCapacity[field]! + 1 },
      };
      expect.soft(eligibility.logicalWorkerStaticMatcherProfileHash(capacityOnly), field).toBe(baselineHash);
    }

    const expectedNeutral = {
      ...baseline,
      capacity: eligibility.NEUTRAL_LEASE_MATCHER_CAPACITY,
    };
    const frozen = await loadFrozenV1Module();
    expect.soft(canonicalizeJsonV1(expectedNeutral)).toBe(frozen.canonicalizeJsonV1(expectedNeutral));
    const expectedHash = createHash("sha256")
      .update(frozen.canonicalizeJsonV1(expectedNeutral))
      .digest("hex");
    expect.soft(baselineHash).toBe(expectedHash);
  });

  it("binds every poll-invariant authority fact and all version values in one context hash", async () => {
    const eligibility = await loadEligibility();
    if (!eligibility) return;
    const baseline = context();
    const baselineHash = eligibility.leaseStaticContextHash(baseline);
    expect.soft(baselineHash).toMatch(/^[0-9a-f]{64}$/);
    const expectedCanonical = {
      certificateVersion: eligibility.LEASE_STATIC_ELIGIBILITY_VERSION,
      canonicalizerVersion: eligibility.LEASE_CANONICALIZER_VERSION,
      leasingAlgorithmVersion: eligibility.LEASE_ALGORITHM_VERSION,
      matcherVersion: eligibility.LEASE_MATCHER_VERSION,
      placementNormalizerVersion: eligibility.LEASE_PLACEMENT_NORMALIZER_VERSION,
      workloadVocabularyVersion: eligibility.LEASE_WORKLOAD_VOCABULARY_VERSION,
      ...baseline,
    };
    const frozen = await loadFrozenV1Module();
    expect.soft(Object.keys(expectedCanonical)).toHaveLength(25);
    expect.soft(baselineHash).toBe(createHash("sha256")
      .update(frozen.canonicalizeJsonV1(expectedCanonical))
      .digest("hex"));
    for (const key of Object.keys(baseline)) {
      const value = baseline[key];
      const changedValue = value === null ? "changed" : typeof value === "number" ? value + 1 : `${String(value)}-changed`;
      const changed = { ...baseline, [key]: changedValue };
      expect.soft(eligibility.leaseStaticContextHash(changed), key).not.toBe(baselineHash);
    }
    expect.soft(eligibility.leaseStaticContextHash({ ...baseline, ignoredExtraKey: "must-not-enter-hash" }))
      .toBe(baselineHash);
    expect.soft(source).toMatch(/certificateVersion[\s\S]*canonicalizerVersion[\s\S]*leasingAlgorithmVersion/);
    expect.soft(source).toMatch(/matcherVersion[\s\S]*placementNormalizerVersion[\s\S]*workloadVocabularyVersion/);
  });

  it("keeps dynamic capacity/live-count gates outside durable static-negative reasons", () => {
    expect.soft(source).not.toMatch(/reasonCode\s*:\s*["'](?:capacity|slots|provider_total|resource)/);
    expect.soft(source).not.toMatch(/static_context_hash[\s\S]{0,300}(?:liveLeases|freeCpuMillis|batchSlots)/);
    expect.soft(source).toMatch(/eligible[\s\S]*static_requirements_mismatch|static_requirements_mismatch[\s\S]*eligible/);
  });

  it("is bidirectionally equivalent to frozen matching after dynamic gates pass", async () => {
    const eligibility = await loadEligibility();
    if (!eligibility) return;
    const frozenWorkerSatisfiesRequirements = await loadFrozenV1Matcher();
    expect.soft(typeof eligibility.evaluateStaticLeaseEligibility).toBe("function");
    if (typeof eligibility.evaluateStaticLeaseEligibility !== "function") return;

    const baselinePair = await matcherPair();
    const providerMismatch = await matcherPair();
    providerMismatch.target.providerConstraints = {
      ...(providerMismatch.target.providerConstraints as Record<string, unknown>),
      digest: "9".repeat(64),
    };
    const targetClassMismatch = await matcherPair({
      requirements: {
        targetRequirements: {
          ...baselinePair.requirements.targetRequirements as Record<string, unknown>,
          allowedTargetClasses: ["organization_dedicated"],
        },
      },
    });
    const trustMismatch = await matcherPair({
      requirements: {
        targetRequirements: {
          ...baselinePair.requirements.targetRequirements as Record<string, unknown>,
          allowedTrustClasses: ["organization_isolated"],
        },
      },
    });
    const ownerMismatch = await matcherPair({
      target: {
        targetClass: "owner_desktop",
        scope: "owner",
        organizationId: "e3200000-0000-4000-8000-000000000003",
        ownerPrincipalId: "owner-principal-9",
        trustCeiling: "owner_local_trusted",
        credentialCeiling: "owner_bound",
        dataLocalityCeiling: "owner_device_only",
      },
      requirements: {
        targetRequirements: {
          ...baselinePair.requirements.targetRequirements as Record<string, unknown>,
          allowedTargetClasses: ["owner_desktop"],
          allowedTrustClasses: ["owner_local_trusted"],
          requiredOwnerPrincipalId: "someone-else",
          credentialKind: "owner_bound",
          dataLocality: "owner_device_only",
        },
      },
    });
    const credentialMismatch = await matcherPair({
      target: {
        targetClass: "organization_dedicated",
        scope: "organization",
        organizationId: "e3200000-0000-4000-8000-000000000003",
        trustCeiling: "organization_isolated",
        credentialCeiling: "platform_brokered",
        dataLocalityCeiling: "organization_target_only",
      },
      requirements: {
        targetRequirements: {
          ...baselinePair.requirements.targetRequirements as Record<string, unknown>,
          allowedTargetClasses: ["organization_dedicated"],
          allowedTrustClasses: ["organization_isolated"],
          credentialKind: "organization_brokered",
          dataLocality: "organization_target_only",
        },
      },
    });
    const localityMismatch = await matcherPair({
      target: {
        targetClass: "organization_dedicated",
        scope: "organization",
        organizationId: "e3200000-0000-4000-8000-000000000003",
        trustCeiling: "organization_isolated",
        credentialCeiling: "organization_brokered",
        dataLocalityCeiling: "transfer_allowed",
      },
      requirements: {
        targetRequirements: {
          ...baselinePair.requirements.targetRequirements as Record<string, unknown>,
          allowedTargetClasses: ["organization_dedicated"],
          allowedTrustClasses: ["organization_isolated"],
          credentialKind: "organization_brokered",
          dataLocality: "organization_target_only",
        },
      },
    });
    const requirementsProviderMismatch = await matcherPair({
      requirements: {
        targetRequirements: {
          ...baselinePair.requirements.targetRequirements as Record<string, unknown>,
          providerConstraints: {
            ...baselinePair.requirements.targetRequirements.providerConstraints as Record<string, unknown>,
            digest: "8".repeat(64),
          },
        },
      },
    });
    const cases = [
      { name: "coherent", pair: baselinePair, expected: true },
      { name: "target-id", pair: await matcherPair({ worker: { targetId: "e3200000-0000-4000-8000-000000000099" } }), expected: false },
      { name: "target-generation", pair: await matcherPair({ worker: { deviceGeneration: 2 } }), expected: false },
      { name: "revoked-target", pair: await matcherPair({ target: { revokedAt: "2026-08-11T00:00:00.000Z" } }), expected: false },
      { name: "provider-profile", pair: providerMismatch, expected: false },
      { name: "requirements-provider-profile", pair: requirementsProviderMismatch, expected: false },
      { name: "server-capability-ceiling", pair: await matcherPair({ target: { capabilityCeiling: ["workload.batch"] } }), expected: false },
      { name: "worker-capability-report", pair: await matcherPair({ worker: { reportedCapabilities: ["workload.batch"] } }), expected: false },
      { name: "unknown-must-understand", pair: await matcherPair({ requirements: { mustUnderstand: ["provider.unknownfuture_v9"] } }), expected: false },
      { name: "withheld-must-understand", pair: await matcherPair({
        target: { capabilityCeiling: ["workload.batch", "provider.lifecycle_v1", "sandbox.process_isolated"] },
        requirements: { mustUnderstand: ["secret.proxy"] },
      }), expected: false },
      { name: "requirements-policy", pair: await matcherPair({ requirements: { policyHash: "b".repeat(64) } }), expected: false },
      { name: "worker-policy", pair: await matcherPair({ worker: { policyHash: "b".repeat(64) } }), expected: false },
      { name: "protocol", pair: await matcherPair({ worker: { supportedProtocol: { min: 2, max: 2 } } }), expected: false },
      { name: "target-class", pair: targetClassMismatch, expected: false },
      { name: "target-trust", pair: trustMismatch, expected: false },
      { name: "credential-ceiling", pair: credentialMismatch, expected: false },
      { name: "data-locality", pair: localityMismatch, expected: false },
      { name: "owner-principal", pair: ownerMismatch, expected: false },
      { name: "workload-capability", pair: await matcherPair({ requirements: { workloadType: "service", capabilities: [] } }), expected: false },
    ];
    const dynamicallyAdmissibleCapacity = [
      { batchSlots: 1, browserSessionSlots: 0, serviceSlots: 0, freeCpuMillis: 1, freeMemoryMiB: 1, freeDiskMiB: 1 },
      { batchSlots: 3, browserSessionSlots: 2, serviceSlots: 1, freeCpuMillis: 4000, freeMemoryMiB: 8192, freeDiskMiB: 20480 },
    ];
    for (const testCase of cases) {
      const adapter = eligibility.evaluateStaticLeaseEligibility(testCase.pair);
      expect.soft(adapter.eligible, testCase.name).toBe(testCase.expected);
      expect.soft(adapter.reasonCode, testCase.name).toBe(testCase.expected ? null : "static_requirements_mismatch");
      for (const capacity of dynamicallyAdmissibleCapacity) {
        const frozen = frozenWorkerSatisfiesRequirements(
          testCase.pair.target as never,
          testCase.pair.verifiedProviderConstraints!,
          { ...testCase.pair.worker, capacity } as never,
          testCase.pair.requirements as never,
        );
        expect.soft(adapter.eligible, `${testCase.name}:${capacity.batchSlots}`).toBe(frozen);
      }
    }

    const dynamicOnly = await matcherPair({ worker: { capacity: {
      batchSlots: 0,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 999_999,
      freeMemoryMiB: 999_999,
      freeDiskMiB: 999_999,
    } } });
    expect.soft(frozenWorkerSatisfiesRequirements(
      dynamicOnly.target as never,
      dynamicOnly.verifiedProviderConstraints!,
      dynamicOnly.worker as never,
      dynamicOnly.requirements as never,
    )).toBe(false);
    expect.soft(eligibility.evaluateStaticLeaseEligibility(dynamicOnly).eligible).toBe(true);
  });

  it("runs every immutable target_worker_pair conformance case through frozen v1 and the adapter", async () => {
    const eligibility = await loadEligibility();
    if (!eligibility) return;
    const frozen = await vi.importActual<Record<string, any>>(frozenV1Url.href);
    const conformance = JSON.parse(readFileSync(frozenConformanceUrl, "utf8")) as {
      cases: Array<{ name: string; schema: string; valid: boolean; input: Record<string, unknown> }>;
    };
    const cases = conformance.cases.filter((entry) => entry.schema === "target_worker_pair");
    expect.soft(cases.length).toBeGreaterThan(0);
    for (const entry of cases) {
      const target = frozen.registeredTargetProfileV1Schema.parse(entry.input.registeredTarget);
      const provider = await frozen.verifyAndBrandProviderConstraintProfileV1(
        entry.input.providerProfile,
        async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"),
      );
      const worker = frozen.workerHelloV1Schema.parse(entry.input.worker);
      const requirements = frozen.jobCapabilityRequirementsSchema.parse(entry.input.requirements);
      expect.soft(provider, entry.name).not.toBeNull();
      if (!provider) continue;
      const frozenResult = frozen.workerSatisfiesRequirements(target, provider, worker, requirements);
      expect.soft(frozenResult, `${entry.name}:fixture disposition`).toBe(entry.valid);
      const adapter = eligibility.evaluateStaticLeaseEligibility({
        target,
        verifiedProviderConstraints: provider,
        worker,
        requirements,
      });
      expect.soft(adapter.eligible, `${entry.name}:adapter`).toBe(frozenResult);
      expect.soft(adapter.reasonCode, `${entry.name}:reason`)
        .toBe(frozenResult ? null : "static_requirements_mismatch");
    }
  });
});
