// Wiring guard: the durable extraction sweeper must be registered on the
// server's existing setInterval worker pattern (mirrors the file-import
// queue). Source-presence assertion (index.ts is the process entrypoint —
// not unit-bootable); typecheck + the sweeper's own contract tests cover
// behaviour. Windows-runnable.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("extraction sweeper is wired into the server worker loop", () => {
  // Use __dirname so this works whether vitest CWD is server/ or the monorepo root.
  const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8");

  it("imports runExtractionSweep", () => {
    expect(src).toContain("runExtractionSweep");
  });

  it("registers it on a setInterval with an in-flight guard (mirrors file-import worker)", () => {
    expect(src).toContain("extractionSweepInFlight");
    expect(src).toMatch(/setInterval\([^)]*\)|setInterval\(\(\) =>/);
    // guard pattern present: `if (extractionSweepInFlight) return;`
    expect(src).toMatch(/if\s*\(\s*extractionSweepInFlight\s*\)\s*return/);
  });
});
