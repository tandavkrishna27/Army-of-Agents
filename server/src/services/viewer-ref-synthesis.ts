// server/src/services/viewer-ref-synthesis.ts
//
// Post-run synthesis of the NAVIGATIONAL ShowRefs a crew run delivers onto its
// originating Discussion thread when the run finishes (Viewer Upgrade Phase 7B).
//
// AGGREGATE SEMANTICS (locked decision, 2026-07-19): this returns the task's
// CURRENT products — its task ref + its current artifacts + its task_outputs —
// NOT "this run created these". Every synthesized ref carries action:"referenced";
// the provenance (surface:"discussion", entityId:threadId, runId, agentId)
// identifies WHO delivered the products, not per-product authorship. Precise
// per-run correlation (which output was born this run) is deferred: task_outputs
// already has `createdByRunId` (→ heartbeat_runs), but crew's attach path does
// not stamp it, so a future precise-correlation phase would filter/stamp there.
//
// The task_outputs → ref mapping is FIELD-AWARE over the real 9-value type enum
// (`packages/shared/src/validators/task-output.ts`): we branch on which
// supporting field is populated (artifactId > url > else), not on the type name,
// so a malformed row (e.g. a `preview_url` with a null url) degrades safely to a
// by-id `output` ref instead of crashing.
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { issues } from "@armyofagents/db";
import {
  MAX_OUTPUT_REF_TITLE_LENGTH,
  type ShowRef,
  type ShowRefProvenance,
} from "@armyofagents/shared";
import { taskOutputService } from "./task-outputs.js";
import { mergeOutputRefs } from "./internal-agent/output-refs.js";

export interface SynthesizeThreadDeliveryRefsInput {
  db: Db;
  companyId: string;
  issueId: string;
  /** The origin Discussion thread the products are delivered onto. */
  threadId: string;
  /** The finishing crew run (provenance — who delivered). */
  runId: string | null;
  /** The delivering agent (provenance — who delivered). */
  agentId: string | null;
}

function asId(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asTitle(v: unknown): string | null {
  return typeof v === "string" && v.length > 0
    ? v.slice(0, MAX_OUTPUT_REF_TITLE_LENGTH)
    : null;
}

/**
 * Synthesize the navigational ShowRefs to deliver when a crew run finishes.
 *
 * Order (before dedup/cap):
 *   1. exactly one `task` ref (always) — the delivered task itself.
 *   2. one ref per `task_outputs` row, mapped field-aware.
 *   3. one `artifact` ref for the task's primary artifact (`issues.artifactId`),
 *      if set (deduped against a task_output artifact of the same identity).
 * Then dedup + cap via `mergeOutputRefs` (dedup key = kind|id|versionId; cap =
 * MAX_OUTPUT_REFS_PER_MESSAGE). An empty issue yields just the task ref.
 */
export async function synthesizeThreadDeliveryRefs(
  input: SynthesizeThreadDeliveryRefsInput,
): Promise<ShowRef[]> {
  const { db, companyId, issueId, threadId, runId, agentId } = input;

  // Single wall-clock stamp for the whole delivery; per-ref seq allocated below.
  const emittedAt = new Date().toISOString();
  let seq = 0;
  const provenance = (): ShowRefProvenance => ({
    surface: "discussion",
    entityId: threadId,
    runId: runId ?? null,
    agentId: agentId ?? null,
    messageId: null,
    seq: seq++,
    emittedAt,
  });

  function makeRef(
    kind: "task" | "artifact" | "url" | "output",
    id: string,
    opts: { versionId?: string | null; title?: string | null } = {},
  ): ShowRef {
    return {
      v: 2,
      kind,
      id,
      versionId: opts.versionId ?? null,
      versionNumber: null,
      title: opts.title ?? null,
      action: "referenced",
      toolCallId: null,
      mimeType: null,
      provenance: provenance(),
    };
  }

  const refs: ShowRef[] = [];

  // ── 1. Read the issue row (for the task's primary artifact) ───────────────
  const issueRows = await db
    .select({ id: issues.id, artifactId: issues.artifactId })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const issue = (issueRows[0] ?? null) as { id: string; artifactId: string | null } | null;

  // ── 2. Task ref (always emitted) ──────────────────────────────────────────
  refs.push(makeRef("task", issueId));

  // ── 3. task_outputs → field-aware refs ────────────────────────────────────
  const outputs = await taskOutputService(db).listForIssue(companyId, issueId);
  for (const row of outputs) {
    const title = asTitle(row.title);
    const artifactId = asId(row.artifactId);
    const url = asId(row.url);
    if (artifactId) {
      // `artifact` / `artifact_version` (or any artifact-bearing row).
      refs.push(makeRef("artifact", artifactId, { versionId: asId(row.artifactVersionId), title }));
    } else if (url) {
      // `preview_url` / `pull_request` / `branch` / `commit` / `external_link`.
      // A url ref's `id` IS the target URL (per showRefV2Schema).
      refs.push(makeRef("url", url, { title }));
    } else {
      // `detected_file` / `runtime_service` / asset-bearing — AND the safe
      // fallback for any malformed row missing its expected supporting field.
      // Opens via the output tab body, which self-resolves by row id.
      const rowId = asId(row.id);
      if (rowId) refs.push(makeRef("output", rowId, { title }));
    }
  }

  // ── 4. Task's primary artifact ───────────────────────────────────────────
  // Skip if a task_output above already produced an artifact ref for the SAME
  // artifact id — even at a different version. `mergeOutputRefs` dedups on
  // `kind|id|versionId`, so a versioned task_output artifact (`artifact|X|v123`,
  // the common attach_task_artifact case) would NOT collide with this
  // null-version primary (`artifact|X|`) → two chips for one artifact. Guard by
  // artifact id, ignoring version, so the richer versioned ref wins.
  const taskArtifactId = asId(issue?.artifactId);
  if (
    taskArtifactId &&
    !refs.some((r) => r.kind === "artifact" && r.id === taskArtifactId)
  ) {
    refs.push(makeRef("artifact", taskArtifactId));
  }

  // ── 5. Dedup (kind|id|versionId) + cap at MAX_OUTPUT_REFS_PER_MESSAGE ─────
  // The task ref is emitted first, so it survives the cap slice.
  return mergeOutputRefs([], refs);
}
