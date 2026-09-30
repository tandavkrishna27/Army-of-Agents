import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_STATUSES,
  ORGANIZATION_ROLES,
  ORGANIZATION_INVITATION_STATUSES,
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_SLUG,
  DEPLOYMENT_MODES,
} from "../constants.js";

describe("organization constants", () => {
  it("statuses mirror the company status vocabulary", () => {
    expect(ORGANIZATION_STATUSES).toEqual(["active", "suspended", "archived"]);
  });
  it("roles are owner|admin|member|billing (locked decision)", () => {
    expect(ORGANIZATION_ROLES).toEqual(["owner", "admin", "member", "billing"]);
  });
  it("invitation statuses cover the full lifecycle", () => {
    expect(ORGANIZATION_INVITATION_STATUSES).toEqual([
      "pending",
      "accepted",
      "revoked",
      "expired",
    ]);
  });
  it("pins the sentinel default-organization id + slug", () => {
    expect(DEFAULT_ORGANIZATION_ID).toBe("00000000-0000-0000-0000-000000000001");
    expect(DEFAULT_ORGANIZATION_SLUG).toBe("default");
  });
  it("adds cloud_auth as the third deployment mode, preserving self-hosted modes", () => {
    expect(DEPLOYMENT_MODES).toEqual(["local_trusted", "authenticated", "cloud_auth"]);
  });
});
