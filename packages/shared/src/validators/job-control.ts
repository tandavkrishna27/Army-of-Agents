import { z } from "zod";

const uuid = z.string().uuid();

const taskRun = z.object({
  kind: z.literal("task_run"),
  runId: uuid,
  issueId: uuid,
  assigneeAgentId: uuid,
}).strict();

const commanderTurn = z.object({
  kind: z.literal("commander_turn"),
  internalAgentRunId: uuid,
  conversationId: uuid,
}).strict();

const crewRun = z.object({
  kind: z.literal("crew_run"),
  crewRunId: uuid,
}).strict();

const oneShot = z.object({
  kind: z.literal("one_shot"),
  operationId: uuid,
  operationKind: z.enum(["extraction", "compaction", "readiness_probe"]),
}).strict();

const browserRequest = z.object({
  kind: z.literal("browser_request"),
  browserRequestId: uuid,
  parentJobId: uuid.nullable(),
}).strict();

const serviceReconcile = z.object({
  kind: z.literal("service_reconcile"),
  serviceId: uuid,
  generation: z.number().int().positive(),
  reconciliationId: uuid,
}).strict();

export const submitJobSourceSchema = z.discriminatedUnion("kind", [
  taskRun,
  commanderTurn,
  crewRun,
  oneShot,
  browserRequest,
  serviceReconcile,
]);

const boundedInputSchema = z.record(z.unknown()).superRefine((input, ctx) => {
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "input must be JSON serializable" });
    return;
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > 65_536) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "input exceeds the 64 KiB limit" });
  }
});

export const submitJobCommandSchema = z.object({
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/),
  source: submitJobSourceSchema,
  input: boundedInputSchema,
}).strict();

export type SubmitJobCommandInput = z.infer<typeof submitJobCommandSchema>;
