import { z } from "zod";
import { CREATABLE_APPROVAL_TYPES } from "../constants.js";

export const createApprovalSchema = z.object({
  // Only externally-creatable types — `crew_dispatch` is system-internal (see
  // CREATABLE_APPROVAL_TYPES). Both the HTTP route and the MCP create-approval tool
  // validate against this, so neither can create a caller-controlled crew_dispatch.
  type: z.enum(CREATABLE_APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z
  .object({
    decisionNote: z.string().optional().nullable(),
  })
  .strict();

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z
  .object({
    decisionNote: z.string().optional().nullable(),
  })
  .strict();

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: z.string().min(1),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
