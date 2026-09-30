import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

/**
 * Durable record of an in-flight interactive CLI login (`claude login` /
 * `codex login`) started from onboarding (Plan 3 / §6.2 Task 4).
 *
 * Durability matters: a detached login child can outlive a hard server restart,
 * after which the in-memory TrackedChildHandle (and its `terminate()`) is gone.
 * Persisting `pid`/`pgid` lets the startup reaper kill orphans by PID
 * (`terminateByPid`). Keyed logically by `(provider, authHome)` so two companies
 * sharing one auth home can't run competing logins — enforced in the service.
 */
export const commanderLoginChallenges = pgTable(
  "commander_login_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // 'anthropic' | 'openai'
    authHome: text("auth_home").notNull(),
    loginUrl: text("login_url"),
    pid: integer("pid"),
    pgid: integer("pgid"),
    status: text("status").notNull().default("pending"), // pending|completed|failed|timeout
    startedByUserId: text("started_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("commander_login_challenges_company_idx").on(table.companyId),
    lockIdx: index("commander_login_challenges_lock_idx").on(table.provider, table.authHome, table.status),
    statusIdx: index("commander_login_challenges_status_idx").on(table.status),
  }),
);
