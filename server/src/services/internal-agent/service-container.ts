// server/src/services/internal-agent/service-container.ts
import type { Db } from "@armyofagents/db";
import type { ServiceContainer } from "./types.js";
import { issueService } from "../issues.js";
import { goalService } from "../goals.js";
import { agentService } from "../agents.js";
import { projectService } from "../projects.js";
import { memoryService } from "../memory.js";
import { costService } from "../costs.js";
import { activityService } from "../activity.js";
import { heartbeatService } from "../heartbeat.js";
import { suggestionService } from "../suggestions.js";
import { artifactService } from "../artifacts.js";
import { dependencyService } from "../dependencies.js";
import { secretService } from "../secrets.js";
import { notificationService } from "../notifications.js";
import { discussionService } from "../discussions.js";
import { threadService } from "../threads.js";
import { taskOutputService } from "../task-outputs.js";
import { companyService } from "../companies.js";
import { approvalService } from "../approvals.js";
import { issueApprovalService } from "../issue-approvals.js";
import { humanContextService } from "../human-context.js";
import { humanDiscoveryService } from "../human-discovery.js";
import { teamService } from "../team.js";
import {
  createEmbeddingService,
  createOpenAiEmbedder,
  type EmbeddingService,
} from "../embeddings.js";
import { getProviderApiKey } from "./providers/index.js";
import { getDbCapabilities } from "../db-capabilities.js";
import { logger } from "../../middleware/logger.js";

const serviceLog = logger.child({ service: "service-container" });

/**
 * Embedding model used for the synchronous `embedSync` path. Matches the
 * default in `startEmbeddingWorker` so production and tool-time use the
 * same model + dimensions. text-embedding-3-small produces 1536-dim vectors
 * — the same shape the `discussions.summary_embedding` and
 * `memory_items.embedding` columns store.
 */
// SYNC_EMBEDDING_MODEL is now encapsulated inside createOpenAiEmbedder (DEFAULT_EMBED_MODEL).

/**
 * Lazily-built embedding service used to back `ctx.services.embeddings` in
 * tools like `find_similar_threads`. We deliberately do NOT start a worker
 * here — the background drain loop is already running from `index.ts`
 * (`startEmbeddingWorker`). The container needs only the *service handle*
 * so synchronous `embedSync` calls succeed; the write-behind queue is
 * separately drained by the worker.
 *
 * Per-company key resolution (Task 10):
 *   `embedSync(text, companyId)` resolves the key for `companyId` via
 *   `getProviderApiKey(db, companyId, "openai")` (Settings llm:openai →
 *   env OPENAI_API_KEY). When no key resolves, the call returns null/throws
 *   and callers surface EMBEDDINGS_UNAVAILABLE gracefully.
 *
 * Why a per-db Map instead of a single module-level singleton:
 *   - Tests build multiple ServiceContainer instances against different
 *     mock `db` handles. A single singleton would alias them.
 *   - Production has exactly one `db` instance, so the Map size is 1 in
 *     practice — no memory pressure.
 *
 * Why memoize at all instead of building per-request:
 *   - The service handle itself is cheap; the per-company embedder is built
 *     lazily at `embedSync` time and cached by resolved key. ServiceContainer
 *     is built per request in `routes/internal-agent.ts`, so building a fresh
 *     service per request is fine — the embedder cache inside it handles
 *     the real work.
 *
 * Returns `undefined` when `OPENAI_API_KEY` is missing AND `db` is unavailable
 * for company-secret lookup — tools then surface `EMBEDDINGS_UNAVAILABLE`
 * gracefully (matches the test/dev environment behavior).
 */
const embeddingServiceCache = new WeakMap<Db, EmbeddingService>();
let warnedMissingKey = false;

/**
 * Build an EmbeddingService whose `embedSync` resolves a per-company OpenAI
 * key at call time, using Settings `llm:openai` → env `OPENAI_API_KEY`.
 *
 * The returned service's `embedSync(text, companyId)` will:
 *   1. Try `getProviderApiKey(db, companyId, "openai")` (Settings secret).
 *   2. Fall back to `process.env.OPENAI_API_KEY`.
 *   3. Throw if neither is set — callers catch and surface EMBEDDINGS_UNAVAILABLE.
 *
 * Embedders are cached by resolved key within the service instance lifetime
 * so repeated calls from the same company don't re-allocate the OpenAI SDK.
 */
function buildPerCompanyEmbeddingService(db: Db): EmbeddingService {
  // Cache of apiKey → LlmEmbedder. Built lazily at embedSync time.
  const embedderByKey = new Map<string, ReturnType<typeof createOpenAiEmbedder>>();

  // A placeholder LlmEmbedder injected into createEmbeddingService. The base
  // service's `llm` is only used when `embedSync` is called WITHOUT a companyId
  // (legacy callers). In practice all callers pass companyId in T10+.
  const fallbackEmbedder = {
    async embed(text: string): Promise<number[]> {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        throw new Error(
          "No OpenAI API key available. Configure the embeddings key in Settings → Memory or set OPENAI_API_KEY.",
        );
      }
      let embedder = embedderByKey.get(key);
      if (!embedder) {
        embedder = createOpenAiEmbedder(key);
        embedderByKey.set(key, embedder);
      }
      return embedder.embed(text);
    },
  };

  const base = createEmbeddingService(db, fallbackEmbedder);

  // Wrap embedSync to resolve per-company key.
  return {
    ...base,
    async embedSync(text: string, companyId?: string | null): Promise<number[]> {
      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error("Cannot generate embedding for empty text");
      }

      let apiKey: string | null = null;

      if (companyId) {
        try {
          apiKey = await getProviderApiKey(db, companyId, "openai");
        } catch {
          // No key in company_secrets; fall through to env fallback below.
        }
      }

      if (!apiKey) {
        // Env fallback (covers both no-companyId path and missing-secret path).
        apiKey = process.env.OPENAI_API_KEY ?? null;
      }

      if (!apiKey) {
        throw new Error(
          "No OpenAI API key available. Configure the embeddings key in Settings → Memory or set OPENAI_API_KEY.",
        );
      }

      let embedder = embedderByKey.get(apiKey);
      if (!embedder) {
        embedder = createOpenAiEmbedder(apiKey);
        embedderByKey.set(apiKey, embedder);
      }

      return embedder.embed(trimmed);
    },
  };
}

function getOrCreateEmbeddingService(db: Db): EmbeddingService | undefined {
  const cached = embeddingServiceCache.get(db);
  if (cached) return cached;

  // Gate on pgvector (P2, Codex): without vector support the embedding columns
  // (memory_items.embedding / discussions.summary_embedding) don't exist, so
  // find_similar_memory_hnsw / find_similar_threads would run SQL against
  // missing columns and error once a company has an llm:openai key — turning a
  // documented graceful degradation into a tool failure. Withhold the service so
  // those tools return EMBEDDINGS_UNAVAILABLE and the enqueue path no-ops.
  if (!getDbCapabilities().hasVectorSupport) {
    return undefined;
  }

  // Check whether ANY key is available (env only; company secrets are resolved
  // at embedSync time). If neither env key nor company secrets path could ever
  // work, log once and return undefined so tools get EMBEDDINGS_UNAVAILABLE.
  // We can't know at construction time whether a company has a secret, so we
  // always build the service and let embedSync throw if no key resolves.
  const hasEnvKey = Boolean(process.env.OPENAI_API_KEY);
  if (!hasEnvKey && !warnedMissingKey) {
    // Log once per process lifetime to avoid spamming the log on every request.
    // If a company has configured llm:openai in Settings, embedSync will still
    // succeed even without the env key. This is just an advisory log.
    serviceLog.warn(
      "OPENAI_API_KEY is not set — find_similar_threads + find_similar_memory_hnsw will " +
        "use per-company Settings keys (llm:openai). If no company has configured a key, " +
        "those tools will return EMBEDDINGS_UNAVAILABLE.",
    );
    warnedMissingKey = true;
  }

  const service = buildPerCompanyEmbeddingService(db);
  embeddingServiceCache.set(db, service);
  return service;
}

export function createServiceContainer(db: Db): ServiceContainer {
  const companySvc = companyService(db);
  const embeddings = getOrCreateEmbeddingService(db);
  return {
    issues: issueService(db),
    goals: goalService(db),
    agents: agentService(db),
    projects: projectService(db),
    memory: memoryService(db),
    costs: costService(db),
    activity: activityService(db),
    heartbeat: heartbeatService(db),
    suggestions: suggestionService(db),
    artifacts: artifactService(db),
    dependencies: dependencyService(db),
    secrets: secretService(db),
    notifications: notificationService(db),
    discussions: discussionService(db),
    threads: threadService(db),
    taskOutputs: taskOutputService(db),
    approvals: approvalService(db),
    issueApprovals: issueApprovalService(db),
    humanContext: humanContextService(db),
    humanDiscovery: humanDiscoveryService(db),
    team: teamService(db),
    companies: {
      get: (id: string) => companySvc.getById(id).then((row) => {
        if (!row) return null;
        return {
          name: row.name ?? null,
          vision: row.vision ?? null,
          mission: row.mission ?? null,
          issuePrefix: row.issuePrefix ?? null,
          stage: null, // companies schema has no stage field
        };
      }),
      update: async (id: string, data: Partial<{ vision: string; mission: string }>) => {
        const row = await companySvc.update(id, data);
        if (!row) throw new Error(`Company ${id} not found`);
        return {
          id: row.id,
          name: row.name ?? null,
          vision: row.vision ?? null,
          mission: row.mission ?? null,
        };
      },
    },
    workflows: null,
    embeddings,
  };
}
