import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockEq, mockAnd } = vi.hoisted(() => ({
  mockEq: vi.fn((..._args: unknown[]) => "eq-result"),
  mockAnd: vi.fn((..._args: unknown[]) => "and-result"),
}));

vi.mock("drizzle-orm", () => ({
  eq: mockEq,
  and: mockAnd,
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    companies: makeTable("companies"),
    environments: makeTable("environments"),
    environmentLeases: makeTable("environment_leases"),
    executionTargets: makeTable("execution_targets"),
  };
});

import {
  environmentService,
  mayCompanyPinExecutionTarget,
} from "../services/environments.js";
import { companies, environmentLeases, environments, executionTargets } from "@armyofagents/db";

type MockRow = Record<string, unknown>;

function createSequenceDb(
  config: {
    selects?: MockRow[][];
    inserts?: MockRow[][];
    updates?: MockRow[][];
    deletes?: MockRow[][];
  } = {},
) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  let deleteIdx = 0;
  const selects = config.selects ?? [];
  const inserts = config.inserts ?? [];
  const updates = config.updates ?? [];
  const deletes = config.deletes ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of [
      "from",
      "where",
      "values",
      "returning",
      "set",
      "onConflictDoUpdate",
      "orderBy",
      "for",
    ]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => deletes[deleteIdx++] ?? []),
  } as any;
}

const COMPANY = "00000000-0000-0000-0000-000000000001";
const ORG = "00000000-0000-0000-0000-000000000011";
const OTHER_ORG = "00000000-0000-0000-0000-000000000012";
const TARGET = "00000000-0000-0000-0000-000000000021";

function makeEnv(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "e1",
    companyId: COMPANY,
    name: "production",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    metadata: null,
    envVars: {},
    connectionTarget: null,
    target: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeLease(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "lease-1",
    companyId: COMPANY,
    environmentId: "e1",
    executionWorkspaceId: null,
    issueId: "issue-1",
    heartbeatRunId: "run-1",
    status: "active",
    leasePolicy: "ephemeral",
    provider: "local",
    providerLeaseId: null,
    acquiredAt: new Date("2026-01-01T00:00:00Z"),
    lastUsedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: null,
    releasedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: { driver: "local" },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("environmentService", () => {
  beforeEach(() => {
    mockEq.mockClear();
    mockAnd.mockClear();
  });

  describe("execution-target ownership", () => {
    it("allows system targets and same-Organization targets only", () => {
      expect(mayCompanyPinExecutionTarget(ORG, null)).toBe(true);
      expect(mayCompanyPinExecutionTarget(ORG, ORG)).toBe(true);
      expect(mayCompanyPinExecutionTarget(ORG, OTHER_ORG)).toBe(false);
      expect(mayCompanyPinExecutionTarget(null, ORG)).toBe(false);
    });

    it("creates with a same-Organization execution target", async () => {
      const env = makeEnv({ executionTargetId: TARGET });
      const db = createSequenceDb({
        selects: [[{ organizationId: ORG }], [{ organizationId: ORG }]],
        inserts: [[env]],
      });

      const result = await environmentService(db).create(COMPANY, {
        name: "production",
        executionTargetId: TARGET,
      });

      expect(result).toEqual(env);
      expect(mockEq).toHaveBeenCalledWith(companies.id, COMPANY);
      expect(mockEq).toHaveBeenCalledWith(executionTargets.id, TARGET);
    });

    it("uses the same non-enumerating 422 for missing and cross-Organization targets", async () => {
      const crossOrgDb = createSequenceDb({
        selects: [[{ organizationId: ORG }], [{ organizationId: OTHER_ORG }]],
      });
      const missingDb = createSequenceDb({
        selects: [[{ organizationId: ORG }], []],
      });

      for (const db of [crossOrgDb, missingDb]) {
        await expect(environmentService(db).create(COMPANY, {
          name: "production",
          executionTargetId: TARGET,
        })).rejects.toMatchObject({
          status: 422,
          message: "Execution target is unavailable for this company",
        });
      }
    });

    it("preserves omitted updates and permits an explicit null clear without ownership reads", async () => {
      const omitted = makeEnv({ name: "renamed", executionTargetId: TARGET });
      const cleared = makeEnv({ executionTargetId: null });
      const db = createSequenceDb({ updates: [[omitted], [cleared]] });
      const svc = environmentService(db);

      expect(await svc.update(COMPANY, "e1", { name: "renamed" })).toEqual(omitted);
      expect(await svc.update(COMPANY, "e1", { executionTargetId: null })).toEqual(cleared);
    });
  });

  describe("list", () => {
    it("returns empty array when no environments exist", async () => {
      const db = createSequenceDb({ selects: [[]] });
      const svc = environmentService(db);
      const result = await svc.list(COMPANY);
      expect(result).toEqual([]);
    });

    it("returns all environments for the company", async () => {
      const envs = [makeEnv(), makeEnv({ id: "e2", name: "staging" })];
      const db = createSequenceDb({ selects: [envs] });
      const svc = environmentService(db);
      const result = await svc.list(COMPANY);
      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe("production");
      expect(result[1]!.name).toBe("staging");
    });
  });

  describe("get", () => {
    it("returns the environment when found", async () => {
      const env = makeEnv();
      const db = createSequenceDb({ selects: [[env]] });
      const svc = environmentService(db);
      const result = await svc.get(COMPANY, "e1");
      expect(result).toEqual(env);
    });

    it("returns null when not found", async () => {
      const db = createSequenceDb({ selects: [[]] });
      const svc = environmentService(db);
      const result = await svc.get(COMPANY, "nonexistent");
      expect(result).toBeNull();
    });

    it("calls eq with correct column references and values", async () => {
      const env = makeEnv();
      const db = createSequenceDb({ selects: [[env]] });
      const svc = environmentService(db);
      await svc.get(COMPANY, "e1");
      expect(mockEq).toHaveBeenCalledWith(environments.id, "e1");
      expect(mockEq).toHaveBeenCalledWith(environments.companyId, COMPANY);
    });
  });

  describe("create", () => {
    it("inserts and returns the new environment", async () => {
      const env = makeEnv({ name: "preview", envVars: { PORT: "3000" } });
      const db = createSequenceDb({ inserts: [[env]] });
      const svc = environmentService(db);
      const result = await svc.create(COMPANY, {
        name: "preview",
        envVars: { PORT: "3000" },
      });
      expect(result).toEqual(env);
      expect(result!.name).toBe("preview");
    });

    it("inserts and returns a target-aware environment", async () => {
      const target = { type: "sandbox-docker", image: "node:22-bookworm" };
      const env = makeEnv({ name: "docker", target });
      const db = createSequenceDb({ inserts: [[env]] });
      const svc = environmentService(db);
      const result = await svc.create(COMPANY, {
        name: "docker",
        envVars: {},
        target,
      });
      expect(result).toEqual(env);
      expect(result!.target).toEqual(target);
    });

    it("returns null when insert returns empty (no row)", async () => {
      const db = createSequenceDb({ inserts: [[]] });
      const svc = environmentService(db);
      const result = await svc.create(COMPANY, { name: "preview", envVars: {} });
      expect(result).toBeNull();
    });
  });

  describe("update", () => {
    it("updates fields and returns the updated environment", async () => {
      const updated = makeEnv({ name: "prod-updated" });
      const db = createSequenceDb({ updates: [[updated]] });
      const svc = environmentService(db);
      const result = await svc.update(COMPANY, "e1", { name: "prod-updated" });
      expect(result).toEqual(updated);
      expect(result!.name).toBe("prod-updated");
    });

    it("updates the execution target", async () => {
      const target = { type: "local" };
      const updated = makeEnv({ target });
      const db = createSequenceDb({ updates: [[updated]] });
      const svc = environmentService(db);
      const result = await svc.update(COMPANY, "e1", { target });
      expect(result!.target).toEqual(target);
    });

    it("returns null when environment not found", async () => {
      const db = createSequenceDb({ updates: [[]] });
      const svc = environmentService(db);
      const result = await svc.update(COMPANY, "nonexistent", { name: "x" });
      expect(result).toBeNull();
    });
  });

  describe("delete", () => {
    it("returns the deleted environment when it exists", async () => {
      const env = makeEnv();
      const db = createSequenceDb({ deletes: [[env]] });
      const svc = environmentService(db);
      const result = await svc.delete(COMPANY, "e1");
      expect(result).toEqual(env);
    });

    it("returns null when environment does not exist", async () => {
      const db = createSequenceDb({ deletes: [[]] });
      const svc = environmentService(db);
      const result = await svc.delete(COMPANY, "nonexistent");
      expect(result).toBeNull();
    });

    it("calls eq with correct column references and values", async () => {
      const env = makeEnv();
      const db = createSequenceDb({ deletes: [[env]] });
      const svc = environmentService(db);
      await svc.delete(COMPANY, "e1");
      expect(mockEq).toHaveBeenCalledWith(environments.id, "e1");
      expect(mockEq).toHaveBeenCalledWith(environments.companyId, COMPANY);
    });
  });

  describe("leases", () => {
    it("acquires a company-scoped lease for an owned environment", async () => {
      const lease = makeLease();
      const db = createSequenceDb({
        selects: [[makeEnv({ id: "e1" })]],
        inserts: [[lease]],
      });
      const svc = environmentService(db);
      const result = await svc.acquireLease({
        companyId: COMPANY,
        environmentId: "e1",
        issueId: "issue-1",
        heartbeatRunId: "run-1",
        provider: "local",
        metadata: { driver: "local" },
      });
      expect(result).toEqual(lease);
      expect(mockEq).toHaveBeenCalledWith(environments.companyId, COMPANY);
      expect(mockEq).toHaveBeenCalledWith(environments.id, "e1");
    });

    it("rejects cross-company lease acquisition when the environment is not visible", async () => {
      const db = createSequenceDb({ selects: [[]] });
      const svc = environmentService(db);
      await expect(svc.acquireLease({
        companyId: COMPANY,
        environmentId: "other-company-env",
        heartbeatRunId: "run-1",
      })).rejects.toThrow(/environment not found/i);
    });

    it("releases active leases for a completed heartbeat run", async () => {
      const released = makeLease({ status: "released", releasedAt: new Date("2026-01-01T00:01:00Z") });
      const db = createSequenceDb({ updates: [[released]] });
      const svc = environmentService(db);
      const result = await svc.releaseLeasesForRun("run-1");
      expect(result).toEqual([released]);
      expect(mockEq).toHaveBeenCalledWith(environmentLeases.heartbeatRunId, "run-1");
      expect(mockEq).toHaveBeenCalledWith(environmentLeases.status, "active");
    });

    it("marks a lease failed with cleanup metadata", async () => {
      const failed = makeLease({
        status: "failed",
        failureReason: "provision command failed",
        cleanupStatus: "pending",
      });
      const db = createSequenceDb({ updates: [[failed]] });
      const svc = environmentService(db);
      const result = await svc.releaseLease("lease-1", "failed", {
        failureReason: "provision command failed",
        cleanupStatus: "pending",
      });
      expect(result).toEqual(failed);
      expect(mockEq).toHaveBeenCalledWith(environmentLeases.id, "lease-1");
    });

    // TOCTOU CAS: the warm reaper / cap-evictor claims a paused lease with a
    // status-guarded compare-and-swap BEFORE force-killing its VM, so a
    // concurrent resume (reactivatePausedLease, WHERE status='paused') and a
    // destroy can never both win the same row.
    it("expireLeaseIfPaused returns the row and sets status=expired when the lease is still paused", async () => {
      const expired = makeLease({
        status: "expired",
        releasedAt: new Date("2026-01-01T00:02:00Z"),
        cleanupStatus: "success",
      });
      const db = createSequenceDb({ updates: [[expired]] });
      const svc = environmentService(db);
      const result = await svc.expireLeaseIfPaused("lease-1", { cleanupStatus: "success" });
      expect(result).toEqual(expired);
      // The status guard is the concurrency latch: WHERE id = ? AND status = 'paused'.
      expect(mockEq).toHaveBeenCalledWith(environmentLeases.id, "lease-1");
      expect(mockEq).toHaveBeenCalledWith(environmentLeases.status, "paused");
    });

    it("expireLeaseIfPaused returns null when 0 rows match (lease was resumed/claimed since the scan)", async () => {
      const db = createSequenceDb({ updates: [[]] });
      const svc = environmentService(db);
      const result = await svc.expireLeaseIfPaused("lease-1");
      expect(result).toBeNull();
    });
  });
});
