import type {
  GitProjectGraphResponse,
  GitProjectEnrichResponse,
} from "@armyofagents/shared";

export const projectGitApi = {
  /**
   * Fast (~50ms): git-only branch list + commit graph.
   * Returns immediately with PR fields as null — call getEnrich to populate them.
   */
  getGraph(companyId: string, projectId: string): Promise<GitProjectGraphResponse> {
    return fetch(`/api/companies/${companyId}/projects/${projectId}/git/graph`).then((r) => {
      if (!r.ok) throw new Error(`git graph fetch failed: ${r.status}`);
      return r.json() as Promise<GitProjectGraphResponse>;
    });
  },

  /**
   * Slow (~1–2s): GitHub PR + CI enrichment patches per branch.
   * Returns an array of { branchName, pr } to merge onto the graph data.
   */
  getEnrich(companyId: string, projectId: string): Promise<GitProjectEnrichResponse> {
    return fetch(`/api/companies/${companyId}/projects/${projectId}/git/enrich`).then((r) => {
      if (!r.ok) throw new Error(`git enrich fetch failed: ${r.status}`);
      return r.json() as Promise<GitProjectEnrichResponse>;
    });
  },
};
