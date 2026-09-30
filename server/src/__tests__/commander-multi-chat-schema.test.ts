import { describe, expect, it } from "vitest";
import { internalAgentConversations } from "@armyofagents/db";

describe("internalAgentConversations schema: multi-chat fields", () => {
  const columns = Object.keys(internalAgentConversations);

  it("has title column", () => {
    expect(columns).toContain("title");
  });

  it("has archivedAt column", () => {
    expect(columns).toContain("archivedAt");
  });

  it("has sharedWithCompany column", () => {
    expect(columns).toContain("sharedWithCompany");
  });
});
