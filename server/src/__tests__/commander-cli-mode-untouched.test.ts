import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("cli-mode spawn shape invariant", () => {
  it("cli-mode.ts keeps the Windows-safe system-prompt-file + permission bypass wiring", () => {
    // Use __dirname so this works whether vitest CWD is server/ or monorepo root.
    const src = readFileSync(resolve(__dirname, "../services/internal-agent/cli-mode.ts"), "utf8");
    // C-systemsplit (corrected): --system-prompt-file is used instead of inline --system-prompt
    // to avoid Windows cmd.exe newline-truncation. --dangerously-skip-permissions bypasses
    // the MCP tool permission prompts that block tools in non-interactive (--print) mode.
    expect(src).toContain("--system-prompt-file");
    expect(src).toContain("--dangerously-skip-permissions");
    // codex still receives its raw prompt for its own stdin handling.
    expect(src).toContain("prompt: params.content");
    // no skillsDir / assembledPrompt plumbing leaked into cli-mode
    expect(src).not.toContain("skillsDir");
    expect(src).not.toContain("assembledPrompt");
  });

  it("W1 stdin fix: claude's prompt rides stdin (stdinPrompt), NOT an argv positional", () => {
    const src = readFileSync(resolve(__dirname, "../services/internal-agent/cli-mode.ts"), "utf8");
    // The new stdin contract: invocation carries a raw stdinPrompt the spawn
    // block writes + closes. The old argv-positional escaped form is gone.
    expect(src).toContain("stdinPrompt");
    expect(src).toContain("systemSplitArgs.rawContent");
    // The old shell-escaped argv positional for the claude prompt must be gone:
    // neither the systemSplit nor plain claude argv may end in a content positional.
    expect(src).not.toContain("safeRawContent");
  });
});
