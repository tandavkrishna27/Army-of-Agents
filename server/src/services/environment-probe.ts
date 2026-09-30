import type { EnvironmentDriver } from "@armyofagents/shared";
import {
  sandboxProviderRuntime,
  type SandboxProviderRuntime,
  type SandboxRuntimeProvider,
} from "./sandbox-provider-runtime.js";
import { runtimeProviderKeyService } from "./runtime-provider-keys.js";

export interface EnvironmentProbeCheck {
  name: string;
  status: "passed" | "failed";
  message: string;
}

export interface EnvironmentProbeResult {
  ok: boolean;
  driver: EnvironmentDriver;
  provider?: string;
  summary: string;
  checks?: EnvironmentProbeCheck[];
  metadata?: Record<string, unknown>;
}

export interface ProbeEnvironmentConfigInput {
  companyId: string;
  driver: EnvironmentDriver;
  config: Record<string, unknown>;
  providerRuntime?: SandboxProviderRuntime;
  sandboxProviders?: SandboxRuntimeProvider[];
  runtimeProviderKeys?: Pick<ReturnType<typeof runtimeProviderKeyService>, "resolveCredential">;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function getLocalProbeTargetPath(config: Record<string, unknown>): string | null {
  return readString(config.path) ?? readString(config.rootFolder);
}

function isDockerSandboxProvider(provider: string): boolean {
  return provider === "sandbox-docker" || provider === "docker" || provider === "local-docker";
}

function dockerSandboxProbe(config: Record<string, unknown>, provider: string): EnvironmentProbeResult {
  const image = readString(config.image);
  if (!image) {
    return {
      ok: false,
      driver: "sandbox",
      provider: "sandbox-docker",
      summary: "Docker sandbox configuration is invalid.",
      checks: [{
        name: "config.image",
        status: "failed",
        message: "Sandbox Docker environments require config.image.",
      }],
    };
  }

  return {
    ok: true,
    driver: "sandbox",
    provider: "sandbox-docker",
    summary: "Docker sandbox configuration is valid.",
    checks: [{
      name: "config.image",
      status: "passed",
      message: `Docker image ${image} is configured for ${provider}.`,
    }],
    metadata: {
      provider: "sandbox-docker",
      image,
    },
  };
}

export async function probeEnvironmentConfig(input: ProbeEnvironmentConfigInput): Promise<EnvironmentProbeResult> {
  if (input.driver === "local") {
    const targetPath = getLocalProbeTargetPath(input.config);
    if (!targetPath) {
      // Back-compat: local runtime with no path has nothing to verify.
      return {
        ok: true,
        driver: "local",
        summary: "Local environment configuration is valid.",
        checks: [{
          name: "config",
          status: "passed",
          message: "Local runtime does not require provider config.",
        }],
      };
    }
    // Blocking read/write verification (revA R13 — fixes the previously
    // non-fatal folder-create). Actually create the directory and round-trip a
    // probe file so onboarding cannot advance against an unwritable path.
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const nodePath = await import("node:path");
    try {
      await mkdir(targetPath, { recursive: true });
      const probeFile = nodePath.join(targetPath, `.aoa-write-probe-${Date.now()}`);
      await writeFile(probeFile, "ok");
      await rm(probeFile, { force: true });
      return {
        ok: true,
        driver: "local",
        summary: `Verified read/write access to ${targetPath}.`,
        checks: [{
          name: "config.path",
          status: "passed",
          message: `Directory is writable: ${targetPath}`,
        }],
      };
    } catch (err) {
      return {
        ok: false,
        driver: "local",
        summary: `Cannot write to ${targetPath}.`,
        checks: [{
          name: "config.path",
          status: "failed",
          message: err instanceof Error ? err.message : "Directory is not writable.",
        }],
      };
    }
  }

  if (input.driver !== "sandbox") {
    return {
      ok: false,
      driver: input.driver,
      summary: `Environment driver "${input.driver}" is not probeable yet.`,
      checks: [{
        name: "driver",
        status: "failed",
        message: "Only local and sandbox environments can be probed in this runtime.",
      }],
    };
  }

  const provider = readString(input.config.provider) ?? "sandbox-docker";
  if (isDockerSandboxProvider(provider)) {
    return dockerSandboxProbe(input.config, provider);
  }

  const runtime = input.providerRuntime ?? sandboxProviderRuntime({ providers: input.sandboxProviders });
  let providerConfig = input.config;
  if (provider === "e2b" && input.runtimeProviderKeys) {
    const resolvedApiKey = await input.runtimeProviderKeys.resolveCredential(
      input.companyId,
      "e2b",
      input.config,
      {
        consumerType: "system",
        consumerId: "runtime-provider-key:e2b",
        actorType: "system",
        configPath: "runtimeProviderKeys.e2b.default",
      },
    );
    providerConfig = { ...input.config, resolvedApiKey };
    delete providerConfig.apiKey;
  }
  let validation: Awaited<ReturnType<SandboxProviderRuntime["validateConfig"]>>;
  try {
    validation = await runtime.validateConfig(provider, providerConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      driver: "sandbox",
      provider,
      summary: `${provider} sandbox configuration is invalid.`,
      checks: [{
        name: "config",
        status: "failed",
        message,
      }],
    };
  }
  if (!validation.ok) {
    return {
      ok: false,
      driver: "sandbox",
      provider,
      summary: `${provider} sandbox configuration is invalid.`,
      checks: (validation.errors ?? [`Unsupported sandbox provider "${provider}"`]).map((message) => ({
        name: "config",
        status: "failed",
        message,
      })),
      metadata: validation.sanitizedConfig,
    };
  }

  let probe: Awaited<ReturnType<SandboxProviderRuntime["probe"]>>;
  try {
    probe = await runtime.probe(provider, {
      companyId: input.companyId,
      environmentId: "probe",
      config: providerConfig,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      driver: "sandbox",
      provider,
      summary: `${provider} sandbox probe failed.`,
      checks: [{
        name: "probe",
        status: "failed",
        message,
      }],
    };
  }

  return {
    ok: probe.ok,
    driver: "sandbox",
    provider,
    summary: probe.summary,
    ...(probe.errors ? {
      checks: probe.errors.map((message) => ({
        name: "probe",
        status: "failed" as const,
        message,
      })),
    } : {}),
    metadata: probe.metadata,
  };
}
