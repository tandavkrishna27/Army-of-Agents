import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeploymentExposure, DeploymentMode } from "@armyofagents/shared";

export type InstallProfile =
  | "local_single_user"
  | "remote_single_tenant"
  | "hosted_multi_tenant";
export type NetworkLocation = "local" | "remote";
export type TrustBoundary = "single_user" | "single_tenant" | "multi_tenant";
export type ExecutionOwnership = "aoa_hosted" | "tenant_hosted" | "user_hosted";
export type SubscriptionMode = "device_code" | "paste_code" | "none";

export interface CliAuthTopology {
  platform: NodeJS.Platform;
  installProfile: InstallProfile;
  networkLocation: NetworkLocation;
  trustBoundary: TrustBoundary;
  executionOwnership: ExecutionOwnership;
  source: "operator" | "safe_default";
}

export interface ProviderSubscriptionCapability {
  provider: "openai" | "anthropic";
  mode: SubscriptionMode;
  enabled: boolean;
  browserSafeRemotely: boolean;
  reason: string | null;
  cliInstalled?: boolean;
  cliVersion?: string | null;
  cliVersionSupported?: boolean;
}

const PROFILES: Record<
  InstallProfile,
  Pick<CliAuthTopology, "networkLocation" | "trustBoundary" | "executionOwnership">
> = {
  local_single_user: {
    networkLocation: "local",
    trustBoundary: "single_user",
    executionOwnership: "user_hosted",
  },
  remote_single_tenant: {
    networkLocation: "remote",
    trustBoundary: "single_tenant",
    executionOwnership: "tenant_hosted",
  },
  hosted_multi_tenant: {
    networkLocation: "remote",
    trustBoundary: "multi_tenant",
    executionOwnership: "aoa_hosted",
  },
};

function parseEnum<T extends string>(name: string, raw: string | undefined, values: readonly T[]): T | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim() as T;
  if (!values.includes(value)) {
    throw new Error(`${name}="${raw}" is invalid; expected one of: ${values.join(", ")}`);
  }
  return value;
}

export function resolveCliAuthTopology(args: {
  env?: NodeJS.ProcessEnv;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  platform?: NodeJS.Platform;
}): CliAuthTopology {
  const env = args.env ?? process.env;
  const explicitProfile = parseEnum("AOA_INSTALL_PROFILE", env.AOA_INSTALL_PROFILE, [
    "local_single_user",
    "remote_single_tenant",
    "hosted_multi_tenant",
  ] as const);
  const installProfile: InstallProfile =
    explicitProfile ??
    (args.deploymentMode === "local_trusted" && args.deploymentExposure === "private"
      ? "local_single_user"
      : "hosted_multi_tenant");
  const profile = PROFILES[installProfile];
  const networkLocation =
    parseEnum("AOA_NETWORK_LOCATION", env.AOA_NETWORK_LOCATION, ["local", "remote"] as const) ??
    profile.networkLocation;
  const trustBoundary =
    parseEnum("AOA_TRUST_BOUNDARY", env.AOA_TRUST_BOUNDARY, [
      "single_user",
      "single_tenant",
      "multi_tenant",
    ] as const) ?? profile.trustBoundary;
  const executionOwnership =
    parseEnum("AOA_EXECUTION_OWNERSHIP", env.AOA_EXECUTION_OWNERSHIP, [
      "aoa_hosted",
      "tenant_hosted",
      "user_hosted",
    ] as const) ?? profile.executionOwnership;

  if (
    networkLocation !== profile.networkLocation ||
    trustBoundary !== profile.trustBoundary ||
    executionOwnership !== profile.executionOwnership
  ) {
    throw new Error(
      `CLI authentication topology conflicts with AOA_INSTALL_PROFILE=${installProfile}. ` +
        `Choose a matching install profile or remove the axis overrides.`,
    );
  }

  return {
    platform: args.platform ?? process.platform,
    installProfile,
    networkLocation,
    trustBoundary,
    executionOwnership,
    source: explicitProfile ? "operator" : "safe_default",
  };
}

function enabledFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  return /^(1|true|yes)$/i.test(env[name]?.trim() ?? "");
}

export function providerSubscriptionCapability(
  provider: "openai" | "anthropic",
  topology: CliAuthTopology,
  env: NodeJS.ProcessEnv = process.env,
): ProviderSubscriptionCapability {
  const mode: SubscriptionMode = provider === "openai" ? "device_code" : "paste_code";
  if (topology.trustBoundary === "multi_tenant") {
    return {
      provider,
      mode,
      enabled: false,
      browserSafeRemotely: true,
      reason:
        "Subscription sign-in is disabled on shared hosted installations. Use a company API key or a dedicated execution target.",
    };
  }
  const flag = provider === "openai" ? "AOA_CODEX_DEVICE_AUTH" : "AOA_CLAUDE_PASTE_AUTH";
  if (topology.networkLocation === "remote" && !enabledFlag(env, flag)) {
    return {
      provider,
      mode,
      enabled: false,
      browserSafeRemotely: true,
      reason: `Subscription sign-in requires the operator to enable ${flag} on this dedicated installation.`,
    };
  }
  return { provider, mode, enabled: true, browserSafeRemotely: true, reason: null };
}

function opaqueSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export interface ScopedCliAuthHomeArgs {
  env?: NodeJS.ProcessEnv;
  executionTargetId?: string | null;
  companyId: string;
  userId: string;
  provider: "openai" | "anthropic";
}

function resolveAoaHome(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.AOA_HOME?.trim() || path.join(os.homedir(), ".aoa"));
}

export function resolveScopedCliAuthHome(args: ScopedCliAuthHomeArgs): string {
  const env = args.env ?? process.env;
  const root = resolveAoaHome(env);
  return path.join(
    root,
    "execution-targets",
    opaqueSegment(args.executionTargetId?.trim() || "control-plane"),
    "auth",
    opaqueSegment(args.companyId),
    opaqueSegment(args.userId),
    args.provider,
  );
}

function readDirectoryWithoutSymlink(candidate: string, recursive = false): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(candidate, { recursive, mode: 0o700 });
    stat = fs.lstatSync(candidate);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Scoped CLI auth path is not a regular directory: ${candidate}`);
  }
  return stat;
}

/**
 * Prepare the exact company/user/provider auth home before a provider CLI starts.
 *
 * A recursive mkdir follows pre-existing symlink components. Agent workloads run
 * on the same host, so accepting one here could redirect provider-native OAuth
 * files outside the derived scope. Walk one component at a time with lstat, then
 * compare real paths to prove the completed directory is the exact descendant
 * derived from AOA_HOME. This is path hardening, not a same-UID security boundary.
 */
export function prepareScopedCliAuthHome(args: ScopedCliAuthHomeArgs): string {
  const env = args.env ?? process.env;
  const root = resolveAoaHome(env);
  const authHome = resolveScopedCliAuthHome({ ...args, env });
  const relative = path.relative(root, authHome);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Scoped CLI auth home escapes the configured AOA data root");
  }

  // Parents above the configured root are operator-owned; create them when an
  // operator selects a new nested AOA_HOME, then reject if AOA_HOME itself is a
  // symlink. Every derived component below it is created non-recursively.
  readDirectoryWithoutSymlink(root, true);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    readDirectoryWithoutSymlink(current);
  }

  const realRoot = fs.realpathSync(root);
  const realHome = fs.realpathSync(authHome);
  const expectedRealHome = path.join(realRoot, ...segments);
  if (
    realHome !== expectedRealHome ||
    !realHome.startsWith(`${realRoot}${path.sep}`)
  ) {
    throw new Error("Scoped CLI auth home does not match its derived AOA path");
  }
  fs.chmodSync(authHome, 0o700);
  return authHome;
}

export function scopedCliAuthEnv(
  env: NodeJS.ProcessEnv,
  authHome: string,
  provider: "openai" | "anthropic",
): NodeJS.ProcessEnv {
  const executionHome = path.dirname(authHome);
  return {
    ...env,
    HOME: executionHome,
    ...(provider === "openai"
      ? { CODEX_HOME: authHome }
      : { CLAUDE_CONFIG_DIR: authHome }),
  };
}

const PROVIDER_HOSTS: Record<"openai" | "anthropic", readonly string[]> = {
  openai: ["auth.openai.com", "chatgpt.com"],
  anthropic: ["claude.ai", "claude.com", "anthropic.com"],
};

export function assertProviderLoginUrl(provider: "openai" | "anthropic", raw: string): string {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();
  const allowed = PROVIDER_HOSTS[provider].some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
  if (url.protocol !== "https:" || !allowed || url.username || url.password) {
    throw new Error("provider-login-url-rejected");
  }
  return url.toString();
}

const execFile = promisify(nodeExecFile);

export async function detectProviderCli(
  provider: "openai" | "anthropic",
  run: (command: string, args: string[]) => Promise<{ stdout: string; stderr?: string }> = async (
    command,
    args,
  ) => execFile(command, args, { timeout: 5_000 }),
): Promise<{ cliInstalled: boolean; cliVersion: string | null; cliVersionSupported: boolean }> {
  const command = provider === "openai" ? "codex" : "claude";
  try {
    const result = await run(command, ["--version"]);
    const version = /\b(\d+\.\d+\.\d+)\b/.exec(`${result.stdout} ${result.stderr ?? ""}`)?.[1] ?? null;
    const supported =
      version !== null &&
      (provider === "openai" ? /^0\.145\.\d+$/.test(version) : /^2\.1\.\d+$/.test(version));
    return { cliInstalled: true, cliVersion: version, cliVersionSupported: supported };
  } catch {
    return { cliInstalled: false, cliVersion: null, cliVersionSupported: false };
  }
}
