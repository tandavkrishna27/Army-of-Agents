import type { HealthReport } from "@armyofagents/shared";
import { api } from "./client";

export type HealthStatus = {
  status: "ok";
  revision?: string | null;
  deploymentMode?: "local_trusted" | "authenticated" | "cloud_auth";
  deploymentExposure?: "private" | "public";
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending";
  features?: {
    companyDeletionEnabled?: boolean;
  };
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    const res = await fetch("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to load health (${res.status})`);
    }
    return res.json();
  },
  company: (companyId: string): Promise<HealthReport> =>
    api.get<HealthReport>(`/companies/${encodeURIComponent(companyId)}/health`),
  instance: (): Promise<HealthReport> =>
    api.get<HealthReport>("/instance/health"),
};
