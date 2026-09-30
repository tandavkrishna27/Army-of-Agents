import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub child_process so we can verify the kill attempt without spawning anything.
const execMock = vi.fn();

vi.mock("node:child_process", () => ({
  exec: (cmd: string, cb: (err: Error | null, stdout: string) => void) => {
    const result = execMock(cmd);
    // Allow tests to inject errors via mockImplementationOnce.
    if (result && typeof result === "object" && "err" in result) {
      cb((result as { err: Error | null }).err, "");
      return;
    }
    // Simulate "no orphans" by default; tests override per case.
    cb(null, "");
  },
  execSync: (cmd: string) => {
    execMock(cmd);
    return Buffer.from("");
  },
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { tryRecoverOrphanPostgres } from "../postgres/embedded-orphan-recovery";

describe("tryRecoverOrphanPostgres (Windows-only)", () => {
  beforeEach(() => {
    execMock.mockClear();
  });

  it("is a no-op on non-Windows platforms", async () => {
    // The helper checks process.platform; we test by stubbing it.
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await tryRecoverOrphanPostgres({ dataDir: "C:/fake/path" });
      expect(execMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  it("issues a Stop-Process for postgres.exe processes referencing the data dir on Windows", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      await tryRecoverOrphanPostgres({ dataDir: "C:/Users/test/.aoa/db" });
      expect(execMock).toHaveBeenCalled();
      const cmd = execMock.mock.calls[0][0] as string;
      expect(cmd).toContain("postgres");
      expect(cmd).toMatch(/Stop-Process|taskkill/i);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  it("swallows exec failures and resolves cleanly", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    execMock.mockImplementationOnce(() => ({ err: new Error("ETIMEDOUT") }));
    try {
      await expect(
        tryRecoverOrphanPostgres({ dataDir: "C:/whatever" }),
      ).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});
