import type { DeploymentMode } from "@armyofagents/shared";

export type MigrationGateDeploymentMode = DeploymentMode | "unknown";

export interface SnapshotGateInput {
  deploymentMode: MigrationGateDeploymentMode;
  pendingMigrationTags: string[];
  companyCount: number;
  recordedSnapshots: string[];
}

export interface AssertMigrationSnapshotGateInput {
  deploymentMode?: DeploymentMode;
  pendingMigrationTags: string[];
  queryCompanyCount: () => Promise<unknown>;
  queryRecordedSnapshots: () => Promise<unknown>;
}

const GATED_MIGRATION = "0188";
const UNDEFINED_TABLE_SQLSTATE = "42P01";

function hasPendingGatedMigration(pendingMigrationTags: string[]): boolean {
  return pendingMigrationTags.some((tag) => tag.startsWith(GATED_MIGRATION));
}

/**
 * PostgreSQL errors can be wrapped by Drizzle and other adapters. Walk the
 * complete cause chain so only SQLSTATE 42P01 means a genuinely absent table.
 */
export function isUndefinedTableError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { cause?: unknown; code?: unknown };
    if (candidate.code === UNDEFINED_TABLE_SQLSTATE) return true;
    current = candidate.cause;
  }

  return false;
}

type CompanyCountRow = { count?: unknown };

/**
 * Read the pre-migration company count without converting operational database
 * failures into an empty database. Only an actually missing companies table is
 * safe to treat as zero.
 */
export async function readCompanyCountForSnapshotGate(
  query: () => Promise<unknown>,
): Promise<number> {
  let result: unknown;
  try {
    result = await query();
  } catch (error) {
    if (isUndefinedTableError(error)) return 0;
    throw error;
  }

  const rows = Array.isArray(result)
    ? (result as CompanyCountRow[])
    : Array.isArray((result as { rows?: unknown } | null)?.rows)
      ? (result as { rows: CompanyCountRow[] }).rows
      : null;
  const rawCount = rows?.[0]?.count;
  const count =
    typeof rawCount === "number"
      ? rawCount
      : typeof rawCount === "string" && /^\d+$/.test(rawCount)
        ? Number(rawCount)
        : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Could not read a valid companies count for the migration snapshot gate");
  }
  return count;
}

type InstanceSettingsRow = { general?: unknown };

/** Read and validate the durable snapshot markers from instance settings. */
export async function readRecordedSnapshotsForSnapshotGate(
  query: () => Promise<unknown>,
): Promise<string[]> {
  let result: unknown;
  try {
    result = await query();
  } catch (error) {
    if (isUndefinedTableError(error)) return [];
    throw error;
  }

  const rows = Array.isArray(result)
    ? (result as InstanceSettingsRow[])
    : Array.isArray((result as { rows?: unknown } | null)?.rows)
      ? (result as { rows: InstanceSettingsRow[] }).rows
      : null;
  if (rows === null) {
    throw new Error("Could not read migration snapshot markers from instance settings");
  }
  if (rows.length > 1) {
    throw new Error("Could not identify a unique canonical instance settings row");
  }

  const general = rows[0]?.general;
  if (general === undefined || general === null) return [];
  if (typeof general !== "object" || Array.isArray(general)) {
    throw new Error("Could not read migration snapshot markers from instance settings");
  }

  const snapshots = (general as { migrationSnapshots?: unknown }).migrationSnapshots;
  if (snapshots === undefined) return [];
  if (!Array.isArray(snapshots) || snapshots.some((value) => typeof value !== "string")) {
    throw new Error("Could not read migration snapshot markers from instance settings");
  }
  return snapshots;
}

/** Pure predicate: true means migration 0188 must not be applied. */
export function shouldBlockForMissingSnapshot(input: SnapshotGateInput): boolean {
  if (input.deploymentMode === "local_trusted" || input.deploymentMode === "authenticated") {
    return false;
  }
  if (input.companyCount <= 0) return false;
  if (!hasPendingGatedMigration(input.pendingMigrationTags)) return false;
  return !input.recordedSnapshots.some((snapshot) => snapshot === GATED_MIGRATION);
}

export class SnapshotGateError extends Error {
  constructor(deploymentMode: MigrationGateDeploymentMode = "unknown") {
    const context =
      deploymentMode === "unknown"
        ? "the deployment mode is unavailable"
        : "deploymentMode is cloud_auth";
    super(
      `Refusing to apply migration 0188 (multi-tenant tenant schema): ${context} with a ` +
        "populated companies table and no snapshot marker. Take a full DB snapshot, then " +
        "record it on instance_settings.singleton_key = 'default' via " +
        "general.migrationSnapshots += \"0188\" before " +
        "retrying. Manual migrations must also set AOA_DEPLOYMENT_MODE to the configured " +
        "deployment mode. (One-way door once a second Organization exists.)",
    );
    this.name = "SnapshotGateError";
  }
}

/**
 * Enforce the 0188 backup marker at the shared migration boundary. An omitted
 * deployment mode is intentionally unknown, not local_trusted: direct callers
 * and the manual CLI must not silently bypass the cloud safety policy.
 */
export async function assertMigrationSnapshotGate(
  input: AssertMigrationSnapshotGateInput,
): Promise<void> {
  const deploymentMode: MigrationGateDeploymentMode = input.deploymentMode ?? "unknown";
  if (deploymentMode === "local_trusted" || deploymentMode === "authenticated") return;
  if (!hasPendingGatedMigration(input.pendingMigrationTags)) return;

  const companyCount = await readCompanyCountForSnapshotGate(input.queryCompanyCount);
  if (companyCount <= 0) return;
  const recordedSnapshots = await readRecordedSnapshotsForSnapshotGate(
    input.queryRecordedSnapshots,
  );

  if (
    shouldBlockForMissingSnapshot({
      deploymentMode,
      pendingMigrationTags: input.pendingMigrationTags,
      companyCount,
      recordedSnapshots,
    })
  ) {
    throw new SnapshotGateError(deploymentMode);
  }
}
