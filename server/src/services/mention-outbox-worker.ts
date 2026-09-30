/**
 * Mention-outbox drain worker (PR #291 round-6 #3).
 *
 * Ticking loop that drains `discussion_mention_outbox`, mirroring the embedding
 * worker's lifecycle: a deferred first tick, best-effort stop, and swallowed
 * per-tick errors so a bad tick never crashes the process. The exactly-once
 * summon guarantee lives in `drainMentionOutbox` (FOR UPDATE SKIP LOCKED claim +
 * mark-'done'); this file only schedules it.
 */

import type { Db } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import { drainMentionOutbox, type DrainOpts } from "./mention-outbox.js";

const log = logger.child({ service: "mention-outbox-worker" });

const DEFAULT_INITIAL_DELAY_MS = 1500;

export interface MentionOutboxWorkerConfig {
  /** Interval between ticks once the queue is drained. */
  intervalMs: number;
  /** Max rows per tick. */
  batchSize?: number;
  /** Initial delay before the first tick (non-blocking startup). */
  initialDelayMs?: number;
  /** Injectable summon (tests); defaults to the real processMentions. */
  runMentions?: DrainOpts["runMentions"];
}

export interface MentionOutboxWorkerHandle {
  stop(): void;
}

export function startMentionOutboxWorker(
  db: Db,
  config: MentionOutboxWorkerConfig,
): MentionOutboxWorkerHandle {
  const initialDelayMs = config.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  let stopped = false;
  let nextTimer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await drainMentionOutbox(db, {
        batchSize: config.batchSize,
        runMentions: config.runMentions,
      });
      if (result.failed > 0 || result.processed > 0) {
        log.debug({ processed: result.processed, failed: result.failed }, "mention outbox tick");
      }
    } catch (err) {
      log.error({ err }, "mention outbox worker tick failed");
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
