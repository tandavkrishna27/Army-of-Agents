import { describe, expect, it, vi, beforeEach } from "vitest";
import { inspect } from "node:util";
import type { ToolContext } from "../services/internal-agent/types.js";

const updateSummaryMock = vi.hoisted(() => vi.fn());

vi.mock("../services/hub-curation.js", () => ({
  hubCurationService: vi.fn(() => ({
    updateSummary: updateSummaryMock,
  })),
}));

import {
  hubReadCurationContextTool,
  hubUpdateCurationSummaryTool,
} from "../services/internal-agent/tools/hub-curation-tools.js";
import { createToolRegistry } from "../services/internal-agent/tool-registry.js";
import { STEWARD_TOOL_ALLOWLIST } from "../services/internal-agent/aoa-agents/ensure-steward.js";

const COMPANY_ID = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
const HUB_ITEM_ID = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";
const AGENT_ID = "cccccccc-0000-4000-8000-cccccccccccc";

function makeCtx(): ToolContext {
  return {
    companyId: COMPANY_ID,
    userId: "user-1",
    userRole: "team_member",
    enabledCapabilities: [],
    agentKind: "aoa",
    agentId: AGENT_ID,
    toolAllowlist: STEWARD_TOOL_ALLOWLIST,
    db: {} as any,
    services: {} as any,
  } as ToolContext;
}

function makeReadDb(rows: Array<Record<string, unknown>>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, _limit: limit, _where: where } as any;
}

describe("hub.updateCurationSummary tool", () => {
  beforeEach(() => {
    updateSummaryMock.mockReset();
    updateSummaryMock.mockResolvedValue({
      id: HUB_ITEM_ID,
      curationRevision: 3,
      version: 4,
    });
  });

  it("is a narrow coordination tool registered only for curation metadata", () => {
    expect(hubUpdateCurationSummaryTool.name).toBe("hub.updateCurationSummary");
    expect(hubUpdateCurationSummaryTool.category).toBe("coordination");
    expect(hubUpdateCurationSummaryTool.requiresConfirmation).toBe(false);
    expect(createToolRegistry().some((tool) => tool.name === "hub.updateCurationSummary")).toBe(true);
    expect(STEWARD_TOOL_ALLOWLIST).toContain("hub.updateCurationSummary");
    expect(STEWARD_TOOL_ALLOWLIST).not.toContain("post_entry");
  });

  it("requires company scope, hub item id, and expected curation revision", async () => {
    const result = await hubUpdateCurationSummaryTool.execute(
      { companyId: COMPANY_ID, hubItemId: HUB_ITEM_ID, curationGroupSummary: "Explained." },
      makeCtx(),
    );

    expect(result).toMatchObject({
      success: false,
      error: "INVALID_PARAMS",
    });
    expect(updateSummaryMock).not.toHaveBeenCalled();
  });

  it("rejects cross-company writes before reaching the service", async () => {
    const result = await hubUpdateCurationSummaryTool.execute(
      {
        companyId: "dddddddd-0000-4000-8000-dddddddddddd",
        hubItemId: HUB_ITEM_ID,
        expectedCurationRevision: 2,
        curationGroupSummary: "Explained.",
      },
      makeCtx(),
    );

    expect(result).toMatchObject({
      success: false,
      error: "COMPANY_MISMATCH",
    });
    expect(updateSummaryMock).not.toHaveBeenCalled();
  });

  it("rejects lifecycle/source-side action fields", async () => {
    const result = await hubUpdateCurationSummaryTool.execute(
      {
        companyId: COMPANY_ID,
        hubItemId: HUB_ITEM_ID,
        expectedCurationRevision: 2,
        curationGroupSummary: "Explained.",
        action: "resolve",
      },
      makeCtx(),
    );

    expect(result).toMatchObject({
      success: false,
      error: "INVALID_PARAMS",
    });
    expect(updateSummaryMock).not.toHaveBeenCalled();
  });

  it("writes only curation metadata through the curation service using the calling agent id", async () => {
    const result = await hubUpdateCurationSummaryTool.execute(
      {
        companyId: COMPANY_ID,
        hubItemId: HUB_ITEM_ID,
        expectedCurationRevision: 2,
        curationGroupLabel: "Failed runs",
        curationGroupSummary: "Three failures need review.",
        curationReason: "SLA is due in 20 minutes.",
      },
      makeCtx(),
    );

    expect(result).toMatchObject({
      success: true,
      data: { hubItemId: HUB_ITEM_ID, curationRevision: 3 },
    });
    expect(updateSummaryMock).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      hubItemId: HUB_ITEM_ID,
      expectedCurationRevision: 2,
      curationGroupLabel: "Failed runs",
      curationGroupSummary: "Three failures need review.",
      curationReason: "SLA is due in 20 minutes.",
      curatedByAgentId: AGENT_ID,
    });
  });

  it("returns a conflict result when the curation revision is stale", async () => {
    updateSummaryMock.mockRejectedValueOnce({ status: 409, message: "Hub curation metadata changed." });

    const result = await hubUpdateCurationSummaryTool.execute(
      {
        companyId: COMPANY_ID,
        hubItemId: HUB_ITEM_ID,
        expectedCurationRevision: 1,
        curationGroupSummary: "Stale write.",
      },
      makeCtx(),
    );

    expect(result).toMatchObject({
      success: false,
      error: "CURATION_CONFLICT",
    });
  });
});

describe("hub.readCurationContext tool", () => {
  it("is registered and included in the Steward allowlist", () => {
    expect(hubReadCurationContextTool.name).toBe("hub.readCurationContext");
    expect(hubReadCurationContextTool.category).toBe("coordination");
    expect(hubReadCurationContextTool.requiresConfirmation).toBe(false);
    expect(createToolRegistry().some((tool) => tool.name === "hub.readCurationContext")).toBe(true);
    expect(STEWARD_TOOL_ALLOWLIST).toContain("hub.readCurationContext");
  });

  it("rejects cross-company reads before reaching the database", async () => {
    const ctx = makeCtx();
    ctx.db = makeReadDb([]);

    const result = await hubReadCurationContextTool.execute(
      {
        companyId: "dddddddd-0000-4000-8000-dddddddddddd",
        targetType: "item",
        hubItemId: HUB_ITEM_ID,
      },
      ctx,
    );

    expect(result).toMatchObject({
      success: false,
      error: "COMPANY_MISMATCH",
    });
    expect(ctx.db.select).not.toHaveBeenCalled();
  });

  it("returns redacted bounded item context for an item target", async () => {
    const ctx = makeCtx();
    ctx.db = makeReadDb([
      {
        id: HUB_ITEM_ID,
        semanticType: "run_failed",
        sourceType: "heartbeat_run",
        sourceId: "run-1",
        title: "Provider rejected sk-ant-abc123DEF456ghi789",
        summary: "The token sk-ant-abc123DEF456ghi789 failed.",
        priority: "high",
        slaAt: null,
        curationRevision: 2,
      },
    ]);

    const result = await hubReadCurationContextTool.execute(
      {
        companyId: COMPANY_ID,
        targetType: "item",
        hubItemId: HUB_ITEM_ID,
      },
      ctx,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        targetType: "item",
        items: [
          expect.objectContaining({
            hubItemId: HUB_ITEM_ID,
            title: "Provider rejected ***REDACTED***",
            summary: "The token ***REDACTED*** failed.",
            curationRevision: 2,
          }),
        ],
      },
    });
  });

  it("builds group reads against persisted and derived auto group keys", async () => {
    const ctx = makeCtx();
    ctx.db = makeReadDb([
      {
        id: HUB_ITEM_ID,
        semanticType: "run_failed",
        sourceType: "heartbeat_run",
        sourceId: "run-1",
        title: "Failed run",
        summary: null,
        priority: "high",
        slaAt: null,
        curationRevision: 2,
      },
    ]);

    const result = await hubReadCurationContextTool.execute(
      {
        companyId: COMPANY_ID,
        targetType: "group",
        groupKey: `auto:${COMPANY_ID}:run_failed:engineering:heartbeat_run:owner:user-1`,
      },
      ctx,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        targetType: "group",
        groupKey: `auto:${COMPANY_ID}:run_failed:engineering:heartbeat_run:owner:user-1`,
        items: [expect.objectContaining({ hubItemId: HUB_ITEM_ID })],
      },
    });
    const whereCondition = inspect(ctx.db._where.mock.calls[0][0], { depth: 20 });
    expect(whereCondition).toContain("auto:");
    expect(whereCondition).toContain("owner:unassigned");
  });

  it("requires the matching target identifier", async () => {
    const result = await hubReadCurationContextTool.execute(
      {
        companyId: COMPANY_ID,
        targetType: "group",
        hubItemId: HUB_ITEM_ID,
      },
      makeCtx(),
    );

    expect(result).toMatchObject({
      success: false,
      error: "INVALID_PARAMS",
    });
  });
});
