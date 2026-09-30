import { describe, expect, it, vi } from "vitest";
import { resolveAgentCompletionPolicy } from "../services/agent-completion-policy.js";

function makePolicyDb() {
  const rows = [
    [{ policyDefault: "review_required", reviewGuardrail: false }],
    [{ id: "project-1", type: "project", policyDefault: "agent_can_complete" }],
  ];
  const lockModes: string[] = [];
  let selectIndex = 0;

  return {
    db: {
      select: vi.fn(() => {
        const result = rows[selectIndex++] ?? [];
        const chain: any = {};
        chain.from = () => chain;
        chain.where = () => chain;
        chain.for = (mode: string) => {
          lockModes.push(mode);
          return chain;
        };
        chain.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve);
        return chain;
      }),
    },
    lockModes,
  };
}

describe("completion-policy source locking", () => {
  it("locks company and project policy rows before snapshotting a task", async () => {
    const { db, lockModes } = makePolicyDb();

    const resolved = await resolveAgentCompletionPolicy(db as never, {
      companyId: "company-1",
      projectId: "project-1",
      lockSources: true,
    });

    expect(lockModes).toEqual(["no key update", "share"]);
    expect(resolved).toMatchObject({
      policy: "agent_can_complete",
      source: "project",
      sourceId: "project-1",
    });
  });
});
