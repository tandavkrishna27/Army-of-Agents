import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routeSrc = readFileSync(
  resolve(__dirname, "../routes/internal-agent.ts"),
  "utf8",
);

const convSrc = readFileSync(
  resolve(__dirname, "../services/internal-agent/conversation.ts"),
  "utf8",
);

describe("conversation messages endpoint — implementation contract", () => {
  it("has GET conversations/:convId/messages route", () => {
    expect(routeSrc).toContain("conversations/:convId/messages");
    expect(routeSrc).toContain("router.get");
  });

  it("GET route uses loadOwnedConversation for ownership check (includes founder bypass)", () => {
    // The messages route delegates ownership to loadOwnedConversation, which
    // applies the same founder bypass used by archive/pin/rename/delete.
    expect(routeSrc).toContain("loadOwnedConversation");
  });

  it("GET route throws 404 when conversation not found", () => {
    expect(routeSrc).toContain("notFound");
  });

  it("chat route accepts optional conversationId in body", () => {
    expect(routeSrc).toContain("conversationId");
    expect(routeSrc).toContain("chatMessageSchema");
  });

  it("chat route uses shared chat schema and forwards structured context scope", () => {
    // Tolerant of other members on the same shared import line (e.g. AGENT_PROVIDERS,
    // added by the provider-switching reconnect) — assert the two symbols are imported
    // from @armyofagents/shared, not the exact member list.
    expect(routeSrc).toMatch(
      /import \{[^}]*\bCOMMANDER_TOOL_PERMISSION_DEFAULT\b[^}]*\bchatMessageSchema\b[^}]*\} from "@armyofagents\/shared"/,
    );
    expect(routeSrc).toContain("contextScope: req.body.contextScope ?? undefined");
    expect(routeSrc).toContain("departmentContext: req.body.departmentContext ?? req.body.contextScope?.departmentId ?? undefined");
  });

  it("conversationService has getById returning null when not found", () => {
    expect(convSrc).toContain("getById");
    expect(convSrc).toContain("?? null");
  });
});
