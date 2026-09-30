import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function resolveAoaHomeDir(): string {
  const envHome = process.env.AOA_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));
  const aoaHome = path.resolve(os.homedir(), ".aoa");
  // Migration fallback: if ~/.aoa/ doesn't exist yet but a legacy
  // ~/.paperclip/ does, use the legacy directory for one release so
  // existing installs keep working. Remove after the next major.
  if (!existsSync(aoaHome)) {
    const legacyHome = path.resolve(os.homedir(), ".paperclip");
    if (existsSync(legacyHome)) return legacyHome;
  }
  return aoaHome;
}

export function resolveAoaInstanceId(override?: string): string {
  const raw = override?.trim() || process.env.AOA_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
  if (!INSTANCE_ID_RE.test(raw)) {
    throw new Error(
      `Invalid instance id '${raw}'. Allowed characters: letters, numbers, '_' and '-'.`,
    );
  }
  return raw;
}

export function resolveAoaInstanceRoot(instanceId?: string): string {
  const id = resolveAoaInstanceId(instanceId);
  return path.resolve(resolveAoaHomeDir(), "instances", id);
}

export function resolveDefaultConfigPath(instanceId?: string): string {
  return path.resolve(resolveAoaInstanceRoot(instanceId), "config.json");
}

export function resolveDefaultContextPath(): string {
  return path.resolve(resolveAoaHomeDir(), "context.json");
}

export function resolveDefaultEmbeddedPostgresDir(instanceId?: string): string {
  return path.resolve(resolveAoaInstanceRoot(instanceId), "db");
}

export function resolveDefaultLogsDir(instanceId?: string): string {
  return path.resolve(resolveAoaInstanceRoot(instanceId), "logs");
}

export function resolveDefaultSecretsKeyFilePath(instanceId?: string): string {
  return path.resolve(resolveAoaInstanceRoot(instanceId), "secrets", "master.key");
}

export function resolveDefaultStorageDir(instanceId?: string): string {
  return path.resolve(resolveAoaInstanceRoot(instanceId), "data", "storage");
}

export function resolveDefaultBackupDir(instanceId?: string): string {
  return path.resolve(resolveAoaInstanceRoot(instanceId), "data", "backups");
}

export function resolveDefaultCliAuthPath(): string {
  return path.resolve(resolveAoaHomeDir(), "auth.json");
}

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function describeLocalInstancePaths(instanceId?: string) {
  const resolvedInstanceId = resolveAoaInstanceId(instanceId);
  const instanceRoot = resolveAoaInstanceRoot(resolvedInstanceId);
  return {
    homeDir: resolveAoaHomeDir(),
    instanceId: resolvedInstanceId,
    instanceRoot,
    configPath: resolveDefaultConfigPath(resolvedInstanceId),
    embeddedPostgresDataDir: resolveDefaultEmbeddedPostgresDir(resolvedInstanceId),
    backupDir: resolveDefaultBackupDir(resolvedInstanceId),
    logDir: resolveDefaultLogsDir(resolvedInstanceId),
    secretsKeyFilePath: resolveDefaultSecretsKeyFilePath(resolvedInstanceId),
    storageDir: resolveDefaultStorageDir(resolvedInstanceId),
  };
}
