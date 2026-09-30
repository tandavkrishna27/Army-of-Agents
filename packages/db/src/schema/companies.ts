import { pgTable, uuid, text, integer, timestamp, boolean, uniqueIndex, unique, jsonb } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Phase 1 tenant FK. RESTRICT: an Organization cannot be deleted while it
    // still owns companies (org teardown is out of Phase 1 scope). Injected on
    // every existing row by migration 0188.
    // FAIL-CLOSED (TEN-006b, migration 0210 — ref E2-D07): the fail-OPEN sentinel
    // DB DEFAULT ('00000000-0000-0000-0000-000000000001') was DROPPED. It used to
    // bucket any writer that omitted organization_id into the Default Org; now an
    // omitting writer trips this NOT NULL (23502) = fail closed. Every writer must
    // resolve the Organization EXPLICITLY (TEN-006a swept every Company-insert site
    // + the writers throw `requireResolvedOrganizationId` before the insert). The
    // sentinel value survives as the legitimate single-tenant Default Org
    // (DEFAULT_ORGANIZATION_ID, @armyofagents/shared) — resolved explicitly by the
    // self-hosted path, never silently defaulted here. Do NOT re-add `.default(...)`.
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    // Optional client-generated replay anchor for company creation. The same
    // request may only materialize once inside its owning Organization.
    creationRequestId: uuid("creation_request_id"),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    issuePrefix: text("issue_prefix").notNull().default("PAP"),
    issueCounter: integer("issue_counter").notNull().default(0),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(true),
    agentCompletionPolicyDefault: text("agent_completion_policy_default")
      .notNull()
      .default("review_required"),
    agentCompletionReviewGuardrail: boolean("agent_completion_review_guardrail")
      .notNull()
      .default(false),
    humanQuestionSlaHours: integer("human_question_sla_hours").notNull().default(24),
    vision: text("vision"),
    mission: text("mission"),
    values: text("values"),
    brandColor: text("brand_color"),
    logoAssetId: uuid("logo_asset_id"),
    rootFolder: text("root_folder"),
    mcpEnabled: boolean("mcp_enabled").notNull().default(false),
    // @deprecated NEVER READ at runtime (the "Task D6" reader was never built).
    // Superseded by internal_agent_config.{cliTool,model,provider,crewModel}, which
    // is the live source of truth for Commander + crew. Kept (not dropped) for
    // rollback safety per AoA convention; onboarding no longer writes them.
    commanderAdapterConfig: jsonb("commander_adapter_config")
      .$type<{ adapter: string; model: string } | Record<string, never>>()
      .notNull()
      .default({}),
    // Crew adapter pick — `default` covers every crew agent that doesn't
    // have a per-agent override; `perAgent` keys by agent.id (uuid string).
    // Shape contract: CrewAdapterConfigSchema in
    // packages/shared/src/api/threads-contract.ts (Pre-Task 0.6).
    crewAdapterConfig: jsonb("crew_adapter_config")
      .$type<{
        default?: { adapter: string; model: string };
        perAgent?: Record<string, { adapter: string; model: string }>;
      } | Record<string, never>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    enableTeams: boolean("enable_teams").notNull().default(false),
  },
  (table) => ({
    // Temporary route-safety invariant: the current board URL namespace is
    // /:companyPrefix, so a prefix must identify exactly one company globally.
    // Company-qualified routes can safely relax this back to per-Organization.
    // The 23505 retry in companyService keys on this constraint name.
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
    organizationCreationRequestUq: uniqueIndex("companies_organization_creation_request_uq").on(
      table.organizationId,
      table.creationRequestId,
    ),
    // TEN-004 (CAV-005-safe, ADDITIVE ONLY): FK-target composite unique on
    // (organization_id, id) so the new-path `jobs`/`services` composite
    // (organization_id, company_id) FKs can bind to companies and prove a
    // company shares the referencing row's tenant. This is a plain additive
    // unique — NO RLS, NO other companies column/behavior touched. `id` is the
    // PK so the pair is trivially unique; this exists solely to be an FK target.
    organizationIdUq: unique("companies_org_id_uq").on(table.organizationId, table.id),
  }),
);
