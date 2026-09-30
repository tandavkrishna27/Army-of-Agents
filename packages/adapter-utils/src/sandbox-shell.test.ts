import { describe, expect, it } from "vitest";
import { preferredShellForSandbox } from "./sandbox-shell.js";

describe("preferredShellForSandbox", () => {
  it("returns bash only for an explicit bash command", () => {
    expect(preferredShellForSandbox("bash")).toBe("bash");
  });

  it("defaults every other value to sh", () => {
    expect(preferredShellForSandbox("zsh")).toBe("sh");
    expect(preferredShellForSandbox("")).toBe("sh");
    expect(preferredShellForSandbox(null)).toBe("sh");
  });
});
