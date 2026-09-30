import { Router } from "express";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { heartbeatRuns, issues } from "@armyofagents/db";
import { confirmDetectedOutputSchema } from "@armyofagents/shared";
import type { DetectedOutput, DetectedOutputForUI } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { artifactService, logActivity, taskOutputService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { registerIssueParamNormalizer } from "./issue-param-normalizer.js";

// ---------------------------------------------------------------------------
// Transactional core (A-M9)
//
// The confirm/dismiss flow is a read-modify-write over the entire
// heartbeat_runs.detectedOutputs JSONB array. Without serialization, two
// concurrent confirms/dismisses on different indices both read the same
// snapshot and the last write-back clobbers the other's mutation (lost
// update). A re-confirm of an already-confirmed index can also create a
// duplicate artifact version because the `status !== 'pending'` guard was read
// from a stale, unlocked snapshot.
//
// These cores wrap the whole read-modify-write in db.transaction and take a
// `FOR NO KEY UPDATE` row lock on the heartbeat_runs row first, so concurrent
// confirms/dismisses on the same run serialize. The pending-guard is re-checked
// against the FRESH (locked) read, and every service write inside the tx is
// performed through a tx-scoped service instance (artifactService(tx),
// taskOutputService(tx), logActivity(tx, ...)) so the whole unit commits or
// rolls back atomically.
// ---------------------------------------------------------------------------

type ActorInfo = ReturnType<typeof getActorInfo>;

interface ConfirmInput {
  runId: string;
  index: number;
  actor: ActorInfo;
  body: { artifactId?: string; title?: string; type?: string; changelog?: string };
  /** Authorization gate, invoked with the company that owns the run (under lock). */
  assertAccess: (companyId: string) => Promise<void>;
}

interface DismissInput {
  runId: string;
  index: number;
  /** Authorization gate, invoked with the company that owns the run (under lock). */
  assertAccess: (companyId: string) => Promise<void>;
}

type CoreResult<TOk> = { ok: true; value: TOk } | { ok: false; status: number; error: string };

export interface ConfirmDetectedOutputResult {
  artifactId: string;
  versionId: string;
  status: "confirmed";
}

/**
 * Lock the heartbeat_runs row with `FOR NO KEY UPDATE` and return the fresh
 * (post-lock) run row, or null when the run does not exist. NO KEY UPDATE is
 * sufficient to serialize writers to this row without blocking unrelated FK
 * references to heartbeat_runs.
 */
async function lockAndReadRun(tx: Db, runId: string) {
  await tx.execute(
    sql`select id from ${heartbeatRuns} where ${heartbeatRuns.id} = ${runId} for no key update`,
  );
  return tx
    .select({
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      detectedOutputs: heartbeatRuns.detectedOutputs,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
}

/**
 * Confirm a detected output → create artifact/version, upsert the task output,
 * and flip the JSONB entry to `confirmed`. All under a single transaction with
 * the run row locked FOR NO KEY UPDATE.
 */
export async function confirmDetectedOutputCore(
  db: Db,
  input: ConfirmInput,
): Promise<CoreResult<ConfirmDetectedOutputResult>> {
  const { runId, index, actor, body, assertAccess } = input;

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;

    const run = await lockAndReadRun(tx, runId);
    if (!run) {
      return { ok: false, status: 404, error: "Heartbeat run not found" };
    }
    await assertAccess(run.companyId);

    const outputs = run.detectedOutputs as unknown as DetectedOutput[] | null;
    if (!outputs || index >= outputs.length) {
      return { ok: false, status: 404, error: "Detected output not found at index" };
    }

    // Re-check the pending guard against the FRESH, locked read. A concurrent
    // confirm/dismiss that committed first will have flipped this away from
    // "pending", and we must NOT create a second artifact version.
    const output = outputs[index];
    if (output.status !== "pending") {
      return { ok: false, status: 409, error: `Output already ${output.status}` };
    }

    if (!output.assetId) {
      return { ok: false, status: 422, error: "Output has no stored asset" };
    }

    // Tx-scoped service instances: every downstream write commits/rolls back
    // with this transaction.
    const artifactSvc = artifactService(tx);
    const taskOutputSvc = taskOutputService(tx);

    const fileUrl = `/api/assets/${output.assetId}/content`;
    const { artifactId, title, type, changelog } = body;
    const issueId = (run.contextSnapshot as Record<string, unknown> | null)?.issueId as
      | string
      | undefined;

    let confirmedArtifactId: string;
    let confirmedVersionId: string;
    let issueForOutput: { artifactId: string | null; projectId: string | null } | null = null;

    if (issueId) {
      issueForOutput = await tx
        .select({ artifactId: issues.artifactId, projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null);
    }

    if (artifactId) {
      const existingArtifact = await artifactSvc.getById(artifactId);
      if (!existingArtifact) {
        return { ok: false, status: 404, error: "Artifact not found" };
      }
      if (existingArtifact.companyId !== run.companyId) {
        return { ok: false, status: 403, error: "Artifact does not belong to this company" };
      }

      // Add version to existing artifact
      const version = await artifactSvc.addVersion(artifactId, {
        source: "agent",
        sourceDetail: run.agentId,
        changelog: changelog ?? `Captured from agent output: ${output.filename}`,
        fileUrl,
      });
      confirmedArtifactId = artifactId;
      confirmedVersionId = version.id;
    } else {
      // Create new artifact with initial version
      const artifact = await artifactSvc.create(run.companyId, actor.actorId, {
        title: title ?? output.filename,
        type: type ?? inferArtifactType(output),
        source: "agent",
        sourceDetail: run.agentId,
        changelog: changelog ?? `Captured from agent output: ${output.filename}`,
        fileUrl,
      });
      confirmedArtifactId = artifact.id;
      confirmedVersionId = artifact.versions[0]?.id ?? artifact.id;

      // Link to task if issue has no artifact yet
      if (issueId && issueForOutput && !issueForOutput.artifactId) {
        await tx
          .update(issues)
          .set({ artifactId: confirmedArtifactId, updatedAt: new Date() })
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
      }
    }

    if (issueId && issueForOutput) {
      await taskOutputSvc.upsertForIssue(run.companyId, issueId, {
        type: artifactId ? "artifact_version" : "artifact",
        provider: "aoa",
        externalId: `detected-output:${runId}:${index}`,
        artifactId: confirmedArtifactId,
        artifactVersionId: confirmedVersionId,
        assetId: output.assetId,
        title: output.filename,
        status: "active",
        reviewState: "needs_review",
        isPrimary: !artifactId && !issueForOutput.artifactId,
        healthStatus: "unknown",
        summary: output.label ?? null,
        metadata: {
          path: output.path,
          contentType: output.contentType,
          byteSize: output.byteSize,
          sha256: output.sha256,
          source: output.source,
        },
        createdByRunId: runId,
        createdByAgentId: run.agentId,
      });
    }

    // Update the JSONB array item (write-back on tx)
    const updatedOutputs = [...outputs];
    updatedOutputs[index] = {
      ...output,
      status: "confirmed",
      confirmedArtifactId,
      confirmedVersionId,
    };

    await tx
      .update(heartbeatRuns)
      .set({
        detectedOutputs: updatedOutputs as unknown as Array<Record<string, unknown>>,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));

    await logActivity(tx, {
      companyId: run.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "artifact.output_confirmed",
      entityType: "artifact",
      entityId: confirmedArtifactId,
      details: {
        runId,
        filename: output.filename,
        versionId: confirmedVersionId,
      },
    });

    return {
      ok: true,
      value: {
        artifactId: confirmedArtifactId,
        versionId: confirmedVersionId,
        status: "confirmed" as const,
      },
    };
  });
}

/**
 * Dismiss a detected output → flip the JSONB entry to `dismissed`. Under a
 * single transaction with the run row locked FOR NO KEY UPDATE so it cannot
 * clobber a concurrent confirm/dismiss on a sibling index.
 */
export async function dismissDetectedOutputCore(
  db: Db,
  input: DismissInput,
): Promise<CoreResult<{ status: "dismissed" }>> {
  const { runId, index, assertAccess } = input;

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;

    const run = await lockAndReadRun(tx, runId);
    if (!run) {
      return { ok: false, status: 404, error: "Heartbeat run not found" };
    }
    await assertAccess(run.companyId);

    const outputs = run.detectedOutputs as unknown as DetectedOutput[] | null;
    if (!outputs || index >= outputs.length) {
      return { ok: false, status: 404, error: "Detected output not found at index" };
    }

    const output = outputs[index];
    if (output.status !== "pending") {
      return { ok: false, status: 409, error: `Output already ${output.status}` };
    }

    const updatedOutputs = [...outputs];
    updatedOutputs[index] = { ...output, status: "dismissed" };

    await tx
      .update(heartbeatRuns)
      .set({
        detectedOutputs: updatedOutputs as unknown as Array<Record<string, unknown>>,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));

    return { ok: true, value: { status: "dismissed" as const } };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function outputDetectionRoutes(db: Db) {
  const router = Router();
  registerIssueParamNormalizer(router, db, ["issueId"]);

  // ── List detected outputs for a task (aggregated from all runs) ──────
  router.get("/issues/:issueId/detected-outputs", async (req, res) => {
    const issueId = req.params.issueId as string;

    // Verify issue exists and check access
    const issue = await db
      .select({ companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    if (!issue) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);

    // Query runs that have detected outputs for this issue
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        detectedOutputs: heartbeatRuns.detectedOutputs,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          isNotNull(heartbeatRuns.detectedOutputs),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
        ),
      );

    // Flatten into a single list, preserving each item's index within its run
    const result: DetectedOutputForUI[] = [];
    for (const run of runs) {
      const outputs = run.detectedOutputs as unknown as DetectedOutput[] | null;
      if (!outputs) continue;
      for (let i = 0; i < outputs.length; i++) {
        result.push({
          ...outputs[i],
          runId: run.id,
          runFinishedAt: run.finishedAt?.toISOString() ?? null,
          outputIndex: i,
        });
      }
    }

    res.json(result);
  });

  // ── List detected outputs for a specific run ────────────────────────
  router.get("/heartbeat-runs/:runId/detected-outputs", async (req, res) => {
    const runId = req.params.runId as string;

    const run = await db
      .select({
        companyId: heartbeatRuns.companyId,
        detectedOutputs: heartbeatRuns.detectedOutputs,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    await assertCompanyAccess(db, req, run.companyId);

    const outputs = (run.detectedOutputs as unknown as DetectedOutput[] | null) ?? [];
    const result: DetectedOutputForUI[] = outputs.map((o, i) => ({
      ...o,
      runId,
      runFinishedAt: run.finishedAt?.toISOString() ?? null,
      outputIndex: i,
    }));

    res.json(result);
  });

  // ── Confirm a detected output → create artifact/version ─────────────
  router.post(
    "/heartbeat-runs/:runId/detected-outputs/:index/confirm",
    validate(confirmDetectedOutputSchema),
    async (req, res) => {
      const runId = req.params.runId as string;
      const index = parseInt(req.params.index as string, 10);

      if (!Number.isFinite(index) || index < 0) {
        res.status(400).json({ error: "Invalid output index" });
        return;
      }

      const actor = getActorInfo(req);
      const result = await confirmDetectedOutputCore(db, {
        runId,
        index,
        actor,
        body: req.body,
        assertAccess: async (companyId) => { await assertCompanyAccess(db, req, companyId); },
      });

      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      res.status(200).json(result.value);
    },
  );

  // ── Dismiss a detected output ───────────────────────────────────────
  router.post("/heartbeat-runs/:runId/detected-outputs/:index/dismiss", async (req, res) => {
    const runId = req.params.runId as string;
    const index = parseInt(req.params.index as string, 10);

    if (!Number.isFinite(index) || index < 0) {
      res.status(400).json({ error: "Invalid output index" });
      return;
    }

    const result = await dismissDetectedOutputCore(db, {
      runId,
      index,
      assertAccess: async (companyId) => { await assertCompanyAccess(db, req, companyId); },
    });

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.status(200).json(result.value);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferArtifactType(output: DetectedOutput): string {
  const ext = output.filename.split(".").pop()?.toLowerCase();

  const codeExts = new Set([
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java",
    "c", "cpp", "h", "hpp", "rb", "php", "swift", "kt", "scala", "sh",
    "bash", "zsh", "ps1", "sql", "vue", "svelte",
  ]);
  const docExts = new Set(["md", "mdx", "txt", "csv", "html", "htm"]);
  const designExts = new Set(["svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "fig"]);
  const presentationExts = new Set(["pptx", "ppt", "key"]);

  if (output.artifactType) return output.artifactType;
  if (ext && codeExts.has(ext)) return "code";
  if (ext && docExts.has(ext)) return "document";
  if (ext && designExts.has(ext)) return "design";
  if (ext && presentationExts.has(ext)) return "presentation";
  if (ext === "pdf" || ext === "docx") return "document";
  if (ext === "xlsx") return "report";

  return "other";
}
