import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  asc: vi.fn((arg: unknown) => ({ op: "asc", arg })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: "eq", left, right })),
  ne: vi.fn((left: unknown, right: unknown) => ({ op: "ne", left, right })),
  isNull: vi.fn((arg: unknown) => ({ op: "isNull", arg })),
  or: vi.fn((...args: unknown[]) => ({ op: "or", args })),
  sql: Object.assign(vi.fn((strings: TemplateStringsArray) => ({ sql: strings })), { raw: vi.fn() }),
}));

vi.mock("@armyofagents/db", () => ({
  agentWakeupRequests: new Proxy({} as Record<string, unknown>, { get: (_target, prop) => String(prop) }),
  agents: new Proxy({} as Record<string, unknown>, { get: (_target, prop) => String(prop) }),
  aoaAgentTriggers: new Proxy({} as Record<string, unknown>, { get: (_target, prop) => String(prop) }),
  hubItems: new Proxy({} as Record<string, unknown>, { get: (_target, prop) => String(prop) }),
  internalAgentConfig: new Proxy({} as Record<string, unknown>, { get: (_target, prop) => String(prop) }),
}));

import { runStewardSweep } from "../services/internal-agent/aoa-agents/sweep-steward.js";
import { isNull } from "drizzle-orm";

interface StewardSweepTrigger {
  agentId: string;
  companyId: string;
  config: Record<string, unknown> | null;
}

interface StewardCandidate {
  id: string;
  companyId: string;
  semanticType: string | null;
  sourceType: string | null;
  sourceId: string | null;
  scopeKey: string | null;
  groupKey: string | null;
  ownerUserId: string | null;
  ownerPool: string | null;
  priority: string;
  slaAt: Date | null;
  status: string;
  version: number;
  curationRevision: number;
  curationGroupLabel: string | null;
  curationGroupSummary: string | null;
  curatedAt: Date | null;
}

function resultHolder(rows: object[]) {
  return {
    limit: vi.fn(() => Promise.resolve(rows)),
    orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(rows)) })),
    then: (resolve: (value: object[]) => unknown) => resolve(rows),
  };
}

function makeDb(options: {
  triggers?: StewardSweepTrigger[];
  companyConfig?: Array<{ crewPaused: boolean }>;
  candidates?: StewardCandidate[];
}) {
  const selectRows = [
    options.triggers ?? [{ agentId: "steward-1", companyId: "company-1", config: { role: "steward" } }],
    options.companyConfig ?? [{ crewPaused: false }],
    options.candidates ?? [],
  ];
  let selectIndex = 0;
  const where = vi.fn(() => resultHolder(selectRows[selectIndex++] ?? []));
  const values = vi.fn(() => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({ where })),
        where,
      })),
    })),
    insert: vi.fn(() => ({ values })),
    _values: values,
  };
  return db;
}

const candidate: StewardCandidate = {
  id: "hub-1",
  companyId: "company-1",
  semanticType: "run_failed",
  sourceType: "heartbeat_run",
  sourceId: "run-1",
  scopeKey: "engineering",
  groupKey: null,
  ownerUserId: "user-1",
  ownerPool: null,
  priority: "urgent",
  slaAt: null,
  status: "open",
  version: 4,
  curationRevision: 2,
  curationGroupLabel: null,
  curationGroupSummary: null,
  curatedAt: null,
};

describe("runStewardSweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs deterministic curation and queues one deduped group-summary wakeup with the Steward contract", async () => {
    const db = makeDb({ candidates: [candidate] });
    const updateSummary = vi.fn().mockResolvedValue({ curationRevision: 3 });
    const result = await runStewardSweep(db as any, {
      curationService: {
        deriveForItem: () => ({
          effectiveGroupKey: "auto:company-1:run_failed:engineering:heartbeat_run:owner:user-1",
          curationGroupLabel: "user-1",
          curationGroupSummary: null,
          curationReason: null,
          curationPriorityReason: "Urgent priority is set on this hub item.",
          nextCurationRevision: 3,
          nextVersion: 4,
        }),
        updateSummary,
      },
    });

    expect(result).toEqual({ curated: 1, queued: 1 });
    expect(updateSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        hubItemId: "hub-1",
        expectedCurationRevision: 2,
        curationGroupLabel: "user-1",
      }),
    );
    expect(db._values).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        agentId: "steward-1",
        source: "sweep.steward",
        reason: "hub_curation_summary",
        status: "queued",
        dedupKey: "steward:company-1:group:auto:company-1:run_failed:engineering:heartbeat_run:owner:user-1:queued",
        payload: {
          role: "steward",
          targetType: "group",
          groupKey: "auto:company-1:run_failed:engineering:heartbeat_run:owner:user-1",
          companyId: "company-1",
          expectedCurationRevision: 3,
          evidence: [
            {
              hubItemId: "hub-1",
              semanticType: "run_failed",
              sourceType: "heartbeat_run",
              sourceId: "run-1",
            },
          ],
        },
      }),
    );
  });

  it("ignores non-Steward sweep triggers and companies whose crew is paused", async () => {
    const db = makeDb({
      triggers: [
        { agentId: "chronicler-1", companyId: "company-1", config: { role: "chronicler" } },
        { agentId: "steward-1", companyId: "company-1", config: { role: "steward" } },
      ],
      companyConfig: [{ crewPaused: true }],
      candidates: [candidate],
    });

    const result = await runStewardSweep(db as any);

    expect(result).toEqual({ curated: 0, queued: 0 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("does not queue language wakeups for items that already have a group summary", async () => {
    const db = makeDb({
      candidates: [{ ...candidate, curationGroupSummary: "Already explained." }],
    });
    const updateSummary = vi.fn().mockResolvedValue({ curationRevision: 3 });

    const result = await runStewardSweep(db as any, {
      curationService: {
        deriveForItem: () => ({
          effectiveGroupKey: "source:run_failed",
          curationGroupLabel: "run_failed",
          curationGroupSummary: null,
          curationReason: null,
          curationPriorityReason: null,
          nextCurationRevision: 3,
          nextVersion: 4,
        }),
        updateSummary,
      },
    });

    expect(result).toEqual({ curated: 1, queued: 0 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("does not bump curation revision again while a Steward group summary is already queued", async () => {
    const db = makeDb({
      candidates: [
        {
          ...candidate,
          curationGroupLabel: "Release risk",
          curationGroupSummary: null,
          curatedAt: new Date("2026-07-01T10:00:00.000Z"),
        },
      ],
    });
    const updateSummary = vi.fn();

    const result = await runStewardSweep(db as any, {
      curationService: {
        deriveForItem: () => ({
          effectiveGroupKey: "source:run_failed",
          curationGroupLabel: "run_failed",
          curationGroupSummary: null,
          curationReason: null,
          curationPriorityReason: null,
          nextCurationRevision: 3,
          nextVersion: 4,
        }),
        updateSummary,
      },
    });

    expect(result).toEqual({ curated: 0, queued: 1 });
    expect(updateSummary).not.toHaveBeenCalled();
    expect(db._values).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          expectedCurationRevision: 2,
        }),
      }),
    );
  });

  it("does not select items again only because quiet reason fields are null", async () => {
    const db = makeDb({ candidates: [] });

    await runStewardSweep(db as any);

    expect(isNull).toHaveBeenCalledWith("curationGroupLabel");
    expect(isNull).toHaveBeenCalledWith("curatedAt");
    expect(isNull).toHaveBeenCalledWith("curationGroupSummary");
    expect(isNull).not.toHaveBeenCalledWith("curationReason");
    expect(isNull).not.toHaveBeenCalledWith("curationPriorityReason");
  });
});

describe("Steward sweep startup wiring", () => {
  it("schedules the Steward sweep with an in-flight guard", () => {
    const source = readFileSync(join(process.cwd(), "server/src/index.ts"), "utf8");

    expect(source).toContain("runStewardSweep");
    expect(source).toContain("STEWARD_SWEEP_INTERVAL_MS");
    expect(source).toContain("stewardSweepInFlight");
    expect(source).toMatch(/if \(stewardSweepInFlight\) return;/);
    expect(source).toContain("steward sweep tick failed");
  });
});
