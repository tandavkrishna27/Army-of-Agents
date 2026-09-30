import { describe, expect, it } from "vitest";
import { agentIdSchema, principalIdSchema } from "./ids.js";
import {
  EXECUTION_SOURCE_KINDS,
  ONE_SHOT_OPERATION_KINDS,
  PRINCIPAL_TYPES,
  executionSourceV1Schema,
  principalV1Schema,
} from "./source.js";

const AGENT_UUID = "00000000-0000-4000-8000-000000000017";
const OTHER_UUID = "00000000-0000-4000-8000-0000000000ff";

const agentExecutor = { principalType: "agent", principalId: AGENT_UUID } as const;
const userRequester = { principalType: "user", principalId: "better-auth-user-17" } as const;

const taskRun = {
  kind: "task_run",
  runId: "00000000-0000-4000-8000-000000000013",
  issueId: "00000000-0000-4000-8000-000000000014",
  requestedBy: userRequester,
  executionPrincipal: agentExecutor,
  assigneeAgentId: AGENT_UUID,
};

const commanderTurn = {
  kind: "commander_turn",
  internalAgentRunId: "00000000-0000-4000-8000-000000000020",
  conversationId: "00000000-0000-4000-8000-000000000021",
  requestedBy: userRequester,
  executionPrincipal: agentExecutor,
};

const crewRun = {
  kind: "crew_run",
  crewRunId: "00000000-0000-4000-8000-000000000022",
  requestedBy: userRequester,
  executionPrincipal: agentExecutor,
};

const oneShot = {
  kind: "one_shot",
  operationId: "00000000-0000-4000-8000-000000000023",
  operationKind: "extraction",
  requestedBy: { principalType: "system", principalId: "system-extractor" },
  executionPrincipal: agentExecutor,
};

const browserRequest = {
  kind: "browser_request",
  browserRequestId: "00000000-0000-4000-8000-000000000024",
  parentJobId: null,
  requestedBy: userRequester,
  executionPrincipal: agentExecutor,
};

const serviceReconcile = {
  kind: "service_reconcile",
  serviceId: "00000000-0000-4000-8000-000000000025",
  generation: 1,
  reconciliationId: "00000000-0000-4000-8000-000000000026",
  requestedBy: { principalType: "system", principalId: "reconciler" },
  executionPrincipal: { principalType: "service", principalId: "svc-instance-1" },
};

describe("principal vocabulary", () => {
  it("locks the four wire principal types", () => {
    expect([...PRINCIPAL_TYPES].sort()).toEqual(["agent", "service", "system", "user"]);
    for (const principalType of PRINCIPAL_TYPES) {
      expect(principalV1Schema.safeParse({ principalType, principalId: "id-1" }).success).toBe(true);
    }
    expect(principalV1Schema.safeParse({ principalType: "founder", principalId: "x" }).success).toBe(
      false,
    );
  });

  it("is strict — rejects unknown keys on the principal object", () => {
    expect(
      principalV1Schema.safeParse({ principalType: "user", principalId: "u", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("opaque principal identity (Better Auth style)", () => {
  it("accepts representative opaque and UUID-shaped IDs and preserves bytes", () => {
    expect(principalIdSchema.parse("better-auth-user-17")).toBe("better-auth-user-17");
    expect(principalIdSchema.parse("org|user 42")).toBe("org|user 42");
    expect(principalIdSchema.parse(AGENT_UUID)).toBe(AGENT_UUID);
  });

  it("rejects empty, whitespace-only, edge-whitespace, oversized, and non-string IDs", () => {
    expect(principalIdSchema.safeParse("").success).toBe(false);
    expect(principalIdSchema.safeParse("   ").success).toBe(false);
    expect(principalIdSchema.safeParse(" lead").success).toBe(false);
    expect(principalIdSchema.safeParse("trail ").success).toBe(false);
    expect(principalIdSchema.safeParse(42 as unknown as string).success).toBe(false);
  });

  it("bounds at 200 UTF-8 bytes (not code units) — 200 ASCII ok, 201 fails", () => {
    expect(principalIdSchema.safeParse("a".repeat(200)).success).toBe(true);
    expect(principalIdSchema.safeParse("a".repeat(201)).success).toBe(false);
    // "€" is 3 UTF-8 bytes: 66 chars = 198 bytes ok, 67 chars = 201 bytes fails.
    expect(principalIdSchema.safeParse("€".repeat(66)).success).toBe(true);
    expect(principalIdSchema.safeParse("€".repeat(67)).success).toBe(false);
  });

  it("does not normalize accepted IDs (NFD sequence preserved byte-for-byte)", () => {
    const nfd = "é"; // e + combining acute
    expect(principalIdSchema.parse(nfd)).toBe(nfd);
    expect(principalIdSchema.parse(nfd).length).toBe(2);
  });

  it("a UUID-branded domain ID cannot stand in for an opaque PrincipalId and vice versa", () => {
    // An opaque Better-Auth principal text is NOT a valid UUID-branded AgentId.
    expect(agentIdSchema.safeParse("better-auth-user-17").success).toBe(false);
    // A UUID is a valid PrincipalId (opaque text accepts it), but the two schemas
    // are distinct validators — one never stands in for the other.
    expect(principalIdSchema.safeParse(AGENT_UUID).success).toBe(true);
    expect(agentIdSchema.safeParse(AGENT_UUID).success).toBe(true);
  });
});

describe("execution source discriminated union", () => {
  it("locks the six source kinds", () => {
    expect([...EXECUTION_SOURCE_KINDS].sort()).toEqual(
      ["browser_request", "commander_turn", "crew_run", "one_shot", "service_reconcile", "task_run"].sort(),
    );
  });

  it("round-trips every variant with a typed requester and execution principal", () => {
    for (const source of [taskRun, commanderTurn, crewRun, oneShot, browserRequest, serviceReconcile]) {
      const result = executionSourceV1Schema.safeParse(source);
      expect(result.success, source.kind).toBe(true);
    }
  });

  it("fails closed on an unknown source kind", () => {
    expect(executionSourceV1Schema.safeParse({ ...taskRun, kind: "mystery_kind" }).success).toBe(
      false,
    );
    expect(executionSourceV1Schema.safeParse({}).success).toBe(false);
  });

  it("system is a valid requester principal kind (service_reconcile)", () => {
    expect(executionSourceV1Schema.safeParse(serviceReconcile).success).toBe(true);
  });

  it("rejects an oversized/blank principal ID inside a source", () => {
    expect(
      executionSourceV1Schema.safeParse({
        ...crewRun,
        requestedBy: { principalType: "user", principalId: "a".repeat(201) },
      }).success,
    ).toBe(false);
    expect(
      executionSourceV1Schema.safeParse({
        ...crewRun,
        requestedBy: { principalType: "user", principalId: "" },
      }).success,
    ).toBe(false);
  });
});

describe("task_run run/issue exclusivity and executor/assignee binding", () => {
  it("requires runId and issueId on task_run", () => {
    const { runId, ...noRun } = taskRun;
    void runId;
    expect(executionSourceV1Schema.safeParse(noRun).success).toBe(false);
    const { issueId, ...noIssue } = taskRun;
    void issueId;
    expect(executionSourceV1Schema.safeParse(noIssue).success).toBe(false);
  });

  it("rejects fabricated runId/issueId on every non-task source (strict)", () => {
    for (const source of [commanderTurn, crewRun, oneShot, browserRequest, serviceReconcile]) {
      expect(
        executionSourceV1Schema.safeParse({ ...source, runId: taskRun.runId }).success,
        `${source.kind}+runId`,
      ).toBe(false);
      expect(
        executionSourceV1Schema.safeParse({ ...source, issueId: taskRun.issueId }).success,
        `${source.kind}+issueId`,
      ).toBe(false);
    }
  });

  it("requires an agent execution principal whose ID byte-matches assigneeAgentId", () => {
    expect(executionSourceV1Schema.safeParse(taskRun).success).toBe(true);
    // Executor/assignee mismatch is denied.
    expect(
      executionSourceV1Schema.safeParse({
        ...taskRun,
        executionPrincipal: { principalType: "agent", principalId: OTHER_UUID },
      }).success,
    ).toBe(false);
    // A non-agent execution principal is denied even if the ID matches.
    expect(
      executionSourceV1Schema.safeParse({
        ...taskRun,
        executionPrincipal: { principalType: "user", principalId: AGENT_UUID },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys on a source variant (strict)", () => {
    expect(executionSourceV1Schema.safeParse({ ...crewRun, surprise: true }).success).toBe(false);
  });
});

describe("one_shot operation kinds", () => {
  it("locks the exact operation-kind set", () => {
    expect([...ONE_SHOT_OPERATION_KINDS].sort()).toEqual(
      ["compaction", "extraction", "readiness_probe"].sort(),
    );
    for (const operationKind of ONE_SHOT_OPERATION_KINDS) {
      expect(executionSourceV1Schema.safeParse({ ...oneShot, operationKind }).success).toBe(true);
    }
  });

  it("fails closed on an unknown operation kind", () => {
    expect(executionSourceV1Schema.safeParse({ ...oneShot, operationKind: "summarize" }).success).toBe(
      false,
    );
  });
});
