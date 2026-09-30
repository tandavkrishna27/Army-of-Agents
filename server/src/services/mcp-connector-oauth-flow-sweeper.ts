import { mcpConnectorOauthFlows, type Db } from "@armyofagents/db";
import { and, eq, inArray, lte, lt, or } from "drizzle-orm";

export const MCP_OAUTH_FLOW_SWEEP_BATCH_SIZE = 500;
export const MCP_OAUTH_FLOW_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
// OAuth HTTP calls are capped at 10 seconds. Give a claimed callback 30 seconds
// beyond its browser-flow TTL so an in-flight exchange + DB commit cannot be
// changed to expired by the hourly sweeper.
export const MCP_OAUTH_FLOW_CLAIMED_GRACE_MS = 30_000;

export interface OAuthFlowSweepResult {
  expired: number;
  deleted: number;
}

export function oauthFlowExpirationCutoffs(now: Date): { pending: Date; claimed: Date } {
  return {
    pending: now,
    claimed: new Date(now.getTime() - MCP_OAUTH_FLOW_CLAIMED_GRACE_MS),
  };
}

/**
 * Deletes one bounded batch. The predicate is repeated on DELETE so a row
 * changed after selection cannot be removed accidentally. Multiple server
 * instances may safely sweep at the same time.
 */
export async function sweepMcpConnectorOauthFlows(
  db: Db,
  options: { now?: Date; limit?: number } = {},
): Promise<OAuthFlowSweepResult> {
  const now = options.now ?? new Date();
  const terminalCutoff = new Date(now.getTime() - MCP_OAUTH_FLOW_TERMINAL_RETENTION_MS);
  const expiryCutoffs = oauthFlowExpirationCutoffs(now);
  const limit = Math.max(1, Math.min(options.limit ?? MCP_OAUTH_FLOW_SWEEP_BATCH_SIZE, MCP_OAUTH_FLOW_SWEEP_BATCH_SIZE));
  const expirable = and(
    or(
      and(
        eq(mcpConnectorOauthFlows.status, "pending"),
        lte(mcpConnectorOauthFlows.expiresAt, expiryCutoffs.pending),
      ),
      and(
        eq(mcpConnectorOauthFlows.status, "claimed"),
        lte(
          mcpConnectorOauthFlows.expiresAt,
          expiryCutoffs.claimed,
        ),
      ),
    ),
  );
  const expirableRows = await db
    .select({ id: mcpConnectorOauthFlows.id })
    .from(mcpConnectorOauthFlows)
    .where(expirable)
    .limit(limit);
  const expired = expirableRows.length === 0
    ? []
    : await db
      .update(mcpConnectorOauthFlows)
      .set({ status: "expired", updatedAt: now })
      .where(and(
        inArray(mcpConnectorOauthFlows.id, expirableRows.map((row) => row.id)),
        expirable,
      ))
      .returning({ id: mcpConnectorOauthFlows.id });

  const eligible = and(
    inArray(mcpConnectorOauthFlows.status, ["completed", "failed", "expired"]),
    lt(mcpConnectorOauthFlows.updatedAt, terminalCutoff),
  );
  const candidates = await db
    .select({ id: mcpConnectorOauthFlows.id })
    .from(mcpConnectorOauthFlows)
    .where(eligible)
    .limit(limit);
  if (candidates.length === 0) return { expired: expired.length, deleted: 0 };

  const rows = await db
    .delete(mcpConnectorOauthFlows)
    .where(and(
      inArray(mcpConnectorOauthFlows.id, candidates.map((row) => row.id)),
      eligible,
    ))
    .returning({ id: mcpConnectorOauthFlows.id });
  return { expired: expired.length, deleted: rows.length };
}

export async function drainMcpConnectorOauthFlows(
  db: Db,
  options: { now?: Date; maxBatches?: number } = {},
): Promise<OAuthFlowSweepResult> {
  let deleted = 0;
  let expired = 0;
  const maxBatches = Math.max(1, options.maxBatches ?? 20);
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await sweepMcpConnectorOauthFlows(db, { now: options.now });
    expired += result.expired;
    deleted += result.deleted;
    if (
      result.deleted < MCP_OAUTH_FLOW_SWEEP_BATCH_SIZE &&
      result.expired < MCP_OAUTH_FLOW_SWEEP_BATCH_SIZE
    ) break;
  }
  return { expired, deleted };
}
