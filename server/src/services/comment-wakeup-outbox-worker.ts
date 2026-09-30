/**
 * Comment-wakeup-outbox drain worker (PR #291 round-16).
 *
 * Ticking loop that drains `comment_wakeup_outbox` — a direct mirror of
 * mention-outbox-worker.ts. The exactly-once + per-target guarantees live in
 * `drainCommentWakeupOutbox` (FOR UPDATE SKIP LOCKED claim + owner-guarded
 * mark-'done'); this file only schedules it, swallowing per-tick errors so a bad
 * tick never crashes the process.
 */

import type { Db } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import { drainCommentWakeupOutbox, type DrainCommentWakeupOpts } from "./comment-wakeup-outbox.js";

const LOG_CTX = { service: "comment-wakeup-outbox-worker" } as const;

const DEFAULT_INITIAL_DELAY_MS = 1500;

export interface CommentWakeupOutboxWorkerConfig {
  /** Interval between ticks once the queue is drained. */
  intervalMs: number;
  /** Max rows per tick. */
  batchSize?: number;
  /** Initial delay before the first tick (non-blocking startup). */
  initialDelayMs?: number;
  /** Injectable dispatch (tests); defaults to the real kind-resolving wakeup. */
  runWakeup?: DrainCommentWakeupOpts["runWakeup"];
}

export interface CommentWakeupOutboxWorkerHandle {
  stop(): void;
}

export function startCommentWakeupOutboxWorker(
  db: Db,
  config: CommentWakeupOutboxWorkerConfig,
): CommentWakeupOutboxWorkerHandle {
  const initialDelayMs = config.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  let stopped = false;
  let nextTimer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await drainCommentWakeupOutbox(db, {
        batchSize: config.batchSize,
        runWakeup: config.runWakeup,
      });
      if (result.failed > 0 || result.processed > 0) {
        logger.debug({ ...LOG_CTX, processed: result.processed, failed: result.failed }, "comment wakeup outbox tick");
      }
    } catch (err) {
      logger.error({ ...LOG_CTX, err }, "comment wakeup outbox worker tick failed");
    }
    if (!stopped) {
      nextTimer = setTimeout(() => void tick(), config.intervalMs);
    }
  };

  nextTimer = setTimeout(() => void tick(), initialDelayMs);

  return {
    stop() {
      stopped = true;
      if (nextTimer) {
        clearTimeout(nextTimer);
        nextTimer = null;
      }
    },
  };
}
