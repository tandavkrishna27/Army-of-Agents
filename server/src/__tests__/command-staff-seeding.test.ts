import { describe, it, expect } from "vitest";

// ── Mocks (must precede imports that transitively import drizzle) ────────────
import { vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
}));

vi.mock("../services/internal-agent/aoa-agents/seed-commander-bundle.js", () => ({
  seedCommanderInstructionBundle: vi.fn(),
  seedRoleInstructionBundle: vi.fn(),
}));

vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: vi.fn(() => ({})),
}));

vi.mock("../services/internal-agent/aoa-agents/resolve-crew-adapter.js", () => ({
  resolveCrewAdapterForCompany: vi.fn(),
  needsAdapterBackfill: vi.fn(() => false),
  mergeAdapterConfig: vi.fn(),
}));

vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return {
    agents: t("agents"),
    aoaAgentTriggers: t("aoaAgentTriggers"),
    internalAgentConfig: t("internalAgentConfig"),
    companySkills: t("companySkills"),
  };
});

import {
  SCRIBE_AGENT_NAME,
  SCRIBE_TOOL_ALLOWLIST,
} from "../services/internal-agent/aoa-agents/ensure-extraction-agent.js";

import {
  COMMAND_STAFF_ROLES,
  roleToolAllowlist,
} from "../services/internal-agent/aoa-agents/ensure-command-staff.js";

import {
  COMMANDER_TOOL_ALLOWLIST,
} from "../services/internal-agent/aoa-agents/ensure-commander.js";

describe("Scribe (extended extraction agent)", () => {
  it("is named Scribe", () => {
    expect(SCRIBE_AGENT_NAME).toBe("Scribe");
  });
  it("can submit extracted items but cannot write memory directly", () => {
    expect(SCRIBE_TOOL_ALLOWLIST).toContain("submit_extracted_items");
    expect(SCRIBE_TOOL_ALLOWLIST).not.toContain("create_memory");
    expect(SCRIBE_TOOL_ALLOWLIST).not.toContain("update_memory");
  });
});

describe("Command Staff roster", () => {
  it("defines exactly three roles (Navigator/router, Planner, Memory Keeper) — Dispatcher retired (Task 2.7)", () => {
    expect(COMMAND_STAFF_ROLES.map((r) => r.key)).toEqual([
      "router",
      "planner",
      "memory_keeper",
    ]);
  });

  it("Dispatcher is NOT in COMMAND_STAFF_ROLES (crew-task-service is the sole crew-work creator)", () => {
    const keys = COMMAND_STAFF_ROLES.map((r) => r.key);
    expect(keys).not.toContain("dispatcher");
  });

  it("Memory Keeper can propose memory but never write identity/domain directly", () => {
    const allow = roleToolAllowlist("memory_keeper");
    expect(allow).toContain("suggest_memory");
    expect(allow).not.toContain("create_memory");
    expect(allow).not.toContain("update_memory");
  });

  it("Navigator (router) has attach_to_thread + spin_off_thread (inbound routing intact)", () => {
    const allow = roleToolAllowlist("router");
    expect(allow).toContain("attach_to_thread");
    expect(allow).toContain("spin_off_thread");
    expect(allow).not.toContain("create_task");
  });

  it("Planner still seeded — has create_artifact but not create_task", () => {
    const allow = roleToolAllowlist("planner");
    expect(allow).toContain("create_artifact");
    expect(allow).not.toContain("create_task");
  });

  it("Planner's allowlist includes the 4 crew task tools (Spec B Task 6)", () => {
    // Task 6: Planner is one of the executor roles a task can be dispatched to,
    // so it needs the per-task tools (get_task / post_task_comment /
    // attach_task_artifact / set_task_status). Adding these must not grant it
    // create_task — task creation stays behind the Adjutant chokepoint.
    const allow = roleToolAllowlist("planner");
    expect(allow).toContain("get_task");
    expect(allow).toContain("post_task_comment");
    expect(allow).toContain("attach_task_artifact");
    expect(allow).toContain("set_task_status");
    expect(allow).not.toContain("create_task");
  });
});

describe("Commander ad-hoc create_task (Task 2.7 sanity: non-thread flow unaffected)", () => {
  it("COMMANDER_TOOL_ALLOWLIST still contains create_task (ad-hoc task creation intact)", () => {
    expect(COMMANDER_TOOL_ALLOWLIST).toContain("create_task");
  });
});
