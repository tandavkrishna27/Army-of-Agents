/**
 * Process-local cache for the project git graph + enrich responses (25s TTL).
 * Lives in the service layer so both routes/project-git.ts (writer/reader) and
 * services/projects.ts (invalidator on workspace change) can import it without
 * a service→route dependency.
 *
 * Cache is process-local — suitable for single-process deployments only.
 */
import type {
  GitProjectEnrichResponse,
  GitProjectGraphResponse,
} from "@armyofagents/shared";

export interface GraphCacheEntry<T = GitProjectGraphResponse> {
  data: T;
  expiresAt: number;
}

export interface EnrichCacheEntry<T = GitProjectEnrichResponse> {
  data: T;
  expiresAt: number;
}

export const GRAPH_CACHE_TTL_MS = 25_000;
export const ENRICH_CACHE_TTL_MS = 25_000;

export const graphCache = new Map<string, GraphCacheEntry>();
export const enrichCache = new Map<string, EnrichCacheEntry>();

export function projectGitCacheKey(companyId: string, projectId: string): string {
  return `${companyId}:${projectId}`;
}

/** Clear cached graph + enrich responses for a project (call on workspace change). */
export function invalidateProjectGitCache(companyId: string, projectId: string): void {
  const key = projectGitCacheKey(companyId, projectId);
  graphCache.delete(key);
  enrichCache.delete(key);
}
