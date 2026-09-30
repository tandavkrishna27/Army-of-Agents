// server/src/services/internal-agent/output-refs.ts
//
// Pure ref-builder for the Commander viewer.
// Called from the MCP bridge with (toolName, args, structured ToolResult).
// MUST NEVER THROW — a ref bug can't be allowed to fail a tool call.
import {
  MAX_OUTPUT_REFS_PER_MESSAGE,
  MAX_OUTPUT_REF_TITLE_LENGTH,
  showRefsSchema,
  type ShowRef,
  type ShowRefProvenance,
  type ShowRefSurface,
} from "@armyofagents/shared";
import type { ToolResult } from "./types.js";
import type { AgentStreamChunk } from "./agent-loop.js";

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function asId(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asTitle(v: unknown): string | null {
  return typeof v === "string" && v.length > 0
    ? v.slice(0, MAX_OUTPUT_REF_TITLE_LENGTH)
    : null;
}
function asVersionNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * Emission context threaded from the MCP bridge. `provenanceBase` carries the
 * per-turn who/where/when (surface/entity/run/agent/emittedAt); `nextSeq` is a
 * PER-REF ordering allocator (a module-level counter in the bridge subprocess).
 * `entityId` may be null (a Commander turn without a conversation) — in that
 * case the emitted ref carries `provenance: null` (still v2, never v1).
 */
export interface OutputRefProvenanceBase {
  surface: ShowRefSurface;
  entityId: string | null;
  runId: string | null;
  agentId: string | null;
  messageId: string | null;
  emittedAt: string;
}
export interface OutputRefEmitCtx {
  provenanceBase: OutputRefProvenanceBase | null;
  /** Called ONCE per ref actually emitted — each ref gets a distinct, contiguous seq. */
  nextSeq: () => number;
}

function buildProvenance(ctx?: OutputRefEmitCtx): ShowRefProvenance | null {
  const base = ctx?.provenanceBase;
  // Schema forbids an empty entityId — a null conversation → provenance: null.
  if (!ctx || !base || !base.entityId) return null;
  return {
    surface: base.surface,
    entityId: base.entityId,
    runId: base.runId,
    agentId: base.agentId,
    messageId: base.messageId,
    emittedAt: base.emittedAt,
    seq: ctx.nextSeq(),
  };
}

function artifactRef(
  partial: {
    id: string | null;
    versionId?: unknown;
    versionNumber?: unknown;
    title?: unknown;
    action: "created" | "referenced";
  },
  ctx?: OutputRefEmitCtx,
): ShowRef | null {
  if (!partial.id) return null;
  return {
    v: 2,
    kind: "artifact",
    id: partial.id,
    versionId: asId(partial.versionId) ?? null,
    versionNumber: asVersionNumber(partial.versionNumber),
    title: asTitle(partial.title),
    action: partial.action,
    toolCallId: null,
    mimeType: null,
    provenance: buildProvenance(ctx),
  };
}

/**
 * Build a NAVIGATIONAL (pointer) ref — task / memory_item / approval. Unlike
 * `artifactRef` these carry no versionId/versionNumber: they point at a live
 * entity the viewer resolves by id on open. Returns null when `id` is absent
 * (a failed/empty tool result must emit no ref — the schema would reject an
 * empty id anyway; we fail gracefully instead).
 */
function navRef(
  partial: {
    kind: "task" | "memory_item" | "approval";
    id: string | null;
    action: "created" | "referenced";
  },
  ctx?: OutputRefEmitCtx,
): ShowRef | null {
  if (!partial.id) return null;
  return {
    v: 2,
    kind: partial.kind,
    id: partial.id,
    versionId: null,
    versionNumber: null,
    title: null,
    action: partial.action,
    toolCallId: null,
    mimeType: null,
    provenance: buildProvenance(ctx),
  };
}

function refsFromRows(data: unknown, ctx?: OutputRefEmitCtx): ShowRef[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => {
      const r = asRecord(row);
      return artifactRef(
        {
          id: asId(r.artifactId),
          versionId: r.currentVersionId,
          title: r.title,
          action: "referenced",
        },
        ctx,
      );
    })
    .filter((r): r is ShowRef => r !== null);
}

export function buildOutputRefs(
  toolName: string,
  params: unknown,
  result: ToolResult,
  ctx?: OutputRefEmitCtx,
): ShowRef[] {
  try {
    if (!result || result.success !== true) return [];
    const p = asRecord(params);
    const d = asRecord(result.data);

    let refs: ShowRef[] = [];
    switch (toolName) {
      case "create_artifact": {
        const ref = artifactRef(
          {
            id: asId(d.artifactId),
            versionId: d.versionId,
            // create() makes the first version when content/fileRef given.
            versionNumber: asId(d.versionId) ? 1 : null,
            title: p.title,
            action: "created",
          },
          ctx,
        );
        refs = ref ? [ref] : [];
        break;
      }
      case "create_artifact_version": {
        const ref = artifactRef(
          {
            id: asId(p.artifactId),
            versionId: d.versionId,
            versionNumber: d.versionNumber,
            title: null,
            action: "created",
          },
          ctx,
        );
        refs = ref ? [ref] : [];
        break;
      }
      case "attach_task_artifact": {
        // Return shape verified: data: { artifactId, versionId, taskOutputId }
        // (attach-task-artifact-tool.ts lines 170-178)
        const ref = artifactRef(
          {
            id: asId(d.artifactId),
            versionId: d.versionId ?? d.artifactVersionId,
            title: p.title,
            action: "created",
          },
          ctx,
        );
        refs = ref ? [ref] : [];
        break;
      }
      case "query_artifacts":
      case "query_company_artifacts":
        // Dedupe BEFORE capping: query_artifacts inner-joins attachments, so one
        // artifact attached to N entries yields N duplicate rows (review T2 #1).
        // seq is allocated per row inside refsFromRows (before dedup).
        refs = mergeOutputRefs([], refsFromRows(result.data, ctx));
        break;
      case "get_task": {
        const ref = artifactRef(
          {
            id: asId(d.artifactId),
            title: d.title, // task title fallback; viewer resolves real name on open
            action: "referenced",
          },
          ctx,
        );
        refs = ref ? [ref] : [];
        break;
      }
      // ── Navigational (Tier-3) — Commander's internal-agent tools ──
      // Result shapes verified against the handlers (file:line noted per case).
      case "create_task": {
        // action-tools.ts:65 → data: issue row (id at data.id).
        const ref = navRef({ kind: "task", id: asId(d.id), action: "created" }, ctx);
        refs = ref ? [ref] : [];
        break;
      }
      case "update_task": {
        // action-tools.ts:97 → data: issue row | null (id at data.id).
        const ref = navRef({ kind: "task", id: asId(d.id), action: "referenced" }, ctx);
        refs = ref ? [ref] : [];
        break;
      }
      case "suggest_memory": {
        // memory-tools.ts:292 → data: memory item row (id at data.id).
        const ref = navRef({ kind: "memory_item", id: asId(d.id), action: "created" }, ctx);
        refs = ref ? [ref] : [];
        break;
      }
      case "write_memory":
      case "propose_memory_from_thread": {
        // memory-write.ts:209 / memory-propose.ts:308 → data: { memoryItemId }.
        // (propose's gated controller path returns { actionId, queued } with no
        // memoryItemId → asId returns null → no ref, which is correct.)
        const ref = navRef(
          { kind: "memory_item", id: asId(d.memoryItemId), action: "created" },
          ctx,
        );
        refs = ref ? [ref] : [];
        break;
      }
      case "approval_decision": {
        // approval-tools.ts:163 → data: approval row (id at data.id). A
        // successful decision always returns the updated row; a failed one
        // returns success:false (already short-circuited above) — so guard on
        // the RESULT id, not the params. Commander only DECIDES existing
        // approvals → action is always "referenced".
        const ref = navRef({ kind: "approval", id: asId(d.id), action: "referenced" }, ctx);
        refs = ref ? [ref] : [];
        break;
      }
      default:
        refs = [];
    }

    // Validate before returning — a malformed ref must not reach the envelope.
    // On failure return [] but LOG it (P2.4): the bridge's outer buildOutputRefs
    // catch never sees this drop (we return [], we don't throw). stderr keeps the
    // JSON-RPC stdout channel clean (matches mcp-bridge.ts's process.stderr.write).
    const parsed = showRefsSchema.safeParse(refs);
    if (!parsed.success) {
      process.stderr.write(
        `output-refs: dropped ${refs.length} ref(s) for '${toolName}' (schema): ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}\n`,
      );
      return [];
    }
    return refs;
  } catch (err) {
    // Builder threw (must never propagate — a ref bug can't fail a tool call).
    // Log so the silent [] is observable; the bridge's outer catch never fires.
    process.stderr.write(
      `output-refs: builder threw for '${toolName}', dropped all refs: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

/** Collect refs from a forwarded chunk into a turn-level sink (mutates sink). */
export function collectChunkRefs(sink: ShowRef[], chunk: AgentStreamChunk): void {
  if (chunk.type === "tool_result" && Array.isArray(chunk.refs) && chunk.refs.length > 0) {
    sink.push(...chunk.refs);
  }
}

// Dedup identity is the ARTIFACT identity `(kind,id,versionId)` — NOT `v`.
// A legacy-replayed v1 ref and a fresh v2 ref for the same artifact are the
// same card; keeping `v` in the key split them into a double-card (B5).
const refKey = (r: ShowRef) => `${r.kind}|${r.id}|${r.versionId ?? ""}`;

const firstStr = (a?: string | null, b?: string | null): string | null =>
  a != null && a !== "" ? a : b != null && b !== "" ? b : null;
const firstNum = (a?: number | null, b?: number | null): number | null =>
  a != null ? a : b != null ? b : null;

// Provenance precedence (order-independent): the v2 provenance wins over a v1
// (which has none); when both are v2 the newer `emittedAt` wins, and a real
// provenance beats a null one. Symmetric so input order can't change the result.
function pickProvenance(a: ShowRef, b: ShowRef): ShowRefProvenance | null {
  const pa = a.v === 2 ? a.provenance ?? null : null;
  const pb = b.v === 2 ? b.provenance ?? null : null;
  if (pa && pb) return pb.emittedAt >= pa.emittedAt ? pb : pa;
  return pa ?? pb ?? null;
}

// FIELD-WISE merge (Codex P2.1): so the STRONGEST action AND the RICHEST
// provenance both survive a collision — never winner-take-all on one whole
// object (that would drop either the created action or the v2 provenance).
function mergeRefPair(a: ShowRef, b: ShowRef): ShowRef {
  const action: "created" | "referenced" =
    a.action === "created" || b.action === "created" ? "created" : "referenced";
  const versionId = firstStr(a.versionId, b.versionId);
  const versionNumber = firstNum(a.versionNumber, b.versionNumber);
  const title = firstStr(a.title, b.title);
  const mimeType = firstStr(a.mimeType, b.mimeType);
  const toolCallId = firstStr(
    a.v === 2 ? a.toolCallId : null,
    b.v === 2 ? b.toolCallId : null,
  );

  // `v` = 2 if either is v2. If both v1, stay v1 (no provenance surface).
  if (a.v !== 2 && b.v !== 2) {
    return {
      v: 1,
      kind: "artifact",
      id: a.id,
      versionId,
      versionNumber,
      title,
      action,
      toolCallId: null,
      mimeType,
    };
  }
  return {
    v: 2,
    kind: a.kind,
    id: a.id,
    versionId,
    versionNumber,
    title,
    mimeType,
    viewerKind: firstStr(
      a.v === 2 ? a.viewerKind : null,
      b.v === 2 ? b.viewerKind : null,
    ),
    action,
    toolCallId,
    provenance: pickProvenance(a, b),
  };
}

export function mergeOutputRefs(
  existing: ShowRef[],
  incoming: ShowRef[],
): ShowRef[] {
  const map = new Map<string, ShowRef>();
  for (const r of [...existing, ...incoming]) {
    const k = refKey(r);
    const prev = map.get(k);
    map.set(k, prev ? mergeRefPair(prev, r) : r);
  }
  const all = [...map.values()];
  if (all.length <= MAX_OUTPUT_REFS_PER_MESSAGE) return all;
  const created = all.filter((r) => r.action === "created");
  const referenced = all.filter((r) => r.action === "referenced");
  return [...created, ...referenced].slice(0, MAX_OUTPUT_REFS_PER_MESSAGE);
}
