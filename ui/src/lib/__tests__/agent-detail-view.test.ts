import { describe, it, expect } from "vitest";
import { parseAgentDetailView } from "../agent-detail-view";

describe("parseAgentDetailView", () => {
  it("maps configuration alias to configure", () => {
    expect(parseAgentDetailView("configuration")).toBe("configure");
    expect(parseAgentDetailView("configure")).toBe("configure");
  });
  it("passes through known views", () => {
    expect(parseAgentDetailView("instructions")).toBe("instructions");
    expect(parseAgentDetailView("runs")).toBe("runs");
    expect(parseAgentDetailView("skills")).toBe("skills");
  });
  it("defaults unknown/null to overview", () => {
    expect(parseAgentDetailView(null)).toBe("overview");
    expect(parseAgentDetailView("nope")).toBe("overview");
  });
});
