import { describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ op: "and", a }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
}));
// Task #39 fix: include internalAgentConfig so resolveCrewAdapterForCompany
// (P1-B fix's new dependency in ensure-command-staff.ts) can resolve.
vi.mock("@armyofagents/db", () => {
  const t = (n: string) => new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return { agents: t("agents"), aoaAgentTriggers: t("aoaAgentTriggers"), internalAgentConfig: t("internalAgentConfig") };
});

// Spy the seeder so we assert it is called per role with the right role key.
const seedMock = vi.fn().mockResolvedValue({ seeded: true });
vi.mock("../services/internal-agent/aoa-agents/seed-commander-bundle.js", () => ({
  seedRoleInstructionBundle: (...a: unknown[]) => seedMock(...a),
  seedCommanderInstructionBundle: vi.fn(),
}));
vi.mock("../services/agent-instructions.js", () => ({ agentInstructionsService: () => ({}) }));

import { ensureCommandStaff } from "../services/internal-agent/aoa-agents/ensure-command-staff.js";

function makeDb() {
  const row = { id: "agent-1", companyId: "c1", name: "Router", adapterConfig: null, runtimeConfig: { aoa: { toolAllowlist: ["x"] } } };
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([row]) })),
        returning: vi.fn().mockResolvedValue([row]),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([row]), then: (f: any) => Promise.resolve(f([row])) })) })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
  } as any;
}

describe("ensureCommandStaff bundle seeding", () => {
  it("seeds an instruction bundle for each command-staff role key (Dispatcher retired in Task 2.7)", async () => {
    seedMock.mockClear();
    await ensureCommandStaff(makeDb(), "c1");
    const roles = seedMock.mock.calls.map((c: any[]) => (c[0] as { role: string }).role).sort();
    // Dispatcher removed from seeding roster: crew-task-service is the sole crew-work creator.
    expect(roles).toEqual(["memory_keeper", "planner", "router"]);
  });

  it("does not throw if seeding fails (provisioning must not break)", async () => {
    seedMock.mockRejectedValue(new Error("disk full"));
    await expect(ensureCommandStaff(makeDb(), "c1")).resolves.toBeUndefined();
  });
});
