import { describe, it, expect } from "vitest";
import { resolveBoardRoleForMode } from "../realtime/live-events-ws.js";

describe("resolveBoardRoleForMode (WS board-role clamp)", () => {
  it("local_trusted → founder", () => {
    expect(resolveBoardRoleForMode("local_trusted", true, "team_member")).toBe("founder");
    expect(resolveBoardRoleForMode("local_trusted", false, "team_member")).toBe("founder");
  });
  it("authenticated + instance_admin → founder (parity with REST there)", () => {
    expect(resolveBoardRoleForMode("authenticated", true, "team_member")).toBe("founder");
  });
  it("authenticated without instance_admin → real per-company role", () => {
    expect(resolveBoardRoleForMode("authenticated", false, "team_lead")).toBe("team_lead");
  });
  it("cloud_auth + instance_admin + real team_member → team_member (the fix)", () => {
    expect(resolveBoardRoleForMode("cloud_auth", true, "team_member")).toBe("team_member");
  });
  it("cloud_auth + instance_admin + real founder → founder", () => {
    expect(resolveBoardRoleForMode("cloud_auth", true, "founder")).toBe("founder");
  });
});
