import { integer, jsonb, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/**
 * Resumable onboarding state (revB §1.1 / RC1).
 *
 * One row per (userId, companyId). The USER-layer row has companyId = NULL
 * (exactly one per user); ORG-layer rows carry a real companyId (one per
 * user+company). Postgres does not treat NULLs as equal in a plain unique
 * index, so the two layers get SEPARATE partial unique indexes.
 *
 * `version` is a monotonic ETag for optimistic, forward-only advance under
 * concurrent tabs/devices (see the onboarding service).
 */
export const onboardingProgress = pgTable(
  "onboarding_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    journey: text("journey").notNull(), // "founder" | "invited"
    currentState: text("current_state").notNull(),
    completedStates: jsonb("completed_states").$type<string[]>().notNull().default([]),
    version: integer("version").notNull().default(0),
    /**
     * WS0b — the persisted "first-run done" flag. Gates Home first-run vs
     * steady-state (`showOnboarding = !firstRunCompleted`) independently of
     * the vision+dept+agent+goal checklist, which never completes for
     * In-flight/Explorer personas. Set once, on the door-band choice or when
     * the founder reaches Home after SETUP_COMPLETE. Null = not yet done.
     */
    firstRunCompletedAt: timestamp("first_run_completed_at", { withTimezone: true }),
    /**
     * Which door the founder chose on the Map (WS9). Null until chosen.
     * Persisted so a reload/resume routes correctly.
     */
    firstRunPersona: text("first_run_persona").$type<"manual" | "in_flight" | "explorer">(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCompanyUq: uniqueIndex("onboarding_progress_user_company_uq")
      .on(t.userId, t.companyId)
      .where(sql`${t.companyId} IS NOT NULL`),
    userLayerUq: uniqueIndex("onboarding_progress_user_layer_uq")
      .on(t.userId)
      .where(sql`${t.companyId} IS NULL`),
  }),
);
