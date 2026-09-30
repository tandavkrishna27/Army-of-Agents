import { describe, expect, it } from "vitest";
import {
  buildNpmGlobalInstallIfMissingCommand,
  buildSandboxNpmInstallCommand,
  shellQuote,
} from "../sandbox-install.js";

describe("sandbox install helpers", () => {
  it("quotes shell values with single quotes", () => {
    expect(shellQuote("abc")).toBe("'abc'");
    expect(shellQuote("a'b")).toBe("'a'\"'\"'b'");
  });

  it("builds npm install-if-missing command", () => {
    expect(buildNpmGlobalInstallIfMissingCommand({
      command: "claude",
      packageName: "@anthropic-ai/claude-code",
    })).toContain("npm install -g '@anthropic-ai/claude-code'");
  });

  it("rejects empty command names", () => {
    expect(() =>
      buildNpmGlobalInstallIfMissingCommand({ command: "", packageName: "x" }),
    ).toThrow(/command/i);
  });

  it("builds sandbox npm install commands that can bootstrap npm", () => {
    const command = buildSandboxNpmInstallCommand("@google/gemini-cli");
    expect(command).toContain("if ! command -v npm >/dev/null 2>&1; then");
    expect(command).toContain("https://nodejs.org/dist/");
    expect(command).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(command).toContain("sudo -E npm install -g '@google/gemini-cli'");
    expect(command).toContain("npm install -g --prefix \"$HOME/.local\" '@google/gemini-cli'");
  });

  it("shell-quotes sandbox package names", () => {
    expect(buildSandboxNpmInstallCommand("odd'pkg")).toContain("'odd'\"'\"'pkg'");
  });
});
