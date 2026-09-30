import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATE_SOURCE = readFileSync(join(__dirname, "..", "migrate.ts"), "utf8");

describe("manual migration CLI snapshot-gate context", () => {
  it("passes an explicitly parsed deployment mode through the guarded shared entrypoint", () => {
    expect(MIGRATE_SOURCE).toContain("AOA_DEPLOYMENT_MODE");
    expect(MIGRATE_SOURCE).toContain("PAPERCLIP_DEPLOYMENT_MODE");
    expect(MIGRATE_SOURCE).toMatch(
      /applyPendingMigrations\(url,\s*\{\s*deploymentMode:\s*readDeploymentModeForMigration\(\)/,
    );
  });

  it("does not invoke the Drizzle migrator directly", () => {
    expect(MIGRATE_SOURCE).not.toContain("migratePg(");
    expect(MIGRATE_SOURCE).not.toContain("postgres-js/migrator");
  });
});
