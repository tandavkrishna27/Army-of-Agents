import "./env-compat.js"; // side-effect: mirror PAPERCLIP_* env to AOA_* for migration
import { readConfigFile } from "./config-file.js";
import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { resolveAoaEnvPath } from "./paths.js";
import {
  AUTH_BASE_URL_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  type AuthBaseUrlMode,
  type DeploymentExposure,
  type DeploymentMode,
  type SecretProvider,
  type StorageProvider,
} from "@armyofagents/shared";
import {
  resolveDefaultBackupDir,
  resolveDefaultCompanyWorkspaceBaseDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveHomeAwarePath,
} from "./home-paths.js";
import {
  assertHostedExecutionStartupSafe,
  type HostedExecutionStartupSafetyOutcome,
} from "./config/distributed-execution.js";

const AOA_ENV_FILE_PATH = resolveAoaEnvPath();
if (existsSync(AOA_ENV_FILE_PATH)) {
  loadDotenv({ path: AOA_ENV_FILE_PATH, override: false, quiet: true });
}

type DatabaseMode = "embedded-postgres" | "postgres";

export interface Config {
  deploymentMode: DeploymentMode;
  /**
   * FND-005: default-off deployment gate for the distributed execution rollout.
   * Enabling it never starts a worker or registers a distributed route by
   * itself — the Organization rollout flag (E3/E10) and per-workload flag remain
   * separately required (see `resolveDistributedExecutionRollout`). The reserved
   * public-ingress and cloud-plugin surfaces are NOT config booleans: their env
   * sentinels are hard-negatives that stop startup via
   * `assertHostedExecutionStartupSafe`.
   */
  distributedExecutionEnabled: boolean;
  /**
   * DE-14: what `assertHostedExecutionStartupSafe` DECIDED on this load, carried
   * out so the entrypoint records the assertion's own outcome instead of
   * re-deriving it from the same environment. A refusal never reaches here — it
   * throws out of `loadConfig` and is recorded by
   * `loadConfigWithStartupSafetyAudit` on the way past.
   */
  hostedExecutionStartupSafety: HostedExecutionStartupSafetyOutcome;
  deploymentExposure: DeploymentExposure;
  host: string;
  port: number;
  allowedHostnames: string[];
  authBaseUrlMode: AuthBaseUrlMode;
  authPublicBaseUrl: string | undefined;
  googleClientId: string | null;
  googleClientSecret: string | null;
  devLocalIdentity: boolean;
  headlessBootstrap: boolean;
  databaseMode: DatabaseMode;
  databaseUrl: string | undefined;
  embeddedPostgresDataDir: string;
  embeddedPostgresPort: number;
  databaseBackupEnabled: boolean;
  databaseBackupIntervalMinutes: number;
  databaseBackupRetentionDays: number;
  databaseBackupDir: string;
  serveUi: boolean;
  uiDevMiddleware: boolean;
  secretsProvider: SecretProvider;
  secretsStrictMode: boolean;
  secretsMasterKeyFilePath: string;
  storageProvider: StorageProvider;
  storageLocalDiskBaseDir: string;
  /**
   * WS0a — server-owned base dir that `authenticated`-mode company
   * workspace-fs browse/mkdir is jailed under (per-company subdir joined
   * in by resolveCompanyWorkspaceRoot()). Unused in local_trusted mode
   * (the founder browses their real home area, unjailed).
   */
  companyWorkspaceBaseDir: string;
  storageS3Bucket: string;
  storageS3Region: string;
  storageS3Endpoint: string | undefined;
  storageS3PresignEndpoint: string | undefined;
  storageS3Prefix: string;
  storageS3ForcePathStyle: boolean;
  heartbeatSchedulerEnabled: boolean;
  heartbeatSchedulerIntervalMs: number;
  companyDeletionEnabled: boolean;
  /**
   * Express trust-proxy setting. Set when AoA runs behind a reverse proxy
   * (Cloudflare, ALB, nginx). Without this, `req.ip` reads the proxy's IP
   * and IP-keyed rate limits collapse to one shared bucket.
   * - `false` (default): trust the socket peer only
   * - `true`: trust the X-Forwarded-* headers from any source (DANGEROUS without a real proxy)
   * - `number` N: trust the N-th hop in X-Forwarded-For (recommended for cloud)
   * - `string[]`: list of CIDRs to trust as proxies
   */
  trustProxy: boolean | number | string[];
}

function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  if (raw === undefined) return false;
  const value = raw.trim();
  if (value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (value.includes(",") || value.includes("/") || value.includes(".") || value.includes(":")) {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  throw new Error(
    `AOA_TRUST_PROXY="${raw}" is not a valid value. ` +
      `Use "true", "false", a hop count (e.g. "1"), or a comma-separated CIDR list.`,
  );
}

function parseOptionalPortEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name}="${raw}" is not a valid TCP port`);
  }
  return port;
}

export function loadConfig(): Config {
  const fileConfig = readConfigFile();
  const fileDatabaseMode =
    (fileConfig?.database.mode === "postgres" ? "postgres" : "embedded-postgres") as DatabaseMode;

  const fileDbUrl =
    fileDatabaseMode === "postgres"
      ? fileConfig?.database.connectionString
      : undefined;
  const fileDatabaseBackup = fileConfig?.database.backup;
  const fileSecrets = fileConfig?.secrets;
  const fileStorage = fileConfig?.storage;
  const strictModeFromEnv = process.env.AOA_SECRETS_STRICT_MODE;
  const secretsStrictMode =
    strictModeFromEnv !== undefined
      ? strictModeFromEnv === "true"
      : (fileSecrets?.strictMode ?? false);

  const providerFromEnvRaw = process.env.AOA_SECRETS_PROVIDER;
  const providerFromEnv =
    providerFromEnvRaw && SECRET_PROVIDERS.includes(providerFromEnvRaw as SecretProvider)
      ? (providerFromEnvRaw as SecretProvider)
      : null;
  const providerFromFile = fileSecrets?.provider;
  const secretsProvider: SecretProvider = providerFromEnv ?? providerFromFile ?? "local_encrypted";

  const storageProviderFromEnvRaw = process.env.AOA_STORAGE_PROVIDER;
  const storageProviderFromEnv =
    storageProviderFromEnvRaw && STORAGE_PROVIDERS.includes(storageProviderFromEnvRaw as StorageProvider)
      ? (storageProviderFromEnvRaw as StorageProvider)
      : null;
  const storageProvider: StorageProvider = storageProviderFromEnv ?? fileStorage?.provider ?? "local_disk";
  const storageLocalDiskBaseDir = resolveHomeAwarePath(
    process.env.AOA_STORAGE_LOCAL_DIR ??
      fileStorage?.localDisk?.baseDir ??
      resolveDefaultStorageDir(),
  );
  const companyWorkspaceBaseDir = resolveHomeAwarePath(
    process.env.AOA_COMPANY_WORKSPACE_DIR ?? resolveDefaultCompanyWorkspaceBaseDir(),
  );
  const storageS3Bucket = process.env.AOA_STORAGE_S3_BUCKET ?? fileStorage?.s3?.bucket ?? "paperclip";
  const storageS3Region = process.env.AOA_STORAGE_S3_REGION ?? fileStorage?.s3?.region ?? "us-east-1";
  // A BLANK env value means UNSET (use the AWS default host), never a literal ""
  // endpoint — a "" would make the S3 presign path reject the valid AWS default as
  // "not https". Apply env-over-file precedence FIRST (`??` so a set-but-blank env
  // still overrides a stored file endpoint), THEN normalize blank/whitespace to
  // undefined — so `AOA_STORAGE_S3_ENDPOINT=""` selects the AWS default even when a
  // config file has a (possibly non-https) MinIO/R2 endpoint.
  const storageS3Endpoint =
    (process.env.AOA_STORAGE_S3_ENDPOINT ?? fileStorage?.s3?.endpoint)?.trim() || undefined;
  // DAT-002 — worker-facing https endpoint used ONLY to mint presigned artifact
  // grant URLs (distinct from the internal control-plane endpoint above).
  const storageS3PresignEndpoint =
    (process.env.AOA_STORAGE_S3_PRESIGN_ENDPOINT ?? fileStorage?.s3?.presignEndpoint)?.trim() ||
    undefined;
  const storageS3Prefix = process.env.AOA_STORAGE_S3_PREFIX ?? fileStorage?.s3?.prefix ?? "";
  const storageS3ForcePathStyle =
    process.env.AOA_STORAGE_S3_FORCE_PATH_STYLE !== undefined
      ? process.env.AOA_STORAGE_S3_FORCE_PATH_STYLE === "true"
      : (fileStorage?.s3?.forcePathStyle ?? false);

  const deploymentModeFromEnvRaw = process.env.AOA_DEPLOYMENT_MODE;
  const deploymentModeFromEnv =
    deploymentModeFromEnvRaw && DEPLOYMENT_MODES.includes(deploymentModeFromEnvRaw as DeploymentMode)
      ? (deploymentModeFromEnvRaw as DeploymentMode)
      : null;
  const deploymentMode: DeploymentMode = deploymentModeFromEnv ?? fileConfig?.server.deploymentMode ?? "local_trusted";
  // FND-005: resolve the default-off distributed-execution deployment flag and
  // assert hosted-execution startup safety immediately after the deployment mode
  // is known. A truthy excluded surface (public ingress / cloud plugin) stops
  // startup in every mode; the process-wide unsandboxed override is rejected in
  // cloud_auth. Neither branch starts a scheduler, adapter, distributed route, or
  // worker — the reserved distributed routes stay unregistered when absent/false.
  // ★ DE-14 — THE FLAG IS READ *THROUGH* THE ASSERTION, NOT BESIDE IT, and the
  // order matters. This line used to be a separate
  // `readDistributedExecutionDeploymentFlag(process.env)` call sitting BEFORE the
  // assertion. That reader throws a PLAIN `Error` on a non-boolean value, so
  // `AOA_DISTRIBUTED_EXECUTION_ENABLED=banana` refused startup one line too early
  // — before the assertion could classify it — and the recorder at the entrypoint
  // saw an unrelated load failure and wrote no
  // `distributed_execution.startup_safety.refused` line. The classified
  // `env_flag_unparseable` branch was therefore PRODUCTION-UNREACHABLE for this
  // one flag: a reason code that nothing could emit. Found by external review on
  // PR #416. The assertion already reads the same flag and now RETURNS it, so
  // there is exactly one read and the refusal cannot outrun the record.
  const hostedExecutionStartupSafety = assertHostedExecutionStartupSafe({
    deploymentMode,
    env: process.env,
  });
  const distributedExecutionEnabled = hostedExecutionStartupSafety.distributedExecutionEnabled;
  const deploymentExposureFromEnvRaw = process.env.AOA_DEPLOYMENT_EXPOSURE;
  const deploymentExposureFromEnv =
    deploymentExposureFromEnvRaw &&
    DEPLOYMENT_EXPOSURES.includes(deploymentExposureFromEnvRaw as DeploymentExposure)
      ? (deploymentExposureFromEnvRaw as DeploymentExposure)
      : null;
  const deploymentExposure: DeploymentExposure =
    deploymentMode === "local_trusted"
      ? "private"
      : (deploymentExposureFromEnv ?? fileConfig?.server.exposure ?? "private");
  const authBaseUrlModeFromEnvRaw = process.env.AOA_AUTH_BASE_URL_MODE;
  const authBaseUrlModeFromEnv =
    authBaseUrlModeFromEnvRaw &&
    AUTH_BASE_URL_MODES.includes(authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      ? (authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      : null;
  const publicUrlFromEnv = process.env.AOA_PUBLIC_URL;
  const authPublicBaseUrlRaw =
    process.env.AOA_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    publicUrlFromEnv ??
    fileConfig?.auth?.publicBaseUrl;
  const authPublicBaseUrl = authPublicBaseUrlRaw?.trim() || undefined;
  const authBaseUrlMode: AuthBaseUrlMode =
    authBaseUrlModeFromEnv ??
    fileConfig?.auth?.baseUrlMode ??
    (authPublicBaseUrl ? "explicit" : "auto");
  const allowedHostnamesFromEnvRaw = process.env.AOA_ALLOWED_HOSTNAMES;
  const allowedHostnamesFromEnv = allowedHostnamesFromEnvRaw
    ? allowedHostnamesFromEnvRaw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : null;
  const publicUrlHostname = authPublicBaseUrl
    ? (() => {
      try {
        return new URL(authPublicBaseUrl).hostname.trim().toLowerCase();
      } catch {
        return null;
      }
    })()
    : null;
  const allowedHostnames = Array.from(
    new Set(
      [
        ...(allowedHostnamesFromEnv ?? fileConfig?.server.allowedHostnames ?? []),
        ...(publicUrlHostname ? [publicUrlHostname] : []),
      ]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const companyDeletionEnvRaw = process.env.AOA_ENABLE_COMPANY_DELETION;
  const companyDeletionEnabled =
    companyDeletionEnvRaw !== undefined
      ? companyDeletionEnvRaw === "true"
      : deploymentMode === "local_trusted";
  const databaseBackupEnabled =
    process.env.AOA_DB_BACKUP_ENABLED !== undefined
      ? process.env.AOA_DB_BACKUP_ENABLED === "true"
      : (fileDatabaseBackup?.enabled ?? true);
  const databaseBackupIntervalMinutes = Math.max(
    1,
    Number(process.env.AOA_DB_BACKUP_INTERVAL_MINUTES) ||
      fileDatabaseBackup?.intervalMinutes ||
      60,
  );
  const databaseBackupRetentionDays = Math.max(
    1,
    Number(process.env.AOA_DB_BACKUP_RETENTION_DAYS) ||
      fileDatabaseBackup?.retentionDays ||
      30,
  );
  const databaseBackupDir = resolveHomeAwarePath(
    process.env.AOA_DB_BACKUP_DIR ??
      fileDatabaseBackup?.dir ??
      resolveDefaultBackupDir(),
  );

  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || null;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || null;
  const devLocalIdentity =
    deploymentMode === "local_trusted" &&
    /^(1|true|yes)$/i.test(process.env.AOA_DEV_LOCAL_IDENTITY?.trim() ?? "");
  const headlessBootstrap = /^(1|true|yes)$/i.test(process.env.AOA_HEADLESS_BOOTSTRAP?.trim() ?? "");

  return {
    deploymentMode,
    distributedExecutionEnabled,
    hostedExecutionStartupSafety,
    deploymentExposure,
    host: process.env.HOST ?? fileConfig?.server.host ?? "127.0.0.1",
    port: Number(process.env.PORT) || fileConfig?.server.port || 3100,
    allowedHostnames,
    authBaseUrlMode,
    authPublicBaseUrl,
    googleClientId,
    googleClientSecret,
    devLocalIdentity,
    headlessBootstrap,
    databaseMode: fileDatabaseMode,
    databaseUrl: process.env.DATABASE_URL ?? fileDbUrl,
    embeddedPostgresDataDir: resolveHomeAwarePath(
      fileConfig?.database.embeddedPostgresDataDir ?? resolveDefaultEmbeddedPostgresDir(),
    ),
    embeddedPostgresPort:
      parseOptionalPortEnv("AOA_EMBEDDED_POSTGRES_PORT") ??
      fileConfig?.database.embeddedPostgresPort ??
      54329,
    databaseBackupEnabled,
    databaseBackupIntervalMinutes,
    databaseBackupRetentionDays,
    databaseBackupDir,
    serveUi:
      process.env.SERVE_UI !== undefined
        ? process.env.SERVE_UI === "true"
        : fileConfig?.server.serveUi ?? true,
    uiDevMiddleware: process.env.AOA_UI_DEV_MIDDLEWARE === "true",
    secretsProvider,
    secretsStrictMode,
    secretsMasterKeyFilePath:
      resolveHomeAwarePath(
        process.env.AOA_SECRETS_MASTER_KEY_FILE ??
          fileSecrets?.localEncrypted.keyFilePath ??
          resolveDefaultSecretsKeyFilePath(),
      ),
    storageProvider,
    storageLocalDiskBaseDir,
    companyWorkspaceBaseDir,
    storageS3Bucket,
    storageS3Region,
    storageS3Endpoint,
    storageS3PresignEndpoint,
    storageS3Prefix,
    storageS3ForcePathStyle,
    heartbeatSchedulerEnabled: process.env.HEARTBEAT_SCHEDULER_ENABLED !== "false",
    heartbeatSchedulerIntervalMs: Math.max(10000, Number(process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS) || 30000),
    companyDeletionEnabled,
    trustProxy: parseTrustProxy(process.env.AOA_TRUST_PROXY),
  };
}
