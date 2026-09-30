import { describe, it, expect } from "vitest";
import { teamsApi } from "../teams";
import { api } from "../client";

describe("teamsApi — uses canonical api.* methods", () => {
  it("exports the expected method names", () => {
    expect(typeof teamsApi.list).toBe("function");
    expect(typeof teamsApi.get).toBe("function");
    expect(typeof teamsApi.create).toBe("function");
    expect(typeof teamsApi.update).toBe("function");
    expect(typeof teamsApi.archive).toBe("function");
    expect(typeof teamsApi.listMembers).toBe("function");
    expect(typeof teamsApi.addMember).toBe("function");
    expect(typeof teamsApi.removeMember).toBe("function");
    expect(typeof teamsApi.updateMemberRole).toBe("function");
    expect(typeof teamsApi.getCoordination).toBe("function");
    expect(typeof teamsApi.upsertCoordination).toBe("function");
  });

  it("api object has the methods we depend on", () => {
    expect(typeof api.get).toBe("function");
    expect(typeof api.post).toBe("function");
    expect(typeof api.patch).toBe("function");
    expect(typeof api.put).toBe("function");
    expect(typeof api.delete).toBe("function");
    expect(typeof api.postForm).toBe("function");
  });
});
