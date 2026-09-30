import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace-runtime local Git command guard", () => {
  it("guards the shared process chokepoint before spawning Git", () => {
    const source = readFileSync(
      new URL("../services/workspace-runtime.ts", import.meta.url),
      "utf8",
    );
    const executeStart = source.indexOf("async function executeProcess(");
    const executeEnd = source.indexOf("async function runGit(", executeStart);
    const executeBody = source.slice(executeStart, executeEnd);
    const commandCheck = executeBody.indexOf('input.command === "git"');
    const guard = executeBody.indexOf(
      'assertLocalWorkspaceCommandAllowed("workspace Git command")',
    );
    const spawn = executeBody.indexOf("spawn(input.command, input.args");

    expect(executeStart).toBeGreaterThanOrEqual(0);
    expect(commandCheck).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(commandCheck);
    expect(spawn).toBeGreaterThan(guard);
  });
});
