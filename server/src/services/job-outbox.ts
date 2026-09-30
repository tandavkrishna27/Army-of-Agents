import type { NewJobOutbox } from "@armyofagents/db";

export function attemptReadyOutbox(input: {
  id: string;
  organizationId: string;
  companyId: string;
  jobId: string;
  attemptId: string;
  sourceKind: string;
  availableAt: Date;
  createdAt: Date;
}): NewJobOutbox {
  return {
    id: input.id,
    organizationId: input.organizationId,
    companyId: input.companyId,
    jobId: input.jobId,
    attemptId: input.attemptId,
    kind: "attempt_ready",
    status: "pending",
    payload: {
      organizationId: input.organizationId,
      companyId: input.companyId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      sourceKind: input.sourceKind,
    },
    availableAt: input.availableAt,
    attemptCount: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}
