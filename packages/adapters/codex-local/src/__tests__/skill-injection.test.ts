import { describe, expect, it, vi } from "vitest";
import { linkOrCopyCodexSkill } from "../server/execute.js";

describe("codex skill injection", () => {
  it("copies a skill directory when symlink creation is denied", async () => {
    const logs: string[] = [];
    const linkSkill = vi.fn().mockRejectedValue(new Error("EPERM: operation not permitted"));
    const copySkill = vi.fn().mockResolvedValue(undefined);

    await linkOrCopyCodexSkill({
      source: "C:/repo/skills/aoa",
      target: "C:/Users/TK/.codex/skills/aoa",
      entryName: "aoa",
      skillsHome: "C:/Users/TK/.codex/skills",
      onLog: async (_stream, message) => {
        logs.push(message);
      },
      linkSkill,
      copySkill,
    });

    // The 3rd arg is the symlink type: "junction" on Windows, undefined elsewhere
    // (execute.ts passes `process.platform === "win32" ? "junction" : undefined`).
    // expect.anything() does NOT match undefined, so assert the exact value per platform.
    expect(linkSkill).toHaveBeenCalledWith(
      "C:/repo/skills/aoa",
      "C:/Users/TK/.codex/skills/aoa",
      process.platform === "win32" ? "junction" : undefined,
    );
    expect(copySkill).toHaveBeenCalledWith(
      "C:/repo/skills/aoa",
      "C:/Users/TK/.codex/skills/aoa",
      { recursive: true },
    );
    expect(logs.join("\n")).toContain("Copied Codex skill \"aoa\"");
  });

  it("does not fail when another run creates the skill target first", async () => {
    const logs: string[] = [];
    const linkSkill = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" }));
    const copySkill = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" }));

    await expect(
      linkOrCopyCodexSkill({
        source: "C:/repo/skills/aoa",
        target: "C:/Users/TK/.codex/skills/aoa",
        entryName: "aoa",
        skillsHome: "C:/Users/TK/.codex/skills",
        onLog: async (_stream, message) => {
          logs.push(message);
        },
        linkSkill,
        copySkill,
      }),
    ).resolves.toBeUndefined();

    expect(logs.join("\n")).toContain("already exists");
  });
});
