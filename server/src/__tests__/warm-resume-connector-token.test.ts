import { describe, expect, it, vi } from "vitest";
import type { Environment, EnvironmentLease } from "@armyofagents/shared";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { buildConnectorSpecs } from "../services/mcp-connectors.js";

/**
 * U7.7 — OAuth connector token re-resolution on warm resume (SECURITY invariant).
 *
 * A paused E2B snapshot's env holds a STALE, bounded-TTL `AOA_MCP_*_TOKEN`
 * (minted per #317 OAuth broker). On warm RESUME the host must re-resolve +
 * re-inject a FRESH token; the stale one is never trusted (spec §7). Only the
 * minted short-lived access token ever crosses into the VM — the refresh token
 * / signed bundle stay host-side (spec §9). Getting this wrong lets a resumed
 * run execute with an expired (or worse, a wrong-tenant) token baked into the
 * snapshot.
 *
 * Grounding verdict (verified against the code, not the plan sketch): the
 * resume path routes through the SAME stage-in env rebuild as create. The org
 * run re-resolves connectors FRESH on EVERY run via `resolveAgentConnectors`
 * (heartbeat.ts, unconditional — not gated on warm-vs-create) → the pure
 * `buildConnectorSpecs`, keyed off the freshly-resolved `secretValue`; the
 * lease's `metadata.providerMetadata` is only ever the sandbox RECONNECT handle
 * (`leaseMetadata`), never the run env. So resume is already safe. U7.7 encodes
 * that as a guard and, as defense-in-depth, strips any baked env/token fields
 * off the RETURNED lease record so a stale token can never travel forward at
 * all — even for a (future) stage-in that naively seeded env from the resumed
 * snapshot's baked provider env.
 */

const COMPANY = "00000000-0000-0000-0000-000000000001";

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "00000000-0000-0000-0000-000000000010",
    companyId: COMPANY,
    name: "Sandbox",
    description: null,
    driver: "sandbox",
    status: "active",
    config: { provider: "e2b", template: "base" },
    metadata: null,
    envVars: {},
    connectionTarget: null,
    target: null,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

function makeLease(overrides: Partial<EnvironmentLease> = {}): EnvironmentLease {
  return {
    id: "00000000-0000-0000-0000-000000000020",
    companyId: COMPANY,
    environmentId: "00000000-0000-0000-0000-000000000010",
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: "00000000-0000-0000-0000-000000000030",
    agentId: null,
    status: "active",
    leasePolicy: "ephemeral",
    provider: "e2b",
    providerLeaseId: null,
    acquiredAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    lastUsedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    expiresAt: null,
    releasedAt: null,
    pausedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: { provider: "e2b" },
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

/**
 * Build a real `environmentRuntimeService` wired for the warm-RESUME path whose
 * paused (and reactivated) lease metadata carries `stalePausedMetadata` — the
 * baked-into-the-snapshot env an E2B pause would leave behind. The provider's
 * `resumeLease` reports the snapshot is live (`resumed:true`), so the driver
 * flips the paused row back to active and returns it — the exact seam U7.7
 * defends. `reactivatePausedLease` echoes the SAME stale metadata (a real
 * `UPDATE … RETURNING *` never touches the `metadata` column), so the strip is
 * the only thing that can keep the stale token off the returned record.
 */
function warmResumeRuntime(stalePausedMetadata: Record<string, unknown>) {
  const pausedLease = makeLease({
    id: "paused-1",
    provider: "e2b",
    providerLeaseId: "e2b-paused-1",
    status: "paused",
    leasePolicy: "reuse_by_agent",
    agentId: "a1",
    metadata: stalePausedMetadata,
  });
  const reactivatedLease = makeLease({
    id: "paused-1",
    provider: "e2b",
    providerLeaseId: "e2b-paused-1",
    status: "active",
    leasePolicy: "reuse_by_agent",
    agentId: "a1",
    pausedAt: null,
    // A real reactivate UPDATE returns the row with its metadata UNCHANGED.
    metadata: stalePausedMetadata,
  });

  const createSpy = vi.fn(); // provider.acquireLease — must NOT run on a live resume
  const dbAcquireSpy = vi.fn(); // env DB create — must NOT run on a live resume
  const resumeSpy = vi.fn(async () => ({
    resumed: true,
    providerLeaseId: "e2b-paused-1",
    metadata: { provider: "e2b" },
  }));
  const runtime = environmentRuntimeService({} as never, {
    environments: {
      acquireLease: dbAcquireSpy,
      releaseLease: vi.fn(),
      releaseLeasesForRun: vi.fn(),
      findResumablePausedLease: vi.fn(async () => pausedLease),
      reactivatePausedLease: vi.fn(async () => reactivatedLease),
      markLeasePaused: vi.fn(),
      listLiveAndPausedProviderLeasesForCompany: vi.fn(),
    },
    sandboxProviders: [
      { provider: "e2b", acquireLease: createSpy, releaseLease: vi.fn(), resumeLease: resumeSpy, execute: vi.fn() },
    ],
    runtimeProviderKeys: { resolveCredential: vi.fn(async () => "sk-e2b") } as never,
  } as never);

  const warmInput = {
    companyId: COMPANY,
    environment: makeEnvironment(),
    issueId: "i1",
    heartbeatRunId: "r2",
    persistedExecutionWorkspace: null,
    warmPreference: true,
    agentId: "a1",
  } as const;

  return { runtime, warmInput, createSpy, dbAcquireSpy, resumeSpy };
}

/**
 * Compose the REAL acquire (`environmentRuntimeService.acquireRunLease`, warm
 * resume) with the REAL stage-in env seam (`buildConnectorSpecs`, the pure half
 * of `resolveAgentConnectors`). The staged env is seeded from the resumed
 * lease's baked provider env — the realistic leak surface a naive stage-in
 * would read — then overlaid with the FRESHLY re-resolved connector token. The
 * fresh token models `resolveConnectorToken` minting a new short-lived access
 * token at resume-time stage-in (spec §7/§9). If the strip is missing, the
 * snapshot's baked env rides forward and its stale tokens leak into `staged.env`.
 */
async function acquireAndStageWarmResume(opts: { agentId: string; warmPreference: boolean }) {
  // The paused E2B snapshot's baked env: the notion token (which will be
  // refreshed at resume) PLUS a token for a connector that has since been
  // disabled — the fresh resolver will NOT re-emit the latter, so if the
  // snapshot's env leaks forward its stale value rides into the VM.
  const snapshotBakedEnv: Record<string, string> = {
    AOA_MCP_NOTION_TOKEN: "stale",
    AOA_MCP_DISABLED_TOKEN: "stale-disabled",
  };
  const stalePausedMetadata = {
    provider: "e2b",
    providerMetadata: { remoteCwd: "/workspace", reuseLease: true, env: snapshotBakedEnv },
  };

  const { runtime, warmInput } = warmResumeRuntime(stalePausedMetadata);
  const rec = await runtime.acquireRunLease({
    ...warmInput,
    warmPreference: opts.warmPreference,
    agentId: opts.agentId,
  });

  // ── STAGE-IN (real seam) ────────────────────────────────────────────────
  // A naive stage-in would seed env from the resumed lease's baked provider env;
  // the strip is what makes that `{}`.
  const bakedEnv = ((rec.lease.metadata as Record<string, unknown> | null)?.providerMetadata as
    | Record<string, unknown>
    | undefined)?.env as Record<string, string> | undefined;
  // The FRESH connector re-resolution at stage-in: `resolveAgentConnectors` →
  // `buildConnectorSpecs`, keyed off the freshly-minted `secretValue`.
  const { env: freshConnectorEnv } = buildConnectorSpecs([
    {
      serverName: "notion",
      transport: "http",
      url: "https://mcp.notion.com/mcp",
      command: null,
      args: [],
      headerTemplate: { Authorization: "Bearer ${TOKEN}" },
      envTemplate: {},
      secretValue: "fresh",
    },
  ]);
  const env: Record<string, string> = { ...(bakedEnv ?? {}), ...freshConnectorEnv };
  return { env, lease: rec.lease };
}

describe("U7.7 — warm resume re-resolves the connector token at stage-in", () => {
  it("re-resolves the connector token on warm resume — stale paused-env token is never reused", async () => {
    const staged = await acquireAndStageWarmResume({ agentId: "a1", warmPreference: true });
    // The FRESHLY re-resolved token wins.
    expect(staged.env.AOA_MCP_NOTION_TOKEN).toBe("fresh");
    // No stale token — from ANY connector — survives into the resumed run's env.
    expect(JSON.stringify(staged.env)).not.toContain("stale");
    expect(staged.env.AOA_MCP_DISABLED_TOKEN).toBeUndefined();
  });

  it("resume never carries env forward from the paused lease metadata", async () => {
    const stalePausedMetadata = {
      provider: "e2b",
      // A stale token baked at BOTH a top-level `metadata.env` and the nested
      // `metadata.providerMetadata.env` — both must be stripped.
      env: { AOA_MCP_NOTION_TOKEN: "stale" },
      providerMetadata: {
        remoteCwd: "/workspace",
        reuseLease: true,
        env: { AOA_MCP_NOTION_TOKEN: "stale" },
      },
    };
    const { runtime, warmInput, createSpy, dbAcquireSpy } = warmResumeRuntime(stalePausedMetadata);

    const rec = await runtime.acquireRunLease({ ...warmInput });

    const md = rec.lease.metadata as Record<string, unknown> | null;
    // The returned lease record exposes NO pre-baked env — stage-in (U5/U6)
    // rebuilds it every run.
    expect((md as { env?: unknown } | null)?.env).toBeUndefined();
    // …at BOTH levels.
    expect((md?.providerMetadata as { env?: unknown } | undefined)?.env).toBeUndefined();
    // The strip is surgical — provider identity + the sandbox reconnect handle
    // the resume needs are preserved.
    expect(rec.lease.provider).toBe("e2b");
    expect(rec.lease.providerLeaseId).toBe("e2b-paused-1");
    expect((md?.providerMetadata as { remoteCwd?: unknown } | undefined)?.remoteCwd).toBe("/workspace");
    expect((md?.providerMetadata as { reuseLease?: unknown } | undefined)?.reuseLease).toBe(true);
    // No stale token anywhere on the returned lease record.
    expect(JSON.stringify(rec.lease.metadata)).not.toContain("stale");
    // This WAS a resume (not a create-fresh), so the strip is on the resume return.
    expect(rec.lease.status).toBe("active");
    expect(rec.lease.leasePolicy).toBe("reuse_by_agent");
    expect(createSpy).not.toHaveBeenCalled();
    expect(dbAcquireSpy).not.toHaveBeenCalled();
  });
});
