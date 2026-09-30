import { z } from "zod";

// -----------------------------------------------------------------------------
// Distinct lifecycle machines. Every state set, transition edge, reason guard,
// and terminal set below is a literal copy of the authoritative
// docs/architecture/distributed-execution-lifecycles.json (Decision #121,
// frozen E0/FND-001 authority). Runtime source has NO filesystem access, so the
// maps are embedded literals; states.test.ts loads the JSON and asserts
// byte-for-byte semantic parity against these literals (E1-D001).
//
// Delivery lifecycles (job / attempt / lease) are separate from workload
// lifecycles (browser session / service). `dead_letter` belongs only to job
// policy exhaustion; retry mints a new attempt. Service-instance health/stop/
// loss are service-instance transitions and never enter a generic attempt
// terminal payload.
// -----------------------------------------------------------------------------

/** Fail-closed transition check for an unguarded machine. An unknown `from`
 * (e.g. a state from a different lifecycle) yields no outgoing edges. */
function canTransition<S extends string>(
  transitions: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): boolean {
  return ((transitions[from] as readonly S[] | undefined) ?? []).includes(to);
}

// --- Workload types (locked V1 set) ------------------------------------------

export const WORKLOAD_TYPES = ["batch", "browser_session", "service"] as const;
export const workloadTypeSchema = z.enum(WORKLOAD_TYPES);
export type WorkloadType = (typeof WORKLOAD_TYPES)[number];

// --- Job lifecycle (guarded terminal reasons) --------------------------------

export const JOB_STATUSES = [
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "dead_letter",
] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Reason accompanying a job transition. Only `policy_exhausted` permits
 * `dead_letter`; only `non_retryable_failure` permits aggregate `failed`. */
export const JOB_TRANSITION_REASONS = [
  "normal",
  "cancel",
  "non_retryable_failure",
  "policy_exhausted",
] as const;
export const jobTransitionReasonSchema = z.enum(JOB_TRANSITION_REASONS);
export type JobTransitionReason = (typeof JOB_TRANSITION_REASONS)[number];

const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running", "cancel_requested", "cancelled"],
  running: ["cancel_requested", "succeeded", "failed", "dead_letter"],
  cancel_requested: ["cancelled", "failed", "dead_letter"],
  succeeded: [],
  failed: [],
  cancelled: [],
  dead_letter: [],
};

// Guard keyed by target terminal state; the reason is a property of the target,
// consistent across every from-state (matches the JSON `guards` object).
const JOB_TERMINAL_REASON_GUARDS: Readonly<Partial<Record<JobStatus, JobTransitionReason>>> = {
  dead_letter: "policy_exhausted",
  failed: "non_retryable_failure",
};

/** The job predicate requires an explicit `reason` (no default) so a caller can
 * never accidentally dead-letter or fail a job without stating the cause. */
export function canTransitionJobStatus(
  from: JobStatus,
  to: JobStatus,
  { reason }: { reason: JobTransitionReason },
): boolean {
  const targets = (JOB_TRANSITIONS[from] as readonly JobStatus[] | undefined) ?? [];
  if (!targets.includes(to)) return false;
  const guard = JOB_TERMINAL_REASON_GUARDS[to];
  if (guard !== undefined) return reason === guard;
  return true;
}

// --- Attempt lifecycle -------------------------------------------------------

export const ATTEMPT_STATUSES = [
  "pending",
  "offered",
  "leased",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;
export const attemptStatusSchema = z.enum(ATTEMPT_STATUSES);
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  pending: ["offered", "cancelled", "expired"],
  offered: ["leased", "expired", "cancelled"],
  leased: ["running", "cancel_requested", "expired", "cancelled"],
  running: ["cancel_requested", "succeeded", "failed", "expired"],
  cancel_requested: ["cancelled", "succeeded", "failed", "expired"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export function canTransitionAttemptStatus(from: AttemptStatus, to: AttemptStatus): boolean {
  return canTransition(ATTEMPT_TRANSITIONS, from, to);
}

// --- Lease lifecycle ---------------------------------------------------------

export const LEASE_STATUSES = ["offered", "active", "released", "expired", "revoked"] as const;
export const leaseStatusSchema = z.enum(LEASE_STATUSES);
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

const LEASE_TRANSITIONS: Readonly<Record<LeaseStatus, readonly LeaseStatus[]>> = {
  offered: ["active", "expired", "revoked"],
  active: ["released", "expired", "revoked"],
  released: [],
  expired: [],
  revoked: [],
};

export function canTransitionLeaseStatus(from: LeaseStatus, to: LeaseStatus): boolean {
  return canTransition(LEASE_TRANSITIONS, from, to);
}

// --- Browser-session lifecycle -----------------------------------------------

export const BROWSER_SESSION_STATUSES = [
  "queued",
  "leased",
  "starting",
  "active",
  "waiting_approval",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;
export const browserSessionStatusSchema = z.enum(BROWSER_SESSION_STATUSES);
export type BrowserSessionStatus = (typeof BROWSER_SESSION_STATUSES)[number];

const BROWSER_SESSION_TRANSITIONS: Readonly<Record<BrowserSessionStatus, readonly BrowserSessionStatus[]>> = {
  queued: ["leased", "cancelled", "expired"],
  leased: ["starting", "cancel_requested", "cancelled", "expired"],
  starting: ["active", "cancel_requested", "failed", "cancelled", "expired"],
  active: ["waiting_approval", "cancel_requested", "succeeded", "failed", "cancelled", "expired"],
  waiting_approval: ["active", "cancel_requested", "failed", "cancelled", "expired"],
  cancel_requested: ["cancelled", "succeeded", "failed", "expired"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export function canTransitionBrowserSessionStatus(
  from: BrowserSessionStatus,
  to: BrowserSessionStatus,
): boolean {
  return canTransition(BROWSER_SESSION_TRANSITIONS, from, to);
}

// --- Service desired-state lifecycle -----------------------------------------

export const SERVICE_DESIRED_STATES = ["running", "paused", "stopped", "deleted"] as const;
export const serviceDesiredStateSchema = z.enum(SERVICE_DESIRED_STATES);
export type ServiceDesiredState = (typeof SERVICE_DESIRED_STATES)[number];

const SERVICE_DESIRED_TRANSITIONS: Readonly<Record<ServiceDesiredState, readonly ServiceDesiredState[]>> = {
  running: ["paused", "stopped", "deleted"],
  paused: ["running", "stopped", "deleted"],
  stopped: ["running", "deleted"],
  deleted: [],
};

export function canTransitionServiceDesiredState(
  from: ServiceDesiredState,
  to: ServiceDesiredState,
): boolean {
  return canTransition(SERVICE_DESIRED_TRANSITIONS, from, to);
}

// --- Service-instance lifecycle ----------------------------------------------

export const SERVICE_INSTANCE_STATUSES = [
  "pending",
  "leased",
  "starting",
  "healthy",
  "unhealthy",
  "stopping",
  "stopped",
  "failed",
  "lost",
] as const;
export const serviceInstanceStatusSchema = z.enum(SERVICE_INSTANCE_STATUSES);
export type ServiceInstanceStatus = (typeof SERVICE_INSTANCE_STATUSES)[number];

const SERVICE_INSTANCE_TRANSITIONS: Readonly<Record<ServiceInstanceStatus, readonly ServiceInstanceStatus[]>> = {
  pending: ["leased", "failed", "lost"],
  leased: ["starting", "stopping", "failed", "lost"],
  starting: ["healthy", "unhealthy", "stopping", "failed", "lost"],
  healthy: ["unhealthy", "stopping", "failed", "lost"],
  unhealthy: ["healthy", "stopping", "failed", "lost"],
  stopping: ["stopped", "failed", "lost"],
  stopped: [],
  failed: [],
  lost: [],
};

export function canTransitionServiceInstanceStatus(
  from: ServiceInstanceStatus,
  to: ServiceInstanceStatus,
): boolean {
  return canTransition(SERVICE_INSTANCE_TRANSITIONS, from, to);
}
