import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const routeSource = readFileSync(resolve(here, "../routes/artifacts.ts"), "utf8");

describe("artifact archive route authz contract", () => {
  it("requires a board actor before founder RBAC for archive and unarchive routes", () => {
    expect(routeSource).toContain("import { assertBoard, assertCompanyAccess, getActorInfo } from \"./authz.js\"");
    expect(routeSource).toMatch(/\/artifacts\/:id\/archive[\s\S]*await assertCompanyAccess\(db, req, existing\.companyId\);\s*assertBoard\(req\);\s*await assertRole\(db, req, existing\.companyId, "founder"\);/);
    expect(routeSource).toMatch(/\/artifacts\/:id\/unarchive[\s\S]*await assertCompanyAccess\(db, req, existing\.companyId\);\s*assertBoard\(req\);\s*await assertRole\(db, req, existing\.companyId, "founder"\);/);
  });
});
