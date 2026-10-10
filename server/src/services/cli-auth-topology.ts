import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
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

export function usesCanonicalLocalCliAuth(env: NodeJS.ProcessEnv): boolean {
  return (
    (env.AOA_DEPLOYMENT_MODE?.trim() || "local_trusted") === "local_trusted" &&
    env.AOA_INSTALL_PROFILE === "local_single_user"
  );
}

/** Resolve the one CLI home used by login, verification, credential binding, and agent runs. */
export function resolveProviderCliAuthHome(args: ScopedCliAuthHomeArgs): string {
  const env = args.env ?? process.env;
  if (usesCanonicalLocalCliAuth(env)) {
    const home = path.resolve(env.HOME?.trim() || os.homedir());
    return path.join(home, args.provider === "openai" ? ".codex" : ".claude");
  }
  return resolveScopedCliAuthHome({ ...args, env });
}

/** Backward-compatible name for the Commander login call site. */
export function resolveCommanderLoginAuthHome(args: ScopedCliAuthHomeArgs): string {
  return resolveProviderCliAuthHome(args);
}

/** Docker Compose's terminal fallback uses the same opaque scope as login and verify. */
export function dockerClaudeLoginCommand(args: ScopedCliAuthHomeArgs): string | null {
  if (args.provider !== "anthropic") return null;
  const root = args.env?.AOA_HOME?.trim() || "/aoa";
  // The command is copyable in both POSIX shells and PowerShell. A configured
  // path containing shell metacharacters needs the in-app flow instead.
  if (!/^\/[A-Za-z0-9_./-]+$/.test(root)) return null;
  const home = path.posix.join(
    root,
    "execution-targets",
    opaqueSegment(args.executionTargetId?.trim() || "control-plane"),
    "auth",
    opaqueSegment(args.companyId),
    opaqueSegment(args.userId),
    "anthropic",
  );
  return `docker compose exec --user node -e HOME='${path.posix.dirname(home)}' -e CLAUDE_CONFIG_DIR='${home}' server claude auth login`;
}

export function dockerClaudeLoginCommands(
  args: ScopedCliAuthHomeArgs,
): Array<{ mode: "standard" | "quickstart"; command: string }> | null {
  const standard = dockerClaudeLoginCommand(args);
  if (!standard) return null;
  const root = args.env?.AOA_HOME?.trim() || "/aoa";
  if (!/^\/[A-Za-z0-9_./-]+$/.test(root)) return null;
  const scopedHome = path.posix.join(
    root,
    "execution-targets",
    opaqueSegment(args.executionTargetId?.trim() || "control-plane"),
    "auth",
    opaqueSegment(args.companyId),
    opaqueSegment(args.userId),
    "anthropic",
  );
  // The command is intentionally mode-specific: Compose service names and file
  // selection cannot be inferred reliably from inside the server container.
  // Tell founders to run the one matching the stack they started, from the
  // repository directory, rather than silently targeting another project.
  return [
    { mode: "standard", command: standard },
    {
      mode: "quickstart",
      command: `docker compose -f docker-compose.quickstart.yml exec --user node -e HOME='${path.posix.dirname(scopedHome)}' -e CLAUDE_CONFIG_DIR='${scopedHome}' aoa claude auth login`,
    },
  ];
}

export type ScopedClaudeCredentialStatus = {
  code: "claude_credentials_ready" | "claude_credentials_missing" | "claude_credentials_permission_denied" | "claude_credentials_unsafe_path";
  message: string;
  recoverable: boolean;
};

export type OpenedScopedClaudeCredential = {
  diagnostic: ScopedClaudeCredentialStatus;
  /** Linux /proc fd path is anchored to the opened directory and survives renames. */
  configDir: string | null;
  close(): Promise<void>;
};
const openedCredentialEvidence = new WeakMap<object, { authHome: string; active: boolean }>();

export function isScopedClaudeCredentialEvidenceFor(
  value: OpenedScopedClaudeCredential | undefined,
  authHome: string,
): value is OpenedScopedClaudeCredential {
  const evidence = value ? openedCredentialEvidence.get(value) : undefined;
  return Boolean(evidence?.active && evidence.authHome === path.resolve(authHome));
}

const DIRECTORY_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0);
const NO_FOLLOW_FLAGS = fs.constants.O_NOFOLLOW ?? 0;

function linuxProcFdPath(fd: number): string {
  return `/proc/${process.pid}/fd/${fd}`;
}

function scopedCredentialDiagnostic(code: ScopedClaudeCredentialStatus["code"]): ScopedClaudeCredentialStatus {
  switch (code) {
    case "claude_credentials_missing":
      return { code, message: "Claude is not signed in for this workspace yet.", recoverable: true };
    case "claude_credentials_permission_denied":
      return {
        code,
        message: "AoA cannot read this workspace's Claude credential. Ask the installation owner to grant the node service user access to the scoped credential, then try sign-in again.",
        recoverable: true,
      };
    case "claude_credentials_unsafe_path":
      return {
        code,
        message: "The scoped Claude credential path is unsafe. Ask the installation owner to inspect it before signing in again.",
        recoverable: false,
      };
    default:
      return { code, message: "Claude is not signed in for this workspace yet.", recoverable: true };
  }
}

function classifyCredentialPathError(error: unknown): ScopedClaudeCredentialStatus["code"] {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "claude_credentials_missing";
  if (code === "EACCES" || code === "EPERM") return "claude_credentials_permission_denied";
  return "claude_credentials_unsafe_path";
}

/**
 * Open each Linux path component from a pinned root directory descriptor.
 * Opening `/proc/self/fd/<parent>/<child>` is Linux's descriptor-relative
 * equivalent here: every component is opened with O_NOFOLLOW, and each next
 * lookup is rooted at the already-open parent inode, not a re-resolved path.
 */
async function openLinuxDirectoryChain(authHome: string): Promise<FileHandle> {
  const absolute = path.resolve(authHome);
  if (!absolute.startsWith(path.sep)) throw new Error("scoped auth home must be absolute");
  const components = absolute.split(path.sep).filter(Boolean);
  let directory = await fsp.open(path.sep, DIRECTORY_FLAGS);
  try {
    for (const component of components) {
      const next = await fsp.open(
        `${linuxProcFdPath(directory.fd)}/${component}`,
        DIRECTORY_FLAGS | NO_FOLLOW_FLAGS,
      );
      await directory.close();
      directory = next;
    }
    return directory;
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
}

/** Open and validate only the founder's exact scoped Claude credential. */
export async function openScopedClaudeCredential(
  authHome: string,
): Promise<OpenedScopedClaudeCredential> {
  let directory: FileHandle | null = null;
  try {
    if (process.platform === "linux") {
      directory = await openLinuxDirectoryChain(authHome);
      const credential = await fsp.open(
        `${linuxProcFdPath(directory.fd)}/.credentials.json`,
        fs.constants.O_RDONLY | NO_FOLLOW_FLAGS,
      );
      try {
        if (!(await credential.stat()).isFile()) {
          await directory.close();
          return {
            diagnostic: scopedCredentialDiagnostic("claude_credentials_unsafe_path"),
            configDir: null,
            close: async () => {},
          };
        }
      } finally {
        await credential.close();
      }
      const pinnedConfigDir = linuxProcFdPath(directory.fd);
      const opened: OpenedScopedClaudeCredential = {
        diagnostic: {
          code: "claude_credentials_ready",
          message: "Scoped Claude credential is readable.",
          recoverable: false,
        },
        configDir: pinnedConfigDir,
        close: async () => {
          await directory?.close();
          directory = null;
          const evidence = openedCredentialEvidence.get(opened);
          if (evidence) evidence.active = false;
        },
      };
      openedCredentialEvidence.set(opened, { authHome: path.resolve(authHome), active: true });
      return opened;
    }

    // Docker uses Linux. Keep native development supported while checking every
    // component on other platforms; no global Claude home is inspected.
    const absolute = path.resolve(authHome);
    const parsed = path.parse(absolute);
    let current = parsed.root;
    for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return {
          diagnostic: scopedCredentialDiagnostic("claude_credentials_unsafe_path"),
          configDir: null,
          close: async () => {},
        };
      }
    }
    const credentialPath = path.join(absolute, ".credentials.json");
    const credentialStat = await fsp.lstat(credentialPath);
    if (credentialStat.isSymbolicLink() || !credentialStat.isFile()) {
      return {
        diagnostic: scopedCredentialDiagnostic("claude_credentials_unsafe_path"),
        configDir: null,
        close: async () => {},
      };
    }
    const credential = await fsp.open(credentialPath, fs.constants.O_RDONLY | NO_FOLLOW_FLAGS);
    await credential.close();
    const opened: OpenedScopedClaudeCredential = {
      diagnostic: {
        code: "claude_credentials_ready",
        message: "Scoped Claude credential is readable.",
        recoverable: false,
      },
      configDir: absolute,
      close: async () => {
        const evidence = openedCredentialEvidence.get(opened);
        if (evidence) evidence.active = false;
      },
    };
    openedCredentialEvidence.set(opened, { authHome: path.resolve(authHome), active: true });
    return opened;
  } catch (error) {
    if (directory) await directory.close().catch(() => undefined);
    return {
      diagnostic: scopedCredentialDiagnostic(classifyCredentialPathError(error)),
      configDir: null,
      close: async () => {},
    };
  }
}

/** Inspect only the founder's scoped file, returning allowlisted diagnostics. */
export async function inspectScopedClaudeCredential(authHome: string): Promise<ScopedClaudeCredentialStatus> {
  const opened = await openScopedClaudeCredential(authHome);
  await opened.close();
  return opened.diagnostic;
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
  ) =>
    execFile(command, args, {
      timeout: 5_000,
      // npm installs Windows CLIs as .cmd shims. Node cannot spawn those
      // shims directly with execFile on Windows; use the platform shell for
      // this fixed executable name and fixed version argument only.
      ...(process.platform === "win32" ? { shell: true } : {}),
    }),
): Promise<{ cliInstalled: boolean; cliVersion: string | null; cliVersionSupported: boolean }> {
  const command = resolveProviderCliCommand(provider, process.platform);
  try {
    const result = await run(command, ["--version"]);
    const version = /\b(\d+\.\d+\.\d+)\b/.exec(`${result.stdout} ${result.stderr ?? ""}`)?.[1] ?? null;
    const supported = version !== null && isSupportedCliVersion(provider, version);
    return { cliInstalled: true, cliVersion: version, cliVersionSupported: supported };
  } catch {
    return { cliInstalled: false, cliVersion: null, cliVersionSupported: false };
  }
}

export function resolveProviderCliCommand(
  provider: "openai" | "anthropic",
  platform: NodeJS.Platform,
): string {
  const command = provider === "openai" ? "codex" : "claude";
  return platform === "win32" ? `${command}.cmd` : command;
}

/**
 * Keep the compatibility gate conservative without tying local onboarding to
 * the exact Docker patch version. Codex's CLI uses a pre-1.0 version scheme,
 * so the adapter supports the tested 0.145+ through the current 0.1xx line;
 * an unrelated future 0.999 release remains blocked until it is verified.
 * Claude's 2.1 line is the supported adapter family.
 */
export function isSupportedCliVersion(provider: "openai" | "anthropic", version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (provider === "openai") return major === 0 && minor >= 145 && minor < 200;
  return major === 2 && minor === 1;
}
