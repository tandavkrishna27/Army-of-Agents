/**
 * DEP-003 (E6 deployment harness): the PRIVILEGED, idempotent, non-destructive,
 * bounded-retry, FAIL-CLOSED-exit migration job. It runs as a dedicated container
 * command (`docker/control-plane/migrate-entrypoint.sh`) under a PRIVILEGED migration
 * role that is DISTINCT from the `aoa_app`/`aoa_operator` non-owner serving roles.
 *
 * Application startup runs NO migrations — this job is the sole schema-apply path in
 * the split control-plane topology. It:
 *   - is IDEMPOTENT + NON-DESTRUCTIVE: delegates to `applyPendingMigrations` (advisory
 *     lock + snapshot gate + per-file transactions), so a re-run on an up-to-date DB
 *     is a no-op and a partial apply never corrupts.
 *   - NEVER loops destructively: retries are BOUNDED with backoff; a persistently
 *     failing or unresolved migration exhausts the bound and exits non-zero.
 *   - FAILS CLOSED: any unresolved-pending / exhausted-retry / missing-URL condition
 *     returns a non-success result and the CLI `process.exit(1)`s so the container
 *     stops the deploy rather than serving on an unmigrated schema.
 *
 * This job applies SCHEMA migrations only. The operator-gated 0188 populated-cutover
 * preflight is a SEPARATE, conditional server-side step the entrypoint runs after
 * this job succeeds (it needs the object-store/pg-restore ports that live in
 * `server`, which `packages/db` must not import).
 */
import { DEPLOYMENT_MODES, type DeploymentMode } from "@armyofagents/shared";
import { applyPendingMigrations, inspectMigrations } from "./client.js";

export type MigrateJobReason =
  | "no_database_url"
  | "already_up_to_date"
  | "applied"
  | "unresolved_pending"
  | "exhausted_retries";

export interface MigrateJobEvent {
  phase: "start" | "attempt" | "applied" | "up_to_date" | "retry" | "failed";
  attempt?: number;
  pending?: number;
  detail?: string;
}

export interface MigrateJobResult {
  ok: boolean;
  attempts: number;
  reason: MigrateJobReason;
}

export interface MigrateJobDeps {
  url: string | undefined;
  applyMigrations?: (url: string, options: { deploymentMode?: DeploymentMode }) => Promise<void>;
  inspect?: (url: string) => Promise<{ status: "upToDate" | "needsMigrations"; pendingMigrations?: string[] }>;
  deploymentMode?: DeploymentMode;
  /** Bounded retry ceiling. Never infinite — this is the "no destructive loop" guarantee. */
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: (event: MigrateJobEvent) => void;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the bounded, idempotent, fail-closed schema migration job. Returns a result
 * with `ok:false` on every failure mode (the CLI maps that to a non-zero exit).
 */
export async function runMigrateJob(deps: MigrateJobDeps): Promise<MigrateJobResult> {
  const log = (event: MigrateJobEvent): void => deps.logger?.(event);
  const url = deps.url;
  if (typeof url !== "string" || url.trim() === "") {
    log({ phase: "failed", detail: "DATABASE_URL is required for the migration job" });
    return { ok: false, attempts: 0, reason: "no_database_url" };
  }

  const applyMigrations = deps.applyMigrations ?? applyPendingMigrations;
  const inspect = deps.inspect ?? inspectMigrations;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = deps.sleep ?? defaultSleep;

  log({ phase: "start" });

  let lastReason: MigrateJobReason = "unresolved_pending";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    log({ phase: "attempt", attempt });
    try {
      const before = await inspect(url);
      if (before.status === "upToDate") {
        log({ phase: "up_to_date", attempt });
        return { ok: true, attempts: attempt, reason: attempt === 1 ? "already_up_to_date" : "applied" };
      }

      await applyMigrations(url, { deploymentMode: deps.deploymentMode });

      const after = await inspect(url);
      if (after.status === "upToDate") {
        log({ phase: "applied", attempt });
        return { ok: true, attempts: attempt, reason: "applied" };
      }
      lastReason = "unresolved_pending";
      log({ phase: "retry", attempt, pending: after.pendingMigrations?.length });
    } catch (error) {
      lastReason = "exhausted_retries";
      log({
        phase: "retry",
        attempt,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (attempt < maxAttempts) {
      // Bounded exponential backoff between attempts. This is the ONLY delay; the
      // loop is hard-capped at maxAttempts so it can never spin destructively.
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  log({ phase: "failed", detail: `migration job exhausted ${maxAttempts} attempt(s)` });
  return { ok: false, attempts: maxAttempts, reason: lastReason };
}

function readDeploymentModeForMigration(): DeploymentMode | undefined {
  const raw = process.env.AOA_DEPLOYMENT_MODE ?? process.env.PAPERCLIP_DEPLOYMENT_MODE;
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!DEPLOYMENT_MODES.includes(raw as DeploymentMode)) {
    throw new Error(
      `Invalid AOA_DEPLOYMENT_MODE '${raw}'. Expected one of: ${DEPLOYMENT_MODES.join(", ")}`,
    );
  }
  return raw as DeploymentMode;
}

/** CLI entrypoint: run the job and FAIL CLOSED (non-zero exit) on any failure. */
export async function main(): Promise<void> {
  const result = await runMigrateJob({
    url: process.env.DATABASE_URL,
    deploymentMode: readDeploymentModeForMigration(),
    logger: (event) => console.log(JSON.stringify({ migrateJob: event })),
  });
  if (!result.ok) {
    console.error(`migration job failed: ${result.reason} after ${result.attempts} attempt(s)`);
    process.exit(1);
  }
  console.log(`migration job ok: ${result.reason} after ${result.attempts} attempt(s)`);
}

// Run as a CLI only when invoked directly (not when imported by tests).
const invokedPath = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (invokedPath.endsWith("/migrate-job.js") || invokedPath.endsWith("/migrate-job.ts")) {
  await main();
}
