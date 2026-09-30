import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companyMcpConnectors } from "./company_mcp_connectors.js";

/**
 * Per-agent opt-in (design decision D4). A connector is installed company-wide
 * but reaches an agent run only when a row exists here. Commander is exempt —
 * it receives all active company connectors (D3) and is not represented here.
 */
export const companyMcpConnectorAgents = pgTable(
  "company_mcp_connector_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => companyMcpConnectors.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    connectorIdx: index("company_mcp_connector_agents_connector_idx").on(table.connectorId),
    agentIdx: index("company_mcp_connector_agents_agent_idx").on(table.agentId),
    connectorAgentUq: uniqueIndex("company_mcp_connector_agents_connector_agent_uq").on(
      table.connectorId,
      table.agentId,
    ),
  }),
);
