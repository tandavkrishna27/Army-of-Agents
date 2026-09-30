import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_INDEX_SOURCE = readFileSync(join(__dirname, "..", "index.ts"), "utf8");

describe("server migration snapshot-gate wiring", () => {
  it("passes the file/env-resolved deployment mode to every migration apply", () => {
    const guardedCalls = SERVER_INDEX_SOURCE.match(
      /applyPendingMigrations\(connectionString,\s*\{\s*deploymentMode:\s*config\.deploymentMode/g,
    );
    expect(guardedCalls).toHaveLength(2);
  });

  it("does not retain a server-only gate that manual migrations could bypass", () => {
    expect(SERVER_INDEX_SOURCE).not.toContain("checkMigrationSnapshotGate");
    expect(SERVER_INDEX_SOURCE).not.toContain("./postgres/snapshot-gate.js");
  });
});
