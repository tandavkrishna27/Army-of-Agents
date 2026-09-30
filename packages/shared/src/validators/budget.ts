import { z } from "zod";

export const upsertBudgetPolicySchema = z.object({
  scopeType: z.enum(["company", "agent"]),
  scopeId: z.string().uuid(),
  amountCents: z.number().int().nonnegative(),
  warnPercent: z.number().int().min(1).max(99).optional().default(80),
  hardStopEnabled: z.boolean().optional().default(true),
});

export type UpsertBudgetPolicy = z.infer<typeof upsertBudgetPolicySchema>;

export const resolveBudgetIncidentSchema = z.object({
  action: z.enum(["raise_and_resume", "dismiss"]),
  newAmountCents: z.number().int().nonnegative().optional(),
}).refine(
  (d) => d.action !== "raise_and_resume" || (d.newAmountCents !== undefined),
  { message: "newAmountCents is required when action is raise_and_resume" },
);

export type ResolveBudgetIncident = z.infer<typeof resolveBudgetIncidentSchema>;
