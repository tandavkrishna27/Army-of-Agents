import { describe, it, expect } from "vitest";
import { parseInviteRoleMetadata } from "../team.js";

describe("parseInviteRoleMetadata", () => {
  it("returns email + role for a teamInvite payload", () => {
    const meta = parseInviteRoleMetadata({
      teamInvite: { role: "team_member", email: "Ada@Example.com", projectId: null, parentId: null },
    });
    expect(meta).toEqual({ email: "Ada@Example.com", role: "team_member", projectId: null, parentId: null });
  });

  it("returns null for a payload without a valid role", () => {
    expect(parseInviteRoleMetadata({ teamInvite: { email: "a@b.c" } })).toBeNull();
    expect(parseInviteRoleMetadata(null)).toBeNull();
  });
});
