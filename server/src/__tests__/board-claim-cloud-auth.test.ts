import { describe, it, expect } from "vitest";
import { initializeBoardClaimChallenge, claimBoardOwnership, getBoardClaimWarningUrl } from "../board-claim.js";

const db: any = { select: () => ({ from: () => ({ where: async () => [] }) }) };

describe("board-claim in cloud_auth", () => {
  it("initializes no challenge", async () => {
    await initializeBoardClaimChallenge(db, { deploymentMode: "cloud_auth" });
    expect(getBoardClaimWarningUrl("localhost", 3101)).toBeNull();
  });
  it("claim is a no-op returning invalid", async () => {
    const r = await claimBoardOwnership(db, { token: "x", code: "y", userId: "u1", deploymentMode: "cloud_auth" } as any);
    expect(r.status).toBe("invalid");
  });
});
