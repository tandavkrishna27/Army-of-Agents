import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The boundary policy lives in the repo-root scripts (a dev-time gate, not a
// runtime module). Its RED->GREEN cycle is proven by the dependency-free
// `scripts/check-worker-daemon-boundary.test.mjs` node:test corpus; this
// in-package suite guards that the SAME policy rejects forbidden imports and
// that the worker-daemon's OWN sources stay clean.
import {
  evaluateManifest,
  evaluateRuntimeSourceImports,
  REQUIRED_RUNTIME_DEPENDENCIES,
  EXPECTED_PACKAGE_NAME,
} from "../../../../scripts/lib/worker-daemon-boundary.mjs";
import { runBoundaryCheck } from "../../../../scripts/check-worker-daemon-boundary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const sourceRoot = path.resolve(here, "..");

function evalSource(source: string): string[] {
  return evaluateRuntimeSourceImports({
    relPath: "packages/worker-daemon/src/index.ts",
    absPath: path.join(sourceRoot, "index.ts"),
    sourceRoot,
    source,
  });
}

describe("worker-daemon dependency boundary — policy", () => {
  it("rejects forbidden server/db/drizzle imports", () => {
    const forbidden = [
      'import { db } from "@armyofagents/db";',
      'import { app } from "@armyofagents/server";',
      'import { s } from "@armyofagents/shared";',
      'import { r } from "@armyofagents/adapters";',
      'import { sql } from "drizzle-orm";',
      'import { Pool } from "pg";',
      'import express from "express";',
    ];
    for (const line of forbidden) {
      const errors = evalSource(`${line}\nexport const x = 1;\n`);
      expect(errors.length, `expected rejection for: ${line}`).toBeGreaterThan(0);
      expect(errors.join(" | ")).toMatch(/forbidden runtime import/);
    }
  });

  it("allows worker-protocol, pino, node builtins, and in-src relative imports", () => {
    const allowed = [
      'import { PROTOCOL_VERSION } from "@armyofagents/worker-protocol";',
      'import pino from "pino";',
      'import { createServer } from "node:http";',
      'import { createHash } from "node:crypto";',
      'import { loadWorkerConfig } from "./config/config.js";',
    ];
    const errors = evalSource(`${allowed.join("\n")}\nexport const x = 1;\n`);
    expect(errors).toEqual([]);
  });

  it("declares exactly the allowed manifest name + runtime deps", () => {
    expect(EXPECTED_PACKAGE_NAME).toBe("@armyofagents/worker-daemon");
    expect(REQUIRED_RUNTIME_DEPENDENCIES).toEqual(["@armyofagents/worker-protocol", "pino"]);
    const ok = evaluateManifest({
      name: EXPECTED_PACKAGE_NAME,
      dependencies: { "@armyofagents/worker-protocol": "workspace:*", pino: "^9.6.0" },
    });
    expect(ok).toEqual([]);
    const bad = evaluateManifest({
      name: EXPECTED_PACKAGE_NAME,
      dependencies: { "@armyofagents/worker-protocol": "workspace:*", pino: "^9.6.0", express: "^4" },
    });
    expect(bad.length).toBeGreaterThan(0);
  });
});

describe("worker-daemon dependency boundary — real package sources", () => {
  it("passes the boundary check with no policy or read errors", async () => {
    const { policyErrors, readErrors } = await runBoundaryCheck(repoRoot);
    expect(policyErrors, policyErrors.join(" | ")).toEqual([]);
    expect(readErrors, readErrors.join(" | ")).toEqual([]);
  });
});
