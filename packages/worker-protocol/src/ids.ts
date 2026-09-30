import { z } from "zod";

// Domain row identifiers that are genuinely UUIDs stay UUID-branded. Opaque
// principal identifiers (Better Auth users, agents, services, system actors)
// are branded as non-empty text and are NOT interchangeable with UUID IDs — one
// parser never stands in for both kinds.
const uuidSchema = z.string().uuid();

// Opaque principal text: non-empty, no leading/trailing whitespace, at most 200
// UTF-8 bytes. Bytes are preserved exactly — no trim, no normalization, no
// rewrite — so an authenticated identity round-trips unchanged.
const opaquePrincipalTextSchema = z.string().min(1).superRefine((value, ctx) => {
  if (value !== value.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "principal ID must not contain leading or trailing whitespace",
    });
  }
  if (new TextEncoder().encode(value).byteLength > 200) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "principal ID exceeds 200 UTF-8 bytes",
    });
  }
});

export const organizationIdSchema = uuidSchema.brand<"OrganizationId">();
export const companyIdSchema = uuidSchema.brand<"CompanyId">();
export const agentIdSchema = uuidSchema.brand<"AgentId">();
export const runIdSchema = uuidSchema.brand<"RunId">();
export const issueIdSchema = uuidSchema.brand<"IssueId">();
export const internalAgentRunIdSchema = uuidSchema.brand<"InternalAgentRunId">();
export const conversationIdSchema = uuidSchema.brand<"ConversationId">();
export const crewRunIdSchema = uuidSchema.brand<"CrewRunId">();
export const oneShotOperationIdSchema = uuidSchema.brand<"OneShotOperationId">();
export const browserRequestIdSchema = uuidSchema.brand<"BrowserRequestId">();
export const reconciliationIdSchema = uuidSchema.brand<"ReconciliationId">();
export const jobIdSchema = uuidSchema.brand<"JobId">();
export const workerIdSchema = uuidSchema.brand<"WorkerId">();
export const targetIdSchema = uuidSchema.brand<"TargetId">();
export const leaseIdSchema = uuidSchema.brand<"LeaseId">();
export const eventIdSchema = uuidSchema.brand<"EventId">();
export const artifactIdSchema = uuidSchema.brand<"ArtifactId">();
export const secretHandleIdSchema = uuidSchema.brand<"SecretHandleId">();
export const serviceIdSchema = uuidSchema.brand<"ServiceId">();
export const serviceInstanceIdSchema = uuidSchema.brand<"ServiceInstanceId">();
export const principalIdSchema = opaquePrincipalTextSchema.brand<"PrincipalId">();
export const sandboxIdSchema = z.string().min(1).max(200).brand<"SandboxId">();
export const attemptNumberSchema = z.number().int().positive().max(1_000_000);
export const eventSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const fenceTokenSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"FenceToken">();
export const sha256DigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<"Sha256Digest">();

export type OrganizationId = z.infer<typeof organizationIdSchema>;
export type CompanyId = z.infer<typeof companyIdSchema>;
export type AgentId = z.infer<typeof agentIdSchema>;
export type RunId = z.infer<typeof runIdSchema>;
export type IssueId = z.infer<typeof issueIdSchema>;
export type InternalAgentRunId = z.infer<typeof internalAgentRunIdSchema>;
export type ConversationId = z.infer<typeof conversationIdSchema>;
export type CrewRunId = z.infer<typeof crewRunIdSchema>;
export type OneShotOperationId = z.infer<typeof oneShotOperationIdSchema>;
export type BrowserRequestId = z.infer<typeof browserRequestIdSchema>;
export type ReconciliationId = z.infer<typeof reconciliationIdSchema>;
export type JobId = z.infer<typeof jobIdSchema>;
export type WorkerId = z.infer<typeof workerIdSchema>;
export type TargetId = z.infer<typeof targetIdSchema>;
export type LeaseId = z.infer<typeof leaseIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type ArtifactId = z.infer<typeof artifactIdSchema>;
export type SecretHandleId = z.infer<typeof secretHandleIdSchema>;
export type ServiceId = z.infer<typeof serviceIdSchema>;
export type ServiceInstanceId = z.infer<typeof serviceInstanceIdSchema>;
export type PrincipalId = z.infer<typeof principalIdSchema>;
export type SandboxId = z.infer<typeof sandboxIdSchema>;
export type FenceToken = z.infer<typeof fenceTokenSchema>;
export type Sha256Digest = z.infer<typeof sha256DigestSchema>;
