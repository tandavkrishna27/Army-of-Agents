import { describe, it, expect, vi } from "vitest";

// Mock the bundle loader so the test does not touch disk for source files,
// and the fs writer so we can assert write-if-absent behavior.
const loadMock = vi.fn();
vi.mock("../services/default-agent-instructions.js", () => ({
  loadDefaultAgentInstructionsBundle: (role: string) => loadMock(role),
}));

const statMock = vi.fn();
const writeMock = vi.fn();
const mkdirMock = vi.fn();
const readFileMock = vi.fn();

vi.mock("node:fs/promises", () => ({
  default: {
    stat: (...a: unknown[]) => statMock(...a),
    writeFile: (...a: unknown[]) => writeMock(...a),
    mkdir: (...a: unknown[]) => mkdirMock(...a),
    readFile: (...a: unknown[]) => readFileMock(...a),
  },
}));

import { seedRoleInstructionBundle } from "../services/internal-agent/aoa-agents/seed-commander-bundle.js";

function fakeService() {
  return {
    ensureWritableBundle: vi.fn().mockResolvedValue({
      adapterConfig: { instructionBundle: { rootPath: "/bundle/root", entryFile: "AGENTS.md" } },
      state: { rootPath: "/bundle/root", entryFile: "AGENTS.md" },
    }),
  };
}

/**
 * Default readFile mock shared across tests:
 *   - sidecar → ENOENT (starts empty so readCanonicalHashes returns {})
 *   - persona files → return the canonical content the loader mock returns
 *     so sha256(existing) === sha256(canonical) → file treated as unedited.
 */
function setupReadFileMock(canonicalContent: Record<string, string>) {
  readFileMock.mockImplementation((filePath: unknown) => {
    const p = String(filePath);
    if (p.endsWith(".canonical-hashes.json")) {
      return Promise.reject(
        Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
      );
    }
    const base = p.replace(/\\/g, "/").split("/").pop() ?? "";
    if (base in canonicalContent) return Promise.resolve(canonicalContent[base]);
    return Promise.reject(
      Object.assign(new Error(`ENOENT: unexpected readFile path: ${p}`), { code: "ENOENT" }),
    );
  });
}

describe("seedRoleInstructionBundle", () => {
  it("loads the bundle for the GIVEN role and writes only absent files", async () => {
    loadMock.mockResolvedValue({ "AGENTS.md": "A", "SOUL.md": "S" });
    setupReadFileMock({ "AGENTS.md": "A", "SOUL.md": "S" });

    // AGENTS.md already exists (skip write); SOUL.md absent (write).
    statMock.mockImplementation((p: string) =>
      p.endsWith("AGENTS.md")
        ? Promise.resolve({ isFile: () => true })
        : Promise.reject(new Error("ENOENT")),
    );
    mkdirMock.mockResolvedValue(undefined);
    writeMock.mockResolvedValue(undefined);

    const service = fakeService();
    await seedRoleInstructionBundle({
      role: "planner",
      agent: { id: "a1", companyId: "c1", name: "Planner", adapterConfig: null },
      service,
    });

    expect(loadMock).toHaveBeenCalledWith("planner");

    // SOUL.md must be written (was absent); AGENTS.md must NOT be written (existed and matched canonical).
    const written = writeMock.mock.calls.map((c) => String(c[0]));
    expect(written.some((p) => p.endsWith("SOUL.md"))).toBe(true);
    expect(written.some((p) => p.endsWith("AGENTS.md"))).toBe(false);

    // Sidecar is also written (hashesChanged = true due to SOUL.md being new).
    expect(written.some((p) => p.endsWith(".canonical-hashes.json"))).toBe(true);
  });

  it("commander wrapper delegates with role='commander'", async () => {
    loadMock.mockResolvedValue({ "AGENTS.md": "A" });
    setupReadFileMock({ "AGENTS.md": "A" });
    statMock.mockRejectedValue(new Error("ENOENT"));
    mkdirMock.mockResolvedValue(undefined);
    writeMock.mockResolvedValue(undefined);

    const service = fakeService();
    const { seedCommanderInstructionBundle } = await import(
      "../services/internal-agent/aoa-agents/seed-commander-bundle.js"
    );
    await seedCommanderInstructionBundle({
      agent: { id: "a1", companyId: "c1", name: "Commander", adapterConfig: null },
      service,
    });
    expect(loadMock).toHaveBeenCalledWith("commander");
  });
});
