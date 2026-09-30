import path from "node:path";
import { describe, it, expect } from "vitest";

// Observe case-sensitivity via the jail's OWN detector, so the expectation can
// never drift from the code as the probe evolves — and it is filesystem-probed,
// not guessed from process.platform.
const CASE_INSENSITIVE_FS = isCaseInsensitiveFilesystem();
import {
  legacyMarketplaceSkillsRoot,
  managedMarketplaceSkillsRoot,
  managedMarketplaceSkillsRoots,
  persistentMarketplaceSkillsRoot,
  isInsideManagedMarketplaceSkillsRoot,
  overlapsManagedMarketplaceSkillsRoot,
  isCaseInsensitiveFilesystem,
} from "../services/marketplace-install/managed-skills-root.js";

describe("managedMarketplaceSkillsRoot", () => {
  it("is <cwd>/.aoa/marketplace-skills", () => {
    expect(managedMarketplaceSkillsRoot()).toBe(
      path.join(process.cwd(), ".aoa", "marketplace-skills"),
    );
  });

  it("selects only between the two fixed roots", () => {
    const previous = process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT;
    try {
      process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT = "persistent";
      expect(managedMarketplaceSkillsRoot()).toBe(
        persistentMarketplaceSkillsRoot(),
      );
      process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT = "legacy";
      expect(managedMarketplaceSkillsRoot()).toBe(
        legacyMarketplaceSkillsRoot(),
      );
      process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT = "C:\\arbitrary";
      expect(() => managedMarketplaceSkillsRoot()).toThrow(
        /legacy or persistent/,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT;
      } else {
        process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT = previous;
      }
    }
  });

  it("always jails both fixed roots regardless of the write selector", () => {
    const roots = managedMarketplaceSkillsRoots();
    expect(roots).toContain(path.resolve(legacyMarketplaceSkillsRoot()));
    expect(roots).toContain(path.resolve(persistentMarketplaceSkillsRoot()));
    for (const root of roots) {
      expect(
        isInsideManagedMarketplaceSkillsRoot(
          path.join(root, "company", "skill", "1.0.0"),
        ),
      ).toBe(true);
    }
  });
});

describe("isInsideManagedMarketplaceSkillsRoot (T2.8c(b) containment)", () => {
  const root = managedMarketplaceSkillsRoot();

  it("true for a bundle directory nested inside the root", () => {
    expect(
      isInsideManagedMarketplaceSkillsRoot(path.join(root, "co-1", "skill_x", "1.0.0")),
    ).toBe(true);
  });

  it("true for the root itself", () => {
    expect(isInsideManagedMarketplaceSkillsRoot(root)).toBe(true);
  });

  it("true for traversal that normalizes back inside the root", () => {
    expect(
      isInsideManagedMarketplaceSkillsRoot(path.join(root, "co-1", "..", "co-2", "s", "1.0.0")),
    ).toBe(true);
  });

  it("false for the parent .aoa directory", () => {
    expect(isInsideManagedMarketplaceSkillsRoot(path.join(process.cwd(), ".aoa"))).toBe(false);
  });

  it("false for a sibling directory with a shared prefix", () => {
    // `.../marketplace-skills-other` must not be treated as inside
    // `.../marketplace-skills`.
    expect(
      isInsideManagedMarketplaceSkillsRoot(
        path.join(process.cwd(), ".aoa", "marketplace-skills-other"),
      ),
    ).toBe(false);
  });

  it("false for an unrelated absolute path", () => {
    expect(isInsideManagedMarketplaceSkillsRoot(path.join(process.cwd(), "src"))).toBe(false);
  });

  it("false for traversal that escapes the root", () => {
    expect(isInsideManagedMarketplaceSkillsRoot(path.join(root, "..", "..", "etc"))).toBe(false);
  });

  it("catches a case-variant path on case-insensitive filesystems (win32/darwin)", () => {
    // `.AOA\MARKETPLACE-SKILLS\…` names the SAME directory the OS would open on a
    // case-insensitive FS, so the jail must catch it there. On case-sensitive
    // Linux it is genuinely a different directory and correctly reads as outside.
    const caseVariant = path.join(process.cwd(), ".AOA", "MARKETPLACE-SKILLS", "co", "skill_x", "1.0.0");
    expect(isInsideManagedMarketplaceSkillsRoot(caseVariant)).toBe(CASE_INSENSITIVE_FS);
  });

  it("treats a child dir that merely STARTS with two dots as contained (Codex #302: ..shadow)", () => {
    // `path.relative` yields "..shadow/file.md"; a naive startsWith("..") would
    // wrongly classify this contained target as outside and bypass the jail.
    expect(
      isInsideManagedMarketplaceSkillsRoot(path.join(root, "..shadow", "file.md")),
    ).toBe(true);
  });
});

describe("overlapsManagedMarketplaceSkillsRoot (T2.8c(b) root-set jail, bidirectional)", () => {
  const root = managedMarketplaceSkillsRoot();

  it("true when the candidate is inside the root", () => {
    expect(overlapsManagedMarketplaceSkillsRoot(path.join(root, "co", "skill_x"))).toBe(true);
  });

  it("true when the candidate is an ANCESTOR of the root (e.g. .aoa)", () => {
    expect(overlapsManagedMarketplaceSkillsRoot(path.join(process.cwd(), ".aoa"))).toBe(true);
    expect(overlapsManagedMarketplaceSkillsRoot(process.cwd())).toBe(true);
  });

  it("false for a sibling with a shared prefix or an unrelated path", () => {
    expect(
      overlapsManagedMarketplaceSkillsRoot(path.join(process.cwd(), ".aoa", "marketplace-skills-other")),
    ).toBe(false);
    expect(overlapsManagedMarketplaceSkillsRoot(path.join(process.cwd(), "src"))).toBe(false);
  });
});
