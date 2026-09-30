import { pgTable, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";

export const agentProjects = pgTable(
  "agent_projects",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.projectId] }),
    agentIdx: index("agent_projects_agent_idx").on(table.agentId),
    projectIdx: index("agent_projects_project_idx").on(table.projectId),
    companyIdx: index("agent_projects_company_idx").on(table.companyId),
  }),
);
