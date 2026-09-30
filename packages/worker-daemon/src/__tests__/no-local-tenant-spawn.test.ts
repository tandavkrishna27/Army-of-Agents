import { describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { collectingSink, makeHandoff, SUPERVISOR_IDENTITY } from "./support/supervisor-fixtures.js";

// Replace EVERY process-spawning API so any local child spawn is observable.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw new Error("no-local-tenant-spawn: spawn is forbidden");
  }),
  spawnSync: vi.fn(() => {
    throw new Error("no-local-tenant-spawn: spawnSync is forbidden");
  }),
  exec: vi.fn(() => {
    throw new Error("no-local-tenant-spawn: exec is forbidden");
  }),
  execSync: vi.fn(() => {
    throw new Error("no-local-tenant-spawn: execSync is forbidden");
  }),
  execFile: vi.fn(() => {
    throw new Error("no-local-tenant-spawn: execFile is forbidden");
  }),
  execFileSync: vi.fn(() => {
    throw new Error("no-local-tenant-spawn: execFileSync is forbidden");
  }),
  fork: vi.fn(() => {
    throw new Error("no-local-tenant-spawn: fork is forbidden");
  }),
}));

describe("no-local-tenant-spawn — the tenant command runs INSIDE the sandbox, never as a worker child", () => {
  it("spawns no local child process while running the tenant command inside the sandbox", async () => {
    // The spies are genuinely installed (a real spawn WOULD be caught) — this is
    // what makes the zero-call assertion below non-vacuous.
    expect(vi.isMockFunction(childProcess.spawn)).toBe(true);
    expect(vi.isMockFunction(childProcess.fork)).toBe(true);

    const fake = createFakeSandboxProvider();
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: collectingSink() });
    await supervisor.accept(makeHandoff());

    // The tenant command DID run — inside the sandbox.
    const sandboxId = fake.calls().find((c) => c.op === "create")?.sandboxId;
    expect(sandboxId).toBeTruthy();
    const executions = fake.executionsOf(sandboxId!);
    expect(executions).toHaveLength(1);
    expect(executions[0].insideSandbox).toBe(true);
    expect(executions[0].command).toBe("codex");

    // ...and NO local child process was ever spawned by the worker.
    for (const fn of [
      childProcess.spawn,
      childProcess.spawnSync,
      childProcess.exec,
      childProcess.execSync,
      childProcess.execFile,
      childProcess.execFileSync,
      childProcess.fork,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
