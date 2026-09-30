// BRW-002 — the download-root path adapter (unit-shaped; uses a REAL temp filesystem).
//
// Clause (b) is "downloads stay job scoped". Plan review killed two earlier ideas:
//
//  1. A STRING function cannot enforce this. It cannot see a symlink, and a page that can
//     cause a directory to be created can plant one. The check must ask the filesystem.
//  2. Testing hostile `Content-Disposition` filenames proves nothing about confinement:
//     Chromium pre-sanitises `suggestedFilename` (measured — `../../escape.txt` arrives as
//     `_.._escape.txt`) and writes to a GUID. The surface that can ACTUALLY escape is
//     `download.saveAs(path)`, which takes a caller-supplied path. That is what this guards.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { resolveUnderRoot, safeDownloadName } from "../path-adapter.js";

function withRoot<T>(fn: (root: string, outside: string) => T): T {
  const base = mkdtempSync(join(tmpdir(), "brw002-"));
  const root = join(base, "job-root");
  const outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  try {
    return fn(root, outside);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

describe("BRW-002 safeDownloadName — reduce an attacker-influenced name to a basename", () => {
  it("keeps an ordinary filename", () => {
    expect(safeDownloadName("invoice-2026-07.pdf")).toBe("invoice-2026-07.pdf");
  });

  it("strips directory components rather than trusting them", () => {
    expect(safeDownloadName("../../etc/passwd")).toBe("passwd");
    expect(safeDownloadName("/etc/shadow")).toBe("shadow");
    expect(safeDownloadName("dir\\windows\\evil.exe")).toBe("evil.exe");
  });

  it("refuses a name that is only traversal or separators", () => {
    for (const bad of ["..", ".", "../..", "/", "///", ""]) {
      expect(safeDownloadName(bad), `${bad} must be unusable`).toBeNull();
    }
  });

  it("refuses control bytes and NUL rather than stripping them", () => {
    // Stripping would silently rename the file; refusing tells the caller their name was
    // rejected. NUL in particular truncates a path in any C-based syscall layer.
    expect(safeDownloadName("evil\u0000.pdf")).toBeNull();
    expect(safeDownloadName("evil\n.pdf")).toBeNull();
    expect(safeDownloadName("evil\x7f.pdf")).toBeNull();
  });

  it("refuses a leading dot so a download cannot become a dotfile", () => {
    expect(safeDownloadName(".bashrc")).toBeNull();
  });

  it("bounds the length", () => {
    const name = safeDownloadName(`${"a".repeat(500)}.pdf`);
    expect(name).not.toBeNull();
    expect((name ?? "").length).toBeLessThanOrEqual(255);
  });
});

describe("BRW-002 resolveUnderRoot — confinement asked of the filesystem", () => {
  it("accepts a plain name and returns a path inside the root", () => {
    withRoot((root) => {
      const result = resolveUnderRoot(root, "invoice.pdf");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.path.startsWith(root + sep)).toBe(true);
    });
  });

  it("accepts a target whose file does not exist yet", () => {
    // This is the `saveAs` case: the download target never exists before the call, so a
    // check that realpath()s the CANDIDATE would throw on every legitimate download.
    withRoot((root) => {
      expect(resolveUnderRoot(root, "not-created-yet.bin").ok).toBe(true);
    });
  });

  it("refuses traversal out of the root", () => {
    withRoot((root) => {
      const result = resolveUnderRoot(root, join("..", "outside", "loot.txt"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("outside_root");
    });
  });

  it("refuses an absolute path that reassigns the destination", () => {
    withRoot((root, outside) => {
      const result = resolveUnderRoot(root, join(outside, "loot.txt"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("outside_root");
    });
  });

  it("refuses a NUL byte in the candidate", () => {
    // This previously used "ok<NUL>/../../loot.txt" and passed for the WRONG REASON:
    // path.resolve() drops the NUL and resolves the traversal, so it was the `..` that got
    // refused, never the NUL. Mutation testing exposed it -- deleting the control-byte check
    // left the suite green. This candidate stays INSIDE the root, so only the control-byte
    // check can refuse it.
    withRoot((root) => {
      const result = resolveUnderRoot(root, "innocent\u0000.txt");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unusable_name");
    });
  });

  it("still refuses a NUL combined with traversal", () => {
    withRoot((root) => {
      expect(resolveUnderRoot(root, "ok\u0000/../../loot.txt").ok).toBe(false);
    });
  });

  it("refuses when the root itself does not exist", () => {
    // A missing root must fail closed. Creating it here would let a typo silently relocate
    // every download.
    const result = resolveUnderRoot(join(tmpdir(), "brw002-does-not-exist-xyz"), "a.txt");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("root_missing");
  });

  it("accepts a nested path whose intermediate directory exists", () => {
    withRoot((root) => {
      mkdirSync(join(root, "sub"), { recursive: true });
      expect(resolveUnderRoot(root, join("sub", "a.txt")).ok).toBe(true);
    });
  });
});

// Symlink creation needs elevation on Windows (EPERM, measured on this machine), so these run
// on Linux CI. They are the cases that justify touching the filesystem at all, so they are
// kept separate and explicit rather than folded into a suite that appears to cover them.
describe.skipIf(process.platform === "win32")(
  "BRW-002 resolveUnderRoot — symlink escape (the reason this is not a string function)",
  () => {
    it("refuses a path that leaves the root through a symlinked directory", () => {
      withRoot((root, outside) => {
        symlinkSync(outside, join(root, "escape"), "dir");
        const result = resolveUnderRoot(root, join("escape", "loot.txt"));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("outside_root");
      });
    });

    it("refuses a symlinked FILE target that points outside", () => {
      withRoot((root, outside) => {
        writeFileSync(join(outside, "victim.txt"), "x");
        symlinkSync(join(outside, "victim.txt"), join(root, "innocent.txt"), "file");
        expect(resolveUnderRoot(root, "innocent.txt").ok).toBe(false);
      });
    });

    it("still accepts a symlink that stays INSIDE the root", () => {
      // Over-refusal would be its own defect: the guard must distinguish escape from
      // legitimate structure, or it gets disabled.
      withRoot((root) => {
        mkdirSync(join(root, "real"), { recursive: true });
        symlinkSync(join(root, "real"), join(root, "alias"), "dir");
        expect(resolveUnderRoot(root, join("alias", "a.txt")).ok).toBe(true);
      });
    });
  },
);

describe("BRW-002 resolveUnderRoot — sibling-prefix confusion", () => {
  it("refuses a sibling directory whose name merely starts with the root's name", () => {
    // `/tmp/x/job-root-evil` must not pass a prefix test against `/tmp/x/job-root`. This is
    // why the comparison appends a separator; without it the guard is a substring check.
    const base = mkdtempSync(join(tmpdir(), "brw002-sib-"));
    try {
      const root = join(base, "job-root");
      const evil = join(base, "job-root-evil");
      mkdirSync(root, { recursive: true });
      mkdirSync(evil, { recursive: true });
      const result = resolveUnderRoot(root, join(evil, "loot.txt"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("outside_root");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
