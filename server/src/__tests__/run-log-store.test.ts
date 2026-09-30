import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = {
  AOA_HOME: process.env.AOA_HOME,
  AOA_INSTANCE_ID: process.env.AOA_INSTANCE_ID,
  RUN_LOG_BASE_PATH: process.env.RUN_LOG_BASE_PATH,
};

let tmpRoot: string;
let originalCwd: string;

async function makeTempDir(name: string) {
  return mkdtemp(path.join(tmpRoot, `${name}-`));
}

async function loadRunLogStore() {
  vi.resetModules();
  return import("../services/run-log-store.js");
}

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("run log store", () => {
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "aoa-run-log-store-"));
    originalCwd = process.cwd();
    restoreEnv();
    vi.resetModules();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    restoreEnv();
    vi.resetModules();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("defaults run logs to the AoA instance data directory instead of process cwd", async () => {
    const aoaHome = await makeTempDir("home");
    const cwd = await makeTempDir("cwd");
    process.env.AOA_HOME = aoaHome;
    process.env.AOA_INSTANCE_ID = "test-instance";
    delete process.env.RUN_LOG_BASE_PATH;
    process.chdir(cwd);

    const { getRunLogStore } = await loadRunLogStore();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    await store.append(handle, {
      ts: "2026-05-22T00:00:00.000Z",
      stream: "stdout",
      chunk: "hello instance log",
    });

    const expectedPath = path.resolve(
      aoaHome,
      "instances",
      "test-instance",
      "data",
      "run-logs",
      "company-1",
      "agent-1",
      "run-1.ndjson",
    );
    const oldCwdPath = path.resolve(cwd, "data", "run-logs", "company-1", "agent-1", "run-1.ndjson");

    await expect(readFile(expectedPath, "utf8")).resolves.toContain("hello instance log");
    await expect(readFile(oldCwdPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps RUN_LOG_BASE_PATH as the explicit override", async () => {
    const aoaHome = await makeTempDir("home");
    const override = await makeTempDir("override");
    process.env.AOA_HOME = aoaHome;
    process.env.AOA_INSTANCE_ID = "test-instance";
    process.env.RUN_LOG_BASE_PATH = override;

    const { getRunLogStore } = await loadRunLogStore();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-2",
      agentId: "agent-2",
      runId: "run-2",
    });
    await store.append(handle, {
      ts: "2026-05-22T00:00:00.000Z",
      stream: "stderr",
      chunk: "override log",
    });

    const expectedPath = path.resolve(override, "company-2", "agent-2", "run-2.ndjson");
    await expect(readFile(expectedPath, "utf8")).resolves.toContain("override log");
  });

  it("stores relative log refs and can read and finalize appended ndjson", async () => {
    const aoaHome = await makeTempDir("home");
    process.env.AOA_HOME = aoaHome;
    process.env.AOA_INSTANCE_ID = "test-instance";
    delete process.env.RUN_LOG_BASE_PATH;

    const { getRunLogStore } = await loadRunLogStore();
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company/unsafe",
      agentId: "agent unsafe",
      runId: "run:unsafe",
    });

    expect(path.isAbsolute(handle.logRef)).toBe(false);
    expect(handle.logRef).not.toContain("..");

    await store.append(handle, {
      ts: "2026-05-22T00:00:00.000Z",
      stream: "system",
      chunk: "first",
    });
    await store.append(handle, {
      ts: "2026-05-22T00:00:01.000Z",
      stream: "stdout",
      chunk: "second",
    });

    const full = await store.read(handle);
    expect(full.content).toContain("\"chunk\":\"first\"");
    expect(full.content).toContain("\"chunk\":\"second\"");

    const partial = await store.read(handle, { offset: 0, limitBytes: 10 });
    expect(partial.content.length).toBeGreaterThan(0);
    expect(partial.nextOffset).toBeDefined();

    const summary = await store.finalize(handle);
    expect(summary.bytes).toBeGreaterThan(0);
    expect(summary.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.compressed).toBe(false);
  });
});
