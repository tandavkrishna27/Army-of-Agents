/**
 * U6.5 — Crew A+ capture: sandbox working dir -> `task_outputs`, artifacts
 * founder-gated.
 *
 * The crew A+ model (R1, spec): the sandbox's own working dir IS the per-run
 * workspace — no host worktree, no crew PR in v1. This module pulls produced
 * files out of that sandbox (`collectSandboxDiff`, U6.3) and captures each to
 * `task_outputs` as a `detected_file` row. Artifact VERSIONS still route
 * through founder review-confirmation (Decision #67) — this module NEVER
 * inserts an `artifacts` or `artifact_versions` row itself; it only writes
 * `assets` (raw bytes) + `task_outputs` (review-gated pointer).
 *
 * Crew run-id FK divergence from the org path (U6.3) — see the Wave 4 plan
 * header and runner.ts (`internalAgentRuns` insert, ~:225): a crew run id is
 * minted into `internal_agent_runs`, NOT `heartbeat_runs`, but
 * `task_outputs.createdByRunId` FKs `heartbeat_runs` and
 * `taskOutputService(...).upsertForIssue` asserts it against that table
 * (`assertCompanyOwnedRef(db, heartbeatRuns, input.createdByRunId, …)`,
 * `task-outputs.ts`). Passing a crew run id there FK-fails on insert (and the
 * pre-insert assertion 404s first, since the id doesn't resolve in
 * `heartbeat_runs`). Every row captured here therefore carries
 * `createdByRunId: null` (the FK is nullable and `assertCompanyOwnedRef`
 * short-circuits on `null`) plus `metadata.crewRunId` for provenance, and
 * `createdByAgentId` (which FKs `agents`, a real ref for this actor).
 *
 * Best-effort throughout, matching `crew-run-outcome.ts`'s philosophy: NEVER
 * throws. A whole-batch failure (e.g. `collectSandboxDiff` can't read the
 * sandbox, or the runner doesn't support `readFiles`) is caught and logged,
 * returning whatever was captured before the failure (empty, if nothing
 * was). A single file's capture failure (storage write, asset insert, or
 * task-output upsert) is caught per-file so one bad file does not discard the
 * rest of the batch.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { Db } from "@armyofagents/db";
import { assets } from "@armyofagents/db";
import { logger } from "../../../middleware/logger.js";
import { getStorageService } from "../../../storage/index.js";
import { getContentType } from "../../../mime-types.js";
import { taskOutputService } from "../../task-outputs.js";
import { collectSandboxDiff, type SandboxFileMovementRunner } from "../../sandbox-file-movement.js";

const log = logger.child({ svc: "crew-output-capture" });

export interface CaptureCrewOutputsInput {
  db: Db;
  companyId: string;
  /** Thread-only crew runs (no linked task) have nowhere to attach outputs — guarded, returns `[]`. */
  issueId: string | null | undefined;
  /** The delivering crew agent id — provenance (`createdByAgentId`, FKs `agents`). */
  agentId: string;
  /** The crew run id, minted into `internal_agent_runs` — carried in `metadata.crewRunId`, never `createdByRunId` (see module doc). */
  runId: string;
  runner: SandboxFileMovementRunner;
  remoteCwd: string;
}

export interface CapturedCrewOutput {
  path: string;
  type?: string;
}

/**
 * Pulls produced files out of the crew's in-sandbox working dir and captures
 * each to `task_outputs`. See module doc for the FK divergence + Decision #67
 * founder-gating. NEVER throws.
 */
export async function captureCrewOutputs(
  input: CaptureCrewOutputsInput,
): Promise<CapturedCrewOutput[]> {
  if (!input.issueId) return [];
  const issueId = input.issueId;

  const results: CapturedCrewOutput[] = [];

  try {
    const diff = await collectSandboxDiff({ runner: input.runner, remoteCwd: input.remoteCwd });
    if (diff.length === 0) return [];

    const storage = getStorageService();

    for (const file of diff) {
      try {
        if (file.content.length === 0) continue;

        const filename = path.basename(file.path);
        const contentType = getContentType(filename);
        const sha256 = createHash("sha256").update(file.content).digest("hex");

        const stored = await storage.putFile({
          companyId: input.companyId,
          namespace: "agent-outputs",
          originalFilename: filename,
          contentType,
          body: file.content,
        });

        const [asset] = await input.db
          .insert(assets)
          .values({
            companyId: input.companyId,
            provider: stored.provider,
            objectKey: stored.objectKey,
            contentType: stored.contentType,
            byteSize: stored.byteSize,
            sha256: stored.sha256 ?? sha256,
            originalFilename: stored.originalFilename,
            createdByAgentId: input.agentId,
            createdByUserId: null,
          })
          .returning();

        // Decision #67: `detected_file`, review-gated (`needs_review`) — never
        // an `artifacts`/`artifact_versions` row (founder confirmation is a
        // separate, later step this module does not perform).
        // `createdByRunId: null` + `metadata.crewRunId` — see module doc (the
        // crew run-id FK divergence from the org path).
        await taskOutputService(input.db).upsertForIssue(input.companyId, issueId, {
          type: "detected_file",
          provider: "aoa",
          assetId: asset.id,
          title: filename,
          status: "active",
          reviewState: "needs_review",
          isPrimary: false,
          healthStatus: "unknown",
          createdByAgentId: input.agentId,
          createdByRunId: null,
          metadata: { crewRunId: input.runId },
        });

        results.push({ path: file.path });
      } catch (fileErr) {
        log.warn(
          { err: fileErr, runId: input.runId, issueId, file: file.path },
          "crew output capture: failed to capture file (skipping)",
        );
      }
    }
  } catch (err) {
    log.warn(
      { err, runId: input.runId, issueId },
      "crew output capture failed (non-fatal)",
    );
  }

  return results;
}
