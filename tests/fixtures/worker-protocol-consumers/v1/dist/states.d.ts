import { z } from "zod";
export declare const WORKLOAD_TYPES: readonly ["batch", "browser_session", "service"];
export declare const workloadTypeSchema: z.ZodEnum<["batch", "browser_session", "service"]>;
export type WorkloadType = (typeof WORKLOAD_TYPES)[number];
export declare const JOB_STATUSES: readonly ["queued", "running", "cancel_requested", "succeeded", "failed", "cancelled", "dead_letter"];
export declare const jobStatusSchema: z.ZodEnum<["queued", "running", "cancel_requested", "succeeded", "failed", "cancelled", "dead_letter"]>;
export type JobStatus = (typeof JOB_STATUSES)[number];
/** Reason accompanying a job transition. Only `policy_exhausted` permits
 * `dead_letter`; only `non_retryable_failure` permits aggregate `failed`. */
export declare const JOB_TRANSITION_REASONS: readonly ["normal", "cancel", "non_retryable_failure", "policy_exhausted"];
export declare const jobTransitionReasonSchema: z.ZodEnum<["normal", "cancel", "non_retryable_failure", "policy_exhausted"]>;
export type JobTransitionReason = (typeof JOB_TRANSITION_REASONS)[number];
/** The job predicate requires an explicit `reason` (no default) so a caller can
 * never accidentally dead-letter or fail a job without stating the cause. */
export declare function canTransitionJobStatus(from: JobStatus, to: JobStatus, { reason }: {
    reason: JobTransitionReason;
}): boolean;
export declare const ATTEMPT_STATUSES: readonly ["pending", "offered", "leased", "running", "cancel_requested", "succeeded", "failed", "cancelled", "expired"];
export declare const attemptStatusSchema: z.ZodEnum<["pending", "offered", "leased", "running", "cancel_requested", "succeeded", "failed", "cancelled", "expired"]>;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export declare function canTransitionAttemptStatus(from: AttemptStatus, to: AttemptStatus): boolean;
export declare const LEASE_STATUSES: readonly ["offered", "active", "released", "expired", "revoked"];
export declare const leaseStatusSchema: z.ZodEnum<["offered", "active", "released", "expired", "revoked"]>;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];
export declare function canTransitionLeaseStatus(from: LeaseStatus, to: LeaseStatus): boolean;
export declare const BROWSER_SESSION_STATUSES: readonly ["queued", "leased", "starting", "active", "waiting_approval", "cancel_requested", "succeeded", "failed", "cancelled", "expired"];
export declare const browserSessionStatusSchema: z.ZodEnum<["queued", "leased", "starting", "active", "waiting_approval", "cancel_requested", "succeeded", "failed", "cancelled", "expired"]>;
export type BrowserSessionStatus = (typeof BROWSER_SESSION_STATUSES)[number];
export declare function canTransitionBrowserSessionStatus(from: BrowserSessionStatus, to: BrowserSessionStatus): boolean;
export declare const SERVICE_DESIRED_STATES: readonly ["running", "paused", "stopped", "deleted"];
export declare const serviceDesiredStateSchema: z.ZodEnum<["running", "paused", "stopped", "deleted"]>;
export type ServiceDesiredState = (typeof SERVICE_DESIRED_STATES)[number];
export declare function canTransitionServiceDesiredState(from: ServiceDesiredState, to: ServiceDesiredState): boolean;
export declare const SERVICE_INSTANCE_STATUSES: readonly ["pending", "leased", "starting", "healthy", "unhealthy", "stopping", "stopped", "failed", "lost"];
export declare const serviceInstanceStatusSchema: z.ZodEnum<["pending", "leased", "starting", "healthy", "unhealthy", "stopping", "stopped", "failed", "lost"]>;
export type ServiceInstanceStatus = (typeof SERVICE_INSTANCE_STATUSES)[number];
export declare function canTransitionServiceInstanceStatus(from: ServiceInstanceStatus, to: ServiceInstanceStatus): boolean;
