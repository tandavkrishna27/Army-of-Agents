import { z } from "zod";

export const financeDirectionSchema = z.enum(["debit", "credit"]);

export const createFinanceEventSchema = z.object({
  agentId: z.string().uuid().optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  heartbeatRunId: z.string().uuid().optional().nullable(),
  costEventId: z.string().uuid().optional().nullable(),
  billingCode: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  eventKind: z.string().min(1),
  direction: financeDirectionSchema.optional(),
  biller: z.string().min(1),
  provider: z.string().optional().nullable(),
  executionAdapterType: z.string().optional().nullable(),
  pricingTier: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
  quantity: z.number().int().optional().nullable(),
  unit: z.string().optional().nullable(),
  amountCents: z.number().int(),
  currency: z.string().optional(),
  estimated: z.boolean().optional(),
  externalInvoiceId: z.string().optional().nullable(),
  metadataJson: z.record(z.string(), z.unknown()).optional().nullable(),
  occurredAt: z.string().datetime(),
});

export type CreateFinanceEvent = z.infer<typeof createFinanceEventSchema>;

export const financeDateRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const financeListQuerySchema = financeDateRangeQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export type FinanceListQuery = z.infer<typeof financeListQuerySchema>;
