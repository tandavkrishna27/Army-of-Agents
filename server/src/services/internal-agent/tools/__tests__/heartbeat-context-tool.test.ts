import { describe, it, expect, vi } from "vitest";
import { getHeartbeatContextTool } from "../heartbeat-context-tool.js";

function ctx(task: any, comments: any[] = []) {
  return {
    companyId: "c1",
    services: { issues: { getById: vi.fn().mockResolvedValue(task), listComments: vi.fn().mockResolvedValue(comments) } },
  } as any;
}

describe("getHeartbeatContextTool", () => {
  it("returns task + up to 10 recent comments", async () => {
    const comments = Array.from({ length: 15 }, (_, i) => ({ id: `c${i}` }));
    const res = await getHeartbeatContextTool.execute({ taskId: "t1" }, ctx({ id: "t1", companyId: "c1" }, comments));
    expect(res.success).toBe(true);
    expect((res.data as any).recentComments).toHaveLength(10);
  });

  it("NOT_FOUND for a cross-company task", async () => {
    const res = await getHeartbeatContextTool.execute({ taskId: "t1" }, ctx({ id: "t1", companyId: "other" }));
    expect(res.error).toBe("NOT_FOUND");
  });
});
