// server/src/services/gvisor-sandbox-provider.ts
import type {
  SandboxRuntimeProvider,
  SandboxProviderAcquireInput,
  SandboxProviderReleaseInput,
  SandboxProviderExecuteInput,
} from "./sandbox-provider-runtime.js";

export interface GvisorPoolClient {
  acquire(input: SandboxProviderAcquireInput): Promise<{ providerLeaseId: string; expiresAt?: Date | null; metadata: Record<string, unknown> }>;
  release(input: SandboxProviderReleaseInput): Promise<{ cleanupStatus: "success" | "failed"; metadata?: Record<string, unknown> }>;
  run(input: SandboxProviderExecuteInput): Promise<{ exitCode: number | null; stdout: string; stderr: string; signal?: string | null; timedOut?: boolean }>;
}

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function createGvisorSandboxRuntimeProvider(
  options: { poolClient?: GvisorPoolClient } = {},
): SandboxRuntimeProvider {
  const pool = options.poolClient;
  function requirePool(): GvisorPoolClient {
    if (!pool) throw new Error("gVisor pool transport is not configured (no poolClient). Single-box beta uses the local sandbox-docker path instead.");
    return pool;
  }
  return {
    provider: "gvisor",
    async validateConfig(config) {
      const errors: string[] = [];
      if (!readString(config.image)) errors.push("gVisor environments require config.image.");
      if (config.transport === "pool" && !readString(config.poolEndpoint)) {
        errors.push("gVisor pool transport requires config.poolEndpoint.");
      }
      return { ok: errors.length === 0, provider: "gvisor", ...(errors.length ? { errors } : {}), sanitizedConfig: { provider: "gvisor", transport: config.transport ?? "local_docker", hasImage: Boolean(readString(config.image)) } };
    },
    async probe(input) {
      const v = await this.validateConfig!(input.config);
      return { ok: v.ok, provider: "gvisor", summary: v.ok ? "gVisor pool configuration is valid." : "gVisor pool configuration is invalid.", ...(v.errors ? { errors: v.errors } : {}) };
    },
    async acquireLease(input) {
      const lease = await requirePool().acquire(input);
      return { providerLeaseId: lease.providerLeaseId, expiresAt: lease.expiresAt ?? null, metadata: { provider: "gvisor", ...lease.metadata } };
    },
    async releaseLease(input) {
      return requirePool().release(input);
    },
    async execute(input) {
      const r = await requirePool().run(input);
      return { exitCode: r.exitCode, signal: r.signal ?? null, timedOut: r.timedOut ?? false, stdout: r.stdout, stderr: r.stderr };
    },
  };
}
