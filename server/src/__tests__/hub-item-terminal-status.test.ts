import { describe, expect, it } from "vitest";
import { terminalHubStatusForSource } from "../services/hub-items.js";

describe("terminal hub-item status", () => {
  it("resolves completed work questions into resolved history", () => {
    expect(terminalHubStatusForSource("work_question")).toBe("resolved");
  });

  it("keeps non-work-question terminal sources archived", () => {
    expect(terminalHubStatusForSource("runtime_decision")).toBe("archived");
    expect(terminalHubStatusForSource("approval")).toBe("archived");
  });
});
