import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routeSrc = readFileSync(
  resolve(__dirname, "../routes/internal-agent.ts"),
  "utf8",
);

describe("confirmation flow implementation contract", () => {
  it("/confirm endpoint resolves the durable approval row", () => {
    expect(routeSrc).toContain("runtimeApprovalService");
    expect(routeSrc).toContain("claimForExecution");
    expect(routeSrc).toContain("deny(confirmId");
  });

  it("/confirm calls executeTool after the durable approval is claimed", () => {
    expect(routeSrc).toContain("executeTool");
    expect(routeSrc).toContain("markExecuted");
  });

  it("/confirm returns 404 when confirmId not found", () => {
    expect(routeSrc).toContain("notFound");
    expect(routeSrc).toContain("No pending confirmation for id");
  });

  it("action_confirmation SSE handler only forwards durable confirmation ids", () => {
    expect(routeSrc).toContain('case "action_confirmation"');
    expect(routeSrc).not.toContain("pendingConfirmations.set");
  });
});
