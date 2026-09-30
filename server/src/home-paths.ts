import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolveAoaHomeDir(): string {
  const envHome = process.env.AOA_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));
  const aoaHome = path.resolve(os.homedir(), ".aoa");
  // Migration fallback: use legacy ~/.paperclip/ if it exists and the new
  // ~/.aoa/ hasn't been created yet. Remove after the next major.
  if (!existsSync(aoaHome)) {
    const legacyHome = path.resolve(os.homedir(), ".paperclip");
    if (existsSync(legacyHome)) return legacyHome;
  }
  return aoaHome;
}

export function resolveAoaInstanceId(): string {
  const raw = process.env.AOA_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
  if (!INSTANCE_ID_RE.test(raw)) {
    throw new Error(`Invalid AOA_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolveAoaInstanceRoot(): string {
  return path.resolve(resolveAoaHomeDir(), "instances", resolveAoaInstanceId());
}

export function resolveDefaultConfigPath(): string {
  return path.resolve(resolveAoaInstanceRoot(), "config.json");
}

export function resolveDefaultEmbeddedPostgresDir(): string {
  return path.resolve(resolveAoaInstanceRoot(), "db");
}

export function resolveDefaultLogsDir(): string {
  return path.resolve(resolveAoaInstanceRoot(), "logs");
}

export function resolveDefaultRunLogsDir(): string {
  return path.resolve(resolveAoaInstanceRoot(), "data", "run-logs");
}

export function resolveDefaultSecretsKeyFilePath(): string {
  return path.resolve(resolveAoaInstanceRoot(), "secrets", "master.key");
}

export function resolveDefaultStorageDir(): string {
  return path.resolve(resolveAoaInstanceRoot(), "data", "storage");
}

export function resolveDefaultBackupDir(): string {
  return path.resolve(resolveAoaInstanceRoot(), "data", "backups");
}

export function resolveDefaultAgentWorkspaceDir(agentId: string): string {
  const trimmed = agentId.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid agent id for workspace path '${agentId}'.`);
  }
  return path.resolve(resolveAoaInstanceRoot(), "workspaces", trimmed);
}

// WS0a — server-owned base dir that authenticated/multi-tenant company
// workspace-fs browsing is jailed under (per-company subdirectory joined in
// by resolveCompanyWorkspaceRoot()). Distinct from the per-agent
// resolveDefaultAgentWorkspaceDir() tree above (heartbeat execution homes).
export function resolveDefaultCompanyWorkspaceBaseDir(): string {
  return path.resolve(resolveAoaInstanceRoot(), "data", "company-workspaces");
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
