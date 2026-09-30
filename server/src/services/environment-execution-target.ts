import type { Environment, EnvironmentLease } from "@armyofagents/shared";
import {
  resolveAdapterExecutionTarget,
  type AdapterExecutionTarget,
  type AdapterProviderSandboxRunner,
} from "@armyofagents/adapter-utils";
import { resolveGvisorSandboxTarget } from "./environment-runtime.js";

export interface EnvironmentExecutionTargetInput {
  environment: Pick<Environment, "driver" | "target" | "config">;
  lease?: Pick<EnvironmentLease, "id" | "metadata" | "provider" | "providerLeaseId"> | null;
  adapterType: string;
  providerRunner?: AdapterProviderSandboxRunner | null;
  // Deployment-mode-aware gVisor hardening (P5 SSRF residual). True when the run
  // executes on SHARED multi-tenant infra: a tenant-authored gVisor environment config
  // must not weaken the sandbox on the path environments.config -> resolveGvisorSandboxTarget
  // -> resolveAdapterExecutionTarget -> buildDockerRunArgs. On self-hosted the config is
  // honored. Resolved by the orchestrator; fail-closed hardening when absent.
  multiTenant?: boolean;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isDockerSandboxProvider(value: unknown): boolean {
  const provider = readString(value);
  return !provider || provider === "sandbox-docker" || provider === "docker" || provider === "local-docker" || provider === "gvisor";
}

function resolveDockerSandboxTarget(
  environment: Pick<Environment, "config">,
  multiTenant: boolean,
): AdapterExecutionTarget | null {
  const config = readObject(environment.config);
  if (!isDockerSandboxProvider(config.provider)) return null;

  // gVisor uses the same single-box sandbox-docker transport but carries the
  // hardened, opt-in isolation profile (runsc runtime + cap-drop/read-only/tmpfs
  // + limits + egress `--network none` + conditional --add-host). Normalize via
  // the shared resolver so a founder who set only { provider:"gvisor", image }
  // still gets the full hardened default profile, and pass runtime/isolation/
  // allowHostGateway through to resolveAdapterExecutionTarget (and thence
  // buildDockerRunArgs). On shared infra multiTenant forces the hardened profile so a
  // tenant config cannot weaken it (SSRF residual). Non-gvisor docker providers stay
  // byte-identical below.
  if (readString(config.provider) === "gvisor") {
    const gvisor = resolveGvisorSandboxTarget(config, { multiTenant });
    // Belt-and-suspenders: resolveGvisorSandboxTarget already hardened for shared
    // infra, but thread multiTenant to the sink too so the choke point is uniform.
    return resolveAdapterExecutionTarget({
      type: "sandbox-docker",
      image: gvisor.image,
      workdir: gvisor.workdir,
      shell: config.shell,
      network: gvisor.network,
      remove: typeof config.remove === "boolean" ? config.remove : undefined,
      env: readObject(config.env),
      installCommand: readString(config.installCommand),
      runtime: gvisor.runtime,
      isolation: gvisor.isolation,
      allowHostGateway: gvisor.allowHostGateway,
    }, multiTenant);
  }

  const image = readString(config.image);
  if (!image) return null;

  // Non-gvisor docker sandbox: a tenant-authored environments.config could set
  // network:"host" / weak isolation, so harden at the sink on shared infra.
  return resolveAdapterExecutionTarget({
    type: "sandbox-docker",
    image,
    workdir: readString(config.workdir) ?? undefined,
    shell: config.shell,
    network: config.network,
    remove: typeof config.remove === "boolean" ? config.remove : undefined,
    env: readObject(config.env),
    installCommand: readString(config.installCommand),
  }, multiTenant);
}

function resolveProviderSandboxTarget(
  input: EnvironmentExecutionTargetInput,
): AdapterExecutionTarget | null {
  const provider = readString(input.lease?.provider) ?? readString(readObject(input.environment.config).provider);
  if (!provider || isDockerSandboxProvider(provider)) return null;
  const providerLeaseId = readString(input.lease?.providerLeaseId);
  if (!providerLeaseId || !input.providerRunner) return null;

  const metadata = readObject(input.lease?.metadata);
  const providerMetadata = readObject(metadata.providerMetadata);
  const config = readObject(input.environment.config);
  const remoteCwd = readString(providerMetadata.remoteCwd) ?? readString(config.remoteCwd) ?? "/workspace";
  const shellCommand = readString(providerMetadata.shellCommand) ?? readString(config.shellCommand) ?? readString(config.shell);

  return resolveAdapterExecutionTarget({
    type: "provider-sandbox",
    provider,
    providerLeaseId,
    remoteCwd,
    shell: shellCommand === "bash" ? "bash" : "sh",
    env: readObject(config.env),
    runner: input.providerRunner,
  });
}

export function resolveEnvironmentExecutionTarget(
  input: EnvironmentExecutionTargetInput,
): AdapterExecutionTarget | null {
  if (input.environment.target) {
    // environments.target is a raw, tenant-authorable AdapterExecutionTarget shape
    // and reaches buildDockerRunArgs unforced — harden at the sink on shared infra.
    // Fail-closed default: harden when the caller did not resolve the boundary.
    return resolveAdapterExecutionTarget(input.environment.target, input.multiTenant ?? true);
  }

  if (input.environment.driver === "local") {
    return { type: "local" };
  }

  if (input.environment.driver === "sandbox") {
    // Fail-closed default: harden when the caller did not resolve the trust boundary.
    return resolveDockerSandboxTarget(input.environment, input.multiTenant ?? true) ?? resolveProviderSandboxTarget(input);
  }

  return null;
}

export function resolveEnvironmentExecutionTargetConfigPatch(
  input: EnvironmentExecutionTargetInput,
): { executionTarget?: AdapterExecutionTarget } {
  const executionTarget = resolveEnvironmentExecutionTarget(input);
  return executionTarget ? { executionTarget } : {};
}
