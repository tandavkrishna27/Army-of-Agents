import { z } from "zod";
import { RUNTIME_DECISION_PERMISSION_DECISIONS } from "../hub.js";

/** Destination kinds a Universe draft can target. The submission itself is owned
 * by the destination's canonical service (Commander/task/etc.); this only scopes
 * where the draft text lives. */
export const UNIVERSE_DRAFT_DESTINATION_KINDS = [
  "commander",
  "task",
  "question",
  "runtime_decision",
  "approval",
] as const;
export type UniverseDraftDestinationKind =
  (typeof UNIVERSE_DRAFT_DESTINATION_KINDS)[number];

export const UNIVERSE_DRAFT_SCHEMA_VERSION = 1;
/** Conservative bounds honouring the Commander composer limit; a destination's
 * own validator may be stricter, never broader. */
export const UNIVERSE_DRAFT_MAX_TEXT = 10_000;
export const UNIVERSE_DRAFT_MAX_ATTACHMENTS = 5;

export const draftDestinationSchema = z
  .object({
    kind: z.enum(UNIVERSE_DRAFT_DESTINATION_KINDS),
    id: z.string().uuid(),
  })
  .strict();
export type UniverseDraftDestination = z.infer<typeof draftDestinationSchema>;

/** A draft write: the revision the client expects plus the new text + validated
 * attachment asset IDs. No client userId/company/conversation is accepted here. */
export const draftPatchSchema = z
  .object({
    schemaVersion: z.literal(UNIVERSE_DRAFT_SCHEMA_VERSION),
    expectedRevision: z.number().int().gte(0),
    text: z.string().max(UNIVERSE_DRAFT_MAX_TEXT),
    attachmentAssetIds: z
      .array(z.string().uuid())
      .max(UNIVERSE_DRAFT_MAX_ATTACHMENTS),
  })
  .strict();
export type UniverseDraftPatch = z.infer<typeof draftPatchSchema>;

const textPayload = (kind: "commander" | "task") => z.object({
  kind: z.literal(kind),
  text: z.string().max(UNIVERSE_DRAFT_MAX_TEXT),
  attachmentAssetIds: z.array(z.string().uuid()).max(UNIVERSE_DRAFT_MAX_ATTACHMENTS),
}).strict();

export const universeDraftPayloadSchema = z.discriminatedUnion("kind", [
  textPayload("commander"),
  textPayload("task"),
  z.object({
    kind: z.literal("question"),
    expectedVersion: z.number().int().nonnegative(),
    text: z.string().max(8000),
    selectedValues: z.array(z.string().max(500)).max(20),
  }).strict(),
  z.object({
    kind: z.literal("runtime_decision"),
    expectedSourceRevision: z.number().int().nonnegative(),
    answer: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("permission"), decision: z.enum(RUNTIME_DECISION_PERMISSION_DECISIONS).nullable() }).strict(),
      z.object({ kind: z.literal("work_question"), fields: z.record(z.unknown()) }).strict(),
    ]),
  }).strict(),
  z.object({
    kind: z.literal("approval"),
    observedUpdatedAt: z.string().datetime(),
    decision: z.enum(["approve", "reject"]).nullable(),
    decisionNote: z.string().max(8000),
  }).strict(),
]).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32 * 1024, {
  message: "Draft payload exceeds 32 KiB",
});

export const pendingDraftAttemptSchema = z.object({
  attemptId: z.string().min(1).max(200),
  draftRevision: z.number().int().nonnegative(),
  payloadHash: z.string().min(1).max(128),
  clientSubmissionId: z.string().min(1).max(200).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  state: z.enum(["pending", "unknown", "acknowledged"]),
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2 * 1024, {
  message: "Pending attempt metadata exceeds 2 KiB",
});

export const structuredDraftPatchSchema = z.object({
  schemaVersion: z.literal(UNIVERSE_DRAFT_SCHEMA_VERSION),
  expectedRevision: z.number().int().nonnegative(),
  payload: universeDraftPayloadSchema,
  pendingAttempt: pendingDraftAttemptSchema.nullable().optional(),
}).strict();

/** Compatibility union while the existing Commander/task composer migrates to payload form. */
export const universeDraftPatchSchema = z.union([draftPatchSchema, structuredDraftPatchSchema]);
export type UniverseDraftPayload = z.infer<typeof universeDraftPayloadSchema>;
export type PendingDraftAttempt = z.infer<typeof pendingDraftAttemptSchema>;
export type UniverseDraftPatchInput = z.infer<typeof universeDraftPatchSchema>;

export interface UniverseDraft {
  revision: number;
  text: string;
  attachmentAssetIds: string[];
  payload?: UniverseDraftPayload;
  pendingAttempt?: PendingDraftAttempt | null;
}
