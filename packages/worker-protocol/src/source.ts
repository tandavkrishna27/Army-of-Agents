import { z } from "zod";
import {
  agentIdSchema,
  browserRequestIdSchema,
  conversationIdSchema,
  crewRunIdSchema,
  internalAgentRunIdSchema,
  issueIdSchema,
  jobIdSchema,
  oneShotOperationIdSchema,
  principalIdSchema,
  reconciliationIdSchema,
  runIdSchema,
  serviceIdSchema,
} from "./ids.js";

// -----------------------------------------------------------------------------
// Typed principals and the strict discriminated execution-source union.
//
// The execution source is IMMUTABLE PROVENANCE, not authorization. The
// context-free wire schema uses a coarse principal-type vocabulary
// (user|agent|service|system) and cannot decide admission: JOB-001 validates
// `requestedBy` against the authenticated/domain authority and JOB-010..014
// revalidate current domain policy (per the hardening amendment). This layer
// only proves each variant carries the correct, well-formed identity shape and
// that only `task_run` carries `runId`/`issueId`.
// -----------------------------------------------------------------------------

/** Coarse wire principal types. Domain roles (founder/team_lead/worker/…) are a
 * separate authority checked by JOB-001/JOB-010, not by this schema. */
export const PRINCIPAL_TYPES = ["user", "agent", "service", "system"] as const;
export const principalTypeSchema = z.enum(PRINCIPAL_TYPES);
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/** A typed requester/executor principal: a coarse type plus an opaque,
 * byte-preserving principal ID. */
export const principalV1Schema = z
  .object({
    principalType: principalTypeSchema,
    principalId: principalIdSchema,
  })
  .strict();
export type PrincipalV1 = z.infer<typeof principalV1Schema>;

/** The exact set of one-shot operation kinds. */
export const ONE_SHOT_OPERATION_KINDS = ["extraction", "compaction", "readiness_probe"] as const;
export const oneShotOperationKindSchema = z.enum(ONE_SHOT_OPERATION_KINDS);
export type OneShotOperationKind = (typeof ONE_SHOT_OPERATION_KINDS)[number];

/** The exact set of execution-source discriminants. */
export const EXECUTION_SOURCE_KINDS = [
  "task_run",
  "commander_turn",
  "crew_run",
  "one_shot",
  "browser_request",
  "service_reconcile",
] as const;
export type ExecutionSourceKind = (typeof EXECUTION_SOURCE_KINDS)[number];

// Each variant is strict: unknown keys (including fabricated run/issue fields on
// non-task variants) are rejected. Only `task_run` declares `runId`/`issueId`.

export const taskRunSourceSchema = z
  .object({
    kind: z.literal("task_run"),
    runId: runIdSchema,
    issueId: issueIdSchema,
    requestedBy: principalV1Schema,
    executionPrincipal: principalV1Schema,
    assigneeAgentId: agentIdSchema,
  })
  .strict();
export type TaskRunSource = z.infer<typeof taskRunSourceSchema>;

export const commanderTurnSourceSchema = z
  .object({
    kind: z.literal("commander_turn"),
    internalAgentRunId: internalAgentRunIdSchema,
    conversationId: conversationIdSchema,
    requestedBy: principalV1Schema,
    executionPrincipal: principalV1Schema,
  })
  .strict();
export type CommanderTurnSource = z.infer<typeof commanderTurnSourceSchema>;

export const crewRunSourceSchema = z
  .object({
    kind: z.literal("crew_run"),
    crewRunId: crewRunIdSchema,
    requestedBy: principalV1Schema,
    executionPrincipal: principalV1Schema,
  })
  .strict();
export type CrewRunSource = z.infer<typeof crewRunSourceSchema>;

export const oneShotSourceSchema = z
  .object({
    kind: z.literal("one_shot"),
    operationId: oneShotOperationIdSchema,
    operationKind: oneShotOperationKindSchema,
    requestedBy: principalV1Schema,
    executionPrincipal: principalV1Schema,
  })
  .strict();
export type OneShotSource = z.infer<typeof oneShotSourceSchema>;

export const browserRequestSourceSchema = z
  .object({
    kind: z.literal("browser_request"),
    browserRequestId: browserRequestIdSchema,
    parentJobId: jobIdSchema.nullable(),
    requestedBy: principalV1Schema,
    executionPrincipal: principalV1Schema,
  })
  .strict();
export type BrowserRequestSource = z.infer<typeof browserRequestSourceSchema>;

export const serviceReconcileSourceSchema = z
  .object({
    kind: z.literal("service_reconcile"),
    serviceId: serviceIdSchema,
    generation: z.number().int().positive(),
    reconciliationId: reconciliationIdSchema,
    requestedBy: principalV1Schema,
    executionPrincipal: principalV1Schema,
  })
  .strict();
export type ServiceReconcileSource = z.infer<typeof serviceReconcileSourceSchema>;

/**
 * The strict execution-source union. Unknown source kinds fail closed. For
 * `task_run`, the execution principal must be an `agent` whose opaque principal
 * ID is byte-for-byte equal to the UUID-branded `assigneeAgentId` — a stale or
 * mismatched executor is denied at the schema boundary; JOB-001/JOB-010 still
 * own the authenticated/domain authorization of the requester.
 */
export const executionSourceV1Schema = z
  .discriminatedUnion("kind", [
    taskRunSourceSchema,
    commanderTurnSourceSchema,
    crewRunSourceSchema,
    oneShotSourceSchema,
    browserRequestSourceSchema,
    serviceReconcileSourceSchema,
  ])
  .superRefine((source, ctx) => {
    if (source.kind === "task_run") {
      if (source.executionPrincipal.principalType !== "agent") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executionPrincipal", "principalType"],
          message: "task_run execution principal must be an agent",
        });
      }
      // Byte-for-byte string-value equality (opaque principal ID vs UUID brand).
      if (String(source.executionPrincipal.principalId) !== String(source.assigneeAgentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assigneeAgentId"],
          message: "task_run assignee agent must equal the execution principal ID",
        });
      }
    }
  });
export type ExecutionSourceV1 = z.infer<typeof executionSourceV1Schema>;
