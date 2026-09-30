import { describe, expect, it } from "vitest";
import {
  companyInviteExpiresAt,
  inviteDefaultsHaveBoundEmail,
} from "../routes/access-helpers.js";

const CREATED_AT_MS = Date.parse("2026-03-06T00:00:00.000Z");
const TEN_MINUTES_LATER = "2026-03-06T00:10:00.000Z";
const SEVEN_DAYS_LATER = "2026-03-13T00:00:00.000Z";
const EMAIL_BOUND_PAYLOAD = {
  teamInvite: { role: "team_member", email: "ada@example.com" },
};

describe("companyInviteExpiresAt", () => {
  it("sets open-invite expiration to 10 minutes after invite creation time", () => {
    const expiresAt = companyInviteExpiresAt(null, null, CREATED_AT_MS);
    expect(expiresAt.toISOString()).toBe(TEN_MINUTES_LATER);
  });

  it("keeps the 10-minute TTL for agent invites (no teamInvite payload)", () => {
    const expiresAt = companyInviteExpiresAt(
      { agentMessage: "welcome" },
      "agent",
      CREATED_AT_MS,
    );
    expect(expiresAt.toISOString()).toBe(TEN_MINUTES_LATER);
  });

  it("keeps the 10-minute TTL when teamInvite has no email", () => {
    const expiresAt = companyInviteExpiresAt(
      { teamInvite: { role: "team_member", email: "   " } },
      "human",
      CREATED_AT_MS,
    );
    expect(expiresAt.toISOString()).toBe(TEN_MINUTES_LATER);
  });

  it("gives human-only email-bound team invites a 7-day expiration", () => {
    const expiresAt = companyInviteExpiresAt(
      EMAIL_BOUND_PAYLOAD,
      "human",
      CREATED_AT_MS,
    );
    expect(expiresAt.toISOString()).toBe(SEVEN_DAYS_LATER);
  });

  it("keeps the 10-minute TTL for 'agent'/'both' join types even with a bound email", () => {
    // The agent-join half of an "agent"/"both" invite is gated only by link
    // secrecy — a crafted email payload must not extend its lifetime.
    for (const joinTypes of ["agent", "both"]) {
      const expiresAt = companyInviteExpiresAt(
        EMAIL_BOUND_PAYLOAD,
        joinTypes,
        CREATED_AT_MS,
      );
      expect(expiresAt.toISOString()).toBe(TEN_MINUTES_LATER);
    }
  });

  it("keeps the 10-minute TTL when the join type is missing, even with a bound email", () => {
    const expiresAt = companyInviteExpiresAt(
      EMAIL_BOUND_PAYLOAD,
      null,
      CREATED_AT_MS,
    );
    expect(expiresAt.toISOString()).toBe(TEN_MINUTES_LATER);
  });
});

describe("inviteDefaultsHaveBoundEmail", () => {
  it("is true only when teamInvite.email is a non-empty string", () => {
    expect(inviteDefaultsHaveBoundEmail(null)).toBe(false);
    expect(inviteDefaultsHaveBoundEmail(undefined)).toBe(false);
    expect(inviteDefaultsHaveBoundEmail("string")).toBe(false);
    expect(inviteDefaultsHaveBoundEmail({})).toBe(false);
    expect(inviteDefaultsHaveBoundEmail({ teamInvite: null })).toBe(false);
    expect(inviteDefaultsHaveBoundEmail({ teamInvite: {} })).toBe(false);
    expect(inviteDefaultsHaveBoundEmail({ teamInvite: { email: "" } })).toBe(false);
    expect(inviteDefaultsHaveBoundEmail({ teamInvite: { email: 42 } })).toBe(false);
    expect(
      inviteDefaultsHaveBoundEmail({ teamInvite: { email: "ada@example.com" } }),
    ).toBe(true);
  });
});
