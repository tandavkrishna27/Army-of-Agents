import type {
  EnvironmentDriver,
  EnvironmentLeaseCleanupStatus,
  EnvironmentLeasePolicy,
  EnvironmentLeaseStatus,
  EnvironmentStatus,
} from "../constants.js";

export interface Environment {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  driver: EnvironmentDriver;
  status: EnvironmentStatus;
  config: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  envVars: Record<string, unknown>;
  connectionTarget: Record<string, unknown> | null;
  target: Record<string, unknown> | null;
  // Phase 5 execution-target registry (Task 5 added the DB column + Task 12
  // reads/writes it from Settings > Environments; this response type never
  // picked it up until now). null = route by credential (business key ->
  // pooled_gvisor, personal subscription -> its bound dedicated target).
  executionTargetId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentLease {
  id: string;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;
  agentId: string | null;
  status: EnvironmentLeaseStatus;
  leasePolicy: EnvironmentLeasePolicy;
  provider: string | null;
  providerLeaseId: string | null;
  acquiredAt: string;
  lastUsedAt: string;
  expiresAt: string | null;
  releasedAt: string | null;
  pausedAt: string | null;
  failureReason: string | null;
  cleanupStatus: EnvironmentLeaseCleanupStatus | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentProbeCheck {
  name: string;
  status: "passed" | "failed";
  message: string;
}

export interface EnvironmentProbeResult {
  ok: boolean;
  driver: EnvironmentDriver;
  provider?: string;
  summary: string;
  checks?: EnvironmentProbeCheck[];
  metadata?: Record<string, unknown>;
}
