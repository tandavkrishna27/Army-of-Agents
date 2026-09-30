import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("loadDefaultAgentInstructionsBundle", () => {
  it("loads 4-file CXO bundle for role=cxo", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("cxo");
    expect(bundle["AGENTS.md"]).toBeDefined();
    expect(bundle["HEARTBEAT.md"]).toBeDefined();
    expect(bundle["SOUL.md"]).toBeDefined();
    expect(bundle["TOOLS.md"]).toBeDefined();
    expect(bundle["AGENTS.md"]).toContain("Executive");
    expect(bundle["AGENTS.md"]).toContain("Chief of Staff");
    expect(bundle["AGENTS.md"]).toContain("Founder");
  });

  it("loads 4-file Lead bundle for role=lead", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("lead");
    expect(bundle["AGENTS.md"]).toBeDefined();
    expect(bundle["HEARTBEAT.md"]).toBeDefined();
    expect(bundle["SOUL.md"]).toBeDefined();
    expect(bundle["TOOLS.md"]).toBeDefined();
    expect(bundle["AGENTS.md"]).toContain("Lead");
    // Should NOT mention "Tech Lead" or "Junior Devs" — that's the
    // pre-genericization vocab.
    expect(bundle["AGENTS.md"]).not.toContain("Tech Lead");
    expect(bundle["AGENTS.md"]).not.toContain("Junior Dev");
  });

  it("loads AGENTS-only bundle for role=default", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    expect(bundle["AGENTS.md"]).toBeDefined();
    expect(bundle["HEARTBEAT.md"]).toBeUndefined();
    expect(bundle["SOUL.md"]).toBeUndefined();
    expect(bundle["TOOLS.md"]).toBeUndefined();
  });

  it("all default AGENTS.md files include the AoA preview URL protocol", async () => {
    for (const role of ["default", "lead", "cxo"] as const) {
      const bundle = await loadDefaultAgentInstructionsBundle(role);
      expect(bundle["AGENTS.md"]).toContain("AOA_PREVIEW_URL=<full localhost URL>");
      expect(bundle["AGENTS.md"]).toContain("Do not create a preview server just because this instruction exists");
    }
  });

  it("CXO bundle has no paperclipai repo references", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("cxo");
    expect(bundle["AGENTS.md"]).not.toMatch(/\bpaperclipai\b/);
  });

  it("CXO HEARTBEAT.md uses AOA_* env vars not PAPERCLIP_* env vars", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("cxo");
    expect(bundle["HEARTBEAT.md"]).not.toMatch(/PAPERCLIP_(TASK_ID|WAKE_REASON|WAKE_COMMENT_ID|APPROVAL_ID)/);
    expect(bundle["HEARTBEAT.md"]).toMatch(/AOA_TASK_ID/);
    expect(bundle["HEARTBEAT.md"]).toMatch(/AOA_APPROVAL_ID/);
  });
});

describe("resolveDefaultAgentInstructionsBundleRole", () => {
  it("maps 'cxo' to 'cxo'", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("cxo")).toBe("cxo");
  });

  it("maps 'lead' to 'lead'", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("lead")).toBe("lead");
  });

  it("maps 'general' to 'default'", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("general")).toBe("default");
  });

  it("maps any unknown role to 'default' (defensive fallback)", () => {
    // Old role values that may still appear in legacy data should
    // fall through cleanly so the agent boots.
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("cto")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("pm")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("unknown")).toBe("default");
  });
});
