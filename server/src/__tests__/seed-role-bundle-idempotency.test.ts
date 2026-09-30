import { describe, it, expect, vi, beforeEach } from "vitest";

// Canonical content returned by loadDefaultAgentInstructionsBundle mock.
// readFile for persona files must return these same strings so sha256 matches
// and the seeder treats the files as unedited (QA-BUG-014 sidecar logic).
const CANONICAL: Record<string, string> = {
  "AGENTS.md": "agents content",
  "SOUL.md": "soul content",
};

const { statMock, writeFileMock, mkdirMock, readFileMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  mkdirMock: vi.fn().mockResolvedValue(undefined),
  readFileMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    stat: statMock,
    writeFile: writeFileMock,
    mkdir: mkdirMock,
    readFile: readFileMock,
  },
}));

vi.mock("../services/default-agent-instructions.js", () => ({
  loadDefaultAgentInstructionsBundle: vi.fn().mockResolvedValue({
    "AGENTS.md": "agents content",
    "SOUL.md": "soul content",
  }),
}));

import { seedRoleInstructionBundle } from "../services/internal-agent/aoa-agents/seed-commander-bundle.js";

const agent = { id: "a1", companyId: "c1", name: "Router", adapterConfig: null };
const adapterConfig = { bundleRoot: "/bundles/a1" };

function makeService(rootPath: string | null) {
  return {
    ensureWritableBundle: vi.fn().mockResolvedValue({
      adapterConfig,
      state: { rootPath, entryFile: "AGENTS.md" },
    }),
  };
}

/** Default readFile mock: sidecar → ENOENT; persona files → canonical content. */
function defaultReadFileMock() {
  readFileMock.mockImplementation((filePath: string) => {
    if (String(filePath).endsWith(".canonical-hashes.json")) {
      return Promise.reject(
        Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
      );
    }
    // Extract the basename to look up canonical content.
    const base = String(filePath).replace(/\\/g, "/").split("/").pop() ?? "";
    const content = CANONICAL[base];
    if (content !== undefined) return Promise.resolve(content);
    return Promise.reject(
      Object.assign(new Error(`ENOENT: unexpected readFile path: ${filePath}`), { code: "ENOENT" }),
    );
  });
}

describe("seedRoleInstructionBundle idempotency (write-if-absent)", () => {
  beforeEach(() => {
    statMock.mockReset();
    writeFileMock.mockReset().mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockReset();
    defaultReadFileMock();
  });

  it("writes bundle files that do not yet exist", async () => {
    // All stat calls → ENOENT (neither persona file exists yet, no sidecar check via stat).
    statMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await seedRoleInstructionBundle({ role: "router", agent, service: makeService("/root") });

    // Two persona writes + one sidecar write = 3 total.
    expect(writeFileMock).toHaveBeenCalledTimes(3);

    const writtenPaths = writeFileMock.mock.calls.map((c) => String(c[0]));
    expect(writtenPaths.some((p) => p.endsWith("AGENTS.md"))).toBe(true);
    expect(writtenPaths.some((p) => p.endsWith("SOUL.md"))).toBe(true);
    expect(writtenPaths.some((p) => p.endsWith(".canonical-hashes.json"))).toBe(true);

    expect(result).toEqual(adapterConfig);
  });

  it("does NOT overwrite persona files that already exist and match canonical (idempotent)", async () => {
    // stat → isFile true for both persona files.
    statMock.mockResolvedValue({ isFile: () => true });
    // readFileMock from beforeEach: sidecar → ENOENT (starts empty), persona files → canonical content.

    const result = await seedRoleInstructionBundle({ role: "router", agent, service: makeService("/root") });

    const writtenPaths = writeFileMock.mock.calls.map((c) => String(c[0]));

    // Persona files must NOT be rewritten.
    expect(writtenPaths.some((p) => p.endsWith("AGENTS.md"))).toBe(false);
    expect(writtenPaths.some((p) => p.endsWith("SOUL.md"))).toBe(false);

    // Sidecar IS written once (hashes moved from {} to {AGENTS.md: hash, SOUL.md: hash}).
    expect(writtenPaths.filter((p) => p.endsWith(".canonical-hashes.json")).length).toBe(1);

    expect(result).toEqual(adapterConfig);
  });

  it("returns adapterConfig unchanged when rootPath is null (no bundle dir yet)", async () => {
    const result = await seedRoleInstructionBundle({ role: "router", agent, service: makeService(null) });
    expect(result).toEqual(adapterConfig);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("writes only missing files when bundle is partially seeded", async () => {
    // AGENTS.md exists, SOUL.md does not.
    statMock
      .mockResolvedValueOnce({ isFile: () => true })   // AGENTS.md stat → exists
      .mockRejectedValueOnce(new Error("ENOENT"));     // SOUL.md stat → missing
    // readFileMock from beforeEach: sidecar → ENOENT, AGENTS.md → canonical content.

    await seedRoleInstructionBundle({ role: "router", agent, service: makeService("/root") });

    const writtenPaths = writeFileMock.mock.calls.map((c) => String(c[0]));

    // SOUL.md written (was missing); AGENTS.md NOT written (existed and matched canonical).
    expect(writtenPaths.some((p) => p.endsWith("SOUL.md"))).toBe(true);
    expect(writtenPaths.some((p) => p.endsWith("AGENTS.md"))).toBe(false);

    // Sidecar written (at least SOUL.md hash recorded).
    expect(writtenPaths.some((p) => p.endsWith(".canonical-hashes.json"))).toBe(true);
  });
});
