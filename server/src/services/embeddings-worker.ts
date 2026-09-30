/**
 * Write-behind embedding worker (Task B1, Decision D2).
 *
 * Thin wrapper around OpenAI's embeddings API + the `createEmbeddingService`
 * factory. Sets up the ticking loop that drains the `embedding_queue` table.
 *
 * Design notes:
 *   - The first tick is delayed via `setTimeout` so app startup is never
 *     blocked by a slow OpenAI call.
 *   - Missing `OPENAI_API_KEY` is a soft warning — we still register the
 *     worker so that any rows already enqueued surface as auth errors via
 *     the normal failure path (or leave pending when resolveCompanyKey is
 *     wired and returns null).
 *   - `stop()` is racy with an in-flight `processQueue()`; we set the flag
 *     then trust the tick to exit at its next checkpoint. Callers that need
 *     hard shutdown should drain the queue first.
 *   - Per-company key resolution (Task 10): when `resolveCompanyKey` is
 *     provided, each queue row's companyId is used to resolve the correct
 *     OpenAI key. Rows whose company has no key are left pending rather
 *     than failed.
 */

import type { Db } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import {
  createEmbeddingService,
  createOpenAiEmbedder,
  type CircuitEntry,
  type EmbeddingService,
} from "./embeddings.js";

const log = logger.child({ service: "embedding-worker" });

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_INITIAL_DELAY_MS = 1000;

export interface EmbeddingWorkerConfig {
  /** Interval between worker ticks once the queue is drained. */
  intervalMs: number;
  /** Max rows to process per tick. Default 50. */
  batchSize?: number;
  /**
   * Per-company key resolver. Resolution order per row:
   *   company Settings secret `llm:openai` → env `OPENAI_API_KEY` → null.
   *
   * When provided, rows whose company resolves to null are LEFT PENDING
   * (not failed, attempts not bumped) — they'll be retried on the next tick.
   *
   * When omitted, the worker falls back to a single embedder built from
   * `config.apiKey ?? process.env.OPENAI_API_KEY`. This legacy path is
   * preserved for backward compatibility and tests.
   */
  resolveCompanyKey?: (companyId: string | null) => Promise<string | null>;
  /**
   * OpenAI API key for the legacy (non-per-company) path. Only used when
   * `resolveCompanyKey` is NOT provided. If omitted, reads
   * `process.env.OPENAI_API_KEY`. When neither is present, the worker is
   * registered but every tick will fail with an auth error — the queue rows
   * surface as 'failed' after the usual retry exhaustion.
   */
  apiKey?: string;
  /** Initial delay before the first tick. Default 1000ms. */
  initialDelayMs?: number;
}

export interface EmbeddingWorkerHandle {
  /** Best-effort stop — the current in-flight tick will still finish. */
  stop(): void;
  /** Direct access to the service (useful for tests / route handlers). */
  service: EmbeddingService;
}

/**
 * Start the embedding worker. Returns immediately with a handle; the first
 * tick fires after `initialDelayMs` so app startup is non-blocking.
 *
 * Callers should `stop()` on graceful shutdown.
 */
export function startEmbeddingWorker(
  db: Db,
  config: EmbeddingWorkerConfig,
): EmbeddingWorkerHandle {
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const initialDelayMs = config.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

  // Build a baseline embedder for the legacy (non-per-company) path.
  // This is also used as the `llm` injected into createEmbeddingService so
  // the service handle has a working embedSync for the sync query path.
  const legacyApiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!legacyApiKey && !config.resolveCompanyKey) {
    log.warn(
      "OPENAI_API_KEY is not set and no resolveCompanyKey provided — embedding worker will run but every tick will fail with an auth error. " +
        "Set OPENAI_API_KEY in the server environment or configure llm:openai in company Settings to enable write-behind embeddings.",
    );
  }

  // Create a single baseline embedder. When resolveCompanyKey IS provided, this
  // embedder is only used by `embedSync` (the sync query-time path in
  // service-container.ts). The worker's processQueue() will use per-company
  // embedders resolved at tick time.
  const baselineEmbedder = createOpenAiEmbedder(legacyApiKey ?? "");

  const service = createEmbeddingService(db, baselineEmbedder);

  // Per-company circuit breaker map. Lives on the worker handle so it persists
  // across ticks: a systemic error (bad/expired key, quota exhausted) opens the
  // circuit for CIRCUIT_TTL_MS and suppresses that company's rows without
  // burning them to 'failed'. The map is passed into processQueue each tick.
  const circuit = new Map<string, CircuitEntry>();

  let stopped = false;
  let nextTimer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await service.processQueue({
        batchSize,
        resolveCompanyKey: config.resolveCompanyKey,
        circuit,
      });
      // Don't spam logs on quiet ticks. Only log on activity or failure.
      if (result.failed > 0) {
        log.warn(
          {
            processed: result.processed,
            failed: result.failed,
            skipped: result.skipped,
            remaining: result.remaining,
            openCircuits: circuit.size,
          },
          "embedding worker tick produced failures",
        );
      } else if (result.processed > 0) {
        log.debug(
          {
            processed: result.processed,
            skipped: result.skipped,
            remaining: result.remaining,
          },
          "embedding worker tick drained queue rows",
        );
      } else if (result.skipped > 0) {
        log.debug(
          { skipped: result.skipped },
          "embedding worker tick: rows left pending (no key for company)",
        );
      }
    } catch (err) {
      log.error({ err }, "embedding worker tick failed");
    }
    if (!stopped) {
      nextTimer = setTimeout(() => void tick(), config.intervalMs);
    }
  };

  // Defer the first tick so app startup isn't blocked.
  nextTimer = setTimeout(() => void tick(), initialDelayMs);

  return {
    stop() {
      stopped = true;
      if (nextTimer) {
        clearTimeout(nextTimer);
        nextTimer = null;
      }
    },
    service,
  };
}
