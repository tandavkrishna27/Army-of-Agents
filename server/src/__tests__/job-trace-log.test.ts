import { describe, expect, it } from "vitest";
import pino from "pino";
import { bindJobTraceLogger, type JobTraceSpine } from "../services/job-trace-log.js";

/** Capture every structured record a pino logger writes, parsed back to objects. */
function captureLogger(): { logger: pino.Logger; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const stream = {
    write(chunk: string): void {
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        records.push(JSON.parse(trimmed));
      }
    },
  };
  const logger = pino({ level: "debug" }, stream);
  return { logger, records };
}

const FULL_SPINE: JobTraceSpine = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  jobId: "33333333-3333-4333-8333-333333333333",
  attemptId: "44444444-4444-4444-8444-444444444444",
  attemptNumber: 1,
  leaseId: "55555555-5555-4555-8555-555555555555",
  fence: "fence-token-abc",
  sequence: 2,
  executionSourceKind: "distributed_worker",
};

describe("DEP-007 job-trace correlation logger binding", () => {
  it("binds the full spine so one jobId-keyed query reconstructs the trace across hops", () => {
    const { logger, records } = captureLogger();
    const child = bindJobTraceLogger(logger, FULL_SPINE);
    child.info("job_events ingest");

    expect(records).toHaveLength(1);
    const record = records[0]!;
    // The load-bearing correlation set (invariant #2): jobId + attempt + lease +
    // executionSourceKind — plus the rest of the composite spine — on every line.
    expect(record.jobId).toBe(FULL_SPINE.jobId);
    expect(record.attemptId).toBe(FULL_SPINE.attemptId);
    expect(record.attemptNumber).toBe(FULL_SPINE.attemptNumber);
    expect(record.leaseId).toBe(FULL_SPINE.leaseId);
    expect(record.executionSourceKind).toBe(FULL_SPINE.executionSourceKind);
    expect(record.organizationId).toBe(FULL_SPINE.organizationId);
    expect(record.companyId).toBe(FULL_SPINE.companyId);
    expect(record.fence).toBe(FULL_SPINE.fence);
    expect(record.sequence).toBe(FULL_SPINE.sequence);
    expect(record.msg).toBe("job_events ingest");
  });

  it("omits absent spine fields entirely (never binds an undefined/null id label)", () => {
    const { logger, records } = captureLogger();
    // A hop that only knows the org/job/attempt/lease anchor (e.g. the poll route).
    const child = bindJobTraceLogger(logger, {
      organizationId: FULL_SPINE.organizationId,
      jobId: FULL_SPINE.jobId,
      attemptNumber: 1,
      leaseId: FULL_SPINE.leaseId,
      fence: FULL_SPINE.fence,
      executionSourceKind: "distributed_worker",
      companyId: null,
      attemptId: undefined,
      sequence: undefined,
    });
    child.info("worker poll offer");

    const record = records[0]!;
    expect(record.jobId).toBe(FULL_SPINE.jobId);
    expect(record.leaseId).toBe(FULL_SPINE.leaseId);
    expect(record.executionSourceKind).toBe("distributed_worker");
    // Null/undefined spine fields must not appear as bound keys at all.
    expect(Object.prototype.hasOwnProperty.call(record, "companyId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, "attemptId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, "sequence")).toBe(false);
  });

  it("inherits the base logger's bindings (the child never drops parent context)", () => {
    const { logger, records } = captureLogger();
    const base = logger.child({ component: "worker-control" });
    const child = bindJobTraceLogger(base, FULL_SPINE);
    child.info("hop");

    const record = records[0]!;
    expect(record.component).toBe("worker-control");
    expect(record.jobId).toBe(FULL_SPINE.jobId);
  });
});
