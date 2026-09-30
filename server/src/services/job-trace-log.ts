// server/src/services/job-trace-log.ts
//
// DEP-007 — the hop-local correlation logger binding for distributed execution.
//
// The distributed-execution trace spine already exists as first-class columns on
// `job_events` (`organizationId, companyId, jobId, attemptId, attemptNumber, leaseId,
// fenceToken, sequence`); DEP-007 adds NO new id. This binds that same spine onto a
// pino child logger at each worker-control hop (JOB-005 event ingest + the poll/ack
// routes) so EVERY structured line for a job carries `jobId` (+ attempt + lease +
// executionSourceKind), and one `jobId`-keyed log query reconstructs the trace across
// hops.
//
// High-cardinality ids belong ONLY in the access-controlled sinks — FORCE-RLS
// `job_events` and the operator-only server logs — NEVER as a metric label (that is the
// `JobControlMetrics` count-only surface). This helper is the log side of that split.
//
// Dormancy: these bindings live only on the worker-control graph, which is mounted
// exclusively inside the `AOA_DISTRIBUTED_EXECUTION_ENABLED` composition-root block, so
// the binding is inherently flag-gated. Binding is a pure `logger.child(...)` — it never
// throws into a job/lease/event control path.

import type { Logger } from "pino";

/**
 * The correlation spine bound onto a hop-local child logger. `organizationId` + `jobId`
 * are the always-present anchors; every other field is optional so a hop binds exactly
 * what it knows (a null/undefined field is OMITTED, never bound as an empty id label).
 * `executionSourceKind` is the execution-source end of the exec-source→job→attempt→
 * lease→sandbox trace.
 */
export interface JobTraceSpine {
  readonly organizationId: string;
  readonly companyId?: string | null;
  readonly jobId: string;
  readonly attemptId?: string | null;
  readonly attemptNumber?: number | null;
  readonly leaseId?: string | null;
  readonly fence?: string | null;
  readonly sequence?: number | null;
  readonly executionSourceKind?: string | null;
}

/**
 * Bind `spine` onto `base` as a pino child. Only defined, non-null fields are bound, so
 * an absent id never becomes an empty/undefined label. The child inherits the base
 * logger's existing bindings.
 */
export function bindJobTraceLogger(base: Logger, spine: JobTraceSpine): Logger {
  const bindings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spine)) {
    if (value !== undefined && value !== null) bindings[key] = value;
  }
  return base.child(bindings);
}
