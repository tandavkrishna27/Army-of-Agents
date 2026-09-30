// Viewer Upgrade ShowRef — a versioned superset of CommanderOutputRef.
// v:1 (legacy, artifact-only) lives in commander-output-refs.ts and still
// validates here. v:2 adds the expanded kind set + viewerKind + provenance.
// A ref is a presentation pointer — never content, never a capability grant.
// NOTE: a structural mirror (LiftedOutputRef) in
// packages/adapters/codex-local/src/server/parse-shared.ts is widened for v:2
// in Phase 2 (with emission) — not in this phase.
import { z } from "zod";
import {
  MAX_OUTPUT_REFS_PER_MESSAGE,
  MAX_OUTPUT_REF_TITLE_LENGTH,
  commanderOutputRefSchema,
  type CommanderOutputRef,
} from "./commander-output-refs.js";

export const SHOW_REF_KINDS = [
  "artifact",
  "asset",
  "output",
  "task",
  "discussion",
  "approval",
  "memory_item",
  "url",
] as const;
export type ShowRefKind = (typeof SHOW_REF_KINDS)[number];

export const SHOW_REF_SURFACES = ["commander", "discussion", "workspace"] as const;
export type ShowRefSurface = (typeof SHOW_REF_SURFACES)[number];

export interface ShowRefProvenance {
  agentId?: string | null;
  surface: ShowRefSurface;
  entityId: string;
  runId?: string | null;
  messageId?: string | null;
  seq: number;
  emittedAt: string; // ISO-8601
}

export interface ShowRefV2 {
  v: 2;
  kind: ShowRefKind;
  id: string;
  versionId?: string | null;
  versionNumber?: number | null;
  title?: string | null;
  mimeType?: string | null;
  viewerKind?: string | null;
  action: "created" | "referenced"; // REQUIRED (avoids the mergeOutputRefs cap-drop hazard)
  toolCallId?: string | null;
  provenance?: ShowRefProvenance | null;
}

// A ShowRef is either a legacy v:1 CommanderOutputRef or a v:2 ShowRefV2.
export type ShowRef = CommanderOutputRef | ShowRefV2;

export const showRefProvenanceSchema = z.object({
  agentId: z.string().min(1).max(256).nullish(),
  surface: z.enum(SHOW_REF_SURFACES),
  entityId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256).nullish(),
  messageId: z.string().min(1).max(256).nullish(),
  seq: z.number().int().nonnegative(),
  emittedAt: z.string().datetime(),
});

export const showRefV2Schema = z.object({
  v: z.literal(2),
  kind: z.enum(SHOW_REF_KINDS),
  id: z.string().min(1).max(2048), // wider than v1 (256): "url" kind stores the target URL in id
  versionId: z.string().min(1).max(256).nullish(),
  versionNumber: z.number().int().positive().nullish(),
  title: z.string().max(MAX_OUTPUT_REF_TITLE_LENGTH).nullish(),
  mimeType: z.string().min(1).max(256).nullish(),
  viewerKind: z.string().min(1).max(64).nullish(), // open set: resolveViewer safelists the recognized values
  action: z.enum(["created", "referenced"]),
  toolCallId: z.string().min(1).max(256).nullish(),
  provenance: showRefProvenanceSchema.nullish(),
});

export const showRefSchema = z.discriminatedUnion("v", [
  commanderOutputRefSchema,
  showRefV2Schema,
]);

export const showRefsSchema = z.array(showRefSchema).max(MAX_OUTPUT_REFS_PER_MESSAGE);

showRefSchema satisfies z.ZodType<ShowRef>;
