import { describe, expect, it, vi } from "vitest";
import {
  drainMcpConnectorOauthFlows,
  MCP_OAUTH_FLOW_SWEEP_BATCH_SIZE,
  MCP_OAUTH_FLOW_CLAIMED_GRACE_MS,
  oauthFlowExpirationCutoffs,
  sweepMcpConnectorOauthFlows,
} from "../mcp-connector-oauth-flow-sweeper.js";

function fakeDb(candidateBatches: string[][], deletedBatches: string[][] = [], expiredBatches: string[][] = []) {
  const selectLimit = vi.fn(async () => (candidateBatches.shift() ?? []).map((id) => ({ id })));
  const deleteReturning = vi.fn(async () => (deletedBatches.shift() ?? []).map((id) => ({ id })));
  const updateReturning = vi.fn(async () => (expiredBatches.shift() ?? []).map((id) => ({ id })));
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: updateReturning }) }) }),
    delete: () => ({ where: () => ({ returning: deleteReturning }) }),
  };
  return { db: db as any, selectLimit, deleteReturning };
}

describe("MCP OAuth flow sweeper", () => {
  it("gives claimed callbacks grace beyond the provider exchange timeout", () => {
    const now = new Date("2026-08-03T00:00:00.000Z");
    const cutoffs = oauthFlowExpirationCutoffs(now);
    expect(cutoffs.pending).toEqual(now);
    expect(now.getTime() - cutoffs.claimed.getTime()).toBe(MCP_OAUTH_FLOW_CLAIMED_GRACE_MS);
    expect(MCP_OAUTH_FLOW_CLAIMED_GRACE_MS).toBeGreaterThan(10_000);
  });
  it("does no delete when no rows are eligible", async () => {
    const fake = fakeDb([[], []]);
    await expect(sweepMcpConnectorOauthFlows(fake.db)).resolves.toEqual({ expired: 0, deleted: 0 });
    expect(fake.deleteReturning).not.toHaveBeenCalled();
  });

  it("caps every deletion batch at 500", async () => {
    const ids = Array.from({ length: 700 }, (_, index) => `flow-${index}`);
    const fake = fakeDb([[], ids], [ids.slice(0, MCP_OAUTH_FLOW_SWEEP_BATCH_SIZE)]);
    await sweepMcpConnectorOauthFlows(fake.db, { limit: 5_000 });
    expect(fake.selectLimit).toHaveBeenCalledWith(MCP_OAUTH_FLOW_SWEEP_BATCH_SIZE);
  });

  it("marks expired pending/claimed flows before retention deletion", async () => {
    const fake = fakeDb([["pending-1", "claimed-1"], []], [], [["pending-1", "claimed-1"]]);
    await expect(sweepMcpConnectorOauthFlows(fake.db)).resolves.toEqual({ expired: 2, deleted: 0 });
  });

  it("drains full batches until a short batch is reached", async () => {
    const full = Array.from({ length: MCP_OAUTH_FLOW_SWEEP_BATCH_SIZE }, (_, index) => `flow-${index}`);
    const tail = ["tail-1", "tail-2"];
    const fake = fakeDb([[], full, [], tail], [full, tail]);
    await expect(drainMcpConnectorOauthFlows(fake.db)).resolves.toEqual({ expired: 0, deleted: 502 });
    expect(fake.selectLimit).toHaveBeenCalledTimes(4);
  });
});
