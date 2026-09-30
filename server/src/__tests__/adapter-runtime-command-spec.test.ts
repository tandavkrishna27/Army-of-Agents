import { describe, expect, it } from "vitest";
import { findServerAdapter } from "../adapters/registry.js";
import { SANDBOX_INSTALL_COMMAND as claudeSandboxInstallCommand } from "@armyofagents/adapter-claude-local";
import { SANDBOX_INSTALL_COMMAND as codexSandboxInstallCommand } from "@armyofagents/adapter-codex-local";
import { SANDBOX_INSTALL_COMMAND as cursorSandboxInstallCommand } from "@armyofagents/adapter-cursor-local";
import { SANDBOX_INSTALL_COMMAND as geminiSandboxInstallCommand } from "@armyofagents/adapter-gemini-local";
import { SANDBOX_INSTALL_COMMAND as openCodeSandboxInstallCommand } from "@armyofagents/adapter-opencode-local";
import { SANDBOX_INSTALL_COMMAND as piSandboxInstallCommand } from "@armyofagents/adapter-pi-local";

describe("adapter runtime command specs", () => {
  it.each([
    ["claude_local", "claude", claudeSandboxInstallCommand],
    ["codex_local", "codex", codexSandboxInstallCommand],
    ["cursor", "agent", cursorSandboxInstallCommand],
    ["gemini_local", "gemini", geminiSandboxInstallCommand],
  ])("%s default command includes sandbox install guidance", (type, command, installCommand) => {
    const spec = findServerAdapter(type)?.getRuntimeCommandSpec?.({});

    expect(spec).toEqual({
      command,
      detectCommand: `command -v ${command}`,
      installCommand,
    });
  });

  it("opencode_local uses the official sandbox installer", () => {
    const spec = findServerAdapter("opencode_local")?.getRuntimeCommandSpec?.({});

    expect(spec).toEqual({
      command: "opencode",
      detectCommand: "command -v opencode",
      installCommand: openCodeSandboxInstallCommand,
    });
  });

  it("pi_local includes sandbox install guidance", () => {
    const spec = findServerAdapter("pi_local")?.getRuntimeCommandSpec?.({});

    expect(spec).toEqual({
      command: "pi",
      detectCommand: "command -v pi",
      installCommand: piSandboxInstallCommand,
    });
  });

  it("acpx_local includes npm install guidance", () => {
    const spec = findServerAdapter("acpx_local")?.getRuntimeCommandSpec?.({});

    expect(spec).toEqual({
      command: "acpx",
      detectCommand: "command -v acpx",
      installCommand: "if ! command -v acpx >/dev/null 2>&1; then npm install -g acpx; fi",
    });
  });

  it.each([
    ["claude_local", "my-claude"],
    ["codex_local", "my-codex"],
    ["cursor", "my-agent"],
    ["gemini_local", "my-gemini"],
    ["opencode_local", "my-opencode"],
    ["pi_local", "my-pi"],
    ["acpx_local", "my-acpx"],
  ])("%s custom command does not include install guidance", (type, command) => {
    const spec = findServerAdapter(type)?.getRuntimeCommandSpec?.({ command });

    expect(spec).toEqual({
      command,
      detectCommand: `command -v ${command}`,
      installCommand: null,
    });
  });

  it("openclaw is command-only without install guidance", () => {
    const type = "openclaw";
    const command = "openclaw";
    const spec = findServerAdapter(type)?.getRuntimeCommandSpec?.({});
    const customSpec = findServerAdapter(type)?.getRuntimeCommandSpec?.({ command: `custom-${command}` });

    expect(spec).toEqual({
      command,
      detectCommand: `command -v ${command}`,
      installCommand: null,
    });
    expect(customSpec).toEqual({
      command: `custom-${command}`,
      detectCommand: `command -v custom-${command}`,
      installCommand: null,
    });
  });
});
