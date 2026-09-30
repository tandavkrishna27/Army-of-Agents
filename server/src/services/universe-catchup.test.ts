import { describe, expect, it, vi } from "vitest";
import { createUniverseCatchupService, type UniverseCatchupDependencies } from "./universe-catchup-core.js";

const scope = {companyId: "company-a", conversationId: "conversation-a", userId: "user-a", role: "founder" as const};
const emptyAttention = {asOf: "2026-09-20T00:00:00.000Z", needsYou: [], ready: [], comingUp: [], nextCursor: null};
function deps(overrides: Partial<UniverseCatchupDependencies> = {}): UniverseCatchupDependencies {
  return {
    requireOwner: vi.fn().mockResolvedValue(undefined),
    currentSeq: vi.fn().mockResolvedValue(9),
    getLayout: vi.fn().mockResolvedValue({schemaVersion: 1, revision: 4, document: {
      panels: [{key: "task-key", ref: {companyId: "company-a", kind: "task", id: "task-a"}, title: "Task", rect: {x:0,y:0,width:400,height:300}, openedOrdinal: 1, minimized: false, pinned: false}],
      order: ["task-key"], selected: "task-key", maximized: null, viewport: {x:0,y:0,zoom:1}, nextOpenedOrdinal: 2,
    }}),
    getTask: vi.fn().mockResolvedValue({id: "task-a", companyId: "company-a", title: "Canonical", status: "done", updatedAt: new Date("2026-09-20T00:00:00Z")}),
    getOutputs: vi.fn().mockResolvedValue([{id:"out-a",issueId:"task-a",type:"artifact_version",title:"Final",status:"active",artifactId:"artifact-a",artifactVersionId:"version-2",updatedAt:new Date("2026-09-20T00:00:01Z")}]),
    getAttention: vi.fn().mockResolvedValue(emptyAttention),
    now: () => new Date("2026-09-20T00:00:02Z"),
    ...overrides,
  };
}

describe("Universe canonical catch-up", () => {
  it("authorizes the owner before anchoring and reading canonical projections", async () => {
    const order: string[] = [];
    const d = deps({
      requireOwner: vi.fn(async () => {order.push("owner");}),
      currentSeq: vi.fn(async () => {order.push("seq"); return 9;}),
      getLayout: vi.fn(async () => {order.push("layout"); return deps().getLayout(scope);}),
    });
    const result = await createUniverseCatchupService(d).get(scope);
    expect(order.slice(0, 3)).toEqual(["owner", "seq", "layout"]);
    expect(result.tasks).toEqual([{id:"task-a",title:"Canonical",status:"done",updatedAt:"2026-09-20T00:00:00.000Z"}]);
    expect(result.outputs[0]?.artifactVersionId).toBe("version-2");
  });

  it("marks a deleted task unavailable without leaking its title or outputs", async () => {
    const d = deps({getTask: vi.fn().mockResolvedValue(null)});
    const result = await createUniverseCatchupService(d).get(scope);
    expect(result.references).toEqual([{key:"task-key",kind:"task",id:"task-a",available:false}]);
    expect(result.tasks).toEqual([]);
    expect(result.outputs).toEqual([]);
    expect(d.getOutputs).not.toHaveBeenCalled();
  });

  it("reports durable and attention degradation explicitly rather than as empty truth", async () => {
    const result = await createUniverseCatchupService(deps({
      currentSeq: vi.fn().mockResolvedValue(null),
      getAttention: vi.fn().mockRejectedValue(new Error("offline")),
    })).get(scope);
    expect(result.currentSeq).toBe(0);
    expect(result.attention).toBeNull();
    expect(result.partialReasons).toEqual(["durable_event_cursor_unavailable", "attention_unavailable"]);
  });
});
