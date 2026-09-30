import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agentTrustScores, agents } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "trust-scores" });

const RECENT_WINDOW = 20;

interface TrustScoreResult {
  id: string;
  companyId: string;
  agentId: string;
  totalCompleted: number;
  approvedWithoutChanges: number;
  recentCompleted: number;
  recentApproved: number;
  currentScore: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Calculate weighted trust score.
 *
 * Formula: (approvedWithoutChanges / totalCompleted) × 100
 * Last 20 tasks weighted 2×.
 *
 * With weighting:
 *   olderApproved = approvedWithoutChanges - recentApproved
 *   olderCompleted = totalCompleted - recentCompleted
 *   weightedScore = (olderApproved + recentApproved * 2) / (olderCompleted + recentCompleted * 2) × 100
 *
 * If fewer than 20 total tasks, all tasks are "recent" so no double-weighting applies.
 */
function computeScore(
  totalCompleted: number,
  approvedWithoutChanges: number,
  recentCompleted: number,
  recentApproved: number,
): number {
  if (totalCompleted === 0) return 0;

  // If fewer than RECENT_WINDOW tasks, no weighting — all tasks are equal
  if (totalCompleted <= RECENT_WINDOW) {
    return (approvedWithoutChanges / totalCompleted) * 100;
  }

  const olderCompleted = totalCompleted - recentCompleted;
  const olderApproved = approvedWithoutChanges - recentApproved;

  const weightedApproved = olderApproved + recentApproved * 2;
  const weightedTotal = olderCompleted + recentCompleted * 2;

  if (weightedTotal === 0) return 0;

  return (weightedApproved / weightedTotal) * 100;
}

export function trustScoreService(db: Db) {
  return {
    /**
     * Get the trust score for an agent from stored counters.
     * Returns null if agent has no reviewed tasks.
     */
    calculateScore: async (agentId: string): Promise<TrustScoreResult | null> => {
      const row = await db
        .select()
        .from(agentTrustScores)
        .where(eq(agentTrustScores.agentId, agentId))
        .then((rows) => rows[0] ?? null);

      if (!row || row.totalCompleted === 0) return null;

      return row;
    },

    /**
     * Called when a task review is completed (approve or reject).
     * Recalculates score and upserts the agent_trust_scores row.
     */
    updateOnReview: async (agentId: string, approved: boolean): Promise<void> => {
      // Get agent to find companyId
      const agent = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent) {
        log.warn({ agentId }, "Trust score update skipped: agent not found");
        return;
      }

      // Get or create the trust score row
      let existing = await db
        .select()
        .from(agentTrustScores)
        .where(
          and(
            eq(agentTrustScores.agentId, agentId),
            eq(agentTrustScores.companyId, agent.companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!existing) {
        const [created] = await db
          .insert(agentTrustScores)
          .values({
            companyId: agent.companyId,
            agentId,
            totalCompleted: 0,
            approvedWithoutChanges: 0,
            recentCompleted: 0,
            recentApproved: 0,
            currentScore: 0,
          })
          .returning();
        existing = created;
      }

      // Increment counters
      const newTotal = existing.totalCompleted + 1;
      const newApproved = existing.approvedWithoutChanges + (approved ? 1 : 0);

      // Recalculate recent counters
      // Recent = last RECENT_WINDOW tasks. Since we're adding one more task,
      // the recent window shifts.
      let newRecentCompleted: number;
      let newRecentApproved: number;

      if (newTotal <= RECENT_WINDOW) {
        // All tasks fit in recent window
        newRecentCompleted = newTotal;
        newRecentApproved = newApproved;
      } else {
        // We need to recalculate the recent window.
        // The most accurate approach: query the last RECENT_WINDOW completed tasks
        // and count approvals. But since we don't track per-task approval status
        // in the issues table, we maintain a sliding window approximation.
        //
        // When the window is full, we increment recentCompleted (capped at RECENT_WINDOW)
        // and adjust recentApproved proportionally for the task that falls off.
        newRecentCompleted = RECENT_WINDOW;

        if (existing.totalCompleted < RECENT_WINDOW) {
          // Transitioning into the window size
          newRecentApproved = existing.recentApproved + (approved ? 1 : 0);
        } else {
          // Window is already full. The oldest task in the window falls off.
          // Approximate: assume the task falling off had the same approval rate
          // as the overall recent window.
          const oldRate = existing.recentCompleted > 0
            ? existing.recentApproved / existing.recentCompleted
            : 0;
          const fallingOffApproved = oldRate;
          newRecentApproved = Math.max(
            0,
            Math.min(
              RECENT_WINDOW,
              existing.recentApproved - fallingOffApproved + (approved ? 1 : 0),
            ),
          );
        }
      }

      const newScore = computeScore(newTotal, newApproved, newRecentCompleted, newRecentApproved);

      await db
        .update(agentTrustScores)
        .set({
          totalCompleted: newTotal,
          approvedWithoutChanges: newApproved,
          recentCompleted: newRecentCompleted,
          recentApproved: newRecentApproved,
          currentScore: newScore,
          updatedAt: new Date(),
        })
        .where(eq(agentTrustScores.id, existing.id));
    },

    /**
     * Get the current trust score for an agent.
     * Filters by companyId to prevent cross-company data access.
     * Returns null if agent has no completed tasks.
     */
    getScore: async (companyId: string, agentId: string): Promise<TrustScoreResult | null> => {
      const row = await db
        .select()
        .from(agentTrustScores)
        .where(
          and(
            eq(agentTrustScores.agentId, agentId),
            eq(agentTrustScores.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!row || row.totalCompleted === 0) return null;

      return row;
    },

    /**
     * List all agent trust scores for a company.
     */
    listScores: async (companyId: string): Promise<TrustScoreResult[]> => {
      return db
        .select()
        .from(agentTrustScores)
        .where(eq(agentTrustScores.companyId, companyId));
    },
  };
}

