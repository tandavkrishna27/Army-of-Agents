// Pure mapping helpers for the EnvironmentsSection gVisor sandbox option +
// execution-target pin selector (Phase 5 / multi-tenant cloud, Task 12).
// No React/DOM dependency here — see environment-target-form.test.ts.

export interface GvisorFormFields {
  image: string;
  memory: string;
  cpus: string;
  pidsLimit: string;
}

/**
 * Maps the gVisor sub-form fields to the `environments.config` payload
 * `gvisorEnvironmentConfigSchema` (packages/shared/src/validators/execution-target.ts)
 * accepts. The hardening defaults here (capDropAll, noNewPrivileges,
 * readOnlyRootfs, user 1000:1000) mirror the server-side defaults in
 * `resolveGvisorSandboxTarget` (server/src/services/environment-runtime.ts,
 * Task 6) so the form previews the same posture the run will actually get.
 */
export function buildGvisorConfig(input: GvisorFormFields): Record<string, unknown> {
  return {
    provider: "gvisor",
    image: input.image.trim(),
    runtime: "runsc",
    network: "none",
    isolation: {
      user: "1000:1000",
      capDropAll: true,
      noNewPrivileges: true,
      readOnlyRootfs: true,
      memory: input.memory.trim() || "2g",
      cpus: input.cpus.trim() || "2",
      pidsLimit: Number(input.pidsLimit) || 512,
    },
  };
}

/**
 * Inverse of buildGvisorConfig: reads a persisted `environment.config`
 * (driver "sandbox", provider "gvisor") back into editable form field
 * strings. Used by EnvironmentsSection's readTarget() when opening the edit
 * dialog for an existing gVisor environment.
 */
export function parseGvisorConfig(config: Record<string, unknown> | null | undefined): GvisorFormFields {
  const cfg = config ?? {};
  const iso =
    cfg.isolation && typeof cfg.isolation === "object" && !Array.isArray(cfg.isolation)
      ? (cfg.isolation as Record<string, unknown>)
      : {};
  return {
    image: typeof cfg.image === "string" ? cfg.image : "",
    memory: typeof iso.memory === "string" ? iso.memory : "2g",
    cpus: typeof iso.cpus === "string" ? iso.cpus : "2",
    pidsLimit: typeof iso.pidsLimit === "number" ? String(iso.pidsLimit) : "512",
  };
}

/**
 * Normalizes the "Pin to execution target" `<select>` value. An empty
 * selection means "unpinned" — the run routes by credential kind via
 * `resolveExecutionTargetForRun` (server/src/services/execution-target-resolver.ts)
 * instead of a fixed target, so it must serialize to `null`, not `""`.
 */
export function normalizeExecutionTargetId(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
