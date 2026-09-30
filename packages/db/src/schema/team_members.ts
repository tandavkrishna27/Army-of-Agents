import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { teams } from "./teams.js";
import { agents } from "./agents.js";

export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamAgentUq: uniqueIndex("team_members_team_agent_uq").on(table.teamId, table.agentId),
    teamIdx: index("team_members_team_idx").on(table.teamId),
    agentIdx: index("team_members_agent_idx").on(table.agentId),
    // Partial unique index — at most one lead per team, enforced at DB level.
    // Service-layer checks (teamsService.addMember, updateMemberRole) are TOCTOU-vulnerable
    // without this; two concurrent addMember(team, agent, "lead") calls could both pass
    // the existing-lead check and both insert. This index makes the second insert fail
    // with Postgres unique constraint error 23505.
    oneLeadPerTeamUq: uniqueIndex("team_members_one_lead_uq")
      .on(table.teamId)
      .where(sql`role = 'lead'`),
  }),
);
