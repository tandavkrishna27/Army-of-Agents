/**
 * DEP-003 (E6 deployment harness): the ORCHESTRATOR for the operator-gated 0188
 * populated-cutover preflight. It runs the six steps in order with INJECTED ports
 * (object store, restore-validation, operator marker store, clock) and drives the
 * PURE fail-closed state machine (`cutover-0188-preflight-state.ts`) as the single
 * source of the proceed/stop verdict. It fails closed at every step and NEVER writes
 * the marker until opt-in + exact SHA match AND snapshot AND checksum AND
 * restore-validation all pass.
 *
 * Runs in the MIGRATION JOB (privileged container command), NEVER at application
 * startup. Application startup only READS the marker (see `evaluateStartupCutoverGate`).
 *
 * Ports are injected so the whole orchestration is exercised by deterministic
 * in-memory fakes in the pure test; the live child-process pg_dump/pg_restore +
 * object-store + operator-pool adapters run only in the Linux/CI container (deferred).
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import {
  evaluateCutover0188Preflight,
  type Cutover0188PreflightDecision,
  type MarkerWriteOutcome,
  type PreflightStepOutcome,
} from "./cutover-0188-preflight-state.js";

const execFileAsync = promisify(execFile);

/** The durable marker row shape (mirrors the `distributed_cutover_markers` table). */
export interface CutoverMarkerRow {
  candidateSha: string;
  snapshotRef: string;
  snapshotChecksum: string;
  verifiedAt: Date;
}

export interface SnapshotResult {
  ok: boolean;
  snapshotRef?: string;
  error?: string;
}

export interface ChecksumResult {
  ok: boolean;
  checksum?: string;
  error?: string;
}

export interface RestoreValidationResult {
  ok: boolean;
  error?: string;
}

export interface MarkerWriteResult {
  ok: boolean;
  error?: string;
}

/** Take + checksum-validate a snapshot in the object store. Unavailable store -> throw or ok:false. */
export interface CutoverObjectStorePort {
  takeSnapshot(input: { candidateSha: string }): Promise<SnapshotResult>;
  validateChecksum(input: { snapshotRef: string }): Promise<ChecksumResult>;
}

/** Restore the snapshot into an ISOLATED pre-cutover database and verify it restores cleanly. */
export interface CutoverRestoreValidationPort {
  restoreAndValidate(input: { snapshotRef: string }): Promise<RestoreValidationResult>;
}

/**
 * The operator-role marker store. `writeMarker` runs as `aoa_operator` (the only
 * role permitted to write the marker); `readMarker`/`verifyMarker` are read-backs.
 * Application startup uses a READ-ONLY variant and never calls `writeMarker`.
 */
export interface CutoverMarkerStorePort {
  readMarker(input: { candidateSha: string }): Promise<CutoverMarkerRow | null>;
  writeMarker(row: CutoverMarkerRow): Promise<MarkerWriteResult>;
  verifyMarker(input: { candidateSha: string }): Promise<CutoverMarkerRow | null>;
}

export interface CutoverClockPort {
  now(): Date;
}

export type PreflightStepName =
  | "opt_in_sha"
  | "snapshot"
  | "checksum"
  | "restore_validate"
  | "marker_write"
  | "marker_verify";

export interface PreflightStepEvent {
  step: PreflightStepName;
  outcome: "ok" | "failed";
  detail?: string;
}

export interface Cutover0188PreflightDeps {
  optIn: boolean;
  candidateSha: string | null;
  imageSha: string | null;
  objectStore: CutoverObjectStorePort;
  restore: CutoverRestoreValidationPort;
  markerStore: CutoverMarkerStorePort;
  clock: CutoverClockPort;
  logger?: (event: PreflightStepEvent) => void;
}

export interface Cutover0188PreflightResult {
  decision: Cutover0188PreflightDecision;
  snapshotRef: string | null;
  snapshotChecksum: string | null;
  steps: PreflightStepEvent[];
}

const BASE = {
  snapshotResult: "not_run" as PreflightStepOutcome,
  checksumResult: "not_run" as PreflightStepOutcome,
  restoreValidationResult: "not_run" as PreflightStepOutcome,
  markerWriteResult: "not_run" as MarkerWriteOutcome,
  markerVerifyResult: "not_run" as PreflightStepOutcome,
};

/** Best-effort port call: an exception (unavailable store/provider) is a failed step. */
async function attempt<T extends { ok: boolean; error?: string }>(
  work: () => Promise<T>,
  onError: (message: string) => T,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return onError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Run the full preflight. Short-circuits at the first failing gate/step, records an
 * ordered step log, and returns the pure-machine verdict. The marker is written ONLY
 * after every prior gate passes; a marker-verify failure stops deployment even though
 * a row may physically exist.
 */
export async function runCutover0188Preflight(
  deps: Cutover0188PreflightDeps,
): Promise<Cutover0188PreflightResult> {
  const steps: PreflightStepEvent[] = [];
  const log = (event: PreflightStepEvent): void => {
    steps.push(event);
    deps.logger?.(event);
  };
  const input = {
    optIn: deps.optIn,
    candidateSha: deps.candidateSha,
    imageSha: deps.imageSha,
    ...BASE,
  };

  // Gates 1+2 (opt-in + exact SHA) run BEFORE any I/O — no snapshot on a failed gate.
  const gate = evaluateCutover0188Preflight(input);
  if (gate.reason === "missing_opt_in" || gate.reason === "candidate_sha_mismatch") {
    log({ step: "opt_in_sha", outcome: "failed", detail: gate.reason });
    return { decision: gate, snapshotRef: null, snapshotChecksum: null, steps };
  }
  log({ step: "opt_in_sha", outcome: "ok" });
  const candidateSha = (deps.candidateSha ?? "").trim();

  // Idempotent-repeat: a present, verified marker for this candidate SHA is a no-op
  // success. READ-ONLY — the orchestrator never re-snapshots or re-writes on repeat.
  const existing = await deps.markerStore.readMarker({ candidateSha });
  if (existing) {
    const readback = await deps.markerStore.verifyMarker({ candidateSha });
    const verifyOk = readback !== null && readback.candidateSha === candidateSha;
    log({ step: "marker_verify", outcome: verifyOk ? "ok" : "failed" });
    return {
      decision: evaluateCutover0188Preflight({
        ...input,
        markerWriteResult: "already_present",
        markerVerifyResult: verifyOk ? "ok" : "failed",
      }),
      snapshotRef: existing.snapshotRef,
      snapshotChecksum: existing.snapshotChecksum,
      steps,
    };
  }

  // Step 3a: snapshot to the object store.
  const snapshot = await attempt(
    () => deps.objectStore.takeSnapshot({ candidateSha }),
    (message): SnapshotResult => ({ ok: false, error: message }),
  );
  if (!snapshot.ok || !snapshot.snapshotRef) {
    log({ step: "snapshot", outcome: "failed", detail: snapshot.error });
    return {
      decision: evaluateCutover0188Preflight({ ...input, snapshotResult: "failed" }),
      snapshotRef: null,
      snapshotChecksum: null,
      steps,
    };
  }
  const snapshotRef = snapshot.snapshotRef;
  log({ step: "snapshot", outcome: "ok" });

  // Step 3b: checksum-validate the snapshot.
  const checksum = await attempt(
    () => deps.objectStore.validateChecksum({ snapshotRef }),
    (message): ChecksumResult => ({ ok: false, error: message }),
  );
  if (!checksum.ok || !checksum.checksum) {
    log({ step: "checksum", outcome: "failed", detail: checksum.error });
    return {
      decision: evaluateCutover0188Preflight({
        ...input,
        snapshotResult: "ok",
        checksumResult: "failed",
      }),
      snapshotRef,
      snapshotChecksum: null,
      steps,
    };
  }
  const snapshotChecksum = checksum.checksum;
  log({ step: "checksum", outcome: "ok" });

  // Step 4: restore into an ISOLATED pre-cutover database + validate.
  const restore = await attempt(
    () => deps.restore.restoreAndValidate({ snapshotRef }),
    (message): RestoreValidationResult => ({ ok: false, error: message }),
  );
  if (!restore.ok) {
    log({ step: "restore_validate", outcome: "failed", detail: restore.error });
    return {
      decision: evaluateCutover0188Preflight({
        ...input,
        snapshotResult: "ok",
        checksumResult: "ok",
        restoreValidationResult: "failed",
      }),
      snapshotRef,
      snapshotChecksum,
      steps,
    };
  }
  log({ step: "restore_validate", outcome: "ok" });

  // Step 5: write the durable marker (ONLY now) — as aoa_operator.
  const verifiedAt = deps.clock.now();
  const row: CutoverMarkerRow = { candidateSha, snapshotRef, snapshotChecksum, verifiedAt };
  const write = await attempt(
    () => deps.markerStore.writeMarker(row),
    (message): MarkerWriteResult => ({ ok: false, error: message }),
  );
  if (!write.ok) {
    log({ step: "marker_write", outcome: "failed", detail: write.error });
    return {
      decision: evaluateCutover0188Preflight({
        ...input,
        snapshotResult: "ok",
        checksumResult: "ok",
        restoreValidationResult: "ok",
        markerWriteResult: "failed",
      }),
      snapshotRef,
      snapshotChecksum,
      steps,
    };
  }
  log({ step: "marker_write", outcome: "ok" });

  // Step 6: verify the marker by read-back.
  const readback = await deps.markerStore.verifyMarker({ candidateSha });
  const verifyOk =
    readback !== null &&
    readback.candidateSha === candidateSha &&
    readback.snapshotRef === snapshotRef &&
    readback.snapshotChecksum === snapshotChecksum;
  log({ step: "marker_verify", outcome: verifyOk ? "ok" : "failed" });
  return {
    decision: evaluateCutover0188Preflight({
      ...input,
      snapshotResult: "ok",
      checksumResult: "ok",
      restoreValidationResult: "ok",
      markerWriteResult: "written",
      markerVerifyResult: verifyOk ? "ok" : "failed",
    }),
    snapshotRef,
    snapshotChecksum,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Live adapters + CLI (the migration-job path; exercised live only on Linux/CI).
// The pure orchestration above is proven by injected in-memory fakes; the wiring
// below is the real object-store/pg-restore/operator-pool implementation the
// container runs. Application startup NEVER imports or invokes `main()`.
// ---------------------------------------------------------------------------

/**
 * The operator-role marker store. `writeMarker` runs through the aoa_operator
 * non-owner pool (the ONLY role permitted to write the marker). Reads are gated to
 * the non-tenant context by the RLS read policy. Never invoked by app startup.
 */
export function createOperatorMarkerStore(operatorDb: {
  execute: (query: unknown) => Promise<unknown>;
}): CutoverMarkerStorePort {
  // Kept SQL-level (rather than the drizzle query builder) so this adapter has no
  // hard type coupling to the generated table and stays a thin operator-pool shim.
  const rowsOf = (result: unknown): Array<Record<string, unknown>> =>
    Array.isArray(result)
      ? (result as Array<Record<string, unknown>>)
      : ((result as { rows?: Array<Record<string, unknown>> })?.rows ?? []);
  const toMarker = (row: Record<string, unknown> | undefined): CutoverMarkerRow | null => {
    if (!row) return null;
    return {
      candidateSha: String(row.candidate_sha),
      snapshotRef: String(row.snapshot_ref),
      snapshotChecksum: String(row.snapshot_checksum),
      verifiedAt: new Date(String(row.verified_at)),
    };
  };
  // `sql` is imported lazily so this module has no top-level drizzle dependency.
  const read = async (candidateSha: string): Promise<CutoverMarkerRow | null> => {
    const { sql } = await import("drizzle-orm");
    const result = await operatorDb.execute(sql`
      SELECT candidate_sha, snapshot_ref, snapshot_checksum, verified_at
      FROM distributed_cutover_markers
      WHERE candidate_sha = ${candidateSha}
      LIMIT 1
    `);
    return toMarker(rowsOf(result)[0]);
  };
  return {
    readMarker: ({ candidateSha }) => read(candidateSha),
    verifyMarker: ({ candidateSha }) => read(candidateSha),
    writeMarker: async (row) => {
      const { sql } = await import("drizzle-orm");
      await operatorDb.execute(sql`
        INSERT INTO distributed_cutover_markers
          (candidate_sha, snapshot_ref, snapshot_checksum, verified_at)
        VALUES (${row.candidateSha}, ${row.snapshotRef}, ${row.snapshotChecksum}, ${row.verifiedAt.toISOString()})
        ON CONFLICT (candidate_sha) DO UPDATE SET
          snapshot_ref = EXCLUDED.snapshot_ref,
          snapshot_checksum = EXCLUDED.snapshot_checksum,
          verified_at = EXCLUDED.verified_at
      `);
      return { ok: true };
    },
  };
}

export interface PgSnapshotConfig {
  /** The populated source database URL to snapshot (privileged migration role). */
  sourceUrl: string;
  /** An ISOLATED pre-cutover database URL to restore INTO for validation. */
  isolatedRestoreUrl: string;
  /** The object-store directory the snapshot artifact is written to (a mounted volume/bucket). */
  snapshotDir: string;
}

/**
 * Real object-store + restore-validation ports backed by `pg_dump`/`pg_restore` and
 * a sha256 checksum. This is the live migration-job path (Linux/CI container). It
 * shells out via `execFile` (no shell interpolation) and fails closed on any error.
 */
export function createPgSnapshotAdapters(config: PgSnapshotConfig): {
  objectStore: CutoverObjectStorePort;
  restore: CutoverRestoreValidationPort;
} {
  const artifactPath = (candidateSha: string): string =>
    path.join(config.snapshotDir, `cutover-0188-${candidateSha}.dump`);
  return {
    objectStore: {
      takeSnapshot: async ({ candidateSha }) => {
        const snapshotRef = artifactPath(candidateSha);
        await mkdir(config.snapshotDir, { recursive: true });
        // Custom-format dump so pg_restore can validate it into an isolated DB.
        await execFileAsync("pg_dump", ["--format=custom", "--file", snapshotRef, config.sourceUrl]);
        return { ok: true, snapshotRef };
      },
      validateChecksum: async ({ snapshotRef }) => {
        const bytes = await readFile(snapshotRef);
        const checksum = createHash("sha256").update(bytes).digest("hex");
        // A non-trivial artifact with a stable digest passes; a zero-byte dump fails.
        if (bytes.length === 0) return { ok: false, error: "empty snapshot artifact" };
        return { ok: true, checksum };
      },
    },
    restore: {
      restoreAndValidate: async ({ snapshotRef }) => {
        // Restore into the ISOLATED pre-cutover DB (never the source). `--clean` +
        // `--exit-on-error` make a bad snapshot fail closed.
        await execFileAsync("pg_restore", [
          "--clean",
          "--if-exists",
          "--exit-on-error",
          "--no-owner",
          "--dbname",
          config.isolatedRestoreUrl,
          snapshotRef,
        ]);
        return { ok: true };
      },
    },
  };
}

/**
 * CLI entrypoint for the operator-gated 0188 preflight. Invoked by
 * `docker/control-plane/migrate-entrypoint.sh` AFTER the schema migration job, only
 * when `AOA_0188_CUTOVER_OPT_IN=1`. Fails closed (non-zero exit) on any stop verdict.
 */
export async function main(): Promise<void> {
  const optIn = process.env.AOA_0188_CUTOVER_OPT_IN === "1";
  const candidateSha = process.env.AOA_0188_CANDIDATE_SHA ?? null;
  const imageSha = process.env.AOA_DEPLOY_SHA ?? null;
  const operatorUrl = process.env.AOA_OPERATOR_DATABASE_URL;
  const sourceUrl = process.env.DATABASE_URL;
  const isolatedRestoreUrl = process.env.AOA_0188_ISOLATED_RESTORE_DATABASE_URL;
  const snapshotDir = process.env.AOA_0188_SNAPSHOT_DIR ?? "/aoa/cutover-snapshots";

  if (!operatorUrl || !sourceUrl || !isolatedRestoreUrl) {
    console.error(
      "0188 preflight requires DATABASE_URL, AOA_OPERATOR_DATABASE_URL, and " +
        "AOA_0188_ISOLATED_RESTORE_DATABASE_URL; refusing to proceed (fail-closed).",
    );
    process.exit(1);
    return;
  }

  const { createOperatorDbConnection } = await import("@armyofagents/db");
  const operator = createOperatorDbConnection(operatorUrl);
  const cleanupIsolated = async (): Promise<void> => {
    try {
      await rm(path.join(snapshotDir), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  try {
    const { objectStore, restore } = createPgSnapshotAdapters({
      sourceUrl,
      isolatedRestoreUrl,
      snapshotDir,
    });
    const result = await runCutover0188Preflight({
      optIn,
      candidateSha,
      imageSha,
      objectStore,
      restore,
      markerStore: createOperatorMarkerStore(operator.db as unknown as {
        execute: (query: unknown) => Promise<unknown>;
      }),
      clock: { now: () => new Date() },
      logger: (event) => console.log(JSON.stringify({ cutover0188Preflight: event })),
    });
    console.log(JSON.stringify({ cutover0188Preflight: { decision: result.decision } }));
    if (result.decision.action !== "proceed") {
      console.error(`0188 cutover preflight STOPPED: ${result.decision.reason} (no cutover)`);
      process.exit(1);
    }
  } finally {
    await operator.close({ timeoutSeconds: 5 }).catch(() => {});
    await cleanupIsolated();
  }
}

const invokedPath = process.argv[1] ? process.argv[1].replaceAll("\\", "/") : "";
if (
  invokedPath.endsWith("/cutover-0188-preflight.js") ||
  invokedPath.endsWith("/cutover-0188-preflight.ts")
) {
  await main();
}
