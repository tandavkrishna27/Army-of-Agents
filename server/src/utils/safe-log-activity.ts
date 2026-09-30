import type { Db } from "@armyofagents/db";
import { logActivity } from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ util: "safe-log-activity" });

/**
 * Activity-log helper that swallows errors. The main operation has already
 * succeeded by the time this runs; a transient DB error here would otherwise
 * cause the client to see a 500 + retry, double-applying the operation.
 *
 * Use for activity logs that happen AFTER a successful business-logic
 * transaction commit — a transient log-INSERT failure (pool exhaustion,
 * replication lag, etc.) should not propagate as a 500 to the client
 * (which would imply the business action failed and prompt a destructive
 * retry).
 *
 * (D3: pre-release polish — consistent across all team-route activity logs.)
 */
export async function safeLogActivity(
  db: Db,
  params: Parameters<typeof logActivity>[1],
): Promise<void> {
  try {
    await logActivity(db, params);
  } catch (err) {
    log.warn(
      {
        err:
          err instanceof Error
            ? { name: err.name, message: err.message }
            : String(err),
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
      },
      "activity log failed; main operation succeeded",
    );
  }
}
