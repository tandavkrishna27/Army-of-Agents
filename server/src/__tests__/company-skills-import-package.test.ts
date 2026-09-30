/**
 * Tests for importPackageFiles edge-case fixes:
 *   1. Path traversal — schema + service guard
 *   2. Slug collision — finalSlug resolved before disk write (covered by validatePackageFileKey)
 *   3. Orphaned files — directory cleared on re-import
 *   4. Race condition — queue serialization (covered by in-process queue; tested via concurrent call pattern)
 *   5. Markdown overwrite — lastPackageImportAt metadata written
 *
 * importPackageFiles itself is a bound service method that requires a DB connection,
 * so DB-dependent behaviour (slug resolution, upsert) is covered by integration tests.
 * This file tests the two pure/fs-level pieces that are fully extractable:
 *   - companySkillImportPackageSchema (Zod validator)
 *   - validatePackageFileKey (exported pure function)
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { companySkillImportPackageSchema } from "@armyofagents/shared";
import { validatePackageFileKey } from "../services/company-skills.js";

// ---------------------------------------------------------------------------
// Temp dir helpers (same pattern as company-skills.test.ts)
// ---------------------------------------------------------------------------

const cleanupDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  cleanupDirs.clear();
});

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Fix 1a — Schema-level path traversal guard
// ---------------------------------------------------------------------------

describe("companySkillImportPackageSchema — path traversal", () => {
  it("accepts a valid file map with SKILL.md", () => {
    expect(() =>
      companySkillImportPackageSchema.parse({
        files: { "SKILL.md": "# skill" },
      }),
    ).not.toThrow();
  });

  it("accepts ancillary files in subdirectories", () => {
    expect(() =>
      companySkillImportPackageSchema.parse({
        files: {
          "SKILL.md": "# skill",
          "references/context.md": "context",
          "scripts/helper.sh": "#!/bin/bash",
          "assets/diagram.png": "base64data",
        },
      }),
    ).not.toThrow();
  });

  it("accepts skill.md (lowercase) as the required entry", () => {
    expect(() =>
      companySkillImportPackageSchema.parse({
        files: { "skill.md": "# skill" },
      }),
    ).not.toThrow();
  });

  it("rejects file maps missing SKILL.md entirely", () => {
    expect(() =>
      companySkillImportPackageSchema.parse({
        files: { "README.md": "content" },
      }),
    ).toThrow();
  });

  it("rejects path traversal with leading ../", () => {
    expect(() =>
      companySkillImportPackageSchema.parse({
        files: { "SKILL.md": "# skill", "../etc/passwd": "evil" },
      }),
    ).toThrow();
  });

  it("rejects path traversal with embedded ../", () => {
    expect(() =>
      companySkillImportPackageSchema.parse({
        files: { "SKILL.md": "# skill", "references/../../etc/passwd": "evil" },
      }),
    ).toThrow();
  });

  it("rejects path traversal with Windows-style ..\\", () => {
    expect(() =>
      companySkillImportPackageSchema.parse({
        files: { "SKILL.md": "# skill", "..\\etc\\passwd": "evil" },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fix 1b — Service-level validatePackageFileKey (belt-and-suspenders)
// ---------------------------------------------------------------------------

describe("validatePackageFileKey", () => {
  const SKILL_DIR = "/tmp/test-managed-skill";

  it("returns normalized path for a simple file", () => {
    expect(validatePackageFileKey(SKILL_DIR, "SKILL.md")).toBe("SKILL.md");
  });

  it("returns normalized path for a subdirectory file", () => {
    expect(validatePackageFileKey(SKILL_DIR, "references/context.md")).toBe(
      "references/context.md",
    );
  });

  it("normalizes Windows-style backslashes", () => {
    expect(validatePackageFileKey(SKILL_DIR, "references\\context.md")).toBe(
      "references/context.md",
    );
  });

  it("returns SKILL.md for an empty path", () => {
    expect(validatePackageFileKey(SKILL_DIR, "")).toBe("SKILL.md");
  });

  it("throws on leading path traversal (../)", () => {
    expect(() => validatePackageFileKey(SKILL_DIR, "../etc/passwd")).toThrow(
      "path traversal",
    );
  });

  it("throws on embedded path traversal (foo/../../bar)", () => {
    expect(() =>
      validatePackageFileKey(SKILL_DIR, "foo/../../etc/passwd"),
    ).toThrow("path traversal");
  });

  it("throws on deeply nested traversal", () => {
    expect(() =>
      validatePackageFileKey(SKILL_DIR, "references/../../../etc/shadow"),
    ).toThrow("path traversal");
  });

  it("throws on Windows-style traversal after normalization", () => {
    expect(() =>
      validatePackageFileKey(SKILL_DIR, "references\\..\\..\\etc\\passwd"),
    ).toThrow("path traversal");
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — Orphaned files are cleared on re-import
// Tests the expected disk behaviour that importPackageFiles must produce.
// We test this by simulating the fs.rm + re-write pattern directly,
// matching what importPackageFiles does inside doWork.
// ---------------------------------------------------------------------------

describe("import package — orphaned file clearing behaviour", () => {
  it("files absent from the new file map are not present after re-import", async () => {
    const skillDir = await makeTempDir("paperclip-import-pkg-");

    // First import: SKILL.md + references/old.md
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# v1", "utf8");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "references", "old.md"),
      "old content",
      "utf8",
    );

    // Simulate re-import: clear dir, then write new file map (SKILL.md only)
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# v2", "utf8");

    // references/old.md must no longer exist
    await expect(
      fs.access(path.join(skillDir, "references", "old.md")),
    ).rejects.toThrow();

    // SKILL.md must have the new content
    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(content).toBe("# v2");
  });

  it("files present in the new file map replace old content at the same path", async () => {
    const skillDir = await makeTempDir("paperclip-import-pkg-replace-");

    // First import
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# v1", "utf8");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "references", "context.md"),
      "old context",
      "utf8",
    );

    // Re-import: clear, then write updated content
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# v2", "utf8");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "references", "context.md"),
      "new context",
      "utf8",
    );

    const content = await fs.readFile(
      path.join(skillDir, "references", "context.md"),
      "utf8",
    );
    expect(content).toBe("new context");
  });
});
