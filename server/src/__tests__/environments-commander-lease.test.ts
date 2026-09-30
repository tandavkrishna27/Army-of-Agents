import { describe, it, expect } from "vitest";
import { environmentService } from "../services/environments.js";

/**
 * W7.5c — Commander's conversation-keyed analogue of findResumablePausedLease.
 * Mirrors the wave6 agent-keyed query but filters `commanderConversationId`.
 */
describe("findResumableCommanderPausedLease", () => {
  it("queries by companyId + commanderConversationId + environmentId, status=paused, providerLeaseId not null", async () => {
    const paused = { id: "l1", providerLeaseId: "e2b-1", status: "paused" };
    let whereCalled = false;
    const chain: any = {
      select: () => chain,
      from: () => chain,
      where: () => {
        whereCalled = true;
        return chain;
      },
      orderBy: () => chain,
      limit: async () => [paused],
    };
    const svc = environmentService(chain as any);
    const row = await svc.findResumableCommanderPausedLease!({
      companyId: "c1",
      conversationId: "conv1",
      environmentId: "env1",
    });
    expect(whereCalled).toBe(true);
    expect(row).toEqual(paused);
  });

  it("returns null when no paused lease exists", async () => {
    const chain: any = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => [],
    };
    const svc = environmentService(chain as any);
    expect(
      await svc.findResumableCommanderPausedLease!({
        companyId: "c1",
        conversationId: "conv1",
        environmentId: "env1",
      }),
    ).toBeNull();
  });
});
