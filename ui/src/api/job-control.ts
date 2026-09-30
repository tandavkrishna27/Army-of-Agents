import type {
  JobDetail,
  JobDrainResult,
  JobSummary,
  WorkerRevokeResult,
  WorkerSummary,
} from "@armyofagents/shared";
import { api } from "./client";

// JOB-008 — the operator job/worker control client. Org+company scoped. `ApiError` is
// THROWN by `./client` (never swallowed), so React Query surfaces every failure to the
// section's visible error/mutation-error UI. A 403 renders the access-required state; a
// 404 (routes absent when the distributed-execution flag is off) renders "not enabled".
//
// The operator CANCEL path is JOB-006's existing worker-control route (reused); the UI
// posts `graceful:false` there for a hard cancel, and DRAIN posts to the graceful route.
export const jobControlApi = {
  listJobs: (organizationId: string, companyId: string) =>
    api.get<JobSummary[]>(`/organizations/${organizationId}/companies/${companyId}/jobs`),
  getJob: (organizationId: string, companyId: string, jobId: string) =>
    api.get<JobDetail>(`/organizations/${organizationId}/companies/${companyId}/jobs/${jobId}`),
  listWorkers: (organizationId: string) =>
    api.get<WorkerSummary[]>(`/organizations/${organizationId}/workers`),
  cancelJob: (organizationId: string, companyId: string, jobId: string, reason: string) =>
    api.post<JobDrainResult>(
      `/organizations/${organizationId}/companies/${companyId}/jobs/${jobId}/cancel`,
      { reason, graceful: false },
    ),
  drainJob: (organizationId: string, companyId: string, jobId: string, reason: string) =>
    api.post<JobDrainResult>(
      `/organizations/${organizationId}/companies/${companyId}/jobs/${jobId}/drain`,
      { reason },
    ),
  revokeWorker: (organizationId: string, workerId: string, reason: string) =>
    api.post<WorkerRevokeResult>(
      `/organizations/${organizationId}/workers/${workerId}/revoke`,
      { reason },
    ),
};
