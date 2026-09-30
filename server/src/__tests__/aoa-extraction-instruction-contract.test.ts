// FX1 / Part B: the seeded extraction-agent instruction must name the tool
// EXACTLY as it is registered + allowlisted: `submit_extracted_items`
// (underscore). It previously said `submit-extracted-items` (hyphen) — a tool
// name that does not exist — so the provisioned agent called a nonexistent
// tool and silently produced no output on the real §17 path.
//
// Pure contract test: imports the constants only, no db / drizzle. The
// drizzle-orm + @armyofagents/db mocks exist solely so importing the module
// (which statically imports them) does not pull the real ESM cycle.
import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));
vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined),
    });
  return { agents: t("agents"), aoaAgentTriggers: t("agt") };
});

import {
  EXTRACTION_INSTRUCTION,
  EXTRACTION_AGENT_TOOL_ALLOWLIST,
} from "../services/internal-agent/aoa-agents/ensure-extraction-agent.js";

describe("FX1: extraction-agent instruction ↔ registered tool-name contract", () => {
  it("EXTRACTION_INSTRUCTION names the underscore tool, not the hyphen one", () => {
    expect(EXTRACTION_INSTRUCTION).toContain("submit_extracted_items");
    expect(EXTRACTION_INSTRUCTION).not.toContain("submit-extracted-items");
  });

  it("instruction tool-name matches the allowlist entry exactly", () => {
    expect(EXTRACTION_AGENT_TOOL_ALLOWLIST[0]).toBe("submit_extracted_items");
    expect(EXTRACTION_INSTRUCTION).toContain(EXTRACTION_AGENT_TOOL_ALLOWLIST[0]);
  });
});
