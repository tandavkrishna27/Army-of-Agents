import type { GlobalSearchResponse } from "@armyofagents/shared";
import { api } from "./client";

export const searchApi = {
  global: (
    companyId: string,
    query: string,
    opts?: {
      includeArchived?: boolean;
      limitPerType?: number;
      /**
       * Phase 1 Phase E batch 3 (T24): thread-only filters. When ANY of these
       * is set the server replaces the brief source with `discussions`, so
       * the returned `brief` group represents threads instead of legacy
       * briefs+debriefs rows.
       */
      intent?: string;
      phase?: string;
      /** Formatted as `agent:<uuid>` or `user:<id>`. */
      participant?: string;
    },
  ) => {
    const params = new URLSearchParams({ q: query });
    if (opts?.includeArchived) params.set("includeArchived", "true");
    if (opts?.limitPerType) params.set("limitPerType", String(opts.limitPerType));
    if (opts?.intent) params.set("intent", opts.intent);
    if (opts?.phase) params.set("phase", opts.phase);
    if (opts?.participant) params.set("participant", opts.participant);
    return api.get<GlobalSearchResponse>(`/companies/${companyId}/search?${params.toString()}`);
  },
};
