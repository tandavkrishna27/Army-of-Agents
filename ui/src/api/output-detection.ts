import type { DetectedOutputForUI } from "@armyofagents/shared";
import { api } from "./client.js";

export type { DetectedOutputForUI } from "@armyofagents/shared";

export interface ConfirmDetectedOutputPayload {
  artifactId?: string;
  title?: string;
  type?: string;
  changelog?: string | null;
}

export interface ConfirmDetectedOutputResult {
  artifactId: string;
  versionId: string;
  status: "confirmed";
}

export const outputDetectionApi = {
  listForIssue: (issueId: string) =>
    api.get<DetectedOutputForUI[]>(`/issues/${issueId}/detected-outputs`),

  listForRun: (runId: string) =>
    api.get<DetectedOutputForUI[]>(`/heartbeat-runs/${runId}/detected-outputs`),

  confirm: (runId: string, index: number, payload: ConfirmDetectedOutputPayload) =>
    api.post<ConfirmDetectedOutputResult>(
      `/heartbeat-runs/${runId}/detected-outputs/${index}/confirm`,
      payload,
    ),

  dismiss: (runId: string, index: number) =>
    api.post<{ status: "dismissed" }>(
      `/heartbeat-runs/${runId}/detected-outputs/${index}/dismiss`,
      {},
    ),
};
