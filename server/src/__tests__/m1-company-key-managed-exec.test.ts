import { describe, expect, it, vi } from "vitest";
import type { Environment } from "@armyofagents/shared";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import {
  assertWithinPlatformExecutionLimit,
  PlatformExecutionLimitExceededError,
  type PlatformExecutionLimitCheck,
} from "../services/platform-execution-limit.js";

// M1 — company-key managed execution + platform-limit seam.
//
// Two invariants are pinned here at the MANAGED DISPATCH ENTRY (the E2B /
// provider-sandbox acquire branch of `createSandboxDockerEnvironmentDriver`):
//
//   (1) R1 — a run for company C resolves C's `runtime_provider_keys` E2B key when
//       present (BYO), else the platform `E2B_API_KEY` env fallback. This resolution
//       is ALREADY WIRED via `resolveRuntimeProviderConfig`; these tests pin it so a
//       regression that drops it turns the BYO case red.
//   (2) R2 — the org-grained platform execution-limit SEAM is invoked at the managed
//       dispatch entry with the run's company AND its resolved organization, so a
//       later (M4) enforcement author cannot miss the call site.

const COMPANY = "00000000-0000-0000-0000-000000000001";
const ORG = "00000000-0000-0000-0000-0000000000aa";

function makeE2bEnvironment(): Environment {
  return {
    id: "00000000-0000-0000-0000-000000000010",
    companyId: COMPANY,
    name: "Managed E2B",
    description: null,
    driver: "sandbox",
    status: "active",
    config: { provider: "e2b", credentialRef: "default", template: "base" },
    metadata: null,
    envVars: {},
    connectionTarget: null,
    target: null,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  };
}

/**
 * A minimal chainable drizzle-shaped stub. Every `select().from().where()...limit()`
 * resolves to `rows`. The only live consumers on the managed acquire path are the
 * (best-effort, try/catch-wrapped) org resolver and key-generation deriver — so a
 * single row shape suffices, and anything the key-gen path cannot parse is swallowed.
 */
function makeChainDb(rows: Array<Record<string, unknown>>) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.from = self;
  chain.where = self;
  chain.orderBy = self;
  chain.limit = async () => rows;
  return chain as never;
}

function makeE2bProvider(providerAcquireLease: ReturnType<typeof vi.fn>) {
  return [{
    provider: "e2b",
    acquireLease: providerAcquireLease,
    releaseLease: vi.fn(),
    execute: vi.fn(),
  }];
}

describe("M1 — per-company E2B key resolution on the managed execution path (R1)", () => {
  it("resolves the company's BYO E2B key at the managed dispatch entry when one is set", async () => {
    const providerAcquireLease = vi.fn(async () => ({
      providerLeaseId: "e2b-lease-1",
      metadata: { provider: "e2b", remoteCwd: "/workspace" },
    }));
    // A company WITH a runtime_provider_keys E2B row: resolveCredential returns its key.
    const runtimeProviderKeys = { resolveCredential: vi.fn(async () => "sk-company-byo") };

    const runtime = environmentRuntimeService(makeChainDb([{ organizationId: ORG }]), {
      environments: {
        acquireLease: vi.fn(async () => ({ id: "lease", provider: "e2b" })),
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
      sandboxProviders: makeE2bProvider(providerAcquireLease),
      runtimeProviderKeys: runtimeProviderKeys as never,
    } as never);

    await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: makeE2bEnvironment(),
      issueId: null,
      heartbeatRunId: "run-1",
      persistedExecutionWorkspace: null,
    });

    // Proof the BYO key was resolved for THIS company and handed to the provider —
    // this is the wiring that would go red if `resolveRuntimeProviderConfig` were
    // dropped from the managed acquire branch.
    expect(runtimeProviderKeys.resolveCredential).toHaveBeenCalledWith(
      COMPANY,
      "e2b",
      expect.objectContaining({ credentialRef: "default" }),
      expect.objectContaining({ configPath: "runtimeProviderKeys.e2b.default" }),
    );
    expect(providerAcquireLease).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ resolvedApiKey: "sk-company-byo" }) }),
    );
  });

  it("falls back to the platform key (config unchanged, no resolvedApiKey) when the company has no BYO key", async () => {
    const providerAcquireLease = vi.fn(async () => ({
      providerLeaseId: "e2b-lease-2",
      metadata: { provider: "e2b", remoteCwd: "/workspace" },
    }));
    // A company WITHOUT a runtime_provider_keys E2B row: resolveCredential throws
    // notFound(404) → config returned unchanged so the operator env E2B_API_KEY fires.
    const runtimeProviderKeys = {
      resolveCredential: vi.fn(async () => {
        throw Object.assign(new Error("No default e2b provider key configured."), { status: 404 });
      }),
    };

    const runtime = environmentRuntimeService(makeChainDb([{ organizationId: ORG }]), {
      environments: {
        acquireLease: vi.fn(async () => ({ id: "lease", provider: "e2b" })),
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
      sandboxProviders: makeE2bProvider(providerAcquireLease),
      runtimeProviderKeys: runtimeProviderKeys as never,
    } as never);

    await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: makeE2bEnvironment(),
      issueId: null,
      heartbeatRunId: "run-2",
      persistedExecutionWorkspace: null,
    });

    expect(runtimeProviderKeys.resolveCredential).toHaveBeenCalledTimes(1);
    // No BYO key was injected — the platform env fallback path is taken.
    const providerConfig = providerAcquireLease.mock.calls[0]?.[0]?.config as Record<string, unknown>;
    expect(providerConfig).not.toHaveProperty("resolvedApiKey");
  });
});

describe("M1 — platform execution-limit seam at the managed dispatch entry (R2)", () => {
  it("invokes the org-grained seam with the company and its resolved organization", async () => {
    const platformExecutionLimit = vi.fn<PlatformExecutionLimitCheck>(
      (input) => ({ allowed: true, organizationId: input.organizationId }),
    );
    const providerAcquireLease = vi.fn(async () => ({
      providerLeaseId: "e2b-lease-3",
      metadata: { provider: "e2b", remoteCwd: "/workspace" },
    }));

    const runtime = environmentRuntimeService(makeChainDb([{ organizationId: ORG }]), {
      environments: {
        acquireLease: vi.fn(async () => ({ id: "lease", provider: "e2b" })),
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
      sandboxProviders: makeE2bProvider(providerAcquireLease),
      runtimeProviderKeys: { resolveCredential: vi.fn(async () => "sk-company-byo") } as never,
      platformExecutionLimit,
    } as never);

    await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: makeE2bEnvironment(),
      issueId: null,
      heartbeatRunId: "run-3",
      persistedExecutionWorkspace: null,
    });

    // The seam is REACHED at the managed dispatch entry, org-grained (company + org).
    // Deleting the seam call site turns this red — a later enforcement author cannot
    // wire M4 into a call site that is not there.
    expect(platformExecutionLimit).toHaveBeenCalledTimes(1);
    expect(platformExecutionLimit).toHaveBeenCalledWith({ companyId: COMPANY, organizationId: ORG });
  });

  it("REJECTS the acquire when the seam denies — M4's deny path is enforced at the call site now (Codex P2)", async () => {
    // M1's default seam never returns { allowed: false }; this proves the ENFORCEMENT is
    // wired so M4 changes only the checker, not this call site. Removing the `if (!allowed)
    // throw` at the acquire branch turns this red — a discarded decision would let a denied
    // run acquire a sandbox anyway.
    const platformExecutionLimit = vi.fn<PlatformExecutionLimitCheck>(
      (input) => ({ allowed: false, organizationId: input.organizationId }),
    );
    const providerAcquireLease = vi.fn(async () => ({
      providerLeaseId: "e2b-lease-denied",
      metadata: { provider: "e2b", remoteCwd: "/workspace" },
    }));

    const runtime = environmentRuntimeService(makeChainDb([{ organizationId: ORG }]), {
      environments: {
        acquireLease: vi.fn(async () => ({ id: "lease", provider: "e2b" })),
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
      sandboxProviders: makeE2bProvider(providerAcquireLease),
      runtimeProviderKeys: { resolveCredential: vi.fn(async () => "sk-company-byo") } as never,
      platformExecutionLimit,
    } as never);

    await expect(
      runtime.acquireRunLease({
        companyId: COMPANY,
        environment: makeE2bEnvironment(),
        issueId: null,
        heartbeatRunId: "run-denied",
        persistedExecutionWorkspace: null,
      }),
    ).rejects.toThrow(PlatformExecutionLimitExceededError);

    // The sandbox was NOT acquired — the deny stopped it before provider acquisition.
    expect(providerAcquireLease).not.toHaveBeenCalled();
  });

  it("does NOT invoke the platform seam for a local (non-managed) run", async () => {
    const platformExecutionLimit = vi.fn<PlatformExecutionLimitCheck>(
      () => ({ allowed: true, organizationId: null }),
    );
    const runtime = environmentRuntimeService(makeChainDb([{ organizationId: ORG }]), {
      environments: {
        acquireLease: vi.fn(async () => ({ id: "lease", provider: "local" })),
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
      platformExecutionLimit,
    } as never);

    await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: {
        ...makeE2bEnvironment(),
        driver: "local",
        config: {},
      },
      issueId: null,
      heartbeatRunId: "run-4",
      persistedExecutionWorkspace: null,
    });

    // The seam gates MANAGED (provider-sandbox) dispatch only; a local run never
    // reaches it.
    expect(platformExecutionLimit).not.toHaveBeenCalled();
  });
});

describe("M1 — the seam is a no-op today (M4 enforces)", () => {
  it("always allows and echoes the org grain", () => {
    expect(assertWithinPlatformExecutionLimit({ companyId: COMPANY, organizationId: ORG }))
      .toEqual({ allowed: true, organizationId: ORG });
    expect(assertWithinPlatformExecutionLimit({ companyId: COMPANY, organizationId: null }))
      .toEqual({ allowed: true, organizationId: null });
  });
});
