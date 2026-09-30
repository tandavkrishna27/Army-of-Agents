import { z } from "zod";
import { AGENT_COMPLETION_POLICIES, COMPANY_STATUSES } from "../constants.js";
import {
  CommanderAdapterConfigSchema,
  CrewAdapterConfigSchema,
} from "../api/threads-contract.js";

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  rootFolder: z.string().min(1).optional().nullable(),
  // Phase 2 Task 10 (cloud_auth cutover): OPTIONAL. Self-hosted single-tenant
  // clients never send this; the route derives DEFAULT_ORGANIZATION_ID
  // server-side. In cloud_auth, if a caller belongs to more than one
  // Organization, this lets them pick which one -- but the route re-derives
  // and authorizes it against the caller's own membership (never trusts this
  // value directly as an authorization target -- anti-tenant-hop).
  organizationId: z.string().uuid().optional(),
  // Optional for backwards compatibility; first-party create surfaces always
  // provide this UUID so an ambiguous network retry replays one company.
  creationRequestId: z.string().uuid().optional(),
  // Phase 1 Phase E batch 2 (T20): OnboardingWizard now collects Commander +
  // Crew adapter picks at company-create time. Both are optional — when
  // omitted, the companies row keeps its `{}` default and downstream code
  // (resolveCrewAdapterForCompany) falls back to internal_agent_config.
  commanderAdapterConfig: CommanderAdapterConfigSchema.optional(),
  crewAdapterConfig: CrewAdapterConfigSchema.optional(),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  // organizationId is the tenant key: set once at create, immutable thereafter.
  // Omit it BEFORE .partial() so PATCH /companies/:id can never accept it and
  // reparent a company across organizations (Codex ①). createCompanySchema is
  // untouched — create-time tenant pick in cloud_auth is unchanged.
  .omit({ organizationId: true, creationRequestId: true })
  .partial()
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    logoAssetId: z.string().uuid().nullable().optional(),
    vision: z.string().nullable().optional(),
    mission: z.string().nullable().optional(),
    values: z.string().nullable().optional(),
    mcpEnabled: z.boolean().optional(),
    agentCompletionPolicyDefault: z.enum(AGENT_COMPLETION_POLICIES).optional(),
    agentCompletionReviewGuardrail: z.boolean().optional(),
    humanQuestionSlaHours: z.number().int().min(1).max(24 * 30).optional(),
  });

export type UpdateCompany = z.infer<typeof updateCompanySchema>;
