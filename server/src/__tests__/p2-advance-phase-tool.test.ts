import { describe, expect, it, vi } from "vitest";
import { createAdvancePhaseTool } from "../services/internal-agent/tools/advance-phase-tool.js";
import type { ToolContext } from "../services/internal-agent/types.js";

describe("advance_phase tool (P2.3)", () => {
  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      companyId: "co-1",
      userId: "u-1",
      userRole: "team_member",
      enabledCapabilities: [],
      db: {} as any,
      services: {
        threads: { advancePhase: vi.fn().mockResolvedValue(undefined) },
      } as any,
      ...overrides,
    } as unknown as ToolContext;
  }

  it("category/meta: tool has name='advance_phase', category='action', requiresConfirmation=false, requiredRole='team_member'", () => {
    const tool = createAdvancePhaseTool();
    expect(tool.name).toBe("advance_phase");
    expect(tool.category).toBe("action");
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.requiredRole).toBe("team_member");
  });

  it("autonomy gate — rejects when effectiveAutonomy < 2", async () => {
    const tool = createAdvancePhaseTool();
    const ctx = makeCtx({ effectiveAutonomy: 1 });

    const result = await tool.execute({ threadId: "t-1", toPhase: "scope" }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe("AUTONOMY_INSUFFICIENT");

    const advancePhase = ctx.services.threads.advancePhase as ReturnType<typeof vi.fn>;
    expect(advancePhase).not.toHaveBeenCalled();
  });

  it("autonomy gate — rejects when effectiveAutonomy is absent (null)", async () => {
    const tool = createAdvancePhaseTool();
    const ctx = makeCtx({ effectiveAutonomy: null });

    const result = await tool.execute({ threadId: "t-1", toPhase: "scope" }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe("AUTONOMY_INSUFFICIENT");

    const advancePhase = ctx.services.threads.advancePhase as ReturnType<typeof vi.fn>;
    expect(advancePhase).not.toHaveBeenCalled();
  });

  it("advances phase when autonomy = 2", async () => {
    const tool = createAdvancePhaseTool();
    const ctx = makeCtx({
      effectiveAutonomy: 2,
      agentId: "agent-42",
    });

    const result = await tool.execute({ threadId: "t-1", toPhase: "scope" }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ phase: "scope" });
    expect(result.summary).toBe("Thread advanced to phase: scope");

    const advancePhase = ctx.services.threads.advancePhase as ReturnType<typeof vi.fn>;
    expect(advancePhase).toHaveBeenCalledOnce();
    expect(advancePhase).toHaveBeenCalledWith(
      "co-1",
      "t-1",
      "scope",
      { userId: "agent-42", role: "team_member", isHuman: false },
    );
  });
});
