import { describe, it, expect } from "vitest";
import {
  CREW_PROVIDERS,
  COMMANDER_PROVIDERS,
  providerToCliTool,
  providerToCrewAdapter,
  cliToolToProvider,
} from "../provider-mapping.js";
import { AGENT_PROVIDERS } from "../constants.js";

describe("provider-mapping", () => {
  it("CREW_PROVIDERS has all four; COMMANDER_PROVIDERS is anthropic+openai only", () => {
    expect([...CREW_PROVIDERS]).toEqual(["anthropic", "openai", "google", "opencode"]);
    // cli-mode chat only supports claude_cli + codex (no gemini, no opencode path).
    expect([...COMMANDER_PROVIDERS]).toEqual(["anthropic", "openai"]);
    expect(COMMANDER_PROVIDERS).not.toContain("google");
    expect(COMMANDER_PROVIDERS).not.toContain("opencode");
  });

  it("providerToCliTool maps each commander provider to its CLI", () => {
    expect(providerToCliTool("anthropic")).toBe("claude_cli");
    expect(providerToCliTool("openai")).toBe("codex");
  });

  it("providerToCrewAdapter maps each crew provider to its adapter", () => {
    expect(providerToCrewAdapter("anthropic")).toBe("claude_local");
    expect(providerToCrewAdapter("openai")).toBe("codex_local");
    expect(providerToCrewAdapter("google")).toBe("gemini_local");
    expect(providerToCrewAdapter("opencode")).toBe("opencode_local");
  });

  it("cliToolToProvider inverts providerToCliTool (+ opencode legacy + default)", () => {
    expect(cliToolToProvider("claude_cli")).toBe("anthropic");
    expect(cliToolToProvider("codex")).toBe("openai");
    expect(cliToolToProvider("opencode")).toBe("opencode");
    expect(cliToolToProvider(null)).toBe("anthropic");
    expect(cliToolToProvider("weird")).toBe("anthropic");
  });

  it("AGENT_PROVIDERS now includes opencode", () => {
    expect([...AGENT_PROVIDERS]).toEqual(["anthropic", "openai", "google", "opencode"]);
  });
});
