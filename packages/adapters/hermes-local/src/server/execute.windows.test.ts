import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@armyofagents/adapter-utils";
import { execute } from "./execute.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function context(command: string, cwd: string, body: string): AdapterExecutionContext {
  return {
    runId: "run-win", agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: { hermesCommand: command, cwd } },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { taskId: "task-1", taskTitle: "Check argv", taskBody: body }, context: {}, authToken: "jwt",
    onLog: async () => {},
  };
}

describe.skipIf(process.platform !== "win32")("Hermes Windows process safety", () => {
  it("passes a quoted prompt and metacharacters literally to an executable in a path with spaces", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes argv "));
    roots.push(root);
    const executable = path.join(root, "hermes test.exe");
    const argvFile = path.join(root, "argv.json");
    const sideEffect = path.join(root, "SHOULD_NOT_EXIST");
    await fs.copyFile(process.execPath, executable);
    // Node receives `chat` as its entry script; the Hermes flags become script argv.
    await fs.writeFile(path.join(root, "chat"), `require('node:fs').writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2))); process.stdout.write('done\\nsession_id: safe-session\\n');`);
    const body = `Literal \"quotes\" & echo hijacked > \"${sideEffect}\"`;
    const ctx = context(executable, root, body);
    (ctx.agent.adapterConfig as Record<string, unknown>).env = { ARGV_FILE: argvFile };
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toEqual({ sessionId: "safe-session" });
    const argv = JSON.parse(await fs.readFile(argvFile, "utf8")) as string[];
    expect(argv[0]).toBe("-q");
    expect(argv[1]).toContain(body);
    expect(await fs.stat(sideEffect).then(() => true).catch(() => false)).toBe(false);
  });

  it("rejects batch shims before spawning", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes shim "));
    roots.push(root);
    const shim = path.join(root, "hermes.cmd");
    await fs.writeFile(shim, "@echo off\r\necho unsafe>SHOULD_NOT_EXIST\r\n");
    const result = await execute(context(shim, root, "task"));
    expect(result.errorMessage).toMatch(/batch shims cannot safely receive/);
    expect(await fs.stat(path.join(root, "SHOULD_NOT_EXIST")).then(() => true).catch(() => false)).toBe(false);
  });
});
