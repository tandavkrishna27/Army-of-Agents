import { describe, it, expect } from "vitest";
import { environmentLeases } from "../schema/environment_leases.js";

describe("environment_leases commander warm columns", () => {
  it("carries the commanderConversationId column", () => {
    expect(environmentLeases.commanderConversationId).toBeDefined();
  });
});
