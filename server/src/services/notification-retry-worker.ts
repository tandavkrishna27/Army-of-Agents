/**
 * Periodic worker that drains the notification retry queue (Phase G2, T26).
 *
 * Runs every `intervalMs` (default 60s). Started from server bootstrap when
 * `NOTIFICATION_RETRY_ENABLED` is unset or "true". Each tick calls
 * `retryFailedNotifications`, which picks up to `batchSize` rows where
 * `delivery_error IS NOT NULL AND delivered_at IS NULL AND
 * delivery_attempts < MAX_DELIVERY_ATTEMPTS` and re-attempts delivery.
 *
 * Design notes mirror the embedding worker (Task B1, D2):
 *   - First tick is deferred so app startup is non-blocking.
 *   - Best-effort `stop()` clears the next timer; an in-flight sweep finishes.
 *   - Quiet ticks (no candidates) log nothing to keep logs readable.
 */

import type { Db } from "@armyofagents/db";
import { retryFailedNotifications, type NotificationRow } from "./notifications.js";
import { logger } from "../middleware/logger.js";

const DEFAULT_INTERVAL_MS = 60_000;

export interface NotificationRetryWorkerOptions {
  /** Interval between sweeps. Default 60s. */
  intervalMs?: number;
  /** Max rows processed per sweep. Default 10 (inherited from `retryFailedNotifications`). */
  batchSize?: number;
  /**
   * Concrete delivery hook. When undefined the sweep just clears
   * `deliveryError` on each candidate, treating the previous failure as
   * resolved. Concrete channels (WS, email) pass an `attempt` that throws
   * to keep the row in the queue.
   */
  attempt?: (row: NotificationRow) => Promise<void>;
}

/**
 * Start the notification retry worker. Returns the underlying timer handle
 * so callers can `clearInterval` on graceful shutdown.
 *
 * The function spelling follows the in-house pattern (`scheduleX`,
 * `startX`). We return the raw timer handle rather than a wrapper because
 * the existing server bootstrap clears similar workers directly.
 */
export function scheduleNotificationRetryWorker(
  db: Db,
  options: NotificationRetryWorkerOptions = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize;
  const attempt = options.attempt;

  const tick = () => {
    void retryFailedNotifications(db, { batchSize, attempt })
      .then((result) => {
        if (result.scanned > 0) {
          logger.info(result, "notification retry sweep");
        }
      })
      .catch((err) => {
        logger.error({ err }, "notification retry sweep failed");
      });
  };

  return setInterval(tick, intervalMs);
}
