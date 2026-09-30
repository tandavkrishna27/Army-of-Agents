// BRW-001 — browser input validation at submit, and its ORDERING (unit-shaped; DEC-03).
//
// `submitJobWithinTenant` takes `repos` as a parameter, so the whole admission→validation
// ordering is testable with a stub and no database.
//
// THE ORDERING IS A SECURITY PROPERTY, not a style preference (review finding F1). The
// pre-existing code computed `inputHash = digest(input.command.input)` at line 121, BEFORE
// the admission gate at :139-153. Validating the browser config at that natural spot would
// give an UNAUTHORIZED caller two distinguishable outcomes — one for a malformed config and
// one for a valid config — which is an authorization oracle. Validation therefore runs
// strictly after the full authority resolution, and these tests pin that by asserting the
// denied responses are IDENTICAL rather than merely both denials.
import { describe, expect, it } from "vitest";
import type { Db, TenantRepositories } from "@armyofagents/db";
import { browserWorkloadV1Schema } from "@armyofagents/worker-protocol";
import { submitJobWithinTenant, type SubmitJobRequest } from "../services/job-submission.js";
import { TenantAdmissionDeniedError } from "../services/tenant-admission.js";
import { HttpError } from "../errors.js";

const ORG = "00000000-0000-4000-8000-0000000000c0";
const COMPANY = "00000000-0000-4000-8000-0000000000c1";
const BROWSER_REQUEST = "00000000-0000-4000-8000-0000000000c2";
const RUN = "00000000-0000-4000-8000-0000000000c3";
const ISSUE = "00000000-0000-4000-8000-0000000000c4";
const AGENT = "00000000-0000-4000-8000-0000000000c5";

const VALID_BROWSER_CONFIG = { locale: "en-GB", recordTrace: true };
/** `engine` is pinned to `chromium` by the frozen schema, so this can never be valid. */
const INVALID_BROWSER_CONFIG = { engine: "firefox" };

interface StubOptions {
  readonly principalAuthorized?: boolean;
  readonly sourceAdmitted?: boolean;
}

/** Captures the row that would have been persisted, so the test can assert on the stored
 * `input` and `inputHash` without a database. */
interface Captured {
  input?: Record<string, unknown>;
  inputHash?: string;
  workloadType?: string;
}

function stubRepos(options: StubOptions = {}): { repos: TenantRepositories; captured: Captured } {
  const captured: Captured = {};
  const principalAuthorized = options.principalAuthorized ?? true;
  const sourceAdmitted = options.sourceAdmitted ?? true;

  const jobControl = {
    admission: async () => ({
      organizationExists: true,
      companyInOrganization: true,
      principalAuthorized,
      requester: principalAuthorized ? { kind: "founder", id: "requester-1" } : null,
    }),
    internalRunSourceIsAdmitted: async () =>
      sourceAdmitted ? { kind: "agent", id: AGENT } : null,
    taskSourceIsAdmitted: async () => (sourceAdmitted ? { kind: "agent", id: AGENT } : null),
    insertJobOnce: async (row: Record<string, unknown>) => {
      captured.input = row.input as Record<string, unknown>;
      captured.inputHash = row.inputHash as string;
      captured.workloadType = row.workloadType as string;
      return { id: row.id as string };
    },
    insertAttempt: async (row: Record<string, unknown>) => ({ id: row.id as string }),
    insertOutbox: async () => undefined,
    findSubmission: async () => null,
    findInitialAttempt: async () => null,
  };

  return { repos: { jobControl } as unknown as TenantRepositories, captured };
}

function browserRequest(input: Record<string, unknown>): SubmitJobRequest {
  return {
    organizationId: ORG,
    companyId: COMPANY,
    principal: { kind: "user", id: "user-1", role: "founder" },
    command: {
      idempotencyKey: "idem-browser-1",
      source: { kind: "browser_request", browserRequestId: BROWSER_REQUEST, parentJobId: null },
      input,
    },
  } as unknown as SubmitJobRequest;
}

async function captureThrow(fn: () => Promise<unknown>): Promise<{ name: string; message: string; status?: number }> {
  try {
    await fn();
    return { name: "NO_THROW", message: "the call unexpectedly succeeded" };
  } catch (error) {
    const err = error as Error & { status?: number };
    return { name: err.constructor.name, message: err.message, status: err.status };
  }
}

describe("BRW-001 F1 — an UNAUTHORIZED caller cannot distinguish a bad config from a good one", () => {
  it("returns an identical denial for a valid and an invalid browser config", async () => {
    const validDenial = await captureThrow(() =>
      submitJobWithinTenant(stubRepos({ principalAuthorized: false }).repos, browserRequest(VALID_BROWSER_CONFIG)),
    );
    const invalidDenial = await captureThrow(() =>
      submitJobWithinTenant(stubRepos({ principalAuthorized: false }).repos, browserRequest(INVALID_BROWSER_CONFIG)),
    );

    expect(validDenial.name).toBe(TenantAdmissionDeniedError.name);
    // The whole point: byte-identical, not merely "both are denials".
    expect(invalidDenial).toEqual(validDenial);
  });

  it("does not leak a 400 to a caller who is denied at the principal gate", async () => {
    const denial = await captureThrow(() =>
      submitJobWithinTenant(stubRepos({ principalAuthorized: false }).repos, browserRequest(INVALID_BROWSER_CONFIG)),
    );
    expect(denial.status).not.toBe(400);
  });

  it("returns an identical denial when the SOURCE authority refuses, valid or invalid config", async () => {
    // Authorization is resolved in two stages: the principal gate, then the per-source
    // authority. Validation must sit after BOTH, or the second stage becomes the oracle.
    const validDenial = await captureThrow(() =>
      submitJobWithinTenant(stubRepos({ sourceAdmitted: false }).repos, browserRequest(VALID_BROWSER_CONFIG)),
    );
    const invalidDenial = await captureThrow(() =>
      submitJobWithinTenant(stubRepos({ sourceAdmitted: false }).repos, browserRequest(INVALID_BROWSER_CONFIG)),
    );
    expect(validDenial.name).toBe(TenantAdmissionDeniedError.name);
    expect(invalidDenial).toEqual(validDenial);
  });
});

describe("BRW-001 F4 — an AUTHORIZED caller gets a 400 for a malformed config", () => {
  it("rejects an invalid browser config with 400, not 403", async () => {
    const rejection = await captureThrow(() =>
      submitJobWithinTenant(stubRepos().repos, browserRequest(INVALID_BROWSER_CONFIG)),
    );
    expect(rejection.name).toBe(HttpError.name);
    expect(rejection.status).toBe(400);
  });

  it("names the offending reason so the caller can act on it", async () => {
    const rejection = await captureThrow(() =>
      submitJobWithinTenant(stubRepos().repos, browserRequest({ maxSessionSeconds: 40_000 })),
    );
    expect(rejection.status).toBe(400);
    expect(rejection.message).toContain("max_session_seconds_above_ceiling");
  });
});

describe("BRW-001 — an accepted browser job persists the NORMALISED workload", () => {
  it("stores a frozen-valid workload rather than the raw blob", async () => {
    const { repos, captured } = stubRepos();
    await submitJobWithinTenant(repos, browserRequest(VALID_BROWSER_CONFIG));

    expect(captured.workloadType).toBe("browser_session");
    // The raw blob had two keys; the frozen schema needs all seven.
    expect(browserWorkloadV1Schema.safeParse(captured.input).success).toBe(true);
    expect(captured.input?.locale).toBe("en-GB");
    expect(captured.input?.recordTrace).toBe(true);
  });

  it("hashes the NORMALISED input, NOT the raw blob", async () => {
    // `inputHash` must describe what actually becomes the workload, or it describes
    // something that never executes.
    //
    // Asserting only `inputHash === digest(captured.input)` would be a check that CANNOT
    // FAIL: it holds trivially whether or not normalisation happened. The load-bearing
    // assertion is that the hash differs from the digest of the RAW submitted blob.
    const { repos, captured } = stubRepos();
    await submitJobWithinTenant(repos, browserRequest(VALID_BROWSER_CONFIG));
    const { createHash } = await import("node:crypto");
    const canonical = (value: unknown): string => {
      if (value === null || typeof value !== "object") return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
    };
    const sha = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

    expect(captured.inputHash).toBe(sha(captured.input));
    // The raw blob had 2 keys; the stored workload has all 7. The hashes MUST differ.
    expect(captured.inputHash).not.toBe(sha(VALID_BROWSER_CONFIG));
    expect(Object.keys(captured.input ?? {})).toHaveLength(7);
  });
});

describe("BRW-001 — a non-browser source is completely unaffected", () => {
  it("stores a task_run input byte-identically, including the empty object", async () => {
    // The registry declares `batch` but does NOT enforce it, so the live cutover path's
    // behaviour must be unchanged. This is the test that would fail if a mutant promoted
    // the batch slot to enforced.
    const { repos, captured } = stubRepos();
    const taskRun = {
      organizationId: ORG,
      companyId: COMPANY,
      principal: { kind: "user", id: "user-1", role: "founder" },
      command: {
        idempotencyKey: "idem-task-1",
        source: { kind: "task_run", runId: RUN, issueId: ISSUE, assigneeAgentId: AGENT },
        input: {},
      },
    } as unknown as SubmitJobRequest;

    await submitJobWithinTenant(repos, taskRun);
    expect(captured.workloadType).toBe("batch");
    expect(captured.input).toEqual({});
  });

  it("stores an arbitrary task_run blob unchanged", async () => {
    const { repos, captured } = stubRepos();
    const blob = { command: "run", args: ["--x"], nonsense: true };
    const taskRun = {
      organizationId: ORG,
      companyId: COMPANY,
      principal: { kind: "user", id: "user-1", role: "founder" },
      command: {
        idempotencyKey: "idem-task-2",
        source: { kind: "task_run", runId: RUN, issueId: ISSUE, assigneeAgentId: AGENT },
        input: blob,
      },
    } as unknown as SubmitJobRequest;

    await submitJobWithinTenant(repos, taskRun);
    expect(JSON.stringify(captured.input)).toBe(JSON.stringify(blob));
  });
});
