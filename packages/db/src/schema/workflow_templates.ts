import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { companies } from "./companies.js";

// ── Table 10: workflow_templates ────────────────────────────────────────────

export const workflowTemplates = pgTable(
  "workflow_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    description: text("description"),
    workspaceMode: text("workspace_mode").default("department_default"),
    agentCompletionPolicyOverride: text("agent_completion_policy_override"),

    // Ordered steps with role assignments
    // Array of: { order, title, description, role, suggestedAssigneeType, suggestedDepartmentId, estimatedDurationHours, priority }
    steps: jsonb("steps").notNull(),

    // Dependencies between steps
    // Array of: { fromStep: number (order), toStep: number (order) }
    dependencies: jsonb("dependencies").notNull().default([]),

    // Usage tracking
    instantiationCount: integer("instantiation_count").notNull().default(0),
    lastInstantiatedAt: timestamp("last_instantiated_at", {
      withTimezone: true,
    }),

    createdBy: text("created_by").notNull(), // userId or 'internal_agent'
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("workflow_templates_company_idx").on(table.companyId),
  }),
);

// ── Relations ───────────────────────────────────────────────────────────────

export const workflowTemplatesRelations = relations(
  workflowTemplates,
  ({ one }) => ({
    company: one(companies, {
      fields: [workflowTemplates.companyId],
      references: [companies.id],
    }),
  }),
);
