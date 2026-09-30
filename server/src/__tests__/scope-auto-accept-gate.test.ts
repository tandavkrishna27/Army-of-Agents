import { describe, it, expect } from "vitest";
import { resolveScopeAutoAcceptGate } from "../services/crew-task-service.js";

describe("resolveScopeAutoAcceptGate", () => {
  it("maps autonomy to the 3-way gate", () => {
    expect(resolveScopeAutoAcceptGate(0)).toBe("draft_only");
    expect(resolveScopeAutoAcceptGate(1)).toBe("accept_apply");
    expect(resolveScopeAutoAcceptGate(2)).toBe("accept_apply_dispatch");
    expect(resolveScopeAutoAcceptGate(3)).toBe("accept_apply_dispatch"); // clamp-up
  });
  it("fails closed for null/undefined/negative", () => {
    expect(resolveScopeAutoAcceptGate(null)).toBe("draft_only");
    expect(resolveScopeAutoAcceptGate(undefined)).toBe("draft_only");
    expect(resolveScopeAutoAcceptGate(-1)).toBe("draft_only");
  });
});
